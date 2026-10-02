// etcd restore on a REAL multi-node cluster: after restoring a snapshot taken
// BEFORE pods were replaced, no kubelet may keep stale pods ("no relationship
// found between node … and this object"), every node is Ready, workloads run.
// Run via: bash tests/e2e/e2e.sh restore <master> <worker>
process.env.APP_SECRET = 'test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-restore-'))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { etcdBackupService } = await import('../../backend/src/services/etcdBackupService.js')

const MASTER = process.env.MASTER_CONTAINER
const WORKERS = (process.env.WORKER_CONTAINERS || '').split(',').filter(Boolean)
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (c, cmd) => { const r = spawnSync('docker', ['exec', c, 'bash', '-c', cmd], { encoding: 'utf8', env }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const ipOf = (c) => dx(c, 'hostname -I').stdout.split(' ')[0]
const byIp = Object.fromEntries([MASTER, ...WORKERS].map(c => [ipOf(c), c]))
automationEngine.connectSSH = async (node) => ({ execCommand: async (cmd) => dx(byIp[node.ip], cmd), dispose() {} })
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const K = (cmd) => dx(MASTER, `KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const wait = (s) => dx(MASTER, `sleep ${s}`)

const cluster = { id: 'c-restore', masterNodes: [{ ip: ipOf(MASTER) }], workerNodes: WORKERS.map(c => ({ ip: ipOf(c) })) }

// A workload spread over the nodes
K('create deployment web --image=registry.k8s.io/pause:3.10.1 --replicas=4')
K('rollout status deploy/web --timeout=180s')
const snap = await etcdBackupService.createBackup(cluster)
ok(snap.success, 'snapshot taken: ' + snap.filename)

// Replace pods AFTER the snapshot — the snapshot doesn't know these pods
K('rollout restart deploy/web'); K('rollout status deploy/web --timeout=180s')
K('-n kube-system delete pod -l k8s-app=kube-dns --wait=true'); K('-n kube-system rollout status deploy/coredns --timeout=180s')
const marker = dx(MASTER, 'date +"%Y-%m-%d %H:%M:%S"').stdout

const logs = []
let restoreErr = null
try { await etcdBackupService.restoreBackup(cluster, snap.filename, (l, m) => logs.push(m)) } catch (e) { restoreErr = e.message }
ok(!restoreErr, 'restore completed ' + (restoreErr || ''))

wait(90)   // give kubelets time to settle (or to keep complaining)
const stale = (c) => parseInt(dx(c, `journalctl -u kubelet --since "${marker}" --no-pager 2>/dev/null | grep -c "no relationship found"`).stdout, 10) || 0
// Only count complaints that continue AFTER the restore settled
const lateMarker = dx(MASTER, 'date -d "-30 sec" +"%Y-%m-%d %H:%M:%S"').stdout
const lateStale = (c) => parseInt(dx(c, `journalctl -u kubelet --since "${lateMarker}" --no-pager 2>/dev/null | grep -c "no relationship found"`).stdout, 10) || 0
for (const c of [MASTER, ...WORKERS]) {
    console.log(`   ${c}: "no relationship found" since restore = ${stale(c)}, in the last 30 s = ${lateStale(c)}`)
    ok(lateStale(c) === 0, `${c}: kubelet has no stale pods 90 s after the restore`)
}
const nodes = K('get nodes --no-headers').stdout
ok(nodes.split('\n').every(l => / Ready /.test(l)), 'every node Ready')
const web = K('get deploy web -o jsonpath={.status.readyReplicas}').stdout
ok(web === '4', 'workload back to 4/4 ready: ' + web)
const dns = K('-n kube-system get deploy coredns -o jsonpath={.status.readyReplicas}').stdout
ok(parseInt(dns, 10) >= 1, 'CoreDNS ready: ' + dns)
console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
