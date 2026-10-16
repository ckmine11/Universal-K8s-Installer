// Namespace-level access, two-person approval and temporary elevation:
// the rules (unit) and the flows on a real server. The Kubernetes side
// (RoleBindings, scoped kubeconfig) runs against a real cluster in e2e (access).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, client, tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
const { accessOn, nsMatches, cleanClusterRules } = await import('../src/services/accessControl.js')
const { approvalStore } = await import('../src/services/approvalStore.js')
const { desiredState, saName } = await import('../src/services/namespaceAccess.js')
const { requestHash } = await import('../src/services/approvals.js')
const { identityFor } = await import('../src/services/explorerProxy.js')

const ORG = 'org-p2'
const prod = { id: 'c-prod', orgId: ORG, clusterName: 'prod', labels: { env: 'prod' } }

describe('namespaces (rules)', () => {
    test('patterns: names and prefixes', () => {
        assert.equal(nsMatches(['payments-*'], 'payments-api'), true)
        assert.equal(nsMatches(['payments-*'], 'payroll'), false)
        assert.equal(nsMatches(['web'], 'web'), true)
        assert.equal(nsMatches(['web'], 'web2'), false)
    })
    test('a rule limited to namespaces limits the member; an unlimited matching rule lifts it', () => {
        const u = { id: 'u1', orgId: ORG, role: 'viewer', clusterAccess: [{ type: 'label', key: 'env', value: 'prod', role: 'operator', namespaces: ['payments-*'] }] }
        assert.deepEqual(accessOn(u, prod).namespaces, ['payments-*'])
        u.clusterAccess.push({ type: 'label', key: 'env', value: 'prod', role: 'viewer' })
        assert.equal(accessOn(u, prod).namespaces, null)
    })
    test('namespace lists are checked', () => {
        assert.throws(() => cleanClusterRules(ORG, [{ type: 'cluster', clusterId: 'c-prod', role: 'viewer', namespaces: ['Bad_NS'] }], ['c-prod']), /lowercase/)
        assert.deepEqual(cleanClusterRules(ORG, [{ type: 'cluster', clusterId: 'c-prod', role: 'viewer', namespaces: 'web, payments-*' }], ['c-prod'])[0].namespaces, ['web', 'payments-*'])
        assert.equal(cleanClusterRules(ORG, [{ type: 'cluster', clusterId: 'c-prod', role: 'none', namespaces: ['web'] }], ['c-prod'])[0].namespaces, undefined, '"No access" has no namespaces')
    })
    test('the RBAC KubeEZ keeps: RoleBindings in the allowed namespaces, a service-account binding for limited cluster-wide access, nothing for admins', () => {
        const scoped = { id: 'u-s', username: 'dev', orgId: ORG, role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'c-prod', role: 'operator', namespaces: ['payments-*', 'web'] }] }
        const wide = { id: 'u-w', username: 'ops', orgId: ORG, role: 'viewer', clusterAccess: [] }
        const admin = { id: 'u-a', username: 'boss', orgId: ORG, role: 'admin', clusterAccess: [] }
        const hidden = { id: 'u-h', username: 'gone', orgId: ORG, role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'c-prod', role: 'none' }] }
        const d = desiredState(prod, [scoped, wide, admin, hidden], ['default', 'kube-system', 'payments-api', 'payments-db', 'web', 'kubeez-access'])
        assert.deepEqual(d.roleBindings.map(b => `${b.ns}:${b.role}`).sort(), ['payments-api:edit', 'payments-db:edit', 'web:edit'])
        assert.deepEqual(d.roleBindings[0].subjects.map(s => s.kind), ['User', 'ServiceAccount'])
        assert.equal(d.roleBindings[0].subjects[0].name, 'kubeez:dev')
        assert.deepEqual(d.saBindings.map(b => `${b.sa}:${b.role}`), [`${saName('u-w')}:view`])
        assert.equal(d.serviceAccounts.length, 2)
    })
    test('the Explorer sends no cluster-wide group for a namespace-limited member', () => {
        assert.deepEqual(identityFor({ username: 'dev', orgId: ORG }, 'edit', true).groups, ['kubeez:scoped', `kubeez:org:${ORG}`])
    })
})

describe('temporary elevation (rules)', () => {
    test('an active elevation adds its role on that cluster, lifts namespace limits, and ends by itself', () => {
        const u = { id: 'u-e', orgId: ORG, role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'c-prod', role: 'viewer', namespaces: ['web'] }] }
        assert.equal(accessOn(u, prod).permissions.has('cluster:upgrade'), false)
        const r = approvalStore.add({ orgId: ORG, kind: 'elevation', clusterId: 'c-prod', role: 'operator', minutes: 30, requestedBy: { id: 'u-e' } })
        approvalStore.update(r.id, { status: 'active', until: new Date(Date.now() + 60e3).toISOString() })
        const a = accessOn(u, prod)
        assert.equal(a.permissions.has('cluster:upgrade'), true)
        assert.equal(a.via, 'elevation')
        assert.equal(a.namespaces, null)
        assert.equal(accessOn(u, { ...prod, id: 'c-other' }).permissions.has('cluster:upgrade'), false, 'only on that cluster')
        approvalStore.update(r.id, { until: new Date(Date.now() - 1000).toISOString() })
        assert.equal(accessOn(u, prod).permissions.has('cluster:upgrade'), false, 'expired')
    })
    test('the request fingerprint ignores key order', () => {
        assert.equal(requestHash('post', '/a', { b: 1, a: { y: 2, x: 1 } }), requestHash('POST', '/a', { a: { x: 1, y: 2 }, b: 1 }))
        assert.notEqual(requestHash('POST', '/a', { b: 1 }), requestHash('POST', '/a', { b: 2 }))
    })
})

// ── the real server ──────────────────────────────────────────────────────────
let srv, api, root, owner
const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).data
const add = async (u, role) => { const r = await api('POST', '/api/admin/users', owner.token, { username: u, password: 'secret123', email: `${u}@example.com`, role }); assert.equal(r.status, 200, JSON.stringify(r.data)); return { ...r.data.user, token: (await login(u, 'secret123')).token } }

before(async () => {
    srv = await startServer()
    api = client(srv)
    root = await login('root', 'secret123')
    owner = (await api('POST', '/api/auth/register', null, { username: 'chief', password: 'secret123', email: 'chief@example.com' })).data
    assert.equal((await api('PUT', `/api/superadmin/users/${owner.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 10, maxNodes: 50, maxMembers: 8 })).status, 200)
    fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
        { id: 'c1', clusterName: 'prod', orgId: owner.user.orgId, ownerId: owner.user.id, k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.40', username: 'root', password: 'x' }], workerNodes: [] }
    ]))
})
after(() => { srv?.stop(); fs.rmSync(DATA, { recursive: true, force: true }) })

describe('two-person approval', () => {
    let op, admin2, req
    const upgrade = (tok, body, approval) => fetch(`${srv.url}/api/clusters/c1/upgrade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(approval ? { 'x-kubeez-approval': approval } : {}) }, body: JSON.stringify(body) })

    test('needs two people who can approve', async () => {
        const r = await api('PUT', '/api/approvals/settings', owner.token, { actions: { 'cluster:upgrade': true } })
        assert.equal(r.status, 400)
        assert.match(r.data.error, /at least two/)
        admin2 = await add('deputy', 'admin')
        op = await add('opsguy', 'operator')
        assert.equal((await api('PUT', '/api/approvals/settings', op.token, { actions: { 'cluster:upgrade': true } })).status, 403)
        assert.equal((await api('PUT', '/api/approvals/settings', owner.token, { actions: { 'cluster:upgrade': true, 'cluster:delete': true } })).status, 200)
    })

    test('the action answers 428 until approved — for admins too', async () => {
        const r = await upgrade(op.token, { targetVersion: '1.36.0' })
        assert.equal(r.status, 428)
        const j = await r.json()
        assert.equal(j.approvalRequired, true)
        assert.match(j.summary, /Upgrade prod to Kubernetes 1\.36\.0/)
        assert.equal((await upgrade(owner.token, { targetVersion: '1.36.0' })).status, 428, 'four eyes for admins as well')
    })

    test('request → not by yourself → approved by someone else', async () => {
        assert.equal((await api('POST', '/api/approvals', op.token, { kind: 'action', action: 'cluster:upgrade', clusterId: 'c1', method: 'POST', path: '/api/clusters/c1/upgrade', body: { targetVersion: '1.36.0' }, reason: 'ok' })).status, 400, 'a real reason')
        const r = await api('POST', '/api/approvals', op.token, { kind: 'action', action: 'cluster:upgrade', clusterId: 'c1', method: 'POST', path: '/api/clusters/c1/upgrade', body: { targetVersion: '1.36.0' }, reason: 'monthly patch window' })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        req = r.data
        assert.equal(req.status, 'pending')
        assert.equal((await api('POST', `/api/approvals/${req.id}/approve`, op.token)).status, 403, 'operators cannot approve')
        // the operator asks again → same request (no duplicates)
        assert.equal((await api('POST', '/api/approvals', op.token, { kind: 'action', action: 'cluster:upgrade', clusterId: 'c1', method: 'POST', path: '/api/clusters/c1/upgrade', body: { targetVersion: '1.36.0' }, reason: 'monthly patch window' })).data.id, req.id)
        const ok = await api('POST', `/api/approvals/${req.id}/approve`, admin2.token, { comment: 'go' })
        assert.equal(ok.status, 200)
        assert.equal(ok.data.status, 'approved')
    })

    test('the approval fits exactly that request, once', async () => {
        assert.equal((await upgrade(op.token, { targetVersion: '1.37.0' }, req.id)).status, 403, 'different body')
        assert.equal((await upgrade(owner.token, { targetVersion: '1.36.0' }, req.id)).status, 403, 'someone else')
        const r = await upgrade(op.token, { targetVersion: '1.36.0' }, req.id)
        assert.ok(![403, 428].includes(r.status), `ran (then failed on the fake cluster): ${r.status}`)
        assert.equal((await upgrade(op.token, { targetVersion: '1.36.0' }, req.id)).status, 403, 'used')
        assert.equal((await api('GET', `/api/approvals/${req.id}`, op.token)).data.status, 'used')
    })

    test('your own request cannot be approved by you; denied stays denied', async () => {
        const r = await api('POST', '/api/approvals', owner.token, { kind: 'action', action: 'cluster:delete', clusterId: 'c1', method: 'DELETE', path: '/api/clusters/c1', body: {}, reason: 'retire the old cluster' })
        assert.equal(r.status, 200)
        assert.equal((await api('POST', `/api/approvals/${r.data.id}/approve`, owner.token)).status, 403)
        assert.equal((await api('POST', `/api/approvals/${r.data.id}/deny`, admin2.token, { comment: 'not yet' })).data.status, 'denied')
        assert.equal((await api('POST', `/api/approvals/${r.data.id}/approve`, admin2.token)).status, 400)
    })

    test('actions that are not protected run without approval; requests must match the action', async () => {
        assert.equal((await api('POST', '/api/approvals', op.token, { kind: 'action', action: 'etcd:restore', clusterId: 'c1', method: 'POST', path: '/api/clusters/c1/etcd/restore', body: {}, reason: 'test restore please' })).status, 400)
        assert.equal((await api('POST', '/api/approvals', op.token, { kind: 'action', action: 'cluster:upgrade', clusterId: 'c1', method: 'POST', path: '/api/clusters/c1/etcd/restore', body: {}, reason: 'sneaky other route' })).status, 400)
    })
})

describe('temporary elevation', () => {
    let viewer, elev
    test('a viewer asks for Operator on prod for 30 minutes', async () => {
        viewer = await add('auditor1', 'viewer')
        assert.equal((await api('POST', '/api/approvals', viewer.token, { kind: 'elevation', clusterId: 'c1', role: 'admin', minutes: 30, reason: 'need full power' })).status, 400)
        assert.equal((await api('POST', '/api/approvals', viewer.token, { kind: 'elevation', clusterId: 'c1', role: 'operator', minutes: 7, reason: 'fix the ingress' })).status, 400)
        const r = await api('POST', '/api/approvals', viewer.token, { kind: 'elevation', clusterId: 'c1', role: 'operator', minutes: 30, reason: 'fix the ingress on prod' })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        elev = r.data
        assert.equal((await api('POST', '/api/approvals', viewer.token, { kind: 'elevation', clusterId: 'c1', role: 'operator', minutes: 30, reason: 'again please' })).status, 400, 'one at a time')
        const opts = (await api('GET', '/api/approvals/options', viewer.token)).data
        assert.ok(opts.roles.some(x => x.key === 'operator') && !opts.roles.some(x => x.key === 'admin'))
    })
    test('approved → the role is there; ended → gone', async () => {
        let me = (await api('GET', '/api/rbac/me', viewer.token)).data
        assert.equal(me.clusters.c1.permissions.includes('cluster:upgrade'), false)
        const ok = await api('POST', `/api/approvals/${elev.id}/approve`, owner.token)
        assert.equal(ok.data.status, 'active')
        me = (await api('GET', '/api/rbac/me', viewer.token)).data
        assert.equal(me.clusters.c1.permissions.includes('cluster:upgrade'), true)
        assert.equal(me.clusters.c1.via, 'elevation')
        assert.ok(me.clusters.c1.elevatedUntil)
        const review = (await api('GET', '/api/admin/access-review', owner.token)).data.rows.find(r => r.member === 'auditor1')
        assert.equal(review.via, 'temporary access')
        assert.equal((await api('POST', `/api/approvals/${elev.id}/end`, viewer.token)).data.status, 'ended')
        me = (await api('GET', '/api/rbac/me', viewer.token)).data
        assert.equal(me.clusters.c1.permissions.includes('cluster:upgrade'), false)
    })
    test('members see only their own requests; approvers see all; all in the audit trail', async () => {
        const mine = (await api('GET', '/api/approvals', viewer.token)).data
        assert.equal(mine.canApprove, false)
        assert.ok(mine.requests.every(r => r.requestedBy.username === 'auditor1'))
        const all = (await api('GET', '/api/approvals', owner.token)).data
        assert.ok(all.requests.length >= 3)
        const audit = JSON.stringify((await api('GET', '/api/compliance/audit?limit=300', owner.token)).data)
        for (const a of ['approval.requested', 'approval.approved', 'approval.used', 'elevation.granted', 'elevation.ended']) assert.match(audit, new RegExp(a.replace('.', '\\.')))
    })
})

describe('namespaces on the API', () => {
    test('cluster rules carry namespaces; /rbac/me reports them', async () => {
        const dev = await add('devns', 'viewer')
        const r = await api('PUT', `/api/admin/users/${dev.id}/cluster-access`, owner.token, { rules: [{ type: 'cluster', clusterId: 'c1', role: 'operator', namespaces: ['payments-*', 'web'] }] })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        assert.deepEqual((await api('GET', '/api/rbac/me', dev.token)).data.clusters.c1.namespaces, ['payments-*', 'web'])
        assert.equal((await api('PUT', `/api/admin/users/${dev.id}/cluster-access`, owner.token, { rules: [{ type: 'cluster', clusterId: 'c1', role: 'operator', namespaces: ['Payments!'] }] })).status, 400)
    })
})
