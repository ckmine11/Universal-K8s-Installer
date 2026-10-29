// Progressive delivery and autoscaling on a cluster:
//   Argo Rollouts  canary / blue-green rollouts — where each one is, and
//                  promote, promote fully, abort, retry (what the kubectl
//                  plugin does: the rollout's status subresource)
//   KEDA           ScaledObjects — list, and create / remove the ones KubeEZ
//                  made from a small wizard (schedule, CPU / memory, Prometheus)
import { KUBECTL, crdSection, splitSections, listError } from './kubeList.js'

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const bad = (m, status = 400) => Object.assign(new Error(m), { status })
const str = (v, n = 200) => v == null || v === '' ? null : String(v).slice(0, n)
export const MANAGED_BY = 'app.kubernetes.io/managed-by'

async function run(connect, cluster, cmd, opts = {}) {
    const ssh = await connect(cluster)
    try { return await ssh.execCommand(cmd, { timeoutMs: 90e3, ...opts }) } finally { ssh.dispose?.() }
}
const must = (r, what) => { if (r?.code) throw bad(`${what}: ${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`, /NotFound/.test(r?.stderr || '') ? 404 : 502); return r }

// ── Argo Rollouts ──
export const ROLLOUT_SCRIPT = [crdSection('KZRO', 'RO', 'rollouts.argoproj.io'), `echo '==KZRO:END=='`].join('; ')
export function parseRollouts(out) {
    const s = splitSections(out, 'KZRO')
    if (s.RO_ERR != null) { const e = listError(s.RO_ERR, 'rollouts.argoproj.io'); return { installed: e.state !== 'missing', error: e.message || null, rollouts: [] } }
    let items = []
    try { items = JSON.parse(s.RO || '{"items":[]}').items || [] } catch { }
    return {
        installed: true, error: null,
        rollouts: items.map(o => {
            const spec = o.spec || {}, st = o.status || {}
            const strategy = spec.strategy?.blueGreen ? 'blueGreen' : 'canary'
            const steps = spec.strategy?.canary?.steps || []
            const idx = Number.isInteger(st.currentStepIndex) ? st.currentStepIndex : null
            // the traffic share of the current step (the last setWeight up to it)
            const weight = strategy !== 'canary' ? null : idx === null || idx >= steps.length ? 100 : steps.slice(0, idx + 1).reduce((w, x) => x.setWeight ?? w, 0)
            return {
                namespace: o.metadata?.namespace, name: o.metadata?.name, strategy,
                phase: st.phase || 'Unknown', message: str(st.message, 300), aborted: !!st.abort,
                paused: !!spec.paused || (st.pauseConditions || []).length > 0, pauseReasons: (st.pauseConditions || []).map(p => p.reason).filter(Boolean),
                step: strategy === 'canary' && steps.length ? { index: idx, total: steps.length } : null, weight,
                replicas: { desired: spec.replicas ?? null, ready: st.readyReplicas || 0, updated: st.updatedReplicas || 0, available: st.availableReplicas || 0 },
                stableHash: str(st.stableRS, 20), canaryHash: str(st.currentPodHash, 20),
                images: (spec.template?.spec?.containers || []).map(c => str(c.image, 200)).filter(Boolean)
            }
        }).filter(r => r.name && r.namespace).sort((a, b) => (a.phase === 'Healthy') - (b.phase === 'Healthy') || `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`))
    }
}
export async function readRollouts(cluster, { connect = defaultConnect } = {}) {
    const r = await run(connect, cluster, ROLLOUT_SCRIPT, { timeoutMs: 120e3 })
    if (!String(r?.stdout || '').includes('==KZRO:END==')) throw bad('Could not read the cluster', 502)
    return parseRollouts(r.stdout)
}
export const ROLLOUT_ACTIONS = {
    promote: { label: 'Promote to the next step', patches: [['status', { status: { pauseConditions: null } }], ['spec', { spec: { paused: false } }]] },
    'promote-full': { label: 'Promote fully (skip the remaining steps)', patches: [['status', { status: { promoteFull: true } }]] },
    abort: { label: 'Abort (back to the stable version)', patches: [['status', { status: { abort: true } }]] },
    retry: { label: 'Retry an aborted rollout', patches: [['status', { status: { abort: false } }]] }
}
/** The kubectl commands of a rollout action (each a merge patch, on the status subresource where needed). */
export function rolloutCommands(namespace, name, action) {
    if (!NS.test(String(namespace)) || !NAME.test(String(name))) throw bad('Not a valid rollout')
    const a = ROLLOUT_ACTIONS[action]
    if (!a) throw bad(`action: ${Object.keys(ROLLOUT_ACTIONS).join(', ')}`)
    return a.patches.map(([sub, p]) => `${KUBECTL} -n ${q(namespace)} patch rollouts.argoproj.io ${q(name)} --type merge${sub === 'status' ? ' --subresource=status' : ''} -p ${q(JSON.stringify(p))} --request-timeout=30s`)
}
export async function rolloutAction(cluster, namespace, name, action, { connect = defaultConnect } = {}) {
    must(await run(connect, cluster, rolloutCommands(namespace, name, action).join(' && ')), `${action} was refused`)
    return { message: `${ROLLOUT_ACTIONS[action].label}: ${namespace}/${name}.` }
}

// ── KEDA ──
export const KEDA_SCRIPT = [crdSection('KZKEDA', 'SO', 'scaledobjects.keda.sh'), `echo '==KZKEDA:END=='`].join('; ')
export function parseScaledObjects(out) {
    const s = splitSections(out, 'KZKEDA')
    if (s.SO_ERR != null) { const e = listError(s.SO_ERR, 'scaledobjects.keda.sh'); return { installed: e.state !== 'missing', error: e.message || null, scaledObjects: [] } }
    let items = []
    try { items = JSON.parse(s.SO || '{"items":[]}').items || [] } catch { }
    const cond = (o, t) => (o.status?.conditions || []).find(c => c.type === t)
    return {
        installed: true, error: null,
        scaledObjects: items.map(o => ({
            namespace: o.metadata?.namespace, name: o.metadata?.name, managed: o.metadata?.labels?.[MANAGED_BY] === 'kubeez',
            target: `${o.spec?.scaleTargetRef?.kind || 'Deployment'}/${o.spec?.scaleTargetRef?.name}`,
            min: o.spec?.minReplicaCount ?? 0, max: o.spec?.maxReplicaCount ?? 100,
            triggers: (o.spec?.triggers || []).map(t => t.type).filter(Boolean),
            ready: cond(o, 'Ready')?.status === 'True', active: cond(o, 'Active')?.status === 'True',
            message: cond(o, 'Ready')?.status === 'True' ? null : str(cond(o, 'Ready')?.message, 300)
        })).filter(x => x.name)
    }
}
export async function readScaledObjects(cluster, { connect = defaultConnect } = {}) {
    const r = await run(connect, cluster, KEDA_SCRIPT, { timeoutMs: 120e3 })
    if (!String(r?.stdout || '').includes('==KZKEDA:END==')) throw bad('Could not read the cluster', 502)
    return parseScaledObjects(r.stdout)
}

const CRON = /^[\d*/,-]+( [\d*/,-]+){4}$/
const TZ = /^(UTC|[A-Z][A-Za-z_]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?)$/
// the operator queries Prometheus from inside the cluster: in-cluster Services only
const IN_CLUSTER = /^https?:\/\/[a-z0-9-]+\.[a-z0-9-]+(\.svc(\.cluster\.local)?)?(:\d{2,5})?(\/[\w./-]*)?$/
/** The wizard's answer → a checked ScaledObject spec, or 400. */
export function cleanScaledObject(b) {
    const x = b || {}
    if (!NS.test(String(x.namespace || ''))) throw bad('namespace is not valid')
    if (!['Deployment', 'StatefulSet'].includes(x.target?.kind)) throw bad('Scale a Deployment or a StatefulSet')
    if (!NAME.test(String(x.target?.name || ''))) throw bad('The workload name is not valid')
    const name = x.name || `${x.target.name}-scaler`
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) throw bad('Name is not valid')
    const min = Number(x.min ?? 1), max = Number(x.max ?? 10)
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || max > 100 || min > max) throw bad('Replicas: min 0–100, max 1–100, min ≤ max')
    const triggers = (Array.isArray(x.triggers) ? x.triggers : []).map(t => {
        if (t?.type === 'cron') {
            if (!CRON.test(String(t.start || '')) || !CRON.test(String(t.end || ''))) throw bad('Schedule: start and end as cron (e.g. "0 9 * * 1-5")')
            if (!TZ.test(String(t.timezone || 'UTC'))) throw bad('Time zone like Asia/Kolkata or UTC')
            const n = Number(t.desiredReplicas)
            if (!Number.isInteger(n) || n < 1 || n > max) throw bad('Replicas during the schedule: 1 to max')
            return { type: 'cron', metadata: { timezone: t.timezone || 'UTC', start: t.start, end: t.end, desiredReplicas: String(n) } }
        }
        if (t?.type === 'cpu' || t?.type === 'memory') {
            const v = Number(t.value)
            if (!Number.isInteger(v) || v < 10 || v > 95) throw bad(`${t.type} target: 10–95 %`)
            if (min < 1) throw bad('CPU / memory scaling needs at least 1 replica (min ≥ 1)')
            return { type: t.type, metricType: 'Utilization', metadata: { value: String(v) } }
        }
        if (t?.type === 'prometheus') {
            if (!IN_CLUSTER.test(String(t.serverAddress || ''))) throw bad('Prometheus address: an in-cluster Service, e.g. http://prometheus-operated.monitoring.svc:9090')
            const query = String(t.query || '').trim()
            if (!query || query.length > 500 || /[\n\r]/.test(query)) throw bad('Query: one line, up to 500 characters')
            const th = Number(t.threshold)
            if (!(th > 0) || th > 1e9) throw bad('Threshold: a positive number')
            return { type: 'prometheus', metadata: { serverAddress: t.serverAddress, query, threshold: String(th) } }
        }
        throw bad('Trigger: cron, cpu, memory or prometheus')
    })
    if (!triggers.length || triggers.length > 5) throw bad('Add 1–5 triggers')
    return { name, namespace: x.namespace, target: { kind: x.target.kind, name: x.target.name }, min, max, triggers }
}
export function scaledObjectManifest(spec, by = 'kubeez') {
    return {
        apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject',
        metadata: { name: spec.name, namespace: spec.namespace, labels: { [MANAGED_BY]: 'kubeez' }, annotations: { 'kubeez.io/created-by': String(by).replace(/[^\w.@-]/g, '').slice(0, 60) || 'kubeez' } },
        spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: spec.target.kind, name: spec.target.name }, minReplicaCount: spec.min, maxReplicaCount: spec.max, triggers: spec.triggers }
    }
}
export async function applyScaledObject(cluster, spec, { by, connect = defaultConnect } = {}) {
    // one KubeEZ did not make is not overwritten
    const cur = await run(connect, cluster, `${KUBECTL} -n ${q(spec.namespace)} get scaledobjects.keda.sh ${q(spec.name)} -o jsonpath='{.metadata.labels.app\\.kubernetes\\.io/managed-by}' --request-timeout=20s`)
    if (!cur.code && String(cur.stdout || '').trim() !== 'kubeez') throw bad(`A ScaledObject called ${spec.name} already exists and was not made by KubeEZ.`, 409)
    must(await run(connect, cluster, `${KUBECTL} apply -f - --request-timeout=30s`, { stdin: JSON.stringify(scaledObjectManifest(spec, by)) }), 'The cluster refused it')
    return { message: `${spec.target.kind} ${spec.target.name} now scales ${spec.min}–${spec.max} on ${spec.triggers.map(t => t.type).join(', ')}.` }
}
export async function deleteScaledObject(cluster, namespace, name, { connect = defaultConnect } = {}) {
    if (!NS.test(String(namespace)) || !NAME.test(String(name))) throw bad('Not a valid ScaledObject')
    const cur = must(await run(connect, cluster, `${KUBECTL} -n ${q(namespace)} get scaledobjects.keda.sh ${q(name)} -o jsonpath='{.metadata.labels.app\\.kubernetes\\.io/managed-by}' --request-timeout=20s`), 'Not found')
    if (String(cur.stdout || '').trim() !== 'kubeez') throw bad('KubeEZ removes only the ScaledObjects it made.', 409)
    must(await run(connect, cluster, `${KUBECTL} -n ${q(namespace)} delete scaledobjects.keda.sh ${q(name)} --request-timeout=30s`), 'The cluster refused it')
    return { message: `${namespace}/${name} removed — the workload keeps its current replicas.` }
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}
export const _test = { useConnect(fn) { testConnect = fn } }
