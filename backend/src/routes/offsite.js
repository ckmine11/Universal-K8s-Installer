import express from 'express'
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js'
import { offsiteStore } from '../services/offsiteStore.js'
import { offsiteService, normaliseConfig, sameClusterWarning } from '../services/offsiteService.js'
import { installationManager } from '../services/installationManager.js'
import { authService } from '../services/authService.js'
import { isPaidPlan } from '../config/planFeatures.js'
import { canAccessResource } from '../utils/access.js'

// Offsite (S3 / MinIO) backup target for the workspace.
// Reading the status: any workspace member. Changing it: 'backup:manage' (admin).
const router = express.Router()
router.use(requireAuth)

function requirePaidPlan(req, res, next) {
    if (req.user.role === 'superadmin' || isPaidPlan(authService.getOrgPlan(req.user.orgId))) return next()
    res.status(402).json({ error: 'Offsite backups are a Pro feature. Upgrade to Pro to enable them.', upgradeRequired: true })
}
router.use(requirePaidPlan)

// The connection test runs FROM the cluster's control-plane, because that is
// where uploads happen — so the request names a cluster of this workspace.
async function loadCluster(req, res) {
    const id = req.body?.clusterId || req.query?.clusterId
    if (!id) { res.status(400).json({ error: 'clusterId is required (the connection is tested from that cluster\'s control-plane).' }); return null }
    const cluster = (await installationManager.getSavedClusters()).find(c => c.id === id)
    if (!cluster) { res.status(404).json({ error: 'Cluster not found' }); return null }
    if (!canAccessResource(req.user, cluster)) { res.status(403).json({ error: 'Unauthorized access to this cluster' }); return null }
    return cluster
}

router.get('/', (req, res) => {
    res.json(offsiteStore.publicView(req.user.orgId))
})

router.post('/test', requirePermission('backup:manage'), async (req, res) => {
    const cluster = await loadCluster(req, res)
    if (!cluster) return
    let cfg
    try { cfg = normaliseConfig(req.body, offsiteStore.get(req.user.orgId)) } catch (e) { return res.status(400).json({ ok: false, error: e.message }) }
    const r = await offsiteService.test(cluster, cfg)
    res.status(r.ok ? 200 : 422).json({ ...r, warning: sameClusterWarning(cluster, cfg.endpoint) })
})

// Connect = test + save. Only a configuration that passed the test is saved.
router.put('/', requirePermission('backup:manage'), async (req, res) => {
    const cluster = await loadCluster(req, res)
    if (!cluster) return
    let cfg
    try { cfg = normaliseConfig(req.body, offsiteStore.get(req.user.orgId)) } catch (e) { return res.status(400).json({ ok: false, error: e.message }) }
    const t = await offsiteService.test(cluster, cfg)
    if (!t.ok) return res.status(422).json(t)
    const { recoveryKey } = offsiteStore.connect(req.user.orgId, cfg)
    // First upload right away (don't make the user wait for it)
    const target = offsiteStore.getConnected(req.user.orgId)
    offsiteService.sync(cluster, target)
        .then(r => offsiteStore.recordSync(req.user.orgId, cluster.id, r))
        .catch(() => {})
    res.json({ ok: true, ...offsiteStore.publicView(req.user.orgId), recoveryKey })
})

router.delete('/', requirePermission('backup:manage'), (req, res) => {
    offsiteStore.disconnect(req.user.orgId)
    res.json({ ok: true, ...offsiteStore.publicView(req.user.orgId) })
})

router.get('/recovery-key', requirePermission('backup:manage'), (req, res) => {
    const r = offsiteStore.get(req.user.orgId)
    if (!r?.encKey) return res.status(404).json({ error: 'No recovery key yet — connect offsite storage first.' })
    res.json({ recoveryKey: r.encKey })
})

// Upload any snapshot of this cluster that isn't offsite yet
router.post('/sync', requirePermission('cluster:upgrade'), async (req, res) => {
    const cluster = await loadCluster(req, res)
    if (!cluster) return
    const target = offsiteStore.getConnected(req.user.orgId)
    if (!target) return res.status(400).json({ ok: false, error: 'Offsite storage is not connected.' })
    const r = await offsiteService.sync(cluster, target)
    offsiteStore.recordSync(req.user.orgId, cluster.id, r)
    res.status(r.ok ? 200 : 422).json(r)
})

export default router
