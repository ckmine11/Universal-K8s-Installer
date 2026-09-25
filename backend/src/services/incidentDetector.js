import { clusterStore } from './clusterStore.js'
import { automationEngine } from './automationEngine.js'
import { remediationEngine } from './remediationEngine.js'

const NODE_POLL_INTERVAL  = 60  * 1000   // 60s
const POD_POLL_INTERVAL   = 90  * 1000   // 90s
const RECONNECT_BASE_MS   = 10  * 1000   // 10s
const RECONNECT_MAX_MS    = 5   * 60 * 1000 // 5min cap
const INCIDENT_TTL_MS     = 24  * 60 * 60 * 1000 // 24h
const DEDUP_WINDOW_MS     = 5   * 60 * 1000 // 5min — same incident won't be created twice

class IncidentDetector {
    constructor() {
        this.automationEngine   = automationEngine
        this.eventStreams        = new Map()   // clusterId -> { ssh, lineBuffer }
        this.pollers            = new Map()   // clusterId -> { nodeTimer, podTimer }
        this.reconnectAttempts  = new Map()   // clusterId -> number
        this.incidents          = []
    }

    getIncidents() {
        return this.incidents
    }

    async init() {
        console.log('[AutoHealing] Initializing Auto-Healing Engine...')
        const clusters = await clusterStore.getClusters()
        for (const cluster of clusters) {
            if (cluster.status === 'healthy') {
                this.startWatching(cluster)
            }
        }
    }

    // Called externally when a cluster finishes installation
    watchCluster(cluster) {
        this.startWatching(cluster)
    }

    async startWatching(cluster) {
        if (this.eventStreams.has(cluster.id)) return

        const masterNode = cluster.masterNodes?.[0]
        if (!masterNode) return

        const attempt = this.reconnectAttempts.get(cluster.id) || 0
        console.log(`[AutoHealing] Connecting to ${cluster.name} (attempt ${attempt + 1})`)

        try {
            const ssh = await this.automationEngine.connectSSH(masterNode)
            this.reconnectAttempts.set(cluster.id, 0)

            // ── 1. Event stream watcher ──────────────────────────────────────
            let lineBuffer = ''
            this.eventStreams.set(cluster.id, { ssh })

            ssh.execCommand('kubectl get events --watch -A -o json 2>/dev/null', {
                onStdout: (chunk) => {
                    lineBuffer += chunk.toString('utf8')
                    const lines = lineBuffer.split('\n')
                    lineBuffer = lines.pop() // Hold incomplete last line
                    for (const line of lines) {
                        if (!line.trim()) continue
                        try {
                            const event = JSON.parse(line)
                            if (event.type && event.type !== 'Normal') {
                                this._createIncident(cluster,
                                    event.reason,
                                    event.message,
                                    event.involvedObject?.name
                                )
                            }
                        } catch (_) { /* partial chunk — skip */ }
                    }
                },
                onStderr: () => {}
            }).catch(err => {
                console.warn(`[AutoHealing] Event stream lost for ${cluster.name}: ${err.message}`)
                this._scheduleReconnect(cluster)
            })

            // ── 2. Node health poller ────────────────────────────────────────
            const nodeTimer = setInterval(
                () => this._pollNodeHealth(cluster),
                NODE_POLL_INTERVAL
            )

            // ── 3. Pod health poller ─────────────────────────────────────────
            const podTimer = setInterval(
                () => this._pollPodHealth(cluster),
                POD_POLL_INTERVAL
            )

            this.pollers.set(cluster.id, { nodeTimer, podTimer })

            // Run first poll immediately without waiting for interval
            this._pollNodeHealth(cluster)
            this._pollPodHealth(cluster)

            console.log(`[AutoHealing] Watching ${cluster.name} — event stream + node/pod pollers active`)

        } catch (err) {
            console.error(`[AutoHealing] Failed to connect to ${cluster.name}: ${err.message}`)
            this._scheduleReconnect(cluster)
        }
    }

    _scheduleReconnect(cluster) {
        this._cleanup(cluster.id)

        const attempt = this.reconnectAttempts.get(cluster.id) || 0
        this.reconnectAttempts.set(cluster.id, attempt + 1)

        // Exponential backoff: 10s → 20s → 40s → ... → 5min
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS)
        console.log(`[AutoHealing] Will reconnect to ${cluster.name} in ${Math.round(delay / 1000)}s`)
        setTimeout(() => this.startWatching(cluster), delay)
    }

    _cleanup(clusterId) {
        const stream = this.eventStreams.get(clusterId)
        if (stream?.ssh?.dispose) {
            try { stream.ssh.dispose() } catch (_) {}
        }
        this.eventStreams.delete(clusterId)

        const pollers = this.pollers.get(clusterId)
        if (pollers) {
            clearInterval(pollers.nodeTimer)
            clearInterval(pollers.podTimer)
            this.pollers.delete(clusterId)
        }
    }

    // ── Node health poller ─────────────────────────────────────────────────────
    async _pollNodeHealth(cluster) {
        // Reuse the existing event-stream SSH connection — no new connection needed
        const stream = this.eventStreams.get(cluster.id)
        if (!stream?.ssh) return
        const ssh = stream.ssh

        try {
            const result = await ssh.execCommand('kubectl get nodes -o json 2>/dev/null')
            if (result.code !== 0 || !result.stdout?.trim()) return

            const data = JSON.parse(result.stdout)
            for (const node of (data.items || [])) {
                const name = node.metadata.name
                for (const cond of (node.status?.conditions || [])) {
                    if (cond.type === 'Ready' && cond.status !== 'True') {
                        this._createIncident(cluster, 'NodeNotReady',
                            `Node ${name} is not Ready: ${cond.message}`, name)
                    }
                    if (cond.type === 'DiskPressure' && cond.status === 'True') {
                        this._createIncident(cluster, 'DiskPressure',
                            `Node ${name} has DiskPressure: ${cond.message}`, name)
                    }
                    if (cond.type === 'MemoryPressure' && cond.status === 'True') {
                        this._createIncident(cluster, 'MemoryPressure',
                            `Node ${name} has MemoryPressure: ${cond.message}`, name)
                    }
                    if (cond.type === 'PIDPressure' && cond.status === 'True') {
                        this._createIncident(cluster, 'PIDPressure',
                            `Node ${name} has PIDPressure: ${cond.message}`, name)
                    }
                }
            }
        } catch (_) { /* transient — next poll will retry */ }
        // No dispose — SSH connection is shared with event stream
    }

    // ── Pod health poller ──────────────────────────────────────────────────────
    async _pollPodHealth(cluster) {
        const stream = this.eventStreams.get(cluster.id)
        if (!stream?.ssh) return
        const ssh = stream.ssh

        try {
            const result = await ssh.execCommand('kubectl get pods -A -o json 2>/dev/null')
            if (result.code !== 0 || !result.stdout?.trim()) return

            const data = JSON.parse(result.stdout)
            for (const pod of (data.items || [])) {
                const podName = pod.metadata.name
                const ns      = pod.metadata.namespace

                for (const c of (pod.status?.containerStatuses || [])) {
                    const waiting = c.state?.waiting
                    if (!waiting) continue

                    if (waiting.reason === 'CrashLoopBackOff') {
                        this._createIncident(cluster, 'CrashLoopBackOff',
                            `${ns}/${podName} (${c.name}) is in CrashLoopBackOff`, podName)
                    }
                    if (waiting.reason === 'OOMKilled') {
                        this._createIncident(cluster, 'OOMKilled',
                            `${ns}/${podName} (${c.name}) was OOMKilled`, podName)
                    }
                    if (waiting.reason === 'ImagePullBackOff' || waiting.reason === 'ErrImagePull') {
                        this._createIncident(cluster, 'ImagePullBackOff',
                            `${ns}/${podName} (${c.name}) cannot pull image: ${waiting.message || ''}`, podName)
                    }
                }

                // Pod stuck Pending > 5 min
                if (pod.status?.phase === 'Pending') {
                    const age = Date.now() - new Date(pod.metadata.creationTimestamp).getTime()
                    if (age > 5 * 60 * 1000) {
                        this._createIncident(cluster, 'PodPendingTooLong',
                            `${ns}/${podName} has been Pending for ${Math.round(age / 60000)} minutes`, podName)
                    }
                }
            }
        } catch (_) { /* transient — next poll retries */ }
        // No dispose — SSH connection is shared with event stream
    }

    // ── Incident factory ───────────────────────────────────────────────────────
    _createIncident(cluster, reason, message, target) {
        const key = `${cluster.id}:${reason}:${target}`

        // Dedup — same issue within 5 min = same incident
        const recent = this.incidents.find(i =>
            i._key === key &&
            Date.now() - new Date(i.timestamp).getTime() < DEDUP_WINDOW_MS
        )
        if (recent) return

        const incident = {
            id:          `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            _key:        key,
            clusterId:   cluster.id,
            clusterName: cluster.name,
            orgId:       cluster.orgId,
            ownerId:     cluster.ownerId,
            reason,
            message,
            timestamp:   new Date().toISOString(),
            status:      'detecting',
            target:      target || 'cluster-wide'
        }

        console.log(`[AutoHealing] Incident detected — [${reason}] target=${target} cluster=${cluster.name}`)

        this.incidents.unshift(incident)

        // Keep last 200, expire older than 24h
        this.incidents = this.incidents
            .slice(0, 200)
            .filter(i => Date.now() - new Date(i.timestamp).getTime() < INCIDENT_TTL_MS)

        remediationEngine.handleAnomaly(
            cluster,
            { reason, message, involvedObject: { name: target } },
            incident
        )
    }

    updateIncidentStatus(incidentId, status, details) {
        const inc = this.incidents.find(i => i.id === incidentId)
        if (inc) {
            inc.status    = status
            inc.details   = details
            inc.updatedAt = new Date().toISOString()
        }
    }

    stopWatching(clusterId) {
        this._cleanup(clusterId)
        this.reconnectAttempts.delete(clusterId)
        console.log(`[AutoHealing] Stopped watching cluster ${clusterId}`)
    }
}

export const incidentDetector = new IncidentDetector()
