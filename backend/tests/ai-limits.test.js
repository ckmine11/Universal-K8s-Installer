// When the engine's ACCOUNT or LIMITS are the problem, not the model — as seen
// on prod: "You have no credits remaining", "only with a subscription",
// "Rate limit exceeded … Retry in 12s":
//   • an account problem is not retried, the engine is paused (with the reason)
//     and the next engine answers at once; a new key / a passing Test resumes it
//   • a rate limit waits as long as the provider asks, then retries
//   • the quality test says "Could not test: the provider refused …" instead of a
//     0 that blames the model, and waits out rate limits so the score is fair
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
process.env.KUBEEZ_QUALITY_WAIT_MS = '20'
process.env.KUBEEZ_QUALITY_PACE_MS = '0'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'

const { ask, breakerState, resetBreaker, accountProblem, rateLimitWait } = await import('../src/services/ai/engine.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { startExam, runsOf, isRunning } = await import('../src/services/ai/quality.js')

// fake engines: each answers by a script
function engine(behave) {
    const seen = []
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c)
        req.on('end', () => {
            const body = JSON.parse(b || '{}'); seen.push(body)
            const out = behave(body, seen.length)
            res.writeHead(out.status || 200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(out.status ? { error: { message: out.error } } : { choices: [{ message: { content: out.text } }] }))
        })
    })
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/v1`, seen, close: () => { srv.closeAllConnections?.(); srv.close() } })))
}
const GOOD = JSON.stringify({ summary: 'The container ran out of memory and was killed.', cause: 'Its memory limit is too low for the app (OOMKilled).', evidence: [], fix: ['Raise the memory limit'], confidence: 'medium', missing: '' })
let noCredits, rateLimited, good
before(async () => {
    noCredits = await engine(() => ({ status: 429, error: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.' }))
    rateLimited = await engine((body, n) => n % 2 === 1 ? { status: 429, error: 'Rate limit exceeded. Max 3 requests per minute for this account. Retry in 0.05s.' } : { text: body.response_format ? GOOD : 'Paris is the capital of France.' })
    good = await engine((body) => ({ text: body.response_format ? GOOD : 'Paris is the capital of France.' }))
})
after(() => { for (const e of [noCredits, rateLimited, good]) e?.close(); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

describe('account problems and rate limits', () => {
    test('which errors are the account\'s, and how long a rate limit asks to wait', () => {
        for (const m of ['You have no credits remaining. Add credits…', 'This model is currently available only with a subscription.', 'Anthropic models are only available to accounts with at least one balance top-up.', 'Incorrect API key provided']) assert.equal(accountProblem({ message: m, status: 400 }), true, m)
        assert.equal(accountProblem({ message: 'whatever', status: 401 }), true)
        for (const m of ['Provider returned error', 'No answer within 60 s', 'Rate limit exceeded. Retry in 12s.']) assert.equal(accountProblem({ message: m }), false, m)
        assert.equal(rateLimitWait({ message: 'Rate limit exceeded. Max 10 requests per minute. Retry in 12s.' }), 12000)
        assert.equal(rateLimitWait({ status: 429, message: 'Too many requests' }), 10000)
        assert.equal(rateLimitWait({ message: 'Provider returned error' }), 0)
    })

    test('no credits: asked once (not retried), paused with the reason, the next engine answers', async () => {
        const org = 'org-acct'
        const a = aiStore.addProvider(org, { name: 'OpenAI', kind: 'openai', preset: 'openai', baseUrl: noCredits.url, model: 'gpt-x', apiKey: 'sk-test' })
        aiStore.addProvider(org, { name: 'OpenRouter', kind: 'openai', preset: 'openrouter', baseUrl: good.url, model: 'free-model', apiKey: 'sk-or' })
        const user = { id: 'u', username: 'u', orgId: org, role: 'admin' }
        const r = await ask(user, { task: 'chat', question: 'What is the capital of France?' })
        assert.equal(r.text, 'Paris is the capital of France.'); assert.equal(r.provider, 'OpenRouter')
        assert.equal(noCredits.seen.length, 1, 'an account problem is not retried')
        const b = breakerState(org, a)
        assert.equal(b.open, true); assert.equal(b.account, true); assert.match(b.reason, /no credits remaining/)
        // the next question does not even try it
        const before = noCredits.seen.length
        await ask(user, { task: 'chat', question: 'And of Spain?' })
        assert.equal(noCredits.seen.length, before)
        // a new key (or a passing Test) tries it again right away
        resetBreaker(org, a)
        assert.equal(breakerState(org, a).open, false)
    })

    test('a rate limit: waits as long as asked, then answers', async () => {
        const org = 'org-rate'
        aiStore.addProvider(org, { name: 'Limited', kind: 'openai', preset: 'groq', baseUrl: rateLimited.url, model: 'm', apiKey: 'k' })
        const t0 = Date.now()
        const r = await ask({ id: 'u', username: 'u', orgId: org, role: 'admin' }, { task: 'chat', question: 'What is the capital of France?' })
        assert.equal(r.text, 'Paris is the capital of France.')
        assert.ok(r.attempts.some(x => x.rateLimited), 'the first try was rate limited')
        assert.ok(Date.now() - t0 >= 40, 'it waited before trying again')
    })
})

describe('a fair quality test', () => {
    const wait = async (org) => { for (let i = 0; i < 400 && isRunning(org); i++) await new Promise(r => setTimeout(r, 25)) }

    test('no credits: "Could not test: the provider refused …" — no score, no 16 refusals', async () => {
        const org = 'org-q1'
        const p = aiStore.addProvider(org, { name: 'OpenAI', kind: 'openai', preset: 'openai', baseUrl: noCredits.url, model: 'gpt-x', apiKey: 'sk-test' })
        const before = noCredits.seen.length
        startExam({ id: 'u', username: 'boss', orgId: org, role: 'admin' }, [{ ...p }])
        await wait(org)
        const run = runsOf(org)[0]
        assert.equal(run.status, 'failed')
        assert.match(run.error, /^Could not test: the engine refused — You have no credits remaining/)
        assert.equal(run.summary, undefined, 'no score — a 0 would blame the model')
        assert.ok(noCredits.seen.length - before <= 2, 'found at the warm-up, not after 16 refusals')
    })

    test('rate limited on every other request: waited out — every case answered and scored', async () => {
        const org = 'org-q2'
        const p = aiStore.addProvider(org, { name: 'Limited', kind: 'openai', preset: 'groq', baseUrl: rateLimited.url, model: 'm', apiKey: 'k' })
        startExam({ id: 'u', username: 'boss', orgId: org, role: 'admin' }, [{ ...p }])
        await wait(org)
        const run = runsOf(org)[0]
        assert.equal(run.status, 'done', run.error)
        assert.equal(run.results.length, 16)
        assert.equal(run.results.filter(x => /Rate limit/.test((x.notes || []).join(' '))).length, 0, 'no case lost to the rate limit')
        assert.ok(run.summary.format === 100, `every case has an answer (format ${run.summary.format}%)`)
    })
})
