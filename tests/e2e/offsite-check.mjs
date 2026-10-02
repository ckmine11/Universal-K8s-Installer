// S3 Object Storage add-on (SeaweedFS) + offsite etcd backups, on a REAL node.
// Run via: bash tests/e2e/e2e.sh offsite <distro>
// The add-on is installed on the node first; the checks then use it as an
// "other cluster's" S3 target. Uses the backend's own services — only SSH is
// replaced by 'docker exec'. Out-of-band S3 calls use presigned URLs + curl.
process.env.APP_SECRET = 'test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-offsite-'))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { addonAccessService } = await import('../../backend/src/services/addonAccessService.js')
const { offsiteService, normaliseConfig } = await import('../../backend/src/services/offsiteService.js')
const { offsiteStore } = await import('../../backend/src/services/offsiteStore.js')
const { etcdBackupService } = await import('../../backend/src/services/etcdBackupService.js')
const { presign } = await import('../../backend/src/utils/s3presign.js')

const NODE = process.env.NODE_CONTAINER
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd) => { const r = spawnSync('docker', ['exec', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env }); return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' } }
automationEngine.connectSSH = async () => ({ execCommand: async (cmd) => dx(cmd), dispose() {} })
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const K = 'KUBECONFIG=/etc/kubernetes/admin.conf kubectl'
const nodeIp = dx('hostname -I').stdout.trim().split(' ')[0]
const cluster = { id: 'c-test', masterNodes: [{ ip: nodeIp }] }

// ── Add-on ──────────────────────────────────────────────────────────────────
console.log('— S3 Object Storage add-on (SeaweedFS)')
const info = await addonAccessService.getAccessInfo(cluster)
const sw = info.addons.find(a => a.key === 'seaweedfs')
ok(!!sw, 'access panel lists the add-on')
ok(sw?.url === `http://${nodeIp}:30833`, 'S3 endpoint shown: ' + sw?.url)
ok(/^KZ[0-9A-F]{18}$/.test(sw?.auth?.username || '') && (sw?.auth?.password || '').length === 40, 'generated access key + secret key shown')
dx('bash /k/seaweedfs.sh > /tmp/sw-again.log 2>&1')
const again = (await addonAccessService.getAccessInfo(cluster)).addons.find(a => a.key === 'seaweedfs')
ok(again?.auth?.password === sw?.auth?.password, 're-install keeps the same credentials')

const base = { provider: 'other', endpoint: sw.url, bucket: 'backups', prefix: 'kubeez', accessKey: sw.auth.username, secretKey: sw.auth.password }
const t = normaliseConfig(base)
const persistPut = presign(t, { method: 'PUT', key: 'persist/check.txt' })
dx(`echo survive-restart > /tmp/p.txt && curl -s -o /dev/null -T /tmp/p.txt '${persistPut}'`)
dx(`${K} -n seaweedfs delete pod -l app=seaweedfs --wait=true >/dev/null && ${K} -n seaweedfs rollout status deploy/seaweedfs --timeout=180s >/dev/null`)
let body = ''
for (let i = 0; i < 20; i++) { body = dx(`curl -s '${presign(t, { method: 'GET', key: 'persist/check.txt' })}'`).stdout.trim(); if (body === 'survive-restart') break; dx('sleep 3') }
ok(body === 'survive-restart', 'data survives the pod being deleted and recreated')

// ── Offsite backups against it ──────────────────────────────────────────────
console.log('— Offsite etcd backups')
let r = await offsiteService.test(cluster, normaliseConfig({ ...base, bucket: 'no-such-bucket' }))
ok(!r.ok && r.code === 'NO_BUCKET', 'wrong bucket → NO_BUCKET')
r = await offsiteService.test(cluster, normaliseConfig({ ...base, secretKey: 'wrong-secret' }))
ok(!r.ok && r.code === 'BAD_KEYS', 'wrong secret → BAD_KEYS')
r = await offsiteService.test(cluster, normaliseConfig({ ...base, endpoint: 'http://10.255.255.1:9000' }))
ok(!r.ok && r.code === 'UNREACHABLE', 'unreachable endpoint → UNREACHABLE')
r = await offsiteService.test(cluster, t)
ok(r.ok, 'correct config → test passes ' + (r.error || ''))
ok(!dx(`grep -rl '${sw.auth.password}' /usr/local/sbin /etc/kubeez /tmp 2>/dev/null`).stdout.trim(), 'the node never stores the storage secret')

const { recoveryKey } = offsiteStore.connect('org1', t)
ok(/^[0-9a-f]{64}$/.test(recoveryKey), 'recovery key generated on first connect')
const target = offsiteStore.getConnected('org1')

const snap = await etcdBackupService.createBackup(cluster)
ok(snap.success, 'manual snapshot ' + snap.filename)
r = await offsiteService.sync(cluster, target)
ok(r.ok && r.uploaded >= 1 && r.total === r.uploaded, 'sync uploaded every local snapshot ' + JSON.stringify({ up: r.uploaded, total: r.total, err: r.error }))
r = await offsiteService.sync(cluster, target)
ok(r.ok && r.uploaded === 0, 'second sync uploads nothing')
const obj = snap.filename.replace(/\.db$/, '.tar.gz.enc')
r = await offsiteService.list(cluster, target)
ok(r.ok && r.remote.includes(obj), 'list shows the bundle')

// Fetch the bundle from the bucket and decrypt it with ONLY the recovery key
const get = presign(target, { method: 'GET', key: `kubeez/c-test/${obj}` })
const d = dx(`rm -rf /tmp/rec && mkdir -p /tmp/rec && cd /tmp/rec && curl -s -o /tmp/b.enc '${get}' && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:${recoveryKey} -in /tmp/b.enc | tar xz && ls -1 && sha256sum etcd-snapshot.db | cut -c1-16 && sha256sum /var/lib/etcd-backup/${snap.filename} | cut -c1-16 && test -f pki/ca.key && echo HAS_CA_KEY`)
const lines = d.stdout.trim().split('\n')
ok(['etcd-snapshot.db', 'MANIFEST', 'kubeadm-config.yaml', 'pki'].every(f => lines.includes(f)), 'bundle = snapshot + pki + kubeadm config + manifest')
ok(lines.includes('HAS_CA_KEY'), 'bundle includes the cluster CA key (needed for DR)')
const sums = lines.filter(l => /^[0-9a-f]{16}$/.test(l))
ok(sums.length === 2 && sums[0] === sums[1], 'decrypted snapshot is byte-identical to the local one')
ok(dx('openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:wrongkey -in /tmp/b.enc 2>/dev/null | tar tz >/dev/null 2>&1').code !== 0, 'a wrong key cannot decrypt it')

// Offsite retention: a 2025 bundle is deleted, the newest is kept
const old = presign(target, { method: 'PUT', key: 'kubeez/c-test/etcd-manual-20250101-000000.tar.gz.enc' })
dx(`echo x > /tmp/old && curl -s -o /dev/null -T /tmp/old '${old}'`)
r = await offsiteService.sync(cluster, target)
ok(r.ok && r.deleted === 1, 'offsite bundle older than 45 days deleted')
r = await offsiteService.list(cluster, target)
ok(r.remote.includes(obj) && !r.remote.some(n => n.includes('20250101')), 'newest kept, old one gone')

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
