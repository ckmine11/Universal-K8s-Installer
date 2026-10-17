// Learning without training — KubeEZ AI gets better from your feedback:
//   examples   an explanation members marked 👍 becomes a worked example for
//              that kind of problem; the next explanation of the same kind sees
//              the two newest ones (in-context learning — works with any model,
//              no GPU). Admins can review and delete them.
//   dataset    every 👍 answer, masked, as chat-format JSONL — the input for
//              real fine-tuning elsewhere (needs a GPU: Unsloth, Axolotl,
//              llama.cpp…); the result can be added back as an Ollama engine.
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'
import { aiStore } from './aiStore.js'

const FILE = path.join(DATA_DIR, 'ai-examples.json')
const PER_KIND = 5, MAX = 150
const LEARNABLE = new Set(['incident explainer', 'install doctor'])
let cache = null
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { cache = {} } cache.orgs ||= {} } return cache }
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(load())) }
const list = (orgId) => (load().orgs[orgId || '_'] ||= [])

function parseAnswer(text) {
    try { const s = String(text || '').replace(/```(?:json)?/gi, ''); const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); return j?.summary ? j : null } catch { return null }
}

/** A 👍 on an answer: keep it as a worked example (only explanations with their context). */
export function learnFromTrace(orgId, trace, by) {
    if (!trace?.ok || !LEARNABLE.has(trace.purpose) || !trace.meta?.input) return null
    const a = parseAnswer(trace.answer)
    if (!a) return null
    const all = list(orgId)
    if (all.some(x => x.traceId === trace.id)) return null
    const kind = trace.meta.reason || trace.purpose
    const ex = {
        id: randomBytes(5).toString('hex'), traceId: trace.id, kind, specialist: trace.meta.specialist || null, purpose: trace.purpose,
        input: trace.meta.input, answer: { summary: a.summary, cause: a.cause || '', fix: (Array.isArray(a.fix) ? a.fix : [a.fix]).filter(Boolean).slice(0, 5) },
        by, at: new Date().toISOString(), model: trace.model, provider: trace.provider
    }
    all.unshift(ex)
    // the newest few per kind of problem
    const same = all.filter(x => x.kind === kind)
    for (const old of same.slice(PER_KIND)) all.splice(all.indexOf(old), 1)
    if (all.length > MAX) all.length = MAX
    persist()
    return ex
}

/** The worked examples for this kind of problem (newest first). */
export const examplesFor = (orgId, kind, n = 2) => list(orgId).filter(x => x.kind === kind).slice(0, n)
export const examplesText = (exs) => exs.map((x, i) => `Example ${i + 1} — a past ${x.kind} that the team confirmed:\nSituation: ${x.input}\nGood answer: ${JSON.stringify(x.answer)}`).join('\n\n')
export const examplesOf = (orgId) => list(orgId)
export function removeExample(orgId, id) { const all = list(orgId); const i = all.findIndex(x => x.id === id); if (i < 0) return false; all.splice(i, 1); persist(); return true }

/** Every 👍 answer as chat-format JSONL (masked) — for fine-tuning elsewhere. */
export function datasetJsonl(orgId) {
    const rows = []
    for (const t of aiStore.traces(orgId)) {
        if (t.feedback?.rating !== 'up' || !t.ok || !t.answer) continue
        const user = [t.meta?.input, t.question].filter(Boolean).join('\n\n')
        if (!user) continue
        rows.push(JSON.stringify({ messages: [
            { role: 'system', content: 'You are KubeEZ AI, a careful Kubernetes operations assistant. Base every statement on the evidence; never invent log lines.' },
            { role: 'user', content: user }, { role: 'assistant', content: t.answer }
        ], metadata: { purpose: t.purpose, kind: t.meta?.reason || null, model: t.model, at: t.at } }))
    }
    return rows.join('\n') + (rows.length ? '\n' : '')
}

export function _reset() { cache = null }
