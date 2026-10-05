import { v4 as uuidv4 } from 'uuid'
import { automationEngine } from './automationEngine.js'
import { clusterStore } from './clusterStore.js'
import { terminalService } from './terminalService.js'
import { sameTenant } from '../utils/access.js'

// Day-2 jobs that touch one add-on of an existing cluster
const ADDON_JOB_MODES = new Set(['addon-only', 'addon-uninstall', 'addon-reinstall'])
// The same add-on can be stored under more than one key
const addonAliases = (key) => (key === 'cert-manager' || key === 'certManager') ? ['cert-manager', 'certManager'] : [key]

class InstallationManager {
    constructor() {
        this.installations = new Map()
        this.clients = new Map() // WebSocket clients per installation
        this.cancelRequests = new Set() // installationIds requested to cancel

        // Auto-cleanup stale installations every hour
        setInterval(() => this.cleanupStaleInstallations(), 60 * 60 * 1000).unref?.()
    }

    /** A job (install/upgrade/add-on…) still running on this cluster, if any. */
    runningJobFor(clusterId) {
        for (const job of this.installations.values()) {
            if (job.status === 'running' && (job.originalClusterId === clusterId || job.id === clusterId)) return job
        }
        return null
    }

    cleanupStaleInstallations() {
        const now = new Date().getTime()
        const ONE_DAY = 24 * 60 * 60 * 1000

        for (const [id, inst] of this.installations.entries()) {
            const startDate = new Date(inst.startedAt).getTime()
            // Remove if older than 24 hours AND not running
            if (now - startDate > ONE_DAY && inst.status !== 'running') {
                this.installations.delete(id)
                this.clients.delete(id) // Ensure clients are gone too
            }
        }
    }

    addClient(installationId, ws) {
        if (!this.clients.has(installationId)) {
            this.clients.set(installationId, new Set())
        }
        this.clients.get(installationId).add(ws)

        // Send historical data to the new client
        const inst = this.installations.get(installationId)
        if (inst && ws.readyState === 1) { // WebSocket.OPEN
            // Send current status
            ws.send(JSON.stringify({
                type: 'status',
                status: inst.status,
                clusterInfo: inst.clusterInfo
            }))

            // Send current progress
            ws.send(JSON.stringify({
                type: 'progress',
                progress: inst.progress,
                step: inst.currentStep
            }))

            // Replay all historical logs
            inst.logs.forEach(log => {
                ws.send(JSON.stringify({
                    type: 'log',
                    level: log.level,
                    message: log.message,
                    timestamp: log.timestamp
                }))
            })
        }
    }

    removeClient(installationId, ws) {
        const clients = this.clients.get(installationId)
        if (clients) {
            clients.delete(ws)
            if (clients.size === 0) {
                this.clients.delete(installationId)
            }
        }
    }

    broadcast(installationId, message) {
        const clients = this.clients.get(installationId)
        if (clients) {
            const data = JSON.stringify(message)
            clients.forEach(client => {
                if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(data)
                }
            })
        }
    }

    async startInstallation(installation) {
        const { id } = installation

        // Store installation
        this.installations.set(id, {
            ...installation,
            status: 'running',
            progress: 0,
            logs: [],
            startedAt: new Date().toISOString()
        })

        // Send initial status
        this.broadcast(id, {
            type: 'status',
            status: 'running'
        })

        // Start automation engine
        try {
            const callbacks = {
                onLog: (level, message) => {
                    this.addLog(id, level, message)
                    this.broadcast(id, {
                        type: 'log',
                        level,
                        message
                    })
                },
                onProgress: (progress, step) => {
                    this.updateProgress(id, progress, step)
                    this.broadcast(id, {
                        type: 'progress',
                        progress,
                        step
                    })
                },
                onComplete: (clusterInfo) => {
                    this.completeInstallation(id, clusterInfo)
                    this.broadcast(id, {
                        type: 'status',
                        status: 'completed',
                        clusterInfo
                    })
                },
                onError: (error) => {
                    // If the user cancelled, keep the 'cancelled' state (don't mark failed)
                    if (this.cancelRequests.has(id)) {
                        this.addLog(id, 'warning', '⛔ Installation cancelled by user')
                        this.broadcast(id, { type: 'status', status: 'cancelled' })
                        return
                    }
                    this.failInstallation(id, error)
                    this.broadcast(id, {
                        type: 'status',
                        status: 'failed',
                        error: error.message,
                        diagnosis: error.diagnosis
                    })
                },
                // Cancellation checkpoint — automationEngine calls this between steps
                checkCancel: () => {
                    if (this.cancelRequests.has(id)) {
                        throw new Error('Installation cancelled by user')
                    }
                }
            }

            if (installation.mode === 'upgrade') {
                await automationEngine.upgradeCluster(installation, installation.targetVersion, callbacks)
            } else {
                await automationEngine.install(installation, callbacks)
            }

        } catch (error) {
            if (this.cancelRequests.has(id)) {
                this.addLog(id, 'warning', '⛔ Installation cancelled by user')
                this.broadcast(id, { type: 'status', status: 'cancelled' })
                return
            }
            this.failInstallation(id, error)
            this.broadcast(id, {
                type: 'status',
                status: 'failed',
                error: error.message,
                diagnosis: error.diagnosis
            })
        }
    }

    addLog(installationId, level, message) {
        const installation = this.installations.get(installationId)
        if (installation) {
            installation.logs.push({
                level,
                message,
                timestamp: new Date().toISOString()
            })

            // Cap logs at 2000 entries to prevent OOM
            if (installation.logs.length > 2000) {
                installation.logs = installation.logs.slice(-2000)
            }
        }
    }

    updateProgress(installationId, progress, step) {
        const installation = this.installations.get(installationId)
        if (installation) {
            installation.progress = progress
            installation.currentStep = step
        }
    }

    async completeInstallation(installationId, clusterInfo) {
        const installation = this.installations.get(installationId)
        if (installation) {
            installation.status = 'completed'
            installation.progress = 100
            installation.clusterInfo = clusterInfo
            installation.completedAt = new Date().toISOString()

            // On upgrade, the cluster version must reflect the TARGET version —
            // installation.k8sVersion is a copy of the OLD cluster's version.
            const effectiveVersion = (installation.mode === 'upgrade' && installation.targetVersion)
                ? installation.targetVersion
                : installation.k8sVersion

            // Prepare data to save
            let finalCluster = {
                id: installationId,
                ownerId: installation.ownerId, // Save the ownerId to the cluster data
                orgId: installation.orgId,     // Workspace isolation — team members need this
                clusterName: installation.clusterName,
                k8sVersion: effectiveVersion,
                networkPlugin: installation.networkPlugin,
                masterNodes: installation.masterNodes,
                workerNodes: installation.workerNodes,
                addons: installation.addons,
                status: 'healthy',
                ...clusterInfo
            }

            // Handle Upgrade/Addon ID Preservation
            if (installation.originalClusterId) {
                finalCluster.id = installation.originalClusterId
            }

            // Handle Scaling Merge Logic
            if (installation.mode === 'scale') {
                const existingClusters = await clusterStore.getClusters()
                // Find existing cluster by Bridge Master IP (first node in list)
                const bridgeIp = installation.masterNodes[0]?.ip

                // Only ever merge into a cluster of the SAME tenant
                const existingCluster = existingClusters.find(c =>
                    sameTenant(c, installation) &&
                    c.masterNodes && c.masterNodes.some(n => n.ip === bridgeIp)
                )

                if (existingCluster) {
                    // Preserve original Cluster ID
                    finalCluster.id = existingCluster.id

                    // Merge Nodes (filtering duplicates based on IP)
                    const mergeNodes = (oldNodes, newNodes) => {
                        const uniqueMap = new Map()
                        if (oldNodes) oldNodes.forEach(n => uniqueMap.set(n.ip, n))
                        if (newNodes) newNodes.forEach(n => uniqueMap.set(n.ip, n))
                        return Array.from(uniqueMap.values())
                    }

                    finalCluster.masterNodes = mergeNodes(existingCluster.masterNodes, installation.masterNodes)
                    finalCluster.workerNodes = mergeNodes(existingCluster.workerNodes, installation.workerNodes)
                }
            }

            // Add-on jobs change ONE add-on of an existing cluster: merge into the
            // saved add-on list instead of replacing it with this job's selection.
            if (ADDON_JOB_MODES.has(installation.mode)) {
                const existing = (await clusterStore.getClusters()).find(c => c.id === finalCluster.id)
                const addons = { ...(existing?.addons || {}) }
                if (installation.mode === 'addon-only') {
                    for (const [k, v] of Object.entries(installation.addons || {})) if (v) addons[k] = true
                } else if (installation.mode === 'addon-reinstall') {
                    addons[installation.uninstallAddon] = true
                } else {
                    for (const k of addonAliases(installation.uninstallAddon)) delete addons[k]
                }
                finalCluster.addons = addons
                if (existing) finalCluster.k8sVersion = existing.k8sVersion
                // A cluster whose INSTALL or UPGRADE failed stays failed (Resume /
                // retry is still needed). One marked failed only because an add-on
                // failed (older KubeEZ versions did that) is healthy again.
                if (existing?.status === 'failed' && !ADDON_JOB_MODES.has(existing.mode)) {
                    finalCluster.status = 'failed'
                    finalCluster.mode = existing.mode
                    finalCluster.error = existing.error
                }
            }

            // Persist
            await clusterStore.saveCluster(finalCluster)

            // Start auto-healing on the freshly completed cluster immediately
            // (no need to wait for a server restart). Only for real clusters.
            if (!finalCluster.simulationMode && finalCluster.status === 'healthy') {
                try {
                    const { incidentDetector } = await import('./incidentDetector.js')
                    incidentDetector.watchCluster(finalCluster)
                } catch (e) {
                    console.error('[InstallationManager] Failed to start auto-healing:', e.message)
                }

                // An upgrade took a pre-upgrade etcd snapshot — copy it offsite
                // when the workspace has S3 / MinIO connected. Fire-and-forget.
                if (installation.mode === 'upgrade') {
                    ;(async () => {
                        const { offsiteStore } = await import('./offsiteStore.js')
                        const target = offsiteStore.getConnected(installation.orgId)
                        if (!target) return
                        const { offsiteService } = await import('./offsiteService.js')
                        const r = await offsiteService.sync(finalCluster, target)
                        offsiteStore.recordSync(installation.orgId, finalCluster.id, r)
                        if (!r.ok) console.error(`[Offsite] Upload after upgrade failed for ${finalCluster.clusterName}: ${r.error}`)
                    })().catch(e => console.error('[Offsite] Upload after upgrade failed:', e.message))
                }
            }
        }
    }

    failInstallation(installationId, error) {
        const installation = this.installations.get(installationId)
        if (installation) {
            installation.status  = 'failed'
            installation.error   = error.message
            installation.diagnosis = error.diagnosis   // reason + fix, re-shown after a page refresh
            installation.failedAt = new Date().toISOString()

            // An add-on job failing says nothing about the cluster itself — keep the
            // cluster's saved state (it used to become "Installation Failed").
            if (ADDON_JOB_MODES.has(installation.mode)) return

            // Persist to disk so resume works after server restart (fire-and-forget)
            clusterStore.saveCluster({
                id:            installation.originalClusterId || installationId,
                ownerId:       installation.ownerId,
                orgId:         installation.orgId,
                clusterName:   installation.clusterName,
                k8sVersion:    installation.k8sVersion,
                networkPlugin: installation.networkPlugin,
                masterNodes:   installation.masterNodes,
                workerNodes:   installation.workerNodes,
                addons:        installation.addons,
                mode:          installation.mode,
                status:        'failed',
                error:         error.message,
                failedAt:      installation.failedAt
            }).catch(e =>
                console.error('[InstallationManager] Could not persist failed cluster:', e.message)
            )
        }
    }

    async resumeInstallation(clusterId, analysis, userId, orgId) {
        const { resumeAnalyzer } = await import('./resumeAnalyzer.js')

        // Load cluster config from store (has SSH creds)
        const clusters = await clusterStore.getClusters()
        const cluster = clusters.find(c => c.id === clusterId)
        if (!cluster) throw new Error('Cluster not found — cannot resume')

        const resumeId = uuidv4()

        const resumeInstallation = {
            ...cluster,
            id: resumeId,
            originalClusterId: clusterId,
            ownerId: userId,
            orgId,
            mode: 'resume',
            status: 'pending',
            progress: 0,
            logs: [],
            createdAt: new Date().toISOString()
        }

        this.installations.set(resumeId, {
            ...resumeInstallation,
            status: 'running',
            startedAt: new Date().toISOString()
        })

        this.broadcast(resumeId, { type: 'status', status: 'running' })

        // Run resume in background
        const callbacks = {
            onLog: (level, message) => {
                this.addLog(resumeId, level, message)
                this.broadcast(resumeId, { type: 'log', level, message })
            },
            onProgress: (progress, step) => {
                this.updateProgress(resumeId, progress, step)
                this.broadcast(resumeId, { type: 'progress', progress, step })
            },
            onComplete: (clusterInfo) => {
                this.completeInstallation(resumeId, clusterInfo)
                this.broadcast(resumeId, { type: 'status', status: 'completed', clusterInfo })
            },
            onError: (error) => {
                this.failInstallation(resumeId, error)
                this.broadcast(resumeId, { type: 'status', status: 'failed', error: error.message })
            }
        }

        automationEngine.resume(cluster, analysis, callbacks).catch(err => {
            this.failInstallation(resumeId, err)
        })

        return resumeId
    }

    getStatus(installationId) {
        return this.installations.get(installationId)
    }

    // List installations the UI should surface: anything RUNNING, plus ones that
    // finished (completed/failed/cancelled) within the last few minutes so the
    // result is briefly visible. Old finished installs are NOT returned — they
    // must not resurface as stale "Active Processes" entries.
    getActiveInstallations(userId, orgId) {
        const RECENT_MS = 10 * 60 * 1000 // show finished installs for 10 min
        const now = Date.now()
        const result = []
        for (const [id, inst] of this.installations.entries()) {
            const owned = (orgId && inst.orgId === orgId) || (userId && inst.ownerId === userId)
            if (!owned) continue

            const status = inst.status || 'running'
            if (status !== 'running') {
                const finishedAt = inst.completedAt || inst.failedAt || inst.cancelledAt
                const age = finishedAt ? (now - new Date(finishedAt).getTime()) : Infinity
                if (age > RECENT_MS) continue // too old — don't surface
            }

            result.push({
                id,
                clusterName: inst.clusterName || 'Cluster',
                mode: inst.mode || 'install',
                status,
                progress: inst.progress || 0,
                currentStep: inst.currentStep || '',
                startedAt: inst.startedAt || inst.createdAt || new Date().toISOString()
            })
        }
        return result
    }

    getLogs(installationId) {
        const installation = this.installations.get(installationId)
        return installation ? installation.logs : null
    }

    cancelInstallation(installationId) {
        const installation = this.installations.get(installationId)
        if (!installation) return false

        // Flag for the automation engine's checkCancel() to abort mid-run
        this.cancelRequests.add(installationId)
        installation.status = 'cancelled'
        installation.cancelledAt = new Date().toISOString()

        this.addLog(installationId, 'warning', '⛔ Cancellation requested — stopping after the current step...')
        this.broadcast(installationId, { type: 'status', status: 'cancelled' })

        // Persist as 'cancelled' so the user can Resume later (skips completed steps)
        clusterStore.saveCluster({
            id:            installation.originalClusterId || installationId,
            ownerId:       installation.ownerId,
            orgId:         installation.orgId,
            clusterName:   installation.clusterName,
            k8sVersion:    installation.k8sVersion,
            networkPlugin: installation.networkPlugin,
            masterNodes:   installation.masterNodes,
            workerNodes:   installation.workerNodes,
            addons:        installation.addons,
            mode:          installation.mode,
            status:        'cancelled',
            cancelledAt:   installation.cancelledAt
        }).catch(e => console.error('[InstallationManager] Could not persist cancelled cluster:', e.message))

        // Clear the cancel flag after a grace period (engine will have aborted by then)
        setTimeout(() => this.cancelRequests.delete(installationId), 60000)
        return true
    }

    async getSavedClusters() {
        return await clusterStore.getClusters()
    }


    async deleteCluster(id) {
        // CLEANUP: Force close any active sessions before deleting data
        try {
            console.log(`[Cleanup] Closing active sessions for cluster ${id}`)

            // Cancel any in-progress installation/upgrade/resume for this cluster
            for (const [instId, inst] of this.installations.entries()) {
                const belongs = instId === id || inst.originalClusterId === id
                if (belongs && inst.status === 'running') {
                    console.log(`[Cleanup] Cancelling running installation ${instId} for deleted cluster ${id}`)
                    this.cancelInstallation(instId)
                }
            }

            await terminalService.closeSession(id)
            // Stop auto-healing watchers so we don't keep polling a deleted cluster
            const { incidentDetector } = await import('./incidentDetector.js')
            incidentDetector.stopWatching(id)
        } catch (err) {
            console.warn(`[Cleanup] Warning during session cleanup for ${id}:`, err.message)
        }

        return await clusterStore.deleteCluster(id)
    }

    async getKubeconfig(id) {
        const clusters = await clusterStore.getClusters()
        const cluster = clusters.find(c => c.id === id)

        if (!cluster) {
            throw new Error('Cluster not found')
        }

        // Handle Simulation Mode
        if (cluster.simulationMode) {
            return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUN5RENDQWJ...
    server: https://${cluster.masterNodes[0].ip}:6443
  name: ${cluster.clusterName}
contexts:
- context:
    cluster: ${cluster.clusterName}
    user: kubernetes-admin
  name: kubernetes-admin@${cluster.clusterName}
current-context: kubernetes-admin@${cluster.clusterName}
kind: Config
preferences: {}
users:
- name: kubernetes-admin
  user:
    client-certificate-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JS...
    client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVkt...`
        }

        const masterNode = cluster.masterNodes[0]
        if (!masterNode) {
            throw new Error('No master node found configuration')
        }

        try {
            const ssh = await automationEngine.connectSSH(masterNode)
            // Use sudo to ensure we can read the file even if non-root user
            const result = await ssh.execCommand('sudo cat /etc/kubernetes/admin.conf')
            ssh.dispose()

            if (result.stderr) {
                // Sometimes stderr might have warnings, but if stdout is empty, it's an error
                if (!result.stdout) throw new Error('Failed to read kubeconfig: ' + result.stderr)
            }

            return result.stdout
        } catch (error) {
            console.error('Get Kubeconfig failed:', error)
            throw new Error('Failed to retrieve kubeconfig: ' + error.message)
        }
    }

    // Live status is polled every 15 s by every open cluster page: concurrent
    // requests share one check, and a result is reused for a few seconds, so
    // several tabs / overlapping polls don't each open SSH through the tunnel.
    async getClusterHealth(id) {
        this._health = this._health || new Map()
        const hit = this._health.get(id)
        if (hit && (hit.pending || Date.now() - hit.at < 5000)) return hit.promise
        const entry = { pending: true, at: Date.now() }
        entry.promise = this._fetchClusterHealth(id).finally(() => { entry.pending = false; entry.at = Date.now() })
        this._health.set(id, entry)
        return entry.promise
    }

    async _fetchClusterHealth(id) {
        const clusters = await clusterStore.getClusters()
        const cluster = clusters.find(c => c.id === id)

        if (!cluster) {
            // Fallback: Check if this is an active/completed installation ID
            // and try to resolve to the real cluster via Master IP
            const installation = this.installations.get(id)
            if (installation) {
                const masterIp = installation.masterNodes?.[0]?.ip
                if (masterIp) {
                    const found = clusters.find(c =>
                        sameTenant(c, installation) &&
                        c.masterNodes && c.masterNodes.some(n => n.ip === masterIp))
                    if (found) {
                        return this.getClusterHealth(found.id)
                    }
                }
            }

            throw new Error('Cluster not found')
        }

        // Handle Simulation Mode - Return Fake Healthy Data
        if (cluster.simulationMode) {
            const randomCpu = (Math.random() * 15 + 5).toFixed(1) // 5-20%
            const randomRam = (Math.random() * 30 + 20).toFixed(1) // 20-50%
            const randomDisk = (Math.random() * 5 + 40).toFixed(1) // 40-45%

            return {
                cpu: parseFloat(randomCpu),
                mem: parseFloat(randomRam),
                disk: parseFloat(randomDisk),
                pods: Math.floor(Math.random() * 20 + 10),
                nodes: cluster.masterNodes.concat(cluster.workerNodes || []).map(n => ({
                    name: n.hostname || `node-${n.ip}`,
                    status: 'Ready',
                    ip: n.ip
                })),
                timestamp: new Date().toISOString()
            }
        }

        const masterNode = cluster.masterNodes[0]
        if (!masterNode) {
            throw new Error('No master node found configuration')
        }

        let ssh
        try {
            // Re-use automation engine's SSH capability
            ssh = await automationEngine.connectSSH(masterNode, { readyTimeout: 10000 })
        } catch (error) {
            return { error: 'Cannot connect to the control-plane', details: error.message, step: 'connect' }
        }

        try {
            // admin.conf is readable by root only: a non-root SSH user (passwordless
            // sudo is set up on connect) must read it through sudo. Short timeout —
            // the page polls every 15 s and must never hang on a slow tunnel.
            const KUBECTL = 'sudo -n KUBECONFIG=/etc/kubernetes/admin.conf kubectl'
            const run = (cmd) => ssh.execCommand(cmd, { timeoutMs: 20000 })
            const [cpuResult, memResult, diskResult, nodesResult, podsResult] = await Promise.all([
                // CPU Usage (simple top check)
                run("top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'"),
                // Memory Usage (free -m)
                run("free -m | awk 'NR==2{printf \"%.2f\", $3*100/$2 }'"),
                // Disk Usage (root partition)
                run("df -h / | awk 'NR==2 {print $5}' | sed 's/%//'"),
                // Node Status (kubectl -o wide) - Name, Status, Roles, and INTERNAL-IP (col 6)
                run(`${KUBECTL} get nodes -o wide --no-headers | awk '{print $1,$2,$3,$6}'`),
                // Pods Running count
                run(`${KUBECTL} get pods -A --field-selector=status.phase=Running --no-headers | wc -l`)
            ])

            ssh.dispose?.()

            // Through the Gateway Agent a failed SSH login comes back as failed
            // commands, not as an exception — if nothing ran, report the reason
            const all = [cpuResult, memResult, diskResult, nodesResult, podsResult]
            if (all.every(r => r.code !== 0)) {
                return {
                    error: 'Cannot run commands on the control-plane',
                    details: (nodesResult.stderr || nodesResult.stdout || 'no output').trim().split('\n').pop().slice(0, 300),
                    step: 'commands'
                }
            }

            // Parse Nodes (name, status, roles, internal-ip)
            const nodesList = nodesResult.stdout.split('\n').filter(Boolean).map(line => {
                const [name, status, rawRole, ip] = line.split(/\s+/)
                const isMaster = rawRole && (rawRole.includes('master') || rawRole.includes('control-plane'))
                return {
                    name,
                    status,
                    role: isMaster ? 'master' : 'worker',
                    ip: ip && ip !== '<none>' ? ip : undefined
                }
            })

            return {
                cpu: parseFloat(cpuResult.stdout) || 0,
                mem: parseFloat(memResult.stdout) || 0,
                disk: parseFloat(diskResult.stdout) || 0,
                pods: parseInt((podsResult.stdout || '0').trim(), 10) || 0,
                nodes: nodesList.length > 0 ? nodesList : null, // If null, use stored config
                // Connected, but the node list could not be read — say why
                nodesError: nodesList.length ? undefined
                    : ((nodesResult.stderr || nodesResult.stdout || '').trim().split('\n').pop() || 'kubectl returned no nodes').slice(0, 300),
                timestamp: new Date().toISOString()
            }

        } catch (error) {
            console.error('Health check failed:', error)
            ssh?.dispose?.()
            // A reason the UI can show instead of a silent "Unknown"
            return {
                error: 'Could not read the cluster status',
                details: error.message,
                step: 'commands'
            }
        }
    }
}

export const installationManager = new InstallationManager()
