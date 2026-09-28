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

    'team:view':           ['admin'],
    'team:manage':         ['admin'],
    'billing:manage':      ['admin'],
    'backup:manage':       ['admin'],
}

/** Does a role have a given permission? superadmin always true. */
export function can(role, permission) {
    if (role === 'superadmin') return true
    const allowed = PERMISSIONS[permission]
    return Array.isArray(allowed) && allowed.includes(role)
}
