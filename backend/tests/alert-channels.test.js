// Every alert channel against the answers the real services give: payload
// format, success, the common failures (in plain words), retries on rate
// limits, Twilio's "accepted now, failed later", links only when absolute.
import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
delete process.env.KUBEEZ_MODE
const { _deliver: deliver, validateChannel, render } = await import('../src/services/notifier.js')

// Fake https: `answer(call)` → [status, body, headers?] for each request, in order
let calls, answer
function fakeHttps() {
    calls = []
    mock.method(https, 'request', (url, opts, cb) => {
        const req = new EventEmitter()
        let body = ''
        req.setTimeout = () => req
        req.destroy = (e) => req.emit('error', e)
        req.end = (d) => {
            body = d ? String(d) : ''
            const call = { url: String(url), method: opts.method, auth: opts.auth, body, json: (() => { try { return JSON.parse(body) } catch { return null } })(), form: Object.fromEntries(new URLSearchParams(body)) }
            calls.push(call)
            const [status, text, headers = {}] = answer(call, calls.length)
            setImmediate(() => {
                const res = new EventEmitter()
                res.statusCode = status; res.headers = headers; res.setEncoding = () => { }
                cb(res)
                res.emit('data', typeof text === 'string' ? text : JSON.stringify(text)); res.emit('end')
            })
        }
        return req
    })
}
beforeEach(() => { fakeHttps(); process.env.KUBEEZ_PUBLIC_URL = 'https://k8scluster.space' })
afterEach(() => mock.restoreAll())

const ev = { type: 'incident', severity: 'critical', title: 'Node down — w1 <prod> & co', clusterName: 'prod', text: 'kubelet stopped', link: '/cluster/c1' }
const TG = { botToken: '123456:ABCdefGhIJKlmnOPQRstuVWxyz_-12', chatId: '987654321' }
const tg = { type: 'telegram', config: TG }

test('links: only absolute, never relative', () => {
    assert.equal(render(ev).link, 'https://k8scluster.space/cluster/c1')
    delete process.env.KUBEEZ_PUBLIC_URL; delete process.env.FRONTEND_URL
    assert.equal(render(ev).link, '', 'no public URL → no link (Telegram/Teams reject relative ones)')
    assert.ok(render({ ...ev, text: 'x'.repeat(5000) }).lines[1].length <= 1500, 'long text is cut')
})

test('Telegram: HTML message, escaped, with link', async () => {
    answer = () => [200, { ok: true }]
    await deliver(tg, ev)
    const c = calls[0]
    assert.match(c.url, /api\.telegram\.org\/bot123456:.*\/sendMessage$/)
    assert.equal(c.json.chat_id, '987654321')
    assert.equal(c.json.parse_mode, 'HTML')
    assert.match(c.json.text, /<b>🔴 Node down — w1 &lt;prod&gt; &amp; co<\/b>/)
    assert.match(c.json.text, /<a href="https:\/\/k8scluster\.space\/cluster\/c1">Open in KubeEZ<\/a>/)
})

test('Telegram: formatting refused → sent again as plain text', async () => {
    answer = (c, n) => n === 1 ? [400, { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" }] : [200, { ok: true }]
    await deliver(tg, ev)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].json.parse_mode, undefined)
    assert.match(calls[1].json.text, /Node down — w1 <prod> & co/)
})

test('Telegram: the common failures in plain words', async () => {
    const cases = [
        [403, "Forbidden: the bot can't send messages to the bot", /bots cannot message bots/],
        [400, 'Bad Request: chat not found', /send \/start/],
        [403, 'Forbidden: bot was blocked by the user', /Unblock/],
        [401, 'Unauthorized', /token is not valid/],
        [403, 'Forbidden: bot was kicked from the group chat', /add it again/]
    ]
    for (const [status, description, re] of cases) {
        answer = () => [status, { ok: false, error_code: status, description }]
        await assert.rejects(deliver(tg, ev), re, description)
    }
    answer = () => [400, { ok: false, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1009876543210 } }]
    await assert.rejects(deliver(tg, ev), /new chat ID is -1009876543210/)
})

test('Telegram: rate limit → waits Retry-After and sends again', async () => {
    answer = (c, n) => n === 1 ? [429, { ok: false, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }] : [200, { ok: true }]
    const t0 = Date.now()
    await deliver(tg, ev)
    assert.equal(calls.length, 2)
    assert.ok(Date.now() - t0 >= 900)
})

test('Slack: escaped mrkdwn with link; dead webhook explained', async () => {
    const ch = { type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX' } }
    answer = () => [200, 'ok']
    await deliver(ch, ev)
    assert.match(calls[0].json.text, /^\*🔴 Node down — w1 &lt;prod&gt; &amp; co\*/)
    assert.match(calls[0].json.text, /<https:\/\/k8scluster\.space\/cluster\/c1\|Open in KubeEZ>/)
    answer = () => [404, 'no_service']
    await assert.rejects(deliver(ch, ev), /does not know this webhook/)
    answer = () => [410, 'channel_is_archived']
    await assert.rejects(deliver(ch, ev), /archived/)
    assert.throws(() => validateChannel('slack', { webhookUrl: 'https://hooks.slack.com/triggers/T0/1/abc' }), /services/)
})

test('Teams: Adaptive Card; no button without a public URL; errors explained', async () => {
    const ch = { type: 'teams', config: { webhookUrl: 'https://default123.08.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=x' } }
    answer = () => [202, '']
    await deliver(ch, ev)
    const card = calls[0].json.attachments[0]
    assert.equal(calls[0].json.type, 'message')
    assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive')
    assert.equal(card.content.type, 'AdaptiveCard')
    assert.equal(card.content.actions[0].url, 'https://k8scluster.space/cluster/c1')
    delete process.env.KUBEEZ_PUBLIC_URL; delete process.env.FRONTEND_URL
    await deliver(ch, ev)
    assert.equal(calls[1].json.attachments[0].content.actions, undefined, 'a relative OpenUrl would make the card invalid')
    answer = () => [401, '{"error":{"code":"DirectApiAuthorizationRequired"}}']
    await assert.rejects(deliver(ch, ev), /Anyone/)
    answer = () => [404, '']
    await assert.rejects(deliver(ch, ev), /no longer exists or is turned off/)
    assert.throws(() => validateChannel('teams', { webhookUrl: 'https://acme.webhook.office.com/webhookb2/x' }), /retired/)
    validateChannel('teams', { webhookUrl: ch.config.webhookUrl })
})

const WA = { accountSid: 'AC' + 'a'.repeat(32), authToken: 'b'.repeat(32), from: '+14155238886', to: '+919812345678' }

test('WhatsApp: sent, then followed until Twilio says sent', async () => {
    answer = (c) => c.method === 'POST' ? [201, { sid: 'SM1', status: 'queued' }] : [200, { sid: 'SM1', status: 'sent' }]
    await deliver({ type: 'whatsapp', config: WA }, ev)
    assert.match(calls[0].url, /Accounts\/ACa+\/Messages\.json$/)
    assert.equal(calls[0].auth, `${WA.accountSid}:${WA.authToken}`)
    assert.equal(calls[0].form.From, 'whatsapp:+14155238886')
    assert.equal(calls[0].form.To, 'whatsapp:+919812345678')
    assert.match(calls[0].form.Body, /Node down/)
    assert.match(calls[1].url, /Messages\/SM1\.json$/)
})

test('WhatsApp: accepted, then failed (24 h window / sandbox) → explained, not "delivered"', async () => {
    answer = (c) => c.method === 'POST' ? [201, { sid: 'SM2', status: 'queued' }] : [200, { sid: 'SM2', status: 'failed', error_code: 63016 }]
    await assert.rejects(deliver({ type: 'whatsapp', config: WA }, ev), /24 h/)
    answer = (c) => c.method === 'POST' ? [201, { sid: 'SM3', status: 'queued' }] : [200, { sid: 'SM3', status: 'undelivered', error_code: 63015 }]
    await assert.rejects(deliver({ type: 'whatsapp', config: WA }, ev), /join <your sandbox code>/)
})

test('WhatsApp: refused at once, and the template form', async () => {
    answer = () => [401, { code: 20003, message: 'Authenticate', status: 401 }]
    await assert.rejects(deliver({ type: 'whatsapp', config: WA }, ev), /Account SID \/ Auth Token/)
    answer = () => [400, { code: 21211, message: "The 'To' number is not a valid phone number." }]
    await assert.rejects(deliver({ type: 'whatsapp', config: WA }, ev), /country code/)
    answer = (c) => c.method === 'POST' ? [201, { sid: 'SM4', status: 'queued' }] : [200, { sid: 'SM4', status: 'delivered' }]
    await deliver({ type: 'whatsapp', config: { ...WA, contentSid: 'HX' + 'c'.repeat(32) } }, ev)
    assert.equal(calls.at(-2).form.ContentSid, 'HX' + 'c'.repeat(32))
    assert.equal(calls.at(-2).form.Body, undefined)
    const vars = JSON.parse(calls.at(-2).form.ContentVariables)
    assert.match(vars[1], /Node down/); assert.match(vars[3], /^https:\/\//)
    assert.throws(() => validateChannel('whatsapp', { ...WA, contentSid: 'nope' }), /HX/)
    assert.throws(() => validateChannel('whatsapp', { ...WA, to: WA.from }), /same number/)
    validateChannel('whatsapp', WA)
})

test('Webhook: JSON event; server errors retried once', async () => {
    const ch = { type: 'webhook', config: { url: 'https://hooks.example.com/kubeez' } }
    answer = (c, n) => n === 1 ? [503, 'busy'] : [200, 'ok']
    await deliver(ch, ev)
    assert.equal(calls.length, 2)
    assert.deepEqual([calls[1].json.source, calls[1].json.type, calls[1].json.severity, calls[1].json.cluster, calls[1].json.link],
        ['kubeez', 'incident', 'critical', 'prod', 'https://k8scluster.space/cluster/c1'])
    answer = () => [400, 'bad']
    await assert.rejects(deliver(ch, ev), /HTTP 400/)
    assert.equal(calls.length, 3, 'a 4xx is not retried')
})

test('Email: no SMTP → clear message; SMTP errors explained', async () => {
    const saved = { u: process.env.SMTP_USER, p: process.env.SMTP_PASS }
    delete process.env.SMTP_USER; delete process.env.SMTP_PASS
    try { await assert.rejects(deliver({ type: 'email', config: { to: 'ops@example.com' } }, ev), /SMTP settings/) }
    finally { if (saved.u) process.env.SMTP_USER = saved.u; if (saved.p) process.env.SMTP_PASS = saved.p }
    // a host that refuses: the error names the host instead of hanging
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'u@example.com', SMTP_PASS: 'p' })
    const t0 = Date.now()
    await assert.rejects(deliver({ type: 'email', config: { to: 'ops@example.com' } }, ev), /Cannot reach the SMTP server \(127\.0\.0\.1:1\)/)
    assert.ok(Date.now() - t0 < 15000)
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k]
    assert.throws(() => validateChannel('email', { to: 'a@b.com; c@d.com' }), /comma-separated/)
})

test('Telegram "Find my chat ID": bot username + the chats that wrote to it', async () => {
    const { telegramChats } = await import('../src/services/notifier.js')
    answer = (c) => /getMe$/.test(c.url) ? [200, { ok: true, result: { id: 123456, is_bot: true, first_name: 'K8s', username: 'k8sminebot' } }]
        : [200, { ok: true, result: [
            { update_id: 1, message: { chat: { id: 987654321, type: 'private', first_name: 'Joy', username: 'joy' }, text: '/start kubeez' } },
            { update_id: 2, message: { chat: { id: 987654321, type: 'private', first_name: 'Joy' }, text: 'hi' } },
            { update_id: 3, my_chat_member: { chat: { id: -1001234567890, type: 'supergroup', title: 'Ops' } } }
        ] }]
    const r = await telegramChats(TG.botToken)
    assert.deepEqual(r.bot, { username: 'k8sminebot', name: 'K8s' })
    assert.deepEqual(r.chats.map(c => [c.id, c.name, c.type]), [['987654321', 'Joy', 'private'], ['-1001234567890', 'Ops', 'supergroup']])
    answer = () => [401, { ok: false, error_code: 401, description: 'Unauthorized' }]
    await assert.rejects(telegramChats(TG.botToken), /token is not valid/)
    await assert.rejects(telegramChats(''), /bot token first/)
})
