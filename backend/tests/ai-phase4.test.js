// KubeEZ AI phase 4: predictions (memory leak → OOM, restarts rising) through
// the real detector, the risk score, the right specialist, learned runbooks
// (learn, suggest, every gate of an automatic run) and the API.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, client, tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
const { memoryFindings, recordMemory, restartFindings, recordRestarts, podFacts, containerMemory, trend } = await import('../src/services/predict.js')
const { incidentDetector } = await import('../src/services/incidentDetector.js')
const { remediationEngine } = await import('../src/services/remediationEngine.js')
const { riskScore } = await import('../src/services/ai/risk.js')
const { pickSpecialist } = await import('../src/services/ai/specialists.js')
const { actionLog } = await import('../src/services/ai/actions.js')
const runbooks = await import('../src/services/ai/runbooks.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
after(() => fs.rmSync(DATA, { recursive: true, force: true }))
remediationEngine.handleAnomaly = async () => { }

const H = 3600e3, MI = 1024 ** 2
const T0 = Date.parse('2026-10-17T00:00:00Z')

describe('predictions', () => {
    const limits = new Map([['shop/api-1/api', { limit: 512 * MI, ownerHint: 'ReplicaSet/api-6c9', nodeName: 'w1' }]])
    test('a steady climb toward the limit → "out of memory in ~N h"; noise, low use and restarts do not', () => {
        const series = new Map()
        // 300 MB → 400 MB over 2 h = 50 MB/h; 112 MB left → ~2 h
        for (let i = 0; i <= 24; i++) recordMemory(series, new Map([['shop/api-1/api', (300 + i * (100 / 24)) * MI]]), limits, T0 + i * 5 * 60e3)
        const f = memoryFindings(series, limits, { now: T0 + 2 * H })
        assert.equal(f.length, 1)
        assert.equal(f[0].reason, 'MemoryLeakSuspected'); assert.equal(f[0].target, 'api-1'); assert.equal(f[0].namespace, 'shop')
        assert.match(f[0].message, /keeps growing ~50 MB\/h — 400 MB of its 512 MB limit, out of memory in ~2 h/)
        // noisy (up and down) — not a leak
        const noisy = new Map()
        for (let i = 0; i <= 24; i++) recordMemory(noisy, new Map([['shop/api-1/api', (i % 2 ? 420 : 300) * MI]]), limits, T0 + i * 5 * 60e3)
        assert.equal(memoryFindings(noisy, limits, { now: T0 + 2 * H }).length, 0)
        // a restart (big drop) starts a new trend
        recordMemory(series, new Map([['shop/api-1/api', 120 * MI]]), limits, T0 + 2 * H + 5 * 60e3)
        assert.equal(series.get('shop/api-1/api').length, 1)
        assert.ok(Math.abs(trend([{ t: 0, v: 0 }, { t: H, v: 10 }]).perHour - 10) < 1e-9)
    })

    test('restarting again and again (not yet a crash loop) is reported; a crash loop has its own incident', () => {
        const hist = new Map()
        const facts = (n, crash = false) => new Map([['shop/web-1', { count: n, ownerHint: 'ReplicaSet/web-7', nodeName: 'w1', crashLoop: crash, lastReason: 'Error' }]])
        recordRestarts(hist, facts(2), T0)
        recordRestarts(hist, facts(5), T0 + 30 * 60e3)
        recordRestarts(hist, facts(8), T0 + 55 * 60e3)
        const f = restartFindings(hist, facts(8), { now: T0 + 55 * 60e3 })
        assert.equal(f.length, 1); assert.match(f[0].message, /restarted 6 times in the last hour \(last: Error\)/)
        assert.equal(restartFindings(hist, facts(8, true), { now: T0 + 55 * 60e3 }).length, 0)
    })

    test('the real detector: pod limits from the pod poll + kubelet memory → an incident before the OOM kill', async () => {
        const realNow = Date.now
        let now = T0, mem = 300
        const pods = { items: [{ metadata: { namespace: 'shop', name: 'api-1', ownerReferences: [{ kind: 'ReplicaSet', name: 'api-6c9' }] }, spec: { nodeName: 'w1', containers: [{ name: 'api', resources: { limits: { memory: '512Mi' } } }] }, status: { phase: 'Running', containerStatuses: [{ name: 'api', restartCount: 0, state: { running: {} } }] } }] }
        const summary = () => JSON.stringify({ node: { cpu: { usageNanoCores: 1e8 }, memory: { workingSetBytes: 2 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }, fs: { usedBytes: 1e10, capacityBytes: 1e11, availableBytes: 9e10 } }, pods: [{ podRef: { namespace: 'shop', name: 'api-1' }, cpu: { usageNanoCores: 1e7 }, memory: { workingSetBytes: mem * MI }, containers: [{ name: 'api', memory: { workingSetBytes: mem * MI } }] }] })
        const ssh = { execCommand: async (cmd) => cmd.includes('get pods -A -o json') ? { code: 0, stdout: JSON.stringify(pods) } : cmd.includes('stats/summary') ? { code: 0, stdout: `==CAP\nw1 4 8Gi 10.0.0.2\n==NODE w1\n${summary()}\n==END` } : { code: 0, stdout: '' }, dispose() { } }
        const cluster = { id: 'cp4', clusterName: 'p4', orgId: 'org-p4', ownerId: 'u1', masterNodes: [{ ip: '10.0.0.1' }] }
        incidentDetector.streams.set(cluster.id, { ssh, timers: [], failCount: 0, cluster })
        incidentDetector.watched.set(cluster.id, cluster)
        Date.now = () => now
        try {
            await incidentDetector._pollPods(cluster.id)
            for (let i = 0; i <= 24; i++) { now = T0 + i * 5 * 60e3; mem = 300 + i * (100 / 24); await incidentDetector._pollResources(cluster.id) }
            const inc = incidentDetector.getIncidents().find(i => i.clusterId === 'cp4' && i.reason === 'MemoryLeakSuspected')
            assert.ok(inc, 'incident opened')
            assert.equal(inc.target, 'api-1'); assert.equal(inc.owner, 'ReplicaSet/api-6c9')
            assert.match(inc.message, /out of memory in ~2 h/)
            // the app was restarted (memory back to normal) → the prediction clears
            now += 5 * 60e3; mem = 100
            await incidentDetector._pollResources(cluster.id)
            assert.equal(incidentDetector.find(inc.id).status, 'cleared')
        } finally { Date.now = realNow; incidentDetector.stopWatching(cluster.id); incidentDetector.streams.delete(cluster.id) }
    })

    test('parsers: limits and restarts from pods, container memory from kubelet summaries', () => {
        const f = podFacts({ items: [{ metadata: { namespace: 'a', name: 'p' }, spec: { containers: [{ name: 'c', resources: { limits: { memory: '1Gi' } } }, { name: 'nolimit' }] }, status: { containerStatuses: [{ restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }] })
        assert.equal(f.limits.get('a/p/c').limit, 1024 ** 3); assert.equal(f.limits.has('a/p/nolimit'), false)
        assert.equal(f.restarts.get('a/p').count, 3); assert.equal(f.restarts.get('a/p').crashLoop, true)
        assert.equal(containerMemory('==NODE n\n{"pods":[{"podRef":{"namespace":"a","name":"p"},"containers":[{"name":"c","memory":{"workingSetBytes":42}}]}]}\n==END').get('a/p/c'), 42)
    })
})

describe('risk score', () => {
    const now = T0
    const base = { cluster: { id: 'c', k8sVersion: '1.37.1', masterNodes: [{}, {}, {}], controlPlaneVip: '10.0.0.50' }, incidents: [], monitoring: { watched: true, connected: true }, snapshot: { newestAt: new Date(now - 2 * H).toISOString() }, offsite: true, compliance: { score: 88 }, now }
    test('a healthy, backed-up HA cluster has no known risk', () => {
        const r = riskScore(base)
        assert.equal(r.score, 100); assert.equal(r.level, 'low'); assert.equal(r.factors.length, 0)
        assert.ok(r.good.includes('3 control-planes behind 10.0.0.50'))
    })
    test('every point off has a reason and a fix; the biggest first', () => {
        const r = riskScore({ ...base, cluster: { id: 'c', k8sVersion: '1.33.2', masterNodes: [{}] }, snapshot: { newestAt: null }, offsite: false,
            incidents: [{ reason: 'NodeNotReady', severity: 'critical', target: 'w2' }, { reason: 'MemoryLeakSuspected', severity: 'warning', target: 'api-1', message: 'out of memory in ~2 h' }] })
        assert.equal(r.level, 'high')
        assert.deepEqual(r.factors.map(f => f.key), ['critical', 'no-backup', 'unsupported', 'predicted', 'single-cp', 'no-offsite'])
        assert.equal(r.score, 100 - 25 - 20 - 15 - 10 - 10 - 5)
        assert.ok(r.factors.every(f => f.fix && f.label))
        assert.match(r.factors.find(f => f.key === 'predicted').detail, /out of memory in ~2 h/)
    })
    test('unreachable and not-yet-checked backups', () => {
        const r = riskScore({ ...base, monitoring: { watched: true, connected: false }, snapshot: undefined })
        assert.ok(r.factors.some(f => f.key === 'unreachable')); assert.equal(r.partial, true)
    })
})

describe('specialists', () => {
    test('the right expert for the problem and what the logs say', () => {
        assert.equal(pickSpecialist({ reason: 'EtcdUnhealthy', category: 'control-plane' }), 'controlPlane')
        assert.equal(pickSpecialist({ reason: 'PVCPending', category: 'storage' }), 'storage')
        assert.equal(pickSpecialist({ reason: 'CrashLoopBackOff', category: 'pod' }, 'MountVolume.SetUp failed: FailedMount'), 'storage')
        assert.equal(pickSpecialist({ reason: 'DiskPressure', category: 'node' }), 'node')
        assert.equal(pickSpecialist({ reason: 'CrashLoopBackOff', category: 'pod' }, 'dial tcp: lookup orders-db: no such host'), 'network')
        assert.equal(pickSpecialist({ reason: 'CrashLoopBackOff', category: 'pod' }, 'panic: nil pointer'), 'app')
    })
})

describe('learned runbooks', () => {
    const org = 'org-rb'
    const cluster = { id: 'c-rb', clusterName: 'rb', orgId: org, masterNodes: [{}] }
    const workload = { kind: 'deployment', name: 'web', namespace: 'shop' }
    const fakeApplied = (id, incidentId, minsAgo, spec = { type: 'restart', kind: 'deployment', name: 'web', namespace: 'shop' }) => {
        const rec = { id, orgId: org, clusterId: cluster.id, clusterName: 'rb', spec, title: 'Restart deployment shop/web', incidentId, by: 'alice', at: new Date(Date.now() - minsAgo * 60e3).toISOString(), status: 'applied', undo: { possible: false }, workload }
        actionLog.all().unshift(rec); return rec
    }
    const ssh = { cmds: [], async execCommand(cmd) { this.cmds.push(cmd); if (/get deployment\/web .*jsonpath/.test(cmd)) return { code: 0, stdout: '2\t3\tweb:1 ' }; if (/get rs -n/.test(cmd)) return { code: 0, stdout: '3\tweb:1 ' }; return { code: 0, stdout: 'ok' } } }

    test('learns: worked when the incident closes, failed when undone or still open 45 min later', () => {
        fakeApplied('a1', 'i1', 20)
        runbooks.onIncidentClosed({ id: 'i1', orgId: org, clusterId: cluster.id, reason: 'MemoryLeakSuspected', closedAt: new Date().toISOString() })
        let rb = runbooks.runbooksOf(org)[0]
        assert.equal(rb.successes, 1); assert.equal(rb.scope, 'shop/deployment/web'); assert.equal(rb.reason, 'MemoryLeakSuspected')
        const undone = fakeApplied('a2', 'i2', 10)
        runbooks.onUndone(undone, 'MemoryLeakSuspected')
        fakeApplied('a3', 'i3', 50)
        runbooks.sweep((id) => id === 'i3' ? { id: 'i3', status: 'unresolved', reason: 'MemoryLeakSuspected' } : null)
        rb = runbooks.runbooksOf(org)[0]
        assert.equal(rb.failures, 2); assert.equal(rb.rate, 33)
        assert.equal(runbooks.suggest(org, 'MemoryLeakSuspected', workload), null, 'fails more than it works → not suggested')
        for (const [i, id] of ['b1', 'b2', 'b3'].entries()) { fakeApplied(id, `j${i}`, 5); runbooks.onIncidentClosed({ id: `j${i}`, orgId: org, clusterId: cluster.id, reason: 'MemoryLeakSuspected' }) }
        assert.equal(runbooks.suggest(org, 'MemoryLeakSuspected', workload).successes, 4)
        assert.equal(runbooks.suggest(org, 'MemoryLeakSuspected', { ...workload, name: 'other' }), null, 'only for the same workload')
    })

    test('automatic runs: only when every gate allows it', async () => {
        const rb = runbooks.runbooksOf(org)[0]
        assert.throws(() => runbooks.setAuto(org, rb.id, true), /80 %/)
        for (const [i, id] of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].entries()) { fakeApplied(id, `k${i}`, 5); runbooks.onIncidentClosed({ id: `k${i}`, orgId: org, clusterId: cluster.id, reason: 'MemoryLeakSuspected' }) }
        assert.equal(runbooks.setAuto(org, rb.id, true).auto, true)
        const inc = { id: 'new1', reason: 'MemoryLeakSuspected', target: 'web-7d9-x', namespace: 'shop' }
        const deps = (o = {}) => ({ resolveWorkload: async () => workload, onCluster: (fn) => fn(ssh), approvalsOn: () => false, maintenance: () => false, builtinAuto: () => false, timeline: () => { }, notify: () => { }, ...o })
        const why = async (o, setup = {}) => { aiStore.save(org, { enabled: true, actionsEnabled: true, autonomy: 'auto', ...setup }); return (await runbooks.maybeAutoRun(cluster, inc, deps(o), Date.now())).why }
        assert.match(await why({}, { autonomy: 'approve' }), /autonomy/)
        assert.match(await why({}, { actionsEnabled: false }), /stopped/)
        assert.match(await why({ approvalsOn: () => true }), /second person/)
        assert.match(await why({ maintenance: () => true }), /maintenance/)
        assert.match(await why({ builtinAuto: () => true }), /own automatic fix/)
        assert.match(await why({ resolveWorkload: async () => ({ ...workload, name: 'other' }) }), /this workload/)
        aiStore.save(org, { autonomy: 'auto', actionsEnabled: true })
        const r = await runbooks.maybeAutoRun(cluster, inc, deps(), Date.now())
        assert.equal(r.ran, true, r.why)
        assert.ok(ssh.cmds.some(c => /patch deployment\/web .*--dry-run=server/.test(c)), 'dry-run first')
        assert.ok(ssh.cmds.some(c => /rollout restart deployment\/web -n shop$/.test(c)))
        assert.equal(r.rec.by, 'KubeEZ AI (runbook)'); assert.equal(r.rec.incidentId, 'new1')
        assert.match(await why({}), /less than 30 minutes/)
    })
})

describe('API', () => {
    let srv, api, owner, viewer
    before(async () => {
        srv = await startServer()
        api = client(srv)
        const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).data
        const root = await login('root', 'secret123')
        owner = (await api('POST', '/api/auth/register', null, { username: 'p4boss', password: 'secret123', email: 'p4boss@example.com' })).data
        assert.equal((await api('PUT', `/api/superadmin/users/${owner.user.id}/limits`, root.token, { plan: 'FREE', maxClusters: 2, maxNodes: 10, maxMembers: 4 })).status, 200)
        assert.equal((await api('POST', '/api/admin/users', owner.token, { username: 'p4view', password: 'secret123', email: 'p4view@example.com', role: 'viewer' })).status, 200)
        viewer = await login('p4view', 'secret123')
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([{ id: 'c4', clusterName: 'four', orgId: owner.user.orgId, ownerId: owner.user.id, k8sVersion: '1.33.0', masterNodes: [{ ip: '192.0.2.44', username: 'root', password: 'x' }], workerNodes: [] }]))
    })
    after(() => srv?.stop())

    test('risk for the list (quick) and for one cluster; runbooks are for admins', async () => {
        const all = await api('GET', '/api/clusters/risk-summary', viewer.token)
        assert.equal(all.status, 200)
        assert.deepEqual([all.data.c4.score, all.data.c4.level], [55, 'medium'], JSON.stringify(all.data))   // unsupported 15, not watched 15, one control-plane 10, no offsite 5
        const one = await api('GET', '/api/clusters/c4/risk?quick=1', viewer.token)
        assert.equal(one.status, 200)
        assert.ok(one.data.factors.some(f => f.key === 'unsupported') && one.data.factors.some(f => f.key === 'single-cp'))
        assert.equal((await api('GET', '/api/clusters/nope/risk?quick=1', viewer.token)).status, 404)
        assert.equal((await api('GET', '/api/ai/runbooks', viewer.token)).status, 403)
        assert.equal((await api('GET', '/api/ai/runbooks', owner.token)).status, 200)
        assert.equal((await api('PUT', '/api/ai/runbooks/nope', owner.token, { auto: true })).status, 404)
    })
})
