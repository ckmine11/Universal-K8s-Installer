import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { notificationStore, CHANNEL_TYPES, EVENTS } from '../services/notificationStore.js'
import { notifier, validateChannel, telegramChats } from '../services/notifier.js'
import { alertPlanFor, lockedChannelIds } from '../config/alertPlans.js'
import { clusterStore } from '../services/clusterStore.js'

// Alert channels + rules of the caller's workspace (admins only: channels
// hold bot tokens and webhook URLs)
const router = express.Router()
router.use(requirePermission('alerts:manage'))

const org = (req) => {
    if (!req.user.orgId) throw Object.assign(new Error('Alerts belong to a workspace'), { status: 400 })
    return req.user.orgId
}
const fail = (res, e) => res.status(e.status || 400).json({ error: e.message, ...(e.upgrade ? { upgrade: true } : {}) })
// 402 = "your plan does not include this" (the page offers the upgrade)
const planError = (msg) => Object.assign(new Error(msg), { status: 402, upgrade: true })
const routingPro = 'Sending some clusters or severities to a channel is part of Pro. On Free the channel receives every critical alert.'
const isDefaultRouting = (r) => !(r.clusters?.length) && (!r.minSeverity || r.minSeverity === 'info')
const LABEL = { telegram: 'Telegram', slack: 'Slack', teams: 'Microsoft Teams', whatsapp: 'WhatsApp', email: 'Email', webhook: 'Webhook' }

router.get('/', async (req, res) => {
    try {
        const plan = await alertPlanFor(org(req))
        const view = notificationStore.publicView(org(req), plan.history)
        const locked = lockedChannelIds(notificationStore.channels(org(req)), plan)
        res.json({
            ...view,
            channels: view.channels.map(c => ({ ...c, locked: locked.has(c.id) })),
            plan: { ...plan, emailsToday: notificationStore.emailsToday(org(req)) },
            types: Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([k, v]) => [k, { label: v.label, fields: [...v.plain, ...v.secret], secret: v.secret }])),
            events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.label])),
            emailConfigured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
            linksConfigured: /^https?:\/\/[^/]/.test(process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || ''),
            // for routing: which clusters a channel receives
            clusters: (await clusterStore.getClusters())
                .filter(c => (c.orgId && c.orgId === req.user.orgId) || (!c.orgId && c.ownerId === req.user.id))
                .map(c => ({ id: c.id, name: c.clusterName || c.name || c.id }))
        })
    } catch (e) { fail(res, e) }
})

router.post('/channels', async (req, res) => {
    try {
        const { type, name, config, enabled, routing } = req.body || {}
        const plan = await alertPlanFor(org(req))
        if (routing && !plan.rules && !isDefaultRouting(routing)) throw planError(routingPro)
        if (!plan.channelTypes.includes(type)) throw planError(`${LABEL[type] || type} alerts are part of Pro. On Free you can use one Telegram, email or webhook channel.`)
        if (plan.maxChannels != null && notificationStore.channels(org(req)).filter(c => plan.channelTypes.includes(c.type)).length >= plan.maxChannels) {
            throw planError(`The Free plan includes ${plan.maxChannels} alert channel — remove the existing one first, or upgrade to Pro for more.`)
        }
        validateChannel(type, config)
        const id = notificationStore.saveChannel(org(req), { type, name, config, enabled, routing: plan.rules ? routing : undefined })
        res.json({ success: true, id })
    } catch (e) { fail(res, e) }
})

router.put('/channels/:id', async (req, res) => {
    try {
        const existing = notificationStore.channels(org(req)).find(c => c.id === req.params.id)
        if (!existing) return res.status(404).json({ error: 'Channel not found' })
        const { name, config = {}, enabled, routing } = req.body || {}
        const plan = await alertPlanFor(org(req))
        if (routing && !plan.rules && !isDefaultRouting(routing)) throw planError(routingPro)
        validateChannel(existing.type, config, true)
        notificationStore.saveChannel(org(req), { id: existing.id, name: name ?? existing.name, config, enabled: enabled ?? existing.enabled, routing: plan.rules ? routing : undefined })
        res.json({ success: true })
    } catch (e) { fail(res, e) }
})

router.delete('/channels/:id', (req, res) => {
    try { notificationStore.deleteChannel(org(req), req.params.id); res.json({ success: true }) } catch (e) { fail(res, e) }
})

router.post('/channels/:id/test', async (req, res) => {
    try { res.json(await notifier.test(org(req), req.params.id)) } catch (e) { fail(res, e) }
})

// "Find my chat ID": the chats that wrote to the bot. Token from the form, or
// the saved one when editing (it is never sent back to the browser).
router.post('/telegram/chats', async (req, res) => {
    try {
        let token = String(req.body?.botToken || '').trim()
        if (!token && req.body?.channelId) token = notificationStore.channels(org(req)).find(c => c.id === req.body.channelId && c.type === 'telegram')?.config.botToken || ''
        res.json(await telegramChats(token))
    } catch (e) { fail(res, e) }
})

router.put('/rules', async (req, res) => {
    try {
        if (!(await alertPlanFor(org(req))).rules) throw planError('Choosing alert types, quiet hours, the cooldown and escalation is part of Pro. Free sends critical alerts with fixed settings.')
        res.json({ success: true, rules: notificationStore.saveRules(org(req), req.body || {}) })
    } catch (e) { fail(res, e) }
})

export default router
