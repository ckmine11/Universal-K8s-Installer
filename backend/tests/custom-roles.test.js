// Custom roles and per-cluster access: the rules (unit) and the whole flow on
// a real server — role builder, member roles, cluster rules by cluster and by
// label, enforcement on the API (visibility, actions, Explorer level), plan
// gating, deleting a role in use, and the access review.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, client, tempDataDir } from './helpers/server.js'

// ── unit: the rules ──────────────────────────────────────────────────────────
const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
const { roleStore, customRoleKey } = await import('../src/services/roleStore.js')
const { accessOn, canOn, canSeeCluster, kubeLevelOn, cleanClusterRules } = await import('../src/services/accessControl.js')
const { identityFor } = await import('../src/services/explorerProxy.js')

const ORG = 'org-u'
const prod = { id: 'c-prod', orgId: ORG, clusterName: 'prod', labels: { env: 'prod' } }
const stage = { id: 'c-stage', orgId: ORG, clusterName: 'stage', labels: { env: 'staging' } }
const fin = { id: 'c-fin', orgId: ORG, clusterName: 'finance', labels: { env: 'prod', team: 'finance' } }

describe('access rules', () => {
    const oncall = roleStore.create(ORG, { name: 'On-call', permissions: ['cluster:view', 'incident:view', 'incident:act', 'terminal:access', 'agent:view'], kube: 'edit' })
    const backup = roleStore.create(ORG, { name: 'Backups', permissions: ['cluster:view', 'backup:manage'], kube: 'view' })
    const OC = customRoleKey(oncall.id), BK = customRoleKey(backup.id)

    test('a custom role gives exactly its permissions', () => {
        const u = { id: 'u1', orgId: ORG, role: OC }
        assert.equal(canOn(u, 'incident:act', prod), true)
        assert.equal(canOn(u, 'cluster:upgrade', prod), false)
        assert.equal(canOn(u, 'agent:view'), true)
        assert.equal(kubeLevelOn(u, prod), 'edit')
    })

    test('a cluster rule beats a label rule; label rules add up', () => {
        const u = { id: 'u2', orgId: ORG, role: 'viewer', clusterAccess: [
            { type: 'label', key: 'env', value: 'prod', role: OC },
            { type: 'label', key: 'team', value: 'finance', role: BK },
            { type: 'cluster', clusterId: 'c-stage', role: 'operator' }
        ] }
        assert.equal(canOn(u, 'cluster:upgrade', stage), true, 'operator on staging (cluster rule)')
        assert.equal(canOn(u, 'incident:act', prod), true, 'on-call on prod (label)')
        assert.equal(canOn(u, 'backup:manage', prod), false)
        assert.equal(canOn(u, 'backup:manage', fin), true, 'finance gets both label rules')
        assert.equal(canOn(u, 'incident:act', fin), true)
        assert.equal(accessOn(u, fin).via, 'label')
    })

    test('"No access" hides the cluster; other clusters keep the main role', () => {
        const u = { id: 'u3', orgId: ORG, role: 'operator', clusterAccess: [{ type: 'cluster', clusterId: 'c-fin', role: 'none' }] }
        assert.equal(canSeeCluster(u, fin), false)
        assert.equal(kubeLevelOn(u, fin), 'none')
        assert.equal(canSeeCluster(u, prod), true)
        assert.equal(canOn(u, 'cluster:upgrade', prod), true)
    })

    test('workspace permissions always come from the main role', () => {
        const u = { id: 'u4', orgId: ORG, role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'c-prod', role: 'operator' }] }
        assert.equal(canOn(u, 'cluster:create', prod), false, 'creating clusters is not a per-cluster permission')
        assert.equal(canOn(u, 'agent:manage', prod), false)
    })

    test('admins are never restricted; another workspace sees nothing', () => {
        const a = { id: 'a', orgId: ORG, role: 'admin', clusterAccess: [{ type: 'cluster', clusterId: 'c-fin', role: 'none' }] }
        assert.equal(canSeeCluster(a, fin), true)
        const other = { id: 'x', orgId: 'org-other', role: 'admin' }
        assert.equal(canSeeCluster(other, prod), false)
    })

    test('a deleted custom role falls back to read-only', () => {
        const tmp = roleStore.create(ORG, { name: 'Temp', permissions: ['cluster:view', 'cluster:upgrade'], kube: 'admin' })
        const u = { id: 'u5', orgId: ORG, role: customRoleKey(tmp.id) }
        assert.equal(canOn(u, 'cluster:upgrade', prod), true)
        roleStore.remove(ORG, tmp.id)
        assert.equal(canOn(u, 'cluster:upgrade', prod), false)
        assert.equal(canOn(u, 'cluster:view', prod), true)
        assert.equal(kubeLevelOn(u, prod), 'view')
    })

    test('roles are validated: no admin-only permissions, no duplicate or built-in names', () => {
        assert.throws(() => roleStore.create(ORG, { name: 'Boss', permissions: ['team:manage'] }), /team and billing stay with Admins/)
        assert.throws(() => roleStore.create(ORG, { name: 'on-call', permissions: ['cluster:view'] }), /already exists/)
        assert.throws(() => roleStore.create(ORG, { name: 'Viewer', permissions: ['cluster:view'] }), /built-in/)
        assert.throws(() => roleStore.create(ORG, { name: 'Empty', permissions: [] }), /at least one/)
    })

    test('cluster rules are checked', () => {
        assert.throws(() => cleanClusterRules(ORG, [{ type: 'cluster', clusterId: 'c-nope', role: 'viewer' }], ['c-prod']), /not in this workspace/)
        assert.throws(() => cleanClusterRules(ORG, [{ type: 'label', key: 'env', value: 'prod', role: 'custom:000000000000' }], []), /Unknown role/)
        assert.deepEqual(cleanClusterRules(ORG, [{ type: 'label', key: 'Env', value: 'PROD', role: 'viewer' }], []), [{ type: 'label', key: 'env', value: 'prod', role: 'viewer' }])
    })

    test('the Explorer gets the group of the level on that cluster', () => {
        assert.equal(identityFor({ username: 'a', role: 'viewer' }, 'admin').groups[0], 'kubeez:admins')
        assert.equal(identityFor({ username: 'a', role: 'admin' }, 'view').groups[0], 'kubeez:viewers')
        assert.equal(identityFor({ username: 'a', role: 'operator' }).groups[0], 'kubeez:operators')
    })
})

// ── the real server ──────────────────────────────────────────────────────────
let srv, api, root, owner, ownerOrg
const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).data

before(async () => {
    srv = await startServer()
    api = client(srv)
    root = await login('root', 'secret123')
    owner = (await api('POST', '/api/auth/register', null, { username: 'boss', password: 'secret123', email: 'boss@example.com' })).data
    ownerOrg = owner.user.orgId
})
after(() => { srv?.stop(); fs.rmSync(DATA, { recursive: true, force: true }) })

describe('custom roles on the API', () => {
    let role, dev, devTok

    test('Free plan: built-in roles only', async () => {
        const r = await api('POST', '/api/roles', owner.token, { name: 'On-call', permissions: ['cluster:view'] })
        assert.equal(r.status, 402)
        assert.equal((await api('GET', '/api/roles', owner.token)).data.allowed, false)
    })

    test('Pro: build a role from a template', async () => {
        assert.equal((await api('PUT', `/api/superadmin/users/${owner.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 10, maxNodes: 50, maxMembers: 5 })).status, 200)
        const meta = (await api('GET', '/api/roles', owner.token)).data
        assert.equal(meta.allowed, true)
        const t = meta.templates.find(x => x.key === 'oncall')
        assert.ok(t && meta.groups.length && meta.kubeLevels.includes('edit'))
        const r = await api('POST', '/api/roles', owner.token, { name: 'Prod on-call', description: t.description, permissions: t.permissions, kube: t.kube })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        role = r.data
        assert.match(role.key, /^custom:[a-f0-9]{12}$/)
    })

    test('a member gets the custom role', async () => {
        const r = await api('POST', '/api/admin/users', owner.token, { username: 'dev1', password: 'secret123', email: 'dev1@example.com', role: role.key })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        dev = r.data.user
        devTok = (await login('dev1', 'secret123')).token
        const list = (await api('GET', '/api/admin/users', owner.token)).data.users
        assert.equal(list.find(u => u.username === 'dev1').roleName, 'Prod on-call')
    })

    test('clusters: labels, cluster rules, and what the member sees and may do', async () => {
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
            { id: 'c-prod', clusterName: 'prod', orgId: ownerOrg, ownerId: owner.user.id, k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.10', username: 'root', password: 'x' }], workerNodes: [] },
            { id: 'c-stage', clusterName: 'stage', orgId: ownerOrg, ownerId: owner.user.id, k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.20', username: 'root', password: 'x' }], workerNodes: [] },
            { id: 'c-fin', clusterName: 'finance', orgId: ownerOrg, ownerId: owner.user.id, k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.30', username: 'root', password: 'x' }], workerNodes: [] }
        ]))
        // labels: admins only
        assert.equal((await api('PUT', '/api/clusters/c-prod/labels', devTok, { labels: { env: 'prod' } })).status, 403)
        assert.equal((await api('PUT', '/api/clusters/c-prod/labels', owner.token, { labels: { env: 'prod' } })).status, 200)
        assert.equal((await api('PUT', '/api/clusters/c-prod/labels', owner.token, { labels: { 'bad key!': 'x' } })).status, 400)

        // dev1: operator on staging, no access to finance, the custom role elsewhere
        const r = await api('PUT', `/api/admin/users/${dev.id}/cluster-access`, owner.token, { rules: [
            { type: 'cluster', clusterId: 'c-stage', role: 'operator' },
            { type: 'cluster', clusterId: 'c-fin', role: 'none' }
        ] })
        assert.equal(r.status, 200, JSON.stringify(r.data))

        const seen = (await api('GET', '/api/clusters/list', devTok)).data.map(c => c.id).sort()
        assert.deepEqual(seen, ['c-prod', 'c-stage'], 'finance is hidden')
        assert.equal((await api('GET', '/api/clusters/c-fin/health', devTok)).status, 403)

        // kubeconfig: operator on staging may (the download then fails on SSH — not 403); on prod the role may not
        assert.notEqual((await api('GET', '/api/clusters/c-stage/kubeconfig', devTok)).status, 403)
        assert.equal((await api('GET', '/api/clusters/c-prod/kubeconfig', devTok)).status, 403)
        // workspace-wide: no cluster creation
        assert.equal((await api('POST', '/api/clusters/install', devTok, { clusterName: 'x' })).status, 403)

        const me = (await api('GET', '/api/rbac/me', devTok)).data
        assert.equal(me.roleName, 'Prod on-call')
        assert.ok(me.clusters['c-stage'].permissions.includes('cluster:upgrade'))
        assert.equal(me.clusters['c-fin'].kube, 'none')
        assert.equal(me.clusters['c-prod'].kube, 'edit')
    })

    test('a label rule: everything labelled env=prod', async () => {
        const r = await api('PUT', `/api/admin/users/${dev.id}/cluster-access`, owner.token, { rules: [{ type: 'label', key: 'env', value: 'prod', role: 'viewer' }] })
        assert.equal(r.status, 200)
        const me = (await api('GET', '/api/rbac/me', devTok)).data
        assert.equal(me.clusters['c-prod'].via, 'label')
        assert.equal(me.clusters['c-prod'].permissions.includes('incident:act'), false, 'viewer on prod now')
        assert.equal(me.clusters['c-stage'].via, 'role')
        assert.ok(me.clusters['c-fin'].permissions.includes('cluster:view'), 'finance visible again')
    })

    test('admins cannot get cluster rules; a role in use cannot be deleted', async () => {
        assert.equal((await api('PUT', `/api/admin/users/${owner.user.id}/cluster-access`, owner.token, { rules: [] })).status, 400)
        const del = await api('DELETE', `/api/roles/${role.id}`, owner.token)
        assert.equal(del.status, 409)
        assert.deepEqual(del.data.members, ['dev1'])
        assert.equal((await api('PUT', `/api/admin/users/${dev.id}/role`, owner.token, { role: 'viewer' })).status, 200)
        assert.equal((await api('DELETE', `/api/roles/${role.id}`, owner.token)).status, 200)
    })

    test('members cannot reach the role builder; changes are in the audit trail', async () => {
        assert.equal((await api('GET', '/api/roles', devTok)).status, 403)
        assert.equal((await api('POST', '/api/roles', devTok, { name: 'Mine', permissions: ['cluster:view'] })).status, 403)
        const audit = (await api('GET', '/api/compliance/audit?limit=200', owner.token)).data
        const actions = JSON.stringify(audit)
        assert.match(actions, /roles/i)
        assert.match(actions, /cluster-access|cluster access/i)
    })

    test('access review: who has what, where (JSON and CSV)', async () => {
        const r = await api('GET', '/api/admin/access-review', owner.token)
        assert.equal(r.status, 200)
        const rows = r.data.rows.filter(x => x.member === 'dev1')
        assert.equal(rows.length, 3)
        assert.equal(rows.find(x => x.cluster === 'prod').via, 'label rule')
        const csv = await fetch(`${srv.url}/api/admin/access-review?format=csv`, { headers: { Authorization: `Bearer ${owner.token}` } })
        assert.match(csv.headers.get('content-type'), /text\/csv/)
        assert.match(await csv.text(), /^member,email,mainRole,cluster,access,via,kube,namespaces,temporaryUntil,permissions/)
    })
})
