import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { mcpTokens, handleMcp } from '../services/ai/mcp.js'
import { auditLog } from '../services/auditLog.js'

// /api/mcp — the MCP endpoint (Bearer kzm_… token, no browser session) and
// /api/ai/mcp/tokens — members manage their own tokens (mounted with requireAuth).
export const mcpEndpoint = express.Router()
export const mcpTokenRoutes = express.Router()

mcpEndpoint.post('/', async (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')
    const who = m && mcpTokens.resolve(m[1])
    if (!who) return res.status(401).set('WWW-Authenticate', 'Bearer realm="kubeez"').json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'A valid KubeEZ MCP token is needed (AI settings → MCP)' } })
    if (!mcpTokens.touch(who.rec)) return res.status(429).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32002, message: 'Too many calls — 120 an hour per token' } })
    if (Array.isArray(req.body)) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } })
    try {
        const out = await handleMcp(req.body, { user: who.user, rec: who.rec, ip: req.ip })
        if (!out) return res.status(202).end()   // notification
        res.json(out)
    } catch (e) { res.status(500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: e.message } }) }
})
// no server-sent stream: answers come back on the POST
mcpEndpoint.get('/', (req, res) => res.status(405).set('Allow', 'POST').end())
mcpEndpoint.delete('/', (req, res) => res.status(405).set('Allow', 'POST').end())

mcpTokenRoutes.get('/', requirePermission('ai:use'), (req, res) => res.json({ tokens: mcpTokens.list(req.user.id) }))
mcpTokenRoutes.post('/', requirePermission('ai:use'), (req, res) => {
    try {
        const t = mcpTokens.create(req.user, req.body || {})
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.mcp_token_created', detail: `${t.name} (${t.prefix}…, until ${t.expiresAt.slice(0, 10)})` })
        res.json(t)
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
mcpTokenRoutes.delete('/:id', requirePermission('ai:use'), (req, res) => {
    try {
        mcpTokens.revoke(req.user, req.params.id)
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.mcp_token_revoked', detail: req.params.id })
        res.json({ success: true })
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
