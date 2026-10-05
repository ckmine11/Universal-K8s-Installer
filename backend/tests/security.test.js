// Security audit fixes, against the real server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, client } from './helpers/server.js'
import { isPrivateAddress } from '../src/utils/netGuard.js'

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
    fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
        { id: 'c-a', ownerId: alice.user.id, orgId: alice.user.orgId, clusterName: 'a', k8sVersion: '1.35.0', status: 'healthy',
          masterNodes: [{ ip: '203.0.113.10', username: 'root', password: 'TopSecretPw' }], workerNodes: [] }
    ]))
})
after(() => srv?.stop())

test('SaaS: a sign-up never becomes Super Admin (even the first one)', async () => {
    const fresh = await startServer({ NO_SUPERADMIN: '1' })
    try {
        const first = (await client(fresh)('POST', '/api/auth/register', null, { username: 'first', password: 'firstpass1', email: 'f@example.com' })).data
        assert.equal(first.user.role, 'admin')
    } finally { await fresh.stop() }
})

test('self-hosted: nobody can register before the initial setup', async () => {
    const sh = await startServer({ KUBEEZ_MODE: 'self-hosted' })
    try {
        const call = client(sh)
        assert.equal((await call('POST', '/api/auth/register', null, { username: 'early', password: 'earlypass1', email: 'e@example.com' })).status, 403)
        const setup = await call('POST', '/api/auth/setup', null, { username: 'owner', password: 'ownerpass1', email: 'o@example.com' })
        assert.equal(setup.data.user.role, 'superadmin')
        const later = await call('POST', '/api/auth/register', null, { username: 'later', password: 'laterpass1', email: 'l@example.com' })
        assert.equal(later.data.user.role, 'admin')
    } finally { await sh.stop() }
})

test('SSH passwords never reach the browser', async () => {
    const list = (await api('GET', '/api/clusters/list', alice.token)).data
    const node = list[0].masterNodes[0]
    assert.equal(node.password, undefined)
    assert.equal(node.hasPassword, true)
    assert.ok(!JSON.stringify(list).includes('TopSecretPw'))
})

test('server internals are for the platform Super Admin only', async () => {
    assert.equal((await api('GET', '/api/health/detailed', alice.token)).status, 403)
    assert.equal((await api('GET', '/api/health/detailed', root.token)).status, 200)
})

test('SaaS: the server will not SSH into internal addresses itself', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.5']) {
        const r = await api('POST', '/api/nodes/verify', alice.token, { ip, username: 'root', password: 'x' })
        assert.match(JSON.stringify(r.data), /private\/internal address/, ip)
    }
    assert.equal(isPrivateAddress('8.8.8.8'), false)
    assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true)
    assert.equal(isPrivateAddress('fd00::1'), true)
})

test('install input is validated before anything runs', async () => {
    const bad = [
        { clusterName: 'x$(id)', k8sVersion: '1.35.0', masterNodes: [{ ip: '203.0.113.5', username: 'root', password: 'p' }] },
        { clusterName: 'ok', k8sVersion: '1.35.0;reboot', masterNodes: [{ ip: '203.0.113.5', username: 'root', password: 'p' }] },
        { clusterName: 'ok', k8sVersion: '1.35.0', masterNodes: [{ ip: '203.0.113.5;id', username: 'root', password: 'p' }] },
        { clusterName: 'ok', k8sVersion: '1.35.0', networkPlugin: 'weave; rm', masterNodes: [{ ip: '203.0.113.5', username: 'root', password: 'p' }] }
    ]
    for (const body of bad) assert.equal((await api('POST', '/api/clusters/install', alice.token, body)).status, 400, JSON.stringify(body))
})

test('weak passwords are refused (sign-up and team members)', async () => {
    assert.equal((await api('POST', '/api/auth/register', null, { username: 'weak', password: 'short', email: 'w@example.com' })).status, 400)
    assert.equal((await api('POST', '/api/admin/users', alice.token, { username: 'tiny', password: '1', role: 'viewer' })).status, 400)
})

test('only workspace admins can start a plan purchase', async () => {
    const r = await api('POST', '/api/stripe/create-checkout-session', viewer.token, { planId: 'pro' })
    assert.equal(r.status, 403)
})

test('members see the WORKSPACE plan', async () => {
    const sub = (await api('GET', '/api/billing/subscription', viewer.token)).data
    assert.equal(sub.plan, 'PRO')
    assert.equal(sub.isOwner, false)
})

test('WebSocket from a foreign web page is refused', async () => {
    const code = await new Promise(resolve => {
        const s = new WebSocket(`${srv.url.replace('http', 'ws')}/ws/installation/x?token=${alice.token}`, { headers: { Origin: 'https://evil.example' } })
        s.on('unexpected-response', (req, res) => resolve(res.statusCode))
        s.on('open', () => { s.close(); resolve('opened') })
        s.on('error', () => resolve('error'))
    })
    assert.equal(code, 401)
})

test('an account is locked after 10 wrong passwords (also against distributed guessing)', async () => {
    await api('POST', '/api/auth/register', null, { username: 'target', password: 'targetpass1', email: 't@example.com' })
    // the per-IP limiter allows 15 failed tries; the account locks at 10
    for (let i = 0; i < 10; i++) await login('target', 'wrong-' + i)
    const r = await login('target', 'targetpass1')
    assert.equal(r.status, 401)
    assert.match(r.data.error, /Too many failed attempts/)
})
