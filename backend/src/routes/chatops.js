import express from 'express'
import crypto from 'crypto'
import { notificationStore } from '../services/notificationStore.js'
import { aiStore } from '../services/ai/aiStore.js'
import { handleChat } from '../services/ai/chatops.js'
import { postRequest } from '../services/notifier.js'

// ChatOps from Slack: a slash command (e.g. /kubeez kya problem hai) posts here.
// Public, but every request must carry Slack's signature made with the
// channel's signing secret (checked on the raw body, within 5 minutes).
// Mounted BEFORE express.json() — the signature needs the exact body.
const router = express.Router()

function findChannel(channelId) {
    let all = {}
    try { all = notificationStore._read() } catch { return null }
    for (const orgId of Object.keys(all)) {
        const ch = notificationStore.channels(orgId).find(c => c.id === channelId && c.type === 'slack')
        if (ch) return { orgId, ch }
    }
    return null
}

export function slackSignatureOk(secret, ts, raw, sig) {
    if (!secret || !ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
    const want = Buffer.from(`v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`)
    const got = Buffer.from(String(sig))
    return got.length === want.length && crypto.timingSafeEqual(got, want)
}

router.post('/slack/:channelId', express.raw({ type: 'application/x-www-form-urlencoded', limit: '20kb' }), async (req, res) => {
    const found = findChannel(req.params.channelId)
    const cfg = found && aiStore.chatops(found.orgId, found.ch.id)
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
    if (!found || !cfg.enabled || !slackSignatureOk(cfg.slackSecret, req.get('x-slack-request-timestamp'), raw, req.get('x-slack-signature'))) {
        return res.status(401).json({ error: 'Not a valid Slack request for a KubeEZ ChatOps channel' })
    }
    const body = Object.fromEntries(new URLSearchParams(raw))
    const responseUrl = body.response_url
    if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl || '')) return res.status(400).json({ error: 'No response URL' })
    // Slack wants an answer within 3 s — the real one follows via response_url
    res.json({ response_type: 'ephemeral', text: '🔎 …' })
    const post = (text) => postRequest(responseUrl, { response_type: 'in_channel', replace_original: false, text: String(text).slice(0, 3500) }, { timeoutMs: 15000 }).catch(() => { })
    try {
        const r = await handleChat({ orgId: found.orgId, chatKey: `slack:${body.team_id}:${body.channel_id}`, who: body.user_name || 'Slack user', source: 'Slack', text: body.text || 'help' })
        await post(r.reply)
    } catch (e) { await post(`⚠ ${e.message}`) }
})

export default router
