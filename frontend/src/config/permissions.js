// Frontend mirror of the backend RBAC matrix (backend/src/config/permissions.js).
// This is for UI gating only (show/hide buttons) — the backend is the real
// enforcement point. Keep this in sync with the backend matrix.

export const PERMISSIONS = {
    'cluster:view':        ['admin', 'operator', 'viewer'],
    'cluster:create':      ['admin', 'operator'],
    'cluster:delete':      ['admin', 'operator'],
    'cluster:scale':       ['admin', 'operator'],
    'cluster:upgrade':     ['admin', 'operator'],
    'cluster:resume':      ['admin', 'operator'],

    'addon:view':          ['admin', 'operator', 'viewer'],
    'addon:credentials':   ['admin', 'operator'],
    'addon:install':       ['admin', 'operator'],

    'kubeconfig:download': ['admin', 'operator'],
    'terminal:access':     ['admin', 'operator'],

    'agent:view':          ['admin', 'operator', 'viewer'],
    'agent:manage':        ['admin', 'operator'],

    'incident:view':       ['admin', 'operator', 'viewer'],

    'gitops:view':         ['admin', 'operator', 'viewer'],
    'gitops:sync':         ['admin', 'operator'],
    'gitops:create':       ['admin', 'operator'],
    'gitops:delete':       ['admin'],
    'app:view':            ['admin', 'operator', 'viewer'],
    'app:values':          ['admin', 'operator'],
    'app:deploy':          ['admin', 'operator'],
    'app:delete':          ['admin'],
    'env:manage':          ['admin'],
    'chartrepo:manage':    ['admin'],
    'freeze:manage':       ['admin'],
    'security:view':       ['admin', 'operator', 'viewer'],
    'metrics:view':        ['admin', 'operator', 'viewer'],

    'team:view':           ['admin'],
    'team:manage':         ['admin'],
    'billing:manage':      ['admin'],
    'backup:manage':       ['admin'],
    'alerts:manage':       ['admin'],
    'incident:act':        ['admin', 'operator'],
    'healing:manage':      ['admin'],
    'compliance:view':     ['admin', 'operator', 'viewer'],
    'compliance:manage':   ['admin'],
    'audit:view':          ['admin'],
    'access:approve':    ['admin'],
    // KubeEZ AI: admins by default; an admin gives it to members (Team & Roles → KubeEZ AI)
    'ai:use':            ['admin'],
    'ai:apply':          ['admin'],
    'ai:manage':         ['admin'],
}

// The signed-in member's real access (custom role + cluster rules), loaded
// from /api/rbac/me by AuthContext. Without it the built-in matrix answers.
let ACCESS = null
export function setAccess(a) { ACCESS = a || null }
export const currentAccess = () => ACCESS

/**
 * May this role do `permission` — on `clusterId` when given (cluster rules
 * apply there), otherwise workspace-wide? superadmin always true.
 */
export function can(role, permission, clusterId) {
    if (role === 'superadmin') return true
    if (ACCESS && ACCESS.role === role) {
        const onCluster = clusterId && ACCESS.clusters?.[clusterId]
        return (onCluster ? onCluster.permissions : ACCESS.permissions).includes(permission)
    }
    const allowed = PERMISSIONS[permission]
    return Array.isArray(allowed) && allowed.includes(role)
}

/** Kubernetes level on a cluster (Explorer): none | view | edit | admin */
export function kubeLevel(role, clusterId) {
    if (role === 'superadmin' || role === 'admin') return 'admin'
    const c = ACCESS?.clusters?.[clusterId]
    return c ? c.kube : (ACCESS?.kube || (role === 'operator' ? 'edit' : 'view'))
}
