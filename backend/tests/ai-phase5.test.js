// KubeEZ AI phase 5: ChatOps (intents in English / Hindi / Hinglish, the
// Telegram hook, Slack signatures, limits), text → YAML (checks, dry-run,
// apply, undo) and the security / cost advisor.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { startServer, client, tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
process.env.KUBEEZ_PUBLIC_URL = 'https://kubeez.example'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'

// one local server: the Telegram API and a model
const tgSent = []
let modelReply = 'A DaemonSet runs one pod on every node.'
let fake, base
before(async () => {
    fake = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c)
        req.on('end', () => {
            const body = JSON.parse(b || '{}')
            if (req.url.startsWith('/tg/')) { if (req.url.endsWith('/sendMessage')) tgSent.push(body); return res.end(JSON.stringify({ ok: true, result: [] })) }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content: typeof modelReply === 'function' ? modelReply(body) : modelReply } }] }))
        })
    })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${fake.address().port}`
    process.env.KUBEEZ_TELEGRAM_API = `${base}/tg`
})
after(async () => { (await import('../src/services/alertActions.js')).telegramPoller.stop(); fake.closeAllConnections?.(); fake.close(); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const { intentOf, handleChat } = await import('../src/services/ai/chatops.js')
const { handleTelegramUpdate } = await import('../src/services/alertActions.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { incidentDetector } = await import('../src/services/incidentDetector.js')
const { slackSignatureOk } = await import('../src/routes/chatops.js')
const { parseManifests, checkManifests, generateManifests, previewManifests, applyManifests, undoManifests } = await import('../src/services/ai/manifests.js')
const { analyze } = await import('../src/services/ai/advisor.js')

describe('ChatOps: what was asked (in English, Hindi or Hinglish)', () => {
    test('intents in English, Hinglish and Hindi', () => {
        const k = (t) => { const i = intentOf(t); return `${i.kind}${i.n ? `:${i.n}` : ''}${i.kind === 'changes' ? `:${i.hours}` : ''}` }
        assert.equal(k('sab theek hai?'), 'status')
        assert.equal(k('kya problem hai'), 'incidents')
        assert.equal(k('2 kyu hua'), 'explain:2')
        assert.equal(k('2 theek karo'), 'fix:2')
        assert.equal(k('why #3'), 'explain:3')
        assert.equal(k('prod pe kya badla 6h'), 'changes:6')
        assert.equal(k('what changed in the last 2 days'), 'changes:48')
        assert.equal(k('/ask@kubeez_bot status'), 'status')
        assert.equal(k('What is a DaemonSet?'), 'ask')
    })
})

describe('ChatOps: answers', () => {
    const org = 'org-chat'
    const inc = { id: 'chat-i1', orgId: org, clusterId: 'c-chat', clusterName: 'prod', reason: 'CrashLoopBackOff', target: 'web-1', namespace: 'shop', status: 'unresolved', severity: 'warning', message: 'crash', timestamp: new Date().toISOString(), lastSeen: new Date().toISOString(), timeline: [] }
    test('no AI connected: "connect an AI model first"; then the AI answers from the numbered problems; a rate limit', async () => {
        incidentDetector.incidents.unshift(inc)
        assert.match((await handleChat({ orgId: org, chatKey: 'tg:1', who: 'ravi', source: 'Telegram', text: 'kya problem hai' })).reply, /^Please connect an AI model first/)
        aiStore.addProvider(org, { name: 'Fake', kind: 'ollama', baseUrl: base, model: 'm' })
        let sent = ''
        modelReply = (body) => { sent = body.messages.map(m => m.content).join('\n'); return '1 open problem: web-1 in shop on prod is crash-looping. Send "why 1" for the cause.' }
        const r = await handleChat({ orgId: org, chatKey: 'tg:1', who: 'ravi', source: 'Telegram', text: 'kya problem hai' })
        assert.equal(r.reply, '1 open problem: web-1 in shop on prod is crash-looping. Send "why 1" for the cause.')
        assert.match(sent, /open problems \(numbered\)/); assert.match(sent, /1\. warning — Pod crash loop on prod shop\/web-1: crash/)
        assert.match((await handleChat({ orgId: org, chatKey: 'tg:1', who: 'ravi', source: 'Telegram', text: 'why 7' })).reply, /no problem #7/)
        assert.match((await handleChat({ orgId: org, chatKey: 'tg:1', who: 'ravi', source: 'Telegram', text: 'help' })).reply, /I am KubeEZ AI/)
        for (let i = 0; i < 17; i++) await handleChat({ orgId: org, chatKey: 'tg:1', who: 'ravi', source: 'Telegram', text: 'help' })
        assert.match((await handleChat({ orgId: org, chatKey: 'tg:1', who: 'ravi', source: 'Telegram', text: 'help' })).reply, /Too many questions/)
        incidentDetector.incidents = incidentDetector.incidents.filter(i => i.id !== 'chat-i1')
    })

    test('a free question goes to the model, which must answer in English even when asked in Hinglish; AI off says so', async () => {
        let sys = ''
        modelReply = (body) => { sys = body.messages[0].content; return 'A DaemonSet runs one pod on every node.' }
        const progress = []
        const r = await handleChat({ orgId: org, chatKey: 'tg:2', who: 'ravi', source: 'Telegram', text: 'daemonset kya hota hai', send: (t) => progress.push(t) })
        assert.equal(r.reply, 'A DaemonSet runs one pod on every node.')
        assert.match(sys, /Always answer in clear, correct, professional English/); assert.match(sys, /Never answer in Hindi or Hinglish/); assert.match(sys, /Never claim you changed anything/)
        assert.deepEqual(progress, ['🔎 Looking into it…'])
        aiStore.save(org, { enabled: false })
        assert.match((await handleChat({ orgId: org, chatKey: 'tg:2', who: 'ravi', source: 'Telegram', text: 'what is a pod?' })).reply, /turned off/)
        aiStore.save(org, { enabled: true })
    })

    test('Telegram: only the channel\'s own chat, only when turned on, groups need /ask', async () => {
        const channel = { id: 'ch-tg', type: 'telegram', config: { botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '-100' } }
        const msg = (chatId, text, type = 'group') => ({ update_id: 1, message: { message_id: 5, text, chat: { id: chatId, type }, from: { username: 'ravi' } } })
        tgSent.length = 0
        assert.equal(await handleTelegramUpdate(org, channel, msg('-100', '/ask help')), null, 'ChatOps off → ignored')
        aiStore.setChatops(org, 'ch-tg', { enabled: true })
        assert.equal(await handleTelegramUpdate(org, channel, msg('-999', '/ask help')), null, 'another chat → ignored')
        assert.equal(await handleTelegramUpdate(org, channel, msg('-100', 'just chatting')), null, 'a group message not meant for the bot → ignored')
        const r = await handleTelegramUpdate(org, channel, msg('-100', '/ask help'))
        assert.equal(r.chatops, true)
        assert.equal(tgSent.length, 1); assert.equal(tgSent[0].chat_id, '-100'); assert.match(tgSent[0].text, /I am KubeEZ AI/)
        assert.equal(tgSent[0].reply_to_message_id, 5)
    })

    test('Ask AI in the web app: only the clusters and problems this member may see', async () => {
        const org2 = 'org-web'
        fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
            { id: 'w1', clusterName: 'shop', orgId: org2, ownerId: 'u', k8sVersion: '1.36.0', status: 'completed', masterNodes: [], workerNodes: [] },
            { id: 'w2', clusterName: 'finance', orgId: org2, ownerId: 'u', k8sVersion: '1.36.0', status: 'completed', masterNodes: [], workerNodes: [] }
        ]))
        const now = new Date().toISOString()
        incidentDetector.incidents.unshift(
            { id: 'wi1', orgId: org2, clusterId: 'w1', clusterName: 'shop', reason: 'CrashLoopBackOff', target: 'web-1', namespace: 'shop', status: 'unresolved', severity: 'warning', message: 'crash', timestamp: now, lastSeen: now, timeline: [] },
            { id: 'wi2', orgId: org2, clusterId: 'w2', clusterName: 'finance', reason: 'NodeNotReady', target: 'fin-1', status: 'unresolved', severity: 'critical', message: 'down', timestamp: now, lastSeen: now, timeline: [] })
        const member = { id: 'm1', username: 'dev', orgId: org2, role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'w2', role: 'none' }] }
        aiStore.addProvider(org2, { name: 'Fake', kind: 'ollama', baseUrl: base, model: 'm' })
        let sent = ''
        modelReply = (body) => { sent = body.messages.map(m => m.content).join('\n'); return 'shop has one crash-looping pod.' }
        const r = await handleChat({ orgId: org2, chatKey: 'web:m1', who: 'dev', source: 'Web', text: 'sab theek hai?', user: member, rate: 60 })
        assert.equal(r.reply, 'shop has one crash-looping pod.')
        assert.match(sent, /shop: Kubernetes 1\.36\.0.*health score \d+\/100 \(higher is safer/)
        assert.equal(/finance|fin-1/.test(sent), false, 'the hidden cluster and its problem never reach the AI')
        await handleChat({ orgId: org2, chatKey: 'tg:team', who: 'ops', source: 'Telegram', text: 'incidents' })
        assert.match(sent, /fin-1/, 'a team chat sees the whole workspace, like its alerts')
        incidentDetector.incidents = incidentDetector.incidents.filter(i => !['wi1', 'wi2'].includes(i.id))
    })

    test('Slack: only requests signed with the channel\'s secret, within 5 minutes', () => {
        const secret = 'a'.repeat(32), ts = String(Math.floor(Date.now() / 1000)), body = 'text=status&user_name=ravi'
        const sig = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
        assert.equal(slackSignatureOk(secret, ts, body, sig), true)
        assert.equal(slackSignatureOk(secret, ts, body + 'x', sig), false)
        assert.equal(slackSignatureOk('b'.repeat(32), ts, body, sig), false)
        assert.equal(slackSignatureOk(secret, String(Number(ts) - 600), body, sig), false, 'replayed later')
    })
})

describe('text → YAML', () => {
    const good = `Here you go:\n\`\`\`yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web, namespace: other }\nspec:\n  replicas: 2\n  selector: { matchLabels: { app.kubernetes.io/name: web } }\n  template:\n    metadata: { labels: { app.kubernetes.io/name: web } }\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27-alpine\n        ports: [{ containerPort: 80 }]\n        resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { memory: 128Mi } }\n        readinessProbe: { httpGet: { path: /, port: 80 } }\n---\napiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec: { selector: { app.kubernetes.io/name: web }, ports: [{ port: 80 }] }\n\`\`\``
    test('parsed, put in the chosen namespace, checked', () => {
        const c = checkManifests(parseManifests(good), { namespace: 'shop' })
        assert.deepEqual(c.objects.map(o => `${o.kind}/${o.name}@${o.namespace}`), ['Deployment/web@shop', 'Service/web@shop'])
        assert.equal(c.blocked, false)
        assert.ok(c.problems.some(p => /replaced by shop/.test(p.text)))
        assert.match(c.yaml, /namespace: shop/)
    })
    test('dangerous or cluster-wide things are blocked, sloppy ones warned', () => {
        const bad = `kind: ClusterRoleBinding\nmetadata: { name: all }\n---\nkind: Deployment\napiVersion: apps/v1\nmetadata: { name: x }\nspec:\n  template:\n    spec:\n      hostNetwork: true\n      volumes: [{ name: h, hostPath: { path: / } }]\n      containers: [{ name: c, image: busybox, securityContext: { privileged: true } }]`
        const c = checkManifests(parseManifests(bad), { namespace: 'shop' })
        assert.equal(c.blocked, true)
        const t = c.problems.map(p => `${p.level}: ${p.text}`).join('\n')
        assert.match(t, /block: ClusterRoleBinding cannot be created/)
        assert.match(t, /block: Uses the node's network/)
        assert.match(t, /block: Mounts a folder of the node/)
        assert.match(t, /block: Container c is privileged/)
        assert.match(t, /warn: Container c: pin an image version/)
        assert.throws(() => parseManifests('kind: [unclosed'), /YAML error/)
        assert.throws(() => checkManifests(parseManifests(good), { namespace: 'Bad_NS' }), /valid namespace/)
    })
    test('a small model\'s real output: separate fenced blocks, wrong apiVersion, CPU in Mi', () => {
        const out = '```yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: nginx\nspec:\n  template:\n    spec:\n      containers:\n      - name: nginx\n        image: nginx:latest\n        resources:\n          limits:\n            cpu: 64Mi\n            memory: 2Gi\n```\n\n```yaml\napiVersion: batch/v1\nkind: Service\nmetadata:\n  name: nginx\nspec:\n  ports:\n  - port: 80\n```'
        const c = checkManifests(parseManifests(out), { namespace: 'shop' })
        assert.deepEqual(c.objects.map(o => o.kind), ['Deployment', 'Service'])
        const t = c.problems.map(p => `${p.level}: ${p.text}`).join('\n')
        assert.match(t, /block: Container nginx: limits\.cpu "64Mi" is not a CPU amount/)
        assert.match(t, /warn: apiVersion batch\/v1 corrected to v1/)
        assert.equal(parseManifests('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: b}').length, 2, 'objects without --- between them')
    })

    test('every request is written by the connected AI, with KubeEZ\'s rules (and its draft when it has one)', async () => {
        aiStore.addProvider('org-yaml', { name: 'Fake', kind: 'ollama', baseUrl: base, model: 'm' })
        const prompts = []
        modelReply = (body) => { prompts.push(body.messages.map(m => m.content).join('\n')); return good }
        const plain = await generateManifests({ id: 'u', username: 'a', orgId: 'org-yaml' }, { description: 'nginx with 2 replicas and a service', namespace: 'shop' })
        assert.equal(plain.method, 'ai'); assert.equal(prompts.length, 1, 'the AI wrote it')
        assert.match(prompts[0], /a draft KubeEZ prepared/); assert.match(prompts[0], /replicas: 2/)
        const extra = await generateManifests({ id: 'u', username: 'a', orgId: 'org-yaml' }, { description: 'nginx with a sidecar that tails the logs', namespace: 'shop' })
        assert.equal(extra.method, 'ai'); assert.equal(extra.objects.length, 2)
        assert.match(prompts.at(-1), /never :latest/); assert.match(prompts.at(-1), /Never privileged/)
    })
    test('preview, apply and undo — what was created is deleted, what was changed is put back', async () => {
        const c = checkManifests(parseManifests(good), { namespace: 'shop' })
        const cmds = []
        const svcBefore = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: 'shop', resourceVersion: '7', uid: 'u', managedFields: [] }, spec: { ports: [{ port: 8080 }] }, status: {} }
        const ssh = { async execCommand(cmd) {
            cmds.push(cmd)
            if (/get namespace shop/.test(cmd)) return { code: 0, stdout: 'namespace/shop' }
            if (/get service web -o name/.test(cmd)) return { code: 0, stdout: 'service/web' }
            if (/get deployment web -o name/.test(cmd)) return { code: 1, stdout: '' }
            if (/get service web -o json/.test(cmd)) return { code: 0, stdout: JSON.stringify(svcBefore) }
            if (/get deployment web -o json/.test(cmd)) return { code: 1, stdout: '' }
            if (/kubectl diff/.test(cmd)) return { code: 1, stdout: '-  port: 8080\n+  port: 80' }
            return { code: 0, stdout: 'ok' }
        } }
        const p = await previewManifests(ssh, c.yaml, c.objects)
        assert.equal(p.ok, true); assert.deepEqual(p.existing, ['Service/web']); assert.match(p.diff, /port: 80/)
        assert.ok(cmds.some(x => /base64 -d \| sudo KUBECONFIG=\S+ timeout 60 kubectl apply --dry-run=server -f -/.test(x)), 'YAML goes base64 through stdin, never as arguments')
        const rec = await applyManifests(ssh, c, { orgId: 'o', cluster: { id: 'c1', clusterName: 'c' }, user: { username: 'alice' }, description: 'nginx' })
        assert.deepEqual(rec.created, ['Deployment/web']); assert.deepEqual(rec.changed, ['Service/web'])
        await undoManifests(ssh, rec, { username: 'alice' })
        const undo = cmds.slice(-2)
        assert.match(undo[0], /delete deployment web --ignore-not-found/)
        const restored = JSON.parse(Buffer.from(undo[1].match(/echo (\S+) \| base64 -d/)[1], 'base64').toString())
        assert.equal(restored.spec.ports[0].port, 8080); assert.equal(restored.metadata.resourceVersion, undefined); assert.equal(restored.status, undefined)
        await assert.rejects(undoManifests(ssh, rec, { username: 'alice' }), /Already undone/)
    })
})

describe('advisor', () => {
    const pod = (ns, name, owner, spec) => ({ metadata: { namespace: ns, name, ownerReferences: owner ? [{ kind: owner[0], name: owner[1] }] : undefined }, spec, status: { phase: 'Running' } })
    const out = [
        '==PODS==', JSON.stringify({ items: [
            pod('shop', 'web-7d9-a', ['ReplicaSet', 'web-7d9'], { containers: [{ name: 'web', image: 'nginx:latest', env: [{ name: 'DB_PASSWORD', value: 'hunter2' }], resources: { requests: { cpu: '2', memory: '2Gi' }, limits: { memory: '2Gi' } } }] }),
            pod('shop', 'api-5c-b', ['ReplicaSet', 'api-5c'], { securityContext: { runAsNonRoot: true }, automountServiceAccountToken: false, containers: [{ name: 'api', image: 'api:1.2', securityContext: { privileged: true }, resources: { requests: { cpu: '100m', memory: '64Mi' }, limits: { memory: '128Mi' } } }] }),
            pod('kube-system', 'kube-proxy-x', ['DaemonSet', 'kube-proxy'], { hostNetwork: true, containers: [{ name: 'p', image: 'kube-proxy:v1.35', securityContext: { privileged: true } }] })
        ] }),
        '==RS==', 'shop/web-7d9\tDeployment/web\nshop/api-5c\tDeployment/api',
        '==SVC==', 'shop/web\tNodePort',
        '==NETPOL==', '',
        '==NODES==', 'n1\t4\t16Gi',
        '==USAGE n1==', JSON.stringify({ pods: [
            { podRef: { namespace: 'shop', name: 'web-7d9-a' }, containers: [{ name: 'web', cpu: { usageNanoCores: 5e7 }, memory: { workingSetBytes: 200 * 1024 ** 2 } }] },
            { podRef: { namespace: 'shop', name: 'api-5c-b' }, containers: [{ name: 'api', cpu: { usageNanoCores: 4e8 }, memory: { workingSetBytes: 300 * 1024 ** 2 } }] }
        ] }),
        '==END=='
    ].join('\n')
    test('security: per workload, worst first; system namespaces kept apart', () => {
        const a = analyze(out, { rates: { cpu: 1000, memGb: 200, currency: '₹' } })
        const f = (w, key) => a.security.findings.find(x => x.workload === w && x.key.startsWith(key))
        assert.ok(f('Deployment/api', 'privileged')); assert.ok(f('Deployment/web', 'env-DB_PASSWORD')); assert.ok(f('Deployment/web', 'latest'))
        assert.ok(f('Service/web', 'exposed')); assert.ok(f('Namespace/shop', 'netpol'))
        assert.equal(f('DaemonSet/kube-proxy', 'privileged').scope, 'system')
        assert.equal(a.security.findings[0].severity, 'high')
        assert.equal(JSON.stringify(a).includes('hunter2'), false, 'the secret value is never in the result')
        assert.ok(a.security.score < 80)
    })
    test('cost: over- and under-provisioned, with the saving', () => {
        const a = analyze(out, { rates: { cpu: 1000, memGb: 200, currency: '₹' } })
        const web = a.cost.workloads.find(w => w.workload === 'Deployment/web')
        assert.equal(web.advice.kind, 'over'); assert.match(web.advice.text, /Asks for 2 cores \/ 2.0 GiB but uses 50m \/ 200 MiB/)
        assert.equal(a.cost.workloads.find(w => w.workload === 'Deployment/api').advice.kind, 'under')
        assert.ok(a.cost.savings.monthly > 1500); assert.match(a.cost.savings.text, /^About ₹/)
        assert.equal(a.cost.nodes.total.cpu, 4)
    })
})

describe('API', () => {
    let srv, api, owner, viewer
    before(async () => {
        srv = await startServer()
        api = client(srv)
        const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).data
        const root = await login('root', 'secret123')
        owner = (await api('POST', '/api/auth/register', null, { username: 'p5boss', password: 'secret123', email: 'p5boss@example.com' })).data
        assert.equal((await api('PUT', `/api/superadmin/users/${owner.user.id}/limits`, root.token, { plan: 'FREE', maxClusters: 2, maxNodes: 10, maxMembers: 4 })).status, 200)
        assert.equal((await api('POST', '/api/admin/users', owner.token, { username: 'p5view', password: 'secret123', email: 'p5view@example.com', role: 'viewer' })).status, 200)
        viewer = await login('p5view', 'secret123')
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([{ id: 'c5', clusterName: 'five', orgId: owner.user.orgId, ownerId: owner.user.id, k8sVersion: '1.36.0', masterNodes: [{ ip: '192.0.2.55', username: 'root', password: 'x' }], workerNodes: [] }]))
    })
    after(() => srv?.stop())
    const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: cfg }\ndata: { a: b }\n'

    test('YAML: anyone may check; only Kubernetes editors may apply; the kill switch stops it; Slack needs a signature', async () => {
        const c = await api('POST', '/api/ai/check-yaml', viewer.token, { yaml, namespace: 'shop' })
        assert.equal(c.status, 200); assert.equal(c.data.objects[0].namespace, 'shop')
        // Check & fix (also from Ask AI): a password left as a placeholder gets a random value
        const sec = await api('POST', '/api/ai/check-yaml', viewer.token, { yaml: 'apiVersion: v1\nkind: Secret\nmetadata: { name: db }\nstringData:\n  password: changeme\n', namespace: 'shop', fix: true })
        assert.equal(sec.status, 200); assert.doesNotMatch(sec.data.yaml, /changeme/); assert.ok(sec.data.fixes.some(x => /random value/.test(x)), JSON.stringify(sec.data.fixes))
        assert.equal((await api('POST', '/api/clusters/c5/ai-manifests/preview', viewer.token, { yaml, namespace: 'shop' })).status, 403, 'viewers only see')
        assert.equal((await api('PUT', '/api/ai/settings', owner.token, { actionsEnabled: false })).status, 200)
        const k = await api('POST', '/api/clusters/c5/ai-manifests', owner.token, { yaml, namespace: 'shop' })
        assert.equal(k.status, 403); assert.equal(k.data.code, 'AI_ACTIONS_STOPPED')
        assert.equal((await api('PUT', '/api/ai/settings', owner.token, { actionsEnabled: true, costRates: { cpu: 900, memGb: 200, currency: '₹' } })).status, 200)
        assert.equal((await api('PUT', '/api/ai/settings', owner.token, { costRates: { cpu: -1, memGb: 1, currency: '₹' } })).status, 400)
        const blocked = await api('POST', '/api/clusters/c5/ai-manifests/preview', owner.token, { yaml: 'kind: ClusterRole\nmetadata: { name: x }', namespace: 'shop' })
        assert.equal(blocked.status, 400); assert.match(blocked.data.problems[0].text, /cannot be created/)
        const s = await fetch(`${srv.url}/api/chatops/slack/nope`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=status' })
        assert.equal(s.status, 401)
        const g = await api('GET', '/api/ai', owner.token)
        assert.deepEqual(g.data.chatops, []); assert.equal(g.data.costRates.cpu, 900)
        assert.equal(JSON.stringify((await api('PUT', '/api/ai/settings', owner.token, { maskIps: false })).data).includes('chatops'), false)
    })
})
