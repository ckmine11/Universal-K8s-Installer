// AI providers — one interface for every model:
//   chat(provider, { system, messages, maxTokens, temperature, json, timeoutMs })
//     → { text, model, tokensIn, tokensOut }
//   health(provider) → { ok, models?: [...], detail }
//
// kinds:
//   openai    any OpenAI-compatible API (OpenAI, Groq, DeepSeek, Mistral, OpenRouter, Together, vLLM, LM Studio, llama.cpp…)
//   ollama    an Ollama server at an address (customer LAN / own machine)
//   server    KubeEZ's own Ollama (env KUBEEZ_AI_URL — the docker-compose 'ollama' container)
//   cluster   the KubeEZ AI add-on inside a cluster (reached through the cluster tunnel, like the Explorer)
//   gemini    Google Gemini API
//   anthropic Claude (official SDK, ./anthropic.js)
// An offline engine (openai / ollama) can be "reached through a cluster"
// (viaClusterId): a model on the user's own network, e.g. a GPU server at
// 192.168.1.50 — KubeEZ goes through that cluster's tunnel (Gateway Agent or
// SSH) and its control-plane node reaches the server. Nothing is exposed.
import net from 'net'
import { requestJson, AiHttpError } from './http.js'
import { anthropicChat, anthropicHealth } from './anthropic.js'

export const KINDS = {
    openai: { label: 'OpenAI-compatible API', needsKey: false, needsUrl: true, example: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' } },
    ollama: { label: 'Ollama server (your own machine)', needsKey: false, needsUrl: true, example: { baseUrl: 'http://192.168.1.50:11434', model: 'qwen2.5:3b' } },
    server: { label: 'KubeEZ server model', needsKey: false, needsUrl: false },
    cluster: { label: 'KubeEZ AI add-on (in a cluster)', needsKey: false, needsUrl: false, example: { model: 'qwen2.5:3b' } },
    gemini: { label: 'Google Gemini', needsKey: true, needsUrl: false, example: { model: 'gemini-2.5-flash' } },
    anthropic: { label: 'Anthropic Claude', needsKey: true, needsUrl: false, example: { model: 'claude-opus-5' } }
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '')
export const serverModel = () => ({ url: trimSlash(process.env.KUBEEZ_AI_URL || ''), model: process.env.KUBEEZ_AI_MODEL || 'qwen2.5:3b' })

// the add-on's Service inside a cluster: resolved over SSH, reached through the tunnel
const AI_NS = 'kubeez-ai', AI_SVC = 'kubeez-ai', AI_PORT = 11434
const svcCache = new Map()
async function clusterConnection(p) {
    const { installationManager } = await import('../installationManager.js')
    const { automationEngine } = await import('../automationEngine.js')
    const { clusterTunnel } = await import('../clusterTunnel.js')
    const cluster = (await installationManager.getSavedClusters()).find(c => c.id === p.clusterId)
    if (!cluster) throw new AiHttpError('The cluster of this AI engine is gone', { code: 'GONE' })
    let ip = svcCache.get(cluster.id)
    if (!ip || Date.now() - ip.at > 60e3) {
        const ssh = await automationEngine.connectSSH({ ...cluster.masterNodes[0], ownerId: cluster.ownerId, orgId: cluster.orgId })
        try {
            const r = await ssh.execCommand(`sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n ${AI_NS} get svc ${AI_SVC} -o jsonpath='{.spec.clusterIP}' 2>/dev/null`)
            const v = (r.stdout || '').trim()
            if (!/^[0-9a-f.:]+$/i.test(v)) throw new AiHttpError('The KubeEZ AI add-on is not installed on this cluster — install it from Add-ons', { code: 'NOT_INSTALLED' })
            ip = { v, at: Date.now() }; svcCache.set(cluster.id, ip)
        } finally { ssh.dispose?.() }
    }
    const stream = await clusterTunnel.open(cluster, ip.v, AI_PORT)
    return { url: `http://${ip.v}:${AI_PORT}`, createConnection: () => stream }
}

// where an Ollama-type provider lives
async function ollamaTarget(p) {
    if (p.kind === 'server') {
        const s = serverModel()
        if (!s.url) throw new AiHttpError('No KubeEZ server model on this installation', { code: 'NOT_CONFIGURED' })
        return { base: s.url, trusted: true }
    }
    if (p.kind === 'cluster') { const c = await clusterConnection(p); return { base: c.url, createConnection: c.createConnection, trusted: true } }
    return { base: trimSlash(p.baseUrl), trusted: false, via: p.viaClusterId ? p : null }
}

// ── through a cluster ──
// the control plane itself and the cloud metadata service are never targets
const PROTECTED_PORTS = new Set([22, 2379, 2380, 6443, 10250, 10255, 10256, 10257, 10259])
const LAN_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.(local|lan|internal|home|corp|intranet|localdomain))?$|^[a-z0-9.-]+\.(local|lan|internal|home|corp|intranet|localdomain)$/i
/** The address of a model on the user's network, as their cluster's control-plane node sees it. */
export function checkViaClusterUrl(url) {
    let u
    try { u = new URL(url) } catch { throw new AiHttpError('Not a valid address', { code: 'BAD_URL' }) }
    if (u.protocol !== 'http:') throw new AiHttpError('Through a cluster, use the server\'s plain http address — the KubeEZ tunnel is already encrypted', { code: 'BAD_URL' })
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(host)) {
        if (/^169\.254\.|^fe80:/i.test(host) || host === '0.0.0.0') throw new AiHttpError(`${host} is not allowed (link-local / cloud metadata)`, { code: 'BAD_URL' })
        if (!isPrivate(host)) throw new AiHttpError(`${host} is a public address — reach it directly, not through a cluster`, { code: 'BAD_URL' })
    } else if (!LAN_NAME.test(host)) throw new AiHttpError('Through a cluster, use the server\'s IP address on your network (or a local name like gpu-server or gpu.lan)', { code: 'BAD_URL' })
    const port = Number(u.port || 80)
    if (PROTECTED_PORTS.has(port)) throw new AiHttpError(`Port ${port} belongs to SSH / the Kubernetes control plane — not an AI server`, { code: 'BAD_URL' })
    return u
}
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) || /^(::1|f[cd])/i.test(ip)

/** A request — straight, or through the engine's cluster when it has one (a fresh stream each time). */
export async function requestVia(p, method, url, body, opts = {}) {
    if (!p?.viaClusterId) return requestJson(method, url, body, opts)
    const u = checkViaClusterUrl(url)
    const { installationManager } = await import('../installationManager.js')
    const { clusterTunnel } = await import('../clusterTunnel.js')
    const cluster = (await installationManager.getSavedClusters()).find(c => c.id === p.viaClusterId)
    if (!cluster || (p.orgId && cluster.orgId !== p.orgId)) throw new AiHttpError('The cluster this AI engine goes through is gone', { code: 'GONE' })
    let stream
    try { stream = await clusterTunnel.open(cluster, u.hostname.replace(/^\[|\]$/g, ''), Number(u.port || 80)) }
    catch (e) { throw new AiHttpError(`Could not reach ${u.host} through cluster ${cluster.clusterName}: ${e.message}`, { code: 'NETWORK', retryable: true }) }
    return requestJson(method, url, body, { ...opts, createConnection: () => stream, trusted: true })
}

const toOpenAiMessages = (system, messages) => [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))]

// servers that reject the JSON-mode field (some local runtimes) — asked without it from then on
const noJsonMode = new Set()
async function openAiChat(base, key, model, req, extra = {}, via = null) {
    const send = (jsonMode) => requestVia(via, 'POST', `${base}/chat/completions`, {
        model, messages: toOpenAiMessages(req.system, req.messages),
        max_tokens: req.maxTokens, temperature: req.temperature ?? 0.2,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    }, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeoutMs: req.timeoutMs, ...extra })
    const jsonMode = !!req.json && !noJsonMode.has(base)
    let r
    try { r = await send(jsonMode) }
    catch (e) {
        // the JSON answer is still asked for in the prompt and checked by KubeEZ
        if (!jsonMode || ![400, 404, 415, 422, 500, 501].includes(e.status) || !/response_format|json|grammar|unsupported|not supported|unknown|extra (fields|inputs)/i.test(`${e.message} ${e.body || ''}`)) throw e
        noJsonMode.add(base)
        r = await send(false)
    }
    const text = r?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new AiHttpError('The model returned no text', { code: 'EMPTY', retryable: true })
    return { text, model: r.model || model, tokensIn: r.usage?.prompt_tokens ?? null, tokensOut: r.usage?.completion_tokens ?? null }
}

async function geminiChat(p, key, req) {
    const model = encodeURIComponent(p.model)
    const r = await requestJson('POST', `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature ?? 0.2, ...(req.json ? { responseMimeType: 'application/json' } : {}) }
    }, { headers: { 'x-goog-api-key': key }, timeoutMs: req.timeoutMs })
    const text = (r?.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('')
    if (!text) throw new AiHttpError(r?.promptFeedback?.blockReason ? `Blocked by Gemini: ${r.promptFeedback.blockReason}` : 'The model returned no text', { code: 'EMPTY', retryable: !r?.promptFeedback?.blockReason })
    return { text, model: p.model, tokensIn: r.usageMetadata?.promptTokenCount ?? null, tokensOut: r.usageMetadata?.candidatesTokenCount ?? null }
}

/** One answer from one provider (no fallback here — the engine does that). */
export async function chat(p, key, req) {
    switch (p.kind) {
        case 'openai': return openAiChat(trimSlash(p.baseUrl), key, p.model, req, {}, p.viaClusterId ? p : null)
        case 'ollama': case 'server': case 'cluster': {
            const t = await ollamaTarget(p)
            const model = p.model || (p.kind === 'server' ? serverModel().model : 'qwen2.5:3b')
            return openAiChat(`${t.base}/v1`, null, model, req, { trusted: t.trusted, createConnection: t.createConnection }, t.via)
        }
        case 'gemini': return geminiChat(p, key, req)
        case 'anthropic': return anthropicChat(p, key, req)
        default: throw new AiHttpError(`Unknown provider type ${p.kind}`, { code: 'BAD_KIND' })
    }
}

/** Is it reachable, and is the model there? */
export async function health(p, key) {
    const t0 = Date.now()
    try {
        if (['ollama', 'server', 'cluster'].includes(p.kind)) {
            const t = await ollamaTarget(p)
            const r = await requestVia(t.via, 'GET', `${t.base}/api/tags`, undefined, { timeoutMs: 10000, trusted: t.trusted, createConnection: t.createConnection })
            const models = (r.models || []).map(m => m.name)
            const want = p.model || (p.kind === 'server' ? serverModel().model : '')
            const has = !want || models.some(m => m === want || m.split(':')[0] === want)
            return { ok: has, models, ms: Date.now() - t0, detail: has ? `${models.length} model(s) available` : `Model ${want} is not downloaded yet — use "Download model"` }
        }
        if (p.kind === 'openai') {
            const r = await requestVia(p, 'GET', `${trimSlash(p.baseUrl)}/models`, undefined, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeoutMs: 10000 })
            const models = (r.data || []).map(m => m.id).slice(0, 200)
            return { ok: true, models, ms: Date.now() - t0, detail: `Reachable — ${models.length} model(s)` }
        }
        if (p.kind === 'gemini') {
            const r = await requestJson('GET', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', undefined, { headers: { 'x-goog-api-key': key }, timeoutMs: 10000 })
            const models = (r.models || []).map(m => String(m.name).replace(/^models\//, ''))
            return { ok: true, models, ms: Date.now() - t0, detail: `Reachable — ${models.length} model(s)` }
        }
        if (p.kind === 'anthropic') return { ...(await anthropicHealth(key)), ms: Date.now() - t0 }
        return { ok: false, detail: 'Unknown provider type' }
    } catch (e) {
        return { ok: false, ms: Date.now() - t0, detail: e.message, code: e.code }
    }
}

/** Download a model into an Ollama-type engine (may take minutes). */
export async function pullModel(p, model) {
    if (!['ollama', 'server', 'cluster'].includes(p.kind)) throw new AiHttpError('Only Ollama engines download models', { code: 'BAD_KIND' })
    if (!/^[a-z0-9][a-z0-9._:/-]{0,100}$/i.test(model)) throw new AiHttpError('Model name: letters, numbers, ".", "-", "_", ":" and "/" (e.g. qwen2.5:3b)', { code: 'BAD_MODEL' })
    const t = await ollamaTarget(p)
    const r = await requestVia(t.via, 'POST', `${t.base}/api/pull`, { name: model, stream: false }, { timeoutMs: 45 * 60e3, trusted: t.trusted, createConnection: t.createConnection })
    return { status: r.status || 'success' }
}

/**
 * The server model must be there: on start, wait for the 'ollama' container
 * and download KUBEEZ_AI_MODEL once if it is missing (in the background —
 * KubeEZ starts normally meanwhile; the engine shows "downloading").
 */
export const serverModelState = { status: 'unknown', error: null, at: null }
export async function ensureServerModel({ tries = 40, waitMs = 30000 } = {}) {
    const s = serverModel()
    if (!s.url) { serverModelState.status = 'off'; return }
    for (let i = 0; i < tries; i++) {
        try {
            const r = await requestJson('GET', `${s.url}/api/tags`, undefined, { timeoutMs: 10000, trusted: true })
            const have = (r.models || []).some(m => m.name === s.model || m.name === `${s.model}:latest`)
            if (have) { Object.assign(serverModelState, { status: 'ready', error: null, at: new Date().toISOString() }); return }
            Object.assign(serverModelState, { status: 'downloading', error: null, at: new Date().toISOString() })
            console.log(`[KubeEZ AI] downloading ${s.model} into the server engine (first start only)...`)
            await requestJson('POST', `${s.url}/api/pull`, { name: s.model, stream: false }, { timeoutMs: 60 * 60e3, trusted: true })
            Object.assign(serverModelState, { status: 'ready', error: null, at: new Date().toISOString() })
            console.log(`[KubeEZ AI] ${s.model} is ready`)
            return
        } catch (e) {
            Object.assign(serverModelState, { status: 'waiting', error: e.message, at: new Date().toISOString() })
            await new Promise(r => setTimeout(r, waitMs).unref?.())
        }
    }
    serverModelState.status = 'unavailable'
}
