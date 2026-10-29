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

    // GitOps (Argo CD / Flux apps on a cluster)
    'gitops:view':       ['admin', 'operator', 'viewer'],   // apps, sync & health, repo, revision, drift
    'gitops:sync':       ['admin', 'operator'],             // "Sync now" / "Refresh" — asks Argo CD / Flux to sync from Git

    'gitops:create':     ['admin', 'operator'],             // create an Argo CD app from a Git repo (locked to its namespace)
    'gitops:delete':     ['admin'],                         // remove an app KubeEZ created (what it deployed stays)

    // Helm apps (your releases on a cluster)
    'app:view':          ['admin', 'operator', 'viewer'],   // releases, status, history
    'app:values':        ['admin', 'operator'],             // values (secrets masked), previews, environment compare
    'app:deploy':        ['admin', 'operator'],             // install, upgrade, roll back
    'app:delete':        ['admin'],                         // uninstall a release

    // Delivery settings (workspace-wide)
    'env:manage':        ['admin'],                         // environments (dev / staging / prod) and which are protected
    'chartrepo:manage':  ['admin'],                         // chart repositories the team may deploy from
    'freeze:manage':     ['admin'],                         // change freezes
    'token:manage':      ['admin'],                         // deploy tokens for CI (one release each)
    'gitrepo:manage':    ['admin'],                         // Git accounts for promotion pull requests

    // Day-2 operations on a cluster
    'hibernate:manage':  ['admin', 'operator'],             // scale a namespace to 0 and back (Hibernate / Wake)
    'debug:ephemeral':   ['admin', 'operator'],             // add a debug container to a running pod (also needs terminal access)
    'autoscale:manage':  ['admin', 'operator'],             // KEDA ScaledObjects KubeEZ makes (schedule, CPU / memory, Prometheus)
    'registry:manage':   ['admin'],                         // container registries and their pull secrets in namespaces

    // Security & delivery insight (read-only)
    'security:view':     ['admin', 'operator', 'viewer'],   // Trivy: image vulnerabilities and misconfigurations per workload
    'metrics:view':      ['admin', 'operator', 'viewer'],   // DORA: deploy frequency, change failure rate, recovery time

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

    // KubeEZ AI — only admins by default; an admin gives it to a member
    // (Team & Roles → AI access) or puts it in a custom role
    'ai:use':            ['admin'],   // ask KubeEZ AI: Ask AI, explanations, summaries, Create YAML (it only explains / suggests)
    'ai:apply':          ['admin'],   // apply what the AI wrote or suggested (YAML, fixes) — also needs Kubernetes edit on the cluster
    'ai:manage':         ['admin']    // AI engines, routing, safety switches, activity, usage & cost
}

// What an admin can give a member on top of their role (Team & Roles → AI access)
export const AI_ACCESS = {
    none:  { label: 'No AI', permissions: [] },
    ask:   { label: 'Ask AI', permissions: ['ai:use'] },
    apply: { label: 'Ask & apply', permissions: ['ai:use', 'ai:apply'] }
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
    { group: 'GitOps', items: [
        { key: 'gitops:view', label: 'View GitOps apps (Argo CD / Flux): sync, health, drift' },
        { key: 'gitops:sync', label: 'Sync or refresh a GitOps app from Git' },
        { key: 'gitops:create', label: 'Create an Argo CD app from a Git repository' },
        { key: 'gitops:delete', label: 'Remove an app KubeEZ created' }
    ]},
    { group: 'Apps & delivery', items: [
        { key: 'app:view', label: 'View Helm apps, their status and history' },
        { key: 'app:values', label: 'View values (secrets masked), previews and environment compare' },
        { key: 'app:deploy', label: 'Install, upgrade and roll back Helm apps' },
        { key: 'app:delete', label: 'Uninstall Helm apps' },
        { key: 'env:manage', label: 'Manage environments and which are protected' },
        { key: 'chartrepo:manage', label: 'Manage chart repositories' },
        { key: 'freeze:manage', label: 'Manage change freezes' },
        { key: 'token:manage', label: 'Manage deploy tokens for CI' },
        { key: 'gitrepo:manage', label: 'Manage Git accounts for promotion pull requests' },
        { key: 'hibernate:manage', label: 'Hibernate and wake namespaces' },
        { key: 'debug:ephemeral', label: 'Add debug containers to running pods' },
        { key: 'autoscale:manage', label: 'Set up autoscaling (KEDA)' },
        { key: 'registry:manage', label: 'Manage registries and pull secrets' }
    ]},
    { group: 'Security & delivery', items: [
        { key: 'security:view', label: 'View image vulnerabilities and misconfigurations (Trivy)' },
        { key: 'metrics:view', label: 'View delivery metrics (DORA)' }
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
        { key: 'ai:use',    label: 'Ask KubeEZ AI (Ask AI, explanations, summaries, Create YAML)' },
        { key: 'ai:apply',  label: 'Apply AI-written YAML and AI fixes (with Kubernetes edit access)' },
        { key: 'ai:manage', label: 'Manage AI engines, routing, safety, usage & cost' }
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
    'backup:manage',
    'gitops:view', 'gitops:sync', 'gitops:create', 'gitops:delete',
    'app:view', 'app:values', 'app:deploy', 'app:delete',
    'hibernate:manage', 'debug:ephemeral', 'autoscale:manage',
    'security:view', 'metrics:view'
]

// Never part of a custom role: running the workspace stays with Admins
export const ADMIN_ONLY_PERMISSIONS = ['team:view', 'team:manage', 'billing:manage']

// What the member may do INSIDE the cluster (KubeEZ Explorer → Kubernetes RBAC)
export const KUBE_LEVELS = ['none', 'view', 'edit', 'admin']
export const BUILTIN_KUBE_LEVEL = { admin: 'admin', operator: 'edit', viewer: 'view', superadmin: 'admin' }

// Ready-made starting points for the role builder
export const ROLE_TEMPLATES = [
    { key: 'oncall', name: 'On-call engineer', description: 'Watches and fixes incidents, terminal with approval. Cannot delete or upgrade.',
      kube: 'edit', permissions: ['cluster:view', 'addon:view', 'incident:view', 'incident:act', 'terminal:access', 'compliance:view', 'agent:view', 'gitops:view', 'gitops:sync', 'security:view', 'metrics:view', 'app:view', 'app:values', 'app:deploy', 'debug:ephemeral'] },
    { key: 'developer', name: 'Developer', description: 'Sees clusters and add-on addresses, works inside the cluster (Explorer). No credentials, no cluster changes.',
      kube: 'edit', permissions: ['cluster:view', 'addon:view', 'incident:view', 'compliance:view', 'gitops:view', 'security:view', 'metrics:view', 'app:view'] },
    { key: 'backup', name: 'Backup manager', description: 'Takes and restores backups. Nothing else changes.',
      kube: 'view', permissions: ['cluster:view', 'addon:view', 'incident:view', 'backup:manage'] },
    { key: 'auditor', name: 'Auditor', description: 'Read-only compliance: scores, reports, audit trail and terminal recordings. No secrets.',
      kube: 'view', permissions: ['cluster:view', 'incident:view', 'compliance:view', 'audit:view', 'security:view'] },
    { key: 'addons', name: 'Add-on manager', description: 'Installs, configures and updates add-ons, with their logins.',
      kube: 'view', permissions: ['cluster:view', 'addon:view', 'addon:credentials', 'addon:install', 'incident:view'] }
]

// Permissions a custom role may contain (everything except the admin-only ones)
export const ASSIGNABLE_PERMISSIONS = () => Object.keys(PERMISSIONS).filter(p => !ADMIN_ONLY_PERMISSIONS.includes(p))
