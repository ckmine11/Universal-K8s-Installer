import { isPaidPlan } from './planFeatures.js'

// What Alerts can do on each plan.
// Free: one channel (Telegram, email or webhook), critical alerts only, fixed
// rules, a small daily email allowance — email shares the server's SMTP quota
// with password resets and welcome emails, so it is capped on every plan.
const ALL_TYPES = ['telegram', 'slack', 'teams', 'whatsapp', 'email', 'webhook']
const n = (v, d) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= 0 ? x : d }

export const ALERT_PLANS = {
    free: {
        name: 'Free', paid: false,
        maxChannels: 1,
        channelTypes: ['telegram', 'email', 'webhook'],
        criticalOnly: true,
        rules: false,
        emailPerDay: n(process.env.ALERT_EMAILS_PER_DAY_FREE, 20),
        history: 10
    },
    paid: {
        name: 'Pro', paid: true,
        maxChannels: null,
        channelTypes: ALL_TYPES,
        criticalOnly: false,
        rules: true,
        emailPerDay: n(process.env.ALERT_EMAILS_PER_DAY_PAID, 200),
        history: 100
    }
}

/** The alert plan of a workspace (the platform owner's workspace is never limited). */
export async function alertPlanFor(orgId) {
    const { authService } = await import('../services/authService.js')
    const owner = authService.getOrgOwner(orgId)
    if (owner?.role === 'superadmin' || isPaidPlan(authService.getOrgPlan(orgId))) return ALERT_PLANS.paid
    return ALERT_PLANS.free
}

/** Channels the plan does not cover (a downgraded workspace keeps them, locked). */
export function lockedChannelIds(channels, plan) {
    const locked = new Set()
    let used = 0
    for (const c of [...channels].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
        if (!plan.channelTypes.includes(c.type)) { locked.add(c.id); continue }
        if (plan.maxChannels != null && used >= plan.maxChannels) { locked.add(c.id); continue }
        used++
    }
    return locked
}
