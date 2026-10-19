// Connected clusters on a REAL cluster (k3s): the connect command (Direct),
// the KubeEZ agent through Helm, features on the imported cluster (health,
// What changed, Advisor, compliance, an add-on, the kubectl terminal as the
// member), access changes, and disconnecting with cleanup.
// Run via: bash tests/e2e/import-e2e.sh
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const WebSocket = require('ws')

const B = process.env.KUBEEZ_URL                       // where this script reaches KubeEZ
const INNER = process.env.KUBEEZ_INNER_URL             // where the cluster reaches KubeEZ
const NET = process.env.E2E_NET, KUBECONFIG = process.env.E2E_KUBECONFIG
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const host = new URL(INNER).host
let TOK
// (one retry: a kept-alive connection the server already closed fails once)
const fetchRetry = async (u, o) => { try { return await fetch(u, o) } catch { await sleep(500); return fetch(u, o) } }
const api = async (method, path, body, extra = {}) => { const r = await fetchRetry(B + path, { method, headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let d; try { d = JSON.parse(t) } catch { d = t } return { status: r.status, data: d } }
// kubectl / helm where the user's kubectl works (a helper container next to the cluster)
const kubectlHere = (cmd) => { const r = spawnSync('docker', ['run', '--rm', '--network', NET, '-v', `${KUBECONFIG}:/root/.kube/config:ro`, 'alpine/k8s:1.31.4', 'sh', '-c', cmd], { encoding: 'utf8', env }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') } }
const waitFor = async (fn, secs = 180) => { for (let i = 0; i < secs / 3; i++) { const v = await fn(); if (v) return v; await sleep(3000) } return null }

const setup = await (await fetch(`${B}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'e2eboss', password: 'e2e-secret-123', email: 'e2eboss@example.com' }) })).json()
TOK = setup.token
ok(TOK, 'admin set up')

console.log('== Direct: the connect command, read-only')
let s = (await api('POST', '/api/connect/sessions', { name: 'k3s-direct', provider: 'k3s', method: 'direct', level: 'read' }, { 'x-forwarded-host': host })).data
let r = kubectlHere(s.commands.connect.sh)
ok(r.code === 0 && /✔ Connected to KubeEZ as "k3s-direct"/.test(r.out), `connect command: ${r.out.trim().split('\n').slice(-2).join(' ')}`)
let c = (await api('GET', '/api/connect/clusters')).data.clusters[0]
ok(c && c.provider === 'k3s' && c.distro === 'k3s' && c.method === 'direct' && c.level === 'read' && c.status === 'live', `connected: ${c?.providerName} ${c?.version}, ${c?.nodeCount} node(s), ${c?.method}, ${c?.level}`)
ok(c.features.etcdBackup.ok === false && c.features.addons.ok === false, 'etcd / add-ons not offered (provider-run; read-only)')
const h = await waitFor(async () => { const x = (await api('GET', `/api/clusters/${c.id}/health`)).data; return x.pods > 0 ? x : null }, 120) || {}
ok(h.imported && h.nodes?.length >= 1 && h.pods > 0, `health through the API: ${h.nodes?.length} node(s), ${h.pods} pods`)
ok(((await api('GET', `/api/ai/changes/${c.id}?hours=24`)).data.items || []).length > 0, 'What changed reads the cluster')
const adv = await api('GET', `/api/clusters/${c.id}/advisor`)
ok(adv.status === 200 && adv.data.security, `Advisor: ${adv.data.security?.findings?.length} security finding(s)`)
ok((await api('GET', `/api/clusters/${c.id}/etcd/backups`)).status === 409, 'etcd refused with the reason')
ok((await api('POST', `/api/clusters/${c.id}/addons`, { addons: { 'cert-manager': true } })).status === 409, 'add-on refused while read-only')
ok(!JSON.stringify((await api('GET', '/api/clusters/list')).data).includes('"token":"'), 'the token never leaves the server')
const rbac = kubectlHere('kubectl auth can-i create deployments --as=system:serviceaccount:kubeez-system:kubeez -A; kubectl auth can-i get secrets --as=system:serviceaccount:kubeez-system:kubeez -A')
ok(/^no\s+no/m.test(rbac.out.trim().replace(/\n/g, ' ')) || rbac.out.trim().split('\n').every(l => l.trim() === 'no'), `read-only login: may not create, may not read Secrets (${rbac.out.trim().replace(/\n/g, ', ')})`)
const del = await api('DELETE', `/api/connect/clusters/${c.id}`)
ok(del.status === 200 && /kubectl delete namespace kubeez-system/.test(del.data.cleanup), 'disconnected — the cleanup command is shown (read-only cannot remove itself)')
kubectlHere(del.data.cleanup)

console.log('== the KubeEZ agent with Helm, Full manage')
s = (await api('POST', '/api/connect/sessions', { name: 'k3s-agent', provider: 'k3s', method: 'agent', level: 'full' }, { 'x-forwarded-host': host })).data
r = kubectlHere(s.commands.helm)
ok(r.code === 0 && /STATUS: deployed/.test(r.out), 'helm upgrade --install kubeez-agent: deployed')
const done = await waitFor(async () => { const x = (await api('GET', `/api/connect/sessions/${s.code}`)).data; return ['connected', 'failed'].includes(x.status) ? x : null }, 240)
ok(done?.status === 'connected' && done.route === 'agent', `the agent connected out: ${done?.status} ${done?.error || ''}`)
c = (await api('GET', '/api/connect/clusters')).data.clusters[0]
ok(c.level === 'full' && c.agentOnline && c.features.addons.ok, 'Full manage through the agent')
// (a free self-hosted KubeEZ: the Dashboard is a free add-on — a chart KubeEZ ships)
const job = (await api('POST', `/api/clusters/${c.id}/addons`, { addons: { dashboard: true } })).data.newInstallationId
const st = await waitFor(async () => { const x = (await api('GET', `/api/clusters/${job}/status`)).data; return ['completed', 'failed'].includes(x.status) ? x : null }, 480)
ok(st?.status === 'completed', `add-on (Helm, through the agent): ${st?.status} ${st?.error || ''}`)
ok(/Running/.test((await waitFor(async () => { const o = kubectlHere('kubectl -n kubernetes-dashboard get pods').out; return /Running/.test(o) ? o : null }, 120)) || ''), 'the Dashboard runs in the cluster')
const lh = await api('POST', `/api/clusters/${c.id}/addons`, { addons: { longhorn: true } })
ok([402, 409].includes(lh.status), `Longhorn refused: ${String(lh.data.error).slice(0, 90)}`)
// the terminal: kubectl as the member, recorded
await api('POST', '/api/terminal/grants', { clusterId: c.id, reason: 'e2e check', minutes: 15 })
const term = (cmd) => new Promise((resolve) => {
    const ws = new WebSocket(`${B.replace(/^http/, 'ws')}/ws/orbital/${c.id}?token=${TOK}`)
    let out = ''
    ws.on('open', () => ws.send(JSON.stringify({ type: 'command', clusterId: c.id, command: cmd })))
    ws.on('message', (m) => { out += JSON.parse(m).content || '' })
    setTimeout(() => { try { ws.close() } catch { } resolve(out) }, 12000)
})
ok(/kube-system/.test(await term('kubectl get ns')), 'terminal: kubectl get ns')
ok(/kubeez-access/.test(await term('kubectl auth whoami')), 'terminal runs as the member\'s own account')
ok(/no pipes/.test(await term('kubectl get pods -A | grep x')), 'terminal: pipes refused')
// compliance
const scan = await api('POST', `/api/compliance/clusters/${c.id}/scan`, { cis: false })
const rep = await waitFor(async () => { const x = (await api('GET', `/api/compliance/clusters/${c.id}/reports`)).data; const l = x.reports || x; return Array.isArray(l) && l[0] }, 240)
ok(scan.status === 202 && rep, `compliance scan: score ${rep?.score}`)
// access down, then disconnect with cleanup (Full manage removes its own login)
ok((await api('PUT', `/api/connect/clusters/${c.id}/level`, { level: 'read' })).data.changed, 'Full → Read-only')
ok(/NotFound|not found/i.test(kubectlHere('kubectl get clusterrolebinding kubeez-full').out), 'the cluster-admin binding is gone')
await api('PUT', `/api/connect/clusters/${c.id}/level`, { level: 'full' })   // (needs the command — stays read-only)
ok((await api('GET', `/api/connect/clusters/${c.id}`)).data.level === 'read', 'more access needs the cluster\'s own admin (a command)')
const d2 = await api('DELETE', `/api/connect/clusters/${c.id}`)
ok(d2.status === 200, 'disconnected')
kubectlHere('helm -n kubeez-system uninstall kubeez-agent >/dev/null 2>&1; kubectl delete ns kubeez-system kubeez-access kubeez-explorer kubernetes-dashboard --ignore-not-found >/dev/null 2>&1')

console.log(fails ? `RESULT: FAIL (${fails})` : 'RESULT: PASS')
process.exit(fails ? 1 : 0)
