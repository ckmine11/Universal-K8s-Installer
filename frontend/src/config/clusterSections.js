import { LayoutGrid, Compass, Boxes, GitBranch, ShieldAlert, BadgeCheck, Activity, Package, Database } from 'lucide-react'
import { can } from './permissions'

// A cluster's sections — the one list behind both the sidebar's cluster group
// and the cluster page (?tab=<key>). A section shows when the member has its
// permission on that cluster and its feature is on.
export const CLUSTER_SECTIONS = [
    { key: 'overview', label: 'Overview', hint: 'nodes & health', icon: LayoutGrid },
    { key: 'explorer', label: 'Explorer', hint: 'resources, timeline, audit', icon: Compass },
    { key: 'apps', label: 'Apps', hint: 'Helm install, upgrade, roll back', icon: Boxes, permission: 'app:view', feature: 'helmApps' },
    { key: 'gitops', label: 'GitOps', hint: 'Argo CD & Flux sync', icon: GitBranch, permission: 'gitops:view', feature: 'gitops' },
    { key: 'security', label: 'Security', hint: 'vulnerabilities, misconfig', icon: ShieldAlert, permission: 'security:view', feature: 'security' },
    { key: 'certificates', label: 'Certificates', hint: 'cert-manager, expiry, renew', icon: BadgeCheck, permission: 'security:view', feature: 'certManager' },
    { key: 'delivery', label: 'Delivery metrics', hint: 'DORA metrics', icon: Activity, permission: 'metrics:view', feature: 'dora' },
    { key: 'addons', label: 'Add-ons', hint: 'access, manage, logs', icon: Package },
    { key: 'backups', label: 'Backups', hint: 'snapshots, volumes, recovery', icon: Database },
]

export function visibleSections(role, clusterId, featureOn) {
    return CLUSTER_SECTIONS.filter(s => (!s.permission || can(role, s.permission, clusterId)) && (!s.feature || featureOn(s.feature)))
}

export const sectionLink = (clusterId, key) => `/cluster/${encodeURIComponent(clusterId)}${key && key !== 'overview' ? `?tab=${key}` : ''}`
