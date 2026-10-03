import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import { installationManager } from '../services/installationManager.js'
import { automationEngine } from '../services/automationEngine.js'
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js'
import { licenseService } from '../services/licenseService.js'
import { resumeAnalyzer } from '../services/resumeAnalyzer.js'
import { addonAccessService } from '../services/addonAccessService.js'
import { addonManager, ADDON_REGISTRY } from '../services/addonManager.js'
import { etcdBackupService } from '../services/etcdBackupService.js'
import { checkAddonPlan } from '../config/addonTiers.js'
import { authService } from '../services/authService.js'
import { can } from '../config/permissions.js'
import { isPaidPlan } from '../config/planFeatures.js'
import { canAccessResource } from '../utils/access.js'
import { offsiteStore } from '../services/offsiteStore.js'
import { offsiteService } from '../services/offsiteService.js'


const router = express.Router()

// ─── Tenant-isolation helpers ───────────────────────────────────────────────
// Load a saved cluster and enforce workspace (org) ownership.
async function loadOwnedCluster(req, res) {
    const clusters = await installationManager.getSavedClusters()
    const cluster = clusters.find(c => c.id === req.params.id)
    if (!cluster) { res.status(404).json({ error: 'Cluster not found' }); return null }
    if (!canAccessResource(req.user, cluster)) {
        res.status(403).json({ error: 'Unauthorized access to this cluster' }); return null
    }
    return cluster
}

// Load an in-memory installation and enforce workspace (org) ownership.
function loadOwnedInstallation(req, res, id) {
    const installation = installationManager.getStatus(id)
    if (!installation) { res.status(404).json({ error: 'Installation not found' }); return null }
    if (!canAccessResource(req.user, installation)) {
        res.status(403).json({ error: 'Unauthorized access to this cluster' }); return null
    }
    return installation
}

// Node SSH credentials are needed by the UI only for scaling (the wizard
// pre-fills the bridge master). Roles that can't scale (viewers) must never
// receive them.
function redactForRole(req, record) {
    if (!record || can(req.user.role, 'cluster:scale')) return record
    const strip = (nodes) => (nodes || []).map(({ password, sshKey, ...n }) => n)
    return { ...record, masterNodes: strip(record.masterNodes), workerNodes: strip(record.workerNodes) }
}

// List all in-progress/recent installations for the current user/org.
// Lets the UI recover a running install after navigating away or refreshing.
router.get('/installations/active', requireAuth, (req, res) => {
    try {
        const list = installationManager.getActiveInstallations(req.user.id, req.user.orgId)
        res.json(list)
    } catch (error) {
        console.error('Active installations error:', error)
        res.status(500).json({ error: error.message })
    }
})

// List saved clusters
router.get('/list', async (req, res) => {
    try {
        const clusters = await installationManager.getSavedClusters()
        // Strict Isolation: Users only see clusters from their own Workspace (orgId)
        const filtered = clusters.filter(c => canAccessResource(req.user, c))
        res.json(filtered.map(c => redactForRole(req, c)))
    } catch (error) {
        console.error('List clusters error:', error)
        res.status(500).json({ error: 'Failed to retrieve clusters' })
    }
})

// Start cluster installation
router.post('/install', requirePermission('cluster:create'), async (req, res) => {
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
            newNodesCount,
            req.user.orgId
        )

        if (!enforcement.allowed) {
            console.error('License limit check failed:', enforcement.error)
            return res.status(402).json({ error: enforcement.error, limitExceeded: true })
        }

        // Plan-gate add-ons by the WORKSPACE plan (team members have plan 'MEMBER')
        const addonCheck = checkAddonPlan(addons, authService.getOrgPlan(req.user.orgId))
        if (!addonCheck.allowed) {
            return res.status(402).json({ error: addonCheck.error, limitExceeded: true, blockedAddons: addonCheck.blocked })
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
    const status = loadOwnedInstallation(req, res, req.params.id)
    if (!status) return
    res.json(redactForRole(req, status))
})

// Get cluster health (real-time)
router.get('/:id/health', async (req, res) => {
    try {
        const { id } = req.params
        const clusters = await installationManager.getSavedClusters()
        const cluster = clusters.find(c => c.id === id)

        if (cluster) {
            if (!canAccessResource(req.user, cluster)) {
                return res.status(403).json({ error: 'Unauthorized access to this cluster' })
            }
        } else {
            // Not a saved cluster — may be an installation ID; it must be ours too.
            const installation = installationManager.getStatus(id)
            if (!installation) return res.status(404).json({ error: 'Cluster not found' })
            if (!canAccessResource(req.user, installation)) {
                return res.status(403).json({ error: 'Unauthorized access to this cluster' })
            }
        }

        const health = await installationManager.getClusterHealth(id)
        res.json(health)
    } catch (error) {
        console.error('Health check error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get kubeconfig
router.get('/:id/kubeconfig', requirePermission('kubeconfig:download'), async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return

        const kubeconfig = await installationManager.getKubeconfig(cluster.id)

        // Send as file download
        res.setHeader('Content-Type', 'application/x-yaml')
        res.setHeader('Content-Disposition', `attachment; filename="kubeconfig-${cluster.id}.yaml"`)
        res.send(kubeconfig)
    } catch (error) {
        console.error('Kubeconfig fetch error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Get installation logs
router.get('/:id/logs', (req, res) => {
    const status = loadOwnedInstallation(req, res, req.params.id)
    if (!status) return
    res.json({ logs: installationManager.getLogs(status.id) })
})

// Cancel installation
router.post('/:id/cancel', requirePermission('cluster:delete'), (req, res) => {
    const status = loadOwnedInstallation(req, res, req.params.id)
    if (!status) return
    installationManager.cancelInstallation(status.id)
    res.json({ message: 'Installation cancelled successfully' })
})

// Delete a saved cluster (or an in-progress installation that isn't saved yet)
router.delete('/:id', requirePermission('cluster:delete'), async (req, res) => {
    const { id } = req.params
    const clusters = await installationManager.getSavedClusters()
    const target = clusters.find(c => c.id === id) || installationManager.getStatus(id)

    if (!target) {
        return res.status(404).json({ error: 'Cluster not found' })
    }
    if (!canAccessResource(req.user, target)) {
        return res.status(403).json({ error: 'Unauthorized access to this cluster' })
    }

    const success = await installationManager.deleteCluster(id)

    if (!success) {
        return res.status(500).json({ error: 'Failed to delete cluster' })
    }

    res.json({ message: 'Cluster deleted successfully' })
})

// Execute Auto-Fix Action
router.post('/action/fix', requireAuth, requirePermission('cluster:create'), async (req, res) => {
    try {
        const { installationId, nodeIp, fixAction } = req.body

        // Find installation to get node details (credentials)
        const installation = loadOwnedInstallation(req, res, installationId)
        if (!installation) return

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
router.post('/:id/retry', requireAuth, requirePermission('cluster:create'), async (req, res) => {
    try {
        const oldInstallation = loadOwnedInstallation(req, res, req.params.id)
        if (!oldInstallation) return

        // Check license limits — only a fresh install adds a cluster, and only
        // install/scale add nodes. Retrying an upgrade/add-on/resume adds nothing.
        const mode = oldInstallation.mode || 'install'
        const newClustersCount = mode === 'install' ? 1 : 0
        const newNodesCount = (mode === 'install' || mode === 'scale')
            ? (oldInstallation.masterNodes?.length || 0) + (oldInstallation.workerNodes?.length || 0)
            : 0

        const enforcement = await licenseService.checkEnforcementLimit(
            req.user.id,
            req.user.role,
            newClustersCount,
            newNodesCount,
            req.user.orgId
        )

        if (!enforcement.allowed) {
            console.error('License limit check failed on retry:', enforcement.error)
            return res.status(402).json({ error: enforcement.error, limitExceeded: true })
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

// Get access info (URLs + credentials) for all installed addons in a cluster
router.get('/:id/addons/access', requireAuth, async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return

        const info = await addonAccessService.getAccessInfo(cluster)

        // Viewers may see WHICH add-ons are installed + their URLs, but NOT the
        // sensitive login credentials/tokens. Redact auth for those roles.
        const canSeeCreds = can(req.user.role, 'addon:credentials')
        if (!canSeeCreds && info && Array.isArray(info.addons)) {
            info.addons = info.addons.map(a => {
                if (!a || !a.auth) return a
                const { auth, ...rest } = a
                return { ...rest, credentialsHidden: true }
            })
            info.credentialsHidden = true
        }

        res.json(info)
    } catch (error) {
        console.error('Addon access error:', error)
        res.status(500).json({ error: error.message })
    }
})

// ─── Add-on management: live status, logs, uninstall ──────────────────────────

// Health + pods of every add-on (installed or not)
router.get('/:id/addons/status', requireAuth, requirePermission('addon:view'), async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return
        const status = await addonManager.getStatus(cluster)
        const job = installationManager.runningJobFor(cluster.id)
        res.json({ ...status, runningJob: job ? { id: job.id, mode: job.mode } : null })
    } catch (error) {
        console.error('Addon status error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Pod logs + recent events of one add-on (logs can contain secrets → operators/admins)
router.get('/:id/addons/:key/logs', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return
        res.json(await addonManager.getLogs(cluster, req.params.key, { pod: req.query.pod, tail: req.query.tail }))
    } catch (error) {
        console.error('Addon logs error:', error)
        res.status(error.status || 500).json({ error: error.message })
    }
})

// Uninstall (remove) or reinstall (remove, then install fresh) one add-on —
// runs as a job with live logs, like an install
router.post('/:id/addons/:key/:action(uninstall|reinstall)', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const { key, action } = req.params
        const existingCluster = await loadOwnedCluster(req, res)
        if (!existingCluster) return
        if (!ADDON_REGISTRY[key]) return res.status(400).json({ error: 'Unknown add-on' })
        // Deliberate action: the client must echo the add-on key back
        if (req.body?.confirm !== key) return res.status(400).json({ error: `Confirm the ${action} by sending the add-on key as "confirm".` })
        if (action === 'reinstall') {
            // Reinstall installs again → same plan rules as Install
            const addonCheck = checkAddonPlan({ [key]: true }, authService.getOrgPlan(req.user.orgId))
            if (!addonCheck.allowed) return res.status(402).json({ error: addonCheck.error, limitExceeded: true, blockedAddons: addonCheck.blocked })
        }

        const busy = installationManager.runningJobFor(existingCluster.id)
        if (busy) return res.status(409).json({ error: 'Another operation is still running on this cluster — wait for it to finish.', runningJobId: busy.id })

        const newInstallationId = uuidv4()
        installationManager.startInstallation({
            ...existingCluster,
            id: newInstallationId,
            ownerId: existingCluster.ownerId || req.user.id,
            orgId: existingCluster.orgId || req.user.orgId,
            originalClusterId: existingCluster.id,
            mode: action === 'reinstall' ? 'addon-reinstall' : 'addon-uninstall',
            uninstallAddon: key,
            uninstallNamespace: ADDON_REGISTRY[key].ns,   // used by the generic removal path
            status: 'pending',
            logs: [],
            progress: 0,
            createdAt: new Date().toISOString()
        })
        res.json({ success: true, newInstallationId, message: `${action === 'reinstall' ? 'Reinstalling' : 'Uninstalling'} ${ADDON_REGISTRY[key].label}` })
    } catch (error) {
        console.error(`Add-on ${req.params.action} error:`, error)
        res.status(500).json({ error: `Failed to start the add-on ${req.params.action}` })
    }
})

// ─── etcd backups (Pro/Enterprise feature) ─────────────────────────────────────

// etcd backup & restore is a paid feature. superadmin always allowed.
function requireEtcdPlan(req, res) {
    if (req.user.role === 'superadmin') return true
    if (!isPaidPlan(authService.getOrgPlan(req.user.orgId))) {
        res.status(402).json({
            error: 'etcd cluster-state backup & restore is a Pro feature. Upgrade to Pro to enable it.',
            upgradeRequired: true,
            feature: 'etcd-backup'
        })
        return false
    }
    return true
}

// List etcd snapshots on the cluster (any org member who can view the cluster)
router.get('/:id/etcd/backups', requireAuth, async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return
        if (!requireEtcdPlan(req, res)) return
        const result = await etcdBackupService.listBackups(cluster)
        // Which snapshots also exist offsite (S3 / MinIO)?
        const target = offsiteStore.getConnected(req.user.orgId)
        if (target) {
            const r = await offsiteService.list(cluster, target)
            result.offsite = {
                connected: true, provider: target.provider, bucket: target.bucket,
                remote: r.ok ? r.remote : [], error: r.ok ? null : r.error,
                lastSync: offsiteStore.publicView(req.user.orgId).lastSync?.[cluster.id] || null
            }
        } else {
            result.offsite = { connected: false }
        }
        res.json(result)
    } catch (error) {
        console.error('etcd list error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Take an on-demand etcd snapshot (control-plane maintenance → operator/admin)
router.post('/:id/etcd/backups', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return
        if (!requireEtcdPlan(req, res)) return
        const result = await etcdBackupService.createBackup(cluster)
        // Copy it offsite right away when S3 / MinIO is connected
        const target = result.success && offsiteStore.getConnected(req.user.orgId)
        if (target) {
            const s = await offsiteService.sync(cluster, target)
            offsiteStore.recordSync(req.user.orgId, cluster.id, s)
            result.offsite = { uploaded: s.ok, error: s.ok ? null : s.error }
        }
        if (result.success) res.json(result)
        else res.status(500).json(result)
    } catch (error) {
        console.error('etcd backup error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Restore etcd from a snapshot (DESTRUCTIVE → operator/admin, single control-plane only)
router.post('/:id/etcd/restore', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    const logs = []
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return
        if (!requireEtcdPlan(req, res)) return
        const { filename } = req.body
        if (!filename || /[\/\\]|\.\./.test(filename)) {
            return res.status(400).json({ error: 'Invalid or missing snapshot filename' })
        }
        // Safety: automated restore is only supported for a single control-plane.
        if ((cluster.masterNodes?.length || 0) > 1) {
            return res.status(400).json({
                error: 'Automated restore is only supported for single control-plane clusters. For HA clusters, restore etcd manually on each member.'
            })
        }
        await etcdBackupService.restoreBackup(cluster, filename, (level, msg) => logs.push({ level, msg }))
        res.json({ success: true, message: 'etcd restore completed', logs })
    } catch (error) {
        console.error('etcd restore error:', error)
        // Return the collected step-by-step logs even on failure (transparency).
        res.status(500).json({ success: false, error: error.message, logs })
    }
})

// Analyze failed cluster — detect what completed, what's missing, where to resume
router.post('/:id/analyze', requireAuth, async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return

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
router.post('/:id/resume', requireAuth, requirePermission('cluster:resume'), async (req, res) => {
    try {
        const { id } = req.params
        const { analysis } = req.body  // Pass analysis result from /analyze call

        if (!analysis?.resumeFromStep) {
            return res.status(400).json({ error: 'Missing analysis — call /analyze first' })
        }

        const cluster = await loadOwnedCluster(req, res)
        if (!cluster) return

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
router.post('/:id/addons', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const { addons } = req.body

        // Load cluster config (decrypted)
        const existingCluster = await loadOwnedCluster(req, res)
        if (!existingCluster) return
        const busy = installationManager.runningJobFor(existingCluster.id)
        if (busy) return res.status(409).json({ error: 'Another operation is still running on this cluster — wait for it to finish.', runningJobId: busy.id })

        // Plan-gate add-ons by the WORKSPACE plan (team members have plan 'MEMBER')
        const addonCheck = checkAddonPlan(addons, authService.getOrgPlan(req.user.orgId))
        if (!addonCheck.allowed) {
            return res.status(402).json({ error: addonCheck.error, limitExceeded: true, blockedAddons: addonCheck.blocked })
        }

        const newInstallationId = uuidv4()
        const addonInstallation = {
            ...existingCluster, // Copy credentials and nodes
            id: newInstallationId,
            ownerId: existingCluster.ownerId || req.user.id, // Keep the original owner
            orgId: existingCluster.orgId || req.user.orgId,
            originalClusterId: existingCluster.id,
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
router.post('/:id/upgrade', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const { targetVersion } = req.body

        // Load cluster config
        const existingCluster = await loadOwnedCluster(req, res)
        if (!existingCluster) return

        const newInstallationId = uuidv4()
        const upgradeInstallation = {
            ...existingCluster,
            id: newInstallationId,
            ownerId: existingCluster.ownerId || req.user.id, // Keep the original owner
            orgId: existingCluster.orgId || req.user.orgId,
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
