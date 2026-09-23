import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { incidentDetector } from '../services/incidentDetector.js'

const router = express.Router()

// Get all recent incidents
router.get('/', requireAuth, (req, res) => {
    const incidents = incidentDetector.getIncidents()
    const { id: userId, orgId } = req.user

    // Filter incidents to only show those for clusters the user owns, or in the same workspace (orgId)
    const filtered = incidents.filter(inc => {
        // Workspace model: match by orgId
        if (inc.orgId && orgId && inc.orgId === orgId) return true
        
        // Legacy fallback: match by ownerId
        if (!inc.orgId && inc.ownerId === userId) return true
        
        // Super Admin override (if we add a global super admin later)
        if (req.user.role === 'superadmin') return true

        return false
    })

    res.json(filtered)
})

export default router
