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
import { requestJson, requestStream, AiHttpError } from './http.js'
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
        const { connectCluster } = await import('../clusterAccess.js')
        const ssh = await connectCluster(cluster)
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
    return requestJson(method, url, body, { ...opts, ...(await tunnelTo(p, url)) })
}
/** The same, streamed (an answer that appears as it is written). */
export async function streamVia(p, url, body, opts = {}) {
    if (!p?.viaClusterId) return requestStream(url, body, opts)
    return requestStream(url, body, { ...opts, ...(await tunnelTo(p, url)) })
}
async function tunnelTo(p, url) {
    const u = checkViaClusterUrl(url)
    const { installationManager } = await import('../installationManager.js')
    const { clusterTunnel } = await import('../clusterTunnel.js')
    const cluster = (await installationManager.getSavedClusters()).find(c => c.id === p.viaClusterId)
    if (!cluster || (p.orgId && cluster.orgId !== p.orgId)) throw new AiHttpError('The cluster this AI engine goes through is gone', { code: 'GONE' })
    let stream
    try { stream = await clusterTunnel.open(cluster, u.hostname.replace(/^\[|\]$/g, ''), Number(u.port || 80)) }
    catch (e) { throw new AiHttpError(`Could not reach ${u.host} through cluster ${cluster.clusterName}: ${e.message}`, { code: 'NETWORK', retryable: true }) }
    return { createConnection: () => stream, trusted: true }
}

const toOpenAiMessages = (system, messages) => [...(system ? [{ role: 'system', content: system }] : []), ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))]

// What an OpenAI-compatible engine does not accept, learned from its own error
// messages and remembered per server + model, so every engine works without
// settings: newer OpenAI models (o1/o3/o4, GPT-5) want max_completion_tokens
// and no custom temperature; small local models / vLLM cap the answer length to
// their context; some servers cannot stream or reject the JSON-mode / usage fields.
const quirks = new Map()   // `${base}|${model}` → { completionTokens, noTemperature, maxTokens, noStream, noJson, noUsage }
const quirksOf = (base, model) => { const k = `${base}|${model}`; let q = quirks.get(k); if (!q) { q = {}; quirks.set(k, q) } return q }
export function _resetQuirks() { quirks.clear() }
// the newest OpenAI reasoning models are known to need it, before any error
const REASONING_MODEL = /(^|\/)(o[1-9](-|$)|gpt-5)/i

/** The engine's error → what to change for the next try (null: nothing to learn). */
export function learnFrom(e, q, want) {
    const msg = `${e?.message || ''} ${e?.body || ''}`
    if (![400, 404, 405, 415, 422, 500, 501].includes(e?.status)) return null
    if (!q.completionTokens && /max_completion_tokens|unsupported parameter[^.]*max_tokens|max_tokens[^.]*not supported/i.test(msg)) return { completionTokens: true }
    if (!q.noTemperature && /temperature/i.test(msg) && /unsupported|not support|only (the )?default|does not support|must be 1|invalid/i.test(msg)) return { noTemperature: true }
    if (/maximum context|context length|context window|max_model_len|too many tokens|max_tokens|max_completion_tokens|max_new_tokens|maxoutputtokens|max_output_tokens|output tokens/i.test(msg)) {
        // vLLM / OpenAI: "maximum context length is 4096 tokens … (900 in the messages, …)" → what is left
        const ctx = msg.match(/context length is (\d+)/i), used = msg.match(/(\d+) in the messages/i)
        const room = ctx && used ? Number(ctx[1]) - Number(used[1]) - 64 : 0
        // else "max_tokens: 8000 > 4096", "must be less than or equal to 4096": the largest limit below the ask
        // (asked again with less if that is still too much)
        const nums = [...msg.matchAll(/\b(\d{3,6})\b/g)].map(m => Number(m[1])).filter(n => n >= 256 && n < want)
        const next = room >= 256 && room < want ? room : nums.length ? Math.max(...nums) : want > 2048 ? 2048 : want > 1024 ? 1024 : 0
        if (next && next < want) return { maxTokens: next }
    }
    if (!q.noStream && /stream/i.test(msg)) return { noStream: true }
    if (!q.noJson && /response_format|json|grammar|unsupported|not supported|unknown|extra (fields|inputs)/i.test(msg)) return { noJson: true }
    if (!q.noUsage && /stream_options|include_usage/i.test(msg)) return { noUsage: true }
    return null
}

async function openAiChat(base, key, model, req, extra = {}, via = null) {
    const q = quirksOf(base, model)
    if (REASONING_MODEL.test(model) && q.completionTokens === undefined) { q.completionTokens = true; q.noTemperature = true }
    const headers = key ? { authorization: `Bearer ${key}` } : {}
    const body = (stream) => {
        const tokens = Math.min(req.maxTokens || 1500, q.maxTokens || Infinity)
        return {
            model, messages: toOpenAiMessages(req.system, req.messages),
            ...(q.completionTokens ? { max_completion_tokens: tokens } : { max_tokens: tokens }),
            ...(q.noTemperature ? {} : { temperature: req.temperature ?? 0.2 }),
            ...(stream ? { stream: true, ...(q.noUsage ? {} : { stream_options: { include_usage: true } }) } : {}),
            ...(!stream && req.json && !q.noJson ? { response_format: { type: 'json_object' } } : {})
        }
    }
    // up to 4 adjustments, each learned from the engine's own answer
    for (let tries = 0; ; tries++) {
        const live = !!req.onToken && !req.json && !q.noStream
        try {
            if (live) {
                const r = await streamVia(via, `${base}/chat/completions`, body(true), { headers, timeoutMs: req.timeoutMs, ...extra, onDelta: (d, all) => req.onToken(all) })
                if (!r.text.trim()) throw new AiHttpError('The model returned no text', { code: 'EMPTY', retryable: true })
                return { text: r.text, model: r.model || model, tokensIn: r.usage?.prompt_tokens ?? null, tokensOut: r.usage?.completion_tokens ?? null, streamed: true }
            }
            const r = await requestVia(via, 'POST', `${base}/chat/completions`, body(false), { headers, timeoutMs: req.timeoutMs, ...extra })
            const text = r?.choices?.[0]?.message?.content
            if (typeof text !== 'string') throw new AiHttpError('The model returned no text', { code: 'EMPTY', retryable: true })
            // an engine that cannot stream still answers in full (the page shows it at once)
            if (req.onToken && !req.json) try { req.onToken(text) } catch { }
            return { text, model: r.model || model, tokensIn: r.usage?.prompt_tokens ?? null, tokensOut: r.usage?.completion_tokens ?? null }
        } catch (e) {
            const change = tries < 4 && learnFrom(e, q, Math.min(req.maxTokens || 1500, q.maxTokens || Infinity))
            if (!change) throw e
            // a stream that was refused for its usage field: try the plain stream first
            if (change.noStream && live && !q.noUsage && /stream_options|include_usage/i.test(`${e.message} ${e.body || ''}`)) { q.noUsage = true; continue }
            Object.assign(q, change)
        }
    }
}

// tests only: a local fake of the Gemini API
let geminiBase = 'https://generativelanguage.googleapis.com'
export function _setGeminiBaseForTests(url) { geminiBase = url || 'https://generativelanguage.googleapis.com' }

async function geminiChat(p, key, req) {
    const model = encodeURIComponent(p.model)
    const body = {
        ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature ?? 0.2, ...(req.json ? { responseMimeType: 'application/json' } : {}) }
    }
    const gq = quirksOf('gemini', p.model)
    if (gq.maxTokens) body.generationConfig.maxOutputTokens = Math.min(body.generationConfig.maxOutputTokens || gq.maxTokens, gq.maxTokens)
    try { return await geminiOnce(p, key, req, model, body) }
    catch (e) {
        const change = learnFrom(e, gq, body.generationConfig.maxOutputTokens || 8192)
        if (!change?.maxTokens) throw e
        Object.assign(gq, change); body.generationConfig.maxOutputTokens = change.maxTokens
        return geminiOnce(p, key, req, model, body)
    }
}
async function geminiOnce(p, key, req, model, body) {
    if (req.onToken && !req.json) {
        // the answer as it is written (Server-Sent Events, one GenerateContentResponse per piece)
        let block = null
        const r = await requestStream(`${geminiBase}/v1beta/models/${model}:streamGenerateContent?alt=sse`, body, {
            headers: { 'x-goog-api-key': key }, timeoutMs: req.timeoutMs, trusted: geminiBase.startsWith('http://127.0.0.1'), onDelta: (d, all) => req.onToken(all),
            pick: (j) => { if (j.promptFeedback?.blockReason) block = j.promptFeedback.blockReason; return { delta: (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join(''), model: j.modelVersion, usage: j.usageMetadata } }
        })
        if (!r.text) throw new AiHttpError(block ? `Blocked by Gemini: ${block}` : 'The model returned no text', { code: 'EMPTY', retryable: !block })
        return { text: r.text, model: p.model, tokensIn: r.usage?.promptTokenCount ?? null, tokensOut: r.usage?.candidatesTokenCount ?? null, streamed: true }
    }
    const r = await requestJson('POST', `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, body, { headers: { 'x-goog-api-key': key }, timeoutMs: req.timeoutMs })
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
