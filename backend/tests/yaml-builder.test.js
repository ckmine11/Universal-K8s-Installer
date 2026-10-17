// Text → YAML that is right the first time: a fixed set of real descriptions
// (English and Hinglish) with what must come out, the builder's best
// practices, auto-fix for free-form YAML, and the fallbacks when AI is down or
// writes broken YAML. The same descriptions are dry-run on a real cluster in
// e2e.sh ai-ops.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { parse } from 'yaml'
import { tempDataDir } from './helpers/server.js'
import { GOLDEN } from './helpers/yamlGolden.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
const { parseIntent, buildFromIntent, autoFix, cleanIntent, cronOf } = await import('../src/services/ai/yamlBuilder.js')
const { generateManifests, checkManifests, parseManifests } = await import('../src/services/ai/manifests.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { APPS } = await import('../src/config/appCatalog.js')
after(() => { process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const USER = { id: 'u', username: 'a', orgId: 'org-noai' }   // no engine → only rules
const gen = (d, extra = {}) => generateManifests(USER, { description: d, namespace: 'shop', ...extra })
const kinds = (r) => r.objects.map(o => o.kind)
const doc = (r, kind) => r.yaml.split('\n---\n').map(x => parse(x)).find(o => o.kind === kind)
const container = (o) => (o.kind === 'Pod' ? o.spec : o.kind === 'CronJob' ? o.spec.jobTemplate.spec.template.spec : o.spec.template.spec).containers[0]


describe('golden set: descriptions → right YAML, no AI needed', () => {
    for (const [d, e] of GOLDEN) test(d, async () => {
        const r = await gen(d)
        assert.equal(r.method, 'templates', 'built by KubeEZ itself')
        assert.equal(r.blocked, false, JSON.stringify(r.problems))
        assert.deepEqual(r.problems.filter(p => p.level === 'block'), [])
        assert.deepEqual(kinds(r), e.kinds)
        assert.ok(r.objects.every(o => o.namespace === 'shop'))
        assert.equal(/&a\d|\*a\d/.test(r.yaml), false, 'no YAML anchors')
        const w = r.yaml.split('\n---\n').map(x => parse(x)).find(o => ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob'].includes(o.kind))
        const c = container(w)
        // best practices on every workload
        assert.ok(/:[\w][\w.-]*$/.test(c.image) && !/:latest$/.test(c.image), `pinned image (${c.image})`)
        assert.ok(c.resources.requests.cpu && c.resources.requests.memory && c.resources.limits.memory, 'requests and a memory limit')
        assert.equal(c.securityContext.allowPrivilegeEscalation, false)
        if (c.ports?.length && !['Job', 'CronJob'].includes(w.kind) && !APPS[r.understood[0]?.split(' · ')[0]]?.base) assert.ok(c.readinessProbe && c.livenessProbe, 'health checks')
        if (e.image) assert.equal(c.image, e.image)
        if (e.replicas) assert.equal(w.spec.replicas, e.replicas)
        if (e.port) assert.equal(c.ports[0].containerPort, e.port)
        if (e.ports) assert.deepEqual(c.ports.map(p => p.containerPort), e.ports)
        if (e.memory) assert.equal(c.resources.limits.memory, e.memory)
        if (e.schedule) assert.equal(w.spec.schedule, e.schedule)
        if (e.command) assert.match(c.command.join(' '), new RegExp(e.command))
        if (e.probe) assert.ok(c.readinessProbe[e.probe])
        if (e.volume) assert.equal((doc(r, 'PersistentVolumeClaim')?.spec || w.spec.volumeClaimTemplates?.[0]?.spec).resources.requests.storage, e.volume)
        if (e.claimTemplate) assert.equal(w.spec.volumeClaimTemplates[0].spec.resources.requests.storage, e.claimTemplate)
        if (e.secret) { assert.match(String(doc(r, 'Secret').stringData[e.secret]), /^[\w-]{20,}$/, 'a random password, never CHANGE_ME'); assert.equal(c.env.find(x => x.name === e.secret).valueFrom.secretKeyRef.name, doc(r, 'Secret').metadata.name) }
        if (e.serviceType) assert.equal(doc(r, 'Service').spec.type, e.serviceType)
        if (e.host) assert.equal(doc(r, 'Ingress').spec.rules[0].host, e.host)
        if (e.name) assert.equal(w.metadata.name, e.name)
        if (e.env) for (const [k, v] of Object.entries(e.env)) assert.equal(c.env.find(x => x.name === k).value, v)
        if (e.note) assert.ok(r.notes.some(n => e.note.test(n)), JSON.stringify(r.notes))
        // the Service finds the pods
        const svc = doc(r, 'Service'); if (svc) assert.equal(svc.spec.selector['app.kubernetes.io/name'], w.spec?.template?.metadata?.labels?.['app.kubernetes.io/name'] || w.metadata.labels['app.kubernetes.io/name'])
    })
})

describe('every catalog app builds clean', () => {
    test('one workload per app, no blocking problem', async () => {
        for (const key of Object.keys(APPS)) {
            const { docs } = buildFromIntent({ workloads: [{ name: key, app: key }] }, { namespace: 'x' })
            const c = checkManifests(JSON.parse(JSON.stringify(docs)), { namespace: 'x' })
            assert.equal(c.blocked, false, `${key}: ${JSON.stringify(c.problems)}`)
        }
    })
    test('schedules in words', () => {
        assert.equal(cronOf('every night at 2am'), '0 2 * * *'); assert.equal(cronOf('daily at 10:30 pm'), '30 22 * * *')
        assert.equal(cronOf('every 15 minutes'), '*/15 * * * *'); assert.equal(cronOf('har raat 11 baje'), '0 23 * * *')
        assert.equal(cronOf('every sunday at 6'), '0 6 * * 0'); assert.equal(cronOf('run "*/10 * * * *"'), '*/10 * * * *')
    })
})

describe('auto-fix for free-form YAML', () => {
    test('what small models get wrong is fixed', () => {
        const docs = parseManifests('apiVersion: batch/v1\nkind: Deployment\nmetadata: { name: Web_App }\nspec:\n  template:\n    spec:\n      containers:\n      - name: web\n        image: nginx:latest\n        ports: [{ containerPort: 80 }]\n        resources: { limits: { cpu: 64Mi, memory: 64Mi }, requests: { memory: 512Mi } }\n---\nkind: Job\napiVersion: batch/v1\nmetadata: { name: once }\nspec: { template: { spec: { containers: [{ name: c, image: busybox }] } } }')
        const { docs: out, fixes } = autoFix(docs)
        const [dep, job] = out
        assert.equal(dep.apiVersion, 'apps/v1'); assert.equal(dep.metadata.name, 'web-app')
        assert.deepEqual(dep.spec.selector.matchLabels, { 'app.kubernetes.io/name': 'web-app' })
        assert.equal(dep.spec.template.metadata.labels['app.kubernetes.io/name'], 'web-app')
        const c = dep.spec.template.spec.containers[0]
        assert.equal(c.image, 'nginx:1.27-alpine'); assert.equal(c.resources.limits.cpu, undefined)
        assert.equal(c.resources.requests.memory, '64Mi', 'request lowered to the limit')
        assert.ok(c.readinessProbe.httpGet)
        assert.equal(job.spec.template.spec.restartPolicy, 'OnFailure'); assert.equal(job.spec.template.spec.containers[0].image, 'busybox:1.36')
        assert.ok(fixes.length >= 8)
        assert.equal(checkManifests(out, { namespace: 'x' }).blocked, false)
    })
    test('a model\'s intent JSON is checked: unknown apps, bad values dropped', () => {
        const c = cleanIntent({ workloads: [{ app: 'nginx', replicas: 9999, memory: '64 megs', port: 80, expose: 'internet' }, { app: 'nope' }, { image: 'evil; rm -rf /' }] })
        assert.equal(c.workloads.length, 1)
        assert.equal(c.workloads[0].replicas, null); assert.equal(c.workloads[0].memory, null); assert.equal(c.workloads[0].expose, null)
        assert.deepEqual(cleanIntent({ freeform: true }), { workloads: [], freeform: true })
    })
})

describe('undo covers every kind it can create', () => {
    test('a Pod made from "create httpd pod" is really deleted by undo (found on a real cluster)', async () => {
        const { applyManifests, undoManifests } = await import('../src/services/ai/manifests.js')
        const g = await gen('create httpd pod')
        const cmds = []
        const ssh = { async execCommand(cmd) { cmds.push(cmd); return /get (pod|service) .* -o json/.test(cmd) ? { code: 1, stdout: '' } : { code: 0, stdout: 'ok' } } }
        const rec = await applyManifests(ssh, g, { orgId: 'o', cluster: { id: 'c', clusterName: 'c' }, user: { username: 'a' } })
        assert.deepEqual(rec.created, ['Pod/httpd', 'Service/httpd'])
        await undoManifests(ssh, rec, { username: 'a' })
        assert.ok(cmds.some(c => /delete pod httpd --ignore-not-found/.test(c)), 'the Pod is deleted')
        assert.ok(cmds.some(c => /delete service httpd --ignore-not-found/.test(c)))
        assert.equal(cmds.some(c => / undefined /.test(c)), false, 'no kind without its resource name')
    })
})

describe('fallbacks', () => {
    test('AI down: what the rules understood is still built; nothing understood → a clear message', async () => {
        const r = await gen('nginx with a sidecar that ships logs')
        assert.equal(r.method, 'templates'); assert.ok(r.notes.some(n => /could not answer/.test(n)) || r.notes.some(n => /not included/.test(n)))
        await assert.rejects(gen('make my thing work nicely'), /Name the app or image/)
    })
    test('the model writes broken YAML → KubeEZ fixes it and asks once more', async () => {
        let calls = 0
        const m = http.createServer((req, res) => { let b = ''; req.on('data', x => b += x); req.on('end', () => {
            calls++
            const body = JSON.parse(b)
            const understand = /turn a request for Kubernetes workloads into JSON/.test(body.messages[0].content)
            const text = understand ? '{"workloads":[],"freeform":true}'
                : calls === 2 ? 'apiVersion: v1\nkind: Pod\nmetadata: { name: x }\nspec:\n  hostNetwork: true\n  containers: [{ name: c, image: nginx:latest }]'
                    : 'apiVersion: v1\nkind: Pod\nmetadata: { name: x }\nspec:\n  containers: [{ name: c, image: nginx:latest }]'
            res.end(JSON.stringify({ choices: [{ message: { content: text } }] }))
        }) })
        await new Promise(r => m.listen(0, '127.0.0.1', r))
        try {
            aiStore.addProvider('org-free', { name: 'F', kind: 'ollama', baseUrl: `http://127.0.0.1:${m.address().port}`, model: 'm' })
            const r = await generateManifests({ id: 'u', username: 'a', orgId: 'org-free' }, { description: 'a pod with a sidecar container that tails logs', namespace: 'shop' })
            assert.equal(r.method, 'ai-yaml')
            assert.equal(calls, 3, 'understand → write (blocked: hostNetwork) → write again')
            assert.equal(r.blocked, false)
            assert.ok(r.fixes.some(f => /nginx:1\.27-alpine/.test(f)), 'the image was pinned')
        } finally { m.close() }
    })
})
