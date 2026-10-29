// GitOps view: the Argo CD Applications and Flux Kustomizations / HelmReleases
// of a cluster on one list — synced or not, healthy or not, from which repo and
// revision, what drifted — plus "Sync now" / "Refresh".
//
// Read-only except the sync, which only asks the GitOps tool to do its own
// job (Argo CD: the `operation` field / refresh annotation; Flux: the
// reconcile.fluxcd.io/requestedAt annotation). KubeEZ never edits an app's
// spec, never prunes, and never reads Secrets. Repo URLs lose any user:password.
import { KUBECTL, crdSection, splitSections, listError } from './kubeList.js'

const MARK = (k) => `==KZGITOPS:${k}==`

export const SOURCES = [
    { key: 'ARGO', tool: 'argocd', kind: 'Application', resource: 'applications.argoproj.io' },
    { key: 'KS', tool: 'flux', kind: 'Kustomization', resource: 'kustomizations.kustomize.toolkit.fluxcd.io' },
    { key: 'HR', tool: 'flux', kind: 'HelmRelease', resource: 'helmreleases.helm.toolkit.fluxcd.io' },
    // only to show the repo URL of a Flux source
    { key: 'GITREPO', tool: 'flux', kind: 'GitRepository', resource: 'gitrepositories.source.toolkit.fluxcd.io', lookup: true }
]
const KINDS = Object.fromEntries(SOURCES.filter(s => !s.lookup).map(s => [s.kind, s]))

// one round trip; a missing CRD (tool not installed) or a forbidden read
// answers with its error instead of the list
export const GITOPS_SCRIPT = [...SOURCES.map(s => crdSection('KZGITOPS', s.key, s.resource)), `echo '${MARK('END')}'`].join('; ')
const sections = (out) => splitSections(out, 'KZGITOPS')

const str = (v, n = 300) => v == null || v === '' ? null : String(v).slice(0, n)
const at = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString() }

/** A repo URL without credentials (https://user:token@host/…, ?token=…). */
export function cleanRepo(url) {
    if (!url) return null
    const s = String(url).trim()
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        try { const u = new URL(s); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return str(u.toString().replace(/\/$/, ''), 300) } catch { /* below */ }
    }
    return str(s.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/@\s]*:[^/@\s]*@/i, '$1').replace(/\?.*$/, ''), 300)
}

/** "main@sha1:0123456789abcdef…" → "main@0123456", a bare SHA → 7 characters. */
export function shortRev(r) {
    if (!r) return null
    const s = String(r)
    const m = /^(.*?)@?(?:sha1|sha256):([0-9a-f]{7,})$/i.exec(s)
    if (m) return `${m[1] ? `${m[1]}@` : ''}${m[2].slice(0, 7)}`
    return /^[0-9a-f]{40}$/i.test(s) ? s.slice(0, 7) : str(s, 80)
}


const IN_CLUSTER = ['https://kubernetes.default.svc', 'https://kubernetes.default.svc:443']

function argoApp(a) {
    const md = a.metadata || {}, spec = a.spec || {}, st = a.status || {}
    const src = spec.source || spec.sources?.[0] || {}
    const dest = spec.destination || {}
    const external = dest.server ? !IN_CLUSTER.includes(dest.server.replace(/\/$/, '')) : !!dest.name && dest.name !== 'in-cluster'
    const op = st.operationState || {}
    const resources = Array.isArray(st.resources) ? st.resources : []
    const drift = resources.filter(r => r.status === 'OutOfSync' || ['Degraded', 'Missing'].includes(r.health?.status))
    const failed = ['Failed', 'Error'].includes(op.phase)
    const cond = (st.conditions || []).find(c => /Error$/.test(c.type || ''))
    let sync = ['Synced', 'OutOfSync'].includes(st.sync?.status) ? st.sync.status : 'Unknown'
    if (failed && sync !== 'Synced') sync = 'Failed'
    const namespaces = new Set([dest.namespace, ...resources.map(r => r.namespace)].filter(Boolean))
    return {
        id: `Application/${md.namespace}/${md.name}`, tool: 'argocd', kind: 'Application', namespace: md.namespace, name: md.name,
        project: str(spec.project, 100) || 'default',
        source: { repo: cleanRepo(src.repoURL), path: str(src.path, 200), chart: str(src.chart, 120), revision: str(src.targetRevision, 80) || 'HEAD', count: spec.sources?.length || 1 },
        destination: { namespace: str(dest.namespace, 63), external, server: external ? cleanRepo(dest.server || dest.name) : null },
        targetNamespaces: [...namespaces].sort(),
        clusterScoped: resources.some(r => !r.namespace),
        revision: shortRev(st.sync?.revision || st.sync?.revisions?.[0]),
        sync, health: st.health?.status || 'Unknown',
        automated: !!spec.syncPolicy?.automated, suspended: false,
        running: op.phase === 'Running' || op.phase === 'Terminating',
        operation: op.phase ? { phase: op.phase, startedAt: at(op.startedAt), finishedAt: at(op.finishedAt), message: str(op.message), by: str(op.operation?.initiatedBy?.username, 80) || (op.operation?.initiatedBy?.automated ? 'automated' : null) } : null,
        lastSyncAt: at(op.finishedAt) || at(st.reconciledAt),
        message: str(cond?.message || (failed ? op.message : null) || st.health?.message),
        drift: drift.slice(0, 50).map(r => ({ kind: str(r.kind, 80), namespace: str(r.namespace, 63), name: str(r.name, 253), sync: r.status || null, health: r.health?.status || null, message: str(r.health?.message, 200) })),
        driftCount: drift.length, resourceCount: resources.length
    }
}

// Flux inventory ids: <namespace>_<name>_<group>_<kind> (cluster-scoped: empty namespace)
const inventoryNamespaces = (entries) => (entries || []).map(e => String(e.id || '').split('_')[0])

function fluxObj(o, kind, repos) {
    const md = o.metadata || {}, spec = o.spec || {}, st = o.status || {}
    const conds = st.conditions || []
    const ready = conds.find(c => c.type === 'Ready')
    const reconciling = conds.some(c => c.type === 'Reconciling' && c.status === 'True')
    const stalled = conds.some(c => c.type === 'Stalled' && c.status === 'True')
    const suspended = !!spec.suspend
    const sync = ready?.status === 'True' ? 'Synced' : ready?.status === 'False' && !reconciling ? 'Failed' : 'Unknown'
    const health = suspended ? 'Suspended' : ready?.status === 'True' ? 'Healthy' : stalled || (ready?.status === 'False' && !reconciling) ? 'Degraded' : 'Progressing'
    const helm = kind === 'HelmRelease'
    const chart = spec.chart?.spec || {}
    const ref = (helm ? chart.sourceRef || spec.chartRef : spec.sourceRef) || {}
    const refNs = ref.namespace || md.namespace
    const repo = ref.kind === 'GitRepository' ? repos.get(`${refNs}/${ref.name}`) : null
    const inv = inventoryNamespaces(st.inventory?.entries)
    const target = spec.targetNamespace || (helm ? md.namespace : null)
    const namespaces = new Set([target, ...inv].filter(Boolean))
    return {
        id: `${kind}/${md.namespace}/${md.name}`, tool: 'flux', kind, namespace: md.namespace, name: md.name, project: null,
        source: {
            repo: repo || (ref.kind ? `${ref.kind}/${refNs}/${ref.name}` : null),
            path: helm ? null : str(spec.path, 200), chart: helm ? str(chart.chart || ref.name, 120) : null,
            revision: helm ? str(chart.version, 80) || '*' : null, count: 1
        },
        destination: { namespace: str(target, 63), external: !!spec.kubeConfig, server: spec.kubeConfig ? 'remote cluster (kubeConfig)' : null },
        targetNamespaces: [...namespaces].sort(),
        clusterScoped: inv.some(n => n === ''),
        revision: shortRev(st.lastAppliedRevision || st.history?.[0]?.chartVersion),
        sync, health, automated: true, suspended,
        running: reconciling,
        operation: null,
        lastSyncAt: at(ready?.lastTransitionTime) || at(st.lastHandledReconcileAt),
        message: ready?.status === 'True' ? null : str(ready?.message),
        drift: [], driftCount: 0, resourceCount: helm ? null : (st.inventory?.entries || []).length
    }
}

/**
 * The GITOPS_SCRIPT output → { apps, tools: { argocd, flux } }
 * tools[x] = { state: 'ok' | 'missing' | 'forbidden' | 'error', message? }
 */
export function parseGitops(out) {
    const s = sections(out)
    const tools = { argocd: { state: 'missing' }, flux: { state: 'missing' } }
    const lists = {}
    for (const src of SOURCES) {
        if (s[`${src.key}_ERR`] != null) {
            const e = listError(s[`${src.key}_ERR`], src.resource)
            // Flux: one of its kinds missing (e.g. no helm-controller) is not a Flux problem
            if (!src.lookup && e.state !== 'missing' && tools[src.tool].state !== 'ok') tools[src.tool] = e
            continue
        }
        if (s[src.key] == null) continue
        try { lists[src.key] = JSON.parse(s[src.key] || '{"items":[]}').items || [] } catch {
            lists[src.key] = []
            if (!src.lookup) tools[src.tool] = { state: 'error', message: `The ${src.kind} list is too large or could not be read.` }
            continue
        }
        if (!src.lookup && tools[src.tool].state !== 'error') tools[src.tool] = { state: 'ok' }
    }
    const repos = new Map((lists.GITREPO || []).map(r => [`${r.metadata?.namespace}/${r.metadata?.name}`, cleanRepo(r.spec?.url)]))
    const apps = [
        ...(lists.ARGO || []).map(argoApp),
        ...(lists.KS || []).map(o => fluxObj(o, 'Kustomization', repos)),
        ...(lists.HR || []).map(o => fluxObj(o, 'HelmRelease', repos))
    ].filter(a => a.name && a.namespace)
    return { apps: apps.sort(byProblem), tools }
}

const RANK = { Failed: 0, Degraded: 0, OutOfSync: 1, Missing: 1, Progressing: 2, Unknown: 2, Suspended: 3, Synced: 4, Healthy: 4 }
const score = (a) => Math.min(RANK[a.sync] ?? 2, RANK[a.health] ?? 2)
const byProblem = (a, b) => score(a) - score(b) || a.name.localeCompare(b.name)

/** Counts for the header cards. */
export function summarize(apps) {
    const n = (f) => apps.filter(f).length
    return {
        total: apps.length,
        synced: n(a => a.sync === 'Synced'),
        outOfSync: n(a => a.sync === 'OutOfSync'),
        failed: n(a => a.sync === 'Failed'),
        healthy: n(a => a.health === 'Healthy'),
        degraded: n(a => ['Degraded', 'Missing'].includes(a.health)),
        progressing: n(a => a.health === 'Progressing' || a.running),
        suspended: n(a => a.suspended || a.health === 'Suspended')
    }
}

/**
 * May a member limited to some namespaces see (and sync) this app? Only when
 * everything it deploys is in their namespaces — not another cluster, nothing
 * cluster-wide. `match(ns)` is true for an allowed namespace.
 */
export function visibleTo(app, match) {
    if (!match) return true
    if (app.destination.external || app.clusterScoped) return false
    return app.targetNamespaces.length > 0 && app.targetNamespaces.every(match)
}

// ── auto-healing: GitOps problems become incidents (alerts, AI explain) ──
// Only problems that last: Flux retries on its own and a sync takes a while.
export const PERSIST_MS = { GitOpsSyncFailed: 5 * 60e3, GitOpsDegraded: 5 * 60e3, GitOpsOutOfSync: 30 * 60e3 }
export const GITOPS_REASONS = new Set(Object.keys(PERSIST_MS))
const TOOL = { argocd: 'Argo CD', flux: 'Flux' }

/** The problem an app has now (one per app, the worst), or null. */
export function problemOf(app) {
    if (app.suspended) return null
    if (app.sync === 'Failed') return 'GitOpsSyncFailed'
    if (['Degraded', 'Missing'].includes(app.health)) return 'GitOpsDegraded'
    if (app.sync === 'OutOfSync' && !app.running) return 'GitOpsOutOfSync'
    return null
}

/** What KubeEZ knows about an app, as plain lines (incident evidence, the AI). */
export function gitopsFacts(app) {
    const s = app.source || {}
    return [
        `${TOOL[app.tool]} ${app.kind} ${app.namespace}/${app.name}${app.project ? ` (project ${app.project})` : ''}`,
        `Source: ${s.repo || 'unknown'}${s.path ? ` path ${s.path}` : ''}${s.chart ? ` chart ${s.chart}` : ''}${s.revision ? ` at ${s.revision}` : ''}${s.count > 1 ? ` (+${s.count - 1} more sources)` : ''}`,
        `Deploys to: ${app.destination?.external ? app.destination.server : 'this cluster'}${app.targetNamespaces?.length ? `, namespaces ${app.targetNamespaces.join(', ')}` : ''}${app.clusterScoped ? ', plus cluster-wide resources' : ''}`,
        `Sync: ${app.sync}, health: ${app.health}${app.running ? ', a sync is running' : ''}${app.automated ? ', automated sync' : ', manual sync'}${app.suspended ? ', suspended' : ''}`,
        app.revision && `Synced revision: ${app.revision}`,
        app.lastSyncAt && `Last sync / reconcile: ${app.lastSyncAt}`,
        app.operation && `Last operation: ${app.operation.phase}${app.operation.by ? ` by ${app.operation.by}` : ''}${app.operation.finishedAt ? ` at ${app.operation.finishedAt}` : ''}${app.operation.message ? ` — ${app.operation.message}` : ''}`,
        app.message && `Message: ${app.message}`,
        app.driftCount && `Drift (${app.driftCount} resource(s)):\n${app.drift.map(r => `- ${r.kind} ${r.namespace ? `${r.namespace}/` : ''}${r.name}: ${[r.sync, r.health, r.message].filter(Boolean).join(', ')}`).join('\n')}`
    ].filter(Boolean).join('\n')
}

/**
 * Apps with a problem that lasted long enough → incident findings.
 * since(key) → when this problem was first seen (the detector keeps the clocks).
 */
export function analyzeGitops(apps, { since = () => Date.now(), now = Date.now() } = {}) {
    const out = []
    for (const a of apps) {
        const reason = problemOf(a)
        if (!reason || now - since(`${a.id}|${reason}`) < PERSIST_MS[reason]) continue
        const why = reason === 'GitOpsSyncFailed' ? `sync failed${a.message ? `: ${a.message}` : ''}`
            : reason === 'GitOpsDegraded' ? `${a.health.toLowerCase()} after sync${a.drift?.[0] ? ` — ${a.drift[0].kind} ${a.drift[0].name}${a.drift[0].message ? `: ${a.drift[0].message}` : ` ${a.drift[0].health || ''}`}` : a.message ? `: ${a.message}` : ''}`
                : `out of sync with Git for over ${PERSIST_MS[reason] / 60e3} min${a.driftCount ? ` (${a.driftCount} resource(s) differ)` : ''}`
        out.push({ reason, target: `${a.kind}/${a.name}`, namespace: a.namespace, message: `${TOOL[a.tool]} ${a.kind} ${a.namespace}/${a.name} ${why}`.slice(0, 500) })
    }
    return out
}

const cache = new Map()   // clusterId → { at, value }
const TTL = 30e3
/** The detector's own read is the freshest one — the GitOps tab and the diagnosis reuse it. */
export const rememberGitops = (clusterId, value) => cache.set(clusterId, { at: Date.now(), value })
/** The last read app (any age) for an incident target "Kind/name" in a namespace. */
export function lastKnownApp(clusterId, namespace, target) {
    const [kind, name] = String(target || '').split('/')
    return cache.get(clusterId)?.value?.apps?.find(a => a.kind === kind && a.name === name && a.namespace === namespace) || null
}

/** Every GitOps app of the cluster → { apps, tools, summary, at, cached? } */
export async function readGitops(cluster, { connect, fresh = false } = {}) {
    const hit = cache.get(cluster.id)
    if (!fresh && hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true }
    const ssh = await (connect || defaultConnect)(cluster)
    let r
    try { r = await ssh.execCommand(GITOPS_SCRIPT, { timeoutMs: 120e3 }) } finally { ssh.dispose?.() }
    const out = r?.stdout || ''
    if (!out.includes(MARK('END'))) throw Object.assign(new Error(`Could not read the cluster${r?.stderr ? `: ${String(r.stderr).trim().slice(0, 200)}` : ''}`), { status: 502 })
    const value = { ...parseGitops(out), at: new Date().toISOString() }
    cache.set(cluster.id, { at: Date.now(), value })
    return value
}
export const forgetGitops = (clusterId) => cache.delete(clusterId)

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
export const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
export const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
export const ACTIONS = ['sync', 'refresh']

/** A sync request from the API → { kind, namespace, name, action } or throws 400. */
export function cleanSyncRequest(body) {
    const b = body || {}
    const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }) }
    if (!KINDS[b.kind]) bad(`kind must be one of ${Object.keys(KINDS).join(', ')}`)
    if (typeof b.namespace !== 'string' || !NAMESPACE.test(b.namespace)) bad('namespace is not a valid Kubernetes namespace')
    if (typeof b.name !== 'string' || !NAME.test(b.name)) bad('name is not a valid Kubernetes name')
    const action = b.action ?? 'sync'
    if (!ACTIONS.includes(action)) bad(`action must be one of ${ACTIONS.join(', ')}`)
    return { kind: b.kind, namespace: b.namespace, name: b.name, action }
}

/**
 * The one kubectl command for a sync / refresh of this app (throws 409 when
 * it cannot be done now). `by` is who asked (shown in Argo CD's history).
 */
export function syncCommand(app, action, { by = 'kubeez', now = new Date() } = {}) {
    const busy = (m) => { throw Object.assign(new Error(m), { status: 409 }) }
    const res = KINDS[app.kind].resource
    const target = `-n ${q(app.namespace)} ${res} ${q(app.name)}`
    if (app.tool === 'argocd') {
        if (action === 'refresh') return `${KUBECTL} annotate --overwrite ${target} argocd.argoproj.io/refresh=normal`
        if (app.running) busy(`A sync of ${app.name} is already running — wait for it to finish.`)
        const user = `kubeez:${String(by).replace(/[^\w.@-]/g, '').slice(0, 60) || 'user'}`
        const patch = { operation: { initiatedBy: { username: user }, info: [{ name: 'Reason', value: 'Sync now from KubeEZ' }], sync: {} } }
        return `${KUBECTL} patch ${target} --type merge -p ${q(JSON.stringify(patch))}`
    }
    if (app.suspended) busy(`${app.kind} ${app.name} is suspended in Flux — resume it first (flux resume ${app.kind === 'HelmRelease' ? 'helmrelease' : 'kustomization'} ${app.name} -n ${app.namespace}).`)
    return `${KUBECTL} annotate --overwrite ${target} reconcile.fluxcd.io/requestedAt=${q(now.toISOString())}`
}

/** Ask the GitOps tool to sync / refresh the app now. → { message } */
export async function runSync(cluster, app, action, { by, connect } = {}) {
    const cmd = syncCommand(app, action, { by })
    const ssh = await (connect || defaultConnect)(cluster)
    let r
    try { r = await ssh.execCommand(cmd, { timeoutMs: 60e3 }) } finally { ssh.dispose?.() }
    forgetGitops(cluster.id)
    if (r?.code) throw Object.assign(new Error(`The cluster refused it: ${String(r.stderr || r.stdout || '').trim().slice(0, 300) || `exit ${r.code}`}`), { status: 502 })
    const what = action === 'refresh' ? 'Refresh requested' : app.tool === 'argocd' ? 'Sync started' : 'Reconcile requested'
    return { message: `${what} for ${app.kind} ${app.namespace}/${app.name}.` }
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}

// tests only: answer every cluster call with a fake connection
export const _test = { useConnect(fn) { testConnect = fn; cache.clear() } }
