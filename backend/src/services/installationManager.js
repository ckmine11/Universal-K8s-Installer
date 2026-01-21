import { automationEngine } from './automationEngine.js'
import { clusterStore } from './clusterStore.js'

class InstallationManager {
    constructor() {
        this.installations = new Map()
        this.clients = new Map() // WebSocket clients per installation
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
            await automationEngine.install(installation, {
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
                    this.failInstallation(id, error)
                    this.broadcast(id, {
                        type: 'status',
                        status: 'failed',
                        error: error.message,
                        diagnosis: error.diagnosis // Send structured diagnosis to frontend
                    })
                }
            })
        } catch (error) {
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

            // Prepare data to save
            let finalCluster = {
                id: installationId,
                clusterName: installation.clusterName,
                k8sVersion: installation.k8sVersion,
                networkPlugin: installation.networkPlugin,
                masterNodes: installation.masterNodes,
                workerNodes: installation.workerNodes,
                addons: installation.addons,
                status: 'healthy',
                ...clusterInfo
            }

            // Handle Scaling Merge Logic
            if (installation.mode === 'scale') {
                const existingClusters = await clusterStore.getClusters()
                // Find existing cluster by Bridge Master IP (first node in list)
                const bridgeIp = installation.masterNodes[0]?.ip

                const existingCluster = existingClusters.find(c =>
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

            // Persist
            await clusterStore.saveCluster(finalCluster)
        }
    }

    failInstallation(installationId, error) {
        const installation = this.installations.get(installationId)
        if (installation) {
            installation.status = 'failed'
            installation.error = error.message
            installation.failedAt = new Date().toISOString()
        }
    }

    getStatus(installationId) {
        return this.installations.get(installationId)
    }

    getLogs(installationId) {
        const installation = this.installations.get(installationId)
        return installation ? installation.logs : null
    }

    cancelInstallation(installationId) {
        const installation = this.installations.get(installationId)
        if (installation && installation.status === 'running') {
            installation.status = 'cancelled'
            installation.cancelledAt = new Date().toISOString()

            this.broadcast(installationId, {
                type: 'status',
                status: 'cancelled'
            })

            return true
        }
        return false
    }

    async getSavedClusters() {
        return await clusterStore.getClusters()
    }


    async deleteCluster(id) {
        return await clusterStore.deleteCluster(id)
    }

    async getKubeconfig(id) {
        const clusters = await clusterStore.getClusters()
        const cluster = clusters.find(c => c.id === id)

        if (!cluster) {
            throw new Error('Cluster not found')
        }

        const masterNode = cluster.masterNodes[0]
        if (!masterNode) {
            throw new Error('No master node found configuration')
        }

        try {
            const ssh = await automationEngine.connectSSH(masterNode)
            const result = await ssh.execCommand('cat /etc/kubernetes/admin.conf')
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

    async getClusterHealth(id) {
        const clusters = await clusterStore.getClusters()
        const cluster = clusters.find(c => c.id === id)

        if (!cluster) {
            throw new Error('Cluster not found')
        }

        const masterNode = cluster.masterNodes[0]
        if (!masterNode) {
            throw new Error('No master node found configuration')
        }

        try {
            // Re-use automation engine's SSH capability
            const ssh = await automationEngine.connectSSH(masterNode)

            // Parallel execution for speed
            const [cpuResult, memResult, diskResult, nodesResult] = await Promise.all([
                // CPU Usage (simple top check)
                ssh.execCommand("top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4}'"),
                // Memory Usage (free -m)
                ssh.execCommand("free -m | awk 'NR==2{printf \"%.2f\", $3*100/$2 }'"),
                // Disk Usage (root partition)
                ssh.execCommand("df -h / | awk 'NR==2 {print $5}' | sed 's/%//'"),
                // Node Status (kubectl) - try/catch in case kubectl fails or permission issues
                ssh.execCommand("export KUBECONFIG=/etc/kubernetes/admin.conf; kubectl get nodes --no-headers | awk '{print $1,$2}'")
            ])

            ssh.dispose()

            // Parse Nodes
            const nodesList = nodesResult.stdout.split('\n').filter(Boolean).map(line => {
                const [name, status] = line.split(/\s+/)
                return { name, status }
            })

            return {
                cpu: parseFloat(cpuResult.stdout) || 0,
                ram: parseFloat(memResult.stdout) || 0,
                disk: parseFloat(diskResult.stdout) || 0,
                nodes: nodesList.length > 0 ? nodesList : null, // If null, use stored config
                timestamp: new Date().toISOString()
            }

        } catch (error) {
            console.error('Health check failed:', error)
            // Return null or partial data so UI can show "Connection Failed" instead of crashing
            return {
                error: 'Failed to connect to cluster master',
                details: error.message
            }
        }
    }
}

export const installationManager = new InstallationManager()
