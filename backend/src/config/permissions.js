// ─────────────────────────────────────────────────────────────────────────────
// KubeEZ RBAC — single source of truth for roles & permissions
//
// Scope model:
//   - Every customer signs up as an "admin" (Org Owner) with a unique orgId.
//   - The admin invites team members into the SAME orgId with a role.
//   - All data is isolated by orgId (a workspace). Nobody sees another org.
//   - "superadmin" is the KubeEZ platform owner (global, not part of any org).
// ─────────────────────────────────────────────────────────────────────────────

// Roles a workspace admin can assign to team members (superadmin is platform-only)
export const ROLES = {
    superadmin: {
        key: 'superadmin',
        label: 'Super Admin',
        description: 'KubeEZ platform owner. Full global access across all workspaces.',
        assignable: false // cannot be assigned via the team UI
    },
    admin: {
        key: 'admin',
        label: 'Org Admin',
        description: 'Workspace owner. Full control: clusters, team, billing, everything.',
        assignable: true
    },
    operator: {
        key: 'operator',
        label: 'Operator',
        description: 'Can create, scale, upgrade and manage clusters and add-ons — but cannot manage the team or billing.',
        assignable: true
    },
    viewer: {
        key: 'viewer',
        label: 'Viewer',
        description: 'Read-only. Can view clusters, health, incidents and add-on access — cannot make changes.',
        assignable: true
    }
}

// Every capability in the product, mapped to the roles allowed to use it.
// superadmin implicitly has ALL permissions (handled in `can()`).
export const PERMISSIONS = {
    // Clusters
    'cluster:view':      ['admin', 'operator', 'viewer'],
    'cluster:create':    ['admin', 'operator'],
    'cluster:delete':    ['admin', 'operator'],
    'cluster:scale':     ['admin', 'operator'],
    'cluster:upgrade':   ['admin', 'operator'],
    'cluster:resume':    ['admin', 'operator'],

    // Add-ons
    'addon:view':        ['admin', 'operator', 'viewer'],
    'addon:install':     ['admin', 'operator'],

    // Access to sensitive cluster material
    'kubeconfig:download': ['admin', 'operator'],
    'terminal:access':     ['admin', 'operator'],

    // Gateway agents
    'agent:view':        ['admin', 'operator', 'viewer'],
    'agent:manage':      ['admin', 'operator'],

    // Incidents / monitoring
    'incident:view':     ['admin', 'operator', 'viewer'],

    // Workspace administration
    'team:view':         ['admin'],
    'team:manage':       ['admin'],   // invite / remove / change roles / reset passwords
    'billing:manage':    ['admin'],
    'backup:manage':     ['admin']
}

// Human-readable grouping for the transparency matrix shown in the UI
export const PERMISSION_GROUPS = [
    { group: 'Clusters', items: [
        { key: 'cluster:view',    label: 'View clusters & health' },
        { key: 'cluster:create',  label: 'Create clusters' },
        { key: 'cluster:scale',   label: 'Scale (add/remove nodes)' },
        { key: 'cluster:upgrade', label: 'Upgrade Kubernetes version' },
        { key: 'cluster:delete',  label: 'Delete clusters' }
    ]},
    { group: 'Add-ons & Access', items: [
        { key: 'addon:view',          label: 'View add-on access info' },
        { key: 'addon:install',       label: 'Install add-ons' },
        { key: 'kubeconfig:download', label: 'Download kubeconfig' },
        { key: 'terminal:access',     label: 'Use the cluster terminal' }
    ]},
    { group: 'Infrastructure', items: [
        { key: 'agent:view',    label: 'View gateway agents' },
        { key: 'agent:manage',  label: 'Create/remove gateway agents' },
        { key: 'incident:view', label: 'View incidents & auto-healing' }
    ]},
    { group: 'Workspace', items: [
        { key: 'team:manage',    label: 'Manage team & roles' },
        { key: 'billing:manage', label: 'Manage billing & plan' },
        { key: 'backup:manage',  label: 'Manage config backups' }
    ]}
]

/**
 * Does a role have a given permission?
 * superadmin always returns true.
 */
export function can(role, permission) {
    if (role === 'superadmin') return true
    const allowed = PERMISSIONS[permission]
    return Array.isArray(allowed) && allowed.includes(role)
}

/**
 * Return the full set of permission keys granted to a role — used by the UI
 * to show/hide actions and render the transparency matrix.
 */
export function permissionsForRole(role) {
    if (role === 'superadmin') return Object.keys(PERMISSIONS)
    return Object.keys(PERMISSIONS).filter(p => PERMISSIONS[p].includes(role))
}
