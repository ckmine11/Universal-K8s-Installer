// Alerts: channels, rules (events, quiet hours, cooldown), delivery, safety.
// A local HTTP server stands in for webhooks; Telegram/Slack/Teams/Twilio
// formats are checked through their validation and payload builders.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { tempDataDir, startServer, client } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'
delete process.env.KUBEEZ_MODE

const { notificationStore } = await import('../src/services/notificationStore.js')
const { notifier, validateChannel, inQuietHours, postRequest } = await import('../src/services/notifier.js')
// these workspaces are on Pro (Free limits are tested in alert-plans.test.js)
const { authService } = await import('../src/services/authService.js')
for (const org of ['org-s', 'org-a', 'org-f']) authService.users.push({ id: 'owner-' + org, username: 'owner-' + org, orgId: org, role: 'admin', subscription: { plan: 'PRO' } })

const got = []
let hook, hookUrl
before(async () => {
    hook = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push(JSON.parse(b || '{}')); res.end('ok') }) })
    await new Promise(r => hook.listen(0, '127.0.0.1', r))
    hookUrl = `http://127.0.0.1:${hook.address().port}/hook`
})
after(() => { hook.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

test('channel validation gives clear messages', () => {
    assert.throws(() => validateChannel('telegram', { botToken: 'nope', chatId: '-100123' }), /BotFather/)
    validateChannel('telegram', { botToken: '123456:ABCdefGhIJKlmnOPQRstuVWxyz_-12', chatId: '-1001234567890' })
    assert.throws(() => validateChannel('slack', { webhookUrl: 'https://evil.example/x' }), /hooks\.slack\.com/)
    assert.throws(() => validateChannel('teams', { webhookUrl: 'https://evil.example/x' }), /Workflows/)
    validateChannel('teams', { webhookUrl: 'https://prod-01.westeurope.logic.azure.com/workflows/abc' })
    assert.throws(() => validateChannel('whatsapp', { accountSid: 'AC1', authToken: 'x', from: '+1', to: '+91' }), /Account SID/)
    assert.throws(() => validateChannel('email', { to: 'not-an-email' }), /addresses/)
    validateChannel('slack', { webhookUrl: '' }, true)   // edit: blank secret = keep the saved one
    // the bot itself as chat ID (bots cannot message bots)
    assert.throws(() => validateChannel('telegram', { botToken: '123456:ABCdefGhIJKlmnOPQRstuVWxyz_-12', chatId: '@k8sminebot' }), /bot itself/)
    assert.throws(() => validateChannel('telegram', { botToken: '123456:ABCdefGhIJKlmnOPQRstuVWxyz_-12', chatId: '123456' }), /bot itself/)
})

test('Telegram errors are explained', async () => {
    const { telegramError } = await import('../src/services/notifier.js')
    assert.match(telegramError(new Error('HTTP 403: {"ok":false,"error_code":403,"description":"Forbidden: the bot can\'t send messages to the bot"}')), /bots cannot message bots/)
    assert.match(telegramError(new Error('HTTP 400: {"description":"Bad Request: chat not found"}')), /send \/start/)
    assert.match(telegramError(new Error('HTTP 403: {"description":"Forbidden: bot was blocked by the user"}')), /Unblock/)
    assert.match(telegramError(new Error('HTTP 401: {"description":"Unauthorized"}')), /token is not valid/)
})

test('secrets are encrypted at rest and never in the public view', () => {
    const id = notificationStore.saveChannel('org-s', { type: 'telegram', name: 'Ops', config: { botToken: '123456:SECRETSECRETSECRETSECRET', chatId: '-100999' } })
    const raw = fs.readFileSync(path.join(DATA, 'notifications.json'), 'utf8')
    assert.ok(!raw.includes('SECRETSECRET'))
    const v = notificationStore.publicView('org-s')
    assert.ok(!JSON.stringify(v).includes('SECRETSECRET'))
    assert.match(v.channels[0].config.botToken, /^••••••CRET$/)
    assert.equal(v.channels[0].config.chatId, '-100999')
    notificationStore.saveChannel('org-s', { id, name: 'Ops 2', config: { botToken: '', chatId: '-100999' } })   // blank = keep
    assert.equal(notificationStore.channels('org-s')[0].config.botToken, '123456:SECRETSECRETSECRETSECRET')
})

test('delivery, event rules, cooldown and quiet hours', async () => {
    notificationStore.saveChannel('org-a', { type: 'webhook', name: 'Hook', config: { url: hookUrl } })
    let r = await notifier.notify('org-a', { type: 'incident', severity: 'critical', title: 'Node down — w1', clusterName: 'prod', clusterId: 'c1', text: 'kubelet stopped' })
    assert.equal(r.sent, 1)
    assert.deepEqual([got.at(-1).type, got.at(-1).severity, got.at(-1).cluster, got.at(-1).title], ['incident', 'critical', 'prod', 'Node down — w1'])

    r = await notifier.notify('org-a', { type: 'incident', severity: 'critical', title: 'Node down — w1', clusterName: 'prod', clusterId: 'c1' })
    assert.equal(r.reason, 'cooldown', 'the same alert is not repeated within the cooldown')

    notificationStore.saveRules('org-a', { events: { upgrade_done: false } })
    r = await notifier.notify('org-a', { type: 'upgrade_done', severity: 'success', title: 'Upgrade finished' })
    assert.equal(r.reason, 'event turned off')

    notificationStore.saveRules('org-a', { events: { upgrade_done: true }, quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' } })
    const night = new Date('2026-10-06T18:30:00Z')   // 00:00 in India
    r = await notifier.notify('org-a', { type: 'upgrade_done', severity: 'success', title: 'Upgrade finished at night' }, { now: night })
    assert.equal(r.reason, 'quiet hours')
    r = await notifier.notify('org-a', { type: 'incident', severity: 'critical', title: 'Node down at night', clusterId: 'c2' }, { now: night })
    assert.equal(r.sent, 1, 'critical alerts still go out in quiet hours')

    assert.equal(inQuietHours({ enabled: true, start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' }, new Date('2026-10-06T06:30:00Z')), false, '12:00 India is not quiet')
    const hist = notificationStore.publicView('org-a').history
    assert.ok(hist.some(h => /^held — quiet hours/.test(h.outcome)) && hist.some(h => /1\/1 delivered/.test(h.outcome)))
})

test('a failing channel is reported, others still deliver', async () => {
    notificationStore.saveChannel('org-f', { type: 'webhook', name: 'Good', config: { url: hookUrl } })
    notificationStore.saveChannel('org-f', { type: 'webhook', name: 'Dead', config: { url: 'http://127.0.0.1:1/x' } })
    const r = await notifier.notify('org-f', { type: 'backup_failed', severity: 'critical', title: 'etcd backup failed' })
    assert.equal(r.sent, 1)
    const dead = notificationStore.publicView('org-f').channels.find(c => c.name === 'Dead')
    assert.equal(dead.lastResult.ok, false)
})

test('SaaS: webhooks must be https and may not reach private addresses', async () => {
    process.env.KUBEEZ_MODE = 'saas'
    try {
        await assert.rejects(postRequest('http://example.com/x', {}), /https/)
        await assert.rejects(postRequest('https://127.0.0.1/x', {}), /private\/internal/)
        await assert.rejects(postRequest('https://localhost/x', {}), /private\/internal/)
    } finally { delete process.env.KUBEEZ_MODE }
})

test('routes: admins only, test endpoint, no secrets returned', async () => {
    const srv = await startServer()
    const api = client(srv)
    try {
        const root = (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data
        const ann = (await api('POST', '/api/auth/register', null, { username: 'ann', password: 'annpass123', email: 'ann@example.com' })).data
        await api('PUT', `/api/superadmin/users/${ann.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 5 })
        assert.equal((await api('POST', '/api/admin/users', ann.token, { username: 'vee', password: 'veepass123', email: 'v@example.com', role: 'viewer' })).status, 200)
        const vee = (await api('POST', '/api/auth/login', null, { username: 'vee', password: 'veepass123' })).data
        assert.equal((await api('GET', '/api/notifications', vee.token)).status, 403, 'viewers cannot see or change alert channels')

        let r = await api('POST', '/api/notifications/channels', ann.token, { type: 'slack', name: 'x', config: { webhookUrl: 'https://evil.example/hook' } })
        assert.equal(r.status, 400)
        r = await api('POST', '/api/notifications/channels', ann.token, { type: 'webhook', name: 'Mine', config: { url: hookUrl } })
        assert.equal(r.status, 400, 'SaaS: an http webhook is refused when saving')
        r = await api('POST', '/api/notifications/channels', ann.token, { type: 'webhook', name: 'Mine', config: { url: hookUrl.replace('http:', 'https:') } })
        assert.equal(r.status, 200)
        r = await api('GET', '/api/notifications', ann.token)
        assert.ok(!JSON.stringify(r.data).includes('/hook'), 'webhook URL is a secret')
        assert.ok(r.data.events.incident && r.data.types.telegram)
        // This test server runs as SaaS: a webhook to a private http address is
        // refused at delivery (SSRF) and the test button says why
        const before = got.length
        r = await api('POST', `/api/notifications/channels/${r.data.channels[0].id}/test`, ann.token)
        assert.equal(r.data.ok, false)
        assert.match(r.data.error, /https|private/)
        assert.equal(got.length, before, 'nothing reached the private address')
        r = await api('GET', '/api/notifications', ann.token)
        assert.equal(r.data.channels[0].lastResult.ok, false)
    } finally { await srv.stop() }
})

test('rules: wrong input is refused with the reason, never silently replaced', () => {
    const ok = notificationStore.saveRules('org-a', { quietHours: { enabled: true, start: '23:00', end: '06:30', timezone: 'Europe/London' }, cooldownMinutes: '30', events: { upgrade_done: 'false' } })
    assert.deepEqual(ok.quietHours, { enabled: true, start: '23:00', end: '06:30', timezone: 'Europe/London' })
    assert.equal(ok.cooldownMinutes, 30)
    assert.equal(ok.events.upgrade_done, false, '"false" is off, not a truthy string')
    assert.throws(() => notificationStore.saveRules('org-a', { quietHours: { timezone: 'Asia/Kolkatta' } }), /Unknown time zone "Asia\/Kolkatta"/)
    assert.throws(() => notificationStore.saveRules('org-a', { quietHours: { enabled: true, start: '22:00', end: '22:00' } }), /never apply/)
    assert.throws(() => notificationStore.saveRules('org-a', { quietHours: { start: '25:00' } }), /times like/)
    assert.throws(() => notificationStore.saveRules('org-a', { cooldownMinutes: -5 }), /0 to 1440/)
    assert.throws(() => notificationStore.saveRules('org-a', { cooldownMinutes: '' }), /0 to 1440/)
    assert.equal(notificationStore.rules('org-a').quietHours.timezone, 'Europe/London', 'a refused save changes nothing')
})

test('quiet hours: non-critical alerts are held and sent as one summary afterwards', async () => {
    notificationStore.saveChannel('org-q', { type: 'webhook', name: 'Hook', config: { url: hookUrl } })
    authService.users.push({ id: 'owner-org-q', username: 'owner-org-q', orgId: 'org-q', role: 'admin', subscription: { plan: 'PRO' } })
    notificationStore.saveRules('org-q', { quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' }, cooldownMinutes: 0 })
    const night = new Date('2026-10-06T18:30:00Z'), morning = new Date('2026-10-07T03:00:00Z')   // 00:00 and 08:30 in India
    const before = got.length
    await notifier.notify('org-q', { type: 'incident', severity: 'warning', title: 'Disk pressure — w1', clusterName: 'prod' }, { now: night })
    await notifier.notify('org-q', { type: 'incident_resolved', severity: 'success', title: 'Cleared: Disk pressure — w1', clusterName: 'prod' }, { now: night })
    assert.equal(got.length, before, 'nothing sent at night')
    assert.equal(await notifier.flushHeld({ now: night, only: 'org-q' }), 0, 'still quiet → still held')
    assert.equal(await notifier.flushHeld({ now: morning, only: 'org-q' }), 1)
    const summary = got.at(-1)
    assert.equal(summary.type, 'digest')
    assert.match(summary.title, /2 alerts held during quiet hours/)
    assert.match(summary.text, /Disk pressure — w1 \(prod\)/)
    assert.equal(await notifier.flushHeld({ now: morning, only: 'org-q' }), 0, 'sent once')
})
