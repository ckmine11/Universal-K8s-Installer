// Cost per app and namespace: what the running pods ask for (CPU / memory
// requests) at the workspace's prices, per month (730 h) — and, where
// metrics-server answers, what they really use and the money left idle.
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
const T = '{"\\t"}', N = '{"\\n"}'
export const COST_SCRIPT = [
    `echo '==KZC:PODS=='; ${KUBECTL} get pods -A --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.metadata.name}${T}{.metadata.ownerReferences[0].kind}${T}{.metadata.ownerReferences[0].name}${T}{range .spec.containers[*]}{.resources.requests.cpu},{.resources.requests.memory};{end}${N}{end}' --request-timeout=50s 2>/dev/null | head -c 8000000`,
    `echo '==KZC:TOP=='; ${KUBECTL} top pods -A --no-headers --request-timeout=30s 2>/dev/null | head -c 4000000`,
    `echo '==KZC:END=='`
].join('; ')
export const DEFAULT_RATES = { currency: 'INR', cpuHour: 2.5, memGiBHour: 0.35 }
const HOURS = 730

/** "250m" → 0.25 cores, "2" → 2 */
export function cpu(s) { const m = /^(\d+(?:\.\d+)?)(m)?$/.exec(String(s || '').trim()); return m ? Number(m[1]) / (m[2] ? 1000 : 1) : 0 }
/** "512Mi" / "1Gi" / "1G" / bytes → GiB */
export function mem(s) {
    const m = /^(\d+(?:\.\d+)?)([KMGT]i?|[kmgt])?$/.exec(String(s || '').trim())
    if (!m) return 0
    const f = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, k: 1e3, M: 1e6, m: 1e-3, G: 1e9, g: 1e9, T: 1e12, t: 1e12 }[m[2]] ?? 1
    return Number(m[1]) * f / 2 ** 30
}
// a pod's app: Deployment from its ReplicaSet, or its own owner
const appOf = (kind, name, pod) => kind === 'ReplicaSet' ? { kind: 'Deployment', name: String(name).replace(/-[a-z0-9]{6,10}$/, '') } : kind ? { kind, name } : { kind: 'Pod', name: pod }

/** COST_SCRIPT output + rates → per namespace and per app, monthly. match(ns) limits namespaces. */
export function computeCosts(out, rates = DEFAULT_RATES, { match = null } = {}) {
    const sec = {}
    for (const m of String(out || '').matchAll(/==KZC:([A-Z]+)==\n?([\s\S]*?)(?===KZC:|$)/g)) sec[m[1]] = m[2]
    const usage = new Map()
    for (const line of String(sec.TOP || '').split('\n')) { const f = line.trim().split(/\s+/); if (f.length >= 4) usage.set(`${f[0]}/${f[1]}`, { cpu: cpu(f[2]), mem: mem(f[3]) }) }
    const hasUsage = usage.size > 0
    const price = (c, g) => (c * rates.cpuHour + g * rates.memGiBHour) * HOURS
    const apps = new Map()
    for (const line of String(sec.PODS || '').split('\n').filter(Boolean)) {
        const [ns, pod, kind, owner, ctrs = ''] = line.split('\t')
        if (!ns || !pod || (match && !match(ns))) continue
        let c = 0, g = 0
        for (const x of ctrs.split(';').filter(Boolean)) { const [rc, rm] = x.split(','); c += cpu(rc); g += mem(rm) }
        const a = appOf(kind, owner, pod)
        const k = `${ns}|${a.kind}|${a.name}`
        const cur = apps.get(k) || { namespace: ns, kind: a.kind, name: a.name, pods: 0, cpu: 0, memGiB: 0, usedCpu: 0, usedMemGiB: 0, noRequests: 0 }
        cur.pods++; cur.cpu += c; cur.memGiB += g
        if (!c && !g) cur.noRequests++
        const u = usage.get(`${ns}/${pod}`); if (u) { cur.usedCpu += u.cpu; cur.usedMemGiB += u.mem }
        apps.set(k, cur)
    }
    const round = (n) => Math.round(n * 100) / 100
    const list = [...apps.values()].map(a => ({
        ...a, cpu: round(a.cpu), memGiB: round(a.memGiB), usedCpu: hasUsage ? round(a.usedCpu) : null, usedMemGiB: hasUsage ? round(a.usedMemGiB) : null,
        monthly: Math.round(price(a.cpu, a.memGiB)),
        idleMonthly: hasUsage ? Math.round(price(Math.max(0, a.cpu - a.usedCpu), Math.max(0, a.memGiB - a.usedMemGiB))) : null
    })).sort((x, y) => y.monthly - x.monthly || x.name.localeCompare(y.name))
    const nsMap = new Map()
    for (const a of list) { const n = nsMap.get(a.namespace) || { namespace: a.namespace, apps: 0, monthly: 0, idleMonthly: hasUsage ? 0 : null }; n.apps++; n.monthly += a.monthly; if (hasUsage) n.idleMonthly += a.idleMonthly; nsMap.set(a.namespace, n) }
    const namespaces = [...nsMap.values()].sort((x, y) => y.monthly - x.monthly)
    return {
        rates, hasUsage, total: namespaces.reduce((s, n) => s + n.monthly, 0), idle: hasUsage ? namespaces.reduce((s, n) => s + n.idleMonthly, 0) : null,
        namespaces, apps: list.slice(0, 100), noRequests: list.filter(a => a.noRequests).map(a => `${a.namespace}/${a.name}`).slice(0, 30)
    }
}
export function cleanRates(b) {
    const currency = String(b?.currency || 'INR').toUpperCase()
    const cpuHour = Number(b?.cpuHour), memGiBHour = Number(b?.memGiBHour)
    if (!/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('Currency: a 3-letter code (INR, USD…)'), { status: 400 })
    if (!(cpuHour >= 0 && cpuHour < 1e4) || !(memGiBHour >= 0 && memGiBHour < 1e4)) throw Object.assign(new Error('Prices: per vCPU-hour and per GiB-hour, 0 or more'), { status: 400 })
    return { currency, cpuHour, memGiBHour }
}
export async function readCosts(cluster, rates, { match, connect } = {}) {
    const c = connect || (async (cl) => (await import('./clusterAccess.js')).connectCluster(cl))
    const ssh = await c(cluster)
    let r
    try { r = await ssh.execCommand(COST_SCRIPT, { timeoutMs: 120e3 }) } finally { ssh.dispose?.() }
    if (!String(r?.stdout || '').includes('==KZC:END==')) throw Object.assign(new Error('Could not read the cluster'), { status: 502 })
    return computeCosts(r.stdout, rates, { match })
}
