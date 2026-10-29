// External Secrets: are the secrets from Vault / AWS / GCP / Azure syncing?
// The ExternalSecrets of a cluster with their store, target Secret, refresh
// interval and Ready condition, and the stores themselves. Names and status
// only — KubeEZ never reads a Secret or a provider's credentials.
import { crdSection, splitSections, listError, KUBECTL } from './kubeList.js'

const TAG = 'KZESO'
export const ESO_SCRIPT = [
    crdSection(TAG, 'ES', 'externalsecrets.external-secrets.io'),
    crdSection(TAG, 'SS', 'secretstores.external-secrets.io'),
    crdSection(TAG, 'CSS', 'clustersecretstores.external-secrets.io'),
    `echo '==${TAG}:END=='`
].join('; ')
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const str = (v, n = 200) => v == null || v === '' ? null : String(v).slice(0, n)
const ready = (o) => (o?.status?.conditions || []).find(c => c.type === 'Ready') || null
const providerOf = (spec) => Object.keys(spec?.provider || {})[0] || null

/** ESO_SCRIPT output → { installed, error?, externalSecrets, stores } */
export function parseEso(out) {
    const s = splitSections(out, TAG)
    if (s.ES_ERR != null) { const e = listError(s.ES_ERR, 'externalsecrets.external-secrets.io'); return { installed: e.state !== 'missing', error: e.message || null, externalSecrets: [], stores: [] } }
    const items = (k) => { try { return JSON.parse(s[k] || '{"items":[]}').items || [] } catch { return [] } }
    const externalSecrets = items('ES').map(o => {
        const r = ready(o)
        return {
            namespace: o.metadata?.namespace, name: o.metadata?.name,
            store: o.spec?.secretStoreRef ? `${o.spec.secretStoreRef.kind || 'SecretStore'}/${o.spec.secretStoreRef.name}` : null,
            target: str(o.spec?.target?.name || o.metadata?.name, 253), refreshInterval: str(o.spec?.refreshInterval, 20) || '1h',
            keys: (o.spec?.data || []).length + (o.spec?.dataFrom || []).length,
            ready: r?.status === 'True', reason: str(r?.reason, 60), message: r?.status === 'True' ? null : str(r?.message, 300),
            lastSync: o.status?.refreshTime || null
        }
    }).filter(e => e.name).sort((a, b) => Number(a.ready) - Number(b.ready) || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
    const stores = [...items('SS').map(o => ({ o, kind: 'SecretStore' })), ...items('CSS').map(o => ({ o, kind: 'ClusterSecretStore' }))].map(({ o, kind }) => {
        const r = ready(o)
        return { kind, namespace: o.metadata?.namespace || null, name: o.metadata?.name, provider: providerOf(o.spec), ready: r?.status === 'True', message: r?.status === 'True' ? null : str(r?.message, 300) }
    }).filter(x => x.name)
    return { installed: true, error: null, externalSecrets, stores }
}

async function run(connect, cluster, cmd) {
    const ssh = await connect(cluster)
    try { return await ssh.execCommand(cmd, { timeoutMs: 120e3 }) } finally { ssh.dispose?.() }
}
export async function readEso(cluster, { connect = defaultConnect } = {}) {
    const r = await run(connect, cluster, ESO_SCRIPT)
    if (!String(r?.stdout || '').includes(`==${TAG}:END==`)) throw Object.assign(new Error('Could not read the cluster'), { status: 502 })
    return parseEso(r.stdout)
}
/** Sync one ExternalSecret now (the force-sync annotation the operator watches). */
export async function refreshEso(cluster, namespace, name, { connect = defaultConnect } = {}) {
    if (!NS.test(String(namespace)) || !NAME.test(String(name))) throw Object.assign(new Error('Not a valid ExternalSecret'), { status: 400 })
    const r = await run(connect, cluster, `${KUBECTL} -n '${namespace}' annotate externalsecrets.external-secrets.io '${name}' force-sync=${Math.floor(Date.now() / 1000)} --overwrite --request-timeout=30s`)
    if (r?.code) throw Object.assign(new Error(`The cluster refused it: ${String(r.stderr || '').trim().slice(0, 300)}`), { status: /NotFound/.test(r.stderr || '') ? 404 : 502 })
    return { message: `${namespace}/${name} is syncing now.` }
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}
export const _test = { useConnect(fn) { testConnect = fn } }
