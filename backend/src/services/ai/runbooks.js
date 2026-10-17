// Learned runbooks — KubeEZ remembers which fix really solved a problem:
//   learn    a fix applied from an incident counts as "worked" when the incident
//            goes away within 2 hours; "did not work" when it is undone or the
//            incident is still open 45 minutes later
//   suggest  next time the same problem hits the same workload, that fix is
//            offered first ("worked 3 of 3 times") — and the model is told
//   auto     an admin may let a proven, low-risk runbook (restart / delete pod)
//            run by itself — only with autonomy "Auto for low-risk", no kill
//            switch, no two-person approval for AI fixes, not in maintenance,
//            not when KubeEZ's own auto-fix handles it, and at most once per
//            30 minutes and 3 times a day. Dry-run first, then a notification
//            and an undo, like any fix.
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'
import { actionLog, applyAction, ACTION_TYPES } from './actions.js'
import { aiStore } from './aiStore.js'
import { label as reasonLabel } from '../../config/incidentCatalog.js'

const FILE = path.join(DATA_DIR, 'ai-runbooks.json')
const WORKED_WITHIN_MS = 2 * 3600e3, FAILED_AFTER_MS = 45 * 60e3
const AUTO_TYPES = new Set(['restart', 'delete-pod'])
const AUTO_MIN_SUCCESSES = 2, AUTO_MIN_RATE = 0.8, AUTO_GAP_MS = 30 * 60e3, AUTO_PER_DAY = 3

let cache = null
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { cache = {} } cache.orgs ||= {} } return cache }
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(load())) }
const list = (orgId) => (load().orgs[orgId || '_'] ||= [])

// a runbook is about one problem on one workload; a pod's runbook uses its workload
const scopeOf = (spec) => spec.kind === 'pod' ? null : `${spec.namespace}/${spec.kind}/${spec.name}`
export const keyOf = (reason, scope, spec) => `${reason}|${scope}|${spec.type}${spec.type === 'scale' ? `:${spec.replicas}` : ''}`

export function eligibleForAuto(rb) {
    if (!AUTO_TYPES.has(rb.action.type)) return 'Only restarts and pod deletions can run by themselves'
    if (rb.successes < AUTO_MIN_SUCCESSES) return `It has to work at least ${AUTO_MIN_SUCCESSES} times first (${rb.successes} so far)`
    if (rb.successes / (rb.successes + rb.failures) < AUTO_MIN_RATE) return 'It did not work often enough (needs 80 %)'
    return null
}
export const viewOf = (rb) => ({ ...rb, reasonLabel: reasonLabel(rb.reason), rate: rb.successes + rb.failures ? Math.round(100 * rb.successes / (rb.successes + rb.failures)) : null, autoBlocked: eligibleForAuto(rb) })

/** Record what an applied fix did for its incident. */
export function learn(rec, result, { reason, workload, note = null } = {}) {
    if (!rec?.incidentId || rec.learned) return null
    const spec = rec.spec
    // the workload the fix belongs to (a deleted pod counts for its Deployment)
    const scope = scopeOf(spec) || (workload ? `${workload.namespace}/${workload.kind}/${workload.name}` : null)
    rec.learned = result
    if (!scope || !reason) { persistActions(); return null }
    const all = list(rec.orgId)
    const key = keyOf(reason, scope, spec)
    let rb = all.find(x => x.key === key)
    if (!rb) {
        rb = { id: randomBytes(5).toString('hex'), key, reason, scope, clusterId: rec.clusterId, clusterName: rec.clusterName, action: { ...spec }, successes: 0, failures: 0, auto: false, autoRuns: [], createdAt: new Date().toISOString() }
        all.unshift(rb)
        if (all.length > 200) all.length = 200
    }
    result === 'worked' ? rb.successes++ : rb.failures++
    Object.assign(rb, { lastResult: result, lastNote: note, lastAt: new Date().toISOString(), lastBy: rec.by })
    // a runbook that stopped working loses "auto"
    if (rb.auto && eligibleForAuto(rb)) rb.auto = false
    persist(); persistActions()
    return rb
}
function persistActions() { try { actionLog._persist?.() } catch { } }

/** An incident closed: the fixes applied for it in the 2 hours before worked. */
export function onIncidentClosed(inc) {
    const closed = Date.parse(inc.closedAt || inc.updatedAt || new Date().toISOString())
    for (const rec of actionLog.list(inc.orgId, inc.clusterId)) {
        if (rec.incidentId !== inc.id || rec.status !== 'applied' || rec.learned) continue
        if (closed - Date.parse(rec.at) <= WORKED_WITHIN_MS) learn(rec, 'worked', { reason: inc.reason, workload: rec.workload, note: 'the problem went away after it' })
    }
}
/** A fix that was undone did not help. */
export const onUndone = (rec, reason) => learn(rec, 'failed', { reason, workload: rec.workload, note: 'undone by a person' })

/** Fixes whose incident is still open 45 minutes later did not work. */
export function sweep(findIncident, now = Date.now()) {
    for (const rec of actionLog.all()) {
        if (!rec.incidentId || rec.status !== 'applied' || rec.learned || now - Date.parse(rec.at) < FAILED_AFTER_MS) continue
        const inc = findIncident(rec.incidentId)
        if (!inc) { rec.learned = 'unknown'; continue }
        if (['resolved', 'cleared'].includes(inc.status)) onIncidentClosed(inc)
        else learn(rec, 'failed', { reason: inc.reason, workload: rec.workload, note: 'the problem was still there 45 minutes later' })
    }
}

/** The best runbook for this problem on this workload (worked at least once, more often than not). */
export function suggest(orgId, reason, workload) {
    if (!workload) return null
    const scope = `${workload.namespace}/${workload.kind}/${workload.name}`
    const c = list(orgId).filter(rb => rb.reason === reason && rb.scope === scope && rb.successes > 0 && rb.successes >= rb.failures)
    c.sort((a, b) => (b.successes - b.failures) - (a.successes - a.failures))
    return c[0] ? viewOf(c[0]) : null
}

export const runbooksOf = (orgId) => list(orgId).map(viewOf)
export function setAuto(orgId, id, on) {
    const rb = list(orgId).find(x => x.id === id)
    if (!rb) throw Object.assign(new Error('Runbook not found'), { status: 404 })
    if (on) { const why = eligibleForAuto(rb); if (why) throw Object.assign(new Error(why), { status: 400 }) }
    rb.auto = !!on; persist()
    return viewOf(rb)
}
export function remove(orgId, id) { const all = list(orgId); const i = all.findIndex(x => x.id === id); if (i >= 0) { all.splice(i, 1); persist() } }

/**
 * A new incident: is there an "auto" runbook for it that may run now?
 * deps: { resolveWorkload(inc) → workload|null, onCluster(fn), approvalsOn(orgId) → bool,
 *         maintenance(orgId, clusterId) → bool, builtinAuto(orgId, reason) → bool, notify(rb, rec), timeline(inc, text) }
 */
export async function maybeAutoRun(cluster, inc, deps, now = Date.now()) {
    const s = aiStore.get(cluster.orgId)
    const candidates = list(cluster.orgId).filter(rb => rb.auto && rb.reason === inc.reason)
    if (!candidates.length) return { ran: false, why: 'no automatic runbook' }
    if (!s.enabled || !s.actionsEnabled) return { ran: false, why: 'AI actions are stopped' }
    if (s.autonomy !== 'auto') return { ran: false, why: 'autonomy is not "Auto for low-risk"' }
    if (deps.approvalsOn(cluster.orgId)) return { ran: false, why: 'AI fixes need a second person' }
    if (inc.causedBy || inc.muted) return { ran: false, why: 'caused by another problem, or muted' }
    if (deps.maintenance(cluster.orgId, cluster.id)) return { ran: false, why: 'maintenance' }
    if (deps.builtinAuto(cluster.orgId, inc.reason)) return { ran: false, why: "KubeEZ's own automatic fix handles it" }
    const workload = await deps.resolveWorkload(inc)
    if (!workload) return { ran: false, why: 'workload unknown' }
    const scope = `${workload.namespace}/${workload.kind}/${workload.name}`
    const rb = candidates.find(x => x.scope === scope && !eligibleForAuto(x))
    if (!rb) return { ran: false, why: 'no automatic runbook for this workload' }
    rb.autoRuns = (rb.autoRuns || []).filter(t => now - Date.parse(t) < 86400e3)
    if (rb.autoRuns.some(t => now - Date.parse(t) < AUTO_GAP_MS)) return { ran: false, why: 'ran less than 30 minutes ago' }
    if (rb.autoRuns.length >= AUTO_PER_DAY) return { ran: false, why: 'ran 3 times today already' }
    if (!ACTION_TYPES[rb.action.type]) return { ran: false, why: 'unknown action' }
    // a deleted pod: the pod of THIS incident, not the one that was deleted last time
    const spec = rb.action.type === 'delete-pod' ? { ...rb.action, name: inc.target, namespace: inc.namespace } : { ...rb.action }
    rb.autoRuns.push(new Date(now).toISOString()); persist()
    const rec = await deps.onCluster((ssh) => applyAction(ssh, spec, { orgId: cluster.orgId, cluster, user: { username: 'KubeEZ AI (runbook)' }, incidentId: inc.id, reason: `runbook — worked ${rb.successes} of ${rb.successes + rb.failures} times` }))
    rec.workload = workload; rec.runbookId = rb.id; persistActions()
    deps.timeline?.(inc, `${rec.title} — automatic runbook (worked ${rb.successes}× before). Undo within 24 h on the incident.`)
    deps.notify?.(rb, rec)
    return { ran: true, rec, runbook: viewOf(rb) }
}

export function _reset() { cache = null }
