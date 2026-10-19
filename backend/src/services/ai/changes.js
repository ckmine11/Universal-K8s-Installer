// "What changed?" — one timeline of the changes to a cluster, from both sides:
//   KubeEZ   the audit trail (upgrades, add-ons, restores, scaling, access…)
//   cluster  new rollouts (with old → new image), StatefulSet/DaemonSet
//            revisions, Helm releases, ConfigMaps / Secrets edited (names
//            only, never their data), new nodes and namespaces
// Facts only — no AI needed. AI can summarise it, and the incident explainer
// uses the changes before an incident as evidence.
import { auditLog } from '../auditLog.js'

const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 40 kubectl'
const MAX_ITEMS = 400
const MAX_BYTES = 3_000_000
const T = '{"\\t"}'
const N = '{"\\n"}'

// one SSH round trip; each section is tab-separated lines
export const CHANGES_SCRIPT = [
    `echo '==RS=='; ${KUBECTL} get rs -A -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}${T}{.metadata.namespace}${T}{.metadata.ownerReferences[0].kind}${T}{.metadata.ownerReferences[0].name}${T}{.metadata.annotations.deployment\\.kubernetes\\.io/revision}${T}{range .spec.template.spec.containers[*]}{.image}{" "}{end}${N}{end}' 2>/dev/null | head -c ${MAX_BYTES}`,
    `echo '==CR=='; ${KUBECTL} get controllerrevisions -A -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}${T}{.metadata.namespace}${T}{.metadata.ownerReferences[0].kind}${T}{.metadata.ownerReferences[0].name}${T}{.revision}${N}{end}' 2>/dev/null | head -c ${MAX_BYTES}`,
    `echo '==HELM=='; ${KUBECTL} get secrets -A -l owner=helm -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}${T}{.metadata.namespace}${T}{.metadata.labels.name}${T}{.metadata.labels.version}${T}{.metadata.labels.status}${N}{end}' 2>/dev/null | head -c ${MAX_BYTES}`,
    `echo '==CM=='; ${KUBECTL} get configmaps -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.metadata.creationTimestamp}${T}{range .metadata.managedFields[*]}{.time}{" "}{end}${N}{end}' 2>/dev/null | head -c ${MAX_BYTES}`,
    `echo '==SECRET=='; ${KUBECTL} get secrets -A --field-selector type=Opaque -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.metadata.creationTimestamp}${T}{range .metadata.managedFields[*]}{.time}{" "}{end}${N}{end}' 2>/dev/null | head -c ${MAX_BYTES}`,
    `echo '==NODE=='; ${KUBECTL} get nodes -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}${T}{.metadata.name}${T}{.status.nodeInfo.kubeletVersion}${N}{end}' 2>/dev/null`,
    `echo '==NS=='; ${KUBECTL} get namespaces -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}${T}{.metadata.name}${N}{end}' 2>/dev/null`,
    `echo '==END=='`
].join('; ')

function sections(out) {
    const s = {}
    const re = /==([A-Z]+)==\n?([\s\S]*?)(?===[A-Z]+==|$)/g
    let m
    while ((m = re.exec(out || ''))) s[m[1]] = m[2].trim()
    return s
}
const rows = (text) => String(text || '').split('\n').filter(Boolean).map(l => l.split('\t'))
const ms = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t }
const latest = (times) => Math.max(-Infinity, ...String(times || '').trim().split(/\s+/).map(ms).filter(Boolean))
const imgs = (s) => String(s || '').trim().split(/\s+/).filter(Boolean)

// noise that changes all the time and says nothing about "who changed what"
const NOISY_CM = /^(kube-root-ca\.crt|extension-apiserver-authentication|cluster-info|kubeadm-config|kubelet-config|.*-leader(-election)?|.*-lock|.*\.v\d+)$/
const NOISY_SECRET = /^(sh\.helm\.release\..*|.*-token-.*|.*-webhook-(cert|tls)|.*-ca(-cert)?|bootstrap-token-.*)$/

/** Kubernetes-side changes between from and to (ms) out of the CHANGES_SCRIPT output. */
export function parseClusterChanges(out, { from, to = Date.now() }) {
    const s = sections(out)
    const inWin = (t) => t != null && t >= from && t <= to
    const items = []

    // Deployments: a new ReplicaSet = a new rollout; compare with the previous revision
    const rsByOwner = new Map()
    for (const [at, ns, kind, owner, rev, images] of rows(s.RS)) {
        if (kind !== 'Deployment' || !owner) continue
        const k = `${ns}/${owner}`
        if (!rsByOwner.has(k)) rsByOwner.set(k, [])
        rsByOwner.get(k).push({ t: ms(at), rev: Number(rev) || 0, images: imgs(images) })
    }
    for (const [k, list] of rsByOwner) {
        list.sort((a, b) => a.rev - b.rev)
        list.forEach((r, i) => {
            if (!inWin(r.t)) return
            const prev = list[i - 1]
            const [ns, name] = k.split('/')
            const changed = prev ? r.images.filter(x => !prev.images.includes(x)) : r.images
            const before = prev ? prev.images.filter(x => !r.images.includes(x)) : []
            items.push({
                at: new Date(r.t).toISOString(), source: 'cluster', kind: prev ? 'rollout' : 'created', ns, name: `deployment/${name}`,
                title: prev ? `Deployment ${name} rolled out (revision ${r.rev})` : `Deployment ${name} created`,
                detail: prev ? (changed.length || before.length ? `image ${before.join(', ') || '—'} → ${changed.join(', ') || '—'}` : 'pod template changed (env, config or resources) — same image') : `image ${r.images.join(', ')}`
            })
        })
    }
    // StatefulSets / DaemonSets: revisions (the first one is their creation)
    const crByOwner = new Map()
    for (const [at, ns, kind, owner, rev] of rows(s.CR)) {
        if (!['StatefulSet', 'DaemonSet'].includes(kind) || !owner) continue
        const k = `${kind}|${ns}|${owner}`
        if (!crByOwner.has(k)) crByOwner.set(k, [])
        crByOwner.get(k).push({ t: ms(at), rev: Number(rev) || 0 })
    }
    for (const [k, list] of crByOwner) {
        const [kind, ns, name] = k.split('|')
        const minRev = Math.min(...list.map(r => r.rev))
        for (const r of list) if (inWin(r.t)) items.push({
            at: new Date(r.t).toISOString(), source: 'cluster', kind: r.rev === minRev ? 'created' : 'rollout', ns, name: `${kind.toLowerCase()}/${name}`,
            title: r.rev === minRev ? `${kind} ${name} created` : `${kind} ${name} rolled out (revision ${r.rev})`, detail: null
        })
    }
    for (const [at, ns, name, version, status] of rows(s.HELM)) if (inWin(ms(at))) items.push({
        at: new Date(ms(at)).toISOString(), source: 'cluster', kind: 'helm', ns, name: `helm/${name}`,
        title: `Helm release ${name} ${Number(version) > 1 ? `upgraded (revision ${version})` : 'installed'}`, detail: status ? `status ${status}` : null
    })
    for (const [section, kind, noisy] of [['CM', 'ConfigMap', NOISY_CM], ['SECRET', 'Secret', NOISY_SECRET]]) {
        for (const [ns, name, created, times] of rows(s[section])) {
            if (!name || noisy.test(name)) continue
            const c = ms(created), t = latest(times)
            if (inWin(c)) items.push({ at: new Date(c).toISOString(), source: 'cluster', kind: 'config', ns, name: `${kind.toLowerCase()}/${name}`, title: `${kind} ${name} created`, detail: kind === 'Secret' ? 'values are never read by KubeEZ' : null })
            else if (Number.isFinite(t) && inWin(t)) items.push({ at: new Date(t).toISOString(), source: 'cluster', kind: 'config', ns, name: `${kind.toLowerCase()}/${name}`, title: `${kind} ${name} changed`, detail: kind === 'Secret' ? 'values are never read by KubeEZ' : null })
        }
    }
    for (const [at, name, kubelet] of rows(s.NODE)) if (inWin(ms(at))) items.push({ at: new Date(ms(at)).toISOString(), source: 'cluster', kind: 'node', ns: null, name: `node/${name}`, title: `Node ${name} joined`, detail: kubelet ? `kubelet ${kubelet}` : null })
    for (const [at, name] of rows(s.NS)) if (inWin(ms(at))) items.push({ at: new Date(ms(at)).toISOString(), source: 'cluster', kind: 'namespace', ns: name, name: `namespace/${name}`, title: `Namespace ${name} created`, detail: null })
    return items
}

// what an audit entry means, in words
const LABELS = [
    [/^POST \/api\/clusters\/:id\/upgrade$/, 'Kubernetes upgrade started'],
    [/^POST \/api\/clusters\/:id\/addons$/, 'Add-ons installed'],
    [/^POST \/api\/clusters\/:id\/addons\/:key\/settings$/, 'Add-on settings changed'],
    [/^POST \/api\/clusters\/:id\/addons\/:key\/:action/, 'Add-on uninstalled or reinstalled'],
    [/^POST \/api\/clusters\/:id\/addons\/sealed-secrets\/seal$/, 'A secret was sealed'],
    [/^POST \/api\/clusters\/:id\/(resume|retry)$/, 'Failed job resumed'],
    [/^POST \/api\/clusters\/:id\/etcd\/restore$/, 'etcd snapshot restored'],
    [/^POST \/api\/clusters\/:id\/etcd\/backups$/, 'etcd snapshot taken'],
    [/^POST \/api\/clusters\/:id\/etcd\/recover$/, 'Control-plane rebuilt'],
    [/^POST \/api\/clusters\/:id\/volume-backups\/restores$/, 'Volume backup restored'],
    [/^POST \/api\/clusters\/:id\/volume-backups\/backups$/, 'Volume backup taken'],
    [/^PUT \/api\/clusters\/:id\/labels$/, 'Cluster labels changed'],
    [/^POST \/api\/clusters\/:id\/ai-actions$/, 'Fix suggested by KubeEZ AI applied'],
    [/^POST \/api\/clusters\/:id\/ai-actions\/:actionId\/undo$/, 'AI fix undone']
]
// reads and previews that only look are not changes
const NOT_A_CHANGE = /^ai\.ask|^approval\.|^GET |\/(preview|analyze|verify|cancel)$|\/etcd\/(offsite\/fetch|refresh-workers)$/
const labelOf = (action) => (LABELS.find(([re]) => re.test(action)) || [])[1] || null

/** KubeEZ-side changes for one cluster (writes only, successful, no AI questions). */
export function kubeezChanges(orgId, clusterId, { from, to = Date.now() }) {
    return auditLog.query({ orgId, clusterId, from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: 300 })
        .filter(r => r.ok && !NOT_A_CHANGE.test(r.action))
        .map(r => ({
            at: r.at, source: 'kubeez', kind: 'kubeez', ns: null, name: null, actor: r.actor?.username || 'KubeEZ',
            title: labelOf(r.action) || r.action.replace(/^(POST|PUT|PATCH|DELETE) \/api\/clusters\/:id\/?/, '$1 ').trim(),
            detail: r.detail || null
        }))
}

const cache = new Map()   // clusterId → { at, out }
/**
 * Everything that changed on a cluster in the last `hours` (or between from and to).
 * → { from, to, items: [{ at, source, kind, ns, name, title, detail, actor? }], clusterError }
 */
export async function collectChanges(cluster, { hours = 24, from, to = Date.now(), connect } = {}) {
    from = from ?? to - hours * 3600e3
    let out = '', clusterError = null
    const hit = cache.get(cluster.id)
    if (hit && Date.now() - hit.at < 30e3) out = hit.out
    else {
        try {
            const ssh = await (connect || defaultConnect)(cluster)
            try { out = (await ssh.execCommand(CHANGES_SCRIPT)).stdout || '' } finally { ssh.dispose?.() }
            cache.set(cluster.id, { at: Date.now(), out })
        } catch (e) { clusterError = `Could not read the cluster: ${e.message}` }
    }
    const items = [...kubeezChanges(cluster.orgId, cluster.id, { from, to }), ...(out ? parseClusterChanges(out, { from, to }) : [])]
        .sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ITEMS)
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), items, clusterError }
}

async function defaultConnect(cluster) {
    const { connectCluster } = await import('../clusterAccess.js')
    return connectCluster(cluster)
}

/** The changes as plain text lines (for the AI), newest first. */
export const changesText = (items, max = 60) => items.slice(0, max).map(i =>
    `${i.at} [${i.source === 'kubeez' ? `KubeEZ, by ${i.actor}` : 'cluster'}] ${i.ns ? `${i.ns}: ` : ''}${i.title}${i.detail ? ` — ${i.detail}` : ''}`).join('\n')
