// Plans: what each one allows, and the Pro trial a new hosted workspace starts
// with. One place for the numbers — sign-up, billing, limits and features read
// them from here. Pro and Enterprise have every feature (services/features.js);
// Enterprise differs only in quantities, set per deal.
export const PLAN_LIMITS = {
    FREE: { maxClusters: 1, maxNodes: 5, maxMembers: 1 },
    PRO: { maxClusters: 10, maxNodes: 50, maxMembers: 5 },
}
// KUBEEZ_TRIAL_DAYS: length of the trial (0 = no trial); read at sign-up
const trialDays = () => { const n = parseInt(process.env.KUBEEZ_TRIAL_DAYS ?? '14', 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 90) : 14 }
export const TRIAL_DAYS = trialDays()

/** A new hosted workspace: Free, with TRIAL_DAYS of Pro. */
export function newSubscription({ trial = true, now = Date.now(), days = trialDays() } = {}) {
    return { plan: 'FREE', ...PLAN_LIMITS.FREE, ...(trial && days > 0 ? { trialEndsAt: new Date(now + days * 864e5).toISOString() } : {}) }
}

/**
 * What a stored subscription allows right now: a Free workspace in its trial
 * counts as Pro (with Pro limits); a Free one never gets less than the Free
 * limits (older accounts were saved with smaller ones). trial: { endsAt,
 * daysLeft } while it runs, { endedAt } after.
 */
export function effectiveSubscription(sub, now = Date.now()) {
    const s = sub || {}
    const plan = String(s.plan || 'FREE').toUpperCase()
    const at = (k, min) => Math.max(Number(s[k]) || 0, min[k])
    if (plan !== 'FREE') return { ...s, plan, trial: null }
    const ends = s.trialEndsAt ? Date.parse(s.trialEndsAt) : 0
    if (ends > now) {
        const P = PLAN_LIMITS.PRO
        return { ...s, plan: 'PRO', maxClusters: at('maxClusters', P), maxNodes: at('maxNodes', P), maxMembers: at('maxMembers', P), trial: { endsAt: s.trialEndsAt, daysLeft: Math.ceil((ends - now) / 864e5) } }
    }
    const F = PLAN_LIMITS.FREE
    return { ...s, plan: 'FREE', maxClusters: at('maxClusters', F), maxNodes: at('maxNodes', F), maxMembers: at('maxMembers', F), trial: ends ? { endedAt: s.trialEndsAt } : null }
}
