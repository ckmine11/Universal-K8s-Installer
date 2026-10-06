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
    whatsapp: { label: 'WhatsApp (Twilio)', secret: ['authToken'], plain: ['accountSid', 'from', 'to'] },
    email: { label: 'Email', secret: [], plain: ['to'] },
    webhook: { label: 'Webhook', secret: ['url'], plain: [] }
}

// What can be alerted on, and the default for a new workspace
export const EVENTS = {
    incident: { label: 'New incident (node down, crash loop, pressure…)', default: true },
    incident_resolved: { label: 'Incident cleared', default: true },
    backup_failed: { label: 'etcd backup / offsite upload failed', default: true },
    restore_done: { label: 'etcd restore or recovery finished (success or failure)', default: true },
    upgrade_done: { label: 'Kubernetes upgrade finished (success or failure)', default: true },
    install_failed: { label: 'Cluster install or add-on job failed', default: true },
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
    publicView(orgId) {
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
            history: o.history.slice(0, 50)
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

    saveRules(orgId, rules) {
        const all = this._read()
        const o = this._org(all, orgId)
        const events = {}
        for (const k of Object.keys(EVENTS)) events[k] = rules?.events?.[k] ?? o.rules.events[k]
        const q = rules?.quietHours || o.rules.quietHours
        const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
        o.rules = {
            events,
            quietHours: {
                enabled: !!q.enabled,
                start: hhmm.test(q.start) ? q.start : '22:00',
                end: hhmm.test(q.end) ? q.end : '07:00',
                timezone: (() => { try { new Intl.DateTimeFormat('en', { timeZone: q.timezone }); return q.timezone } catch { return 'Asia/Kolkata' } })()
            },
            cooldownMinutes: Math.max(0, Math.min(1440, parseInt(rules?.cooldownMinutes ?? o.rules.cooldownMinutes, 10) || 0))
        }
        this._write(all)
        return o.rules
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
