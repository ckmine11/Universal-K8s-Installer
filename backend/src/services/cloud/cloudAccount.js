// A connected cluster's cloud account: node pools and Kubernetes upgrades
// through the provider's own API (EKS, AKS, GKE, OKE, DOKS, LKE).
//
// Stored on the cluster as cloud: { provider, ref, creds (encrypted JSON),
// identity, connectedAt, lastError? } — the credentials never leave the server.
import { cloudApiFor, cmpVersion } from './providers.js'
import { clusterStore } from '../clusterStore.js'
import { encrypt, decrypt } from '../../utils/cryptoUtils.js'
import { auditLog } from '../auditLog.js'

const bad = (m, status = 400) => Object.assign(new Error(m), { status })

// the node label that names a node's pool, per provider (for the live count)
const POOL_LABEL = { eks: 'eks.amazonaws.com/nodegroup', aks: 'kubernetes.azure.com/agentpool', gke: 'cloud.google.com/gke-nodepool', doks: 'doks.digitalocean.com/node-pool-id', lke: 'lke.linode.com/pool-id' }

const strOnly = (o, keys) => Object.fromEntries(keys.map(k => [k, o?.[k] == null ? '' : String(o[k]).trim()]).filter(([, v]) => v !== ''))

/** The API for this cluster's provider, or a 400 with what is supported. */
export function apiFor(cluster) {
    const api = cloudApiFor(cluster.provider)
    if (!api) throw bad(`Node pools and upgrades from KubeEZ are available for EKS, AKS, GKE, OKE, DOKS and LKE — ${cluster.provider || 'this provider'} is managed in its own console.`)
    return api
}
function accountOf(cluster) {
    if (!cluster.cloud?.creds) throw Object.assign(bad('No cloud account connected for this cluster — add one in its connection settings.', 409), { code: 'NO_CLOUD_ACCOUNT' })
    let creds
    try { creds = JSON.parse(decrypt(cluster.cloud.creds)) } catch { throw bad('The stored cloud account could not be read — connect it again.', 409) }
    return { ref: cluster.cloud.ref || {}, creds }
}

/** What the browser may see: where, who, when — never the credentials. */
export function cloudView(cluster) {
    const api = cloudApiFor(cluster.provider)
    if (!api) return { supported: false }
    const c = cluster.cloud
    return {
        supported: true, provider: api.id, providerName: api.name, fields: api.fields,
        defaults: Object.fromEntries(api.fields.ref.filter(f => f.fromCluster).map(f => [f.key, cluster.clusterName])),
        setup: api.setup({ ...(c?.ref || {}), ...(!c?.ref?.clusterName ? { clusterName: '' } : {}) }),
        connected: !!c?.creds, ref: c?.ref || null, identity: c?.identity || null, connectedAt: c?.connectedAt || null, lastError: c?.lastError || null,
        poolUpgrades: api.upgradePool !== null
    }
}

/** Check the credentials against this cluster, then keep them (encrypted). */
export async function connectCloud(cluster, body, user) {
    const api = apiFor(cluster)
    const ref = strOnly(body?.ref, api.fields.ref.map(f => f.key))
    // a blank secret field on an edit keeps the stored one
    let prev = {}
    if (cluster.cloud?.creds) { try { prev = JSON.parse(decrypt(cluster.cloud.creds)) } catch { } }
    const creds = { ...strOnly(prev, api.fields.creds.map(f => f.key)), ...strOnly(body?.creds, api.fields.creds.map(f => f.key)) }
    for (const f of api.fields.ref) if (!f.optional && !ref[f.key]) throw bad(`${f.label} is required`)
    for (const f of api.fields.creds) if (!f.optional && !creds[f.key]) throw bad(`${f.label} is required`)
    const r = await api.test({ ref, creds })
    // the account must be for THIS cluster: the versions should agree (one minor apart: an upgrade under way)
    const mm = (v) => String(v || '').replace(/^v/, '').split('.').slice(0, 2).map(n => parseInt(n, 10))
    const [x, y] = [mm(r.version), mm(cluster.k8sVersion)]
    if (r.version && cluster.k8sVersion && (x[0] !== y[0] || Math.abs(x[1] - y[1]) > 1)) throw bad(`That cloud cluster runs Kubernetes ${r.version}, this one ${cluster.k8sVersion} — is it the same cluster?`, 409)
    const fresh = (await clusterStore.getClusters()).find(x => x.id === cluster.id) || cluster
    await clusterStore.saveCluster({ ...fresh, cloud: { provider: api.id, ref, creds: encrypt(JSON.stringify(creds)), identity: r.identity, connectedAt: new Date().toISOString() } })
    auditLog.record({ orgId: user.orgId, actor: user, action: 'cluster.cloud_connected', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `${api.name} · ${r.identity}` })
    return { identity: r.identity }
}

export async function disconnectCloud(cluster, user) {
    const fresh = (await clusterStore.getClusters()).find(x => x.id === cluster.id) || cluster
    const { cloud, ...rest } = fresh
    await clusterStore.saveCluster({ ...rest, cloud: null })
    auditLog.record({ orgId: user.orgId, actor: user, action: 'cluster.cloud_disconnected', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: cloud?.identity || null })
}

async function remember(cluster, error) {
    const fresh = (await clusterStore.getClusters()).find(x => x.id === cluster.id)
    if (!fresh?.cloud) return
    const lastError = error ? String(error.message).slice(0, 300) : null
    if ((fresh.cloud.lastError || null) === lastError) return
    await clusterStore.saveCluster({ ...fresh, cloud: { ...fresh.cloud, lastError } })
}

// nodes per pool, as Kubernetes sees them (best effort)
async function liveCounts(cluster) {
    const key = POOL_LABEL[cluster.provider]
    if (!key) return null
    try {
        const { apiShell, usesApi } = await import('../clusterAccess.js')
        if (!usesApi(cluster)) return null
        const r = await apiShell(cluster).execCommand(`kubectl get nodes -o json --request-timeout=10s`, { timeoutMs: 20000 })
        const out = {}
        for (const n of JSON.parse(r.stdout).items || []) {
            const p = n.metadata?.labels?.[key]
            if (!p) continue
            const ready = (n.status?.conditions || []).find(c => c.type === 'Ready')?.status === 'True'
            out[p] ||= { nodes: 0, ready: 0 }
            out[p].nodes++; if (ready) out[p].ready++
        }
        return out
    } catch { return null }
}

/** The cluster as its provider sees it: version, upgrades, node pools. */
export async function cloudOverview(cluster) {
    const api = apiFor(cluster)
    const a = accountOf(cluster)
    try {
        const [o, live] = await Promise.all([api.overview(a), liveCounts(cluster)])
        await remember(cluster, null)
        const pools = o.pools.map(p => ({
            ...p, live: live ? live[p.id] || live[p.name] || { nodes: 0, ready: 0 } : null,
            // a pool behind the control plane can follow it
            upgradeTo: api.upgradePool === null ? null : p.upgrades?.length ? p.upgrades.sort((x, y) => cmpVersion(y, x))[0] : o.poolRecycle ? 'recycle' : p.version && o.version && cmpVersion(String(o.version).split('-')[0], String(p.version).split('-')[0]) > 0 ? o.version.split('-')[0] : null
        }))
        return { provider: api.id, providerName: api.name, ...o, pools, poolUpgrades: api.upgradePool !== null, checkedAt: new Date().toISOString() }
    } catch (e) {
        await remember(cluster, e)
        throw e
    }
}

const sizeOf = (v, name) => {
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw bad(`${name}: a whole number from 0 to 1000`)
    return n
}

export async function scalePool(cluster, poolId, body, user) {
    const api = apiFor(cluster)
    const a = accountOf(cluster)
    const count = sizeOf(body?.count, 'Nodes'), min = sizeOf(body?.min, 'Min'), max = sizeOf(body?.max, 'Max')
    if (count == null && (min == null || max == null)) throw bad('Give the node count (or min and max for an autoscaled pool).')
    if (min != null && max != null && min > max) throw bad('Min is more than max.')
    const pool = String(poolId || '')
    const o = await api.overview(a)
    const p = o.pools.find(x => x.id === pool)
    if (!p) throw bad('No such node pool in this cluster.', 404)
    if (p.busy) throw bad(`${p.name} is busy (${p.status}) — wait until it is done.`, 409)
    // the last pool to 0 would leave nowhere for the system pods
    if (count === 0 && o.pools.filter(x => x.id !== pool).every(x => (x.count || 0) === 0 && !x.autoscale)) throw bad('That would leave the cluster without nodes.', 409)
    const r = await api.scale(a, pool, { count, min, max })
    const what = count != null ? `${p.count ?? '?'} → ${count} nodes` : `min–max ${p.min ?? '?'}–${p.max ?? '?'} → ${min}–${max}`
    auditLog.record({ orgId: user.orgId, actor: user, action: 'cluster.pool_scaled', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `${api.name} pool ${p.name}: ${what}` })
    return { ok: true, pool: p.name, operation: r.operation || null }
}

export async function upgradeCluster(cluster, version, user) {
    const api = apiFor(cluster)
    const a = accountOf(cluster)
    const o = await api.overview(a)
    const v = String(version || '')
    if (!o.upgrades.includes(v)) throw bad(`${v || 'That version'} is not an upgrade the provider offers for this cluster (${o.upgrades.join(', ') || 'none right now'}).`)
    if (o.busy) throw bad(`The cluster is busy (${o.status}) — wait until it is done.`, 409)
    const r = await api.upgrade(a, v)
    auditLog.record({ orgId: user.orgId, actor: user, action: 'cluster.cloud_upgrade', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `${api.name}: control plane ${o.version} → ${v}` })
    return { ok: true, from: o.version, to: v, operation: r.operation || null }
}

export async function upgradePool(cluster, poolId, version, user) {
    const api = apiFor(cluster)
    if (!api.upgradePool) throw bad(`${api.name} upgrades the node pools together with the cluster.`)
    const a = accountOf(cluster)
    const o = await cloudOverview(cluster)
    const p = o.pools.find(x => x.id === String(poolId || ''))
    if (!p) throw bad('No such node pool in this cluster.', 404)
    if (o.busy) throw bad(`The control plane is busy (${o.status}) — upgrade the pool when it is done.`, 409)
    if (p.busy) throw bad(`${p.name} is busy (${p.status}) — wait until it is done.`, 409)
    if (!p.upgradeTo) throw bad(`${p.name} is already on the control plane's version.`)
    const v = p.upgradeTo === 'recycle' ? null : String(version || p.upgradeTo)
    if (v && v !== p.upgradeTo && !(p.upgrades || []).includes(v)) throw bad(`${p.name} can go to ${p.upgradeTo}.`)
    const r = await api.upgradePool(a, p.id, v)
    auditLog.record({ orgId: user.orgId, actor: user, action: 'cluster.pool_upgrade', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: v ? `${api.name} pool ${p.name}: ${p.version} → ${v}` : `${api.name} pool ${p.name}: nodes recycled` })
    return { ok: true, pool: p.name, to: v, operation: r.operation || null }
}
