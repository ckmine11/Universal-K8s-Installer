// Warnings before something breaks: per-node CPU, memory and disk from the
// kubelet (stats/summary), a disk-fill forecast, and sustained high CPU / memory
// with the pods using it. Pure functions — the poller lives in incidentDetector.

export const RESOURCE_REASONS = new Set(['NodeDiskFilling', 'NodeMemoryHigh', 'NodeCPUHigh'])

export const HISTORY_MAX       = 200                  // ~6.5 h at one sample per 2 min
const FORECAST_WINDOW_MS       = 6 * 3600e3           // trend from the last 6 hours
const FORECAST_MIN_SPAN_MS     = 30 * 60e3            // …but at least 30 minutes of it
const FORECAST_MIN_POINTS      = 6
const FILL_WARN_H              = 24
const FILL_CRIT_H              = 3
const FILL_CLEAR_H             = 48                   // once open, stays open until > 48 h (no flapping)
const SUSTAIN_MS               = 15 * 60e3
const HIGH_PCT                 = 90
const VERY_HIGH_PCT            = 95
const CLEAR_PCT                = 85
const MIN_DISK_GROWTH_BPH      = 50 * 1024 * 1024     // under 50 MB/h is noise

const GB = 1024 ** 3
export const fmtBytes = (b) => b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`
const fmtHours = (h) => h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`

/** "4", "3500m" → cores; "16384000Ki", "16Gi", "17179869184" → bytes */
export function parseQuantity(q) {
    const m = /^([\d.]+)([a-zA-Z]*)$/.exec(String(q ?? '').trim())
    if (!m) return null
    const n = parseFloat(m[1])
    const mult = { '': 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }[m[2]]
    return mult == null ? null : n * mult
}

/**
 * The resource script's output → { nodeName: { ip, sample } }.
 * Sections: "==CAP" lines "name cpu memory ip", then "==NODE name" + summary JSON.
 */
export function parseResources(out, now = Date.now()) {
    const nodes = {}
    const parts = String(out || '').split(/^==/m)
    const cap = {}
    for (const p of parts) {
        if (p.startsWith('CAP')) {
            for (const l of p.split('\n').slice(1)) {
                const [name, cpu, mem, ip] = l.trim().split(/\s+/)
                if (name) cap[name] = { cores: parseQuantity(cpu), memBytes: parseQuantity(mem), ip: ip || null }
            }
        }
    }
    for (const p of parts) {
        if (!p.startsWith('NODE ')) continue
        const nl = p.indexOf('\n')
        const name = p.slice(5, nl).trim()
        let s; try { s = JSON.parse(p.slice(nl + 1)) } catch { continue }
        const sample = summaryToSample(s, cap[name] || {}, now)
        if (sample) nodes[name] = { ip: cap[name]?.ip || null, sample }
    }
    return nodes
}

/** One kubelet stats/summary → one sample (percentages + top pods) */
export function summaryToSample(s, cap = {}, now = Date.now()) {
    const n = s?.node
    if (!n) return null
    const memUsed = n.memory?.workingSetBytes
    const memTotal = cap.memBytes || (n.memory?.availableBytes != null && memUsed != null ? n.memory.availableBytes + memUsed : null)
    const cores = cap.cores || null
    const pct = (a, b) => a != null && b ? Math.round((a / b) * 1000) / 10 : null
    const pods = (s.pods || []).map(p => ({
        pod: `${p.podRef?.namespace}/${p.podRef?.name}`,
        cpu: (p.cpu?.usageNanoCores || 0) / 1e9,
        mem: p.memory?.workingSetBytes || 0
    }))
    return {
        t: now,
        cpuPct: pct(n.cpu?.usageNanoCores != null ? n.cpu.usageNanoCores / 1e9 : null, cores),
        memPct: pct(memUsed, memTotal),
        diskUsed: n.fs?.usedBytes ?? null,
        diskCap: n.fs?.capacityBytes ?? null,
        diskAvail: n.fs?.availableBytes ?? null,
        diskPct: pct(n.fs?.usedBytes, n.fs?.capacityBytes),
        memTotal, cores,
        topCpu: [...pods].sort((a, b) => b.cpu - a.cpu).slice(0, 3).filter(p => p.cpu > 0.01),
        topMem: [...pods].sort((a, b) => b.mem - a.mem).slice(0, 3).filter(p => p.mem > 0)
    }
}

/** Disk trend: bytes per hour and hours until full (null = not growing / too little data) */
export function diskForecast(samples, now = Date.now()) {
    let pts = samples.filter(s => s.diskUsed != null && s.diskCap && now - s.t <= FORECAST_WINDOW_MS)
    // a cleanup (usage dropped) starts a new trend
    for (let i = pts.length - 1; i > 0; i--) {
        if (pts[i].diskUsed < pts[i - 1].diskUsed - pts[i].diskCap * 0.01) { pts = pts.slice(i); break }
    }
    if (pts.length < FORECAST_MIN_POINTS || pts.at(-1).t - pts[0].t < FORECAST_MIN_SPAN_MS) return null
    // least squares: used = a + b·t
    const n = pts.length
    const mt = pts.reduce((a, p) => a + p.t, 0) / n, mu = pts.reduce((a, p) => a + p.diskUsed, 0) / n
    let num = 0, den = 0
    for (const p of pts) { num += (p.t - mt) * (p.diskUsed - mu); den += (p.t - mt) ** 2 }
    if (!den) return null
    const perHour = (num / den) * 3600e3
    const last = pts.at(-1)
    const free = last.diskAvail ?? (last.diskCap - last.diskUsed)
    if (perHour < MIN_DISK_GROWTH_BPH) return { perHour, hoursToFull: null }
    return { perHour, hoursToFull: free / perHour }
}

// Every sample of the last 15 minutes at or above `pct` (and 15 minutes of samples)
function sustained(samples, key, pct, now) {
    const recent = samples.filter(s => now - s.t <= SUSTAIN_MS + 60e3 && s[key] != null)
    if (recent.length < 3 || recent.at(-1).t - recent[0].t < SUSTAIN_MS - 2 * 60e3) return false
    return recent.every(s => s[key] >= pct)
}

const pods = (list, f) => list.length ? ` — top pods: ${list.map(p => `${p.pod} (${f(p)})`).join(', ')}` : ''

/**
 * history: { nodeName: { ip, samples: [] } } → findings.
 * isOpen(reason, node): an incident for it is open (keeps it until clearly better).
 */
export function analyzeResources(history, { now = Date.now(), isOpen = () => false } = {}) {
    const out = []
    for (const [node, h] of Object.entries(history || {})) {
        const s = h.samples || [], last = s.at(-1)
        if (!last || now - last.t > 10 * 60e3) continue   // stale
        const base = { target: node, nodeName: node, nodeIp: h.ip || null }

        // disk filling up
        const fc = diskForecast(s, now)
        const open = isOpen('NodeDiskFilling', node)
        if (fc?.hoursToFull != null && (fc.hoursToFull <= FILL_WARN_H || (open && fc.hoursToFull <= FILL_CLEAR_H))) {
            out.push({ ...base, reason: 'NodeDiskFilling', severity: fc.hoursToFull <= FILL_CRIT_H ? 'critical' : 'warning',
                message: `Disk on ${node} is ${last.diskPct}% full and growing ~${fmtBytes(fc.perHour)}/h — full in about ${fmtHours(fc.hoursToFull)}` })
        }

        // memory / CPU high for 15 minutes
        for (const [reason, key, what, top] of [
            ['NodeMemoryHigh', 'memPct', 'Memory', () => pods(last.topMem, p => fmtBytes(p.mem))],
            ['NodeCPUHigh', 'cpuPct', 'CPU', () => pods(last.topCpu, p => `${p.cpu.toFixed(2)} cores`)]
        ]) {
            const high = sustained(s, key, HIGH_PCT, now)
            const stillHigh = isOpen(reason, node) && last[key] != null && last[key] >= CLEAR_PCT
            if (!high && !stillHigh) continue
            out.push({ ...base, reason, severity: sustained(s, key, VERY_HIGH_PCT, now) ? 'critical' : 'warning',
                message: `${what} on ${node} at ${Math.round(last[key])}% for 15+ minutes${top()}` })
        }
    }
    return out
}

/** For the Incidents page: the latest numbers per node */
export function resourceView(history, now = Date.now()) {
    return Object.entries(history || {}).map(([node, h]) => {
        const last = h.samples?.at(-1)
        if (!last) return null
        const fc = diskForecast(h.samples, now)
        return {
            node, ip: h.ip || null, at: new Date(last.t).toISOString(), stale: now - last.t > 10 * 60e3,
            cpuPct: last.cpuPct, memPct: last.memPct, diskPct: last.diskPct,
            cores: last.cores, memTotal: last.memTotal, diskCap: last.diskCap,
            diskFullInHours: fc?.hoursToFull != null ? Math.round(fc.hoursToFull * 10) / 10 : null,
            topCpu: last.topCpu, topMem: last.topMem,
            trend: h.samples.slice(-30).map(x => ({ c: x.cpuPct, m: x.memPct, d: x.diskPct }))
        }
    }).filter(Boolean).sort((a, b) => a.node.localeCompare(b.node))
}
