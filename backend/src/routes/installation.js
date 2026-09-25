import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { installationManager } from '../services/installationManager.js'
import { automationEngine } from '../services/automationEngine.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { licenseService } from '../services/licenseService.js'
import { resumeAnalyzer } from '../services/resumeAnalyzer.js'


const router = express.Router()

// List saved clusters
router.get('/list', async (req, res) => {
    try {
        const clusters = await installationManager.getSavedClusters()
        // Strict Isolation: Users only see clusters from their own Workspace (orgId)
        const filtered = clusters.filter(c => c.orgId === req.user.orgId || (!c.orgId && c.ownerId === req.user.id))
        res.json(filtered)
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

        // Check license limits
        const newClustersCount = mode === 'scale' ? 0 : 1
        const newNodesCount = (masterNodes?.length || 0) + (workerNodes?.length || 0)

        const enforcement = await licenseService.checkEnforcementLimit(
            req.user.id,
            req.user.role,
            newClustersCount,
            newNodesCount
        )

        if (!enforcement.allowed) {
            console.error('License limit check failed:', enforcement.error)
            return res.status(403).json({ error: enforcement.error })
        }

        // Generate installation ID
        const installationId = uuidv4()

        // Create installation job
        const installation = {

            id: installationId,
            ownerId: req.user.id, // Legacy compatibility
            orgId: req.user.orgId, // Strict Workspace Isolation
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

    if (status.orgId !== req.user.orgId && status.ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized access to this cluster' })
    }

    res.json(status)
})

// Get cluster health (real-time)
router.get('/:id/health', async (req, res) => {
    try {
        const { id } = req.params
        const clusters = await installationManager.getSavedClusters()
        const cluster = clusters.find(c => c.id === id)

        if (cluster && cluster.orgId !== req.user.orgId && cluster.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized access to this cluster' })
        }

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
        const clusters = await installationManager.getSavedClusters()
        const cluster = clusters.find(c => c.id === id)

        if (!cluster) {
            return res.status(404).json({ error: 'Cluster not found' })
        }

        if (req.user.role !== 'admin' && cluster.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized access to this cluster' })
        }

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
    const status = installationManager.getStatus(id)

    if (!status) {
        return res.status(404).json({ error: 'Installation not found' })
    }

    if (req.user.role !== 'admin' && status.ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized access to this cluster' })
    }

    const logs = installationManager.getLogs(id)
    res.json({ logs })
})

// Cancel installation
router.post('/:id/cancel', (req, res) => {
    const { id } = req.params
    const status = installationManager.getStatus(id)

    if (!status) {
        return res.status(404).json({ error: 'Installation not found' })
    }

    if (req.user.role !== 'admin' && status.ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized access to this cluster' })
    }

    const success = installationManager.cancelInstallation(id)
    res.json({ message: 'Installation cancelled successfully' })
})

// Delete a saved cluster
router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const clusters = await installationManager.getSavedClusters()
    const cluster = clusters.find(c => c.id === id)

    if (cluster && req.user.role !== 'admin' && cluster.ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized access to this cluster' })
    }

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
        const installation = installationManager.getStatus(installationId)
        if (!installation) {
            return res.status(404).json({ error: 'Installation not found' })
        }

        if (req.user.role !== 'admin' && installation.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized access to this cluster' })
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
            installationManager.broadcast(installationId, {
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

        if (req.user.role !== 'admin' && oldInstallation.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized access to this cluster' })
        }

        // Check license limits
        const newClustersCount = oldInstallation.mode === 'scale' ? 0 : 1
        const newNodesCount = (oldInstallation.masterNodes?.length || 0) + (oldInstallation.workerNodes?.length || 0)

        const enforcement = await licenseService.checkEnforcementLimit(
            req.user.id,
            req.user.role,
            newClustersCount,
            newNodesCount
        )

        if (!enforcement.allowed) {
            console.error('License limit check failed on retry:', enforcement.error)
            return res.status(403).json({ error: enforcement.error })
        }

        // Create a new installation based on the old one
        const newInstallationId = uuidv4()
        const newInstallation = {

            ...oldInstallation,
            id: newInstallationId,
            ownerId: oldInstallation.ownerId || req.user.id, // Keep the original owner
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

// Analyze failed cluster — detect what completed, what's missing, where to resume
router.post('/:id/analyze', requireAuth, async (req, res) => {
    try {
        const { id } = req.params
        const clusters = await installationManager.getSavedClusters()
        const cluster = clusters.find(c => c.id === id)

        if (!cluster) return res.status(404).json({ error: 'Cluster not found' })
        if (cluster.orgId !== req.user.orgId && cluster.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized' })
        }

        const logs = []
        const onLog = (level, msg) => logs.push({ level, message: msg })

        const analysis = await resumeAnalyzer.analyze(cluster, onLog)
        res.json({ ...analysis, logs })

    } catch (error) {
        console.error('Resume analyze error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Start resume from where installation failed
router.post('/:id/resume', requireAuth, async (req, res) => {
    try {
        const { id } = req.params
        const { analysis } = req.body  // Pass analysis result from /analyze call

        if (!analysis?.resumeFromStep) {
            return res.status(400).json({ error: 'Missing analysis — call /analyze first' })
        }

        const clusters = await installationManager.getSavedClusters()
        const cluster = clusters.find(c => c.id === id)

        if (!cluster) return res.status(404).json({ error: 'Cluster not found' })
        if (cluster.orgId !== req.user.orgId && cluster.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized' })
        }

        const resumeId = await installationManager.resumeInstallation(
            id, analysis, req.user.id, req.user.orgId
        )

        res.json({
            success: true,
            resumeInstallationId: resumeId,
            resumeFromStep: analysis.resumeFromStep,
            message: `Resuming from: ${analysis.resumeFromStep}`
        })

    } catch (error) {
        console.error('Resume start error:', error)
        res.status(500).json({ error: error.message })
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

        if (req.user.role !== 'admin' && existingCluster.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized access to this cluster' })
        }

        const newInstallationId = uuidv4()
        const addonInstallation = {
            ...existingCluster, // Copy credentials and nodes
            id: newInstallationId,
            ownerId: existingCluster.ownerId || req.user.id, // Keep the original owner
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

        if (req.user.role !== 'admin' && existingCluster.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized access to this cluster' })
        }

        const newInstallationId = uuidv4()
        const upgradeInstallation = {
            ...existingCluster,
            id: newInstallationId,
            ownerId: existingCluster.ownerId || req.user.id, // Keep the original owner
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
