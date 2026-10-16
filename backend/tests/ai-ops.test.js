// KubeEZ AI phase 2: "What changed?", Install Doctor, incident explainer and
// the safe fixes (dry-run, apply, undo) — with a fake cluster (SSH) and a fake
// model server; and the API gates (permissions, kill switch, approval).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { startServer, client, tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
const { parseClusterChanges, kubeezChanges, collectChanges } = await import('../src/services/ai/changes.js')
const { checkEvidence, allowedActions, pickAction, explainInstall, explainIncident, installFacts, asList, finish, screenSteps, shape } = await import('../src/services/ai/doctor.js')
const { planAction, applyAction, undoAction, cleanSpec, actionLog } = await import('../src/services/ai/actions.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { auditLog } = await import('../src/services/auditLog.js')
after(() => { process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const H = 3600e3
const NOW = Date.parse('2026-10-17T12:00:00Z')
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()

describe('What changed?', () => {
    const out = [
        '==RS==',
        `${iso(48 * H)}\tshop\tDeployment\tweb\t1\tnginx:1.25 `,
        `${iso(2 * H)}\tshop\tDeployment\tweb\t2\tnginx:1.27 `,
        `${iso(1 * H)}\tshop\tDeployment\tapi\t1\tapi:v1 `,
        `${iso(30 * 60e3)}\tshop\tDeployment\tapi\t2\tapi:v1 `,
        '==CR==',
        `${iso(50 * H)}\tdata\tStatefulSet\tpg\t1`,
        `${iso(3 * H)}\tdata\tStatefulSet\tpg\t2`,
        '==HELM==',
        `${iso(4 * H)}\tmonitoring\tkube-prometheus\t3\tdeployed`,
        '==CM==',
        `shop\tweb-config\t${iso(100 * H)}\t${iso(100 * H)} ${iso(90 * 60e3)} `,
        `shop\tkube-root-ca.crt\t${iso(100 * H)}\t${iso(10 * 60e3)} `,
        `shop\told\t${iso(100 * H)}\t${iso(80 * H)} `,
        '==SECRET==',
        `shop\tdb-password\t${iso(5 * H)}\t${iso(5 * H)} `,
        '==NODE==',
        `${iso(6 * H)}\tworker-3\tv1.35.0`,
        `${iso(900 * H)}\tmaster-1\tv1.35.0`,
        '==NS==',
        `${iso(7 * H)}\tpayments`,
        '==END=='
    ].join('\n')

    test('rollouts with old → new image, revisions, Helm, config by name, nodes, namespaces — only inside the window', () => {
        const items = parseClusterChanges(out, { from: NOW - 24 * H, to: NOW })
        const t = (needle) => items.find(i => i.title.includes(needle))
        assert.equal(t('Deployment web rolled out').detail, 'image nginx:1.25 → nginx:1.27')
        assert.match(t('Deployment api rolled out').detail, /same image/)
        assert.ok(t('Deployment api created'))
        assert.ok(t('StatefulSet pg rolled out (revision 2)'))
        assert.ok(t('Helm release kube-prometheus upgraded (revision 3)'))
        assert.ok(t('ConfigMap web-config changed'))
        assert.equal(t('kube-root-ca'), undefined, 'noise is left out')
        assert.equal(t('ConfigMap old'), undefined, 'outside the window')
        assert.match(t('Secret db-password created').detail, /never read/)
        assert.ok(t('Node worker-3 joined'))
        assert.equal(t('master-1'), undefined)
        assert.ok(t('Namespace payments created'))
        assert.equal(t('Deployment web created'), undefined, 'revision 1 of web is older than the window')
    })

    test('KubeEZ side: the audit trail in words; questions and approvals are not changes', () => {
        auditLog.record({ orgId: 'o1', actor: { username: 'alice' }, action: 'POST /api/clusters/:id/upgrade', target: { clusterId: 'c1' } })
        auditLog.record({ orgId: 'o1', actor: { username: 'alice' }, action: 'POST /api/clusters/:id/addons/:key/settings', target: { clusterId: 'c1' } })
        auditLog.record({ orgId: 'o1', actor: { username: 'alice' }, action: 'ai.ask', target: { clusterId: 'c1' } })
        auditLog.record({ orgId: 'o1', actor: { username: 'alice' }, action: 'POST /api/clusters/:id/addons/:key/preview', target: { clusterId: 'c1' } })
        auditLog.record({ orgId: 'o1', actor: { username: 'bob' }, action: 'POST /api/clusters/:id/upgrade', target: { clusterId: 'other' } })
        auditLog.record({ orgId: 'o1', actor: { username: 'alice' }, action: 'POST /api/clusters/:id/upgrade', target: { clusterId: 'c1' }, ok: false })
        const k = kubeezChanges('o1', 'c1', { from: Date.now() - H })
        assert.deepEqual(k.map(i => i.title).sort(), ['Add-on settings changed', 'Kubernetes upgrade started'])
        assert.equal(k[0].actor, 'alice')
    })

    test('a cluster that cannot be reached still shows KubeEZ\'s changes', async () => {
        const r = await collectChanges({ id: 'c1', orgId: 'o1', masterNodes: [] }, { hours: 1, connect: async () => { throw new Error('ssh down') } })
        assert.match(r.clusterError, /ssh down/)
        assert.equal(r.items.length, 2)
        const ok = await collectChanges({ id: 'c2', orgId: 'o1' }, { from: NOW - 24 * H, to: NOW, connect: async () => ({ execCommand: async () => ({ stdout: out }), dispose() { } }) })
        assert.ok(ok.items.some(i => i.title.includes('web rolled out')))
        assert.ok(ok.items.every((x, i, a) => i === 0 || a[i - 1].at >= x.at), 'newest first')
    })
})

// ── a fake cluster for actions: records commands, answers like kubectl ──
function fakeCluster({ replicas = 3, revision = 5, revisions = [[5, 'web:2.0'], [4, 'web:1.9']], podOwner = 'ReplicaSet\tweb-abc', failDryRun = false } = {}) {
    const cmds = []
    return {
        cmds,
        ssh: {
            async execCommand(cmd) {
                cmds.push(cmd)
                if (/get pod .* -o jsonpath/.test(cmd)) return { code: 0, stdout: `${podOwner}\tRunning` }
                if (/get (deployment|statefulset|daemonset)\/\S+ .*-o jsonpath/.test(cmd)) return { code: 0, stdout: `${replicas}\t${revision}\tweb:2.0 ` }
                if (/get rs -n/.test(cmd)) return { code: 0, stdout: revisions.map(([r, i]) => `${r}\t${i} `).join('\n') }
                if (/--dry-run=server/.test(cmd)) return failDryRun ? { code: 1, stderr: 'admission webhook denied' } : { code: 0, stdout: 'ok (server dry run)' }
                return { code: 0, stdout: 'done' }
            }
        }
    }
}
const DEP = { type: 'rollback', kind: 'deployment', name: 'web', namespace: 'shop' }
const CL = { id: 'c1', clusterName: 'prod' }
const ALICE = { username: 'alice' }

describe('safe fixes', () => {
    test('only the fixed list, only valid names', () => {
        assert.throws(() => cleanSpec({ type: 'exec', kind: 'pod', name: 'x' }), /Unknown action/)
        assert.throws(() => cleanSpec({ type: 'restart', kind: 'pod', name: 'x' }), /works on/)
        assert.throws(() => cleanSpec({ type: 'restart', kind: 'deployment', name: 'web; rm -rf /', namespace: 'shop' }), /valid Kubernetes name/)
        assert.throws(() => cleanSpec({ type: 'scale', kind: 'deployment', name: 'web', replicas: 500 }), /0 – 100/)
    })

    test('rollback: preview shows the versions and a server-side dry-run; apply runs it; undo rolls forward again', async () => {
        const f = fakeCluster()
        const p = await planAction(f.ssh, DEP)
        assert.equal(p.ok, true)
        assert.match(p.change, /Revision 5 → 4: image web:2.0 → web:1.9/)
        assert.ok(f.cmds.some(c => /rollout undo deployment\/web -n shop --to-revision=4 --dry-run=server/.test(c)))
        assert.equal(f.cmds.some(c => /rollout undo/.test(c) && !/dry-run/.test(c)), false, 'a preview changes nothing')
        const rec = await applyAction(f.ssh, DEP, { orgId: 'o1', cluster: CL, user: ALICE, incidentId: 'i1' })
        assert.ok(f.cmds.some(c => /rollout undo deployment\/web -n shop --to-revision=4$/.test(c)))
        assert.equal(rec.undo.toRevision, 5)
        assert.equal(actionLog.get(rec.id).status, 'applied')
        await undoAction(f.ssh, rec, ALICE)
        assert.match(f.cmds.at(-1), /rollout undo deployment\/web -n shop --to-revision=5$/)
        assert.equal(rec.status, 'undone')
        await assert.rejects(undoAction(f.ssh, rec, ALICE), /Already undone/)
    })

    test('scale: undo puts the old replica count back; scaling to 0 is high risk', async () => {
        const f = fakeCluster({ replicas: 2 })
        const rec = await applyAction(f.ssh, { type: 'scale', kind: 'deployment', name: 'web', namespace: 'shop', replicas: 5 }, { orgId: 'o1', cluster: CL, user: ALICE })
        assert.match(rec.change, /Replicas 2 → 5/)
        await undoAction(f.ssh, rec, ALICE)
        assert.match(f.cmds.at(-1), /scale deployment\/web -n shop --replicas=2$/)
        assert.equal((await planAction(f.ssh, { type: 'scale', kind: 'deployment', name: 'web', namespace: 'shop', replicas: 0 })).risk, 'high')
        assert.match((await planAction(f.ssh, { type: 'scale', kind: 'deployment', name: 'web', namespace: 'shop', replicas: 2 })).blocked, /already runs 2/)
    })

    test('never: a pod without a controller, a rollback with no earlier revision, a failing dry-run', async () => {
        const lone = fakeCluster({ podOwner: '\t' })
        const p = await planAction(lone.ssh, { type: 'delete-pod', kind: 'pod', name: 'debug', namespace: 'shop' })
        assert.match(p.blocked, /no controller/)
        await assert.rejects(applyAction(lone.ssh, { type: 'delete-pod', kind: 'pod', name: 'debug', namespace: 'shop' }, { orgId: 'o1', cluster: CL, user: ALICE }), /no controller/)
        assert.equal(lone.cmds.some(c => /delete pod/.test(c)), false)
        const first = fakeCluster({ revision: 1, revisions: [[1, 'web:1']] })
        assert.match((await planAction(first.ssh, DEP)).blocked, /no earlier revision/)
        const denied = fakeCluster({ failDryRun: true })
        await assert.rejects(applyAction(denied.ssh, { type: 'restart', kind: 'deployment', name: 'web', namespace: 'shop' }, { orgId: 'o1', cluster: CL, user: ALICE }), /dry-run failed, nothing was changed.*admission webhook/)
        assert.equal(denied.cmds.some(c => /rollout restart/.test(c) && !/dry-run/.test(c)), false)
        const rf = fakeCluster()
        const restart = await applyAction(rf.ssh, { type: 'restart', kind: 'deployment', name: 'web', namespace: 'shop' }, { orgId: 'o1', cluster: CL, user: ALICE })
        assert.ok(rf.cmds.some(c => /patch deployment\/web -n shop --type merge .*restartedAt.* --dry-run=server$/.test(c)), 'kubectl rollout restart has no --dry-run: the same patch is dry-run instead')
        assert.equal(rf.cmds.some(c => /rollout restart.*--dry-run/.test(c)), false)
        assert.match(rf.cmds.at(-1), /rollout restart deployment\/web -n shop$/)
        assert.equal(restart.undo.possible, false)
        await assert.rejects(undoAction(fakeCluster().ssh, restart, ALICE), /Nothing to undo/)
    })
})

// ── a fake model ──
function fakeModel(reply) {
    const seen = []
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c); req.on('end', () => {
            seen.push(JSON.parse(b))
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: typeof reply === 'function' ? reply(JSON.parse(b)) : reply } }] }))
        })
    })
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => { srv.closeAllConnections?.(); srv.close() } })))
}

describe('the doctor', () => {
    test('evidence must be in the data', () => {
        const src = 'line one\n[ERROR] kubelet: failed to pull image "pause:3.9": i/o timeout\nline three'
        const r = checkEvidence(['failed to pull image "pause:3.9": i/o timeout', 'ERROR]   KUBELET:  Failed to pull', 'containerd crashed with code 137'], src)
        assert.equal(r.kept.length, 2); assert.equal(r.dropped.length, 1)
    })

    test('steps that would damage the cluster never reach the user; risky ones are marked', () => {
        const a = finish({ summary: 'config file missing', cause: 'no config.yaml', evidence: [], fix: ['Mount the ConfigMap', 'run: kubectl delete namespace kube-system', 'sudo kubeadm reset -f', 'kubectl delete pods --all -A', 'rm -rf /'], confidence: 'high' }, 'x')
        assert.deepEqual(a.fix, ['Mount the ConfigMap', 'sudo kubeadm reset -f'])
        assert.deepEqual(a.blockedSteps, ['run: kubectl delete namespace kube-system', 'kubectl delete pods --all -A', 'rm -rf /'])
        assert.deepEqual(a.cautionSteps, ['sudo kubeadm reset -f'])
        assert.deepEqual(screenSteps(['kubectl rollout undo deployment/web -n shop', 'sudo swapoff -a', 'kubectl delete pod web-1 -n shop']).removed, [])
        assert.deepEqual(screenSteps(['etcdctl del --prefix /registry', 'iptables -F', 'mkfs.ext4 /dev/sdb']).removed.length, 3)
    })

    test('an answer that copies the format description is rejected (one correction, then the next engine)', () => {
        assert.match(shape({ summary: 'Workload not available', cause: 'the most likely root cause', fix: ['Short concrete steps, in order', 'commands in backticks'] }), /copied the format/)
        assert.equal(shape({ summary: 'billing has 0 replicas', cause: 'unknown — events needed', fix: ['kubectl describe deployment billing'] }), null)
    })

    test('a small model\'s loose format is still used (steps as text, steps as objects)', () => {
        assert.deepEqual(asList('1. Check the db Service 2. Restart the pod'), ['Check the db Service', 'Restart the pod'])
        assert.deepEqual(asList('- a\n- b'), ['a', 'b'])
        assert.deepEqual(asList([{ step: 'x' }, 'y']), ['x', 'y'])
        assert.deepEqual(asList(''), [])
    })

    test('Install Doctor: the log goes in masked, invented proof is removed', async () => {
        const m = await fakeModel(JSON.stringify({ summary: 'containerd could not pull the pause image', cause: 'No route to registry.k8s.io', evidence: ['dial tcp: lookup registry.k8s.io: i/o timeout', 'swap is enabled on node 2'], fix: ['Allow outbound HTTPS to registry.k8s.io', 'Resume'], confidence: 'high', missing: '' }))
        try {
            aiStore.addProvider('o-doc', { name: 'Fake', kind: 'ollama', baseUrl: m.base, model: 'm' })
            const inst = { id: 'i1', clusterName: 'prod', mode: 'install', k8sVersion: '1.35.0', currentStep: 'installKubernetes', progress: 40, error: 'kubeadm init failed', masterNodes: [{}], workerNodes: [],
                diagnosis: { reason: 'KUBEADM_INIT', message: 'kubeadm init failed', suggestedFix: 'check the log' },
                logs: [{ level: 'info', message: 'Installing containerd' }, { level: 'info', message: 'export TOKEN=password=Sup3rS3cret' }, { level: 'error', message: '[ERROR ImagePull]: failed to pull image registry.k8s.io/pause:3.10: dial tcp: lookup registry.k8s.io: i/o timeout' }] }
            assert.match(installFacts(inst).facts, /KUBEADM_INIT/)
            const r = await explainInstall({ id: 'u', username: 'alice', orgId: 'o-doc' }, inst)
            assert.deepEqual(r.answer.evidence, ['dial tcp: lookup registry.k8s.io: i/o timeout'])
            assert.equal(r.answer.unverified, 1)
            assert.equal(r.answer.fix.length, 2)
            assert.equal(JSON.stringify(m.seen).includes('Sup3rS3cret'), false, 'secrets in the log are masked')
            assert.ok(r.engine.masked >= 1)
        } finally { m.close() }
    })

    test('incident explainer: the change before it is named; only an allowed fix for this incident is kept', async () => {
        const inc = { id: 'x', reason: 'CrashLoopBackOff', severity: 'warning', status: 'unresolved', target: 'web-7d9-abc', namespace: 'shop', owner: 'ReplicaSet/web-7d9', message: 'shop/web-7d9-abc in CrashLoopBackOff', timestamp: iso(0), lastSeen: iso(0), timeline: [{ at: iso(0), kind: 'detected', text: 'crash' }] }
        const fresh = { data: [{ label: 'previous container log', text: 'Error: cannot connect to postgres at db:5432' }], workload: { kind: 'deployment', name: 'web', namespace: 'shop' } }
        const allowed = allowedActions(inc, fresh.workload)
        assert.deepEqual(allowed.map(a => a.type).sort(), ['delete-pod', 'restart', 'rollback', 'scale'])
        assert.equal(pickAction({ type: 'rollback', target: 'deployment/other' }, allowed), null, 'not this incident\'s workload')
        assert.equal(pickAction({ type: 'scale', target: 'deployment/web', replicas: 0 }, allowed), null, 'never suggests scaling to 0')
        assert.equal(pickAction({ type: 'exec', target: 'deployment/web' }, allowed), null)
        const changes = [{ at: iso(10 * 60e3), source: 'cluster', kind: 'rollout', ns: 'shop', title: 'Deployment web rolled out (revision 6)', detail: 'image web:1.9 → web:2.0' }]
        const m = await fakeModel((body) => {
            assert.match(body.messages[0].content, /rollback \| restart|restart \| rollback/)
            return JSON.stringify({ summary: 'web crashes since the new version', cause: 'web:2.0 cannot reach postgres', evidence: ['cannot connect to postgres at db:5432'], change: 'shop: Deployment web rolled out (revision 6) — image web:1.9 → web:2.0', action: { type: 'rollback', target: 'deployment/web' }, fix: ['Roll back', 'Check DB_HOST in 2.0'], confidence: 'high' })
        })
        try {
            aiStore.addProvider('o-inc', { name: 'Fake', kind: 'ollama', baseUrl: m.base, model: 'm' })
            const r = await explainIncident({ id: 'u', username: 'alice', orgId: 'o-inc' }, { incident: inc, catalog: { label: 'Crash loop' }, cluster: { id: 'c1', clusterName: 'prod' }, fresh, changes, related: null })
            assert.deepEqual(r.answer.action, { type: 'rollback', kind: 'deployment', name: 'web', namespace: 'shop' })
            assert.match(r.answer.change, /web:1\.9 → web:2\.0/)
            assert.deepEqual(r.answer.evidence, ['cannot connect to postgres at db:5432'])
            assert.equal(r.answer.confidence, 'high')
        } finally { m.close() }
    })
})

describe('API', () => {
    let srv, api, owner, viewer, operator
    const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).data
    const spec = { type: 'restart', kind: 'deployment', name: 'web', namespace: 'shop' }

    before(async () => {
        srv = await startServer()
        api = client(srv)
        const root = await login('root', 'secret123')
        owner = (await api('POST', '/api/auth/register', null, { username: 'opsboss', password: 'secret123', email: 'opsboss@example.com' })).data
        assert.equal((await api('PUT', `/api/superadmin/users/${owner.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 6 })).status, 200)
        for (const [u, role] of [['opsview', 'viewer'], ['opsop', 'operator'], ['opsadm2', 'admin']]) assert.equal((await api('POST', '/api/admin/users', owner.token, { username: u, password: 'secret123', email: `${u}@example.com`, role })).status, 200)
        viewer = await login('opsview', 'secret123'); operator = await login('opsop', 'secret123')
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
            { id: 'c1', clusterName: 'prod', orgId: owner.user.orgId, ownerId: owner.user.id, k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.40', username: 'root', password: 'x' }], workerNodes: [] }
        ]))
    })
    after(() => srv?.stop())

    test('who may preview / apply / see; unknown things are 404', async () => {
        assert.equal((await api('POST', '/api/clusters/c1/ai-actions/preview', viewer.token, { spec })).status, 403, 'viewers do not act')
        assert.equal((await api('GET', '/api/clusters/c1/ai-actions', viewer.token)).status, 200)
        assert.equal((await api('POST', '/api/clusters/c1/ai-actions/preview', operator.token, { spec: { ...spec, name: 'x;reboot' } })).status, 400)
        assert.equal((await api('GET', '/api/ai/changes/nope', owner.token)).status, 404)
        assert.equal((await api('POST', '/api/ai/explain/install/nope', owner.token)).status, 404)
        assert.equal((await api('POST', '/api/ai/explain/incident/nope', owner.token)).status, 404)
    })

    test('the kill switch and "suggest only" stop fixes before anything touches the cluster', async () => {
        assert.equal((await api('PUT', '/api/ai/settings', owner.token, { actionsEnabled: false })).status, 200)
        let r = await api('POST', '/api/clusters/c1/ai-actions', operator.token, { spec })
        assert.equal(r.status, 403); assert.equal(r.data.code, 'AI_ACTIONS_STOPPED')
        assert.equal((await api('PUT', '/api/ai/settings', owner.token, { actionsEnabled: true, autonomy: 'suggest' })).status, 200)
        r = await api('POST', '/api/clusters/c1/ai-actions/preview', operator.token, { spec })
        assert.equal(r.status, 403); assert.equal(r.data.code, 'AI_SUGGEST_ONLY')
        assert.equal((await api('PUT', '/api/ai/settings', owner.token, { autonomy: 'approve' })).status, 200)
    })

    test('two-person approval can protect AI fixes', async () => {
        assert.equal((await api('PUT', '/api/approvals/settings', owner.token, { actions: { 'ai:action': true } })).status, 200)
        const r = await api('POST', '/api/clusters/c1/ai-actions', operator.token, { spec })
        assert.equal(r.status, 428)
        assert.match(r.data.summary, /KubeEZ AI fix on prod: restart deployment shop\/web/)
        const req = await api('POST', '/api/approvals', operator.token, { kind: 'action', action: 'ai:action', clusterId: 'c1', method: 'POST', path: '/api/clusters/c1/ai-actions', body: { spec }, reason: 'web is stuck, restart it' })
        assert.equal(req.status, 200, JSON.stringify(req.data))
    })
})

describe('slow answers become jobs (no proxy timeout)', () => {
    let srv, api, owner, model
    before(async () => {
        // the server's own model: answers after 1.5 s; the request waits only 300 ms
        model = http.createServer((req, res) => {
            if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'm' }] })) }
            let b = ''; req.on('data', c => b += c); req.on('end', () => setTimeout(() => {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ choices: [{ message: { content: '- Kubernetes was upgraded by opsjob' } }] }))
            }, 1500))
        })
        await new Promise(r => model.listen(0, '127.0.0.1', r))
        srv = await startServer({ KUBEEZ_AI_URL: `http://127.0.0.1:${model.address().port}`, KUBEEZ_AI_MODEL: 'm', KUBEEZ_AI_JOB_WAIT_MS: '300' })
        api = client(srv)
        owner = (await api('POST', '/api/auth/register', null, { username: 'opsjob', password: 'secret123', email: 'opsjob@example.com' })).data
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([{ id: 'c9', clusterName: 'slow', orgId: owner.user.orgId, ownerId: owner.user.id, k8sVersion: '1.35.0', masterNodes: [], workerNodes: [] }]))
    })
    after(() => { srv?.stop(); model?.close() })

    test('202 with a job id, then the answer by polling; asking again joins the same job', async () => {
        const first = await api('POST', '/api/ai/changes/c9/summary', owner.token, { hours: 24 })
        assert.equal(first.status, 202, JSON.stringify(first.data))
        assert.match(first.data.jobId, /^[0-9a-f]{16}$/)
        const again = await api('POST', '/api/ai/changes/c9/summary', owner.token, { hours: 24 })
        assert.equal(again.data.jobId, first.data.jobId, 'no second model call')
        let r
        for (let i = 0; i < 40; i++) { r = await api('GET', `/api/ai/jobs/${first.data.jobId}`, owner.token); if (r.status !== 202) break; await new Promise(x => setTimeout(x, 200)) }
        assert.equal(r.status, 200, JSON.stringify(r.data))
        assert.match(r.data.summary, /upgraded/)
        assert.equal(r.data.engine.provider, 'KubeEZ server model')
        const other = (await api('POST', '/api/auth/register', null, { username: 'nosy', password: 'secret123', email: 'nosy@example.com' })).data
        assert.equal((await api('GET', `/api/ai/jobs/${first.data.jobId}`, other.token)).status, 404, 'another workspace cannot read it')
    })
})
