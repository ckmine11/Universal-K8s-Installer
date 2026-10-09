// Auto-healing 2.0: health checks, root cause, policies, mutes, maintenance,
// stats, and who may act on incidents.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tempDataDir, startServer, client } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const { incidentDetector, analyzeHealth, analyzePods, splitSections } = await import('../src/services/incidentDetector.js')
const { remediationEngine, PLAYBOOKS } = await import('../src/services/remediationEngine.js')
const { healingPolicyStore } = await import('../src/services/healingPolicyStore.js')
const { CATALOG } = await import('../src/config/incidentCatalog.js')

const NOW = Date.parse('2026-10-09T12:00:00Z')
const ago = (min) => new Date(NOW - min * 60000).toISOString()
const J = (o) => JSON.stringify(o)

test('every catalogued problem has a playbook (fix or diagnose)', () => {
    for (const [reason, meta] of Object.entries(CATALOG)) {
        const p = PLAYBOOKS[reason]
        assert.ok(p, `playbook for ${reason}`)
        assert.ok(meta.fixable ? typeof p.fix === 'function' : typeof p.diagnose === 'function', `${reason}: ${meta.fixable ? 'fix' : 'diagnose'}`)
        assert.ok(meta.label && meta.suggestion && ['critical', 'warning', 'info'].includes(meta.severity))
    }
})

test('health checks: control plane, etcd, certificates, disk', () => {
    const certs = `CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED
admin.conf                 Oct 06, 2027 10:00 UTC   364d            ca                      no
apiserver                  Oct 14, 2026 10:00 UTC   4d              ca                      no

CERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME   EXTERNALLY MANAGED
ca                      Oct 04, 2035 10:00 UTC   8y              no`
    const cpPods = { items: [
        { metadata: { name: 'kube-apiserver-cp1', labels: { component: 'kube-apiserver' } }, spec: { nodeName: 'cp1' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } },
        { metadata: { name: 'kube-scheduler-cp1', labels: { component: 'kube-scheduler' } }, spec: { nodeName: 'cp1' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False', lastTransitionTime: ago(10) }], containerStatuses: [{ restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } },
        { metadata: { name: 'kube-controller-manager-cp1', labels: { component: 'kube-controller-manager' } }, spec: { nodeName: 'cp1' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False', lastTransitionTime: ago(0.5) }] } }   // just restarting
    ] }
    const out = `==CP==\n${J(cpPods)}\n==ETCD==\n{"health":"false","reason":"RAFT NO LEADER"}\n==CERT==\n${certs}\n==DISK==\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 96 4 96% /\ncp1\n==END==`
    const { findings, checked } = analyzeHealth(splitSections(out), { now: NOW })
    const by = (r) => findings.filter(f => f.reason === r)
    assert.equal(by('ControlPlaneDown').length, 1, 'only the component down for > 2 min')
    assert.match(by('ControlPlaneDown')[0].message, /kube-scheduler on cp1 is not ready \(CrashLoopBackOff\) — restarted 7×/)
    assert.equal(by('ControlPlaneDown')[0].nodeName, 'cp1')
    assert.match(by('EtcdUnhealthy')[0].message, /RAFT NO LEADER/)
    assert.match(by('CertExpiring')[0].message, /apiserver expires in 4 days/)
    assert.equal(by('CertExpiring')[0].severity, 'critical', '< 7 days is critical')
    assert.equal(by('ControlPlaneDiskFull')[0].severity, 'critical')
    assert.equal(by('ControlPlaneDiskFull')[0].target, 'cp1')
    // sections that were not in the output are not "checked" (open incidents stay open)
    assert.ok(!checked.has('WorkloadUnavailable') && !checked.has('PVCPending'))

    const down = analyzeHealth(splitSections(`==CP==\nThe connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?\n==END==`), { now: NOW })
    assert.equal(down.findings[0].reason, 'ControlPlaneDown')
    assert.equal(down.findings[0].target, 'kube-apiserver')

    const expired = analyzeHealth(splitSections(`==CERT==\nCERTIFICATE EXPIRES RESIDUAL TIME\napiserver   Oct 01, 2026 10:00 UTC   <invalid>   ca   no\n==END==`), { now: NOW })
    assert.match(expired.findings[0].message, /EXPIRED/)
})

test('health checks: workloads, volume claims, jobs (only after 5 minutes)', () => {
    const wl = { items: [
        { kind: 'Deployment', metadata: { name: 'web', namespace: 'shop' }, spec: { replicas: 3 }, status: { availableReplicas: 1, conditions: [{ type: 'Available', status: 'False', lastTransitionTime: ago(12) }] } },
        { kind: 'Deployment', metadata: { name: 'api', namespace: 'shop' }, spec: { replicas: 2 }, status: { availableReplicas: 1, conditions: [{ type: 'Available', status: 'False', lastTransitionTime: ago(1) }] } },
        { kind: 'Deployment', metadata: { name: 'idle', namespace: 'shop' }, spec: { replicas: 0 }, status: {} },
        { kind: 'DaemonSet', metadata: { name: 'kube-proxy', namespace: 'kube-system' }, status: { desiredNumberScheduled: 3, numberAvailable: 2 } }
    ] }
    const pvc = { items: [
        { metadata: { name: 'data', namespace: 'shop', creationTimestamp: ago(30) }, spec: { resources: { requests: { storage: '10Gi' } } }, status: { phase: 'Pending' } },
        { metadata: { name: 'ok', namespace: 'shop', creationTimestamp: ago(30) }, status: { phase: 'Bound' } }
    ] }
    const jobs = { items: [
        { metadata: { name: 'backup-123', namespace: 'ops' }, status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', lastTransitionTime: ago(30) }] } },
        { metadata: { name: 'old', namespace: 'ops' }, status: { conditions: [{ type: 'Failed', status: 'True', lastTransitionTime: ago(60 * 24) }] } }
    ] }
    const first = new Map()
    const since = (k) => { if (!first.has(k)) first.set(k, NOW - 6 * 60000); return first.get(k) }   // DaemonSet seen 6 min ago
    const out = `==WL==\n${J(wl)}\n==PVC==\n${J(pvc)}\n==JOB==\n${J(jobs)}\n==END==`
    const { findings } = analyzeHealth(splitSections(out), { now: NOW, since })
    const t = findings.map(f => `${f.reason}:${f.namespace}/${f.target}`).sort()
    assert.deepEqual(t, [
        'JobFailed:ops/backup-123',
        'PVCPending:shop/data',
        'WorkloadUnavailable:kube-system/daemonset/kube-proxy',
        'WorkloadUnavailable:shop/deployment/web'
    ])
    assert.equal(findings.find(f => f.target === 'daemonset/kube-proxy').severity, 'critical', 'kube-system workloads are critical')
    assert.match(findings.find(f => f.target === 'deployment/web').message, /1\/3 ready for 12m/)
})

test('pods: owner and node are recorded; OOM from the last restart is seen', () => {
    const pods = { items: [{
        metadata: { name: 'web-7d9f-abcde', namespace: 'shop', ownerReferences: [{ kind: 'ReplicaSet', name: 'web-7d9f' }] }, spec: { nodeName: 'w1' },
        status: { containerStatuses: [{ name: 'app', restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] }
    }] }
    const f = analyzePods(pods, NOW)
    assert.deepEqual(f.map(x => x.reason).sort(), ['CrashLoopBackOff', 'OOMKilled'])
    assert.equal(f[0].nodeName, 'w1')
    assert.equal(f[0].ownerHint, 'ReplicaSet/web-7d9f')
    assert.match(f[0].message, /restarted 4×, last exit: OOMKilled \(code 137\)/)
})

// ── Detector behaviour with a fake cluster ─────────────────────────────────
const dispatched = []
remediationEngine.handleAnomaly = async (cluster, event, incident, opts) => { dispatched.push([incident.reason, incident.target, !!opts?.force]) }
const cluster = { id: 'hc1', clusterName: 'prod', orgId: 'orgH', ownerId: 'u1', masterNodes: [{ ip: '10.0.0.1' }] }

test('a node down is the root cause of the pod problems on it', () => {
    dispatched.length = 0
    incidentDetector._createIncident(cluster, { reason: 'NodeNotReady', target: 'w1', nodeName: 'w1', message: 'w1 down' })
    incidentDetector._createIncident(cluster, { reason: 'PodPendingTooLong', target: 'web-1', namespace: 'shop', nodeName: 'w1', message: 'pending' })
    const node = incidentDetector.getIncidents().find(i => i.clusterId === 'hc1' && i.reason === 'NodeNotReady')
    const pod = incidentDetector.getIncidents().find(i => i.clusterId === 'hc1' && i.reason === 'PodPendingTooLong')
    assert.equal(pod.causedBy, node.id)
    assert.match(pod.details, /Caused by node down on w1/)
    assert.deepEqual(dispatched.map(d => d[0]), ['NodeNotReady'], 'no separate "fix" for the consequence')
    assert.equal(pod.timeline[0].kind, 'detected')
})

test('policies: notify = alert only, off = not detected; Run fix now forces it', async () => {
    dispatched.length = 0
    healingPolicyStore.savePolicies('orgH', { DiskPressure: 'notify', MemoryPressure: 'off' })
    incidentDetector._createIncident(cluster, { reason: 'DiskPressure', target: 'w2', nodeName: 'w2', message: 'disk' })
    assert.equal(incidentDetector._createIncident(cluster, { reason: 'MemoryPressure', target: 'w2', message: 'mem' }), null)
    const disk = incidentDetector.getIncidents().find(i => i.clusterId === 'hc1' && i.reason === 'DiskPressure')
    assert.equal(disk.status, 'unresolved')
    assert.match(disk.details, /Alert only/)
    assert.equal(dispatched.length, 0)
    incidentDetector.watched.set('hc1', cluster)
    await incidentDetector.runNow(disk.id, 'otto')
    assert.deepEqual(dispatched.at(-1), ['DiskPressure', 'w2', true])
    assert.ok(disk.timeline.some(t => t.kind === 'manual' && t.by === 'otto'))
    healingPolicyStore.savePolicies('orgH', { DiskPressure: 'auto', MemoryPressure: 'auto' })
})

test('mute: no fix and no alert for that incident; ack is recorded', () => {
    dispatched.length = 0
    incidentDetector._createIncident(cluster, { reason: 'CrashLoopBackOff', target: 'api-1', namespace: 'shop', message: 'crash' })
    const inc = incidentDetector.getIncidents().find(i => i.target === 'api-1')
    incidentDetector.mute(inc.id, 24, 'ann')
    assert.ok(inc.muted)
    inc.lastDispatchedAt = new Date(0).toISOString()   // as if 5 minutes passed
    dispatched.length = 0
    incidentDetector._createIncident(cluster, { reason: 'CrashLoopBackOff', target: 'api-1', namespace: 'shop', message: 'crash again' })
    assert.equal(dispatched.length, 0)
    assert.equal(inc.count, 2)
    incidentDetector.acknowledge(inc.id, 'ann')
    assert.equal(inc.ackBy, 'ann')
})

test('maintenance: the cluster is not polled', async () => {
    let calls = 0
    incidentDetector.streams.set('hc1', { ssh: { execCommand: async () => { calls++; return { code: 0, stdout: '{"items":[]}' } } }, timers: [], failCount: 0, cluster })
    healingPolicyStore.setMaintenance('orgH', 'hc1', 2, 'ann')
    await incidentDetector._pollNodes('hc1')
    assert.equal(calls, 0)
    healingPolicyStore.setMaintenance('orgH', 'hc1', 0)
    await incidentDetector._pollNodes('hc1')
    assert.equal(calls, 1)
    incidentDetector.stopWatching('hc1')
})

test('stats: open by severity, fixed, MTTR, per day', () => {
    const s = incidentDetector.getStats(i => i.orgId === 'orgH', 7)
    // the maintenance test's last poll saw every node healthy → node + disk incidents cleared
    assert.equal(s.open.total, 2)
    assert.equal(s.cleared, 2)
    assert.ok(s.mttrMinutes !== null)
    assert.equal(s.daily.length, 7)
    assert.ok(s.top.length && s.top[0].label)
    assert.ok(s.perCluster.find(c => c.clusterId === 'hc1'))
})

test('API: viewers see but cannot act; operators act; only admins change policies', async () => {
    const srv = await startServer()
    const api = client(srv)
    try {
        const root = (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data
        const ann = (await api('POST', '/api/auth/register', null, { username: 'annh', password: 'annpass123', email: 'annh@example.com' })).data
        await api('PUT', `/api/superadmin/users/${ann.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 5 })
        await api('POST', '/api/admin/users', ann.token, { username: 'vic', password: 'vicpass123', email: 'vic@example.com', role: 'viewer' })
        await api('POST', '/api/admin/users', ann.token, { username: 'otto', password: 'ottopass123', email: 'otto@example.com', role: 'operator' })
        const vic = (await api('POST', '/api/auth/login', null, { username: 'vic', password: 'vicpass123' })).data
        const otto = (await api('POST', '/api/auth/login', null, { username: 'otto', password: 'ottopass123' })).data

        const cat = (await api('GET', '/api/incidents/catalog', vic.token)).data
        assert.equal(cat.policies.NodeNotReady, 'auto')
        assert.equal(cat.catalog.CertExpiring.policy, 'notify')
        assert.equal((await api('GET', '/api/incidents/stats', vic.token)).status, 200)
        assert.equal((await api('PUT', '/api/incidents/policy', otto.token, { policies: { DiskPressure: 'notify' } })).status, 403)
        const r = await api('PUT', '/api/incidents/policy', ann.token, { policies: { DiskPressure: 'notify', Bogus: 'auto', NodeNotReady: 'explode' } })
        assert.equal(r.data.policies.DiskPressure, 'notify')
        assert.equal(r.data.policies.NodeNotReady, 'auto', 'invalid values are ignored')
        assert.equal((await api('POST', '/api/incidents/nope/ack', vic.token)).status, 403, 'viewer cannot act')
        assert.equal((await api('POST', '/api/incidents/nope/ack', otto.token)).status, 404)
    } finally { await srv.stop() }
})
