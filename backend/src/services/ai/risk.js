// Risk score — how likely is this cluster to break soon, and why. 100 = no
// known risk. Every point taken off is a named reason with how to fix it, so
// the number is never a mystery. Facts only (no AI): open incidents and
// predictions, whether KubeEZ can watch it, backups, Kubernetes support,
// control-plane redundancy, compliance.
import { LATEST_K8S_MINOR } from '../complianceScanner.js'

const minorOf = (v) => Number((String(v || '').replace(/^v/, '').match(/^\d+\.(\d+)/) || [])[1]) || null
const PREDICTIONS = new Set(['NodeDiskFilling', 'MemoryLeakSuspected', 'CertExpiring', 'RestartsRising', 'ControlPlaneDiskFull', 'NodeMemoryHigh', 'NodeCPUHigh'])
const ago = (ms) => { const h = ms / 3600e3; return h < 1 ? `${Math.max(1, Math.round(ms / 60e3))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days` }

/**
 * facts: { cluster, incidents (open, this cluster), monitoring: { watched, connected },
 *          snapshot: { newestAt|null, error? } | undefined, offsite: bool, compliance: { score, at } | null,
 *          maintenanceUntil, now }
 * → { score, level, factors: [{ key, label, points, detail, fix, link }], good: [string], partial }
 */
export function riskScore(f) {
    const now = f.now ?? Date.now()
    const factors = [], good = []
    const add = (key, points, label, detail, fix, link = null) => factors.push({ key, points, label, detail, fix, link })
    const c = f.cluster

    // what is wrong right now — and what is coming
    const open = f.incidents || []
    const crit = open.filter(i => i.severity === 'critical'), warn = open.filter(i => i.severity !== 'critical' && i.severity !== 'info')
    const pred = open.filter(i => PREDICTIONS.has(i.reason))
    const nowIssues = (list) => list.filter(i => !PREDICTIONS.has(i.reason))
    if (nowIssues(crit).length) add('critical', Math.min(45, 25 * nowIssues(crit).length), `${nowIssues(crit).length} critical problem(s) now`, nowIssues(crit).slice(0, 3).map(i => `${i.reason}: ${i.target}`).join(', '), 'Open them on Incidents — fix those first.', '/incidents')
    if (nowIssues(warn).length) add('warnings', Math.min(24, 6 * nowIssues(warn).length), `${nowIssues(warn).length} open warning(s)`, nowIssues(warn).slice(0, 3).map(i => `${i.reason}: ${i.target}`).join(', '), 'See Incidents; "Explain with AI" shows the cause.', '/incidents')
    if (pred.length) add('predicted', Math.min(30, 10 * pred.length), `${pred.length} problem(s) predicted`, pred.slice(0, 3).map(i => i.message || `${i.reason}: ${i.target}`).join(' · '), 'Act before it happens (disk cleanup, renew certificates, a rolling restart for a memory leak…).', '/incidents')
    if (!open.length) good.push('No open problems')

    // can KubeEZ see it at all?
    if (!f.monitoring?.watched) add('unwatched', 15, 'Not watched', 'KubeEZ is not checking this cluster, so problems are not seen.', 'Check that the cluster is reachable (SSH or Gateway Agent).')
    else if (!f.monitoring.connected) add('unreachable', 20, 'KubeEZ cannot reach it', 'Health checks fail to connect — nothing is watched or healed meanwhile.', 'Check the machine, the network and the Gateway Agent.', '/agents')
    else good.push('Watched every few minutes')
    if (f.maintenanceUntil && Date.parse(f.maintenanceUntil) > now) add('maintenance', 5, 'In maintenance', `No checks, fixes or alerts until ${new Date(f.maintenanceUntil).toLocaleString()}.`, 'End maintenance when the work is done.', '/incidents')

    // backups
    if (f.snapshot) {
        if (f.snapshot.error) add('backup-unknown', 5, 'Backups not checked', f.snapshot.error, 'Open Backups to check the snapshots.', `/cluster/${c.id}?tab=backups`)
        else if (!f.snapshot.newestAt) add('no-backup', 20, 'No etcd snapshot', 'If the control-plane is lost, the cluster cannot be restored.', 'Backups → Back up now (KubeEZ also takes one before every upgrade).', `/cluster/${c.id}?tab=backups`)
        else {
            const age = now - Date.parse(f.snapshot.newestAt)
            if (age > 14 * 86400e3) add('old-backup', 10, 'Last snapshot is old', `The newest etcd snapshot is ${ago(age)} old.`, 'Take a fresh snapshot (Backups → Back up now).', `/cluster/${c.id}?tab=backups`)
            else if (age > 7 * 86400e3) add('old-backup', 5, 'Last snapshot is over a week old', `${ago(age)} old.`, 'Take a fresh snapshot.', `/cluster/${c.id}?tab=backups`)
            else good.push(`etcd snapshot ${ago(age)} old`)
        }
    }
    if (f.offsite === false) add('no-offsite', 5, 'Snapshots only on the node', 'If the machine is lost, its snapshots are lost with it.', 'Connect offsite backups (S3 / MinIO / R2) in Backups.', `/cluster/${c.id}?tab=backups`)
    else if (f.offsite) good.push('Offsite backups connected')

    // Kubernetes support and redundancy
    const minor = minorOf(c.k8sVersion)
    if (minor) {
        const behind = LATEST_K8S_MINOR - minor
        if (behind >= 3) add('unsupported', 15, `Kubernetes ${c.k8sVersion} is out of support`, `No more security fixes upstream (supported: 1.${LATEST_K8S_MINOR - 2}–1.${LATEST_K8S_MINOR}).`, 'Upgrade one minor version at a time — KubeEZ takes a snapshot first and rolls back on failure.', `/cluster/${c.id}`)
        else if (behind === 2) add('oldest-supported', 4, `Kubernetes ${c.k8sVersion} leaves support next`, 'It is the oldest supported minor version.', 'Plan the next upgrade.', `/cluster/${c.id}`)
        else good.push(`Kubernetes ${c.k8sVersion} is supported`)
    }
    const cps = (c.masterNodes || []).length
    if (cps <= 1) add('single-cp', 10, 'One control-plane', 'If that machine fails, the cluster cannot be managed until it is rebuilt.', 'For production: 3 control-planes behind a virtual IP (new cluster with HA in the wizard).')
    else good.push(`${cps} control-planes${c.controlPlaneVip ? ` behind ${c.controlPlaneVip}` : ''}`)

    // compliance
    if (f.compliance?.score != null) {
        if (f.compliance.score < 60) add('compliance', 5, `Compliance score ${f.compliance.score}`, 'Many security controls fail.', 'Compliance → see the failing controls and their fixes.', '/compliance')
        else good.push(`Compliance ${f.compliance.score}/100`)
    }

    const score = Math.max(0, 100 - factors.reduce((a, x) => a + x.points, 0))
    factors.sort((a, b) => b.points - a.points)
    return { score, level: score >= 80 ? 'low' : score >= 50 ? 'medium' : 'high', factors, good, partial: !f.snapshot }
}

// ── gathering the facts ──
const snapCache = new Map()   // clusterId → { at, value }
/** The last snapshot check, if one ran in the last 10 minutes (no cluster call) — keeps the list and the card in step. */
export const cachedSnapshot = (clusterId) => { const h = snapCache.get(clusterId); return h && Date.now() - h.at < 10 * 60e3 ? h.value : undefined }
/** Newest etcd snapshot on the control-plane (read-only; cached 10 minutes). */
export async function newestSnapshot(cluster, connect) {
    const hit = snapCache.get(cluster.id)
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.value
    let value
    try {
        const ssh = await connect(cluster)
        try {
            const r = await ssh.execCommand("sudo bash -c 'ls -1t /var/lib/etcd-backup/*.db 2>/dev/null | head -1 | xargs -r stat -c %Y'")
            const t = Number((r.stdout || '').trim())
            value = { newestAt: t ? new Date(t * 1000).toISOString() : null }
        } finally { ssh.dispose?.() }
    } catch (e) { value = { newestAt: null, error: `Could not check: ${e.message}` } }
    snapCache.set(cluster.id, { at: Date.now(), value })
    return value
}
