import express from 'express'
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js'
import { incidentDetector } from '../services/incidentDetector.js'
import { healingPolicyStore } from '../services/healingPolicyStore.js'
import { CATALOG, POLICIES } from '../config/incidentCatalog.js'

const router = express.Router()

// Same workspace (orgId); legacy records without orgId match their owner;
// the platform super admin sees everything.
function visibleTo(user) {
    return (item) =>
        user.role === 'superadmin' ||
        (item.orgId && user.orgId && item.orgId === user.orgId) ||
        (!item.orgId && item.ownerId === user.id)
}
const strip = ({ _key, orgId, ownerId, ...inc }) => inc

// Recent incidents (newest first; kept 7 days after they were last seen)
router.get('/', requireAuth, (req, res) => {
    res.json(incidentDetector.getIncidents().filter(visibleTo(req.user)).map(strip))
})

// What each problem type means, what KubeEZ does, and the workspace policy
router.get('/catalog', requireAuth, (req, res) => {
    res.json({ catalog: CATALOG, policies: healingPolicyStore.view(req.user.orgId).policies, choices: POLICIES })
})

// Numbers for the page: open by severity, auto-fixed, fix rate, MTTR, top problems, per day
router.get('/stats', requireAuth, (req, res) => {
    const days = Math.max(1, Math.min(7, parseInt(req.query.days, 10) || 7))
    res.json(incidentDetector.getStats(visibleTo(req.user), days))
})

// Which clusters are actually being watched, and whether the watcher is connected
router.get('/monitoring', requireAuth, (req, res) => {
    const clusters = incidentDetector.getMonitoring().filter(visibleTo(req.user))
        .map(({ orgId, ownerId, ...c }) => c)
    const skipped = incidentDetector.getSkipped().filter(visibleTo(req.user))
        .map(({ orgId, ownerId, ...c }) => c)
    res.json({ clusters, connected: clusters.filter(c => c.connected).length, skipped })
})

// Workspace policy per problem type: auto (fix) / notify (alert only) / off
router.put('/policy', requireAuth, requirePermission('healing:manage'), (req, res) => {
    const policies = healingPolicyStore.savePolicies(req.user.orgId, req.body?.policies || {})
    res.json({ policies })
})

// Maintenance: no checks, fixes or alerts for a cluster for some hours
router.put('/maintenance/:clusterId', requireAuth, requirePermission('incident:act'), (req, res) => {
    const c = incidentDetector.getMonitoring().find(x => x.clusterId === req.params.clusterId)
    if (!c || !visibleTo(req.user)(c)) return res.status(404).json({ error: 'Cluster not found' })
    const hours = Math.max(0, Math.min(336, Number(req.body?.hours) || 0))
    res.json({ maintenance: healingPolicyStore.setMaintenance(c.orgId, c.clusterId, hours, req.user.username) })
})

// Actions on one incident
const own = (req, res) => {
    const inc = incidentDetector.find(req.params.id)
    if (!inc || !visibleTo(req.user)(inc)) { res.status(404).json({ error: 'Incident not found' }); return null }
    return inc
}
router.post('/:id/ack', requireAuth, requirePermission('incident:act'), (req, res) => {
    if (!own(req, res)) return
    res.json(strip(incidentDetector.acknowledge(req.params.id, req.user.username)))
})
router.post('/:id/run', requireAuth, requirePermission('incident:act'), async (req, res) => {
    const inc = own(req, res); if (!inc) return
    const meta = CATALOG[inc.reason]
    if (!meta?.fixable) return res.status(400).json({ error: 'KubeEZ has no automatic fix for this problem — see the suggestion' })
    try { res.json(strip(await incidentDetector.runNow(req.params.id, req.user.username))) }
    catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
router.post('/:id/mute', requireAuth, requirePermission('incident:act'), (req, res) => {
    if (!own(req, res)) return
    const hours = Math.max(0, Math.min(336, Number(req.body?.hours) || 0))
    res.json(strip(incidentDetector.mute(req.params.id, hours, req.user.username)))
})

export default router
