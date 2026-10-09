import fs from 'fs'
import path from 'path'
import { clusterStore } from './clusterStore.js'
import { automationEngine } from './automationEngine.js'
import { remediationEngine } from './remediationEngine.js'
import { healingPolicyStore } from './healingPolicyStore.js'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomic } from '../utils/atomicWrite.js'
import { notifier } from './notifier.js'
import { CATALOG, label } from '../config/incidentCatalog.js'

const alertTarget = (inc) => inc.namespace ? `${inc.namespace}/${inc.target}` : inc.target

const NODE_POLL_INTERVAL   = 60 * 1000        // node conditions
const POD_POLL_INTERVAL    = 90 * 1000        // pod states
const HEALTH_POLL_INTERVAL = 2 * 60 * 1000    // control plane, etcd, certs, disk, workloads, PVCs, jobs
const RECONNECT_BASE_MS    = 10 * 1000
const RECONNECT_MAX_MS     = 5 * 60 * 1000
const INCIDENT_TTL_MS      = 7 * 24 * 60 * 60 * 1000   // a week of history (stats, MTTR)
const DEDUP_WINDOW_MS      = 5 * 60 * 1000              // re-run a playbook at most every 5 min
const MAX_POLL_FAILURES    = 3
const MAX_INCIDENTS        = 500
const PERSIST_MS           = 5 * 60 * 1000              // workloads / PVCs must be unhealthy this long
const CP_GRACE_MS          = 2 * 60 * 1000              // a control-plane pod restarting briefly is normal
const CERT_WARN_DAYS       = 30
const CERT_CRIT_DAYS       = 7
const DISK_WARN_PCT        = 90
const DISK_CRIT_PCT        = 95
const JOB_WINDOW_MS        = 6 * 60 * 60 * 1000
const TIMELINE_MAX         = 40
const INCIDENTS_FILE       = path.join(DATA_DIR, 'incidents.json')

// The SSH user may not be root and may have no kubeconfig of its own — always
// use the cluster admin kubeconfig (same as every other KubeEZ check).
export const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl'

// Problems found by each poller — used to notice when one has gone away
const NODE_REASONS = new Set(['NodeNotReady', 'DiskPressure', 'MemoryPressure', 'PIDPressure'])
const UNREACHABLE = new Set(['ClusterUnreachable'])
const UNREACHABLE_AFTER_MS = Number(process.env.KUBEEZ_UNREACHABLE_ALERT_MS) || 5 * 60 * 1000
const POD_REASONS  = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'OOMKilled', 'PodPendingTooLong'])
// A closed incident is not reused; the same problem coming back opens a new one
const CLOSED = new Set(['resolved', 'cleared'])

const cname = (c) => c.clusterName || c.name || 'cluster'
const RESYNC_MS = 60 * 1000

// Which saved clusters should be watched. Decided by facts, not by the status
// text (older records carry statuses like "running", "completed", "active"):
//  - every cluster with a control-plane is watched — reachability then shows
//    "connected" or "unreachable";
//  - not a cluster whose INSTALLATION failed or was cancelled (no Kubernetes
//    yet). A failed upgrade / scale / add-on job leaves a running cluster.
//  - paused while an install / upgrade / scale job runs on it — nodes restart
//    on purpose then, auto-healing must not interfere.
const JOB_MODES = new Set(['upgrade', 'scale', 'addon-only', 'addon-uninstall', 'addon-reinstall'])
const DISRUPTIVE_JOBS = new Set(['install', 'resume', 'upgrade', 'scale'])
export function watchReason(c, runningJob = null) {
    if (!c?.masterNodes?.length) return 'no control-plane node is saved for it'
    if (c.simulationMode) return 'it is a simulation'
    if (runningJob && DISRUPTIVE_JOBS.has(runningJob.mode || 'install')) {
        return `${runningJob.mode === 'upgrade' ? 'an upgrade' : runningJob.mode === 'scale' ? 'adding nodes' : 'the installation'} is running — watching resumes when it finishes`
    }
    const st = String(c.status || 'healthy').toLowerCase()
    const installJob = !c.mode || c.mode === 'install' || c.mode === 'resume'
    if (st === 'failed' && installJob) return 'its installation did not finish — resume it from the cluster page'
    if (st === 'cancelled' && installJob) return 'its installation was cancelled — resume it from the cluster page'
    return null
}

// ── Analysis (pure: kubectl JSON / command output → findings) ────────────────
// A finding: { reason, target, namespace?, message, severity?, nodeName?, ownerHint? }

export function analyzeNodes(data) {
    const out = []
    for (const n of data?.items || []) {
        const name = n.metadata?.name
        for (const c of n.status?.conditions || []) {
            if (c.type === 'Ready' && c.status !== 'True') out.push({ reason: 'NodeNotReady', target: name, nodeName: name, message: `Node ${name} not Ready: ${c.message || c.reason || ''}`.trim() })
            if (c.type === 'DiskPressure' && c.status === 'True') out.push({ reason: 'DiskPressure', target: name, nodeName: name, message: `Node ${name} DiskPressure: ${c.message || ''}`.trim() })
            if (c.type === 'MemoryPressure' && c.status === 'True') out.push({ reason: 'MemoryPressure', target: name, nodeName: name, message: `Node ${name} MemoryPressure: ${c.message || ''}`.trim() })
            if (c.type === 'PIDPressure' && c.status === 'True') out.push({ reason: 'PIDPressure', target: name, nodeName: name, message: `Node ${name} PIDPressure: ${c.message || ''}`.trim() })
        }
    }
    return out
}

export function analyzePods(data, now = Date.now()) {
    const out = []
    for (const pod of data?.items || []) {
        const name = pod.metadata?.name, ns = pod.metadata?.namespace, nodeName = pod.spec?.nodeName || null
        const owner = pod.metadata?.ownerReferences?.[0]
        const ownerHint = owner ? `${owner.kind}/${owner.name}` : null
        for (const c of pod.status?.containerStatuses || []) {
            const w = c.state?.waiting, t = c.state?.terminated, last = c.lastState?.terminated
            if (w?.reason === 'CrashLoopBackOff')
                out.push({ reason: 'CrashLoopBackOff', target: name, namespace: ns, nodeName, ownerHint, message: `${ns}/${name} (${c.name}) in CrashLoopBackOff — restarted ${c.restartCount || 0}×${last?.reason ? `, last exit: ${last.reason}${last.exitCode != null ? ` (code ${last.exitCode})` : ''}` : ''}` })
            if (w?.reason === 'ImagePullBackOff' || w?.reason === 'ErrImagePull')
                out.push({ reason: 'ImagePullBackOff', target: name, namespace: ns, nodeName, ownerHint, message: `${ns}/${name} (${c.name}) cannot pull image ${c.image || ''}: ${w.message || ''}`.trim() })
            if (t?.reason === 'OOMKilled' || w?.reason === 'OOMKilled' || (last?.reason === 'OOMKilled' && w?.reason === 'CrashLoopBackOff'))
                out.push({ reason: 'OOMKilled', target: name, namespace: ns, nodeName, ownerHint, message: `${ns}/${name} (${c.name}) was killed for using too much memory` })
        }
        if (pod.status?.phase === 'Pending' && pod.metadata?.creationTimestamp) {
            const age = now - new Date(pod.metadata.creationTimestamp).getTime()
            if (age > PERSIST_MS) {
                const why = (pod.status?.conditions || []).find(c => c.type === 'PodScheduled' && c.status === 'False')?.message
                out.push({ reason: 'PodPendingTooLong', target: name, namespace: ns, nodeName, ownerHint, message: `${ns}/${name} Pending for ${Math.round(age / 60000)}m${why ? ` — ${why}` : ''}` })
            }
        }
    }
    return out
}

// kubeadm residual time ("364d", "9y", "23h", "<invalid>") → days
function residualDays(tok) {
    if (tok === '<invalid>') return -1
    const m = /^(\d+)([ydhm])$/.exec(tok); if (!m) return null
    const n = +m[1]
    return m[2] === 'y' ? n * 365 : m[2] === 'd' ? n : m[2] === 'h' ? n / 24 : n / 1440
}

/**
 * The health script's sections → findings, plus which reasons were actually
 * checked (a section that could not run must not "clear" open incidents).
 * since(key) returns when a condition was first seen (for "unhealthy > 5 min").
 */
export function analyzeHealth(sections, { now = Date.now(), since = () => now } = {}) {
    const findings = [], checked = new Set()
    const json = (s) => { try { return JSON.parse(s) } catch { return null } }

    // control plane
    const cp = sections.CP || ''
    if (/The connection to the server|connection refused|Unable to connect to the server|dial tcp/i.test(cp) && !json(cp)) {
        checked.add('ControlPlaneDown')
        findings.push({ reason: 'ControlPlaneDown', target: 'kube-apiserver', severity: 'critical', message: 'The Kubernetes API does not answer on the control-plane' })
    } else if (json(cp)) {
        checked.add('ControlPlaneDown')
        for (const p of json(cp).items || []) {
            const comp = p.metadata?.labels?.component || p.metadata?.name
            const ready = (p.status?.conditions || []).find(c => c.type === 'Ready')
            const ok = p.status?.phase === 'Running' && ready?.status === 'True'
            if (ok) continue
            const from = ready?.lastTransitionTime ? new Date(ready.lastTransitionTime).getTime() : since(`cp:${p.metadata?.name}`)
            if (now - from < CP_GRACE_MS) continue
            const cs = (p.status?.containerStatuses || [])[0]
            const why = cs?.state?.waiting?.reason || cs?.lastState?.terminated?.reason || p.status?.phase
            findings.push({ reason: 'ControlPlaneDown', target: `${comp}@${p.spec?.nodeName || '?'}`, nodeName: p.spec?.nodeName, severity: 'critical',
                message: `${comp} on ${p.spec?.nodeName || 'the control-plane'} is not ready${why ? ` (${why})` : ''}${cs?.restartCount ? ` — restarted ${cs.restartCount}×` : ''}` })
        }
    }

    // etcd /health on the control-plane (kubeadm serves it on 127.0.0.1:2381)
    const etcd = (sections.ETCD || '').trim()
    if (etcd) {
        checked.add('EtcdUnhealthy')
        const j = json(etcd)
        if (j && String(j.health) !== 'true') findings.push({ reason: 'EtcdUnhealthy', target: 'etcd', severity: 'critical', message: `etcd reports unhealthy${j.reason ? `: ${j.reason}` : ''}` })
    }

    // certificates
    const certs = sections.CERT || ''
    if (/RESIDUAL TIME/i.test(certs)) {
        checked.add('CertExpiring')
        let worst = null
        for (const line of certs.split('\n')) {
            const name = line.trim().split(/\s+/)[0]
            const tok = (line.match(/\s(<invalid>|\d+[ydhm])\s/) || [])[1]
            if (!name || !tok || /^(CERTIFICATE|CERTIFICATE AUTHORITY)$/i.test(name)) continue
            const d = residualDays(tok)
            if (d == null) continue
            if (!worst || d < worst.days) worst = { name, days: d, when: (line.match(/([A-Z][a-z]{2} \d{2}, \d{4} \d{2}:\d{2} UTC)/) || [])[1] }
        }
        if (worst && worst.days < CERT_WARN_DAYS) {
            const msg = worst.days < 0 ? `${worst.name} has EXPIRED` : `${worst.name} expires in ${worst.days < 1 ? `${Math.max(1, Math.round(worst.days * 24))} hours` : `${Math.floor(worst.days)} days`}${worst.when ? ` (${worst.when})` : ''}`
            findings.push({ reason: 'CertExpiring', target: 'control-plane-certs', severity: worst.days < CERT_CRIT_DAYS ? 'critical' : 'warning', message: msg })
        }
    }

    // control-plane disk
    const disk = (sections.DISK || '').trim().split('\n')
    const dfLine = disk.find(l => /\s\/$/.test(l.trim()))
    if (dfLine) {
        checked.add('ControlPlaneDiskFull')
        const pct = parseInt((dfLine.match(/(\d+)%/) || [])[1], 10)
        const host = disk[disk.length - 1]?.trim()
        if (pct >= DISK_WARN_PCT) findings.push({ reason: 'ControlPlaneDiskFull', target: host || 'control-plane', nodeName: host, severity: pct >= DISK_CRIT_PCT ? 'critical' : 'warning', message: `The control-plane disk (/) is ${pct}% full` })
    }

    // workloads that stay below their wanted replicas
    const wl = json(sections.WL || '')
    if (wl) {
        checked.add('WorkloadUnavailable')
        for (const o of wl.items || []) {
            const kind = o.kind, n = o.metadata?.name, ns = o.metadata?.namespace
            let want, have
            if (kind === 'Deployment') { want = o.spec?.replicas ?? 1; have = o.status?.availableReplicas || 0 }
            else if (kind === 'StatefulSet') { want = o.spec?.replicas ?? 1; have = o.status?.readyReplicas || 0 }
            else if (kind === 'DaemonSet') { want = o.status?.desiredNumberScheduled || 0; have = o.status?.numberAvailable ?? o.status?.numberReady ?? 0 }
            else continue
            if (!want || have >= want) continue
            const avail = (o.status?.conditions || []).find(c => c.type === 'Available' && c.status === 'False')
            const from = avail?.lastTransitionTime ? new Date(avail.lastTransitionTime).getTime() : since(`wl:${kind}/${ns}/${n}`)
            if (now - from < PERSIST_MS) continue
            findings.push({ reason: 'WorkloadUnavailable', target: `${kind.toLowerCase()}/${n}`, namespace: ns, workload: { kind, name: n },
                severity: ns === 'kube-system' ? 'critical' : 'warning',
                message: `${kind} ${ns}/${n}: ${have}/${want} ready for ${Math.round((now - from) / 60000)}m` })
        }
    }

    // volume claims that cannot be bound
    const pvc = json(sections.PVC || '')
    if (pvc) {
        checked.add('PVCPending')
        for (const c of pvc.items || []) {
            if (c.status?.phase !== 'Pending') continue
            const age = now - new Date(c.metadata?.creationTimestamp || now).getTime()
            if (age < PERSIST_MS) continue
            findings.push({ reason: 'PVCPending', target: c.metadata?.name, namespace: c.metadata?.namespace,
                message: `${c.metadata?.namespace}/${c.metadata?.name} Pending for ${Math.round(age / 60000)}m (${c.spec?.storageClassName ? `class ${c.spec.storageClassName}` : 'no storage class'}, ${c.spec?.resources?.requests?.storage || '?'})` })
        }
    }

    // jobs that failed recently
    const jobs = json(sections.JOB || '')
    if (jobs) {
        checked.add('JobFailed')
        for (const j of jobs.items || []) {
            const f = (j.status?.conditions || []).find(c => c.type === 'Failed' && c.status === 'True')
            if (!f || now - new Date(f.lastTransitionTime || 0).getTime() > JOB_WINDOW_MS) continue
            findings.push({ reason: 'JobFailed', target: j.metadata?.name, namespace: j.metadata?.namespace, severity: 'info',
                message: `Job ${j.metadata?.namespace}/${j.metadata?.name} failed: ${f.reason || ''}${f.message ? ` — ${f.message}` : ''}`.trim() })
        }
    }
    return { findings, checked }
}

// One SSH round trip for every cluster-wide check
const HEALTH_SCRIPT = [
    `echo '==CP=='; ${KUBECTL} -n kube-system get pods -l tier=control-plane -o json --request-timeout=15s 2>&1`,
    `echo '==WL=='; ${KUBECTL} get deploy,sts,ds -A -o json --request-timeout=20s 2>/dev/null`,
    `echo '==PVC=='; ${KUBECTL} get pvc -A -o json --request-timeout=15s 2>/dev/null`,
    `echo '==JOB=='; ${KUBECTL} get jobs -A -o json --request-timeout=15s 2>/dev/null`,
    `echo '==ETCD=='; (curl -s -m 3 http://127.0.0.1:2381/health || wget -qO- -T 3 http://127.0.0.1:2381/health) 2>/dev/null`,
    `echo '==CERT=='; sudo kubeadm certs check-expiration 2>/dev/null`,
    `echo '==DISK=='; df -P / 2>/dev/null; hostname`,
    `echo '==END=='`
].join('; ')

export function splitSections(out) {
    const s = {}
    const re = /==([A-Z]+)==\n?([\s\S]*?)(?===[A-Z]+==|$)/g
    let m
    while ((m = re.exec(out || ''))) s[m[1]] = m[2].trim()
    return s
}

/**
 * Detects cluster anomalies via lightweight polling over a single reused SSH
 * connection — routed through a Gateway Agent when present. Polling (not a
 * long-lived `kubectl --watch`) works the same over direct SSH and agent
 * relays, and can't silently die.
 */
class IncidentDetector {
    constructor() {
        this.automationEngine = automationEngine
        this.streams   = new Map()   // clusterId -> { ssh, timers:[], failCount, cluster }
        this.reconnect = new Map()   // clusterId -> attempt count
        this.watched   = new Map()   // clusterId -> cluster (everything we try to monitor)
        this.skipped   = []          // [{ cluster, reason }] saved clusters we do not watch
        this.firstSeen = new Map()   // condition key -> first time seen (for "unhealthy > 5 min")
        this.lastCheck = new Map()   // clusterId -> last successful health check
        this.unreachableSince = new Map()   // clusterId -> first failed connection
        this.incidents = this._load()
    }

    getIncidents() {
        const now = Date.now()
        return this.incidents.filter(i => now - new Date(i.lastSeen || i.timestamp).getTime() < INCIDENT_TTL_MS)
    }

    /** Clusters under watch and whether the watcher is connected right now. */
    getMonitoring() {
        return [...this.watched.values()].map(c => ({
            clusterId: c.id, clusterName: cname(c), orgId: c.orgId, ownerId: c.ownerId,
            connected: this.streams.has(c.id),
            lastCheck: this.lastCheck.get(c.id) || null,
            maintenance: healingPolicyStore.view(c.orgId).maintenance[c.id] || null
        }))
    }

    /** Saved clusters that are not watched, and why (shown on the Incidents page). */
    getSkipped() {
        return this.skipped.map(({ cluster: c, reason }) => ({ clusterId: c.id, clusterName: cname(c), orgId: c.orgId, ownerId: c.ownerId, reason }))
    }

    /** Numbers for the Incidents page (the caller filters to the user's workspace). */
    getStats(filter = () => true, days = 7) {
        const now = Date.now(), from = now - days * 86400e3
        const list = this.incidents.filter(filter).filter(i => new Date(i.timestamp).getTime() >= from)
        const open = list.filter(i => !CLOSED.has(i.status))
        const closed = list.filter(i => CLOSED.has(i.status))
        const resolved = list.filter(i => i.status === 'resolved').length
        const failed = list.filter(i => i.status === 'failed').length
        const durations = closed.map(i => new Date(i.closedAt || i.updatedAt || i.lastSeen).getTime() - new Date(i.timestamp).getTime()).filter(d => d >= 0)
        const top = {}
        for (const i of list) top[i.reason] = (top[i.reason] || 0) + 1
        const daily = []
        for (let d = days - 1; d >= 0; d--) {
            const day = new Date(now - d * 86400e3).toISOString().slice(0, 10)
            const dayList = list.filter(i => i.timestamp.slice(0, 10) === day)
            daily.push({ day, critical: dayList.filter(i => sev(i) === 'critical').length, warning: dayList.filter(i => sev(i) === 'warning').length, info: dayList.filter(i => sev(i) === 'info').length })
        }
        const perCluster = {}
        for (const i of list) {
            const c = perCluster[i.clusterId] ||= { clusterId: i.clusterId, clusterName: i.clusterName, open: 0, total: 0, critical: 0 }
            c.total++; if (!CLOSED.has(i.status)) { c.open++; if (sev(i) === 'critical') c.critical++ }
        }
        return {
            days, total: list.length,
            open: { total: open.length, critical: open.filter(i => sev(i) === 'critical').length, warning: open.filter(i => sev(i) === 'warning').length, info: open.filter(i => sev(i) === 'info').length },
            autoFixed: resolved, cleared: closed.length - resolved, failed,
            fixRate: resolved + failed ? Math.round((resolved / (resolved + failed)) * 100) : null,
            mttrMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000) : null,
            top: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([reason, count]) => ({ reason, label: label(reason), count })),
            daily, perCluster: Object.values(perCluster).sort((a, b) => b.open - a.open || b.total - a.total)
        }
    }

    // ── Persistence: incidents survive a KubeEZ restart ─────────────────────
    _load() {
        try { return JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8')) } catch { return [] }
    }
    _save() {
        clearTimeout(this._saveTimer)
        this._saveTimer = setTimeout(() => {
            writeFileAtomic(INCIDENTS_FILE, JSON.stringify(this.incidents.slice(0, MAX_INCIDENTS)))
                .catch(e => console.error('[AutoHealing] Could not save incidents:', e.message))
        }, 1000)
        this._saveTimer.unref?.()
    }

    async init() {
        console.log('[AutoHealing] Initializing Auto-Healing Engine...')
        await this.resync()
        // Every minute: watch clusters that became healthy (repaired, imported,
        // a job finished), follow node changes, drop removed clusters
        if (!this._resyncTimer) {
            this._resyncTimer = setInterval(() => this.resync(), RESYNC_MS)
            this._resyncTimer.unref?.()
        }
    }

    async resync() {
        try {
            const clusters = await clusterStore.getClusters()
            const ids = new Set(clusters.map(c => c.id))
            const skipped = []
            let jobs = null
            try { jobs = (await import('./installationManager.js')).installationManager } catch { }
            for (const c of clusters) {
                const reason = watchReason(c, jobs?.runningJobFor?.(c.id) || null)
                if (reason) {
                    skipped.push({ cluster: c, reason })
                    if (this.watched.has(c.id)) this.stopWatching(c.id)
                    continue
                }
                const prev = this.watched.get(c.id)
                const moved = prev && prev.masterNodes?.[0]?.ip !== c.masterNodes?.[0]?.ip
                if (moved) this.stopWatching(c.id)
                if (!this.watched.has(c.id)) this.startWatching(c)
                else this.watched.set(c.id, c)   // latest record (credentials, nodes)
            }
            for (const id of [...this.watched.keys()]) if (!ids.has(id)) this.stopWatching(id)
            this.skipped = skipped
        } catch (e) {
            console.error('[AutoHealing] resync failed:', e.message)
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
        this.watched.set(cluster.id, cluster)

        // Gateway-Agent routing needs ownerId/orgId on the node
        const node = { ...master, ownerId: cluster.ownerId, orgId: cluster.orgId }
        const attempt = this.reconnect.get(cluster.id) || 0
        console.log(`[AutoHealing] Connecting to ${cname(cluster)} (attempt ${attempt + 1})`)

        let ssh
        try {
            ssh = await this.automationEngine.connectSSH(node)
        } catch (err) {
            console.error(`[AutoHealing] Connect failed for ${cname(cluster)}: ${err.message}`)
            this._unreachable(cluster, err.message)
            return this._scheduleReconnect(cluster)
        }

        this.reconnect.set(cluster.id, 0)
        // reachable again: the "unreachable" incident clears
        this.unreachableSince.delete(cluster.id)
        this._clearGone(cluster, UNREACHABLE, new Set())
        const stream = { ssh, timers: [], failCount: 0, cluster }
        this.streams.set(cluster.id, stream)

        // Structured pollers (not raw events: a single node-down produces dozens
        // of warning events, which would flood incidents and alerts)
        stream.timers.push(setInterval(() => this._pollNodes(cluster.id), NODE_POLL_INTERVAL))
        stream.timers.push(setInterval(() => this._pollPods(cluster.id), POD_POLL_INTERVAL))
        stream.timers.push(setInterval(() => this._pollHealth(cluster.id), HEALTH_POLL_INTERVAL))
        this._pollNodes(cluster.id)
        this._pollPods(cluster.id)
        setTimeout(() => this._pollHealth(cluster.id), 15000).unref?.()

        console.log(`[AutoHealing] Watching ${cname(cluster)} — node/pod/health pollers active`)
    }

    // Cannot connect for UNREACHABLE_AFTER_MS → one critical incident (+ alert)
    _unreachable(cluster, why) {
        if (healingPolicyStore.inMaintenance(cluster.orgId, cluster.id)) return
        if (!this.unreachableSince.has(cluster.id)) this.unreachableSince.set(cluster.id, Date.now())
        const since = this.unreachableSince.get(cluster.id)
        if (Date.now() - since < UNREACHABLE_AFTER_MS) return
        const target = cluster.masterNodes?.[0]?.ip || cname(cluster)
        this._createIncident(cluster, { reason: 'ClusterUnreachable', target, severity: 'critical',
            message: `${cname(cluster)} (${target}) unreachable for ${Math.round((Date.now() - since) / 60000)} min — ${String(why || 'no answer').slice(0, 160)}` })
    }

    _scheduleReconnect(cluster) {
        this._cleanup(cluster.id)
        const attempt = this.reconnect.get(cluster.id) || 0
        this.reconnect.set(cluster.id, attempt + 1)
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS)
        console.log(`[AutoHealing] Reconnecting to ${cname(cluster)} in ${Math.round(delay / 1000)}s`)
        const t = setTimeout(() => {
            const latest = this.watched.get(cluster.id)
            if (latest) this.startWatching(latest)
        }, delay)
        t.unref?.()
    }

    _cleanup(clusterId) {
        const stream = this.streams.get(clusterId)
        if (stream) {
            stream.timers.forEach(t => clearInterval(t))
            try { stream.ssh?.dispose?.() } catch (_) {}
            this.streams.delete(clusterId)
        }
    }

    // Run a poll against the shared SSH; reconnect after repeated failures.
    // Clusters in maintenance are not polled at all.
    async _run(clusterId, fn) {
        const cluster = this.watched.get(clusterId)
        const stream = this.streams.get(clusterId)
        if (!cluster || !stream?.ssh) return null
        if (healingPolicyStore.inMaintenance(cluster.orgId, clusterId)) return null
        try {
            const out = await fn(stream.ssh)
            stream.failCount = 0
            return out
        } catch (e) {
            stream.failCount++
            if (stream.failCount >= MAX_POLL_FAILURES) {
                console.warn(`[AutoHealing] ${cname(cluster)} SSH unhealthy (${stream.failCount}x) — reconnecting`)
                this._unreachable(cluster, e.message)
                this._scheduleReconnect(cluster)
            }
            return null
        }
    }

    _since(key) {
        if (!this.firstSeen.has(key)) this.firstSeen.set(key, Date.now())
        return this.firstSeen.get(key)
    }

    _apply(cluster, findings, reasons) {
        const seen = new Set()
        for (const f of findings) { const k = this._createIncident(cluster, f); if (k) seen.add(k) }
        this._clearGone(cluster, reasons, seen)
    }

    async _pollNodes(clusterId) {
        const r = await this._run(clusterId, ssh => ssh.execCommand(`${KUBECTL} get nodes -o json --request-timeout=20s 2>/dev/null`))
        if (!r || r.code !== 0 || !r.stdout?.trim()) return
        let data; try { data = JSON.parse(r.stdout) } catch { return }
        this.lastCheck.set(clusterId, new Date().toISOString())
        this._apply(this.watched.get(clusterId), analyzeNodes(data), NODE_REASONS)
    }

    async _pollPods(clusterId) {
        const r = await this._run(clusterId, ssh => ssh.execCommand(`${KUBECTL} get pods -A -o json --request-timeout=30s 2>/dev/null`))
        if (!r || r.code !== 0 || !r.stdout?.trim()) return
        let data; try { data = JSON.parse(r.stdout) } catch { return }
        this._apply(this.watched.get(clusterId), analyzePods(data), POD_REASONS)
    }

    async _pollHealth(clusterId) {
        const r = await this._run(clusterId, ssh => ssh.execCommand(HEALTH_SCRIPT))
        if (!r?.stdout || !/==END==/.test(r.stdout)) return
        // "unhealthy since" clocks: only conditions seen in this round keep theirs
        const used = new Set()
        const since = (k) => { const key = `${clusterId}|${k}`; used.add(key); return this._since(key) }
        const { findings, checked } = analyzeHealth(splitSections(r.stdout), { since })
        for (const k of [...this.firstSeen.keys()]) if (k.startsWith(`${clusterId}|`) && !used.has(k)) this.firstSeen.delete(k)
        this.lastCheck.set(clusterId, new Date().toISOString())
        this._apply(this.watched.get(clusterId), findings, checked)
    }

    // An open incident whose problem is no longer reported has gone away
    _clearGone(cluster, reasons, seenKeys) {
        let changed = false
        for (const inc of this.incidents) {
            if (inc.clusterId !== cluster.id || !reasons.has(inc.reason) || CLOSED.has(inc.status)) continue
            if (seenKeys.has(inc._key)) continue
            const fixedByUs = inc.status === 'remediating'
            inc.status = fixedByUs ? 'resolved' : 'cleared'
            inc.details = fixedByUs ? 'Fixed — no longer detected after the automatic fix' : 'No longer detected — the problem went away'
            inc.updatedAt = inc.closedAt = new Date().toISOString()
            this._tl(inc, inc.status, inc.details)
            changed = true
            if (!inc.causedBy) notifier.emit(inc.orgId, {
                type: 'incident_resolved', severity: 'success', recovery: inc.severity === 'critical', key: `resolved|${inc._key}`,
                title: `${fixedByUs ? 'Fixed' : 'Cleared'}: ${label(inc.reason)} — ${alertTarget(inc)}`,
                text: inc.details, clusterId: inc.clusterId, clusterName: inc.clusterName, link: '/incidents'
            })
        }
        if (changed) this._save()
    }

    _tl(inc, kind, text, by) {
        inc.timeline ||= []
        const last = inc.timeline[inc.timeline.length - 1]
        if (last && last.kind === kind && last.text === text) return
        inc.timeline.push({ at: new Date().toISOString(), kind, text: String(text || '').slice(0, 500), ...(by ? { by } : {}) })
        if (inc.timeline.length > TIMELINE_MAX) inc.timeline.splice(1, inc.timeline.length - TIMELINE_MAX)
    }

    // The node an incident is really about (if it is down, pod problems there are a consequence)
    _rootCause(cluster, f) {
        if (f.reason === 'NodeNotReady') return null
        if (f.nodeName) {
            const node = this.incidents.find(i => i.clusterId === cluster.id && i.reason === 'NodeNotReady' && i.target === f.nodeName && !CLOSED.has(i.status))
            if (node) return node
        }
        // a workload below its replicas because its pods crash / cannot pull / are pending
        if (f.reason === 'WorkloadUnavailable' && f.workload) {
            const base = f.workload.name + '-'
            return this.incidents.find(i => i.clusterId === cluster.id && i.namespace === f.namespace && POD_REASONS.has(i.reason) && !CLOSED.has(i.status) && i.target?.startsWith(base)) || null
        }
        return null
    }

    // ── Incident factory ───────────────────────────────────────────────────────
    // Returns the incident key (pollers use it to notice problems that went away).
    _createIncident(cluster, f) {
        if (!cluster || !f?.reason) return null
        const { reason, target, namespace } = f
        const policy = healingPolicyStore.policy(cluster.orgId, reason)
        if (policy === 'off') return null
        const key = `${cluster.id}:${reason}:${namespace ? namespace + '/' : ''}${target}`
        const now = Date.now()
        const severity = f.severity || CATALOG[reason]?.severity || 'warning'
        const mute = healingPolicyStore.muted(cluster.orgId, key)

        // Still the same ongoing problem → update it instead of adding a row.
        // Re-run the playbook at most every DEDUP_WINDOW (it has its own retry limit).
        const open = this.incidents.find(i => i._key === key && !CLOSED.has(i.status))
        if (open) {
            open.count = (open.count || 1) + 1
            open.lastSeen = new Date(now).toISOString()
            open.message = f.message || open.message
            open.severity = severity
            open.muted = mute?.until || null
            const last = new Date(open.lastDispatchedAt || open.timestamp).getTime()
            if (now - last >= DEDUP_WINDOW_MS) {
                open.lastDispatchedAt = new Date(now).toISOString()
                this._dispatch(cluster, open)
            }
            this._save()
            return key
        }

        const cause = this._rootCause(cluster, f)
        const incident = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            _key: key,
            clusterId: cluster.id,
            clusterName: cname(cluster),
            orgId: cluster.orgId,
            ownerId: cluster.ownerId,
            reason,
            category: CATALOG[reason]?.category || 'other',
            severity,
            message: f.message || '',
            timestamp: new Date(now).toISOString(),
            lastSeen: new Date(now).toISOString(),
            count: 1,
            status: 'detecting',
            target: target || 'cluster-wide',
            namespace: namespace || null,
            nodeName: f.nodeName || null,
            owner: f.ownerHint || (f.workload ? `${f.workload.kind}/${f.workload.name}` : null),
            causedBy: cause?.id || null,
            muted: mute?.until || null,
            timeline: []
        }
        this._tl(incident, 'detected', incident.message)

        console.log(`[AutoHealing] Incident — [${reason}] target=${incident.target} cluster=${cname(cluster)}${cause ? ` (caused by ${cause.target})` : ''}`)
        if (cause) {
            incident.status = 'unresolved'
            incident.details = `Caused by ${label(cause.reason).toLowerCase()} on ${cause.target} — it clears when that is fixed`
            this._tl(incident, 'unresolved', incident.details)
        } else if (!mute) {
            notifier.emit(cluster.orgId, {
                type: 'incident', severity: severity === 'info' ? 'info' : severity, key: `incident|${key}`,
                title: `${label(reason)} — ${alertTarget(incident)}`,
                text: incident.message, clusterId: cluster.id, clusterName: cname(cluster), link: '/incidents'
            })
        }

        this.incidents.unshift(incident)
        this.incidents = this.incidents
            .filter(i => now - new Date(i.lastSeen || i.timestamp).getTime() < INCIDENT_TTL_MS)
            .slice(0, MAX_INCIDENTS)
        if (!cause) this._dispatch(cluster, incident)
        this._save()
        return key
    }

    // Policy decides: fix (auto), or only alert + diagnose (notify). A person can
    // always force the fix ("Run fix now"). Never let a failure here break detection.
    _dispatch(cluster, incident, { force = false } = {}) {
        try {
            if (incident.causedBy && !force) return
            if (incident.muted && !force) {
                if (incident.status === 'detecting') this.updateIncidentStatus(incident.id, 'unresolved', `Muted until ${new Date(incident.muted).toLocaleString()} — no alerts or fixes`)
                return
            }
            const meta = CATALOG[incident.reason] || {}
            const policy = healingPolicyStore.policy(cluster.orgId, incident.reason)
            if (!force && meta.fixable && policy !== 'auto') {
                this.updateIncidentStatus(incident.id, 'unresolved', `Alert only (workspace policy) — "Run fix now" applies: ${meta.fix || 'the fix'}`)
                return
            }
            Promise.resolve(remediationEngine.handleAnomaly(
                cluster,
                { reason: incident.reason, message: incident.message, involvedObject: { name: incident.target, namespace: incident.namespace } },
                incident,
                { force }
            )).catch(e => console.error(`[AutoHealing] Remediation failed: ${e.message}`))
        } catch (e) {
            console.error(`[AutoHealing] Remediation dispatch failed: ${e.message}`)
        }
    }

    updateIncidentStatus(incidentId, status, details) {
        const inc = this.incidents.find(i => i.id === incidentId)
        if (!inc || (CLOSED.has(inc.status) && !CLOSED.has(status))) return
        inc.status = status
        inc.details = details
        inc.updatedAt = new Date().toISOString()
        if (CLOSED.has(status)) inc.closedAt = inc.updatedAt
        this._tl(inc, status, details)
        this._save()
    }

    /** Evidence collected by a playbook (logs, describe output) — shown in the incident. */
    addEvidence(incidentId, title, text) {
        const inc = this.incidents.find(i => i.id === incidentId)
        if (!inc || !text) return
        inc.evidence = [{ title, text: String(text).slice(-4000), at: new Date().toISOString() }, ...(inc.evidence || []).filter(e => e.title !== title)].slice(0, 5)
        this._save()
    }

    // ── Actions from the Incidents page ──────────────────────────────────────
    find(id) { return this.incidents.find(i => i.id === id) }

    acknowledge(id, by) {
        const inc = this.find(id); if (!inc) return null
        inc.ackBy = by; inc.ackAt = new Date().toISOString()
        this._tl(inc, 'ack', `Acknowledged by ${by}`, by)
        this._save(); return inc
    }

    async runNow(id, by) {
        const inc = this.find(id); if (!inc) return null
        if (CLOSED.has(inc.status)) throw Object.assign(new Error('This incident is already closed'), { status: 400 })
        const cluster = this.watched.get(inc.clusterId) || (await clusterStore.getClusters()).find(c => c.id === inc.clusterId)
        if (!cluster) throw Object.assign(new Error('The cluster is no longer managed'), { status: 404 })
        this._tl(inc, 'manual', `Fix started by ${by}`, by)
        remediationEngine.reset(inc)
        inc.lastDispatchedAt = new Date().toISOString()
        this._dispatch(cluster, inc, { force: true })
        this._save(); return inc
    }

    mute(id, hours, by) {
        const inc = this.find(id); if (!inc) return null
        const m = healingPolicyStore.mute(inc.orgId, inc._key, hours, by)
        inc.muted = m?.until || null
        this._tl(inc, 'mute', m ? `Muted for ${hours} h by ${by}` : `Unmuted by ${by}`, by)
        this._save(); return inc
    }

    stopWatching(clusterId) {
        this._cleanup(clusterId)
        this.reconnect.delete(clusterId)
        this.watched.delete(clusterId)
        console.log(`[AutoHealing] Stopped watching cluster ${clusterId}`)
    }
}

const sev = (i) => i.severity || CATALOG[i.reason]?.severity || 'warning'

export const incidentDetector = new IncidentDetector()
