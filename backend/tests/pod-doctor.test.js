// Ask AI looks into a pod: "web-2 ka log check karo" → KubeEZ reads the logs,
// describe and events, says the problem, the cause and the fix (its own checks
// without AI; the AI explanation with proof when on), offers a fix it can run —
// only for what the member may see. Fake cluster (SSH) and fake model.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'

const { parseSnapshot, _setSnapshot } = await import('../src/services/ai/clusterQuery.js')
const { targetOf, quickDiagnosis, podIncident, DIAG } = await import('../src/services/ai/podDoctor.js')
const { handleChat, intentOf } = await import('../src/services/ai/chatops.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { automationEngine } = await import('../src/services/automationEngine.js')

const now = new Date().toISOString()
const SNAP = parseSnapshot([
    '==NS==', `default\tActive\t${now}`, `kube-system\tActive\t${now}`, `shop\tActive\t${now}`, `payments\tActive\t${now}`,
    '==NODES==', 'cp-1\tTrue\tv1.36.0\t4\t8Gi\t{"node-role.kubernetes.io/control-plane":""}\t10.0.0.10\t', 'w-1\tTrue\tv1.36.0\t8\t16Gi\t{}\t10.0.0.11\t',
    '==PODS==',
    'shop\tweb-6d4f9-a1\tRunning\ttrue,\t0,\t,\tw-1\tReplicaSet\tnginx:1.27 \tweb-6d4f9',
    'shop\tweb-6d4f9-b2\tRunning\tfalse,\t14,\tCrashLoopBackOff,\tw-1\tReplicaSet\tnginx:1.27 \tweb-6d4f9',
    'shop\tapi-5c8-x\tPending\t\t\t\t\tReplicaSet\tshop/api:2 \tapi-5c8',
    'payments\tpay-0\tRunning\ttrue,\t0,\t,\tw-1\tStatefulSet\tpostgres:16 \tpay',
    '==DEPLOY==', 'shop\tweb\t2\t1', 'shop\tapi\t1\t',
    '==STS==', 'payments\tpay\t1\t1',
    '==DS==', '==SVC==', 'default\tkubernetes\tClusterIP\t10.96.0.1\t443,', 'shop\tweb\tNodePort\t10.96.4.2\t80,',
    '==PVC==', '==ING==', '==JOBS==', '==EVENTS==', '==END=='
].join('\n'))

describe('which pod or app the question is about', () => {
    const k = (q) => { const t = targetOf(q, SNAP); return t && `${t.kind}:${t.ns}/${t.name}${t.pod && t.kind !== 'pod' ? `→${t.pod.name}` : ''}${t.guessed ? '?' : ''}` }
    test('named pods, apps and services — in English and Hinglish', () => {
        assert.equal(k('web-6d4f9-b2 ka log check karo'), 'pod:shop/web-6d4f9-b2')
        assert.equal(k('why is the web deployment failing'), 'deployment:shop/web→web-6d4f9-b2', 'the app → its pod with the most trouble')
        assert.equal(k('web kyu crash ho raha hai'), 'deployment:shop/web→web-6d4f9-b2')
        assert.equal(k('web service ka port kya hai'), 'service:shop/web', 'the kind named decides')
        assert.equal(k('pay ka log dekho'), 'statefulset:payments/pay→pay-0')
        assert.equal(k('crash wala pod check karo'), 'pod:shop/web-6d4f9-b2?', 'no name: the worst unhealthy pod')
        assert.equal(k('kaunse pod fail ho rahe hain'), null, 'a list question, not a look-into')
        assert.equal(k('kubernetes version kya hai'), null, 'the "kubernetes" service is not meant')
        assert.equal(k('how many namespaces'), null)
    })
    test('asked to look into it', () => {
        for (const q of ['web-2 ka log check karo', 'why is api failing', 'web theek karo', 'pay me kya issue hai', 'fix web', 'web kya hua']) assert.equal(DIAG.test(q), true, q)
        for (const q of ['web service ka port kya hai', 'pods in shop']) assert.equal(DIAG.test(q), false, q)
    })
    test('"web-2 kyu crash" is about the pod, not problem #2', () => {
        assert.equal(intentOf('web-2 kyu crash ho raha').kind, 'ask')
        assert.equal(intentOf('2 kyu hua').kind, 'explain')
        assert.equal(intentOf('fix #3').n, 3)
    })
    test('the pod as an incident for the explainer', () => {
        const c = { id: 'c1', orgId: 'o', clusterName: 'prod' }
        assert.equal(podIncident(c, SNAP.pods[1]).reason, 'CrashLoopBackOff')
        assert.equal(podIncident(c, SNAP.pods[2]).reason, 'PodPendingTooLong')
        assert.equal(podIncident(c, SNAP.pods[0]).reason, 'PodCheck')
        assert.equal(podIncident(c, SNAP.pods[1]).owner, 'ReplicaSet/web-6d4f9')
    })
})

describe('KubeEZ\'s own checks (no AI)', () => {
    const d = (text, label = 'pod events') => quickDiagnosis([{ label, text }], { phase: 'Running', ready: 0, containers: 1 })
    test('the common causes, with the proof line', () => {
        assert.match(d('    Last State:     Terminated\n      Reason:       OOMKilled\n      Exit Code:    137').summary, /ran out of memory/)
        const sec = d('Warning  Failed  kubelet  Error: secret "db-pass" not found')
        assert.match(sec.summary, /secret "db-pass", which does not exist/); assert.match(sec.fix[0], /kubectl create secret generic db-pass/)
        assert.match(d('0/3 nodes are available: 3 Insufficient cpu.').summary, /no node has enough free cpu/)
        assert.match(d('Failed to pull image "nginx:9.9": rpc error: manifest unknown').summary, /does not exist/)
        assert.match(d('Failed to pull image "acme/app:1": pull access denied, repository does not exist or may require authorization').summary, /does not exist|refused/)
        assert.match(d('Failed to pull image "ghcr.io/acme/app:1": 401 Unauthorized').summary, /registry refused/)
        assert.match(d('Warning  Unhealthy  Liveness probe failed: HTTP probe failed with statuscode: 500').summary, /liveness probe fails/)
        assert.match(d('0/2 nodes are available: 2 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }').summary, /taints/)
        assert.match(d('standard_init_linux.go:228: exec user process caused: exec format error', 'container log').summary, /another CPU type/)
        const conn = d('Error: connect ECONNREFUSED 10.96.7.7:5432', 'previous container log')
        assert.match(conn.summary, /cannot reach something it depends on/); assert.equal(conn.evidence[0], 'Error: connect ECONNREFUSED 10.96.7.7:5432')
        assert.match(d('FATAL: cannot connect to postgres at db:5432', 'container log').summary, /depends on: "cannot connect to postgres at db:5432"/)
        assert.match(d('ERROR: could not connect to redis://cache:6379', 'container log').summary, /depends on/)
    })
    test('the pod\'s own command is not evidence; the log line is', () => {
        const describe = 'Containers:\n  app:\n    Command:\n      sh\n      -c\n      echo "FATAL: cannot connect to postgres at db:5432"; exit 1\n    State:  Waiting\n      Reason:  CrashLoopBackOff\nEvents:\n  Warning  BackOff  kubelet  Back-off restarting failed container'
        const both = quickDiagnosis([{ label: 'pod events', text: describe }, { label: 'container log', text: 'FATAL: cannot connect to postgres at db:5432' }], { phase: 'Running', ready: 0, containers: 1 })
        assert.equal(both.evidence[0], 'FATAL: cannot connect to postgres at db:5432')
        assert.equal(/exit 1/.test(both.summary), false)
        const onlyCmd = quickDiagnosis([{ label: 'pod events', text: describe }, { label: 'container log', text: 'all good' }], { phase: 'Running', ready: 0, containers: 1 })
        assert.equal(onlyCmd, null, 'nothing in the command counts as something that happened')
    })
    test('app errors in the log, or a clean healthy pod', () => {
        const e = quickDiagnosis([{ label: 'container log', text: 'starting\nTraceback (most recent call last):\nKeyError: DATABASE_URL' }], { phase: 'Running', ready: 0, containers: 1 })
        assert.match(e.summary, /logs errors/); assert.match(e.evidence[0], /Traceback/)
        const ok = quickDiagnosis([{ label: 'container log', text: 'GET / 200\nGET /health 200' }], { phase: 'Running', ready: 1, containers: 1 })
        assert.match(ok.summary, /running and ready/); assert.equal(ok.fix.length, 0)
    })
})

// ── the whole flow: a fake cluster and a fake model ──
const DESCRIBE = `Containers:
  nginx:
    State:          Waiting
      Reason:       CrashLoopBackOff
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
Volumes:
Events:
  Warning  BackOff  2m  kubelet  Back-off restarting failed container nginx`
const LOG = '2026/10/17 10:00:01 starting\n2026/10/17 10:00:02 Error: connect ECONNREFUSED 10.96.7.7:5432\n2026/10/17 10:00:02 exiting'
const cmds = []
const ssh = {
    execCommand: async (cmd) => {
        cmds.push(cmd)
        if (/describe pod/.test(cmd)) return { stdout: DESCRIBE }
        if (/logs .*--previous/.test(cmd)) return { stdout: LOG }
        if (/ logs /.test(cmd)) return { stdout: LOG }
        if (/get rs web-6d4f9/.test(cmd)) return { stdout: 'Deployment/web' }
        if (/describe deployment web/.test(cmd)) return { stdout: 'Replicas: 2 desired | 1 updated | 2 total | 1 available | 1 unavailable' }
        return { stdout: '' }
    },
    dispose() { }
}
let modelReply = ''
let fake, base
before(async () => {
    automationEngine.connectSSH = async () => ssh
    fake = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c)
        req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: typeof modelReply === 'function' ? modelReply(JSON.parse(b || '{}')) : modelReply } }] })) })
    })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${fake.address().port}`
})
after(() => { fake.closeAllConnections?.(); fake.close(); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

describe('Ask AI: "check the logs of this pod"', () => {
    const org = 'org-pd'
    const cluster = { id: 'pd1', clusterName: 'prod', orgId: org, ownerId: 'u', k8sVersion: '1.36.0', status: 'completed', masterNodes: [{ ip: '10.0.0.10' }], workerNodes: [] }
    fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([cluster]))
    _setSnapshot('pd1', SNAP)
    const admin = { id: 'a1', username: 'boss', orgId: org, role: 'admin' }

    test('AI off: KubeEZ\'s own check — the problem, the cause, the fix and the log, in Hinglish', async () => {
        aiStore.save(org, { enabled: false })
        const r = await handleChat({ orgId: org, chatKey: 'tg:pd', who: 'ravi', source: 'Telegram', text: 'web-6d4f9-b2 ka log check karo' })
        assert.match(r.reply, /^🔎 prod: shop\/web-6d4f9-b2 — CrashLoopBackOff \(0\/1 ready, 14 restarts, node w-1\)/)
        assert.match(r.reply, /Problem: The app cannot reach something it depends on: "ECONNREFUSED 10\.96\.7\.7:5432"/)
        assert.match(r.reply, /Wajah: /); assert.match(r.reply, /Saboot:\n  › 2026\/10\/17 10:00:02 Error: connect ECONNREFUSED/)
        assert.match(r.reply, /Aise theek karo:\n1\. /)
        assert.match(r.reply, /Aakhri log lines:\n {2}2026\/10\/17 10:00:01 starting/)
        assert.equal(r.direct, true)
        assert.ok(cmds.some(c => /logs web-6d4f9-b2 -n shop --all-containers --previous/.test(c)), 'the crashed container\'s log is read too')
        assert.equal(cmds.some(c => /kubectl (delete|apply|patch|scale|rollout restart)/.test(c)), false, 'read-only')
    })

    test('AI on: the explanation with proof and a fix KubeEZ can run (offered in the web app)', async () => {
        aiStore.save(org, { enabled: true })
        aiStore.addProvider(org, { name: 'Fake', kind: 'ollama', baseUrl: base, model: 'm' })
        let sent = ''
        modelReply = (body) => {
            sent = body.messages.map(m => m.content).join('\n')
            return JSON.stringify({ summary: 'web cannot reach its database at 10.96.7.7:5432 and exits.', cause: 'The pay database service refuses connections.', evidence: ['Error: connect ECONNREFUSED 10.96.7.7:5432'], fix: ['Check the pay StatefulSet: `kubectl -n payments get pods`', 'kubectl delete ns kube-system', 'Restart web when the database is up'], confidence: 'high', missing: '', change: '', action: { type: 'restart', target: 'deployment/web' } })
        }
        const r = await handleChat({ orgId: org, chatKey: 'web:a1', who: 'boss', source: 'Web', text: 'why is the web deployment failing', user: admin, rate: 60 })
        assert.match(r.reply, /\(deployment web: 1\/2 ready — its pod with the most trouble\)/)
        assert.match(r.reply, /Problem: web cannot reach its database/)
        assert.match(r.reply, /Proof:\n  › Error: connect ECONNREFUSED 10\.96\.7\.7:5432/)
        assert.match(r.reply, /How to fix it:\n1\. Check the pay StatefulSet/)
        assert.equal(/delete ns kube-system/.test(r.reply), false, 'a dangerous step is never shown')
        assert.match(r.reply, /1 dangerous step\(s\) removed/)
        assert.match(r.reply, /🛠 A fix KubeEZ can run: restart deployment\/web/)
        assert.deepEqual(r.fix, { clusterId: 'pd1', spec: { type: 'restart', kind: 'deployment', name: 'web', namespace: 'shop' }, canAct: true })
        assert.match(sent, /KubeEZ's own check of the logs\/events: The app cannot reach/, 'the AI gets KubeEZ\'s own finding')
        assert.match(sent, /ECONNREFUSED/, 'and the real log')
        assert.equal(r.direct, false)
    })

    test('a healthy pod: no AI call needed', async () => {
        let called = false
        modelReply = () => { called = true; return '{}' }
        const prevLog = LOG
        ssh.execCommand = (orig => async (cmd) => / logs /.test(cmd) ? { stdout: 'GET / 200' } : orig(cmd))(ssh.execCommand)
        const r = await handleChat({ orgId: org, chatKey: 'web:a1', who: 'boss', source: 'Web', text: 'check web-6d4f9-a1 logs', user: admin, rate: 60 })
        assert.match(r.reply, /running and ready; the logs show no errors/)
        assert.equal(called, false)
        assert.ok(prevLog)
    })

    test('a member limited to one namespace cannot look into another', async () => {
        const member = { id: 'm1', username: 'dev', orgId: org, role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'pd1', role: 'developer', namespaces: ['shop'] }] }
        aiStore.save(org, { enabled: false })
        const r = await handleChat({ orgId: org, chatKey: 'web:m1', who: 'dev', source: 'Web', text: 'pay-0 ka log check karo', user: member, rate: 60 })
        assert.equal(/pay-0 —|postgres/.test(r.reply), false, r.reply)
    })
})
