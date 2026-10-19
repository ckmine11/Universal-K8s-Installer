import express from 'express'
import rateLimit from 'express-rate-limit'
import { requirePermission } from '../middleware/authMiddleware.js'
import { PROVIDERS, providerById } from '../config/clusterProviders.js'
import { startSession, getSession, sessionView, accessManifest, agentManifest, connectScript, receiveCredentials, importKubeconfig, checkConnection, lowerToRead, rotateToken, cleanupCluster, CLEANUP, NS } from '../services/clusterImport.js'
import { capabilities, isImported, usesApi, closeForwarders } from '../services/clusterAccess.js'
import { clusterStore } from '../services/clusterStore.js'
import { canSeeCluster } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { encrypt } from '../utils/cryptoUtils.js'
import { auditLog } from '../services/auditLog.js'

// "Connected clusters": add an existing cluster (cloud or on-prem), see how
// each one is reached, change its access, reconnect or disconnect it.
// Mounted at /api/connect (signed in) and /api/import (the connect command —
// its one-time code is the only key).
const router = express.Router()
export const publicRouter = express.Router()

const baseUrlOf = (req) => (process.env.KUBEEZ_PUBLIC_URL || `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`).replace(/\/+$/, '')
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, code: e.code, hint: e.hint || null })

function commandsFor(s, base) {
    const sh = `curl -fsSL "${base}/api/import/${s.code}/connect.sh" | sh`
    const ps1 = `irm "${base}/api/import/${s.code}/connect.ps1" | iex`
    const agent = `kubectl apply -f "${base}/api/import/${s.code}/agent.yaml"`
    return { connect: { sh, ps1 }, agent, manifest: `${base}/api/import/${s.code}/access.yaml`, agentManifest: `${base}/api/import/${s.code}/agent.yaml`, cleanup: CLEANUP, namespace: NS }
}
const ownSession = (req, res) => {
    const s = getSession(req.params.code)
    if (!s || s.orgId !== req.user.orgId) { res.status(404).json({ error: 'This connect session has expired — start again.' }); return null }
    return s
}

// ── the wizard ──
router.get('/providers', (req, res) => res.json({ providers: PROVIDERS, saas: process.env.KUBEEZ_MODE === 'saas' }))

router.post('/sessions', requirePermission('cluster:create'), (req, res) => {
    try {
        const b = req.body || {}
        const labels = b.labels && typeof b.labels === 'object' && !Array.isArray(b.labels) ? Object.fromEntries(Object.entries(b.labels).slice(0, 20).map(([k, v]) => [String(k).toLowerCase().slice(0, 63), String(v).toLowerCase().slice(0, 63)]).filter(([k, v]) => /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(k) && /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(v))) : null
        const s = startSession(req.user, { name: b.name, provider: b.provider, method: b.method || 'auto', level: b.level || 'read', labels })
        res.json({ ...sessionView(s), commands: commandsFor(s, baseUrlOf(req)) })
    } catch (e) { fail(res, e) }
})
router.get('/sessions/:code', (req, res) => {
    const s = ownSession(req, res); if (!s) return
    res.json({ ...sessionView(s), commands: commandsFor(s, baseUrlOf(req)) })
})
router.post('/sessions/:code/kubeconfig', requirePermission('cluster:create'), async (req, res) => {
    const s = ownSession(req, res); if (!s) return
    try { res.json(await importKubeconfig(s.code, req.body?.kubeconfig)) } catch (e) { fail(res, e) }
})

// ── connected clusters ──
async function view(c) {
    const { agentService } = await import('../services/agentService.js')
    const a = c.access || {}
    const agentOnline = a.mode === 'agent' ? agentService.isAgentOnline(a.agentId) : a.mode === 'gateway' ? !!(a.gatewayAgentId && agentService.isAgentOnline(a.gatewayAgentId)) || !!(await agentService.getGatewayAgentForOwner(c.ownerId, 'admin', c.orgId)) : null
    const stale = a.lastOk && Date.now() - Date.parse(a.lastOk) > 15 * 60e3
    const status = !usesApi(c) ? 'ssh' : a.lastError && (!a.lastOk || Date.parse(a.checkedAt || 0) >= Date.parse(a.lastOk)) ? 'lost' : stale ? 'stale' : 'live'
    return {
        id: c.id, name: c.clusterName, provider: c.provider || null, providerName: providerById(c.provider)?.name || c.provider || 'Kubernetes', distro: c.distro || null,
        version: c.k8sVersion || null, nodeCount: c.nodeCount ?? ((c.masterNodes?.length || 0) + (c.workerNodes?.length || 0)), nodes: c.importedNodes || [],
        method: a.mode || 'ssh', level: a.level || 'full', server: a.mode === 'agent' ? null : (a.server || null), sshAdded: !!c.masterNodes?.length,
        status, lastOk: a.lastOk || null, checkedAt: a.checkedAt || null, lastError: a.lastError || null, lastHint: a.lastHint || null,
        connectedAt: a.connectedAt || c.importedAt || null, agentId: a.agentId || null, agentOnline, labels: c.labels || {},
        features: capabilities(c)
    }
}
async function ownCluster(req, res) {
    const c = (await clusterStore.getClusters()).find(x => x.id === req.params.id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c) || !isImported(c)) { res.status(404).json({ error: 'Connected cluster not found' }); return null }
    return c
}

router.get('/clusters', requirePermission('cluster:view'), async (req, res) => {
    const list = (await clusterStore.getClusters()).filter(c => isImported(c) && canSeeCluster(req.user, c))
    res.json({ clusters: await Promise.all(list.map(view)) })
})
router.get('/clusters/:id', requirePermission('cluster:view'), async (req, res) => {
    const c = await ownCluster(req, res); if (!c) return
    res.json(await view(c))
})
router.post('/clusters/:id/check', requirePermission('cluster:view'), async (req, res) => {
    const c = await ownCluster(req, res); if (!c) return
    try { await checkConnection(c); res.json(await view((await clusterStore.getClusters()).find(x => x.id === c.id))) } catch (e) { fail(res, e) }
})

// a new connect command for this cluster (token lost, moved to the agent, more access…)
router.post('/clusters/:id/reconnect', requirePermission('cluster:delete'), async (req, res) => {
    const c = await ownCluster(req, res); if (!c) return
    try {
        const s = startSession(req.user, { name: c.clusterName, provider: c.provider && providerById(c.provider) ? c.provider : 'cloud-other', method: req.body?.method || (c.access?.mode === 'agent' ? 'agent' : 'auto'), level: req.body?.level || c.access?.level || 'read', clusterId: c.id })
        res.json({ ...sessionView(s), commands: commandsFor(s, baseUrlOf(req)) })
    } catch (e) { fail(res, e) }
})

// Read-only ↔ Full manage
router.put('/clusters/:id/level', requirePermission('cluster:delete'), async (req, res) => {
    const c = await ownCluster(req, res); if (!c) return
    const level = req.body?.level
    if (!['read', 'full'].includes(level)) return res.status(400).json({ error: 'Access: read or full' })
    if (!usesApi(c)) return res.status(400).json({ error: 'This cluster is reached over SSH — it already has full access.' })
    if (level === (c.access.level || 'read')) return res.json({ level, changed: false })
    try {
        if (level === 'read') {
            await lowerToRead(c)
            await clusterStore.saveCluster({ ...c, access: { ...c.access, level: 'read' } })
            auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'cluster.access_changed', target: { clusterId: c.id, clusterName: c.clusterName }, detail: 'Full manage → Read-only' })
            return res.json({ level: 'read', changed: true })
        }
        // more access needs the cluster's own admin: run the command once more
        const s = startSession(req.user, { name: c.clusterName, provider: providerById(c.provider) ? c.provider : 'cloud-other', method: c.access.mode === 'agent' ? 'agent' : 'auto', level: 'full', clusterId: c.id })
        res.json({ ...sessionView(s), commands: commandsFor(s, baseUrlOf(req)), level: c.access.level, sessionLevel: 'full', changed: false, needsCommand: true })
    } catch (e) { fail(res, e) }
})

// a new token: KubeEZ makes it itself with Full manage; read-only needs the command
router.post('/clusters/:id/rotate', requirePermission('cluster:delete'), async (req, res) => {
    const c = await ownCluster(req, res); if (!c) return
    if (!usesApi(c)) return res.status(400).json({ error: 'This cluster is reached over SSH.' })
    try {
        if (c.access.level === 'full' && c.access.mode !== 'agent') {
            const token = await rotateToken(c)
            closeForwarders(c.id)
            await clusterStore.saveCluster({ ...c, access: { ...c.access, token: encrypt(token), rotatedAt: new Date().toISOString() } })
            auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'cluster.token_rotated', target: { clusterId: c.id, clusterName: c.clusterName } })
            return res.json({ rotated: true })
        }
        if (c.access.mode === 'agent' && c.access.level === 'full') {
            // the agent sends the new token by itself when its Secret changes and it reconnects
            const token = await rotateToken(c)
            await clusterStore.saveCluster({ ...c, access: { ...c.access, token: encrypt(token), rotatedAt: new Date().toISOString() } })
            closeForwarders(c.id)
            auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'cluster.token_rotated', target: { clusterId: c.id, clusterName: c.clusterName } })
            return res.json({ rotated: true, note: 'Restart the agent so it picks up the new token: kubectl -n kubeez-system rollout restart deploy/kubeez-agent' })
        }
        const s = startSession(req.user, { name: c.clusterName, provider: providerById(c.provider) ? c.provider : 'cloud-other', method: c.access.mode === 'agent' ? 'agent' : 'auto', level: 'read', clusterId: c.id })
        res.json({ rotated: false, needsCommand: true, ...sessionView(s), commands: commandsFor(s, baseUrlOf(req)) })
    } catch (e) { fail(res, e) }
})

// disconnect: KubeEZ forgets it (and, with Full manage, removes its account from the cluster)
router.delete('/clusters/:id', requirePermission('cluster:delete'), async (req, res) => {
    const c = await ownCluster(req, res); if (!c) return
    try {
        let cleaned = false
        if (req.query.cleanup === '1' && usesApi(c) && c.access.level === 'full') cleaned = await cleanupCluster(c).catch(() => false)
        const { agentService } = await import('../services/agentService.js')
        if (c.access?.agentId) await agentService.deleteAgent(c.access.agentId, req.user.id, req.user.role, req.user.orgId).catch(() => { })
        closeForwarders(c.id)
        const { installationManager } = await import('../services/installationManager.js')
        await installationManager.deleteCluster(c.id)
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'cluster.disconnected', target: { clusterId: c.id, clusterName: c.clusterName }, detail: cleaned ? 'kubeez account removed from the cluster' : 'KubeEZ forgot the cluster' })
        res.json({ success: true, cleaned, cleanup: cleaned ? null : CLEANUP })
    } catch (e) { fail(res, e) }
})

// the KubeEZ agents running inside imported clusters
router.get('/agents', requirePermission('cluster:view'), async (req, res) => {
    const { agentService } = await import('../services/agentService.js')
    const clusters = await clusterStore.getClusters()
    const agents = (await agentService.getAgentsByOwner(req.user.id, req.user.role, req.user.orgId)).filter(a => a.kind === 'cluster')
    res.json({
        agents: agents.map(a => {
            const c = clusters.find(x => x.id === a.clusterId)
            return { agentId: a.agentId, label: a.label, clusterId: a.clusterId, clusterName: c?.clusterName || null, connected: !!c, online: agentService.isAgentOnline(a.agentId), status: a.status, lastSeen: a.lastSeen, createdAt: a.createdAt, caps: [...(agentService.agentCaps.get(a.agentId) || [])] }
        }).filter(a => !a.clusterId || clusters.some(c => c.id === a.clusterId && canSeeCluster(req.user, c)) || !a.connected)
    })
})
router.delete('/agents/:agentId', requirePermission('cluster:delete'), async (req, res) => {
    const { agentService } = await import('../services/agentService.js')
    const a = await agentService.getAgentById(req.params.agentId)
    if (!a || a.kind !== 'cluster' || a.orgId !== req.user.orgId) return res.status(404).json({ error: 'Agent not found' })
    try {
        await agentService.deleteAgent(a.agentId, req.user.id, req.user.role, req.user.orgId)
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'cluster.agent_removed', detail: a.label })
        res.json({ success: true, cleanup: `kubectl delete namespace ${NS}` })
    } catch (e) { fail(res, e) }
})

// ── the connect command (no login — the one-time code is the key) ──
const codeLimiter = rateLimit({ windowMs: 60e3, max: 60, standardHeaders: true, legacyHeaders: false })
publicRouter.use(codeLimiter)
const session = (req, res) => {
    const s = /^[A-Za-z0-9_-]{20,40}$/.test(req.params.code) && getSession(req.params.code)
    if (!s) { res.status(404).type('text/plain').send('This KubeEZ connect command has expired — open "Add existing cluster" in KubeEZ for a new one.\n'); return null }
    return s
}
publicRouter.get('/:code/access.yaml', (req, res) => { const s = session(req, res); if (!s) return; res.type('text/yaml').send(accessManifest(s.level)) })
publicRouter.get('/:code/agent.yaml', async (req, res) => { const s = session(req, res); if (!s) return; try { res.type('text/yaml').send(await agentManifest(s, baseUrlOf(req))) } catch (e) { res.status(500).type('text/plain').send(e.message) } })
publicRouter.get('/:code/connect.sh', (req, res) => { const s = session(req, res); if (!s) return; res.type('text/x-shellscript').send(connectScript(s, baseUrlOf(req), 'sh')) })
publicRouter.get('/:code/connect.ps1', (req, res) => { const s = session(req, res); if (!s) return; res.type('text/plain').send(connectScript(s, baseUrlOf(req), 'ps1')) })
publicRouter.post('/:code/credentials', express.json({ limit: '64kb' }), async (req, res) => {
    const s = session(req, res); if (!s) return
    // ?format=text: the connect script prints the answer as it is
    const text = req.query.format === 'text'
    try {
        const r = await receiveCredentials(s.code, req.body || {})
        text ? res.type('text/plain').send(`✔ ${r.message}\n  Open KubeEZ → Connected clusters.\n`) : res.json(r)
    } catch (e) {
        const message = `✘ KubeEZ could not connect: ${e.message}${e.hint ? `\n  ${e.hint}` : ''}`
        text ? res.status(e.status || 500).type('text/plain').send(`${message}\n`) : res.status(e.status || 500).json({ error: e.message, hint: e.hint || null, message })
    }
})

export default router
