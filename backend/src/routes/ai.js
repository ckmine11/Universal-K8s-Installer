import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { aiStore, TASKS, AUTONOMY } from '../services/ai/aiStore.js'
import { KINDS, health, pullModel, serverModel, serverModelState, checkViaClusterUrl } from '../services/ai/providers.js'
import { checkProviderUrl } from '../services/ai/http.js'
import { ask, routeFor, breakerState, queueState, serverAvailable, AiUnavailable } from '../services/ai/engine.js'
import { canSeeCluster } from '../services/accessControl.js'
import { clusterStore } from '../services/clusterStore.js'
import { auditLog } from '../services/auditLog.js'
import { latestByEngine, feedbackStats } from '../services/ai/quality.js'
import { notificationStore } from '../services/notificationStore.js'
import { PRESETS, presetOf, legacyPreset } from '../config/aiPresets.js'
import { discover, modelsOf, newCount, OLLAMA_SUGGESTIONS } from '../services/ai/modelCatalog.js'
import { startExam, isRunning } from '../services/ai/quality.js'
import { startSignIn, finishSignIn, openRouterApi } from '../services/ai/openrouterAuth.js'

// KubeEZ AI: engines (providers), routing per task, safety switches, a test
// box and the activity log. Mounted at /api/ai behind requireAuth.
const router = express.Router()
const fail = (res, e) => res.status(e.status || (e.code === 'BAD_URL' ? 400 : 500)).json({ error: e.message, code: e.code, attempts: e.attempts })
const bad = (m) => Object.assign(new Error(m), { status: 400 })
const SERVER = () => serverAvailable() ? { id: 'server', name: 'KubeEZ server model', kind: 'server', model: serverModel().model, builtin: true, enabled: true, state: { ...serverModelState } } : null
const pulls = new Map()   // `${org}:${provider}` → { model, status, error, at }

export function cleanProvider(input, orgClusterIds, partial = false) {
    const out = {}
    if (!partial || input.name !== undefined) {
        out.name = String(input.name || '').trim().slice(0, 60)
        if (out.name.length < 2) throw bad('Give the engine a name')
    }
    // a preset ("LM Studio", "OpenRouter"…) decides the engine type, and whether a key is needed
    const preset = input.preset ? presetOf(input.preset) : null
    if (input.preset && !preset) throw bad('Unknown engine')
    if (!partial) {
        const k = preset ? preset.kind : input.kind
        if (!KINDS[k] || k === 'server') throw bad('Unknown engine type')
        out.kind = k
        if (preset) { out.preset = preset.id; out.offline = preset.group === 'offline' }
        else if (['ollama', 'cluster'].includes(k)) out.offline = true
    }
    const kind = out.kind || input.kind
    const needsKey = preset ? !!preset.needsKey : KINDS[kind]?.needsKey
    // reached through one of the workspace's clusters: a model on the user's own network
    const via = input.viaClusterId !== undefined ? (input.viaClusterId || null) : (partial ? input._viaClusterId || null : null)
    if (via) {
        const offline = preset ? preset.group === 'offline' : partial ? !!input._offline : kind === 'ollama'
        if (!offline || !['openai', 'ollama'].includes(kind)) throw bad('Only a model on your own network can be reached through a cluster')
        if (!orgClusterIds.includes(via)) throw bad('Pick one of your clusters')
    }
    if (input.viaClusterId !== undefined) out.viaClusterId = via
    const url = input.baseUrl || (partial && input.viaClusterId !== undefined ? input._baseUrl : '')
    if (url) via ? checkViaClusterUrl(url) : checkProviderUrl(url)
    if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl !== '') out.baseUrl = String(input.baseUrl).trim().replace(/\/+$/, '')
    if (!partial && KINDS[kind]?.needsUrl && !out.baseUrl) throw bad('This engine needs its address')
    if (input.model !== undefined) {
        const m = String(input.model || '').trim()
        if (m && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,120}$/.test(m)) throw bad('Model name: letters, numbers and . _ : / @ -')
        out.model = m || null
    }
    if (!partial && !out.model && kind !== 'cluster') throw bad('Which model? (e.g. qwen2.5:3b, gpt-4.1-mini, gemini-2.5-flash, claude-opus-5)')
    if (input.clusterId !== undefined) {
        if (kind === 'cluster' || input.clusterId) {
            if (!orgClusterIds.includes(input.clusterId)) throw bad('Pick one of your clusters')
            out.clusterId = input.clusterId
        }
    }
    if (!partial && kind === 'cluster' && !out.clusterId) throw bad('Pick the cluster where the KubeEZ AI add-on runs')
    if (input.apiKey !== undefined) {
        const k = String(input.apiKey || '').trim()
        if (k.length > 500) throw bad('That API key is too long')
        out.apiKey = k
    }
    if (!partial && needsKey && !out.apiKey) throw bad('This engine needs an API key')
    if (input.enabled !== undefined) out.enabled = !!input.enabled
    return out
}

const orgClusters = async (req) => (await clusterStore.getClusters().catch(() => [])).filter(c => c.orgId === req.user.orgId)

// Everything AI settings shows
router.get('/', requirePermission('ai:use'), async (req, res) => {
    const s = aiStore.get(req.user.orgId)
    const server = SERVER()
    const latest = latestByEngine(req.user.orgId), fb = feedbackStats(req.user.orgId)
    const raw = Object.fromEntries(s.providers.map(p => [p.id, p]))
    const clusterNames = Object.fromEntries((await orgClusters(req)).map(c => [c.id, c.clusterName]))
    const engines = [...s.providers.map(p => aiStore.view(p)), ...(server ? [server] : [])].map(p => {
        const q = latest[p.id]
        return {
            ...p, preset: p.preset || legacyPreset(p.kind), viaClusterName: p.viaClusterId ? (clusterNames[p.viaClusterId] || 'a removed cluster') : null, newModels: raw[p.id] ? newCount(raw[p.id]) : 0,
            qualityRunning: isRunning(req.user.orgId), breaker: breakerState(req.user.orgId, p), queue: queueState(req.user.orgId, p), pull: pulls.get(`${req.user.orgId}:${p.id}`) || null,
            // the last quality test — and whether the model changed since (then it is untested)
            quality: q ? { score: q.summary.score, at: q.finishedAt, stale: (q.engineModel || null) !== (p.model || null) } : null,
            feedback: fb[p.id] || null
        }
    })
    res.json({
        enabled: s.enabled, autonomy: s.autonomy, actionsEnabled: s.actionsEnabled, maskEmails: s.maskEmails, maskIps: s.maskIps,
        dailyLimit: s.dailyLimit, usedToday: aiStore.usedToday(req.user.orgId), costRates: s.costRates,
        engines, routes: s.routes, effectiveRoutes: Object.fromEntries(Object.keys(TASKS).map(t => [t, routeFor(req.user.orgId, t).map(p => p.id)])),
        tasks: TASKS, kinds: KINDS, presets: PRESETS, ollamaSuggestions: OLLAMA_SUGGESTIONS, saas: process.env.KUBEEZ_MODE === 'saas', autonomyLevels: AUTONOMY, server: server ? { model: server.model } : null,
        clusters: (await orgClusters(req)).filter(c => canSeeCluster(req.user, c)).map(c => ({ id: c.id, name: c.clusterName, hasAi: !!c.addons?.['kubeez-ai'] })),
        chatops: chatopsChannels(req.user.orgId)
    })
})

// ChatOps: the workspace's Telegram and Slack alert channels, and whether people may ask KubeEZ there
const publicUrl = () => (process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '')
function chatopsChannels(orgId) {
    return notificationStore.channels(orgId).filter(c => ['telegram', 'slack'].includes(c.type)).map(c => {
        const cfg = aiStore.chatops(orgId, c.id)
        return {
            id: c.id, type: c.type, name: c.name, enabled: cfg.enabled, hasSecret: !!cfg.slackSecret,
            slashUrl: c.type === 'slack' && /^https:\/\//.test(publicUrl()) ? `${publicUrl()}/api/chatops/slack/${c.id}` : null
        }
    })
}
router.put('/chatops/:channelId', requirePermission('ai:manage'), (req, res) => {
    try {
        const ch = notificationStore.channels(req.user.orgId).find(c => c.id === req.params.channelId && ['telegram', 'slack'].includes(c.type))
        if (!ch) return res.status(404).json({ error: 'Telegram or Slack channel not found' })
        const b = req.body || {}
        const secret = b.slackSigningSecret === undefined ? undefined : String(b.slackSigningSecret).trim()
        if (secret && !/^[a-f0-9]{32}$/i.test(secret)) throw bad('The Slack signing secret is 32 letters and numbers (Slack app → Basic Information → App Credentials)')
        if (ch.type === 'slack' && b.enabled && !secret && !aiStore.chatops(req.user.orgId, ch.id).slackSecret) throw bad('Slack needs the app\'s signing secret first')
        aiStore.setChatops(req.user.orgId, ch.id, { enabled: b.enabled, slackSecret: secret })
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.chatops', detail: `ChatOps ${b.enabled ? 'on' : b.enabled === false ? 'off' : 'changed'} for ${ch.name} (${ch.type})` })
        res.json(chatopsChannels(req.user.orgId).find(c => c.id === ch.id))
    } catch (e) { fail(res, e) }
})

router.put('/settings', requirePermission('ai:manage'), (req, res) => {
    try {
        const b = req.body || {}
        const s = aiStore.get(req.user.orgId)
        const patch = {}
        if (b.enabled !== undefined) patch.enabled = !!b.enabled
        if (b.actionsEnabled !== undefined) patch.actionsEnabled = !!b.actionsEnabled
        if (b.maskEmails !== undefined) patch.maskEmails = !!b.maskEmails
        if (b.maskIps !== undefined) patch.maskIps = !!b.maskIps
        if (b.autonomy !== undefined) { if (!AUTONOMY.includes(b.autonomy)) throw bad('Autonomy: suggest, approve or auto'); patch.autonomy = b.autonomy }
        if (b.dailyLimit !== undefined) { const n = Number(b.dailyLimit); if (!Number.isInteger(n) || n < 0 || n > 10000) throw bad('Daily limit: 0 – 10000'); patch.dailyLimit = n }
        if (b.costRates !== undefined) {
            const r = b.costRates || {}
            const n = (v, label) => { const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 1e6) throw bad(`${label}: a number from 0`); return x }
            if (!['₹', '$', '€', '£'].includes(r.currency)) throw bad('Currency: ₹, $, € or £')
            patch.costRates = { cpu: n(r.cpu, 'Price per CPU core a month'), memGb: n(r.memGb, 'Price per GiB of memory a month'), currency: r.currency }
        }
        if (b.routes !== undefined) {
            const ids = new Set([...s.providers.map(p => p.id), 'server'])
            const routes = {}
            for (const [task, list] of Object.entries(b.routes || {})) {
                if (!TASKS[task] && task !== 'default') continue
                if (!Array.isArray(list) || list.length > 10 || list.some(id => !ids.has(id))) throw bad(`Route for ${task}: pick engines from your list`)
                routes[task] = [...new Set(list)]
            }
            patch.routes = routes
        }
        const out = aiStore.save(req.user.orgId, patch)
        if (patch.actionsEnabled === false) auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.actions_stopped', detail: 'Kill switch: AI actions stopped' })
        const { chatops: _secrets, ...safe } = out   // never send the (encrypted) Slack secrets
        res.json({ ...safe, providers: out.providers.map(p => aiStore.view(p)) })
    } catch (e) { fail(res, e) }
})

// "Sign in with OpenRouter": no API key to copy — the admin signs in there and comes back connected
router.post('/openrouter/start', requirePermission('ai:manage'), (req, res) => {
    try {
        const origin = req.headers.origin || req.body?.origin
        res.json(startSignIn(req.user, origin, { label: `KubeEZ (${req.user.username})` }))
    } catch (e) { fail(res, e) }
})
router.post('/openrouter/finish', requirePermission('ai:manage'), async (req, res) => {
    try {
        const key = await finishSignIn(req.user, req.body || {})
        const base = openRouterApi()
        // the models this account can use, live — one preselected (the admin can change it right away)
        const d = await discover({ kind: 'openai', baseUrl: base }, key).catch(() => ({ models: [], suggested: null }))
        const model = d.suggested || 'openrouter/auto'
        // signing in again refreshes the same engine instead of adding a second one
        const cur = aiStore.get(req.user.orgId).providers.find(p => p.preset === 'openrouter' && p.signedIn)
        const p = cur
            ? aiStore.updateProvider(req.user.orgId, cur.id, { apiKey: key, enabled: true })
            : aiStore.addProvider(req.user.orgId, { name: 'OpenRouter', kind: 'openai', preset: 'openrouter', offline: false, baseUrl: base, model, apiKey: key, signedIn: true })
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.engine_signed_in', detail: `${cur ? 'Signed in again' : 'Signed in'} with OpenRouter (${p.model}) — ${d.models.length} model(s)` })
        res.json({ ...aiStore.view(p), models: d.models.length, again: !!cur })
    } catch (e) { fail(res, e) }
})

// Connect to an engine before saving it: which runtime answers, and which models it offers (live)
router.post('/discover', requirePermission('ai:manage'), async (req, res) => {
    try {
        const b = req.body || {}
        const preset = presetOf(b.preset)
        if (!preset) throw bad('Pick an engine')
        const clean = cleanProvider({ ...b, name: b.name || preset.label, model: 'probe' }, (await orgClusters(req)).filter(c => canSeeCluster(req.user, c)).map(c => c.id))
        const p = { ...clean, model: null }
        if (p.viaClusterId) auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.engine_reach', detail: `Connect AI: ${p.baseUrl} through cluster ${(await orgClusters(req)).find(c => c.id === p.viaClusterId)?.clusterName || p.viaClusterId}` })
        const r = await discover(p, clean.apiKey || null)
        res.json(r)
    } catch (e) { fail(res, e) }
})

// The models a saved engine offers now (live), with the ones that are new marked
router.get('/providers/:id/models', requirePermission('ai:manage'), async (req, res) => {
    try {
        const p = aiStore.get(req.user.orgId).providers.find(x => x.id === req.params.id)
        if (!p) return res.status(404).json({ error: 'AI engine not found' })
        res.json(await modelsOf(req.user.orgId, p))
    } catch (e) { fail(res, e) }
})

router.post('/providers', requirePermission('ai:manage'), async (req, res) => {
    try {
        const p = aiStore.addProvider(req.user.orgId, cleanProvider(req.body || {}, (await orgClusters(req)).filter(c => canSeeCluster(req.user, c)).map(c => c.id)))
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.engine_added', detail: `${p.name} (${p.preset || p.kind}${p.model ? `, ${p.model}` : ''})${p.viaClusterId ? ` at ${p.baseUrl} through cluster ${(await orgClusters(req)).find(c => c.id === p.viaClusterId)?.clusterName || p.viaClusterId}` : ''}` })
        // the quality test runs on its own, so a weak model is noticed before people rely on it
        let qualityCheck = null
        if (req.body?.qualityCheck === true) {
            if (isRunning(req.user.orgId)) qualityCheck = 'busy'
            else { try { startExam(req.user, [{ ...p }]); qualityCheck = 'started' } catch { qualityCheck = null } }
        }
        res.json({ ...aiStore.view(p), qualityCheck })
    } catch (e) { fail(res, e) }
})
router.put('/providers/:id', requirePermission('ai:manage'), async (req, res) => {
    try {
        const cur = aiStore.get(req.user.orgId).providers.find(p => p.id === req.params.id)
        if (!cur) return res.status(404).json({ error: 'AI engine not found' })
        const p = aiStore.updateProvider(req.user.orgId, req.params.id, cleanProvider({ ...req.body, kind: cur.kind, _offline: cur.offline, _viaClusterId: cur.viaClusterId, _baseUrl: cur.baseUrl }, (await orgClusters(req)).filter(c => canSeeCluster(req.user, c)).map(c => c.id), true))
        res.json(aiStore.view(p))
    } catch (e) { fail(res, e) }
})
router.delete('/providers/:id', requirePermission('ai:manage'), (req, res) => {
    aiStore.removeProvider(req.user.orgId, req.params.id)
    res.json({ success: true })
})

const findEngine = (req) => req.params.id === 'server' ? SERVER() : aiStore.get(req.user.orgId).providers.find(p => p.id === req.params.id)

// Is it reachable, is the model there?
router.post('/providers/:id/test', requirePermission('ai:manage'), async (req, res) => {
    const p = findEngine(req)
    if (!p) return res.status(404).json({ error: 'AI engine not found' })
    res.json(await health(p, p.builtin ? null : aiStore.keyOf(p)))
})

// Download a model into an Ollama engine (runs in the background; the list shows progress)
router.post('/providers/:id/pull', requirePermission('ai:manage'), async (req, res) => {
    const p = findEngine(req)
    if (!p) return res.status(404).json({ error: 'AI engine not found' })
    const model = String(req.body?.model || p.model || '').trim()
    const k = `${req.user.orgId}:${p.id}`
    if (pulls.get(k)?.status === 'downloading') return res.status(409).json({ error: 'A download is already running for this engine' })
    pulls.set(k, { model, status: 'downloading', at: new Date().toISOString() })
    pullModel(p, model).then(() => pulls.set(k, { model, status: 'done', at: new Date().toISOString() }))
        .catch(e => pulls.set(k, { model, status: 'failed', error: e.message, at: new Date().toISOString() }))
    auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.model_download', detail: `${p.name}: ${model}` })
    res.status(202).json({ status: 'downloading', model })
})

// The "Try it" box: a question with no cluster data
router.post('/ask', requirePermission('ai:use'), async (req, res) => {
    try {
        const question = String(req.body?.question || '').trim()
        if (question.length < 3) throw bad('Ask a question')
        const r = await ask(req.user, { task: 'chat', purpose: 'try it', question, maxTokens: 800 })
        res.json({ answer: r.text, provider: r.provider, model: r.model, ms: r.ms, attempts: r.attempts, masked: r.masked, traceId: r.traceId })
    } catch (e) { if (e instanceof AiUnavailable) return res.status(e.status || 503).json({ error: e.message, code: e.code, attempts: e.attempts }); fail(res, e) }
})

// What the AI did (masked) — admins
router.get('/activity', requirePermission('ai:manage'), (req, res) => {
    res.json({ traces: aiStore.traces(req.user.orgId).slice(0, Math.min(300, Number(req.query.limit) || 100)) })
})

export default router
