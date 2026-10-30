import express from 'express'
import { features } from '../services/features.js'
import { auditLog } from '../services/auditLog.js'
import { authService } from '../services/authService.js'

// Feature flags (mounted at /api/features, signed in):
//   GET  /            the features of my workspace (on, available, labels)
//   PUT  /            { key: true|false } — a workspace admin turns available features off / on
//   GET  /platform    superadmin: availability on the whole server
//   PUT  /platform    superadmin: { key: true | false | null (follow KUBEEZ_FEATURES again) }
const router = express.Router()
const isAdmin = (u) => ['admin', 'superadmin'].includes(u?.role)
const changed = (body) => Object.entries(body || {}).map(([k, v]) => `${k}=${v === null ? 'default' : v ? 'on' : 'off'}`).join(', ')

router.get('/', (req, res) => res.json({ features: features.view(req.user.orgId || null, req.user.role), plan: req.user.orgId ? authService.getOrgPlan(req.user.orgId) : 'FREE', enabled: features.enabled(req.user.orgId || null), canManage: isAdmin(req.user) && !!req.user.orgId, canManagePlatform: req.user.role === 'superadmin' }))
router.put('/', (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an admin may change the workspace\'s features' })
    try {
        const out = features.setWorkspace(req.user.orgId, req.body)
        req.auditDetail = `features: ${changed(req.body)}`
        res.json({ features: out, enabled: features.enabled(req.user.orgId) })
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
router.get('/platform', (req, res) => req.user.role === 'superadmin' ? res.json({ features: features.setPlatform({}) }) : res.status(403).json({ error: 'Super Admin only' }))
router.put('/platform', (req, res) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Super Admin only' })
    const out = features.setPlatform(req.body)
    auditLog.record({ orgId: null, actor: req.user, ip: req.ip, action: 'features.platform', detail: changed(req.body) })
    res.json({ features: out })
})

export default router
