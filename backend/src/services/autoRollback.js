// Auto-rollback: a Helm release that breaks its workload within an hour of a
// deploy is rolled back to the revision before — when its environment says so.
//   off   nothing (default)
//   ask   an alert: "rollback suggested", a person decides (Apps → History)
//   auto  KubeEZ rolls back (once per revision), and says so
// Never during a change freeze; never twice for the same revision.
import { FAILURE_REASONS } from './dora.js'

const WINDOW_MS = 60 * 60e3
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 30 kubectl'
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
const done = new Set()   // clusterId/ns/release@revision already handled

/** Helm's "2026-10-29 10:00:00.123456 +0530 IST" → ms (or null). */
export function helmTime(s) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(?:([+-])(\d{2}):?(\d{2}))?/.exec(String(s || ''))
    if (!m) return null
    const t = Date.parse(`${m[1]}T${m[2]}${m[4] ? `${m[4]}${m[5]}:${m[6]}` : 'Z'}`)
    return Number.isNaN(t) ? null : t
}

/** The Deployment / StatefulSet an incident is about, from its target or owner. */
export function workloadOf(inc) {
    const t = String(inc.target || '')
    const direct = /^(deployment|statefulset)\/([a-z0-9.-]+)$/.exec(t)
    if (direct) return { kind: direct[1], name: direct[2] }
    const owner = String(inc.owner || '')
    const rs = /^ReplicaSet\/(.+)-[a-z0-9]{6,10}$/.exec(owner)
    if (rs) return { kind: 'deployment', name: rs[1] }
    const sts = /^StatefulSet\/(.+)$/.exec(owner)
    if (sts) return { kind: 'statefulset', name: sts[1] }
    const pod = /^(.+)-[a-z0-9]{6,10}-[a-z0-9]{5}$/.exec(t)
    return pod ? { kind: 'deployment', name: pod[1] } : null
}

/**
 * Should this incident roll back the release? → { action: 'auto'|'ask', release, from, to } or { skip: why }
 * history: the release's revisions (newest first, with updated); now: ms.
 */
export function decide({ incident, policy, release, history, frozen, now = Date.now() }) {
    if (!policy || policy === 'off') return { skip: 'off' }
    if (!FAILURE_REASONS.has(incident.reason)) return { skip: 'not a deploy failure' }
    if (!release) return { skip: 'not a Helm release' }
    const cur = history?.[0], prev = history?.find(h => h.revision < cur?.revision && ['superseded', 'deployed'].includes(h.status))
    if (!cur || !prev) return { skip: 'no earlier revision' }
    const at = helmTime(cur.updated)
    if (at == null || now - at > WINDOW_MS || Date.parse(incident.timestamp) < at) return { skip: 'not right after a deploy' }
    if (frozen) return { skip: 'change freeze' }
    return { action: policy, release, from: cur.revision, to: prev.revision }
}

/** The Helm release that owns a workload (meta.helm.sh/release-name), or null. */
async function releaseOf(ssh, ns, w) {
    if (!NAME.test(ns) || !NAME.test(w.name)) return null
    const r = await ssh.execCommand(`${KUBECTL} -n '${ns}' get ${w.kind} '${w.name}' -o jsonpath='{.metadata.annotations.meta\\.helm\\.sh/release-name}' --request-timeout=20s`)
    const name = String(r?.stdout || '').trim()
    return /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/.test(name) ? name : null
}

/**
 * A new incident → maybe a rollback. deps (for tests): connect, releaseDetail,
 * rollback, notify, evidence, policyFor, frozen, usable.
 */
export async function onIncident(cluster, incident, deps) {
    const ns = incident.namespace
    if (!ns || !deps.usable(cluster.orgId)) return { skip: 'feature' }
    const policy = deps.policyFor(cluster, ns)
    if (!policy || policy === 'off') return { skip: 'off' }
    const w = workloadOf(incident)
    if (!w) return { skip: 'no workload' }
    const ssh = await deps.connect(cluster)
    let release
    try { release = await releaseOf(ssh, ns, w) } finally { ssh.dispose?.() }
    if (!release) return { skip: 'not a Helm release' }
    const { history } = await deps.releaseDetail(cluster, ns, release)
    const d = decide({ incident, policy, release, history, frozen: deps.frozen(cluster) })
    if (d.skip) return d
    const key = `${cluster.id}/${ns}/${release}@${d.from}`
    if (done.has(key)) return { skip: 'already handled' }
    done.add(key)
    const what = `${ns}/${release} revision ${d.from} (deployed less than an hour ago) broke ${w.kind}/${w.name}: ${incident.message || incident.reason}`
    if (d.action === 'auto') {
        await deps.rollback(cluster, ns, release, d.to, { by: 'KubeEZ auto-rollback' })
        deps.evidence(incident, 'Auto-rollback', `Rolled back ${ns}/${release} from revision ${d.from} to ${d.to}.`)
        deps.notify(cluster, { severity: 'warning', title: `Auto-rollback: ${ns}/${release} → revision ${d.to}`, text: `${what}. KubeEZ rolled it back to revision ${d.to} (the environment's auto-rollback policy).` })
    } else {
        deps.evidence(incident, 'Rollback suggested', `Roll back ${ns}/${release} to revision ${d.to} (Apps → ${release} → History).`)
        deps.notify(cluster, { severity: 'warning', title: `Rollback suggested: ${ns}/${release} → revision ${d.to}`, text: `${what}. Roll back in KubeEZ: Apps → ${release} → History → Roll back to #${d.to}.` })
    }
    return d
}
export const _test = { reset: () => done.clear() }

/** Wire it to the incident detector (server start). */
export async function startAutoRollback() {
    const [{ incidentDetector }, { deliveryStore }, { features }, helm, { notifier }, { connectCluster }] = await Promise.all([
        import('./incidentDetector.js'), import('./deliveryStore.js'), import('./features.js'), import('./helmApps.js'), import('./notifier.js'), import('./clusterAccess.js')])
    const deps = {
        connect: connectCluster, releaseDetail: helm.releaseDetail, rollback: helm.rollback,
        usable: (orgId) => features.usable(orgId, 'autoRollback'),
        policyFor: (c, ns) => deliveryStore.environmentAt(c.orgId, c.id, ns)?.autoRollback || 'off',
        frozen: (c) => !!deliveryStore.activeFreeze(c.orgId, c.id),
        evidence: (inc, title, text) => incidentDetector.addEvidence(inc.id, title, text),
        notify: (c, ev) => notifier.emit(c.orgId, { type: 'auto_rollback', key: `rollback|${c.id}|${ev.title}`, clusterId: c.id, clusterName: c.clusterName, link: '/incidents', ...ev })
    }
    incidentDetector.on('create', (cluster, incident) => onIncident(cluster, incident, deps).catch(e => console.error(`[AutoRollback] ${e.message}`)))
}
