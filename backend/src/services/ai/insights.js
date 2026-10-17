// What KubeEZ knows about clusters, for one member — risk, fleet, advisor.
// Shared by the web pages and the MCP server, so both answer the same and
// apply the same access rules (visible clusters, incident view, namespaces).
import { incidentDetector } from '../incidentDetector.js'
import { clusterStore } from '../clusterStore.js'
import { complianceStore } from '../complianceService.js'
import { offsiteStore } from '../offsiteStore.js'
import { addonSettingsStore } from '../addonSettings.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../accessControl.js'
import { canAccessResource } from '../../utils/access.js'
import { riskScore, newestSnapshot, cachedSnapshot } from './risk.js'
import { fleetView } from './fleet.js'
import { ADVISOR_SCRIPT, analyze as analyzeAdvisor } from './advisor.js'
import { aiStore } from './aiStore.js'
import { onCluster } from './incidentExplain.js'

const CLOSED = new Set(['resolved', 'cleared'])
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref?.())])

async function sshTo(cluster) {
    const { automationEngine } = await import('../automationEngine.js')
    const master = cluster.masterNodes?.[0]
    if (!master) throw new Error('No control-plane node saved for this cluster')
    return automationEngine.connectSSH({ ...master, ownerId: cluster.ownerId, orgId: cluster.orgId })
}

/** The clusters this member may see. */
export async function visibleClusters(user) {
    return (await clusterStore.getClusters().catch(() => [])).filter(c => canAccessResource(user, c) && canSeeCluster(user, c))
}
/** A cluster by id or name, if the member may see it. */
export async function findCluster(user, ref) {
    const all = await visibleClusters(user)
    const r = String(ref || '').trim().toLowerCase()
    return all.find(c => c.id.toLowerCase() === r) || all.find(c => String(c.clusterName).toLowerCase() === r) || null
}
/** Open problems the member may see (one cluster or all). */
export function openIncidents(user, clusters) {
    const byId = new Map(clusters.map(c => [c.id, c]))
    return incidentDetector.getIncidents().filter(i => byId.has(i.clusterId) && !CLOSED.has(i.status) && !i.causedBy && canOn(user, 'incident:view', byId.get(i.clusterId)))
}

export async function riskOf(cluster, { deep }) {
    const m = incidentDetector.getMonitoring().find(x => x.clusterId === cluster.id)
    const latest = complianceStore.reports(cluster.id)[0]
    return riskScore({
        cluster,
        incidents: incidentDetector.getIncidents().filter(i => i.clusterId === cluster.id && !CLOSED.has(i.status) && !i.causedBy),
        monitoring: m ? { watched: true, connected: m.connected } : { watched: false },
        maintenanceUntil: m?.maintenance?.until || null,
        snapshot: deep ? await withTimeout(newestSnapshot(cluster, sshTo), 20000, 'timeout').catch(e => ({ newestAt: null, error: `Could not check: ${e.message}` })) : cachedSnapshot(cluster.id),
        offsite: !!offsiteStore.getConnected(cluster.orgId),
        compliance: latest ? { score: latest.score, at: latest.at } : null
    })
}

/** The whole fleet the member can see — facts, no cluster calls. */
export async function fleetFor(user) {
    const clusters = (await visibleClusters(user)).filter(c => c.status !== 'failed')
    const incidents = openIncidents(user, clusters)
    const risks = {}
    for (const c of clusters) { const r = await riskOf(c, { deep: false }); risks[c.id] = { score: r.score, level: r.level, top: r.factors[0]?.label || null } }
    return fleetView({ clusters, incidents, risks, addonVersion: (cid, key) => addonSettingsStore.get(cid, key)?.applied?.version || null })
}

// ── advisor (read-only, cached 5 minutes) ──
const advCache = new Map()
export async function advisorFor(user, cluster, refresh = false) {
    const hit = advCache.get(cluster.id)
    let a = !refresh && hit && Date.now() - hit.at < 5 * 60e3 ? hit.value : null
    if (!a) {
        const out = await withTimeout(onCluster(cluster, async (ssh) => (await ssh.execCommand(ADVISOR_SCRIPT)).stdout || ''), 90000, 'The cluster did not answer in time')
        if (!/==END==/.test(out)) throw Object.assign(new Error('Could not read the cluster'), { status: 502 })
        a = analyzeAdvisor(out, { rates: aiStore.get(cluster.orgId).costRates })
        advCache.set(cluster.id, { at: Date.now(), value: a })
    }
    // members limited to some namespaces see only those
    const nss = accessOn(user, cluster).namespaces
    if (!nss) return a
    const mine = (ns) => nsMatches(nss, ns)
    return { ...a, security: { ...a.security, findings: a.security.findings.filter(f => mine(f.namespace)) }, cost: { ...a.cost, workloads: a.cost.workloads.filter(w => mine(w.namespace)), nodes: null, savings: null }, limited: true }
}
