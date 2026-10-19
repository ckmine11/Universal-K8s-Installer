// What each AI engine costs: US$ per million tokens in and out. Filled in by
// itself from OpenRouter's public model list (its prices follow the providers'
// list prices — OpenAI, Anthropic, Google, Mistral, DeepSeek…), or typed in by
// an admin (then never overwritten). Models on your own machines cost nothing.
import { requestJson } from './http.js'
import { aiStore } from './aiStore.js'

const LIST_URL = () => process.env.KUBEEZ_OPENROUTER_MODELS_URL || 'https://openrouter.ai/api/v1/models'
const LOCAL = new Set(['ollama', 'server', 'cluster'])
let table = null   // { at, map: id → { in, out } }

export async function priceTable({ refresh = false } = {}) {
    if (!refresh && table && Date.now() - table.at < 6 * 3600e3) return table.map
    if (process.env.NODE_ENV === 'test' && !process.env.KUBEEZ_OPENROUTER_MODELS_URL) throw new Error('no price list in tests')
    const r = await requestJson('GET', LIST_URL(), undefined, { timeoutMs: 20000, maxBytes: 16 << 20 })
    const map = new Map()
    for (const m of r?.data || []) {
        const i = Number(m.pricing?.prompt), o = Number(m.pricing?.completion)
        if (m.id && Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0) map.set(m.id, { in: +(i * 1e6).toFixed(4), out: +(o * 1e6).toFixed(4) })
    }
    if (!map.size) throw new Error('OpenRouter sent no prices')
    table = { at: Date.now(), map }
    return map
}

// presets that are the model's own vendor — their list price is OpenRouter's price
const VENDOR = { openai: 'openai', anthropic: 'anthropic', gemini: 'google', mistral: 'mistralai', deepseek: 'deepseek', xai: 'x-ai' }
const isOpenRouter = (p) => /(^|\.)openrouter\.ai$/i.test((() => { try { return new URL(p.baseUrl || '').hostname } catch { return '' } })())
export const isOffline = (p) => LOCAL.has(p.kind) || !!p.offline

/** The price of an engine's model in the table → { in, out, estimate? } or null */
export function matchPrice(map, p) {
    if (isOffline(p)) return { in: 0, out: 0 }
    const model = String(p.model || '').trim()
    if (!model) return null
    // OpenRouter itself: its own price, exactly. Anyone else under an OpenRouter-style name: the vendor or a guess below
    if (isOpenRouter(p)) return map.get(model) || null
    // the same model under its vendor's name: gpt-4o-mini → openai/gpt-4o-mini,
    // claude-3-5-haiku-20241022 → anthropic/claude-3.5-haiku, gemini-2.0-flash → google/gemini-2.0-flash-001
    const bare = model.replace(/^models\//, '').toLowerCase()
    const forms = new Set([bare, bare.replace(/-\d{8}$/, ''), bare.replace(/-\d{8}$/, '').replace(/(\d)-(\d)/g, '$1.$2'), bare.replace(/-latest$/, '')])
    const vendor = VENDOR[p.preset] || (['anthropic', 'gemini'].includes(p.kind) ? VENDOR[p.kind] : null)
    const ids = [...map.keys()]
    for (const f of forms) {
        if (vendor) { const hit = map.get(`${vendor}/${f}`) || map.get(`${vendor}/${f}-001`); if (hit) return hit }
    }
    if (vendor) return null
    // another host of an open model (Groq, Together…): the same model's price elsewhere — a guess, marked so
    const last = bare.split('/').pop()
    const plain = last.replace(/-(versatile|instant|turbo|instruct-turbo|chat-hf|hf)$/, '')   // Groq / Together names
    for (const f of [...forms, last, plain, `${plain}-instruct`]) {
        if (map.has(f)) return { ...map.get(f), estimate: true }
        const any = ids.find(id => id.split('/')[1]?.toLowerCase() === f && !id.endsWith(':free'))
        if (any) return { ...map.get(any), estimate: true }
    }
    return null
}

/** Fill in the price of one engine (unless an admin typed it). → the engine */
export async function autoPrice(orgId, p, { force = false } = {}) {
    if (!force && p.priceSource === 'manual') return p
    if (isOffline(p)) return aiStore.setPrice(orgId, p.id, { priceIn: 0, priceOut: 0, priceSource: 'offline' })
    const hit = matchPrice(await priceTable(), p)
    if (!hit) return aiStore.setPrice(orgId, p.id, { priceIn: null, priceOut: null, priceSource: 'unknown' })
    return aiStore.setPrice(orgId, p.id, { priceIn: hit.in, priceOut: hit.out, priceSource: hit.estimate ? 'estimate' : 'openrouter' })
}

/** Every engine's price, again (daily, with the model lists). */
export async function refreshPrices() {
    for (const orgId of aiStore.orgIds()) {
        for (const p of aiStore.get(orgId).providers) { try { await autoPrice(orgId, p) } catch { /* OpenRouter down: tomorrow */ } }
    }
}

export function _setTable(map) { table = map ? { at: Date.now(), map } : null }
