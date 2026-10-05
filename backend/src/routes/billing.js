import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { authService } from '../services/authService.js'

const router = express.Router()

router.get('/subscription', requireAuth, (req, res) => {
    try {
        const user = authService.getUserById(req.user.id)
        if (!user) return res.status(404).json({ error: 'User not found' })
        
        // Team members have plan "MEMBER" — what counts is the WORKSPACE plan
        // (the owner's subscription), the same one the server enforces.
        const owner = authService.getOrgOwner(req.user.orgId) || user
        const sub = owner.subscription || { plan: 'FREE', maxClusters: 1, maxNodes: 2, maxMembers: 1 }
        res.json({ ...sub, isOwner: owner.id === user.id })
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
