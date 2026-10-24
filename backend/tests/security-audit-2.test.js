// Security audit (2026-10-24), against the real server: closed sign-up on a
// self-hosted server, sign-out ends the token, no tokens in URLs, node checks
// need a role that adds servers, audit CSV cells are never formulas, the
// optional CAPTCHA on public forms.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, client } from './helpers/server.js'

let srv, api, root, alice, viewer
const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p }))

before(async () => {
    srv = await startServer()
    api = client(srv)
    root = (await login('root', 'secret123')).data
    alice = (await api('POST', '/api/auth/register', null, { username: 'alice', password: 'alicepass1', email: 'alice@example.com' })).data
    await api('PUT', `/api/superadmin/users/${alice.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 10, maxNodes: 50, maxMembers: 5 })
    assert.equal((await api('POST', '/api/admin/users', alice.token, { username: 'vic', password: 'viewerpass1', email: 'v@example.com', role: 'viewer' })).status, 200)
    viewer = (await login('vic', 'viewerpass1')).data
})
after(() => srv?.stop())

test('self-hosted: after the setup, sign-up is closed unless the operator opens it', async () => {
    const sh = await startServer({ KUBEEZ_MODE: 'self-hosted' })
    try {
        const call = client(sh)
        assert.equal((await call('POST', '/api/auth/setup', null, { username: 'owner', password: 'ownerpass1', email: 'o@example.com' })).status, 200)
        assert.equal((await call('GET', '/api/auth/options')).data.signup, false)
        const r = await call('POST', '/api/auth/register', null, { username: 'stranger', password: 'strangerpass1', email: 's@example.com' })
        assert.equal(r.status, 403)
        assert.match(r.data.error, /closed/)
        assert.equal((await call('POST', '/api/auth/login', null, { username: 'stranger', password: 'strangerpass1' })).status, 401)
    } finally { await sh.stop() }
    const open = await startServer({ KUBEEZ_MODE: 'self-hosted', KUBEEZ_OPEN_SIGNUP: 'true' })
    try {
        const call = client(open)
        await call('POST', '/api/auth/setup', null, { username: 'owner', password: 'ownerpass1', email: 'o@example.com' })
        assert.equal((await call('GET', '/api/auth/options')).data.signup, true)
        assert.equal((await call('POST', '/api/auth/register', null, { username: 'member', password: 'memberpass1', email: 'm@example.com' })).status, 200)
    } finally { await open.stop() }
    // KubeEZ cloud: sign-up stays open
    assert.equal((await api('GET', '/api/auth/options')).data.signup, true)
})

test('signing out ends the token itself, not only the cookie', async () => {
    const s = (await login('vic', 'viewerpass1')).data
    assert.equal((await api('GET', '/api/auth/me', s.token)).status, 200)
    assert.equal((await api('POST', '/api/auth/logout', s.token)).status, 200)
    assert.equal((await api('GET', '/api/auth/me', s.token)).status, 401, 'a copied token stops working')
    // other sessions of the same member go on
    assert.equal((await api('GET', '/api/auth/me', viewer.token)).status, 200)
})

test('a session token in the address (?token=) is not accepted', async () => {
    const r = await fetch(`${srv.url}/api/auth/me?token=${alice.token}`)
    assert.equal(r.status, 401)
    const ok = await fetch(`${srv.url}/api/auth/me`, { headers: { cookie: `token=${alice.token}` } })
    assert.equal(ok.status, 200)
})

test('a viewer cannot make the server SSH to an address (node verification)', async () => {
    for (const p of ['/api/nodes/verify', '/api/nodes/verify-batch']) {
        const r = await api('POST', p, viewer.token, p.endsWith('batch') ? { nodes: [{ ip: '203.0.113.9', username: 'root', password: 'x' }] } : { ip: '203.0.113.9', username: 'root', password: 'x' })
        assert.equal(r.status, 403, p)
    }
    // an admin still gets as far as the check itself
    const r = await api('POST', '/api/nodes/verify', alice.token, { ip: '', username: '' })
    assert.equal(r.status, 400)
})

test('audit CSV: a username typed as a formula comes out as text', async () => {
    await api('POST', '/api/auth/login', null, { username: 'alice', password: 'wrong-password' })
    await api('POST', '/api/auth/login', null, { username: '=HYPERLINK("https://evil.example","x")', password: 'x' })
    const r = await fetch(`${srv.url}/api/compliance/audit.csv?all=1`, { headers: { Authorization: `Bearer ${root.token}` } })
    assert.equal(r.status, 200)
    const csv = await r.text()
    assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.example""/)
    assert.doesNotMatch(csv, /(^|,)"=HYPERLINK/m)
})

test('a compliance job is only visible in its own workspace', async () => {
    const r = await api('GET', '/api/compliance/jobs/00000000-0000-4000-8000-000000000000', alice.token)
    assert.equal(r.status, 404)
})

test('CAPTCHA (when its keys are set): sign-up and forgot-password need a solved check', async () => {
    const c = await startServer({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' })
    try {
        const call = client(c)
        assert.equal((await call('GET', '/api/auth/options')).data.captchaSiteKey, '1x00000000000000000000AA')
        const reg = await call('POST', '/api/auth/register', null, { username: 'bot', password: 'botpass123', email: 'b@example.com' })
        assert.equal(reg.status, 400)
        assert.equal(reg.data.code, 'CAPTCHA')
        assert.equal((await call('POST', '/api/auth/forgot-password', null, { identifier: 'bot' })).data.code, 'CAPTCHA')
    } finally { await c.stop() }
    // off by default
    assert.equal((await api('GET', '/api/auth/options')).data.captchaSiteKey, null)
})

test('member WebSockets: a token in the address is refused; the header / cookie works', async () => {
    const { default: WebSocket } = await import('ws')
    const close = (url, opts) => new Promise(resolve => {
        const s = new WebSocket(url, opts)
        // refused: closed at once with 4001; accepted: still open a moment later
        const t = setTimeout(() => { resolve('open'); s.terminate() }, 800)
        s.on('close', (code) => { clearTimeout(t); resolve(code) })
        s.on('error', () => { clearTimeout(t); resolve('error') })
    })
    const base = srv.url.replace('http', 'ws')
    assert.equal(await close(`${base}/ws/orbital/x?token=${alice.token}`), 4001)
    assert.notEqual(await close(`${base}/ws/orbital/x`, { headers: { Authorization: `Bearer ${alice.token}` } }), 4001)
    assert.notEqual(await close(`${base}/ws/orbital/x`, { headers: { cookie: `token=${alice.token}` } }), 4001)
})

test('agent tokens: never in clear on disk; an old plain-text agents.json is converted', async () => {
    const fs = await import('node:fs'), path = await import('node:path')
    const r = await api('POST', '/api/agent/token', alice.token, { label: 'gw' })
    assert.equal(r.status, 200)
    const disk = fs.readFileSync(path.join(srv.dataDir, 'agents.json'), 'utf8')
    assert.ok(!disk.includes(r.data.token), 'the token is not in agents.json')
    const rec = JSON.parse(disk).find(a => a.agentId === r.data.agentId)
    assert.equal(rec.token, undefined); assert.match(rec.tokenHash, /^[0-9a-f]{64}$/); assert.match(rec.tokenEnc, /^v2:/)
    // the reinstall command still has the very same token
    const again = await api('GET', `/api/agent/${r.data.agentId}/install-command`, alice.token)
    assert.ok(again.data.installCommandLinux.includes(`--token ${r.data.token}`))

    // a server whose agents.json predates this: converted when it starts
    const { tempDataDir } = await import('./helpers/server.js')
    const dir = tempDataDir()
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{ agentId: 'legacy-1', token: 'plain-legacy-token-123', ownerId: 'u', orgId: 'o', label: 'old', registeredNodeIps: [], status: 'offline' }]))
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, ['--input-type=module', '-e', `const { agentService } = await import('./src/services/agentService.js'); await new Promise(r => setTimeout(r, 300)); const a = await agentService.getAgentByToken('plain-legacy-token-123'); console.log(a?.agentId); process.exit(0)`], { cwd: process.cwd(), env: { ...process.env, KUBEEZ_DATA_DIR: dir, APP_SECRET: 'test-secret' }, stdio: 'pipe' })
    const conv = fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')
    assert.ok(!conv.includes('plain-legacy-token-123'), 'converted on start')
    assert.match(JSON.parse(conv)[0].tokenHash, /^[0-9a-f]{64}$/)
    fs.rmSync(dir, { recursive: true, force: true })
})
