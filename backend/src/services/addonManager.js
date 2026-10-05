import { automationEngine } from './automationEngine.js'

const KB = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl'

// Every add-on KubeEZ can install: where it lives and how to tell it is there.
// `keepsData`: uninstalling deletes user data → the UI asks for a typed confirmation.
export const ADDON_REGISTRY = {
    ingress:        { label: 'Nginx Ingress',                 ns: 'ingress-nginx',        detect: 'deploy/ingress-nginx-controller' },
    monitoring:     { label: 'Prometheus + Grafana',          ns: 'monitoring',           detect: 'deploy/grafana' },
    dashboard:      { label: 'Kubernetes Dashboard',          ns: 'kubernetes-dashboard', detect: 'deploy/kubernetes-dashboard' },
    'cert-manager': { label: 'cert-manager',                  ns: 'cert-manager',         detect: 'deploy/cert-manager' },
    longhorn:       { label: 'Longhorn Storage',              ns: 'longhorn-system',      detect: 'ds/longhorn-manager', keepsData: true },
    argocd:         { label: 'ArgoCD',                        ns: 'argocd',               detect: 'deploy/argocd-server' },
    seaweedfs:      { label: 'S3 Object Storage (SeaweedFS)', ns: 'seaweedfs',            detect: 'deploy/seaweedfs', keepsData: true },
    velero:         { label: 'Velero (Volume Backups)',       ns: 'velero',               detect: 'deploy/velero' }
}

const BROKEN = /CrashLoopBackOff|ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|CreateContainerError|RunContainerError|OOMKilled|Error/

// Kubernetes pod JSON → the few facts the UI needs
export function summarizePod(p) {
    const cs = p.status?.containerStatuses || []
    const ready = cs.filter(c => c.ready).length
    const restarts = cs.reduce((n, c) => n + (c.restartCount || 0), 0)
    const reason = cs.map(c => c.state?.waiting?.reason || c.state?.terminated?.reason).find(Boolean)
        || (p.status?.phase === 'Pending' && (p.status?.conditions || []).find(c => c.type === 'PodScheduled' && c.status === 'False')?.reason)
        || null
    return {
        name: p.metadata?.name,
        phase: p.status?.phase || 'Unknown',
        ready: `${ready}/${(p.spec?.containers || []).length || cs.length}`,
        allReady: cs.length > 0 && ready === cs.length,
        restarts,
        reason,
        node: p.spec?.nodeName || null,
        createdAt: p.metadata?.creationTimestamp || null
    }
}

// healthy | starting | failed | removing | not-installed
export function addonHealth({ installed, nsPhase, pods }) {
    if (nsPhase === 'Terminating') return 'removing'
    if (!installed) return 'not-installed'
    const live = pods.filter(p => p.phase !== 'Succeeded')
    if (!live.length) return 'starting'
    if (live.some(p => BROKEN.test(p.reason || '') || p.phase === 'Failed')) return 'failed'
    if (live.every(p => p.phase === 'Running' && p.allReady)) return 'healthy'
    return 'starting'
}

async function run(ssh, cmd) {
    try {
        const r = await ssh.execCommand(cmd)
        return { ok: r.code === 0, out: r.stdout || '', err: r.stderr || '' }
    } catch (e) {
        return { ok: false, out: '', err: e.message }
    }
}

class AddonManager {
    master(cluster) {
        const m = cluster.masterNodes?.[0]
        if (!m) throw new Error('No master node found for this cluster')
        return m
    }

    /** Live state of every add-on: installed?, health, pods. One SSH round-trip. */
    async getStatus(cluster) {
        const ssh = await automationEngine.connectSSH(this.master(cluster))
        try {
            const script = Object.entries(ADDON_REGISTRY).map(([key, a]) =>
                `echo "@@ADDON ${key}"; ` +
                `echo "@@NS $(${KB} get ns ${a.ns} -o jsonpath='{.status.phase}' 2>/dev/null)"; ` +
                `echo "@@DETECT $(${KB} -n ${a.ns} get ${a.detect} -o name 2>/dev/null)"; ` +
                `${KB} -n ${a.ns} get pods -o json 2>/dev/null; echo`
            ).join('; ')
            const r = await run(ssh, script)
            if (!r.out.includes('@@ADDON')) throw new Error(`Could not read add-on status from the cluster: ${(r.err || 'no output').trim().slice(0, 300)}`)

            const addons = r.out.split('@@ADDON ').slice(1).map(block => {
                const key = block.slice(0, block.indexOf('\n')).trim()
                const nsPhase = (block.match(/@@NS ([^\n]*)/)?.[1] || '').trim()
                const installed = !!(block.match(/@@DETECT ([^\n]*)/)?.[1] || '').trim()
                let pods = []
                const json = block.slice(block.indexOf('{'))
                if (block.includes('{')) {
                    try { pods = (JSON.parse(json).items || []).map(summarizePod) } catch { /* no pods */ }
                }
                const def = ADDON_REGISTRY[key]
                const configured = !!(cluster.addons?.[key] || (key === 'cert-manager' && cluster.addons?.certManager))
                return {
                    key, label: def.label, namespace: def.ns, keepsData: !!def.keepsData,
                    installed, configured, nsPhase: nsPhase || null,
                    health: addonHealth({ installed, nsPhase, pods }),
                    pods
                }
            })
            return { addons, fetchedAt: new Date().toISOString() }
        } finally {
            ssh.dispose?.()
        }
    }

    /**
     * Logs of an add-on's pods (one pod, or the first 6) + recent namespace events.
     * A container that restarted also gets the log of its PREVIOUS run (the crash).
     */
    async getLogs(cluster, key, { pod, tail = 200 } = {}) {
        const def = ADDON_REGISTRY[key]
        if (!def) throw Object.assign(new Error('Unknown add-on'), { status: 400 })
        if (pod && !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(pod)) throw Object.assign(new Error('Invalid pod name'), { status: 400 })
        const lines = Math.max(10, Math.min(2000, parseInt(tail, 10) || 200))

        const ssh = await automationEngine.connectSSH(this.master(cluster))
        try {
            const podsR = await run(ssh, `${KB} -n ${def.ns} get pods -o json 2>/dev/null`)
            let pods = []
            try { pods = (JSON.parse(podsR.out).items || []).map(summarizePod) } catch { /* none */ }
            const selected = pod ? pods.filter(p => p.name === pod) : pods.slice(0, 6)

            const logs = []
            for (const p of selected) {
                const cur = await run(ssh, `${KB} -n ${def.ns} logs ${p.name} --all-containers --prefix --timestamps --tail=${lines} 2>&1`)
                let previous = null
                if (p.restarts > 0) {
                    const prev = await run(ssh, `${KB} -n ${def.ns} logs ${p.name} --all-containers --prefix --previous --tail=50 2>&1`)
                    if (prev.ok && prev.out.trim()) previous = prev.out
                }
                logs.push({ pod: p.name, log: cur.out || cur.err || '(no output)', previous })
            }
            const ev = await run(ssh,
                `${KB} -n ${def.ns} get events --sort-by=.lastTimestamp ` +
                `-o custom-columns=TIME:.lastTimestamp,TYPE:.type,REASON:.reason,OBJECT:.involvedObject.name,MESSAGE:.message --no-headers 2>/dev/null | tail -25`)
            return { key, namespace: def.ns, pods, logs, events: ev.out.trim() }
        } finally {
            ssh.dispose?.()
        }
    }
}

export const addonManager = new AddonManager()
