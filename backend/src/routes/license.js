import express from 'express'
import { licenseService } from '../services/licenseService.js'
import { clusterStore } from '../services/clusterStore.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

// Dynamic configuration endpoint (public)
router.get('/config', (req, res) => {
    res.json({
        mode: licenseService.getMode()
    })
})

// License status endpoint (authenticated)
router.get('/license/status', requireAuth, async (req, res) => {
    try {
        const state = await licenseService.getLicenseState()
        const clusters = await clusterStore.getClusters()

        let activeClusters = []
        let activeClustersCount = 0
        let activeNodesCount = 0

        if (state.mode === 'saas') {
            const authService = (await import('../services/authService.js')).authService;
            const user = authService.getUserById(req.user.id);
            const sub = user?.subscription || { plan: 'FREE', maxClusters: 1, maxNodes: 2 };
            
            state.plan = sub.plan === 'FREE' ? 'Free Tier' : `${sub.plan} Subscription`;
            state.maxClusters = sub.maxClusters;
            state.maxNodes = sub.maxNodes;
            state.status = 'active';
            if (sub.plan === 'FREE') {
                state.expiresAt = null;
            }

            if (req.user.role === 'admin') {
                activeClusters = clusters
            } else {
                activeClusters = clusters.filter(c => c.ownerId === req.user.id)
            }
        } else {
            activeClusters = clusters
        }

        activeClustersCount = activeClusters.length
        activeNodesCount = activeClusters.reduce((sum, c) => {
            const masters = c.masterNodes?.length || 0
            const workers = c.workerNodes?.length || 0
            return sum + masters + workers
        }, 0)

        res.json({
            ...state,
            activeClustersCount,
            activeNodesCount
        })
    } catch (error) {
        console.error('Error in /license/status:', error)
        res.status(500).json({ error: error.message })
    }
})

// Activate license key (admin only, self-hosted mode only)
router.post('/license/activate', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required to activate license.' })
        }

        const { licenseKey } = req.body
        if (!licenseKey) {
            return res.status(400).json({ error: 'License key is required.' })
        }

        const result = await licenseService.activateLicense(licenseKey)
        res.json({
            success: true,
            message: 'License activated successfully',
            ...result
        })
    } catch (error) {
        res.status(400).json({ error: error.message })
    }
})

// Generate new license key (Vendor Only)
router.post('/license/generate', requireAuth, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Vendor access required to generate licenses.' })
        }

        const { plan, maxClusters, maxNodes, validityDays, systemId } = req.body
        
        if (!plan || !maxClusters || !maxNodes || !validityDays || !systemId) {
            return res.status(400).json({ error: 'Missing required parameters.' })
        }

        const token = licenseService.generateLicense(
            plan, 
            parseInt(maxClusters), 
            parseInt(maxNodes), 
            parseInt(validityDays),
            systemId
        )

        res.json({
            success: true,
            token
        })
    } catch (error) {
        res.status(403).json({ error: error.message })
    }
})

export default router
