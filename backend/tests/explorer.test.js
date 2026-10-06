// Cluster Explorer (Radar behind KubeEZ): the proxy is the ONLY way into Radar,
// so it must (1) authenticate + check the workspace, (2) never forward KubeEZ
// credentials, (3) replace any identity the browser tries to send, (4) pin
// Radar's inline scripts in the CSP, (5) carry SSE + WebSockets. A fake Radar
// stands in for the cluster; the tunnel is a plain local TCP connection.
// Real cluster: tests/e2e (e2e.sh explorer).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { WebSocketServer, WebSocket } from 'ws'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 'c-ex', clusterName: 'ex', orgId: 'org-a', ownerId: 'u-a', k8sVersion: '1.35.0', addons: { explorer: true }, masterNodes: [{ ip: '10.0.0.5', username: 'root', password: 'x' }], workerNodes: [] }
]))

const { authService } = await import('../src/services/authService.js')
const { automationEngine } = await import('../src/services/automationEngine.js')
const { clusterTunnel } = await import('../src/services/clusterTunnel.js')
const { agentService } = await import('../src/services/agentService.js')
const { requireAuth } = await import('../src/middleware/authMiddleware.js')
const { explorerHttp, explorerUpgrade, EXPLORER_PATH, identityFor, upstreamHeaders, cspFor } = await import('../src/services/explorerProxy.js')
const { summarizeReadiness, summarizeAudit } = await import('../src/services/explorerInsights.js')

// tokens → users (no user store needed)
const USERS = {
    'tok-viewer': { id: 'u-v', username: 'vic', role: 'viewer', orgId: 'org-a' },
    'tok-admin': { id: 'u-a', username: 'alice', role: 'admin', orgId: 'org-a' },
    'tok-other': { id: 'u-o', username: 'eve', role: 'admin', orgId: 'org-b' }
}
authService.verifyToken = (t) => USERS[t] || null

// ── Fake Radar ──
let lastHeaders = null
const radar = http.createServer((req, res) => {
    lastHeaders = req.headers
    if (req.url.endsWith('/api/health')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}') }
    if (req.url.endsWith('/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: one\n\n')
        setTimeout(() => { res.write('data: two\n\n'); res.end() }, 100)
        return
    }
    if (req.url.endsWith('/api/upgrade-readiness?target=1.36')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ verdict: 'blocked', currentVersion: 'v1.35.2', targetVersion: 'v1.36', reviewedThrough: '1.37', summary: { blocked: 1, warnings: 1, passed: 20 },
            checks: [{ id: 'removed-apis', title: 'Removed APIs', status: 'blocked', findings: [{ level: 'blocker', title: 'flowcontrol v1beta3 is removed', impact: 'x', remediation: 'y', resource: { kind: 'FlowSchema', name: 'fs1' } }] },
                     { id: 'pdb', title: 'PDBs', status: 'warning', findings: [{ level: 'warning', title: 'PDB blocks drain', resource: { kind: 'PodDisruptionBudget', namespace: 'shop', name: 'db' } }] }] }))
    }
    if (req.method === 'POST') { let b = ''; req.on('data', c => b += c); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('got:' + b) }); return }
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' })
    res.end('<!doctype html><html><head><script>window.__theme="dark"</script><script type="module" src="/x.js"></script></head><body>radar</body></html>')
})
const radarWs = new WebSocketServer({ server: radar })
radarWs.on('connection', (ws, req) => { lastHeaders = req.headers; ws.on('message', m => ws.send('echo:' + m)) })

let kz, kzUrl, radarPort
before(async () => {
    await new Promise(r => radar.listen(0, '127.0.0.1', r))
    radarPort = radar.address().port
    // the cluster's Service IP, and the tunnel → our fake Radar
    automationEngine.connectSSH = async () => ({ execCommand: async () => ({ code: 0, stdout: '10.96.0.42', stderr: '' }), dispose() {} })
    clusterTunnel.open = async () => net.connect(radarPort, '127.0.0.1')

    const app = express()
    app.use(EXPLORER_PATH, cookieParser(), requireAuth, explorerHttp)
    kz = http.createServer(app)
    kz.on('upgrade', (req, socket, head) => explorerUpgrade(req, socket, head, []))
    await new Promise(r => kz.listen(0, '127.0.0.1', r))
    kzUrl = `http://127.0.0.1:${kz.address().port}`
})
after(() => { kz?.close(); radar.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

const get = (p, headers = {}) => fetch(kzUrl + p, { headers })

test('identity: KubeEZ role → Kubernetes groups, no reserved names', () => {
    assert.deepEqual(identityFor({ username: 'alice', role: 'admin', orgId: 'o1' }), { user: 'kubeez:alice', groups: ['kubeez:admins', 'kubeez:org:o1'] })
    assert.equal(identityFor({ username: 'op', role: 'operator', orgId: 'o1' }).groups[0], 'kubeez:operators')
    assert.equal(identityFor({ username: 'v', role: 'viewer' }).groups[0], 'kubeez:viewers')
    assert.equal(identityFor({ username: 'x', role: 'superadmin' }).groups[0], 'kubeez:admins')
    assert.equal(identityFor({ username: 'evil,system:masters', role: 'viewer' }).user, 'kubeez:evil_system_masters')
    const h = upstreamHeaders({ cookie: 'token=SECRET; radar_session=abc', authorization: 'Bearer SECRET', 'X-Forwarded-User': 'admin', 'x-forwarded-groups': 'system:masters', host: 'k' }, { username: 'v', role: 'viewer', orgId: 'o' })
    assert.equal(h.cookie, undefined, 'no cookies reach Radar (its session cookie would beat the headers)')
    assert.equal(h.authorization, undefined)
    assert.equal(h['x-forwarded-user'], 'kubeez:v')
    assert.equal(h['x-forwarded-groups'], 'kubeez:viewers,kubeez:org:o')
    assert.equal(Object.keys(h).filter(k => k.toLowerCase() === 'x-forwarded-user').length, 1)
})

test('CSP pins exactly the inline scripts of the page', () => {
    const csp = cspFor('<script>a()</script><script src="/b.js"></script><script> </script>')
    assert.equal((csp.match(/'sha256-/g) || []).length, 1)
    assert.match(csp, /frame-ancestors 'self'/)
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
})

test('proxy: login required, workspace enforced', async () => {
    assert.equal((await get('/api/clusters/c-ex/explorer/')).status, 401)
    assert.equal((await get('/api/clusters/c-ex/explorer/', { cookie: 'token=tok-other' })).status, 403)
    assert.equal((await get('/api/clusters/nope/explorer/', { cookie: 'token=tok-admin' })).status, 404)
})

test('proxy: spoofed identity replaced, KubeEZ credentials never reach Radar', async () => {
    const r = await get('/api/clusters/c-ex/explorer/api/health', {
        cookie: 'token=tok-viewer; radar_session=r1', 'x-forwarded-user': 'admin', 'x-forwarded-groups': 'kubeez:admins'
    })
    assert.equal(r.status, 200)
    assert.equal(lastHeaders['x-forwarded-user'], 'kubeez:vic')
    assert.equal(lastHeaders['x-forwarded-groups'], 'kubeez:viewers,kubeez:org:org-a')
    assert.equal(lastHeaders.cookie, undefined)
    assert.ok(!JSON.stringify(lastHeaders).includes('tok-viewer'))
})

test('proxy: pages get the hashed CSP and can be framed by KubeEZ only', async () => {
    const r = await get('/api/clusters/c-ex/explorer/', { cookie: 'token=tok-admin', accept: 'text/html' })
    assert.equal(r.status, 200)
    assert.match(await r.text(), /radar/)
    assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval' 'sha256-/)
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.equal(lastHeaders['accept-encoding'], undefined, 'pages are fetched uncompressed so they can be hashed')
})

test('proxy: request bodies and server-sent events stream through', async () => {
    const p = await fetch(kzUrl + '/api/clusters/c-ex/explorer/api/apply', { method: 'POST', headers: { cookie: 'token=tok-admin' }, body: 'kind: Pod' })
    assert.equal(await p.text(), 'got:kind: Pod')
    const s = await get('/api/clusters/c-ex/explorer/api/events', { cookie: 'token=tok-admin' })
    assert.equal(await s.text(), 'data: one\n\ndata: two\n\n')
})

test('WebSocket: authenticated, workspace-checked, tunnelled both ways', async () => {
    const wsUrl = kzUrl.replace('http', 'ws') + '/api/clusters/c-ex/explorer/api/pods/shop/db/exec'
    const ws = new WebSocket(wsUrl, { headers: { cookie: 'token=tok-admin', 'x-forwarded-user': 'root' } })
    const reply = await new Promise((res, rej) => { ws.on('open', () => ws.send('ls')); ws.on('message', m => res(String(m))); ws.on('error', rej) })
    assert.equal(reply, 'echo:ls')
    assert.equal(lastHeaders['x-forwarded-user'], 'kubeez:alice')
    ws.close()
    const denied = await new Promise(res => { const w = new WebSocket(wsUrl); w.on('unexpected-response', (q, r) => res(r.statusCode)); w.on('error', () => res('error')) })
    assert.equal(denied, 401)
    const otherOrg = await new Promise(res => { const w = new WebSocket(wsUrl, { headers: { cookie: 'token=tok-other' } }); w.on('unexpected-response', (q, r) => res(r.statusCode)); w.on('error', () => res('error')) })
    assert.equal(otherOrg, 403)
    const crossSite = await new Promise(res => { const w = new WebSocket(wsUrl, { headers: { cookie: 'token=tok-admin', origin: 'https://evil.example' } }); w.on('unexpected-response', (q, r) => res(r.statusCode)); w.on('error', () => res('error')) })
    assert.equal(crossSite, 403)
})

test('upgrade readiness + audit summaries for KubeEZ screens', async () => {
    const { explorerApi } = await import('../src/services/explorerProxy.js')
    const raw = await explorerApi({ id: 'c-ex', masterNodes: [{ ip: '10.0.0.5' }] }, USERS['tok-admin'], '/api/upgrade-readiness?target=1.36')
    const s = summarizeReadiness(raw, 'c-ex')
    assert.equal(s.verdict, 'blocked')
    assert.equal(s.blockers.length, 1)
    assert.equal(s.blockers[0].resource.kind, 'FlowSchema')
    assert.equal(s.warnings[0].resource.namespace, 'shop')
    assert.equal(s.detailsUrl, '/api/clusters/c-ex/explorer/checks/upgrade')
    const a = summarizeAudit({ summary: { passing: 80, warning: 10, danger: 10, categories: { Security: { passing: 1, warning: 2, danger: 3 } } },
        groupedChecks: [{ title: 'A', effectiveSeverity: 'warning', affectedResources: 9 }, { title: 'B', effectiveSeverity: 'danger', affectedResources: 1 }, { title: 'C', effectiveSeverity: 'passing' }] }, 'c-ex')
    assert.equal(a.score, 84)
    assert.deepEqual(a.top.map(t => t.title), ['B', 'A'], 'critical first')
})

test('Gateway Agent: old builds are refused clearly, new builds relay TCP both ways', async () => {
    const sent = []
    const fakeWs = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) }
    agentService.agentSockets.set('ag-old', fakeWs)
    await assert.rejects(agentService.openTcp('ag-old', { ip: '10.0.0.5' }, '10.96.0.42', 9280), (e) => e.code === 'AGENT_OUTDATED')

    agentService.agentSockets.set('ag-new', fakeWs)
    agentService.agentCaps.set('ag-new', new Set(['tcp']))
    const p = agentService.openTcp('ag-new', { ip: '10.0.0.5', username: 'root', password: 'pw' }, '10.96.0.42', 9280)
    const open = sent.find(m => m.type === 'tcp-open')
    assert.deepEqual([open.host, open.port, open.ip], ['10.96.0.42', 9280, '10.0.0.5'])
    agentService._onTcpMessage('ag-other', { type: 'tcp-opened', streamId: open.streamId })   // another agent can't hijack it
    agentService._onTcpMessage('ag-new', { type: 'tcp-opened', streamId: open.streamId })
    const duplex = await p
    duplex.write('hello')
    assert.equal(Buffer.from(sent.find(m => m.type === 'tcp-data').data, 'base64').toString(), 'hello')
    const got = new Promise(r => duplex.once('data', d => r(String(d))))
    agentService._onTcpMessage('ag-new', { type: 'tcp-data', streamId: open.streamId, data: Buffer.from('world').toString('base64') })
    assert.equal(await got, 'world')
    agentService._closeTcpForAgent('ag-new', new Error('gone'))
    assert.equal(agentService.tcpStreams.size, 0)
})

test('proxy: cross-site changes are refused (CSRF), same-site ones pass', async () => {
    const evil = await fetch(kzUrl + '/api/clusters/c-ex/explorer/api/apply', { method: 'POST', headers: { cookie: 'token=tok-admin', origin: 'https://evil.example' }, body: 'x' })
    assert.equal(evil.status, 403)
    const ok = await fetch(kzUrl + '/api/clusters/c-ex/explorer/api/apply', { method: 'POST', headers: { cookie: 'token=tok-admin', origin: kzUrl }, body: 'x' })
    assert.equal(ok.status, 200)
})
