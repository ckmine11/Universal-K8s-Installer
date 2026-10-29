// DORA delivery metrics of a cluster, from what the cluster and KubeEZ already
// know — no CI integration needed:
//   deployment frequency   every rollout: a new ReplicaSet (Deployment) or a
//                          new ControllerRevision (StatefulSet / DaemonSet)
//   change failure rate    a rollout that was rolled back, or that was followed
//                          within an hour (and before the next rollout) by an
//                          incident on that workload (crash loop, image pull…)
//   recovery time          from that rollout until its incident closed or the
//                          next rollout replaced it
//   lead time for changes  needs commit times from Git — not measured yet
// Kubernetes keeps ~10 old ReplicaSets per Deployment and KubeEZ keeps
// incidents for 7 days, so long windows count what is still there.
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
const MAX_BYTES = 6_000_000
const T = '{"\\t"}'
const N = '{"\\n"}'

export const DORA_SCRIPT = [
    `echo '==KZDORA:RS=='; ${KUBECTL} get rs -A -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}${T}{.metadata.namespace}${T}{.metadata.ownerReferences[0].kind}${T}{.metadata.ownerReferences[0].name}${T}{.metadata.annotations.deployment\\.kubernetes\\.io/revision}${T}{range .spec.template.spec.containers[*]}{.image}{" "}{end}${N}{end}' --request-timeout=50s 2>/dev/null | head -c ${MAX_BYTES}`,
    `echo '==KZDORA:CR=='; ${KUBECTL} get controllerrevisions -A -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}${T}{.metadata.namespace}${T}{.metadata.ownerReferences[0].kind}${T}{.metadata.ownerReferences[0].name}${T}{.revision}${N}{end}' --request-timeout=50s 2>/dev/null | head -c ${MAX_BYTES}`,
    `echo '==KZDORA:END=='`
].join('; ')

// KubeEZ's add-ons and Kubernetes itself are not "your" deployments
export const PLATFORM_NS = /^(kube-.*|calico-.*|tigera-.*|cattle-.*|metallb-system|longhorn-system|cert-manager|ingress-nginx|monitoring|logging|argocd|flux-system|trivy-system|velero|kyverno|gatekeeper-system|falco|vault|harbor|elastic-system|seaweedfs|nfs-provisioner|local-path-storage|kubeez.*|kubernetes-dashboard|piraeus-.*|sealed-secrets|loki|jenkins|ollama)$/

// incidents that mean "this rollout broke the workload"
export const FAILURE_REASONS = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'OOMKilled', 'WorkloadUnavailable', 'RestartsRising', 'PodPendingTooLong', 'GitOpsDegraded'])
const FAILURE_WINDOW_MS = 60 * 60e3

const ms = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t }
const rows = (text) => String(text || '').split('\n').filter(Boolean).map(l => l.split('\t'))
function sections(out) {
    const s = {}
    const re = /==KZDORA:([A-Z]+)==\n?([\s\S]*?)(?===KZDORA:[A-Z]+==|$)/g
    let m
    while ((m = re.exec(out || ''))) s[m[1]] = m[2].trim()
    return s
}

/**
 * Every rollout still visible in the cluster →
 * [{ at, namespace, kind, name, revision, images, first, rolledBack }]
 */
export function parseRollouts(out) {
    const s = sections(out)
    const list = []
    const byDeploy = new Map()
    for (const [created, ns, kind, owner, rev, images] of rows(s.RS)) {
        if (kind !== 'Deployment' || !owner || ms(created) == null) continue
        const k = `${ns}/${owner}`
        if (!byDeploy.has(k)) byDeploy.set(k, [])
        byDeploy.get(k).push({ at: ms(created), namespace: ns, kind: 'deployment', name: owner, revision: Number(rev) || 0, images: String(images || '').trim().split(/\s+/).filter(Boolean) })
    }
    for (const rss of byDeploy.values()) {
        rss.sort((a, b) => a.at - b.at)
        // a rollback re-uses the old ReplicaSet and gives it the newest revision:
        // then the newest revision is not the newest ReplicaSet — and the one
        // that ran before it (the second-highest revision) was rolled back
        const byRev = [...rss].sort((a, b) => b.revision - a.revision)
        const current = byRev[0]
        const rolledBackFrom = current && rss.at(-1) !== current ? byRev[1] : null
        for (const r of rss) list.push({ ...r, first: r.revision === 1, rolledBack: r === rolledBackFrom })
    }
    const byOwner = new Map()
    for (const [created, ns, kind, owner, rev] of rows(s.CR)) {
        if (!['StatefulSet', 'DaemonSet'].includes(kind) || !owner || ms(created) == null) continue
        const k = `${kind}|${ns}|${owner}`
        if (!byOwner.has(k)) byOwner.set(k, [])
        byOwner.get(k).push({ at: ms(created), namespace: ns, kind: kind.toLowerCase(), name: owner, revision: Number(rev) || 0, images: [] })
    }
    for (const crs of byOwner.values()) for (const r of crs) list.push({ ...r, first: r.revision === 1, rolledBack: false })
    return list.sort((a, b) => a.at - b.at)
}

// the pods of a workload: web-7d9fc8b6c-x2x9z (Deployment), db-0 (StatefulSet), agent-x2x9z (DaemonSet)
const POD_OF = {
    deployment: (name) => new RegExp(`^${esc(name)}-[a-z0-9]{6,10}-[a-z0-9]{5}$`),
    statefulset: (name) => new RegExp(`^${esc(name)}-\\d+$`),
    daemonset: (name) => new RegExp(`^${esc(name)}-[a-z0-9]{5}$`)
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Is this incident about this workload (one of its pods, or the workload itself)? */
export function aboutWorkload(inc, d) {
    if (inc.namespace !== d.namespace) return false
    const t = String(inc.target || '')
    if (t.toLowerCase() === `${d.kind}/${d.name}`) return true
    if (POD_OF[d.kind]?.(d.name).test(t)) return true
    const owner = String(inc.owner || '').toLowerCase()
    return owner === `${d.kind}/${d.name}` || (d.kind === 'deployment' && new RegExp(`^replicaset/${esc(d.name)}-[a-z0-9]{6,10}$`).test(owner))
}

// DORA research (State of DevOps 2023) bands
export function levelOf(metric, v) {
    if (v == null) return null
    if (metric === 'frequency') return v >= 1 ? 'elite' : v >= 1 / 7 ? 'high' : v >= 1 / 30 ? 'medium' : 'low'          // deploys per day
    if (metric === 'failure') return v <= 5 ? 'elite' : v <= 10 ? 'high' : v <= 15 ? 'medium' : 'low'                    // %
    if (metric === 'recovery') return v < 60 ? 'elite' : v < 24 * 60 ? 'high' : v < 7 * 24 * 60 ? 'medium' : 'low'      // minutes
    return null
}
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const day = (t) => new Date(t).toISOString().slice(0, 10)
const MIN_FOR_RATE = 5

/**
 * The four keys for one cluster between from and to (ms).
 * incidents: KubeEZ's incidents of this cluster (open and closed).
 * match(ns): namespaces the member may see (null = all); platform: include
 * Kubernetes' and the add-ons' own namespaces.
 */
export function computeDora({ rollouts, incidents = [], from, to = Date.now(), match = null, platform = false }) {
    const mine = (ns) => (platform || !PLATFORM_NS.test(ns)) && (!match || match(ns))
    const all = rollouts.filter(r => mine(r.namespace))
    const nextOf = new Map()
    const byWorkload = new Map()
    for (const r of all) { const k = `${r.kind}|${r.namespace}|${r.name}`; if (!byWorkload.has(k)) byWorkload.set(k, []); byWorkload.get(k).push(r) }
    for (const list of byWorkload.values()) list.forEach((r, i) => nextOf.set(r, list[i + 1] || null))

    const deploys = all.filter(r => r.at >= from && r.at <= to).map(r => {
        const next = nextOf.get(r)
        const until = Math.min(r.at + FAILURE_WINDOW_MS, next ? next.at : Infinity)
        const inc = incidents
            .filter(i => FAILURE_REASONS.has(i.reason) && aboutWorkload(i, r))
            .map(i => ({ i, t: ms(i.timestamp) }))
            .filter(({ t }) => t != null && t >= r.at && t < until)
            .sort((a, b) => a.t - b.t)[0]?.i || null
        const failed = r.rolledBack || !!inc
        let recoveredAt = null
        if (failed) {
            const closed = inc && ['resolved', 'cleared'].includes(inc.status) ? ms(inc.closedAt || inc.updatedAt) : null
            const candidates = [closed, next?.at].filter(t => t != null && t >= r.at)
            recoveredAt = candidates.length ? Math.min(...candidates) : null
        }
        return {
            at: new Date(r.at).toISOString(), namespace: r.namespace, kind: r.kind, name: r.name, revision: r.revision, images: r.images, first: r.first,
            failed, why: failed ? (r.rolledBack ? 'rolled back' : `${inc.reason} — ${String(inc.message || '').slice(0, 160)}`) : null,
            incidentId: inc?.id || null, recoveryMinutes: recoveredAt != null ? Math.round((recoveredAt - r.at) / 60e3) : null
        }
    })

    const days = Math.max(1, (to - from) / 86400e3)
    const failed = deploys.filter(d => d.failed)
    const perDay = deploys.length / days
    const rate = deploys.length ? Math.round(failed.length / deploys.length * 1000) / 10 : null
    const recovered = failed.map(d => d.recoveryMinutes).filter(v => v != null)
    const recovery = median(recovered)
    // every incident of the cluster that closed in the window (workloads not in scope left out)
    const closed = incidents.filter(i => ['resolved', 'cleared'].includes(i.status) && ms(i.closedAt) != null && ms(i.closedAt) >= from && ms(i.closedAt) <= to && (!i.namespace || mine(i.namespace)))
    const mttr = median(closed.map(i => (ms(i.closedAt) - ms(i.timestamp)) / 60e3).filter(v => v >= 0))

    const daily = []
    for (let t = Date.parse(`${day(from)}T00:00:00Z`); t <= to; t += 86400e3) daily.push({ date: day(t), deploys: 0, failed: 0 })
    const idx = new Map(daily.map((d, i) => [d.date, i]))
    for (const d of deploys) { const i = idx.get(d.at.slice(0, 10)); if (i != null) { daily[i].deploys++; if (d.failed) daily[i].failed++ } }

    const workloads = new Map()
    for (const d of deploys) {
        const k = `${d.kind}|${d.namespace}|${d.name}`
        const w = workloads.get(k) || { kind: d.kind, namespace: d.namespace, name: d.name, deploys: 0, failed: 0, lastAt: null }
        w.deploys++; if (d.failed) w.failed++; w.lastAt = d.at
        workloads.set(k, w)
    }

    return {
        window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: Math.round(days) },
        frequency: { deploys: deploys.length, perDay: Math.round(perDay * 100) / 100, perWeek: Math.round(perDay * 7 * 10) / 10, level: deploys.length ? levelOf('frequency', perDay) : null },
        changeFailure: { failed: failed.length, deploys: deploys.length, percent: rate, level: deploys.length >= MIN_FOR_RATE ? levelOf('failure', rate) : null, tooFew: deploys.length < MIN_FOR_RATE },
        recovery: { medianMinutes: recovery != null ? Math.round(recovery) : null, measured: recovered.length, unrecovered: failed.length - recovered.length, level: levelOf('recovery', recovery) },
        incidentRestore: { medianMinutes: mttr != null ? Math.round(mttr) : null, incidents: closed.length },
        leadTime: { available: false, why: 'Needs the commit time of each change (Git) — comes with deploying through KubeEZ.' },
        daily,
        workloads: [...workloads.values()].sort((a, b) => b.deploys - a.deploys || a.name.localeCompare(b.name)).slice(0, 25),
        failures: [...failed].reverse().slice(0, 25),
        recent: deploys.slice(-25).reverse()
    }
}

const cache = new Map()   // clusterId → { at, rollouts }
const TTL = 60e3

/** Every rollout the cluster still knows (cached 1 minute). */
export async function readRollouts(cluster, { connect, fresh = false } = {}) {
    const hit = cache.get(cluster.id)
    if (!fresh && hit && Date.now() - hit.at < TTL) return hit.rollouts
    const ssh = await (connect || defaultConnect)(cluster)
    let r
    try { r = await ssh.execCommand(DORA_SCRIPT, { timeoutMs: 120e3 }) } finally { ssh.dispose?.() }
    const out = r?.stdout || ''
    if (!out.includes('==KZDORA:END==')) throw Object.assign(new Error(`Could not read the cluster${r?.stderr ? `: ${String(r.stderr).trim().slice(0, 200)}` : ''}`), { status: 502 })
    const rollouts = parseRollouts(out)
    cache.set(cluster.id, { at: Date.now(), rollouts })
    return rollouts
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}

// tests only: answer every cluster call with a fake connection
export const _test = { useConnect(fn) { testConnect = fn; cache.clear() } }
