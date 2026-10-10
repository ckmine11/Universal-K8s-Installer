import { automationEngine } from './automationEngine.js'

// The SSH user may not be root / have its own kubeconfig — use the admin one
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl'

const MAX_RETRIES     = 3
const RETRY_DELAYS    = [0, 30_000, 60_000]  // immediate, 30s, 60s
const VERIFY_POLL_MS  = 15_000               // check every 15s after a fix
const VERIFY_ATTEMPTS = 4                    // up to 60s verification window
const COOLDOWN_MS     = 2 * 60 * 60 * 1000  // forget attempt counters after 2h

const detector = async () => (await import('./incidentDetector.js')).incidentDetector

/**
 * Runs the playbook for an incident. Two kinds of playbooks:
 *  - fix: change something (restart, clean up), then verify it worked, with
 *    retries and a circuit breaker
 *  - diagnose: collect evidence (describe, events, logs) and explain — the
 *    incident stays open for a person; it is never reported as "resolved"
 */
class RemediationEngine {
    constructor() {
        this.automationEngine = automationEngine
        this.activeIncidents  = new Map() // key -> { lastAttempt, retries }
    }

    _key(cluster, event) {
        const ns = event.involvedObject?.namespace
        return `${cluster.id}:${event.reason}:${ns ? ns + '/' : ''}${event.involvedObject?.name}`
    }

    /** Forget attempt counters ("Run fix now" starts fresh). */
    reset(incident) {
        this.activeIncidents.delete(`${incident.clusterId}:${incident.reason}:${incident.namespace ? incident.namespace + '/' : ''}${incident.target}`)
    }

    async handleAnomaly(cluster, event, incident, { force = false } = {}) {
        const key = this._key(cluster, event)
        const now = Date.now()
        for (const [k, v] of this.activeIncidents) if (now - v.lastAttempt > COOLDOWN_MS) this.activeIncidents.delete(k)

        const playbook = PLAYBOOKS[event.reason]
        if (!playbook) {
            await this._updateStatus(incident, 'unresolved', `No automated playbook for ${event.reason}`)
            return
        }
        const ctx = this._context(cluster, incident, event)

        if (playbook.diagnose) {
            try {
                const explanation = await playbook.diagnose(this.automationEngine, ctx.cluster, ctx.node, incident, this._evidence.bind(this))
                await this._updateStatus(incident, 'unresolved', explanation || 'Needs attention — see the suggestion')
            } catch (e) {
                await this._updateStatus(incident, 'unresolved', `Needs attention (diagnosis failed: ${e.message})`)
            }
            return
        }

        const state = this.activeIncidents.get(key) || { lastAttempt: 0, retries: 0 }
        // Circuit breaker — enforce the retry delay
        const retryDelay = RETRY_DELAYS[state.retries] ?? 60_000
        if (!force && state.retries > 0 && now - state.lastAttempt < retryDelay) return
        if (!force && state.retries >= MAX_RETRIES) {
            await this._updateStatus(incident, 'failed', `${MAX_RETRIES} automatic fixes did not help — needs a person (see the suggestion), or "Run fix now" to try again`)
            return
        }

        state.lastAttempt = now
        state.retries++
        this.activeIncidents.set(key, state)
        const attempt = state.retries
        console.log(`[AutoHealing] Playbook [${event.reason}] — attempt ${attempt}/${MAX_RETRIES} — cluster: ${cluster.clusterName || cluster.name || cluster.id}`)
        await this._updateStatus(incident, 'remediating', `${playbook.label} (attempt ${attempt}/${MAX_RETRIES})`)

        try {
            await playbook.fix(this.automationEngine, ctx.cluster, ctx.node, incident, this._updateStatus.bind(this), this._evidence.bind(this))
            await this._updateStatus(incident, 'remediating', 'Fix applied — verifying recovery…')
            const verified = await this._verify(playbook, ctx.cluster, ctx.node, incident)
            if (verified) {
                await this._updateStatus(incident, 'resolved', `${playbook.label} — confirmed healthy after ${attempt} attempt(s)`)
                this.activeIncidents.delete(key)
                console.log(`[AutoHealing] Resolved [${event.reason}] on ${cluster.clusterName || cluster.id}`)
            } else {
                await this._updateStatus(incident, 'remediating', 'Fix applied but not healthy yet — will retry if the problem persists')
            }
        } catch (err) {
            console.error(`[AutoHealing] Playbook error [${event.reason}]: ${err.message}`)
            await this._updateStatus(incident, 'remediating', `Attempt ${attempt} failed: ${err.message}${attempt < MAX_RETRIES ? ' — will retry' : ''}`)
        }
    }

    // Nodes carry ownerId/orgId so SSH routes through the Gateway Agent; the
    // target node is found by name/IP (control-plane problems fall back to the
    // first control-plane)
    _context(cluster, incident, event) {
        const enrich = (n) => n ? { ...n, ownerId: cluster.ownerId, orgId: cluster.orgId } : n
        const c = { ...cluster, masterNodes: (cluster.masterNodes || []).map(enrich), workerNodes: (cluster.workerNodes || []).map(enrich) }
        const all = [...c.masterNodes, ...c.workerNodes]
        const names = [incident.nodeName, incident.nodeIp, event.involvedObject?.name, String(event.involvedObject?.name || '').split('@')[1]].filter(Boolean).map(String)
        const matches = (n) => names.some(x => [n.ip, n.hostname, n.name].filter(Boolean).map(v => String(v).toLowerCase()).includes(x.toLowerCase()))
        let node = all.find(matches)
        if (!node && ['ControlPlaneDown', 'ControlPlaneDiskFull', 'CertExpiring', 'EtcdUnhealthy'].includes(incident.reason)) node = c.masterNodes[0]
        return { cluster: c, node }
    }

    async _verify(playbook, cluster, node, incident) {
        if (!playbook.verify) return true
        for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
            await new Promise(r => setTimeout(r, VERIFY_POLL_MS))
            try { if (await playbook.verify(this.automationEngine, cluster, node, incident)) return true } catch { /* still recovering */ }
        }
        return false
    }

    async _updateStatus(incident, status, details) {
        (await detector()).updateIncidentStatus(incident.id, status, details)
    }

    async _evidence(incident, title, text) {
        (await detector()).addEvidence(incident.id, title, text)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Playbooks — label + fix() + verify(), or diagnose() for problems that need a
// person (returns the explanation shown on the incident)
// ─────────────────────────────────────────────────────────────────────────────

// Names come from the Kubernetes API (DNS-1123), but they are interpolated into
// a shell — validate anyway
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
function ref(incident, name = incident.target) {
    const ns = incident.namespace || 'default'
    if (!K8S_NAME.test(name || '') || !K8S_NAME.test(ns)) throw new Error(`Refusing to act on invalid reference: ${ns}/${name}`)
    return `${name} -n ${ns}`
}
const podRef = (incident) => ref(incident)
// "deployment/web" → "deployment web -n ns"
function workloadRef(incident) {
    const [kind, name] = String(incident.target || '').split('/')
    if (!['deployment', 'statefulset', 'daemonset'].includes(kind)) throw new Error(`Unknown workload ${incident.target}`)
    return `${kind} ${ref(incident, name)}`
}

async function onMaster(engine, cluster, fn) {
    const master = cluster.masterNodes?.[0]
    if (!master) throw new Error('No control-plane node saved for this cluster')
    const ssh = await engine.connectSSH(master)
    try { return await fn(ssh) } finally { ssh.dispose?.() }
}
async function onNode(engine, node, fn) {
    if (!node) throw new Error('Target node not found in the cluster inventory')
    const ssh = await engine.connectSSH(node)
    try { return await fn(ssh) } finally { ssh.dispose?.() }
}
const out = (r) => `${r?.stdout || ''}${r?.stderr ? `\n${r.stderr}` : ''}`.trim()

// Disk cleanup used for node DiskPressure and a full control-plane disk
async function freeDisk(ssh) {
    await ssh.execCommand('sudo crictl rmi --prune 2>/dev/null || sudo docker image prune -a -f 2>/dev/null || true')
    await ssh.execCommand('sudo crictl rm $(sudo crictl ps -a -q --state=Exited) 2>/dev/null || true')
    await ssh.execCommand('sudo journalctl --vacuum-size=300M --vacuum-time=3d 2>/dev/null || true')
    await ssh.execCommand('sudo find /tmp -type f -mtime +1 -delete 2>/dev/null || true')
    // Empty (don't delete) big logs: deleting a file a service still has open
    // frees nothing and loses the application's log
    await ssh.execCommand('sudo find /var/log -name "*.log" -size +50M -exec truncate -s 0 {} + 2>/dev/null || true')
}
const diskBefore = new Map()   // incident id → disk % before the cleanup
const diskPct = async (ssh) => parseInt((await ssh.execCommand("df -P / | tail -1 | awk '{print $5}' | tr -d '%'")).stdout.trim(), 10)

const PLAYBOOKS = {
    // ── Node not reporting Ready ─────────────────────────────────────────────
    NodeNotReady: {
        label: 'Restart kubelet + containerd',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            await onNode(engine, node, async (ssh) => {
                await updateStatus(incident, 'remediating', `Restarting kubelet & containerd on ${node.ip}`)
                const log = await ssh.execCommand('sudo journalctl -u kubelet -n 30 --no-pager 2>/dev/null')
                await evidence(incident, 'kubelet log before the fix', out(log))
                await ssh.execCommand('sudo systemctl restart containerd 2>/dev/null || true')
                await ssh.execCommand('sudo systemctl restart kubelet')
                await ssh.execCommand('sudo systemctl enable --now kubelet 2>/dev/null || true')
            })
        },
        async verify(engine, cluster, node) {
            const nodeName = String(node?.hostname || node?.ip || '').toLowerCase()
            if (!K8S_NAME.test(nodeName)) return false
            return onMaster(engine, cluster, async (ssh) => (await ssh.execCommand(
                `${KUBECTL} get node ${nodeName} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null`)).stdout.trim() === 'True')
        }
    },

    // ── Disk full ────────────────────────────────────────────────────────────
    DiskPressure: {
        label: 'Prune images + clean logs + clear /tmp',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            await onNode(engine, node, async (ssh) => {
                await updateStatus(incident, 'remediating', `Freeing disk space on ${node.ip}`)
                const before = await diskPct(ssh)
                await freeDisk(ssh)
                await evidence(incident, 'Disk usage', `Before: ${before}% · after: ${await diskPct(ssh)}%`)
            })
        },
        async verify(engine, cluster, node) {
            return onNode(engine, node, async (ssh) => { const p = await diskPct(ssh); return !isNaN(p) && p < 85 })
        }
    },

    // ── RAM exhausted ────────────────────────────────────────────────────────
    MemoryPressure: {
        label: 'Drop page cache + restart container runtime',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            await onNode(engine, node, async (ssh) => {
                await updateStatus(incident, 'remediating', `Releasing memory on ${node.ip}`)
                await evidence(incident, 'Top memory users', out(await ssh.execCommand('ps -eo pid,comm,%mem --sort=-%mem | head -8')))
                await ssh.execCommand('sudo bash -c "sync && echo 1 > /proc/sys/vm/drop_caches" 2>/dev/null || true')
                await ssh.execCommand('sudo systemctl restart containerd 2>/dev/null || true')
                await ssh.execCommand('sudo systemctl restart kubelet')
            })
        },
        async verify(engine, cluster, node) {
            return onNode(engine, node, async (ssh) => {
                const freePct = parseInt((await ssh.execCommand("free | awk '/Mem:/ {printf \"%.0f\", ($7/$2)*100}'")).stdout.trim(), 10)
                return !isNaN(freePct) && freePct > 10
            })
        }
    },

    // ── Too many processes ───────────────────────────────────────────────────
    PIDPressure: {
        label: 'Kill zombie processes + restart kubelet',
        async fix(engine, cluster, node, incident, updateStatus) {
            await onNode(engine, node, async (ssh) => {
                await updateStatus(incident, 'remediating', `Cleaning zombie processes on ${node.ip}`)
                await ssh.execCommand("sudo kill -9 $(ps -A -ostat,ppid | awk '/[zZ]/{print $2}') 2>/dev/null || true")
                await ssh.execCommand("sudo pkill -f 'containerd-shim.*exited' 2>/dev/null || true")
                await ssh.execCommand('sudo systemctl restart kubelet')
            })
        },
        async verify(engine, cluster, node) {
            return onNode(engine, node, async (ssh) => {
                const z = parseInt((await ssh.execCommand("ps -A -ostat | grep -c '[zZ]' 2>/dev/null || echo 0")).stdout.trim(), 10)
                return !isNaN(z) && z < 5
            })
        }
    },

    // ── Control plane component not running ──────────────────────────────────
    ControlPlaneDown: {
        label: 'Restart kubelet on the control-plane',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            await onNode(engine, node, async (ssh) => {
                const comp = String(incident.target || '').split('@')[0]
                await updateStatus(incident, 'remediating', `Restarting kubelet on ${node.ip} (restarts ${comp || 'the control-plane components'})`)
                if (/^[a-z-]+$/.test(comp)) {
                    const id = (await ssh.execCommand(`sudo crictl ps -a --name '^${comp}$' -q 2>/dev/null | head -1`)).stdout.trim()
                    if (/^[a-f0-9]+$/.test(id)) await evidence(incident, `${comp} log`, out(await ssh.execCommand(`sudo crictl logs --tail 40 ${id} 2>&1`)))
                }
                await ssh.execCommand('sudo systemctl restart containerd 2>/dev/null || true')
                await ssh.execCommand('sudo systemctl restart kubelet')
            })
        },
        async verify(engine, cluster, node) {
            return onNode(engine, node, async (ssh) => (await ssh.execCommand(`${KUBECTL} get --raw=/readyz --request-timeout=5s 2>/dev/null`)).stdout.trim() === 'ok')
        }
    },

    // ── Control-plane disk filling up ────────────────────────────────────────
    ControlPlaneDiskFull: {
        label: 'Free disk space on the control-plane',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            await onNode(engine, node, async (ssh) => {
                await updateStatus(incident, 'remediating', `Freeing disk space on ${node.ip}`)
                await evidence(incident, 'Biggest folders', out(await ssh.execCommand('sudo du -xh --max-depth=2 /var 2>/dev/null | sort -rh | head -10')))
                const before = await diskPct(ssh)
                await freeDisk(ssh)
                await evidence(incident, 'Disk usage', `Before: ${before}% · after: ${await diskPct(ssh)}%`)
            })
        },
        async verify(engine, cluster, node) {
            return onNode(engine, node, async (ssh) => { const p = await diskPct(ssh); return !isNaN(p) && p < 85 })
        }
    },

    // ── Certificates about to expire (manual by default) ─────────────────────
    CertExpiring: {
        label: 'Renew control-plane certificates',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            for (const cp of cluster.masterNodes || []) {
                await onNode(engine, cp, async (ssh) => {
                    await updateStatus(incident, 'remediating', `Renewing certificates on ${cp.ip}`)
                    const r = await ssh.execCommand('sudo kubeadm certs renew all 2>&1')
                    if (r.code !== 0) throw new Error(`kubeadm certs renew failed on ${cp.ip}: ${out(r).slice(-200)}`)
                    // the components only read certificates at start
                    await ssh.execCommand("for c in kube-apiserver kube-controller-manager kube-scheduler etcd; do sudo crictl ps --name \"^$c$\" -q | xargs -r sudo crictl stop >/dev/null 2>&1; done")
                    await ssh.execCommand('sudo cp -f /etc/kubernetes/admin.conf $HOME/.kube/config 2>/dev/null || true')
                    await evidence(incident, `Renewed on ${cp.ip}`, out(r).slice(-1500))
                })
            }
        },
        async verify(engine, cluster) {
            return onMaster(engine, cluster, async (ssh) => {
                if ((await ssh.execCommand(`${KUBECTL} get --raw=/readyz --request-timeout=5s 2>/dev/null`)).stdout.trim() !== 'ok') return false
                const r = await ssh.execCommand('sudo kubeadm certs check-expiration 2>/dev/null')
                return !/<invalid>|\s([0-9]|[12][0-9])d\s/.test(r.stdout || '')
            })
        }
    },

    // ── Pod restarting repeatedly ────────────────────────────────────────────
    CrashLoopBackOff: {
        label: 'Save logs + delete the pod (its controller starts a fresh one)',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            await onMaster(engine, cluster, async (ssh) => {
                const pod = podRef(incident)
                await updateStatus(incident, 'remediating', `Saving crash logs of ${incident.target}`)
                const logs = await ssh.execCommand(`${KUBECTL} logs ${pod} --all-containers --tail=60 --previous 2>/dev/null || ${KUBECTL} logs ${pod} --all-containers --tail=60 2>/dev/null || echo "No logs available"`)
                await evidence(incident, 'Logs of the crashed container', out(logs))
                const owned = (await ssh.execCommand(`${KUBECTL} get pod ${pod} -o jsonpath='{.metadata.ownerReferences[0].kind}' 2>/dev/null`)).stdout.trim()
                if (!owned) {
                    // A bare pod has no controller: deleting it would delete the app
                    throw new Error('This pod has no controller (Deployment, StatefulSet…) — deleting it would remove it for good, so it is left as is')
                }
                await updateStatus(incident, 'remediating', `Deleting ${incident.target} — ${owned} starts a fresh one`)
                const del = await ssh.execCommand(`${KUBECTL} delete pod ${pod} --grace-period=30`)
                if (del.code !== 0) throw new Error(`Deleting the pod failed: ${out(del).slice(0, 200)}`)
            })
        },
        async verify() { return true }   // the controller recreates it; a new crash loop opens a new incident
    },

    // ── Disk will be full soon (forecast): clean up before it is ──────────────
    // "Fixed" = the cleanup freed real space (≥ 2% of the disk); the forecast
    // then starts over and warns again only if the disk keeps filling.
    NodeDiskFilling: {
        label: 'Free disk space before the disk is full',
        async fix(engine, cluster, node, incident, updateStatus, evidence) {
            await onNode(engine, node, async (ssh) => {
                await updateStatus(incident, 'remediating', `Freeing disk space on ${node.ip}`)
                await evidence(incident, 'Biggest folders', out(await ssh.execCommand('sudo du -xh --max-depth=2 /var 2>/dev/null | sort -rh | head -10')))
                const before = await diskPct(ssh)
                await freeDisk(ssh)
                const after = await diskPct(ssh)
                diskBefore.set(incident.id, before)
                await evidence(incident, 'Disk usage', `Before: ${before}% · after: ${after}%`)
            })
        },
        async verify(engine, cluster, node, incident) {
            const before = diskBefore.get(incident.id)
            return onNode(engine, node, async (ssh) => { const p = await diskPct(ssh); return !isNaN(p) && before != null && before - p >= 2 })
        }
    },

    // ── Diagnose only: a person decides ──────────────────────────────────────
    NodeMemoryHigh: {
        async diagnose(engine, cluster, node, incident, evidence) {
            if (node) await onNode(engine, node, async (ssh) => evidence(incident, 'Top processes by memory', out(await ssh.execCommand('ps -eo pid,comm,%mem,rss --sort=-%mem | head -10; echo; free -m'))))
            return `${incident.message}. Set memory limits on these workloads, scale them out, or add memory / a node.`
        }
    },
    NodeCPUHigh: {
        async diagnose(engine, cluster, node, incident, evidence) {
            if (node) await onNode(engine, node, async (ssh) => evidence(incident, 'Top processes by CPU', out(await ssh.execCommand('ps -eo pid,comm,%cpu --sort=-%cpu | head -10; echo; uptime'))))
            return `${incident.message}. Set CPU limits, scale the workload out, or add a node.`
        }
    },
    OOMKilled: {
        async diagnose(engine, cluster, node, incident, evidence) {
            return onMaster(engine, cluster, async (ssh) => {
                const lim = await ssh.execCommand(`${KUBECTL} get pod ${podRef(incident)} -o jsonpath='{range .spec.containers[*]}{.name}: limit {.resources.limits.memory}, request {.resources.requests.memory}{"\\n"}{end}' 2>/dev/null`)
                await evidence(incident, 'Memory settings', out(lim) || 'No memory limits set')
                return `${incident.target} was killed for using too much memory. Raise its memory limit or reduce its usage.`
            })
        }
    },
    ImagePullBackOff: {
        async diagnose(engine, cluster, node, incident, evidence) {
            return onMaster(engine, cluster, async (ssh) => {
                const [name, , ns] = ref(incident).split(' ')
                const ev = await ssh.execCommand(`${KUBECTL} get events -n ${ns} --field-selector involvedObject.name=${name} --sort-by=.lastTimestamp 2>/dev/null | tail -6`)
                await evidence(incident, 'Pod events', out(ev))
                const msg = (out(ev).match(/(not found|unauthorized|denied|no such host|i\/o timeout|manifest unknown)[^\n]*/i) || [])[0]
                return `Image pull failed for ${incident.target}${msg ? ` — ${msg.slice(0, 160)}` : ''}. Check the image name/tag, registry access and imagePullSecrets.`
            })
        }
    },
    PodPendingTooLong: {
        async diagnose(engine, cluster, node, incident, evidence) {
            return onMaster(engine, cluster, async (ssh) => {
                const desc = await ssh.execCommand(`${KUBECTL} describe pod ${podRef(incident)} 2>/dev/null | sed -n '/Events:/,$p' | tail -8`)
                await evidence(incident, 'Scheduler events', out(desc))
                const why = (out(desc).match(/(\d+\/\d+ nodes are available[^\n]*|Insufficient [a-z]+[^\n]*|untolerated taint[^\n]*|unbound immediate PersistentVolumeClaims[^\n]*)/i) || [])[0]
                return `${incident.target} cannot be scheduled${why ? ` — ${why.slice(0, 200)}` : ''}.`
            })
        }
    },
    WorkloadUnavailable: {
        async diagnose(engine, cluster, node, incident, evidence) {
            return onMaster(engine, cluster, async (ssh) => {
                const w = workloadRef(incident)
                const desc = await ssh.execCommand(`${KUBECTL} describe ${w} 2>/dev/null | sed -n '/Conditions:/,$p' | tail -14`)
                await evidence(incident, 'Workload status', out(desc))
                return `${incident.message}. Its pods' incidents (crash loop, image, pending) usually show the cause.`
            })
        }
    },
    PVCPending: {
        async diagnose(engine, cluster, node, incident, evidence) {
            return onMaster(engine, cluster, async (ssh) => {
                const desc = await ssh.execCommand(`${KUBECTL} describe pvc ${ref(incident)} 2>/dev/null | sed -n '/Events:/,$p' | tail -6`)
                const sc = await ssh.execCommand(`${KUBECTL} get storageclass 2>/dev/null`)
                await evidence(incident, 'Claim events', out(desc))
                await evidence(incident, 'Storage classes', out(sc) || 'No StorageClass exists — install the Longhorn add-on or another provisioner')
                return /No resources found/i.test(out(sc)) || !out(sc) ? 'No StorageClass exists in the cluster — install the Longhorn add-on (or another provisioner).' : `${incident.message}. See the claim events.`
            })
        }
    },
    JobFailed: {
        async diagnose(engine, cluster, node, incident, evidence) {
            return onMaster(engine, cluster, async (ssh) => {
                const logs = await ssh.execCommand(`${KUBECTL} logs job/${ref(incident)} --tail=40 2>&1`)
                await evidence(incident, 'Job logs', out(logs))
                return `${incident.message}. See the job's logs.`
            })
        }
    },
    ClusterUnreachable: {
        async diagnose(engine, cluster, node, incident) {
            return `Cannot connect to ${incident.target} over SSH (${incident.message}). Check the machine, the network and — if used — the Gateway Agent.`
        }
    },
    EtcdUnhealthy: {
        async diagnose(engine, cluster, node, incident, evidence) {
            return onMaster(engine, cluster, async (ssh) => {
                const id = (await ssh.execCommand("sudo crictl ps -a --name '^etcd$' -q 2>/dev/null | head -1")).stdout.trim()
                if (/^[a-f0-9]+$/.test(id)) await evidence(incident, 'etcd log', out(await ssh.execCommand(`sudo crictl logs --tail 40 ${id} 2>&1`)))
                await evidence(incident, 'Disk', out(await ssh.execCommand('df -h /var/lib/etcd 2>/dev/null')))
                return 'etcd reports unhealthy. Check its log and disk below; take a snapshot as soon as it is healthy again.'
            })
        }
    }
}

export const remediationEngine = new RemediationEngine()
export { PLAYBOOKS }
