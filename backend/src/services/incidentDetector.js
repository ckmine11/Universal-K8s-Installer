import { clusterStore } from './clusterStore.js'
import { automationEngine } from './automationEngine.js'
import { remediationEngine } from './remediationEngine.js'

const NODE_POLL_INTERVAL  = 60 * 1000       // 60s — node conditions
const POD_POLL_INTERVAL   = 90 * 1000       // 90s — pod states
const RECONNECT_BASE_MS   = 10 * 1000
const RECONNECT_MAX_MS    = 5 * 60 * 1000
const INCIDENT_TTL_MS     = 24 * 60 * 60 * 1000
const DEDUP_WINDOW_MS     = 5 * 60 * 1000     // don't re-create the same incident within 5min
const MAX_POLL_FAILURES   = 3                 // consecutive failures before reconnect

const cname = (c) => c.clusterName || c.name || 'cluster'

/**
 * Detects cluster anomalies via lightweight polling (events, nodes, pods) over
 * a single reused SSH connection — routed through a Gateway Agent when present.
 * Polling (not a long-lived `kubectl --watch`) is used deliberately: it works
 * identically over direct SSH and agent relays, and can't silently die.
 */
class IncidentDetector {
    constructor() {
        this.automationEngine = automationEngine
        this.streams   = new Map()   // clusterId -> { ssh, timers:[], failCount, cluster }
        this.reconnect = new Map()   // clusterId -> attempt count
        this.incidents = []
    }

    getIncidents() { return this.incidents }

    async init() {
        console.log('[AutoHealing] Initializing Auto-Healing Engine...')
        try {
            const clusters = await clusterStore.getClusters()
            for (const cluster of clusters) {
                if (cluster.status === 'healthy') this.startWatching(cluster)
            }
        } catch (e) {
            console.error('[AutoHealing] init failed:', e.message)
        }
    }

    // Called when a cluster finishes installing/resuming so it's watched immediately
    watchCluster(cluster) {
        if (!cluster?.id) return
        this.startWatching(cluster)
    }

    async startWatching(cluster) {
        if (!cluster?.id) return
        if (this.streams.has(cluster.id)) return // already watching

        const master = cluster.masterNodes?.[0]
        if (!master) return

        // Ensure Gateway-Agent routing works — connectSSH needs ownerId/orgId on the node
        const node = { ...master, ownerId: cluster.ownerId, orgId: cluster.orgId }

        const attempt = this.reconnect.get(cluster.id) || 0
        console.log(`[AutoHealing] Connecting to ${cname(cluster)} (attempt ${attempt + 1})`)

        let ssh
        try {
            ssh = await this.automationEngine.connectSSH(node)
        } catch (err) {
            console.error(`[AutoHealing] Connect failed for ${cname(cluster)}: ${err.message}`)
            return this._scheduleReconnect(cluster)
        }

        this.reconnect.set(cluster.id, 0)
        const stream = { ssh, timers: [], failCount: 0, cluster }
        this.streams.set(cluster.id, stream)

        // Schedule structured pollers (node + pod). We intentionally do NOT poll
        // raw cluster events — a single node-down produces dozens of warning
        // events (node + every pod on it), which floods incidents/notifications.
        // Node & pod pollers give clean, de-duplicated, actionable signals.
        stream.timers.push(setInterval(() => this._pollNodes(cluster), NODE_POLL_INTERVAL))
        stream.timers.push(setInterval(() => this._pollPods(cluster),  POD_POLL_INTERVAL))

        // Run immediately so we don't wait a full interval on first watch
        this._pollNodes(cluster)
        this._pollPods(cluster)

        console.log(`[AutoHealing] Watching ${cname(cluster)} — node/pod pollers active`)
    }

    _scheduleReconnect(cluster) {
        this._cleanup(cluster.id)
        const attempt = this.reconnect.get(cluster.id) || 0
        this.reconnect.set(cluster.id, attempt + 1)
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS)
        console.log(`[AutoHealing] Reconnecting to ${cname(cluster)} in ${Math.round(delay / 1000)}s`)
        setTimeout(() => this.startWatching(cluster), delay)
    }

    _cleanup(clusterId) {
        const stream = this.streams.get(clusterId)
        if (stream) {
            stream.timers.forEach(t => clearInterval(t))
            try { stream.ssh?.dispose?.() } catch (_) {}
            this.streams.delete(clusterId)
        }
    }

    // Run a poll against the shared SSH; reconnect after repeated failures
    async _run(cluster, fn) {
        const stream = this.streams.get(cluster.id)
        if (!stream?.ssh) return null
        try {
            const out = await fn(stream.ssh)
            stream.failCount = 0
            return out
        } catch (e) {
            stream.failCount++
            if (stream.failCount >= MAX_POLL_FAILURES) {
                console.warn(`[AutoHealing] ${cname(cluster)} SSH unhealthy (${stream.failCount}x) — reconnecting`)
                this._scheduleReconnect(cluster)
            }
            return null
        }
    }

    // ── Node poller ──────────────────────────────────────────────────────────
    async _pollNodes(cluster) {
        const result = await this._run(cluster, ssh =>
            ssh.execCommand('kubectl get nodes -o json 2>/dev/null'))
        if (!result || result.code !== 0 || !result.stdout?.trim()) return

        let data
        try { data = JSON.parse(result.stdout) } catch { return }

        for (const n of (data.items || [])) {
            const name = n.metadata?.name
            for (const cond of (n.status?.conditions || [])) {
                if (cond.type === 'Ready' && cond.status !== 'True')
                    this._createIncident(cluster, 'NodeNotReady', `Node ${name} not Ready: ${cond.message}`, name)
                if (cond.type === 'DiskPressure' && cond.status === 'True')
                    this._createIncident(cluster, 'DiskPressure', `Node ${name} DiskPressure: ${cond.message}`, name)
                if (cond.type === 'MemoryPressure' && cond.status === 'True')
                    this._createIncident(cluster, 'MemoryPressure', `Node ${name} MemoryPressure: ${cond.message}`, name)
                if (cond.type === 'PIDPressure' && cond.status === 'True')
                    this._createIncident(cluster, 'PIDPressure', `Node ${name} PIDPressure: ${cond.message}`, name)
            }
        }
    }

    // ── Pod poller ───────────────────────────────────────────────────────────
    async _pollPods(cluster) {
        const result = await this._run(cluster, ssh =>
            ssh.execCommand('kubectl get pods -A -o json 2>/dev/null'))
        if (!result || result.code !== 0 || !result.stdout?.trim()) return

        let data
        try { data = JSON.parse(result.stdout) } catch { return }

        for (const pod of (data.items || [])) {
            const podName = pod.metadata?.name
            const ns = pod.metadata?.namespace
            for (const c of (pod.status?.containerStatuses || [])) {
                const w = c.state?.waiting
                const t = c.state?.terminated
                if (w?.reason === 'CrashLoopBackOff')
                    this._createIncident(cluster, 'CrashLoopBackOff', `${ns}/${podName} (${c.name}) in CrashLoopBackOff`, podName, ns)
                if (w?.reason === 'ImagePullBackOff' || w?.reason === 'ErrImagePull')
                    this._createIncident(cluster, 'ImagePullBackOff', `${ns}/${podName} (${c.name}) cannot pull image: ${w.message || ''}`, podName, ns)
                if (t?.reason === 'OOMKilled' || w?.reason === 'OOMKilled')
                    this._createIncident(cluster, 'OOMKilled', `${ns}/${podName} (${c.name}) was OOMKilled`, podName, ns)
            }
            if (pod.status?.phase === 'Pending' && pod.metadata?.creationTimestamp) {
                const age = Date.now() - new Date(pod.metadata.creationTimestamp).getTime()
                if (age > 5 * 60 * 1000)
                    this._createIncident(cluster, 'PodPendingTooLong', `${ns}/${podName} Pending for ${Math.round(age / 60000)}m`, podName, ns)
            }
        }
    }

    // ── Incident factory ───────────────────────────────────────────────────────
    // namespace is set for pod-level incidents (pods are namespaced; kubectl
    // cannot address a pod by name across all namespaces).
    _createIncident(cluster, reason, message, target, namespace) {
        if (!reason) return
        const key = `${cluster.id}:${reason}:${namespace ? namespace + '/' : ''}${target}`

        const recent = this.incidents.find(i =>
            i._key === key && Date.now() - new Date(i.timestamp).getTime() < DEDUP_WINDOW_MS)
        if (recent) return

        const incident = {
            id:          `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            _key:        key,
            clusterId:   cluster.id,
            clusterName: cname(cluster),
            orgId:       cluster.orgId,
            ownerId:     cluster.ownerId,
            reason,
            message:     message || '',
            timestamp:   new Date().toISOString(),
            status:      'detecting',
            target:      target || 'cluster-wide',
            namespace:   namespace || null
        }

        console.log(`[AutoHealing] Incident — [${reason}] target=${target} cluster=${cname(cluster)}`)

        this.incidents.unshift(incident)
        this.incidents = this.incidents
            .slice(0, 200)
            .filter(i => Date.now() - new Date(i.timestamp).getTime() < INCIDENT_TTL_MS)

        // Dispatch to remediation — never let a failure here break detection
        try {
            remediationEngine.handleAnomaly(
                cluster,
                { reason, message, involvedObject: { name: target, namespace } },
                incident
            )
        } catch (e) {
            console.error(`[AutoHealing] Remediation dispatch failed: ${e.message}`)
        }
    }

    updateIncidentStatus(incidentId, status, details) {
        const inc = this.incidents.find(i => i.id === incidentId)
        if (inc) {
            inc.status = status
            inc.details = details
            inc.updatedAt = new Date().toISOString()
        }
    }

    stopWatching(clusterId) {
        this._cleanup(clusterId)
        this.reconnect.delete(clusterId)
        console.log(`[AutoHealing] Stopped watching cluster ${clusterId}`)
    }
}

export const incidentDetector = new IncidentDetector()
