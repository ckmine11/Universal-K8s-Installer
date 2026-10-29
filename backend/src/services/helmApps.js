// Helm App Manager: the Helm releases of a cluster (your apps, not only
// KubeEZ's add-ons) — list, history, values, a preview of what an install /
// upgrade changes, and install, upgrade, rollback, uninstall as background jobs.
//
// Helm runs where KubeEZ's add-ons run it: on the first control-plane (its own
// Helm in /usr/local/lib/kubeez when the node's is too old), or in the sandbox
// for imported clusters. Charts come only from the workspace's repositories.
// Values that look like secrets are masked before they leave KubeEZ; a masked
// value sent back unchanged keeps the value the release has.
import { randomBytes, createHash } from 'crypto'
import YAML from 'yaml'

const MASK = '••••••'
export const RELEASE = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/
export const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
export const CHART = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/i
export const VERSION = /^v?[0-9A-Za-z.+_-]{1,60}$/
const MAX_VALUES = 256 * 1024
const bad = (m, status = 400) => Object.assign(new Error(m), { status })
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// the Helm KubeEZ installs for add-ons wins over an old one on the node; Helm 4 renamed --atomic
const PRELUDE = [
    'H=helm; [ -x /usr/local/lib/kubeez/helm ] && H=/usr/local/lib/kubeez/helm',
    `command -v "$H" >/dev/null 2>&1 || { echo 'KZHELM|NO_HELM|Helm is not installed on the control-plane yet — install any add-on once (it installs Helm), then try again.' >&2; exit 3; }`,
    'RB=--atomic; "$H" version --short 2>/dev/null | grep -q "^v4" && RB=--rollback-on-failure',
    'HELM() { sudo KUBECONFIG=/etc/kubernetes/admin.conf "$H" "$@"; }'
].join('\n')
const script = (body) => `${PRELUDE}\n${body}`

// ── values: masking secrets ──
const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|private[-_]?key|credential|auth|cert(ificate)?[-_]?key|access[-_]?key|dsn|connection[-_]?string)$/i
/** A copy of values with every secret-looking string replaced by the mask. */
export function maskValues(v, key = '') {
    if (Array.isArray(v)) return v.map(x => maskValues(x, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValues(x, k)]))
    return typeof v === 'string' && v && SECRET_KEY.test(key) ? MASK : v
}
/** Put the release's own value back wherever the mask came back unchanged. */
export function restoreMasked(next, current, at = '') {
    if (next === MASK) {
        if (current === undefined || current === null) throw bad(`${at || 'A value'} is masked but the release has no value there — type the real value.`)
        return current
    }
    if (Array.isArray(next)) return next.map((x, i) => restoreMasked(x, Array.isArray(current) ? current[i] : undefined, `${at}[${i}]`))
    if (next && typeof next === 'object') return Object.fromEntries(Object.entries(next).map(([k, x]) => [k, restoreMasked(x, current && typeof current === 'object' ? current[k] : undefined, at ? `${at}.${k}` : k)]))
    return next
}
/** The values a person typed (YAML or JSON text) → an object, or 400. */
export function parseValues(text) {
    const s = String(text ?? '')
    if (s.length > MAX_VALUES) throw bad('Values are too large (256 KB max)')
    if (!s.trim()) return {}
    let v
    try { v = YAML.parse(s, { maxAliasCount: 50 }) } catch (e) { throw bad(`The values are not valid YAML: ${String(e.message).split('\n')[0]}`) }
    if (v == null) return {}
    if (typeof v !== 'object' || Array.isArray(v)) throw bad('Values must be a YAML map (key: value)')
    return v
}

// ── reading ──
async function run(connect, cluster, body, opts = {}) {
    const ssh = await connect(cluster)
    try { return await ssh.execCommand(script(body), { timeoutMs: opts.timeoutMs || 90e3, ...(opts.stdin != null ? { stdin: opts.stdin } : {}) }) } finally { ssh.dispose?.() }
}
function helmError(r, what) {
    const text = `${r?.stderr || ''}\n${r?.stdout || ''}`
    const m = /KZHELM\|([A-Z_]+)\|(.*)/.exec(text)
    if (m) return Object.assign(new Error(m[2]), { status: 409, code: m[1] })
    const line = text.split('\n').map(l => l.trim()).filter(l => l && !/^(WARNING|walk\.go)/i.test(l)).slice(-3).join(' ')
    return Object.assign(new Error(`${what}: ${line.slice(0, 400) || `exit ${r?.code}`}`), { status: 502 })
}
const json = (r, what) => {
    if (r?.code) throw helmError(r, what)
    try { return JSON.parse(String(r?.stdout || '').trim() || 'null') } catch { throw bad(`${what}: Helm did not answer with JSON`, 502) }
}

/** Every release of the cluster → [{ name, namespace, revision, status, chart, version, appVersion, updated }] */
export async function listReleases(cluster, { connect = defaultConnect } = {}) {
    const r = await run(connect, cluster, 'HELM list -A -a -o json --max 2000')
    return (json(r, 'Could not list the Helm releases') || []).map(x => {
        const m = /^(.*)-(v?\d[\w.+-]*)$/.exec(x.chart || '')
        return { name: x.name, namespace: x.namespace, revision: Number(x.revision) || 0, status: x.status, chart: m ? m[1] : x.chart, version: m ? m[2] : null, appVersion: x.app_version || null, updated: x.updated || null }
    }).sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

const ref = (namespace, name) => {
    if (!RELEASE.test(String(name))) throw bad('Not a valid release name')
    if (!NAMESPACE.test(String(namespace))) throw bad('Not a valid namespace')
    return `${q(name)} -n ${q(namespace)}`
}
/** History (newest first) and the values the release was installed with (masked). */
export async function releaseDetail(cluster, namespace, name, { connect = defaultConnect } = {}) {
    const r = await run(connect, cluster, `echo '==H=='; HELM history ${ref(namespace, name)} --max 30 -o json; echo; echo '==V=='; HELM get values ${ref(namespace, name)} -o json`)
    if (r?.code) throw helmError(r, `Could not read ${namespace}/${name}`)
    const [, h = '', v = ''] = String(r.stdout || '').split(/==H==|==V==/)
    let history = [], values = {}
    try { history = JSON.parse(h.trim() || '[]') } catch { }
    try { values = JSON.parse(v.trim() || '{}') || {} } catch { }
    return {
        history: history.map(x => ({ revision: x.revision, updated: x.updated, status: x.status, chart: x.chart, appVersion: x.app_version || null, description: String(x.description || '').slice(0, 300) })).reverse(),
        values: maskValues(values)
    }
}
async function rawValues(cluster, namespace, name, connect) {
    const r = await run(connect, cluster, `HELM get values ${ref(namespace, name)} -o json 2>/dev/null || echo '{}'`)
    try { return JSON.parse(String(r?.stdout || '').trim() || '{}') || {} } catch { return {} }
}

// ── install / upgrade ──
/**
 * A request → the helm arguments (checked). repo = the workspace repository
 * with credentials; plan.values = what the person typed (masked parts restored later).
 */
export function cleanDeploy(body, repo) {
    const b = body || {}
    if (!RELEASE.test(String(b.release || ''))) throw bad('Release name: lowercase letters, digits and dashes, up to 53')
    if (!NAMESPACE.test(String(b.namespace || ''))) throw bad('Namespace is not a valid Kubernetes namespace')
    if (!repo) throw bad('Pick one of the workspace\'s chart repositories')
    if (!CHART.test(String(b.chart || ''))) throw bad('Chart name is not valid')
    if (b.version != null && b.version !== '' && !VERSION.test(String(b.version))) throw bad('Chart version is not valid')
    return { release: b.release, namespace: b.namespace, chart: b.chart, version: b.version || null, repo, valuesText: b.values ?? '' }
}
function chartArgs({ chart, version, repo }) {
    const oci = repo.url.startsWith('oci://')
    const a = [oci ? q(`${repo.url}/${chart}`) : q(chart)]
    if (!oci) a.push('--repo', q(repo.url))
    if (version) a.push('--version', q(version))
    // credentials of a private repository (on the command line of the control-plane, as Helm needs them)
    if (repo.username) a.push('--username', q(repo.username))
    if (repo.password) a.push('--password', q(repo.password))
    return a.join(' ')
}
const upgradeCmd = (d, extra) => `HELM upgrade --install ${q(d.release)} ${chartArgs(d)} -n ${q(d.namespace)} --create-namespace -f - ${extra}`

/** The final values: typed values with masked parts taken from the release. */
async function finalValues(cluster, d, connect) {
    const typed = parseValues(d.valuesText)
    const current = await rawValues(cluster, d.namespace, d.release, connect)
    return restoreMasked(typed, current)
}

// manifests → { "Kind/ns/name": canonical YAML } (Secret values hashed, never shown)
export function resources(manifest) {
    const out = {}
    for (const doc of YAML.parseAllDocuments(String(manifest || ''))) {
        let o
        try { o = doc.toJS() } catch { continue }
        if (!o || typeof o !== 'object' || !o.kind) continue
        if (o.kind === 'Secret') for (const k of ['data', 'stringData']) if (o[k]) o[k] = Object.fromEntries(Object.entries(o[k]).map(([n, v]) => [n, `(hidden, sha256 ${createHash('sha256').update(String(v)).digest('hex').slice(0, 8)})`]))
        out[`${o.kind}/${o.metadata?.namespace || ''}/${o.metadata?.name || ''}`] = YAML.stringify(o, { sortMapEntries: true })
    }
    return out
}
/** A small line diff (+ / - / two spaces), or null when too large to show. */
export function lineDiff(a, b, max = 600) {
    const x = String(a).split('\n'), y = String(b).split('\n')
    if (x.length > max || y.length > max) return null
    const L = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1))
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    const out = []
    let i = 0, j = 0
    while (i < x.length && j < y.length) {
        if (x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) out.push(`- ${x[i++]}`); else out.push(`+ ${y[j++]}`)
    }
    while (i < x.length) out.push(`- ${x[i++]}`)
    while (j < y.length) out.push(`+ ${y[j++]}`)
    // only the changed lines with 3 lines around them
    const keep = new Set()
    out.forEach((l, k) => { if (l[0] !== ' ') for (let d = -3; d <= 3; d++) keep.add(k + d) })
    return out.filter((_, k) => keep.has(k))
}
/** What an install / upgrade would change → { changes: [{ resource, action, diff }], unchanged } */
export function diffManifests(before, after) {
    const a = resources(before), b = resources(after)
    const changes = []
    let unchanged = 0
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const [kind, ns, name] = k.split('/')
        const base = { kind, namespace: ns || null, name }
        if (!a[k]) changes.push({ ...base, action: 'add', diff: lineDiff('', b[k])?.filter(l => l !== '- ') || null })
        else if (!b[k]) changes.push({ ...base, action: 'remove', diff: null })
        else if (a[k] !== b[k]) changes.push({ ...base, action: 'change', diff: lineDiff(a[k], b[k]) })
        else unchanged++
    }
    const order = { remove: 0, change: 1, add: 2 }
    return { changes: changes.sort((p, r) => order[p.action] - order[r.action] || `${p.kind}${p.name}`.localeCompare(`${r.kind}${r.name}`)), unchanged }
}

/** A dry run on the cluster (the API server checks it) and the diff against what runs now. */
export async function previewDeploy(cluster, d, { connect = defaultConnect } = {}) {
    const values = await finalValues(cluster, d, connect)
    const body = `echo '==CUR=='; HELM get manifest ${ref(d.namespace, d.release)} 2>/dev/null; echo '==NEW=='; ${upgradeCmd(d, '--dry-run=server -o json')}`
    const r = await run(connect, cluster, body, { stdin: JSON.stringify(values), timeoutMs: 120e3 })
    if (r?.code) throw helmError(r, 'The dry run failed')
    const [, cur = '', next = ''] = String(r.stdout || '').split(/==CUR==|==NEW==/)
    let release
    try { release = JSON.parse(next.trim()) } catch { throw bad('The dry run did not answer with a release', 502) }
    return {
        install: !cur.trim(), chart: release?.chart?.metadata ? `${release.chart.metadata.name}-${release.chart.metadata.version}` : d.chart,
        appVersion: release?.chart?.metadata?.appVersion || null, ...diffManifests(cur, release?.manifest || ''),
        notes: String(release?.info?.notes || '').slice(0, 2000) || null
    }
}

// ── jobs (installs and upgrades can take minutes — longer than a proxy waits) ──
const jobs = new Map()   // id → job
const JOB_TTL = 60 * 60e3
function sweep() { for (const [k, j] of jobs) if (j.status !== 'running' && Date.now() - Date.parse(j.finishedAt) > JOB_TTL) jobs.delete(k) }
export const jobView = (j) => j && ({ id: j.id, clusterId: j.clusterId, action: j.action, release: j.release, namespace: j.namespace, status: j.status, by: j.by, startedAt: j.startedAt, finishedAt: j.finishedAt || null, error: j.error || null, output: j.output || null })
export const findJob = (jobId) => jobs.get(jobId) || null
export const runningFor = (clusterId, namespace, release) => [...jobs.values()].find(j => j.status === 'running' && j.clusterId === clusterId && j.namespace === namespace && j.release === release) || null

function startJob(cluster, { action, release, namespace, by }, work) {
    sweep()
    if (runningFor(cluster.id, namespace, release)) throw bad(`A ${runningFor(cluster.id, namespace, release).action} of ${namespace}/${release} is already running`, 409)
    const j = { id: randomBytes(8).toString('hex'), orgId: cluster.orgId, clusterId: cluster.id, action, release, namespace, by, status: 'running', startedAt: new Date().toISOString() }
    jobs.set(j.id, j)
    j.promise = Promise.resolve().then(work).then(
        (r) => Object.assign(j, { status: 'done', finishedAt: new Date().toISOString(), output: String(r?.stdout || '').slice(-4000) }),
        (e) => Object.assign(j, { status: 'failed', finishedAt: new Date().toISOString(), error: e.message })
    )
    return j
}
const must = (r, what) => { if (r?.code) throw helmError(r, what); return r }

/** Install or upgrade (waits for the pods; a failed upgrade is rolled back by Helm). */
export async function deploy(cluster, d, { by, connect = defaultConnect } = {}) {
    const values = await finalValues(cluster, d, connect)
    return startJob(cluster, { action: 'deploy', release: d.release, namespace: d.namespace, by }, async () =>
        must(await run(connect, cluster, upgradeCmd(d, '--wait --timeout 10m $RB -o json'), { stdin: JSON.stringify(values), timeoutMs: 12 * 60e3 }), `${d.release} was not deployed`))
}
export function rollback(cluster, namespace, release, revision, { by, connect = defaultConnect } = {}) {
    if (!Number.isInteger(revision) || revision < 1) throw bad('Pick a revision to roll back to')
    ref(namespace, release)
    return startJob(cluster, { action: `rollback to ${revision}`, release, namespace, by }, async () =>
        must(await run(connect, cluster, `HELM rollback ${q(release)} ${revision} -n ${q(namespace)} --wait --timeout 10m`, { timeoutMs: 12 * 60e3 }), `${release} was not rolled back`))
}
export function uninstall(cluster, namespace, release, { by, connect = defaultConnect } = {}) {
    const r = ref(namespace, release)
    return startJob(cluster, { action: 'uninstall', release, namespace, by }, async () =>
        must(await run(connect, cluster, `HELM uninstall ${r} --wait --timeout 5m`, { timeoutMs: 6 * 60e3 }), `${release} was not uninstalled`))
}

/** Values of two releases side by side (masked) → [{ key, a, b }] for the keys that differ. */
export function compareValues(a, b) {
    const flat = (v, p = '', out = {}) => {
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) { for (const [k, x] of Object.entries(v)) flat(x, p ? `${p}.${k}` : k, out) }
        else out[p] = v
        return out
    }
    const fa = flat(maskValues(a || {})), fb = flat(maskValues(b || {}))
    return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort()
        .filter(k => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]))
        .map(k => ({ key: k, a: k in fa ? fa[k] : null, b: k in fb ? fb[k] : null, only: !(k in fa) ? 'b' : !(k in fb) ? 'a' : null }))
}
export async function valuesOf(cluster, namespace, release, { connect = defaultConnect } = {}) { return rawValues(cluster, namespace, release, connect) }

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}
// tests only: answer every cluster call with a fake connection
export const _test = { useConnect(fn) { testConnect = fn; jobs.clear() }, jobs, MASK, PRELUDE }
