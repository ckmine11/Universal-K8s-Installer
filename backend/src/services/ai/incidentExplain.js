// The whole incident explanation — fresh cluster data, the changes before it,
// what fixed it before — in one place, for the web page and for chat (ChatOps).
// Answers are kept 10 minutes per incident state, so asking from chat and from
// the page does not cost two model calls.
import { incidentDetector } from '../incidentDetector.js'
import { CATALOG } from '../../config/incidentCatalog.js'
import { explainIncident, collectIncidentData } from './doctor.js'
import { collectChanges } from './changes.js'
import { suggest as suggestRunbook } from './runbooks.js'

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref?.())])

export async function onCluster(cluster, fn) {
    const { automationEngine } = await import('../automationEngine.js')
    const master = cluster.masterNodes?.[0]
    if (!master) throw Object.assign(new Error('No control-plane node saved for this cluster'), { status: 400 })
    const ssh = await automationEngine.connectSSH({ ...master, ownerId: cluster.ownerId, orgId: cluster.orgId })
    try { return await fn(ssh) } finally { ssh.dispose?.() }
}

export const explainKey = (inc) => `inc:${inc.id}:${inc.lastSeen}:${inc.status}`

const cache = new Map()   // explainKey → { at, value, promise }
export async function explainIncidentFull(user, inc, cluster, { fresh: forceFresh = false } = {}) {
    const key = `${explainKey(inc)}:${user.language || ''}`   // answers are in the asker's language
    const hit = cache.get(key)
    if (!forceFresh && hit?.value && Date.now() - hit.at < 10 * 60e3) return { ...hit.value, cached: true }
    if (!forceFresh && hit?.promise) return hit.promise
    const promise = (async () => {
        // fresh cluster data and the changes before it, side by side — best effort, never blocks the answer
        const t0 = Date.parse(inc.timestamp)
        const [freshR, changes] = await Promise.all([
            withTimeout(onCluster(cluster, (ssh) => collectIncidentData(ssh, inc)), 35000, 'the cluster did not answer in time').then(v => ({ v }), e => ({ e })),
            withTimeout(collectChanges(cluster, { from: t0 - 3 * 3600e3, to: Math.max(Date.parse(inc.lastSeen || inc.timestamp), t0) + 60e3 }), 45000, 'timeout').then(c => c.items, () => [])
        ])
        const fresh = freshR.v || { data: [], workload: null }
        const related = inc.causedBy ? incidentDetector.find(inc.causedBy) : null
        const runbook = suggestRunbook(cluster.orgId, inc.reason, fresh.workload)
        const out = await explainIncident(user, { incident: inc, catalog: CATALOG[inc.reason], cluster, fresh, changes, related, runbook })
        return { ...out, runbook, changes: changes.slice(0, 15), freshError: freshR.e?.message || null }
    })()
    cache.set(key, { promise })
    try {
        const value = await promise
        cache.set(key, { at: Date.now(), value })
        if (cache.size > 200) cache.delete(cache.keys().next().value)
        return value
    } catch (e) { cache.delete(key); throw e }
}
