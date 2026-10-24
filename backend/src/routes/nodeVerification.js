import express from 'express'
import { nodeVerifier } from '../services/nodeVerifier.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { fillStoredCredentials } from '../services/clusterCredentials.js'
import { canOn } from '../services/accessControl.js'
import { clusterStore } from '../services/clusterStore.js'
import { canAccessResource } from '../utils/access.js'

const router = express.Router()

// Verifying makes the KubeEZ server open SSH to the address given — only for
// members who may add servers (a new cluster, more nodes, SSH for an imported
// one), never a viewer using the server to probe other machines.
const NODE_PERMS = ['cluster:create', 'cluster:scale', 'cluster:upgrade']
async function mayVerifyNodes(req, res, next) {
    // nodes for a cluster of this workspace: its cluster rules count too
    const id = req.body?.clusterId
    const cluster = typeof id === 'string' && id ? (await clusterStore.getClusters().catch(() => [])).find(c => c.id === id && canAccessResource(req.user, c)) : null
    if (NODE_PERMS.some(p => canOn(req.user, p, cluster || null))) return next()
    res.status(403).json({ error: 'Your role does not have permission to add servers.', requiredPermission: NODE_PERMS[0] })
}

// Verify a single node
router.post('/verify', requireAuth, mayVerifyNodes, async (req, res) => {
    try {
        // Re-verifying a node of an existing cluster: no password from the browser —
        // use the stored one (only for a cluster this user may access)
        const [filled] = await fillStoredCredentials(req.user, req.body.clusterId, [req.body])
        const { ip, username, password, sshKey } = filled

        if (!ip || !username) {
            return res.status(400).json({
                error: 'Missing required fields: ip and username'
            })
        }

        console.log(`[Node Verification] Starting verification for ${ip} as ${username}`)

        // Verify the node
        const result = await nodeVerifier.verifyNode({
            ip,
            username,
            password,
            sshKey,
            ownerId: req.user.id,
            orgId: req.user.orgId
        })

        console.log(`[Node Verification] Result for ${ip}:`, result.status)
        res.json(result)
    } catch (error) {
        console.error('Node verification error:', error)
        res.status(500).json({
            error: 'Failed to verify node',
            message: error.message
        })
    }
})

// Verify multiple nodes
router.post('/verify-batch', requireAuth, mayVerifyNodes, async (req, res) => {
    try {
        const { nodes } = req.body

        if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
            return res.status(400).json({
                error: 'Missing required field: nodes array'
            })
        }

        // Each node opens an SSH session — keep one request from fanning out without limit
        if (nodes.length > 50) {
            return res.status(400).json({ error: 'At most 50 nodes per request' })
        }
        const filled = await fillStoredCredentials(req.user, req.body.clusterId, nodes)

        // Verify all nodes in parallel
        const results = await Promise.all(
            filled.map(node => nodeVerifier.verifyNode({
                ...node,
                ownerId: req.user.id,
                orgId: req.user.orgId
            }))
        )

        res.json({ results })
    } catch (error) {
        console.error('Batch verification error:', error)
        res.status(500).json({
            error: 'Failed to verify nodes',
            message: error.message
        })
    }
})

export default router
