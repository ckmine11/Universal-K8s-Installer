// Phase 2: environments, chart repositories, change freezes, the Helm App
// Manager (values masking, previews, the helm commands — also run by a real
// shell against a stub helm), GitOps level 2 (Argo CD apps locked to one
// namespace), and the API gates for every role.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempDataDir, paidOrgs } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
paidOrgs(DATA, ['org-h'])
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 'h1', clusterName: 'prod', orgId: 'org-h', ownerId: 'h-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.70', username: 'root', password: 'x' }], workerNodes: [] },
    { id: 'h2', clusterName: 'stage', orgId: 'org-h', ownerId: 'h-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.71', username: 'root', password: 'x' }], workerNodes: [] },
    { id: 'h-ro', clusterName: 'eks-ro', orgId: 'org-h', ownerId: 'h-admin', k8sVersion: '1.34.0', imported: true, access: { mode: 'direct', level: 'read', server: 'https://203.0.113.9', token: 'x' }, masterNodes: [], workerNodes: [] },
    { id: 'hx', clusterName: 'theirs', orgId: 'org-x', ownerId: 'x', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.72' }], workerNodes: [] }
]))

const { deliveryStore, checkFreeze, cleanRepoUrl } = await import('../src/services/deliveryStore.js')
const helm = await import('../src/services/helmApps.js')
const catalog = await import('../src/services/chartCatalog.js')
const gitops = await import('../src/services/gitops.js')
const { protectedTarget } = await import('../src/services/approvals.js')
after(() => { helm._test.useConnect(null); gitops._test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const bash = ['/bin/bash', '/usr/bin/bash'].find(p => fs.existsSync(p)) || (spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null)

describe('environments, repositories, freezes', () => {
    test('environments: one per namespace and cluster, names checked, protected kept', () => {
        const prod = deliveryStore.saveEnvironment('org-t', { name: 'Prod', clusterId: 'h1', namespace: 'shop', protected: true }, { clusterIds: ['h1', 'h2'], by: 'ann' })
        assert.equal(prod.name, 'prod'); assert.equal(prod.protected, true)
        assert.throws(() => deliveryStore.saveEnvironment('org-t', { name: 'prod', clusterId: 'h2', namespace: 'shop' }, { clusterIds: ['h1', 'h2'] }), /already an environment called prod/)
        assert.throws(() => deliveryStore.saveEnvironment('org-t', { name: 'other', clusterId: 'h1', namespace: 'shop' }, { clusterIds: ['h1', 'h2'] }), /already an environment/)
        assert.throws(() => deliveryStore.saveEnvironment('org-t', { name: 'x', clusterId: 'hx', namespace: 'shop' }, { clusterIds: ['h1'] }), /cluster of this workspace/)
        assert.throws(() => deliveryStore.saveEnvironment('org-t', { name: 'bad name', clusterId: 'h1', namespace: 'a' }, { clusterIds: ['h1'] }), /lowercase/)
        assert.throws(() => deliveryStore.saveEnvironment('org-t', { name: 'ok', clusterId: 'h1', namespace: 'A;b' }, { clusterIds: ['h1'] }), /namespace/)
        assert.equal(deliveryStore.environmentAt('org-t', 'h1', 'shop').id, prod.id)
        assert.equal(deliveryStore.environmentAt('org-other', 'h1', 'shop'), null, 'another workspace sees nothing')
    })

    test('repositories: https or oci, no credentials in the address, the password stays encrypted', () => {
        assert.equal(cleanRepoUrl('https://charts.bitnami.com/bitnami/'), 'https://charts.bitnami.com/bitnami')
        for (const u of ['http://x.io', 'https://u:p@x.io', 'https://x.io/?token=1', 'file:///etc', 'not a url']) assert.throws(() => cleanRepoUrl(u), /./, u)
        const r = deliveryStore.saveRepo('org-t', { name: 'private', url: 'https://charts.acme.io', username: 'bot', password: 's3cr3t-pw' })
        assert.equal(r.hasPassword, true); assert.equal('password' in r, false)
        assert.equal(JSON.stringify(deliveryStore.repos('org-t')).includes('s3cr3t'), false)
        assert.equal(fs.readFileSync(path.join(DATA, 'delivery.json'), 'utf8').includes('s3cr3t-pw'), false, 'not in clear on disk')
        assert.equal(deliveryStore.repoCredentials('org-t', r.id).password, 's3cr3t-pw')
        deliveryStore.saveRepo('org-t', { id: r.id, name: 'private', url: 'https://charts.acme.io', username: 'bot' })
        assert.equal(deliveryStore.repoCredentials('org-t', r.id).password, 's3cr3t-pw', 'an empty password on edit keeps it')
        deliveryStore.saveRepo('org-t', { id: r.id, name: 'private', url: 'https://charts.acme.io', clearPassword: true })
        assert.equal(deliveryStore.repoCredentials('org-t', r.id).password, null)
        assert.equal(deliveryStore.repoCredentials('org-other', r.id), null)
    })

    test('freezes: cover some or all clusters; operators are stopped, admins may override with a reason', () => {
        const now = Date.now()
        assert.throws(() => deliveryStore.saveFreeze('org-t', { from: new Date(now).toISOString(), until: new Date(now - 1).toISOString(), reason: 'x y z' }), /after the start/)
        assert.throws(() => deliveryStore.saveFreeze('org-t', { from: new Date(now).toISOString(), until: new Date(now + 40 * 86400e3).toISOString(), reason: 'long one' }), /31 days/)
        assert.throws(() => deliveryStore.saveFreeze('org-t', { from: new Date(now).toISOString(), until: new Date(now + 3600e3).toISOString(), reason: '' }), /Say why/)
        const f = deliveryStore.saveFreeze('org-t', { from: new Date(now - 60e3).toISOString(), until: new Date(now + 3600e3).toISOString(), reason: 'Diwali sale', clusterIds: ['h1'] }, { clusterIds: ['h1', 'h2'] })
        assert.equal(deliveryStore.activeFreeze('org-t', 'h1').id, f.id)
        assert.equal(deliveryStore.activeFreeze('org-t', 'h2'), null, 'only the clusters it covers')
        const c = { id: 'h1', orgId: 'org-t' }
        assert.throws(() => checkFreeze({ role: 'operator' }, c, {}), (e) => e.status === 423 && /Diwali sale/.test(e.message) && /Ask an admin/.test(e.message))
        assert.throws(() => checkFreeze({ role: 'admin' }, c, {}), (e) => e.status === 423 && /override/.test(e.message))
        assert.throws(() => checkFreeze({ role: 'operator' }, c, { overrideFreeze: 'hotfix for checkout' }), (e) => e.status === 423, 'operators cannot override')
        assert.match(checkFreeze({ role: 'admin' }, c, { overrideFreeze: 'hotfix for checkout' }), /overridden: hotfix for checkout/)
        assert.equal(checkFreeze({ role: 'operator' }, { id: 'h2', orgId: 'org-t' }, {}), null)
        deliveryStore.removeFreeze('org-t', f.id)
        assert.equal(deliveryStore.activeFreeze('org-t', 'h1'), null)
    })

    test('a protected environment always needs a second person for deploys, rollbacks and uninstalls', () => {
        assert.equal(protectedTarget('org-t', 'app:deploy', 'h1', '/api/clusters/h1/apps', { namespace: 'shop' }), true)
        assert.equal(protectedTarget('org-t', 'app:deploy', 'h1', '/api/clusters/h1/apps/shop/web/rollback', {}), true)
        assert.equal(protectedTarget('org-t', 'app:uninstall', 'h1', '/api/clusters/h1/apps/shop/web', {}), true)
        assert.equal(protectedTarget('org-t', 'app:deploy', 'h1', '/api/clusters/h1/apps', { namespace: 'dev' }), false)
        assert.equal(protectedTarget('org-t', 'app:deploy', 'h2', '/api/clusters/h2/apps', { namespace: 'shop' }), false)
        assert.equal(protectedTarget('org-t', 'cluster:upgrade', 'h1', '/api/clusters/h1/upgrade', { namespace: 'shop' }), false)
    })
})

describe('Chart Store', () => {
    const INDEX = `apiVersion: v1
entries:
  redis:
  - name: redis
    version: 19.6.1
    appVersion: 7.2.5
    description: In-memory data store
    icon: https://example.com/redis.png
  - name: redis
    version: 19.5.0
    appVersion: 7.2.4
  old:
  - name: old
    version: 1.0.0
    deprecated: true
  nginx:
  - name: nginx
    version: 18.1.0
    icon: http://insecure/icon.png
`
    test('index.yaml → charts and versions (deprecated left out, only https icons)', () => {
        const c = catalog.parseIndex(INDEX)
        assert.deepEqual(c.map(x => x.name), ['nginx', 'redis'])
        assert.deepEqual(c[1].versions.map(v => v.version), ['19.6.1', '19.5.0'])
        assert.equal(c[1].icon, 'https://example.com/redis.png'); assert.equal(c[0].icon, null)
        assert.throws(() => catalog.parseIndex('just: text'), /not a Helm repository/)
    })

    test('fetched with its credentials only to its own host; redirects checked; OCI has no index', async () => {
        catalog._test.clear()
        const seen = []
        const fake = async (u, opts) => {
            seen.push({ url: String(u), auth: opts.headers.Authorization || null })
            if (String(u) === 'https://charts.acme.io/stable/index.yaml') return new Response('', { status: 302, headers: { location: 'https://cdn.acme-files.io/index.yaml' } })
            return new Response(INDEX, { status: 200 })
        }
        const r = await catalog.listCharts({ url: 'https://charts.acme.io/stable', username: 'bot', password: 'pw' }, { q: 'red', fetchImpl: fake })
        assert.deepEqual(r.charts.map(c => c.name), ['redis']); assert.equal(r.total, 2)
        assert.ok(seen[0].auth?.startsWith('Basic ')); assert.equal(seen[1].auth, null, 'no credentials to the CDN')
        await assert.rejects(catalog.listCharts({ url: 'https://evil.io/x' }, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest' } }) }), /non-https/)
        await assert.rejects(catalog.listCharts({ url: 'https://big.io/x' }, { fetchImpl: async () => new Response('a', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }) }), /too large/)
        await assert.rejects(catalog.listCharts({ url: 'https://auth.io/x' }, { fetchImpl: async () => new Response('', { status: 401 }) }), /HTTP 401 — check its user name and password/)
        assert.deepEqual(await catalog.listCharts({ url: 'oci://ghcr.io/acme/charts' }), { oci: true, charts: [] })
    })

    test('SaaS: never from private addresses', async () => {
        process.env.KUBEEZ_MODE = 'saas'
        try { await assert.rejects(catalog.listCharts({ url: 'https://10.0.0.5/charts' }, { fresh: true, fetchImpl: async () => new Response(INDEX) }), /private\/internal/) } finally { process.env.KUBEEZ_MODE = 'selfhosted' }
    })
})

describe('values', () => {
    test('secret-looking values are masked; a mask sent back keeps the real value', () => {
        const v = { image: { tag: '1.2' }, auth: { password: 'p@ss', enabled: true }, db: { connectionString: 'postgres://u:pw@db/x' }, apiKey: 'k-1', list: [{ token: 't1' }], replicas: 2 }
        const m = helm.maskValues(v)
        assert.equal(m.auth.password, helm._test.MASK); assert.equal(m.auth.enabled, true); assert.equal(m.db.connectionString, helm._test.MASK)
        assert.equal(m.apiKey, helm._test.MASK); assert.equal(m.list[0].token, helm._test.MASK); assert.equal(m.image.tag, '1.2'); assert.equal(m.replicas, 2)
        const back = helm.restoreMasked({ ...m, replicas: 3 }, v)
        assert.deepEqual(back, { ...v, replicas: 3 })
        assert.throws(() => helm.restoreMasked({ newSecret: { password: helm._test.MASK } }, {}), /newSecret.password is masked/)
    })
    test('YAML in, map only, size-limited', () => {
        assert.deepEqual(helm.parseValues('replicas: 2\nimage:\n  tag: "1.0"'), { replicas: 2, image: { tag: '1.0' } })
        assert.deepEqual(helm.parseValues(''), {})
        assert.throws(() => helm.parseValues('- a\n- b'), /YAML map/)
        assert.throws(() => helm.parseValues('a: [1,'), /not valid YAML/)
        assert.throws(() => helm.parseValues('a: ' + 'x'.repeat(300 * 1024)), /too large/)
    })
    test('compare two releases: only the keys that differ, secrets masked', () => {
        const d = helm.compareValues({ replicas: 2, image: { tag: '1.0' }, password: 'a' }, { replicas: 3, image: { tag: '1.0' }, password: 'b', extra: true })
        assert.deepEqual(d, [{ key: 'extra', a: null, b: true, only: 'b' }, { key: 'replicas', a: 2, b: 3, only: null }])
        assert.equal(JSON.stringify(d).includes('"a"') && JSON.stringify(d).includes('"b"'), true)
    })
})

describe('preview diff', () => {
    const before = `---
# Source: web/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: shop }
spec:
  replicas: 2
  template: { spec: { containers: [{ name: web, image: "web:1.0" }] } }
---
apiVersion: v1
kind: Secret
metadata: { name: web-db, namespace: shop }
data: { password: b2xk }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: old, namespace: shop }
data: { a: "1" }
`
    const after = before.replace('web:1.0', 'web:1.1').replace('b2xk', 'bmV3').replace(/---\napiVersion: v1\nkind: ConfigMap[\s\S]*$/, `---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: shop }
spec: { ports: [{ port: 80 }] }
`)
    test('added, changed and removed resources; Secret values never shown', () => {
        const d = helm.diffManifests(before, after)
        assert.deepEqual(d.changes.map(c => `${c.action} ${c.kind}/${c.name}`), ['remove ConfigMap/old', 'change Deployment/web', 'change Secret/web-db', 'add Service/web'])
        const dep = d.changes.find(c => c.kind === 'Deployment')
        assert.ok(dep.diff.includes('-             image: web:1.0') || dep.diff.some(l => /^- .*web:1\.0/.test(l)))
        assert.ok(dep.diff.some(l => /^\+ .*web:1\.1/.test(l)))
        const text = JSON.stringify(d)
        assert.equal(text.includes('b2xk') || text.includes('bmV3') || text.includes('old') && text.includes('olk'), false, 'secret data never in the diff')
        assert.ok(d.changes.find(c => c.kind === 'Secret').diff.some(l => /hidden, sha256/.test(l)))
        assert.equal(d.unchanged, 0)
        assert.equal(helm.lineDiff('a\n'.repeat(700), 'b'), null, 'too large to show')
    })
})

// a fake control-plane: answers helm the way Helm does, and remembers what was asked
const helmCluster = (state = {}) => {
    const calls = []
    const connect = async () => ({
        execCommand: async (cmd, opts = {}) => {
            calls.push({ cmd, stdin: opts.stdin ?? null })
            if (state.fail && state.fail.test(cmd)) return { code: 1, stderr: 'Error: UPGRADE FAILED: timed out waiting for the condition' }
            // a real install waits for its pods
            if (state.slow && /--wait/.test(cmd)) await new Promise(r => setTimeout(r, 150))
            if (/HELM list -A/.test(cmd)) return { code: 0, stdout: JSON.stringify([
                { name: 'web', namespace: 'shop', revision: '3', status: 'deployed', chart: 'web-1.4.2', app_version: '2.0', updated: '2026-10-29 10:00:00' },
                { name: 'redis', namespace: 'cache', revision: '1', status: 'deployed', chart: 'redis-19.6.1', app_version: '7.2.5' },
                { name: 'db', namespace: 'team-b', revision: '2', status: 'failed', chart: 'postgresql-15.0.0' }]) }
            if (/HELM history/.test(cmd)) return { code: 0, stdout: `==H==\n${JSON.stringify([{ revision: 2, status: 'superseded', chart: 'web-1.4.1' }, { revision: 3, status: 'deployed', chart: 'web-1.4.2', description: 'Upgrade complete' }])}\n==V==\n${JSON.stringify({ replicas: 2, db: { password: 'live-pw' } })}` }
            if (/--dry-run=server/.test(cmd)) return { code: 0, stdout: `==CUR==\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: c, namespace: shop }\ndata: { a: "1" }\n==NEW==\n${JSON.stringify({ chart: { metadata: { name: 'web', version: '1.5.0', appVersion: '2.1' } }, manifest: 'apiVersion: v1\nkind: ConfigMap\nmetadata: { name: c, namespace: shop }\ndata: { a: "2" }\n', info: { notes: 'Visit http://web' } })}` }
            if (/HELM get values/.test(cmd)) return { code: 0, stdout: JSON.stringify({ replicas: 2, db: { password: 'live-pw' } }) }
            return { code: 0, stdout: '{"name":"web"}' }
        },
        dispose() { }
    })
    return { calls, connect }
}
const repo = { id: 'r1', name: 'acme', url: 'https://charts.acme.io', username: null, password: null }

describe('the helm commands', () => {
    const cluster = { id: 'h1', orgId: 'org-h' }

    test('releases: chart and version split; details: history newest first, values masked', async () => {
        const f = helmCluster()
        const list = await helm.listReleases(cluster, { connect: f.connect })
        assert.deepEqual(list.find(r => r.name === 'web'), { name: 'web', namespace: 'shop', revision: 3, status: 'deployed', chart: 'web', version: '1.4.2', appVersion: '2.0', updated: '2026-10-29 10:00:00' })
        assert.equal(list.find(r => r.name === 'db').chart, 'postgresql')
        const d = await helm.releaseDetail(cluster, 'shop', 'web', { connect: f.connect })
        assert.deepEqual(d.history.map(h => h.revision), [3, 2])
        assert.equal(d.values.db.password, helm._test.MASK)
        await assert.rejects(helm.releaseDetail(cluster, 'shop', "web';reboot", { connect: f.connect }), /valid release/)
    })

    test('requests are checked before anything runs', () => {
        const ok = { release: 'web', namespace: 'shop', chart: 'web', version: '1.5.0', values: '' }
        assert.equal(helm.cleanDeploy(ok, repo).chart, 'web')
        for (const b of [{ ...ok, release: 'Web' }, { ...ok, release: 'a'.repeat(54) }, { ...ok, namespace: 'x;y' }, { ...ok, chart: '../etc' }, { ...ok, chart: 'a b' }, { ...ok, version: '1.0; rm -rf /' }])
            assert.throws(() => helm.cleanDeploy(b, repo), (e) => e.status === 400, JSON.stringify(b))
        assert.throws(() => helm.cleanDeploy(ok, null), /chart repositories/)
    })

    test('preview: dry run on the server, values with the real secret restored, diff and notes', async () => {
        const f = helmCluster()
        const p = await helm.previewDeploy(cluster, helm.cleanDeploy({ release: 'web', namespace: 'shop', chart: 'web', version: '1.5.0', values: `replicas: 3\ndb:\n  password: ${helm._test.MASK}` }, repo), { connect: f.connect })
        assert.equal(p.install, false); assert.equal(p.chart, 'web-1.5.0'); assert.equal(p.notes, 'Visit http://web')
        assert.deepEqual(p.changes.map(c => `${c.action} ${c.kind}/${c.name}`), ['change ConfigMap/c'])
        const run = f.calls.find(c => /--dry-run=server/.test(c.cmd))
        assert.match(run.cmd, /HELM upgrade --install 'web' 'web' --repo 'https:\/\/charts\.acme\.io' --version '1\.5\.0' -n 'shop' --create-namespace -f - --dry-run=server -o json/)
        assert.deepEqual(JSON.parse(run.stdin), { replicas: 3, db: { password: 'live-pw' } }, 'the masked password is the live one again')
        assert.equal(run.cmd.includes('live-pw'), false, 'values go on stdin, not the command line')
    })

    test('deploy / rollback / uninstall are jobs; one at a time per release; failures are reported', async () => {
        const f = helmCluster({ slow: true })
        const d = helm.cleanDeploy({ release: 'web', namespace: 'shop', chart: 'web', version: '1.5.0', values: 'replicas: 3' }, { ...repo, url: 'oci://ghcr.io/acme/charts', username: 'bot', password: 'pw' })
        const j = await helm.deploy(cluster, d, { by: 'opsy', connect: f.connect })
        assert.equal(j.status, 'running'); assert.equal(j.by, 'opsy')
        await assert.rejects(helm.deploy(cluster, d, { connect: f.connect }), (e) => e.status === 409 && /already running/.test(e.message))
        await helm._test.jobs.get(j.id).promise
        assert.equal(helm.findJob(j.id).status, 'done')
        const up = f.calls.find(c => /upgrade --install/.test(c.cmd) && /--wait/.test(c.cmd))
        assert.match(up.cmd, /upgrade --install 'web' 'oci:\/\/ghcr\.io\/acme\/charts\/web' --version '1\.5\.0' --username 'bot' --password 'pw' -n 'shop' --create-namespace -f - --wait --timeout 10m \$RB -o json/)
        assert.equal(/--repo/.test(up.cmd), false, 'OCI charts have no --repo')
        const rb = helm.rollback(cluster, 'shop', 'web', 2, { connect: f.connect }); await helm._test.jobs.get(rb.id).promise
        assert.ok(f.calls.some(c => /HELM rollback 'web' 2 -n 'shop' --wait --timeout 10m/.test(c.cmd)))
        assert.throws(() => helm.rollback(cluster, 'shop', 'web', 0, { connect: f.connect }), /Pick a revision/)
        const un = helm.uninstall(cluster, 'shop', 'web', { connect: f.connect }); await helm._test.jobs.get(un.id).promise
        assert.ok(f.calls.some(c => /HELM uninstall 'web' -n 'shop' --wait/.test(c.cmd)))
        const bad = helmCluster({ fail: /upgrade --install/ })
        const jf = await helm.deploy(cluster, helm.cleanDeploy({ release: 'api', namespace: 'shop', chart: 'api' }, repo), { connect: bad.connect })
        await helm._test.jobs.get(jf.id).promise
        assert.equal(helm.findJob(jf.id).status, 'failed'); assert.match(helm.findJob(jf.id).error, /api was not deployed: Error: UPGRADE FAILED: timed out/)
    })

    test('the scripts run in a real shell: Helm found, Helm 4 flag chosen, values read from stdin', { skip: !bash && 'no bash' }, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-helm-sh-'))
        try {
            const f = helmCluster()
            await helm.previewDeploy(cluster, helm.cleanDeploy({ release: 'web', namespace: 'shop', chart: 'web', values: 'a: 1' }, repo), { connect: f.connect }).catch(() => { })
            const preview = f.calls.find(c => /--dry-run=server/.test(c.cmd))
            const unix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
            fs.writeFileSync(path.join(dir, 'sudo'), '#!/bin/bash\nwhile [ "${1#*=}" != "$1" ]; do export "$1"; shift; done\nexec "$@"\n')
            fs.writeFileSync(path.join(dir, 'helm'), `#!/bin/bash\nif [ "$1" = version ]; then echo v4.3.0; exit 0; fi\necho "ARGS:$*" >> '${unix(dir)}/log'\necho "KC:$KUBECONFIG" >> '${unix(dir)}/log'\nif [ "$1" = upgrade ]; then cat > '${unix(dir)}/stdin'; echo '{}'; fi\n`)
            fs.chmodSync(path.join(dir, 'sudo'), 0o755); fs.chmodSync(path.join(dir, 'helm'), 0o755)
            const d = helm.cleanDeploy({ release: 'web', namespace: 'shop', chart: 'web', values: 'a: 1' }, repo)
            const j = await helm.deploy(cluster, d, { connect: async () => ({ execCommand: async (cmd, o) => spawnSync(bash, ['-c', `export PATH="${unix(dir)}:$PATH"; ${cmd}`], { input: o.stdin, encoding: 'utf8' }), dispose() { } }) })
            await helm._test.jobs.get(j.id).promise
            assert.equal(helm.findJob(j.id).status, 'done', helm.findJob(j.id).error || '')
            const log = fs.readFileSync(path.join(dir, 'log'), 'utf8')
            assert.match(log, /ARGS:get values web -n shop -o json|ARGS:upgrade --install web web --repo https:\/\/charts\.acme\.io -n shop --create-namespace -f - --wait --timeout 10m --rollback-on-failure -o json/)
            assert.match(log, /--rollback-on-failure/, 'Helm 4 renamed --atomic')
            assert.match(log, /KC:\/etc\/kubernetes\/admin\.conf/)
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'stdin'), 'utf8')), { a: 1 })
            const r = spawnSync(bash, ['-n', '-c', preview.cmd]); assert.equal(r.status, 0, String(r.stderr))
            const none = spawnSync(bash, ['-c', `export PATH="/nonexistent"; ${helm._test.PRELUDE}`], { encoding: 'utf8' })
            assert.equal(none.status, 3); assert.match(none.stderr, /KZHELM\|NO_HELM\|/)
        } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })
})

describe('GitOps level 2: Argo CD apps KubeEZ creates', () => {
    const ok = { name: 'shop-web', repoURL: 'https://github.com/acme/deploy.git', path: 'apps/web', targetRevision: 'main', namespace: 'team-a' }

    test('requests are checked: https public repos, folder paths, names', () => {
        assert.deepEqual(gitops.cleanCreateApp(ok), { ...ok, autoSync: false })
        for (const b of [{ ...ok, repoURL: 'http://x/y' }, { ...ok, repoURL: 'https://u:tok@github.com/a/b' }, { ...ok, repoURL: 'git@github.com:a/b' }, { ...ok, path: '../../etc' }, { ...ok, path: 'a;b' }, { ...ok, name: 'Shop' }, { ...ok, targetRevision: 'main;x' }, { ...ok, namespace: 'A' }])
            assert.throws(() => gitops.cleanCreateApp(b), (e) => e.status === 400, JSON.stringify(b))
    })

    test('each app gets its own project: one repository, one namespace, nothing cluster-wide, never prune', () => {
        const m = gitops.argoAppManifests({ ...ok, autoSync: true }, 'argocd', 'opsy')
        const [proj, app] = m.items
        assert.equal(proj.kind, 'AppProject'); assert.equal(proj.metadata.name, 'kubeez-shop-web')
        assert.deepEqual(proj.spec.sourceRepos, [ok.repoURL])
        assert.deepEqual(proj.spec.destinations, [{ server: 'https://kubernetes.default.svc', namespace: 'team-a' }])
        assert.deepEqual(proj.spec.clusterResourceWhitelist, [])
        assert.equal(app.spec.project, 'kubeez-shop-web'); assert.equal(app.metadata.labels['app.kubernetes.io/managed-by'], 'kubeez')
        assert.deepEqual(app.spec.syncPolicy.automated, { prune: false, selfHeal: true })
        assert.equal(app.metadata.finalizers, undefined, 'no cascade delete')
        assert.equal(gitops.argoAppManifests(ok, 'argocd').items[1].spec.syncPolicy.automated, undefined)
    })

    test('create: applied in Argo CD\'s namespace; an app KubeEZ did not create is not taken over', async () => {
        const calls = []
        const connect = (owner) => async () => ({ execCommand: async (cmd, o = {}) => { calls.push({ cmd, stdin: o.stdin }); if (/argocd-server/.test(cmd)) return { code: 0, stdout: 'gitops' }; if (/managed-by/.test(cmd)) return owner === null ? { code: 1, stderr: 'NotFound' } : { code: 0, stdout: owner }; return { code: 0, stdout: 'created' } }, dispose() { } })
        const r = await gitops.createArgoApp({ id: 'c' }, gitops.cleanCreateApp(ok), { by: 'opsy', connect: connect(null) })
        assert.equal(r.argoNamespace, 'gitops')
        const apply = calls.find(c => /apply -f -/.test(c.cmd))
        assert.equal(JSON.parse(apply.stdin).items[1].metadata.namespace, 'gitops')
        await assert.rejects(gitops.createArgoApp({ id: 'c' }, gitops.cleanCreateApp(ok), { connect: connect('') }), (e) => e.status === 409 && /not created by KubeEZ/.test(e.message))
        await gitops.createArgoApp({ id: 'c' }, gitops.cleanCreateApp(ok), { connect: connect('kubeez') })
    })

    test('remove: only apps KubeEZ created; what they deployed stays', async () => {
        const calls = []
        const connect = async () => ({ execCommand: async (cmd) => { calls.push(cmd); return { code: 0 } }, dispose() { } })
        await assert.rejects(gitops.deleteArgoApp({ id: 'c' }, { name: 'x', namespace: 'argocd', managed: false }, { connect }), /only the apps it created/)
        const r = await gitops.deleteArgoApp({ id: 'c' }, { name: 'shop-web', namespace: 'argocd', managed: true }, { connect })
        assert.match(calls[0], /delete applications\.argoproj\.io 'shop-web' --cascade=orphan/)
        assert.match(calls[0], /delete appprojects\.argoproj\.io 'kubeez-shop-web'/)
        assert.match(r.message, /still running/)
    })
})

describe('API: who may deploy, where, and when', () => {
    let base, server, approvalStore, repoId
    const U = {
        admin: { id: 'h-admin', username: 'hadmin', orgId: 'org-h', role: 'admin' },
        operator: { id: 'h-op', username: 'hop', orgId: 'org-h', role: 'operator' },
        viewer: { id: 'h-view', username: 'hview', orgId: 'org-h', role: 'viewer' },
        scoped: { id: 'h-sc', username: 'hsc', orgId: 'org-h', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'h1', role: 'operator', namespaces: ['team-a'] }] },
        stranger: { id: 'h-x', username: 'hx', orgId: 'org-x', role: 'admin' }
    }
    const call = async (who, method, p, body) => {
        const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined })
        return { status: r.status, data: await r.json().catch(() => null) }
    }
    const f = helmCluster()
    const gitCalls = []

    before(async () => {
        const express = (await import('express')).default
        const { default: appsRouter } = await import('../src/routes/helmApps.js')
        const { default: deliveryRouter } = await import('../src/routes/delivery.js')
        const { default: gitopsRouter } = await import('../src/routes/gitops.js')
        const { auditTrail } = await import('../src/services/auditLog.js');
        ({ approvalStore } = await import('../src/services/approvalStore.js'))
        helm._test.useConnect(f.connect)
        const ARGO_OUT = `==KZGITOPS:ARGO==\n${JSON.stringify({ items: [{ metadata: { name: 'mine', namespace: 'argocd', labels: { 'app.kubernetes.io/managed-by': 'kubeez' } }, spec: { destination: { server: 'https://kubernetes.default.svc', namespace: 'team-a' }, source: { repoURL: 'https://github.com/a/b' } }, status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } } }, { metadata: { name: 'theirs', namespace: 'argocd' }, spec: { destination: { server: 'https://kubernetes.default.svc', namespace: 'team-a' } }, status: {} }] })}\n==KZGITOPS:KS_ERR==\ndoesn't have a resource type\n==KZGITOPS:HR_ERR==\ndoesn't have a resource type\n==KZGITOPS:GITREPO_ERR==\nx\n==KZGITOPS:END==`
        gitops._test.useConnect(async () => ({ execCommand: async (cmd) => { gitCalls.push(cmd); if (/KZGITOPS/.test(cmd)) return { stdout: ARGO_OUT }; if (/argocd-server/.test(cmd)) return { code: 0, stdout: 'argocd' }; if (/managed-by/.test(cmd)) return { code: 1, stderr: 'NotFound' }; return { code: 0, stdout: 'ok' } }, dispose() { } }))
        const app = express()
        app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use(auditTrail)
        app.use('/api/clusters', appsRouter)
        app.use('/api/clusters', gitopsRouter)
        app.use('/api/delivery', deliveryRouter)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())
    const deployBody = (o = {}) => ({ release: 'web', namespace: 'dev', chart: 'web', version: '1.5.0', repoId, values: 'replicas: 2', ...o })
    const wait = async (id) => { await helm._test.jobs.get(id)?.promise }

    test('delivery settings: admins manage, others read; no passwords leave; another workspace sees nothing', async () => {
        assert.equal((await call('operator', 'POST', '/api/delivery/repos', { name: 'acme', url: 'https://charts.acme.io' })).status, 403)
        const r = await call('admin', 'POST', '/api/delivery/repos', { name: 'acme', url: 'https://charts.acme.io', username: 'bot', password: 'repo-pw' })
        assert.equal(r.status, 200, JSON.stringify(r.data)); repoId = r.data.id
        const list = await call('viewer', 'GET', '/api/delivery/repos')
        assert.equal(list.data.repos.length, 1); assert.equal(list.data.canManage, false); assert.equal(JSON.stringify(list.data).includes('repo-pw'), false)
        assert.equal((await call('stranger', 'GET', '/api/delivery/repos')).data.repos.length, 0)
        assert.equal((await call('operator', 'POST', '/api/delivery/environments', { name: 'prod', clusterId: 'h1', namespace: 'shop', protected: true })).status, 403)
        assert.equal((await call('admin', 'POST', '/api/delivery/environments', { name: 'prod', clusterId: 'h1', namespace: 'shop', protected: true })).status, 200)
        assert.equal((await call('admin', 'POST', '/api/delivery/environments', { name: 'staging', clusterId: 'h2', namespace: 'shop' })).status, 200)
        assert.equal((await call('admin', 'POST', '/api/delivery/environments', { name: 'evil', clusterId: 'hx', namespace: 'shop' })).status, 400, 'not a cluster of this workspace')
        const envs = await call('viewer', 'GET', '/api/delivery/environments')
        assert.deepEqual(envs.data.environments.map(e => `${e.name}@${e.clusterName}`).sort(), ['prod@prod', 'staging@stage'])
        assert.equal((await call('operator', 'POST', '/api/delivery/freezes', { from: new Date().toISOString(), until: new Date(Date.now() + 3600e3).toISOString(), reason: 'nope' })).status, 403)
    })

    test('apps: everyone with app:view sees releases (limited members their namespaces); values only with app:values', async () => {
        const v = await call('viewer', 'GET', '/api/clusters/h1/apps')
        assert.equal(v.status, 200, JSON.stringify(v.data)); assert.equal(v.data.releases.length, 3)
        assert.equal(v.data.releases.find(r => r.name === 'web').environment.name, 'prod'); assert.equal(v.data.releases.find(r => r.name === 'web').environment.protected, true)
        assert.deepEqual(v.data.can, { values: false, deploy: false, delete: false })
        assert.equal((await call('viewer', 'GET', '/api/clusters/h1/apps/shop/web')).data.values, null)
        const op = await call('operator', 'GET', '/api/clusters/h1/apps/shop/web')
        assert.equal(op.data.values.db.password, helm._test.MASK)
        const sc = await call('scoped', 'GET', '/api/clusters/h1/apps')
        assert.deepEqual(sc.data.releases, []); assert.equal(sc.data.hidden, 3)
        assert.equal((await call('scoped', 'GET', '/api/clusters/h1/apps/shop/web')).status, 404)
        assert.equal((await call('stranger', 'GET', '/api/clusters/h1/apps')).status, 404)
        assert.equal((await call('nobody', 'GET', '/api/clusters/h1/apps')).status, 401)
    })

    test('deploy: viewers no; bad requests 400; an unknown repository 400; namespace limits; read-only clusters', async () => {
        assert.equal((await call('viewer', 'POST', '/api/clusters/h1/apps', deployBody())).status, 403)
        assert.equal((await call('operator', 'POST', '/api/clusters/h1/apps', deployBody({ release: 'x;reboot' }))).status, 400)
        assert.equal((await call('operator', 'POST', '/api/clusters/h1/apps', deployBody({ repoId: 'nope' }))).status, 400)
        assert.equal((await call('scoped', 'POST', '/api/clusters/h1/apps', deployBody({ namespace: 'team-b' }))).status, 403)
        assert.equal((await call('admin', 'POST', '/api/clusters/h-ro/apps', deployBody())).status, 409)
        assert.equal((await call('operator', 'POST', '/api/clusters/h1/apps', deployBody({ values: 'a: [1,' }))).status, 400)
    })

    test('deploy into a free environment: a job, the right command, audited; the job is readable', async () => {
        const r = await call('operator', 'POST', '/api/clusters/h1/apps', deployBody())
        assert.equal(r.status, 202, JSON.stringify(r.data)); assert.equal(r.data.status, 'running')
        await wait(r.data.id)
        const j = await call('viewer', 'GET', `/api/clusters/h1/apps/jobs/${r.data.id}`)
        assert.equal(j.data.status, 'done')
        assert.equal((await call('viewer', 'GET', `/api/clusters/h2/apps/jobs/${r.data.id}`)).status, 404, 'a job of another cluster')
        assert.ok(f.calls.some(c => /upgrade --install 'web' 'web' --repo 'https:\/\/charts\.acme\.io' --version '1\.5\.0' --username 'bot' --password 'repo-pw' -n 'dev'/.test(c.cmd)))
        const sp = await call('scoped', 'POST', '/api/clusters/h1/apps', deployBody({ namespace: 'team-a', release: 'mine' }))
        assert.equal(sp.status, 202); await wait(sp.data.id)
    })

    test('preview needs deploy + values rights and returns the diff', async () => {
        assert.equal((await call('viewer', 'POST', '/api/clusters/h1/apps/preview', deployBody())).status, 403)
        const p = await call('operator', 'POST', '/api/clusters/h1/apps/preview', deployBody())
        assert.equal(p.status, 200, JSON.stringify(p.data)); assert.equal(p.data.changes[0].action, 'change')
    })

    test('a protected environment always needs a second person — deploy, rollback and uninstall', async () => {
        const before = f.calls.length
        const d = await call('operator', 'POST', '/api/clusters/h1/apps', deployBody({ namespace: 'shop' }))
        assert.equal(d.status, 428, JSON.stringify(d.data)); assert.match(d.data.summary, /Deploy Helm app shop\/web \(web 1\.5\.0\) on prod/)
        const rb = await call('admin', 'POST', '/api/clusters/h1/apps/shop/web/rollback', { revision: 2 })
        assert.equal(rb.status, 428); assert.match(rb.data.summary, /Roll back Helm app shop\/web on prod to revision 2/)
        const un = await call('admin', 'DELETE', '/api/clusters/h1/apps/shop/web')
        assert.equal(un.status, 428); assert.match(un.data.summary, /Uninstall Helm app shop\/web on prod/)
        assert.equal(f.calls.length, before, 'nothing ran')
        // the workspace setting turns it on for every namespace
        approvalStore.saveSettings('org-h', { actions: { 'app:deploy': true } })
        try { assert.equal((await call('operator', 'POST', '/api/clusters/h1/apps', deployBody())).status, 428) } finally { approvalStore.saveSettings('org-h', { actions: {} }) }
    })

    test('uninstall is admin-only; rollback checks the revision', async () => {
        assert.equal((await call('operator', 'DELETE', '/api/clusters/h1/apps/dev/web')).status, 403)
        const u = await call('admin', 'DELETE', '/api/clusters/h1/apps/dev/web'); assert.equal(u.status, 202); await wait(u.data.id)
        assert.equal((await call('operator', 'POST', '/api/clusters/h1/apps/dev/web/rollback', { revision: 'x' })).status, 400)
        const r = await call('operator', 'POST', '/api/clusters/h1/apps/dev/web/rollback', { revision: 1 }); assert.equal(r.status, 202); await wait(r.data.id)
    })

    test('a change freeze stops operators (423) and lets admins through with a reason', async () => {
        const fr = await call('admin', 'POST', '/api/delivery/freezes', { from: new Date(Date.now() - 60e3).toISOString(), until: new Date(Date.now() + 3600e3).toISOString(), reason: 'Year-end release', clusterIds: ['h1'] })
        assert.equal(fr.status, 200, JSON.stringify(fr.data))
        try {
            const op = await call('operator', 'POST', '/api/clusters/h1/apps', deployBody())
            assert.equal(op.status, 423); assert.equal(op.data.code, 'FROZEN'); assert.match(op.data.error, /Year-end release/)
            assert.equal((await call('operator', 'POST', '/api/clusters/h1/apps/dev/web/rollback', { revision: 1 })).status, 423)
            assert.equal((await call('admin', 'POST', '/api/clusters/h1/apps', deployBody())).status, 423, 'admins too, without a reason')
            const ad = await call('admin', 'POST', '/api/clusters/h1/apps', deployBody({ overrideFreeze: 'hotfix for payments' }))
            assert.equal(ad.status, 202); await wait(ad.data.id)
            assert.equal((await call('operator', 'POST', '/api/clusters/h2/apps', deployBody())).status, 202, 'the freeze covers prod only')
            const list = await call('viewer', 'GET', '/api/clusters/h1/apps')
            assert.equal(list.data.freeze.reason, 'Year-end release')
            // GitOps sync is frozen too
            assert.equal((await call('operator', 'POST', '/api/clusters/h1/gitops/sync', { kind: 'Application', namespace: 'argocd', name: 'mine', action: 'sync' })).status, 423)
        } finally { await call('admin', 'DELETE', `/api/delivery/freezes/${fr.data.id}`) }
        await new Promise(r => setTimeout(r, 50))
        const rows = fs.readdirSync(path.join(DATA, 'audit')).flatMap(x => fs.readFileSync(path.join(DATA, 'audit', x), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
        assert.ok(rows.some(r => r.action === 'POST /api/clusters/:id/apps' && r.ok && /freeze "Year-end release" overridden: hotfix for payments/.test(r.detail || '')))
        assert.ok(rows.some(r => r.action === 'POST /api/clusters/:id/apps' && r.status === 423))
    })

    test('compare an app across environments: values diff (masked), only with app:values on both', async () => {
        const envs = (await call('admin', 'GET', '/api/delivery/environments')).data.environments
        const prod = envs.find(e => e.name === 'prod'), stg = envs.find(e => e.name === 'staging')
        assert.equal((await call('viewer', 'POST', '/api/delivery/compare', { release: 'web', a: prod.id, b: stg.id })).status, 403)
        assert.equal((await call('scoped', 'POST', '/api/delivery/compare', { release: 'web', a: prod.id, b: stg.id })).status, 404)
        const r = await call('operator', 'POST', '/api/delivery/compare', { release: 'web', a: prod.id, b: stg.id })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        assert.equal(r.data.a.release.version, '1.4.2'); assert.deepEqual(r.data.values, [], 'same values on both (the fake answers the same)')
        assert.equal(JSON.stringify(r.data).includes('live-pw'), false)
        assert.equal((await call('operator', 'POST', '/api/delivery/compare', { release: 'x;y', a: prod.id, b: stg.id })).status, 400)
    })

    test('GitOps level 2 through the API: who may create where, and remove only KubeEZ\'s apps', async () => {
        const body = { name: 'shop-web', repoURL: 'https://github.com/acme/deploy.git', path: 'apps/web', namespace: 'team-a' }
        assert.equal((await call('viewer', 'POST', '/api/clusters/h1/gitops/apps', body)).status, 403)
        assert.equal((await call('operator', 'POST', '/api/clusters/h1/gitops/apps', { ...body, repoURL: 'http://x' })).status, 400)
        assert.equal((await call('operator', 'POST', '/api/clusters/h1/gitops/apps', { ...body, namespace: 'kube-system' })).status, 403, 'system namespaces: admins only')
        assert.equal((await call('scoped', 'POST', '/api/clusters/h1/gitops/apps', { ...body, namespace: 'team-b' })).status, 403)
        const c = await call('scoped', 'POST', '/api/clusters/h1/gitops/apps', body)
        assert.equal(c.status, 200, JSON.stringify(c.data)); assert.match(c.data.message, /created in argocd/)
        assert.equal((await call('admin', 'POST', '/api/clusters/h-ro/gitops/apps', body)).status, 409)
        const list = await call('admin', 'GET', '/api/clusters/h1/gitops')
        assert.equal(list.data.canCreate, true)
        assert.equal(list.data.apps.find(a => a.name === 'mine').canDelete, true); assert.equal(list.data.apps.find(a => a.name === 'theirs').canDelete, false)
        assert.equal((await call('operator', 'DELETE', '/api/clusters/h1/gitops/apps/argocd/mine')).status, 403, 'admins only')
        assert.equal((await call('admin', 'DELETE', '/api/clusters/h1/gitops/apps/argocd/theirs')).status, 409)
        assert.equal((await call('admin', 'DELETE', '/api/clusters/h1/gitops/apps/argocd/ghost')).status, 404)
        const d = await call('admin', 'DELETE', '/api/clusters/h1/gitops/apps/argocd/mine')
        assert.equal(d.status, 200); assert.ok(gitCalls.some(x => /delete applications\.argoproj\.io 'mine' --cascade=orphan/.test(x)))
    })
})
