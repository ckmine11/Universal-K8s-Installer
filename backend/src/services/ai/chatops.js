// ChatOps — ask KubeEZ from Telegram or Slack, in English, Hindi or Hinglish,
// and get the answer in the same language:
//   "status" / "sab theek hai?"           clusters, risk, open problems
//   "incidents" / "kya problem hai"       the open problems, numbered
//   "why 2" / "2 kyu hua"                 the AI explanation of problem 2
//   "what changed prod 6h" / "kya badla"  the change timeline, summarised
//   "fix 2" / "2 theek karo"              the suggested fix with its dry-run —
//                                         applied only in KubeEZ (a link)
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
import { canOn, accessOn, nsMatches } from '../accessControl.js'
import { snapshotOf, limitSnapshot, queryOf, answerQuery, snapshotText } from './clusterQuery.js'

const CLOSED = new Set(['resolved', 'cleared'])
const RATE = 20, RATE_MS = 3600e3
const publicUrl = () => (process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '')
const link = (path) => publicUrl() ? `${publicUrl()}${path}` : null

export const CHAT_SYSTEM = 'You answer questions about the user\'s Kubernetes clusters in a chat app. Keep it short: at most 6 lines, plain text, no tables. The workspace facts are read live from the clusters and are exact: use them for anything about the user\'s clusters, and never guess a count or a name that is not in them. For general Kubernetes questions answer from knowledge. Never claim you changed anything — from chat you can only explain. For actions, point to KubeEZ (Incidents, AI → What changed, AI settings).'

// ── language ──
const HINGLISH = /\b(kya|kyu|kyun|kyon|hai|hain|ho|hua|hui|kaise|kaisa|batao|bata|theek|thik|sab|mera|meri|kitne|kitna|badla|karo|kar|nahi|nahin|chal|raha|rahi|abhi|aaj|kal|samjhao|dikkat|gadbad|haal|wala|wali|kaun|kab|dikhao|dikha|dikhana|kaunse|kaunsa|kitni|mein|wale|chahiye|bhi|karna|hoga)\b/i
export function detectLanguage(text) {
    if (/[\u0900-\u097F]/.test(text)) return 'hi'
    const words = String(text).toLowerCase().match(/[a-z]+/g) || []
    const hits = words.filter(w => HINGLISH.test(w)).length
    return hits >= 1 && hits / Math.max(1, words.length) >= 0.15 ? 'hinglish' : 'en'
}
const T = {
    en: { looking: '🔎 Looking into it…', none: '✅ No open problems.', limit: (m) => `Too many questions — try again in ${m} min.`, off: 'KubeEZ AI is turned off for this workspace.', noAi: 'No AI engine could answer right now — here are the facts:', unknownN: (n) => `There is no problem #${n} — send "incidents" for the list.`, openIn: 'Open in KubeEZ to preview and apply:', noFix: 'No fix KubeEZ can run for this one — the steps above are for a person.' },
    hinglish: { looking: '🔎 Dekh raha hoon…', none: '✅ Abhi koi problem nahi hai.', limit: (m) => `Bahut saare sawaal — ${m} min baad try karo.`, off: 'Is workspace mein KubeEZ AI band hai.', noAi: 'Abhi koi AI engine jawab nahi de paya — ye facts hain:', unknownN: (n) => `Problem #${n} nahi hai — list ke liye "incidents" bhejo.`, openIn: 'KubeEZ mein preview karke apply karo:', noFix: 'Iske liye KubeEZ khud fix nahi chala sakta — upar ke steps follow karo.' },
    hi: { looking: '🔎 देख रहा हूँ…', none: '✅ अभी कोई समस्या नहीं है।', limit: (m) => `बहुत सारे सवाल — ${m} मिनट बाद कोशिश करें।`, off: 'इस वर्कस्पेस में KubeEZ AI बंद है।', noAi: 'अभी कोई AI इंजन जवाब नहीं दे पाया — ये तथ्य हैं:', unknownN: (n) => `समस्या #${n} नहीं है — सूची के लिए "incidents" भेजें।`, openIn: 'KubeEZ में देखकर लागू करें:', noFix: 'इसके लिए KubeEZ खुद सुधार नहीं चला सकता — ऊपर के कदम अपनाएँ।' }
}

// ── what was asked ──
export function intentOf(raw) {
    const text = String(raw || '').trim().replace(/^\/(ask|kubeez)(@\w+)?\s*/i, '').replace(/^@\w+\s*/, '').trim()
    const t = text.toLowerCase()
    const num = (t.match(/#?\b(\d{1,2})\b/) || [])[1]
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

function listText(sc, state, lang) {
    const list = openIncidents(sc).slice(0, 10)
    state.list = list.map(i => i.id); state.at = Date.now()
    if (!list.length) return T[lang].none
    return list.map((i, n) => `${n + 1}. ${sev(i)} ${reasonLabel(i.reason)} — ${i.clusterName}: ${i.namespace ? `${i.namespace}/` : ''}${i.target}`).join('\n') +
        `\n\n${lang === 'en' ? 'Send "why 1" for the cause, "fix 1" for a fix.' : lang === 'hi' ? 'कारण के लिए "why 1", सुधार के लिए "fix 1" भेजें।' : 'Wajah ke liye "1 kyu", fix ke liye "fix 1" bhejo.'}`
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
    const lang = detectLanguage(intent.text || ctx.text)
    const L = T[lang]
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
    if (['status', 'incidents'].includes(intent.kind)) { const q = queryOf(intent.text); if (q && q.resource !== 'warnings') intent.kind = 'ask' }

    try {
        switch (intent.kind) {
            case 'help': return { reply: helpText(lang) }
            case 'incidents': return { reply: listText(sc, state, lang) }
            case 'status': {
                const clusters = await clustersOf(sc)
                if (!clusters.length) return { reply: lang === 'en' ? 'No clusters yet.' : 'Abhi koi cluster nahi hai.' }
                const mon = incidentDetector.getMonitoring()
                const lines = clusters.map(c => {
                    const inc = incidentDetector.getIncidents().filter(i => i.clusterId === c.id && !CLOSED.has(i.status) && !i.causedBy && mayView(sc, i))
                    const m = mon.find(x => x.clusterId === c.id)
                    const r = riskScore({ cluster: c, incidents: inc, monitoring: m ? { watched: true, connected: m.connected } : { watched: false }, snapshot: cachedSnapshot(c.id), offsite: undefined, compliance: null })
                    return `${RISK[r.level]} ${c.clusterName} — risk ${r.score}/100, ${inc.length} open${r.factors[0] ? ` · ${r.factors[0].label}` : ''}`
                })
                return { reply: `${lines.join('\n')}\n\n${listText(sc, state, lang)}` }
            }
            case 'explain': case 'fix': {
                const inc = pick(sc, state, intent.n)
                if (!inc) return { reply: L.unknownN(intent.n) }
                const cluster = (await clustersOf(sc)).find(c => c.id === inc.clusterId)
                if (!cluster) return { reply: L.unknownN(intent.n) }
                if (!s.enabled) return { reply: L.off }
                await ctx.send?.(L.looking)
                const out = await explainIncidentFull({ ...u, language: lang }, inc, cluster)
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
                if (!c) return { reply: `${lang === 'en' ? 'Which cluster?' : 'Kaunsa cluster?'} ${clusters.map(x => x.clusterName).join(', ')}` }
                const r = await collectChanges(c, { hours: intent.hours })
                if (!r.items.length) return { reply: `${c.clusterName}: ${lang === 'en' ? `no changes in the last ${intent.hours} h.` : `pichhle ${intent.hours} ghante mein koi change nahi.`}` }
                const facts = `${c.clusterName} — ${r.items.length} change(s), last ${intent.hours} h:\n${changesText(r.items, 8).split('\n').map(l => `• ${l.replace(/^\S+ /, '')}`).join('\n')}`
                if (!s.enabled) return { reply: facts }
                await ctx.send?.(L.looking)
                try { const sum = await summarizeChanges({ ...u, language: lang }, c, r); return { reply: `${c.clusterName} (${intent.hours} h):\n${sum.summary}` } }
                catch { return { reply: facts } }
            }
            default: {
                const clusters = await clustersOf(sc)
                // the clusters this is about: the one named, else all of them (up to 5)
                const named = clusters.filter(c => new RegExp(`(^|[^a-z0-9-])${String(c.clusterName).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`).test(intent.text.toLowerCase()))
                const about = (named.length ? named : clusters).slice(0, 5)
                const snaps = await Promise.all(about.map(c => within(snapshotOf(c), 20e3).then(snap => ({ c, snap: limitSnapshot(snap, nsFilter(sc, u, c)) })).catch(e => ({ c, error: e.message }))))
                // what is in a cluster: answered exactly by KubeEZ, no AI, a second or two
                const q = queryOf(intent.text, snaps.flatMap(x => x.snap?.namespaces || []))
                if (q && !clusters.length) return { reply: lang === 'en' ? 'No clusters yet — add or install one in KubeEZ first.' : 'Abhi koi cluster nahi hai — pehle KubeEZ mein ek cluster jodo.' }
                if (q) {
                    const parts = snaps.map(x => x.snap ? answerQuery(q, x.snap, x.c.clusterName, lang) : `${x.c.clusterName}: ⚠ ${lang === 'en' ? 'could not read the cluster' : 'cluster padh nahi paya'} — ${x.error}`).filter(Boolean)
                    if (parts.length) return { reply: parts.join('\n\n').slice(0, 3500), direct: snaps.some(x => x.snap) }
                }
                if (!s.enabled) return { reply: L.off }
                await ctx.send?.(L.looking)
                const facts = [
                    `Clusters: ${clusters.map(c => `${c.clusterName} (Kubernetes ${c.k8sVersion}, ${(c.masterNodes || []).length} control-plane, ${(c.workerNodes || []).length} workers)`).join('; ') || 'none'}`,
                    `Open problems: ${openIncidents(sc).slice(0, 15).map(i => `${reasonLabel(i.reason)} on ${i.clusterName} ${i.namespace ? `${i.namespace}/` : ''}${i.target}: ${i.message}`).join(' | ') || 'none'}`,
                    ...snaps.filter(x => x.snap).map(x => snapshotText(x.snap, x.c.clusterName))
                ].join('\n')
                const r = await ask(u, {
                    task: 'chat', purpose: `chat (${source})`, maxTokens: 300, language: lang,
                    system: CHAT_SYSTEM,
                    data: [{ label: 'workspace facts (live)', text: facts }], question: intent.text
                })
                return { reply: r.text.trim().slice(0, 3500) }
            }
        }
    } catch (e) {
        if (e instanceof AiUnavailable || e.code === 'AI_UNAVAILABLE') return { reply: `${L.noAi}\n${listText(sc, state, lang)}` }
        return { reply: `⚠ ${e.message}` }
    }
}

function helpText(lang) {
    if (lang === 'hinglish') return 'Main KubeEZ AI hoon. Poocho:\n• "sab theek hai?" — clusters aur risk\n• "kya problem hai" — open problems (number ke saath)\n• "2 kyu hua" — problem 2 ki wajah\n• "fix 2" — fix ka dry-run (apply KubeEZ mein)\n• "prod pe kya badla 6h" — changes\n• kuch bhi Kubernetes ke baare mein'
    if (lang === 'hi') return 'मैं KubeEZ AI हूँ। पूछें:\n• "सब ठीक है?" — क्लस्टर और जोखिम\n• "incidents" — खुली समस्याएँ\n• "why 2" — समस्या 2 का कारण\n• "fix 2" — सुधार का dry-run\n• "क्या बदला prod 6h" — बदलाव'
    return 'I am KubeEZ AI. Ask me:\n• "status" — clusters and risk\n• "incidents" — open problems, numbered\n• "why 2" — the cause of problem 2\n• "fix 2" — the suggested fix with its dry-run (applied in KubeEZ)\n• "what changed prod 6h" — the change timeline\n• anything about Kubernetes'
}

export function _reset() { chats.clear() }
