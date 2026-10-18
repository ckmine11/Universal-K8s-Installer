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
export const breakerState = (orgId, p) => { const b = breaker.get(keyOf(orgId, p)); return b && b.openUntil > Date.now() ? { open: true, until: b.openUntil, fails: b.fails, ...(b.reason ? { reason: b.reason, account: true } : {}) } : { open: false, fails: b?.fails || 0 } }
/** The engine was changed (new key, model, address) or answered a test: try it again right away. */
export const resetBreaker = (orgId, p) => breaker.delete(keyOf(orgId, p))

// An engine whose ACCOUNT cannot answer — no credits, quota used up, a plan or top-up needed,
// a wrong or revoked key: asking again does not help. It is paused longer, with the reason.
const ACCOUNT = /no credits|out of credits|insufficient[_ ]?(quota|credits|balance|funds)|exceeded your current quota|quota (exceeded|reached)|billing|payment required|top[- ]?up|subscription|credit balance|balance (is )?(too low|insufficient)|invalid (api )?key|incorrect api key|api key (is )?(not valid|invalid|expired|revoked)|unauthori[sz]ed|authentication (failed|required)|permission denied|account (is )?(disabled|suspended|deactivated|inactive)/i
export const accountProblem = (e) => !!e && e.code !== 'BAD_URL' && ([401, 402].includes(e.status) || ACCOUNT.test(String(e.message || '')))
const ACCOUNT_PAUSE_MS = 30 * 60 * 1000
function noteAccount(orgId, p, reason) { breaker.set(keyOf(orgId, p), { fails: OPEN_AFTER, openUntil: Date.now() + ACCOUNT_PAUSE_MS, reason: String(reason).slice(0, 240) }) }
/** A rate limit: how long the provider asks to wait (ms), else 0. "Retry in 12s", Retry-After… */
export function rateLimitWait(e) {
    const msg = String(e?.message || '')
    if (!(e?.status === 429 || /rate.?limit|too many requests|requests per minute/i.test(msg))) return 0
    const m = /retry (?:in|after) (\d+(?:\.\d+)?)\s*(ms|milliseconds?)?/i.exec(msg)
    return m ? Math.round(Number(m[1]) * (m[2] ? 1 : 1000)) : 10000
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.())
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

// every answer is in English, whatever language the question, the logs or the data are in —
// asked for, and checked: an answer in Hindi / Hinglish, or one that only repeats the
// question (small models do), is asked again once and otherwise not used
const HINGLISH_WORDS = /\b(kya|kyu|kyun|kyon|hai|hain|kaise|karo|kare|karna|karein|nahi|nahin|mein|aur|hota|hoti|aata|aati|aate|jaata|jata|jati|raha|rahi|theek|thik|chahiye|abhi|wala|wali|bhi|lekin|agar|toh|tha|thi|apna|apne|sakte|sakta)\b/g
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim()
/** Is this question not in English? (then the model is told again to answer in English) */
export const nonEnglishQuestion = (q) => /[ऀ-ॿ]/.test(q) || (String(q).toLowerCase().match(HINGLISH_WORDS) || []).length >= 1
/** Why an answer is not acceptable English, or null. */
export function notEnglish(answer, question = '') {
    const a = String(answer || '')
    if ((a.match(/[ऀ-ॿ]/g) || []).length > 3) return 'it is not in English (Hindi script)'
    const words = norm(a).split(' ').filter(Boolean)
    const hits = (a.toLowerCase().match(HINGLISH_WORDS) || []).length
    const ratio = hits / Math.max(1, words.length)
    if ((hits >= 2 && ratio >= 0.06) || (hits >= 1 && ratio >= 0.12)) return 'it is in Hinglish, not English'
    const q = norm(question)
    // the question repeated — as asked, or as KubeEZ's word-by-word English of it
    for (const echo of [q, norm(roughEnglish(question))]) {
        if (echo.length >= 8 && norm(a).includes(echo) && norm(a).length < echo.length * 2 + 60) return 'it only repeats the question'
    }
    if (/\b(the (user'?s )?question (is|in english|as the user wrote)|the same question in english|in english,? the (user'?s )?question|the user asked)\b/i.test(a) && words.length < 60) return 'it only repeats the question'
    return null
}
// A rough English version of a Hindi / Hinglish question, word by word: small models
// answer in the language they read, so they are given the question in English.
const GLOSS = [
    [/\b(hota|hoti|hote|jata|jati) (hai|hain|he)\b|होता है|होती है/g, 'is'],
    [/\b(kya|kyaa)\b|क्या/g, 'what'], [/\b(kyu|kyun|kyon|kyo)\b|क्यों|क्यूँ/g, 'why'], [/\b(kaise|kese)\b|कैसे/g, 'how'], [/\b(kab)\b|कब/g, 'when'], [/\b(kahan|kaha)\b|कहाँ|कहां/g, 'where'],
    [/\b(kaun ?sa|kaun ?se|kaunsa|kaunse|kaun)\b|कौन ?सा|कौन ?से|कौन/g, 'which'], [/\b(kitne|kitna|kitni)\b|कितने|कितना|कितनी/g, 'how many'],
    [/\b(theek|thik|sahi) (kare|karo|karu|karein|karna|kaise)\b/g, 'fix'], [/\b(theek|thik)\b|ठीक/g, 'fine'], [/\b(atka|atki|atke|phasa|fasa)\b/g, 'stuck'],
    [/\b(check|dekh|dekho) (karu|karo|kare|karna|karein)\b/g, 'check'], [/\b(karu|karun|karoon)\b/g, 'should I do'], [/\b(karo|kare|karein|karna)\b|करें|करो|करना/g, 'do'],
    [/\b(ho gaya|ho gayi|ho gaye|hogaya)\b|हो गया|हो गई/g, 'has become'], [/\b(ho raha|ho rahi|ho rahe|chal raha|chal rahi)\b/g, 'is happening'], [/\b(jata|jati|jate)\b/g, 'goes'],
    [/\b(hota|hoti|hote)\b/g, 'is'], [/\b(hai|hain|he|h)\b|है|हैं/g, 'is'], [/\b(tha|thi|the)\b/g, 'was'], [/\b(nahi|nahin|na)\b|नहीं/g, 'not'], [/\b(aur)\b|और/g, 'and'],
    [/\b(me|mein|mai)\b|में/g, 'in'], [/\b(pe|par)\b|पर/g, 'on'], [/\b(se)\b|से/g, 'from'], [/\b(ka|ki|ke)\b|का|की|के/g, 'of'], [/\b(ko)\b|को/g, 'to'],
    [/\b(mera|meri|mere)\b|मेरा|मेरी|मेरे/g, 'my'], [/\b(fark|farak|antar)\b|फर्क|फ़र्क|अंतर/g, 'difference'], [/\b(batao|bata|samjhao)\b|बताओ|समझाओ/g, 'explain'],
    [/\b(chahiye)\b|चाहिए/g, 'is needed'], [/\b(abhi)\b|अभी/g, 'now'], [/\b(sab)\b|सब/g, 'all'], [/\b(band)\b|बंद/g, 'stopped'], [/\b(kharab)\b|खराब/g, 'broken'], [/\b(galti|error)\b|गलती/g, 'error']
]
const asQuestion = (t) => /[?.!]$/.test(t) ? t : `${t}?`
export function roughEnglish(q) {
    let t = ` ${String(q || '').toLowerCase()} `
    for (const [re, en] of GLOSS) t = t.replace(re, en)
    return t.replace(/[ऀ-ॿ]+/g, ' ').replace(/\s+/g, ' ').trim()
}
// the prose of a JSON answer (not quoted evidence, commands or names)
const proseOf = (j) => j && typeof j === 'object' ? ['summary', 'cause', 'missing', 'change', 'answer', 'text'].map(k => j[k]).concat(Array.isArray(j.fix) ? j.fix.map(x => String(x).replace(/`[^`]*`/g, '')) : []).filter(x => typeof x === 'string').join(' ') : ''
const ENGLISH ='Always answer in clear, correct, professional English with proper grammar and full sentences — even when the question, the logs or the data are in Hindi, Hinglish or another language. Never answer in Hindi or Hinglish.'

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
    if (!s.enabled) throw Object.assign(new AiUnavailable('KubeEZ AI is turned off for this workspace (AI settings)'), { code: 'AI_OFF', status: 400 })
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
        opts.task === 'chat'
            ? 'For anything about the user\'s clusters, base every statement on the evidence given; if it is not enough, say what is missing instead of guessing. Any other question — on any topic — answer helpfully from your own knowledge.'
            : 'Base every statement on the evidence given. If the evidence is not enough, say what is missing instead of guessing.',
        UNTRUSTED_RULES,
        ENGLISH,
        opts.system || ''
    ].filter(Boolean).join('\n\n')
    const checkEnglish = opts.english !== false
    // asked in Hindi / Hinglish: the model reads the question in English; the words as written
    // are only reference data (a small model repeats whatever it reads last)
    const foreign = checkEnglish && q.text && nonEnglishQuestion(q.text)
    const asked = foreign ? asQuestion(roughEnglish(q.text)) : q.text
    const original = foreign ? [wrapUntrusted('the question as the user wrote it (Hindi/Hinglish) — for meaning only, do not repeat it', q.text).block] : []
    const content = [...blocks, ...original, asked].filter(Boolean).join('\n\n')
    const messages = [{ role: 'user', content }]

    // 3–4) engines in order, with retries, breaker, queue and validation
    const route = opts.only ? [opts.only] : routeFor(orgId, task)
    if (!route.length) throw Object.assign(new AiUnavailable('No AI is connected to this workspace yet — an admin can connect one in AI settings → Connect AI'), { none: true })
    const attempts = []
    let result = null
    for (const p of route) {
        if (!opts.only && breakerState(orgId, p).open) { const b = breakerState(orgId, p); attempts.push({ provider: p.name, kind: p.kind, skipped: b.reason ? `paused — ${b.reason}` : 'failing — paused for a moment', ...(b.account ? { account: true } : {}) }); continue }
        if (!opts.only && p.kind === 'server' && aiStore.usedToday(orgId) >= s.dailyLimit) { attempts.push({ provider: p.name, kind: p.kind, skipped: `daily limit (${s.dailyLimit}) reached` }); continue }
        const local = LOCAL_KINDS.has(p.kind) || !!p.offline   // a model on someone's own machine: slower, one at a time
        const timeoutMs = opts.timeoutMs || (local ? 150000 : 60000)
        let release
        try { release = await acquire(keyOf(orgId, p), local ? 1 : 4, local ? 180000 : 60000) }
        catch (e) { attempts.push({ provider: p.name, kind: p.kind, error: e.message, code: e.code }); continue }
        try {
            let redo = null   // the messages for the second try, when the first answer was rejected
            for (let attempt = 1; attempt <= 2; attempt++) {
                const a0 = Date.now()
                try {
                    const r = await chat(p, aiStore.keyOf(p), { system, messages: attempt === 1 || !redo ? messages : redo, maxTokens: opts.maxTokens || 1500, json: !!opts.json, timeoutMs })
                    let json, problem = null, english = null
                    if (opts.json) {
                        json = parseJson(r.text)
                        problem = !json ? 'not valid JSON' : opts.validate ? opts.validate(json) : null
                        if (!problem && checkEnglish) english = notEnglish(proseOf(json), q.text)
                    } else if (checkEnglish) english = notEnglish(r.text, q.text)
                    if (problem || english) {
                        const why = problem || english
                        attempts.push({ provider: p.name, kind: p.kind, model: r.model, ms: Date.now() - a0, error: `answer rejected: ${why}` })
                        if (attempt === 1) {
                            // not English: ask afresh with only the English question (seeing its own
                            // Hinglish answer, or the original words, makes a small model repeat them)
                            redo = problem
                                ? [...messages, { role: 'assistant', content: '(invalid)' }, { role: 'user', content: 'Your last reply was not valid JSON in the required shape. Reply again with ONLY the JSON object.' }]
                                : [{ role: 'user', content: [...blocks, `${q.text && nonEnglishQuestion(q.text) ? asQuestion(roughEnglish(q.text)) : q.text}\n\nAnswer only in clear, correct English (keep commands, names and quoted log lines as they are).${opts.json ? ' Reply with ONLY the JSON object.' : ''}`].filter(Boolean).join('\n\n') }]
                            continue
                        }
                        throw Object.assign(new Error(`answer rejected: ${why}`), { code: 'INVALID' })
                    }
                    attempts.push({ provider: p.name, kind: p.kind, model: r.model, ms: Date.now() - a0, ok: true, tokensIn: r.tokensIn, tokensOut: r.tokensOut })
                    if (!opts.only) { noteResult(orgId, p, true); if (p.kind === 'server') aiStore.countUse(orgId) }
                    result = { ...r, json, provider: p.name, providerId: p.id, providerKind: p.kind }
                    break
                } catch (e) {
                    const account = e.code !== 'INVALID' && accountProblem(e)
                    if (e.code !== 'INVALID') attempts.push({ provider: p.name, kind: p.kind, ms: Date.now() - a0, error: e.message, code: e.code, ...(account ? { account: true } : {}), ...(rateLimitWait(e) ? { rateLimited: true } : {}) })
                    // the account cannot answer (no credits, wrong key…): straight to the next engine, and pause this one
                    if (account) { if (!opts.only) noteAccount(orgId, p, e.message); break }
                    // a local model that ran out of time is as slow the second time — go to the next engine
                    const retry = e.retryable && attempt === 1 && !(local && e.code === 'TIMEOUT')
                    if (!retry) { if (e.code !== 'INVALID' && !opts.only) noteResult(orgId, p, false); break }
                    // a temporary error: a short wait first (as long as a rate limit asks, at most 8 s)
                    await sleep(Math.min(rateLimitWait(e) || 1500, 8000))
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
        question: q.text.slice(0, 500), answer: result ? String(result.text).slice(0, 2000) : null,
        // what it was about (masked) — a 👍 answer can become a worked example (learning.js)
        meta: opts.meta ? { ...opts.meta, input: opts.meta.input ? redact(String(opts.meta.input).slice(0, 2000), { maskEmails: s.maskEmails, maskIps: s.maskIps }).text : null } : null
    }
    if (opts.trace !== false) aiStore.addTrace(orgId, trace)
    if (opts.trace !== false) auditLog.record({ orgId, actor: user, action: 'ai.ask', ok: !!result, target: opts.clusterId ? { clusterId: opts.clusterId, clusterName: opts.clusterName } : null,
        detail: `${opts.purpose || task} — ${result ? `${result.provider} (${result.model}), ${ms} ms` : 'no engine answered'}${masked ? `, ${masked} secret(s) masked` : ''}${hits.length ? ', trick text flagged' : ''}` })

    if (!result) throw new AiUnavailable(attempts.some(a => a.skipped?.startsWith('daily limit')) && attempts.every(a => a.skipped || a.error) ? 'Today\'s AI limit is used up — tomorrow it resets, or add your own engine in AI settings' : 'No AI engine could answer right now', attempts)
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
