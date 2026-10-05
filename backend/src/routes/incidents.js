import express from 'express'
import { requireAuth } from '../middleware/authMiddleware.js'
import { incidentDetector } from '../services/incidentDetector.js'

const router = express.Router()

// Same workspace (orgId); legacy records without orgId match their owner;
// the platform super admin sees everything.
function visibleTo(user) {
    return (item) =>
        user.role === 'superadmin' ||
        (item.orgId && user.orgId && item.orgId === user.orgId) ||
        (!item.orgId && item.ownerId === user.id)
}

// Recent incidents (newest first; kept 24 h after they were last seen)
router.get('/', requireAuth, (req, res) => {
    res.json(incidentDetector.getIncidents().filter(visibleTo(req.user)).map(({ _key, ...inc }) => inc))
})

// Which clusters are actually being watched, and whether the watcher is connected
router.get('/monitoring', requireAuth, (req, res) => {
    const clusters = incidentDetector.getMonitoring().filter(visibleTo(req.user))
        .map(({ orgId, ownerId, ...c }) => c)
    res.json({ clusters, connected: clusters.filter(c => c.connected).length })
})

export default router
