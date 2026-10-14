import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { can } from '../config/permissions.js'
import { clusterStore } from '../services/clusterStore.js'
import { canAccessResource } from '../utils/access.js'
import { terminalAccess, terminalRecorder, GRANT_MINUTES, announceRequest } from '../services/terminalAccess.js'

// Terminal access just in time (grants with a reason and a time limit,
// approvals) and the session recordings.
const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })
const sameOrg = (req) => (g) => req.user.role === 'superadmin' || g.orgId === req.user.orgId

// my grants for a cluster (and whether I may open the terminal now)
router.get('/grants/mine', requirePermission('terminal:access'), (req, res) => {
    const clusterId = String(req.query.clusterId || '')
    const mine = terminalAccess.list(g => g.userId === req.user.id && (!clusterId || g.clusterId === clusterId)).slice(0, 10)
    res.json({ active: terminalAccess.activeGrant(req.user.id, clusterId), grants: mine, minutes: GRANT_MINUTES, requireApproval: terminalAccess.settings(req.user.orgId).requireApproval, immediate: terminalAccess.immediate(req.user, req.user.orgId) })
})

router.post('/grants', requirePermission('terminal:access'), async (req, res) => {
    try {
        const c = (await clusterStore.getClusters()).find(x => x.id === req.body?.clusterId)
        if (!c || !canAccessResource(req.user, c)) return res.status(404).json({ error: 'Cluster not found' })
        const g = terminalAccess.request(req.user, c, req.body || {})
        await announceRequest(g)
        res.status(201).json(g)
    } catch (e) { fail(res, e) }
})

router.post('/grants/:id/revoke', requirePermission('terminal:access'), (req, res) => {
    try { res.json(terminalAccess.revoke(req.params.id, req.user)) } catch (e) { fail(res, e) }
})

// ── admins ──
router.get('/grants', requirePermission('access:approve'), (req, res) => {
    res.json({ grants: terminalAccess.list(sameOrg(req)).slice(0, 300), settings: terminalAccess.settings(req.user.orgId) })
})
router.post('/grants/:id/:decision(approve|deny)', requirePermission('access:approve'), (req, res) => {
    try { res.json(terminalAccess.decide(req.params.id, req.user, req.params.decision === 'approve')) } catch (e) { fail(res, e) }
})
router.put('/settings', requirePermission('access:approve'), (req, res) => {
    res.json(terminalAccess.setSettings(req.user.orgId, req.body || {}, req.user))
})

// ── recordings ──
const orgScope = (req) => req.user.role === 'superadmin' && req.query.all === '1' ? null : req.user.orgId
router.get('/sessions', requirePermission('audit:view'), (req, res) => {
    res.json({ sessions: terminalRecorder.list({ orgId: orgScope(req) }) })
})
router.get('/sessions/:id', requirePermission('audit:view'), (req, res) => {
    const rows = terminalRecorder.get(req.params.id, orgScope(req))
    if (!rows) return res.status(404).json({ error: 'Recording not found' })
    if (req.query.format === 'text') {
        const text = rows.map(r => r.type === 'start' ? `# KubeEZ terminal session ${r.id}\n# ${r.user?.username} (${r.user?.role}) on ${r.clusterName} — ${r.t}\n# reason: ${r.reason || '—'}\n`
            : r.type === 'cmd' ? `\n[${r.t}] $ ${r.command}    (${r.nodes.join(', ')})\n`
                : r.type === 'out' ? r.text.split('\n').map(l => l ? `[${r.node}] ${l}` : '').join('\n')
                    : r.type === 'end' ? `\n# ended ${r.t} (${r.why})\n` : `\n# ${r.text}\n`).join('')
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="terminal-${req.params.id.slice(0, 8)}.txt"`)
        return res.send(text)
    }
    res.json({ events: rows })
})

export { can }
export default router
