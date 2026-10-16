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
        description: 'Read-only. Can view clusters, health, incidents and which add-ons are installed — but NOT their credentials/tokens, and cannot make any changes (no create, delete, scale, upgrade).',
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
    'addon:view':        ['admin', 'operator', 'viewer'],   // see which add-ons are installed + their URLs
    'addon:credentials': ['admin', 'operator'],             // see sensitive login credentials/tokens
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
    'backup:manage':     ['admin'],
    'alerts:manage':     ['admin'],
    'incident:act':      ['admin', 'operator'],   // acknowledge, run a fix now, mute, maintenance
    'healing:manage':    ['admin'],               // auto-healing policies
    'compliance:view':   ['admin', 'operator', 'viewer'],   // compliance scores and reports
    'compliance:manage': ['admin'],               // run scans, attestations, fixes, monthly reports
    'audit:view':        ['admin'],               // the audit trail and terminal recordings
    'access:approve':    ['admin'],               // approve terminal access (just in time)

    // KubeEZ AI
    'ai:use':            ['admin', 'operator', 'viewer'],   // ask KubeEZ AI (it only explains / suggests)
    'ai:manage':         ['admin']                // AI engines, routing, safety switches, activity
}

// Human-readable grouping for the transparency matrix shown in the UI
export const PERMISSION_GROUPS = [
    { group: 'Clusters', items: [
        { key: 'cluster:view',    label: 'View clusters & health' },
        { key: 'cluster:create',  label: 'Create clusters' },
        { key: 'cluster:scale',   label: 'Scale (add/remove nodes)' },
        { key: 'cluster:upgrade', label: 'Upgrade Kubernetes version' },
        { key: 'cluster:resume',  label: 'Resume a failed install' },
        { key: 'cluster:delete',  label: 'Delete clusters' }
    ]},
    { group: 'Add-ons & Access', items: [
        { key: 'addon:view',          label: 'View installed add-ons & URLs' },
        { key: 'addon:credentials',   label: 'View add-on credentials/tokens' },
        { key: 'addon:install',       label: 'Install, repair & uninstall add-ons; view add-on logs' },
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
        { key: 'backup:manage',  label: 'Manage config backups' },
        { key: 'alerts:manage',  label: 'Manage alert channels' },
        { key: 'incident:act',   label: 'Act on incidents (fix now, mute, maintenance)' },
        { key: 'healing:manage', label: 'Change auto-healing policies' }
    ]},
    { group: 'Compliance', items: [
        { key: 'compliance:view',   label: 'View compliance scores & reports' },
        { key: 'compliance:manage', label: 'Run scans, confirm attestations, apply fixes' },
        { key: 'audit:view',        label: 'View the audit trail and terminal recordings' },
        { key: 'access:approve',    label: 'Approve terminal access requests' }
    ]},
    { group: 'KubeEZ AI', items: [
        { key: 'ai:use',    label: 'Ask KubeEZ AI (explanations and suggestions)' },
        { key: 'ai:manage', label: 'Manage AI engines, routing and safety' }
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

// ─── Custom roles ─────────────────────────────────────────────────────────────
// A workspace can build its own roles from the permissions above, and give a
// member a different role on some clusters (per cluster or by cluster label).

// Permissions that belong to ONE cluster — a per-cluster role decides these.
// Everything else is workspace-wide and always comes from the member's main role.
export const CLUSTER_PERMISSIONS = [
    'cluster:view', 'cluster:scale', 'cluster:upgrade', 'cluster:delete', 'cluster:resume',
    'addon:view', 'addon:credentials', 'addon:install',
    'kubeconfig:download', 'terminal:access',
    'incident:view', 'incident:act',
    'compliance:view', 'compliance:manage',
    'backup:manage'
]

// Never part of a custom role: running the workspace stays with Admins
export const ADMIN_ONLY_PERMISSIONS = ['team:view', 'team:manage', 'billing:manage']

// What the member may do INSIDE the cluster (KubeEZ Explorer → Kubernetes RBAC)
export const KUBE_LEVELS = ['none', 'view', 'edit', 'admin']
export const BUILTIN_KUBE_LEVEL = { admin: 'admin', operator: 'edit', viewer: 'view', superadmin: 'admin' }

// Ready-made starting points for the role builder
export const ROLE_TEMPLATES = [
    { key: 'oncall', name: 'On-call engineer', description: 'Watches and fixes incidents, terminal with approval. Cannot delete or upgrade.',
      kube: 'edit', permissions: ['cluster:view', 'addon:view', 'incident:view', 'incident:act', 'terminal:access', 'compliance:view', 'agent:view'] },
    { key: 'developer', name: 'Developer', description: 'Sees clusters and add-on addresses, works inside the cluster (Explorer). No credentials, no cluster changes.',
      kube: 'edit', permissions: ['cluster:view', 'addon:view', 'incident:view', 'compliance:view'] },
    { key: 'backup', name: 'Backup manager', description: 'Takes and restores backups. Nothing else changes.',
      kube: 'view', permissions: ['cluster:view', 'addon:view', 'incident:view', 'backup:manage'] },
    { key: 'auditor', name: 'Auditor', description: 'Read-only compliance: scores, reports, audit trail and terminal recordings. No secrets.',
      kube: 'view', permissions: ['cluster:view', 'incident:view', 'compliance:view', 'audit:view'] },
    { key: 'addons', name: 'Add-on manager', description: 'Installs, configures and updates add-ons, with their logins.',
      kube: 'view', permissions: ['cluster:view', 'addon:view', 'addon:credentials', 'addon:install', 'incident:view'] }
]

// Permissions a custom role may contain (everything except the admin-only ones)
export const ASSIGNABLE_PERMISSIONS = () => Object.keys(PERMISSIONS).filter(p => !ADMIN_ONLY_PERMISSIONS.includes(p))
