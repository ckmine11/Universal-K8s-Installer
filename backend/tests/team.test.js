// Team & Roles: the workspace owner cannot be demoted / deleted / reset by
// another admin, and a password change or reset ends older sessions.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, client } from './helpers/server.js'

let srv, api, root, owner, admin2

const login = async (username, password) => (await api('POST', '/api/auth/login', null, { username, password })).data
const me = async (token) => (await api('GET', '/api/auth/me', token)).status

before(async () => {
    srv = await startServer()
    api = client(srv)
    root = (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data
    owner = (await api('POST', '/api/auth/register', null, { username: 'owner', password: 'secret123', email: 'owner@example.com' })).data
    // Give the workspace seats, then add a second admin
    assert.equal((await api('PUT', `/api/superadmin/users/${owner.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 10, maxNodes: 50, maxMembers: 5 })).status, 200)
    const r = await api('POST', '/api/admin/users', owner.token, { username: 'admin2', password: 'secret123', email: 'a2@example.com', role: 'admin' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    admin2 = await login('admin2', 'secret123')
})
after(() => srv?.stop())

test('the member list marks the workspace owner', async () => {
    const { users } = (await api('GET', '/api/admin/users', admin2.token)).data
    assert.equal(users.find(u => u.username === 'owner').isOwner, true)
    assert.equal(users.find(u => u.username === 'admin2').isOwner, false)
})

test('another admin cannot demote, reset or delete the workspace owner', async () => {
    const id = owner.user.id
    assert.equal((await api('PUT', `/api/admin/users/${id}/role`, admin2.token, { role: 'viewer' })).status, 403)
    assert.equal((await api('POST', `/api/admin/users/${id}/reset-password`, admin2.token, { newPassword: 'hijacked1' })).status, 403)
    assert.equal((await api('DELETE', `/api/admin/users/${id}`, admin2.token)).status, 403)
    assert.equal(await me(owner.token), 200, 'owner still works')
})

test('the owner can still manage other admins', async () => {
    const id = admin2.user.id
    assert.equal((await api('PUT', `/api/admin/users/${id}/role`, owner.token, { role: 'operator' })).status, 200)
    assert.equal((await api('PUT', `/api/admin/users/${id}/role`, owner.token, { role: 'admin' })).status, 200)
})

test('an admin password reset logs the member out of existing sessions', async () => {
    const before = await login('admin2', 'secret123')
    assert.equal(await me(before.token), 200)
    await new Promise(r => setTimeout(r, 1100))   // token "iat" has 1-second resolution
    assert.equal((await api('POST', `/api/admin/users/${admin2.user.id}/reset-password`, owner.token, { newPassword: 'newpass123' })).status, 200)
    assert.equal(await me(before.token), 401, 'old session ends')
    assert.ok((await login('admin2', 'newpass123')).token, 'new password works')
})

test('changing your own password keeps this session and ends the others', async () => {
    const other = await login('owner', 'secret123')
    await new Promise(r => setTimeout(r, 1100))
    const r = await api('POST', '/api/auth/change-password', owner.token, { currentPassword: 'secret123', newPassword: 'ownerpass2' })
    assert.equal(r.status, 200)
    assert.ok(r.data.token, 'a fresh token is returned (and set as cookie)')
    assert.equal(await me(r.data.token), 200, 'this session continues')
    assert.equal(await me(other.token), 401, 'the other session ends')
})
