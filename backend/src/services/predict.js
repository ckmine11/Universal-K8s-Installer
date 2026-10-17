// Predictions — problems seen coming, from data KubeEZ already collects (no
// extra cluster calls):
//   MemoryLeakSuspected  a container's memory climbs steadily toward its limit
//                        → "out of memory in ~3 h" (before the OOM kill)
//   RestartsRising       a pod keeps restarting but is not (yet) in a crash loop
// Pure functions; the incident detector keeps the history and opens incidents.

export const PREDICT_REASONS = new Set(['MemoryLeakSuspected', 'RestartsRising'])

const WINDOW_MS = 6 * 3600e3        // trend from the last 6 hours
const MIN_SPAN_MS = 45 * 60e3       // …at least 45 minutes of it
const MIN_POINTS = 6
const MIN_R2 = 0.75                 // a steady climb, not noise
const MIN_USE = 0.5                 // only containers already at half their limit
const MIN_GROWTH = 0.01             // ≥ 1 % of the limit per hour
const WARN_H = 24, CLEAR_H = 48
const SERIES_MAX = 200
const RESTART_WINDOW_MS = 3600e3, RESTARTS_WARN = 5

const GB = 1024 ** 3
const fmtBytes = (b) => b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`
const fmtHours = (h) => h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`
const MULT = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }
const bytes = (q) => { const m = /^([\d.]+)([a-zA-Z]*)$/.exec(String(q ?? '').trim()); return m && MULT[m[2]] != null ? parseFloat(m[1]) * MULT[m[2]] : null }

/** From `kubectl get pods -A -o json`: memory limits per container and restart counts per pod. */
export function podFacts(data) {
    const limits = new Map(), restarts = new Map()
    for (const p of data?.items || []) {
        const ns = p.metadata?.namespace, name = p.metadata?.name
        if (!ns || !name) continue
        const owner = p.metadata?.ownerReferences?.[0]
        const ownerHint = owner ? `${owner.kind}/${owner.name}` : null
        for (const c of p.spec?.containers || []) {
            const lim = bytes(c.resources?.limits?.memory)
            if (lim) limits.set(`${ns}/${name}/${c.name}`, { limit: lim, ownerHint, nodeName: p.spec?.nodeName || null })
        }
        const st = p.status?.containerStatuses || []
        restarts.set(`${ns}/${name}`, {
            count: st.reduce((a, c) => a + (c.restartCount || 0), 0), ownerHint, nodeName: p.spec?.nodeName || null,
            crashLoop: st.some(c => c.state?.waiting?.reason === 'CrashLoopBackOff'),
            lastReason: st.map(c => c.lastState?.terminated?.reason).find(Boolean) || null
        })
    }
    return { limits, restarts }
}

/** Per-container memory (workingSet) from the resource script's kubelet summaries. */
export function containerMemory(out) {
    const mem = new Map()
    for (const part of String(out || '').split(/^==/m)) {
        if (!part.startsWith('NODE ')) continue
        let s; try { s = JSON.parse(part.slice(part.indexOf('\n') + 1)) } catch { continue }
        for (const p of s?.pods || []) for (const c of p.containers || []) {
            const v = c.memory?.workingSetBytes
            if (v != null && p.podRef?.namespace && p.podRef?.name) mem.set(`${p.podRef.namespace}/${p.podRef.name}/${c.name}`, v)
        }
    }
    return mem
}

/** Keep the memory series of containers worth watching (a limit, ≥ 40 % used); drop gone ones. */
export function recordMemory(series, mem, limits, now = Date.now()) {
    for (const k of [...series.keys()]) if (!mem.has(k) || !limits.has(k)) series.delete(k)
    for (const [k, v] of mem) {
        const l = limits.get(k)
        if (!l || (v < l.limit * 0.4 && !series.has(k))) continue
        const s = series.get(k) || []
        // a big drop = the container restarted: a new trend starts
        if (s.length && v < s.at(-1).v * 0.8) s.length = 0
        s.push({ t: now, v })
        if (s.length > SERIES_MAX) s.splice(0, s.length - SERIES_MAX)
        series.set(k, s)
    }
    return series
}

/** Least squares v = a + b·t → { perHour, r2 } */
export function trend(points) {
    const n = points.length
    if (n < 2) return null
    const mt = points.reduce((a, p) => a + p.t, 0) / n, mv = points.reduce((a, p) => a + p.v, 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (const p of points) { sxy += (p.t - mt) * (p.v - mv); sxx += (p.t - mt) ** 2; syy += (p.v - mv) ** 2 }
    if (!sxx) return null
    return { perHour: (sxy / sxx) * 3600e3, r2: syy ? (sxy * sxy) / (sxx * syy) : 0 }
}

/** Containers heading for their memory limit → findings (reason MemoryLeakSuspected, target = pod). */
export function memoryFindings(series, limits, { now = Date.now(), isOpen = () => false } = {}) {
    const out = []
    for (const [k, all] of series) {
        const l = limits.get(k)
        if (!l) continue
        const pts = all.filter(p => now - p.t <= WINDOW_MS)
        if (pts.length < MIN_POINTS || pts.at(-1).t - pts[0].t < MIN_SPAN_MS) continue
        const tr = trend(pts)
        const [ns, pod, container] = k.split('/')
        const last = pts.at(-1).v
        const hours = tr && tr.perHour > 0 ? (l.limit - last) / tr.perHour : Infinity
        const open = isOpen(pod, ns)
        const steady = tr && tr.r2 >= MIN_R2 && tr.perHour >= l.limit * MIN_GROWTH && last >= l.limit * MIN_USE
        if ((steady && hours <= WARN_H) || (open && tr && tr.perHour > 0 && hours <= CLEAR_H)) {
            out.push({
                reason: 'MemoryLeakSuspected', target: pod, namespace: ns, nodeName: l.nodeName, ownerHint: l.ownerHint,
                message: `${ns}/${pod} (${container}) memory keeps growing ~${fmtBytes(tr.perHour)}/h — ${fmtBytes(last)} of its ${fmtBytes(l.limit)} limit, out of memory in ~${fmtHours(Math.max(0, hours))}`,
                hoursLeft: Math.max(0, hours)
            })
        }
    }
    return out
}

/** Restart counts over time → pods that keep restarting without being in a crash loop. */
export function recordRestarts(history, restarts, now = Date.now()) {
    for (const k of [...history.keys()]) if (!restarts.has(k)) history.delete(k)
    for (const [k, r] of restarts) {
        const h = history.get(k) || []
        h.push({ t: now, count: r.count })
        while (h.length && now - h[0].t > 2 * RESTART_WINDOW_MS) h.shift()
        history.set(k, h)
    }
    return history
}
export function restartFindings(history, restarts, { now = Date.now() } = {}) {
    const out = []
    for (const [k, h] of history) {
        const r = restarts.get(k)
        if (!r || r.crashLoop || h.length < 2) continue   // a crash loop has its own incident
        const base = h.find(p => now - p.t <= RESTART_WINDOW_MS) || h[0]
        const n = h.at(-1).count - base.count
        if (n >= RESTARTS_WARN) {
            const [ns, pod] = k.split('/')
            out.push({
                reason: 'RestartsRising', target: pod, namespace: ns, nodeName: r.nodeName, ownerHint: r.ownerHint,
                message: `${ns}/${pod} restarted ${n} times in the last hour${r.lastReason ? ` (last: ${r.lastReason})` : ''} — not yet a crash loop`
            })
        }
    }
    return out
}
