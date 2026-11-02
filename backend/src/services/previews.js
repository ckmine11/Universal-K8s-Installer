import { randomBytes } from 'crypto'
import { deliveryStore } from './deliveryStore.js'
import { listReleases, valuesOf, cleanDeploy, deploy, NAMESPACE } from './helmApps.js'
import { applySet } from './apiTokens.js'

// Preview environments: a short-lived copy of an app for one pull request or
// branch — its own namespace (web-pr-42), the chart and version of the app it
// copies (the "base": an environment's release), the base's values plus what
// the preview changes (image.tag of the PR build). It removes itself when it
// expires (default 72 h): the namespace goes, and with it everything inside.
//
// KubeEZ only ever deletes namespaces it created for a preview — each one
// carries the label kubeez.io/preview=<id>, checked before every change.
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
export const LABEL = 'kubeez.io/preview'
export const MAX_PREVIEWS = 30
const TTL = { def: 72, min: 1, max: 14 * 24 }
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

/** A pull request number or a branch name → the short key in the namespace ("42", "feature-login"). */
export function previewKey(b) {
    if (b?.pr != null && b.pr !== '') {
        const n = Number(b.pr)
        if (!Number.isInteger(n) || n < 1 || n > 9999999) throw bad('pr: the pull request number')
        return { key: `pr-${n}`, label: `PR #${n}` }
    }
    const branch = String(b?.branch || '').trim()
    if (!branch || branch.length > 200) throw bad('Give the pull request number (pr) or the branch name (branch)')
    const slug = branch.toLowerCase().replace(/^refs\/heads\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '')
    if (!slug) throw bad('The branch name has no letters or digits')
    return { key: slug, label: `branch ${branch.slice(0, 100)}` }
}
/** The namespace of a preview: <release>-<key>, a valid namespace or 400. */
export function previewNamespace(release, key) {
    const ns = `${release}-${key}`
    if (ns.length > 63 || !NAMESPACE.test(ns)) throw bad(`The preview namespace ${ns} would be too long — use a shorter branch name`)
    return ns
}
const KEY = /^[A-Za-z0-9_-]{1,60}(\.[A-Za-z0-9_-]{1,60}){0,7}$/
/** The values a preview changes: up to 20 paths like image.tag → short strings, numbers, true/false. */
export function cleanSet(set) {
    if (set == null) return {}
    if (typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length > 20) throw bad('set: up to 20 values like {"image.tag": "pr-42"}')
    for (const [k, v] of Object.entries(set)) {
        if (!KEY.test(k) || k.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw bad(`Not a valid value path: ${k}`)
        if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 200) throw bad(`${k}: a short string, number or true/false`)
    }
    return set
}
export function cleanTtl(h) {
    if (h == null || h === '') return TTL.def
    const n = Number(h)
    if (!Number.isInteger(n) || n < TTL.min || n > TTL.max) throw bad(`ttlHours: ${TTL.min} to ${TTL.max}`)
    return n
}

async function kube(connect, cluster, cmd, stdin = null) {
    const ssh = await connect(cluster)
    try { return await ssh.execCommand(cmd, { timeoutMs: 90e3, ...(stdin != null ? { stdin } : {}) }) } finally { ssh.dispose?.() }
}
const labelCmd = (ns) => `${KUBECTL} get namespace ${q(ns)} -o jsonpath='{.metadata.labels.kubeez\\.io/preview}' --request-timeout=20s`

/** Create the preview's namespace (labelled), or refuse a namespace KubeEZ did not make for this preview. */
export async function ensureNamespace(cluster, ns, id, { connect = defaultConnect } = {}) {
    const cur = await kube(connect, cluster, labelCmd(ns))
    if (!cur.code) {
        if (String(cur.stdout || '').trim() !== id) throw bad(`Namespace ${ns} already exists and is not this preview's — KubeEZ does not take it over.`, 409)
        return
    }
    const manifest = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels: { [LABEL]: id, 'app.kubernetes.io/managed-by': 'kubeez' } } }
    const c = await kube(connect, cluster, `${KUBECTL} create -f - --request-timeout=30s`, JSON.stringify(manifest))
    if (c.code) throw bad(`Could not create namespace ${ns}: ${String(c.stderr || c.stdout || '').trim().slice(0, 300)}`, 502)
}

/** Delete the preview's namespace (only when it carries this preview's label). → true when it was there. */
export async function deleteNamespace(cluster, ns, id, { connect = defaultConnect } = {}) {
    const cur = await kube(connect, cluster, labelCmd(ns))
    if (cur.code) return false   // already gone
    if (String(cur.stdout || '').trim() !== id) throw bad(`Namespace ${ns} is not this preview's — not deleted.`, 409)
    const r = await kube(connect, cluster, `${KUBECTL} delete namespace ${q(ns)} --wait=false --request-timeout=30s`)
    if (r.code) throw bad(`Could not delete namespace ${ns}: ${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`, 502)
    return true
}

/**
 * Create or update the preview of base.release (installed in base.namespace).
 * set: values to change; allowedKeys: what may be set (null = anything — a member who may see values).
 * → { preview, job }
 */
export async function startPreview({ orgId, cluster, base, key, label, set, allowedKeys = null, ttlHours, repo, by, gate = null, connect }) {
    const opts = connect ? { connect } : {}
    set = cleanSet(set)
    const ttl = cleanTtl(ttlHours)
    const src =(await listReleases(cluster, opts)).find(r => r.namespace === base.namespace && r.name === base.release)
    if (!src) throw bad(`${base.release} is not installed in ${base.namespace} — a preview copies a running app`, 404)
    const namespace = previewNamespace(base.release, key)
    const existing = deliveryStore.previewAt(orgId, cluster.id, namespace)
    if (!existing && deliveryStore.previews(orgId).length >= MAX_PREVIEWS) throw bad(`Up to ${MAX_PREVIEWS} preview environments at a time — remove one first`)
    const id = existing?.id || randomBytes(6).toString('hex')
    const values = applySet(await valuesOf(cluster, base.namespace, base.release, opts), set, allowedKeys || Object.keys(set))
    const d = cleanDeploy({ release: base.release, namespace, chart: src.chart, version: src.version }, repo)
    await ensureNamespace(cluster, namespace, id, opts)
    const job = await deploy(cluster, d, { by, values, gate, ...opts })
    const now = new Date()
    const preview = deliveryStore.savePreview(orgId, {
        id, clusterId: cluster.id, namespace, key, label, baseNamespace: base.namespace, release: base.release, chart: src.chart, version: src.version, repoId: repo.id,
        set: set || {}, createdAt: existing?.createdAt || now.toISOString(), createdBy: existing?.createdBy || by, updatedAt: now.toISOString(), updatedBy: by,
        expiresAt: new Date(now.getTime() + ttl * 3600e3).toISOString(), jobId: job.id, error: null
    }, { max: MAX_PREVIEWS })
    return { preview, job }
}

/** Remove a preview: its namespace (everything in it), then the record. */
export async function removePreview(orgId, cluster, p, { connect } = {}) {
    await deleteNamespace(cluster, p.namespace, p.id, connect ? { connect } : {})
    deliveryStore.removePreviewRecord(orgId, p.id)
}

/** One sweep: remove the previews that expired. deps: clusterOf(id), audit(orgId, cluster, detail, ok) */
export async function sweepExpired(deps, now = Date.now()) {
    const removed = []
    for (const p of deliveryStore.allPreviews().filter(x => Date.parse(x.expiresAt) <= now)) {
        const cluster = await deps.clusterOf(p.clusterId)
        if (!cluster) { deliveryStore.removePreviewRecord(p.orgId, p.id); continue }
        try {
            await removePreview(p.orgId, cluster, p, deps.connect ? { connect: deps.connect } : {})
            deps.audit(p.orgId, cluster, `preview ${p.namespace} (${p.label}) expired and was removed`, true)
            removed.push(p.namespace)
        } catch (e) {
            deliveryStore.updatePreview(p.orgId, p.id, { error: e.message.slice(0, 300) })
            deps.audit(p.orgId, cluster, `preview ${p.namespace} could not be removed: ${e.message}`, false)
        }
    }
    return removed
}

export async function startPreviewSweeper() {
    const [{ clusterStore }, { auditLog }] = await Promise.all([import('./clusterStore.js'), import('./auditLog.js')])
    const deps = {
        clusterOf: async (id) => (await clusterStore.getClusters().catch(() => [])).find(c => c.id === id) || null,
        audit: (orgId, c, detail, ok) => auditLog.record({ orgId, actor: { id: 'kubeez', username: 'KubeEZ previews' }, action: 'preview.expire', target: { clusterId: c.id, clusterName: c.clusterName }, ok, detail })
    }
    const t = setInterval(() => sweepExpired(deps).catch(e => console.error(`[Previews] ${e.message}`)), 10 * 60e3)
    t.unref?.()
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}
// tests only: answer every kubectl call with a fake connection
export const _test = { useConnect(fn) { testConnect = fn } }
