// Phase 3: the CVE deploy gate, deploy tokens and the CI webhook, Hibernate /
// Wake, debug containers, External Secrets status, and promotions by GitHub
// pull request — with the gates for every role (in-process, fake clusters).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir, paidOrgs } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
paidOrgs(DATA, ['org-p'])
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 'p1', clusterName: 'prod', orgId: 'org-p', ownerId: 'p-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.80', username: 'root', password: 'x' }], workerNodes: [] },
    { id: 'p-ro', clusterName: 'ro', orgId: 'org-p', ownerId: 'p-admin', k8sVersion: '1.34.0', imported: true, access: { mode: 'direct', level: 'read', server: 'https://203.0.113.10', token: 'x' }, masterNodes: [], workerNodes: [] }
]))

const gate = await import('../src/services/cveGate.js')
const helm = await import('../src/services/helmApps.js')
const { apiTokens, applySet } = await import('../src/services/apiTokens.js')
const hib = await import('../src/services/hibernate.js')
const eso = await import('../src/services/externalSecrets.js')
const gp = await import('../src/services/gitPromote.js')
const { deliveryStore } = await import('../src/services/deliveryStore.js')
after(() => { helm._test.useConnect(null); hib._test.useConnect(null); eso._test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: shop }
spec: { template: { spec: { initContainers: [{ name: init, image: "busybox:1.37" }], containers: [{ name: web, image: "docker.io/library/nginx:1.25" }, { name: side, image: "ghcr.io/acme/agent:2.0@sha256:abc123" }] } } }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: backup, namespace: shop }
spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: b, image: "acme/backup" }] } } } } }
`
const SECURITY = { tools: { vulnerabilities: { state: 'ok' } }, reports: [
    { image: 'nginx:1.25', counts: { critical: 2, high: 5, medium: 0, low: 0 }, updatedAt: '2026-10-29T10:00:00Z', vulns: [{ id: 'CVE-1', severity: 'CRITICAL' }, { id: 'CVE-2', severity: 'CRITICAL' }, { id: 'CVE-3', severity: 'HIGH' }] },
    { image: 'ghcr.io/acme/agent:2.0', counts: { critical: 0, high: 3, medium: 1, low: 0 }, updatedAt: '2026-10-29T10:00:00Z', vulns: [{ id: 'CVE-9', severity: 'HIGH' }] },
    { image: 'busybox:1.37', counts: { critical: 0, high: 0, medium: 0, low: 1 }, updatedAt: '2026-10-29T10:00:00Z', vulns: [] }
] }

describe('CVE deploy gate', () => {
    test('every image of the rendered app, named the way Trivy names them', () => {
        assert.deepEqual(gate.imagesOf(MANIFEST), ['acme/backup', 'busybox:1.37', 'docker.io/library/nginx:1.25', 'ghcr.io/acme/agent:2.0@sha256:abc123'])
        assert.equal(gate.normImage('docker.io/library/nginx:1.25'), 'nginx:1.25')
        assert.equal(gate.normImage('ghcr.io/acme/agent:2.0@sha256:abc'), 'ghcr.io/acme/agent:2.0')
        assert.equal(gate.normImage('acme/backup'), 'acme/backup:latest')
    })
    test('block on critical: nginx fails; HIGH also fails the agent; unscanned images are listed, never blocked', () => {
        const imgs = gate.imagesOf(MANIFEST)
        const c = gate.checkImages(imgs, SECURITY, { mode: 'block', severity: 'CRITICAL' })
        assert.equal(c.blocked, true); assert.deepEqual(c.failing.map(f => f.image), ['docker.io/library/nginx:1.25'])
        assert.deepEqual(c.failing[0].cves, ['CVE-1', 'CVE-2']); assert.deepEqual(c.unscanned, ['acme/backup'])
        const h = gate.checkImages(imgs, SECURITY, { mode: 'warn', severity: 'HIGH' })
        assert.equal(h.blocked, false, 'warn never blocks'); assert.equal(h.failing.length, 2)
        assert.equal(gate.checkImages(['busybox:1.37'], SECURITY, { mode: 'block' }).blocked, false)
        assert.equal(gate.checkImages(imgs, null, { mode: 'block' }).blocked, false, 'no Trivy: nothing scanned, nothing blocked')
        assert.match(gate.gateText(c), /nginx:1\.25 \(2 critical: CVE-1, CVE-2\)/)
    })
})

// a fake control-plane for helm (values, dry run with MANIFEST, upgrades)
const helmFake = () => {
    const calls = []
    const connect = async () => ({
        execCommand: async (cmd, o = {}) => {
            calls.push({ cmd, stdin: o.stdin ?? null })
            if (/HELM get values/.test(cmd)) return { code: 0, stdout: JSON.stringify({ image: { tag: '1.0', repository: 'acme/web' }, replicas: 2 }) }
            if (/--dry-run=server/.test(cmd)) return { code: 0, stdout: JSON.stringify({ manifest: MANIFEST }) }
            if (/HELM list/.test(cmd)) return { code: 0, stdout: '[]' }
            return { code: 0, stdout: '{}' }
        },
        dispose() { }
    })
    return { calls, connect }
}
const repo = { id: 'r', name: 'acme', url: 'https://charts.acme.io' }

describe('the gate inside a deploy', () => {
    const cluster = { id: 'p1', orgId: 'org-p' }
    const d = () => helm.cleanDeploy({ release: 'web', namespace: 'shop', chart: 'web' }, repo)
    test('block: the job fails before Helm changes anything; an admin override deploys with a warning', async () => {
        const f = helmFake()
        const j = await helm.deploy(cluster, d(), { connect: f.connect, gate: { policy: { mode: 'block', severity: 'CRITICAL' }, read: async () => SECURITY } })
        await helm._test.jobs.get(j.id).promise
        assert.equal(helm.findJob(j.id).status, 'failed'); assert.match(helm.findJob(j.id).error, /Blocked by the CVE policy.*nginx:1\.25/)
        assert.equal(f.calls.some(c => /--wait/.test(c.cmd)), false, 'no upgrade ran')
        const o = await helm.deploy(cluster, d(), { connect: f.connect, gate: { policy: { mode: 'block', severity: 'CRITICAL' }, override: 'hotfix', read: async () => SECURITY } })
        await helm._test.jobs.get(o.id).promise
        const v = helm.jobView(helm.findJob(o.id))
        assert.equal(v.status, 'done'); assert.match(v.warnings[0], /CVE policy overridden/); assert.match(v.warnings[1], /Not scanned by Trivy yet: acme\/backup/)
    })
    test('preview shows the check', async () => {
        const f = helmFake()
        f.connect = (orig => async () => { const s = await orig(); const e = s.execCommand; s.execCommand = async (cmd, o) => /--dry-run=server/.test(cmd) ? { code: 0, stdout: `==CUR==\n==NEW==\n${JSON.stringify({ manifest: MANIFEST, chart: { metadata: { name: 'web', version: '1' } } })}` } : e(cmd, o); return s })(f.connect)
        const p = await helm.previewDeploy(cluster, d(), { connect: f.connect, gate: { policy: { mode: 'warn', severity: 'CRITICAL' }, read: async () => SECURITY } })
        assert.equal(p.cve.mode, 'warn'); assert.equal(p.cve.failing.length, 1); assert.equal('manifest' in p, false)
    })
})

describe('deploy tokens', () => {
    const base = { name: 'github actions web', clusterId: 'p1', namespace: 'dev', release: 'web', repoId: 'r1', chart: 'web' }
    const ctx = { by: 'admin', clusterIds: ['p1'], repoIds: ['r1'] }
    test('made for one release; checked; shown once; stored hashed', () => {
        const { token, record } = apiTokens.create('org-t', base, ctx)
        assert.match(token, /^kzt_[A-Za-z0-9_-]{40,}$/)
        assert.deepEqual(record.allowedKeys, ['image.tag']); assert.equal('hash' in record, false)
        assert.equal(fs.readFileSync(path.join(DATA, 'api-tokens.json'), 'utf8').includes(token), false)
        assert.equal(apiTokens.verify(token).id, record.id)
        assert.equal(apiTokens.verify(token.slice(0, -1) + 'x'), null)
        assert.equal(apiTokens.verify('kzm_abc'), null)
        for (const b of [{ ...base, clusterId: 'other' }, { ...base, repoId: 'x' }, { ...base, release: 'Web' }, { ...base, allowedKeys: ['__proto__.x'] }, { ...base, allowedKeys: ['a;b'] }, { ...base, expiresDays: 400 }, { ...base, name: 'x' }])
            assert.throws(() => apiTokens.create('org-t', b, ctx), (e) => e.status === 400, JSON.stringify(b))
        apiTokens.revoke('org-t', record.id); assert.equal(apiTokens.verify(token), null, 'revoked')
        const exp = apiTokens.create('org-t', { ...base, expiresDays: 1 }, ctx)
        const all = JSON.parse(fs.readFileSync(path.join(DATA, 'api-tokens.json'), 'utf8')); all.find(t => t.id === exp.record.id).expiresAt = new Date(Date.now() - 1).toISOString()
        fs.writeFileSync(path.join(DATA, 'api-tokens.json'), JSON.stringify(all))
        assert.equal(apiTokens.verify(exp.token), null, 'expired')
        assert.equal(apiTokens.list('org-other').length, 0)
    })
    test('only the keys the token lists change; nested values are created', () => {
        assert.deepEqual(applySet({ image: { tag: '1' }, replicas: 2 }, { 'image.tag': '2' }, ['image.tag']), { image: { tag: '2' }, replicas: 2 })
        assert.deepEqual(applySet({}, { 'image.tag': '2' }, ['image.tag']), { image: { tag: '2' } })
        assert.throws(() => applySet({}, { replicas: 99 }, ['image.tag']), (e) => e.status === 403)
        assert.throws(() => applySet({}, { 'image.tag': { evil: 1 } }, ['image.tag']), /short string/)
        assert.throws(() => applySet({}, ['x'], ['image.tag']), /set: an object/)
    })
})

describe('Hibernate / Wake and debug containers', () => {
    const lines = ['shop\tDeployment\tweb\t3\t', 'shop\tDeployment\tworker\t0\t', 'shop\tStatefulSet\tdb\t1\t', 'shop\tDeployment\told\t0\t2', 'shop\tPod\tx\t1\t', "shop\tDeployment\tbad;name\t1\t"].join('\n')
    test('workloads parsed; odd names dropped', () => {
        const w = hib.parseWorkloads(lines)
        assert.deepEqual(w.map(x => `${x.kind}/${x.name}:${x.replicas}:${x.saved}`), ['Deployment/web:3:null', 'Deployment/worker:0:null', 'StatefulSet/db:1:null', 'Deployment/old:0:2'])
    })
    test('hibernate remembers replicas first, then scales to 0; wake restores and forgets', async () => {
        const calls = []
        const connect = (out) => async () => ({ execCommand: async (cmd) => { calls.push(cmd); return { code: 0, stdout: /get deployments/.test(cmd) ? out : '' } }, dispose() { } })
        const r = await hib.hibernate({ id: 'c' }, 'shop', { connect: connect(lines) })
        assert.deepEqual(r.changed, ['Deployment/web 3→0', 'StatefulSet/db 1→0'])
        const cmd = calls.at(-1)
        assert.ok(cmd.indexOf("annotate deployment/'web' kubeez.io/hibernated-replicas=3") < cmd.indexOf("scale deployment/'web' --replicas=0"))
        assert.equal(/worker/.test(cmd), false, 'workloads already at 0 are left alone')
        calls.length = 0
        const w = await hib.wake({ id: 'c' }, 'shop', { connect: connect(lines) })
        assert.deepEqual(w.changed, ['Deployment/old 0→2'])
        assert.match(calls.at(-1), /scale deployment\/'old' --replicas=2 && .*annotate deployment\/'old' kubeez\.io\/hibernated-replicas-/)
        await assert.rejects(hib.hibernate({ id: 'c' }, 'Shop;x', { connect: connect('') }), /valid namespace/)
    })
    test('debug container: only known images, a valid pod, ends by itself', async () => {
        let cmd
        const connect = async () => ({ execCommand: async (c) => { cmd = c; return { code: 0 } }, dispose() { } })
        const r = await hib.addDebugContainer({ id: 'c' }, { namespace: 'shop', pod: 'web-7d9-abcde', target: 'web', image: 'netshoot' }, { connect })
        assert.match(cmd, /kubectl debug -n 'shop' 'web-7d9-abcde' --image='nicolaka\/netshoot:v0\.14' -c kubeez-debug-[a-z0-9]+ --target='web' --profile=general -- sleep 3600$/)
        assert.match(r.command, /^kubectl exec -it -n shop web-7d9-abcde -c kubeez-debug-/)
        await assert.rejects(hib.addDebugContainer({ id: 'c' }, { namespace: 'shop', pod: 'x', image: 'alpine:latest' }, { connect }), /Image: busybox or netshoot/)
        await assert.rejects(hib.addDebugContainer({ id: 'c' }, { namespace: 'shop', pod: 'x;rm' }, { connect }), /valid pod/)
    })
})

describe('External Secrets', () => {
    const OUT = `==KZESO:ES==\n${JSON.stringify({ items: [
        { metadata: { name: 'db', namespace: 'shop' }, spec: { secretStoreRef: { kind: 'ClusterSecretStore', name: 'vault' }, target: { name: 'db-creds' }, refreshInterval: '15m', data: [{}, {}] }, status: { refreshTime: '2026-10-30T08:00:00Z', conditions: [{ type: 'Ready', status: 'True', reason: 'SecretSynced' }] } },
        { metadata: { name: 'api', namespace: 'team-b' }, spec: { secretStoreRef: { name: 'aws' }, dataFrom: [{}] }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'SecretSyncedError', message: 'could not get secret: AccessDenied' }] } }] })}\n==KZESO:SS==\n${JSON.stringify({ items: [{ metadata: { name: 'aws', namespace: 'team-b' }, spec: { provider: { aws: { region: 'ap-south-1' } } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] })}\n==KZESO:CSS==\n${JSON.stringify({ items: [{ metadata: { name: 'vault' }, spec: { provider: { vault: {} } }, status: { conditions: [{ type: 'Ready', status: 'False', message: 'permission denied' }] } }] })}\n==KZESO:END==`
    test('sync status per ExternalSecret and store; failures first; never a value', () => {
        const r = eso.parseEso(OUT)
        assert.equal(r.installed, true)
        assert.deepEqual(r.externalSecrets.map(e => `${e.namespace}/${e.name}:${e.ready}`), ['team-b/api:false', 'shop/db:true'])
        assert.equal(r.externalSecrets[0].message, 'could not get secret: AccessDenied'); assert.equal(r.externalSecrets[1].store, 'ClusterSecretStore/vault'); assert.equal(r.externalSecrets[1].keys, 2)
        assert.deepEqual(r.stores.map(s => `${s.kind}/${s.name}:${s.provider}:${s.ready}`), ['SecretStore/aws:aws:true', 'ClusterSecretStore/vault:vault:false'])
        assert.equal(/get secrets?\b/.test(eso.ESO_SCRIPT), false)
        assert.deepEqual(eso.parseEso('==KZESO:ES_ERR==\nerror: the server doesn\'t have a resource type "externalsecrets"\n==KZESO:END=='), { installed: false, error: null, externalSecrets: [], stores: [] })
    })
})

describe('promotion by pull request', () => {
    const FILE = '# prod values\nimage:\n  repository: acme/web\n  tag: "1.4.1"  # bumped by CI\nreplicas: 3\n'
    test('requests checked; YAML edited with comments kept', () => {
        const ok = { repo: 'acme/deploy', base: 'main', path: 'apps/web/prod.yaml', set: { 'image.tag': '1.4.2' } }
        assert.equal(gp.cleanPromotion(ok).path, 'apps/web/prod.yaml')
        for (const b of [{ ...ok, repo: 'acme' }, { ...ok, path: '../x.yaml' }, { ...ok, path: 'a/b.json' }, { ...ok, base: 'a..b' }, { ...ok, set: {} }, { ...ok, set: { '__proto__.x': 1 } }, { ...ok, set: { 'a b': 1 } }, { ...ok, set: { x: { y: 1 } } }])
            assert.throws(() => gp.cleanPromotion(b), (e) => e.status === 400, JSON.stringify(b))
        const r = gp.setInYaml(FILE, { 'image.tag': '1.4.2', 'resources.limits.memory': '512Mi' })
        assert.match(r.text, /# prod values/); assert.match(r.text, /tag: "?1\.4\.2"?\s+# bumped by CI/)
        assert.match(r.text, /resources:\n\s+limits:\n\s+memory: 512Mi/)
        assert.deepEqual(r.changes, [{ key: 'image.tag', from: '1.4.1', to: '1.4.2' }, { key: 'resources.limits.memory', from: null, to: '512Mi' }])
        assert.throws(() => gp.setInYaml(FILE, { image: 'x' }), /is a map/)
    })
    test('branch, commit and pull request on GitHub; nothing to change → 409; bad token → clear message', async () => {
        const seen = []
        const fake = (status = 200) => async (url, o) => {
            const u = new URL(url); seen.push(`${o.method} ${u.pathname}${u.search}`)
            const body = o.body ? JSON.parse(o.body) : null
            if (status !== 200) return new Response(JSON.stringify({ message: 'Bad credentials' }), { status })
            if (o.method === 'GET' && /\/contents\//.test(u.pathname)) return Response.json({ type: 'file', sha: 'filesha', content: Buffer.from(FILE).toString('base64') })
            if (o.method === 'GET' && /\/git\/ref\/heads\/main$/.test(u.pathname)) return Response.json({ object: { sha: 'basesha' } })
            if (o.method === 'POST' && /\/git\/refs$/.test(u.pathname)) { assert.equal(body.sha, 'basesha'); assert.match(body.ref, /^refs\/heads\/kubeez\/promote-/); return Response.json({}) }
            if (o.method === 'PUT') { assert.equal(body.sha, 'filesha'); assert.match(Buffer.from(body.content, 'base64').toString(), /tag: "?1\.4\.2"?/); assert.match(body.message, /image\.tag: 1\.4\.1 → 1\.4\.2/); return Response.json({}) }
            if (o.method === 'POST' && /\/pulls$/.test(u.pathname)) { assert.equal(body.base, 'main'); assert.match(body.body, /Opened from KubeEZ by \*\*opsy\*\*/); return Response.json({ html_url: 'https://github.com/acme/deploy/pull/7', number: 7 }) }
            return new Response('{}', { status: 404 })
        }
        const p = gp.cleanPromotion({ repo: 'acme/deploy', path: 'apps/web/prod.yaml', set: { 'image.tag': '1.4.2' } })
        const r = await gp.openPromotionPr({ apiUrl: 'https://api.github.com', token: 'ghp_x' }, p, { by: 'opsy', fetchImpl: fake() })
        assert.equal(r.number, 7); assert.equal(r.url, 'https://github.com/acme/deploy/pull/7')
        assert.deepEqual(seen.map(s => s.split(' ')[0]), ['GET', 'GET', 'POST', 'PUT', 'POST'])
        await assert.rejects(gp.openPromotionPr({ token: 't' }, gp.cleanPromotion({ repo: 'acme/deploy', path: 'apps/web/prod.yaml', set: { 'image.tag': '1.4.1' } }), { fetchImpl: fake() }), (e) => e.status === 409 && /nothing to promote/.test(e.message))
        await assert.rejects(gp.openPromotionPr({ token: 't' }, p, { fetchImpl: fake(401) }), /GitHub said 401: Bad credentials — check the token/)
    })
    test('SaaS: the GitHub API address must be public', async () => {
        process.env.KUBEEZ_MODE = 'saas'
        try { await assert.rejects(gp.openPromotionPr({ apiUrl: 'https://10.1.2.3/api/v3', token: 't' }, gp.cleanPromotion({ repo: 'a/b', path: 'x.yaml', set: { a: 1 } }), { fetchImpl: async () => Response.json({}) }), /private\/internal/) } finally { process.env.KUBEEZ_MODE = 'selfhosted' }
    })
})

describe('API: webhook, tokens, operations — who may do what', () => {
    let base, server, approvalStore, repoId
    const U = {
        admin: { id: 'p-admin', username: 'padmin', orgId: 'org-p', role: 'admin' },
        operator: { id: 'p-op', username: 'pop', orgId: 'org-p', role: 'operator' },
        viewer: { id: 'p-view', username: 'pview', orgId: 'org-p', role: 'viewer' },
        scoped: { id: 'p-sc', username: 'psc', orgId: 'org-p', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'p1', role: 'operator', namespaces: ['team-a'] }] }
    }
    const call = async (who, method, p, body, headers = {}) => {
        const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': who } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
        return { status: r.status, data: await r.json().catch(() => null) }
    }
    const hook = (token, body) => call(null, 'POST', '/api/hooks/deploy', body, { authorization: `Bearer ${token}` })
    const f = helmFake()
    const kube = []
    const wait = async (id) => { await helm._test.jobs.get(id)?.promise }

    before(async () => {
        const express = (await import('express')).default
        const { default: hooks } = await import('../src/routes/hooks.js')
        const { default: delivery } = await import('../src/routes/delivery.js')
        const { default: operate } = await import('../src/routes/operate.js')
        const { auditTrail } = await import('../src/services/auditLog.js');
        ({ approvalStore } = await import('../src/services/approvalStore.js'))
        helm._test.useConnect(f.connect)
        const W = 'dev\tDeployment\tweb\t2\t\nshop\tDeployment\tapi\t1\t'
        hib._test.useConnect(async () => ({ execCommand: async (cmd) => { kube.push(cmd); return { code: 0, stdout: /get deployments/.test(cmd) ? W : '' } }, dispose() { } }))
        eso._test.useConnect(async () => ({ execCommand: async (cmd) => { kube.push(cmd); return { code: 0, stdout: /KZESO/.test(cmd) ? `==KZESO:ES==\n${JSON.stringify({ items: [{ metadata: { name: 'db', namespace: 'team-a' }, spec: {}, status: {} }, { metadata: { name: 'x', namespace: 'shop' }, spec: {}, status: {} }] })}\n==KZESO:SS==\n{"items":[]}\n==KZESO:CSS==\n{"items":[]}\n==KZESO:END==` : '' } }, dispose() { } }))
        repoId = deliveryStore.saveRepo('org-p', { name: 'acme', url: 'https://charts.acme.io' }).id
        deliveryStore.saveEnvironment('org-p', { name: 'prod', clusterId: 'p1', namespace: 'shop', protected: true }, { clusterIds: ['p1'] })
        const app = express()
        app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use(auditTrail)
        app.use('/api/hooks', hooks)
        app.use('/api/delivery', delivery)
        app.use('/api/clusters', operate)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('tokens: admins only; shown once; the webhook deploys exactly what the token allows', async () => {
        const body = { name: 'ci web dev', clusterId: 'p1', namespace: 'dev', release: 'web', repoId, chart: 'web', allowedKeys: ['image.tag'] }
        assert.equal((await call('operator', 'POST', '/api/delivery/tokens', body)).status, 403)
        const c = await call('admin', 'POST', '/api/delivery/tokens', body)
        assert.equal(c.status, 200, JSON.stringify(c.data)); const token = c.data.token
        const list = await call('admin', 'GET', '/api/delivery/tokens')
        assert.equal(JSON.stringify(list.data).includes(token), false); assert.equal(list.data.tokens[0].hint.endsWith(token.slice(-4)), true)
        assert.equal((await hook('kzt_nope', { set: { 'image.tag': '2.0' } })).status, 401)
        assert.equal((await hook(token, { set: { replicas: 9 } })).status, 403)
        const d = await hook(token, { set: { 'image.tag': '2.0' } })
        assert.equal(d.status, 202, JSON.stringify(d.data)); await wait(d.data.id)
        const up = f.calls.filter(x => /upgrade --install/.test(x.cmd) && /--wait/.test(x.cmd)).at(-1)
        assert.match(up.cmd, /upgrade --install 'web' 'web' --repo 'https:\/\/charts\.acme\.io' -n 'dev'/)
        assert.deepEqual(JSON.parse(up.stdin), { image: { tag: '2.0', repository: 'acme/web' }, replicas: 2 }, 'the live values with only image.tag changed')
        const j = await call(null, 'GET', `/api/hooks/jobs/${d.data.id}`, null, { authorization: `Bearer ${token}` })
        assert.equal(j.data.status, 'done')
        // a second token for another release cannot read that job
        const other = (await call('admin', 'POST', '/api/delivery/tokens', { ...body, name: 'ci api dev', release: 'api' })).data.token
        assert.equal((await call(null, 'GET', `/api/hooks/jobs/${d.data.id}`, null, { authorization: `Bearer ${other}` })).status, 404)
        // revoked → 401
        assert.equal((await call('admin', 'DELETE', `/api/delivery/tokens/${c.data.record.id}`)).status, 200)
        assert.equal((await hook(token, { set: { 'image.tag': '2.1' } })).status, 401)
        await new Promise(r => setTimeout(r, 50))
        const rows = fs.readdirSync(path.join(DATA, 'audit')).flatMap(x => fs.readFileSync(path.join(DATA, 'audit', x), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
        assert.ok(rows.some(r => r.action === 'hook.deploy' && r.ok && r.actor?.username === 'token:ci web dev' && /set image\.tag=2\.0/.test(r.detail)))
        assert.ok(rows.some(r => r.action === 'hook.deploy' && !r.ok && r.status === 403))
    })

    test('the webhook respects protected environments, freezes, read-only clusters and the CVE policy', async () => {
        const mk = async (o) => (await call('admin', 'POST', '/api/delivery/tokens', { name: `t ${Math.random().toString(36).slice(2, 7)}`, clusterId: 'p1', namespace: 'dev', release: 'web', repoId, chart: 'web', ...o })).data.token
        const prot = await hook(await mk({ namespace: 'shop' }), { set: { 'image.tag': '2' } })
        assert.equal(prot.status, 403); assert.equal(prot.data.code, 'PROTECTED')
        const fr = deliveryStore.saveFreeze('org-p', { from: new Date(Date.now() - 1000).toISOString(), until: new Date(Date.now() + 3600e3).toISOString(), reason: 'Big sale' }, { clusterIds: ['p1'] })
        try { const r = await hook(await mk({}), { set: { 'image.tag': '2' } }); assert.equal(r.status, 423); assert.match(r.data.error, /Big sale/) } finally { deliveryStore.removeFreeze('org-p', fr.id) }
        assert.equal((await hook(await mk({ clusterId: 'p-ro' }), {})).status, 409)
        // the dev environment blocks critical CVEs: the job fails before Helm upgrades
        const env = deliveryStore.saveEnvironment('org-p', { name: 'dev', clusterId: 'p1', namespace: 'dev', cvePolicy: { mode: 'block', severity: 'CRITICAL' } }, { clusterIds: ['p1'] })
        try {
            const sec = await import('../src/services/security.js')
            sec._test.useConnect(async () => ({ execCommand: async () => ({ stdout: `==KZSEC:VULN==\n${['R', 'dev', 'r', 'ReplicaSet', 'web-7d9fc8b6c', 'web', 'index.docker.io', 'library/nginx', '1.25', '1', '0', '0', '0', '2026-10-29T10:00:00Z'].join('\t')}\n==KZSEC:AUDIT==\n\n==KZSEC:END==` }), dispose() { } }))
            const r = await hook(await mk({}), { set: { 'image.tag': '3' } })
            assert.equal(r.status, 202); await wait(r.data.id)
            assert.equal(helm.findJob(r.data.id).status, 'failed'); assert.match(helm.findJob(r.data.id).error, /CVE policy/)
            sec._test.useConnect(null)
        } finally { deliveryStore.removeEnvironment('org-p', env.id) }
    })

    test('hibernate / wake: operators in free namespaces; protected → second person; system namespaces admins only; limits', async () => {
        assert.equal((await call('viewer', 'POST', '/api/clusters/p1/hibernate', { namespace: 'dev' })).status, 403)
        const h = await call('operator', 'POST', '/api/clusters/p1/hibernate', { namespace: 'dev' })
        assert.equal(h.status, 200, JSON.stringify(h.data)); assert.deepEqual(h.data.changed, ['Deployment/web 2→0'])
        const p = await call('admin', 'POST', '/api/clusters/p1/hibernate', { namespace: 'shop' })
        assert.equal(p.status, 428); assert.match(p.data.summary, /Hibernate namespace shop on prod/)
        assert.equal((await call('operator', 'POST', '/api/clusters/p1/hibernate', { namespace: 'kube-system' })).status, 403)
        assert.equal((await call('scoped', 'POST', '/api/clusters/p1/wake', { namespace: 'dev' })).status, 403)
        assert.equal((await call('operator', 'POST', '/api/clusters/p1/wake', { namespace: 'x;y' })).status, 400)
        assert.equal((await call('admin', 'POST', '/api/clusters/p-ro/hibernate', { namespace: 'dev' })).status, 409)
        assert.equal((await call('viewer', 'GET', '/api/clusters/p1/hibernate')).status, 200)
    })

    test('debug containers need terminal access and the debug permission; approvals can protect them', async () => {
        assert.equal((await call('viewer', 'POST', '/api/clusters/p1/debug', { namespace: 'dev', pod: 'web-1', image: 'busybox' })).status, 403)
        const ok = await call('operator', 'POST', '/api/clusters/p1/debug', { namespace: 'dev', pod: 'web-1', image: 'busybox' })
        assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.match(ok.data.command, /kubectl exec -it -n dev web-1 -c kubeez-debug-/)
        assert.equal((await call('operator', 'POST', '/api/clusters/p1/debug', { namespace: 'dev', pod: 'web-1', image: 'evil:latest' })).status, 400)
        approvalStore.saveSettings('org-p', { actions: { 'debug:ephemeral': true } })
        try { assert.equal((await call('operator', 'POST', '/api/clusters/p1/debug', { namespace: 'dev', pod: 'web-1', image: 'busybox' })).status, 428) } finally { approvalStore.saveSettings('org-p', { actions: {} }) }
    })

    test('External Secrets: status per namespace limits; refresh needs deploy rights', async () => {
        const all = await call('viewer', 'GET', '/api/clusters/p1/external-secrets')
        assert.equal(all.status, 200); assert.equal(all.data.externalSecrets.length, 2)
        const sc = await call('scoped', 'GET', '/api/clusters/p1/external-secrets')
        assert.deepEqual(sc.data.externalSecrets.map(e => e.namespace), ['team-a'])
        assert.equal((await call('viewer', 'POST', '/api/clusters/p1/external-secrets/refresh', { namespace: 'shop', name: 'x' })).status, 403)
        assert.equal((await call('scoped', 'POST', '/api/clusters/p1/external-secrets/refresh', { namespace: 'shop', name: 'x' })).status, 404)
        const r = await call('operator', 'POST', '/api/clusters/p1/external-secrets/refresh', { namespace: 'shop', name: 'x' })
        assert.equal(r.status, 200); assert.ok(kube.some(c => /annotate externalsecrets\.external-secrets\.io 'x' force-sync=\d+ --overwrite/.test(c)))
    })

    test('Git accounts: admins manage, token never sent back; promotions checked before GitHub is called', async () => {
        assert.equal((await call('operator', 'POST', '/api/delivery/git', { name: 'gh', token: 'ghp_' + 'x'.repeat(30) })).status, 403)
        const a = await call('admin', 'POST', '/api/delivery/git', { name: 'gh', token: 'ghp_' + 'x'.repeat(30) })
        assert.equal(a.status, 200); assert.equal(a.data.hasToken, true)
        const l = await call('viewer', 'GET', '/api/delivery/git'); assert.equal(JSON.stringify(l.data).includes('ghp_'), false)
        assert.equal((await call('viewer', 'POST', '/api/delivery/promote', { accountId: a.data.id, repo: 'a/b', path: 'x.yaml', set: { a: 1 } })).status, 403)
        assert.equal((await call('operator', 'POST', '/api/delivery/promote', { accountId: 'nope', repo: 'a/b', path: 'x.yaml', set: { a: 1 } })).status, 400)
        assert.equal((await call('operator', 'POST', '/api/delivery/promote', { accountId: a.data.id, repo: 'a/b', path: '../x.yaml', set: { a: 1 } })).status, 400)
        assert.equal((await call('admin', 'POST', '/api/delivery/git', { name: 'bad', apiUrl: 'http://ghe.local', token: 'ghp_' + 'x'.repeat(30) })).status, 400)
    })
})
