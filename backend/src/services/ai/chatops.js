// ChatOps — ask KubeEZ from Telegram or Slack (or Ask AI in the web app), in
// English, Hindi or Hinglish; the answer is always in clear English:
//   "status" / "sab theek hai?"           clusters, risk, open problems
//   "incidents" / "kya problem hai"       the open problems, numbered
//   "why 2" / "2 kyu hua"                 the AI explanation of problem 2
//   "what changed prod 6h" / "kya badla"  the change timeline, summarised
//   "fix 2" / "2 theek karo"              the suggested fix with its dry-run —
//                                         applied only in KubeEZ (a link)
//   "web-2 ka log check karo" / "why is api crashing"  a pod or app looked
//                                         into: logs, describe, events → the
//                                         problem, the cause, the fix (a fix
//                                         KubeEZ can run is previewed; applied
//                                         from the web app with its permissions)
//   "kitne namespace hain" / "failing pods" what is in a cluster — answered by
//                                         KubeEZ from the live cluster, no AI
//   anything else                         answered by AI from the live facts
// Read-only from chat: nothing changes a cluster. Off until an admin turns it
// on for a channel; only that channel's own chat; 20 questions an hour.
import { incidentDetector } from '../incidentDetector.js'
import { clusterStore } from '../clusterStore.js'
import { auditLog } from '../auditLog.js'
import { label as reasonLabel } from '../../config/incidentCatalog.js'
import { aiStore } from './aiStore.js'
import { ask, AiUnavailable } from './engine.js'
import { explainIncidentFull, onCluster } from './incidentExplain.js'
import { collectChanges, changesText } from './changes.js'
import { summarizeChanges } from './doctor.js'
import { planAction } from './actions.js'
import { riskScore, cachedSnapshot } from './risk.js'
import { visibleClusters } from './insights.js'
import { canOn, accessOn, nsMatches, kubeLevelOn } from '../accessControl.js'
import { snapshotOf, peekSnapshot, limitSnapshot, queryOf, answerQuery, snapshotText } from './clusterQuery.js'
import { DIAG, targetOf, podIncident, podEvidence, quickDiagnosis, logTail, describeCmd } from './podDoctor.js'
import { explainIncident } from './doctor.js'
import { CATALOG } from '../../config/incidentCatalog.js'
import { suggest as suggestRunbook } from './runbooks.js'

const CLOSED = new Set(['resolved', 'cleared'])
const RATE = 20, RATE_MS = 3600e3
const publicUrl = () => (process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '')
const link = (path) => publicUrl() ? `${publicUrl()}${path}` : null

export const CHAT_SYSTEM = 'You answer questions about the user\'s Kubernetes clusters in a chat app. Keep it short: at most 6 lines, plain text, no tables. The workspace facts are read live from the clusters and are exact: use them for anything about the user\'s clusters, and never guess a count or a name that is not in them. For general Kubernetes questions answer from knowledge. Never claim you changed anything — from chat you can only explain. For actions, point to KubeEZ (Incidents, AI → What changed, AI settings).'

// ── answers are always in English (questions may be English, Hindi or Hinglish) ──
const L = { looking: '🔎 Looking into it…', none: '✅ No open problems.', limit: (m) => `Too many questions — try again in ${m} min.`, off: 'KubeEZ AI is turned off for this workspace.', noEngine: 'No AI is connected to this workspace yet, so I cannot explain this one. An admin can connect one in AI settings → Connect AI (your own model, offline or cloud). I can still answer what runs in your clusters — e.g. "how many pods", "show nodes", "check the logs of web-2".', noAi: 'No AI engine could answer right now — here are the facts:', unknownN: (n) => `There is no problem #${n} — send "incidents" for the list.`, openIn: 'Open in KubeEZ to preview and apply:', noFix: 'No fix KubeEZ can run for this one — the steps above are for a person.' }

// ── what was asked ──
export function intentOf(raw) {
    const text = String(raw || '').trim().replace(/^\/(ask|kubeez)(@\w+)?\s*/i, '').replace(/^@\w+\s*/, '').trim()
    const t = text.toLowerCase()
    // "why 2", "#2" — not the 2 in a pod name like "web-2"
    const num = (t.match(/(?:^|[^\w.-])#?(\d{1,2})(?![\w.-])/) || [])[1]
    if (!t || /^\/?(help|start|madad)\b|kya kar sakte|what can you do|मदद/.test(t)) return { kind: 'help', text }
    if (num && /\b(fix|theek karo|thik karo|sudharo|sahi karo)\b|ठीक करो/.test(t)) return { kind: 'fix', n: Number(num), text }
    if (num && /\b(why|explain|kyu|kyun|kyon|kyo|samjhao|batao|reason|wajah)\b|क्यों|समझाओ/.test(t)) return { kind: 'explain', n: Number(num), text }
    if (/what changed|\bchanges?\b|kya badla|badlav|kya change|क्या बदला/.test(t)) {
        const h = t.match(/(\d{1,3})\s*(h|hr|hours?|ghante)\b/) ? Number(t.match(/(\d{1,3})\s*(h|hr|hours?|ghante)\b/)[1]) : t.match(/(\d{1,2})\s*(d|days?|din)\b/) ? Number(t.match(/(\d{1,2})\s*(d|days?|din)\b/)[1]) * 24 : 24
        return { kind: 'changes', hours: Math.min(168, Math.max(1, h)), text }
    }
    if (/\b(incidents?|problems?|issues?|alerts?|dikkat|gadbad)\b|kya (problem|dikkat|gadbad)|समस्या/.test(t)) return { kind: 'incidents', text }
    if (/\b(status|health|haal)\b|sab (theek|thik|ok|badhiya)|kaisa (hai|chal)|how (is|are) (the |my )?(cluster|everything)|सब ठीक/.test(t)) return { kind: 'status', text }
    return { kind: 'ask', text }
}

// ── per chat: the numbered list and the rate limit ──
const chats = new Map()   // chatKey → { list: [incidentId], at, asked: [ts] }
const chatState = (k) => { let c = chats.get(k); if (!c) { c = { list: [], at: 0, asked: [] }; chats.set(k, c) } return c }

// a scope is { orgId } for a team chat (the whole workspace, like its alerts) or
// { orgId, user, visible } in the web app (only what that member may see)
const mayView = (sc, i) => !sc.visible || sc.visible.some(c => c.id === i.clusterId && canOn(sc.user, 'incident:view', c))
const openIncidents = (sc) => incidentDetector.getIncidents()
    .filter(i => i.orgId === sc.orgId && !CLOSED.has(i.status) && !i.causedBy && mayView(sc, i))
    .sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) || b.lastSeen.localeCompare(a.lastSeen))
const sev = (i) => i.severity === 'critical' ? '🔴' : i.severity === 'info' ? '🔵' : '🟠'
const RISK = { low: '🟢', medium: '🟡', high: '🔴' }

async function clustersOf(sc) { return (sc.visible || (await clusterStore.getClusters().catch(() => [])).filter(c => c.orgId === sc.orgId)).filter(c => c.status !== 'failed') }
const findCluster = (clusters, text) => clusters.find(c => new RegExp(`\\b${String(c.clusterName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) || (clusters.length === 1 ? clusters[0] : null)

function listText(sc, state) {
    const list = openIncidents(sc).slice(0, 10)
    state.list = list.map(i => i.id); state.at = Date.now()
    if (!list.length) return L.none
    return list.map((i, n) => `${n + 1}. ${sev(i)} ${reasonLabel(i.reason)} — ${i.clusterName}: ${i.namespace ? `${i.namespace}/` : ''}${i.target}`).join('\n') +
        '\n\nSend "why 1" for the cause, "fix 1" for a fix.'
}

async function statusReply(sc, state) {
    const clusters = await clustersOf(sc)
    if (!clusters.length) return { reply: 'No clusters yet.' }
    const mon = incidentDetector.getMonitoring()
    const lines = clusters.map(c => {
        const inc = incidentDetector.getIncidents().filter(i => i.clusterId === c.id && !CLOSED.has(i.status) && !i.causedBy && mayView(sc, i))
        const m = mon.find(x => x.clusterId === c.id)
        const r = riskScore({ cluster: c, incidents: inc, monitoring: m ? { watched: true, connected: m.connected } : { watched: false }, snapshot: cachedSnapshot(c.id), offsite: undefined, compliance: null })
        return `${RISK[r.level]} ${c.clusterName} — risk ${r.score}/100, ${inc.length} open${r.factors[0] ? ` · ${r.factors[0].label}` : ''}`
    })
    return { reply: `${lines.join('\n')}\n\n${listText(sc, state)}` }
}

const pick = (sc, state, n) => {
    if (!state.list.length || Date.now() - state.at > 3600e3) listTextSilently(sc, state)
    const id = state.list[n - 1]
    return id ? incidentDetector.find(id) : null
}
function listTextSilently(sc, state) { state.list = openIncidents(sc).slice(0, 10).map(i => i.id); state.at = Date.now() }

// a member limited to some namespaces sees only those (team chats see the workspace, like its alerts)
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('the cluster did not answer in time')), ms).unref?.())])
const nsFilter = (sc, u, c) => { if (!sc.user) return null; const p = accessOn(u, c).namespaces; return p ? (ns) => nsMatches(p, ns) : null }

const user = (orgId, who, source) => ({ id: `chat:${source}`, username: `${who} (${source})`, orgId, role: 'viewer' })

/**
 * One message from a chat. → { reply, progress? } — progress is sent first when
 * the answer takes a while (an AI call).
 * ctx: { orgId, chatKey, who, source: 'Telegram' | 'Slack', text, send?(progressText) }
 */
export async function handleChat(ctx) {
    const { orgId, chatKey, who, source } = ctx
    const intent = intentOf(ctx.text)
    const s = aiStore.get(orgId)
    const state = chatState(chatKey)
    state.asked = state.asked.filter(t => Date.now() - t < RATE_MS)
    const sc = ctx.user ? { orgId, user: ctx.user, visible: await visibleClusters(ctx.user) } : { orgId }
    if (state.asked.length >= (ctx.rate || RATE)) return { reply: L.limit(Math.ceil((RATE_MS - (Date.now() - state.asked[0])) / 60e3)) }
    state.asked.push(Date.now())
    auditLog.record({ orgId, actor: { username: `${who} (${source})` }, action: 'ai.chatops', detail: `${intent.kind}: ${String(intent.text).slice(0, 120)}` })
    const u = ctx.user || user(orgId, who, source)
    if (intent.kind === 'explain' && !s.enabled) return { reply: L.off }
    // "nodes ka status", "pods with problems" — about what is in the cluster
    // "web-2 me kya issue hai" — a pod or app named in the question (from the last look at the clusters)
    if (['status', 'incidents'].includes(intent.kind)) {
        const q = queryOf(intent.text)
        const named = (sc.visible || await clustersOf(sc)).some(c => { const snap = peekSnapshot(c.id); return snap && targetOf(intent.text, snap) })
        if ((q && q.resource !== 'warnings') || named) { intent.was = intent.kind; intent.kind = 'ask' }
    }

    try {
        switch (intent.kind) {
            case 'help': return { reply: helpText() }
            case 'incidents': return { reply: listText(sc, state) }
            case 'status': return statusReply(sc, state)
            case 'explain': case 'fix': {
                const inc = pick(sc, state, intent.n)
                if (!inc) return { reply: L.unknownN(intent.n) }
                const cluster = (await clustersOf(sc)).find(c => c.id === inc.clusterId)
                if (!cluster) return { reply: L.unknownN(intent.n) }
                if (!s.enabled) return { reply: L.off }
                await ctx.send?.(L.looking)
                const out = await explainIncidentFull(u, inc, cluster)
                const a = out.answer
                const head = `${sev(inc)} ${reasonLabel(inc.reason)} — ${inc.clusterName}: ${inc.namespace ? `${inc.namespace}/` : ''}${inc.target}`
                const body = [head, '', a.summary, a.cause ? `→ ${a.cause}` : '', a.change ? `Δ ${a.change}` : '', ...(a.fix || []).slice(0, 3).map((x, i) => `${i + 1}. ${x}`), a.blockedSteps?.length ? `⚠ ${a.blockedSteps.length} dangerous step(s) removed by KubeEZ.` : ''].filter(Boolean)
                if (intent.kind === 'explain') return { reply: [...body, '', link(`/incidents?open=${inc.id}`) || ''].filter(Boolean).join('\n') }
                // fix: the dry-run of the suggested (or learned) fix — applied only in KubeEZ
                const spec = a.action || (out.runbook && out.allowedActions?.find(x => x.type === out.runbook.action.type))
                if (!spec) return { reply: [...body, '', L.noFix].join('\n') }
                const plan = await onCluster(cluster, (ssh) => planAction(ssh, spec)).catch(e => ({ blocked: e.message }))
                return { reply: [head, '', `🛠 ${plan.title || `${spec.type} ${spec.kind}/${spec.name}`}`, plan.change || '', plan.blocked ? `⛔ ${plan.blocked}` : plan.dryRun ? `${plan.dryRun.ok ? '✅' : '❌'} dry-run ${plan.dryRun.ok ? 'passed' : 'failed'}` : '', plan.undo?.text ? `↩ ${plan.undo.text}` : '', '', L.openIn, link(`/incidents?open=${inc.id}`) || 'KubeEZ → Incidents'].filter(x => x !== '').join('\n') }
            }
            case 'changes': {
                const clusters = await clustersOf(sc)
                const c = findCluster(clusters, intent.text)
                if (!c) return { reply: `Which cluster? ${clusters.map(x => x.clusterName).join(', ')}` }
                const r = await collectChanges(c, { hours: intent.hours })
                if (!r.items.length) return { reply: `${c.clusterName}: no changes in the last ${intent.hours} h.` }
                const facts = `${c.clusterName} — ${r.items.length} change(s), last ${intent.hours} h:\n${changesText(r.items, 8).split('\n').map(l => `• ${l.replace(/^\S+ /, '')}`).join('\n')}`
                if (!s.enabled) return { reply: facts }
                await ctx.send?.(L.looking)
                try { const sum = await summarizeChanges(u, c, r); return { reply: `${c.clusterName} (${intent.hours} h):\n${sum.summary}` } }
                catch { return { reply: facts } }
            }
            default: {
                const clusters = await clustersOf(sc)
                // the clusters this is about: the one named, else all of them (up to 5)
                const named = clusters.filter(c => new RegExp(`(^|[^a-z0-9-])${String(c.clusterName).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`).test(intent.text.toLowerCase()))
                const about = (named.length ? named : clusters).slice(0, 5)
                const snaps = await Promise.all(about.map(c => within(snapshotOf(c), 20e3).then(snap => ({ c, snap: limitSnapshot(snap, nsFilter(sc, u, c)) })).catch(e => ({ c, error: e.message }))))
                // a pod or app named in the question ("web-2", "api deployment"), or "the crashing pod"
                const found = snaps.map(x => x.snap && { ...x, t: targetOf(intent.text, x.snap) }).find(x => x?.t)
                if (found && ['pod', 'deployment', 'statefulset', 'daemonset'].includes(found.t.kind) && DIAG.test(intent.text.toLowerCase())) {
                    return await lookInto({ ctx, u, sc, s, cluster: found.c, t: found.t })
                }
                // what is in a cluster: answered exactly by KubeEZ, no AI, a second or two
                const q = queryOf(intent.text, snaps.flatMap(x => x.snap?.namespaces || []))
                if (q && !clusters.length) return { reply: 'No clusters yet — add or install one in KubeEZ first.' }
                if (q && !found) {
                    const parts = snaps.map(x => x.snap ? answerQuery(q, x.snap, x.c.clusterName) : `${x.c.clusterName}: ⚠ could not read the cluster — ${x.error}`).filter(Boolean)
                    if (parts.length) return { reply: parts.join('\n\n').slice(0, 3500), direct: snaps.some(x => x.snap) }
                }
                if (intent.was === 'incidents' && !found) return { reply: listText(sc, state) }
                if (intent.was === 'status' && !found) return statusReply(sc, state)
                if (!s.enabled) return { reply: L.off }
                await ctx.send?.(L.looking)
                // a question about one thing ("web service ka port", "api ka image kya hai"): its live describe too
                let about1 = null
                if (found && mayLook(sc, u, found.c)) {
                    const cmd = describeCmd(found.t.kind, found.t.ns, found.t.name)
                    if (cmd) about1 = await within(onCluster(found.c, (ssh) => ssh.execCommand(cmd)), 25e3).then(r => ({ label: `kubectl describe ${found.t.kind} ${found.t.ns}/${found.t.name} (live)`, text: String(r.stdout || r.stderr || '').slice(0, 6000) }), () => null)
                }
                const facts = [
                    `Clusters: ${clusters.map(c => `${c.clusterName} (Kubernetes ${c.k8sVersion}, ${(c.masterNodes || []).length} control-plane, ${(c.workerNodes || []).length} workers)`).join('; ') || 'none'}`,
                    `Open problems: ${openIncidents(sc).slice(0, 15).map(i => `${reasonLabel(i.reason)} on ${i.clusterName} ${i.namespace ? `${i.namespace}/` : ''}${i.target}: ${i.message}`).join(' | ') || 'none'}`,
                    ...snaps.filter(x => x.snap).map(x => snapshotText(x.snap, x.c.clusterName))
                ].join('\n')
                const r = await ask(u, {
                    task: 'chat', purpose: `chat (${source})`, maxTokens: 350,
                    system: CHAT_SYSTEM,
                    data: [{ label: 'workspace facts (live)', text: facts }, ...(about1 ? [about1] : [])], question: intent.text
                })
                return { reply: r.text.trim().slice(0, 3500) }
            }
        }
    } catch (e) {
        if (e.none) return { reply: L.noEngine }
        if (e instanceof AiUnavailable || e.code === 'AI_UNAVAILABLE') return { reply: `${L.noAi}\n${listText(sc, state)}` }
        return { reply: `⚠ ${e.message}` }
    }
}

// ── looking into a pod: logs, describe, events → problem, cause, fix ──
// may this asker read logs and describe in that cluster? (team chats: the workspace, like its alerts)
const mayLook = (sc, u, c) => !sc.user || kubeLevelOn(u, c) !== 'none'
const W = { problem: 'Problem', cause: 'Cause', proof: 'Proof', fix: 'How to fix it', log: 'Last log lines', kubeez: 'KubeEZ\'s own check', changed: 'Changed just before', run: 'A fix KubeEZ can run', removed: (n) => `⚠ ${n} dangerous step(s) removed by KubeEZ.`, noPods: 'it has no pods right now', worst: 'its pod with the most trouble', others: 'Other pods with trouble', notAllowed: 'Your role may not read logs in this cluster.', aiFail: 'The AI could not answer right now — this is KubeEZ\'s own check.', aiNone: 'This is KubeEZ\'s own check. Connect an AI (AI settings → Connect AI) for a deeper explanation.', unknown: 'KubeEZ found no known cause in the logs and events.', webApply: 'Preview it (dry-run) and apply it below.', chatApply: 'Preview and apply it in KubeEZ → Ask AI.' }
const looked = new Map()   // pod + 2-minute slot → the AI answer (asking twice costs one model call)

async function lookInto({ ctx, u, sc, s, cluster, t }) {
    if (!mayLook(sc, u, cluster)) return { reply: W.notAllowed }
    const pod = t.pod, wl = t.workload
    if (!pod) return { reply: `${cluster.clusterName}: ${t.kind} ${t.ns}/${t.name} — ${wl.ready}/${wl.want} ready, ${W.noPods}${wl.want === 0 ? ' (scaled to 0)' : ''}.` }
    await ctx.send?.(L.looking)
    const ok = (pod.phase === 'Running' && pod.ready === pod.containers) || pod.phase === 'Succeeded'
    const intro = [
        `🔎 ${cluster.clusterName}: ${pod.ns}/${pod.name} — ${pod.reason || pod.phase} (${pod.ready}/${pod.containers} ready, ${pod.restarts} restarts${pod.node ? `, node ${pod.node}` : ''})`,
        t.kind !== 'pod' ? `(${t.kind} ${t.name}: ${wl.ready}/${wl.want} ready — ${W.worst})` : '',
        t.guessed && t.others?.length ? `${W.others}: ${t.others.map(p => `${p.ns}/${p.name}`).join(', ')}` : ''
    ].filter(Boolean)
    const inc = podIncident(cluster, pod)
    const fresh = await within(onCluster(cluster, (ssh) => podEvidence(ssh, inc)), 35e3).catch(e => ({ data: [], workload: null, error: e.message }))
    if (fresh.error && !fresh.data.length) return { reply: [...intro, '', `⚠ ${fresh.error}`].join('\n') }
    const quick = quickDiagnosis(fresh.data, pod)
    const fill = (x) => String(x).split('<ns>').join(pod.ns).split('<name>').join(fresh.workload?.name || pod.name).split('<node>').join(pod.node || '<node>')
    const tail = logTail(fresh.data, 8)
    const clean = ok && quick && !quick.fix.length   // running, ready and no errors: nothing for the AI to find
    let ai = null, aiErr = null, aiNone = false
    if (s.enabled && !clean) {
        const key = `${inc.id}:${inc.lastSeen}`
        try {
            if (!looked.has(key)) {
                if (quick) inc.details = `KubeEZ's own check of the logs/events: ${quick.summary} ${quick.cause}`.trim()
                const p = (async () => {
                    const changes = await within(collectChanges(cluster, { from: Date.now() - 3 * 3600e3, to: Date.now() }), 30e3).then(c => c.items, () => [])
                    const runbook = suggestRunbook(cluster.orgId, inc.reason, fresh.workload)
                    const out = await explainIncident(u, { incident: inc, catalog: CATALOG[inc.reason], cluster, fresh, changes, related: null, runbook })
                    return { ...out, runbook }
                })()
                looked.set(key, p); p.catch(() => looked.delete(key))
                if (looked.size > 100) looked.delete(looked.keys().next().value)
            }
            ai = await looked.get(key)
        } catch (e) { aiErr = e.message; aiNone = !!e.none }
    }
    const lines = [...intro, '']
    if (ai) {
        const a = ai.answer
        lines.push(`${W.problem}: ${a.summary}`)
        if (a.cause) lines.push(`${W.cause}: ${a.cause}`)
        if (a.change) lines.push(`${W.changed}: ${a.change}`)
        if (a.evidence.length) lines.push(`${W.proof}:`, ...a.evidence.slice(0, 3).map(e => `  › ${e}`))
        if (a.fix.length) lines.push(`${W.fix}:`, ...a.fix.slice(0, 6).map((x, i) => `${i + 1}. ${x}`))
        if (a.blockedSteps?.length) lines.push(W.removed(a.blockedSteps.length))
        if (quick?.fix.length) lines.push('', `${W.kubeez}: ${quick.summary}`)
    } else if (quick) {
        lines.push(`${W.problem}: ${quick.summary}`)
        if (quick.cause) lines.push(`${W.cause}: ${quick.cause}`)
        if (quick.evidence.length) lines.push(`${W.proof}:`, ...quick.evidence.map(e => `  › ${e}`))
        if (quick.fix.length) lines.push(`${W.fix}:`, ...quick.fix.map((x, i) => `${i + 1}. ${fill(x)}`))
        if (aiErr) lines.push('', aiNone ? W.aiNone : W.aiFail)
    } else {
        lines.push(W.unknown, aiErr ? `AI: ${aiErr}` : !s.enabled ? L.off : '')
    }
    if (tail.length) lines.push('', `${W.log}:`, ...tail.map(l => `  ${l.slice(0, 220)}`))
    // a fix KubeEZ can run: the AI's, else what fixed this before on this workload
    const spec = ai?.answer.action || (ai?.runbook && ai.allowedActions?.find(x => x.type === ai.runbook.action.type)) || null
    if (spec) lines.push('', `🛠 ${W.run}: ${spec.type} ${spec.kind}/${spec.name}${spec.type === 'scale' ? ` → ${spec.replicas}` : ''}`, sc.user ? W.webApply : W.chatApply)
    return {
        reply: lines.filter(x => x !== null && x !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3800),
        direct: !ai,
        ...(spec && sc.user ? { fix: { clusterId: cluster.id, spec, canAct: canOn(u, 'incident:act', cluster) } } : {})
    }
}

function helpText() {
    return 'I am KubeEZ AI. Ask me:\n• "status" — clusters and risk\n• "incidents" — open problems, numbered\n• "how many namespaces", "show nodes" — what runs in a cluster\n• "check the logs of web-2" — the problem in a pod, its cause and the fix\n• "why 2" — the cause of problem 2\n• "fix 2" — the suggested fix with its dry-run (applied in KubeEZ)\n• "what changed prod 6h" — the change timeline\n• anything about Kubernetes'
}

export function _reset() { chats.clear() }
