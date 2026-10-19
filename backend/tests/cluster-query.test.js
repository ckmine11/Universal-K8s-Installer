// Ask AI: "how many namespaces", "kitne pod", "failing pods", "nodes" — answered
// by the connected AI from the live cluster: KubeEZ reads it (and counts exactly),
// only what the member may see; no AI connected → "connect an AI model first".
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
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const { parseSnapshot, limitSnapshot, queryOf, answerQuery, snapshotText, SNAPSHOT_SCRIPT, _setSnapshot } = await import('../src/services/ai/clusterQuery.js')
const { handleChat } = await import('../src/services/ai/chatops.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')

const now = '2026-10-17T10:00:00Z'
const OUT = [
    '==NS==',
    `default\tActive\t${now}`, `kube-system\tActive\t${now}`, `kube-public\tActive\t${now}`, `shop\tActive\t${now}`, `payments\tActive\t${now}`, `old\tTerminating\t${now}`,
    '==NODES==',
    'cp-1\tTrue\tv1.36.0\t4\t8034856Ki\t{"kubernetes.io/hostname":"cp-1","node-role.kubernetes.io/control-plane":""}\t10.0.0.10\t',
    'w-1\tTrue\tv1.36.0\t8\t16Gi\t{"kubernetes.io/hostname":"w-1"}\t10.0.0.11\t', 'w-2\tFalse\tv1.36.0\t8\t16Gi\t\t10.0.0.12\ttrue',
    '==PODS==',
    'shop\tweb-1\tRunning\ttrue,\t0,\t,\tw-1\tReplicaSet\tnginx:1.27 ',
    'shop\tweb-2\tRunning\tfalse,\t14,\tCrashLoopBackOff,\tw-1\tReplicaSet\tnginx:1.27 ',
    'shop\tapi-1\tPending\t\t\t\t\tReplicaSet\tshop/api:latest ',
    'payments\tpay-1\tRunning\ttrue,true,\t0,1,\t,,\tw-1\tStatefulSet\tpostgres:16 busybox ',
    'kube-system\tcoredns-1\tRunning\ttrue,\t0,\t,\tcp-1\tReplicaSet\tcoredns:1.11 ',
    'default\tjob-1\tSucceeded\tfalse,\t0,\tCompleted,\tw-1\tJob\tbusybox ',
    '==DEPLOY==', 'shop\tweb\t2\t1', 'shop\tapi\t1\t', 'kube-system\tcoredns\t1\t1',
    '==STS==', 'payments\tpay\t1\t1',
    '==DS==', 'kube-system\tkube-proxy\t3\t3',
    '==SVC==', 'default\tkubernetes\tClusterIP\t10.96.0.1\t443,', 'shop\tweb\tNodePort\t10.96.4.2\t80,', 'payments\tpay\tClusterIP\t10.96.7.7\t5432,',
    '==PVC==', 'payments\tdata-pay-0\tBound\t10Gi\tnfs', 'shop\tcache\tPending\t\t',
    '==ING==', 'shop\tweb\tshop.example.com,',
    '==JOBS==', 'default\tnightly\t0 2 * * *\t',
    '==EVENTS==', `shop\tPod/web-2\tBackOff\tBack-off restarting failed container\t${now}`,
    '==END=='
].join('\n')

describe('the live snapshot', () => {
    const snap = parseSnapshot(OUT)
    test('the script reads everything in one SSH call and is read-only', () => {
        assert.match(SNAPSHOT_SCRIPT, /==END==/)
        assert.equal(/kubectl (delete|apply|patch|scale|edit|create|replace|drain|cordon)/.test(SNAPSHOT_SCRIPT), false)
    })
    test('parsed into namespaces, nodes, pods and workloads', () => {
        assert.equal(snap.namespaces.length, 6)
        assert.deepEqual(snap.nodes.map(n => [n.name, n.ready, n.cordoned]), [['cp-1', true, false], ['w-1', true, false], ['w-2', false, true]])
        assert.equal(snap.nodes[0].memGiB.toFixed(1), '7.7')
        assert.deepEqual(snap.nodes.map(n => n.controlPlane), [true, false, false], 'the control-plane label has an empty value — its name decides')
        assert.equal(snap.pods.length, 6)
        const web2 = snap.pods.find(p => p.name === 'web-2')
        assert.equal(web2.reason, 'CrashLoopBackOff'); assert.equal(web2.restarts, 14); assert.equal(web2.ready, 0)
        assert.equal(snap.pods.find(p => p.name === 'pay-1').containers, 2)
        assert.equal(snap.pods.find(p => p.name === 'job-1').reason, null, '"Completed" is not a problem')
        assert.deepEqual(snap.deployments.find(d => d.name === 'api'), { ns: 'shop', name: 'api', want: 1, ready: 0 })
        assert.equal(snap.warnings[0].reason, 'BackOff')
    })

    test('what was asked — English, Hinglish, Hindi', () => {
        const k = (t) => { const q = queryOf(t, snap.namespaces); return q && `${q.resource}${q.ns ? `@${q.ns}` : ''}${q.bad ? '!' : ''}` }
        assert.equal(k('how many namespaces are there?'), 'namespaces')
        assert.equal(k('kitne namespace hai'), 'namespaces')
        assert.equal(k('cluster me kitne ns hain'), 'namespaces')
        assert.equal(k('namespaces dikhao'), 'namespaces')
        assert.equal(k('kitne pod chal rahe hain'), 'pods')
        assert.equal(k('kaunse pod fail ho rahe hain'), 'pods!')
        assert.equal(k('pods in shop'), 'pods@shop')
        assert.equal(k('shop me deployments'), 'deployments@shop')
        assert.equal(k('nodes ka status'), 'nodes')
        assert.equal(k('kubernetes version kya hai'), 'version')
        assert.equal(k('list services'), 'services')
        assert.equal(k('कितने namespace हैं'), 'namespaces')
        // how-to and requests to do something go to the AI
        assert.equal(k('what is a pod?'), null)
        assert.equal(k('daemonset kya hota hai'), null)
        assert.equal(k('how to create a deployment'), null)
        assert.equal(k('pod crash kyu ho raha hai'), null)
        assert.equal(k('create httpd pod'), null)
        assert.equal(k('hello'), null)
    })

    test('exact answers', () => {
        const a = (t, lang = 'en') => answerQuery(queryOf(t, snap.namespaces), snap, 'prod', lang)
        const ns = a('how many namespaces')
        assert.match(ns, /^prod has 6 namespaces — 4 yours \+ 2 system:/)
        assert.match(ns, /• shop\n/); assert.match(ns, /• old \(Terminating\)/)
        assert.match(a('kitne namespace hai'), /^prod has 6 namespaces/, 'asked in Hinglish, answered in English')
        const pods = a('kitne pod hain')
        assert.match(pods, /^prod has 6 pods — 3 Running, 1 CrashLoopBackOff, 1 Pending, 1 Succeeded\./)
        assert.match(pods, /shop\/web-2 — CrashLoopBackOff \(0\/1 ready, 14 restarts\)/)
        assert.match(pods, /shop\/api-1 — Pending/)
        assert.equal(/coredns|pay-1|job-1/.test(pods), false, 'only the unhealthy ones are listed')
        assert.match(a('pods in payments'), /^prod has 1 pod in payments — 1 Running\. ✅ all healthy\.\n• pay-1/)
        const nodes = a('nodes')
        assert.match(nodes, /3 nodes — 2 Ready, 1 NOT ready/); assert.match(nodes, /cp-1 — Ready · control-plane/)
        assert.match(a('nodes dikhao'), /^prod has 3 nodes/)
        assert.match(a('ingress'), /^prod has 1 ingress:/); assert.match(nodes, /w-2 — NOT ready, cordoned · worker/)
        assert.match(a('deployments'), /3 deployments — 2 not healthy/)
        assert.match(a('shop me deployments'), /shop\/api — 0\/1 ready ⚠/)
        assert.match(a('services'), /1 reachable from outside \(web: NodePort\)/)
        assert.match(a('volumes'), /2 volumes \(PVCs\) — 1 not bound/)
        assert.match(a('kubernetes version'), /^prod: Kubernetes v1\.36\.0 \(3 nodes\)/)
        assert.match(a('which images are used'), /shop\/api:latest/); assert.match(a('which images are used'), /2 without a pinned version/)
        assert.match(a('ingress'), /shop\.example\.com/)
        assert.match(a('cronjobs'), /nightly — "0 2 \* \* \*", never ran yet/)
        assert.match(a('pods in old'), /no pods in old/)
    })

    test('a member limited to some namespaces sees only those', () => {
        const lim = limitSnapshot(snap, (ns) => ns === 'shop')
        const ans = answerQuery(queryOf('how many namespaces', lim.namespaces), lim, 'prod', 'en')
        assert.match(ans, /^prod has 1 namespace \(that you may see\)/)
        assert.equal(/payments|kube-system/.test(answerQuery(queryOf('pods'), lim, 'prod', 'en')), false)
        assert.equal(lim.services.every(s => s.ns === 'shop'), true)
    })

    test('the AI gets the live facts', () => {
        const t = snapshotText(snap, 'prod')
        assert.match(t, /Namespaces 6: default, kube-system/)
        assert.match(t, /web-2 — CrashLoopBackOff/)
        assert.match(t, /shop\/api 0\/1/)
    })
})

describe('Ask AI: the connected AI answers, from live cluster facts', () => {
    const org = 'org-cq'
    const cluster = { id: 'cq1', clusterName: 'prod', orgId: org, ownerId: 'u', k8sVersion: '1.36.0', status: 'completed', masterNodes: [{ ip: '10.0.0.10' }], workerNodes: [] }
    fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([cluster]))
    _setSnapshot('cq1', parseSnapshot(OUT))
    // a fake AI: remembers what KubeEZ sent it
    let sent = '', reply = 'ok'
    let fake
    before(async () => {
        fake = http.createServer((req, res) => {
            let b = ''; req.on('data', c => b += c)
            req.on('end', () => { sent = JSON.parse(b || '{}').messages?.map(m => m.content).join('\n') || ''; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] })) })
        })
        await new Promise(r => fake.listen(0, '127.0.0.1', r))
    })
    after(() => { fake.closeAllConnections?.(); fake.close() })
    const admin = { id: 'a9', username: 'boss', orgId: org, role: 'admin' }

    test('no AI connected: every question gets "connect an AI model first"', async () => {
        aiStore.save(org, { enabled: true })
        for (const text of ['kitne namespace hai', 'what is a pod disruption budget?', 'sab theek hai?', 'kya problem hai']) {
            const r = await handleChat({ orgId: org, chatKey: 'web:none', who: 'dev', source: 'Web', text, user: admin, rate: 60 })
            assert.match(r.reply, /^Please connect an AI model first/, text)
            assert.equal(r.needsAi, true)
        }
        assert.match((await handleChat({ orgId: org, chatKey: 'web:none', who: 'dev', source: 'Web', text: 'help', user: admin, rate: 60 })).reply, /I am KubeEZ AI/, 'help still works')
    })

    test('"kitne namespace hai": the AI answers, given the exact count KubeEZ read live', async () => {
        aiStore.addProvider(org, { name: 'My AI', kind: 'openai', preset: 'other-local', offline: true, baseUrl: `http://127.0.0.1:${fake.address().port}/v1`, model: 'm1' })
        reply = 'prod has 6 namespaces: default, kube-system, kube-public, shop, payments and old (terminating).'
        const r = await handleChat({ orgId: org, chatKey: 'web:cq', who: 'dev', source: 'Web', text: 'kitne namespace hai', user: admin, rate: 60 })
        assert.equal(r.reply, reply, 'the reply is the AI\'s answer')
        assert.deepEqual(r.engine, { provider: 'My AI', model: 'm1' })
        assert.match(sent, /KubeEZ counted \(exact, from prod\)/)
        assert.match(sent, /prod has 6 namespaces — 4 yours \+ 2 system/)
        assert.match(sent, /Namespaces 6: default, kube-system/, 'and the whole live snapshot')
        assert.match(sent, /kitne namespace hai/, 'the question as asked')
    })

    test('any question gets the live facts: problems, pods, risk', async () => {
        reply = 'shop/web-2 is crash-looping (14 restarts) and shop/api-1 is Pending.'
        const r = await handleChat({ orgId: org, chatKey: 'web:cq', who: 'dev', source: 'Web', text: 'pods me kya problem hai', user: admin, rate: 60 })
        assert.equal(r.reply, reply)
        assert.match(sent, /web-2 — CrashLoopBackOff/)
        assert.match(sent, /prod: Kubernetes 1\.36\.0, 1 control-plane, 0 workers; health score \d+\/100 \(higher is safer — \w+ risk\)/)
        reply = 'Everything is fine apart from web-2.'
        assert.equal((await handleChat({ orgId: org, chatKey: 'web:cq', who: 'dev', source: 'Web', text: 'sab theek hai?', user: admin, rate: 60 })).reply, reply, '"status" too is answered by the AI')
    })

    test('a member limited to a namespace: the AI is only given that namespace', async () => {
        const member = { id: 'm2', username: 'dev', orgId: org, role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'cq1', role: 'developer', namespaces: ['shop'] }] }
        reply = 'You can see 1 namespace: shop.'
        await handleChat({ orgId: org, chatKey: 'web:m2', who: 'dev', source: 'Web', text: 'how many namespaces', user: member, rate: 60 })
        assert.match(sent, /prod has 1 namespace \(that you may see\)/)
        assert.equal(/payments|pay-1|postgres/.test(sent), false, 'nothing from the other namespaces reaches the AI')
    })

    test('the AI is down: said plainly, with the reason — never a made-up answer', async () => {
        const p = aiStore.get(org).providers[0]
        aiStore.updateProvider(org, p.id, { baseUrl: 'http://127.0.0.1:9/v1' })
        const r = await handleChat({ orgId: org, chatKey: 'web:cq', who: 'dev', source: 'Web', text: 'how many pods', user: admin, rate: 60 })
        assert.match(r.reply, /^The AI did not answer this time \(/)
    })
})
