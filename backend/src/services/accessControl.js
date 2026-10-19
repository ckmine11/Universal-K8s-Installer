// Who may do what, where — the one place that answers it.
//
// A member has a main role (built-in or custom) for the whole workspace, and
// may have cluster rules that give them a different role on some clusters:
//   { type: 'cluster', clusterId, role }       — one cluster
//   { type: 'label', key, value, role }        — every cluster with that label (env=prod)
// role is 'operator' | 'viewer' | 'admin' | 'custom:<id>' | 'none' (no access).
//
// On a cluster: a rule for that exact cluster wins; otherwise every matching
// label rule applies (their permissions add up); otherwise the main role.
// A rule only decides the cluster permissions (CLUSTER_PERMISSIONS) — the
// workspace ones (agents, alerts, audit…) always come from the main role.
// Admins are never restricted: they run the workspace.
import { PERMISSIONS, permissionsForRole, CLUSTER_PERMISSIONS, BUILTIN_KUBE_LEVEL, ROLES, KUBE_LEVELS, AI_ACCESS } from '../config/permissions.js'
import { roleStore, customRoleId } from './roleStore.js'
import { canAccessResource } from '../utils/access.js'
import { approvalStore } from './approvalStore.js'

const ALL = Object.keys(PERMISSIONS)
const RANK = { none: 0, view: 1, edit: 2, admin: 3 }
const BUILTIN = ['admin', 'operator', 'viewer']

export const isBuiltinRole = (r) => BUILTIN.includes(r)

/** A role key → its name, permissions and Kubernetes level. */
export function describeRole(orgId, roleKey) {
    if (roleKey === 'superadmin') return { key: roleKey, name: 'Super Admin', builtin: true, permissions: new Set(ALL), kube: 'admin' }
    if (roleKey === 'none') return { key: 'none', name: 'No access', builtin: true, permissions: new Set(), kube: 'none' }
    if (isBuiltinRole(roleKey)) return { key: roleKey, name: ROLES[roleKey].label, builtin: true, permissions: new Set(permissionsForRole(roleKey)), kube: BUILTIN_KUBE_LEVEL[roleKey] }
    const id = customRoleId(roleKey)
    const role = id && roleStore.get(orgId, id)
    // a deleted role (or unknown value) falls back to read-only
    if (!role) return { key: roleKey, name: 'Viewer (role removed)', builtin: false, missing: true, permissions: new Set(permissionsForRole('viewer')), kube: 'view' }
    return { key: roleKey, name: role.name, builtin: false, permissions: new Set(role.permissions), kube: role.kube || 'view' }
}

/** The cluster rules of this member that apply to this cluster. */
export function matchingRules(user, cluster) {
    const rules = Array.isArray(user?.clusterAccess) ? user.clusterAccess : []
    if (!cluster) return { rules: [], via: null }
    const exact = rules.find(r => r.type === 'cluster' && r.clusterId === cluster.id)
    if (exact) return { rules: [exact], via: 'cluster' }
    const labels = cluster.labels || {}
    const byLabel = rules.filter(r => r.type === 'label' && labels[r.key] === r.value)
    return byLabel.length ? { rules: byLabel, via: 'label' } : { rules: [], via: null }
}

/**
 * Everything the member may do — on a cluster when one is given, otherwise
 * workspace-wide. → { permissions: Set, kube, via, role, namespaces, elevatedUntil }
 *   via: 'admin' | 'role' | 'cluster' | 'label' | 'elevation'
 *   namespaces: null (whole cluster) or the namespace patterns the member is limited to
 */
export function accessOn(user, cluster = null) {
    if (!user) return { permissions: new Set(), kube: 'none', via: 'role', role: null, namespaces: null }
    if (user.role === 'superadmin' || user.role === 'admin') {
        return { permissions: new Set(ALL), kube: 'admin', via: 'admin', role: user.role, namespaces: null }
    }
    const main = describeRole(user.orgId, user.role)
    const { rules, via } = matchingRules(user, cluster)
    let perms, kube, names, namespaces = null, how = via || 'role'
    if (!rules.length) {
        perms = new Set(main.permissions); kube = main.kube; names = [main.name]
    } else {
        perms = new Set([...main.permissions].filter(p => !CLUSTER_PERMISSIONS.includes(p)))
        kube = 'none'; names = []
        for (const r of rules) {
            const d = describeRole(user.orgId, r.role)
            names.push(d.name)
            for (const p of d.permissions) if (CLUSTER_PERMISSIONS.includes(p)) perms.add(p)
            if (RANK[d.kube] > RANK[kube]) kube = d.kube
        }
        // limited to namespaces only when every matching rule is (otherwise one rule gives the whole cluster)
        const real = rules.filter(r => r.role !== 'none')
        if (real.length && real.every(r => r.namespaces?.length)) namespaces = [...new Set(real.flatMap(r => r.namespaces))]
    }
    // KubeEZ AI given to this member by an admin (on top of the role)
    for (const p of AI_ACCESS[user.aiAccess]?.permissions || []) perms.add(p)
    // temporary elevation (approved, time-limited): the role is added on this
    // cluster — and on the whole cluster, namespaces too — until it ends
    let elevatedUntil = null
    if (cluster) {
        for (const e of approvalStore.activeElevations(user.id)) {
            if (e.orgId !== user.orgId || (e.clusterId !== cluster.id && e.clusterId !== '*')) continue
            const d = describeRole(user.orgId, e.role)
            for (const p of d.permissions) if (CLUSTER_PERMISSIONS.includes(p)) perms.add(p)
            if (RANK[d.kube] > RANK[kube]) kube = d.kube
            names.push(`${d.name} (temporary)`); namespaces = null; how = 'elevation'
            if (!elevatedUntil || e.until > elevatedUntil) elevatedUntil = e.until
        }
        // no cluster:view on this cluster → nothing on it (and it is hidden)
        if (!perms.has('cluster:view')) { for (const p of CLUSTER_PERMISSIONS) perms.delete(p); kube = 'none'; namespaces = null }
    }
    return { permissions: perms, kube, via: how, role: names.join(' + '), namespaces, elevatedUntil }
}

/** Does a namespace match one of the patterns ("payments" or "payments-*")? */
export const nsMatches = (patterns, ns) => (patterns || []).some(p => p.endsWith('*') ? ns.startsWith(p.slice(0, -1)) : ns === p)

export const canOn = (user, permission, cluster = null) => accessOn(user, cluster).permissions.has(permission)

/** Same workspace AND allowed to see it. */
export const canSeeCluster = (user, cluster) => !!cluster && canAccessResource(user, cluster) && (user.role === 'superadmin' || canOn(user, 'cluster:view', cluster))

/** Kubernetes level inside the cluster (Explorer): none | view | edit | admin */
export const kubeLevelOn = (user, cluster) => {
    const a = accessOn(user, cluster)
    return a.permissions.has('cluster:view') ? (KUBE_LEVELS.includes(a.kube) ? a.kube : 'view') : 'none'
}

/** For the UI: main permissions plus what differs per cluster. */
export function accessSummary(user, clusters = []) {
    const main = accessOn(user)
    const perCluster = {}
    for (const c of clusters) {
        if (!canAccessResource(user, c) && user.role !== 'superadmin') continue
        const a = accessOn(user, c)
        perCluster[c.id] = { permissions: [...a.permissions], kube: a.kube, via: a.via, role: a.role, namespaces: a.namespaces, elevatedUntil: a.elevatedUntil }
    }
    return { role: user.role, roleName: main.role, permissions: [...main.permissions], kube: main.kube, clusters: perCluster }
}

/** Clean and check a member's cluster rules (from the Team & Roles screen). */
export function cleanClusterRules(orgId, rules, clusterIds) {
    if (!Array.isArray(rules)) throw Object.assign(new Error('Cluster rules must be a list'), { status: 400 })
    if (rules.length > 100) throw Object.assign(new Error('Up to 100 cluster rules per member'), { status: 400 })
    const okRole = (r) => r === 'none' || isBuiltinRole(r) || (customRoleId(r) && roleStore.get(orgId, customRoleId(r)))
    const out = []
    const seen = new Set()
    for (const r of rules) {
        if (!okRole(r?.role)) throw Object.assign(new Error(`Unknown role in a cluster rule: ${r?.role}`), { status: 400 })
        if (r.type === 'cluster') {
            if (!clusterIds.includes(r.clusterId)) throw Object.assign(new Error('A cluster rule points to a cluster that is not in this workspace'), { status: 400 })
            const k = `c:${r.clusterId}`; if (seen.has(k)) throw Object.assign(new Error('Two rules for the same cluster — keep one'), { status: 400 }); seen.add(k)
            out.push({ type: 'cluster', clusterId: r.clusterId, role: r.role, ...cleanNamespaces(r) })
        } else if (r.type === 'label') {
            const key = String(r.key || '').trim().toLowerCase(), value = String(r.value || '').trim().toLowerCase()
            if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) throw Object.assign(new Error('Label rule: key and value — letters, numbers, ".", "_" and "-" (e.g. env = prod)'), { status: 400 })
            const k = `l:${key}=${value}`; if (seen.has(k)) throw Object.assign(new Error(`Two rules for ${key}=${value} — keep one`), { status: 400 }); seen.add(k)
            out.push({ type: 'label', key, value, role: r.role, ...cleanNamespaces(r) })
        } else throw Object.assign(new Error('A cluster rule is for one cluster or for a label'), { status: 400 })
    }
    return out
}

// Optional: limit a rule to some namespaces — names or prefixes ("payments-*")
export const NS_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^[a-z0-9][a-z0-9-]{0,61}\*$/
function cleanNamespaces(r) {
    if (r.namespaces == null || (Array.isArray(r.namespaces) && !r.namespaces.length)) return {}
    if (r.role === 'none') return {}
    const list = Array.isArray(r.namespaces) ? r.namespaces : String(r.namespaces).split(',')
    const out = [...new Set(list.map(n => String(n).trim().toLowerCase()).filter(Boolean))]
    if (out.length > 20) throw Object.assign(new Error('Up to 20 namespaces per rule'), { status: 400 })
    const bad = out.find(n => !NS_PATTERN.test(n))
    if (bad) throw Object.assign(new Error(`Namespace "${bad}": lowercase letters, numbers and "-", optionally ending in * (e.g. payments-*)`), { status: 400 })
    return out.length ? { namespaces: out } : {}
}

export const LABEL_KEY = /^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$/i
export const LABEL_VALUE = /^[a-z0-9]([a-z0-9._-]{0,60}[a-z0-9])?$/i
