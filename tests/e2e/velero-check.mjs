// Volume backups (Velero) on a REAL node. Backup target: the cluster's own S3
// add-on (fine for a test). A pod writes a file into its volume; the namespace
// is backed up, deleted, restored → the file content is back. Also a
// side-by-side copy restore, the daily schedule and the uninstall.
// Run via: bash tests/e2e/e2e.sh velero [distro]
process.env.APP_SECRET = 'test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-velero-'))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { addonAccessService } = await import('../../backend/src/services/addonAccessService.js')
const { normaliseConfig } = await import('../../backend/src/services/offsiteService.js')
const { volumeBackupStore } = await import('../../backend/src/services/volumeBackupStore.js')
const { volumeBackupService } = await import('../../backend/src/services/volumeBackupService.js')

const NODE = process.env.NODE_CONTAINER
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd) => { const r = spawnSync('docker', ['exec', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 64 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
automationEngine.connectSSH = async () => ({ execCommand: async (cmd) => dx(cmd), dispose() {} })
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000))
const nodeIp = dx('hostname -I').stdout.split(' ')[0]
const cluster = { id: 'c-velero', clusterName: 'v', masterNodes: [{ ip: nodeIp }] }
const ssh = await automationEngine.connectSSH()

async function until(what, fn, secs = 300) {
    for (let i = 0; i < secs / 5; i++) { const v = await fn(); if (v) return v; await sleep(5) }
    return null
}
const runVelero = () => {
    const r = dx('bash /k/velero.sh 2>&1')
    if (r.code !== 0) console.log(r.stdout.split('\n').slice(-15).join('\n'))
    return r
}

// ── Not configured → clear message ──
let r = runVelero()
ok(r.code !== 0 && /KUBEEZ_FAIL\|NOT_CONFIGURED/.test(r.stdout), 'install without settings explains what to do')

// ── Install with the S3 add-on as target ──
const sw = (await addonAccessService.getAccessInfo(cluster)).addons.find(a => a.key === 'seaweedfs')
const cfg = normaliseConfig({ provider: 'other', endpoint: sw.url, bucket: 'backups', prefix: 'velero-e2e', accessKey: sw.auth.username, secretKey: sw.auth.password })
volumeBackupStore.save(cluster.id, { ...cfg, source: 'custom' })
await automationEngine.writeVeleroSettings(ssh, cluster.id)
ok(dx('stat -c %a /etc/kubeez/velero.env').stdout === '600', 'settings handed to the node root-only')
console.log('== installing Velero')
r = runVelero()
ok(r.code === 0 && /Backup storage available/.test(r.stdout), 'Velero installed and its storage is available')
ok(dx('test -e /etc/kubeez/velero.env || test -e /etc/kubeez/velero-credentials').code !== 0, 'no key file left on the node')
ok(!dx(`grep -rl '${sw.auth.password}' /etc/kubeez /tmp /root 2>/dev/null`).stdout, 'the secret key is only in the cluster Secret')
let st = await volumeBackupService.status(cluster)
ok(st.installed && st.ready && st.storage?.phase === 'Available', `status: installed, ready, storage ${st.storage?.phase}, node-agent ${st.nodeAgent}`)

// ── An app with data in a volume ──
const DATA = `kubeez-${Date.now()}`
K('create namespace shop')
dx(`cat <<EOF | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata: { name: db, namespace: shop }
spec:
  replicas: 1
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      containers:
      - name: db
        image: busybox:1.36
        command: ["sh", "-c", "[ -f /data/file.txt ] || echo ${DATA} > /data/file.txt; sleep 100000"]
        volumeMounts: [{ name: data, mountPath: /data }]
      volumes: [{ name: data, emptyDir: {} }]
EOF`)
K('-n shop rollout status deploy/db --timeout=240s')
const readFile = (ns) => K(`-n ${ns} exec deploy/db -- cat /data/file.txt`).stdout
ok(readFile('shop') === DATA, 'app wrote its data: ' + readFile('shop'))

// ── Backup ──
const b = await volumeBackupService.backupNow(cluster, { namespaces: ['shop'], ttlDays: 7 })
const done = await until('backup', async () => {
    const s = await volumeBackupService.status(cluster)
    const x = s.backups.find(y => y.name === b.name)
    return x && !['New', 'InProgress', 'WaitingForPluginOperations', 'Finalizing'].includes(x.phase) ? x : null
})
ok(done?.phase === 'Completed', `backup ${b.name}: ${done?.phase} (${done?.items?.done}/${done?.items?.total} items, errors ${done?.errors})`)
ok(parseInt(K('-n velero get podvolumebackups -o name | wc -l').stdout, 10) >= 1 || /Completed/.test(K('-n velero get podvolumebackups').stdout), 'the volume data was copied (PodVolumeBackup)')
const d = await volumeBackupService.describe(cluster, 'backup', b.name)
ok(/shop/.test(d.text), 'describe shows the backup details')

// ── Disaster: namespace deleted → restore ──
K('delete namespace shop --wait=true --timeout=180s')
const rs = await volumeBackupService.restore(cluster, b.name, { namespaces: ['shop'], mode: 'missing' })
const rdone = await until('restore', async () => {
    const s = await volumeBackupService.status(cluster)
    const x = s.restores.find(y => y.name === rs.name)
    return x && !['New', 'InProgress', 'WaitingForPluginOperations', 'Finalizing'].includes(x.phase) ? x : null
})
ok(rdone?.phase === 'Completed', `restore ${rs.name}: ${rdone?.phase} (errors ${rdone?.errors}, warnings ${rdone?.warnings})`)
K('-n shop rollout status deploy/db --timeout=240s')
ok(readFile('shop') === DATA, 'volume data restored: ' + readFile('shop'))

// ── Copy restore next to the original ──
const cp = await volumeBackupService.restore(cluster, b.name, { namespaces: ['shop'], mode: 'copy' })
const copyNs = cp.mappings[0].split(':')[1]
await until('copy', async () => K(`-n ${copyNs} get deploy db -o jsonpath={.status.readyReplicas}`).stdout === '1', 300)
ok(readFile(copyNs) === DATA && readFile('shop') === DATA, `side-by-side copy in ${copyNs} has the data, original untouched`)

// ── Input validation ──
let e = null
try { await volumeBackupService.restore(cluster, b.name, { namespaces: ['kube-system'], mode: 'replace' }) } catch (x) { e = x.message }
ok(e && /cannot be replaced/.test(e), 'replace of a system namespace refused')
e = null
try { await volumeBackupService.backupNow(cluster, { namespaces: ['shop; rm -rf /'] }) } catch (x) { e = x.message }
ok(e === 'Invalid namespace list', 'malicious namespace name refused')

// ── Schedule ──
await volumeBackupService.setSchedule(cluster, { enabled: true, cron: '0 3 * * *', ttlDays: 14 })
st = await volumeBackupService.status(cluster)
ok(st.schedule?.cron === '0 3 * * *', 'daily schedule created: ' + st.schedule?.cron)
await volumeBackupService.setSchedule(cluster, { enabled: false })
st = await volumeBackupService.status(cluster)
ok(!st.schedule, 'schedule removed')

// ── Delete a backup ──
await volumeBackupService.deleteBackup(cluster, b.name)
const gone = await until('delete', async () => !(await volumeBackupService.status(cluster)).backups.some(x => x.name === b.name), 180)
ok(!!gone, 'backup deleted')

// ── Uninstall ──
r = dx('bash /k/addon-uninstall.sh velero /etc/kubernetes/admin.conf velero 2>&1')
ok(r.code === 0, 'uninstall finished')
ok(K('get ns velero -o name').code !== 0 && !K('get crd -o name').stdout.includes('velero.io'), 'namespace and CRDs removed')
ok(readFile('shop') === DATA, 'apps keep running after the uninstall')

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
