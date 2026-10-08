import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { notificationStore, CHANNEL_TYPES, EVENTS } from '../services/notificationStore.js'
import { notifier, validateChannel, telegramChats } from '../services/notifier.js'

// Alert channels + rules of the caller's workspace (admins only: channels
// hold bot tokens and webhook URLs)
const router = express.Router()
router.use(requirePermission('alerts:manage'))

const org = (req) => {
    if (!req.user.orgId) throw Object.assign(new Error('Alerts belong to a workspace'), { status: 400 })
    return req.user.orgId
}
const fail = (res, e) => res.status(e.status || 400).json({ error: e.message })

router.get('/', (req, res) => {
    try {
        res.json({
            ...notificationStore.publicView(org(req)),
            types: Object.fromEntries(Object.entries(CHANNEL_TYPES).map(([k, v]) => [k, { label: v.label, fields: [...v.plain, ...v.secret], secret: v.secret }])),
            events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.label])),
            emailConfigured: !!(process.env.SMTP_USER && process.env.SMTP_PASS),
            linksConfigured: /^https?:\/\/[^/]/.test(process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '')
        })
    } catch (e) { fail(res, e) }
})

router.post('/channels', (req, res) => {
    try {
        const { type, name, config, enabled } = req.body || {}
        validateChannel(type, config)
        const id = notificationStore.saveChannel(org(req), { type, name, config, enabled })
        res.json({ success: true, id })
    } catch (e) { fail(res, e) }
})

router.put('/channels/:id', (req, res) => {
    try {
        const existing = notificationStore.channels(org(req)).find(c => c.id === req.params.id)
        if (!existing) return res.status(404).json({ error: 'Channel not found' })
        const { name, config = {}, enabled } = req.body || {}
        validateChannel(existing.type, config, true)
        notificationStore.saveChannel(org(req), { id: existing.id, name: name ?? existing.name, config, enabled: enabled ?? existing.enabled })
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
        res.json({ chats: await telegramChats(token) })
    } catch (e) { fail(res, e) }
})

router.put('/rules', (req, res) => {
    try { res.json({ success: true, rules: notificationStore.saveRules(org(req), req.body || {}) }) } catch (e) { fail(res, e) }
})

export default router
