// Security view: what the Trivy Operator found in a cluster — image
// vulnerabilities per workload (critical / high with the package and the fixed
// version) and misconfigurations — read from its reports, never re-scanned here.
//
// Only CRITICAL and HIGH vulnerabilities are listed one by one (with counts for
// the rest), so a big cluster's reports stay small to read. Exposed-secret
// reports are never read: their findings quote the secret.
import { crdSection, splitSections, listError } from './kubeList.js'

const TAG = 'KZSEC'
const T = '{"\\t"}'
const N = '{"\\n"}'
// trivy-operator's labels on a report: trivy-operator.resource.kind …
const L = (k) => `{.metadata.labels.trivy-operator\\.${k.replace(/\./g, '\\.')}}`
const each = (path, sev, fields) => ['CRITICAL', 'HIGH'].map(s => `{range ${path}[?(@.severity=="${s}")]}${sev}${T}${fields.join(T)}${N}{end}`).join('')

const VULN_PATH = `jsonpath='{range .items[*]}R${T}{.metadata.namespace}${T}{.metadata.name}${T}${L('resource.kind')}${T}${L('resource.name')}${T}${L('container.name')}${T}{.report.registry.server}${T}{.report.artifact.repository}${T}{.report.artifact.tag}${T}{.report.summary.criticalCount}${T}{.report.summary.highCount}${T}{.report.summary.mediumCount}${T}{.report.summary.lowCount}${T}{.report.updateTimestamp}${N}${each('.report.vulnerabilities', 'V', ['{.severity}', '{.vulnerabilityID}', '{.resource}', '{.installedVersion}', '{.fixedVersion}', '{.score}', '{.title}'])}{end}'`
const AUDIT_PATH = `jsonpath='{range .items[*]}C${T}{.metadata.namespace}${T}${L('resource.kind')}${T}${L('resource.name')}${T}{.report.summary.criticalCount}${T}{.report.summary.highCount}${T}{.report.summary.mediumCount}${T}{.report.summary.lowCount}${N}${each('.report.checks', 'K', ['{.severity}', '{.checkID}', '{.success}', '{.title}'])}{end}'`

export const SECURITY_SCRIPT = [
    crdSection(TAG, 'VULN', 'vulnerabilityreports.aquasecurity.github.io', `-o ${VULN_PATH}`, 20_000_000),
    crdSection(TAG, 'AUDIT', 'configauditreports.aquasecurity.github.io', `-o ${AUDIT_PATH}`, 8_000_000),
    `echo '==${TAG}:END=='`
].join('; ')

const str = (v, n = 200) => v == null || v === '' ? null : String(v).replace(/[\t\r\n]+/g, ' ').trim().slice(0, n) || null
const num = (v) => Number.isFinite(Number(v)) && v !== '' ? Number(v) : 0
const at = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString() }
const SEV_RANK = { CRITICAL: 0, HIGH: 1 }

/**
 * The workload a report is about. trivy-operator scans a Deployment through
 * its ReplicaSet (web-7d9fc8b6c) — that is shown as the Deployment (web).
 */
export function workloadOf(kind, name) {
    if (kind === 'ReplicaSet') { const m = /^(.+)-[a-z0-9]{6,10}$/.exec(name || ''); if (m) return { kind: 'Deployment', name: m[1] } }
    if (kind === 'Job') { const m = /^(.+)-\d{8,}$/.exec(name || ''); if (m) return { kind: 'CronJob', name: m[1] } }
    return { kind: kind || 'Pod', name: name || '?' }
}

/** "index.docker.io" + "library/nginx" + "1.25" → "nginx:1.25" */
export function imageName(server, repo, tag) {
    if (!repo) return null
    const hub = !server || /^(index\.)?docker\.io$/.test(server)
    return `${hub ? String(repo).replace(/^library\//, '') : `${server}/${repo}`}${tag ? `:${tag}` : ''}`
}

/** The SECURITY_SCRIPT output → { reports, audits, tools } (one entry per report). */
export function parseSecurity(out) {
    const s = splitSections(out, TAG)
    const tools = {}
    const reports = [], audits = []
    if (s.VULN_ERR != null) tools.vulnerabilities = listError(s.VULN_ERR, 'vulnerabilityreports.aquasecurity.github.io')
    else if (s.VULN != null) {
        tools.vulnerabilities = { state: 'ok' }
        let cur = null
        for (const line of s.VULN.split('\n')) {
            const f = line.split('\t')
            if (f[0] === 'R' && f.length >= 14) {
                const w = workloadOf(f[3], f[4])
                cur = {
                    namespace: f[1], report: f[2], kind: w.kind, name: w.name, container: str(f[5], 100) || '?',
                    image: str(imageName(f[6], f[7], f[8]), 300),
                    counts: { critical: num(f[9]), high: num(f[10]), medium: num(f[11]), low: num(f[12]) },
                    updatedAt: at(f[13]), vulns: []
                }
                reports.push(cur)
            } else if (f[0] === 'V' && cur && f.length >= 8 && SEV_RANK[f[1]] != null) {
                cur.vulns.push({ severity: f[1], id: str(f[2], 60), pkg: str(f[3], 120), installed: str(f[4], 80), fixed: str(f[5], 120), score: f[6] ? Number(f[6]) || null : null, title: str(f.slice(7).join(' '), 200) })
            }
        }
    }
    if (s.AUDIT_ERR != null) tools.configAudit = listError(s.AUDIT_ERR, 'configauditreports.aquasecurity.github.io')
    else if (s.AUDIT != null) {
        tools.configAudit = { state: 'ok' }
        let cur = null
        for (const line of s.AUDIT.split('\n')) {
            const f = line.split('\t')
            if (f[0] === 'C' && f.length >= 8) {
                const w = workloadOf(f[2], f[3])
                cur = { namespace: f[1], kind: w.kind, name: w.name, counts: { critical: num(f[4]), high: num(f[5]), medium: num(f[6]), low: num(f[7]) }, checks: [] }
                audits.push(cur)
            } else if (f[0] === 'K' && cur && f.length >= 5 && f[3] === 'false' && SEV_RANK[f[1]] != null) {
                cur.checks.push({ severity: f[1], id: str(f[2], 40), title: str(f.slice(4).join(' '), 200) })
            }
        }
    }
    tools.vulnerabilities ||= { state: 'missing' }
    tools.configAudit ||= { state: 'missing' }
    return { reports, audits, tools }
}

const add = (a, b) => { for (const k of ['critical', 'high', 'medium', 'low']) a[k] += b[k] || 0; return a }
const zero = () => ({ critical: 0, high: 0, medium: 0, low: 0 })
const byRisk = (a, b) => b.counts.critical - a.counts.critical || b.counts.high - a.counts.high || b.counts.medium - a.counts.medium || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
const vulnOrder = (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || (b.score || 0) - (a.score || 0) || String(a.id).localeCompare(String(b.id))

/**
 * Per workload and per CVE, for the page. `match(ns)` limits it to the
 * namespaces a member may see (null = whole cluster).
 */
export function summarizeSecurity({ reports, audits, tools }, { match = null, maxVulns = 40, maxCves = 100 } = {}) {
    const ok = (ns) => !match || match(ns)
    // newest report per workload container (old ReplicaSets keep theirs for a while)
    const latest = new Map()
    for (const r of reports.filter(r => ok(r.namespace))) {
        const k = `${r.namespace}|${r.kind}|${r.name}|${r.container}`
        const prev = latest.get(k)
        if (!prev || (r.updatedAt || '') > (prev.updatedAt || '')) latest.set(k, r)
    }
    const workloads = new Map()
    const cves = new Map()
    const images = new Set()
    for (const r of latest.values()) {
        const k = `${r.namespace}|${r.kind}|${r.name}`
        const w = workloads.get(k) || { id: k, namespace: r.namespace, kind: r.kind, name: r.name, counts: zero(), fixable: 0, containers: [], vulns: [], misconfig: null, updatedAt: null }
        add(w.counts, r.counts)
        w.containers.push({ container: r.container, image: r.image, counts: r.counts, updatedAt: r.updatedAt })
        if (!w.updatedAt || (r.updatedAt || '') > w.updatedAt) w.updatedAt = r.updatedAt
        for (const v of r.vulns) {
            if (v.fixed) w.fixable++
            w.vulns.push({ ...v, container: r.container })
            const c = cves.get(v.id) || { id: v.id, severity: v.severity, score: v.score, title: v.title, packages: new Set(), fixed: new Set(), workloads: new Set(), images: new Set() }
            c.packages.add(`${v.pkg} ${v.installed}`); if (v.fixed) c.fixed.add(v.fixed)
            c.workloads.add(k); if (r.image) c.images.add(r.image)
            cves.set(v.id, c)
        }
        if (r.image) images.add(r.image)
        workloads.set(k, w)
    }
    for (const a of audits.filter(a => ok(a.namespace))) {
        const k = `${a.namespace}|${a.kind}|${a.name}`
        const w = workloads.get(k) || { id: k, namespace: a.namespace, kind: a.kind, name: a.name, counts: zero(), fixable: 0, containers: [], vulns: [], misconfig: null, updatedAt: null }
        w.misconfig = { counts: a.counts, checks: a.checks.sort(vulnOrder).slice(0, 20) }
        workloads.set(k, w)
    }
    const list = [...workloads.values()].map(w => {
        const seen = new Set()
        const vulns = w.vulns.sort(vulnOrder).filter(v => { const key = `${v.id}|${v.pkg}`; if (seen.has(key)) return false; seen.add(key); return true })
        return { ...w, vulns: vulns.slice(0, maxVulns), vulnCount: vulns.length }
    }).sort(byRisk)
    const totals = list.reduce((t, w) => add(t, w.counts), zero())
    const misconfig = list.reduce((t, w) => add(t, w.misconfig?.counts || {}), zero())
    const cveList = [...cves.values()].map(c => ({
        id: c.id, severity: c.severity, score: c.score, title: c.title,
        packages: [...c.packages].slice(0, 5), fixed: [...c.fixed].slice(0, 3), workloads: c.workloads.size, images: [...c.images].slice(0, 5)
    })).sort((a, b) => vulnOrder(a, b) || b.workloads - a.workloads)
    return {
        tools,
        totals: { ...totals, images: images.size, workloads: list.filter(w => w.containers.length).length, cves: cveList.length, fixableCves: cveList.filter(c => c.fixed.length).length },
        misconfig: { ...misconfig, workloads: list.filter(w => w.misconfig && (w.misconfig.counts.critical || w.misconfig.counts.high)).length },
        workloads: list, cves: cveList.slice(0, maxCves), cveTotal: cveList.length,
        newestReport: list.reduce((m, w) => (w.updatedAt || '') > (m || '') ? w.updatedAt : m, null)
    }
}

const cache = new Map()   // clusterId → { at, value }
const TTL = 2 * 60e3

/** The Trivy reports of a cluster (cached 2 minutes) → parseSecurity() + at */
export async function readSecurity(cluster, { connect, fresh = false } = {}) {
    const hit = cache.get(cluster.id)
    if (!fresh && hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true }
    const ssh = await (connect || defaultConnect)(cluster)
    let r
    try { r = await ssh.execCommand(SECURITY_SCRIPT, { timeoutMs: 150e3 }) } finally { ssh.dispose?.() }
    const out = r?.stdout || ''
    if (!out.includes(`==${TAG}:END==`)) throw Object.assign(new Error(`Could not read the cluster${r?.stderr ? `: ${String(r.stderr).trim().slice(0, 200)}` : ''}`), { status: 502 })
    const value = { ...parseSecurity(out), at: new Date().toISOString() }
    cache.set(cluster.id, { at: Date.now(), value })
    return value
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}

// tests only: answer every cluster call with a fake connection
export const _test = { useConnect(fn) { testConnect = fn; cache.clear() } }
