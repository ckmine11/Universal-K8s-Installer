import { clusterStore } from './clusterStore.js'
import { canAccessResource } from '../utils/access.js'

// SSH passwords / keys never travel to the browser. Records sent to the UI carry
// only whether a credential is stored; requests that act on an EXISTING cluster
// (scale, re-verify) send its id and the server fills in the stored credentials.

export function stripCredentials(record) {
    if (!record) return record
    const strip = (nodes) => (nodes || []).map(({ password, sshKey, ...n }) => ({
        ...n, hasPassword: !!password, hasSshKey: !!sshKey
    }))
    // an imported cluster: how it is reached, never its token
    const access = record.access ? (({ token, ca, ...a }) => ({ ...a, hasToken: !!token, hasCa: !!ca }))(record.access) : undefined
    // its cloud account: which one, never the keys
    const cloud = record.cloud ? (({ creds, ...c }) => ({ ...c, hasCreds: !!creds }))(record.cloud) : undefined
    return { ...record, masterNodes: strip(record.masterNodes), workerNodes: strip(record.workerNodes), ...(record.sshNodes ? { sshNodes: strip(record.sshNodes) } : {}), ...(access ? { access } : {}), ...(cloud ? { cloud } : {}) }
}

/**
 * For nodes sent without a password/key, use the ones stored for the same IP
 * (and user) in the given cluster — only if the caller may access that cluster.
 */
export async function fillStoredCredentials(user, clusterId, nodes) {
    if (!clusterId || !Array.isArray(nodes)) return nodes
    const cluster = (await clusterStore.getClusters()).find(c => c.id === clusterId)
    if (!cluster || !canAccessResource(user, cluster)) return nodes
    const stored = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])]
    return nodes.map(n => {
        if (!n || n.password || n.sshKey) return n
        const s = stored.find(x => x.ip === n.ip && (!n.username || x.username === n.username))
        return s ? { ...n, username: n.username || s.username, password: s.password, sshKey: s.sshKey } : n
    })
}
