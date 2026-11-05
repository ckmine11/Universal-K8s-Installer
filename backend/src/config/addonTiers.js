// Addon plan-gating — keep in sync with frontend src/config/addons.js
// Free: the basics, and every add-on a Free feature needs (Explorer, Ingress;
// cert-manager → Certificates, Trivy → Security, Argo CD / Flux → GitOps).
export const FREE_ADDONS = ['dashboard', 'metrics-server', 'kubeez-ai', 'explorer', 'ingress', 'cert-manager', 'trivy-operator', 'argocd', 'flux']

// Normalize the various keys the frontend may send for the same addon
const KEY_ALIASES = {
    certManager: 'cert-manager',
    'cert-manager': 'cert-manager'
}
const norm = (k) => KEY_ALIASES[k] || k

/**
 * Validate a selected `addons` object against a user's plan.
 * Returns { allowed: true } or { allowed: false, error, blocked: [...] }.
 * Only FREE plans are restricted; PRO/ENTERPRISE/paid get everything.
 */
export function checkAddonPlan(addons, plan) {
    if (!addons || typeof addons !== 'object') return { allowed: true }

    const isFree = !plan || String(plan).toUpperCase() === 'FREE'
    if (!isFree) return { allowed: true }

    const blocked = Object.entries(addons)
        .filter(([key, enabled]) => enabled && !FREE_ADDONS.includes(norm(key)))
        .map(([key]) => norm(key))

    if (blocked.length > 0) {
        return {
            allowed: false,
            blocked,
            error: `Your Free plan includes these add-ons: Dashboard, Metrics Server, KubeEZ AI, Explorer, Ingress, cert-manager, Trivy, Argo CD and Flux. ` +
                   `Upgrade to Pro to install: ${[...new Set(blocked)].join(', ')}.`
        }
    }
    return { allowed: true }
}
