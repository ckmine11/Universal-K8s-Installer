// KubeEZ AI phase 2 on a REAL cluster: "What changed?" sees real rollouts
// (with old → new image), ConfigMap edits and namespaces; the safe fixes
// really run — dry-run first, then rollback / scale / restart / delete-pod —
// and undo really puts things back; the incident explainer gets the real pod
// log as evidence (a fake model answers, so the result is deterministic).
// Run via: bash tests/e2e/e2e.sh ai-ops [distro]
process.env.APP_SECRET = 'e2e-only-secret-0123456789abcdef0123456789abcdef'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'
import { spawnSync } from 'node:child_process'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-aiops-'))
process.env.KUBEEZ_DATA_DIR = DATA
process.env.KUBEEZ_MODE = 'selfhosted'
delete process.env.KUBEEZ_AI_URL

const NODE = process.env.NODE_CONTAINER
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd, input) => { const r = spawnSync('docker', ['exec', '-i', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, input, maxBuffer: 64 << 20 }); return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' } }
const ssh = { execCommand: async (cmd) => dx(cmd), dispose() { } }
const K = (cmd) => { const r = dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`); return { ...r, out: r.stdout.trim() } }
const C = { id: 'c-ai', clusterName: 'ai', orgId: 'org-ai', ownerId: 'u1', masterNodes: [{ ip: '127.0.0.1', username: 'root' }], workerNodes: [] }
const USER = { id: 'u1', username: 'boss', orgId: 'org-ai', role: 'admin' }

const { collectChanges } = await import('../../backend/src/services/ai/changes.js')
const { planAction, applyAction, undoAction } = await import('../../backend/src/services/ai/actions.js')
const { collectIncidentData, explainIncident, allowedActions } = await import('../../backend/src/services/ai/doctor.js')
const { aiStore } = await import('../../backend/src/services/ai/aiStore.js')

let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn, secs = 240) => { for (let i = 0; i < secs / 3; i++) { if (await fn()) return true; await sleep(3000) } return false }
const image = () => K(`-n shop get deploy web -o jsonpath='{.spec.template.spec.containers[0].image}'`).out
const rolledOut = () => K('-n shop rollout status deploy/web --timeout=180s').code === 0

console.log('== a real app with history')
K('create namespace shop')
K('-n shop create deployment web --image=nginx:1.27-alpine --replicas=1')
ok(await waitFor(rolledOut), 'web 1.27 is running')
K('-n shop create configmap web-config --from-literal=mode=a')
await sleep(1500)
K('-n shop set image deploy/web nginx=nginx:1.28-alpine')
ok(await waitFor(rolledOut), 'web rolled out to 1.28')
K(`-n shop patch configmap web-config -p '{"data":{"mode":"b"}}'`)

console.log('== What changed?')
const ch = await collectChanges(C, { hours: 1, connect: async () => ssh })
const find = (re) => ch.items.find(i => re.test(i.title))
ok(!ch.clusterError, `the cluster was read${ch.clusterError ? `: ${ch.clusterError}` : ''}`)
ok(find(/Deployment web rolled out/)?.detail === 'image nginx:1.27-alpine → nginx:1.28-alpine', `rollout with the image change (${find(/Deployment web rolled out/)?.detail})`)
ok(!!find(/Deployment web created/), 'first version: created')
ok(!!find(/ConfigMap web-config (created|changed)/), 'ConfigMap edit')
ok(!!find(/Namespace shop created/), 'new namespace')
ok(!ch.items.some(i => /kube-root-ca/.test(i.title)), 'no noise')

console.log('== rollback: dry-run, apply, undo')
const rb = { type: 'rollback', kind: 'deployment', name: 'web', namespace: 'shop' }
const plan = await planAction(ssh, rb)
ok(plan.ok && /nginx:1\.28-alpine → nginx:1\.27-alpine/.test(plan.change), `preview: ${plan.change}`)
ok(plan.dryRun.ok && /dry run/i.test(plan.dryRun.output), `server-side dry-run: ${plan.dryRun.output.split('\n')[0]}`)
ok(image() === 'nginx:1.28-alpine', 'the preview changed nothing')
const rec = await applyAction(ssh, rb, { orgId: C.orgId, cluster: C, user: USER })
ok(await waitFor(() => image() === 'nginx:1.27-alpine' && rolledOut()), 'rolled back to 1.27 and healthy')
await undoAction(ssh, rec, USER)
ok(await waitFor(() => image() === 'nginx:1.28-alpine' && rolledOut()), 'undo: back on 1.28')

console.log('== scale + undo')
const sc = await applyAction(ssh, { type: 'scale', kind: 'deployment', name: 'web', namespace: 'shop', replicas: 2 }, { orgId: C.orgId, cluster: C, user: USER })
ok(K(`-n shop get deploy web -o jsonpath='{.spec.replicas}'`).out === '2', `scaled: ${sc.change}`)
await undoAction(ssh, sc, USER)
ok(K(`-n shop get deploy web -o jsonpath='{.spec.replicas}'`).out === '1', 'undo: 1 replica again')

console.log('== restart, delete-pod, refusals')
const before = K(`-n shop get deploy web -o jsonpath='{.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}'`).out
await applyAction(ssh, { type: 'restart', kind: 'deployment', name: 'web', namespace: 'shop' }, { orgId: C.orgId, cluster: C, user: USER })
ok(K(`-n shop get deploy web -o jsonpath='{.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}'`).out !== before, 'rolling restart started')
ok(await waitFor(rolledOut), 'healthy after the restart')
const pod = K(`-n shop get pod -l app=web -o jsonpath='{.items[0].metadata.name}'`).out
await applyAction(ssh, { type: 'delete-pod', kind: 'pod', name: pod, namespace: 'shop' }, { orgId: C.orgId, cluster: C, user: USER })
ok(await waitFor(() => { const n = K(`-n shop get pod -l app=web -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.phase}{"\\n"}{end}'`).out; return n.includes('Running') && !n.split('\n').some(l => l.startsWith(`${pod} Running`)) }), 'pod deleted and replaced by the controller')
K('-n shop run lonely --image=nginx:1.28-alpine --restart=Never')
const lone = await planAction(ssh, { type: 'delete-pod', kind: 'pod', name: 'lonely', namespace: 'shop' })
ok(/no controller/.test(lone.blocked || ''), 'a pod without a controller is never deleted')
const denied = await applyAction(ssh, { type: 'scale', kind: 'deployment', name: 'nope', namespace: 'shop', replicas: 2 }, { orgId: C.orgId, cluster: C, user: USER }).then(() => null, e => e.message)
ok(/not found/.test(denied || ''), 'an unknown workload is refused')

console.log('== incident explainer with the real pod log')
K(`-n shop create deployment crasher --image=busybox:1.36 -- sh -c 'echo "FATAL: cannot connect to postgres at db:5432"; exit 1'`)
ok(await waitFor(() => /CrashLoopBackOff|Error/.test(K(`-n shop get pod -l app=crasher -o jsonpath='{.items[0].status.containerStatuses[0].state.waiting.reason}{.items[0].status.containerStatuses[0].lastState.terminated.reason}'`).out)), 'crasher is crash-looping')
const cpod = K(`-n shop get pod -l app=crasher -o jsonpath='{.items[0].metadata.name}'`).out
const rs = K(`-n shop get pod ${cpod} -o jsonpath='{.metadata.ownerReferences[0].name}'`).out
const inc = { id: 'i1', reason: 'CrashLoopBackOff', severity: 'warning', status: 'unresolved', target: cpod, namespace: 'shop', owner: `ReplicaSet/${rs}`, message: `shop/${cpod} in CrashLoopBackOff`, timestamp: new Date().toISOString(), lastSeen: new Date().toISOString(), timeline: [] }
const fresh = await collectIncidentData(ssh, inc)
ok(fresh.workload?.kind === 'deployment' && fresh.workload?.name === 'crasher', `resolved the workload: ${JSON.stringify(fresh.workload)}`)
ok(fresh.data.some(d => /cannot connect to postgres/.test(d.text)), `the real log is evidence (${fresh.data.map(d => d.label).join(', ')})`)
ok(allowedActions(inc, fresh.workload).some(a => a.type === 'rollback'), 'rollback is an allowed fix')
const model = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'The app exits at start because it cannot reach its database.', cause: 'db:5432 unreachable', evidence: ['FATAL: cannot connect to postgres at db:5432', 'segfault in libc'], fix: ['Check the db Service'], confidence: 'high', change: '', action: { type: 'restart', target: 'deployment/crasher' } }) } }] })) }) })
await new Promise(r => model.listen(0, '127.0.0.1', r))
aiStore.addProvider(C.orgId, { name: 'fake', kind: 'ollama', baseUrl: `http://127.0.0.1:${model.address().port}`, model: 'm' })
const ex = await explainIncident(USER, { incident: inc, catalog: { label: 'Crash loop' }, cluster: C, fresh, changes: [], related: null })
ok(ex.answer.evidence.length === 1 && /postgres/.test(ex.answer.evidence[0]) && ex.answer.unverified === 1, 'proof checked against the real log (invented line removed)')
ok(ex.answer.action?.type === 'restart' && ex.answer.action.name === 'crasher', 'suggested fix is for this workload')
model.close()

console.log('== phase 4: predictions read real data')
const { podFacts, containerMemory } = await import('../../backend/src/services/predict.js')
K(`-n shop create deployment leaky --image=busybox:1.36 -- sh -c 'x=; i=0; while [ $i -lt 40 ]; do x="$x$(head -c 1048576 /dev/zero | tr "\\\\0" a)"; i=$((i+1)); sleep 2; done; sleep 3600'`)
K(`-n shop set resources deploy/leaky --limits=memory=256Mi`)
ok(await waitFor(() => K(`-n shop get pod -l app=leaky -o jsonpath='{.items[0].status.phase}'`).out === 'Running'), 'leaky is running')
await sleep(20000)
const facts = podFacts(JSON.parse(K('get pods -A -o json').stdout))
const leakyKey = [...facts.limits.keys()].find(k => k.startsWith('shop/leaky-'))
ok(leakyKey && facts.limits.get(leakyKey).limit === 256 * 1024 ** 2 && /^ReplicaSet\//.test(facts.limits.get(leakyKey).ownerHint), `memory limit read from the real pod (${leakyKey})`)
const nodeName = K(`get nodes -o jsonpath='{.items[0].metadata.name}'`).out
const mem = containerMemory(`==NODE ${nodeName}\n${K(`get --raw /api/v1/nodes/${nodeName}/proxy/stats/summary`).stdout}\n==END`)
ok(mem.get(leakyKey) > 5 * 1024 ** 2, `per-container memory from the real kubelet (${Math.round((mem.get(leakyKey) || 0) / 1024 ** 2)} MB)`)
ok(facts.restarts.has(leakyKey.split('/').slice(0, 2).join('/')), 'restart counts read')

console.log('== phase 4: specialists collect real evidence')
K(`-n shop apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: orphan }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } }, storageClassName: does-not-exist }
EOF`)
const pvcInc = { id: 'p1', reason: 'PVCPending', category: 'storage', target: 'orphan', namespace: 'shop', message: 'PersistentVolumeClaim shop/orphan Pending' }
const pvcData = await collectIncidentData(ssh, pvcInc)
ok(pvcData.specialist === 'storage', `storage specialist picked (${pvcData.specialist})`)
ok(pvcData.data.some(d => /storage: claims/.test(d.label) && /orphan/.test(d.text)), `the claims were read (${pvcData.data.map(d => d.label).join(', ')})`)
const netInc = { id: 'n1', reason: 'CrashLoopBackOff', category: 'pod', target: cpod, namespace: 'shop', owner: `ReplicaSet/${rs}`, message: 'x', evidence: [{ title: 'log', text: 'dial tcp: lookup orders-db on 10.96.0.10:53: no such host' }] }
const netData = await collectIncidentData(ssh, netInc)
ok(netData.specialist === 'network' && netData.data.some(d => /coredns/i.test(d.text)), 'networking specialist reads CoreDNS and Services')

console.log('== phase 4: risk score reads the real snapshot')
const { newestSnapshot, riskScore } = await import('../../backend/src/services/ai/risk.js')
dx('mkdir -p /var/lib/etcd-backup && touch /var/lib/etcd-backup/manual-test.db')
const snap = await newestSnapshot({ ...C, id: 'c-ai-snap' }, async () => ssh)
ok(snap.newestAt && Date.now() - Date.parse(snap.newestAt) < 10 * 60e3, `newest snapshot found (${snap.newestAt})`)
const risk = riskScore({ cluster: { ...C, k8sVersion: '1.35.0' }, incidents: [], monitoring: { watched: true, connected: true }, snapshot: snap, offsite: false, compliance: null })
ok(risk.factors.some(f => f.key === 'single-cp') && !risk.factors.some(f => f.key === 'no-backup'), `risk ${risk.score} (${risk.level}): ${risk.factors.map(f => f.key).join(', ')}`)

console.log('== phase 4: an automatic runbook runs for real')
const runbooks = await import('../../backend/src/services/ai/runbooks.js')
const { actionLog } = await import('../../backend/src/services/ai/actions.js')
const wl = { kind: 'deployment', name: 'web', namespace: 'shop' }
for (let i = 0; i < 3; i++) {
    actionLog.all().unshift({ id: `seed${i}`, orgId: C.orgId, clusterId: C.id, clusterName: C.clusterName, spec: { type: 'restart', ...wl }, incidentId: `old${i}`, by: 'boss', at: new Date().toISOString(), status: 'applied', undo: { possible: false }, workload: wl })
    runbooks.onIncidentClosed({ id: `old${i}`, orgId: C.orgId, clusterId: C.id, reason: 'MemoryLeakSuspected' })
}
const book = runbooks.runbooksOf(C.orgId).find(x => x.scope === 'shop/deployment/web')
runbooks.setAuto(C.orgId, book.id, true)
aiStore.save(C.orgId, { autonomy: 'auto', actionsEnabled: true, enabled: true })
const restartedBefore = K(`-n shop get deploy web -o jsonpath='{.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}'`).out
const auto = await runbooks.maybeAutoRun(C, { id: 'leak1', reason: 'MemoryLeakSuspected', target: 'web-x', namespace: 'shop' }, {
    resolveWorkload: async () => wl, onCluster: (fn) => fn(ssh), approvalsOn: () => false, maintenance: () => false, builtinAuto: () => false
})
ok(auto.ran, `runbook ran (${auto.why || auto.rec?.title})`)
ok(K(`-n shop get deploy web -o jsonpath='{.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}'`).out !== restartedBefore, 'the deployment really restarted')
ok(await waitFor(rolledOut), 'healthy after the automatic restart')

fs.rmSync(DATA, { recursive: true, force: true })
console.log(fails ? `RESULT: FAIL (${fails})` : 'RESULT: PASS')
process.exit(fails ? 1 : 0)
