// The models an engine offers — always read live from the engine itself (its
// /models list), so a model the provider released yesterday shows up today
// without a KubeEZ update. KubeEZ only sorts and labels them:
//   chat models only    (no embeddings, speech, images, moderation…)
//   recommended / fast / large   from the name
//   new                 first seen in the last 14 days (checked daily)
// For offline runtimes it also tells which runtime is listening.
import { requestJson } from './http.js'
import { health } from './providers.js'
import { aiStore } from './aiStore.js'
import { auditLog } from '../auditLog.js'

const NOT_CHAT = /(embed|embedding|whisper|tts|speech|transcri|dall-?e|image|imagen|veo|moderation|rerank|audio|realtime|search-preview|computer-use|guard|clip|stable-?diffusion|flux|sdxl|davinci|babbage|ada-0|aqa|bge-|nomic-embed|e5-)/i
const RECOMMENDED = [
    /claude-(sonnet|haiku|opus)/i, /gemini-[\d.]+-(flash|pro)(?!.*(lite|tts|image|exp-))/i, /^gpt-(4\.1|4o|5)(?!.*(audio|realtime|search|transcribe))/i, /^o[34](-mini)?$/i,
    /llama-?3\.[1-9].*70b|llama-?4/i, /qwen-?(2\.5|3)[^a-z]*(7|8|14|30|32|72|235)b/i, /qwen(2\.5|3):(7|8|14|30|32|72)b/i, /deepseek-(chat|v3)/i,
    /mistral-(large|medium)|mistral-small-3/i, /grok-[34]/i, /gemma-?3.*(12|27)b|gemma3:(12|27)b/i, /phi-?4/i
]
const FAST = /(mini|flash|haiku|small|lite|nano|instant|turbo|[^0-9](1|1\.5|2|3|4|7|8)b\b|:[1-8]b\b)/i
const LARGE = /(opus|\bpro\b|large|70b|72b|235b|405b|\b(30|32)b|grok-4|gpt-5(?!-mini|-nano))/i
const NEW_DAYS = 14

/** Sorted, labelled chat models. known: { id → firstSeen ISO }, baseline: when the list was first read. */
export function classify(ids, { known = {}, baseline = null, now = Date.now() } = {}) {
    const out = [...new Set(ids)].filter(id => id && !NOT_CHAT.test(id)).map(id => {
        const first = known[id] ? Date.parse(known[id]) : now
        const isNew = !!known[id] && (!baseline || Date.parse(known[id]) > Date.parse(baseline) + 60e3) && now - first < NEW_DAYS * 86400e3
        return { id, recommended: RECOMMENDED.some(re => re.test(id)), fast: FAST.test(id), large: LARGE.test(id), new: isNew }
    })
    // recommended first, then new, then the newest-looking versions (higher numbers first)
    const ver = (id) => (id.match(/\d+(\.\d+)?/g) || []).map(Number)
    return out.sort((a, b) => (b.recommended - a.recommended) || (b.new - a.new) || cmpVer(ver(b.id), ver(a.id)) || a.id.localeCompare(b.id))
}
const cmpVer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d } return 0 }

/** The best model to preselect: recommended + fast first (answers quickly), else recommended, else the first. */
export const suggestModel = (models) => (models.find(m => m.recommended && m.fast) || models.find(m => m.recommended) || models[0] || null)?.id || null

// models to download into an empty Ollama, by the memory they need
export const OLLAMA_SUGGESTIONS = [
    { id: 'qwen2.5:3b', ramGb: 4, note: 'Basic answers, runs on CPU' },
    { id: 'qwen2.5:7b', ramGb: 8, note: 'Good answers — best on a GPU (8 GB)' },
    { id: 'llama3.1:8b', ramGb: 8, note: 'Good general model' },
    { id: 'qwen2.5:14b', ramGb: 14, note: 'Very good — needs a 12–16 GB GPU' },
    { id: 'mistral-small:24b', ramGb: 20, note: 'Strong — needs a 24 GB GPU' }
]

const trim = (s) => String(s || '').trim().replace(/\/+$/, '')
const root = (base) => trim(base).replace(/\/v1$/, '')

/** Which runtime answers at this address? (best effort, a few quick probes) */
export async function detectRuntime(baseUrl, { headers = {} } = {}) {
    const r = root(baseUrl)
    const probe = (path, ok) => requestJson('GET', `${r}${path}`, undefined, { headers, timeoutMs: 4000 }).then(j => ok(j) ? true : false, () => false)
    const [ollama, lmstudio, vllm, tgi, llamacpp] = await Promise.all([
        probe('/api/tags', j => Array.isArray(j?.models)),
        probe('/api/v0/models', j => Array.isArray(j?.data)),
        probe('/version', j => typeof j?.version === 'string' && !j?.model_id),
        probe('/info', j => typeof j?.model_id === 'string'),
        probe('/props', j => j && ('default_generation_settings' in j || 'total_slots' in j))
    ])
    return ollama ? 'Ollama' : lmstudio ? 'LM Studio' : tgi ? 'Hugging Face TGI' : llamacpp ? 'llama.cpp' : vllm ? 'vLLM' : null
}

/** "http://host:1234" → "http://host:1234/v1" when only the /v1 path answers. */
export async function normalizeBase(baseUrl, headers = {}) {
    const b = trim(baseUrl)
    if (/\/v1$/.test(b)) return b
    const ok = await requestJson('GET', `${b}/v1/models`, undefined, { headers, timeoutMs: 5000 }).then(j => Array.isArray(j?.data), () => false)
    return ok ? `${b}/v1` : b
}

/**
 * Connect to an engine (saved or not yet saved) and read its models.
 * → { ok, detail, runtime, baseUrl, models: [classified], suggested, ms }
 */
export async function discover(p, key, { known = {}, baseline = null } = {}) {
    const headers = key ? { authorization: `Bearer ${key}` } : {}
    let engine = { ...p }
    let runtime = null
    if (engine.kind === 'openai' && engine.baseUrl) {
        engine.baseUrl = await normalizeBase(engine.baseUrl, headers)
        if (engine.offline) runtime = await detectRuntime(engine.baseUrl, { headers }).catch(() => null)
    }
    if (engine.kind === 'ollama') runtime = 'Ollama'
    const h = await health({ ...engine, model: null }, key)
    const models = classify(h.models || [], { known, baseline })
    return { ok: !!h.ok, detail: h.detail, runtime, baseUrl: engine.baseUrl || null, models, suggested: suggestModel(models), ms: h.ms }
}

/** Remember which models an engine has offered, and when each was first seen. → the new ids */
export function remember(orgId, providerId, ids) {
    const s = aiStore.get(orgId)
    const i = s.providers.findIndex(p => p.id === providerId)
    if (i < 0) return []
    const p = s.providers[i]
    const now = new Date().toISOString()
    const known = { ...(p.knownModels || {}) }
    const fresh = []
    for (const id of ids) if (!known[id]) { known[id] = now; fresh.push(id) }
    s.providers[i] = { ...p, knownModels: known, modelsBaseline: p.modelsBaseline || now, modelsCheckedAt: now }
    aiStore.save(orgId, { providers: s.providers })
    return p.modelsBaseline ? fresh : []   // the very first list is the baseline, not "new"
}

/** Models of a saved engine, live, with "new" marks (and remembered). */
export async function modelsOf(orgId, p) {
    const r = await discover(p, aiStore.keyOf(p), {})
    if (r.ok || r.models.length) remember(orgId, p.id, r.models.map(m => m.id))
    const cur = aiStore.get(orgId).providers.find(x => x.id === p.id) || p
    const models = classify(r.models.map(m => m.id), { known: cur.knownModels || {}, baseline: cur.modelsBaseline })
    return { ...r, models, suggested: suggestModel(models), current: p.model || null, currentAvailable: !p.model || models.some(m => m.id === p.model || m.id.split(':')[0] === p.model) }
}

/** How many models of an engine are new (for the engine card). */
export function newCount(p) {
    if (!p.knownModels || !p.modelsBaseline) return 0
    return classify(Object.keys(p.knownModels), { known: p.knownModels, baseline: p.modelsBaseline }).filter(m => m.new).length
}

// ── once a day: read every engine's model list, so new models show up by themselves ──
let timer = null
export function startModelRefresh({ everyMs = 24 * 3600e3, firstAfterMs = 3 * 60e3 } = {}) {
    if (timer || process.env.NODE_ENV === 'test') return
    const run = async () => {
        for (const orgId of aiStore.orgIds()) {
            for (const p of aiStore.get(orgId).providers.filter(x => x.enabled !== false && x.kind !== 'cluster')) {
                try {
                    const r = await discover(p, aiStore.keyOf(p))
                    if (!r.models.length) continue
                    const fresh = remember(orgId, p.id, r.models.map(m => m.id)).filter(id => !NOT_CHAT.test(id))
                    if (fresh.length) auditLog.record({ orgId, actor: { username: 'KubeEZ' }, action: 'ai.models_new', detail: `${p.name}: ${fresh.length} new model(s) — ${fresh.slice(0, 5).join(', ')}` })
                } catch { /* an engine that is down is checked again tomorrow */ }
            }
        }
    }
    setTimeout(() => { run(); timer = setInterval(run, everyMs); timer.unref?.() }, firstAfterMs).unref?.()
}
