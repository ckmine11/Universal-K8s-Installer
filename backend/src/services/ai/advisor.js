// Advisor — security and cost, per workload, from one read-only look at the
// cluster (pods, services, network policies, kubelet usage). Facts first; AI
// only summarises. Usage is "right now" (one sample) — the advice says so.
import { HELM_ADDONS } from '../../config/helmAddons.js'

const K = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 40 kubectl'
export const ADVISOR_SCRIPT = [
    `echo '==PODS=='; ${K} get pods -A -o json 2>/dev/null`,
    `echo '==RS=='; ${K} get rs -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\\t"}{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\\n"}{end}' 2>/dev/null`,
    `echo '==SVC=='; ${K} get svc -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\\t"}{.spec.type}{"\\n"}{end}' 2>/dev/null`,
    `echo '==NETPOL=='; ${K} get networkpolicy -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\\n"}{end}' 2>/dev/null`,
    `echo '==NODES=='; ${K} get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\\t"}{.status.allocatable.cpu}{"\\t"}{.status.allocatable.memory}{"\\n"}{end}' 2>/dev/null`,
    `for n in $(${K} get nodes -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\\n' | head -30); do echo "==USAGE $n=="; ${K} get --raw "/api/v1/nodes/$n/proxy/stats/summary" 2>/dev/null; echo; done`,
    `echo '==END=='`
].join('; ')

const SYSTEM_NS = /^(kube-|kubeez-|ingress-nginx$|cert-manager$|metallb-system$|calico|tigera|cilium|flannel|local-path-storage$)/
const addonNamespaces = () => new Set(Object.values(HELM_ADDONS).map(a => a.ns).filter(Boolean))
const MULT = { '': 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }
export const qty = (q) => { const m = /^([\d.]+)([a-zA-Z]*)$/.exec(String(q ?? '').trim()); return m && MULT[m[2]] != null ? parseFloat(m[1]) * MULT[m[2]] : null }
const GB = 1024 ** 3, MB = 1024 ** 2
const cores = (c) => c >= 1 ? `${+c.toFixed(2)} cores` : `${Math.round(c * 1000)}m`
const mem = (b) => b >= GB ? `${(b / GB).toFixed(1)} GiB` : `${Math.round(b / MB)} MiB`

function sections(out) {
    const s = {}
    for (const part of String(out || '').split(/^==(?=[A-Z])/m)) {
        const m = /^([A-Z]+)(?: ([^=\n]+))?==\n?/.exec(part)
        if (!m) continue
        const body = part.slice(m[0].length)
        if (m[1] === 'USAGE') (s.USAGE ||= {})[m[2]] = body.trim()
        else s[m[1]] = body.trim()
    }
    return s
}

/** The workload a pod belongs to (ReplicaSet → its Deployment). */
function workloadOf(pod, rsOwner) {
    const o = pod.metadata?.ownerReferences?.[0]
    const ns = pod.metadata?.namespace
    if (!o) return { kind: 'Pod', name: pod.metadata?.name, namespace: ns }
    if (o.kind === 'ReplicaSet') {
        const own = rsOwner.get(`${ns}/${o.name}`)
        if (own?.startsWith('Deployment/')) return { kind: 'Deployment', name: own.slice(11), namespace: ns }
    }
    if (o.kind === 'Job') return { kind: 'Job', name: o.name.replace(/-\d{8,}$/, ''), namespace: ns }
    return { kind: o.kind, name: o.name, namespace: ns }
}

const SECRETISH = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential/i

/**
 * The advisor's facts from ADVISOR_SCRIPT output.
 * rates: { cpu: per core-month, memGb: per GiB-month, currency }
 * → { security: { findings, workloads, score }, cost: { workloads, nodes, savings }, checkedAt }
 */
export function analyze(out, { rates = { cpu: 1100, memGb: 250, currency: '₹' } } = {}) {
    const s = sections(out)
    let pods = []
    try { pods = JSON.parse(s.PODS || '{}').items || [] } catch { }
    const rsOwner = new Map((s.RS || '').split('\n').filter(Boolean).map(l => l.split('\t')))
    const addons = addonNamespaces()
    const nsKind = (ns) => SYSTEM_NS.test(ns) ? 'system' : addons.has(ns) ? 'add-on' : 'app'
    const netpolNs = new Set((s.NETPOL || '').split('\n').filter(Boolean))

    // usage per container from the kubelet summaries
    const usage = new Map()
    for (const body of Object.values(s.USAGE || {})) {
        let j; try { j = JSON.parse(body) } catch { continue }
        for (const p of j.pods || []) for (const c of p.containers || []) usage.set(`${p.podRef?.namespace}/${p.podRef?.name}/${c.name}`, { cpu: (c.cpu?.usageNanoCores || 0) / 1e9, mem: c.memory?.workingSetBytes || 0 })
    }

    const wl = new Map()   // workload key → aggregate
    const findings = []
    const seen = new Set()
    const find = (w, severity, key, text, fix) => {
        const k = `${w.namespace}/${w.kind}/${w.name}|${key}`
        if (seen.has(k)) return
        seen.add(k)
        findings.push({ workload: `${w.kind}/${w.name}`, namespace: w.namespace, scope: nsKind(w.namespace), severity, key, text, fix })
    }
    for (const p of pods) {
        if (['Succeeded', 'Failed'].includes(p.status?.phase)) continue
        const w = workloadOf(p, rsOwner)
        const key = `${w.namespace}/${w.kind}/${w.name}`
        const a = wl.get(key) || { ...w, scope: nsKind(w.namespace), pods: 0, reqCpu: 0, reqMem: 0, limMem: 0, useCpu: 0, useMem: 0, noReq: false, measured: 0 }
        a.pods++
        const spec = p.spec || {}
        if (spec.hostNetwork || spec.hostPID || spec.hostIPC) find(w, 'high', 'host', 'Uses the node\'s network or processes (hostNetwork / hostPID / hostIPC)', 'Remove hostNetwork/hostPID/hostIPC unless it is a node agent.')
        if ((spec.volumes || []).some(v => v.hostPath)) find(w, 'high', 'hostPath', `Mounts folders of the node (${spec.volumes.filter(v => v.hostPath).map(v => v.hostPath.path).slice(0, 3).join(', ')})`, 'Use a PersistentVolumeClaim instead of hostPath.')
        if (spec.automountServiceAccountToken !== false && (!spec.serviceAccountName || spec.serviceAccountName === 'default') && nsKind(w.namespace) === 'app') find(w, 'low', 'sa-token', 'Gets an API token it probably does not need (default ServiceAccount, token mounted)', 'Set automountServiceAccountToken: false.')
        const podRoot = spec.securityContext?.runAsNonRoot !== true && !(spec.securityContext?.runAsUser > 0)
        for (const c of spec.containers || []) {
            const sc = c.securityContext || {}
            if (sc.privileged) find(w, 'high', 'privileged', `Container ${c.name} is privileged — full access to the node`, 'Remove privileged: true; add only the capability it needs.')
            const caps = (sc.capabilities?.add || []).filter(x => /^(ALL|SYS_ADMIN|NET_ADMIN|SYS_PTRACE|SYS_MODULE|DAC_READ_SEARCH)$/i.test(x))
            if (caps.length) find(w, 'high', 'caps', `Container ${c.name} adds ${caps.join(', ')}`, 'Drop these capabilities.')
            for (const e of c.env || []) if (SECRETISH.test(e.name) && e.value && !e.valueFrom) { find(w, 'high', `env-${e.name}`, `${e.name} is set as plain text in the pod spec`, 'Put it in a Secret and use valueFrom.secretKeyRef (or a Sealed Secret).'); break }
            if (podRoot && sc.runAsNonRoot !== true && !(sc.runAsUser > 0)) find(w, 'medium', 'root', 'May run as root (no runAsNonRoot / runAsUser)', 'Set securityContext.runAsNonRoot: true (and a runAsUser) if the image allows.')
            if (!c.image || /:latest$/.test(c.image) || !/:[\w][\w.-]*$|@sha256:/.test(c.image)) find(w, 'medium', 'latest', `Image ${c.image || '?'} has no pinned version`, 'Use a version tag (or a digest) so rollouts are repeatable.')
            const rc = qty(c.resources?.requests?.cpu), rm = qty(c.resources?.requests?.memory), lm = qty(c.resources?.limits?.memory)
            if (!lm) find(w, 'low', 'no-limit', 'No memory limit — one leak can starve the whole node', 'Set resources.limits.memory.')
            if (rc == null || rm == null) a.noReq = true
            a.reqCpu += rc || 0; a.reqMem += rm || 0; a.limMem += lm || 0
            const u = usage.get(`${p.metadata.namespace}/${p.metadata.name}/${c.name}`)
            if (u) { a.useCpu += u.cpu; a.useMem += u.mem; a.measured++ }
        }
        wl.set(key, a)
    }
    // exposure and network isolation
    for (const l of (s.SVC || '').split('\n').filter(Boolean)) {
        const [ref, type] = l.split('\t'); const [ns, name] = ref.split('/')
        if (['NodePort', 'LoadBalancer'].includes(type) && nsKind(ns) === 'app') find({ kind: 'Service', name, namespace: ns }, 'low', 'exposed', `Reachable from outside the cluster (${type})`, 'Use an Ingress with TLS, or ClusterIP if it is internal.')
    }
    const appNs = [...new Set([...wl.values()].filter(a => a.scope === 'app').map(a => a.namespace))]
    for (const ns of appNs) if (!netpolNs.has(ns)) find({ kind: 'Namespace', name: ns, namespace: ns }, 'low', 'netpol', 'No NetworkPolicy — every pod can reach every other pod', 'Add a default-deny policy and allow only the traffic it needs.')
    const W = { high: 10, medium: 4, low: 1 }
    const appFindings = findings.filter(f => f.scope === 'app')
    const secScore = Math.max(0, 100 - appFindings.reduce((a, f) => a + W[f.severity], 0))
    findings.sort((a, b) => W[b.severity] - W[a.severity] || (a.scope === 'app' ? -1 : 1))

    // cost: requests vs real use, per workload
    const costWl = []
    let saveCpu = 0, saveMem = 0
    for (const a of wl.values()) {
        if (!a.measured) continue
        const item = { workload: `${a.kind}/${a.name}`, namespace: a.namespace, scope: a.scope, pods: a.pods, request: { cpu: a.reqCpu, mem: a.reqMem }, use: { cpu: a.useCpu, mem: a.useMem }, advice: null }
        const all = a.pods > 1 ? ` (all ${a.pods} pods together)` : ''
        if (a.noReq) item.advice = { kind: 'no-requests', text: `No requests set — uses ${cores(a.useCpu)} / ${mem(a.useMem)}${all} now; the scheduler cannot plan for it`, suggest: { cpu: Math.max(0.01, a.useCpu * 1.3), mem: Math.max(32 * MB, a.useMem * 1.3) } }
        else if (a.reqCpu - a.useCpu >= 0.25 && a.reqCpu >= 2 * a.useCpu || a.reqMem - a.useMem >= 256 * MB && a.reqMem >= 2 * a.useMem) {
            const sCpu = Math.max(0.01, a.useCpu * 1.3), sMem = Math.max(32 * MB, a.useMem * 1.3)
            const dCpu = Math.max(0, a.reqCpu - sCpu), dMem = Math.max(0, a.reqMem - sMem)
            saveCpu += dCpu; saveMem += dMem
            item.advice = { kind: 'over', text: `Asks for ${cores(a.reqCpu)} / ${mem(a.reqMem)} but uses ${cores(a.useCpu)} / ${mem(a.useMem)}${all}`, suggest: { cpu: Math.min(a.reqCpu, sCpu), mem: Math.min(a.reqMem, sMem) }, saves: { cpu: dCpu, mem: dMem } }
        } else if (a.useCpu > a.reqCpu * 1.2 + 0.05 || a.useMem > a.reqMem * 1.2 + 64 * MB) item.advice = { kind: 'under', text: `Uses more than it asks for (uses ${cores(a.useCpu)} / ${mem(a.useMem)}, asks ${cores(a.reqCpu)} / ${mem(a.reqMem)}${all}) — it can be throttled or evicted first`, suggest: { cpu: Math.max(a.reqCpu, a.useCpu * 1.3), mem: Math.max(a.reqMem, a.useMem * 1.3) } }
        else if (a.kind === 'Deployment' && a.scope === 'app' && a.useCpu < 0.002) item.advice = { kind: 'idle', text: `Almost idle right now (${cores(a.useCpu)}) — scale to 0 if it is not needed` }
        if (item.advice) costWl.push(item)
    }
    const order = { over: 0, under: 1, 'no-requests': 2, idle: 3 }
    costWl.sort((a, b) => order[a.advice.kind] - order[b.advice.kind] || ((b.advice.saves?.cpu || 0) - (a.advice.saves?.cpu || 0)))

    // nodes: allocatable vs requested vs used
    const nodes = (s.NODES || '').split('\n').filter(Boolean).map(l => { const [name, c, m] = l.split('\t'); return { name, cpu: qty(c), mem: qty(m) } })
    const total = { cpu: nodes.reduce((x, n) => x + (n.cpu || 0), 0), mem: nodes.reduce((x, n) => x + (n.mem || 0), 0) }
    const all = [...wl.values()]
    const requested = { cpu: all.reduce((x, a) => x + a.reqCpu, 0), mem: all.reduce((x, a) => x + a.reqMem, 0) }
    const used = { cpu: all.reduce((x, a) => x + a.useCpu, 0), mem: all.reduce((x, a) => x + a.useMem, 0) }
    const monthly = Math.round(saveCpu * rates.cpu + (saveMem / GB) * rates.memGb)

    return {
        checkedAt: new Date().toISOString(),
        security: { score: secScore, findings: findings.slice(0, 150), counts: { high: appFindings.filter(f => f.severity === 'high').length, medium: appFindings.filter(f => f.severity === 'medium').length, low: appFindings.filter(f => f.severity === 'low').length } },
        cost: {
            workloads: costWl.slice(0, 100), rates,
            nodes: { count: nodes.length, total, requested, used },
            savings: { cpu: saveCpu, mem: saveMem, monthly, text: monthly > 0 ? `About ${rates.currency}${monthly.toLocaleString('en-IN')} a month (${cores(saveCpu)} and ${mem(saveMem)} asked for but not used)` : 'Nothing much to save right now' }
        }
    }
}

/** A short text of the findings for the AI summary. */
export function advisorText(a) {
    const sec = a.security.findings.filter(f => f.scope === 'app').slice(0, 25).map(f => `[${f.severity}] ${f.namespace}/${f.workload}: ${f.text}`).join('\n')
    const cost = a.cost.workloads.slice(0, 20).map(w => `${w.namespace}/${w.workload}: ${w.advice.text}`).join('\n')
    return `Security score ${a.security.score}/100 (${a.security.counts.high} high, ${a.security.counts.medium} medium, ${a.security.counts.low} low):\n${sec || 'no findings'}\n\nCost: ${a.cost.savings.text}. Nodes: ${a.cost.nodes.count}, requested ${cores(a.cost.nodes.requested.cpu)} of ${cores(a.cost.nodes.total.cpu)}, used ${cores(a.cost.nodes.used.cpu)} now.\n${cost || 'no cost findings'}`
}
