// Addon plan-gating — keep in sync with frontend src/config/addons.js
// Free plan may only install these basic add-ons.
export const FREE_ADDONS = ['ingress', 'dashboard']

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
            error: `Your Free plan includes only basic add-ons (Ingress, Dashboard). ` +
                   `Upgrade to Pro to install: ${[...new Set(blocked)].join(', ')}.`
        }
    }
    return { allowed: true }
}
