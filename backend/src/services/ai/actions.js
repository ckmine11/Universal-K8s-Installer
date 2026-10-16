// Fixes KubeEZ AI may suggest — a short, fixed list, never free-form commands:
//   restart     rollout restart of a Deployment / StatefulSet / DaemonSet
//   rollback    a Deployment back to its previous revision
//   scale       a Deployment / StatefulSet to N replicas
//   delete-pod  one pod that a controller recreates
// Every action is previewed first: the current state, what will change, a
// server-side dry-run, and how to undo it. Applying re-checks all of that,
// is recorded (audit trail + data/ai-actions.json) and can be undone.
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'

const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
const FILE = path.join(DATA_DIR, 'ai-actions.json')
const UNDO_HOURS = 24
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

export const ACTION_TYPES = {
    restart: { label: 'Restart', kinds: ['deployment', 'statefulset', 'daemonset'], risk: 'low' },
    'delete-pod': { label: 'Delete the pod (it is recreated)', kinds: ['pod'], risk: 'low' },
    rollback: { label: 'Roll back to the previous version', kinds: ['deployment'], risk: 'medium' },
    scale: { label: 'Scale', kinds: ['deployment', 'statefulset'], risk: 'medium' }
}

/** A checked action spec: { type, kind, name, namespace, replicas? } */
export function cleanSpec(input) {
    const type = String(input?.type || '')
    const t = ACTION_TYPES[type]
    if (!t) throw bad(`Unknown action — one of: ${Object.keys(ACTION_TYPES).join(', ')}`)
    const kind = String(input.kind || '').toLowerCase()
    if (!t.kinds.includes(kind)) throw bad(`${t.label} works on: ${t.kinds.join(', ')}`)
    const name = String(input.name || ''), namespace = String(input.namespace || 'default')
    if (!K8S_NAME.test(name) || !K8S_NAME.test(namespace)) throw bad('Not a valid Kubernetes name')
    const spec = { type, kind, name, namespace }
    if (type === 'scale') {
        const n = Number(input.replicas)
        if (!Number.isInteger(n) || n < 0 || n > 100) throw bad('Replicas: 0 – 100')
        spec.replicas = n
    }
    return spec
}
const ref = (s) => `${s.kind}/${s.name} -n ${s.namespace}`

// ── the cluster side (one SSH session per call) ──
async function readState(ssh, s) {
    const run = async (cmd) => { const r = await ssh.execCommand(cmd); return { ok: r.code === 0, out: (r.stdout || '').replace(/[\r\n]+$/, ''), err: (r.stderr || '').trim() } }   // keep empty leading columns
    if (s.kind === 'pod') {
        const r = await run(`${KUBECTL} get pod ${s.name} -n ${s.namespace} -o jsonpath='{.metadata.ownerReferences[0].kind}{"\\t"}{.metadata.ownerReferences[0].name}{"\\t"}{.status.phase}'`)
        if (!r.ok) throw bad(`Pod ${s.namespace}/${s.name} not found${r.err ? ` (${r.err.slice(0, 160)})` : ''}`, 404)
        const [ownerKind, ownerName, phase] = r.out.split('\t')
        return { ownerKind: ownerKind || null, ownerName: ownerName || null, phase }
    }
    const r = await run(`${KUBECTL} get ${ref(s)} -o jsonpath='{.spec.replicas}{"\\t"}{.metadata.annotations.deployment\\.kubernetes\\.io/revision}{"\\t"}{range .spec.template.spec.containers[*]}{.image}{" "}{end}'`)
    if (!r.ok) throw bad(`${s.kind} ${s.namespace}/${s.name} not found${r.err ? ` (${r.err.slice(0, 160)})` : ''}`, 404)
    const [replicas, revision, images] = r.out.split('\t')
    const st = { replicas: replicas === '' ? null : Number(replicas), revision: revision ? Number(revision) : null, images: String(images || '').trim().split(/\s+/).filter(Boolean) }
    if (s.kind === 'deployment') {
        const rs = await run(`${KUBECTL} get rs -n ${s.namespace} -o jsonpath='{range .items[?(@.metadata.ownerReferences[0].name=="${s.name}")]}{.metadata.annotations.deployment\\.kubernetes\\.io/revision}{"\\t"}{range .spec.template.spec.containers[*]}{.image}{" "}{end}{"\\n"}{end}'`)
        st.revisions = rs.out.split('\n').filter(Boolean).map(l => { const [rev, im] = l.split('\t'); return { revision: Number(rev), images: String(im || '').trim().split(/\s+/).filter(Boolean) } })
            .filter(x => x.revision).sort((a, b) => b.revision - a.revision)
    }
    return st
}

// the command for an action, for a dry-run or for real
function command(s, state, { dryRun = false } = {}) {
    const dr = dryRun ? ' --dry-run=server' : ''
    switch (s.type) {
        // `rollout restart` has no --dry-run: dry-run the same change it makes (the restartedAt annotation)
        case 'restart': return dryRun
            ? `${KUBECTL} patch ${ref(s)} --type merge -p '{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"${new Date().toISOString()}"}}}}}' --dry-run=server`
            : `${KUBECTL} rollout restart ${ref(s)}`
        case 'delete-pod': return `${KUBECTL} delete pod ${s.name} -n ${s.namespace} --wait=false${dr}`
        case 'scale': return `${KUBECTL} scale ${ref(s)} --replicas=${s.replicas}${dr}`
        case 'rollback': return `${KUBECTL} rollout undo ${ref(s)}${state?.toRevision ? ` --to-revision=${state.toRevision}` : ''}${dr}`
    }
    throw bad('Unknown action')
}

/** What the action will do — current state, the change, a server-side dry-run, the undo. */
export async function planAction(ssh, spec) {
    const s = cleanSpec(spec)
    const state = await readState(ssh, s)
    const t = ACTION_TYPES[s.type]
    let risk = t.risk, change, undo, blocked = null
    switch (s.type) {
        case 'restart':
            change = `All pods of ${s.kind} ${s.name} are replaced one by one (a rolling restart) — same version, same settings.`
            undo = { possible: false, text: 'Nothing to undo: the pods come back with the same version and settings.' }
            break
        case 'delete-pod':
            if (!state.ownerKind) blocked = 'This pod has no controller — deleting it would remove it for good. KubeEZ will not do that.'
            change = `Pod ${s.name} is deleted; its ${state.ownerKind || 'controller'} ${state.ownerName || ''} starts a new one.`.replace(' .', '.')
            undo = { possible: false, text: 'Nothing to undo: the controller recreates the pod.' }
            break
        case 'scale':
            if (state.replicas === s.replicas) blocked = `It already runs ${s.replicas} replica(s).`
            if (s.replicas === 0) risk = 'high'
            change = `Replicas ${state.replicas ?? '?'} → ${s.replicas}${s.replicas === 0 ? ' — the app stops serving' : ''}.`
            undo = { possible: state.replicas != null, text: `Undo scales it back to ${state.replicas} replica(s).`, spec: { ...s, replicas: state.replicas } }
            break
        case 'rollback': {
            const cur = state.revisions?.find(r => r.revision === state.revision)
            const prev = state.revisions?.find(r => r.revision < (state.revision || 0))
            if (!prev) blocked = 'There is no earlier revision to go back to.'
            state.toRevision = prev?.revision || null
            change = prev ? `Revision ${state.revision} → ${prev.revision}: image ${(cur?.images || state.images).join(', ')} → ${prev.images.join(', ')}.` : 'No earlier revision.'
            undo = { possible: !!prev, text: `Undo rolls forward again to revision ${state.revision} (${(cur?.images || state.images).join(', ')}).`, toRevision: state.revision }
            break
        }
    }
    let dryRun = { ok: false, output: blocked || '' }
    if (!blocked) {
        const r = await ssh.execCommand(command(s, state, { dryRun: true }))
        dryRun = { ok: r.code === 0, output: `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim().slice(0, 1500) }
    }
    return {
        spec: s, title: `${t.label} ${s.kind} ${s.namespace}/${s.name}${s.type === 'scale' ? ` to ${s.replicas}` : ''}`, risk,
        before: s.kind === 'pod' ? { phase: state.phase, owner: state.ownerKind ? `${state.ownerKind}/${state.ownerName}` : null } : { replicas: state.replicas, revision: state.revision, images: state.images }, state,
        change, undo, blocked, dryRun, ok: !blocked && dryRun.ok
    }
}

// ── applied actions (kept for undo and the record) ──
let cache = null
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { cache = [] } } return cache }
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(load().slice(0, 500), null, 1)) }
export const actionLog = {
    list: (orgId, clusterId) => load().filter(a => a.orgId === orgId && (!clusterId || a.clusterId === clusterId)),
    get: (id) => load().find(a => a.id === id),
    _reset() { cache = null }
}
const canUndo = (a) => a.status === 'applied' && a.undo?.possible && Date.now() - Date.parse(a.at) < UNDO_HOURS * 3600e3
export const view = (a) => ({ ...a, canUndo: canUndo(a) })

/** Apply: plan again (fresh state + dry-run must pass), then run it for real. */
export async function applyAction(ssh, spec, { orgId, cluster, user, incidentId = null, reason = null }) {
    const p = await planAction(ssh, spec)
    if (p.blocked) throw bad(p.blocked)
    if (!p.dryRun.ok) throw bad(`The dry-run failed, nothing was changed: ${p.dryRun.output.slice(0, 300)}`)
    const r = await ssh.execCommand(command(p.spec, p.state))
    const output = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim().slice(0, 1500)
    if (r.code !== 0) throw bad(`Kubernetes refused it: ${output.slice(0, 300)}`, 502)
    const rec = {
        id: randomBytes(6).toString('hex'), orgId, clusterId: cluster.id, clusterName: cluster.clusterName,
        spec: p.spec, title: p.title, risk: p.risk, change: p.change, before: p.before, undo: { possible: p.undo.possible, text: p.undo.text, ...(p.undo.spec ? { spec: p.undo.spec } : {}), ...(p.undo.toRevision ? { toRevision: p.undo.toRevision } : {}) },
        incidentId, reason, by: user.username, at: new Date().toISOString(), status: 'applied', output
    }
    load().unshift(rec); persist()
    return rec
}

/** Undo an applied action (within 24 hours, once). */
export async function undoAction(ssh, rec, user) {
    if (!rec) throw bad('Action not found', 404)
    if (rec.status === 'undone') throw bad('Already undone')
    if (!rec.undo?.possible) throw bad(rec.undo?.text || 'This action cannot be undone')
    if (!canUndo(rec)) throw bad(`Undo is possible for ${UNDO_HOURS} hours after the action`)
    const s = rec.spec
    const cmd = s.type === 'scale' ? `${KUBECTL} scale ${ref(s)} --replicas=${Number(rec.undo.spec.replicas)}`
        : s.type === 'rollback' ? `${KUBECTL} rollout undo ${ref(s)} --to-revision=${Number(rec.undo.toRevision)}` : null
    if (!cmd) throw bad('This action cannot be undone')
    const r = await ssh.execCommand(cmd)
    const output = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim().slice(0, 1500)
    if (r.code !== 0) throw bad(`Undo failed: ${output.slice(0, 300)}`, 502)
    Object.assign(rec, { status: 'undone', undoneBy: user.username, undoneAt: new Date().toISOString(), undoOutput: output })
    persist()
    return rec
}
