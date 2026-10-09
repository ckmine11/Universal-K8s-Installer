import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// Alert channels + rules, one record per workspace (orgId). Secrets inside a
// channel (bot tokens, webhook URLs, auth tokens) are stored encrypted and are
// never sent back to the browser.
const FILE = path.join(DATA_DIR, 'notifications.json')
const HISTORY_MAX = 100

export const CHANNEL_TYPES = {
    telegram: { label: 'Telegram', secret: ['botToken'], plain: ['chatId'] },
    slack: { label: 'Slack', secret: ['webhookUrl'], plain: [] },
    teams: { label: 'Microsoft Teams', secret: ['webhookUrl'], plain: [] },
    whatsapp: { label: 'WhatsApp (Twilio)', secret: ['authToken'], plain: ['accountSid', 'from', 'to', 'contentSid'] },
    email: { label: 'Email', secret: [], plain: ['to'] },
    webhook: { label: 'Webhook', secret: ['url'], plain: [] }
}

// What can be alerted on, and the default for a new workspace
export const EVENTS = {
    incident: { label: 'New incident (nodes, control plane, pods, workloads, storage, certificates)', default: true },
    incident_resolved: { label: 'Incident cleared', default: true },
    backup_failed: { label: 'etcd backup / offsite upload failed', default: true },
    restore_done: { label: 'etcd restore or recovery finished (success or failure)', default: true },
    upgrade_done: { label: 'Kubernetes upgrade finished (success or failure)', default: true },
    job_done: { label: 'Cluster ready, nodes added, add-on installed / removed', default: true },
    install_failed: { label: 'Cluster install, scale or add-on job failed', default: true },
    agent_offline: { label: 'Gateway Agent offline for 5 minutes / back online', default: true }
}

export const DEFAULT_RULES = {
    events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.default])),
    quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' },
    cooldownMinutes: 15
}

class NotificationStore {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
    _write(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2)) }
    _org(all, orgId) {
        if (!all[orgId]) all[orgId] = { channels: [], rules: structuredClone(DEFAULT_RULES), history: [] }
        all[orgId].rules = { ...structuredClone(DEFAULT_RULES), ...all[orgId].rules, events: { ...DEFAULT_RULES.events, ...(all[orgId].rules?.events || {}) } }
        return all[orgId]
    }

    /** Channels with decrypted secrets — backend use only. */
    channels(orgId) {
        const o = this._read()[orgId]
        return (o?.channels || []).map(c => ({ ...c, config: this._decryptConfig(c.type, c.config) }))
    }

    rules(orgId) { return this._org(this._read(), orgId).rules }

    /** Safe view for the UI: secrets replaced by a hint. */
    publicView(orgId, historyMax = 50) {
        const all = this._read()
        const o = this._org(all, orgId)
        return {
            channels: o.channels.map(c => {
                const t = CHANNEL_TYPES[c.type] || { secret: [], plain: [] }
                const cfg = {}
                for (const k of t.plain) cfg[k] = c.config?.[k] ?? ''
                for (const k of t.secret) cfg[k] = c.config?.[k] ? '••••••' + this._tail(c.type, k, c.config[k]) : ''
                return { id: c.id, type: c.type, name: c.name, enabled: c.enabled !== false, config: cfg, createdAt: c.createdAt, lastResult: c.lastResult || null }
            }),
            rules: o.rules,
            history: o.history.slice(0, historyMax)
        }
    }

    _tail(type, key, enc) { try { return decrypt(enc).slice(-4) } catch { return '' } }

    _decryptConfig(type, cfg = {}) {
        const out = { ...cfg }
        for (const k of CHANNEL_TYPES[type]?.secret || []) if (out[k]) { try { out[k] = decrypt(out[k]) } catch { out[k] = '' } }
        return out
    }

    _encryptConfig(type, cfg, previous = {}) {
        const t = CHANNEL_TYPES[type]
        const out = {}
        for (const k of t.plain) out[k] = String(cfg[k] ?? '').trim()
        // blank secret on edit = keep the saved one
        for (const k of t.secret) out[k] = cfg[k] ? encrypt(String(cfg[k]).trim()) : (previous[k] || '')
        return out
    }

    saveChannel(orgId, { id, type, name, enabled = true, config }) {
        const all = this._read()
        const o = this._org(all, orgId)
        const prev = id ? o.channels.find(c => c.id === id) : null
        if (id && !prev) throw Object.assign(new Error('Channel not found'), { status: 404 })
        const ch = {
            id: prev?.id || crypto.randomUUID(),
            type: prev?.type || type,
            name: String(name || CHANNEL_TYPES[type]?.label || type).slice(0, 60),
            enabled: !!enabled,
            config: this._encryptConfig(prev?.type || type, config || {}, prev?.config),
            createdAt: prev?.createdAt || new Date().toISOString(),
            lastResult: prev?.lastResult || null
        }
        o.channels = prev ? o.channels.map(c => c.id === ch.id ? ch : c) : [...o.channels, ch]
        this._write(all)
        return ch.id
    }

    deleteChannel(orgId, id) {
        const all = this._read()
        const o = this._org(all, orgId)
        o.channels = o.channels.filter(c => c.id !== id)
        this._write(all)
    }

    /** Save alert rules. Wrong input is refused with the reason (never silently replaced). */
    saveRules(orgId, rules) {
        const bad = (msg) => Object.assign(new Error(msg), { status: 400 })
        const all = this._read()
        const o = this._org(all, orgId)
        const events = {}
        for (const k of Object.keys(EVENTS)) {
            const v = rules?.events?.[k]
            events[k] = v === undefined ? o.rules.events[k] : v === true || v === 'true'
        }
        const q = { ...o.rules.quietHours, ...(rules?.quietHours || {}) }
        const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
        if (!hhmm.test(q.start) || !hhmm.test(q.end)) throw bad('Quiet hours: use times like 22:00 and 07:00')
        let tz
        try { tz = new Intl.DateTimeFormat('en', { timeZone: String(q.timezone || '') }).resolvedOptions().timeZone } catch { throw bad(`Unknown time zone "${q.timezone}" — pick one from the list`) }
        if (q.enabled && q.start === q.end) throw bad('Quiet hours: start and end are the same time — they would never apply')
        const raw = rules?.cooldownMinutes ?? o.rules.cooldownMinutes
        const cd = Number(raw)
        if (raw === '' || !Number.isFinite(cd) || cd < 0 || cd > 1440) throw bad('Cooldown: 0 to 1440 minutes')
        o.rules = { events, quietHours: { enabled: !!q.enabled, start: q.start, end: q.end, timezone: tz }, cooldownMinutes: Math.round(cd) }
        this._write(all)
        return o.rules
    }

    // Alerts held back during quiet hours, sent as one summary when they end
    hold(orgId, entry) {
        const all = this._read(); const o = this._org(all, orgId)
        o.held = [...(o.held || []), { ...entry, at: new Date().toISOString() }].slice(-50)
        this._write(all)
    }
    takeHeld(orgId) {
        const all = this._read(); const o = all[orgId]
        if (!o?.held?.length) return []
        const held = o.held; o.held = []
        this._write(all); return held
    }
    heldOrgs() { return Object.entries(this._read()).filter(([, o]) => o?.held?.length).map(([id]) => id) }

    /**
     * Daily allowance of alert emails per workspace (UTC day). Returns true and
     * counts one when there is room, false when today's allowance is used up.
     */
    takeEmail(orgId, limit) {
        const all = this._read(); const o = this._org(all, orgId)
        const day = new Date().toISOString().slice(0, 10)
        if (o.emailDay?.day !== day) o.emailDay = { day, n: 0 }
        if (o.emailDay.n >= limit) return false
        o.emailDay.n++
        this._write(all); return true
    }
    emailsToday(orgId) {
        const o = this._read()[orgId]
        return o?.emailDay?.day === new Date().toISOString().slice(0, 10) ? o.emailDay.n : 0
    }

    record(orgId, entry, channelResults = {}) {
        const all = this._read()
        const o = this._org(all, orgId)
        o.history.unshift({ ...entry, at: new Date().toISOString() })
        o.history = o.history.slice(0, HISTORY_MAX)
        for (const c of o.channels) if (channelResults[c.id]) c.lastResult = { ...channelResults[c.id], at: new Date().toISOString() }
        this._write(all)
    }
}

export const notificationStore = new NotificationStore()
