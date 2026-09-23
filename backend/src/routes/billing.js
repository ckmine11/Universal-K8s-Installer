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

router.post('/upgrade', requireAuth, (req, res) => {
    try {
        const { plan } = req.body
        const user = authService.getUserById(req.user.id)
        if (!user) return res.status(404).json({ error: 'User not found' })

        if (plan === 'PRO') {
            authService.updateUserSubscription(user.id, 'PRO', 999, 999) // Mock unlimited
            res.json({ message: 'Successfully upgraded to PRO', plan: 'PRO' })
        } else if (plan === 'ENTERPRISE') {
            authService.updateUserSubscription(user.id, 'ENTERPRISE', 999, 999)
            res.json({ message: 'Successfully upgraded to ENTERPRISE', plan: 'ENTERPRISE' })
        } else {
            res.status(400).json({ error: 'Invalid plan' })
        }
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

export default router
