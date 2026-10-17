// KubeEZ as an MCP server — AI assistants (Claude Code, Claude Desktop,
// Cursor…) can ask KubeEZ about the member's clusters with read-only tools.
// Personal tokens (kzm_…, stored hashed, shown once) act as their member with
// the member's CURRENT permissions; a suspended or removed member's tokens stop
// working. Nothing here changes a cluster. Every call is in the audit trail.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'
import { authService } from '../authService.js'
import { auditLog } from '../auditLog.js'
import { canOn } from '../accessControl.js'
import { label as reasonLabel } from '../../config/incidentCatalog.js'
import { visibleClusters, findCluster, openIncidents, riskOf, fleetFor, advisorFor } from './insights.js'
import { explainIncidentFull } from './incidentExplain.js'
import { collectChanges, changesText } from './changes.js'
import { aiStore } from './aiStore.js'
import { incidentDetector } from '../incidentDetector.js'

// ── personal tokens ──
const FILE = path.join(DATA_DIR, 'ai-mcp-tokens.json')
const MAX_PER_USER = 10, CALLS_PER_HOUR = 120
let cache = null
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { cache = [] } } return cache }
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(load())) }
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex')
const view = ({ hash: _h, calls, ...t }) => t

export const mcpTokens = {
    list: (userId) => load().filter(t => t.userId === userId).map(view),
    create(user, { name, days }) {
        const n = String(name || '').trim().slice(0, 60)
        if (n.length < 2) throw Object.assign(new Error('Give the token a name (e.g. "Claude Code on my laptop")'), { status: 400 })
        if (![30, 90, 365].includes(Number(days))) throw Object.assign(new Error('Valid for 30, 90 or 365 days'), { status: 400 })
        if (load().filter(t => t.userId === user.id).length >= MAX_PER_USER) throw Object.assign(new Error(`At most ${MAX_PER_USER} tokens — revoke an old one`), { status: 400 })
        const token = `kzm_${crypto.randomBytes(24).toString('base64url')}`
        const rec = { id: crypto.randomBytes(5).toString('hex'), userId: user.id, orgId: user.orgId, name: n, prefix: token.slice(0, 10), hash: hash(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + Number(days) * 86400e3).toISOString(), lastUsedAt: null, calls: [] }
        load().push(rec); persist()
        return { ...view(rec), token }
    },
    revoke(user, id) {
        const all = load(); const i = all.findIndex(t => t.id === id && t.userId === user.id)
        if (i < 0) throw Object.assign(new Error('Token not found'), { status: 404 })
        all.splice(i, 1); persist()
    },
    /** The member a token acts as (null = invalid / expired / member gone or suspended) */
    resolve(token) {
        if (!/^kzm_[A-Za-z0-9_-]{20,}$/.test(String(token || ''))) return null
        const rec = load().find(t => t.hash === hash(token))
        if (!rec || Date.parse(rec.expiresAt) < Date.now()) return null
        const u = authService.getUserById(rec.userId)
        if (!u || u.isSuspended || u.orgId !== rec.orgId) return null
        return { rec, user: { ...u, clusterAccess: u.clusterAccess || [] } }
    },
    /** Rate limit + last used; false = over the limit */
    touch(rec) {
        const now = Date.now()
        rec.calls = (rec.calls || []).filter(t => now - t < 3600e3)
        if (rec.calls.length >= CALLS_PER_HOUR) return false
        rec.calls.push(now); rec.lastUsedAt = new Date(now).toISOString()
        persist()
        return true
    },
    _reset() { cache = null }
}

// ── tools ──
const S = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false })
const clusterArg = { cluster: { type: 'string', description: 'Cluster name or id (from list_clusters)' } }
export const TOOLS = [
    { name: 'list_clusters', title: 'List clusters', description: 'All Kubernetes clusters you can see in KubeEZ, with version, nodes, risk score and open problems.', inputSchema: S(), annotations: { readOnlyHint: true } },
    { name: 'fleet_overview', title: 'Fleet overview', description: 'Across all clusters: riskiest clusters, Kubernetes version spread, add-ons on different versions, and the same problem on several clusters.', inputSchema: S(), annotations: { readOnlyHint: true } },
    { name: 'cluster_risk', title: 'Cluster risk', description: 'The risk score of one cluster (100 = no known risk) with every reason and how to fix it.', inputSchema: S(clusterArg, ['cluster']), annotations: { readOnlyHint: true } },
    { name: 'list_incidents', title: 'Open problems', description: 'Open problems (incidents) KubeEZ detected — on one cluster or all. Use the id with explain_incident.', inputSchema: S({ cluster: { type: 'string', description: 'Optional: only this cluster (name or id)' } }), annotations: { readOnlyHint: true } },
    { name: 'explain_incident', title: 'Explain a problem', description: 'KubeEZ AI explains why a problem happens: cause, proof from logs/events (checked against the real data), what changed just before, and steps. May take a minute.', inputSchema: S({ incident_id: { type: 'string', description: 'The id from list_incidents' } }, ['incident_id']), annotations: { readOnlyHint: true } },
    { name: 'what_changed', title: 'What changed', description: 'Everything that changed on a cluster: KubeEZ actions and Kubernetes changes (rollouts with old → new image, Helm, ConfigMaps/Secrets by name, nodes).', inputSchema: S({ ...clusterArg, hours: { type: 'number', description: 'How far back, 1–168 hours (default 24)' } }, ['cluster']), annotations: { readOnlyHint: true } },
    { name: 'advisor', title: 'Security & cost advisor', description: 'Security findings per workload (privileged, host access, secrets in env, root, no limits…) and cost advice (requests vs real use, savings).', inputSchema: S(clusterArg, ['cluster']), annotations: { readOnlyHint: true } }
]

const fail = (m) => Object.assign(new Error(m), { tool: true })
async function cluster(user, ref) { const c = await findCluster(user, ref); if (!c) throw fail(`No cluster "${ref}" that you can see — use list_clusters`); return c }

async function run(user, name, args = {}) {
    switch (name) {
        case 'list_clusters': {
            const cs = await visibleClusters(user)
            if (!cs.length) return 'No clusters.'
            const inc = openIncidents(user, cs)
            const lines = []
            for (const c of cs) { const r = await riskOf(c, { deep: false }); lines.push(`- ${c.clusterName} (id ${c.id}): Kubernetes ${c.k8sVersion}, ${(c.masterNodes || []).length} control-plane + ${(c.workerNodes || []).length} worker node(s), risk ${r.score}/100 (${r.level})${r.factors[0] ? ` — ${r.factors[0].label}` : ''}, ${inc.filter(i => i.clusterId === c.id).length} open problem(s)`) }
            return lines.join('\n')
        }
        case 'fleet_overview': {
            const f = await fleetFor(user)
            return [
                `${f.totals.clusters} clusters — ${f.totals.high} high risk, ${f.totals.medium} medium, ${f.totals.low} low; ${f.totals.open} open problems (${f.totals.critical} critical).`,
                ...f.clusters.map(c => `- ${c.name}: risk ${c.risk?.score ?? '?'}${c.risk?.top ? ` (${c.risk.top})` : ''}, Kubernetes ${c.k8sVersion}, ${c.open} open`),
                `Kubernetes versions: ${f.k8s.versions.map(v => `${v.version}${v.supported === false ? ' (out of support)' : ''} on ${v.clusters.join(', ')}`).join('; ')}`,
                f.addonDrift.length ? `Add-ons on different versions: ${f.addonDrift.map(d => `${d.addon} (${d.versions.map(v => `${v.version}: ${v.clusters.join(', ')}`).join(' / ')})`).join('; ')}` : 'Add-ons: the same versions everywhere.',
                f.shared.length ? `Same problem on several clusters: ${f.shared.map(s => `${s.label}${s.workload ? ` on ${s.workload}` : ''} — ${s.clusters.join(', ')}`).join('; ')}` : 'No problem shared by several clusters.'
            ].join('\n')
        }
        case 'cluster_risk': {
            const c = await cluster(user, args.cluster)
            const r = await riskOf(c, { deep: true })
            return [`${c.clusterName}: risk ${r.score}/100 (${r.level})`, ...r.factors.map(f => `- −${f.points} ${f.label}: ${f.detail || ''} → ${f.fix}`), r.good.length ? `Fine: ${r.good.join(', ')}` : ''].filter(Boolean).join('\n')
        }
        case 'list_incidents': {
            const cs = args.cluster ? [await cluster(user, args.cluster)] : await visibleClusters(user)
            const inc = openIncidents(user, cs)
            if (!inc.length) return 'No open problems.'
            return inc.slice(0, 50).map(i => `- [${i.id}] ${i.severity} · ${reasonLabel(i.reason)} — ${i.clusterName}: ${i.namespace ? `${i.namespace}/` : ''}${i.target} — ${i.message} (since ${i.timestamp})`).join('\n')
        }
        case 'explain_incident': {
            const inc = incidentDetector.find(String(args.incident_id || ''))
            const c = inc && await findCluster(user, inc.clusterId)
            if (!inc || !c || !canOn(user, 'incident:view', c)) throw fail('No such problem that you can see — use list_incidents')
            if (!canOn(user, 'ai:use')) throw fail('Your role may not use KubeEZ AI')
            if (!aiStore.get(user.orgId).enabled) throw fail('KubeEZ AI is turned off in this workspace')
            const out = await explainIncidentFull(user, inc, c)
            const a = out.answer
            return [`${reasonLabel(inc.reason)} on ${c.clusterName}: ${inc.namespace ? `${inc.namespace}/` : ''}${inc.target}`, `Summary: ${a.summary}`, a.cause ? `Cause: ${a.cause}` : '', a.change ? `Likely triggered by: ${a.change}` : '',
                a.evidence?.length ? `Proof (lines found in the real data):\n${a.evidence.map(e => `  > ${e}`).join('\n')}` : '', a.fix?.length ? `Steps:\n${a.fix.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}` : '',
                a.blockedSteps?.length ? `(KubeEZ removed ${a.blockedSteps.length} step(s) that would damage the cluster.)` : '', a.action ? `KubeEZ can preview and apply this fix in its UI: ${a.action.type} ${a.action.kind}/${a.action.name}` : '',
                `Confidence: ${a.confidence}. Engine: ${out.engine.provider} (${out.engine.model}).`].filter(Boolean).join('\n')
        }
        case 'what_changed': {
            const c = await cluster(user, args.cluster)
            const hours = Math.min(168, Math.max(1, Number(args.hours) || 24))
            const r = await collectChanges(c, { hours })
            return r.items.length ? `${c.clusterName}, last ${hours} h (${r.items.length} change(s))${r.clusterError ? ` — ${r.clusterError}` : ''}:\n${changesText(r.items, 60)}` : `${c.clusterName}: no changes in the last ${hours} h.${r.clusterError ? ` (${r.clusterError})` : ''}`
        }
        case 'advisor': {
            const c = await cluster(user, args.cluster)
            const a = await advisorFor(user, c)
            const sec = a.security.findings.filter(f => f.scope === 'app').slice(0, 30)
            return [`${c.clusterName} — security ${a.security.score}/100 (${a.security.counts.high} high, ${a.security.counts.medium} medium, ${a.security.counts.low} low)`,
                ...sec.map(f => `- [${f.severity}] ${f.namespace}/${f.workload}: ${f.text} → ${f.fix}`),
                a.cost.savings ? `Cost: ${a.cost.savings.text}` : '', ...a.cost.workloads.filter(w => w.scope === 'app').slice(0, 20).map(w => `- ${w.namespace}/${w.workload}: ${w.advice.text}`)].filter(Boolean).join('\n')
        }
    }
    throw fail(`Unknown tool ${name}`)
}

// ── JSON-RPC (MCP over streamable HTTP, stateless, JSON responses) ──
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

/** One JSON-RPC message from an MCP client → the response object, or null for a notification. */
export async function handleMcp(msg, { user, rec, ip }) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request')
    const { id, method, params = {} } = msg
    if (id === undefined) return null   // a notification (e.g. notifications/initialized)
    switch (method) {
        case 'initialize': return { jsonrpc: '2.0', id, result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'kubeez', title: 'KubeEZ', version: '1.0.0' },
            instructions: 'KubeEZ manages Kubernetes clusters on the user\'s own servers. These tools are read-only: start with list_clusters or fleet_overview, use list_incidents → explain_incident for problems, what_changed when something broke, advisor for security and cost. Changes (fixes, YAML) are applied in the KubeEZ web UI, where they are previewed and can be undone.'
        } }
        case 'ping': return { jsonrpc: '2.0', id, result: {} }
        case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
        case 'tools/call': {
            const name = String(params.name || '')
            if (!TOOLS.some(t => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`)
            auditLog.record({ orgId: user.orgId, actor: user, ip, action: 'ai.mcp', detail: `${name} ${JSON.stringify(params.arguments || {}).slice(0, 150)} (token ${rec.name})` })
            try {
                const text = await run(user, name, params.arguments || {})
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text).slice(0, 60000) }], isError: false } }
            } catch (e) {
                // tool errors go back to the model as text, so it can correct itself
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.tool ? e.message : `KubeEZ could not do this: ${e.message}` }], isError: true } }
            }
        }
        default: return rpcError(id, -32601, `Method not found: ${method}`)
    }
}
