// The KubeEZ AI engine — "never stuck, never leaks, never acts alone".
//
// ask() turns cluster data + a question into an answer:
//   1. checks: AI on for the workspace, the member may use it
//   2. masks secrets in every piece of data, wraps it as untrusted, flags trick text
//   3. picks the engines for the task (route) — each with its own timeout,
//      one retry on temporary errors, a circuit breaker and a queue
//   4. falls back to the next engine when one fails; a JSON answer must parse
//      (and pass the caller's check) or the next engine is asked
//   5. records a trace (masked) and an audit entry
// When no engine answers it throws AiUnavailable — callers then show the
// facts and the rule-based result instead (never a hang, never a blank).
import { randomBytes, createHash } from 'crypto'
import { aiStore } from './aiStore.js'
import { chat, serverModel } from './providers.js'
import { redact } from './redact.js'
import { wrapUntrusted, detectInjection, UNTRUSTED_RULES, clean } from './guard.js'
import { auditLog } from '../auditLog.js'

export class AiUnavailable extends Error {
    constructor(message, attempts = []) { super(message); this.code = 'AI_UNAVAILABLE'; this.attempts = attempts; this.status = 503 }
}

const LOCAL_KINDS = new Set(['ollama', 'server', 'cluster'])
const SERVER = { id: 'server', name: 'KubeEZ server model', kind: 'server', builtin: true }
export const serverAvailable = () => !!serverModel().url

// ── circuit breaker: an engine that keeps failing is skipped for a while ──
const breaker = new Map()   // providerKey → { fails, openUntil }
const OPEN_AFTER = 3, OPEN_MS = 2 * 60 * 1000
const keyOf = (orgId, p) => p.kind === 'server' ? 'server' : `${orgId}:${p.id}`
export const breakerState = (orgId, p) => { const b = breaker.get(keyOf(orgId, p)); return b && b.openUntil > Date.now() ? { open: true, until: b.openUntil, fails: b.fails } : { open: false, fails: b?.fails || 0 } }
function noteResult(orgId, p, ok) {
    const k = keyOf(orgId, p)
    if (ok) return breaker.delete(k)
    const b = breaker.get(k) || { fails: 0, openUntil: 0 }
    b.fails++; if (b.fails >= OPEN_AFTER) b.openUntil = Date.now() + OPEN_MS
    breaker.set(k, b)
}

// ── queue: local engines answer one question at a time, cloud ones a few ──
const slots = new Map()     // providerKey → { busy, waiting: [] }
function acquire(k, max, waitMs) {
    const s = slots.get(k) || { busy: 0, waiting: [] }; slots.set(k, s)
    if (s.busy < max) { s.busy++; return Promise.resolve(() => release(k)) }
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { s.waiting = s.waiting.filter(w => w.resolve !== resolve); reject(Object.assign(new Error('The AI engine is busy with other questions — try again in a moment'), { code: 'BUSY', retryable: false })) }, waitMs)
        s.waiting.push({ resolve: () => { clearTimeout(t); s.busy++; resolve(() => release(k)) } })
    })
}
function release(k) { const s = slots.get(k); if (!s) return; s.busy = Math.max(0, s.busy - 1); const next = s.waiting.shift(); if (next) next.resolve() }
export const queueState = (orgId, p) => { const s = slots.get(keyOf(orgId, p)); return { busy: s?.busy || 0, waiting: s?.waiting.length || 0 } }

/** The engines a task uses, in order (configured route → all enabled → the server model). */
export function routeFor(orgId, task) {
    const s = aiStore.get(orgId)
    const enabled = s.providers.filter(p => p.enabled !== false)
    const byId = new Map([...enabled.map(p => [p.id, p]), ...(serverAvailable() ? [['server', SERVER]] : [])])
    const ids = (s.routes[task]?.length ? s.routes[task] : s.routes.default?.length ? s.routes.default : [...enabled.map(p => p.id), 'server'])
    const out = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean)
    return out.length ? out : (serverAvailable() ? [SERVER] : [])
}

const LANG = { en: 'Answer in clear, simple English.', hi: 'Answer in simple Hindi (Devanagari).', hinglish: 'Answer in simple Hinglish (Hindi in Latin letters, mixed with English technical words).' }

// first JSON object in a reply (models sometimes add prose or code fences)
export function parseJson(text) {
    const s = String(text || '').replace(/```(?:json)?/gi, '')
    const start = s.indexOf('{'); const end = s.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

/**
 * ask(user, { task, purpose, system, data: [{ label, text }], question, json, validate, maxTokens })
 * Quality tests: { only: engine } asks exactly that engine (no fallback, no breaker,
 * no daily allowance), { trace: false } keeps it out of the activity log.
 *   → { text, json?, provider, model, ms, attempts, masked, suspicious, traceId }
 */
export async function ask(user, opts) {
    const orgId = user.orgId
    const s = aiStore.get(orgId)
    if (!s.enabled) throw Object.assign(new AiUnavailable('KubeEZ AI is turned off for this workspace (Settings → AI)'), { code: 'AI_OFF', status: 400 })
    const task = opts.task || 'chat'
    const t0 = Date.now()
    const traceId = randomBytes(6).toString('hex')

    // 2) mask + wrap every piece of data; flag trick text
    let masked = 0; const kinds = {}; const hits = []
    const blocks = (opts.data || []).map(d => {
        const r = redact(String(d.text ?? '').slice(0, 24000), { maskEmails: s.maskEmails, maskIps: s.maskIps })
        masked += r.masked; for (const [k, v] of Object.entries(r.kinds)) kinds[k] = (kinds[k] || 0) + v
        const inj = detectInjection(r.text); if (inj.suspicious) hits.push(...inj.hits)
        return wrapUntrusted(clean(d.label).slice(0, 60), r.text).block
    })
    const q = redact(clean(opts.question || '').slice(0, 4000), { maskEmails: s.maskEmails, maskIps: s.maskIps })
    masked += q.masked
    const system = [
        'You are KubeEZ AI, a careful Kubernetes operations assistant inside the KubeEZ console.',
        'Base every statement on the evidence given. If the evidence is not enough, say what is missing instead of guessing.',
        UNTRUSTED_RULES,
        LANG[opts.language] || LANG[user.language] || LANG[s.language] || LANG.en,   // a chat answers in the language it was asked in
        opts.system || ''
    ].filter(Boolean).join('\n\n')
    const content = [...blocks, q.text].filter(Boolean).join('\n\n')
    const messages = [{ role: 'user', content }]

    // 3–4) engines in order, with retries, breaker, queue and validation
    const route = opts.only ? [opts.only] : routeFor(orgId, task)
    if (!route.length) throw new AiUnavailable('No AI engine is set up — add one in Settings → AI, or install the KubeEZ AI add-on')
    const attempts = []
    let result = null
    for (const p of route) {
        if (!opts.only && breakerState(orgId, p).open) { attempts.push({ provider: p.name, kind: p.kind, skipped: 'failing — paused for a moment' }); continue }
        if (!opts.only && p.kind === 'server' && aiStore.usedToday(orgId) >= s.dailyLimit) { attempts.push({ provider: p.name, kind: p.kind, skipped: `daily limit (${s.dailyLimit}) reached` }); continue }
        const local = LOCAL_KINDS.has(p.kind)
        const timeoutMs = opts.timeoutMs || (local ? 150000 : 60000)
        let release
        try { release = await acquire(keyOf(orgId, p), local ? 1 : 4, local ? 180000 : 60000) }
        catch (e) { attempts.push({ provider: p.name, kind: p.kind, error: e.message, code: e.code }); continue }
        try {
            for (let attempt = 1; attempt <= 2; attempt++) {
                const a0 = Date.now()
                try {
                    const r = await chat(p, aiStore.keyOf(p), { system, messages: attempt === 1 || !opts.json ? messages : [...messages, { role: 'assistant', content: '(invalid)' }, { role: 'user', content: 'Your last reply was not valid JSON in the required shape. Reply again with ONLY the JSON object.' }], maxTokens: opts.maxTokens || 1500, json: !!opts.json, timeoutMs })
                    let json
                    if (opts.json) {
                        json = parseJson(r.text)
                        const problem = !json ? 'not valid JSON' : opts.validate ? opts.validate(json) : null
                        if (problem) { attempts.push({ provider: p.name, kind: p.kind, model: r.model, ms: Date.now() - a0, error: `answer rejected: ${problem}` }); if (attempt === 1) continue; throw Object.assign(new Error(`answer rejected: ${problem}`), { code: 'INVALID' }) }
                    }
                    attempts.push({ provider: p.name, kind: p.kind, model: r.model, ms: Date.now() - a0, ok: true, tokensIn: r.tokensIn, tokensOut: r.tokensOut })
                    if (!opts.only) { noteResult(orgId, p, true); if (p.kind === 'server') aiStore.countUse(orgId) }
                    result = { ...r, json, provider: p.name, providerId: p.id, providerKind: p.kind }
                    break
                } catch (e) {
                    if (e.code !== 'INVALID') attempts.push({ provider: p.name, kind: p.kind, ms: Date.now() - a0, error: e.message, code: e.code })
                    // a local model that ran out of time is as slow the second time — go to the next engine
                    const retry = e.retryable && attempt === 1 && !(local && e.code === 'TIMEOUT')
                    if (!retry) { if (e.code !== 'INVALID' && !opts.only) noteResult(orgId, p, false); break }
                }
            }
        } finally { release() }
        if (result) break
    }

    // 5) trace + audit (never the key; prompts are already masked)
    const ms = Date.now() - t0
    const trace = {
        id: traceId, at: new Date().toISOString(), user: user.username, task, purpose: opts.purpose || task,
        ok: !!result, ms, provider: result?.provider || null, providerId: result?.providerId || null, model: result?.model || null, attempts,
        masked, maskedKinds: kinds, suspicious: hits.length > 0, injectionHits: [...new Set(hits)].slice(0, 5),
        promptHash: createHash('sha256').update(system + content).digest('hex').slice(0, 16),
        question: q.text.slice(0, 500), answer: result ? String(result.text).slice(0, 2000) : null
    }
    if (opts.trace !== false) aiStore.addTrace(orgId, trace)
    if (opts.trace !== false) auditLog.record({ orgId, actor: user, action: 'ai.ask', ok: !!result, target: opts.clusterId ? { clusterId: opts.clusterId, clusterName: opts.clusterName } : null,
        detail: `${opts.purpose || task} — ${result ? `${result.provider} (${result.model}), ${ms} ms` : 'no engine answered'}${masked ? `, ${masked} secret(s) masked` : ''}${hits.length ? ', trick text flagged' : ''}` })

    if (!result) throw new AiUnavailable(attempts.some(a => a.skipped?.startsWith('daily limit')) && attempts.every(a => a.skipped || a.error) ? 'Today\'s AI limit is used up — tomorrow it resets, or add your own engine in Settings → AI' : 'No AI engine could answer right now', attempts)
    return { text: result.text, json: result.json, provider: result.provider, providerId: result.providerId, providerKind: result.providerKind, model: result.model, ms, attempts, masked, suspicious: hits.length > 0, traceId }
}

/** Kill switch + autonomy level for AI-proposed actions (used by the action features). */
export function actionPolicy(orgId, { risk = 'low' } = {}) {
    const s = aiStore.get(orgId)
    if (!s.enabled || !s.actionsEnabled) return 'blocked'
    if (s.autonomy === 'suggest') return 'suggest'
    if (s.autonomy === 'auto' && risk === 'low') return 'auto'
    return 'approve'
}
