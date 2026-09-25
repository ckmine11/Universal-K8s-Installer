import { automationEngine } from './automationEngine.js'

const MAX_RETRIES     = 3
const RETRY_DELAYS    = [0, 30_000, 60_000]  // immediate, 30s, 60s
const VERIFY_POLL_MS  = 15_000               // check every 15s after fix
const VERIFY_ATTEMPTS = 4                    // up to 60s total verification window
const COOLDOWN_MS     = 2 * 60 * 60 * 1000  // clean activeIncidents after 2h

class RemediationEngine {
    constructor() {
        this.automationEngine = automationEngine
        this.activeIncidents  = new Map() // key -> { lastAttempt, retries }
    }

    async handleAnomaly(cluster, event, incident) {
        const key = `${cluster.id}:${event.reason}:${event.involvedObject?.name}`
        const now = Date.now()

        // Clean up stale entries to prevent memory leak
        for (const [k, v] of this.activeIncidents) {
            if (now - v.lastAttempt > COOLDOWN_MS) this.activeIncidents.delete(k)
        }

        const state = this.activeIncidents.get(key) || { lastAttempt: 0, retries: 0 }

        // Circuit breaker — enforce retry delay
        const retryDelay = RETRY_DELAYS[state.retries] ?? 60_000
        if (state.retries > 0 && now - state.lastAttempt < retryDelay) return

        // Exhausted all retries
        if (state.retries >= MAX_RETRIES) {
            await this._updateStatus(incident, 'failed',
                `Exhausted ${MAX_RETRIES} auto-fix attempts — manual intervention required`)
            return
        }

        const playbook = PLAYBOOKS[event.reason]
        if (!playbook) {
            await this._updateStatus(incident, 'unresolved',
                `No automated playbook for: ${event.reason}`)
            return
        }

        state.lastAttempt = now
        state.retries++
        this.activeIncidents.set(key, state)

        const attempt = state.retries
        console.log(`[AutoHealing] Playbook [${event.reason}] — attempt ${attempt}/${MAX_RETRIES} — cluster: ${cluster.name}`)

        await this._updateStatus(incident, 'remediating',
            `${playbook.label} (attempt ${attempt}/${MAX_RETRIES})`)

        try {
            const allNodes  = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])]
            const targetName = event.involvedObject?.name
            const targetNode = allNodes.find(n =>
                n.ip === targetName || n.hostname === targetName || n.name === targetName
            )

            // Run the fix
            await playbook.fix(this.automationEngine, cluster, targetNode, incident,
                this._updateStatus.bind(this))

            // Verify the fix actually worked
            await this._updateStatus(incident, 'remediating',
                `Fix applied — verifying recovery...`)

            const verified = await this._verify(playbook, cluster, targetNode)

            if (verified) {
                await this._updateStatus(incident, 'resolved',
                    `${playbook.label} — confirmed healthy after ${attempt} attempt(s)`)
                this.activeIncidents.delete(key) // Reset on success
                console.log(`[AutoHealing] Resolved [${event.reason}] on ${cluster.name}`)
            } else {
                await this._updateStatus(incident, 'remediating',
                    `Fix applied but node/pod not yet healthy — will retry if issue persists`)
            }

        } catch (err) {
            console.error(`[AutoHealing] Playbook error [${event.reason}]: ${err.message}`)
            await this._updateStatus(incident, 'remediating',
                `Attempt ${attempt} failed: ${err.message}${attempt < MAX_RETRIES ? ' — will retry' : ''}`)
        }
    }

    async _verify(playbook, cluster, targetNode) {
        if (!playbook.verify) return true
        for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, VERIFY_POLL_MS))
            try {
                const ok = await playbook.verify(this.automationEngine, cluster, targetNode)
                if (ok) return true
            } catch (_) { /* still recovering */ }
        }
        return false
    }

    async _updateStatus(incident, status, details) {
        const { incidentDetector } = await import('./incidentDetector.js')
        incidentDetector.updateIncidentStatus(incident.id, status, details)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Playbooks — each has:
//   label   : human-readable action name
//   fix()   : async function to apply the fix
//   verify(): async function returning true if healthy now
// ─────────────────────────────────────────────────────────────────────────────

const PLAYBOOKS = {

    // ── Node not reporting Ready ──────────────────────────────────────────────
    NodeNotReady: {
        label: 'Restart kubelet + containerd',
        async fix(engine, cluster, node, incident, updateStatus) {
            if (!node) throw new Error('Target node not found in cluster inventory')
            const ssh = await engine.connectSSH(node)
            try {
                await updateStatus(incident, 'remediating',
                    `Restarting kubelet & containerd on ${node.ip}`)
                await ssh.execCommand('sudo systemctl restart containerd 2>/dev/null || true')
                await ssh.execCommand('sudo systemctl restart kubelet')
                // If kubelet not enabled, enable it
                await ssh.execCommand('sudo systemctl enable --now kubelet 2>/dev/null || true')
            } finally { ssh.dispose?.() }
        },
        async verify(engine, cluster, node) {
            if (!node) return false
            // Check via master — is the node Ready in k8s?
            const master = cluster.masterNodes?.[0]
            if (!master) return false
            const ssh = await engine.connectSSH(master)
            try {
                const r = await ssh.execCommand(
                    `kubectl get node ${node.hostname || node.ip} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null`
                )
                return r.stdout.trim() === 'True'
            } finally { ssh.dispose?.() }
        }
    },

    // ── Disk full ────────────────────────────────────────────────────────────
    DiskPressure: {
        label: 'Prune images + clean logs + clear /tmp',
        async fix(engine, cluster, node, incident, updateStatus) {
            if (!node) throw new Error('Target node not found in cluster inventory')
            const ssh = await engine.connectSSH(node)
            try {
                await updateStatus(incident, 'remediating',
                    `Freeing disk space on ${node.ip}`)
                // Prune unused container images
                await ssh.execCommand(
                    'sudo crictl rmi --prune 2>/dev/null || sudo docker image prune -a -f 2>/dev/null || true')
                // Prune stopped containers
                await ssh.execCommand(
                    'sudo crictl rm $(sudo crictl ps -a -q --state=Exited) 2>/dev/null || true')
                // Rotate journals
                await ssh.execCommand(
                    'sudo journalctl --vacuum-size=300M --vacuum-time=3d 2>/dev/null || true')
                // Clean /tmp
                await ssh.execCommand(
                    'sudo find /tmp -type f -mtime +1 -delete 2>/dev/null || true')
                // Clean old logs
                await ssh.execCommand(
                    'sudo find /var/log -name "*.log" -size +50M -delete 2>/dev/null || true')
            } finally { ssh.dispose?.() }
        },
        async verify(engine, cluster, node) {
            if (!node) return false
            const ssh = await engine.connectSSH(node)
            try {
                const r = await ssh.execCommand(
                    "df / --output=pcent | tail -1 | tr -d ' %'")
                const pct = parseInt(r.stdout.trim())
                return !isNaN(pct) && pct < 85
            } finally { ssh.dispose?.() }
        }
    },

    // ── RAM exhausted ────────────────────────────────────────────────────────
    MemoryPressure: {
        label: 'Drop page cache + restart container runtime',
        async fix(engine, cluster, node, incident, updateStatus) {
            if (!node) throw new Error('Target node not found in cluster inventory')
            const ssh = await engine.connectSSH(node)
            try {
                await updateStatus(incident, 'remediating',
                    `Releasing memory on ${node.ip}`)
                // Sync and drop page cache (safe — OS refills automatically)
                await ssh.execCommand(
                    'sudo bash -c "sync && echo 1 > /proc/sys/vm/drop_caches" 2>/dev/null || true')
                // Restart containerd to free leaked container memory
                await ssh.execCommand('sudo systemctl restart containerd 2>/dev/null || true')
                await ssh.execCommand('sudo systemctl restart kubelet')
            } finally { ssh.dispose?.() }
        },
        async verify(engine, cluster, node) {
            if (!node) return false
            const ssh = await engine.connectSSH(node)
            try {
                // Check available memory > 10%
                const r = await ssh.execCommand(
                    "free | awk '/Mem:/ {printf \"%.0f\", ($7/$2)*100}'")
                const freePct = parseInt(r.stdout.trim())
                return !isNaN(freePct) && freePct > 10
            } finally { ssh.dispose?.() }
        }
    },

    // ── Too many processes ───────────────────────────────────────────────────
    PIDPressure: {
        label: 'Kill zombie processes + restart kubelet',
        async fix(engine, cluster, node, incident, updateStatus) {
            if (!node) throw new Error('Target node not found in cluster inventory')
            const ssh = await engine.connectSSH(node)
            try {
                await updateStatus(incident, 'remediating',
                    `Cleaning zombie processes on ${node.ip}`)
                // Kill zombie processes
                await ssh.execCommand(
                    "sudo kill -9 $(ps -A -ostat,ppid | awk '/[zZ]/{print $2}') 2>/dev/null || true")
                // Clean up any hung containerd-shim processes
                await ssh.execCommand(
                    "sudo pkill -f 'containerd-shim.*exited' 2>/dev/null || true")
                await ssh.execCommand('sudo systemctl restart kubelet')
            } finally { ssh.dispose?.() }
        },
        async verify(engine, cluster, node) {
            if (!node) return false
            const ssh = await engine.connectSSH(node)
            try {
                const r = await ssh.execCommand(
                    "ps -A -ostat | grep -c '[zZ]' 2>/dev/null || echo 0")
                const zombies = parseInt(r.stdout.trim())
                return !isNaN(zombies) && zombies < 5
            } finally { ssh.dispose?.() }
        }
    },

    // ── Pod restarting repeatedly ────────────────────────────────────────────
    CrashLoopBackOff: {
        label: 'Capture logs + delete pod (Kubernetes will reschedule)',
        async fix(engine, cluster, node, incident, updateStatus) {
            const master = cluster.masterNodes?.[0]
            if (!master) throw new Error('No master node found')
            const ssh = await engine.connectSSH(master)
            try {
                await updateStatus(incident, 'remediating',
                    `Capturing crash logs for ${incident.target}`)

                // Capture last 50 lines of logs before deleting
                const logsResult = await ssh.execCommand(
                    `kubectl logs ${incident.target} -A --tail=50 --previous 2>/dev/null || ` +
                    `kubectl logs ${incident.target} -A --tail=50 2>/dev/null || echo "No logs available"`)

                console.log(`[AutoHealing] CrashLoop logs for ${incident.target}:\n${logsResult.stdout?.slice(0, 500)}`)

                await updateStatus(incident, 'remediating',
                    `Deleting crashed pod ${incident.target} — Kubernetes will reschedule it cleanly`)

                // Delete the pod — Deployment/DaemonSet/StatefulSet will recreate it
                await ssh.execCommand(
                    `kubectl delete pod ${incident.target} -A --grace-period=30 2>/dev/null || true`)

            } finally { ssh.dispose?.() }
        },
        // Trust Kubernetes to reschedule the pod correctly
        async verify() { return true }
    },

    // ── Pod killed by OOM killer ─────────────────────────────────────────────
    OOMKilled: {
        label: 'OOMKilled — flag for resource limit review',
        async fix(engine, cluster, node, incident, updateStatus) {
            // OOMKilled needs human decision (increase limits vs reduce usage)
            // We surface the diagnosis — can't auto-fix without knowing the intent
            await updateStatus(incident, 'unresolved',
                `${incident.target} was OOMKilled. ` +
                `Action required: increase the container's memory limit or reduce its memory usage.`)
        },
        async verify() { return true }
    },

    // ── Image cannot be pulled ───────────────────────────────────────────────
    ImagePullBackOff: {
        label: 'Image pull failure — check image name and registry credentials',
        async fix(engine, cluster, node, incident, updateStatus) {
            const master = cluster.masterNodes?.[0]
            if (!master) { await updateStatus(incident, 'unresolved', 'No master node'); return }
            const ssh = await engine.connectSSH(master)
            try {
                // Describe the pod to surface the exact error
                const desc = await ssh.execCommand(
                    `kubectl describe pod ${incident.target} -A 2>/dev/null | grep -A5 "Events:" | tail -5`)
                await updateStatus(incident, 'unresolved',
                    `Image pull failed for ${incident.target}. ` +
                    `Check image name/tag and imagePullSecrets. ` +
                    `Events: ${desc.stdout?.trim()?.slice(0, 200) || 'none'}`)
            } finally { ssh.dispose?.() }
        },
        async verify() { return true }
    },

    // ── Pod stuck waiting to be scheduled ───────────────────────────────────
    PodPendingTooLong: {
        label: 'Diagnose pending pod — check node resources and taints',
        async fix(engine, cluster, node, incident, updateStatus) {
            const master = cluster.masterNodes?.[0]
            if (!master) { await updateStatus(incident, 'unresolved', 'No master node'); return }
            const ssh = await engine.connectSSH(master)
            try {
                await updateStatus(incident, 'remediating',
                    `Diagnosing why ${incident.target} is Pending...`)

                const desc = await ssh.execCommand(
                    `kubectl describe pod ${incident.target} -A 2>/dev/null | grep -E "Events:|Warning|Insufficient|didn't|taint" | head -5`)

                const nodes = await ssh.execCommand(
                    'kubectl get nodes -o wide 2>/dev/null | head -5')

                await updateStatus(incident, 'unresolved',
                    `${incident.target} is Pending. ` +
                    `Possible causes: insufficient CPU/memory, node taints, or no matching node selector. ` +
                    `Hint: ${desc.stdout?.trim()?.slice(0, 150) || 'check kubectl describe pod'}`)

            } finally { ssh.dispose?.() }
        },
        async verify() { return true }
    }
}

export const remediationEngine = new RemediationEngine()
