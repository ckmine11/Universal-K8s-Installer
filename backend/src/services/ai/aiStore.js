import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'
import { encrypt, decrypt } from '../../utils/cryptoUtils.js'

// AI settings of each workspace: its engines (providers), which engine does
// which task (with fallbacks), safety switches, and the day's usage. API keys
// are stored encrypted and never leave the server.
const FILE = path.join(DATA_DIR, 'ai.json')
const TRACES = path.join(DATA_DIR, 'ai-traces.json')
export const TASKS = { explain: 'Explain failures & incidents', chat: 'Questions & chat', summarize: 'Summaries & reports' }
export const AUTONOMY = ['suggest', 'approve', 'auto']
const DEFAULTS = { enabled: true, providers: [], routes: {}, autonomy: 'approve', actionsEnabled: true, maskEmails: false, maskIps: false, dailyLimit: 50, chatops: {}, costRates: { cpu: 1100, memGb: 250, currency: '₹' } }

let cache = null
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { cache = {} } cache.orgs ||= {}; cache.usage ||= {} } return cache }
const save = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(load(), null, 2)) }
const today = () => new Date().toISOString().slice(0, 10)

let traces = null
const loadTraces = () => { if (!traces) { try { traces = JSON.parse(fs.readFileSync(TRACES, 'utf8')) } catch { traces = {} } } return traces }

export const aiStore = {
    get(orgId) { const o = load().orgs[orgId || '_'] || {}; return { ...DEFAULTS, ...o, providers: o.providers || [], routes: o.routes || {} } },
    save(orgId, patch) { const all = load(); all.orgs[orgId || '_'] = { ...this.get(orgId), ...patch }; save(); return this.get(orgId) },

    /** a provider as the UI sees it: never the key */
    /** ChatOps per alert channel: { enabled, slackSecret (encrypted) } */
    chatops(orgId, channelId) { const c = this.get(orgId).chatops?.[channelId]; return c ? { enabled: !!c.enabled, slackSecret: c.slackSecret ? (() => { try { return decrypt(c.slackSecret) } catch { return null } })() : null } : { enabled: false, slackSecret: null } },
    setChatops(orgId, channelId, { enabled, slackSecret }) {
        const all = { ...(this.get(orgId).chatops || {}) }
        const cur = all[channelId] || {}
        all[channelId] = { ...cur, ...(enabled !== undefined ? { enabled: !!enabled } : {}), ...(slackSecret ? { slackSecret: encrypt(slackSecret) } : {}) }
        if (slackSecret === '') delete all[channelId].slackSecret
        this.save(orgId, { chatops: all })
        return this.chatops(orgId, channelId)
    },

    view(p) { const { key, knownModels, ...rest } = p; return { ...rest, hasKey: !!key } },
    orgIds() { return Object.keys(load().orgs) },
    keyOf(p) { try { return p.key ? decrypt(p.key) : null } catch { return null } },

    addProvider(orgId, input) {
        const s = this.get(orgId)
        if (s.providers.length >= 20) throw Object.assign(new Error('Up to 20 AI engines per workspace'), { status: 400 })
        const p = { id: randomBytes(5).toString('hex'), name: input.name, kind: input.kind, baseUrl: input.baseUrl || null, model: input.model || null, clusterId: input.clusterId || null, preset: input.preset || null, offline: !!input.offline, enabled: input.enabled !== false, createdAt: new Date().toISOString(), ...(input.apiKey ? { key: encrypt(input.apiKey) } : {}) }
        this.save(orgId, { providers: [...s.providers, p] })
        return p
    },
    updateProvider(orgId, id, input) {
        const s = this.get(orgId)
        const i = s.providers.findIndex(p => p.id === id)
        if (i < 0) throw Object.assign(new Error('AI engine not found'), { status: 404 })
        const cur = s.providers[i]
        const next = { ...cur, name: input.name ?? cur.name, baseUrl: input.baseUrl ?? cur.baseUrl, model: input.model ?? cur.model, clusterId: input.clusterId ?? cur.clusterId, enabled: input.enabled ?? cur.enabled }
        if (input.apiKey) next.key = encrypt(input.apiKey)
        if (input.apiKey === '') delete next.key
        s.providers[i] = next
        this.save(orgId, { providers: s.providers })
        return next
    },
    removeProvider(orgId, id) {
        const s = this.get(orgId)
        const routes = Object.fromEntries(Object.entries(s.routes).map(([t, ids]) => [t, (ids || []).filter(x => x !== id)]))
        this.save(orgId, { providers: s.providers.filter(p => p.id !== id), routes })
    },

    // the KubeEZ server model's daily allowance per workspace
    usedToday(orgId) { const u = load().usage[orgId || '_']; return u?.date === today() ? u.count : 0 },
    countUse(orgId) { const all = load(); const u = all.usage[orgId || '_']; all.usage[orgId || '_'] = u?.date === today() ? { date: u.date, count: u.count + 1 } : { date: today(), count: 1 }; save() },

    // the last calls (masked prompts only, never keys), for AI settings → Activity
    addTrace(orgId, t) {
        const all = loadTraces(); const list = all[orgId || '_'] ||= []
        list.unshift(t); if (list.length > 300) list.length = 300
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(TRACES, JSON.stringify(all)) } catch { }
    },
    traces(orgId) { return (loadTraces()[orgId || '_'] || []) },
    saveTraces() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(TRACES, JSON.stringify(loadTraces())) } catch { } },
    _reset() { cache = null; traces = null }
}
