import express from 'express'
import { authService } from '../services/authService.js'
import { approvalStore } from '../services/approvalStore.js'
import { PROTECTED_ACTIONS, ELEVATION_MINUTES, approversOf, createRequest, decide, cancel, endElevation } from '../services/approvals.js'
import { canOn, canSeeCluster, describeRole } from '../services/accessControl.js'
import { roleStore, customRoleKey } from '../services/roleStore.js'
import { clusterStore } from '../services/clusterStore.js'
import { isPaidPlan } from '../config/planFeatures.js'

// Two-person approval (dangerous actions) and temporary elevation (a role for
// some minutes). Mounted at /api/approvals behind requireAuth.
const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })
const member = (req) => ({ ...req.user, clusterAccess: authService.getUserById(req.user.id)?.clusterAccess || [] })
const paid = (req) => req.user.role === 'superadmin' || isPaidPlan(authService.getOrgPlan(req.user.orgId))
const orgClusters = async (req) => (await clusterStore.getClusters().catch(() => [])).filter(c => c.orgId === req.user.orgId)

// Everything the screens need: settings, what I may do, and the requests I may see
router.get('/', async (req, res) => {
    const me = member(req)
    const canApprove = canOn(me, 'access:approve')
    const clusters = await orgClusters(req)
    const visible = new Set(clusters.filter(c => canSeeCluster(me, c)).map(c => c.id))
    const requests = approvalStore.list(req.user.orgId)
        .filter(r => canApprove ? (r.clusterId === '*' || visible.has(r.clusterId) || !r.clusterId) : r.requestedBy.id === req.user.id)
        .slice(0, 100)
    res.json({
        allowed: paid(req),
        settings: approvalStore.settings(req.user.orgId),
        actions: Object.entries(PROTECTED_ACTIONS).map(([key, a]) => ({ key, label: a.label })),
        canApprove,
        approvers: approversOf(req.user.orgId).map(u => u.username),
        requests
    })
})

// For "Request temporary access": which roles and durations can be asked for
router.get('/options', (req, res) => {
    const builtin = ['operator', 'viewer'].map(k => ({ key: k, name: describeRole(req.user.orgId, k).name }))
    const custom = roleStore.list(req.user.orgId).map(r => ({ key: customRoleKey(r.id), name: r.name, description: r.description }))
    res.json({ allowed: paid(req), roles: [...builtin, ...custom], minutes: ELEVATION_MINUTES })
})

// Which actions need a second person (admins). Needs two people who can approve.
router.put('/settings', async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' })
    if (!paid(req)) return res.status(402).json({ error: 'Two-person approval is part of Pro.', upgrade: true })
    const actions = {}
    for (const [k, v] of Object.entries(req.body?.actions || {})) if (PROTECTED_ACTIONS[k] && v) actions[k] = true
    if (Object.keys(actions).length && approversOf(req.user.orgId).length < 2) {
        return res.status(400).json({ error: 'Two-person approval needs at least two people who can approve (Admins, or a role with "Approve terminal access requests"). Invite a second admin first.' })
    }
    res.json(approvalStore.saveSettings(req.user.orgId, { ...approvalStore.settings(req.user.orgId), actions }))
})

router.post('/', async (req, res) => {
    if (!paid(req)) return res.status(402).json({ error: 'Approvals and temporary access are part of Pro.', upgrade: true })
    try { res.json(await createRequest(req.user, req.body, await orgClusters(req))) } catch (e) { fail(res, e) }
})

router.get('/:id', (req, res) => {
    const r = approvalStore.get(req.params.id)
    if (!r || r.orgId !== req.user.orgId || (r.requestedBy.id !== req.user.id && !canOn(member(req), 'access:approve'))) return res.status(404).json({ error: 'Request not found' })
    res.json(r)
})

router.post('/:id/approve', (req, res) => { try { res.json(decide(req.user, req.params.id, true, req.body?.comment)) } catch (e) { fail(res, e) } })
router.post('/:id/deny', (req, res) => { try { res.json(decide(req.user, req.params.id, false, req.body?.comment)) } catch (e) { fail(res, e) } })
router.post('/:id/cancel', (req, res) => { try { res.json(cancel(req.user, req.params.id)) } catch (e) { fail(res, e) } })
router.post('/:id/end', (req, res) => { try { res.json(endElevation(req.user, req.params.id)) } catch (e) { fail(res, e) } })

export default router
