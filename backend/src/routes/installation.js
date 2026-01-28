import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { installationManager } from '../services/installationManager.js'
import { automationEngine } from '../services/automationEngine.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

// List saved clusters
router.get('/list', async (req, res) => {
    try {
        const clusters = await installationManager.getSavedClusters()
        res.json(clusters)
    } catch (error) {
        console.error('List clusters error:', error)
        res.status(500).json({ error: 'Failed to retrieve clusters' })
    }
})

// Start cluster installation
router.post('/install', async (req, res) => {
    try {
        const { clusterName, k8sVersion, networkPlugin, masterNodes, workerNodes, addons, mode } = req.body

        console.log('Received installation request:', { clusterName, masterNodes: masterNodes?.length, workerNodes: workerNodes?.length, mode })

        // Validate input based on mode
        if (mode === 'scale') {
            // For scaling: need clusterName and at least the bridge master node
            if (!clusterName || !masterNodes || masterNodes.length === 0) {
                console.error('Scaling validation failed: need bridge master node')
                return res.status(400).json({
                    error: 'Scaling requires cluster name and bridge master node for authentication'
                })
            }
            // For scaling, we allow worker-only additions (no new masters required)
        } else {
            // For fresh install: need clusterName and at least one master
            if (!clusterName || !masterNodes || masterNodes.length === 0) {
                console.error('Installation validation failed:', { clusterName, masterNodesLength: masterNodes?.length })
                return res.status(400).json({
                    error: 'Missing required fields: clusterName and at least one master node'
                })
            }
        }

        // Generate installation ID
        const installationId = uuidv4()

        // Create installation job
        const installation = {
            id: installationId,
            clusterName,
            k8sVersion,
            networkPlugin,
            masterNodes,
            workerNodes,
            addons,
            mode: mode || 'install', // Add mode field (defaults to 'install' if not provided)
            status: 'pending',
            createdAt: new Date().toISOString()
        }

        // Start installation process
        installationManager.startInstallation(installation)

        res.json({
            installationId,
            message: 'Installation started successfully',
            status: 'pending'
        })
    } catch (error) {
        console.error('Installation error:', error)
        res.status(500).json({ error: 'Failed to start installation' })
    }
})

// Get installation status
router.get('/:id/status', (req, res) => {
    const { id } = req.params
    const status = installationManager.getStatus(id)

    if (!status) {
        return res.status(404).json({ error: 'Installation not found' })
    }

    res.json(status)
})

// Get cluster health (real-time)
router.get('/:id/health', async (req, res) => {
    try {
        const { id } = req.params
        const health = await installationManager.getClusterHealth(id)
        res.json(health)
    } catch (error) {
        console.error('Health check error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get kubeconfig
router.get('/:id/kubeconfig', async (req, res) => {
    try {
        const { id } = req.params
        const kubeconfig = await installationManager.getKubeconfig(id)

        // Send as file download
        res.setHeader('Content-Type', 'application/x-yaml')
        res.setHeader('Content-Disposition', `attachment; filename="kubeconfig-${id}.yaml"`)
        res.send(kubeconfig)
    } catch (error) {
        console.error('Kubeconfig fetch error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get installation logs
router.get('/:id/logs', (req, res) => {
    const { id } = req.params
    const logs = installationManager.getLogs(id)

    if (!logs) {
        return res.status(404).json({ error: 'Installation not found' })
    }

    res.json({ logs })
})

// Cancel installation
router.post('/:id/cancel', (req, res) => {
    const { id } = req.params
    const success = installationManager.cancelInstallation(id)

    if (!success) {
        return res.status(404).json({ error: 'Installation not found' })
    }

    res.json({ message: 'Installation cancelled successfully' })
})

// Delete a saved cluster
router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const success = await installationManager.deleteCluster(id)

    if (!success) {
        return res.status(500).json({ error: 'Failed to delete cluster' })
    }

    res.json({ message: 'Cluster deleted successfully' })
})

// Execute Auto-Fix Action
// Execute Auto-Fix Action
router.post('/action/fix', requireAuth, async (req, res) => {
    try {
        const { installationId, nodeIp, fixAction } = req.body

        // Find installation to get node details (credentials)
        const installation = installationManager.getInstallation(installationId)
        if (!installation) {
            return res.status(404).json({ error: 'Installation not found' })
        }

        // Find the specific node
        const allNodes = [...installation.masterNodes, ...(installation.workerNodes || [])]
        const targetNode = allNodes.find(n => n.ip === nodeIp)

        if (!targetNode) {
            return res.status(404).json({ error: 'Target node not found in installation' })
        }

        // Execute the fix
        console.log(`Triggering fix ${fixAction} on ${nodeIp}`)

        // Use a temporary logger helper to stream fix logs to the websocket
        const fixLogger = (level, message) => {
            installationManager.broadcastToClients(installationId, {
                type: 'log',
                level: level,
                message: `[Auto-Fix] ${message}`,
                timestamp: new Date().toISOString()
            })
        }

        await automationEngine.runFix(fixAction, targetNode, fixLogger)

        res.json({ success: true, message: 'Fix action executed successfully' })

    } catch (error) {
        console.error('Auto-Fix error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Retry a failed installation
router.post('/:id/retry', requireAuth, async (req, res) => {
    try {
        const { id } = req.params
        const oldInstallation = installationManager.getStatus(id)

        if (!oldInstallation) {
            return res.status(404).json({ error: 'Original installation not found' })
        }

        // Create a new installation based on the old one
        const newInstallationId = uuidv4()
        const newInstallation = {
            ...oldInstallation,
            id: newInstallationId,
            status: 'pending',
            progress: 0,
            logs: [],
            createdAt: new Date().toISOString(),
            failedAt: undefined,
            error: undefined,
            diagnosis: undefined
        }

        // Start the new process
        installationManager.startInstallation(newInstallation)

        res.json({
            success: true,
            newInstallationId: newInstallationId,
            message: 'Installation restarted successfully'
        })

    } catch (error) {
        console.error('Retry error:', error)
        res.status(500).json({ error: 'Failed to retry installation' })
    }
})

// Install Add-ons to existing cluster
router.post('/:id/addons', requireAuth, async (req, res) => {
    try {
        const { id } = req.params
        const { addons } = req.body

        // Load cluster config (decrypted)
        const clusters = await installationManager.getSavedClusters()
        const existingCluster = clusters.find(c => c.id === id)

        if (!existingCluster) {
            return res.status(404).json({ error: 'Cluster not found' })
        }

        const newInstallationId = uuidv4()
        const addonInstallation = {
            ...existingCluster, // Copy credentials and nodes
            id: newInstallationId,
            addons: addons, // Use new addons selection
            mode: 'addon-only',
            status: 'pending',
            logs: [],
            progress: 0,
            createdAt: new Date().toISOString()
        }

        installationManager.startInstallation(addonInstallation)

        res.json({
            success: true,
            newInstallationId: newInstallationId,
            message: 'Add-on installation started'
        })

    } catch (error) {
        console.error('Add-on install error:', error)
        res.status(500).json({ error: 'Failed to start add-on installation' })
    }
})

// Upgrade Cluster Version
router.post('/:id/upgrade', requireAuth, async (req, res) => {
    try {
        const { id } = req.params
        const { targetVersion } = req.body

        // Load cluster config
        const clusters = await installationManager.getSavedClusters()
        const existingCluster = clusters.find(c => c.id === id)

        if (!existingCluster) {
            return res.status(404).json({ error: 'Cluster not found' })
        }

        const newInstallationId = uuidv4()
        const upgradeInstallation = {
            ...existingCluster,
            id: newInstallationId,
            originalClusterId: existingCluster.id, // PERSIST: Keep track of the real cluster ID
            targetVersion: targetVersion,
            mode: 'upgrade',
            status: 'pending',
            logs: [],
            progress: 0,
            createdAt: new Date().toISOString()
        }

        installationManager.startInstallation(upgradeInstallation)

        res.json({
            success: true,
            newInstallationId: newInstallationId,
            message: `Upgrade to v${targetVersion} started`
        })

    } catch (error) {
        console.error('Upgrade error:', error)
        res.status(500).json({ error: 'Failed to start cluster upgrade' })
    }
})

export default router
