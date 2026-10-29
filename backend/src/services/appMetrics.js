// Per-app metrics from the cluster's Prometheus (the Monitoring add-on or any
// prometheus-operated / prometheus-server Service): CPU, memory, restarts and
// network of one workload over 1, 6 or 24 hours — read through the Kubernetes
// API's service proxy, so no port is opened.
//
// Registry pull secrets: a private registry's login, written as a
// kubernetes.io/dockerconfigjson Secret into the namespaces you pick (sent on
// stdin — never on a command line), optionally added to their default
// ServiceAccount so pods pull without changing their manifests.
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const bad = (m, status = 400) => Object.assign(new Error(m), { status })
export const RANGES = { '1h': { seconds: 3600, step: 60 }, '6h': { seconds: 6 * 3600, step: 300 }, '24h': { seconds: 86400, step: 900 } }

async function run(connect, cluster, cmd, opts = {}) {
    const ssh = await connect(cluster)
    try { return await ssh.execCommand(cmd, { timeoutMs: 90e3, ...opts }) } finally { ssh.dispose?.() }
}

/** The Prometheus Service of the cluster from "ns name port" lines, or null. */
export function pickPrometheus(lines) {
    const svcs = String(lines || '').split('\n').map(l => l.trim().split(/\s+/)).filter(f => f.length >= 3 && NS.test(f[0]) && NAME.test(f[1]))
    const score = ([, name, ports]) => (/^prometheus-operated$/.test(name) ? 4 : /kube-prometheus-stack-prometheus$|-prometheus$/.test(name) ? 3 : /prometheus-server$/.test(name) ? 2 : /prometheus/.test(name) ? 1 : 0) + (String(ports).split(',').includes('9090') ? 0.5 : 0)
    const best = svcs.filter(s => score(s) >= 1).sort((a, b) => score(b) - score(a))[0]
    if (!best) return null
    const ports = String(best[2]).split(',')
    return { namespace: best[0], name: best[1], port: ports.includes('9090') ? '9090' : ports.includes('80') ? '80' : ports[0] }
}

/** The PromQL of a workload's metrics (names are checked — they go inside quotes). */
export function queries(namespace, kind, name) {
    if (!NS.test(String(namespace)) || !NAME.test(String(name))) throw bad('Not a valid workload')
    const pods = kind === 'StatefulSet' ? `${name}-[0-9]+` : kind === 'DaemonSet' ? `${name}-[a-z0-9]{5}` : `${name}-[a-z0-9]{6,10}-[a-z0-9]{5}`
    const sel = `namespace="${namespace}",pod=~"${pods.replace(/\./g, '\\\\.')}"`
    const c = `${sel},container!="",container!="POD"`
    return {
        cpu: `sum(rate(container_cpu_usage_seconds_total{${c}}[5m]))`,
        memory: `sum(container_memory_working_set_bytes{${c}})`,
        restarts: `sum(increase(kube_pod_container_status_restarts_total{${sel}}[5m]))`,
        netIn: `sum(rate(container_network_receive_bytes_total{${sel}}[5m]))`,
        netOut: `sum(rate(container_network_transmit_bytes_total{${sel}}[5m]))`
    }
}

/** query_range answers → { key: [{ t, v }] } */
export function parseSeries(out) {
    const series = {}
    for (const m of String(out || '').matchAll(/==KZM:([a-zA-Z]+)==\n([\s\S]*?)(?===KZM:|$)/g)) {
        let d
        try { d = JSON.parse(m[2].trim()) } catch { series[m[1]] = null; continue }
        const vals = d?.data?.result?.[0]?.values || []
        series[m[1]] = d?.status === 'success' ? vals.map(([t, v]) => ({ t: Number(t) * 1000, v: Number(v) })).filter(p => Number.isFinite(p.v)) : null
    }
    return series
}

export async function workloadMetrics(cluster, { namespace, kind = 'Deployment', name, range = '1h', now = Date.now() }, { connect = defaultConnect } = {}) {
    const r0 = RANGES[range]
    if (!r0) throw bad(`range: ${Object.keys(RANGES).join(', ')}`)
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind)) throw bad('kind: Deployment, StatefulSet or DaemonSet')
    const qs = queries(namespace, kind, name)
    const svc = await run(connect, cluster, `${KUBECTL} get svc -A -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.name} {range .spec.ports[*]}{.port},{end}{"\\n"}{end}' --request-timeout=30s`)
    if (svc.code) throw bad(`Could not read the Services: ${String(svc.stderr || '').trim().slice(0, 200)}`, 502)
    const prom = pickPrometheus(String(svc.stdout || '').replace(/,(\s|$)/g, '$1'))
    if (!prom) return { prometheus: null, series: {}, why: 'No Prometheus on this cluster — install the Monitoring add-on.' }
    const end = Math.floor(now / 1000), start = end - r0.seconds
    const cmd = Object.entries(qs).map(([k, query]) => {
        const path = `/api/v1/namespaces/${prom.namespace}/services/http:${prom.name}:${prom.port}/proxy/api/v1/query_range?query=${encodeURIComponent(query).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}&start=${start}&end=${end}&step=${r0.step}`
        return `echo '==KZM:${k}=='; ${KUBECTL} get --raw ${q(path)} --request-timeout=30s 2>&1`
    }).join('; ')
    const r = await run(connect, cluster, cmd)
    const out = String(r?.stdout || '')
    if (/forbidden/i.test(out) && !/"status":"success"/.test(out)) return { prometheus: prom, series: {}, why: 'KubeEZ may not reach Prometheus through this cluster\'s API (services/proxy) — switch the cluster to "Full manage".' }
    return { prometheus: prom, range, step: r0.step, series: parseSeries(out), queries: qs }
}

// ── registry pull secrets ──
const SERVER = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{2,5})?(\/[\w.-]+)*$/i
export function cleanRegistry(input) {
    const name = String(input?.name || '').trim().toLowerCase()
    if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) throw bad('Name: lowercase letters, digits and dashes')
    const server = String(input?.server || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (!SERVER.test(server)) throw bad('Registry: a host like ghcr.io, registry.example.com:5000 or docker.io')
    const username = String(input?.username || '').trim()
    if (!username || username.length > 200 || /[\s:]/.test(username)) throw bad('User name: without spaces or ":"')
    return { name, server, username }
}
export const secretName = (reg) => `kubeez-registry-${reg.name}`
/** The Secrets (one per namespace) as a List for kubectl apply. */
export function pullSecrets(reg, namespaces) {
    const auth = Buffer.from(`${reg.username}:${reg.password}`).toString('base64')
    const config = Buffer.from(JSON.stringify({ auths: { [reg.server]: { username: reg.username, password: reg.password, auth } } })).toString('base64')
    return {
        apiVersion: 'v1', kind: 'List',
        items: namespaces.map(ns => ({ apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/dockerconfigjson', metadata: { name: secretName(reg), namespace: ns, labels: { 'app.kubernetes.io/managed-by': 'kubeez' } }, data: { '.dockerconfigjson': config } }))
    }
}
/** Write the pull secret into the namespaces (and add it to their default ServiceAccount). */
export async function syncRegistry(cluster, reg, namespaces, { defaultServiceAccount = false, connect = defaultConnect } = {}) {
    const list = [...new Set(namespaces || [])]
    if (!list.length || list.length > 50 || list.some(n => !NS.test(n))) throw bad('Namespaces: 1–50 valid names')
    if (!reg?.password) throw bad('This registry has no password saved')
    const r = await run(connect, cluster, `${KUBECTL} apply -f - --request-timeout=30s`, { stdin: JSON.stringify(pullSecrets(reg, list)) })
    if (r.code) throw bad(`The cluster refused it: ${String(r.stderr || '').trim().slice(0, 300)}`, 502)
    const linked = []
    if (defaultServiceAccount) {
        for (const ns of list) {
            const cur = await run(connect, cluster, `${KUBECTL} -n ${q(ns)} get serviceaccount default -o jsonpath='{range .imagePullSecrets[*]}{.name}{"\\n"}{end}' --request-timeout=20s`)
            const names = String(cur.stdout || '').split('\n').filter(Boolean)
            if (names.includes(secretName(reg))) { linked.push(ns); continue }
            // the full list: a merge patch replaces it, so the ones already there are kept
            const p = { imagePullSecrets: [...names, secretName(reg)].map(name => ({ name })) }
            const pr = await run(connect, cluster, `${KUBECTL} -n ${q(ns)} patch serviceaccount default --type merge -p ${q(JSON.stringify(p))} --request-timeout=20s`)
            if (!pr.code) linked.push(ns)
        }
    }
    return { secret: secretName(reg), namespaces: list, linked, message: `${secretName(reg)} written to ${list.length} namespace${list.length === 1 ? '' : 's'}${defaultServiceAccount ? `; default ServiceAccount uses it in ${linked.length}` : ''}.` }
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}
export const _test = { useConnect(fn) { testConnect = fn } }
