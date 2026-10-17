// KubeEZ AI phase 6: fleet view, the MCP server (tokens, JSON-RPC, read-only
// tools, isolation), the AI-BOM (CycloneDX) and learning from 👍 answers.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { startServer, client, tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
const { fleetView, workloadName } = await import('../src/services/ai/fleet.js')
const { learnFromTrace, examplesFor, datasetJsonl, _reset: resetLearning } = await import('../src/services/ai/learning.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { giveFeedback } = await import('../src/services/ai/quality.js')
const { explainIncident } = await import('../src/services/ai/doctor.js')
after(() => { process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

describe('fleet', () => {
    const clusters = [
        { id: 'a', clusterName: 'prod-in', k8sVersion: '1.37.0', addons: { monitoring: true, longhorn: true }, masterNodes: [{}, {}, {}], workerNodes: [{}] },
        { id: 'b', clusterName: 'prod-sg', k8sVersion: '1.36.2', addons: { monitoring: true }, masterNodes: [{}], workerNodes: [] },
        { id: 'c', clusterName: 'old-lab', k8sVersion: '1.33.1', addons: {}, masterNodes: [{}], workerNodes: [] }
    ]
    const inc = (id, clusterId, clusterName, reason, extra = {}) => ({ id, clusterId, clusterName, reason, severity: 'warning', target: 'x', ...extra })
    const incidents = [
        inc('1', 'a', 'prod-in', 'CrashLoopBackOff', { namespace: 'shop', target: 'web-7d9f8c6b5-x2k', owner: 'ReplicaSet/web-7d9f8c6b5' }),
        inc('2', 'b', 'prod-sg', 'CrashLoopBackOff', { namespace: 'shop', target: 'web-5c4d3b2a1-q1', owner: 'ReplicaSet/web-5c4d3b2a1' }),
        inc('3', 'a', 'prod-in', 'NodeDiskFilling', { target: 'w1' }), inc('4', 'b', 'prod-sg', 'NodeDiskFilling', { target: 'w9' }), inc('5', 'c', 'old-lab', 'NodeDiskFilling', { target: 'n1', severity: 'critical' })
    ]
    test('the same problem on several clusters, version and add-on drift, riskiest first', () => {
        const f = fleetView({ clusters, incidents, risks: { a: { score: 70, level: 'medium' }, b: { score: 40, level: 'high' }, c: { score: 90, level: 'low' } }, addonVersion: (cid, k) => k === 'monitoring' ? (cid === 'a' ? '75.0.0' : '72.1.0') : null })
        assert.deepEqual(f.clusters.map(c => c.name), ['prod-sg', 'prod-in', 'old-lab'])
        const web = f.shared.find(s => s.workload === 'shop/web')
        assert.deepEqual(web.clusters.sort(), ['prod-in', 'prod-sg'], 'one app crashing on two clusters (different pod hashes)')
        assert.equal(f.shared.find(s => s.reason === 'NodeDiskFilling').clusters.length, 3)
        assert.equal(f.k8s.spread, 4)
        assert.equal(f.k8s.versions.find(v => v.version === '1.33.1').supported, false)
        assert.deepEqual(f.addonDrift.map(d => d.addon), ['monitoring'])
        assert.equal(f.totals.unsupported, 1); assert.equal(f.totals.critical, 1)
        assert.equal(workloadName({ target: 'deployment/api' }), 'api')
        assert.equal(workloadName({ owner: 'StatefulSet/pg' }), 'pg')
    })
})

describe('learning from 👍 answers', () => {
    const org = 'org-learn'
    test('a confirmed explanation becomes a worked example the next prompt sees; the dataset is masked JSONL', async () => {
        aiStore.addTrace(org, { id: 'aaaaaaaaaaa1', ok: true, purpose: 'incident explainer', provider: 'P', model: 'm', answer: '{"summary":"web crashes: DB_HOST is wrong","cause":"DB_HOST points to db-old","fix":["Set DB_HOST=db","Restart"]}', question: 'Why?', meta: { reason: 'CrashLoopBackOff', specialist: 'app', input: 'Incident: Pod crash loop on shop/web' } })
        aiStore.addTrace(org, { id: 'aaaaaaaaaaa2', ok: true, purpose: 'try it', provider: 'P', model: 'm', answer: 'A pod is…', question: 'What is a pod?' })
        giveFeedback({ username: 'asha', orgId: org }, 'aaaaaaaaaaa1', { rating: 'up' })
        giveFeedback({ username: 'asha', orgId: org }, 'aaaaaaaaaaa2', { rating: 'up' })
        const ex = examplesFor(org, 'CrashLoopBackOff')
        assert.equal(ex.length, 1); assert.equal(ex[0].answer.cause, 'DB_HOST points to db-old'); assert.equal(ex[0].by, 'asha')
        assert.equal(learnFromTrace(org, aiStore.traces(org).find(t => t.id === 'aaaaaaaaaaa1'), 'x'), null, 'once')
        resetLearning(); assert.equal(examplesFor(org, 'CrashLoopBackOff').length, 1, 'kept on disk')
        // the next explanation of a crash loop sees it
        let content = ''
        const m = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { content = JSON.parse(b).messages.map(x => x.content).join('\n'); res.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"x crashes","cause":"y","fix":["z"],"evidence":[],"confidence":"low"}' } }] })) }) })
        await new Promise(r => m.listen(0, '127.0.0.1', r))
        try {
            aiStore.addProvider(org, { name: 'F', kind: 'ollama', baseUrl: `http://127.0.0.1:${m.address().port}`, model: 'm' })
            await explainIncident({ id: 'u', username: 'a', orgId: org }, { incident: { id: 'i', reason: 'CrashLoopBackOff', severity: 'warning', status: 'unresolved', target: 'api-1', namespace: 'shop', message: 'crash', timestamp: 't', lastSeen: 't', timeline: [] }, catalog: {}, cluster: { id: 'c', orgId: org, clusterName: 'c' }, fresh: { data: [], workload: null }, changes: [] })
            assert.match(content, /worked examples the team confirmed/); assert.match(content, /DB_HOST points to db-old/)
            const t = aiStore.traces(org)[0]
            assert.equal(t.meta.reason, 'CrashLoopBackOff'); assert.match(t.meta.input, /Target: shop\/api-1/)
        } finally { m.close() }
        const lines = datasetJsonl(org).trim().split('\n').map(l => JSON.parse(l))
        assert.equal(lines.length, 2)
        assert.deepEqual(lines[0].messages.map(x => x.role), ['system', 'user', 'assistant'])
    })
})

describe('MCP server, AI-BOM (API)', () => {
    let srv, api, owner, viewer, other
    const mcp = (token, body) => fetch(`${srv.url}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    before(async () => {
        srv = await startServer()
        api = client(srv)
        const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).data
        const root = await login('root', 'secret123')
        owner = (await api('POST', '/api/auth/register', null, { username: 'p6boss', password: 'secret123', email: 'p6boss@example.com' })).data
        assert.equal((await api('PUT', `/api/superadmin/users/${owner.user.id}/limits`, root.token, { plan: 'FREE', maxClusters: 3, maxNodes: 10, maxMembers: 4 })).status, 200)
        assert.equal((await api('POST', '/api/admin/users', owner.token, { username: 'p6view', password: 'secret123', email: 'p6view@example.com', role: 'viewer' })).status, 200)
        viewer = await login('p6view', 'secret123')
        other = (await api('POST', '/api/auth/register', null, { username: 'p6other', password: 'secret123', email: 'p6other@example.com' })).data
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
            { id: 'c6', clusterName: 'six', orgId: owner.user.orgId, ownerId: owner.user.id, k8sVersion: '1.36.0', status: 'completed', masterNodes: [{ ip: '192.0.2.66', username: 'root' }], workerNodes: [] },
            { id: 'cx', clusterName: 'secret-cluster', orgId: other.user.orgId, ownerId: other.user.id, k8sVersion: '1.36.0', status: 'completed', masterNodes: [{ ip: '192.0.2.67', username: 'root' }], workerNodes: [] }
        ]))
    })
    after(() => srv?.stop())

    test('MCP: a token, the handshake, the tools — read-only, the member\'s own clusters only', async () => {
        assert.equal((await mcp(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401)
        assert.equal((await api('POST', '/api/ai/mcp/tokens', viewer.token, { name: 'x', days: 7 })).status, 400)
        const t = await api('POST', '/api/ai/mcp/tokens', viewer.token, { name: 'Claude Code', days: 30 })
        assert.equal(t.status, 200); assert.match(t.data.token, /^kzm_/)
        assert.equal((await api('GET', '/api/ai/mcp/tokens', viewer.token)).data.tokens[0].token, undefined, 'shown once, stored hashed')
        assert.equal(fs.readFileSync(path.join(srv.dataDir, 'ai-mcp-tokens.json'), 'utf8').includes(t.data.token), false)
        const tok = t.data.token
        const init = await (await mcp(tok, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json()
        assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'kubeez'); assert.ok(init.result.capabilities.tools)
        assert.equal((await mcp(tok, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
        const tools = (await (await mcp(tok, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools
        assert.deepEqual(tools.map(x => x.name), ['list_clusters', 'fleet_overview', 'cluster_risk', 'list_incidents', 'explain_incident', 'what_changed', 'advisor'])
        assert.ok(tools.every(x => x.annotations.readOnlyHint && x.inputSchema.type === 'object'))
        const call = async (name, args = {}) => (await (await mcp(tok, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).json()).result
        const lc = await call('list_clusters')
        assert.equal(lc.isError, false); assert.match(lc.content[0].text, /six \(id c6\): Kubernetes 1\.36\.0/)
        assert.equal(lc.content[0].text.includes('secret-cluster'), false, 'another workspace\'s cluster is invisible')
        const nope = await call('cluster_risk', { cluster: 'secret-cluster' })
        assert.equal(nope.isError, true); assert.match(nope.content[0].text, /No cluster "secret-cluster"/)
        assert.match((await call('list_incidents')).content[0].text, /No open problems/)
        assert.match((await call('fleet_overview')).content[0].text, /^1 clusters/)
        const bad = await (await mcp(tok, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_cluster' } })).json()
        assert.equal(bad.error.code, -32602)
        assert.equal((await (await mcp(tok, { jsonrpc: '2.0', id: 5, method: 'resources/list' })).json()).error.code, -32601)
        assert.equal((await fetch(`${srv.url}/api/mcp`)).status, 405)
        const audit = JSON.stringify((await api('GET', '/api/compliance/audit?limit=300', owner.token)).data)
        assert.match(audit, /ai\.mcp/)
        assert.equal((await api('DELETE', `/api/ai/mcp/tokens/${t.data.id}`, viewer.token)).status, 200)
        assert.equal((await mcp(tok, { jsonrpc: '2.0', id: 6, method: 'ping' })).status, 401, 'revoked')
    })

    test('AI-BOM: admins only; prompts by hash, controls, CycloneDX 1.6', async () => {
        assert.equal((await api('GET', '/api/ai/bom', viewer.token)).status, 403)
        const b = await api('GET', '/api/ai/bom', owner.token)
        assert.equal(b.status, 200)
        assert.ok(b.data.prompts.length >= 10 && b.data.prompts.every(p => /^[0-9a-f]{64}$/.test(p.sha256)))
        assert.ok(b.data.controls.some(([k, v]) => k === 'Secret masking' && /always on/.test(v)))
        assert.equal(b.data.cyclonedx, undefined)
        const r = await fetch(`${srv.url}/api/ai/bom?format=cyclonedx`, { headers: { authorization: `Bearer ${owner.token}` } })
        assert.match(r.headers.get('content-disposition'), /kubeez-ai-bom-.*\.cdx\.json/)
        const cdx = await r.json()
        assert.equal(cdx.bomFormat, 'CycloneDX'); assert.equal(cdx.specVersion, '1.6'); assert.match(cdx.serialNumber, /^urn:uuid:/)
        assert.ok(cdx.components.some(c => c.type === 'data' && c.name === 'prompt: incident explainer'))
        assert.equal((await api('GET', '/api/ai/learning', owner.token)).status, 200)
        assert.equal((await api('GET', '/api/ai/learning', viewer.token)).status, 403)
    })
})
