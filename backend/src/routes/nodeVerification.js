import express from 'express'
import { nodeVerifier } from '../services/nodeVerifier.js'

const router = express.Router()

// Verify a single node
router.post('/verify', async (req, res) => {
    try {
        const { ip, username, password, sshKey } = req.body

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
            sshKey
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
router.post('/verify-batch', async (req, res) => {
    try {
        const { nodes } = req.body

        if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
            return res.status(400).json({
                error: 'Missing required field: nodes array'
            })
        }

        // Verify all nodes in parallel
        const results = await Promise.all(
            nodes.map(node => nodeVerifier.verifyNode(node))
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
