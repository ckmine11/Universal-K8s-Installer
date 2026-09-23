import { automationEngine } from './automationEngine.js'

class RemediationEngine {
    constructor() {
        this.automationEngine = automationEngine
        this.activeIncidents = new Map()
    }

    async handleAnomaly(cluster, event, incident) {
        // ... (We need dynamic import to avoid circular dependency since incidentDetector imports remediationEngine)
        const cacheKey = `${cluster.id}-${event.involvedObject?.name}-${event.reason}`
        
        if (this.activeIncidents.has(cacheKey)) {
            const lastTime = this.activeIncidents.get(cacheKey)
            if (Date.now() - lastTime < 5 * 60 * 1000) return
        }

        this.activeIncidents.set(cacheKey, Date.now())

        console.log(`[RemediationEngine] Analyzing anomaly: ${event.reason} on ${event.involvedObject?.name}`)

        if (event.reason === 'NodeNotReady') {
            await this.remediateNodeNotReady(cluster, event.involvedObject?.name, incident)
        } else if (event.reason === 'DiskPressure') {
            await this.remediateDiskPressure(cluster, event.involvedObject?.name, incident)
        } else {
            console.log(`[RemediationEngine] No automated playbook for ${event.reason}. Logging incident.`)
            this.updateStatus(incident, 'unresolved', 'No automated playbook available.')
        }
    }

    async updateStatus(incident, status, details) {
        const { incidentDetector } = await import('./incidentDetector.js')
        incidentDetector.updateIncidentStatus(incident.id, status, details)
    }

    async remediateNodeNotReady(cluster, nodeName, incident) {
        const allNodes = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])]
        const targetNode = allNodes.find(n => n.ip === nodeName || n.name === nodeName)

        if (!targetNode) {
            this.updateStatus(incident, 'failed', 'Node not found in inventory.')
            return
        }

        this.updateStatus(incident, 'remediating', `Auto-Fixing NodeNotReady: Restarting Kubelet on ${targetNode.ip}`)

        const ssh = await this.automationEngine.connectSSH(targetNode)
        try {
            await ssh.execCommand('sudo systemctl restart kubelet')
            await ssh.execCommand('sudo systemctl restart containerd')
            this.updateStatus(incident, 'resolved', 'Restarted kubelet and containerd.')
        } catch (err) {
            this.updateStatus(incident, 'failed', `SSH execution failed: ${err.message}`)
        } finally {
            if (ssh.dispose) ssh.dispose()
        }
    }

    async remediateDiskPressure(cluster, nodeName, incident) {
        const allNodes = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])]
        const targetNode = allNodes.find(n => n.ip === nodeName || n.name === nodeName)

        if (!targetNode) {
            this.updateStatus(incident, 'failed', 'Node not found in inventory.')
            return
        }

        this.updateStatus(incident, 'remediating', `Auto-Fixing DiskPressure: Pruning unused images on ${targetNode.ip}`)

        const ssh = await this.automationEngine.connectSSH(targetNode)
        try {
            await ssh.execCommand('sudo crictl rmi --prune || sudo docker image prune -a -f')
            await ssh.execCommand('sudo journalctl --vacuum-time=1d')
            this.updateStatus(incident, 'resolved', 'Cleared unused container images and journals.')
        } catch (err) {
            this.updateStatus(incident, 'failed', `SSH execution failed: ${err.message}`)
        } finally {
            if (ssh.dispose) ssh.dispose()
        }
    }
}

export const remediationEngine = new RemediationEngine()
