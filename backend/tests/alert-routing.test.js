// Alerts 2: routing per channel, escalation of unacknowledged critical alerts,
// and acting from the alert (Telegram buttons, signed links for the rest).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'
process.env.KUBEEZ_PUBLIC_URL = 'https://kubeez.example'
delete process.env.KUBEEZ_MODE

// one local server stands in for webhooks and the Telegram API
const got = []
let hook, base
before(async () => {
    hook = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c)
        req.on('end', () => { got.push({ path: req.url, body: JSON.parse(b || '{}') }); res.end(JSON.stringify({ ok: true, result: [] })) })
    })
    await new Promise(r => hook.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${hook.address().port}`
    process.env.KUBEEZ_TELEGRAM_API = `${base}/tg`
})
after(async () => { (await import('../src/services/alertActions.js')).telegramPoller.stop(); hook.closeAllConnections?.(); hook.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

const { notificationStore } = await import('../src/services/notificationStore.js')
const { notifier, routes } = await import('../src/services/notifier.js')
const { signAction, verifyAction, actionLinks, handleTelegramUpdate } = await import('../src/services/alertActions.js')
const { incidentDetector } = await import('../src/services/incidentDetector.js')
const { authService } = await import('../src/services/authService.js')
for (const org of ['org-r', 'org-e', 'org-t', 'org-l']) authService.users.push({ id: 'owner-' + org, username: 'owner-' + org, orgId: org, role: 'admin', subscription: { plan: 'PRO' } })
authService.users.push({ id: 'owner-free', username: 'owner-free', orgId: 'org-free', role: 'admin', subscription: { plan: 'FREE' } })

const at = (p) => got.filter(g => g.path === p)
const incident = (over = {}) => {
    const inc = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, orgId: 'org-t', clusterId: 'c1', clusterName: 'prod', reason: 'NodeNotReady', target: 'w1', status: 'unresolved', severity: 'critical', timeline: [], _key: 'k' + Math.random(), ...over }
    incidentDetector.incidents.unshift(inc)
    return inc
}

test('routing: a channel gets only its clusters and severities', () => {
    const ch = (routing) => ({ routing })
    assert.equal(routes(ch({ clusters: [], minSeverity: 'info' }), { severity: 'info', clusterId: 'c1' }), true)
    assert.equal(routes(ch({ clusters: ['c2'], minSeverity: 'info' }), { severity: 'critical', clusterId: 'c1' }), false)
    assert.equal(routes(ch({ clusters: ['c2'], minSeverity: 'info' }), { severity: 'critical' }), true, 'alerts without a cluster (Gateway Agent) go everywhere')
    assert.equal(routes(ch({ clusters: [], minSeverity: 'critical' }), { severity: 'warning', clusterId: 'c1' }), false)
    assert.equal(routes(ch({ clusters: [], minSeverity: 'critical' }), { severity: 'success', recovery: true }), true, '"back online" of a critical alert counts as critical')
    assert.throws(() => notificationStore.saveChannel('org-r', { type: 'webhook', name: 'x', config: { url: base }, routing: { minSeverity: 'loud' } }), /info, warning or critical/)
})

test('routing: only the matching channels receive the alert', async () => {
    const all = notificationStore.saveChannel('org-r', { type: 'webhook', name: 'All', config: { url: `${base}/all` } })
    notificationStore.saveChannel('org-r', { type: 'webhook', name: 'Prod critical', config: { url: `${base}/prod` }, routing: { clusters: ['c-prod'], minSeverity: 'critical' } })
    assert.deepEqual(notificationStore.publicView('org-r').channels.find(c => c.id === all).routing, { clusters: [], minSeverity: 'info' })

    let r = await notifier.notify('org-r', { type: 'incident', severity: 'warning', title: 'Disk pressure — stage', clusterId: 'c-stage' })
    assert.equal(r.sent, 1)
    assert.equal(at('/prod').length, 0)
    r = await notifier.notify('org-r', { type: 'incident', severity: 'critical', title: 'Node down — prod', clusterId: 'c-prod' })
    assert.equal(r.sent, 2)
    assert.equal(at('/prod').length, 1)

    notificationStore.saveChannel('org-r', { id: all, name: 'All', config: {}, routing: { clusters: ['c-prod'], minSeverity: 'info' } })
    r = await notifier.notify('org-r', { type: 'incident', severity: 'warning', title: 'Disk pressure — edge', clusterId: 'c-edge' })
    assert.equal(r.reason, 'routing')
    assert.match(notificationStore.publicView('org-r').history[0].outcome, /no channel is set to receive/)
})

test('routing: Free ignores routing (its one channel gets every critical alert)', async () => {
    notificationStore.saveChannel('org-free', { type: 'webhook', name: 'Only', config: { url: `${base}/free` }, routing: { clusters: ['other'], minSeverity: 'critical' } })
    const r = await notifier.notify('org-free', { type: 'incident', severity: 'critical', title: 'Node down', clusterId: 'c1' })
    assert.equal(r.sent, 1)
})

test('escalation: rule validation', () => {
    const a = notificationStore.saveChannel('org-e', { type: 'webhook', name: 'Team', config: { url: `${base}/team` } })
    assert.throws(() => notificationStore.saveRules('org-e', { escalation: { enabled: true, afterMinutes: 15, channelIds: [] } }), /at least one channel/)
    assert.throws(() => notificationStore.saveRules('org-e', { escalation: { enabled: true, afterMinutes: 1, channelIds: [a] } }), /5 to 240/)
    const rules = notificationStore.saveRules('org-e', { escalation: { enabled: true, afterMinutes: 10, channelIds: [a, 'gone'] } })
    assert.deepEqual(rules.escalation, { enabled: true, afterMinutes: 10, channelIds: [a] })
    notificationStore.deleteChannel('org-e', a)
    assert.deepEqual(notificationStore.rules('org-e').escalation.channelIds, [])
})

test('escalation: an unacknowledged critical incident goes to the escalation channels once', async () => {
    notificationStore.saveChannel('org-e', { type: 'webhook', name: 'On-call', config: { url: `${base}/oncall` } })
    const boss = notificationStore.saveChannel('org-e', { type: 'webhook', name: 'Lead', config: { url: `${base}/lead` }, routing: { clusters: ['nothing'], minSeverity: 'critical' } })
    notificationStore.saveRules('org-e', { escalation: { enabled: true, afterMinutes: 10, channelIds: [boss] } })
    const t0 = new Date('2026-10-10T10:00:00Z')

    const inc = incident({ orgId: 'org-e' })
    await notifier.notify('org-e', { type: 'incident', severity: 'critical', title: 'Node down — w1', clusterId: 'c1', incidentId: inc.id, escalate: { kind: 'incident', id: inc.id } }, { now: t0 })
    assert.equal(at('/lead').length, 0, 'routing keeps the lead out of normal alerts')
    assert.equal(await notifier.flushEscalations({ now: new Date(+t0 + 5 * 60e3) }), 0, 'not yet')
    assert.equal(await notifier.flushEscalations({ now: new Date(+t0 + 11 * 60e3) }), 1)
    assert.match(at('/lead')[0].body.title, /^ESCALATED — Node down/)
    assert.match(at('/lead')[0].body.text, /Not acknowledged for 10 minutes/)
    assert.equal(await notifier.flushEscalations({ now: new Date(+t0 + 30 * 60e3) }), 0, 'only once')

    // acknowledged in time → nothing
    const inc2 = incident({ orgId: 'org-e', target: 'w2' })
    await notifier.notify('org-e', { type: 'incident', severity: 'critical', title: 'Node down — w2', clusterId: 'c1', incidentId: inc2.id, escalate: { kind: 'incident', id: inc2.id } }, { now: t0 })
    incidentDetector.acknowledge(inc2.id, 'ann')
    assert.equal(await notifier.flushEscalations({ now: new Date(+t0 + 11 * 60e3) }), 0)
    // fixed in time → nothing
    const inc3 = incident({ orgId: 'org-e', target: 'w3' })
    await notifier.notify('org-e', { type: 'incident', severity: 'critical', title: 'Node down — w3', clusterId: 'c1', incidentId: inc3.id, escalate: { kind: 'incident', id: inc3.id } }, { now: t0 })
    inc3.status = 'resolved'
    assert.equal(await notifier.flushEscalations({ now: new Date(+t0 + 11 * 60e3) }), 0)
    assert.equal(at('/lead').length, 1)
    assert.equal(notificationStore.escalations().length, 0)
})

test('signed action links: tamper-proof, expire, never act on GET', async () => {
    const t = signAction({ i: 'x1', o: 'org-l', action: 'ack' })
    assert.equal(verifyAction(t).i, 'x1')
    assert.throws(() => verifyAction(t.slice(0, -2) + 'AA'), /not valid/)
    const [body, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), action: 'fix' })).toString('base64url')
    assert.throws(() => verifyAction(`${forged}.${sig}`), /not valid/)

    assert.deepEqual(actionLinks({ incidentId: 'i1', orgId: 'o', fixable: true }).map(a => a.action), ['ack', 'mute', 'fix'])
    assert.deepEqual(actionLinks({ incidentId: 'i1', orgId: 'o' }).map(a => a.action), ['ack', 'mute'])
    assert.deepEqual(actionLinks({ title: 'backup failed' }), [], 'only incidents get actions')

    const { default: router } = await import('../src/routes/alertActions.js')
    const app = express(); app.use('/api/alert-actions', router)
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    const url = `http://127.0.0.1:${srv.address().port}/api/alert-actions/`
    try {
        const inc = incident({ orgId: 'org-l' })
        const link = actionLinks({ incidentId: inc.id, orgId: 'org-l' })[0].url
        const token = link.split('/').pop()
        let r = await fetch(url + token)
        assert.equal(r.status, 200)
        const html = await r.text()
        assert.match(html, /Acknowledge\?/)
        assert.match(html, /<form method="post"/)
        assert.equal(inc.ackBy, undefined, 'opening the link (link preview, mail scanner) does nothing')
        r = await fetch(url + token, { method: 'POST' })
        assert.equal(r.status, 200)
        assert.match(await r.text(), /Acknowledged by alert link/)
        assert.equal(inc.ackBy, 'alert link')
        // another workspace's token for this incident is refused
        r = await fetch(url + signAction({ i: inc.id, o: 'org-other', action: 'ack' }), { method: 'POST' })
        assert.equal(r.status, 404)
        r = await fetch(url + 'garbage.sig')
        assert.equal(r.status, 400)
    } finally { srv.close() }
})

test('Telegram: buttons in incident alerts, pressing one acts and removes them', async () => {
    const token = '123456:ABCdefGhIJKlmnOPQRstuVWxyz_-12'
    notificationStore.saveChannel('org-t', { type: 'telegram', name: 'Ops', config: { botToken: token, chatId: '-100777' } })
    const inc = incident({ orgId: 'org-t' })
    await notifier.notify('org-t', { type: 'incident', severity: 'critical', title: 'Node down — w1', clusterId: 'c1', incidentId: inc.id, fixable: true })
    const sent = at(`/tg/bot${token}/sendMessage`).at(-1).body
    assert.deepEqual(sent.reply_markup.inline_keyboard[0].map(b => b.callback_data), [`ack:${inc.id}`, `mute:${inc.id}`, `fix:${inc.id}`])

    const channel = notificationStore.channels('org-t')[0]
    const press = (chatId, data) => handleTelegramUpdate('org-t', channel, { update_id: 1, callback_query: { id: 'q1', data, from: { username: 'ravi' }, message: { message_id: 9, chat: { id: chatId, type: 'group', title: 'Ops' } } } })
    let r = await press(-100999, `ack:${inc.id}`)
    assert.equal(r.ok, false, 'buttons only work in the chat the channel posts to')
    assert.equal(inc.ackBy, undefined)
    r = await press(-100777, `ack:${inc.id}`)
    assert.equal(r.ok, true)
    assert.equal(inc.ackBy, '@ravi (Telegram)')
    assert.ok(at(`/tg/bot${token}/editMessageReplyMarkup`).length, 'buttons removed')
    assert.match(at(`/tg/bot${token}/sendMessage`).at(-1).body.text, /✓ Acknowledged by @ravi/)
    assert.match(at(`/tg/bot${token}/answerCallbackQuery`).at(-1).body.text, /Acknowledged/)

    // recovery messages carry no buttons
    await notifier.notify('org-t', { type: 'incident_resolved', severity: 'success', recovery: true, title: 'Fixed: Node down — w1', clusterId: 'c1', incidentId: inc.id })
    assert.equal(at(`/tg/bot${token}/sendMessage`).at(-1).body.reply_markup, undefined)
})
