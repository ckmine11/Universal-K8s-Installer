// etcd restore safety + volume backups — the parts that need no cluster:
// the restore preview, background jobs, route guards (typed confirmation,
// one operation per cluster, plan), and Velero input validation. Real
// clusters: tests/e2e (e2e.sh restore / restore-ha / recover / velero).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir, startServer, client } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'

const { computePreview, parseKey } = await import('../src/services/restorePreview.js')
const { etcdJobs } = await import('../src/services/etcdJobs.js')
const { snapshotType, SNAPSHOT_RE } = await import('../src/services/etcdBackupService.js')
const { volumeBackupService, summarizeBackup } = await import('../src/services/volumeBackupService.js')
const { volumeBackupStore } = await import('../src/services/volumeBackupStore.js')

after(() => fs.rmSync(DATA, { recursive: true, force: true }))

test('etcd keys → objects (resource paths, custom resources, noise filtered)', () => {
    assert.deepEqual(parseKey('/registry/deployments/shop/api'), { kind: 'Deployment', namespace: 'shop', name: 'api', trackEdits: true })
    assert.equal(parseKey('/registry/services/specs/shop/web').kind, 'Service')
    assert.equal(parseKey('/registry/services/endpoints/shop/web'), null, 'endpoints are bookkeeping')
    assert.equal(parseKey('/registry/namespaces/shop').namespace, null)
    assert.equal(parseKey('/registry/minions/node-1').kind, 'Node')
    assert.equal(parseKey('/registry/leases/kube-node-lease/node-1'), null)
    assert.equal(parseKey('/registry/events/shop/x.123'), null)
    assert.equal(parseKey('/registry/pods/shop/api-123'), null, 'pods are recreated by controllers')
    assert.equal(parseKey('/registry/configmaps/shop/kube-root-ca.crt'), null)
    assert.equal(parseKey('/registry/apiregistration.k8s.io/apiservices/v1.apps'), null)
    const cr = parseKey('/registry/cert-manager.io/certificates/shop/tls')
    assert.deepEqual([cr.kind, cr.namespace, cr.name, cr.custom], ['certificates.cert-manager.io', 'shop', 'tls', true])
    assert.equal(parseKey('/registry/cilium.io/ciliumendpoints/shop/x'), null, 'per-pod CRs are noise')
    assert.equal(parseKey('/registry/apiextensions.k8s.io/customresourcedefinitions/certificates.cert-manager.io').kind, 'CustomResourceDefinition')
})

test('preview: removed / comes back / reverted, volume warnings, failures', () => {
    const out = [
        'SNAPREV|1000',
        'S|/registry/namespaces/shop',
        'S|/registry/deployments/shop/api',
        'S|/registry/deployments/shop/old',
        'S|/registry/configmaps/shop/settings',
        'S|/registry/persistentvolumeclaims/shop/gone-data',
        'S|/registry/deployments/kube-system/coredns',
        'L|/registry/namespaces/shop|5',
        'L|/registry/deployments/shop/api|900',
        'L|/registry/configmaps/shop/settings|1500',
        'L|/registry/deployments/kube-system/coredns|2000',
        'L|/registry/namespaces/newer|1200',
        'L|/registry/persistentvolumeclaims/newer/data|1300',
        'L|/registry/pods/shop/api-xyz|1600',
        'PREVIEW_OK'
    ].join('\n')
    const p = computePreview(out)
    assert.equal(p.ok, true)
    assert.equal(p.snapshotRevision, 1000)
    const names = (l) => p[l].map(o => `${o.kind}:${o.namespace || ''}/${o.name}`).sort()
    assert.deepEqual(names('removed'), ['Namespace:/newer', 'PersistentVolumeClaim:newer/data'])
    assert.deepEqual(names('restored'), ['Deployment:shop/old', 'PersistentVolumeClaim:shop/gone-data'])
    assert.deepEqual(names('reverted'), ['ConfigMap:shop/settings', 'Deployment:kube-system/coredns'])
    assert.equal(p.reverted[p.reverted.length - 1].namespace, 'kube-system', 'system namespaces sort last')
    assert.deepEqual(p.warnings.map(w => w.code).sort(), ['VOLUMES_CREATED_AFTER', 'VOLUMES_DELETED_AFTER'])
    assert.deepEqual(p.counts, { removed: 2, restored: 2, reverted: 2 })

    assert.deepEqual(computePreview('PREVIEW_FAIL|DAMAGED|checksum mismatch').code, 'DAMAGED')
    assert.equal(computePreview('VERIFY_FAIL|snapshot not found on this node').error, 'snapshot not found on this node')
    assert.equal(computePreview('some noise').ok, false, 'no PREVIEW_OK → not ok')
})

test('snapshot names: types and the strict filename rule', () => {
    assert.equal(snapshotType('etcd-pre-upgrade-20260101-010101.db'), 'pre-upgrade')
    assert.equal(snapshotType('etcd-pre-restore-20260101-010101.db'), 'pre-restore')
    assert.equal(snapshotType('etcd-manual-20260101-010101.db'), 'manual')
    for (const bad of ['../x.db', 'a b.db', 'x.db;rm', 'x', '$(id).db', 'x/y.db']) assert.equal(SNAPSHOT_RE.test(bad), false, bad)
})

test('jobs: one at a time per cluster, result / error / progress kept', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const j = etcdJobs.start('c1', 'restore', async ({ log, progress }) => {
        log('info', 'step 1'); progress(40, 'Restoring'); progress(20)   // never goes backwards
        await gate
        return { safetySnapshot: 'etcd-pre-restore-x.db' }
    })
    assert.equal(etcdJobs.activeFor('c1').id, j.id)
    assert.throws(() => etcdJobs.start('c1', 'backup', async () => {}), (e) => e.status === 409 && e.jobId === j.id)
    await new Promise(r => setTimeout(r, 5))   // the job body starts on the next tick
    assert.equal(etcdJobs.view(j).progress, 40)
    assert.equal(etcdJobs.view(j).step, 'Restoring')
    etcdJobs.start('c2', 'backup', async () => {})   // other clusters are independent
    release()
    await new Promise(r => setTimeout(r, 20))
    assert.equal(etcdJobs.get(j.id).status, 'succeeded')
    assert.equal(etcdJobs.get(j.id).result.safetySnapshot, 'etcd-pre-restore-x.db')
    assert.equal(etcdJobs.activeFor('c1'), null)

    const f = etcdJobs.start('c1', 'restore', async () => { throw Object.assign(new Error('rolled back'), { result: { safetySnapshot: 's.db' } }) })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(etcdJobs.get(f.id).status, 'failed')
    assert.equal(etcdJobs.get(f.id).error, 'rolled back')
    assert.equal(etcdJobs.get(f.id).result.safetySnapshot, 's.db', 'the safety snapshot is reported even on failure')
})

test('volume backups: input is validated before anything reaches the node', async () => {
    const cluster = { masterNodes: [{ ip: '10.0.0.1' }] }
    const reject = (p, re) => assert.rejects(p, re)
    // validation happens before any SSH → no node needed
    await assert.rejects(async () => volumeBackupService.backupNow(cluster, { namespaces: ['ok', 'bad;rm -rf /'] }), /Invalid namespace/)
    await reject(async () => volumeBackupService.restore(cluster, '../x', {}), /Invalid backup name/)
    await reject(async () => volumeBackupService.restore(cluster, 'b1', { mode: 'wipe' }), /Invalid restore mode/)
    await reject(async () => volumeBackupService.restore(cluster, 'b1', { mode: 'copy', namespaces: [] }), /Choose the namespaces/)
    await reject(async () => volumeBackupService.restore(cluster, 'b1', { mode: 'replace', namespaces: ['kube-system'] }), /cannot be replaced/)
    await reject(async () => volumeBackupService.setSchedule(cluster, { enabled: true, cron: '* * * * * ; reboot' }), /Invalid schedule/)
    await reject(async () => volumeBackupService.describe(cluster, 'secret', 'x'), /Invalid name/)

    const b = summarizeBackup({ metadata: { name: 'b1', labels: { 'velero.io/schedule-name': 'kubeez-daily' } }, spec: { includedNamespaces: ['shop'] }, status: { phase: 'Completed', progress: { itemsBackedUp: 5, totalItems: 5 }, errors: 0 } })
    assert.deepEqual([b.phase, b.schedule, b.namespaces[0], b.items.done], ['Completed', 'kubeez-daily', 'shop', 5])
    assert.deepEqual(summarizeBackup({ metadata: { name: 'b2' }, spec: {} }).namespaces, ['*'])
})

test('volume backup settings: keys encrypted at rest, never in the public view', () => {
    volumeBackupStore.save('c-vb', { provider: 'minio', endpoint: 'http://m:9000', region: 'us-east-1', bucket: 'velero', prefix: 'p', accessKey: 'VAKEY123', secretKey: 'V-Secret/+=' })
    const raw = fs.readFileSync(`${DATA}/volume-backups.json`, 'utf8')
    assert.ok(!raw.includes('V-Secret') && !raw.includes('VAKEY123'))
    assert.equal(volumeBackupStore.get('c-vb').secretKey, 'V-Secret/+=')
    const v = volumeBackupStore.publicView('c-vb')
    assert.equal(v.accessKeyHint, '••••Y123')
    assert.ok(!JSON.stringify(v).includes('V-Secret'))
})

test('routes: typed cluster name, valid names, plan gate; one operation per cluster; upgrade waits', async () => {
    const srv = await startServer()
    const api = client(srv)
    try {
        const root = (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data
        const bob = (await api('POST', '/api/auth/register', null, { username: 'bobrs', password: 'bobpass123', email: 'bob@example.com' })).data
        // 203.0.113.0/24 (TEST-NET-3) is unroutable → SSH stays in its connect timeout
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
            { id: 'c-rs', ownerId: bob.user.id, orgId: bob.user.orgId, clusterName: 'prod-eu', k8sVersion: '1.35.0', status: 'healthy',
              masterNodes: [{ ip: '203.0.113.77', username: 'root', password: 'x' }], workerNodes: [] }
        ]))
        const post = (p, body) => api('POST', `/api/clusters/c-rs${p}`, bob.token, body)
        const snap = 'etcd-manual-20260101-000000.db'

        let r = await post('/etcd/restore', { filename: snap, confirm: 'prod-eu' })
        assert.equal(r.status, 402, 'Free plan: paid feature')
        assert.equal((await api('PUT', '/api/clusters/c-rs/volume-backups/config', bob.token, {})).status, 402)

        await api('PUT', `/api/superadmin/users/${bob.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 10, maxNodes: 50, maxMembers: 5 })
        r = await post('/etcd/restore', { filename: '../../etc/passwd', confirm: 'prod-eu' })
        assert.equal(r.status, 400)
        r = await post('/etcd/restore', { filename: snap, confirm: 'prod' })
        assert.equal(r.status, 400)
        assert.match(r.data.error, /Type the cluster name \(prod-eu\)/)
        r = await post('/etcd/recover', { filename: snap, confirm: 'prod-eu' })
        assert.equal(r.status, 400, 'recovery needs offsite storage')
        assert.match(r.data.error, /offsite/)
        r = await post('/etcd/offsite/fetch', { filename: snap })
        assert.equal(r.status, 400)
        r = await api('PUT', '/api/clusters/c-rs/volume-backups/config', bob.token, { useOffsite: true })
        assert.equal(r.status, 400, 'no offsite storage to reuse')
        r = await api('PUT', '/api/clusters/c-rs/volume-backups/config', bob.token, { provider: 'minio', endpoint: 'http://203.0.113.77:9000', bucket: 'velero', accessKey: 'a', secretKey: 's' })
        assert.equal(r.status, 400, 'storage on a node of this cluster is refused without consent')
        assert.match(r.data.error, /node of this cluster/)

        // Backup Now → background job (202); while it runs, everything else waits
        r = await post('/etcd/backups', {})
        assert.equal(r.status, 202)
        const jobId = r.data.jobId
        r = await post('/etcd/restore', { filename: snap, confirm: 'prod-eu' })
        assert.equal(r.status, 409)
        assert.equal(r.data.jobId, jobId)
        r = await post('/upgrade', { targetVersion: '1.36.0' })
        assert.equal(r.status, 409)
        assert.match(r.data.error, /etcd backup is still running/)
        r = await api('GET', `/api/clusters/c-rs/etcd/jobs/${jobId}`, bob.token)
        assert.equal(r.status, 200)
        assert.equal(r.data.kind, 'backup')
        assert.equal(r.data.status, 'running')

        // Other workspaces cannot read the job
        const eve = (await api('POST', '/api/auth/register', null, { username: 'evers', password: 'evepass123', email: 'eve@example.com' })).data
        assert.equal((await api('GET', `/api/clusters/c-rs/etcd/jobs/${jobId}`, eve.token)).status, 403)
    } finally {
        await srv.stop()
    }
})
