/**
 * planFeatures.js — central definition of which subscription plans unlock
 * premium platform features (as advertised on the Pricing page).
 */

export const PAID_PLANS = ['PRO', 'ENTERPRISE'];

/**
 * What a paid plan unlocks besides the feature flags (services/features.js) —
 * each is checked with isPaidPlan(getOrgPlan()) in its route. Listed so "Your
 * plan" can show every one of them as included or not.
 */
export const PLAN_CAPABILITIES = [
    { key: 'approvals', label: 'Two-person approvals & temporary access', group: 'Team & security', description: 'A second person approves risky actions; members ask for more access for a while' },
    { key: 'customRoles', label: 'Custom roles', group: 'Team & security', description: 'Your own roles with exactly the permissions you pick, per cluster and namespace' },
    { key: 'complianceReports', label: 'Compliance reports & fixes', group: 'Team & security', description: 'Reports as PDF, evidence bundle, monthly and CERT-In reports, guided fixes' },
    { key: 'alertsFull', label: 'Alerts: every channel, rules, all levels', group: 'Alerts', description: 'Free: one Telegram / email / webhook channel, critical alerts only' },
    { key: 'configBackups', label: 'Daily config backups & 1-click restore', group: 'Backups', description: 'KubeEZ settings of every cluster, every day' },
    { key: 'etcdBackups', label: 'Cluster snapshots, volume backups & restore', group: 'Backups', description: 'etcd snapshots before upgrades and on a schedule, Velero volume backups, disaster recovery' },
    { key: 'offsiteBackups', label: 'Off-site backups', group: 'Backups', description: 'Backups copied to your S3 / object storage' },
    { key: 'allAddons', label: 'Every add-on', group: 'Add-ons', description: 'Free: Dashboard, Metrics Server, KubeEZ AI, Explorer, Ingress, cert-manager, Trivy, Argo CD, Flux. Pro adds monitoring, logging, storage, Velero, MetalLB, policy engines, Vault, Harbor, Jenkins and more' },
    { key: 'advancedAddons', label: 'Advanced add-on settings', group: 'Add-ons', description: 'Your own Helm values for add-ons' },
];

/** True for any paid subscription (Pro or Enterprise). */
export function isPaidPlan(plan) {
    return PAID_PLANS.includes(String(plan || '').toUpperCase());
}

/**
 * Daily config backups + 1-click restore is a Pro feature.
 * Superadmin (platform owner) always has access.
 */
export function canUseBackups(plan, role) {
    if (role === 'superadmin') return true;
    return isPaidPlan(plan);
}
