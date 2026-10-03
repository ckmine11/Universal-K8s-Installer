// Add-on management on a REAL cluster: install → status/logs → web UI login →
// repair → uninstall (nothing left behind, API still writable) → uninstall again.
// Run via: bash tests/e2e/e2e.sh addons [distro]
process.env.APP_SECRET = 'test'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-addons-'))
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { addonManager } = await import('../../backend/src/services/addonManager.js')
const { addonAccessService } = await import('../../backend/src/services/addonAccessService.js')

const NODE = process.env.NODE_CONTAINER
const AUTOMATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src/automation')
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd) => { const r = spawnSync('docker', ['exec', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 64 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const ssh = { execCommand: async (cmd) => dx(cmd), dispose() {} }
automationEngine.connectSSH = async () => ssh
const IP = dx('hostname -I').stdout.split(' ')[0]
const cluster = { id: 'c-addons', clusterName: 'addons', masterNodes: [{ ip: IP }], workerNodes: [], addons: {} }
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const quiet = () => {}

async function script(file, args = []) {
    try { await automationEngine.executeScript(ssh, path.join(AUTOMATION, file), args, quiet, { timeoutMs: 30 * 60 * 1000 }); return null }
    catch (e) { return e.diagnosis ? `${e.diagnosis.reason}: ${e.diagnosis.message}` : e.message.slice(-400) }
}
const statusOf = async (key) => (await addonManager.getStatus(cluster)).addons.find(a => a.key === key)
async function waitHealthy(key, secs = 300) {
    let s
    for (let i = 0; i < secs / 10; i++) { s = await statusOf(key); if (s.health === 'healthy') break; dx('sleep 10') }
    return s
}
// Admin UI login through the NodePort: right password → /admin, wrong → error
function uiLogin(port, user, pass) {
    return dx(`J=$(mktemp); T=$(curl -s -c $J http://${IP}:${port}/login | grep -oE 'name="csrf_token" value="[^"]+"' | sed 's/.*value="//;s/"$//'); ` +
        `curl -s -b $J -o /dev/null -w '%{redirect_url}' --data-urlencode "username=${user}" --data-urlencode "password=${pass}" --data-urlencode "csrf_token=$T" http://${IP}:${port}/login`).stdout
}
const nothingLeft = (pattern) => {
    const r = K(`get crd,validatingwebhookconfiguration,mutatingwebhookconfiguration,clusterrole,clusterrolebinding,ns -o name`).stdout
    return r.split('\n').filter(l => pattern.test(l))
}

// ── SeaweedFS: install, status, logs, web UI ─────────────────────────────────
let err = await script('addons/seaweedfs.sh')
ok(!err, 'SeaweedFS installed ' + (err || ''))
let sw = await waitHealthy('seaweedfs')
ok(sw.health === 'healthy' && sw.pods[0]?.ready === '2/2', `status: SeaweedFS healthy, pod ${sw.pods[0]?.ready}`)

const access = (await addonAccessService.getAccessInfo(cluster)).addons.find(a => a.key === 'seaweedfs')
const pw = access?.auth?.extra?.find(x => x.label === 'Web UI password')?.value
ok(access?.uiUrl?.endsWith(':30834') && !!pw, 'access info has the web UI URL and its password')
dx('sleep 10')
ok(uiLogin(30834, 'admin', pw).endsWith('/admin'), 'web UI: correct password logs in')
ok(/error=/.test(uiLogin(30834, 'admin', 'wrong-password')), 'web UI: wrong password is rejected')

const logs = await addonManager.getLogs(cluster, 'seaweedfs', { tail: 50 })
ok(logs.logs.length === 1 && /\[pod\/seaweedfs-[^/]+\/(seaweedfs|admin)\]/.test(logs.logs[0].log), 'logs: prefixed lines from both containers')
ok(typeof logs.events === 'string', 'logs: events included')

// Repair an install that predates the web UI: password is added, S3 keys are kept
const s3Before = K(`-n seaweedfs get secret seaweedfs-s3 -o jsonpath={.data.secretKey}`).stdout
K(`-n seaweedfs patch secret seaweedfs-s3 --type=json -p '[{"op":"remove","path":"/data/adminPassword"}]'`)
err = await script('addons/seaweedfs.sh')
ok(!err, 'repair (installer re-run) succeeded ' + (err || ''))
ok(!!K(`-n seaweedfs get secret seaweedfs-s3 -o jsonpath={.data.adminPassword}`).stdout, 'repair: web UI password generated')
ok(K(`-n seaweedfs get secret seaweedfs-s3 -o jsonpath={.data.secretKey}`).stdout === s3Before, 'repair: S3 keys unchanged')

// ── cert-manager, dashboard, ingress: install → uninstall → nothing left ─────
const installs = { 'cert-manager': ['addons/cert-manager.sh', []], dashboard: ['install-addons.sh', ['dashboard']], ingress: ['install-addons.sh', ['ingress']] }
const leftovers = { 'cert-manager': /cert-manager/, dashboard: /kubernetes-dashboard|dashboard-admin|dashboard-viewer/, ingress: /ingress-nginx/ }
for (const [key, [file, args]] of Object.entries(installs)) {
    err = await script(file, args)
    ok(!err, `${key} installed ` + (err || ''))
    const st = await waitHealthy(key)
    ok(st.installed && st.health === 'healthy', `${key}: status ${st.health}`)
    err = await script('addon-uninstall.sh', [key])
    ok(!err, `${key} uninstalled ` + (err || ''))
    const left = nothingLeft(leftovers[key])
    ok(left.length === 0, `${key}: nothing left behind ${left.join(' ')}`)
    ok((await statusOf(key)).health === 'not-installed', `${key}: status not-installed`)
}
// A leftover webhook would make the API reject writes — prove it doesn't
K('delete cm kz-probe --ignore-not-found')
ok(K('create configmap kz-probe --from-literal=a=b').code === 0, 'API accepts writes after the uninstalls')

// ── SeaweedFS uninstall, then again (idempotent) ──────────────────────────────
err = await script('addon-uninstall.sh', ['seaweedfs'])
ok(!err, 'SeaweedFS uninstalled ' + (err || ''))
ok(K('get ns seaweedfs').code !== 0, 'seaweedfs namespace gone')
ok((await statusOf('seaweedfs')).health === 'not-installed', 'SeaweedFS: status not-installed')
err = await script('addon-uninstall.sh', ['seaweedfs'])
ok(!err, 'uninstalling again is a no-op ' + (err || ''))
err = await script('addon-uninstall.sh', ['bogus'])
ok(/UNKNOWN_ADDON/.test(err || ''), 'unknown add-on is refused with a reason')

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
