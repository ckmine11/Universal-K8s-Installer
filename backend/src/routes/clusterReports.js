import express from 'express'
import { requireFeature, features } from '../services/features.js'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { incidentDetector } from '../services/incidentDetector.js'
import { readSecurity, summarizeSecurity } from '../services/security.js'
import { readRollouts, computeDora } from '../services/dora.js'
import { leadTimes } from '../services/leadTime.js'
import { readCosts, DEFAULT_RATES } from '../services/costs.js'
import { deliveryStore } from '../services/deliveryStore.js'
import { clusterBadges, currentProblemKeys } from '../services/clusterBadges.js'
import { badgeSeen } from '../services/badgeSeen.js'

// Read-only reports of one cluster (mounted at /api/clusters):
//   GET /:id/security          Trivy: vulnerabilities and misconfigurations per workload
//   GET /:id/dora?days=&platform=1   DORA delivery metrics
//   GET /:id/badges            sidebar counts (critical CVEs, certificates needing attention) not seen yet, from the last reads
//   POST /:id/badges/seen      { kind } — the person opened that tab: what is there now counts as seen
// Members limited to some namespaces see only those namespaces.
const router = express.Router()
// feature flags (services/features.js): a feature that is off answers 403 FEATURE_OFF
router.use('/:id/security', requireFeature('security'))
router.use('/:id/dora', requireFeature('dora'))
router.use('/:id/costs', requireFeature('costs'))

const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { status: 504 })), ms).unref?.())])

async function visibleCluster(req, res) {
    const c = (await clusterStore.getClusters().catch(() => [])).find(x => x.id === req.params.id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
const matcherFor = (user, cluster) => { const nss = accessOn(user, cluster).namespaces; return nss ? (ns) => nsMatches(nss, ns) : null }

router.get('/:id/security', requirePermission('security:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const r = await withTimeout(readSecurity(cluster, { fresh: req.query.fresh === '1' }), 160e3, 'The cluster did not answer in time')
        const match = matcherFor(req.user, cluster)
        res.json({ ...summarizeSecurity(r, { match }), at: r.at, limited: !!match })
    } catch (e) { fail(res, e) }
})

// Each badge only for a section the member may open; null = not read yet
const BADGE_GATES = { security: ['security:view', 'security'], certificates: ['security:view', 'certManager'] }
router.get('/:id/badges', requirePermission('cluster:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const orgId = req.user?.orgId || null
    const allowed = (kind) => { const [perm, key] = BADGE_GATES[kind]; return canOn(req.user, perm, cluster) && features.isOn(orgId, key) && features.planOk(orgId, key, req.user?.role) }
    res.json(clusterBadges(cluster, { allowed, match: matcherFor(req.user, cluster), seen: (kind) => badgeSeen.get(req.user.id, cluster.id, kind) }))
})
router.post('/:id/badges/seen', requirePermission('cluster:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const kind = String(req.body?.kind || '')
    if (!BADGE_GATES[kind]) return res.status(400).json({ error: 'kind: security or certificates' })
    const orgId = req.user?.orgId || null
    const [perm, key] = BADGE_GATES[kind]
    if (!canOn(req.user, perm, cluster) || !features.isOn(orgId, key)) return res.status(403).json({ error: 'You may not open that section' })
    // only what this person can see there (their namespaces); nothing read yet → nothing to mark
    const keys = currentProblemKeys(cluster, kind, matcherFor(req.user, cluster))
    if (keys) badgeSeen.mark(req.user.id, cluster.id, kind, keys)
    res.json({ success: true, seen: keys ? keys.length : 0 })
})

const DAYS = [7, 14, 30]
router.get('/:id/dora', requirePermission('metrics:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const days = DAYS.includes(Number(req.query.days)) ? Number(req.query.days) : 7
    try {
        const rollouts = await withTimeout(readRollouts(cluster, { fresh: req.query.fresh === '1' }), 130e3, 'The cluster did not answer in time')
        const incidents = incidentDetector.getIncidents().filter(i => i.clusterId === cluster.id)
        const to = Date.now()
        const changes = leadTimes.forCluster(cluster.orgId, cluster.id)
        res.json({ ...computeDora({ rollouts, incidents, changes, from: to - days * 86400e3, to, match: matcherFor(req.user, cluster), platform: req.query.platform === '1' }), days, platform: req.query.platform === '1' })
    } catch (e) { fail(res, e) }
})

router.get('/:id/costs', requirePermission('metrics:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const rates = deliveryStore.costRates(cluster.orgId, DEFAULT_RATES)
        res.json(await withTimeout(readCosts(cluster, rates, { match: matcherFor(req.user, cluster) }), 130e3, 'The cluster did not answer in time'))
    } catch (e) { fail(res, e) }
})

export default router
