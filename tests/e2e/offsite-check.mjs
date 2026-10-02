// Offsite backups against a REAL MinIO server and a REAL kubeadm node.
// Run via: bash tests/e2e/e2e.sh offsite <distro>   (starts MinIO + the node)
// Uses the backend's own services; only SSH is replaced by 'docker exec'.
process.env.APP_SECRET = 'test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-off-'))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { offsiteService, normaliseConfig } = await import('../../backend/src/services/offsiteService.js')
const { offsiteStore } = await import('../../backend/src/services/offsiteStore.js')
const { etcdBackupService } = await import('../../backend/src/services/etcdBackupService.js')

const NODE = process.env.NODE_CONTAINER
const MINIO = process.env.MINIO_CONTAINER
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd, c = NODE) => { const r = spawnSync('docker', ['exec', c, 'bash', '-c', cmd], { encoding: 'utf8', env }); return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' } }
automationEngine.connectSSH = async () => ({ execCommand: async (cmd) => dx(cmd), dispose() {} })
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const SECRET = 'S3cr3t/with+chars=AndLong'
const cluster = { id: 'c-test', masterNodes: [{ ip: 'node' }] }
const base = { provider: 'minio', endpoint: `http://${process.env.MINIO_IP}:9000`, bucket: 'kubeez-backups', prefix: 'kubeez', accessKey: 'kzadmin', secretKey: SECRET }

let r = await offsiteService.test(cluster, normaliseConfig({ ...base, bucket: 'no-such-bucket' }))
ok(!r.ok && r.code === 'NO_BUCKET', 'wrong bucket → NO_BUCKET: ' + r.error)
ok(dx('test -x /usr/local/bin/kubeez-mc').code !== 0, 'no third-party S3 client needed on the node (plain curl)')
ok(!/S3cr3t|kzadmin/.test(dx('cat /usr/local/sbin/kubeez-etcd-offsite; ls /tmp')).valueOf(), 'node never stores the storage keys')
r = await offsiteService.test(cluster, normaliseConfig({ ...base, secretKey: 'wrong-secret' }))
ok(!r.ok && r.code === 'BAD_KEYS', 'wrong secret → BAD_KEYS: ' + r.error)
r = await offsiteService.test(cluster, normaliseConfig({ ...base, endpoint: 'http://10.255.255.1:9000' }))
ok(!r.ok && r.code === 'UNREACHABLE', 'unreachable endpoint → UNREACHABLE: ' + (r.error || '').slice(0, 90))
r = await offsiteService.test(cluster, normaliseConfig(base))
ok(r.ok, 'correct config (secret contains / + =) → test passes ' + (r.error || ''))

const { recoveryKey } = offsiteStore.connect('org1', normaliseConfig(base))
ok(/^[0-9a-f]{64}$/.test(recoveryKey), 'recovery key generated on first connect')
ok(offsiteStore.connect('org1', normaliseConfig(base)).recoveryKey === null, 'reconnect keeps the same key')
ok(!fs.readFileSync(path.join(process.env.KUBEEZ_DATA_DIR, 'offsite.json'), 'utf8').includes('S3cr3t'), 'keys stored encrypted on disk')
const target = offsiteStore.getConnected('org1')

const snap = await etcdBackupService.createBackup(cluster)
ok(snap.success, 'manual snapshot: ' + snap.filename)
r = await offsiteService.sync(cluster, target)
ok(r.ok && r.uploaded >= 1 && r.total === r.uploaded, 'sync uploaded every local snapshot ' + JSON.stringify({ up: r.uploaded, total: r.total, err: r.error }))
r = await offsiteService.sync(cluster, target)
ok(r.ok && r.uploaded === 0, 'second sync uploads nothing')
r = await offsiteService.list(cluster, target)
const obj = snap.filename.replace(/\.db$/, '.tar.gz.enc')
ok(r.ok && r.remote.includes(obj), 'list shows the bundle ' + obj)

// Fetch the bundle straight from MinIO, decrypt with ONLY the recovery key
dx(`mc alias set l http://127.0.0.1:9000 kzadmin '${SECRET}' >/dev/null && mc cp l/kubeez-backups/kubeez/c-test/${obj} /tmp/b.enc >/dev/null`, MINIO)
const tmp = path.join(os.tmpdir(), 'kz-b.enc')
spawnSync('docker', ['cp', `${MINIO}:/tmp/b.enc`, tmp], { env })
spawnSync('docker', ['cp', tmp, `${NODE}:/tmp/b.enc`], { env })
const d = dx(`rm -rf /tmp/rec && mkdir -p /tmp/rec && cd /tmp/rec && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:${recoveryKey} -in /tmp/b.enc | tar xz && ls -1 && sha256sum etcd-snapshot.db | cut -c1-16 && sha256sum /var/lib/etcd-backup/${snap.filename} | cut -c1-16 && test -f pki/ca.key && echo HAS_CA_KEY`)
const lines = d.stdout.trim().split('\n')
ok(['etcd-snapshot.db', 'MANIFEST', 'kubeadm-config.yaml', 'pki'].every(f => lines.includes(f)), 'bundle = snapshot + pki + kubeadm config + manifest')
ok(lines.includes('HAS_CA_KEY'), 'bundle includes the cluster CA key (needed for DR)')
const sums = lines.filter(l => /^[0-9a-f]{16}$/.test(l))
ok(sums.length === 2 && sums[0] === sums[1], 'decrypted snapshot is byte-identical to the local one')
ok(dx('openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:wrongkey -in /tmp/b.enc 2>/dev/null | tar tz >/dev/null 2>&1').code !== 0, 'a wrong key cannot decrypt it')

// Offsite retention: a 2025 bundle is deleted, the newest is kept
dx('echo x | mc pipe l/kubeez-backups/kubeez/c-test/etcd-manual-20250101-000000.tar.gz.enc >/dev/null', MINIO)
r = await offsiteService.sync(cluster, target)
ok(r.ok && r.deleted === 1, 'offsite bundle older than 45 days deleted ' + JSON.stringify({ del: r.deleted, err: r.error }))
r = await offsiteService.list(cluster, target)
ok(r.remote.includes(obj) && !r.remote.some(n => n.includes('20250101')), 'newest kept, old one gone')
console.log(fails ? fails + ' FAILED' : 'ALL PASSED')
process.exit(fails ? 1 : 0)
