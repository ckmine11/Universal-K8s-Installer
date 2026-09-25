import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { authService } from '../services/authService.js'

const router = express.Router()

router.get('/subscription', requireAuth, (req, res) => {
    try {
        const user = authService.getUserById(req.user.id)
        if (!user) return res.status(404).json({ error: 'User not found' })
        
        // Return current subscription or default
        const sub = user.subscription || { plan: 'FREE', maxClusters: 1, maxNodes: 3 }
        res.json(sub)
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
