/**
 * planFeatures.js — central definition of which subscription plans unlock
 * premium platform features (as advertised on the Pricing page).
 */

export const PAID_PLANS = ['PRO', 'ENTERPRISE'];

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
