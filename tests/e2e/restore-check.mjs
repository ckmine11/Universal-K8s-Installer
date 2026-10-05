// etcd restore on a REAL cluster (single or HA control-plane), through the
// backend's own service:
//   - snapshots are verified + checksummed; a damaged one is refused before
//     anything stops
//   - the preview names exactly what the restore removes / brings back / reverts
//   - the restore takes a safety snapshot, bumps etcd's revision, leaves no
//     kubelet with stale pods, every node Ready, workloads running
//   - HA: every etcd member re-joins the restored cluster
//   - undo = restoring the safety snapshot brings the newer state back
//   - a restore that cannot start is rolled back automatically
//   - old rollback copies are cleaned up
// Run via: bash tests/e2e/e2e.sh restore <master> <worker>   (HA: e2e.sh restore-ha)
process.env.APP_SECRET = 'test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-restore-'))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { etcdBackupService } = await import('../../backend/src/services/etcdBackupService.js')

const MASTERS = (process.env.MASTER_CONTAINERS || process.env.MASTER_CONTAINER || '').split(',').filter(Boolean)
const MASTER = MASTERS[0]
const WORKERS = (process.env.WORKER_CONTAINERS || '').split(',').filter(Boolean)
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (c, cmd, input) => { const r = spawnSync('docker', ['exec', '-i', c, 'bash', '-c', cmd], { encoding: 'utf8', env, input, maxBuffer: 64 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const ipOf = (c) => dx(c, 'hostname -I').stdout.split(' ')[0]
const byIp = Object.fromEntries([...MASTERS, ...WORKERS].map(c => [ipOf(c), c]))
// SSH → docker exec, streaming like node-ssh does (onStdout gets every chunk)
automationEngine.connectSSH = async (node) => ({
    execCommand: async (cmd, opts = {}) => {
        const r = dx(byIp[node.ip], cmd)
        if (opts.onStdout && r.stdout) opts.onStdout(Buffer.from(r.stdout + '\n'))
        if (opts.onStderr && r.stderr) opts.onStderr(Buffer.from(r.stderr))
        return r
    },
    dispose() {}
})
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const K = (cmd) => dx(MASTER, `KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const wait = (s) => dx(MASTER, `sleep ${s}`)
const exists = (what) => K(`get ${what} -o name`).code === 0
const ETCDCTL = 'ETCDCTL_API=3 etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key --endpoints=https://127.0.0.1:2379'

const cluster = { id: 'c-restore', clusterName: 'e2e', masterNodes: MASTERS.map(c => ({ ip: ipOf(c) })), workerNodes: WORKERS.map(c => ({ ip: ipOf(c) })) }
console.log(`cluster: ${MASTERS.length} control-plane(s), ${WORKERS.length} worker(s)`)

// ── State BEFORE the snapshot ──
K('create deployment web --image=registry.k8s.io/pause:3.10.1 --replicas=4')
K('create deployment old-app --image=registry.k8s.io/pause:3.10.1')
K('create configmap settings --from-literal=mode=before')
K('rollout status deploy/web --timeout=180s')

const snap = await etcdBackupService.createBackup(cluster)
ok(snap.success && snap.verified, `snapshot taken + verified: ${snap.filename} (rev ${snap.revision}, ${snap.keys} keys)`)
ok(dx(MASTER, `test -s /var/lib/etcd-backup/${snap.filename}.sha256`).code === 0, 'checksum file written next to the snapshot')
const list = await etcdBackupService.listBackups(cluster)
ok(list.backups.find(b => b.filename === snap.filename)?.verified === true, 'list marks the snapshot as verified')

// ── Changes AFTER the snapshot ──
K('create namespace after-snap'); K('-n after-snap create configmap x --from-literal=a=b')
K('delete deployment old-app --wait=true')
K('create configmap settings --from-literal=mode=after --dry-run=client -o yaml | KUBECONFIG=/etc/kubernetes/admin.conf kubectl replace -f -')
// Pods replaced after the snapshot — the snapshot doesn't know these pods
K('rollout restart deploy/web'); K('rollout status deploy/web --timeout=180s')
K('-n kube-system delete pod -l k8s-app=kube-dns --wait=true'); K('-n kube-system rollout status deploy/coredns --timeout=180s')

// ── Preview ──
const pv = await etcdBackupService.previewRestore(cluster, snap.filename)
ok(pv.ok, 'preview computed ' + (pv.error || ''))
const has = (l, kind, ns, name) => (pv[l] || []).some(o => o.kind === kind && (o.namespace || null) === ns && o.name === name)
ok(has('removed', 'Namespace', null, 'after-snap'), 'preview: namespace created after the snapshot → removed')
ok(has('removed', 'ConfigMap', 'after-snap', 'x'), 'preview: its configmap → removed')
ok(has('restored', 'Deployment', 'default', 'old-app'), 'preview: deployment deleted after the snapshot → comes back')
ok(has('reverted', 'ConfigMap', 'default', 'settings'), 'preview: configmap edited after the snapshot → reverted')
console.log(`   preview counts: ${JSON.stringify(pv.counts)}`)
ok(dx(MASTER, 'ls -d /var/lib/etcd-backup/.preview-* 2>/dev/null | wc -l').stdout === '0', 'preview cleaned up its temporary etcd')
ok(dx(MASTER, 'ss -ltn | grep -c ":23790 "').stdout === '0', 'temporary etcd is not running any more')

// ── Damaged snapshot is refused before anything stops ──
dx(MASTER, `cd /var/lib/etcd-backup && cp ${snap.filename} etcd-manual-20200101-000000.db && sha256sum etcd-manual-20200101-000000.db | sed 's#  .*#  etcd-manual-20200101-000000.db#' > etcd-manual-20200101-000000.db.sha256 && printf 'XXXX' | dd of=etcd-manual-20200101-000000.db bs=1 seek=8192 conv=notrunc 2>/dev/null`)
const v = await etcdBackupService.verifyBackup(cluster, 'etcd-manual-20200101-000000.db')
ok(!v.ok && /checksum/.test(v.error), 'verify detects the modified file: ' + v.error)
let dmg = null
try { await etcdBackupService.restoreBackup(cluster, 'etcd-manual-20200101-000000.db', () => {}) } catch (e) { dmg = e.message }
ok(dmg && /damaged/i.test(dmg) && /Nothing was changed/.test(dmg), 'restore of the damaged snapshot refused: ' + dmg)
ok(exists('namespace after-snap'), 'cluster untouched after the refused restore')
dx(MASTER, 'rm -f /var/lib/etcd-backup/etcd-manual-20200101-000000.db*')

// ── The restore ──
const marker = dx(MASTER, 'date +"%Y-%m-%d %H:%M:%S"').stdout
const logs = []; const steps = []
let restoreErr = null, res = null
try { res = await etcdBackupService.restoreBackup(cluster, snap.filename, (l, m) => logs.push(m), (p, s) => steps.push(`${p}:${s}`)) } catch (e) { restoreErr = e.message }
ok(!restoreErr, 'restore completed ' + (restoreErr || ''))
if (restoreErr) console.log(logs.slice(-25).join('\n'))
ok(!!res?.safetySnapshot && dx(MASTER, `test -s /var/lib/etcd-backup/${res?.safetySnapshot}`).code === 0, 'safety snapshot of the state before the restore: ' + res?.safetySnapshot)
ok(steps.length >= 3, `progress reported (${steps.length} updates, last ${steps.at(-1)})`)
ok(logs.some(l => /Snapshot verified/.test(l)), 'log shows the verification')
const rev = parseInt(dx(MASTER, `${ETCDCTL} endpoint status -w json`).stdout.match(/"revision":(\d+)/)?.[1], 10)
ok(rev > 1e9, `etcd revision bumped past the old one (${rev}) — controllers re-list instead of trusting caches`)

wait(90)   // give kubelets time to settle (or to keep complaining)
const lateMarker = dx(MASTER, 'date -d "-30 sec" +"%Y-%m-%d %H:%M:%S"').stdout
const stale = (c, since) => parseInt(dx(c, `journalctl -u kubelet --since "${since}" --no-pager 2>/dev/null | grep -c "no relationship found"`).stdout, 10) || 0
for (const c of [...MASTERS, ...WORKERS]) {
    console.log(`   ${c}: "no relationship found" since restore = ${stale(c, marker)}, in the last 30 s = ${stale(c, lateMarker)}`)
    ok(stale(c, lateMarker) === 0, `${c}: kubelet has no stale pods 90 s after the restore`)
}
const nodes = K('get nodes --no-headers').stdout
ok(nodes.split('\n').length === MASTERS.length + WORKERS.length && nodes.split('\n').every(l => / Ready /.test(l)), 'every node Ready:\n' + nodes)
ok(K('get deploy web -o jsonpath={.status.readyReplicas}').stdout === '4', 'workload back to 4/4 ready')
ok(parseInt(K('-n kube-system get deploy coredns -o jsonpath={.status.readyReplicas}').stdout, 10) >= 1, 'CoreDNS ready')
ok(!exists('namespace after-snap'), 'namespace created after the snapshot is gone')
ok(exists('deployment old-app'), 'deployment deleted after the snapshot is back')
ok(K('get cm settings -o jsonpath={.data.mode}').stdout === 'before', 'edited configmap reverted')
if (MASTERS.length > 1) {
    const members = dx(MASTER, `${ETCDCTL} member list`).stdout
    ok(members.split('\n').filter(l => /, started, /.test(l)).length === MASTERS.length, `every etcd member re-joined:\n${members}`)
    for (const m of MASTERS.slice(1)) {
        ok(/"health":"true"/.test(dx(m, "curl -s http://127.0.0.1:2381/health").stdout), `${m}: local etcd healthy`)
        ok(dx(m, `KUBECONFIG=/etc/kubernetes/admin.conf kubectl get --raw=/readyz`).stdout === 'ok', `${m}: API server ready`)
    }
    ok(dx(MASTERS[1], `KUBECONFIG=/etc/kubernetes/admin.conf kubectl get deploy old-app -o name`).code === 0, `${MASTERS[1]} serves the restored data`)
}

// ── Undo: restore the safety snapshot ──
if (res?.safetySnapshot) {
    let undoErr = null, undo = null
    try { undo = await etcdBackupService.restoreBackup(cluster, res.safetySnapshot, () => {}) } catch (e) { undoErr = e.message }
    ok(!undoErr, 'undo (restore of the safety snapshot) completed ' + (undoErr || ''))
    K('wait --for=condition=Ready nodes --all --timeout=180s')
    ok(exists('namespace after-snap') && !exists('deployment old-app') && K('get cm settings -o jsonpath={.data.mode}').stdout === 'after', 'undo brought the newer state back')
    ok(!!undo?.safetySnapshot, 'the undo took its own safety snapshot too')
}

// ── A restore that cannot start is rolled back automatically (single CP) ──
if (MASTERS.length === 1) {
    dx(MASTER, `KUBECONFIG=/etc/kubernetes/admin.conf kubectl create configmap rollback-marker --from-literal=x=1`)
    const r = dx(MASTER, `KUBEEZ_TEST_BREAK_RESTORE=1 bash /k/etcd-restore.sh ${snap.filename}; tail -3 /var/lib/etcd-backup/last-restore.log`)
    ok(/RESULT=FAILED/.test(r.stdout) && /rolled the cluster back automatically/.test(r.stdout), 'broken restore → automatic rollback reported')
    ok(K('get --raw=/readyz').stdout === 'ok', 'API server up after the rollback')
    ok(exists('configmap rollback-marker'), 'cluster runs on the data from before the failed restore')
    ok(dx(MASTER, 'ls -d /var/lib/etcd-failed-restore-* | wc -l').stdout === '1', 'failed attempt kept once for diagnosis')
}
ok(parseInt(dx(MASTER, 'ls -d /var/lib/etcd-prerestore-* 2>/dev/null | wc -l').stdout, 10) <= 2, 'at most 2 rollback copies kept on disk')

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
