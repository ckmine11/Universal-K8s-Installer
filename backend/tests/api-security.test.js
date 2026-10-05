// Tenant isolation, RBAC and auth hardening — against the real HTTP server.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, client } from './helpers/server.js'

let srv, api, root, alice, bob

const register = async (u) => (await api('POST', '/api/auth/register', null, { username: u, password: 'secret123', email: `${u}@example.com` })).data

// Opens a WebSocket, optionally sends one message, resolves on close/timeout
function ws(p, token, send) {
    return new Promise(resolve => {
        const sock = new WebSocket(`${srv.url.replace('http', 'ws')}${p}?token=${token}`)
        const msgs = []
        sock.on('open', () => { if (send) sock.send(JSON.stringify(send)) })
        sock.on('message', m => msgs.push(JSON.parse(m)))
        sock.on('close', code => resolve({ code, msgs }))
        setTimeout(() => sock.close(), 2500)
    })
}

before(async () => {
    srv = await startServer()
    api = client(srv)
    root = (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data
    alice = await register('alice')
    bob = await register('bob')
    // alice owns two clusters (one legacy record without orgId)
    fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
        { id: 'c-alice', ownerId: alice.user.id, orgId: alice.user.orgId, clusterName: 'a', masterNodes: [{ ip: '10.255.255.1', username: 'root', password: 'pw' }], workerNodes: [], status: 'healthy' },
        { id: 'c-legacy', ownerId: alice.user.id, clusterName: 'legacy', masterNodes: [{ ip: '10.255.255.2', username: 'root' }], workerNodes: [], status: 'failed' },
        { id: 'c-root', ownerId: root.user.id, orgId: root.user.orgId, clusterName: 'r', masterNodes: [{ ip: '10.255.255.3', username: 'root' }], workerNodes: [], status: 'healthy' }
    ]))
})
after(() => srv?.stop())

test('the platform Super Admin comes from make-superadmin; every sign-up is an org admin', () => {
    assert.equal(root.user.role, 'superadmin')
    assert.equal(alice.user.role, 'admin')
    assert.notEqual(alice.user.orgId, bob.user.orgId)
})

test('registration validates input', async () => {
    const r = await api('POST', '/api/auth/register', null, { username: 'x', password: '1', email: 'bad' })
    assert.equal(r.status, 400)
})

test('cluster list is scoped to the workspace', async () => {
    assert.equal((await api('GET', '/api/clusters/list', alice.token)).data.length, 2)
    assert.equal((await api('GET', '/api/clusters/list', bob.token)).data.length, 0)
})

for (const [method, p] of [
    ['GET', '/api/clusters/c-alice/kubeconfig'], ['DELETE', '/api/clusters/c-alice'],
    ['POST', '/api/clusters/c-alice/upgrade'], ['POST', '/api/clusters/c-alice/addons'],
    ['GET', '/api/clusters/c-alice/health'], ['POST', '/api/clusters/c-alice/analyze'],
    ['GET', '/api/clusters/c-alice/addons/access'], ['GET', '/api/clusters/c-alice/etcd/backups'],
    ['GET', '/api/clusters/c-alice/addons/status'], ['GET', '/api/clusters/c-alice/addons/seaweedfs/logs'],
    ['POST', '/api/clusters/c-alice/addons/seaweedfs/uninstall'], ['POST', '/api/clusters/c-alice/addons/seaweedfs/reinstall']
]) {
    test(`another tenant gets 403: ${method} ${p}`, async () => {
        assert.equal((await api(method, p, bob.token, {})).status, 403)
    })
}

test('add-on uninstall needs a known add-on and an explicit confirmation', async () => {
    const base = '/api/clusters/c-alice/addons'
    assert.equal((await api('POST', `${base}/nope/uninstall`, alice.token, { confirm: 'nope' })).status, 400)
    assert.equal((await api('POST', `${base}/seaweedfs/uninstall`, alice.token, {})).status, 400)
    assert.equal((await api('POST', `${base}/seaweedfs/uninstall`, alice.token, { confirm: 'longhorn' })).status, 400)
    assert.equal((await api('POST', `${base}/seaweedfs/reinstall`, alice.token, {})).status, 400)
    assert.equal((await api('POST', `${base}/seaweedfs/explode`, alice.token, { confirm: 'seaweedfs' })).status, 404)
    assert.equal((await api('GET', `${base}/seaweedfs/logs?pod=${encodeURIComponent('x; rm -rf /')}`, alice.token)).status, 400)
})

test('tenant admins cannot activate or generate licenses', async () => {
    assert.equal((await api('POST', '/api/license/activate', alice.token, { licenseKey: 'x' })).status, 403)
    assert.equal((await api('POST', '/api/license/generate', alice.token, {})).status, 403)
})

test('unreachable master fails the install (no fake "completed" cluster)', async () => {
    const inst = await api('POST', '/api/clusters/install', root.token, { clusterName: 'z', k8sVersion: '1.35.0', masterNodes: [{ ip: '127.0.0.1', username: 'root', password: 'x' }] })
    assert.equal(inst.status, 200)
    const id = inst.data.installationId

    assert.equal((await api('GET', `/api/clusters/${id}/status`, bob.token)).status, 403)
    assert.equal((await api('POST', `/api/clusters/${id}/cancel`, bob.token)).status, 403)

    let st
    for (let i = 0; i < 60; i++) {
        st = (await api('GET', `/api/clusters/${id}/status`, root.token)).data
        if (st.status !== 'running') break
        await new Promise(r => setTimeout(r, 500))
    }
    assert.equal(st.status, 'failed')
    assert.match(st.error, /aborted/)

    assert.equal((await ws(`/ws/installation/${id}`, bob.token)).code, 4003, 'other tenant cannot stream logs')
    assert.ok((await ws(`/ws/installation/${id}`, root.token)).msgs.some(m => m.type === 'log'), 'owner can stream logs')
})

test('WebSocket streams are tenant-scoped', async () => {
    const orb = await ws('/ws/orbital/c-alice', bob.token, { type: 'command', clusterId: 'c-alice', nodes: [{ ip: '10.255.255.1' }], command: 'id' })
    assert.ok(orb.msgs.some(m => /Unauthorized/.test(m.content || '')))
    assert.ok(!orb.msgs.some(m => m.nodeIp === '10.255.255.1'), 'no command ran on another tenant\'s node')
})

test('role changes apply to existing tokens immediately', async () => {
    await api('PUT', `/api/superadmin/users/${bob.user.id}/role`, root.token, { role: 'viewer' })
    assert.equal((await api('GET', '/api/auth/me', bob.token)).data.role, 'viewer')
    assert.equal((await ws('/ws/orbital/x', bob.token)).code, 4003, 'viewer cannot open the terminal')
    assert.equal((await api('PUT', `/api/superadmin/users/${bob.user.id}/role`, root.token, { role: 'user' })).status, 400)
})

test('superadmin responses never include password hashes', async () => {
    const r = await api('PUT', `/api/superadmin/users/${bob.user.id}/status`, root.token, { isSuspended: false })
    assert.ok(r.data.user && !('password' in r.data.user))
})

test('workspace cluster quota counts org clusters (incl. legacy)', async () => {
    const r = await api('POST', '/api/clusters/install', alice.token, { clusterName: 'q', k8sVersion: '1.35.0', masterNodes: [{ ip: '127.0.0.1', username: 'root', password: 'x' }] })
    assert.equal(r.status, 402)
    assert.match(r.data.error, /currently managing 2/)
})

test('no free PRO upgrade without STRIPE_MOCK', async () => {
    assert.equal((await api('POST', '/api/stripe/create-checkout-session', alice.token, { planId: 'pro' })).status, 503)
})

test('offsite backup API: plan-gated, tenant-scoped, validated', async () => {
    assert.equal((await api('GET', '/api/offsite', alice.token)).status, 402, 'Free plan cannot use offsite backups')
    const view = await api('GET', '/api/offsite', root.token)
    assert.equal(view.status, 200)
    assert.equal(view.data.connected, false)
    const good = { provider: 'minio', endpoint: 'http://minio.local:9000', bucket: 'kubeez-backups', accessKey: 'a', secretKey: 'b' }
    assert.equal((await api('POST', '/api/offsite/test', root.token, good)).status, 400, 'clusterId required')
    assert.equal((await api('POST', '/api/offsite/test', root.token, { ...good, clusterId: 'c-alice' })).status, 403, 'cannot test from another tenant cluster')
    const bad = await api('PUT', '/api/offsite', root.token, { ...good, bucket: 'Bad_Bucket', clusterId: 'c-root' })
    assert.equal(bad.status, 400)
    assert.match(bad.data.error, /Bucket name/)
    assert.equal((await api('POST', '/api/offsite/sync', root.token, { clusterId: 'c-root' })).status, 400, 'sync needs a connection')
    assert.equal((await api('GET', '/api/offsite/recovery-key', root.token)).status, 404)
})

test('passwords never appear in request logs', async () => {
    await api('POST', '/api/auth/change-password', alice.token, { currentPassword: 'secret123', newPassword: 'NEWSECRETxyz' })
    const logs = srv.logs()
    assert.ok(!logs.includes('NEWSECRETxyz') && !logs.includes('secret123'))
})
