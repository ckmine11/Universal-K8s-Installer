// KubeEZ Explorer on a REAL cluster: KubeEZ installs Radar (Helm, auth proxy
// mode), and KubeEZ's own proxy carries the browser to it. The tunnel here is
// `docker exec` + bash /dev/tcp to Radar's ClusterIP, standing in for SSH/agent.
// Checks: page + strict CSP, identity → real Kubernetes RBAC (viewer can't
// scale, operator can), upgrade readiness + audit for KubeEZ screens, uninstall.
// Run via: bash tests/e2e/e2e.sh explorer [distro]
process.env.APP_SECRET = 'e2e-only-secret-0123456789abcdef0123456789abcdef'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { Duplex } from 'node:stream'
import { createRequire } from 'node:module'
// express & cookie-parser come from the backend's node_modules
const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url))
const express = requireBackend('express')
const cookieParser = requireBackend('cookie-parser')
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-explorer-'))
process.env.KUBEEZ_DATA_DIR = DATA

const NODE = process.env.NODE_CONTAINER
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd) => { const r = spawnSync('docker', ['exec', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 64 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const nodeIp = dx('hostname -I').stdout.split(' ')[0]
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([{ id: 'c-exp', clusterName: 'exp', orgId: 'org1', ownerId: 'u1', k8sVersion: '1.35.0', addons: { explorer: true }, masterNodes: [{ ip: nodeIp, username: 'root', password: 'x' }], workerNodes: [] }]))

const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { clusterTunnel } = await import('../../backend/src/services/clusterTunnel.js')
const { authService } = await import('../../backend/src/services/authService.js')
const { requireAuth } = await import('../../backend/src/middleware/authMiddleware.js')
const { explorerHttp, explorerUpgrade, EXPLORER_PATH, explorerApi } = await import('../../backend/src/services/explorerProxy.js')
const { upgradeReadiness, clusterHealth } = await import('../../backend/src/services/explorerInsights.js')

automationEngine.connectSSH = async () => ({ execCommand: async (cmd) => dx(cmd), dispose() {} })
// TCP into the node's network: bash /dev/tcp inside the container
clusterTunnel.open = async (cluster, host, port) => {
    const p = spawn('docker', ['exec', '-i', NODE, 'bash', '-c', `exec 3<>/dev/tcp/${host}/${port} && (cat <&3 & cat >&3; wait)`], { env })
    const d = new Duplex({
        read() {},
        write(c, e, cb) { p.stdin.write(c, cb) },
        final(cb) { p.stdin.end(); cb() },
        destroy(err, cb) { try { p.kill() } catch {} cb(err) }
    })
    p.stdout.on('data', c => d.push(c))
    p.stdout.on('end', () => d.push(null))
    d.on('error', () => {})
    return d
}
const USERS = {
    'tok-viewer': { id: 'u2', username: 'vic', role: 'viewer', orgId: 'org1' },
    'tok-operator': { id: 'u3', username: 'otto', role: 'operator', orgId: 'org1' },
    'tok-admin': { id: 'u1', username: 'alice', role: 'admin', orgId: 'org1' }
}
authService.verifyToken = (t) => USERS[t] || null

let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)

// ── Install through KubeEZ's own path (settings hand-over + script) ──
const ssh = await automationEngine.connectSSH()
await automationEngine.writeExplorerSettings(ssh, 'c-exp')
console.log('== installing the KubeEZ Explorer (Radar via Helm)')
let r = dx('bash /k/explorer.sh 2>&1')
ok(r.code === 0 && /KubeEZ Explorer installed/.test(r.stdout), 'installed: ' + r.stdout.split('\n').filter(l => /✓|FAIL/.test(l)).join(' | '))
if (r.code !== 0) console.log(r.stdout.split('\n').slice(-25).join('\n'))
ok(K('-n kubeez-explorer get svc kubeez-explorer -o jsonpath={.spec.type}').stdout === 'ClusterIP', 'The Explorer is reachable only inside the cluster (ClusterIP)')
ok(K('get clusterrolebinding kubeez-explorer-viewers -o jsonpath={.roleRef.name}').stdout === 'view', 'viewers → view')
ok(K('get clusterrolebinding kubeez-explorer-operators -o jsonpath={.roleRef.name}').stdout === 'edit', 'operators → edit')
ok(K('auth can-i create secrets --as=system:serviceaccount:kubeez-explorer:kubeez-explorer -n default').stdout === 'yes' && K('auth can-i create deployments --as=system:serviceaccount:kubeez-explorer:kubeez-explorer -n default').stdout === 'no', 'Helm gate: the Explorer may create Secrets (opens Helm installs, done as the user) — nothing more')
const ip = K('-n kubeez-explorer get svc kubeez-explorer -o jsonpath={.spec.clusterIP}').stdout

// ── KubeEZ proxy in front of it ──
const app = express()
app.use(EXPLORER_PATH, cookieParser(), requireAuth, explorerHttp)
const server = http.createServer(app)
server.on('upgrade', (req, socket, head) => explorerUpgrade(req, socket, head, []))
await new Promise(res => server.listen(0, '127.0.0.1', res))
const base = `http://127.0.0.1:${server.address().port}/api/clusters/c-exp/explorer`
const get = (p, tok, extra = {}) => fetch(base + p, { headers: { cookie: `token=${tok}`, ...extra } })

r = await get('/', 'tok-viewer', { accept: 'text/html' })
const html = await r.text()
ok(r.status === 200 && /<div id="root"|<html/i.test(html), `Explorer page through KubeEZ (HTTP ${r.status})`)
ok(/script-src 'self' 'wasm-unsafe-eval'/.test(r.headers.get('content-security-policy') || ''), 'strict CSP on the page: ' + (r.headers.get('content-security-policy') || '').slice(0, 90))
ok(/<title>KubeEZ Explorer<\/title>/.test(html) && !/<title>Radar/.test(html), 'page is branded KubeEZ Explorer')
const asset = html.match(/src="([^"]+\.js)"/)?.[1]
if (asset) { const a = await fetch(`http://127.0.0.1:${server.address().port}${asset}`, { headers: { cookie: 'token=tok-viewer' } }); ok(a.status === 200 && /javascript/.test(a.headers.get('content-type') || ''), `app bundle served (${asset.slice(-40)})`) }
ok((await fetch(base + '/', {})).status === 401, 'no KubeEZ login → refused')

// ── Identity reaches Kubernetes RBAC ──
const who = await (await get('/api/rbac/whoami', 'tok-viewer', { 'x-forwarded-user': 'system:admin' })).json().catch(() => ({}))
console.log('   whoami:', JSON.stringify(who).slice(0, 200))
// whoami = the caller's own rules: a viewer's (our cluster-read + view), never cluster-admin's '*'
const rules = who.resourceRules || []
ok(rules.some(r => (r.resources || []).includes('nodes')) && !rules.some(r => (r.verbs || []).includes('*')), 'Radar acts as the KubeEZ viewer (viewer rules, not admin) despite a spoofed header')
K('delete deployment web --ignore-not-found --wait=true')   // a fresh one each run
K('create deployment web --image=registry.k8s.io/pause:3.10.1')
K('rollout status deploy/web --timeout=120s')
const scale = (tok, n) => fetch(base + '/api/workloads/deployments/default/web/scale', { method: 'POST', headers: { cookie: `token=${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ replicas: n }) })
r = await scale('tok-viewer', 3)
ok(r.status >= 400 && K('get deploy web -o jsonpath={.spec.replicas}').stdout === '1', `viewer cannot scale (HTTP ${r.status}, Kubernetes RBAC)`)
r = await scale('tok-operator', 2)
ok(r.status < 300 && K('get deploy web -o jsonpath={.spec.replicas}').stdout === '2', `operator can scale (HTTP ${r.status})`)

// ── KubeEZ screens from Radar's analysis ──
const cluster = JSON.parse(fs.readFileSync(path.join(DATA, 'clusters.json'), 'utf8'))[0]
try {
    const u = await upgradeReadiness(cluster, USERS['tok-admin'], '1.36.0')
    ok(['blocked', 'warning', 'review', 'no_known_blockers', 'unknown'].includes(u.verdict) && /1\.36/.test(u.targetVersion || ''), `upgrade safety check 1.35 → 1.36: ${u.verdict} (${u.summary.blocked || 0} blocked, ${u.summary.warnings || 0} warnings, ${u.summary.passed || 0} passed)`)
} catch (e) { ok(false, 'upgrade safety check: ' + e.message) }
try {
    const h = await clusterHealth(cluster, USERS['tok-admin'])
    ok(typeof h.score === 'number' && h.passing + h.warning + h.danger > 0, `health score ${h.score} (${h.passing} passing, ${h.warning} warnings, ${h.danger} critical)`)
} catch (e) { ok(false, 'health score: ' + e.message) }

server.close()

// ── Migration: an install from before the rename (release/resources "radar") ──
dx("helm -n kubeez-explorer uninstall kubeez-explorer --wait >/dev/null 2>&1")
r = dx("helm upgrade --install radar skyhook/radar --version 1.15.0 -n kubeez-explorer --set fullnameOverride=radar --set auth.mode=proxy --set basePath=/api/clusters/c-exp/explorer --wait --timeout 8m >/dev/null 2>&1; echo rc=$?")
ok(/rc=0/.test(r.stdout) && K('-n kubeez-explorer get svc radar -o name').code === 0, 'old-style install in place (release radar)')
await automationEngine.writeExplorerSettings(ssh, 'c-exp')   // as KubeEZ does before every Repair
r = dx('bash /k/explorer.sh 2>&1')
ok(r.code === 0 && dx('helm -n kubeez-explorer list -q').stdout === 'kubeez-explorer', 'Repair migrates it to kubeez-explorer: ' + dx('helm -n kubeez-explorer list -q').stdout.split('\n').join(','))
ok(K('-n kubeez-explorer get svc radar -o name').code !== 0 && K('-n kubeez-explorer get deploy kubeez-explorer -o name').code === 0, 'old resources gone, new ones running')

// ── Uninstall ──
r = dx('bash /k/addon-uninstall.sh explorer /etc/kubernetes/admin.conf kubeez-explorer 2>&1')
ok(r.code === 0, 'uninstall finished')
ok(K('get ns kubeez-explorer -o name').code !== 0 && K('get clusterrolebinding kubeez-explorer-viewers -o name').code !== 0 && K('get clusterrole kubeez-explorer-helm-gate -o name').code !== 0, 'namespace, role mapping and Helm gate removed')
ok(K('get deploy web -o name').code === 0, 'workloads untouched')

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
