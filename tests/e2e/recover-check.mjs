// Disaster recovery on REAL nodes: the control-plane machine is destroyed and
// replaced by a fresh one with the same IP; KubeEZ rebuilds it from the
// encrypted offsite backup. Also: a snapshot whose local copy is gone is
// fetched back from offsite (restore from offsite).
// Run via: bash tests/e2e/e2e.sh recover [distro]
process.env.APP_SECRET = 'test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-recover-'))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { etcdBackupService } = await import('../../backend/src/services/etcdBackupService.js')
const { offsiteService, normaliseConfig } = await import('../../backend/src/services/offsiteService.js')
const { offsiteStore } = await import('../../backend/src/services/offsiteStore.js')
const { disasterRecovery } = await import('../../backend/src/services/disasterRecovery.js')

const MASTER = process.env.MASTER_CONTAINER
const WORKERS = (process.env.WORKER_CONTAINERS || '').split(',').filter(Boolean)
const E2E = path.dirname(fileURLToPath(import.meta.url))
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (c, cmd) => { const r = spawnSync('docker', ['exec', c, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 64 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const ipOf = (c) => dx(c, 'hostname -I').stdout.split(' ')[0]
const byIp = Object.fromEntries([MASTER, ...WORKERS].map(c => [ipOf(c), c]))
automationEngine.connectSSH = async (node) => {
    if (dx(byIp[node.ip], 'true').code !== 0) throw new Error(`connect ECONNREFUSED ${node.ip}:22`)
    return {
        execCommand: async (cmd, opts = {}) => {
            const r = dx(byIp[node.ip], cmd)
            if (opts.onStdout && r.stdout) opts.onStdout(Buffer.from(r.stdout + '\n'))
            return r
        },
        dispose() {}
    }
}
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const K = (cmd) => dx(MASTER, `KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)

const cluster = { id: 'c-dr', clusterName: 'dr', k8sVersion: '1.35.0', masterNodes: [{ ip: ipOf(MASTER) }], workerNodes: WORKERS.map(c => ({ ip: ipOf(c) })) }
offsiteStore.connect('org', normaliseConfig({ provider: 'other', endpoint: process.env.S3_ENDPOINT, bucket: 'backups', prefix: 'kubeez', accessKey: 'E2EACCESS', secretKey: 'e2e-secret-key-1234567890' }))
const target = offsiteStore.getConnected('org')
let r = await offsiteService.test(cluster, target)
ok(r.ok, 'offsite storage reachable from the control-plane ' + (r.error || ''))

// ── The app that must survive ──
K('create namespace shop')
K('-n shop create deployment api --image=registry.k8s.io/pause:3.10.1 --replicas=3')
K('-n shop create secret generic db --from-literal=password=s3cret')
K('-n shop rollout status deploy/api --timeout=180s')
const saToken = K('-n shop create token default --duration=24h').stdout

const snap = await etcdBackupService.createBackup(cluster)
ok(snap.success, 'snapshot ' + snap.filename)
r = await offsiteService.sync(cluster, target)
ok(r.ok && r.uploaded >= 1, `uploaded offsite (${r.uploaded}) ${r.error || ''}`)

// ── Restore from offsite: the local copy is gone ──
dx(MASTER, `rm -f /var/lib/etcd-backup/${snap.filename} /var/lib/etcd-backup/${snap.filename}.sha256`)
r = await offsiteService.download(cluster, target, snap.filename)
ok(r.ok, 'offsite bundle downloaded + decrypted ' + (r.error || ''))
const v = await etcdBackupService.verifyBackup(cluster, snap.filename)
ok(v.ok, 'downloaded snapshot passes verification')
const listed = (await etcdBackupService.listBackups(cluster)).backups.find(b => b.filename === snap.filename)
ok(listed && Math.abs(new Date(listed.created) - Date.now()) < 30 * 60e3, 'it is listed again with its original time')
r = await offsiteService.download(cluster, { ...target, encKey: 'f'.repeat(64) }, snap.filename)
ok(!r.ok && r.code === 'BAD_KEY', 'wrong recovery key → BAD_KEY: ' + r.error)

// ── Refuses to "recover" a running control plane ──
let err = null
try { await disasterRecovery.recover(cluster, target, snap.filename) } catch (e) { err = e.message }
ok(err && /running/.test(err), 'recovery refused while the control plane runs: ' + err)

// ── The control-plane machine is lost ──
console.log('== destroying the control-plane machine and bringing up a fresh one (same IP)')
spawnSync('docker', ['rm', '-f', MASTER], { env })
const fresh = spawnSync('bash', [path.join(E2E, 'e2e.sh'), 'fresh-node', MASTER, process.env.DISTRO || 'ubuntu2204', cluster.masterNodes[0].ip], { encoding: 'utf8', env })
ok(fresh.status === 0 && ipOf(MASTER) === cluster.masterNodes[0].ip, 'fresh machine up with the same IP')
ok(dx(MASTER, 'test -e /etc/kubernetes/admin.conf').code !== 0, 'it has no Kubernetes at all')

const logs = []; const prog = []
let res = null; err = null
try { res = await disasterRecovery.recover(cluster, target, snap.filename, (l, m) => logs.push(m), (p, s) => prog.push(`${p}% ${s}`)) } catch (e) { err = e.message }
ok(!err, 'recovery completed ' + (err || ''))
if (err) console.log(logs.slice(-30).join('\n'))
console.log('   progress: ' + [...new Set(prog.map(p => p.replace(/^\d+% /, '')))].join(' → '))

// Test environment only (same as node-install.sh): kube-proxy in a container
K(`-n kube-system get cm kube-proxy -o yaml | sed 's/maxPerCore: null/maxPerCore: 0/' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f - >/dev/null 2>&1; KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n kube-system delete pod -l k8s-app=kube-proxy >/dev/null 2>&1`)
K('wait --for=condition=Ready nodes --all --timeout=300s')
const nodes = K('get nodes --no-headers').stdout
ok(nodes.split('\n').length === 1 + WORKERS.length && nodes.split('\n').every(l => / Ready /.test(l)), 'control-plane + worker Ready:\n' + nodes)
K('-n shop rollout status deploy/api --timeout=240s')
ok(K('-n shop get deploy api -o jsonpath={.status.readyReplicas}').stdout === '3', 'the app is back: 3/3 ready')
ok(K('-n shop get secret db -o jsonpath={.data.password}').stdout === Buffer.from('s3cret').toString('base64'), 'its secret is back')
const who = dx(MASTER, `curl -sk -H "Authorization: Bearer ${saToken}" https://127.0.0.1:6443/api/v1/namespaces/shop/pods -o /dev/null -w '%{http_code}'`).stdout
ok(who === '403' || who === '200', `a service-account token issued BEFORE the loss still authenticates (HTTP ${who}, not 401)`)
K('-n shop create deployment after-recovery --image=registry.k8s.io/pause:3.10.1 --replicas=2')
ok(K('-n shop rollout status deploy/after-recovery --timeout=180s').code === 0, 'new workloads schedule on the recovered cluster')
ok(dx(MASTER, 'test -e /var/lib/kubeez-recovery').code !== 0, 'decrypted recovery bundle removed from the machine')

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
