// Alerts by plan: Free = one Telegram/email/webhook channel, critical alerts
// only, fixed rules, a small daily email allowance. Pro = everything.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tempDataDir, startServer, client } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
process.env.ALERT_EMAILS_PER_DAY_FREE = '2'
delete process.env.KUBEEZ_MODE

// local webhook receiver + SMTP server
const hooks = [], mails = []
let hook, hookUrl, smtp
before(async () => {
    hook = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { hooks.push(JSON.parse(b || '{}')); res.end('ok') }) })
    await new Promise(r => hook.listen(0, '127.0.0.1', r))
    hookUrl = `http://127.0.0.1:${hook.address().port}/hook`
    smtp = net.createServer((sock) => {
        let data = false, buf = '', msg = ''
        const say = (l) => sock.write(l + '\r\n')
        say('220 test')
        sock.on('data', (c) => {
            buf += c; let i
            while ((i = buf.indexOf('\r\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 2)
                if (data) { if (line === '.') { data = false; mails.push(msg); msg = ''; say('250 ok') } else msg += line + '\n'; continue }
                const cmd = line.slice(0, 4).toUpperCase()
                if (cmd === 'EHLO') sock.write('250-test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n')
                else if (cmd === 'AUTH') say('235 ok')
                else if (cmd === 'DATA') { data = true; say('354 go') }
                else if (cmd === 'QUIT') { say('221 bye'); sock.end() }
                else say('250 ok')
            }
        })
        sock.on('error', () => { })
    })
    await new Promise(r => smtp.listen(0, '127.0.0.1', r))
    Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_USER: 'k@example.com', SMTP_PASS: 'x' })
})
after(() => { hook.close(); smtp.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

const { notificationStore } = await import('../src/services/notificationStore.js')
const { notifier } = await import('../src/services/notifier.js')
const { authService } = await import('../src/services/authService.js')
const { ALERT_PLANS, lockedChannelIds } = await import('../src/config/alertPlans.js')
const owner = (org, plan) => { authService.users = authService.users.filter(u => u.orgId !== org); authService.users.push({ id: 'o-' + org, username: 'o-' + org, orgId: org, role: 'admin', subscription: { plan } }) }

test('Free: critical alerts only, fixed rules', async () => {
    owner('free1', 'FREE')
    notificationStore.saveChannel('free1', { type: 'webhook', name: 'Hook', config: { url: hookUrl } })
    // rules saved while on Pro (events off, quiet hours) do not apply on Free
    notificationStore.saveRules('free1', { events: { incident: false }, quietHours: { enabled: true, start: '00:00', end: '23:59', timezone: 'UTC' } })
    let r = await notifier.notify('free1', { type: 'incident', severity: 'warning', title: 'Disk pressure — w1' })
    assert.equal(r.reason, 'plan', 'warnings are Pro')
    r = await notifier.notify('free1', { type: 'incident', severity: 'critical', title: 'Node down — w1', clusterId: 'c1' })
    assert.equal(r.sent, 1, 'critical goes out — saved Pro rules are ignored')
    assert.equal(hooks.at(-1).title, 'Node down — w1')
    r = await notifier.notify('free1', { type: 'upgrade_done', severity: 'success', title: 'Upgrade finished' })
    assert.equal(r.reason, 'plan')
})

test('Free: one channel of Telegram/email/webhook; the rest is locked', async () => {
    const chans = [
        { id: 'a', type: 'slack', createdAt: '2026-01-01' },
        { id: 'b', type: 'webhook', createdAt: '2026-01-02' },
        { id: 'c', type: 'telegram', createdAt: '2026-01-03' }
    ]
    assert.deepEqual([...lockedChannelIds(chans, ALERT_PLANS.free)].sort(), ['a', 'c'], 'slack not on Free; only the first allowed channel')
    assert.equal(lockedChannelIds(chans, ALERT_PLANS.paid).size, 0)

    // a workspace that went back to Free: only its first webhook delivers
    owner('down1', 'FREE')
    notificationStore.saveChannel('down1', { type: 'webhook', name: 'First', config: { url: hookUrl } })
    await new Promise(r => setTimeout(r, 5))
    const second = notificationStore.saveChannel('down1', { type: 'webhook', name: 'Second', config: { url: hookUrl } })
    const before = hooks.length
    const r = await notifier.notify('down1', { type: 'incident', severity: 'critical', title: 'Node down — x', clusterId: 'cx' })
    assert.equal(r.sent, 1)
    assert.equal(hooks.length, before + 1, 'the locked second channel got nothing')
    const t = await notifier.test('down1', second)
    assert.equal(t.ok, false)
    assert.match(t.error, /not part of the Free plan/)
})

test('email: daily allowance per workspace (Free = 2 in this test)', async () => {
    owner('free2', 'FREE')
    notificationStore.saveChannel('free2', { type: 'email', name: 'Mail', config: { to: 'ops@example.com' } })
    const send = (n) => notifier.notify('free2', { type: 'incident', severity: 'critical', title: `Node down — n${n}`, clusterId: 'c' + n })
    assert.equal((await send(1)).sent, 1)
    assert.equal((await send(2)).sent, 1)
    const third = await send(3)
    assert.equal(third.sent, 0)
    assert.match(Object.values(third.results)[0].error, /allowance of 2 alert emails is used up \(Free plan\)/)
    assert.equal(mails.length, 2, 'the third email was never sent')
    assert.equal(notificationStore.emailsToday('free2'), 2)
})

test('Pro: every event, every channel, saved rules apply', async () => {
    owner('pro1', 'PRO')
    notificationStore.saveChannel('pro1', { type: 'webhook', name: 'Hook', config: { url: hookUrl } })
    let r = await notifier.notify('pro1', { type: 'upgrade_done', severity: 'success', title: 'Upgrade finished' })
    assert.equal(r.sent, 1)
    notificationStore.saveRules('pro1', { events: { upgrade_done: false } })
    r = await notifier.notify('pro1', { type: 'upgrade_done', severity: 'success', title: 'Upgrade finished again' })
    assert.equal(r.reason, 'event turned off')
})

test('API: Free limits answer 402 with an upgrade hint; Pro unlocks them', async () => {
    const srv = await startServer({ KUBEEZ_MODE: 'selfhosted', NO_SUPERADMIN: '1' })
    const api = client(srv)
    try {
        // self-hosted: the first account is set up as super admin; the second is a normal Free workspace
        const boss = (await api('POST', '/api/auth/setup', null, { username: 'boss', password: 'bosspass123', email: 'boss@example.com' })).data
        const ann = (await api('POST', '/api/auth/register', null, { username: 'annp', password: 'annpass123', email: 'annp@example.com' })).data
        let r = await api('GET', '/api/notifications', ann.token)
        assert.equal(r.status, 200)
        assert.equal(r.data.plan.paid, false)
        assert.equal(r.data.plan.maxChannels, 1)
        assert.deepEqual(r.data.plan.channelTypes, ['telegram', 'email', 'webhook'])

        r = await api('POST', '/api/notifications/channels', ann.token, { type: 'slack', name: 's', config: { webhookUrl: 'https://hooks.slack.com/services/T0/B0/x' } })
        assert.equal(r.status, 402)
        assert.equal(r.data.upgrade, true)
        assert.match(r.data.error, /Slack alerts are part of Pro/)
        r = await api('POST', '/api/notifications/channels', ann.token, { type: 'webhook', name: 'w1', config: { url: 'https://example.com/hook' } })
        assert.equal(r.status, 200)
        r = await api('POST', '/api/notifications/channels', ann.token, { type: 'webhook', name: 'w2', config: { url: 'https://example.com/hook2' } })
        assert.equal(r.status, 402)
        assert.match(r.data.error, /includes 1 alert channel/)
        r = await api('PUT', '/api/notifications/rules', ann.token, { cooldownMinutes: 5 })
        assert.equal(r.status, 402)

        // the platform owner's own workspace is never limited
        assert.equal((await api('GET', '/api/notifications', boss.token)).data.plan.paid, true)

        // upgrade → unlocked
        await api('PUT', `/api/superadmin/users/${ann.user.id}/limits`, boss.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 5 })
        r = await api('POST', '/api/notifications/channels', ann.token, { type: 'slack', name: 's', config: { webhookUrl: 'https://hooks.slack.com/services/T0/B0/x' } })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        assert.equal((await api('PUT', '/api/notifications/rules', ann.token, { cooldownMinutes: 5 })).status, 200)
        r = await api('GET', '/api/notifications', ann.token)
        assert.equal(r.data.plan.paid, true)
        assert.ok(r.data.channels.every(c => !c.locked))
    } finally { await srv.stop() }
})
