// The AI in the alert channels and what it costs: the likely cause & fix as a
// reply under each new incident alert, the daily / weekly AI digest, tokens and
// cost per engine (prices from OpenRouter's list), and the monthly budget that
// pauses cloud engines.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { tempDataDir, startServer, client } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
delete process.env.KUBEEZ_MODE

// one local server: the Telegram API, a webhook, OpenRouter's price list and an OpenAI-compatible model
const tg = [], hooks = []
let reply = 'ok', usage = { prompt_tokens: 1000, completion_tokens: 500 }, msgId = 100
const PRICES = { data: [
    { id: 'openai/gpt-4o-mini', pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    { id: 'anthropic/claude-3.5-haiku', pricing: { prompt: '0.0000008', completion: '0.000004' } },
    { id: 'google/gemini-2.0-flash-001', pricing: { prompt: '0.0000001', completion: '0.0000004' } },
    { id: 'meta-llama/llama-3.3-70b-instruct', pricing: { prompt: '0.00000012', completion: '0.0000003' } },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', pricing: { prompt: '0', completion: '0' } }
] }
const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c)
    req.on('end', () => {
        const body = JSON.parse(b || '{}')
        if (req.url.startsWith('/tg/')) { tg.push(body); return res.end(JSON.stringify({ ok: true, result: { message_id: ++msgId } })) }
        if (req.url === '/hook') { hooks.push(body); return res.end('{}') }
        if (req.url === '/models') return res.end(JSON.stringify(PRICES))
        if (req.url.endsWith('/chat/completions')) return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: typeof reply === 'function' ? reply(body) : reply } }], ...(usage ? { usage } : {}) }))
        res.statusCode = 404; res.end('{}')
    })
})
const base = () => `http://127.0.0.1:${srv.address().port}`
before(async () => {
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    process.env.KUBEEZ_TELEGRAM_API = `${base()}/tg`
    process.env.KUBEEZ_OPENROUTER_MODELS_URL = `${base()}/models`
})
after(async () => { (await import('../src/services/alertActions.js')).telegramPoller.stop(); srv.closeAllConnections?.(); srv.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

const { aiStore } = await import('../src/services/ai/aiStore.js')
const { notificationStore } = await import('../src/services/notificationStore.js')
const { notifier } = await import('../src/services/notifier.js')
const { authService } = await import('../src/services/authService.js')
const { afterAlert, skipReason, PER_HOUR, _reset: resetExplain } = await import('../src/services/ai/alertExplain.js')
const { dueKey, sendDigest } = await import('../src/services/ai/aiDigest.js')
const { recordUse, usageSummary, overBudget, monthUsd } = await import('../src/services/ai/usage.js')
const { matchPrice, priceTable, autoPrice } = await import('../src/services/ai/pricing.js')
const { ask } = await import('../src/services/ai/engine.js')
for (const org of ['org-a', 'org-d', 'org-u']) authService.users.push({ id: 'owner-' + org, username: 'owner-' + org, orgId: org, role: 'admin', subscription: { plan: 'PRO' } })

const model = (org, over = {}) => aiStore.addProvider(org, { name: 'Cloud', kind: 'openai', preset: 'other-cloud', baseUrl: `${base()}/v1`, model: 'm', ...over })

describe('the likely cause & fix under each alert', () => {
    const org = 'org-a'
    let chId
    const ANSWER = { summary: 'web-1 cannot reach its database.', cause: 'The database Service has no endpoints.', fix: ['Check the postgres pod', 'kubectl -n shop get endpoints db'], confidence: 'high' }
    const inc = (over = {}) => ({ id: 'i' + Math.random().toString(36).slice(2, 8), orgId: org, clusterId: 'c1', clusterName: 'prod', reason: 'CrashLoopBackOff', target: 'web-1', status: 'unresolved', ...over })
    const incidents = new Map()
    const deps = { find: (id) => incidents.get(id), cluster: { id: 'c1', clusterName: 'prod', orgId: org }, explain: async () => ({ answer: ANSWER, engine: { provider: 'Cloud', model: 'm' } }) }
    const alert = async (i, severity = 'critical') => {
        incidents.set(i.id, i)
        const ev = { type: 'incident', severity, title: `Crash loop — ${i.target}`, clusterId: 'c1', clusterName: 'prod', incidentId: i.id, link: '/incidents' }
        const r = await notifier.notify(org, ev)
        return { ev, r }
    }
    before(() => {
        chId = notificationStore.saveChannel(org, { type: 'telegram', name: 'Ops', config: { botToken: '1:abc', chatId: '42' } })
        notificationStore.saveRules(org, { ...notificationStore.rules(org), cooldownMinutes: 0 })
        model(org)
    })

    test('the follow-up is a reply under the alert, in the same chat', async () => {
        resetExplain(); tg.length = 0
        const i = inc()
        const { ev, r } = await alert(i)
        assert.equal(r.sent, 1)
        const alertMsg = r.results[chId].messageId
        assert.ok(alertMsg, 'the alert\'s Telegram message id is kept')
        const out = await afterAlert(org, ev, [{ channelId: chId, messageId: alertMsg }], deps)
        assert.equal(out.sent, 1)
        const f = tg.at(-1)
        assert.equal(f.reply_parameters.message_id, alertMsg)
        assert.equal(f.reply_markup, undefined, 'no Acknowledge / Mute buttons on the follow-up')
        assert.match(f.text, /likely cause &amp; fix/)
        assert.match(f.text, /Likely cause: The database Service has no endpoints/)
        assert.match(f.text, /1\. Check the postgres pod/)
        assert.match(f.text, /Written by the connected AI · Cloud \(m\)/)
    })
    test('once per incident; only warnings and critical; only with an AI; can be turned off', async () => {
        resetExplain()
        const i = inc(); incidents.set(i.id, i)
        const ev = { type: 'incident', severity: 'critical', title: 't', incidentId: i.id }
        assert.equal(skipReason(org, ev), null)
        await afterAlert(org, ev, [{ channelId: chId }], deps)
        assert.equal(skipReason(org, ev), 'already explained')
        assert.equal(skipReason(org, { ...ev, incidentId: 'x', severity: 'info' }), 'only warnings and critical alerts')
        assert.equal(skipReason(org, { ...ev, incidentId: 'x', recovery: true }), 'not a new incident')
        assert.equal(skipReason('org-none', { ...ev, incidentId: 'x' }), 'no AI connected')
        aiStore.save(org, { alertExplain: false })
        assert.equal(skipReason(org, { ...ev, incidentId: 'y' }), 'AI cause & fix in alerts is off')
        aiStore.save(org, { alertExplain: true })
    })
    test(`at most ${PER_HOUR} an hour per workspace; nothing about an incident fixed meanwhile`, async () => {
        resetExplain()
        for (let n = 0; n < PER_HOUR; n++) { const i = inc(); incidents.set(i.id, i); await afterAlert(org, { type: 'incident', severity: 'warning', incidentId: i.id }, [{ channelId: chId }], deps) }
        const i = inc(); incidents.set(i.id, i)
        assert.match((await afterAlert(org, { type: 'incident', severity: 'warning', incidentId: i.id }, [], deps)).skipped, /an hour/)
        resetExplain()
        const j = inc(); incidents.set(j.id, j)
        const r = await afterAlert(org, { type: 'incident', severity: 'warning', incidentId: j.id }, [], { ...deps, explain: async () => { j.status = 'resolved'; return { answer: ANSWER } } })
        assert.equal(r.skipped, 'resolved meanwhile')
    })
    test('the AI failing sends nothing (the alert itself already went out)', async () => {
        resetExplain(); tg.length = 0
        const i = inc(); incidents.set(i.id, i)
        const r = await afterAlert(org, { type: 'incident', severity: 'critical', incidentId: i.id }, [{ channelId: chId }], { ...deps, explain: async () => { throw new Error('No AI engine could answer right now') } })
        assert.match(r.skipped, /could not answer/)
        assert.equal(tg.length, 0)
    })
})

describe('the daily / weekly AI digest', () => {
    const org = 'org-d'
    const now = Date.parse('2026-10-19T10:00:00Z')   // a Monday, 15:30 in India
    test('due once a day after the chosen hour (workspace time zone); weekly on Mondays', () => {
        const tz = 'Asia/Kolkata'
        assert.equal(dueKey({ digest: 'off' }, tz, new Date(now)), null)
        assert.equal(dueKey({ digest: 'daily', digestHour: 9 }, tz, new Date(now)), 'daily:2026-10-19')
        assert.equal(dueKey({ digest: 'daily', digestHour: 16 }, tz, new Date(now)), null, 'not yet 16:00 there')
        assert.equal(dueKey({ digest: 'daily', digestHour: 9, digestLast: 'daily:2026-10-19' }, tz, new Date(now)), null, 'already sent today')
        assert.equal(dueKey({ digest: 'weekly', digestHour: 9 }, tz, new Date(now)), 'weekly:2026-10-19')
        assert.equal(dueKey({ digest: 'weekly', digestHour: 9 }, tz, new Date(now + 86400e3)), null, 'Tuesday')
    })
    const facts = {
        incidents: [
            { orgId: org, reason: 'CrashLoopBackOff', target: 'web-1', namespace: 'shop', clusterName: 'prod', status: 'unresolved', severity: 'critical', timestamp: new Date(now - 3600e3).toISOString() },
            { orgId: org, reason: 'NodeNotReady', target: 'w2', clusterName: 'prod', status: 'resolved', severity: 'critical', timestamp: new Date(now - 7200e3).toISOString() },
            { orgId: 'other', reason: 'X', target: 'y', status: 'unresolved', timestamp: new Date(now).toISOString() }
        ],
        audit: [
            { at: new Date(now - 1800e3).toISOString(), action: 'ai.manifests_applied', target: { clusterName: 'prod' }, actor: { username: 'boss' } },
            { at: new Date(now - 1900e3).toISOString(), action: 'auth.login', actor: { username: 'boss' } }
        ],
        fleet: { totals: { clusters: 1, high: 1, medium: 0, low: 0, open: 1, critical: 1 }, clusters: [{ name: 'prod', k8sVersion: '1.36.0', risk: { score: 41, top: 'crash loops' }, open: 1 }], k8s: { versions: [] }, addonDrift: [] }
    }
    let seen = null
    before(() => {
        notificationStore.saveChannel(org, { type: 'webhook', name: 'Hook', config: { url: `${base()}/hook` } })
        notificationStore.saveChannel(org, { type: 'telegram', name: 'TG', config: { botToken: '1:abc', chatId: '7' } })
    })
    test('without an AI: the facts go out alone, with a hint to connect one', async () => {
        hooks.length = 0
        const r = await sendDigest(org, { mode: 'daily', now, deps: facts })
        assert.equal(r.sent, 2)
        const h = hooks.at(-1)
        assert.equal(h.type, 'ai_digest')
        assert.match(h.title, /daily digest — 2 new incidents, 1 open, 1 change/)
        assert.match(h.text, /CrashLoopBackOff ×1, NodeNotReady ×1/)
        assert.match(h.text, /ai\.manifests_applied ×1/)
        assert.doesNotMatch(h.text, /auth\.login/, 'logins are not changes')
        assert.match(h.text, /Connect an AI/)
    })
    test('with an AI: its summary, written from the facts', async () => {
        model(org)
        reply = (body) => { seen = body; return '- web-1 in shop is crash-looping and still open.\n- Node w2 was down and recovered.\n- Next: check the database web-1 uses.' }
        hooks.length = 0
        const r = await sendDigest(org, { mode: 'weekly', now, deps: facts })
        assert.equal(r.engine, 'Cloud (m)')
        assert.match(JSON.stringify(seen.messages), /CrashLoopBackOff/)
        const h = hooks.at(-1)
        assert.match(h.title, /weekly digest/)
        assert.match(h.text, /^- web-1 in shop is crash-looping/)
        assert.match(h.text, /Written by the connected AI · Cloud \(m\)/)
        reply = 'ok'
    })
})

describe('usage, prices and the monthly budget', () => {
    const org = 'org-u'
    test('prices from OpenRouter\'s list: the vendor\'s own name, dated / dotted names, a guess for other hosts', async () => {
        const map = await priceTable({ refresh: true })
        assert.deepEqual(matchPrice(map, { kind: 'openai', preset: 'openai', model: 'gpt-4o-mini' }), { in: 0.15, out: 0.6 })
        assert.deepEqual(matchPrice(map, { kind: 'anthropic', preset: 'anthropic', model: 'claude-3-5-haiku-20241022' }), { in: 0.8, out: 4 })
        assert.deepEqual(matchPrice(map, { kind: 'gemini', preset: 'gemini', model: 'gemini-2.0-flash' }), { in: 0.1, out: 0.4 })
        assert.deepEqual(matchPrice(map, { kind: 'openai', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' }), { in: 0, out: 0 })
        assert.deepEqual(matchPrice(map, { kind: 'openai', preset: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct' }), { in: 0.12, out: 0.3, estimate: true })
        assert.deepEqual(matchPrice(map, { kind: 'ollama', model: 'qwen2.5:7b' }), { in: 0, out: 0 }, 'your own machine')
        assert.equal(matchPrice(map, { kind: 'openai', preset: 'openai', model: 'gpt-unknown' }), null)
        const p = model(org, { preset: 'openai', model: 'gpt-4o-mini' })
        const priced = await autoPrice(org, p)
        assert.equal(priced.priceSource, 'openrouter'); assert.equal(priced.priceIn, 0.15)
        aiStore.setPrice(org, p.id, { priceIn: 1, priceOut: 2, priceSource: 'manual' })
        assert.equal((await autoPrice(org, aiStore.get(org).providers.find(x => x.id === p.id))).priceIn, 1, 'a typed price stays')
        aiStore.removeProvider(org, p.id)
    })
    test('tokens and cost per answer — reported by the engine, or estimated from the text', () => {
        const p = { id: 'e1', name: 'Paid', kind: 'openai', model: 'x', priceIn: 2, priceOut: 10 }
        const a = recordUse(org, p, { tokensIn: 1000, tokensOut: 500 })
        assert.equal(a.usd, (1000 * 2 + 500 * 10) / 1e6)
        const b = recordUse(org, p, { tokensIn: null, tokensOut: null }, { prompt: 'x'.repeat(400), answer: 'y'.repeat(40) })
        assert.deepEqual([b.tokensIn, b.tokensOut, b.estimated], [100, 10, true])
        recordUse(org, { id: 'e2', name: 'Laptop', kind: 'ollama', model: 'q' }, { tokensIn: 9999, tokensOut: 9999 })
        const s = usageSummary(org)
        const paid = s.engines.find(e => e.id === 'e1'), local = s.engines.find(e => e.id === 'e2')
        assert.equal(paid.calls, 2); assert.equal(paid.estimated, 1); assert.equal(paid.tokensIn, 1100)
        assert.equal(local.cost, 0); assert.equal(local.offline, null, 'not an engine of this workspace (removed)')
        assert.equal(s.days.length, 30); assert.equal(s.days.at(-1).calls, 3)
        assert.ok(s.month.cost > 0)
    })
    test('the budget (in ₹): reached → cloud engines skipped, own machines answer, one alert at 80 % and 100 %', async () => {
        const cloud = model(org, { name: 'Cloud', model: 'gpt-x' })
        aiStore.setPrice(org, cloud.id, { priceIn: 1000, priceOut: 1000, priceSource: 'manual' })
        const spent = monthUsd(org)
        aiStore.save(org, { aiCost: { budget: Math.ceil((spent + 1.5) * 88), currency: '₹', perUsd: 88 }, budgetAlerted: '' })
        notificationStore.saveChannel(org, { type: 'webhook', name: 'Hook', config: { url: `${base()}/hook` } })
        hooks.length = 0
        usage = { prompt_tokens: 1000, completion_tokens: 300 }   // $1.30 a question
        reply = 'A DaemonSet runs one pod on every node.'
        const u = { id: 'u', username: 'u', orgId: org }
        const r = await ask(u, { task: 'chat', question: 'What is a DaemonSet?' })
        assert.equal(r.attempts.at(-1).usd, 1.3)
        await new Promise(x => setTimeout(x, 100))
        assert.match(hooks.map(h => h.title).join(' | '), /AI budget 80 % used/)
        await ask(u, { task: 'chat', question: 'What is a StatefulSet?' })
        assert.equal(overBudget(org), true)
        await new Promise(x => setTimeout(x, 100))
        assert.match(hooks.map(h => h.title).join(' | '), /AI budget reached/)
        const n = hooks.length
        await assert.rejects(ask(u, { task: 'chat', question: 'What is a Job?' }), /budget is used up/)
        // a model on your own machine still answers
        aiStore.addProvider(org, { name: 'Laptop', kind: 'openai', preset: 'other-local', offline: true, baseUrl: `${base()}/v1`, model: 'q' })
        const local = await ask(u, { task: 'chat', question: 'What is a Job?' })
        assert.equal(local.provider, 'Laptop')
        assert.equal(local.attempts[0].skipped, 'monthly AI budget reached')
        await new Promise(x => setTimeout(x, 100))
        assert.equal(hooks.length, n, 'the 100 % alert went out once')
        usage = { prompt_tokens: 1000, completion_tokens: 500 }; reply = 'ok'
    })
})

describe('the API', () => {
    let s, api, boss
    before(async () => {
        s = await startServer({ KUBEEZ_MODE: 'selfhosted', NO_SUPERADMIN: '1', KUBEEZ_OPENROUTER_MODELS_URL: `${base()}/models` })
        api = client(s)
        boss = (await api('POST', '/api/auth/setup', null, { username: 'costboss', password: 'bosspass123', email: 'costboss@example.com' })).data
    })
    after(() => s?.stop())
    test('settings: AI in alerts, the digest, the budget — checked', async () => {
        const g = await api('GET', '/api/ai', boss.token)
        assert.equal(g.data.alertExplain, true); assert.equal(g.data.digest, 'off'); assert.deepEqual(g.data.aiCost, { budget: 0, currency: '$', perUsd: 1 })
        assert.equal((await api('PUT', '/api/ai/settings', boss.token, { digest: 'hourly' })).status, 400)
        assert.equal((await api('PUT', '/api/ai/settings', boss.token, { digestHour: 24 })).status, 400)
        assert.equal((await api('PUT', '/api/ai/settings', boss.token, { aiCost: { budget: -1, currency: '$' } })).status, 400)
        assert.equal((await api('PUT', '/api/ai/settings', boss.token, { aiCost: { budget: 500, currency: '₹', perUsd: 0 } })).status, 400)
        assert.equal((await api('PUT', '/api/ai/settings', boss.token, { alertExplain: false, digest: 'weekly', digestHour: 8, aiCost: { budget: 500, currency: '₹', perUsd: 88 } })).status, 200)
        const after = (await api('GET', '/api/ai', boss.token)).data
        assert.deepEqual([after.alertExplain, after.digest, after.digestHour, after.aiCost.budget, after.aiCost.perUsd], [false, 'weekly', 8, 500, 88])
    })
    test('an engine gets its price by itself; an admin can type one; usage per engine', async () => {
        const p = await api('POST', '/api/ai/providers', boss.token, { preset: 'openai', name: 'GPT', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' })
        assert.equal(p.status, 200, JSON.stringify(p.data))
        let price
        for (let i = 0; i < 30 && !price?.priceSource; i++) { await new Promise(x => setTimeout(x, 100)); price = (await api('GET', '/api/ai/usage', boss.token)).data.prices.find(x => x.id === p.data.id) }
        assert.deepEqual([price.priceIn, price.priceOut, price.priceSource], [0.15, 0.6, 'openrouter'])
        assert.equal((await api('PUT', `/api/ai/providers/${p.data.id}/price`, boss.token, { priceIn: 'a', priceOut: 1 })).status, 400)
        const m = await api('PUT', `/api/ai/providers/${p.data.id}/price`, boss.token, { priceIn: 0.2, priceOut: 0.8 })
        assert.equal(m.status, 200); assert.equal(m.data.priceSource, 'manual')
        const again = await api('PUT', `/api/ai/providers/${p.data.id}/price`, boss.token, { auto: true })
        assert.equal(again.data.priceIn, 0.15)
        const u = (await api('GET', '/api/ai/usage', boss.token)).data
        assert.equal(u.currency, '₹'); assert.equal(u.budget, 500); assert.equal(u.month.calls, 0)
        assert.equal((await api('POST', '/api/ai/digest/send', boss.token, { mode: 'daily' })).status, 200)
    })
})
