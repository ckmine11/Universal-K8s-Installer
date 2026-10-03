// Offsite (S3 / MinIO) backups — signing, validation, storage of secrets and
// the sync plan. No network: the node is stubbed. The real-MinIO check lives in
// tests/e2e (e2e.sh offsite).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'

const { presign } = await import('../src/utils/s3presign.js')
const { normaliseConfig, offsiteService, sameClusterWarning } = await import('../src/services/offsiteService.js')
const { offsiteStore } = await import('../src/services/offsiteStore.js')

after(() => fs.rmSync(DATA, { recursive: true, force: true }))

test('SigV4 presigning matches the AWS documentation test vector', () => {
    const url = presign({
        provider: 'aws', endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket', region: 'us-east-1',
        accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    }, { method: 'GET', key: 'test.txt', expires: 86400, now: new Date('2013-05-24T00:00:00Z') })
    assert.equal(new URL(url).host, 'examplebucket.s3.amazonaws.com')
    assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
})

test('presigned URLs: path-style for MinIO and for AWS buckets with dots', () => {
    const t = { endpoint: 'https://minio.local:9000', bucket: 'b', region: 'us-east-1', accessKey: 'a', secretKey: 's' }
    assert.match(presign({ ...t, provider: 'minio' }, { method: 'PUT', key: 'x/y.enc' }), /^https:\/\/minio\.local:9000\/b\/x\/y\.enc\?/)
    assert.match(presign({ ...t, provider: 'aws', endpoint: 'https://s3.ap-south-1.amazonaws.com', bucket: 'my.bucket' }, { method: 'GET', key: 'k' }),
        /^https:\/\/s3\.ap-south-1\.amazonaws\.com\/my\.bucket\/k\?/)
})

test('config validation gives user-facing messages', () => {
    const ok = { provider: 'aws', region: 'ap-south-1', bucket: 'kubeez-backups', accessKey: 'A', secretKey: 'S' }
    assert.equal(normaliseConfig(ok).endpoint, 'https://s3.ap-south-1.amazonaws.com')
    assert.equal(normaliseConfig(ok).prefix, 'kubeez')
    assert.throws(() => normaliseConfig({ ...ok, provider: 'ftp' }), /AWS S3, MinIO/)
    assert.throws(() => normaliseConfig({ ...ok, bucket: 'Bad_Bucket' }), /Bucket name/)
    assert.throws(() => normaliseConfig({ ...ok, region: 'mumbai' }), /region/)
    assert.throws(() => normaliseConfig({ ...ok, secretKey: '' }), /secret key are required/)
    const m = { provider: 'minio', endpoint: 'https://minio.local:9000/', bucket: 'b-1', accessKey: 'A', secretKey: 'S' }
    assert.equal(normaliseConfig(m).endpoint, 'https://minio.local:9000')
    assert.equal(normaliseConfig(m).region, 'us-east-1')
    assert.throws(() => normaliseConfig({ ...m, endpoint: 'https://minio.local:9000/bucket' }), /scheme:\/\/host/)
    assert.throws(() => normaliseConfig({ ...m, endpoint: 'ftp://x' }), /http/)
    assert.throws(() => normaliseConfig({ ...m, prefix: '../etc' }), /Folder prefix/)
    // editing an existing connection: blank keys = keep the saved ones
    assert.equal(normaliseConfig({ ...m, accessKey: '', secretKey: '' }, { accessKey: 'OLD', secretKey: 'OLDS' }).secretKey, 'OLDS')
})

test('store: secrets encrypted at rest, recovery key shown once and kept after disconnect', () => {
    const cfg = normaliseConfig({ provider: 'minio', endpoint: 'http://m:9000', bucket: 'bkt', accessKey: 'AKEYXYZ', secretKey: 'SuperSecret/+=' })
    const first = offsiteStore.connect('org-a', cfg)
    assert.match(first.recoveryKey, /^[0-9a-f]{64}$/)
    assert.equal(offsiteStore.connect('org-a', cfg).recoveryKey, null, 'no new key on reconnect')

    const raw = fs.readFileSync(path.join(DATA, 'offsite.json'), 'utf8')
    assert.ok(!raw.includes('SuperSecret') && !raw.includes('AKEYXYZ') && !raw.includes(first.recoveryKey))

    const view = offsiteStore.publicView('org-a')
    assert.equal(view.accessKeyHint, '••••YXYZ')
    assert.ok(!JSON.stringify(view).includes('SuperSecret'))

    offsiteStore.disconnect('org-a')
    assert.equal(offsiteStore.getConnected('org-a'), null)
    assert.equal(offsiteStore.get('org-a').encKey, first.recoveryKey, 'encryption key survives disconnect')
    assert.equal(offsiteStore.connect('org-a', cfg).recoveryKey, null, 'reconnect reuses the old key')
    assert.equal(offsiteStore.publicView('org-b').connected, false)
})

test('sync plan: uploads missing snapshots, deletes >45-day bundles, keeps the newest', async () => {
    const day = (d) => { const t = new Date(Date.now() - d * 86400000); const p = (n) => String(n).padStart(2, '0'); return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-120000` }
    const local = [`etcd-manual-${day(1)}.db`, `etcd-pre-upgrade-${day(10)}.db`]
    const remote = [`etcd-pre-upgrade-${day(10)}.tar.gz.enc`, `etcd-manual-${day(50)}.tar.gz.enc`, `etcd-manual-${day(44)}.tar.gz.enc`]
    const target = { provider: 'minio', endpoint: 'http://m:9000', bucket: 'b', region: 'us-east-1', prefix: 'kubeez', accessKey: 'a', secretKey: 's', encKey: 'k' }
    const calls = []
    const orig = offsiteService._run
    offsiteService._run = async (cluster, mode, entries) => {
        calls.push({ mode, entries })
        if (mode === 'inventory') return { ok: true, local, remote: remote.map(n => `kubeez/c1/${n}`) }
        return { ok: true, uploaded: String(entries.filter(e => e[0] === 'UPLOAD').length), deleted: String(entries.filter(e => e[0] === 'DELETE').length) }
    }
    try {
        const r = await offsiteService.sync({ id: 'c1' }, target)
        const up = calls[1].entries.filter(e => e[0] === 'UPLOAD').map(e => e[1].split('|')[0])
        const del = calls[1].entries.filter(e => e[0] === 'DELETE').map(e => decodeURIComponent(new URL(e[1]).pathname))
        assert.deepEqual(up, [local[0]], 'only the snapshot not yet offsite')
        assert.equal(del.length, 1)
        assert.match(del[0], new RegExp(`/b/kubeez/c1/etcd-manual-${day(50)}`), 'only the >45-day bundle')
        assert.ok(!calls[1].entries.some(e => /secretKey|s3cret/.test(e[1])), 'no storage secret sent to the node')
        assert.deepEqual({ ok: r.ok, uploaded: r.uploaded, deleted: r.deleted, total: r.total }, { ok: true, uploaded: 1, deleted: 1, total: 3 })

        // Everything old: the newest offsite bundle is still kept
        calls.length = 0
        const oldOnly = [`etcd-manual-${day(60)}.tar.gz.enc`, `etcd-manual-${day(70)}.tar.gz.enc`]
        offsiteService._run = async (c, mode, entries) => {
            calls.push({ mode, entries })
            return mode === 'inventory' ? { ok: true, local: [], remote: oldOnly.map(n => `kubeez/c1/${n}`) } : { ok: true, uploaded: '0', deleted: '1' }
        }
        await offsiteService.sync({ id: 'c1' }, target)
        const del2 = calls[1].entries.filter(e => e[0] === 'DELETE').map(e => new URL(e[1]).pathname)
        assert.equal(del2.length, 1)
        assert.match(del2[0], new RegExp(day(70)), 'the older one goes, the newest stays')
    } finally {
        offsiteService._run = orig
    }
})

test('storage on a node of the same cluster is flagged as not offsite', () => {
    const cluster = { masterNodes: [{ ip: '192.168.220.80' }], workerNodes: [{ ip: '192.168.220.81', hostname: 'worker1' }] }
    assert.match(sameClusterWarning(cluster, 'http://192.168.220.80:30833'), /node of this cluster/)
    assert.match(sameClusterWarning(cluster, 'http://WORKER1:30833'), /node of this cluster/)
    assert.equal(sameClusterWarning(cluster, 'http://192.168.220.90:30833'), null)
    assert.equal(sameClusterWarning(cluster, 'https://s3.us-east-1.amazonaws.com'), null)
})

// Run the node-side script's connection test against a local HTTP server
async function nodeTest(handler) {
    const srv = http.createServer(handler)
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${srv.address().port}/bucket/probe`
    const b64 = (v) => Buffer.from(v).toString('base64')
    const input = ['KZ_PUT', 'KZ_GET', 'KZ_DEL'].map(k => `${k}=${b64(url)}`)
        .concat(`KZ_HOST=${b64('127.0.0.1:' + srv.address().port)}`).join('\n') + '\n'
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/automation/etcd-offsite-node.sh')
    const out = await new Promise(resolve => {
        const p = execFile('bash', [script, 'test'], (err, stdout) => resolve(stdout))
        p.stdin.end(input)
    })
    srv.close()
    return out.split('\n').find(l => l.startsWith('OFFSITE_')) || out
}

test('node script: a web page / wrong port is reported as "not an S3 API"', async () => {
    const line = await nodeTest((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<!doctype html><title>SeaweedFS Admin</title>') })
    assert.match(line, /^OFFSITE_FAIL\|WRONG_ENDPOINT\|.*30833/)
})

test('node script: a real S3 error is still reported precisely', async () => {
    const line = await nodeTest((req, res) => { res.writeHead(404, { 'content-type': 'application/xml' }); res.end('<Error><Code>NoSuchBucket</Code><Message>bucket missing</Message></Error>') })
    assert.match(line, /^OFFSITE_FAIL\|NO_BUCKET\|/)
})
