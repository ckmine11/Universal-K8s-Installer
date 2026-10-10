import express from 'express'
import net from 'net'
import { randomUUID as uuidv4 } from 'crypto'
import { installationManager } from '../services/installationManager.js'
import { automationEngine } from '../services/automationEngine.js'
import { requireAuth, requirePermission } from '../middleware/authMiddleware.js'
import { licenseService } from '../services/licenseService.js'
import { resumeAnalyzer } from '../services/resumeAnalyzer.js'
import { addonAccessService } from '../services/addonAccessService.js'
import { addonManager, ADDON_REGISTRY } from '../services/addonManager.js'
import { stripCredentials, fillStoredCredentials } from '../services/clusterCredentials.js'
import { clusterStore } from '../services/clusterStore.js'
import { etcdBackupService, SNAPSHOT_RE } from '../services/etcdBackupService.js'
import { etcdJobs } from '../services/etcdJobs.js'
import { notifier } from '../services/notifier.js'
import { disasterRecovery } from '../services/disasterRecovery.js'
import { upgradeReadiness, clusterHealth } from '../services/explorerInsights.js'
import { checkAddonPlan } from '../config/addonTiers.js'
import { HELM_ADDONS, isHelmAddon, addonSchema } from '../config/helmAddons.js'
import { addonSettingsStore, buildPlan, valuesYaml, lineDiff } from '../services/addonSettings.js'
import { authService } from '../services/authService.js'
import { can } from '../config/permissions.js'
import { isPaidPlan } from '../config/planFeatures.js'
import { canAccessResource } from '../utils/access.js'
import { offsiteStore } from '../services/offsiteStore.js'
import { offsiteService, sameClusterWarning, normaliseConfig } from '../services/offsiteService.js'
import { volumeBackupStore } from '../services/volumeBackupStore.js'
import { volumeBackupService } from '../services/volumeBackupService.js'


const router = express.Router()

// Anything running on this cluster right now: an install/upgrade/add-on job or
// an etcd backup/restore/recovery. Two of them at once would fight each other.
// A node that cannot be reached is not a server bug: answer 502 with what to
// check, instead of a 500 with "connect ETIMEDOUT 10.0.0.5:22".
export function sshFailure(error) {
    const m = String(error?.message || '')
    const code = error?.code || (m.match(/\b(ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ECONNRESET)\b/) || [])[1]
    const host = error?.address || (m.match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || 'the node'
    const via = process.env.KUBEEZ_MODE === 'saas' ? ' (or that its Gateway Agent is online on the Gateway Agents page)' : ''
    if (code === 'ETIMEDOUT' || /Timed out while waiting for handshake/i.test(m)) return `Can't reach ${host} over SSH — it did not answer. Check that the server is running and reachable${via}.`
    if (code === 'ECONNREFUSED') return `${host} refused the SSH connection — is the SSH service running on port 22?`
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `No network route to ${host} — check the address and the network${via}.`
    if (code === 'ENOTFOUND') return `The address ${host} could not be resolved — check the node's address.`
    if (code === 'ECONNRESET') return `The SSH connection to ${host} was dropped — try again.`
    if (/All configured authentication methods failed/i.test(m)) return `${host} refused the SSH login — the saved username, password or key no longer works.`
    return null
}
const sendFailure = (res, error) => {
    const why = sshFailure(error)
    if (why) return res.status(502).json({ error: why, code: 'NODE_UNREACHABLE' })
    res.status(500).json({ error: error.message })
}

function clusterBusy(clusterId) {
    const job = installationManager.runningJobFor(clusterId)
    if (job) return { message: `Another operation (${job.mode || 'installation'}) is still running on this cluster — wait for it to finish.`, jobId: job.id }
    const ej = etcdJobs.activeFor(clusterId)
    if (ej) return { message: `An etcd ${ej.kind} is still running on this cluster — wait for it to finish.`, jobId: ej.id }
    return null
}

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

// SSH passwords / keys never go to the browser — for any role. Scaling and
// re-verifying send the cluster id; the server fills in the stored credentials.
const redactForRole = (req, record) => stripCredentials(record)

// List all in-progress/recent installations for the current user/org.
// Lets the UI recover a running install after navigating away or refreshing.
router.get('/installations/active', requireAuth, (req, res) => {
    try {
        const list = installationManager.getActiveInstallations(req.user.id, req.user.orgId)
        res.json(list)
    } catch (error) {
        console.error('Active installations error:', error)
        sendFailure(res, error)
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

// Everything here ends up in shell scripts, kubeconfigs and the UI — accept
// only well-formed values (the scripts quote arguments too; this is the first line).
function installInputProblem({ clusterName, k8sVersion, networkPlugin, mode }, masterNodes, workerNodes) {
    if (typeof clusterName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/.test(clusterName)) {
        return 'Cluster name: 1-63 characters — letters, numbers, spaces, ".", "_" or "-"'
    }
    if (mode !== 'scale' || k8sVersion) {
        if (typeof k8sVersion !== 'string' || !/^1\.\d{1,2}\.\d{1,3}$/.test(k8sVersion)) return 'Kubernetes version must look like 1.35.0'
    }
    if (networkPlugin && !['flannel', 'calico'].includes(networkPlugin)) return 'Network plugin must be flannel or calico'
    const nodes = [...(masterNodes || []), ...(workerNodes || [])]
    if (nodes.length > 100) return 'At most 100 nodes per request'
    for (const n of nodes) {
        const host = String(n?.ip || '')
        if (!(net.isIP(host) || /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(host))) {
            return `Node address "${host.slice(0, 60)}" is not a valid IP address or hostname`
        }
        if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(String(n?.username || ''))) return `Invalid SSH username for ${host}`
    }
    return null
}

// The control-plane virtual IP (kube-vip): a free IPv4 address on the
// control-planes' network, never one of the nodes
export function vipProblem(vip, masterNodes, workerNodes) {
    if (vip === undefined || vip === null || vip === '') return null
    if (typeof vip !== 'string' || net.isIP(vip) !== 4) return 'The virtual IP must be an IPv4 address, e.g. 192.168.1.50'
    if ([...(masterNodes || []), ...(workerNodes || [])].some(n => n?.ip === vip)) return `The virtual IP ${vip} is a node's own address — pick a free address on the same network`
    if (/^(127.|0.|169.254.|22[4-9].|23d.|24d.|25[0-5].)/.test(vip)) return 'The virtual IP must be a normal LAN address (not loopback, link-local or multicast)'
    return null
}

// Start cluster installation
router.post('/install', requirePermission('cluster:create'), async (req, res) => {
    try {
        const { clusterName, k8sVersion, networkPlugin, addons, mode, clusterId } = req.body
        // Scaling an existing cluster: its nodes come without passwords (never sent
        // to the browser) — use the stored ones
        const masterNodes = await fillStoredCredentials(req.user, clusterId, req.body.masterNodes)
        const workerNodes = await fillStoredCredentials(req.user, clusterId, req.body.workerNodes)
        const inputProblem = (masterNodes?.length || mode !== 'scale') ? installInputProblem(req.body, masterNodes, workerNodes) : null
        if (inputProblem) return res.status(400).json({ error: inputProblem })
        // A scaled cluster keeps its VIP: new control-planes run kube-vip too
        let controlPlaneVip = req.body.controlPlaneVip || undefined
        if (mode === 'scale') {
            const existing = clusterId && (await clusterStore.getClusters()).find(c => c.id === clusterId)
            controlPlaneVip = existing?.controlPlaneVip
        } else {
            const vp = vipProblem(controlPlaneVip, masterNodes, workerNodes)
            if (vp) return res.status(400).json({ error: vp })
        }

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
            controlPlaneVip,
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
        sendFailure(res, error)
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
        sendFailure(res, error)
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
        sendFailure(res, error)
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
        sendFailure(res, error)
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
        sendFailure(res, error)
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

        const busy = clusterBusy(existingCluster.id)
        if (busy) return res.status(409).json({ error: busy.message, runningJobId: busy.jobId })

        const newInstallationId = uuidv4()
        installationManager.startInstallation({
            ...existingCluster,
            id: newInstallationId,
            ownerId: existingCluster.ownerId || req.user.id,
            orgId: existingCluster.orgId || req.user.orgId,
            originalClusterId: existingCluster.id,
            mode: action === 'reinstall' ? 'addon-reinstall' : 'addon-uninstall',
            uninstallAddon: key,
            clusterAddons: existingCluster.addons || {},
            requestedBy: req.user.username,
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

// ─── Add-on settings (Helm add-ons) ─────────────────────────────────────────
// The form, what runs now, the history; a preview of the values; apply =
// an add-on job with live logs (Helm rolls back by itself when it fails).
const helmKey = (req, res) => {
    if (isHelmAddon(req.params.key)) return req.params.key
    res.status(404).json({ error: 'This add-on has no settings' }); return null
}
const advancedAllowed = (req) => isPaidPlan(authService.getOrgPlan(req.user.orgId)) || req.user.role === 'superadmin'

router.get('/:id/addons/:key/settings', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const key = helmKey(req, res); if (!key) return
        const cluster = await loadOwnedCluster(req, res); if (!cluster) return
        const saved = addonSettingsStore.get(cluster.id, key)
        const schema = addonSchema(key)
        res.json({
            schema, applied: saved.applied, pending: saved.pending, history: saved.history || [], lastSettings: saved.lastSettings || null,
            advancedAllowed: advancedAllowed(req),
            updateAvailable: !!saved.applied && saved.applied.version !== schema.versions[0].id,
            clusterAddons: Object.keys(cluster.addons || {}).filter(k => cluster.addons[k])
        })
    } catch (e) { sendFailure(res, e) }
})

function planFromBody(req, cluster, key) {
    const { settings, advanced, version } = req.body || {}
    if (advanced && String(advanced).trim() && !advancedAllowed(req)) {
        throw Object.assign(new Error('Advanced values (Helm YAML) are part of Pro. On Free, use the settings form.'), { status: 402, upgrade: true })
    }
    return buildPlan(key, cluster, { settings, advanced, version })
}

router.post('/:id/addons/:key/preview', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const key = helmKey(req, res); if (!key) return
        const cluster = await loadOwnedCluster(req, res); if (!cluster) return
        const plan = planFromBody(req, cluster, key)
        const after = valuesYaml(plan)
        let before = ''
        const applied = addonSettingsStore.get(cluster.id, key).applied
        if (applied) { try { before = valuesYaml(buildPlan(key, cluster, applied)) } catch { /* the cluster changed since */ } }
        const diff = lineDiff(before, after)
        res.json({ settings: plan.settings, version: plan.version, ignored: plan.ignored, values: after, diff, changed: diff.some(d => d.t !== ' ') })
    } catch (e) { res.status(e.status || 500).json({ error: e.message, ...(e.upgrade ? { upgrade: true } : {}) }) }
})

router.post('/:id/addons/:key/settings', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const key = helmKey(req, res); if (!key) return
        const cluster = await loadOwnedCluster(req, res); if (!cluster) return
        const tier = checkAddonPlan({ [key]: true }, authService.getOrgPlan(req.user.orgId))
        if (!tier.allowed) return res.status(402).json({ error: tier.error, limitExceeded: true, blockedAddons: tier.blocked })
        let plan
        try { plan = planFromBody(req, cluster, key) } catch (e) { return res.status(e.status || 400).json({ error: e.message, ...(e.upgrade ? { upgrade: true } : {}) }) }
        const busy = clusterBusy(cluster.id)
        if (busy) return res.status(409).json({ error: busy.message, runningJobId: busy.jobId })

        const newInstallationId = uuidv4()
        installationManager.startInstallation({
            ...cluster,
            id: newInstallationId,
            ownerId: cluster.ownerId || req.user.id,
            orgId: cluster.orgId || req.user.orgId,
            originalClusterId: cluster.id,
            addons: { [key]: true },
            addonSettings: { [key]: { settings: plan.settings, advanced: plan.advanced, version: plan.version } },
            clusterAddons: cluster.addons || {},
            requestedBy: req.user.username,
            mode: 'addon-only',
            status: 'pending',
            logs: [],
            progress: 0,
            createdAt: new Date().toISOString()
        })
        res.json({ success: true, newInstallationId, message: `Applying ${HELM_ADDONS[key].label} settings` })
    } catch (e) { sendFailure(res, e) }
})

// Sealed Secrets: encrypt a Secret with this cluster's key (kubeseal runs on
// the control-plane) — the result is safe to commit to Git
const DNS1123 = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
router.post('/:id/addons/sealed-secrets/seal', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const cluster = await loadOwnedCluster(req, res); if (!cluster) return
        const { name, namespace = 'default', scope = 'strict', data } = req.body || {}
        if (!DNS1123.test(String(name || ''))) return res.status(400).json({ error: 'Name: lowercase letters, numbers and "-" (like a Kubernetes name)' })
        if (!DNS1123.test(String(namespace))) return res.status(400).json({ error: 'Namespace: lowercase letters, numbers and "-"' })
        if (!['strict', 'namespace-wide', 'cluster-wide'].includes(scope)) return res.status(400).json({ error: 'Scope: strict, namespace-wide or cluster-wide' })
        const entries = Object.entries(data && typeof data === 'object' ? data : {})
        if (!entries.length || entries.length > 50) return res.status(400).json({ error: 'Add 1 to 50 keys with their values' })
        for (const [k, v] of entries) {
            if (!/^[-._a-zA-Z0-9]{1,253}$/.test(k)) return res.status(400).json({ error: `Key "${String(k).slice(0, 40)}": letters, numbers, "-", "_" and "." only` })
            if (typeof v !== 'string') return res.status(400).json({ error: `Value of "${k}" must be text` })
        }
        const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type: 'Opaque',
            data: Object.fromEntries(entries.map(([k, v]) => [k, Buffer.from(v, 'utf8').toString('base64')])) }
        const payload = Buffer.from(JSON.stringify(secret), 'utf8').toString('base64')
        if (payload.length > 256 * 1024) return res.status(400).json({ error: 'At most 192 KB of secret data' })
        const ssh = await automationEngine.connectSSH(cluster.masterNodes[0])
        try {
            const r = await ssh.execCommand(`echo ${payload} | base64 -d | sudo /usr/local/bin/kubeseal --kubeconfig /etc/kubernetes/admin.conf --controller-namespace sealed-secrets --controller-name sealed-secrets-controller --scope ${scope} --format yaml 2>&1`)
            if (r.code !== 0 || !/kind: SealedSecret/.test(r.stdout || '')) {
                const out = (r.stdout || r.stderr || '').trim()
                const hint = /No such file|not found/.test(out) ? 'kubeseal is missing on the control-plane — Repair the Sealed Secrets add-on.' : out.slice(0, 300)
                return res.status(502).json({ error: `Could not seal: ${hint}` })
            }
            res.json({ yaml: r.stdout, name, namespace, scope })
        } finally { ssh.dispose?.() }
    } catch (e) { sendFailure(res, e) }
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

// Load cluster + plan check in one go (route helper)
async function etcdCluster(req, res) {
    const cluster = await loadOwnedCluster(req, res)
    if (!cluster) return null
    if (!requireEtcdPlan(req, res)) return null
    return cluster
}

// Restore / recovery replace the whole cluster state → the user types the
// cluster name, so a mis-click can't trigger it
function confirmedByName(req, res, cluster) {
    if (String(req.body?.confirm || '').trim() !== String(cluster.clusterName || '').trim()) {
        res.status(400).json({ error: `Type the cluster name (${cluster.clusterName}) to confirm.` })
        return false
    }
    return true
}

// Start a background etcd job → 202 { jobId } (or 409 when the cluster is busy)
// Alert on the outcome of an etcd job (backup failures, restore/recovery results)
export function alertEtcdJob(cluster, kind, ok, detail) {
    const base = { clusterId: cluster.id, clusterName: cluster.clusterName, link: `/cluster/${cluster.id}?tab=backups` }
    if (kind === 'backup') {
        if (!ok) notifier.emit(cluster.orgId, { ...base, type: 'backup_failed', severity: 'critical', title: 'etcd backup failed', text: detail })
        else if (detail) notifier.emit(cluster.orgId, { ...base, type: 'backup_failed', severity: 'warning', title: 'Offsite upload failed', text: detail })
    }
    if (kind === 'restore' || kind === 'recover') {
        const what = kind === 'restore' ? 'etcd restore' : 'Control-plane recovery'
        notifier.emit(cluster.orgId, { ...base, type: 'restore_done', severity: ok ? 'success' : 'critical', title: `${what} ${ok ? 'finished' : 'failed'}`, text: detail || '' })
    }
}

function startEtcdJob(res, cluster, kind, fn, meta) {
    const busy = clusterBusy(cluster.id)
    if (busy) return res.status(409).json({ error: busy.message, jobId: busy.jobId })
    const watched = async (ctx) => {
        try {
            const result = await fn(ctx)
            alertEtcdJob(cluster, kind, true, kind === 'backup' ? (result?.offsite && !result.offsite.uploaded ? result.offsite.error : null)
                : (result?.warnings?.length ? result.warnings.join(' ') : 'The cluster runs on the restored state.'))
            return result
        } catch (e) {
            alertEtcdJob(cluster, kind, false, e.message)
            throw e
        }
    }
    try {
        const job = etcdJobs.start(cluster.id, kind, watched, meta)
        res.status(202).json({ success: true, jobId: job.id })
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message, jobId: e.jobId })
    }
}

// List etcd snapshots on the cluster (any org member who can view the cluster)
router.get('/:id/etcd/backups', requireAuth, async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const result = await etcdBackupService.listBackups(cluster)
        // Which snapshots also exist offsite (S3 / MinIO)?
        const target = offsiteStore.getConnected(req.user.orgId)
        if (target) {
            const r = await offsiteService.list(cluster, target)
            result.offsite = {
                connected: true, provider: target.provider, bucket: target.bucket,
                warning: sameClusterWarning(cluster, target.endpoint),
                remote: r.ok ? r.remote : [], error: r.ok ? null : r.error,
                lastSync: offsiteStore.publicView(req.user.orgId).lastSync?.[cluster.id] || null
            }
        } else {
            result.offsite = { connected: false }
        }
        result.controlPlanes = cluster.masterNodes?.length || 0
        result.activeJob = etcdJobs.view(etcdJobs.activeFor(cluster.id))
        res.json(result)
    } catch (error) {
        console.error('etcd list error:', error)
        sendFailure(res, error)
    }
})

// Offsite backups only — no Kubernetes needed, so it also works on a freshly
// installed replacement machine (disaster recovery); the listing runs there
router.get('/:id/etcd/offsite', requireAuth, async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const target = offsiteStore.getConnected(req.user.orgId)
        if (!target) return res.json({ connected: false, remote: [] })
        const r = await offsiteService.list(cluster, target)
        res.json({ connected: true, ...r })
    } catch (error) {
        sendFailure(res, error)
    }
})

// Take an on-demand etcd snapshot (control-plane maintenance → operator/admin).
// Runs as a job: the offsite upload right after it can take minutes.
router.post('/:id/etcd/backups', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const orgId = req.user.orgId
        startEtcdJob(res, cluster, 'backup', async ({ log, progress }) => {
            progress(10, 'Taking the snapshot')
            const result = await etcdBackupService.createBackup(cluster)
            if (!result.success) throw new Error(result.error || 'Snapshot failed')
            log('info', `✓ Snapshot ${result.filename} taken and verified${result.keys ? ` (${result.keys} keys)` : ''}`)
            // Copy it offsite right away when S3 / MinIO is connected
            const target = offsiteStore.getConnected(orgId)
            if (target) {
                progress(50, 'Uploading the encrypted copy offsite')
                const s = await offsiteService.sync(cluster, target)
                offsiteStore.recordSync(orgId, cluster.id, s)
                result.offsite = { uploaded: s.ok, error: s.ok ? null : s.error }
                log(s.ok ? 'info' : 'warning', s.ok ? '✓ Encrypted copy uploaded offsite' : `⚠️ Offsite upload failed: ${s.error}`)
            }
            return result
        })
    } catch (error) {
        console.error('etcd backup error:', error)
        sendFailure(res, error)
    }
})

// Checksum + integrity check of one snapshot (read-only)
router.post('/:id/etcd/verify', requireAuth, async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        res.json(await etcdBackupService.verifyBackup(cluster, req.body?.filename))
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message })
    }
})

// What would a restore change? (read-only — a throw-away etcd reads the snapshot)
router.get('/:id/etcd/preview', requireAuth, async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        res.json(await etcdBackupService.previewRestore(cluster, String(req.query.filename || '')))
    } catch (error) {
        console.error('etcd preview error:', error)
        res.status(error.status || 500).json({ error: error.message })
    }
})

// Restore etcd from a snapshot (DESTRUCTIVE → operator/admin). Works for HA
// clusters too. source=offsite fetches the encrypted bundle first.
router.post('/:id/etcd/restore', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const { filename, source = 'local' } = req.body || {}
        if (!SNAPSHOT_RE.test(filename || '')) {
            return res.status(400).json({ error: 'Invalid or missing snapshot filename' })
        }
        if (!confirmedByName(req, res, cluster)) return
        const target = source === 'offsite' ? offsiteStore.getConnected(req.user.orgId) : null
        if (source === 'offsite' && !target) return res.status(400).json({ error: 'Offsite storage is not connected.' })
        const orgId = req.user.orgId

        startEtcdJob(res, cluster, 'restore', async ({ log, progress }) => {
            if (target) {
                progress(2, 'Downloading the offsite backup')
                log('info', `Downloading ${filename} from offsite storage...`)
                const dl = await offsiteService.download(cluster, target, filename)
                if (!dl.ok) throw new Error(`Could not fetch the offsite backup: ${dl.error}`)
                log('info', '✓ Offsite backup downloaded and decrypted on the control-plane')
            }
            const result = await etcdBackupService.restoreBackup(cluster, filename, log, progress)
            // Keep the safety snapshot offsite too (best effort)
            const t = offsiteStore.getConnected(orgId)
            if (t && result.safetySnapshot) {
                const s = await offsiteService.sync(cluster, t).catch(e => ({ ok: false, error: e.message }))
                offsiteStore.recordSync(orgId, cluster.id, s)
            }
            return result
        }, { filename, source })
    } catch (error) {
        console.error('etcd restore error:', error)
        sendFailure(res, error)
    }
})

// Bring an offsite-only snapshot back to the control-plane (decrypted,
// checksummed) — then it can be previewed and restored like a local one
router.post('/:id/etcd/offsite/fetch', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const { filename } = req.body || {}
        if (!SNAPSHOT_RE.test(filename || '')) return res.status(400).json({ error: 'Invalid snapshot filename' })
        const target = offsiteStore.getConnected(req.user.orgId)
        if (!target) return res.status(400).json({ error: 'Offsite storage is not connected.' })
        startEtcdJob(res, cluster, 'fetch', async ({ log, progress }) => {
            progress(10, 'Downloading from offsite storage')
            const dl = await offsiteService.download(cluster, target, filename)
            if (!dl.ok) throw new Error(`Could not fetch the offsite backup: ${dl.error}`)
            log('info', `✓ ${filename} downloaded and decrypted on the control-plane`)
            progress(80, 'Verifying the snapshot')
            const v = await etcdBackupService.verifyBackup(cluster, filename)
            if (!v.ok) throw new Error(`The downloaded snapshot is damaged: ${v.error}`)
            log('info', `✓ Verified (revision ${v.revision}, ${v.keys} keys)`)
            return { filename }
        }, { filename })
    } catch (error) {
        sendFailure(res, error)
    }
})

// Rebuild a LOST control-plane machine from an offsite backup (disaster recovery)
router.post('/:id/etcd/recover', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const { filename } = req.body || {}
        if (!SNAPSHOT_RE.test(filename || '')) return res.status(400).json({ error: 'Choose an offsite backup to recover from.' })
        if (!confirmedByName(req, res, cluster)) return
        const target = offsiteStore.getConnected(req.user.orgId)
        if (!target) return res.status(400).json({ error: 'Recovery needs the offsite backups — connect the offsite storage first.' })
        startEtcdJob(res, cluster, 'recover', ({ log, progress }) =>
            disasterRecovery.recover(cluster, target, filename, log, progress), { filename })
    } catch (error) {
        console.error('etcd recover error:', error)
        sendFailure(res, error)
    }
})

// Restart the kubelet on every worker again (after a restore some may have been offline)
router.post('/:id/etcd/refresh-workers', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const logs = []
        const results = await etcdBackupService.refreshWorkerKubelets(cluster, (level, msg) => logs.push({ level, msg }))
        res.json({ success: results.every(r => r.ok), results, logs })
    } catch (error) {
        sendFailure(res, error)
    }
})

// Progress + log of a backup / restore / recovery job
router.get('/:id/etcd/jobs/:jobId', requireAuth, async (req, res) => {
    const cluster = await loadOwnedCluster(req, res)
    if (!cluster) return
    const job = etcdJobs.get(req.params.jobId)
    if (!job || job.clusterId !== cluster.id) return res.status(404).json({ error: 'Job not found (it may have finished more than 2 hours ago, or the server restarted).' })
    res.json(etcdJobs.view(job))
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
        sendFailure(res, error)
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
        sendFailure(res, error)
    }
})

// Install Add-ons to existing cluster
router.post('/:id/addons', requireAuth, requirePermission('addon:install'), async (req, res) => {
    try {
        const { addons } = req.body

        // Load cluster config (decrypted)
        const existingCluster = await loadOwnedCluster(req, res)
        if (!existingCluster) return
        const busy = clusterBusy(existingCluster.id)
        if (busy) return res.status(409).json({ error: busy.message, runningJobId: busy.jobId })

        // Plan-gate add-ons by the WORKSPACE plan (team members have plan 'MEMBER')
        const addonCheck = checkAddonPlan(addons, authService.getOrgPlan(req.user.orgId))
        if (!addonCheck.allowed) {
            return res.status(402).json({ error: addonCheck.error, limitExceeded: true, blockedAddons: addonCheck.blocked })
        }

        // Helm add-ons install with their saved settings (or the defaults) — a
        // setting that is required (MetalLB's addresses) must be chosen first
        for (const key of Object.keys(addons || {}).filter(k => addons[k] && isHelmAddon(k))) {
            const saved = addonSettingsStore.get(existingCluster.id, key)
            try { buildPlan(key, existingCluster, saved.applied || saved.lastSettings || {}) } catch (e) {
                return res.status(400).json({ error: `${HELM_ADDONS[key].label}: ${e.message} — open its Settings to choose them.`, needsSettings: key })
            }
        }

        const newInstallationId = uuidv4()
        const addonInstallation = {
            ...existingCluster, // Copy credentials and nodes
            clusterAddons: existingCluster.addons || {},
            requestedBy: req.user.username,
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
        const busy = clusterBusy(existingCluster.id)
        if (busy) return res.status(409).json({ error: busy.message, runningJobId: busy.jobId })

        // Upgrade safety check (KubeEZ Explorer): blockers stop the upgrade
        // unless a workspace admin explicitly accepts them. Without the
        // Explorer (or when it can't be reached) the upgrade runs as before.
        const override = req.body?.skipSafetyCheck === true
        if (override && !['admin', 'superadmin'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Only a workspace admin can upgrade despite safety-check blockers.' })
        }
        if (!override && targetVersion && existingCluster.addons?.explorer) {
            try {
                const check = await upgradeReadiness(existingCluster, req.user, targetVersion)
                if (check.verdict === 'blocked') {
                    return res.status(409).json({
                        error: `The upgrade safety check found ${check.blockers.length} blocker${check.blockers.length === 1 ? '' : 's'} for v${targetVersion} — fix ${check.blockers.length === 1 ? 'it' : 'them'} first${['admin', 'superadmin'].includes(req.user.role) ? ', or upgrade anyway' : ''}.`,
                        safetyCheck: check
                    })
                }
            } catch (e) {
                if (e.code !== 'NOT_INSTALLED') console.warn('[upgrade] safety check skipped:', e.message)
            }
        }

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

// ─── Volume backups (Velero) — files inside persistent volumes ────────────────

// Status of Velero + its backups/restores, and the saved storage settings
router.get('/:id/volume-backups', requireAuth, async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const off = offsiteStore.publicView(req.user.orgId)
        const result = {
            config: volumeBackupStore.publicView(cluster.id),
            // offsite keys changed since Velero was set up → it still uses the old ones
            staleOffsite: volumeBackupStore.isStale(cluster.id, req.user.orgId),
            offsite: off.connected ? { connected: true, provider: off.provider, endpoint: off.endpoint, bucket: off.bucket } : { connected: false },
            runningJob: (() => { const j = installationManager.runningJobFor(cluster.id); return j ? { id: j.id, mode: j.mode } : null })()
        }
        try {
            Object.assign(result, await volumeBackupService.status(cluster))
        } catch (e) {
            result.error = `Could not read Velero's state from the cluster: ${e.message}`
        }
        res.json(result)
    } catch (error) {
        console.error('volume backups status error:', error)
        sendFailure(res, error)
    }
})

// Save where backups go (own keys, or the workspace's offsite storage) and
// install / update Velero with it. Keys → admin only (backup:manage).
router.put('/:id/volume-backups/config', requireAuth, requirePermission('backup:manage'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const body = req.body || {}
        let cfg
        if (body.useOffsite) {
            const t = offsiteStore.getConnected(req.user.orgId)
            if (!t) return res.status(400).json({ error: 'The workspace has no offsite storage connected — enter the storage details instead.' })
            cfg = { ...t, source: 'offsite', prefix: [t.prefix, cluster.id, 'velero'].filter(Boolean).join('/') }
        } else {
            const existing = volumeBackupStore.get(cluster.id)
            try {
                cfg = normaliseConfig({ ...body, prefix: body.prefix || `kubeez-velero/${cluster.id}` }, existing?.source === 'custom' ? existing : null)
            } catch (e) {
                return res.status(400).json({ error: e.message })
            }
            cfg.source = 'custom'
        }
        if (sameClusterWarning(cluster, cfg.endpoint || '') && !body.allowSameCluster) {
            return res.status(400).json({ error: sameClusterWarning(cluster, cfg.endpoint), sameCluster: true })
        }
        const busy = clusterBusy(cluster.id)
        if (busy) return res.status(409).json({ error: busy.message, runningJobId: busy.jobId })
        volumeBackupStore.save(cluster.id, cfg)

        // Install (or re-apply the settings to) Velero as an add-on job
        const addonCheck = checkAddonPlan({ velero: true }, authService.getOrgPlan(req.user.orgId))
        if (!addonCheck.allowed) return res.status(402).json({ error: addonCheck.error, limitExceeded: true })
        const newInstallationId = uuidv4()
        installationManager.startInstallation({
            ...cluster,
            id: newInstallationId,
            ownerId: cluster.ownerId || req.user.id,
            orgId: cluster.orgId || req.user.orgId,
            originalClusterId: cluster.id,
            addons: { velero: true },
            mode: 'addon-only',
            status: 'pending',
            logs: [],
            progress: 0,
            createdAt: new Date().toISOString()
        })
        res.json({ success: true, newInstallationId, config: volumeBackupStore.publicView(cluster.id) })
    } catch (error) {
        console.error('volume backups config error:', error)
        sendFailure(res, error)
    }
})

// Namespaces a full backup must skip: the in-cluster S3 add-on when it is
// the backup target (never taken from the request)
function volumeBackupExcludes(cluster) {
    const cfg = volumeBackupStore.get(cluster.id)
    return cfg && sameClusterWarning(cluster, cfg.endpoint || '') ? ['seaweedfs'] : []
}

// Back up now (all namespaces, or the chosen ones)
router.post('/:id/volume-backups/backups', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const { namespaces, ttlDays } = req.body || {}
        res.json({ success: true, ...(await volumeBackupService.backupNow(cluster, { namespaces, ttlDays, exclude: volumeBackupExcludes(cluster) })) })
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message })
    }
})

router.delete('/:id/volume-backups/backups/:name', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        res.json({ success: true, ...(await volumeBackupService.deleteBackup(cluster, req.params.name)) })
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message })
    }
})

// Restore (missing only / side-by-side copy / replace). Replace deletes the
// namespaces first → typed cluster-name confirmation.
router.post('/:id/volume-backups/restores', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const { backup, namespaces = [], mode = 'missing' } = req.body || {}
        if (mode === 'replace' && !confirmedByName(req, res, cluster)) return
        res.json({ success: true, ...(await volumeBackupService.restore(cluster, backup, { namespaces, mode })) })
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message })
    }
})

router.put('/:id/volume-backups/schedule', requireAuth, requirePermission('cluster:upgrade'), async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        const { enabled, cron, ttlDays } = req.body || {}
        res.json({ success: true, ...(await volumeBackupService.setSchedule(cluster, { enabled, cron, ttlDays, exclude: volumeBackupExcludes(cluster) })) })
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message })
    }
})

router.get('/:id/volume-backups/describe/:kind/:name', requireAuth, async (req, res) => {
    try {
        const cluster = await etcdCluster(req, res)
        if (!cluster) return
        res.json(await volumeBackupService.describe(cluster, req.params.kind, req.params.name))
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message })
    }
})

// ─── KubeEZ Explorer insights (Radar's analysis in KubeEZ's own screens) ─────

// Upgrade safety check for a target version
router.get('/:id/explorer-insights/upgrade', requireAuth, async (req, res) => {
    const cluster = await loadOwnedCluster(req, res)
    if (!cluster) return
    try {
        res.json(await upgradeReadiness(cluster, req.user, String(req.query.target || '')))
    } catch (e) {
        if (e.code === 'NOT_INSTALLED') return res.json({ installed: false })
        res.status(e.status === 400 ? 400 : 200).json({ installed: true, error: e.message })
    }
})

// Cluster health score (best-practice audit)
router.get('/:id/explorer-insights/health', requireAuth, async (req, res) => {
    const cluster = await loadOwnedCluster(req, res)
    if (!cluster) return
    try {
        res.json(await clusterHealth(cluster, req.user))
    } catch (e) {
        if (e.code === 'NOT_INSTALLED') return res.json({ installed: false })
        res.json({ installed: true, error: e.message })
    }
})

export default router
