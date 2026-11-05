import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { authService } from '../services/authService.js'
import { features } from '../services/features.js'
import { clusterStore } from '../services/clusterStore.js'
import { canAccessResource } from '../utils/access.js'
import { isPaidPlan, PLAN_CAPABILITIES } from '../config/planFeatures.js'
import { PLAN_LIMITS, TRIAL_DAYS } from '../services/plans.js'
import { licenseService } from '../services/licenseService.js'

const router = express.Router()

router.get('/subscription', requireAuth, (req, res) => {
    try {
        const user = authService.getUserById(req.user.id)
        if (!user) return res.status(404).json({ error: 'User not found' })
        
        // Team members have plan "MEMBER" — what counts is the WORKSPACE plan
        // (the owner's subscription), the same one the server enforces.
        const owner = authService.getOrgOwner(req.user.orgId) || user
        // as it applies now: a running Pro trial counts as Pro (services/plans.js)
        const sub = authService.orgSubscription(req.user.orgId)
        res.json({ ...sub, isOwner: owner.id === user.id })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// What this workspace can use: plan (a running trial counts as Pro), limits and
// how much is used, and every feature and paid capability — included or not.
router.get('/plan', requireAuth, async (req, res) => {
    try {
        const orgId = req.user.orgId || null
        const sub = authService.orgSubscription(orgId)
        const plan = authService.getOrgPlan(orgId)
        const paid = req.user.role === 'superadmin' || isPaidPlan(plan)
        const clusters = (await clusterStore.getClusters().catch(() => [])).filter(c => canAccessResource({ id: req.user.id, orgId }, c))
        const nodes = clusters.reduce((n, c) => n + (c.masterNodes?.length || 0) + (c.workerNodes?.length || 0), 0)
        const seats = authService.seatLimit(orgId)
        // self-hosted: clusters and nodes are the server's license (licenseService)
        const lic = licenseService.getMode() === 'saas' ? null : await licenseService.getLicenseState()
        res.json({
            plan, trial: sub.trial || null, superadmin: req.user.role === 'superadmin',
            limits: { clusters: lic ? lic.maxClusters : sub.maxClusters, nodes: lic ? lic.maxNodes : sub.maxNodes, members: seats ?? null },
            usage: { clusters: clusters.length, nodes, members: orgId ? authService.getUsersByOrgId(orgId).length : 1 },
            features: features.view(orgId, req.user.role).filter(f => f.available).map(({ key, label, group, description, plan: needs, on, included }) => ({ key, label, group, description, plan: needs, on, included })),
            capabilities: PLAN_CAPABILITIES.map(c => ({ ...c, plan: 'pro', on: true, included: paid })),
            limitsByPlan: PLAN_LIMITS, trialDays: TRIAL_DAYS,
        })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// Plan upgrades must go through Stripe — no free self-upgrade
router.post('/upgrade', requireAuth, (req, res) => {
    return res.status(402).json({
        error: 'Payment required. Please use the Stripe checkout to upgrade your plan.',
        checkoutEndpoint: '/api/stripe/create-checkout-session'
    })
})

export default router
