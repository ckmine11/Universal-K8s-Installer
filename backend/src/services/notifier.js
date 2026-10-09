import https from 'https'
import http from 'http'
import dns from 'dns'
import net from 'net'
import { notificationStore, CHANNEL_TYPES } from './notificationStore.js'
import { isPrivateAddress } from '../utils/netGuard.js'
import { getMailer, mailError, mailFrom } from '../utils/mailer.js'

/**
 * Alerts: KubeEZ events → the workspace's channels (Telegram, Slack, Teams,
 * WhatsApp via Twilio, email, webhook). Rules decide which events go out;
 * quiet hours hold back everything but critical ones; a cooldown stops the
 * same alert from repeating. Delivery never throws into the caller, and every
 * failure is reported in words the user can act on.
 */

const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️', success: '✅' }
const SLACK_HOSTS = /^hooks\.slack\.com$/
const TEAMS_HOSTS = /(^|\.)(logic\.azure\.com|powerplatform\.com|powerautomate\.com)$/
const TEXT_MAX = 1500   // per message body — far below every service's limit
const lastSent = new Map()   // `${orgId}|${key}` → time

const publicUrl = () => (process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '')
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const httpError = (status, text, extra = {}) => Object.assign(new Error(`HTTP ${status}: ${String(text).slice(0, 400)}`), { status, body: text, ...extra })
const jsonOf = (s) => { try { return JSON.parse(s) } catch { return null } }

// ── Outbound HTTP (SSRF-safe in SaaS: the address actually connected to is checked) ──
function guardedLookup(hostname, opts, cb) {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
        if (err) return cb(err)
        const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }]
        if (process.env.KUBEEZ_MODE === 'saas' && list.some(a => isPrivateAddress(a.address))) {
            return cb(new Error(`${hostname} points to a private/internal address — not allowed`))
        }
        if (opts?.all) return cb(null, list)
        cb(null, list[0].address, list[0].family)
    })
}

function request(method, url, body, { headers = {}, form = false, auth = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        let u
        try { u = new URL(url) } catch { return reject(new Error('Invalid URL')) }
        if (!['https:', 'http:'].includes(u.protocol)) return reject(new Error('Only http(s) URLs'))
        if (process.env.KUBEEZ_MODE === 'saas' && u.protocol !== 'https:') return reject(new Error('Webhooks must use https'))
        // An IP literal never goes through `lookup` — check it here
        const literal = u.hostname.replace(/^\[|\]$/g, '')
        if (process.env.KUBEEZ_MODE === 'saas' && net.isIP(literal) && isPrivateAddress(literal)) {
            return reject(new Error(`${literal} is a private/internal address — not allowed`))
        }
        const data = body === undefined ? '' : form ? new URLSearchParams(body).toString() : JSON.stringify(body)
        const req = (u.protocol === 'https:' ? https : http).request(u, {
            method,
            lookup: guardedLookup,
            auth: auth || undefined,
            headers: {
                ...(data ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
                'user-agent': 'KubeEZ-Alerts/1', ...headers
            }
        }, (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', c => { if (text.length < 4000) text += c })
            res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve({ status: res.statusCode, text })
                : reject(httpError(res.statusCode, text, { retryAfter: parseInt(res.headers['retry-after'], 10) || null })))
        })
        req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('No answer in time'), { timeout: true })))
        req.on('error', reject)
        req.end(data || undefined)
    })
}

export function postRequest(url, body, opts = {}) { return request('POST', url, body, opts) }

// One retry for "busy" answers: rate limits (429, honouring Retry-After up to
// 20 s), server errors (5xx) and time-outs. Never for 4xx — those need a fix.
async function withRetry(fn) {
    try { return await fn() } catch (e) {
        const wait = e.status === 429 ? Math.min(20, e.retryAfter || jsonOf(e.body)?.parameters?.retry_after || 3) * 1000
            : (e.status >= 500 || e.timeout) ? 1500 : null
        if (wait === null) throw e
        await sleep(wait)
        return fn()
    }
}


/** Validate a channel's settings before saving — user-facing messages. */
export function validateChannel(type, config = {}, isEdit = false) {
    const t = CHANNEL_TYPES[type]
    if (!t) throw new Error('Unknown channel type')
    const need = (k, re, msg, optional = false) => {
        const v = String(config[k] ?? '').trim()
        if (!v && isEdit && t.secret.includes(k)) return   // keep the saved secret
        if (!v && optional) return
        if (!re.test(v)) throw new Error(msg)
    }
    if (type === 'telegram') {
        need('botToken', /^\d{5,}:[\w-]{20,}$/, 'Telegram bot token looks wrong (from @BotFather, like 123456:ABC…)')
        need('chatId', /^(-?\d{3,}|@[\w]{4,})$/, 'Chat ID: a number (e.g. -1001234567890) or @channelname')
        // Bots cannot message bots — a common mix-up is entering the bot itself
        const chat = String(config.chatId || '').trim()
        const botId = String(config.botToken || '').split(':')[0]
        if (/bot$/i.test(chat) || (botId && chat === botId)) {
            throw new Error('Chat ID is the bot itself — Telegram bots cannot message bots. Send /start to your bot (or add it to a group), then use "Find my chat ID".')
        }
    }
    if (type === 'slack') need('webhookUrl', /^https:\/\/hooks\.slack\.com\/services\/[\w/-]+$/, 'Slack webhook URL must start with https://hooks.slack.com/services/…')
    if (type === 'teams') {
        const v = String(config.webhookUrl || '').trim()
        if (v || !isEdit) {
            let host = ''
            try { const u = new URL(v); if (u.protocol === 'https:') host = u.hostname } catch { }
            if (/(^|\.)webhook\.office\.com$/.test(host)) throw new Error('Microsoft retired Office 365 connector webhooks (…webhook.office.com). In the Teams channel use Workflows → "Post to a channel when a webhook request is received" and paste that URL.')
            if (!TEAMS_HOSTS.test(host)) throw new Error('Teams: use the HTTPS URL of a Teams "Workflows" webhook (…logic.azure.com or …powerplatform.com)')
        }
    }
    if (type === 'whatsapp') {
        need('accountSid', /^AC[0-9a-f]{32}$/i, 'Twilio Account SID starts with AC followed by 32 characters')
        need('authToken', /^[0-9a-f]{32}$/i, 'Twilio Auth Token is 32 hexadecimal characters')
        need('from', /^\+\d{8,15}$/, 'From: your Twilio WhatsApp number, e.g. +14155238886')
        need('to', /^\+\d{8,15}$/, 'To: the WhatsApp number to alert, with country code, e.g. +919812345678')
        need('contentSid', /^HX[0-9a-f]{32}$/i, 'Template SID starts with HX followed by 32 characters (Twilio Content Template Builder)', true)
        if (String(config.from || '').trim() && String(config.from).trim() === String(config.to || '').trim()) throw new Error('From and To are the same number — To is the phone that should receive the alerts.')
    }
    if (type === 'email') {
        const list = String(config.to || '').split(',').map(s => s.trim()).filter(Boolean)
        if (!list.length || list.length > 10 || list.some(e => !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(e))) throw new Error('Email: up to 10 addresses, comma-separated')
    }
    if (type === 'webhook') {
        const re = process.env.KUBEEZ_MODE === 'saas' ? /^https:\/\/[^\s]+$/ : /^https?:\/\/[^\s]+$/
        need('url', re, 'Webhook URL must start with https://')
    }
}

// ── Each service's errors in words a user can act on ──
export function telegramError(e) {
    const m = String(e?.message || e)
    const migrated = jsonOf(e?.body)?.parameters?.migrate_to_chat_id
    if (migrated) return `This group was upgraded to a supergroup — its new chat ID is ${migrated}. Edit the channel and use that ID.`
    if (/can't send messages to the bot|bots can't send messages to bots/i.test(m)) return 'The chat ID is a bot — Telegram bots cannot message bots. Use your own chat or a group: send /start to the bot, then "Find my chat ID".'
    if (/bot was blocked by the user/i.test(m)) return 'You blocked this bot in Telegram — open the bot, tap Restart/Unblock, then test again.'
    if (/chat not found/i.test(m)) return 'Chat not found — send /start to the bot (or add it to the group) first, then use "Find my chat ID".'
    if (/have no rights|not enough rights|need administrator rights/i.test(m)) return 'The bot may not post in this chat — make it an admin of the channel/group (with "Post messages").'
    if (/bot was kicked|not a member/i.test(m)) return 'The bot is not in this group/channel any more — add it again.'
    if (/HTTP 401|HTTP 404|Unauthorized/i.test(m)) return 'The bot token is not valid — copy it again from @BotFather.'
    if (/HTTP 409|webhook is active/i.test(m)) return 'This bot has a webhook set elsewhere, so KubeEZ cannot read its chats — enter the chat ID by hand, or remove the webhook.'
    if (/HTTP 429/.test(m)) return 'Telegram is rate-limiting this bot — too many messages; it will work again shortly.'
    return m
}

function slackError(e) {
    const m = String(e?.message || e)
    if (/no_service|no_team|HTTP 404/.test(m)) return 'Slack does not know this webhook any more (removed or the app was uninstalled) — create a new Incoming Webhook and paste its URL.'
    if (/channel_is_archived/.test(m)) return 'The Slack channel of this webhook is archived — unarchive it or create a webhook for another channel.'
    if (/channel_not_found/.test(m)) return 'The Slack channel of this webhook was deleted — create a webhook for another channel.'
    if (/invalid_token|action_prohibited|HTTP 403/.test(m)) return 'Slack refused this webhook (revoked token or a workspace restriction) — create a new Incoming Webhook.'
    if (/HTTP 429/.test(m)) return 'Slack is rate-limiting this webhook — it will work again shortly.'
    return m
}

function teamsError(e) {
    const m = String(e?.message || e)
    const code = jsonOf(e?.body)?.error?.code || ''
    if (/WorkflowNotFound/.test(code) || /HTTP 404/.test(m)) return 'This Teams workflow no longer exists or is turned off — copy the webhook URL again from the workflow (or create it again).'
    if (/WorkflowTriggerIsNotEnabled|WorkflowDisabled/.test(code)) return 'This Teams workflow is turned off — turn it on in the Workflows app in Teams.'
    if (/Signature|InvalidAuthorization|AuthorizationFailed/i.test(code)) return 'The webhook URL is incomplete or wrong (signature part) — copy the whole URL again from the workflow.'
    if (/HTTP 40[13]/.test(m)) return 'Teams refused the request — in the workflow\'s trigger set "Who can trigger the flow" to "Anyone", save, and test again.'
    if (/HTTP 404/.test(m)) return 'This Teams workflow no longer exists or is turned off — turn it on in Power Automate, or create the webhook workflow again.'
    if (/WorkflowTriggerIsNotEnabled|disabled/i.test(m)) return 'This Teams workflow is turned off — turn it on in Power Automate (Workflows app in Teams).'
    if (/HTTP 429/.test(m)) return 'Teams is rate-limiting this workflow — it will work again shortly.'
    return m
}

const TWILIO_CODES = {
    20003: 'Twilio rejected the Account SID / Auth Token — copy both again from the Twilio console.',
    20404: 'Twilio does not know this Account SID — copy it again from the Twilio console.',
    21211: 'The "To" number is not a valid phone number — use the full number with country code, e.g. +919812345678.',
    21408: 'Your Twilio account may not send to this country — enable it under Messaging → Settings → Geo permissions.',
    21606: 'The "From" number is not a WhatsApp sender of your Twilio account — use the sandbox number (+14155238886) or your approved WhatsApp sender.',
    63007: 'The "From" number is not a WhatsApp sender of your Twilio account — use the sandbox number (+14155238886) or your approved WhatsApp sender.',
    63015: 'This phone has not joined your Twilio WhatsApp sandbox — from WhatsApp, send "join <your sandbox code>" to +14155238886, then test again.',
    63016: 'WhatsApp only lets businesses send free text within 24 h of the person\'s last message. Reply to the sandbox/your number to open the window — or, for alerts that always arrive, add an approved Content Template SID (HX…).',
    63018: 'Twilio is rate-limiting this WhatsApp sender — it will work again shortly.',
    63003: 'This phone number cannot receive WhatsApp messages (no WhatsApp account?).',
    63024: 'This phone number cannot receive WhatsApp messages (invalid recipient).',
    63032: 'The person opted out of messages from this sender (sent STOP) — they must send START to receive alerts again.',
    63112: 'Meta disabled this WhatsApp Business account — check it in the Twilio console.'
}
function twilioError(e) {
    const j = jsonOf(e?.body)
    if (j?.code && TWILIO_CODES[j.code]) return TWILIO_CODES[j.code]
    if (/HTTP 401/.test(String(e?.message))) return TWILIO_CODES[20003]
    return j?.message ? `Twilio: ${j.message}${j.code ? ` (error ${j.code})` : ''}` : String(e?.message || e)
}


/** Chats that recently wrote to the bot (or added it) — to pick the chat ID instead of guessing it. */
export async function telegramChats(botToken) {
    if (!/^\d{5,}:[\w-]{20,}$/.test(String(botToken || ''))) throw new Error('Enter the bot token first (from @BotFather)')
    let me, r
    try {
        // getMe: checks the token and gives the bot's @username for the t.me link
        me = jsonOf((await postRequest(`https://api.telegram.org/bot${botToken}/getMe`, {})).text)?.result || {}
        r = await postRequest(`https://api.telegram.org/bot${botToken}/getUpdates`, { limit: 100, allowed_updates: ['message', 'channel_post', 'my_chat_member'] })
    } catch (e) { throw new Error(telegramError(e)) }
    const bot = { username: me.username || null, name: me.first_name || null }
    const chats = new Map()
    for (const u of jsonOf(r.text)?.result || []) {
        const c = (u.message || u.channel_post || u.my_chat_member || u.edited_message)?.chat
        if (!c || chats.has(String(c.id))) continue
        const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id)
        chats.set(String(c.id), { id: String(c.id), name, type: c.type, username: c.username || null })
    }
    return { bot, chats: [...chats.values()] }
}

/** One message, rendered for each channel. */
function render(ev) {
    const icon = ICON[ev.severity] || 'ℹ️'
    // Only an absolute link: Telegram refuses relative ones and Teams cards
    // become invalid. Without KUBEEZ_PUBLIC_URL the message has no link.
    const base = publicUrl()
    const link = ev.link && /^https?:\/\/[^/]/.test(base) ? `${base}${ev.link}` : ''
    let text = String(ev.text || '')
    if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX - 1) + '…'
    const lines = [ev.clusterName ? `Cluster: ${ev.clusterName}` : '', text].filter(Boolean)
    return { icon, link, title: `${icon} ${String(ev.title || '').slice(0, 200)}`, lines }
}

const slackEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

async function sendWhatsApp(c, m) {
    const api = `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}`
    const auth = `${c.accountSid}:${c.authToken}`
    const msg = c.contentSid
        // An approved template reaches the phone at any time (outside the 24 h window)
        ? { From: `whatsapp:${c.from}`, To: `whatsapp:${c.to}`, ContentSid: c.contentSid,
            ContentVariables: JSON.stringify({ 1: m.title, 2: m.lines.join(' · ') || '-', 3: m.link || publicUrl() || '-' }) }
        : { From: `whatsapp:${c.from}`, To: `whatsapp:${c.to}`, Body: [m.title, ...m.lines, m.link].filter(Boolean).join('\n') }
    let created
    try { created = jsonOf((await withRetry(() => postRequest(`${api}/Messages.json`, msg, { form: true, auth }))).text) }
    catch (e) { throw new Error(twilioError(e)) }
    // Twilio accepts first and fails later (sandbox not joined, 24 h window…):
    // follow the message for a few seconds so "delivered" means delivered.
    if (!created?.sid) return
    for (let i = 0; i < 5; i++) {
        await sleep(1500)
        let s
        try { s = jsonOf((await request('GET', `${api}/Messages/${created.sid}.json`, undefined, { auth })).text) } catch { return }
        if (['failed', 'undelivered'].includes(s?.status)) {
            throw new Error(TWILIO_CODES[s.error_code] || `WhatsApp message ${s.status}${s.error_code ? ` (Twilio error ${s.error_code})` : ''}${s.error_message ? ': ' + s.error_message : ''}`)
        }
        if (['sent', 'delivered', 'read'].includes(s?.status)) return
    }
}

async function sendTelegram(c, m) {
    const url = `https://api.telegram.org/bot${c.botToken}/sendMessage`
    const html = [`<b>${esc(m.title)}</b>`, ...m.lines.map(esc), m.link ? `<a href="${esc(m.link)}">Open in KubeEZ</a>` : ''].filter(Boolean).join('\n')
    try {
        return await withRetry(() => postRequest(url, { chat_id: c.chatId, parse_mode: 'HTML', disable_web_page_preview: true, text: html }))
    } catch (e) {
        // Formatting or a link Telegram dislikes: send it as plain text instead
        if (e.status === 400 && /can't parse entities|wrong http url|unsupported url|wrong url/i.test(String(e.body))) {
            try {
                return await postRequest(url, { chat_id: c.chatId, disable_web_page_preview: true, text: [m.title, ...m.lines, m.link].filter(Boolean).join('\n') })
            } catch (e2) { throw new Error(telegramError(e2)) }
        }
        throw new Error(telegramError(e))
    }
}

async function deliver(ch, ev) {
    const m = render(ev)
    const c = ch.config
    switch (ch.type) {
        case 'telegram':
            return sendTelegram(c, m)
        case 'slack': {
            if (!SLACK_HOSTS.test(new URL(c.webhookUrl).hostname)) throw new Error('Not a Slack webhook URL')
            const text = [`*${slackEsc(m.title)}*`, ...m.lines.map(slackEsc), m.link ? `<${m.link}|Open in KubeEZ>` : ''].filter(Boolean).join('\n')
            return withRetry(() => postRequest(c.webhookUrl, { text })).catch(e => { throw new Error(slackError(e)) })
        }
        case 'teams': {
            if (!TEAMS_HOSTS.test(new URL(c.webhookUrl).hostname)) throw new Error('Not a Teams Workflows webhook URL — Office 365 connector webhooks were retired; create a Workflows webhook')
            // Teams Workflows webhooks take an Adaptive Card
            const body = [{ type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
                ...m.lines.map(t => ({ type: 'TextBlock', text: t, wrap: true }))]
            return withRetry(() => postRequest(c.webhookUrl, {
                type: 'message',
                attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body,
                    ...(m.link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in KubeEZ', url: m.link }] } : {})
                } }]
            })).catch(e => { throw new Error(teamsError(e)) })
        }
        case 'whatsapp':
            return sendWhatsApp(c, m)
        case 'email':
            return getMailer().sendMail({
                from: mailFrom(),
                to: c.to,
                subject: `[KubeEZ] ${String(ev.title || '').slice(0, 150)}${ev.clusterName ? ` — ${ev.clusterName}` : ''}`,
                text: [m.title, '', ...m.lines, m.link ? `\n${m.link}` : ''].join('\n'),
                html: `<h3 style="margin:0 0 8px">${esc(m.title)}</h3>${m.lines.map(l => `<p style="margin:4px 0">${esc(l)}</p>`).join('')}${m.link ? `<p><a href="${esc(m.link)}">Open in KubeEZ</a></p>` : ''}`
            }).catch(e => { throw new Error(mailError(e)) })
        case 'webhook':
            return withRetry(() => postRequest(c.url, { source: 'kubeez', type: ev.type, severity: ev.severity, title: ev.title, text: ev.text || '', cluster: ev.clusterName || null, clusterId: ev.clusterId || null, link: m.link || null, at: new Date().toISOString() }))
        default:
            throw new Error('Unknown channel type')
    }
}

function inQuietHours(q, now = new Date()) {
    if (!q?.enabled) return false
    let hm
    try { hm = new Intl.DateTimeFormat('en-GB', { timeZone: q.timezone || 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(now) }
    catch { return false }   // a broken time zone must never swallow alerts
    const cur = hm.replace(/^24/, '00')
    return q.start <= q.end ? (cur >= q.start && cur < q.end) : (cur >= q.start || cur < q.end)
}

class Notifier {
    /**
     * ev: { type, severity, title, text?, clusterId?, clusterName?, link?, key? }
     * key: what makes two alerts "the same" for the cooldown (default type+cluster+title)
     */
    async notify(orgId, ev, { now = new Date() } = {}) {
        try {
            if (!orgId) return { sent: 0, reason: 'no workspace' }
            const rules = notificationStore.rules(orgId)
            if (rules.events[ev.type] === false) return { sent: 0, reason: 'event turned off' }
            if (ev.severity !== 'critical' && inQuietHours(rules.quietHours, now)) {
                notificationStore.record(orgId, { ...pick(ev), outcome: 'quiet hours' })
                return { sent: 0, reason: 'quiet hours' }
            }
            const key = `${orgId}|${ev.key || `${ev.type}|${ev.clusterId || ''}|${ev.title}`}`
            const cool = (rules.cooldownMinutes || 0) * 60000
            if (cool && now - (lastSent.get(key) || 0) < cool) return { sent: 0, reason: 'cooldown' }
            const channels = notificationStore.channels(orgId).filter(c => c.enabled !== false)
            if (!channels.length) return { sent: 0, reason: 'no channels' }
            lastSent.set(key, +now)
            if (lastSent.size > 5000) for (const [k, t] of lastSent) if (+now - t > 86400000) lastSent.delete(k)
            const results = {}
            await Promise.all(channels.map(async ch => {
                try { await deliver(ch, ev); results[ch.id] = { ok: true } } catch (e) { results[ch.id] = { ok: false, error: String(e.message).slice(0, 300) } }
            }))
            const okCount = Object.values(results).filter(r => r.ok).length
            // nothing got through: don't hold the next attempt back
            if (!okCount) lastSent.delete(key)
            notificationStore.record(orgId, { ...pick(ev), outcome: `${okCount}/${channels.length} delivered`, failures: Object.entries(results).filter(([, r]) => !r.ok).map(([id, r]) => ({ id, error: r.error })) }, results)
            return { sent: okCount, results }
        } catch (e) {
            console.error('[Alerts] notify failed:', e.message)
            return { sent: 0, reason: e.message }
        }
    }

    /** Fire-and-forget form for event hooks */
    emit(orgId, ev) { this.notify(orgId, ev).catch(() => { }) }

    async test(orgId, channelId) {
        const ch = notificationStore.channels(orgId).find(c => c.id === channelId)
        if (!ch) throw Object.assign(new Error('Channel not found'), { status: 404 })
        const ev = { type: 'test', severity: 'info', title: 'Test alert from KubeEZ', text: `If you can read this, "${ch.name}" works.`, link: '/settings' }
        try {
            await deliver(ch, ev)
            notificationStore.record(orgId, { ...pick(ev), outcome: `test → ${ch.name}: delivered` }, { [ch.id]: { ok: true } })
            return { ok: true }
        } catch (e) {
            notificationStore.record(orgId, { ...pick(ev), outcome: `test → ${ch.name}: failed` }, { [ch.id]: { ok: false, error: e.message } })
            return { ok: false, error: e.message }
        }
    }
}
const pick = (ev) => ({ type: ev.type, severity: ev.severity, title: ev.title, clusterName: ev.clusterName || null })

export const notifier = new Notifier()
export { inQuietHours, render, deliver as _deliver, TWILIO_CODES }
