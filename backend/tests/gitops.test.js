// GitOps view: reading Argo CD / Flux apps (parser + the real shell script
// against a stub kubectl), "Sync now" commands (no injection, no credentials),
// and the API gates — roles, custom roles, namespace limits, other
// workspaces, read-only clusters, two-person approval and the audit trail.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 'c1', clusterName: 'prod', orgId: 'org-a', ownerId: 'u-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.10', username: 'root', password: 'x' }], workerNodes: [] },
    { id: 'imp-ro', clusterName: 'eks-ro', orgId: 'org-a', ownerId: 'u-admin', k8sVersion: '1.34.0', imported: true, access: { mode: 'direct', level: 'read', server: 'https://203.0.113.5', token: 'x' }, masterNodes: [], workerNodes: [] },
    { id: 'c-other', clusterName: 'theirs', orgId: 'org-b', ownerId: 'u-b', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.20', username: 'root', password: 'x' }], workerNodes: [] }
]))

const g = await import('../src/services/gitops.js')
const { parseGitops, summarize, visibleTo, cleanRepo, shortRev, cleanSyncRequest, syncCommand, readGitops, runSync, GITOPS_SCRIPT, _test } = g
after(() => { _test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const SHA = '0123456789abcdef0123456789abcdef01234567'
const argo = (name, { dest = { server: 'https://kubernetes.default.svc', namespace: 'team-a' }, sync = 'Synced', health = 'Healthy', op = { phase: 'Succeeded', finishedAt: '2026-10-29T10:00:00Z' }, resources = [], repo = 'https://github.com/acme/deploy.git', extra = {} } = {}) => ({
    metadata: { name, namespace: 'argocd' },
    spec: { project: 'default', source: { repoURL: repo, path: `apps/${name}`, targetRevision: 'main' }, destination: dest, ...extra },
    status: { sync: { status: sync, revision: SHA }, health: { status: health }, operationState: op, resources }
})
const ARGO = [
    argo('web', { repo: 'https://bob:ghp_SECRET123@github.com/acme/deploy.git?token=abc', resources: [{ kind: 'Deployment', namespace: 'team-a', name: 'web', status: 'Synced', health: { status: 'Healthy' } }] }),
    argo('api', { sync: 'OutOfSync', health: 'Degraded', resources: [
        { kind: 'Deployment', namespace: 'team-a', name: 'api', status: 'OutOfSync', health: { status: 'Degraded', message: 'back-off restarting' } },
        { kind: 'Service', namespace: 'team-a', name: 'api', status: 'Synced', health: { status: 'Healthy' } }] }),
    argo('broken', { sync: 'OutOfSync', health: 'Missing', op: { phase: 'Failed', message: 'ComparisonError: repository not found' } }),
    argo('remote', { dest: { server: 'https://10.0.0.5:6443', namespace: 'prod' } }),
    argo('infra', { resources: [{ kind: 'ClusterRole', name: 'infra-admin', status: 'Synced' }, { kind: 'Deployment', namespace: 'team-a', name: 'x', status: 'Synced' }] }),
    argo('busy', { op: { phase: 'Running', startedAt: '2026-10-29T10:05:00Z' } })
]
const flux = (kind, name, { ns = 'flux-system', spec = {}, ready = { type: 'Ready', status: 'True', lastTransitionTime: '2026-10-29T09:00:00Z' }, conds = [], status = {} } = {}) => ({
    metadata: { name, namespace: ns }, spec, status: { conditions: [ready, ...conds].filter(Boolean), ...status }
})
const KS = [
    flux('Kustomization', 'podinfo', { spec: { targetNamespace: 'team-a', path: './kustomize', sourceRef: { kind: 'GitRepository', name: 'podinfo' } }, status: { lastAppliedRevision: `main@sha1:${SHA}`, inventory: { entries: [{ id: 'team-a_podinfo_apps_Deployment' }] } } }),
    flux('Kustomization', 'infra-ks', { spec: { path: './infra', sourceRef: { kind: 'GitRepository', name: 'podinfo' } }, ready: { type: 'Ready', status: 'False', message: 'kustomize build failed: accumulating resources' }, status: { inventory: { entries: [{ id: '_kyverno_rbac.authorization.k8s.io_ClusterRole' }, { id: 'kyverno_kyverno_apps_Deployment' }] } } }),
    flux('Kustomization', 'paused', { spec: { suspend: true, targetNamespace: 'team-b', sourceRef: { kind: 'GitRepository', name: 'podinfo' } } })
]
const HR = [flux('HelmRelease', 'redis', { ns: 'team-a', spec: { chart: { spec: { chart: 'redis', version: '18.x', sourceRef: { kind: 'HelmRepository', name: 'bitnami', namespace: 'flux-system' } } } }, ready: { type: 'Ready', status: 'Unknown', message: 'Running upgrade' }, conds: [{ type: 'Reconciling', status: 'True' }] })]
const GITREPO = [{ metadata: { name: 'podinfo', namespace: 'flux-system' }, spec: { url: 'https://user:pa55word@github.com/stefanprodan/podinfo' } }]

const output = (parts) => Object.entries(parts).map(([k, v]) => `==KZGITOPS:${k}==\n${typeof v === 'string' ? v : JSON.stringify({ items: v })}`).join('\n') + '\n==KZGITOPS:END=='
const FULL = output({ ARGO, KS, HR, GITREPO })
const byName = (apps) => Object.fromEntries(apps.map(a => [a.name, a]))

describe('reading Argo CD and Flux', () => {
    const { apps, tools } = parseGitops(FULL)
    const a = byName(apps)

    test('both tools found; every app on one list, problems first', () => {
        assert.deepEqual(tools, { argocd: { state: 'ok' }, flux: { state: 'ok' } })
        assert.equal(apps.length, ARGO.length + KS.length + HR.length)
        assert.ok(['broken', 'api', 'infra-ks'].includes(apps[0].name), `problems first, got ${apps[0].name}`)
        assert.equal(apps.at(-1).sync, 'Synced')
    })

    test('Argo CD: sync, health, revision, drift, failed operation', () => {
        assert.equal(a.web.sync, 'Synced'); assert.equal(a.web.health, 'Healthy'); assert.equal(a.web.revision, SHA.slice(0, 7))
        assert.deepEqual(a.web.targetNamespaces, ['team-a'])
        assert.equal(a.api.sync, 'OutOfSync'); assert.equal(a.api.driftCount, 1)
        assert.deepEqual(a.api.drift[0], { kind: 'Deployment', namespace: 'team-a', name: 'api', sync: 'OutOfSync', health: 'Degraded', message: 'back-off restarting' })
        assert.equal(a.broken.sync, 'Failed'); assert.match(a.broken.message, /repository not found/)
        assert.equal(a.busy.running, true)
        assert.equal(a.remote.destination.external, true); assert.equal(a.web.destination.external, false)
        assert.equal(a.infra.clusterScoped, true); assert.equal(a.web.clusterScoped, false)
    })

    test('Flux: Ready condition, suspended, reconciling, inventory namespaces, repo of the source', () => {
        assert.equal(a.podinfo.sync, 'Synced'); assert.equal(a.podinfo.revision, `main@${SHA.slice(0, 7)}`)
        assert.equal(a.podinfo.source.repo, 'https://github.com/stefanprodan/podinfo')
        assert.equal(a['infra-ks'].sync, 'Failed'); assert.equal(a['infra-ks'].health, 'Degraded')
        assert.equal(a['infra-ks'].clusterScoped, true); assert.deepEqual(a['infra-ks'].targetNamespaces, ['kyverno'])
        assert.equal(a.paused.health, 'Suspended'); assert.equal(a.paused.suspended, true)
        assert.equal(a.redis.health, 'Progressing'); assert.equal(a.redis.running, true); assert.equal(a.redis.sync, 'Unknown')
        assert.equal(a.redis.source.chart, 'redis'); assert.equal(a.redis.source.repo, 'HelmRepository/flux-system/bitnami')
        assert.deepEqual(a.redis.targetNamespaces, ['team-a'])
    })

    test('no credentials ever leave: user:password and ?token= are dropped from repo URLs', () => {
        const text = JSON.stringify(apps)
        for (const secret of ['ghp_SECRET123', 'bob', 'pa55word', 'token=abc']) assert.equal(text.includes(secret), false, `${secret} leaked`)
        assert.equal(a.web.source.repo, 'https://github.com/acme/deploy.git')
        assert.equal(cleanRepo('git@github.com:acme/deploy.git'), 'git@github.com:acme/deploy.git')
        assert.equal(cleanRepo('oci://user:tok@ghcr.io/acme/charts'), 'oci://ghcr.io/acme/charts')
        assert.equal(cleanRepo(null), null)
    })

    test('short revisions', () => {
        assert.equal(shortRev(SHA), '0123456'); assert.equal(shortRev(`v1.2@sha256:${SHA}`), 'v1.2@0123456'); assert.equal(shortRev('18.6.1'), '18.6.1'); assert.equal(shortRev(null), null)
    })

    test('summary counts', () => {
        const s = summarize(apps)
        assert.equal(s.total, apps.length)
        assert.equal(s.failed, 2); assert.equal(s.outOfSync, 1); assert.equal(s.suspended, 1)
        assert.ok(s.synced >= 5)
    })

    test('tool not installed, forbidden, other errors, list too large', () => {
        const none = parseGitops(output({ ARGO_ERR: 'error: the server doesn\'t have a resource type "applications"', KS_ERR: 'error: the server doesn\'t have a resource type "kustomizations"', HR_ERR: 'no matches for kind', GITREPO_ERR: 'x' }))
        assert.deepEqual(none, { apps: [], tools: { argocd: { state: 'missing' }, flux: { state: 'missing' } } })
        const denied = parseGitops(output({ ARGO_ERR: 'Error from server (Forbidden): applications.argoproj.io is forbidden: User "system:serviceaccount:kube-system:kubeez" cannot list', KS: [], HR_ERR: 'doesn\'t have a resource type' }))
        assert.equal(denied.tools.argocd.state, 'forbidden'); assert.match(denied.tools.argocd.message, /may not read applications\.argoproj\.io/)
        assert.equal(denied.tools.flux.state, 'ok', 'Flux without helm-controller is still Flux')
        const cut = parseGitops(output({ ARGO: '{"items":[{"metadata":', KS_ERR: 'doesn\'t have a resource type', HR_ERR: 'doesn\'t have a resource type' }))
        assert.equal(cut.tools.argocd.state, 'error'); assert.match(cut.tools.argocd.message, /too large/)
        const other = parseGitops(output({ ARGO_ERR: 'Warning: something\nUnable to connect to the server: dial tcp: i/o timeout' }))
        assert.equal(other.tools.argocd.state, 'error'); assert.equal(other.tools.argocd.message, 'Unable to connect to the server: dial tcp: i/o timeout')
    })

    test('the script only lists the GitOps kinds — no Secrets, nothing that writes', () => {
        assert.equal(/secret/i.test(GITOPS_SCRIPT), false)
        assert.equal(/\b(patch|annotate|apply|delete|edit|create|replace)\b/.test(GITOPS_SCRIPT), false)
    })
})

// the real script, run by a real shell against a stub `sudo` + `kubectl`
const bash = ['/bin/bash', '/usr/bin/bash'].find(p => fs.existsSync(p)) || (spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null)
describe('the shell script', { skip: !bash && 'no bash' }, () => {
    test('lists what exists, reports what is missing or forbidden', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-gitops-sh-'))
        try {
            fs.writeFileSync(path.join(dir, 'argo.json'), JSON.stringify({ items: ARGO.slice(0, 2) }))
            fs.writeFileSync(path.join(dir, 'sudo'), '#!/bin/bash\nwhile [ "${1#*=}" != "$1" ]; do shift; done\n[ "$1" = timeout ] && shift 2\nexec "$@"\n')
            fs.writeFileSync(path.join(dir, 'kubectl'), `#!/bin/bash
case "$2" in
  applications.argoproj.io) case " $* " in *" -o name "*) echo application.argoproj.io/web ;; *) cat '${dir.replace(/\\/g, '/')}/argo.json' ;; esac ;;
  kustomizations.*) echo 'error: the server doesn'"'"'t have a resource type "kustomizations"' >&2; exit 1 ;;
  helmreleases.*) echo 'Error from server (Forbidden): helmreleases is forbidden' >&2; exit 1 ;;
  *) echo 'error: the server doesn'"'"'t have a resource type "x"' >&2; exit 1 ;;
esac
`)
            fs.chmodSync(path.join(dir, 'sudo'), 0o755); fs.chmodSync(path.join(dir, 'kubectl'), 0o755)
            const r = spawnSync(bash, ['-c', `export PATH="$KZ_STUBS:$PATH"; ${GITOPS_SCRIPT}`], { env: { ...process.env, KZ_STUBS: dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) }, encoding: 'utf8' })
            assert.equal(r.status, 0, r.stderr)
            const { apps, tools } = parseGitops(r.stdout)
            assert.deepEqual(apps.map(x => x.name).sort(), ['api', 'web'])
            assert.equal(tools.argocd.state, 'ok')
            assert.equal(tools.flux.state, 'forbidden')
        } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })
})

describe('Sync now', () => {
    const { apps } = parseGitops(FULL)
    const a = byName(apps)

    test('requests are checked: kinds, names, namespaces, actions (no shell tricks)', () => {
        const ok = { kind: 'Application', namespace: 'argocd', name: 'web' }
        assert.deepEqual(cleanSyncRequest(ok), { ...ok, action: 'sync' })
        for (const bad of [
            { ...ok, kind: 'Secret' }, { ...ok, kind: undefined }, { ...ok, name: 'x;reboot' }, { ...ok, name: '$(id)' }, { ...ok, name: "a'b" },
            { ...ok, namespace: 'Argo' }, { ...ok, namespace: 'a b' }, { ...ok, namespace: ['argocd'] }, { ...ok, action: 'delete' }, { ...ok, name: 'x'.repeat(300) }, null
        ]) assert.throws(() => cleanSyncRequest(bad), (e) => e.status === 400, JSON.stringify(bad))
    })

    test('Argo CD sync = the operation field, never prune; refresh = annotation; one at a time', () => {
        const cmd = syncCommand(a.web, 'sync', { by: "bob'; rm -rf / #" })
        assert.match(cmd, /kubectl patch -n 'argocd' applications\.argoproj\.io 'web' --type merge -p '/)
        const patch = JSON.parse(/-p '(.*)'$/.exec(cmd)[1])
        assert.deepEqual(patch.operation.sync, {})
        assert.equal(patch.operation.initiatedBy.username, 'kubeez:bobrm-rf')
        assert.equal(/prune/i.test(cmd), false)
        assert.match(syncCommand(a.web, 'refresh'), /annotate --overwrite -n 'argocd' applications\.argoproj\.io 'web' argocd\.argoproj\.io\/refresh=normal$/)
        assert.throws(() => syncCommand(a.busy, 'sync'), (e) => e.status === 409 && /already running/.test(e.message))
        assert.doesNotThrow(() => syncCommand(a.busy, 'refresh'))
    })

    test('Flux sync = reconcile annotation; a suspended one is refused', () => {
        const now = new Date('2026-10-30T08:00:00Z')
        assert.match(syncCommand(a.podinfo, 'sync', { now }), /annotate --overwrite -n 'flux-system' kustomizations\.kustomize\.toolkit\.fluxcd\.io 'podinfo' reconcile\.fluxcd\.io\/requestedAt='2026-10-30T08:00:00.000Z'$/)
        assert.match(syncCommand(a.redis, 'sync', { now }), /helmreleases\.helm\.toolkit\.fluxcd\.io 'redis'/)
        assert.throws(() => syncCommand(a.paused, 'sync'), (e) => e.status === 409 && /suspended/.test(e.message))
    })

    test('a cluster that refuses is a 502 with its reason; the cached list is dropped', async () => {
        const cluster = { id: 'cx' }
        let calls = 0
        const connect = async () => ({ execCommand: async () => { calls++; return { stdout: FULL } }, dispose() { } })
        await readGitops(cluster, { connect }); await readGitops(cluster, { connect })
        assert.equal(calls, 1, 'cached for 30 s')
        await readGitops(cluster, { connect, fresh: true })
        assert.equal(calls, 2)
        const refuse = async () => ({ execCommand: async () => ({ code: 1, stderr: 'Error from server (Forbidden): cannot patch' }), dispose() { } })
        await assert.rejects(runSync(cluster, a.web, 'sync', { connect: refuse }), (e) => e.status === 502 && /Forbidden/.test(e.message))
        await readGitops(cluster, { connect })
        assert.equal(calls, 3, 'a sync drops the cache')
        const r = await runSync(cluster, a.podinfo, 'sync', { connect: async () => ({ execCommand: async () => ({ code: 0, stdout: 'annotated' }), dispose() { } }) })
        assert.equal(r.message, 'Reconcile requested for Kustomization flux-system/podinfo.')
    })

    test('a cluster that does not answer fully is an error, not an empty list', async () => {
        await assert.rejects(readGitops({ id: 'cy' }, { connect: async () => ({ execCommand: async () => ({ stdout: '==KZGITOPS:ARGO==\n{"items":[', stderr: 'timeout' }), dispose() { } }) }), (e) => e.status === 502)
    })
})

describe('namespace limits', () => {
    const { apps } = parseGitops(FULL)
    const a = byName(apps)
    const teamA = (ns) => ns === 'team-a' || ns.startsWith('team-a-')

    test('a limited member sees only apps that deploy into their namespaces alone', () => {
        assert.equal(visibleTo(a.web, teamA), true)
        assert.equal(visibleTo(a.podinfo, teamA), true)
        assert.equal(visibleTo(a.redis, teamA), true)
        assert.equal(visibleTo(a.remote, teamA), false, 'another cluster')
        assert.equal(visibleTo(a.infra, teamA), false, 'cluster-wide resources')
        assert.equal(visibleTo(a.paused, teamA), false, 'team-b')
        assert.equal(visibleTo(a['infra-ks'], teamA), false)
        assert.equal(visibleTo({ ...a.web, targetNamespaces: [] }, teamA), false, 'unknown target = hidden')
        assert.equal(visibleTo(a.remote, null), true, 'the whole cluster sees everything')
    })
})

describe('API: who may see and sync', () => {
    let base, server, accessControl, approvalStore, roleStore, auditDir
    const U = {
        admin: { id: 'u-admin', username: 'owner', orgId: 'org-a', role: 'admin' },
        operator: { id: 'u-op', username: 'opsy', orgId: 'org-a', role: 'operator' },
        viewer: { id: 'u-view', username: 'vee', orgId: 'org-a', role: 'viewer' },
        scoped: { id: 'u-scoped', username: 'dev', orgId: 'org-a', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'c1', role: 'operator', namespaces: ['team-a'] }] },
        custom: { id: 'u-custom', username: 'cust', orgId: 'org-a', role: 'custom:noview' },
        stranger: { id: 'u-b', username: 'other', orgId: 'org-b', role: 'admin' }
    }
    const call = async (who, method, p, body) => {
        const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined })
        return { status: r.status, data: await r.json().catch(() => null) }
    }
    const cmds = []

    before(async () => {
        const express = (await import('express')).default
        const { default: router } = await import('../src/routes/gitops.js')
        const { auditTrail } = await import('../src/services/auditLog.js');
        ({ approvalStore } = await import('../src/services/approvalStore.js'));
        ({ roleStore } = await import('../src/services/roleStore.js'))
        accessControl = await import('../src/services/accessControl.js')
        auditDir = DATA
        // a custom role with everything about clusters except GitOps
        const created = roleStore.create('org-a', { name: 'No GitOps', permissions: ['cluster:view', 'incident:view'], kube: 'view' })
        U.custom.role = `custom:${created.id}`
        _test.useConnect(async () => ({
            execCommand: async (cmd) => { cmds.push(cmd); return /patch|annotate/.test(cmd) ? { code: 0, stdout: 'ok' } : { stdout: FULL } },
            dispose() { }
        }))
        const app = express()
        app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use(auditTrail)
        app.use('/api/clusters', router)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    const sync = { kind: 'Application', namespace: 'argocd', name: 'api', action: 'sync' }

    test('everyone with gitops:view sees the list; admin sees everything', async () => {
        const r = await call('admin', 'GET', '/api/clusters/c1/gitops')
        assert.equal(r.status, 200, JSON.stringify(r.data))
        assert.equal(r.data.apps.length, 10); assert.equal(r.data.hidden, 0); assert.equal(r.data.canSync, true)
        assert.equal(r.data.summary.total, 10)
        assert.equal(r.data.apps.find(a => a.name === 'remote').canSync, true, 'admins may sync an app deploying to another cluster')
        const v = await call('viewer', 'GET', '/api/clusters/c1/gitops')
        assert.equal(v.status, 200); assert.equal(v.data.canSync, false); assert.ok(v.data.apps.every(a => a.canSync === false))
        const op = await call('operator', 'GET', '/api/clusters/c1/gitops')
        assert.equal(op.data.canSync, true)
        assert.equal(op.data.apps.find(a => a.name === 'remote').canSync, false, 'operators do not sync into another cluster')
    })

    test('a namespace-limited member sees only team-a apps', async () => {
        const r = await call('scoped', 'GET', '/api/clusters/c1/gitops')
        assert.equal(r.status, 200)
        assert.deepEqual(r.data.apps.map(a => a.name).sort(), ['api', 'broken', 'busy', 'podinfo', 'redis', 'web'])
        assert.equal(r.data.hidden, 4)
        assert.equal(r.data.summary.total, 6)
        assert.equal((await call('scoped', 'POST', '/api/clusters/c1/gitops/sync', { kind: 'Application', namespace: 'argocd', name: 'infra', action: 'sync' })).status, 404, 'cannot sync what it cannot see')
        assert.equal((await call('scoped', 'POST', '/api/clusters/c1/gitops/sync', sync)).status, 200)
    })

    test('no gitops:view → 403; another workspace or unknown cluster → 404; not signed in → 401', async () => {
        const r = await call('custom', 'GET', '/api/clusters/c1/gitops')
        assert.equal(r.status, 403, 'a custom role without gitops:view'); assert.equal(r.data.requiredPermission, 'gitops:view')
        assert.equal((await call('custom', 'POST', '/api/clusters/c1/gitops/sync', sync)).status, 403)
        assert.equal(accessControl.canOn(U.viewer, 'gitops:sync'), false)
        assert.equal((await call('stranger', 'GET', '/api/clusters/c1/gitops')).status, 404)
        assert.equal((await call('stranger', 'POST', '/api/clusters/c1/gitops/sync', sync)).status, 404)
        assert.equal((await call('admin', 'GET', '/api/clusters/c-other/gitops')).status, 404)
        assert.equal((await call('admin', 'GET', '/api/clusters/nope/gitops')).status, 404)
        assert.equal((await call('nobody', 'GET', '/api/clusters/c1/gitops')).status, 401)
    })

    test('viewers cannot sync; bad requests are 400 before touching the cluster', async () => {
        const v = await call('viewer', 'POST', '/api/clusters/c1/gitops/sync', sync)
        assert.equal(v.status, 403); assert.equal(v.data.requiredPermission, 'gitops:sync')
        const before = cmds.length
        for (const body of [{ ...sync, name: 'x;reboot' }, { ...sync, kind: 'Secret' }, { ...sync, action: 'prune' }, {}]) {
            assert.equal((await call('operator', 'POST', '/api/clusters/c1/gitops/sync', body)).status, 400, JSON.stringify(body))
        }
        assert.equal(cmds.length, before, 'nothing ran on the cluster')
    })

    test('operator sync: the right command runs, conflicts are 409, unknown apps 404, remote clusters admin-only', async () => {
        const r = await call('operator', 'POST', '/api/clusters/c1/gitops/sync', sync)
        assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.message, /Sync started for Application argocd\/api/)
        assert.match(cmds.at(-1), /patch -n 'argocd' applications\.argoproj\.io 'api'/)
        assert.match(cmds.at(-1), /kubeez:opsy/)
        assert.equal((await call('operator', 'POST', '/api/clusters/c1/gitops/sync', { ...sync, name: 'busy' })).status, 409)
        assert.equal((await call('operator', 'POST', '/api/clusters/c1/gitops/sync', { kind: 'Kustomization', namespace: 'flux-system', name: 'paused', action: 'sync' })).status, 409)
        assert.equal((await call('operator', 'POST', '/api/clusters/c1/gitops/sync', { ...sync, name: 'ghost' })).status, 404)
        assert.equal((await call('operator', 'POST', '/api/clusters/c1/gitops/sync', { ...sync, name: 'remote' })).status, 403)
        assert.equal((await call('admin', 'POST', '/api/clusters/c1/gitops/sync', { ...sync, name: 'remote' })).status, 200)
        const ref = await call('operator', 'POST', '/api/clusters/c1/gitops/sync', { ...sync, action: 'refresh' })
        assert.equal(ref.status, 200); assert.match(cmds.at(-1), /argocd\.argoproj\.io\/refresh=normal/)
    })

    test('a read-only imported cluster: list yes, sync no', async () => {
        const r = await call('admin', 'GET', '/api/clusters/imp-ro/gitops')
        assert.equal(r.status, 200); assert.equal(r.data.canSync, false); assert.match(r.data.readOnlyReason, /read-only/)
        const s = await call('admin', 'POST', '/api/clusters/imp-ro/gitops/sync', sync)
        assert.equal(s.status, 409); assert.match(s.data.error, /read-only/)
    })

    test('two-person approval can protect "Sync now"', async () => {
        approvalStore.saveSettings('org-a', { actions: { 'gitops:sync': true } })
        try {
            const before = cmds.length
            const r = await call('operator', 'POST', '/api/clusters/c1/gitops/sync', sync)
            assert.equal(r.status, 428)
            assert.equal(r.data.action, 'gitops:sync')
            assert.match(r.data.summary, /Sync GitOps app Application argocd\/api on prod/)
            assert.equal(cmds.length, before, 'nothing ran before the approval')
        } finally { approvalStore.saveSettings('org-a', { actions: {} }) }
    })

    test('every sync is in the audit trail with what was synced', async () => {
        await new Promise(r => setTimeout(r, 100))
        const files = fs.readdirSync(path.join(auditDir, 'audit')).filter(f => f.endsWith('.jsonl'))
        const rows = files.flatMap(f => fs.readFileSync(path.join(auditDir, 'audit', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
        const syncs = rows.filter(r => r.action === 'POST /api/clusters/:id/gitops/sync')
        assert.ok(syncs.some(r => r.ok && r.actor?.username === 'opsy' && r.detail === 'sync argocd Application argocd/api' && r.target?.clusterId === 'c1'), JSON.stringify(syncs.slice(0, 3)))
        assert.ok(syncs.some(r => !r.ok && r.status === 403 && r.actor?.username === 'vee'), 'refused attempts are recorded too')
    })
})
