// Image signature gate (cosign), deploy risk, Helm drift and the cert-manager
// dashboard — the services and the API gates for every role (in-process, fake
// clusters, a fake registry, a fake AI).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tempDataDir, paidOrgs } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
paidOrgs(DATA, ['org-s'])
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 's1', clusterName: 'prod', orgId: 'org-s', ownerId: 's-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.95', username: 'root', password: 'x' }], workerNodes: [] },
    { id: 's-ro', clusterName: 'ro', orgId: 'org-s', ownerId: 's-admin', k8sVersion: '1.34.0', imported: true, access: { mode: 'direct', level: 'read', server: 'https://203.0.113.12', token: 'x' }, masterNodes: [], workerNodes: [] }
]))

const sg = await import('../src/services/signGate.js')
const helm = await import('../src/services/helmApps.js')
const drift = await import('../src/services/helmDrift.js')
const risk = await import('../src/services/deployRisk.js')
const cm = await import('../src/services/certManager.js')
const { deliveryStore } = await import('../src/services/deliveryStore.js')
after(() => { helm._test.useConnect(null); cm._test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })
const bash = ['/bin/bash', '/usr/bin/bash'].find(p => fs.existsSync(p)) || (spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null)

// ── a fake OCI registry with cosign signatures ──
const sha = (b) => `sha256:${crypto.createHash('sha256').update(b).digest('hex')}`
const trusted = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pub = (k) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString()
function registry({ signedWith = { web: trusted, evil: other } } = {}) {
    const seen = []
    const images = {}
    for (const name of ['web', 'evil', 'plain']) {
        const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, name }))
        const digest = sha(manifest)
        const img = { manifest, digest }
        const key = signedWith[name]
        if (key) {
            const payload = Buffer.from(JSON.stringify({ critical: { identity: { 'docker-reference': `ghcr.io/acme/${name}` }, image: { 'docker-manifest-digest': digest }, type: 'cosign container image signature' }, optional: null }))
            img.payload = payload
            img.sig = Buffer.from(JSON.stringify({ schemaVersion: 2, layers: [{ mediaType: 'application/vnd.dev.cosign.simplesigning.v1+json', digest: sha(payload), size: payload.length, annotations: { 'dev.cosignproject.cosign/signature': crypto.sign('sha256', payload, key.privateKey).toString('base64') } }] }))
        }
        images[name] = img
    }
    const fetchImpl = async (url, o = {}) => {
        const u = new URL(url); seen.push({ url, auth: o.headers?.Authorization || null })
        if (u.host === 'ghcr.io' && u.pathname === '/token') return Response.json({ token: 'tok-1' })
        if (u.host === 'cdn.example.com') { const name = u.searchParams.get('n'); return new Response(images[name].payload) }
        if (u.host !== 'ghcr.io') return new Response('', { status: 404 })
        if (o.headers?.Authorization !== 'Bearer tok-1') return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/web:pull"' } })
        const m = /^\/v2\/acme\/([a-z]+)\/(manifests|blobs)\/(.+)$/.exec(u.pathname)
        const img = m && images[m[1]]
        if (!img) return new Response('', { status: 404 })
        if (m[2] === 'manifests' && m[3] === '1.0') return new Response(img.manifest, { headers: { 'docker-content-digest': img.digest } })
        if (m[2] === 'manifests' && m[3] === `${img.digest.replace(':', '-')}.sig`) return img.sig ? new Response(img.sig) : new Response('', { status: 404 })
        if (m[2] === 'blobs') return new Response('', { status: 307, headers: { location: `https://cdn.example.com/blob?n=${m[1]}` } })
        return new Response('', { status: 404 })
    }
    return { fetchImpl, seen, images }
}

describe('#11 image signature gate (cosign)', () => {
    test('image references and public keys', () => {
        assert.deepEqual(sg.parseImage('nginx'), { registry: 'docker.io', apiHost: 'registry-1.docker.io', repo: 'library/nginx', tag: 'latest', digest: null })
        assert.deepEqual(sg.parseImage('ghcr.io/acme/web:1.0'), { registry: 'ghcr.io', apiHost: 'ghcr.io', repo: 'acme/web', tag: '1.0', digest: null })
        assert.equal(sg.parseImage(`registry.local:5000/a/b@sha256:${'a'.repeat(64)}`).digest, `sha256:${'a'.repeat(64)}`)
        assert.equal(sg.parseImage('docker.io/library/redis:7').repo, 'library/redis')
        for (const r of ['', 'a b', 'ghcr.io/Acme/x', `x@sha256:short`]) assert.throws(() => sg.parseImage(r), (e) => e.status === 400, r)
        const k = sg.cleanPublicKey(pub(trusted))
        assert.equal(k.type, 'ec'); assert.equal(k.fingerprint.length, 16)
        assert.throws(() => sg.cleanPublicKey('hello'), /PEM public key/)
        assert.throws(() => sg.cleanPublicKey('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----'), /not a valid public key/)
    })
    test('verify: signed with a trusted key / another key / not signed — token auth, CDN redirect without credentials', async () => {
        sg._test.reset()
        const reg = registry()
        const keys = [{ name: 'release', pem: pub(trusted) }]
        const ok = await sg.verifyImage('ghcr.io/acme/web:1.0', keys, { fetchImpl: reg.fetchImpl })
        assert.equal(ok.status, 'signed', JSON.stringify(ok)); assert.equal(ok.key, 'release'); assert.equal(ok.digest, reg.images.web.digest)
        assert.ok(reg.seen.some(s => s.url.startsWith('https://ghcr.io/token?') && /scope=repository%3Aacme%2Fweb%3Apull/.test(s.url)))
        assert.ok(reg.seen.filter(s => s.url.startsWith('https://cdn.example.com')).every(s => s.auth === null), 'no credentials to the CDN')
        assert.equal((await sg.verifyImage('ghcr.io/acme/evil:1.0', keys, { fetchImpl: reg.fetchImpl })).status, 'invalid')
        assert.equal((await sg.verifyImage('ghcr.io/acme/plain:1.0', keys, { fetchImpl: reg.fetchImpl })).status, 'unsigned')
        assert.equal((await sg.verifyImage('ghcr.io/acme/nope:1.0', keys, { fetchImpl: reg.fetchImpl })).status, 'error')
        // a payload that names another digest is not a signature of this image
        const swap = registry()
        swap.images.web.payload = swap.images.evil.payload
        assert.notEqual((await sg.verifyImage('ghcr.io/acme/web:1.0', [{ name: 'k', pem: pub(other) }], { fetchImpl: swap.fetchImpl })).status, 'signed')
    })
    test('checkSignatures: warn / block; no keys = nothing trusted', async () => {
        const reg = registry()
        const keys = [{ name: 'release', pem: pub(trusted) }]
        const b = await sg.checkSignatures(['ghcr.io/acme/web:1.0', 'ghcr.io/acme/plain:1.0'], { mode: 'block' }, { keys, fetchImpl: reg.fetchImpl })
        assert.equal(b.blocked, true); assert.deepEqual(b.signed, [{ image: 'ghcr.io/acme/web:1.0', key: 'release' }]); assert.equal(b.failing[0].status, 'unsigned')
        assert.match(sg.signText(b), /ghcr\.io\/acme\/plain:1\.0 \(unsigned\)/)
        assert.equal((await sg.checkSignatures(['ghcr.io/acme/plain:1.0'], { mode: 'warn' }, { keys, fetchImpl: reg.fetchImpl })).blocked, false)
        const none = await sg.checkSignatures(['ghcr.io/acme/web:1.0'], { mode: 'block' }, { keys: [] })
        assert.equal(none.blocked, true); assert.match(none.failing[0].message, /no signing keys/)
    })
    test('SaaS: a registry on a private address is refused', async () => {
        process.env.KUBEEZ_MODE = 'saas'
        try { const r = await sg.verifyImage('10.0.0.5:5000/acme/web:1', [{ name: 'k', pem: pub(trusted) }], { fetchImpl: async () => new Response('') }); assert.equal(r.status, 'error'); assert.match(r.message, /private|internal/i) } finally { process.env.KUBEEZ_MODE = 'selfhosted' }
    })
    test('environments keep a signature policy; signing keys per workspace, no duplicates', () => {
        const env = deliveryStore.saveEnvironment('org-k', { name: 'prod', clusterId: 'c', namespace: 'shop', signPolicy: { mode: 'block' } }, { clusterIds: ['c'] })
        assert.deepEqual(env.signPolicy, { mode: 'block' })
        assert.equal(deliveryStore.saveEnvironment('org-k', { ...env, signPolicy: { mode: 'off' } }, { clusterIds: ['c'] }).signPolicy, null)
        assert.throws(() => deliveryStore.saveEnvironment('org-k', { ...env, signPolicy: { mode: 'maybe' } }, { clusterIds: ['c'] }), /Signature policy/)
        const k = deliveryStore.saveSigningKey('org-k', { name: 'Release', key: sg.cleanPublicKey(pub(trusted)) })
        assert.equal(k.name, 'release')
        assert.throws(() => deliveryStore.saveSigningKey('org-k', { name: 'again', key: sg.cleanPublicKey(pub(trusted)) }), /already trusted/)
    })
})

// a fake control-plane: helm values / list / history / dry run / drift
const MANIFEST = 'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web, namespace: shop }\nspec: { template: { spec: { containers: [{ name: web, image: "ghcr.io/acme/web:1.0" }, { name: side, image: "ghcr.io/acme/plain:1.0" }] } } }\n'
const DIFF = `diff -u -N /tmp/LIVE-1/apps.v1.Deployment.shop.web /tmp/MERGED-1/apps.v1.Deployment.shop.web
--- /tmp/LIVE-1/apps.v1.Deployment.shop.web	2026-11-02 10:00:00
+++ /tmp/MERGED-1/apps.v1.Deployment.shop.web	2026-11-02 10:00:00
@@ -6,7 +6,7 @@
-  generation: 4
+  generation: 5
 spec:
-  replicas: 5
+  replicas: 2
       containers:
-      - image: ghcr.io/acme/web:hotfix
+      - image: ghcr.io/acme/web:1.0
diff -u -N /tmp/LIVE-1/v1.Service.shop.web /tmp/MERGED-1/v1.Service.shop.web
--- /tmp/LIVE-1/v1.Service.shop.web	2026-11-02 10:00:00
+++ /tmp/MERGED-1/v1.Service.shop.web	2026-11-02 10:00:00
@@ -0,0 +1,3 @@
+apiVersion: v1
+kind: Service
+metadata:
diff -u -N /tmp/LIVE-1/networking.k8s.io.v1.Ingress.shop.web.example /tmp/MERGED-1/networking.k8s.io.v1.Ingress.shop.web.example
--- a
+++ b
@@ -1,2 +1,2 @@
-  generation: 1
+  generation: 2
`
const helmFake = ({ driftOut } = {}) => {
    const calls = []
    const connect = async () => ({
        execCommand: async (cmd, o = {}) => {
            calls.push({ cmd, stdin: o.stdin ?? null })
            if (/==H==/.test(cmd)) return { code: 0, stdout: `==H==\n${JSON.stringify([{ revision: 3, status: 'failed', chart: 'web-1.4.0', updated: new Date(Date.now() - 86400e3).toISOString(), description: 'Upgrade failed' }, { revision: 4, status: 'deployed', chart: 'web-1.4.0', updated: new Date().toISOString() }])}\n==V==\n{}` }
            if (/HELM get values/.test(cmd)) return { code: 0, stdout: JSON.stringify({ image: { tag: '1.0' } }) }
            if (/HELM list/.test(cmd)) return { code: 0, stdout: JSON.stringify([{ name: 'web', namespace: 'shop', revision: '4', status: 'deployed', chart: 'web-1.4.0' }, { name: 'api', namespace: 'team-a', revision: '1', status: 'deployed', chart: 'api-0.1.0' }]) }
            if (/KZDRIFT/.test(cmd)) return { code: 0, stdout: driftOut ?? `==KZDRIFT:shop/web==\n==KZSCALED==\nDeployment/other\n==KZDIFF==\n${DIFF}\n==KZRC:1==\n==KZDRIFT:team-a/api==\n==KZSCALED==\n==KZDIFF==\n\n==KZRC:0==\n==KZDRIFT_END==` }
            if (/==CUR==/.test(cmd)) return { code: 0, stdout: `==CUR==\nkind: Service\nmetadata: { name: old, namespace: shop }\n==NEW==\n${JSON.stringify({ manifest: MANIFEST, chart: { metadata: { name: 'web', version: '2.0.0' } } })}` }
            if (/--dry-run=server/.test(cmd)) return { code: 0, stdout: JSON.stringify({ manifest: MANIFEST }) }
            return { code: 0, stdout: '{}' }
        },
        dispose() { }
    })
    return { calls, connect }
}

describe('#11 the gate inside a deploy', () => {
    const cluster = { id: 's1', orgId: 'org-s' }
    const d = () => helm.cleanDeploy({ release: 'web', namespace: 'shop', chart: 'web' }, { id: 'r', name: 'acme', url: 'https://charts.acme.io' })
    test('block: nothing is upgraded; an admin override deploys with a warning; preview shows it', async () => {
        const f = helmFake()
        const reg = registry()
        const sign = (override = null) => ({ policy: { mode: 'block' }, override, keys: [{ name: 'release', pem: pub(trusted) }], fetchImpl: reg.fetchImpl })
        const j = await helm.deploy(cluster, d(), { connect: f.connect, sign: sign() })
        await helm._test.jobs.get(j.id).promise
        assert.equal(helm.findJob(j.id).status, 'failed'); assert.match(helm.findJob(j.id).error, /image signature policy.*plain:1\.0 \(unsigned\)/)
        assert.equal(f.calls.some(c => /--wait/.test(c.cmd)), false, 'no upgrade ran')
        const o = await helm.deploy(cluster, d(), { connect: f.connect, sign: sign('hotfix') })
        await helm._test.jobs.get(o.id).promise
        const v = helm.jobView(helm.findJob(o.id))
        assert.equal(v.status, 'done'); assert.match(v.warnings[0], /Signature policy overridden/); assert.equal(v.signatures.signed.length, 1)
        const p = await helm.previewDeploy(cluster, d(), { connect: f.connect, sign: sign() })
        assert.equal(p.signatures.blocked, true); assert.equal('manifest' in p, false)
    })
})

describe('#12 deploy risk', () => {
    const preview = (o = {}) => ({ install: false, chart: 'web-2.0.0', changes: [], unchanged: 3, ...o })
    test('a small image bump in dev is low; removing data in protected prod with failures is high', () => {
        const low = risk.scoreRisk({ preview: preview({ changes: [{ action: 'change', kind: 'Deployment', name: 'web', diff: ['-   image: a:1', '+   image: a:2'] }] }), current: { version: '1.4.0' }, toVersion: '1.5.0', env: { name: 'dev' } })
        assert.equal(low.level, 'low'); assert.deepEqual(low.factors.map(f => f.key), ['image'])
        const high = risk.scoreRisk({
            preview: preview({ changes: [{ action: 'remove', kind: 'PersistentVolumeClaim', name: 'data' }, { action: 'change', kind: 'Service', name: 'web', diff: ['+  port: 81'] }, { action: 'change', kind: 'Deployment', name: 'web', diff: ['+  replicas: 0'] }], cve: { blocked: true, failing: [{ image: 'x' }] } }),
            current: { version: '1.4.0' }, toVersion: '2.0.0', env: { name: 'prod', protected: true },
            history: [{ status: 'failed', updated: new Date().toISOString() }], incidents: [{ reason: 'CrashLoopBackOff' }]
        })
        assert.equal(high.level, 'high'); assert.equal(high.score, 100)
        for (const k of ['removeData', 'cveBlocked', 'majorBump', 'protectedEnv', 'scaleToZero', 'network', 'failedBefore', 'incidents']) assert.ok(high.factors.some(f => f.key === k), k)
        assert.equal(risk.scoreRisk({ preview: preview(), env: { name: 'prod-eu' } }).factors[0].key, 'prodName')
    })
    test('the AI explains from the facts; its answer is checked', async () => {
        const facts = risk.riskFacts({ release: 'web', namespace: 'shop', cluster: { clusterName: 'prod' }, preview: preview({ changes: [{ action: 'remove', kind: 'Service', name: 'old' }] }), current: { chart: 'web', version: '1.4.0' }, toVersion: '2.0.0', env: null, history: [], incidents: [], risk: { score: 35, level: 'medium', factors: [{ points: 20, label: 'Removes 1 resource' }] } })
        assert.match(facts.find(f => f.label === 'KubeEZ risk score').text, /35\/100 \(medium\)\n\+20 Removes 1 resource/)
        let asked
        const ask = async (u, o) => { asked = o; assert.equal(o.validate({ level: 'x' }), 'level must be low, medium or high'); return { json: { level: 'high', summary: 'Removes the old Service.', risks: ['Clients of old break'], checks: ['grep for old'], rollback: 'helm rollback web 4' }, provider: 'fake', model: 'm' } }
        const r = await risk.explainRisk({ orgId: 'o' }, facts, { ask })
        assert.equal(r.level, 'high'); assert.deepEqual(r.engine, { provider: 'fake', model: 'm' }); assert.equal(asked.json, true); assert.equal(asked.task, 'explain')
    })
})

describe('#13 Helm drift', () => {
    test('kubectl diff → only real changes: generation ignored, a deleted Service is "missing", file names parsed', () => {
        assert.deepEqual(drift.resourceOf('/tmp/LIVE-1/networking.k8s.io.v1.Ingress.shop.web.example'), { kind: 'Ingress', namespace: 'shop', name: 'web.example' })
        assert.deepEqual(drift.resourceOf('rbac.authorization.k8s.io.v1.ClusterRole.reader'), { kind: 'ClusterRole', namespace: null, name: 'reader' })
        const r = drift.parseDiff(DIFF)
        assert.deepEqual(r.map(x => `${x.kind}/${x.name}:${x.missing}`), ['Deployment/web:false', 'Service/web:true'], 'the Ingress only changed its generation')
        assert.deepEqual(r[0].lines, ['-  replicas: 5', '+  replicas: 2', '-      - image: ghcr.io/acme/web:hotfix', '+      - image: ghcr.io/acme/web:1.0'])
        // an autoscaled workload: replicas are not drift
        assert.deepEqual(drift.parseDiff(DIFF, new Set(['Deployment/web']))[0].lines, ['-      - image: ghcr.io/acme/web:hotfix', '+      - image: ghcr.io/acme/web:1.0'])
    })
    test('the script quotes names, is valid shell and needs nothing installed beyond kubectl', { skip: !bash }, () => {
        const s = drift.driftScript([{ namespace: 'shop', name: 'web' }])
        assert.match(s, /HELM get manifest 'web' -n 'shop'/); assert.match(s, /kubectl diff --server-side --force-conflicts --field-manager=kubeez-drift -n 'shop'/)
        assert.equal(spawnSync(bash, ['-n', '-c', `${helm._test.PRELUDE}\n${s}`]).status, 0)
        assert.throws(() => drift.driftScript([{ namespace: 'a;b', name: 'x' }]), (e) => e.status === 400)
    })
    test('checkDrift and the hourly alert (once per drift, again when it changes)', async () => {
        const f = helmFake()
        const r = await drift.checkDrift({ id: 's1' }, [{ namespace: 'shop', name: 'web' }, { namespace: 'team-a', name: 'api' }], { connect: f.connect })
        assert.deepEqual(r.map(x => `${x.namespace}/${x.release}:${x.drifted}`), ['shop/web:true', 'team-a/api:false'])
        const err = await drift.checkDrift({ id: 's1' }, [{ namespace: 'shop', name: 'web' }], { connect: helmFake({ driftOut: `==KZDRIFT:shop/web==\n==KZERR==\nError: release: not found\n==KZDRIFT_END==` }).connect })
        assert.match(err[0].error, /release: not found/)
        drift._test.reset()
        const sent = []
        let out = r
        const deps = { usable: () => true, list: async () => [{ namespace: 'shop', name: 'web' }], check: async () => out, notify: (c, ev) => sent.push(ev) }
        await drift.alertCluster({ id: 's1', clusterName: 'prod', orgId: 'org-s' }, deps)
        await drift.alertCluster({ id: 's1', clusterName: 'prod', orgId: 'org-s' }, deps)
        assert.equal(sent.length, 1); assert.match(sent[0].title, /Helm drift on prod: shop\/web/); assert.match(sent[0].text, /Service web \(deleted\)/)
        out = [{ ...r[0], resources: [r[0].resources[1]] }]
        await drift.alertCluster({ id: 's1', clusterName: 'prod', orgId: 'org-s' }, deps)
        assert.equal(sent.length, 2, 'the drift changed')
    })
})

describe('#14 cert-manager', () => {
    const NOW = Date.parse('2026-11-02T12:00:00Z')
    const cert = (name, o = {}) => ({ metadata: { name, namespace: o.ns || 'shop' }, spec: { secretName: `${name}-tls`, dnsNames: [`${name}.example.com`], issuerRef: { name: 'letsencrypt', kind: 'ClusterIssuer' } }, status: { conditions: o.conds || [{ type: 'Ready', status: 'True' }], notAfter: o.notAfter, renewalTime: o.renewal } })
    const day = (n) => new Date(NOW + n * 86400e3).toISOString()
    const OUT = `==KZCERT:CERT==\n${JSON.stringify({ items: [
        cert('ok', { notAfter: day(60) }), cert('soon', { notAfter: day(5) }), cert('gone', { notAfter: day(-1) }),
        cert('broken', { conds: [{ type: 'Ready', status: 'False', reason: 'Failed', message: 'ACME order failed' }] }),
        cert('busy', { ns: 'team-a', notAfter: day(30), conds: [{ type: 'Ready', status: 'True' }, { type: 'Issuing', status: 'True', reason: 'Renewing', message: 'Renewing certificate' }] })
    ] })}\n==KZCERT:ISSUER_ERR==\nerror: the server doesn't have a resource type "issuers"\n==KZCERT:CISSUER==\n${JSON.stringify({ items: [{ metadata: { name: 'letsencrypt' }, spec: { acme: { server: 'https://acme-v02.api.letsencrypt.org/directory', email: 'a@b.c' } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] })}\n==KZCERT:CHAL==\n${JSON.stringify({ items: [{ metadata: { name: 'c1', namespace: 'shop' }, spec: { dnsName: 'broken.example.com', type: 'HTTP-01' }, status: { state: 'pending', reason: 'Waiting for HTTP-01 challenge propagation' } }, { metadata: { name: 'c2', namespace: 'shop' }, spec: {}, status: { state: 'valid' } }] })}\n==KZCERT:END==`

    test('states: expired, failing, expiring (<14 days), issuing, ok — worst first; issuers; stuck challenges only', () => {
        const r = cm.parseCerts(OUT, NOW)
        assert.deepEqual(r.certificates.map(c => `${c.name}:${c.state}`), ['gone:expired', 'broken:failing', 'soon:expiring', 'busy:issuing', 'ok:ok'])
        assert.equal(r.certificates.find(c => c.name === 'soon').daysLeft, 5)
        assert.equal(r.certificates.find(c => c.name === 'broken').message, 'ACME order failed')
        assert.deepEqual(r.issuers.map(i => `${i.kind}/${i.name}:${i.type}:${i.ready}`), ['ClusterIssuer/letsencrypt:acme:true'])
        assert.equal(JSON.stringify(r).includes('a@b.c'), false, 'no ACME e-mail')
        assert.deepEqual(r.challenges.map(c => c.name), ['c1'])
        assert.deepEqual(cm.summarizeCerts(r), { total: 5, ok: 1, expiring: 1, expired: 1, failing: 1, issuing: 1, challenges: 1, issuersNotReady: 0 })
        assert.equal(cm.limitCerts(r, (ns) => ns === 'team-a').certificates.length, 1)
        assert.equal(cm.parseCerts(`==KZCERT:CERT_ERR==\nerror: the server doesn't have a resource type "certificates"\n==KZCERT:END==`).tool.state, 'missing')
    })
    test('renew: an Issuing condition on the status subresource; names quoted', () => {
        const c = cm.renewCommand('shop', 'web', { by: 'ops;rm', now: new Date('2026-11-02T12:00:00.123Z') })
        assert.match(c, /patch -n 'shop' certificates\.cert-manager\.io 'web' --subresource=status --type=json/)
        assert.match(c, /"reason":"ManuallyTriggered"/); assert.match(c, /by opsrm/); assert.match(c, /"lastTransitionTime":"2026-11-02T12:00:00Z"/)
        assert.throws(() => cm.renewCommand('shop', 'a b'), (e) => e.status === 400)
    })
    test('alerts: once per state and expiry step (14, 7, 3, 1 days)', async () => {
        cm._test.reset()
        const sent = []
        let out = cm.parseCerts(OUT, NOW)
        const deps = { usable: () => true, read: async () => out, notify: (c, ev) => sent.push(ev) }
        const c = { id: 's1', clusterName: 'prod', orgId: 'org-s' }
        await cm.alertCluster(c, deps); await cm.alertCluster(c, deps)
        assert.equal(sent.length, 1); assert.equal(sent[0].severity, 'critical'); assert.match(sent[0].text, /shop\/soon .*expires in 5 days/); assert.match(sent[0].text, /EXPIRED/)
        out = cm.parseCerts(OUT, NOW + 3 * 86400e3)   // soon: 2 days left → a new step
        await cm.alertCluster(c, deps)
        assert.equal(sent.length, 2); assert.match(sent[1].text, /soon/); assert.doesNotMatch(sent[1].text, /broken/)
    })
})

describe('API: signing keys, risk, drift, certificates — who may do what', () => {
    let base, server, repoId
    const U = {
        admin: { id: 's-admin', username: 'sadmin', orgId: 'org-s', role: 'admin' },
        operator: { id: 's-op', username: 'sop', orgId: 'org-s', role: 'operator' },
        viewer: { id: 's-view', username: 'sview', orgId: 'org-s', role: 'viewer' },
        scoped: { id: 's-sc', username: 'ssc', orgId: 'org-s', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 's1', role: 'operator', namespaces: ['team-a'] }] }
    }
    const call = async (who, method, p, body) => {
        const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined })
        return { status: r.status, data: await r.json().catch(() => null) }
    }
    const f = helmFake()
    const kube = []

    before(async () => {
        const express = (await import('express')).default
        const { default: delivery } = await import('../src/routes/delivery.js')
        const { default: apps } = await import('../src/routes/helmApps.js')
        const { default: certs } = await import('../src/routes/certificates.js')
        const { auditTrail } = await import('../src/services/auditLog.js')
        helm._test.useConnect(f.connect)
        cm._test.useConnect(async () => ({ execCommand: async (cmd) => { kube.push(cmd); if (/KZCERT/.test(cmd)) return { stdout: `==KZCERT:CERT==\n${JSON.stringify({ items: [{ metadata: { name: 'web', namespace: 'shop' }, spec: { dnsNames: ['web.example.com'] }, status: { conditions: [{ type: 'Ready', status: 'True' }], notAfter: new Date(Date.now() + 40 * 86400e3).toISOString() } }, { metadata: { name: 'api', namespace: 'team-a' }, spec: {}, status: {} }] })}\n==KZCERT:ISSUER==\n{"items":[]}\n==KZCERT:CISSUER==\n{"items":[]}\n==KZCERT:CHAL==\n{"items":[]}\n==KZCERT:END==` }; return { code: 0, stdout: 'patched' } }, dispose() { } }))
        repoId = deliveryStore.saveRepo('org-s', { name: 'acme', url: 'https://charts.acme.io' }).id
        deliveryStore.saveEnvironment('org-s', { name: 'prod', clusterId: 's1', namespace: 'shop', protected: true }, { clusterIds: ['s1'] })
        const app = express()
        app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use(auditTrail)
        app.use('/api/delivery', delivery)
        app.use('/api/clusters', apps)
        app.use('/api/clusters', certs)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('signing keys: admins add (checked), everyone sees fingerprints', async () => {
        assert.equal((await call('operator', 'POST', '/api/delivery/signing-keys', { name: 'release', publicKey: pub(trusted) })).status, 403)
        assert.equal((await call('admin', 'POST', '/api/delivery/signing-keys', { name: 'release', publicKey: 'nope' })).status, 400)
        const k = await call('admin', 'POST', '/api/delivery/signing-keys', { name: 'release', publicKey: pub(trusted) })
        assert.equal(k.status, 200, JSON.stringify(k.data))
        const l = await call('viewer', 'GET', '/api/delivery/signing-keys')
        assert.equal(l.data.keys.length, 1); assert.equal(l.data.canManage, false)
        assert.equal((await call('admin', 'DELETE', `/api/delivery/signing-keys/${k.data.id}`)).status, 200)
    })

    test('deploy risk: needs deploy + values; the score comes without AI rights; viewers refused', async () => {
        const body = { release: 'web', namespace: 'shop', chart: 'web', version: '2.0.0', repoId }
        assert.equal((await call('viewer', 'POST', '/api/clusters/s1/apps/risk', body)).status, 403)
        assert.equal((await call('scoped', 'POST', '/api/clusters/s1/apps/risk', body)).status, 403)
        const r = await call('operator', 'POST', '/api/clusters/s1/apps/risk', body)
        assert.equal(r.status, 200, JSON.stringify(r.data))
        assert.equal(r.data.risk.level, 'high')
        for (const k of ['protectedEnv', 'majorBump', 'remove', 'failedBefore']) assert.ok(r.data.risk.factors.some(x => x.key === k), k)
        assert.match(r.data.ai.unavailable, /may not ask KubeEZ AI/)
        const a = await call('admin', 'POST', '/api/clusters/s1/apps/risk', body)
        assert.equal(a.status, 200); assert.ok(a.data.ai.unavailable, 'no AI connected in the test: said so, score still there'); assert.equal(a.data.risk.level, 'high')
    })

    test('drift: everyone with app:view; limited members only their namespaces; one release on its own', async () => {
        const all = await call('viewer', 'GET', '/api/clusters/s1/apps/drift')
        assert.equal(all.status, 200, JSON.stringify(all.data)); assert.equal(all.data.drifted, 1); assert.equal(all.data.checked, 2)
        const sc = await call('scoped', 'GET', '/api/clusters/s1/apps/drift')
        assert.deepEqual(sc.data.releases.map(r => r.release), ['api'])
        const one = await call('viewer', 'GET', '/api/clusters/s1/apps/shop/web/drift')
        assert.equal(one.data.drifted, true); assert.equal(one.data.resources[0].kind, 'Deployment')
        assert.equal((await call('scoped', 'GET', '/api/clusters/s1/apps/shop/web/drift')).status, 404)
        assert.equal((await call('viewer', 'GET', '/api/clusters/s1/apps/shop/x;y/drift')).status, 400)
    })

    test('certificates: viewers read, operators renew; limited members only their namespaces; read-only clusters refuse', async () => {
        const v = await call('viewer', 'GET', '/api/clusters/s1/certificates')
        assert.equal(v.status, 200, JSON.stringify(v.data)); assert.equal(v.data.certificates.length, 2); assert.equal(v.data.canRenew, false)
        assert.equal((await call('scoped', 'GET', '/api/clusters/s1/certificates')).data.certificates.length, 1)
        assert.equal((await call('viewer', 'POST', '/api/clusters/s1/certificates/renew', { namespace: 'shop', name: 'web' })).status, 403)
        assert.equal((await call('operator', 'POST', '/api/clusters/s1/certificates/renew', { namespace: 'shop', name: 'a b' })).status, 400)
        assert.equal((await call('operator', 'POST', '/api/clusters/s1/certificates/renew', { namespace: 'shop', name: 'ghost' })).status, 404)
        const r = await call('operator', 'POST', '/api/clusters/s1/certificates/renew', { namespace: 'shop', name: 'web' })
        assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(kube.some(c => /patch -n 'shop' certificates\.cert-manager\.io 'web' --subresource=status/.test(c)))
        assert.equal((await call('admin', 'POST', '/api/clusters/s-ro/certificates/renew', { namespace: 'shop', name: 'web' })).status, 409)
    })

    test('features off: 403 on each', async () => {
        const { features } = await import('../src/services/features.js')
        features.setWorkspace('org-s', { certManager: false, helmDrift: false, deployRisk: false, signGate: false })
        try {
            assert.equal((await call('admin', 'GET', '/api/clusters/s1/certificates')).status, 403)
            assert.equal((await call('admin', 'GET', '/api/clusters/s1/apps/drift')).status, 403)
            assert.equal((await call('admin', 'POST', '/api/clusters/s1/apps/risk', {})).status, 403)
            assert.equal((await call('admin', 'GET', '/api/delivery/signing-keys')).status, 403)
        } finally { features.setWorkspace('org-s', { certManager: true, helmDrift: true, deployRisk: true, signGate: true }) }
    })
})
