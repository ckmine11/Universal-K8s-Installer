import https from 'https'
import http from 'http'
import dns from 'dns'
import net from 'net'
import nodemailer from 'nodemailer'
import { notificationStore, CHANNEL_TYPES } from './notificationStore.js'
import { isPrivateAddress } from '../utils/netGuard.js'

/**
 * Alerts: KubeEZ events → the workspace's channels (Telegram, Slack, Teams,
 * WhatsApp via Twilio, email, webhook). Rules decide which events go out;
 * quiet hours hold back everything but critical ones; a cooldown stops the
 * same alert from repeating. Delivery never throws into the caller.
 */

const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️', success: '✅' }
const SLACK_HOSTS = /^hooks\.slack\.com$/
const TEAMS_HOSTS = /(^|\.)(logic\.azure\.com|powerplatform\.com|powerautomate\.com|webhook\.office\.com)$/
const lastSent = new Map()   // `${orgId}|${key}` → time

const publicUrl = () => (process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '')
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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

export function postRequest(url, body, { headers = {}, form = false, auth = null, timeoutMs = 15000 } = {}) {
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
        const data = form ? new URLSearchParams(body).toString() : JSON.stringify(body)
        const req = (u.protocol === 'https:' ? https : http).request(u, {
            method: 'POST',
            lookup: guardedLookup,
            auth: auth || undefined,
            headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': Buffer.byteLength(data), 'user-agent': 'KubeEZ-Alerts/1', ...headers }
        }, (res) => {
            let text = ''
            res.on('data', c => { if (text.length < 2000) text += c })
            res.on('end', () => res.statusCode < 300 ? resolve({ status: res.statusCode, text })
                : reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)))
        })
        req.setTimeout(timeoutMs, () => req.destroy(new Error('No answer in time')))
        req.on('error', reject)
        req.end(data)
    })
}

let mailer = null
function getMailer() {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error('Email alerts need the server\'s SMTP settings (SMTP_HOST, SMTP_USER, SMTP_PASS)')
    if (!mailer) mailer = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT, 10) || 465,
        secure: (parseInt(process.env.SMTP_PORT, 10) || 465) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
    return mailer
}

/** Validate a channel's settings before saving — user-facing messages. */
export function validateChannel(type, config = {}, isEdit = false) {
    const t = CHANNEL_TYPES[type]
    if (!t) throw new Error('Unknown channel type')
    const need = (k, re, msg) => {
        const v = String(config[k] ?? '').trim()
        if (!v && isEdit && t.secret.includes(k)) return   // keep the saved secret
        if (!re.test(v)) throw new Error(msg)
    }
    if (type === 'telegram') {
        need('botToken', /^\d{5,}:[\w-]{20,}$/, 'Telegram bot token looks wrong (from @BotFather, like 123456:ABC…)')
        need('chatId', /^(-?\d{3,}|@[\w]{4,})$/, 'Chat ID: a number (e.g. -1001234567890) or @channelname')
    }
    if (type === 'slack') need('webhookUrl', /^https:\/\/hooks\.slack\.com\/[\w/-]+$/, 'Slack webhook URL must start with https://hooks.slack.com/')
    if (type === 'teams') {
        const v = String(config.webhookUrl || '').trim()
        if (v || !isEdit) {
            let host = ''
            try { const u = new URL(v); if (u.protocol === 'https:') host = u.hostname } catch { }
            if (!TEAMS_HOSTS.test(host)) throw new Error('Teams: use the HTTPS URL of a Teams "Workflows" webhook (…logic.azure.com or …powerplatform.com)')
        }
    }
    if (type === 'whatsapp') {
        need('accountSid', /^AC[0-9a-f]{32}$/i, 'Twilio Account SID starts with AC followed by 32 characters')
        need('authToken', /^[0-9a-f]{32}$/i, 'Twilio Auth Token is 32 hexadecimal characters')
        need('from', /^\+\d{8,15}$/, 'From: your Twilio WhatsApp number, e.g. +14155238886')
        need('to', /^\+\d{8,15}$/, 'To: the WhatsApp number to alert, with country code, e.g. +919812345678')
    }
    if (type === 'email') {
        const list = String(config.to || '').split(',').map(s => s.trim()).filter(Boolean)
        if (!list.length || list.length > 10 || list.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error('Email: up to 10 addresses, comma-separated')
    }
    if (type === 'webhook') need('url', /^https?:\/\/[^\s]+$/, 'Webhook URL must start with https://')
}

/** One message, rendered for each channel. */
function render(ev) {
    const icon = ICON[ev.severity] || 'ℹ️'
    const link = ev.link ? `${publicUrl()}${ev.link}` : ''
    const lines = [ev.clusterName ? `Cluster: ${ev.clusterName}` : '', ev.text || ''].filter(Boolean)
    return { icon, link, title: `${icon} ${ev.title}`, lines }
}

async function deliver(ch, ev) {
    const m = render(ev)
    const c = ch.config
    switch (ch.type) {
        case 'telegram':
            return postRequest(`https://api.telegram.org/bot${c.botToken}/sendMessage`, {
                chat_id: c.chatId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: [`<b>${esc(m.title)}</b>`, ...m.lines.map(esc), m.link ? `<a href="${esc(m.link)}">Open in KubeEZ</a>` : ''].filter(Boolean).join('\n')
            })
        case 'slack': {
            const u = new URL(c.webhookUrl)
            if (!SLACK_HOSTS.test(u.hostname)) throw new Error('Not a Slack webhook URL')
            return postRequest(c.webhookUrl, { text: [`*${m.title}*`, ...m.lines, m.link ? `<${m.link}|Open in KubeEZ>` : ''].filter(Boolean).join('\n') })
        }
        case 'teams': {
            if (!TEAMS_HOSTS.test(new URL(c.webhookUrl).hostname)) throw new Error('Not a Teams Workflows webhook URL')
            // Teams Workflows webhooks take an Adaptive Card
            const body = [{ type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true },
                ...m.lines.map(t => ({ type: 'TextBlock', text: t, wrap: true }))]
            return postRequest(c.webhookUrl, {
                type: 'message',
                attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body,
                    actions: m.link ? [{ type: 'Action.OpenUrl', title: 'Open in KubeEZ', url: m.link }] : []
                } }]
            })
        }
        case 'whatsapp':
            return postRequest(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
                From: `whatsapp:${c.from}`, To: `whatsapp:${c.to}`,
                Body: [m.title, ...m.lines, m.link].filter(Boolean).join('\n')
            }, { form: true, auth: `${c.accountSid}:${c.authToken}` })
        case 'email':
            return getMailer().sendMail({
                from: process.env.EMAIL_FROM || process.env.SMTP_USER,
                to: c.to,
                subject: `[KubeEZ] ${ev.title}${ev.clusterName ? ` — ${ev.clusterName}` : ''}`,
                text: [m.title, '', ...m.lines, '', m.link].filter(s => s !== undefined).join('\n'),
                html: `<h3 style="margin:0 0 8px">${esc(m.title)}</h3>${m.lines.map(l => `<p style="margin:4px 0">${esc(l)}</p>`).join('')}${m.link ? `<p><a href="${esc(m.link)}">Open in KubeEZ</a></p>` : ''}`
            })
        case 'webhook':
            return postRequest(c.url, { source: 'kubeez', type: ev.type, severity: ev.severity, title: ev.title, text: ev.text || '', cluster: ev.clusterName || null, clusterId: ev.clusterId || null, link: m.link || null, at: new Date().toISOString() })
        default:
            throw new Error('Unknown channel type')
    }
}

function inQuietHours(q, now = new Date()) {
    if (!q?.enabled) return false
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: q.timezone || 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
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
            const results = {}
            await Promise.all(channels.map(async ch => {
                try { await deliver(ch, ev); results[ch.id] = { ok: true } } catch (e) { results[ch.id] = { ok: false, error: String(e.message).slice(0, 200) } }
            }))
            const okCount = Object.values(results).filter(r => r.ok).length
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
export { inQuietHours, render }
