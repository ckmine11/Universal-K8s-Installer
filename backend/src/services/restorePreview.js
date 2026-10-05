/**
 * "What will a restore change?" — computed from etcd keys.
 *
 * The node tool lists every key in the snapshot (S|key) and every key in the
 * live cluster with its last-modified revision (L|key|modRevision), plus the
 * snapshot's revision (SNAPREV|n). Kubernetes stores each object at
 * /registry/[<group>/]<resource>/[<namespace>/]<name>, so:
 *   live only               → created after the snapshot → REMOVED by the restore
 *   snapshot only           → deleted after the snapshot → COMES BACK
 *   both, modRevision > rev → edited after the snapshot  → REVERTED
 */

// resource path → [Kind, namespaced, trackEdits]
// trackEdits=false: objects whose status changes all the time (pods, nodes,
// leases, custom resources of operators) — only created/deleted is meaningful.
const RESOURCES = {
    'namespaces': ['Namespace', false, false],
    'deployments': ['Deployment', true, true],
    'statefulsets': ['StatefulSet', true, true],
    'daemonsets': ['DaemonSet', true, true],
    'cronjobs': ['CronJob', true, true],
    'jobs': ['Job', true, false],
    'services/specs': ['Service', true, true],
    'ingress': ['Ingress', true, true],
    'configmaps': ['ConfigMap', true, true],
    'secrets': ['Secret', true, true],
    'persistentvolumeclaims': ['PersistentVolumeClaim', true, false],
    'persistentvolumes': ['PersistentVolume', false, false],
    'serviceaccounts': ['ServiceAccount', true, true],
    'roles': ['Role', true, true],
    'rolebindings': ['RoleBinding', true, true],
    'clusterroles': ['ClusterRole', false, true],
    'clusterrolebindings': ['ClusterRoleBinding', false, true],
    'networkpolicies': ['NetworkPolicy', true, true],
    'storageclasses': ['StorageClass', false, true],
    'horizontalpodautoscalers': ['HorizontalPodAutoscaler', true, false],
    'poddisruptionbudgets': ['PodDisruptionBudget', true, true],
    'minions': ['Node', false, false],
    'apiextensions.k8s.io/customresourcedefinitions': ['CustomResourceDefinition', false, true],
    'networking.k8s.io/ingressclasses': ['IngressClass', false, true]
}
// Built-in API groups that are bookkeeping, not user objects
const SYSTEM_GROUP = /(^|\.)k8s\.io$|^flowcontrol|^coordination|^discovery|^events|^apiregistration/
// Custom resources that controllers create and delete on their own (per pod,
// per IP block, per reconcile) — listing them would hide the real changes
const NOISY_CR = new Set([
    'ciliumendpoints', 'ciliumidentities', 'ciliumnodes', 'ciliumendpointslices',
    'blockaffinities', 'ipamblocks', 'ipamhandles',
    'engines', 'replicas', 'instancemanagers', 'engineimages', 'orphans', 'snapshots',
    'certificaterequests', 'orders', 'challenges',
    'podvolumebackups', 'podvolumerestores', 'datauploads', 'datadownloads', 'backuprepositories'
])

export const SYSTEM_NAMESPACES = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'kube-flannel', 'calico-system', 'tigera-operator'])
const LIMIT = 300

/** /registry/... → { kind, namespace, name, trackEdits } or null (not shown) */
export function parseKey(key) {
    if (!key?.startsWith('/registry/')) return null
    const parts = key.slice('/registry/'.length).split('/')
    let res = null, rest = null
    // longest matching resource path first ("services/specs", "group/plural")
    for (const n of [2, 1]) {
        const cand = parts.slice(0, n).join('/')
        if (RESOURCES[cand]) { res = cand; rest = parts.slice(n); break }
    }
    if (!res) {
        // custom resource: /registry/<group.with.dots>/<plural>/[ns/]name
        if (parts.length >= 3 && parts[0].includes('.') && !SYSTEM_GROUP.test(parts[0]) && !NOISY_CR.has(parts[1])) {
            const [group, plural, ...r] = parts
            const namespaced = r.length >= 2
            return { kind: `${plural}.${group}`, namespace: namespaced ? r[0] : null, name: r.slice(namespaced ? 1 : 0).join('/'), trackEdits: false, custom: true }
        }
        return null
    }
    const [kind, namespaced, trackEdits] = RESOURCES[res]
    if (namespaced ? rest.length < 2 : rest.length < 1) return null
    const namespace = namespaced ? rest[0] : null
    const name = rest.slice(namespaced ? 1 : 0).join('/')
    // service-account tokens and the per-namespace root CA are recreated automatically
    if (kind === 'ConfigMap' && name === 'kube-root-ca.crt') return null
    return { kind, namespace, name, trackEdits }
}

/** Parse the node tool's output into the three lists. */
export function computePreview(output) {
    const lines = String(output || '').split('\n')
    const fail = lines.find(l => l.startsWith('PREVIEW_FAIL|') || l.startsWith('VERIFY_FAIL|'))
    if (fail) {
        const p = fail.split('|')
        return { ok: false, code: p.length > 2 ? p[1] : 'FAILED', error: p[p.length - 1] }
    }
    if (!lines.some(l => l.trim() === 'PREVIEW_OK')) {
        return { ok: false, code: 'NO_OUTPUT', error: (lines.filter(Boolean).slice(-2).join(' ') || 'The node did not answer').slice(0, 300) }
    }
    const snapRev = parseInt(lines.find(l => l.startsWith('SNAPREV|'))?.split('|')[1], 10) || 0
    const snap = new Set()
    const live = new Map()
    for (const l of lines) {
        if (l.startsWith('S|')) snap.add(l.slice(2).trim())
        else if (l.startsWith('L|')) {
            const i = l.lastIndexOf('|')
            live.set(l.slice(2, i), parseInt(l.slice(i + 1), 10) || 0)
        }
    }

    const removed = [], restored = [], reverted = []
    for (const [key, modRev] of live) {
        const o = parseKey(key)
        if (!o) continue
        if (!snap.has(key)) removed.push(o)
        else if (o.trackEdits && snapRev && modRev > snapRev) reverted.push(o)
    }
    for (const key of snap) {
        if (live.has(key)) continue
        const o = parseKey(key)
        if (o) restored.push(o)
    }

    const sort = (a, b) => (SYSTEM_NAMESPACES.has(a.namespace) - SYSTEM_NAMESPACES.has(b.namespace))
        || String(a.namespace || '').localeCompare(String(b.namespace || ''))
        || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    const clip = (list) => list.sort(sort).slice(0, LIMIT).map(({ kind, namespace, name, custom }) => ({ kind, namespace, name, ...(custom ? { custom } : {}) }))
    const isVolume = (o) => o.kind === 'PersistentVolumeClaim' || o.kind === 'PersistentVolume'

    const warnings = []
    const newVolumes = removed.filter(isVolume)
    if (newVolumes.length) {
        warnings.push({
            code: 'VOLUMES_CREATED_AFTER',
            message: `${newVolumes.length} volume${newVolumes.length === 1 ? '' : 's'} created after this snapshot will disappear from the cluster — their disks/data are NOT deleted, but no longer attached to anything. Back up their data first (Volume Backups).`
        })
    }
    const goneVolumes = restored.filter(isVolume)
    if (goneVolumes.length) {
        warnings.push({
            code: 'VOLUMES_DELETED_AFTER',
            message: `${goneVolumes.length} volume${goneVolumes.length === 1 ? '' : 's'} deleted after this snapshot will come back as objects — if their disks were deleted too, those volumes will be empty or fail to attach.`
        })
    }
    const nodes = [...removed, ...restored].filter(o => o.kind === 'Node')
    if (nodes.length) {
        warnings.push({
            code: 'NODES_CHANGED',
            message: 'Nodes joined after the snapshot re-register by themselves; nodes removed after it come back as NotReady and can be deleted.'
        })
    }

    return {
        ok: true,
        snapshotRevision: snapRev,
        counts: { removed: removed.length, restored: restored.length, reverted: reverted.length },
        removed: clip(removed),
        restored: clip(restored),
        reverted: clip(reverted),
        truncated: Math.max(removed.length, restored.length, reverted.length) > LIMIT,
        warnings
    }
}
