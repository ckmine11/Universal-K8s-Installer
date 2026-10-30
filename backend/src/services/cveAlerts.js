// New CVE alerts: every 30 minutes the Trivy reports of each cluster are read;
// a critical vulnerability that has a fix and was not there before is sent to
// the alert channels (which workload, package, the fixed version). The first
// look at a cluster only remembers what is there (no flood of old findings).
// The last totals feed the risk score.
import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

const FILE = path.join(DATA_DIR, 'cve-alerts.json')
const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
const write = (all) => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all)) }
const totals = new Map()   // clusterId → { critical, high, fixableCritical, at }

/** The fixable critical findings of a summary → Map key "CVE|ns/workload" → detail */
export function fixableCriticals(summary) {
    const out = new Map()
    for (const w of summary?.workloads || []) for (const v of w.vulns || []) {
        if (v.severity !== 'CRITICAL' || !v.fixed) continue
        out.set(`${v.id}|${w.namespace}/${w.name}`, { id: v.id, workload: `${w.namespace}/${w.name}`, pkg: v.pkg, installed: v.installed, fixed: v.fixed, title: v.title })
    }
    return out
}

/** Compare with what was seen before → { fresh: [...], seen: [keys], baseline } */
export function diffFindings(prevKeys, now) {
    if (!prevKeys) return { fresh: [], seen: [...now.keys()], baseline: true }
    const before = new Set(prevKeys)
    return { fresh: [...now].filter(([k]) => !before.has(k)).map(([, v]) => v), seen: [...now.keys()], baseline: false }
}

/** One cluster: read, compare, alert. deps: readSummary(cluster), notify(cluster, ev), usable(orgId) */
export async function checkCluster(cluster, deps) {
    if (!deps.usable(cluster.orgId)) return { skip: 'feature' }
    const summary = await deps.readSummary(cluster)
    if (summary?.tools?.vulnerabilities?.state !== 'ok') return { skip: 'no Trivy' }
    const now = fixableCriticals(summary)
    totals.set(cluster.id, { critical: summary.totals.critical, high: summary.totals.high, fixableCritical: now.size, at: new Date().toISOString() })
    const all = read()
    const d = diffFindings(all[cluster.id], now)
    all[cluster.id] = d.seen.slice(0, 5000); write(all)
    if (d.fresh.length) {
        const lines = d.fresh.slice(0, 10).map(f => `${f.id} in ${f.workload}: ${f.pkg} ${f.installed} → fixed in ${f.fixed}`)
        deps.notify(cluster, {
            severity: 'critical', title: `${d.fresh.length} new fixable critical CVE${d.fresh.length === 1 ? '' : 's'} on ${cluster.clusterName}`,
            text: `${lines.join('\n')}${d.fresh.length > 10 ? `\n…and ${d.fresh.length - 10} more` : ''}\nUpdate the images (cluster → Security tab).`
        })
    }
    return { fresh: d.fresh.length, baseline: d.baseline }
}
/** The last totals of a cluster for the risk score, or null. */
export const lastCveTotals = (clusterId) => totals.get(clusterId) || null
export const _test = { reset: () => { totals.clear(); try { fs.rmSync(FILE, { force: true }) } catch { } } }

export async function startCveAlerts() {
    const [{ clusterStore }, { features }, sec, { notifier }] = await Promise.all([import('./clusterStore.js'), import('./features.js'), import('./security.js'), import('./notifier.js')])
    const deps = {
        usable: (orgId) => features.usable(orgId, 'cveAlerts') && features.usable(orgId, 'security'),
        readSummary: async (c) => sec.summarizeSecurity(await sec.readSecurity(c, { fresh: true })),
        notify: (c, ev) => notifier.emit(c.orgId, { type: 'cve_alert', key: `cve|${c.id}|${ev.title}`, clusterId: c.id, clusterName: c.clusterName, link: `/cluster/${c.id}?tab=security`, ...ev })
    }
    const run = async () => {
        for (const c of await clusterStore.getClusters().catch(() => [])) {
            if (c.status === 'failed' && c.mode === 'install') continue
            await checkCluster(c, deps).catch(() => { })   // an unreachable cluster is the detector's job to report
        }
    }
    setTimeout(run, 2 * 60e3).unref?.()
    setInterval(run, 30 * 60e3).unref?.()
}
