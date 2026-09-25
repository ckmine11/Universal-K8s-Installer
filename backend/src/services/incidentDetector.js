import { clusterStore } from './clusterStore.js'
import { automationEngine } from './automationEngine.js'
import { remediationEngine } from './remediationEngine.js'

class IncidentDetector {
    constructor() {
        this.automationEngine = automationEngine
        this.activeStreams = new Map() // clusterId -> proxy/ssh connection
        this.incidents = [] // In-memory store for UI
    }

    getIncidents() {
        return this.incidents
    }

    async init() {
        console.log('[IncidentDetector] Initializing Real-time Event Streams...')
        const clusters = await clusterStore.getClusters()
        for (const cluster of clusters) {
            if (cluster.status === 'healthy') {
                this.startWatching(cluster)
            }
        }
    }

    async startWatching(cluster) {
        if (this.activeStreams.has(cluster.id)) {
            return // Already watching
        }

        const masterNode = cluster.masterNodes?.[0]
        if (!masterNode) return

        console.log(`[IncidentDetector] Establishing SSH Stream to Master Node ${masterNode.ip} for cluster ${cluster.name}`)

        try {
            // Re-use AutomationEngine's connect logic which routes through Gateway Agent if needed
            const ssh = await this.automationEngine.connectSSH(masterNode)
            this.activeStreams.set(cluster.id, ssh)

            // Start long-running kubectl watch command
            ssh.execCommand('kubectl get events --watch -A -o json', {
                onStdout: (chunk) => {
                    const lines = chunk.toString('utf8').split('\n')
                    for (const line of lines) {
                        if (!line.trim()) continue
                        try {
                            const event = JSON.parse(line)
                            this.processEvent(cluster, event)
                        } catch (e) {
                            // Ignore parse errors (partial chunks)
                        }
                    }
                },
                onStderr: (chunk) => {
                    console.log(`[IncidentDetector Error] ${cluster.name}:`, chunk.toString('utf8'))
                }
            }).catch(err => {
                console.log(`[IncidentDetector] Stream ended for ${cluster.name}: ${err.message}`)
                this.activeStreams.delete(cluster.id)
                // Try reconnecting after 10s
                setTimeout(() => this.startWatching(cluster), 10000)
            })

        } catch (err) {
            console.error(`[IncidentDetector] Failed to connect to ${cluster.name}:`, err.message)
            // Retry later
            setTimeout(() => this.startWatching(cluster), 30000)
        }
    }

    processEvent(cluster, event) {
        // Filter out normal events
        if (event.type === 'Normal') return

        const incident = {
            id: Date.now().toString(),
            clusterId: cluster.id,
            clusterName: cluster.name,
            orgId: cluster.orgId,
            ownerId: cluster.ownerId,
            reason: event.reason,
            message: event.message,
            timestamp: new Date().toISOString(),
            status: 'detecting',
            target: event.involvedObject?.name
        }

        console.log(`[IncidentDetector] Anomaly Detected in ${cluster.name}: ${event.reason} - ${event.message}`)
        
        // Keep only last 100
        this.incidents.unshift(incident)
        if (this.incidents.length > 100) this.incidents.pop()
        
        // Dispatch to Remediation Engine
        remediationEngine.handleAnomaly(cluster, event, incident)
    }

    updateIncidentStatus(incidentId, status, details) {
        const inc = this.incidents.find(i => i.id === incidentId)
        if (inc) {
            inc.status = status
            if (details) inc.details = details
        }
    }

    stopWatching(clusterId) {
        const ssh = this.activeStreams.get(clusterId)
        if (ssh) {
            if (ssh.dispose) ssh.dispose()
            this.activeStreams.delete(clusterId)
        }
    }
}

export const incidentDetector = new IncidentDetector()
