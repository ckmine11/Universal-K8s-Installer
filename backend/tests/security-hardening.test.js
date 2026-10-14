// Security hardening: just-in-time terminal access with recorded sessions,
// the Gateway Agent's TLS-only link (token in a header), bring-your-own-key /
// rotation for offsite backups, security headers, the add-on image scan.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret-0123456789abcdef0123456789'
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(BACKEND, '..')

const { terminalAccess, terminalRecorder } = await import('../src/services/terminalAccess.js')
const { auditLog } = await import('../src/services/auditLog.js')
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const cluster = { id: 'c1', clusterName: 'prod', orgId: 'o1' }
const admin = { id: 'a1', username: 'asha', role: 'admin', orgId: 'o1' }
const op = { id: 'p1', username: 'ravi', role: 'operator', orgId: 'o1' }
const outsider = { id: 'x1', username: 'mallory', role: 'admin', orgId: 'o2' }

// ── just-in-time terminal access ──
test('terminal access: a reason and a time limit; admins at once, operators after approval', () => {
    assert.throws(() => terminalAccess.request(op, cluster, { reason: 'x', minutes: 30 }), /Say why/)
    assert.throws(() => terminalAccess.request(op, cluster, { reason: 'debug pods', minutes: 9999 }), /Choose 15, 30, 60, 120/)
    const a = terminalAccess.request(admin, cluster, { reason: 'rotate certificates', minutes: 15 })
    assert.equal(a.status, 'active')
    assert.match(a.decidedBy, /own admin access/)
    assert.ok(terminalAccess.activeGrant('a1', 'c1'))

    const g = terminalAccess.request(op, cluster, { reason: 'check disk on node 2', minutes: 30 })
    assert.equal(g.status, 'pending', 'approval required by default')
    assert.equal(terminalAccess.activeGrant('p1', 'c1'), null)
    assert.throws(() => terminalAccess.request(op, cluster, { reason: 'again please', minutes: 30 }), /already asked/)
    assert.throws(() => terminalAccess.decide(g.id, outsider, true), /not found/, 'another workspace cannot approve')
    const ok = terminalAccess.decide(g.id, admin, true)
    assert.equal(ok.status, 'active')
    assert.ok(Math.abs(Date.parse(ok.expiresAt) - Date.now() - 30 * 60e3) < 5000, 'the time starts at approval')
    assert.ok(terminalAccess.activeGrant('p1', 'c1'))
    assert.throws(() => terminalAccess.decide(g.id, admin, false), /already active/)
    terminalAccess.revoke(g.id, admin)
    assert.equal(terminalAccess.activeGrant('p1', 'c1'), null, 'ended at once')
    assert.equal(terminalAccess.activeGrant('p1', 'c1', Date.now()), null)
    assert.equal(terminalAccess.activeGrant('a1', 'c1', Date.now() + 16 * 60e3), null, 'expires by itself')

    const d = terminalAccess.request(op, cluster, { reason: 'look at logs', minutes: 15 })
    assert.equal(terminalAccess.decide(d.id, admin, false).status, 'denied')
    terminalAccess.setSettings('o1', { requireApproval: false }, admin)
    const quick = terminalAccess.request(op, cluster, { reason: 'urgent restart', minutes: 15 })
    assert.equal(quick.status, 'active', 'workspace without approval')
    terminalAccess.revoke(quick.id, op)
    terminalAccess.setSettings('o1', { requireApproval: true }, admin)

    const actions = auditLog.query({ orgId: 'o1' }).map(e => e.action)
    for (const a of ['terminal.access_granted', 'terminal.access_requested', 'terminal.access_approved', 'terminal.access_denied', 'terminal.access_revoked', 'terminal.settings']) assert.ok(actions.includes(a), a)
})

test('terminal recordings: commands and output kept per session, scoped to the workspace, capped', () => {
    const id = terminalRecorder.start({ orgId: 'o1', clusterId: 'c1', clusterName: 'prod', user: { id: 'a1', username: 'asha', role: 'admin' }, grantId: 'g1', reason: 'rotate certificates', ip: '10.1.1.1' })
    terminalRecorder.command(id, ['10.0.0.4', '10.0.0.5'], 'kubeadm certs check-expiration')
    terminalRecorder.output(id, '10.0.0.4', 'stdout', 'CERTIFICATE EXPIRES\nadmin.conf Oct 2027\n')
    terminalRecorder.output(id, '10.0.0.4', 'stdout', 'x'.repeat(3 * 1024 * 1024))
    terminalRecorder.end(id, 'closed')
    const list = terminalRecorder.list({ orgId: 'o1' })
    assert.deepEqual([list[0].id, list[0].user, list[0].commands, list[0].reason, list[0].live], [id, 'asha', 1, 'rotate certificates', false])
    assert.equal(terminalRecorder.list({ orgId: 'o2' }).length, 0)
    const ev = terminalRecorder.get(id, 'o1')
    assert.deepEqual(ev.map(e => e.type), ['start', 'cmd', 'out', 'out', 'note', 'end'])
    assert.equal(ev[1].command, 'kubeadm certs check-expiration')
    assert.ok(ev.filter(e => e.type === 'out').reduce((n, e) => n + e.text.length, 0) <= 2 * 1024 * 1024, 'output capped at 2 MB')
    assert.equal(terminalRecorder.get(id, 'o2'), null)
    assert.equal(terminalRecorder.get('../../etc/passwd', null), null)
    assert.ok(auditLog.query({ orgId: 'o1', action: 'terminal.command' })[0].detail.includes('kubeadm certs check-expiration'))
})

// ── API ──
let srv, url
before(async () => {
    const { authService } = await import('../src/services/authService.js')
    const { requireAuth } = await import('../src/middleware/authMiddleware.js')
    const { clusterStore } = await import('../src/services/clusterStore.js')
    await clusterStore.saveCluster({ id: 'c1', clusterName: 'prod', orgId: 'o1', ownerId: 'a1', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [] })
    const users = { admin, op, view: { id: 'v1', username: 'vik', role: 'viewer', orgId: 'o1' } }
    authService.verifyToken = (t) => users[t] || null
    const { default: routes } = await import('../src/routes/terminal.js')
    const app = express(); app.use(express.json()); app.use('/api/terminal', requireAuth, routes)
    srv = http.createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${srv.address().port}/api/terminal`
})
after(() => srv?.close())
const call = (method, p, tok, body) => fetch(url + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

test('API: operators ask, admins approve and see the recordings; viewers have no terminal', async () => {
    assert.equal((await call('POST', '/grants', 'view', { clusterId: 'c1', reason: 'look around', minutes: 15 })).status, 403)
    let r = await call('POST', '/grants', 'op', { clusterId: 'c1', reason: 'restart a stuck pod', minutes: 15 })
    const g = await r.json()
    assert.deepEqual([r.status, g.status], [201, 'pending'])
    assert.equal((await call('GET', '/grants', 'op')).status, 403, 'operators cannot approve')
    const mine = await (await call('GET', '/grants/mine?clusterId=c1', 'op')).json()
    assert.equal(mine.active, null)
    assert.ok(mine.grants.some(x => x.id === g.id))
    r = await call('POST', `/grants/${g.id}/approve`, 'admin')
    assert.equal((await r.json()).status, 'active')
    assert.ok((await (await call('GET', '/grants/mine?clusterId=c1', 'op')).json()).active)
    assert.equal((await call('GET', '/sessions', 'op')).status, 403)
    const s = await (await call('GET', '/sessions', 'admin')).json()
    assert.ok(s.sessions.length >= 1)
    const txt = await (await call('GET', `/sessions/${s.sessions[0].id}?format=text`, 'admin')).text()
    assert.match(txt, /\$ kubeadm certs check-expiration/)
    assert.equal((await call('POST', '/grants', 'op', { clusterId: 'nope', reason: 'x y z w v', minutes: 15 })).status, 404)
})

// ── Gateway Agent ──
test('agent: TLS only (plain ws:// refused unless local or explicitly allowed); certificate checks cannot be turned off', async () => {
    execFileSync(process.execPath, ['build-agent.js'], { cwd: BACKEND, stdio: 'ignore' })
    const dir = fs.mkdtempSync(path.join(DATA, 'agent-'))
    fs.copyFileSync(path.join(BACKEND, 'public', 'agent-bundle.js'), path.join(dir, 'agent-bundle.js'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
    const run = (args, env = {}, ms = 2500) => new Promise(resolve => {
        const p = spawn(process.execPath, ['agent-bundle.js', '--token', 't', '--agent-id', 'a', ...args], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d)
        const t = setTimeout(() => { p.kill(); resolve({ code: 'running', out }) }, ms)
        p.on('exit', code => { clearTimeout(t); resolve({ code, out }) })
    })
    let r = await run(['--server', 'ws://kubeez.example.com'])
    assert.equal(r.code, 1)
    assert.match(r.out, /must use TLS \(wss:\/\/\)/)
    r = await run(['--server', 'ws://kubeez.example.com', '--allow-insecure', 'yes'])
    assert.equal(r.code, 'running', 'explicit opt-out for labs')
    r = await run(['--server', 'ws://127.0.0.1:9'])
    assert.equal(r.code, 'running', 'a KubeEZ on this machine')
    r = await run(['--server', 'wss://kubeez.example.com'], { NODE_TLS_REJECT_UNAUTHORIZED: '0' })
    assert.equal(r.code, 1)
    assert.match(r.out, /turns off certificate checks/)
    const src = fs.readFileSync(path.join(BACKEND, 'src/services/agent.js'), 'utf8')
    assert.match(src, /headers: \{ Authorization: `Bearer \$\{token\}` \}/, 'token in a header')
    assert.doesNotMatch(src, /\?token=\$\{/, 'never in the URL')
})

test('agent install command: the opt-out only when KubeEZ itself has no HTTPS, with a warning', async () => {
    const app = express()
    app.set('trust proxy', 1)
    const { agentService } = await import('../src/services/agentService.js')
    agentService.generateToken = async () => ({ agentId: 'ag1', token: 'tok', label: 'x', createdAt: 'now' })
    app.use((req, res, next) => { req.user = admin; next() })
    const { default: agentRoutes } = await import('../src/routes/agent.js')
    app.use(express.json()); app.use('/api', agentRoutes)
    const s = http.createServer(app); await new Promise(r => s.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${s.address().port}/api`
    const post = (proto) => fetch(`${base}/agent/token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': proto, authorization: 'Bearer admin' }, body: '{"label":"x"}' }).then(r => r.json())
    const https = await post('https')
    assert.doesNotMatch(https.installCommandLinux, /allow-insecure/)
    assert.equal(https.insecure, null)
    const plain = await post('http')
    assert.match(plain.installCommandLinux, /--server ws:\/\/.* --allow-insecure yes$/)
    assert.match(plain.insecure, /not encrypted/)
    s.close()
})

// ── offsite keys ──
test('offsite keys: bring your own key or rotate; older bundles stay readable with the earlier key', async () => {
    const { offsiteStore } = await import('../src/services/offsiteStore.js')
    const { offsiteService } = await import('../src/services/offsiteService.js')
    const { recoveryKey: first } = offsiteStore.connect('o9', { provider: 'aws', endpoint: 'https://s3.ap-south-1.amazonaws.com', region: 'ap-south-1', bucket: 'b', accessKey: 'AK', secretKey: 'SK' })
    assert.equal(first.length, 64)
    assert.throws(() => offsiteStore.setKey('o9', 'short'), /32 random characters/)
    assert.throws(() => offsiteStore.setKey('o9', 'a'.repeat(40)), /32 random characters/, 'not random')
    assert.throws(() => offsiteStore.setKey('o9', first), /in use already/)
    const mine = 'k9Lq2Xv7Rt4Zp8Wm1Nb6Hs3Jd5Gf0Yc!Ue'
    const r = offsiteStore.setKey('o9', mine, 'asha')
    assert.equal(r.keySource, 'customer')
    let v = offsiteStore.publicView('o9')
    assert.deepEqual([v.keySource, v.previousKeys], ['customer', 1])
    let full = offsiteStore.get('o9')
    assert.deepEqual([full.encKey, full.prevKeys], [mine, [first]])
    // reconnecting (new credentials) keeps the key history
    offsiteStore.connect('o9', { provider: 'aws', endpoint: 'https://s3.ap-south-1.amazonaws.com', region: 'ap-south-1', bucket: 'b', accessKey: 'AK2', secretKey: 'SK2' })
    full = offsiteStore.get('o9')
    assert.deepEqual([full.encKey, full.prevKeys, offsiteStore.publicView('o9').keySource], [mine, [first], 'customer'])
    // restore: the current key fails on an old bundle → the earlier key opens it
    const tried = []
    offsiteService._run = async (c, mode, env) => {
        const key = env.find(([k]) => k === 'KZ_ENC_KEY')[1]
        tried.push(key)
        return key === first ? { ok: true, recovery: [] } : { ok: false, code: 'BAD_KEY', error: 'wrong key' }
    }
    const got = await offsiteService.download({ id: 'c9' }, full, 'etcd-snapshot-2026.db')
    assert.equal(got.ok, true)
    assert.deepEqual(tried, [mine, first])
    const gen = offsiteStore.setKey('o9', null, 'asha')
    assert.equal(gen.keySource, 'kubeez')
    assert.equal(offsiteStore.publicView('o9').previousKeys, 2)
})

// ── headers, image scan ──
test('security headers: HSTS on every page location, no duplicates from the outer proxy, no deprecated X-XSS-Protection', () => {
    const inner = fs.readFileSync(path.join(ROOT, 'frontend/nginx.conf'), 'utf8')
    const outer = fs.readFileSync(path.join(ROOT, 'nginx/production.conf'), 'utf8')
    const blocksWithHeaders = inner.split(/\n\s*location /).filter(b => /add_header Referrer-Policy/.test(b))
    assert.ok(blocksWithHeaders.length >= 3)
    for (const b of blocksWithHeaders) assert.match(b, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/)
    assert.match(inner, /Content-Security-Policy "default-src 'self'/)
    assert.doesNotMatch(outer, /add_header (X-Frame-Options|X-Content-Type-Options|X-XSS-Protection|Referrer-Policy)/)
    assert.doesNotMatch(inner, /X-XSS-Protection/)
})

test('add-on image scan: the setting reaches the node; Block refuses, Warn reports, no scan when off', async () => {
    const sh = fs.readFileSync(path.join(BACKEND, 'src/automation/addons/helm-addon.sh'), 'utf8')
    assert.match(sh, /"\$TRIVY" image --quiet --scanners vuln --severity CRITICAL --ignore-unfixed/)
    assert.match(sh, /\[ "\$SCAN_MODE" = block \] && fail ADDON_CVE/)
    execFileSync('bash', ['-n', path.join(BACKEND, 'src/automation/addons/helm-addon.sh')])
    const { complianceStore } = await import('../src/services/complianceService.js')
    assert.throws(() => complianceStore.setAddonScan('o1', 'maybe'), /off, warn or block/)
    complianceStore.setAddonScan('o1', 'block')
    const { automationEngine } = await import('../src/services/automationEngine.js')
    const cmds = []
    const ssh = { execCommand: async (c) => { cmds.push(c); return { code: 0, stdout: '', stderr: '' } } }
    automationEngine.executeScript = async () => { }
    await automationEngine.installHelmAddon(ssh, { id: 'job1', originalClusterId: 'c1', orgId: 'o1', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [], addons: { 'metrics-server': true }, addonSettings: {} }, 'metrics-server', () => { })
    assert.ok(cmds.some(c => c.includes(`${Buffer.from('block').toString('base64')} | base64 -d | sudo tee /etc/kubeez/addons/metrics-server/scan`)), 'scan mode handed to the node')
    complianceStore.setAddonScan('o1', 'off')
    cmds.length = 0
    await automationEngine.installHelmAddon(ssh, { id: 'job2', originalClusterId: 'c1', orgId: 'o1', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [], addons: { 'metrics-server': true }, addonSettings: {} }, 'metrics-server', () => { })
    assert.ok(!cmds.some(c => c.includes('/metrics-server/scan')))
})

test('node shell: an unknown node or no current access never reaches SSH', async () => {
    const { openNodeShell } = await import('../src/services/nodeShell.js')
    const { EventEmitter } = await import('node:events')
    const fakeWs = () => Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)) }, close(code) { this.code = code; this.readyState = 3 } })
    const cl = { id: 'c-shell', clusterName: 'prod', orgId: 'o1', masterNodes: [{ ip: '10.0.0.4', username: 'root' }], workerNodes: [] }
    let ws = fakeWs()
    await openNodeShell({ ws, user: admin, cluster: cl, nodeIp: '10.9.9.9' })
    assert.deepEqual([ws.code, ws.sent[0].type], [4004, 'error'], 'a node outside the cluster')
    ws = fakeWs()
    await openNodeShell({ ws, user: op, cluster: cl, nodeIp: '10.0.0.4' })
    assert.deepEqual([ws.code, ws.sent[0].type], [4003, 'access-required'], 'no grant, no shell')
})
