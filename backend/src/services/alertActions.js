import crypto from 'crypto'
import { getJwtSecret } from '../utils/cryptoUtils.js'
import { notificationStore } from './notificationStore.js'
import { postRequest } from './notifier.js'

/**
 * Act on an incident straight from the alert:
 *  - Telegram: buttons in the message (Acknowledge / Mute 1 h / Fix now),
 *    picked up by polling the workspace's own bot
 *  - every other channel: signed links that open a short confirmation page
 *    (chat apps open links for previews — a plain link must never act by itself)
 */

const LINK_TTL_MS = 24 * 3600e3
const ACTIONS = { ack: 'Acknowledge', mute: 'Mute for 1 hour', fix: 'Run the fix now' }
const key = () => crypto.createHash('sha256').update(`${getJwtSecret()}|alert-actions`).digest()
const b64 = (b) => Buffer.from(b).toString('base64url')
const publicUrl = () => (process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '')

export function signAction(payload) {
    const body = b64(JSON.stringify({ ...payload, exp: Date.now() + LINK_TTL_MS }))
    const sig = crypto.createHmac('sha256', key()).update(body).digest('base64url')
    return `${body}.${sig}`
}

export function verifyAction(token) {
    const [body, sig] = String(token || '').split('.')
    if (!body || !sig) throw Object.assign(new Error('This link is not valid'), { status: 400 })
    const want = crypto.createHmac('sha256', key()).update(body).digest()
    const got = Buffer.from(sig, 'base64url')
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw Object.assign(new Error('This link is not valid'), { status: 400 })
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!(p.exp > Date.now())) throw Object.assign(new Error('This link has expired (links work for 24 hours) — open KubeEZ instead'), { status: 410 })
    if (!ACTIONS[p.action]) throw Object.assign(new Error('Unknown action'), { status: 400 })
    return p
}

/** Links for an alert about an incident (only with an absolute public address). */
export function actionLinks(ev) {
    const base = publicUrl()
    if (!ev?.incidentId || !/^https?:\/\/[^/]/.test(base)) return []
    const list = ['ack', 'mute', ...(ev.fixable ? ['fix'] : [])]
    return list.map(action => ({ action, label: { ack: 'Acknowledge', mute: 'Mute 1 h', fix: 'Fix now' }[action], url: `${base}/api/alert-actions/${signAction({ i: ev.incidentId, o: ev.orgId, action })}` }))
}

/** Do it. `by` is shown in the incident's timeline. */
export async function performAction({ incidentId, orgId, action, by }) {
    const { incidentDetector } = await import('./incidentDetector.js')
    const inc = incidentDetector.find(incidentId)
    if (!inc || (orgId && inc.orgId && inc.orgId !== orgId)) throw Object.assign(new Error('This incident no longer exists (incidents are kept 7 days)'), { status: 404 })
    if (['resolved', 'cleared'].includes(inc.status)) return { incident: inc, text: 'Already closed — nothing to do.' }
    if (action === 'ack') { incidentDetector.acknowledge(incidentId, by); return { incident: inc, text: `Acknowledged by ${by}.` } }
    if (action === 'mute') { incidentDetector.mute(incidentId, 1, by); return { incident: inc, text: `Muted for 1 hour by ${by} — no alerts or fixes for it.` } }
    if (action === 'fix') { await incidentDetector.runNow(incidentId, by); return { incident: inc, text: `Fix started by ${by} — follow it on the Incidents page.` } }
    throw Object.assign(new Error('Unknown action'), { status: 400 })
}

export const actionLabel = (a) => ACTIONS[a] || a

// ── Telegram: buttons in the alert, answered by polling the bot ───────────
const TG_API = () => process.env.KUBEEZ_TELEGRAM_API || 'https://api.telegram.org'   // overridden in tests
const tg = (token, method, body, timeoutMs = 15000) => postRequest(`${TG_API()}/bot${token}/${method}`, body, { timeoutMs })
const seenChats = new Map()   // bot token → Map(chatId → chat) — "Find my chat ID" reads it while polling
export const telegramSeenChats = (token) => [...(seenChats.get(token)?.values() || [])]

function remember(token, chat) {
    if (!chat?.id) return
    if (!seenChats.has(token)) seenChats.set(token, new Map())
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id)
    seenChats.get(token).set(String(chat.id), { id: String(chat.id), name, type: chat.type, username: chat.username || null })
}

/** One update from a workspace's bot. Exported for tests. */
export async function handleTelegramUpdate(orgId, channel, u) {
    const token = channel.config.botToken
    for (const m of [u.message, u.channel_post, u.my_chat_member, u.callback_query?.message]) remember(token, m?.chat)
    const q = u.callback_query
    if (!q) return null
    const [action, incidentId] = String(q.data || '').split(':')
    const answer = (text) => tg(token, 'answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190), show_alert: false }).catch(() => { })
    // only the chat this channel posts to may act, only on its own workspace
    if (String(q.message?.chat?.id) !== String(channel.config.chatId)) { await answer('Not allowed from this chat'); return { ok: false, reason: 'chat' } }
    const who = q.from?.username ? `@${q.from.username}` : [q.from?.first_name, q.from?.last_name].filter(Boolean).join(' ') || 'Telegram user'
    try {
        const r = await performAction({ incidentId, orgId, action, by: `${who} (Telegram)` })
        await answer(r.text)
        // the buttons are used up — show who did what under the alert
        await tg(token, 'editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => { })
        await tg(token, 'sendMessage', { chat_id: q.message.chat.id, reply_to_message_id: q.message.message_id, text: `✓ ${r.text}` }).catch(() => { })
        return { ok: true, text: r.text }
    } catch (e) {
        await answer(e.message)
        return { ok: false, reason: e.message }
    }
}

class TelegramPoller {
    constructor() { this.offsets = new Map(); this.running = new Set(); this.timer = null; this.backoff = new Map() }

    polling(token) { return this.running.has(token) }

    stop() { clearInterval(this.timer); this.timer = null; this.wanted = new Map() }

    start() {
        if (this.timer) return
        this.timer = setInterval(() => this.tick(), 15000)
        this.timer.unref?.()
        this.tick()
    }

    // One long-poll loop per bot that has a Telegram channel (started / stopped as channels change)
    tick() {
        let all = {}
        try { all = notificationStore._read() } catch { return }
        const wanted = new Map()
        for (const orgId of Object.keys(all)) {
            for (const ch of notificationStore.channels(orgId)) {
                if (ch.type === 'telegram' && ch.enabled !== false && ch.config.botToken) wanted.set(ch.config.botToken, { orgId, channelId: ch.id })
            }
        }
        this.wanted = wanted
        for (const [token, ref] of wanted) if (!this.running.has(token)) this.loop(token, ref)
    }

    async loop(token, ref) {
        this.running.add(token)
        try {
            while (this.wanted?.has(token)) {
                const until = this.backoff.get(token) || 0
                if (Date.now() < until) { await new Promise(r => setTimeout(r, Math.min(15000, until - Date.now()))); continue }
                const t0 = Date.now()
                try {
                    const r = await tg(token, 'getUpdates', { offset: this.offsets.get(token) || 0, timeout: 25, allowed_updates: ['callback_query', 'message', 'channel_post', 'my_chat_member'] }, 35000)
                    const updates = JSON.parse(r.text || '{}').result || []
                    for (const u of updates) {
                        this.offsets.set(token, u.update_id + 1)
                        const cur = this.wanted.get(token)
                        const channel = cur && notificationStore.channels(cur.orgId).find(c => c.id === cur.channelId)
                        if (channel) await handleTelegramUpdate(cur.orgId, channel, u).catch(() => { })
                    }
                    // never spin: an empty answer is normally a 25 s long-poll
                    if (!updates.length && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 1000))
                } catch (e) {
                    // 409: the bot has a webhook / another poller elsewhere; 401: bad token — try again later, quietly
                    this.backoff.set(token, Date.now() + (/HTTP 401/.test(e.message) ? 10 * 60e3 : /HTTP 409/.test(e.message) ? 2 * 60e3 : 30e3))
                }
            }
        } finally { this.running.delete(token) }
    }
}

export const telegramPoller = new TelegramPoller()
