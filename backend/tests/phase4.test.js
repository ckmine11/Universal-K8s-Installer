// Phase 4: Argo Rollouts (state, promote / abort), KEDA ScaledObjects (wizard
// checks, only KubeEZ's are changed), per-app Prometheus metrics, registry
// pull secrets — and the API gates for every role (in-process, fake clusters).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 'q1', clusterName: 'prod', orgId: 'org-q', ownerId: 'q-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.90', username: 'root', password: 'x' }], workerNodes: [] },
    { id: 'q-ro', clusterName: 'ro', orgId: 'org-q', ownerId: 'q-admin', k8sVersion: '1.34.0', imported: true, access: { mode: 'direct', level: 'read', server: 'https://203.0.113.11', token: 'x' }, masterNodes: [], workerNodes: [] }
]))
const pg = await import('../src/services/progressive.js')
const am = await import('../src/services/appMetrics.js')
const { deliveryStore } = await import('../src/services/deliveryStore.js')
after(() => { pg._test.useConnect(null); am._test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const ro = (name, ns, { phase = 'Healthy', idx = 3, paused = false, abort = false, steps = [{ setWeight: 20 }, { pause: {} }, { setWeight: 50 }] } = {}) => ({
    metadata: { name, namespace: ns }, spec: { replicas: 4, strategy: { canary: { steps } }, template: { spec: { containers: [{ image: 'acme/web:2.0' }] } } },
    status: { phase, currentStepIndex: idx, abort, pauseConditions: paused ? [{ reason: 'CanaryPauseStep' }] : undefined, readyReplicas: 4, stableRS: 'abc', currentPodHash: 'def', message: phase === 'Degraded' ? 'RolloutAborted: metric "error-rate" assessed Failed' : undefined }
})
const RO_OUT = `==KZRO:RO==\n${JSON.stringify({ items: [ro('web', 'shop'), ro('api', 'shop', { phase: 'Paused', idx: 1, paused: true }), ro('pay', 'team-a', { phase: 'Degraded', idx: 2, abort: true })] })}\n==KZRO:END==`

describe('Argo Rollouts', () => {
    test('where each rollout is: phase, step, traffic share, paused / aborted, problems first', () => {
        const r = pg.parseRollouts(RO_OUT)
        assert.deepEqual(r.rollouts.map(x => x.name), ['api', 'pay', 'web'])
        const api = r.rollouts.find(x => x.name === 'api')
        assert.equal(api.paused, true); assert.deepEqual(api.step, { index: 1, total: 3 }); assert.equal(api.weight, 20); assert.deepEqual(api.pauseReasons, ['CanaryPauseStep'])
        assert.equal(r.rollouts.find(x => x.name === 'web').weight, 100, 'all steps done')
        assert.equal(r.rollouts.find(x => x.name === 'pay').aborted, true)
        assert.match(r.rollouts.find(x => x.name === 'pay').message, /error-rate/)
        assert.deepEqual(pg.parseRollouts('==KZRO:RO_ERR==\nerror: the server doesn\'t have a resource type "rollouts"\n==KZRO:END=='), { installed: false, error: null, rollouts: [] })
    })
    test('actions patch the status subresource like the kubectl plugin; names checked', () => {
        const p = pg.rolloutCommands('shop', 'api', 'promote')
        assert.match(p[0], /patch rollouts\.argoproj\.io 'api' --type merge --subresource=status -p '\{"status":\{"pauseConditions":null\}\}'/)
        assert.match(p[1], /--type merge -p '\{"spec":\{"paused":false\}\}'/)
        assert.match(pg.rolloutCommands('shop', 'api', 'abort')[0], /"abort":true/)
        assert.match(pg.rolloutCommands('shop', 'api', 'promote-full')[0], /"promoteFull":true/)
        assert.throws(() => pg.rolloutCommands('shop', "api';x", 'abort'), /valid rollout/)
        assert.throws(() => pg.rolloutCommands('shop', 'api', 'delete'), /action/)
    })
})

describe('KEDA wizard', () => {
    const ok = { namespace: 'shop', target: { kind: 'Deployment', name: 'web' }, min: 0, max: 10, triggers: [{ type: 'cron', timezone: 'Asia/Kolkata', start: '0 9 * * 1-5', end: '0 19 * * 1-5', desiredReplicas: 4 }] }
    test('schedules, CPU / memory and in-cluster Prometheus only; sensible bounds', () => {
        const s = pg.cleanScaledObject(ok)
        assert.equal(s.name, 'web-scaler'); assert.deepEqual(s.triggers[0], { type: 'cron', metadata: { timezone: 'Asia/Kolkata', start: '0 9 * * 1-5', end: '0 19 * * 1-5', desiredReplicas: '4' } })
        assert.deepEqual(pg.cleanScaledObject({ ...ok, min: 1, triggers: [{ type: 'cpu', value: 70 }] }).triggers[0], { type: 'cpu', metricType: 'Utilization', metadata: { value: '70' } })
        assert.equal(pg.cleanScaledObject({ ...ok, triggers: [{ type: 'prometheus', serverAddress: 'http://prometheus-operated.monitoring.svc:9090', query: 'sum(rate(http_requests_total[1m]))', threshold: 100 }] }).triggers[0].metadata.threshold, '100')
        for (const b of [
            { ...ok, min: 0, triggers: [{ type: 'cpu', value: 70 }] }, { ...ok, triggers: [{ type: 'cron', start: 'every day', end: '0 1 * * *', desiredReplicas: 1 }] },
            { ...ok, triggers: [{ type: 'prometheus', serverAddress: 'http://169.254.169.254/latest', query: 'up', threshold: 1 }] }, { ...ok, triggers: [{ type: 'prometheus', serverAddress: 'http://p.monitoring.svc:9090', query: 'up\nx', threshold: 1 }] },
            { ...ok, min: 5, max: 2 }, { ...ok, max: 500 }, { ...ok, triggers: [] }, { ...ok, triggers: [{ type: 'kafka' }] }, { ...ok, target: { kind: 'Pod', name: 'x' } }, { ...ok, namespace: 'A' }
        ]) assert.throws(() => pg.cleanScaledObject(b), (e) => e.status === 400, JSON.stringify(b))
        const m = pg.scaledObjectManifest(s, 'opsy')
        assert.equal(m.metadata.labels['app.kubernetes.io/managed-by'], 'kubeez'); assert.deepEqual(m.spec.scaleTargetRef, { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' })
    })
    test('KubeEZ never overwrites or removes a ScaledObject it did not make', async () => {
        const calls = []
        const fake = (owner) => async () => ({ execCommand: async (cmd, o = {}) => { calls.push({ cmd, stdin: o.stdin }); if (/get scaledobjects/.test(cmd)) return owner === null ? { code: 1, stderr: 'NotFound' } : { code: 0, stdout: owner }; return { code: 0 } }, dispose() { } })
        const s = pg.cleanScaledObject(ok)
        await pg.applyScaledObject({ id: 'c' }, s, { connect: fake(null) })
        assert.equal(JSON.parse(calls.find(c => /apply -f -/.test(c.cmd)).stdin).kind, 'ScaledObject')
        await assert.rejects(pg.applyScaledObject({ id: 'c' }, s, { connect: fake('') }), (e) => e.status === 409)
        await assert.rejects(pg.deleteScaledObject({ id: 'c' }, 'shop', 'web-scaler', { connect: fake('') }), /only the ScaledObjects it made/)
        await pg.deleteScaledObject({ id: 'c' }, 'shop', 'web-scaler', { connect: fake('kubeez') })
        assert.ok(calls.some(c => /delete scaledobjects\.keda\.sh 'web-scaler'/.test(c.cmd)))
    })
})

describe('app metrics', () => {
    test('the Prometheus Service is found; PromQL is built from checked names', () => {
        assert.deepEqual(am.pickPrometheus('default kubernetes 443\nmonitoring kube-prometheus-stack-grafana 80\nmonitoring prometheus-operated 9090\nmonitoring kube-prometheus-stack-prometheus 9090,8080'), { namespace: 'monitoring', name: 'prometheus-operated', port: '9090' })
        assert.equal(am.pickPrometheus('default kubernetes 443'), null)
        const qs = am.queries('shop', 'Deployment', 'web')
        assert.match(qs.cpu, /namespace="shop",pod=~"web-\[a-z0-9\]\{6,10\}-\[a-z0-9\]\{5\}",container!=""/)
        assert.match(am.queries('db', 'StatefulSet', 'pg').memory, /pod=~"pg-\[0-9\]\+"/)
        assert.throws(() => am.queries('shop', 'Deployment', 'web"}or vector(1)#'), /valid workload/)
    })
    test('series over the service proxy; a forbidden proxy is explained', async () => {
        const answer = JSON.stringify({ status: 'success', data: { result: [{ values: [[1761800000, '0.25'], [1761800060, '0.30']] }] } })
        let cmd
        const connect = (body) => async () => ({ execCommand: async (c) => { if (/get svc -A/.test(c)) return { code: 0, stdout: 'monitoring prometheus-operated 9090,\n' }; cmd = c; return { code: 0, stdout: body } }, dispose() { } })
        const r = await am.workloadMetrics({ id: 'c' }, { namespace: 'shop', name: 'web', range: '1h', now: 1761803600000 }, { connect: connect(['cpu', 'memory', 'restarts', 'netIn', 'netOut'].map(k => `==KZM:${k}==\n${answer}`).join('\n')) })
        assert.deepEqual(r.series.cpu, [{ t: 1761800000000, v: 0.25 }, { t: 1761800060000, v: 0.3 }])
        assert.match(cmd, /get --raw '\/api\/v1\/namespaces\/monitoring\/services\/http:prometheus-operated:9090\/proxy\/api\/v1\/query_range\?query=sum%28rate%28container_cpu_usage_seconds_total/)
        assert.match(cmd, /&step=60'/)
        const denied = await am.workloadMetrics({ id: 'c' }, { namespace: 'shop', name: 'web' }, { connect: connect('Error from server (Forbidden): services "http:prometheus-operated:9090" is forbidden') })
        assert.match(denied.why, /Full manage/)
        await assert.rejects(am.workloadMetrics({ id: 'c' }, { namespace: 'shop', name: 'web', range: '7d' }, { connect: connect('') }), /range/)
    })
})

describe('registry pull secrets', () => {
    test('a dockerconfigjson Secret per namespace; the password only on stdin; default ServiceAccounts keep their other secrets', async () => {
        const reg = { ...am.cleanRegistry({ name: 'ghcr', server: 'https://ghcr.io/', username: 'bot' }), password: 'pw-123' }
        assert.equal(reg.server, 'ghcr.io')
        for (const b of [{ name: 'x', server: 'ghcr.io', username: 'a b' }, { name: 'x', server: 'evil host', username: 'a' }, { name: 'X Y', server: 'ghcr.io', username: 'a' }]) assert.throws(() => am.cleanRegistry(b), /./)
        const list = am.pullSecrets(reg, ['shop'])
        const cfg = JSON.parse(Buffer.from(list.items[0].data['.dockerconfigjson'], 'base64').toString())
        assert.deepEqual(cfg.auths['ghcr.io'], { username: 'bot', password: 'pw-123', auth: Buffer.from('bot:pw-123').toString('base64') })
        const calls = []
        const connect = async () => ({ execCommand: async (c, o = {}) => { calls.push({ c, stdin: o.stdin }); return /get serviceaccount/.test(c) ? { code: 0, stdout: 'old-secret\n' } : { code: 0 } }, dispose() { } })
        const r = await am.syncRegistry({ id: 'c' }, reg, ['shop', 'dev'], { defaultServiceAccount: true, connect })
        assert.deepEqual(r.linked, ['shop', 'dev'])
        assert.ok(calls.every(x => !x.c.includes('pw-123')), 'never on a command line')
        assert.match(calls.find(x => /patch serviceaccount/.test(x.c)).c, /"imagePullSecrets":\[\{"name":"old-secret"\},\{"name":"kubeez-registry-ghcr"\}\]/)
        await assert.rejects(am.syncRegistry({ id: 'c' }, { ...reg, password: null }, ['shop'], { connect }), /no password/)
    })
})

describe('API: who may promote, scale and sync', () => {
    let base, server, regId
    const U = {
        admin: { id: 'q-admin', username: 'qadmin', orgId: 'org-q', role: 'admin' },
        operator: { id: 'q-op', username: 'qop', orgId: 'org-q', role: 'operator' },
        viewer: { id: 'q-view', username: 'qview', orgId: 'org-q', role: 'viewer' },
        scoped: { id: 'q-sc', username: 'qsc', orgId: 'org-q', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'q1', role: 'operator', namespaces: ['team-a'] }] }
    }
    const call = async (who, method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) } }
    const kube = []
    before(async () => {
        const express = (await import('express')).default
        const { default: scaling } = await import('../src/routes/scaling.js')
        const { default: delivery } = await import('../src/routes/delivery.js')
        const fake = async () => ({ execCommand: async (c, o = {}) => { kube.push({ c, stdin: o.stdin }); if (/KZRO/.test(c)) return { code: 0, stdout: RO_OUT }; if (/KZKEDA/.test(c)) return { code: 0, stdout: '==KZKEDA:SO==\n{"items":[]}\n==KZKEDA:END==' }; if (/get scaledobjects/.test(c)) return { code: 1, stderr: 'NotFound' }; if (/get svc -A/.test(c)) return { code: 0, stdout: '' }; return { code: 0, stdout: '' } }, dispose() { } })
        pg._test.useConnect(fake); am._test.useConnect(fake)
        deliveryStore.saveEnvironment('org-q', { name: 'prod', clusterId: 'q1', namespace: 'shop', protected: true }, { clusterIds: ['q1'] })
        const app = express(); app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use('/api/clusters', scaling); app.use('/api/delivery', delivery)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('rollouts: everyone sees (limited members their namespaces); promote in a protected environment needs a second person, abort never', async () => {
        const v = await call('viewer', 'GET', '/api/clusters/q1/rollouts')
        assert.equal(v.status, 200); assert.equal(v.data.rollouts.length, 3); assert.equal(v.data.rollouts.find(r => r.name === 'api').protected, true)
        assert.deepEqual((await call('scoped', 'GET', '/api/clusters/q1/rollouts')).data.rollouts.map(r => r.name), ['pay'])
        assert.equal((await call('viewer', 'POST', '/api/clusters/q1/rollouts/action', { namespace: 'team-a', name: 'pay', action: 'retry' })).status, 403)
        const p = await call('operator', 'POST', '/api/clusters/q1/rollouts/action', { namespace: 'shop', name: 'api', action: 'promote' })
        assert.equal(p.status, 428); assert.match(p.data.summary, /Promote rollout shop\/api on prod/)
        const a = await call('operator', 'POST', '/api/clusters/q1/rollouts/action', { namespace: 'shop', name: 'api', action: 'abort' })
        assert.equal(a.status, 200, JSON.stringify(a.data))
        assert.equal((await call('scoped', 'POST', '/api/clusters/q1/rollouts/action', { namespace: 'shop', name: 'api', action: 'abort' })).status, 403)
        assert.equal((await call('operator', 'POST', '/api/clusters/q1/rollouts/action', { namespace: 'team-a', name: 'pay', action: 'nuke' })).status, 400)
        const fr = deliveryStore.saveFreeze('org-q', { from: new Date(Date.now() - 1000).toISOString(), until: new Date(Date.now() + 3600e3).toISOString(), reason: 'Freeze' }, { clusterIds: ['q1'] })
        try {
            assert.equal((await call('operator', 'POST', '/api/clusters/q1/rollouts/action', { namespace: 'team-a', name: 'pay', action: 'retry' })).status, 423)
            assert.equal((await call('operator', 'POST', '/api/clusters/q1/rollouts/action', { namespace: 'team-a', name: 'pay', action: 'abort' })).status, 200, 'abort is the way back — allowed in a freeze')
        } finally { deliveryStore.removeFreeze('org-q', fr.id) }
        assert.equal((await call('admin', 'POST', '/api/clusters/q-ro/rollouts/action', { namespace: 'team-a', name: 'pay', action: 'abort' })).status, 409)
    })

    test('autoscale: operators create in their namespaces; viewers do not; bad wizard input 400', async () => {
        const body = { namespace: 'team-a', target: { kind: 'Deployment', name: 'web' }, min: 1, max: 5, triggers: [{ type: 'cpu', value: 70 }] }
        assert.equal((await call('viewer', 'POST', '/api/clusters/q1/autoscale', body)).status, 403)
        assert.equal((await call('scoped', 'POST', '/api/clusters/q1/autoscale', { ...body, namespace: 'shop' })).status, 403)
        assert.equal((await call('scoped', 'POST', '/api/clusters/q1/autoscale', body)).status, 200)
        assert.equal((await call('operator', 'POST', '/api/clusters/q1/autoscale', { ...body, max: 0 })).status, 400)
        assert.equal((await call('viewer', 'GET', '/api/clusters/q1/autoscale')).status, 200)
    })

    test('metrics: namespace limits; no Prometheus is explained', async () => {
        assert.equal((await call('scoped', 'GET', '/api/clusters/q1/metrics?namespace=shop&name=web')).status, 404)
        const r = await call('viewer', 'GET', '/api/clusters/q1/metrics?namespace=shop&name=web')
        assert.equal(r.status, 200); assert.match(r.data.why, /No Prometheus/)
    })

    test('registries: admins only; the password never leaves; sync writes into the cluster', async () => {
        assert.equal((await call('operator', 'POST', '/api/delivery/registries', { name: 'ghcr', server: 'ghcr.io', username: 'bot', password: 'pw-9' })).status, 403)
        const r = await call('admin', 'POST', '/api/delivery/registries', { name: 'ghcr', server: 'ghcr.io', username: 'bot', password: 'pw-9' })
        assert.equal(r.status, 200); regId = r.data.id
        assert.equal(JSON.stringify((await call('viewer', 'GET', '/api/delivery/registries')).data).includes('pw-9'), false)
        assert.equal((await call('operator', 'POST', '/api/clusters/q1/registries/sync', { registryId: regId, namespaces: ['shop'] })).status, 403)
        const s = await call('admin', 'POST', '/api/clusters/q1/registries/sync', { registryId: regId, namespaces: ['shop'], defaultServiceAccount: false })
        assert.equal(s.status, 200, JSON.stringify(s.data)); assert.equal(s.data.secret, 'kubeez-registry-ghcr')
        assert.ok(kube.some(x => /apply -f -/.test(x.c) && JSON.parse(x.stdin).items?.[0]?.type === 'kubernetes.io/dockerconfigjson'))
        assert.equal((await call('admin', 'POST', '/api/clusters/q1/registries/sync', { registryId: 'nope', namespaces: ['shop'] })).status, 400)
    })
})
