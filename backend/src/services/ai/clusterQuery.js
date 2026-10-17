// Questions about what is IN a cluster — "how many namespaces", "kitne pod
// chal rahe hain", "kaunse pod fail ho rahe", "nodes dikhao", "shop me
// deployments" — are answered from the live cluster, exactly and in a second
// or two, without AI. One read-only look (cached 60 s) also gives the AI a
// summary for the questions it does answer, so it does not guess.
const K = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 30 kubectl'
const T = '{"\\t"}', N = '{"\\n"}'
const CAP = 'head -c 3000000'
export const SNAPSHOT_SCRIPT = [
    `echo '==NS=='; ${K} get ns -o jsonpath='{range .items[*]}{.metadata.name}${T}{.status.phase}${T}{.metadata.creationTimestamp}${N}{end}' 2>/dev/null`,
    `echo '==NODES=='; ${K} get nodes -o jsonpath='{range .items[*]}{.metadata.name}${T}{.status.conditions[?(@.type=="Ready")].status}${T}{.status.nodeInfo.kubeletVersion}${T}{.status.capacity.cpu}${T}{.status.capacity.memory}${T}{.metadata.labels}${T}{.status.addresses[?(@.type=="InternalIP")].address}${T}{.spec.unschedulable}${N}{end}' 2>/dev/null`,
    `echo '==PODS=='; ${K} get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.status.phase}${T}{range .status.containerStatuses[*]}{.ready}{","}{end}${T}{range .status.containerStatuses[*]}{.restartCount}{","}{end}${T}{range .status.containerStatuses[*]}{.state.waiting.reason}{.state.terminated.reason}{","}{end}${T}{.spec.nodeName}${T}{.metadata.ownerReferences[0].kind}${T}{range .spec.containers[*]}{.image}{" "}{end}${N}{end}' 2>/dev/null | ${CAP}`,
    `echo '==DEPLOY=='; ${K} get deploy -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.spec.replicas}${T}{.status.readyReplicas}${N}{end}' 2>/dev/null`,
    `echo '==STS=='; ${K} get sts -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.spec.replicas}${T}{.status.readyReplicas}${N}{end}' 2>/dev/null`,
    `echo '==DS=='; ${K} get ds -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.status.desiredNumberScheduled}${T}{.status.numberReady}${N}{end}' 2>/dev/null`,
    `echo '==SVC=='; ${K} get svc -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.spec.type}${T}{.spec.clusterIP}${T}{range .spec.ports[*]}{.port}{","}{end}${N}{end}' 2>/dev/null`,
    `echo '==PVC=='; ${K} get pvc -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.status.phase}${T}{.status.capacity.storage}${T}{.spec.storageClassName}${N}{end}' 2>/dev/null`,
    `echo '==ING=='; ${K} get ingress -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{range .spec.rules[*]}{.host}{","}{end}${N}{end}' 2>/dev/null`,
    `echo '==JOBS=='; ${K} get cronjobs -A -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.spec.schedule}${T}{.status.lastScheduleTime}${N}{end}' 2>/dev/null`,
    `echo '==EVENTS=='; ${K} get events -A --field-selector type=Warning --sort-by=.lastTimestamp -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.involvedObject.kind}/{.involvedObject.name}${T}{.reason}${T}{.message}${T}{.lastTimestamp}${N}{end}' 2>/dev/null | tail -40`,
    `echo '==END=='`
].join('; ')

const rows = (t) => String(t || '').split('\n').filter(Boolean).map(l => l.split('\t'))
const list = (s) => String(s || '').split(',').filter(x => x !== '')
const GiB = (q) => { const m = /^(\d+)(Ki|Mi|Gi)?$/.exec(String(q || '')); if (!m) return null; const n = Number(m[1]); return m[2] === 'Ki' ? n / 1024 ** 2 : m[2] === 'Mi' ? n / 1024 : n }

/** The script's output → a snapshot of the cluster */
export function parseSnapshot(out) {
    const s = {}
    for (const part of String(out || '').split(/^==(?=[A-Z]+==)/m)) { const m = /^([A-Z]+)==\n?/.exec(part); if (m) s[m[1]] = part.slice(m[0].length).trim() }
    const pods = rows(s.PODS).map(([ns, name, phase, ready, restarts, reasons, node, owner, images]) => {
        const r = list(ready), why = list(reasons).find(x => x && !['Completed'].includes(x)) || null
        return { ns, name, phase, ready: r.length ? r.filter(x => x === 'true').length : 0, containers: r.length, restarts: list(restarts).reduce((a, x) => a + (Number(x) || 0), 0), reason: why, node: node || null, owner: owner || null, images: String(images || '').trim().split(/\s+/).filter(Boolean) }
    })
    return {
        at: new Date().toISOString(),
        namespaces: rows(s.NS).map(([name, phase, created]) => ({ name, phase, created })),
        nodes: rows(s.NODES).map(([name, ready, version, cpu, mem, cp, ip, unsched]) => ({ name, ready: ready === 'True', version, cpu: Number(cpu) || null, memGiB: GiB(mem), controlPlane: /node-role\.kubernetes\.io\/(control-plane|master)"/.test(cp || ''), ip, cordoned: unsched === 'true' })),
        pods,
        deployments: rows(s.DEPLOY).map(([ns, name, want, ready]) => ({ ns, name, want: Number(want) || 0, ready: Number(ready) || 0 })),
        statefulsets: rows(s.STS).map(([ns, name, want, ready]) => ({ ns, name, want: Number(want) || 0, ready: Number(ready) || 0 })),
        daemonsets: rows(s.DS).map(([ns, name, want, ready]) => ({ ns, name, want: Number(want) || 0, ready: Number(ready) || 0 })),
        services: rows(s.SVC).map(([ns, name, type, ip, ports]) => ({ ns, name, type, ip, ports: list(ports) })),
        pvcs: rows(s.PVC).map(([ns, name, phase, size, sc]) => ({ ns, name, phase, size, storageClass: sc || null })),
        ingresses: rows(s.ING).map(([ns, name, hosts]) => ({ ns, name, hosts: list(hosts) })),
        cronjobs: rows(s.JOBS).map(([ns, name, schedule, last]) => ({ ns, name, schedule, last: last || null })),
        warnings: rows(s.EVENTS).map(([ns, obj, reason, message, at]) => ({ ns, obj, reason, message, at })).reverse()
    }
}

/** Only what this member may see: namespace-limited members get their namespaces only. */
export function limitSnapshot(snap, allowed) {
    if (!allowed) return snap
    const ok = (ns) => allowed(ns)
    const f = (arr) => arr.filter(x => ok(x.ns))
    return { ...snap, limited: true, namespaces: snap.namespaces.filter(n => ok(n.name)), pods: f(snap.pods), deployments: f(snap.deployments), statefulsets: f(snap.statefulsets), daemonsets: f(snap.daemonsets), services: f(snap.services), pvcs: f(snap.pvcs), ingresses: f(snap.ingresses), cronjobs: f(snap.cronjobs), warnings: f(snap.warnings) }
}

const cache = new Map()   // clusterId → { at, snap, promise }
/** The live snapshot of one cluster (one SSH call, cached 60 s, one at a time). */
export async function snapshotOf(cluster, { fresh = false } = {}) {
    const hit = cache.get(cluster.id)
    if (hit?.promise) return hit.promise
    if (hit && !fresh && Date.now() - hit.at < 60e3) return hit.snap
    const { onCluster } = await import('./incidentExplain.js')
    const promise = onCluster(cluster, (ssh) => ssh.execCommand(SNAPSHOT_SCRIPT)).then(r => {
        const out = r.stdout || ''
        if (!/==END==/.test(out)) throw new Error('the cluster did not answer')
        const snap = parseSnapshot(out)
        cache.set(cluster.id, { at: Date.now(), snap })
        return snap
    }).catch(e => { cache.delete(cluster.id); throw e })
    cache.set(cluster.id, { ...hit, promise })
    return promise
}
export function _resetSnapshots() { cache.clear() }
export function _setSnapshot(clusterId, snap) { cache.set(clusterId, { at: Date.now(), snap }) }

// ── what was asked ──
const RESOURCES = [
    ['namespaces', /\b(namespaces?|ns)\b/],
    ['nodes', /\b(nodes?|machines?|servers?|vms?)\b/],
    ['pods', /\b(pods?|containers?)\b/],
    ['deployments', /\b(deployments?|deploys?|apps?|applications?)\b/],
    ['statefulsets', /\b(statefulsets?|sts|databases?)\b/],
    ['daemonsets', /\b(daemonsets?|ds)\b/],
    ['services', /\b(services?|svc)\b/],
    ['pvcs', /\b(pvcs?|volumes?|storage|disks?|persistentvolumeclaims?)\b/],
    ['ingresses', /\b(ingress(es)?|domains?|hosts?|urls?)\b/],
    ['cronjobs', /\b(cron ?jobs?|scheduled jobs?)\b/],
    ['warnings', /\b(warnings?|events?|errors?)\b/],
    ['images', /\b(images?)\b/],
    ['version', /\b(versions?|kubernetes version|k8s version)\b/],
    ['usage', /\b(capacity|resources?|cpu|memory|ram)\b/]
]
const COUNT = /\b(how many|kitne|kitna|kitni|count|number of|total)\b|कितने|कितना/
const BAD = /\b(fail\w*|crash\w*|not (running|ready|healthy)|pending|error\w*|kharab|band|down|unhealthy|problem|issue|broken|restart\w*|stuck)\b|खराब/
const SHOW = /\b(list|show|dikhao|dikha|batao|bata|kaun ?se|which|what are|sab|saare|all|names?)\b|दिखाओ|बताओ/

// how-to and "why" questions, and requests to do something, are for the AI
const HOWTO = /\b(how (do|to|can|should|does)|kaise|why|kyu|kyun|kyon|explain|samjhao|what is an?|what does|kya hota|difference|vs|best practices?|create|make|bana\w*|generate|write|likh\w*|install|delete|remove|hata\w*|scale|upgrade|configure|setup|set up|yaml)\b|कैसे|क्यों/

/** Is this a question about what is in the cluster? → { resource, count, bad, ns } | null */
export function queryOf(text, namespaces = []) {
    const t = ` ${String(text || '').toLowerCase()} `
    if (HOWTO.test(t) && !COUNT.test(t)) return null
    const r = RESOURCES.find(([, re]) => re.test(t))
    if (!r) return null
    // a namespace that exists, named in the question ("in shop", "shop me", "namespace shop")
    const ns = namespaces.map(n => n.name).sort((a, b) => b.length - a.length).find(n => new RegExp(`(^|[^a-z0-9-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`).test(t) && r[0] !== 'namespaces') || null
    return { resource: r[0], count: COUNT.test(t), bad: BAD.test(t), show: SHOW.test(t), ns }
}

// ── the answer ──
const W = {
    en: { has: (c, n, what) => `${c} has ${n} ${one(n, what)}`, none: (c, what) => `${c}: no ${what}`, in: (ns) => ` in ${ns}`, allOk: 'all healthy', notOk: 'not healthy', more: (n) => `… and ${n} more` },
    hinglish: { has: (c, n, what) => `${c} me ${n} ${one(n, what)} ${n === 1 ? 'hai' : 'hain'}`, none: (c, what) => `${c}: koi ${what} nahi`, in: (ns) => ` (${ns} me)`, allOk: 'sab theek', notOk: 'theek nahi', more: (n) => `… aur ${n}` },
    hi: { has: (c, n, what) => `${c} में ${n} ${one(n, what)} ${n === 1 ? 'है' : 'हैं'}`, none: (c, what) => `${c}: कोई ${what} नहीं`, in: (ns) => ` (${ns} में)`, allOk: 'सब ठीक', notOk: 'ठीक नहीं', more: (n) => `… और ${n}` }
}
// "1 node", not "1 nodes" (the first word: namespaces → namespace, ingresses → ingress)
const one = (n, what) => n !== 1 ? what : what.replace(/^(\w+?)(sses|s)\b/, (m, w, e) => e === 'sses' ? `${w}ss` : w)
const cap = (arr, n, L) => arr.length > n ? [...arr.slice(0, n), L.more(arr.length - n)] : arr
const healthy = (p) => (p.phase === 'Running' && p.ready === p.containers) || p.phase === 'Succeeded'
const podLine = (p) => `${p.ns}/${p.name} — ${p.reason || p.phase}${p.containers ? ` (${p.ready}/${p.containers} ready` : ''}${p.restarts ? `, ${p.restarts} restarts` : ''}${p.containers ? ')' : ''}`

/** A direct answer from the snapshot (null = not a question for this). */
export function answerQuery(q, snap, clusterName, lang = 'en') {
    const L = W[lang] || W.en
    const where = q.ns ? L.in(q.ns) : ''
    const inNs = (arr) => q.ns ? arr.filter(x => x.ns === q.ns) : arr
    const c = clusterName
    switch (q.resource) {
        case 'namespaces': {
            const n = snap.namespaces
            const sys = n.filter(x => /^kube-/.test(x.name)).length
            return `${L.has(c, n.length, 'namespaces')}${snap.limited ? ' (that you may see)' : ''}${sys ? ` — ${n.length - sys} yours + ${sys} system` : ''}:\n${n.map(x => `• ${x.name}${x.phase !== 'Active' ? ` (${x.phase})` : ''}`).join('\n')}`
        }
        case 'nodes': {
            const n = snap.nodes, down = n.filter(x => !x.ready)
            return `${L.has(c, n.length, 'nodes')} — ${n.filter(x => x.ready).length} Ready${down.length ? `, ${down.length} NOT ready` : ''}:\n${n.map(x => `• ${x.name} — ${x.ready ? 'Ready' : 'NOT ready'}${x.cordoned ? ', cordoned' : ''} · ${x.controlPlane ? 'control-plane' : 'worker'} · ${x.version} · ${x.cpu || '?'} CPU / ${x.memGiB ? x.memGiB.toFixed(1) : '?'} GiB${x.ip ? ` · ${x.ip}` : ''}`).join('\n')}`
        }
        case 'pods': {
            const p = inNs(snap.pods), bad = p.filter(x => !healthy(x))
            const byPhase = Object.entries(p.reduce((m, x) => { const k = x.reason && !healthy(x) ? x.reason : x.phase; m[k] = (m[k] || 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')
            if (!p.length) return L.none(c, `pods${where}`)
            const head = `${L.has(c, p.length, `pods${where}`)} — ${byPhase}.`
            if (q.bad || bad.length) return `${head}\n${bad.length ? `${L.notOk} (${bad.length}):\n${cap(bad.map(podLine), 15, L).map(x => `• ${x}`).join('\n')}` : `✅ ${L.allOk}`}`
            const byNs = Object.entries(p.reduce((m, x) => { m[x.ns] = (m[x.ns] || 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1])
            return `${head} ✅ ${L.allOk}.${q.ns ? `\n${cap(p.map(x => `• ${x.name}`), 25, L).join('\n')}` : `\n${byNs.map(([ns, k]) => `• ${ns}: ${k}`).join('\n')}`}`
        }
        case 'deployments': case 'statefulsets': case 'daemonsets': {
            const label = { deployments: 'deployments', statefulsets: 'statefulsets', daemonsets: 'daemonsets' }[q.resource]
            const all = inNs(snap[q.resource]), bad = all.filter(x => x.ready < x.want)
            if (!all.length) return L.none(c, `${label}${where}`)
            const shown = q.bad ? bad : all
            return `${L.has(c, all.length, `${label}${where}`)}${bad.length ? ` — ${bad.length} ${L.notOk}` : ` — ✅ ${L.allOk}`}:\n${cap(shown.map(x => `• ${x.ns}/${x.name} — ${x.ready}/${x.want} ready${x.ready < x.want ? ' ⚠' : ''}`), 30, L).join('\n')}`
        }
        case 'services': {
            const s = inNs(snap.services)
            if (!s.length) return L.none(c, `services${where}`)
            const ext = s.filter(x => x.type !== 'ClusterIP')
            return `${L.has(c, s.length, `services${where}`)}${ext.length ? ` — ${ext.length} reachable from outside (${ext.map(x => `${x.name}: ${x.type}`).join(', ')})` : ''}:\n${cap(s.map(x => `• ${x.ns}/${x.name} — ${x.type} ${x.ip}${x.ports.length ? ` :${x.ports.join(',')}` : ''}`), 30, L).join('\n')}`
        }
        case 'pvcs': {
            const v = inNs(snap.pvcs), pend = v.filter(x => x.phase !== 'Bound')
            if (!v.length) return L.none(c, `volumes (PVCs)${where}`)
            return `${L.has(c, v.length, `volumes (PVCs)${where}`)}${pend.length ? ` — ${pend.length} not bound` : ''}:\n${cap(v.map(x => `• ${x.ns}/${x.name} — ${x.phase}${x.size ? ` · ${x.size}` : ''}${x.storageClass ? ` · ${x.storageClass}` : ''}`), 30, L).join('\n')}`
        }
        case 'ingresses': {
            const i = inNs(snap.ingresses)
            if (!i.length) return L.none(c, `ingresses${where}`)
            return `${L.has(c, i.length, `ingresses${where}`)}:\n${i.map(x => `• ${x.ns}/${x.name} — ${x.hosts.join(', ') || 'every host'}`).join('\n')}`
        }
        case 'cronjobs': {
            const j = inNs(snap.cronjobs)
            if (!j.length) return L.none(c, `cronjobs${where}`)
            return `${L.has(c, j.length, `cronjobs${where}`)}:\n${j.map(x => `• ${x.ns}/${x.name} — "${x.schedule}"${x.last ? `, last ran ${x.last}` : ', never ran yet'}`).join('\n')}`
        }
        case 'warnings': {
            const w = inNs(snap.warnings)
            if (!w.length) return `✅ ${L.none(c, `warning events${where}`)}`
            return `${c}: the latest ${Math.min(w.length, 12)} warning event(s)${where}:\n${w.slice(0, 12).map(x => `• ${x.ns} ${x.obj}: ${x.reason} — ${String(x.message).slice(0, 140)}`).join('\n')}`
        }
        case 'images': {
            const imgs = {}
            for (const p of inNs(snap.pods)) for (const i of p.images) imgs[i] = (imgs[i] || 0) + 1
            const e = Object.entries(imgs).sort((a, b) => b[1] - a[1])
            const latest = e.filter(([i]) => /:latest$/.test(i) || !/:/.test(i.split('/').pop()))
            return `${L.has(c, e.length, `images in use${where}`)}${latest.length ? ` — ${latest.length} without a pinned version` : ''}:\n${cap(e.map(([i, n]) => `• ${i} (${n} pod${n > 1 ? 's' : ''})`), 30, L).join('\n')}`
        }
        case 'version': {
            const v = [...new Set(snap.nodes.map(n => n.version))]
            return `${c}: Kubernetes ${v.join(', ')}${v.length > 1 ? ' — the nodes run different versions' : ''} (${snap.nodes.length} ${one(snap.nodes.length, 'nodes')})`
        }
        case 'usage': {
            const cpu = snap.nodes.reduce((a, n) => a + (n.cpu || 0), 0), mem = snap.nodes.reduce((a, n) => a + (n.memGiB || 0), 0)
            return `${c}: ${snap.nodes.length} nodes with ${cpu} CPU and ${mem.toFixed(1)} GiB memory in total; ${snap.pods.filter(p => p.phase === 'Running').length} pods running. For who uses what, open AI → Advisor.`
        }
    }
    return null
}

/** A short summary for the AI (so it answers from the real cluster, not from memory). */
export function snapshotText(snap, clusterName) {
    const bad = snap.pods.filter(p => !healthy(p))
    return [
        `Cluster ${clusterName} (live, ${snap.at}):`,
        `Nodes ${snap.nodes.length}: ${snap.nodes.map(n => `${n.name} ${n.ready ? 'Ready' : 'NotReady'} ${n.controlPlane ? 'control-plane' : 'worker'} ${n.version} ${n.cpu}cpu/${n.memGiB?.toFixed(1)}GiB`).join('; ')}`,
        `Namespaces ${snap.namespaces.length}: ${snap.namespaces.map(n => n.name).join(', ')}`,
        `Pods ${snap.pods.length} (${snap.pods.filter(p => p.phase === 'Running').length} running); not healthy: ${bad.slice(0, 15).map(podLine).join('; ') || 'none'}`,
        `Deployments ${snap.deployments.length}: ${snap.deployments.slice(0, 40).map(d => `${d.ns}/${d.name} ${d.ready}/${d.want}`).join(', ')}`,
        `StatefulSets: ${snap.statefulsets.map(d => `${d.ns}/${d.name} ${d.ready}/${d.want}`).join(', ') || 'none'}; DaemonSets: ${snap.daemonsets.map(d => `${d.ns}/${d.name} ${d.ready}/${d.want}`).join(', ') || 'none'}`,
        `Services ${snap.services.length}; PVCs ${snap.pvcs.length} (${snap.pvcs.filter(p => p.phase !== 'Bound').length} not bound); Ingresses: ${snap.ingresses.map(i => i.hosts.join(',') || i.name).join(', ') || 'none'}`,
        `Recent warnings: ${snap.warnings.slice(0, 8).map(w => `${w.ns} ${w.obj} ${w.reason}: ${String(w.message).slice(0, 100)}`).join(' | ') || 'none'}`
    ].join('\n').slice(0, 6000)
}
