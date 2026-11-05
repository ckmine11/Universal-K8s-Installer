// GitLab / Bitbucket promotions, Flux apps KubeEZ creates, deploy from chat
// (Slack / Telegram) and preview environments — the services and the API gates
// for every role (in-process, fake clusters and fake Git providers).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir, paidOrgs } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
paidOrgs(DATA, ['org-n'])
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 'n1', clusterName: 'prod', orgId: 'org-n', ownerId: 'n-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.90', username: 'root', password: 'x' }], workerNodes: [] },
    { id: 'n-ro', clusterName: 'ro', orgId: 'org-n', ownerId: 'n-admin', k8sVersion: '1.34.0', imported: true, access: { mode: 'direct', level: 'read', server: 'https://203.0.113.11', token: 'x' }, masterNodes: [], workerNodes: [] }
]))

const gp = await import('../src/services/gitPromote.js')
const gitops = await import('../src/services/gitops.js')
const helm = await import('../src/services/helmApps.js')
const pv = await import('../src/services/previews.js')
const cd = await import('../src/services/chatDeploy.js')
const { deliveryStore } = await import('../src/services/deliveryStore.js')
const { notificationStore } = await import('../src/services/notificationStore.js')
after(() => { helm._test.useConnect(null); gitops._test.useConnect(null); pv._test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const FILE = '# prod values\nimage:\n  repository: acme/web\n  tag: "1.4.1"  # bumped by CI\n'

describe('#7 promotions on GitLab and Bitbucket', () => {
    test('names: GitLab sub-groups allowed, GitHub / Bitbucket owner/name only', () => {
        const b = { repo: 'acme/platform/deploy', path: 'apps/web/prod.yaml', set: { 'image.tag': '2' } }
        assert.equal(gp.cleanPromotion(b, 'gitlab').repo, 'acme/platform/deploy')
        assert.throws(() => gp.cleanPromotion(b, 'github'), /owner\/name/)
        assert.throws(() => gp.cleanPromotion(b, 'bitbucket'), /workspace\/name/)
        assert.throws(() => gp.cleanPromotion({ ...b, repo: 'acme/../x' }, 'gitlab'), (e) => e.status === 400)
    })

    test('Git accounts: provider, default API address, Bitbucket user name; token never sent back', () => {
        const gl = deliveryStore.saveGitAccount('org-g', { name: 'gitlab', provider: 'gitlab', token: 'glpat-xxxxxxxxxxxxxxxxxxxx' })
        assert.equal(gl.provider, 'gitlab'); assert.equal(gl.apiUrl, 'https://gitlab.com/api/v4')
        const bb = deliveryStore.saveGitAccount('org-g', { name: 'bb', provider: 'bitbucket', username: 'opsy', token: 'app-password-xxxxxxxxxxxx' })
        assert.equal(bb.username, 'opsy'); assert.equal(bb.apiUrl, 'https://api.bitbucket.org/2.0')
        assert.equal(JSON.stringify(deliveryStore.gitAccounts('org-g')).includes('glpat'), false)
        assert.equal(deliveryStore.gitAccountCredentials('org-g', gl.id).token, 'glpat-xxxxxxxxxxxxxxxxxxxx')
        assert.throws(() => deliveryStore.saveGitAccount('org-g', { name: 'x', provider: 'svn', token: 'x'.repeat(30) }), /Provider/)
        assert.throws(() => deliveryStore.saveGitAccount('org-g', { name: 'y', provider: 'gitlab', token: 'short' }), /GitLab access token/)
        // older accounts without a provider are GitHub
        assert.equal(deliveryStore.saveGitAccount('org-g', { name: 'gh', token: 'ghp_xxxxxxxxxxxxxxxxxxxxxx' }).provider, 'github')
    })

    test('GitLab: file → branch → commit guarded by last_commit_id → merge request', async () => {
        const seen = []
        const fetchImpl = async (url, o) => {
            const u = new URL(url); seen.push(`${o.method} ${u.pathname}`)
            assert.equal(o.headers['PRIVATE-TOKEN'], 'glpat-x'); assert.equal(o.headers.Authorization, undefined)
            const body = o.body ? JSON.parse(o.body) : null
            if (o.method === 'GET' && /\/repository\/files\//.test(u.pathname)) {
                assert.match(url, /\/projects\/acme%2Fplatform%2Fdeploy\/repository\/files\/apps%2Fweb%2Fprod\.yaml\?ref=main/)
                return Response.json({ content: Buffer.from(FILE).toString('base64'), encoding: 'base64', last_commit_id: 'c0ffee' })
            }
            if (o.method === 'POST' && /\/repository\/branches$/.test(u.pathname)) { assert.match(u.search, /branch=kubeez%2Fpromote-.*&ref=main/); return Response.json({}) }
            if (o.method === 'PUT') { assert.equal(body.last_commit_id, 'c0ffee'); assert.match(body.content, /tag: "?1\.4\.2"?\s+# bumped by CI/); assert.match(body.branch, /^kubeez\/promote-/); return Response.json({}) }
            if (o.method === 'POST' && /\/merge_requests$/.test(u.pathname)) { assert.equal(body.target_branch, 'main'); assert.equal(body.remove_source_branch, true); assert.match(body.description, /Opened from KubeEZ by \*\*opsy\*\*/); return Response.json({ web_url: 'https://gitlab.com/acme/platform/deploy/-/merge_requests/12', iid: 12 }) }
            return new Response('{}', { status: 404 })
        }
        const p = gp.cleanPromotion({ repo: 'acme/platform/deploy', path: 'apps/web/prod.yaml', set: { 'image.tag': '1.4.2' } }, 'gitlab')
        const r = await gp.openPromotionPr({ provider: 'gitlab', apiUrl: 'https://gitlab.com/api/v4', token: 'glpat-x' }, p, { by: 'opsy', fetchImpl })
        assert.equal(r.number, 12); assert.equal(r.provider, 'gitlab'); assert.match(r.url, /merge_requests\/12/)
        assert.deepEqual(seen.map(s => s.split(' ')[0]), ['GET', 'POST', 'PUT', 'POST'])
        await assert.rejects(gp.openPromotionPr({ provider: 'gitlab', token: 't' }, p, { fetchImpl: async () => new Response(JSON.stringify({ message: '401 Unauthorized' }), { status: 401 }) }), /GitLab said 401: 401 Unauthorized — check the token/)
    })

    test('Bitbucket: base commit → raw file → branch → commit as a form → pull request; app password = Basic', async () => {
        const seen = []
        const fetchImpl = async (url, o) => {
            const u = new URL(url); seen.push(`${o.method} ${u.pathname}`)
            assert.equal(o.headers.Authorization, `Basic ${Buffer.from('opsy:app-pw').toString('base64')}`)
            if (o.method === 'GET' && /\/refs\/branches\/main$/.test(u.pathname)) return Response.json({ target: { hash: 'abc123' } })
            if (o.method === 'GET' && /\/src\/abc123\/apps\/web\/prod\.yaml$/.test(u.pathname)) return new Response(FILE)
            if (o.method === 'POST' && /\/refs\/branches$/.test(u.pathname)) { assert.equal(JSON.parse(o.body).target.hash, 'abc123'); return Response.json({}) }
            if (o.method === 'POST' && /\/src$/.test(u.pathname)) {
                assert.equal(o.headers['Content-Type'], 'application/x-www-form-urlencoded')
                const f = new URLSearchParams(o.body)
                assert.match(f.get('apps/web/prod.yaml'), /tag: "?1\.4\.2"?/); assert.equal(f.get('parents'), 'abc123'); assert.match(f.get('branch'), /^kubeez\/promote-/)
                return new Response('', { status: 201 })
            }
            if (o.method === 'POST' && /\/pullrequests$/.test(u.pathname)) { const b = JSON.parse(o.body); assert.equal(b.destination.branch.name, 'main'); return Response.json({ id: 5, links: { html: { href: 'https://bitbucket.org/acme/deploy/pull-requests/5' } } }) }
            return new Response('{}', { status: 404 })
        }
        const p = gp.cleanPromotion({ repo: 'acme/deploy', path: 'apps/web/prod.yaml', set: { 'image.tag': '1.4.2' } }, 'bitbucket')
        const r = await gp.openPromotionPr({ provider: 'bitbucket', username: 'opsy', token: 'app-pw' }, p, { fetchImpl })
        assert.equal(r.number, 5); assert.match(r.url, /pull-requests\/5/)
        assert.deepEqual(seen.map(s => s.split(' ')[0]), ['GET', 'GET', 'POST', 'POST', 'POST'])
        // nothing to change → 409 before any branch is made
        const same = gp.cleanPromotion({ repo: 'acme/deploy', path: 'apps/web/prod.yaml', set: { 'image.tag': '1.4.1' } }, 'bitbucket')
        seen.length = 0
        await assert.rejects(gp.openPromotionPr({ provider: 'bitbucket', username: 'opsy', token: 'app-pw' }, same, { fetchImpl }), (e) => e.status === 409)
        assert.equal(seen.some(s => s.startsWith('POST')), false)
    })
})

describe('#8 Flux apps KubeEZ creates', () => {
    const ok = { tool: 'flux', name: 'shop-web', repoURL: 'https://github.com/acme/deploy.git', path: 'apps/web', targetRevision: 'main', namespace: 'team-a' }
    test('revision → ref; manifests: own ServiceAccount (namespace admin), impersonated, never prune', () => {
        assert.deepEqual(gitops.fluxRef('HEAD'), { branch: 'main' })
        assert.deepEqual(gitops.fluxRef('release'), { branch: 'release' })
        assert.deepEqual(gitops.fluxRef('A'.repeat(40)), { commit: 'a'.repeat(40) })
        assert.deepEqual(gitops.fluxRef('refs/tags/v1.2.0'), { name: 'refs/tags/v1.2.0' })
        assert.equal(gitops.cleanCreateApp({ ...ok, autoSync: false }).autoSync, true, 'Flux always reconciles')
        assert.throws(() => gitops.cleanCreateApp({ ...ok, tool: 'jenkins' }), (e) => e.status === 400)
        const [sa, rb, repo, ks] = gitops.fluxAppManifests(gitops.cleanCreateApp(ok), 'opsy').items
        assert.equal(sa.metadata.name, 'kubeez-flux-shop-web'); assert.equal(sa.metadata.namespace, 'team-a')
        assert.equal(rb.kind, 'RoleBinding'); assert.deepEqual(rb.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'admin' })
        assert.deepEqual(rb.subjects, [{ kind: 'ServiceAccount', name: 'kubeez-flux-shop-web', namespace: 'team-a' }])
        assert.equal(repo.spec.url, ok.repoURL); assert.deepEqual(repo.spec.ref, { branch: 'main' })
        assert.equal(ks.spec.serviceAccountName, 'kubeez-flux-shop-web'); assert.equal(ks.spec.targetNamespace, 'team-a'); assert.equal(ks.spec.prune, false); assert.equal(ks.spec.path, './apps/web')
        assert.ok([sa, rb, repo, ks].every(o => o.metadata.labels['app.kubernetes.io/managed-by'] === 'kubeez'))
        assert.equal(gitops.fluxAppManifests(gitops.cleanCreateApp({ ...ok, path: '' })).items[3].spec.path, './')
    })
    test('create: namespace made when missing; a Kustomization or GitRepository KubeEZ did not make is not taken over', async () => {
        const calls = []
        const connect = (owner) => async () => ({ execCommand: async (cmd, o = {}) => { calls.push({ cmd, stdin: o.stdin }); if (/managed-by/.test(cmd)) return owner === null ? { code: 1, stderr: 'NotFound' } : { code: 0, stdout: owner }; return { code: 0, stdout: 'ok' } }, dispose() { } })
        const r = await gitops.createFluxApp({ id: 'c' }, gitops.cleanCreateApp(ok), { by: 'opsy', connect: connect(null) })
        assert.match(r.message, /Flux app shop-web created in team-a/)
        assert.ok(calls.some(c => /get namespace 'team-a'.*\|\| .*create namespace 'team-a'/.test(c.cmd)))
        assert.equal(JSON.parse(calls.find(c => /apply -f -/.test(c.cmd)).stdin).items.length, 4)
        await assert.rejects(gitops.createFluxApp({ id: 'c' }, gitops.cleanCreateApp(ok), { connect: connect('') }), (e) => e.status === 409 && /not created by KubeEZ/.test(e.message))
    })
    test('remove: only KubeEZ\'s; Kustomization, GitRepository, RoleBinding, ServiceAccount — what it deployed stays', async () => {
        const calls = []
        const connect = async () => ({ execCommand: async (cmd) => { calls.push(cmd); return { code: 0 } }, dispose() { } })
        await assert.rejects(gitops.deleteFluxApp({ id: 'c' }, { name: 'x', namespace: 'team-a', managed: false }, { connect }), /only the apps it created/)
        const r = await gitops.deleteFluxApp({ id: 'c' }, { name: 'shop-web', namespace: 'team-a', managed: true }, { connect })
        for (const re of [/delete kustomizations\.kustomize\.toolkit\.fluxcd\.io 'shop-web'/, /delete gitrepositories\.source\.toolkit\.fluxcd\.io 'shop-web'/, /delete rolebinding 'kubeez-flux-shop-web'/, /delete serviceaccount 'kubeez-flux-shop-web'/]) assert.match(calls[0], re)
        // by default Flux prunes what it applied first, still running as its ServiceAccount — which goes last
        assert.match(calls[0], /patch kustomizations\.kustomize\.toolkit\.fluxcd\.io 'shop-web' --type merge -p '\{"spec":\{"prune":true,"suspend":false\}\}'/)
        assert.ok(calls[0].indexOf('wait --for=delete') < calls[0].indexOf("delete serviceaccount"), 'the ServiceAccount stays until the prune is done')
        assert.match(r.message, /everything it deployed were removed/)
        const keep = await gitops.deleteFluxApp({ id: 'c' }, { name: 'shop-web', namespace: 'team-a', managed: true }, { connect, cascade: false })
        assert.equal(calls.at(-1).includes('prune'), false); assert.match(keep.message, /still running/)
    })
    test('the list marks KubeEZ\'s Kustomizations as managed (HelmReleases never)', () => {
        const out = `==KZGITOPS:ARGO_ERR==\ndoesn't have a resource type\n==KZGITOPS:KS==\n${JSON.stringify({ items: [{ metadata: { name: 'shop-web', namespace: 'team-a', labels: { 'app.kubernetes.io/managed-by': 'kubeez' } }, spec: { targetNamespace: 'team-a' }, status: {} }, { metadata: { name: 'infra', namespace: 'flux-system' }, spec: {}, status: {} }] })}\n==KZGITOPS:HR==\n${JSON.stringify({ items: [{ metadata: { name: 'h', namespace: 'team-a', labels: { 'app.kubernetes.io/managed-by': 'kubeez' } }, spec: {}, status: {} }] })}\n==KZGITOPS:GITREPO==\n{"items":[]}\n==KZGITOPS:END==`
        const r = gitops.parseGitops(out)
        assert.equal(r.tools.flux.state, 'ok'); assert.equal(r.tools.argocd.state, 'missing')
        assert.deepEqual(r.apps.map(a => `${a.kind}/${a.name}:${a.managed}`).sort(), ['HelmRelease/h:false', 'Kustomization/infra:false', 'Kustomization/shop-web:true'])
    })
})

describe('#10 preview environments', () => {
    test('keys and namespaces: PR numbers, branch slugs, length checked; TTL 1 h – 14 days; set paths checked', () => {
        assert.deepEqual(pv.previewKey({ pr: 42 }), { key: 'pr-42', label: 'PR #42' })
        assert.equal(pv.previewKey({ branch: 'refs/heads/Feature/Login_Page!!' }).key, 'feature-login-page')
        assert.equal(pv.previewNamespace('web', 'pr-42'), 'web-pr-42')
        for (const b of [{ pr: 0 }, { pr: 'x' }, {}, { branch: '!!!' }]) assert.throws(() => pv.previewKey(b), (e) => e.status === 400, JSON.stringify(b))
        assert.throws(() => pv.previewNamespace('a'.repeat(50), 'feature-long-branch'), /too long/)
        assert.equal(pv.cleanTtl(undefined), 72); assert.throws(() => pv.cleanTtl(0)); assert.throws(() => pv.cleanTtl(24 * 15))
        for (const s of [{ '__proto__.x': 1 }, { 'a b': 1 }, { x: { y: 1 } }, []]) assert.throws(() => pv.cleanSet(s), (e) => e.status === 400, JSON.stringify(s))
    })
    test('a namespace KubeEZ did not make for this preview is never taken over or deleted', async () => {
        const calls = []
        const connect = (label) => async () => ({ execCommand: async (cmd, o = {}) => { calls.push({ cmd, stdin: o.stdin }); if (/get namespace/.test(cmd)) return label === null ? { code: 1, stderr: 'NotFound' } : { code: 0, stdout: label }; return { code: 0 } }, dispose() { } })
        await pv.ensureNamespace({ id: 'c' }, 'web-pr-1', 'p1', { connect: connect(null) })
        const made = JSON.parse(calls.find(c => /create -f -/.test(c.cmd)).stdin)
        assert.equal(made.metadata.labels['kubeez.io/preview'], 'p1')
        await assert.rejects(pv.ensureNamespace({ id: 'c' }, 'web-pr-1', 'p1', { connect: connect('') }), (e) => e.status === 409)
        await assert.rejects(pv.deleteNamespace({ id: 'c' }, 'web-pr-1', 'p1', { connect: connect('other') }), (e) => e.status === 409)
        calls.length = 0
        assert.equal(await pv.deleteNamespace({ id: 'c' }, 'web-pr-1', 'p1', { connect: connect('p1') }), true)
        assert.ok(calls.some(c => /delete namespace 'web-pr-1' --wait=false/.test(c.cmd)))
        assert.equal(await pv.deleteNamespace({ id: 'c' }, 'web-pr-1', 'p1', { connect: connect(null) }), false, 'already gone')
    })
})

describe('#9 deploy from chat: understanding the message', () => {
    const rules = [{ id: 'r1', release: 'web', envId: 'e1', key: 'image.tag' }, { id: 'r2', release: 'api', envId: 'e2', key: 'image.tag' }]
    const envName = (r) => ({ e1: 'staging', e2: 'dev' })[r.envId]
    test('commands vs questions', () => {
        assert.deepEqual(cd.deployIntent('confirm 4821'), { kind: 'confirm', code: '4821' })
        assert.deepEqual(cd.deployIntent('/confirm 4821'), { kind: 'confirm', code: '4821' })
        assert.equal(cd.deployIntent('cancel').kind, 'cancel')
        assert.equal(cd.deployIntent('deploy list').kind, 'list')
        assert.equal(cd.deployIntent('/kubeez deploy').kind, 'list')
        assert.equal(cd.deployIntent('how to deploy nginx on kubernetes?'), null, 'a question goes to the AI')
        assert.equal(cd.deployIntent('why did the deploy fail'), null)
        assert.equal(cd.deployIntent('status'), null)
        assert.deepEqual(cd.deployIntent('deploy web 1.4.2-RC1 to staging').words, ['web', '1.4.2-RC1', 'staging'], 'the tag keeps its case')
        assert.deepEqual(cd.deployIntent('web 1.4.2 staging pe deploy karo').words, ['web', '1.4.2', 'staging'])
        assert.deepEqual(cd.deployIntent('/deploy web@v2 dev').words, ['web', 'v2', 'dev'])
    })
    test('matching an allowed app and environment', () => {
        assert.deepEqual(cd.matchDeploy(['web', '1.4.2', 'staging'], rules, envName), { rule: rules[0], tag: '1.4.2' })
        assert.match(cd.matchDeploy(['web', '1.4.2', 'dev'], rules, envName).error, /deploy list/, 'web may not go to dev')
        assert.match(cd.matchDeploy(['web', 'staging'], rules, envName).error, /Say the version once/)
        assert.match(cd.matchDeploy(['web', 'a', 'b', 'staging'], rules, envName).error, /Say the version once/)
        assert.match(cd.matchDeploy(['web', '$(rm)', 'staging'], rules, envName).error, /not a valid version/)
    })
})

// a fake control-plane: helm (values, list) and kubectl (namespaces)
const helmFake = () => {
    const calls = []
    const connect = async () => ({
        execCommand: async (cmd, o = {}) => {
            calls.push({ cmd, stdin: o.stdin ?? null })
            if (/HELM get values/.test(cmd)) return { code: 0, stdout: JSON.stringify({ image: { tag: '1.0', repository: 'acme/web' }, replicas: 2 }) }
            if (/HELM list/.test(cmd)) return { code: 0, stdout: JSON.stringify([{ name: 'web', namespace: 'stage', revision: '3', status: 'deployed', chart: 'web-1.5.0' }, { name: 'web', namespace: 'shop', revision: '9', status: 'deployed', chart: 'web-1.5.0' }]) }
            return { code: 0, stdout: '{}' }
        },
        dispose() { }
    })
    return { calls, connect }
}

describe('API: previews, chat deploy, Git providers, Flux — who may do what', () => {
    let base, server, repoId, stagingId, prodId, slackId, mailId
    const U = {
        admin: { id: 'n-admin', username: 'nadmin', orgId: 'org-n', role: 'admin' },
        operator: { id: 'n-op', username: 'nop', orgId: 'org-n', role: 'operator' },
        viewer: { id: 'n-view', username: 'nview', orgId: 'org-n', role: 'viewer' },
        scoped: { id: 'n-sc', username: 'nsc', orgId: 'org-n', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'n1', role: 'operator', namespaces: ['team-a'] }] }
    }
    const call = async (who, method, p, body, headers = {}) => {
        const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': who } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
        return { status: r.status, data: await r.json().catch(() => null) }
    }
    const f = helmFake()
    const kube = []
    const nsLabels = new Map()   // namespace → preview label (the fake cluster)
    const gitCalls = []
    const wait = async (id) => { await helm._test.jobs.get(id)?.promise }

    before(async () => {
        const express = (await import('express')).default
        const { default: hooks } = await import('../src/routes/hooks.js')
        const { default: delivery } = await import('../src/routes/delivery.js')
        const { default: gitopsRouter } = await import('../src/routes/gitops.js')
        const { auditTrail } = await import('../src/services/auditLog.js')
        helm._test.useConnect(f.connect)
        pv._test.useConnect(async () => ({
            execCommand: async (cmd, o = {}) => {
                kube.push(cmd)
                const ns = /namespace '([^']+)'/.exec(cmd)?.[1]
                if (/get namespace/.test(cmd)) return nsLabels.has(ns) ? { code: 0, stdout: nsLabels.get(ns) } : { code: 1, stderr: 'NotFound' }
                if (/create -f -/.test(cmd)) { const m = JSON.parse(o.stdin); nsLabels.set(m.metadata.name, m.metadata.labels['kubeez.io/preview']); return { code: 0 } }
                if (/delete namespace/.test(cmd)) { nsLabels.delete(ns); return { code: 0 } }
                return { code: 0 }
            },
            dispose() { }
        }))
        const FLUX_OUT = `==KZGITOPS:ARGO_ERR==\ndoesn't have a resource type\n==KZGITOPS:KS==\n${JSON.stringify({ items: [{ metadata: { name: 'mine', namespace: 'team-a', labels: { 'app.kubernetes.io/managed-by': 'kubeez' } }, spec: { targetNamespace: 'team-a' }, status: {} }, { metadata: { name: 'theirs', namespace: 'team-a' }, spec: { targetNamespace: 'team-a' }, status: {} }] })}\n==KZGITOPS:HR_ERR==\ndoesn't have a resource type\n==KZGITOPS:GITREPO==\n{"items":[]}\n==KZGITOPS:END==`
        gitops._test.useConnect(async () => ({ execCommand: async (cmd) => { gitCalls.push(cmd); if (/KZGITOPS/.test(cmd)) return { stdout: FLUX_OUT }; if (/managed-by/.test(cmd)) return { code: 1, stderr: 'NotFound' }; return { code: 0, stdout: 'ok' } }, dispose() { } }))
        repoId = deliveryStore.saveRepo('org-n', { name: 'acme', url: 'https://charts.acme.io' }).id
        stagingId = deliveryStore.saveEnvironment('org-n', { name: 'staging', clusterId: 'n1', namespace: 'stage' }, { clusterIds: ['n1'] }).id
        prodId = deliveryStore.saveEnvironment('org-n', { name: 'prod', clusterId: 'n1', namespace: 'shop', protected: true }, { clusterIds: ['n1'] }).id
        slackId = notificationStore.saveChannel('org-n', { type: 'slack', name: 'ops-slack', config: { webhookUrl: 'https://hooks.slack.com/services/x' } })
        mailId = notificationStore.saveChannel('org-n', { type: 'email', name: 'mail', config: { to: 'a@b.c' } })
        const app = express()
        app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use(auditTrail)
        app.use('/api/hooks', hooks)
        app.use('/api/delivery', delivery)
        app.use('/api/clusters', gitopsRouter)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('Git accounts list the providers; promote checks the name the provider expects', async () => {
        const g = await call('admin', 'GET', '/api/delivery/git')
        assert.deepEqual(Object.keys(g.data.providers), ['github', 'gitlab', 'bitbucket'])
        assert.equal((await call('operator', 'POST', '/api/delivery/git', { name: 'gl', provider: 'gitlab', token: 'glpat-xxxxxxxxxxxxxxxxxxxx' })).status, 403)
        const a = await call('admin', 'POST', '/api/delivery/git', { name: 'gl', provider: 'gitlab', token: 'glpat-xxxxxxxxxxxxxxxxxxxx' })
        assert.equal(a.status, 200); assert.equal(a.data.provider, 'gitlab')
        assert.equal((await call('operator', 'POST', '/api/delivery/promote', { accountId: a.data.id, repo: 'acme', path: 'a.yaml', set: { x: 1 } })).status, 400)
    })

    test('Flux through the API: create in a namespace the member may use; remove only KubeEZ\'s Kustomizations', async () => {
        const body = { tool: 'flux', name: 'shop-web', repoURL: 'https://github.com/acme/deploy.git', path: 'apps/web', namespace: 'team-a' }
        const list = await call('admin', 'GET', '/api/clusters/n1/gitops')
        assert.deepEqual(list.data.createTools, ['flux']); assert.equal(list.data.canCreate, true)
        assert.equal(list.data.apps.find(a => a.name === 'mine').canDelete, true); assert.equal(list.data.apps.find(a => a.name === 'theirs').canDelete, false)
        assert.equal((await call('viewer', 'POST', '/api/clusters/n1/gitops/apps', body)).status, 403)
        assert.equal((await call('operator', 'POST', '/api/clusters/n1/gitops/apps', { ...body, namespace: 'flux-system' })).status, 403, 'system namespaces: admins only')
        assert.equal((await call('scoped', 'POST', '/api/clusters/n1/gitops/apps', { ...body, namespace: 'team-b' })).status, 403)
        const c = await call('scoped', 'POST', '/api/clusters/n1/gitops/apps', body)
        assert.equal(c.status, 200, JSON.stringify(c.data)); assert.match(c.data.message, /Flux app shop-web created in team-a/)
        const argo = await call('operator', 'POST', '/api/clusters/n1/gitops/apps', { ...body, tool: 'argocd' })
        assert.equal(argo.status, 409); assert.match(argo.data.error, /Argo CD is not installed/)
        assert.equal((await call('admin', 'DELETE', '/api/clusters/n1/gitops/apps/team-a/theirs?kind=Kustomization')).status, 409)
        assert.equal((await call('admin', 'DELETE', '/api/clusters/n1/gitops/apps/team-a/mine')).status, 404, 'no Argo CD app called mine')
        const d = await call('admin', 'DELETE', '/api/clusters/n1/gitops/apps/team-a/mine?kind=Kustomization')
        assert.equal(d.status, 200, JSON.stringify(d.data)); assert.ok(gitCalls.some(x => /delete kustomizations\.kustomize\.toolkit\.fluxcd\.io 'mine'/.test(x)))
    })

    test('previews from the app: copies the base release; values rights needed; listed, then removed with the namespace', async () => {
        const body = { envId: stagingId, release: 'web', pr: 42, set: { 'image.tag': 'pr-42' }, repoId, ttlHours: 24 }
        assert.equal((await call('viewer', 'POST', '/api/delivery/previews', body)).status, 403)
        assert.equal((await call('scoped', 'POST', '/api/delivery/previews', body)).status, 403, 'a viewer outside its namespaces')
        assert.equal((await call('operator', 'POST', '/api/delivery/previews', { ...body, set: { '__proto__.x': 1 } })).status, 400)
        assert.equal((await call('operator', 'POST', '/api/delivery/previews', { ...body, release: 'nope' })).status, 404, 'not installed in staging')
        const r = await call('operator', 'POST', '/api/delivery/previews', body)
        assert.equal(r.status, 202, JSON.stringify(r.data)); await wait(r.data.job.id)
        assert.equal(r.data.preview.namespace, 'web-pr-42'); assert.equal(nsLabels.get('web-pr-42'), r.data.preview.id)
        const up = f.calls.filter(x => /upgrade --install/.test(x.cmd) && /--wait/.test(x.cmd)).at(-1)
        assert.match(up.cmd, /upgrade --install 'web' 'web' --repo 'https:\/\/charts\.acme\.io' --version '1\.5\.0' -n 'web-pr-42'/)
        assert.deepEqual(JSON.parse(up.stdin), { image: { tag: 'pr-42', repository: 'acme/web' }, replicas: 2 })
        assert.ok(Math.abs(Date.parse(r.data.preview.expiresAt) - Date.now() - 24 * 3600e3) < 60e3)
        // a second push to the same PR updates the same preview
        const again = await call('operator', 'POST', '/api/delivery/previews', { ...body, set: { 'image.tag': 'pr-42b' } })
        assert.equal(again.data.preview.id, r.data.preview.id); await wait(again.data.job.id)
        const list = await call('viewer', 'GET', '/api/delivery/previews')
        assert.equal(list.data.previews.length, 1); assert.equal(list.data.previews[0].job.status, 'done'); assert.equal(list.data.canCreate, false)
        assert.equal((await call('scoped', 'GET', '/api/delivery/previews')).data.previews.length, 0)
        assert.equal((await call('operator', 'DELETE', `/api/delivery/previews/${r.data.preview.id}`)).status, 403, 'removing needs app:delete')
        const d = await call('admin', 'DELETE', `/api/delivery/previews/${r.data.preview.id}`)
        assert.equal(d.status, 200, JSON.stringify(d.data)); assert.equal(nsLabels.has('web-pr-42'), false)
        assert.equal((await call('viewer', 'GET', '/api/delivery/previews')).data.previews.length, 0)
    })

    test('previews from CI: only a token made for previews; its allowed values; removed when the PR closes', async () => {
        const mk = async (o) => (await call('admin', 'POST', '/api/delivery/tokens', { name: `t ${Math.random().toString(36).slice(2, 7)}`, clusterId: 'n1', namespace: 'stage', release: 'web', repoId, chart: 'web', ...o })).data.token
        const hook = (token, method, body) => call(null, method, '/api/hooks/preview', body, { authorization: `Bearer ${token}` })
        const plain = await mk({})
        assert.equal((await hook(plain, 'POST', { pr: 7 })).status, 403, 'a token without previews')
        const t = await mk({ previews: true })
        assert.equal((await hook(t, 'POST', { pr: 7, set: { replicas: 9 } })).status, 403, 'only the token\'s values')
        const r = await hook(t, 'POST', { branch: 'feature/login', set: { 'image.tag': 'abc123' } })
        assert.equal(r.status, 202, JSON.stringify(r.data)); assert.equal(r.data.preview.namespace, 'web-feature-login'); await wait(r.data.job.id)
        // its job is readable with the token
        assert.equal((await call(null, 'GET', `/api/hooks/jobs/${r.data.job.id}`, null, { authorization: `Bearer ${t}` })).data.status, 'done')
        assert.equal((await call(null, 'GET', `/api/hooks/jobs/${r.data.job.id}`, null, { authorization: `Bearer ${plain}` })).status, 404)
        // a freeze stops previews too
        const fr = deliveryStore.saveFreeze('org-n', { from: new Date(Date.now() - 1000).toISOString(), until: new Date(Date.now() + 3600e3).toISOString(), reason: 'Big sale' }, { clusterIds: ['n1'] })
        try { assert.equal((await hook(t, 'POST', { pr: 8 })).status, 423) } finally { deliveryStore.removeFreeze('org-n', fr.id) }
        assert.equal((await hook(t, 'DELETE', { pr: 99 })).status, 404)
        const d = await hook(t, 'DELETE', { branch: 'feature/login' })
        assert.equal(d.status, 200, JSON.stringify(d.data)); assert.equal(nsLabels.has('web-feature-login'), false)
    })

    test('expired previews are removed by the sweeper; one that cannot be removed keeps its record with the error', async () => {
        const cluster = { id: 'n1', orgId: 'org-n', clusterName: 'prod' }
        const { preview, job } = await pv.startPreview({ orgId: 'org-n', cluster, base: { namespace: 'stage', release: 'web' }, key: 'pr-5', label: 'PR #5', set: {}, ttlHours: 1, repo: deliveryStore.repoCredentials('org-n', repoId), by: 'test' })
        await wait(job.id)
        const audits = []
        const deps = { clusterOf: async () => cluster, audit: (o, c, detail, ok) => audits.push({ detail, ok }) }
        assert.deepEqual(await pv.sweepExpired(deps, Date.now()), [], 'not expired yet')
        nsLabels.set('web-pr-5', 'someone-else')
        assert.deepEqual(await pv.sweepExpired(deps, Date.now() + 2 * 3600e3), [])
        assert.match(deliveryStore.previews('org-n').find(p => p.id === preview.id).error, /not this preview's/)
        nsLabels.set('web-pr-5', preview.id)
        assert.deepEqual(await pv.sweepExpired(deps, Date.now() + 2 * 3600e3), ['web-pr-5'])
        assert.equal(deliveryStore.previews('org-n').length, 0); assert.ok(audits.some(a => a.ok && /expired and was removed/.test(a.detail)))
    })

    test('chat deploy rules: admins only, Slack / Telegram channels, never a protected environment', async () => {
        const body = { channelId: slackId, envId: stagingId, release: 'web', repoId, allowedUsers: '@Opsy, dev2' }
        assert.equal((await call('operator', 'POST', '/api/delivery/chat-deploy', body)).status, 403)
        assert.equal((await call('admin', 'POST', '/api/delivery/chat-deploy', { ...body, channelId: mailId })).status, 400)
        const p = await call('admin', 'POST', '/api/delivery/chat-deploy', { ...body, envId: prodId })
        assert.equal(p.status, 400); assert.match(p.data.error, /protected/)
        const r = await call('admin', 'POST', '/api/delivery/chat-deploy', body)
        assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.allowedUsers, ['opsy', 'dev2']); assert.equal(r.data.key, 'image.tag')
        assert.equal((await call('admin', 'POST', '/api/delivery/chat-deploy', body)).status, 400, 'no duplicates')
        const l = await call('admin', 'GET', '/api/delivery/chat-deploy')
        assert.equal(l.data.rules.length, 1); assert.equal(l.data.rules[0].envName, 'staging'); assert.deepEqual(l.data.channels.map(c => c.name), ['ops-slack'])
    })

    test('deploy from chat: ask → confirm by the same person → deploy → result posted; freezes and strangers refused', async () => {
        cd._test.reset()
        const { handleChat } = await import('../src/services/ai/chatops.js')
        const posted = []
        const ctx = (who, text) => ({ orgId: 'org-n', channelId: slackId, chatKey: 'slack:T1:C1', who, source: 'Slack', text, later: (m) => posted.push(m) })
        assert.match((await handleChat(ctx('opsy', 'deploy list'))).reply, /web → staging \(sets image\.tag\) — only opsy, dev2/)
        assert.match((await handleChat(ctx('mallory', 'deploy web 2.0 to staging'))).reply, /mallory may not deploy web/)
        const ask = await handleChat(ctx('opsy', 'deploy web 2.0 to staging'))
        assert.match(ask.reply, /About to deploy web to staging \(prod \/ stage\): image\.tag = 2\.0/)
        const code = /confirm (\d{4})/.exec(ask.reply)[1]
        assert.match((await handleChat(ctx('dev2', `confirm ${code}`))).reply, /Only opsy, who asked/)
        assert.match((await handleChat(ctx('opsy', 'confirm 0000'))).reply, /does not match/)
        const before = f.calls.length
        const go = await handleChat(ctx('opsy', `confirm ${code}`))
        assert.match(go.reply, /Deploying web 2\.0 to staging/)
        await wait(go.jobId); await new Promise(r => setImmediate(r))
        const up = f.calls.slice(before).find(x => /upgrade --install/.test(x.cmd) && /--wait/.test(x.cmd))
        assert.match(up.cmd, /--version '1\.5\.0' -n 'stage'/, 'the chart version that runs now')
        assert.deepEqual(JSON.parse(up.stdin), { image: { tag: '2.0', repository: 'acme/web' }, replicas: 2 })
        assert.deepEqual(posted, ['✅ web 2.0 is running in staging.'])
        assert.match((await handleChat(ctx('opsy', `confirm ${code}`))).reply, /does not match/, 'a code works once')
        // cancel; a freeze refuses at once
        await handleChat(ctx('opsy', 'deploy web 2.1 to staging'))
        assert.match((await handleChat(ctx('opsy', 'cancel'))).reply, /Cancelled/)
        const fr = deliveryStore.saveFreeze('org-n', { from: new Date(Date.now() - 1000).toISOString(), until: new Date(Date.now() + 3600e3).toISOString(), reason: 'Big sale' }, { clusterIds: ['n1'] })
        try { assert.match((await handleChat(ctx('opsy', 'deploy web 2.2 to staging'))).reply, /⛔ Change freeze.*Big sale/) } finally { deliveryStore.removeFreeze('org-n', fr.id) }
        // the web chat and other channels never deploy; questions still go to the AI
        assert.doesNotMatch((await handleChat({ ...ctx('opsy', 'deploy list'), channelId: mailId })).reply, /may deploy/)
        assert.doesNotMatch((await handleChat({ ...ctx('opsy', 'deploy list'), source: 'Web' })).reply || '', /may deploy/)
        await new Promise(r => setTimeout(r, 50))
        const rows = fs.readdirSync(path.join(DATA, 'audit')).flatMap(x => fs.readFileSync(path.join(DATA, 'audit', x), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
        assert.ok(rows.some(r => r.action === 'chatops.deploy' && r.ok && r.actor?.username === 'opsy (Slack)' && /set image\.tag=2\.0/.test(r.detail)))
    })

    test('features off or not paid: chat deploy and previews answer so', async () => {
        const { features } = await import('../src/services/features.js')
        features.setWorkspace('org-n', { previews: false, chatDeploy: false })
        try {
            assert.equal((await call('admin', 'GET', '/api/delivery/previews')).status, 403)
            assert.equal((await call('admin', 'GET', '/api/delivery/chat-deploy')).status, 403)
            const r = await cd.handleDeployChat({ orgId: 'org-n', channelId: slackId, chatKey: 'k', who: 'opsy', source: 'Slack', text: 'deploy web 1 to staging' })
            assert.match(r.reply, /not available/)
        } finally { features.setWorkspace('org-n', { previews: true, chatDeploy: true }) }
    })
})
