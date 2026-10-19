// Connects learned runbooks to the incident detector: learn when incidents
// close, check new incidents for an automatic runbook, and mark fixes that did
// not help (every 10 minutes).
import { incidentDetector } from '../incidentDetector.js'
import { healingPolicyStore } from '../healingPolicyStore.js'
import { approvalStore } from '../approvalStore.js'
import { auditLog } from '../auditLog.js'
import { CATALOG } from '../../config/incidentCatalog.js'
import { onIncidentClosed, maybeAutoRun, sweep } from './runbooks.js'
import { resolveWorkload } from './doctor.js'

async function onCluster(cluster, fn) {
    const { connectCluster } = await import('../clusterAccess.js')
    const ssh = await connectCluster(cluster)
    try { return await fn(ssh) } finally { ssh.dispose?.() }
}

export const depsFor = (cluster) => ({
    resolveWorkload: (inc) => onCluster(cluster, (ssh) => resolveWorkload(ssh, inc)).catch(() => null),
    onCluster: (fn) => onCluster(cluster, fn),
    approvalsOn: (orgId) => !!approvalStore.settings(orgId).actions?.['ai:action'],
    maintenance: (orgId, clusterId) => healingPolicyStore.inMaintenance(orgId, clusterId),
    builtinAuto: (orgId, reason) => !!CATALOG[reason]?.fixable && healingPolicyStore.policy(orgId, reason) === 'auto',
    timeline: (inc, text) => { incidentDetector._tl(inc, 'action', text, 'KubeEZ AI'); incidentDetector._save() },
    notify: async (rb, rec) => {
        auditLog.record({ orgId: cluster.orgId, actor: null, action: 'ai.runbook_auto', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `${rec.title} — automatic runbook (worked ${rb.successes} of ${rb.successes + rb.failures} times)` })
        const { notifier } = await import('../notifier.js')
        notifier.emit(cluster.orgId, {
            type: 'incident', severity: 'info', key: `runbook|${rec.id}`,
            title: `KubeEZ AI ran a runbook: ${rec.title}`,
            text: `It fixed this problem ${rb.successes} time(s) before. Undo within 24 hours on the incident or under AI → What changed.`,
            clusterId: cluster.id, clusterName: cluster.clusterName, link: '/incidents'
        })
    }
})

let started = false
export function startRunbooks() {
    if (started) return
    started = true
    incidentDetector.on('close', (inc) => onIncidentClosed(inc))
    incidentDetector.on('create', async (cluster, inc) => {
        const r = await maybeAutoRun(cluster, inc, depsFor(cluster))
        if (r.ran) console.log(`[KubeEZ AI] runbook ran on ${cluster.clusterName}: ${r.rec.title}`)
    })
    setInterval(() => { try { sweep((id) => incidentDetector.find(id)) } catch (e) { console.warn('[KubeEZ AI] runbook sweep:', e.message) } }, 10 * 60e3).unref?.()
}
