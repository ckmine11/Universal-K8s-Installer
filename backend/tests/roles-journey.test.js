// Every role, end to end on a real server: an admin creates a viewer and an
// operator, resets their passwords, they sign in and change their own; the
// terminal works for each role as it should (admin at once, operator after
// approval, viewer never).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { startServer, client } from './helpers/server.js'

let srv, api, root, ann
before(async () => {
    srv = await startServer()
    api = client(srv)
    root = (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data
    ann = (await api('POST', '/api/auth/register', null, { username: 'annj', password: 'annpass123', email: 'annj@example.com' })).data
    await api('PUT', `/api/superadmin/users/${ann.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 5 })
    fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
        { id: 'c-ann', ownerId: ann.user.id, orgId: ann.user.orgId, clusterName: 'prod', masterNodes: [{ ip: '10.255.255.7', username: 'root', password: 'pw' }], workerNodes: [], status: 'healthy' }
    ]))
})
after(() => srv?.stop?.())

function ws(p, token, send, ms = 2500) {
    return new Promise(resolve => {
        const sock = new WebSocket(`${srv.url.replace('http', 'ws')}${p}?token=${token}`)
        const msgs = []
        sock.on('open', () => { if (send) sock.send(JSON.stringify(send)) })
        sock.on('message', m => msgs.push(JSON.parse(m)))
        sock.on('close', code => resolve({ code, msgs }))
        setTimeout(() => sock.close(), ms)
    })
}
const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p }))

test('team: admin creates a viewer and an operator, resets their passwords; they sign in and change their own', async () => {
    let r = await api('POST', '/api/admin/users', ann.token, { username: 'vina', password: 'vinapass123', email: 'vina@example.com', role: 'viewer' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    r = await api('POST', '/api/admin/users', ann.token, { username: 'opal', password: 'opalpass123', email: 'opal@example.com', role: 'operator' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const list = (await api('GET', '/api/admin/users', ann.token)).data
    const users = Array.isArray(list) ? list : list.users
    const vina = users.find(u => u.username === 'vina'), opal = users.find(u => u.username === 'opal')
    const old = (await login('vina', 'vinapass123')).data

    for (const [u, pw] of [[vina, 'NewViewer2026'], [opal, 'NewOperator2026']]) {
        r = await api('POST', `/api/admin/users/${u.id}/reset-password`, ann.token, { newPassword: pw })
        assert.equal(r.status, 200, `reset ${u.username}: ${JSON.stringify(r.data)}`)
        assert.equal((await login(u.username, pw)).status, 200, `${u.username} signs in with the new password`)
    }
    assert.equal((await api('GET', '/api/auth/me', old.token)).status, 401, 'sessions from before the reset end')
    assert.equal((await login('vina', 'vinapass123')).status, 401, 'the old password no longer works')
    r = await api('POST', `/api/admin/users/${vina.id}/reset-password`, ann.token, { newPassword: 'short' })
    assert.deepEqual([r.status, r.data.error], [400, 'Password must be at least 8 characters'])

    // the viewer changes her own password; a wrong current one is an error message, not a logout (401)
    const v = (await login('vina', 'NewViewer2026')).data
    r = await api('POST', '/api/auth/change-password', v.token, { currentPassword: 'wrong-one-2026', newPassword: 'ViewerOwn2026' })
    assert.deepEqual([r.status, r.data.error], [400, 'Current password is incorrect'])
    r = await api('POST', '/api/auth/change-password', v.token, { currentPassword: 'NewViewer2026', newPassword: 'ViewerOwn2026' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal((await login('vina', 'ViewerOwn2026')).status, 200)
    // a viewer / operator cannot reset others
    const o = (await login('opal', 'NewOperator2026')).data
    assert.equal((await api('POST', `/api/admin/users/${vina.id}/reset-password`, o.token, { newPassword: 'Whatever2026' })).status, 403)
    assert.ok(auditTrail().some(e => e.action === 'POST /api/admin/users/:id/reset-password' && e.ok), 'resets are in the audit trail')
})

function auditTrail() {
    const dir = path.join(srv.dataDir, 'audit')
    return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
}

test('terminal: the admin gets in at once, the operator after approval, the viewer never', async () => {
    const cmd = { type: 'command', clusterId: 'c-ann', nodes: [{ ip: '10.255.255.7' }], command: 'uptime' }
    // admin: opening the terminal is enough (recorded), no reason form
    let mine = (await api('GET', '/api/terminal/grants/mine?clusterId=c-ann', ann.token)).data
    assert.equal(mine.active, null)
    let r = await api('POST', '/api/terminal/grants', ann.token, { clusterId: 'c-ann' })
    assert.deepEqual([r.status, r.data.status], [201, 'active'], `admin without a reason: ${JSON.stringify(r.data)}`)
    let orb = await ws('/ws/orbital/c-ann', ann.token, cmd)
    assert.ok(!orb.msgs.some(m => m.type === 'access-required'), 'the admin runs commands')

    // operator: asks with a reason, the admin approves, then it works
    const opal = (await login('opal', 'NewOperator2026')).data
    orb = await ws('/ws/orbital/c-ann', opal.token, cmd)
    assert.ok(orb.msgs.some(m => m.type === 'access-required'), 'operator without approval')
    r = await api('POST', '/api/terminal/grants', opal.token, { clusterId: 'c-ann' })
    assert.equal(r.status, 400, 'operators say why')
    r = await api('POST', '/api/terminal/grants', opal.token, { clusterId: 'c-ann', reason: 'restart the stuck ingress pod', minutes: 30 })
    assert.deepEqual([r.status, r.data.status], [201, 'pending'])
    r = await api('POST', `/api/terminal/grants/${r.data.id}/approve`, ann.token)
    assert.equal(r.data.status, 'active')
    orb = await ws('/ws/orbital/c-ann', opal.token, cmd)
    assert.ok(!orb.msgs.some(m => m.type === 'access-required'), 'operator runs commands after approval')

    // workspace without approvals: operators get in at once too
    await api('PUT', '/api/terminal/settings', ann.token, { requireApproval: false })
    assert.equal((await api('GET', '/api/terminal/grants/mine?clusterId=c-ann', opal.token)).data.requireApproval, false)
    await api('PUT', '/api/terminal/settings', ann.token, { requireApproval: true })

    // viewer: no terminal at all
    const vina = (await login('vina', 'ViewerOwn2026')).data
    assert.equal((await api('POST', '/api/terminal/grants', vina.token, { clusterId: 'c-ann', reason: 'just looking around', minutes: 15 })).status, 403)
    assert.equal((await ws('/ws/orbital/c-ann', vina.token, cmd)).code, 4003)
    const sessions = (await api('GET', '/api/terminal/sessions', ann.token)).data.sessions
    assert.ok(sessions.filter(s => s.user === 'annj').length >= 1 && sessions.filter(s => s.user === 'opal').length >= 1, 'both sessions recorded')
})
