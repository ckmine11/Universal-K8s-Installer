// Auto-rollback (decision, once per revision, ask vs auto) and the promotion
// pipeline (chart version + chosen values into the next environment, approvals,
// freezes) — in-process with fake clusters.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir, paidOrgs } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
paidOrgs(DATA, ['org-r'])
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([{ id: 'r1', clusterName: 'main', orgId: 'org-r', ownerId: 'r-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.120', username: 'root', password: 'x' }], workerNodes: [] }]))
const ar = await import('../src/services/autoRollback.js')
const helm = await import('../src/services/helmApps.js')
const { deliveryStore } = await import('../src/services/deliveryStore.js')
after(() => { helm._test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const NOW = Date.parse('2026-10-31T10:00:00Z')
const hist = (minAgo) => [{ revision: 4, status: 'deployed', updated: new Date(NOW - minAgo * 60e3).toISOString().replace('Z', '+00:00') }, { revision: 3, status: 'superseded', updated: '2026-10-30T10:00:00+00:00' }]
const inc = { id: 'i1', reason: 'CrashLoopBackOff', namespace: 'shop', target: 'web-7d9fc8b6c-x2x9z', owner: 'ReplicaSet/web-7d9fc8b6c', message: 'crash', timestamp: new Date(NOW - 5 * 60e3).toISOString() }

describe('auto-rollback decision', () => {
    test('Helm times, workloads', () => {
        assert.equal(ar.helmTime('2026-10-31 15:30:00.123456 +0530 IST'), Date.parse('2026-10-31T10:00:00Z'))
        assert.equal(ar.helmTime('2026-10-31T10:00:00.5+00:00'), Date.parse('2026-10-31T10:00:00Z'))
        assert.equal(ar.helmTime('nope'), null)
        assert.deepEqual(ar.workloadOf(inc), { kind: 'deployment', name: 'web' })
        assert.deepEqual(ar.workloadOf({ target: 'statefulset/db' }), { kind: 'statefulset', name: 'db' })
        assert.equal(ar.workloadOf({ target: 'w1' }), null)
    })
    test('only a deploy failure, right after a deploy, with an earlier revision, outside a freeze', () => {
        const base = { incident: inc, release: 'web', history: hist(20), frozen: false, now: NOW }
        assert.deepEqual(ar.decide({ ...base, policy: 'auto' }), { action: 'auto', release: 'web', from: 4, to: 3 })
        assert.equal(ar.decide({ ...base, policy: 'ask' }).action, 'ask')
        assert.equal(ar.decide({ ...base, policy: 'off' }).skip, 'off')
        assert.equal(ar.decide({ ...base, policy: 'auto', incident: { ...inc, reason: 'NodeNotReady' } }).skip, 'not a deploy failure')
        assert.equal(ar.decide({ ...base, policy: 'auto', history: hist(90) }).skip, 'not right after a deploy')
        assert.equal(ar.decide({ ...base, policy: 'auto', incident: { ...inc, timestamp: new Date(NOW - 30 * 60e3).toISOString() } }).skip, 'not right after a deploy', 'the problem was there before the deploy')
        assert.equal(ar.decide({ ...base, policy: 'auto', history: [hist(5)[0]] }).skip, 'no earlier revision')
        assert.equal(ar.decide({ ...base, policy: 'auto', frozen: true }).skip, 'change freeze')
    })
    test('auto rolls back once per revision; ask only suggests; the feature and Helm ownership are checked', async () => {
        ar._test.reset()
        const calls = { rollback: [], notify: [], evidence: [] }
        const deps = (o = {}) => ({
            connect: async () => ({ execCommand: async () => ({ stdout: o.release ?? 'web' }), dispose() { } }),
            releaseDetail: async () => ({ history: hist(10) }),
            rollback: async (...a) => calls.rollback.push(a), notify: (c, ev) => calls.notify.push(ev), evidence: (i, t) => calls.evidence.push(t),
            usable: () => o.usable ?? true, policyFor: () => o.policy ?? 'auto', frozen: () => false
        })
        const realNow = Date.now; Date.now = () => NOW
        try {
            const r = await ar.onIncident({ id: 'r1', orgId: 'org-r' }, inc, deps())
            assert.deepEqual(r, { action: 'auto', release: 'web', from: 4, to: 3 })
            assert.deepEqual(calls.rollback[0].slice(0, 4), [{ id: 'r1', orgId: 'org-r' }, 'shop', 'web', 3])
            assert.match(calls.notify[0].title, /Auto-rollback: shop\/web → revision 3/)
            assert.equal((await ar.onIncident({ id: 'r1', orgId: 'org-r' }, inc, deps())).skip, 'already handled')
            ar._test.reset(); calls.rollback.length = 0
            const ask = await ar.onIncident({ id: 'r1', orgId: 'org-r' }, inc, deps({ policy: 'ask' }))
            assert.equal(ask.action, 'ask'); assert.equal(calls.rollback.length, 0); assert.match(calls.notify.at(-1).title, /Rollback suggested/)
            assert.equal((await ar.onIncident({ id: 'r1', orgId: 'org-r' }, inc, deps({ usable: false }))).skip, 'feature')
            ar._test.reset()
            assert.equal((await ar.onIncident({ id: 'r1', orgId: 'org-r' }, inc, deps({ release: '' }))).skip, 'not a Helm release')
        } finally { Date.now = realNow }
    })
    test('the environment keeps its policy', () => {
        const e = deliveryStore.saveEnvironment('org-r', { name: 'shop', clusterId: 'r1', namespace: 'shop', autoRollback: 'auto' }, { clusterIds: ['r1'] })
        assert.equal(e.autoRollback, 'auto')
        assert.equal(deliveryStore.saveEnvironment('org-r', { ...e, autoRollback: 'sometimes' }, { clusterIds: ['r1'] }).autoRollback, 'off')
        deliveryStore.removeEnvironment('org-r', e.id)
    })
})

describe('promotion pipeline', () => {
    let base, server, envs = {}, repoId
    const calls = []
    const U = {
        admin: { id: 'r-admin', username: 'radmin', orgId: 'org-r', role: 'admin' },
        operator: { id: 'r-op', username: 'rop', orgId: 'org-r', role: 'operator' },
        viewer: { id: 'r-view', username: 'rview', orgId: 'org-r', role: 'viewer' }
    }
    const call = async (who, body) => { const r = await fetch(`${base}/api/delivery/promote-release`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': who }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) } }
    before(async () => {
        helm._test.useConnect(async () => ({
            execCommand: async (cmd, o = {}) => {
                calls.push({ cmd, stdin: o.stdin })
                if (/HELM list/.test(cmd)) return { code: 0, stdout: JSON.stringify([{ name: 'web', namespace: 'stg', revision: '7', status: 'deployed', chart: 'web-1.5.0' }]) }
                if (/HELM get values/.test(cmd)) return { code: 0, stdout: JSON.stringify(/-n 'stg'/.test(cmd) ? { image: { tag: '2.0' }, replicas: 1, ingress: { host: 'stg.acme.io' } } : { image: { tag: '1.0' }, replicas: 5, ingress: { host: 'acme.io' } }) }
                return { code: 0, stdout: '{}' }
            }, dispose() { }
        }))
        repoId = deliveryStore.saveRepo('org-r', { name: 'acme', url: 'https://charts.acme.io' }).id
        for (const [name, ns, prot] of [['staging', 'stg', false], ['dev', 'dev', false], ['prod', 'prod', true]]) envs[name] = deliveryStore.saveEnvironment('org-r', { name, clusterId: 'r1', namespace: ns, protected: prot }, { clusterIds: ['r1'] }).id
        const express = (await import('express')).default
        const app = express(); app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use('/api/delivery', (await import('../src/routes/delivery.js')).default)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('staging → dev: the source\'s chart version and image.tag, the target\'s own values kept', async () => {
        const r = await call('operator', { release: 'web', from: envs.staging, to: envs.dev, repoId })
        assert.equal(r.status, 202, JSON.stringify(r.data)); assert.deepEqual(r.data.promoted, { chart: 'web', version: '1.5.0', values: ['image.tag=2.0'] })
        await helm._test.jobs.get(r.data.id).promise
        const up = calls.filter(c => /upgrade --install/.test(c.cmd) && /--wait/.test(c.cmd)).at(-1)
        assert.match(up.cmd, /upgrade --install 'web' 'web' --repo 'https:\/\/charts\.acme\.io' --version '1\.5\.0' -n 'dev'/)
        assert.deepEqual(JSON.parse(up.stdin), { image: { tag: '2.0' }, replicas: 5, ingress: { host: 'acme.io' } })
    })
    test('who and where: viewers no; the same environment no; a protected target needs a second person; a freeze stops it', async () => {
        assert.equal((await call('viewer', { release: 'web', from: envs.staging, to: envs.dev, repoId })).status, 403)
        assert.equal((await call('operator', { release: 'web', from: envs.dev, to: envs.dev, repoId })).status, 400)
        assert.equal((await call('operator', { release: 'web', from: envs.staging, to: envs.dev, repoId: 'nope' })).status, 400)
        assert.equal((await call('operator', { release: 'web', from: envs.staging, to: envs.dev, repoId, keys: ['__proto__.x'] })).status, 400)
        const p = await call('operator', { release: 'web', from: envs.staging, to: envs.prod, repoId })
        assert.equal(p.status, 428, JSON.stringify(p.data)); assert.equal(p.data.clusterId, 'r1'); assert.match(p.data.summary, /Promote web into another environment \(main\)/)
        const fr = deliveryStore.saveFreeze('org-r', { from: new Date(Date.now() - 1000).toISOString(), until: new Date(Date.now() + 3600e3).toISOString(), reason: 'Sale' }, { clusterIds: ['r1'] })
        try { assert.equal((await call('operator', { release: 'web', from: envs.staging, to: envs.dev, repoId })).status, 423) } finally { deliveryStore.removeFreeze('org-r', fr.id) }
        assert.equal((await call('operator', { release: 'ghost', from: envs.staging, to: envs.dev, repoId })).status, 404)
    })
})
