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
// a pod that is running and not on its way out (old pods of the restart may still be terminating)
const livePod = () => (JSON.parse(K('-n shop get pod -l app=web -o json').stdout || '{"items":[]}').items.find(p => p.status?.phase === 'Running' && !p.metadata.deletionTimestamp) || {}).metadata?.name
ok(await waitFor(() => !!livePod() && JSON.parse(K('-n shop get pod -l app=web -o json').stdout).items.every(p => !p.metadata.deletionTimestamp)), 'the restart is fully done')
const pod = livePod()
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

console.log('== phase 5: the advisor on a real cluster')
const { ADVISOR_SCRIPT, analyze } = await import('../../backend/src/services/ai/advisor.js')
const adv = analyze((await ssh.execCommand(ADVISOR_SCRIPT)).stdout, {})
ok(/==END==/.test((await ssh.execCommand(ADVISOR_SCRIPT)).stdout), 'the advisor script runs')
ok(adv.security.findings.some(f => f.namespace === 'shop' && f.key === 'netpol'), 'no NetworkPolicy in shop is found')
ok(adv.security.findings.some(f => f.workload === 'Deployment/web' && f.key === 'no-limit'), 'web has no memory limit → found')
ok(adv.security.findings.some(f => f.scope === 'system'), 'system workloads kept apart')
ok(adv.cost.nodes.total.cpu > 0 && adv.cost.nodes.used.cpu > 0, `node usage read (used ${adv.cost.nodes.used.cpu.toFixed(2)} of ${adv.cost.nodes.total.cpu} cores)`)
ok(adv.cost.workloads.some(w => w.workload === 'Deployment/web' && w.advice.kind === 'no-requests'), 'web without requests → cost advice')

console.log('== phase 5: text → YAML on the real cluster (dry-run, diff, apply, undo)')
const { parseManifests, checkManifests, previewManifests, applyManifests, undoManifests } = await import('../../backend/src/services/ai/manifests.js')
K('-n shop create configmap site --from-literal=title=old')
const yamlText = `apiVersion: apps/v1
kind: Deployment
metadata: { name: hello }
spec:
  replicas: 1
  selector: { matchLabels: { app.kubernetes.io/name: hello } }
  template:
    metadata: { labels: { app.kubernetes.io/name: hello } }
    spec:
      containers:
      - name: hello
        image: nginx:1.28-alpine
        ports: [{ containerPort: 80 }]
        resources: { requests: { cpu: 10m, memory: 32Mi }, limits: { memory: 64Mi } }
        readinessProbe: { httpGet: { path: /, port: 80 } }
---
apiVersion: v1
kind: Service
metadata: { name: hello }
spec: { selector: { app.kubernetes.io/name: hello }, ports: [{ port: 80 }] }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: site }
data: { title: new }
`
const chk = checkManifests(parseManifests(yamlText), { namespace: 'shop' })
ok(!chk.blocked && chk.objects.length === 3, `checked: ${chk.problems.map(p => p.text).join('; ') || 'no problems'}`)
const prev = await previewManifests(ssh, chk.yaml, chk.objects)
ok(prev.ok && /created \(server dry run\)|configured \(server dry run\)/.test(prev.dryRun), `server dry-run: ${prev.dryRun.split('\n')[0]}`)
ok(/title: new/.test(prev.diff) && /title: old/.test(prev.diff), 'the diff shows the ConfigMap change')
ok(K('-n shop get deploy hello').code !== 0, 'the preview created nothing')
const applied = await applyManifests(ssh, chk, { orgId: C.orgId, cluster: C, user: USER, description: 'hello' })
ok(applied.created.join() === 'Deployment/hello,Service/hello' && applied.changed.join() === 'ConfigMap/site', `applied: created ${applied.created}, changed ${applied.changed}`)
ok(await waitFor(() => K('-n shop rollout status deploy/hello --timeout=60s').code === 0), 'hello is running')
ok(K(`-n shop get cm site -o jsonpath='{.data.title}'`).out === 'new', 'the ConfigMap changed')
await undoManifests(ssh, applied, USER)
ok(await waitFor(() => K('-n shop get deploy hello').code !== 0 && K('-n shop get svc hello').code !== 0), 'undo deleted what was created')
ok(K(`-n shop get cm site -o jsonpath='{.data.title}'`).out === 'old', 'undo put the old ConfigMap back')

console.log('== text → YAML golden set: every description passes the real server-side dry-run')
const { GOLDEN } = await import('../../backend/tests/helpers/yamlGolden.js')
const { generateManifests } = await import('../../backend/src/services/ai/manifests.js')
K('create namespace golden')
const noAi = { id: 'g', username: 'golden', orgId: 'org-golden' }   // no engine: KubeEZ builds it itself
let dryFails = 0
for (const [d] of GOLDEN) {
    const g = await generateManifests(noAi, { description: d, namespace: 'golden' })
    const p = await previewManifests(ssh, g.yaml, g.objects)
    if (!p.ok || g.blocked) { dryFails++; console.log(`   ✗ "${d}": ${(p.dryRun || '').split('\n').filter(l => /error|invalid|forbidden/i.test(l)).join(' / ').slice(0, 300) || JSON.stringify(g.problems)}`) }
}
ok(dryFails === 0, `${GOLDEN.length - dryFails}/${GOLDEN.length} golden descriptions pass the server dry-run`)

console.log('== text → YAML: built from words, really running')
const running = []
for (const d of ['create httpd pod', 'nginx 1.27 with 2 replicas, 64Mi memory, a service on port 80', 'memcached 2 replicas', 'a cronjob that runs busybox every night at 2am and prints the date']) {
    const g = await generateManifests(noAi, { description: d, namespace: 'golden' })
    running.push(await applyManifests(ssh, g, { orgId: C.orgId, cluster: C, user: USER, description: d }))
}
ok(await waitFor(() => K(`-n golden get pod httpd -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`).out === 'True'), '"create httpd pod" → the pod is Ready (its health check passes)')
ok(await waitFor(() => K('-n golden rollout status deploy/nginx --timeout=120s').code === 0 && K(`-n golden get deploy nginx -o jsonpath='{.status.readyReplicas}'`).out === '2'), '"nginx … 2 replicas" → 2 of 2 ready')
ok(await waitFor(() => K(`-n golden get deploy memcached -o jsonpath='{.status.readyReplicas}'`).out === '2'), '"memcached 2 replicas" → ready (TCP health check)')
ok(K(`-n golden run curl-check --image=busybox:1.36 --restart=Never --rm -i --timeout=90s -- wget -qO- http://httpd/`).out.includes('It works'), 'the httpd Service answers inside the cluster')
K('-n golden create job busybox-now --from=cronjob/busybox')
ok(await waitFor(() => K(`-n golden get job busybox-now -o jsonpath='{.status.succeeded}'`).out === '1'), 'the CronJob\'s job runs and finishes')
ok(/\d{2}:\d{2}:\d{2}/.test(K('-n golden logs job/busybox-now').out), `…and prints the date (${K('-n golden logs job/busybox-now').out})`)
K('-n golden delete job busybox-now --wait=false')
for (const r of running) { const u = await undoManifests(ssh, r, USER); console.log(`   undo "${r.description}": ${u.undoOutput.replace(/\n/g, ' | ')}`) }
// exactly what was created (the job started by hand above is not part of it)
const created = running.flatMap(r => r.created)
ok(await waitFor(() => !created.some(ref => { const [kind, name] = ref.split('/'); return K(`-n golden get ${kind.toLowerCase()} ${name} -o name`).code === 0 })), `undo removed all of it (${created.join(', ')})`)

console.log('== phase 5: ChatOps answers from the real cluster')
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([{ id: C.id, clusterName: 'shopcluster', orgId: C.orgId, ownerId: C.ownerId, k8sVersion: '1.35.0', status: 'completed', masterNodes: [{ ip: '127.0.0.1', username: 'root' }], workerNodes: [] }]))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
automationEngine.connectSSH = async () => ssh
const { handleChat } = await import('../../backend/src/services/ai/chatops.js')
aiStore.save(C.orgId, { enabled: false })   // facts only — no model here
const chg = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'shopcluster pe kya badla 1h' })
ok(/shopcluster — \d+ change/.test(chg.reply) && /Deployment web rolled out/.test(chg.reply), `"kya badla" answered from the cluster:\n${chg.reply.split('\n').slice(0, 4).join('\n')}`)
const st = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'sab theek hai?' })
ok(/shopcluster — risk \d+\/100/.test(st.reply), `"sab theek hai?" → ${st.reply.split('\n')[0]}`)

console.log('== Ask AI: what is in the cluster — exact, from the live cluster, no AI')
const realNs = K(`get ns -o name`).out.split('\n').filter(Boolean).length
const realPods = K(`get pods -A -o name`).out.split('\n').filter(Boolean).length
const realShopPods = K(`-n shop get pods -o name`).out.split('\n').filter(Boolean).length
const realNodes = K(`get nodes -o name`).out.split('\n').filter(Boolean).length
let t0 = Date.now()
const nsA = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'kitne namespace hai' })
ok(new RegExp(`^shopcluster has ${realNs} namespaces`).test(nsA.reply) && /• shop\b/.test(nsA.reply) && /• kube-system/.test(nsA.reply), `"kitne namespace hai" → ${nsA.reply.split('\n')[0]} (kubectl: ${realNs}) in ${Date.now() - t0} ms`)
t0 = Date.now()
const podA = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'how many pods are there' })
ok(new RegExp(`^shopcluster has ${realPods} pods — `).test(podA.reply), `"how many pods" → ${podA.reply.split('\n')[0]} (kubectl: ${realPods}) in ${Date.now() - t0} ms (cached)`)
const shopA = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'pods in shop' })
ok(new RegExp(`^shopcluster has ${realShopPods} pods in shop`).test(shopA.reply), `"pods in shop" → ${shopA.reply.split('\n')[0]}`)
const nodeA = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'nodes dikhao' })
ok(new RegExp(`shopcluster has ${realNodes} nodes? — ${realNodes} Ready`).test(nodeA.reply) && /control-plane · v1\.\d+/.test(nodeA.reply), `"nodes dikhao" → ${nodeA.reply.split('\n').slice(0, 2).join(' | ')}`)
const depA = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'shop me deployments' })
ok(/shop\/web — \d+\/\d+ ready/.test(depA.reply), `"shop me deployments" → ${depA.reply.split('\n').slice(0, 2).join(' | ')}`)
const verA = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'kubernetes version kya hai' })
ok(/^shopcluster: Kubernetes v1\.\d+\.\d+/.test(verA.reply), `"version" → ${verA.reply}`)

console.log('== Ask AI: "check the logs of this pod" — real logs, describe and events → problem, cause, fix')
t0 = Date.now()
const look = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'crasher ka log check karo' })
ok(/^🔎 shopcluster: shop\/crasher-[a-z0-9-]+ — (CrashLoopBackOff|Error)/.test(look.reply), `found the app's pod: ${look.reply.split('\n')[0]} (${Date.now() - t0} ms)`)
ok(/› FATAL: cannot connect to postgres at db:5432/.test(look.reply) && /Last log lines:\n {2}FATAL: cannot connect to postgres/.test(look.reply), 'the real crash log is the proof, and is shown')
ok(/Problem: The app cannot reach something it depends on: "cannot connect to postgres at db:5432"/.test(look.reply) && /How to fix it:\n1\. /.test(look.reply), `KubeEZ's own diagnosis and fix steps (AI off):\n${look.reply.split('\n').slice(2, 7).join('\n')}`)
const guess = await handleChat({ orgId: C.orgId, chatKey: 'e2e', who: 'ravi', source: 'Telegram', text: 'crash wala pod check karo' })
ok(/shop\/crasher-/.test(guess.reply.split('\n')[0]), `"crash wala pod check karo" picks the crashing pod: ${guess.reply.split('\n')[0]}`)

fs.rmSync(DATA, { recursive: true, force: true })
console.log(fails ? `RESULT: FAIL (${fails})` : 'RESULT: PASS')
process.exit(fails ? 1 : 0)
