// An explanation inside each alert: right after a new incident alert went out,
// the connected AI looks at it (fresh logs, events, the changes before it — the
// same explainer as the Incidents page) and its likely cause and fix go to the
// same channels, as a reply under the alert in Telegram. Once per incident, a
// few per hour per workspace, only warnings and critical ones, only when an AI
// is connected and "AI cause & fix in alerts" is on (AI settings).
import { aiStore } from './aiStore.js'
import { routeFor } from './engine.js'

export const PER_HOUR = 6
const explained = new Map()   // incidentId → when
const recent = new Map()      // orgId → [timestamps]

// who asks: KubeEZ itself, for the workspace (shows as "KubeEZ alerts" in AI activity)
export const alertUser = (orgId) => ({ id: 'kubeez-alerts', username: 'KubeEZ alerts', orgId, role: 'admin' })

/** Should this alert get the AI follow-up? → null (yes) or why not */
export function skipReason(orgId, ev, now = Date.now()) {
    const s = aiStore.get(orgId)
    if (!s.enabled || s.alertExplain === false) return 'AI cause & fix in alerts is off'
    if (ev.type !== 'incident' || !ev.incidentId || ev.recovery) return 'not a new incident'
    if (!['warning', 'critical'].includes(ev.severity)) return 'only warnings and critical alerts'
    if (!routeFor(orgId, 'explain').length) return 'no AI connected'
    if (explained.has(ev.incidentId)) return 'already explained'
    const list = (recent.get(orgId) || []).filter(t => now - t < 3600e3)
    recent.set(orgId, list)
    if (list.length >= PER_HOUR) return `at most ${PER_HOUR} AI follow-ups an hour`
    return null
}

/** The follow-up's text — short enough for a chat message. */
export function followUpText(a) {
    return [
        a.summary,
        a.cause ? `Likely cause: ${a.cause}` : '',
        a.change ? `Changed before it: ${a.change}` : '',
        ...(a.fix || []).slice(0, 4).map((x, i) => `${i + 1}. ${x}`),
        a.confidence ? `Confidence: ${a.confidence}` : ''
    ].filter(Boolean).join('\n')
}

/**
 * After an incident alert went out. sent: [{ channelId, messageId }] — the
 * channels it reached. deps (tests): { find, cluster, explain, notifier }
 */
export async function afterAlert(orgId, ev, sent, deps = {}) {
    const why = skipReason(orgId, ev)
    if (why) return { skipped: why }
    explained.set(ev.incidentId, Date.now())
    if (explained.size > 2000) explained.delete(explained.keys().next().value)
    recent.get(orgId).push(Date.now())
    const { incidentDetector } = deps.find ? { incidentDetector: { find: deps.find } } : await import('../incidentDetector.js')
    const inc = incidentDetector.find(ev.incidentId)
    if (!inc) return { skipped: 'incident gone' }
    const cluster = deps.cluster || (await (await import('../installationManager.js')).installationManager.getSavedClusters()).find(c => c.id === inc.clusterId)
    if (!cluster) return { skipped: 'cluster gone' }
    const explain = deps.explain || (await import('./incidentExplain.js')).explainIncidentFull
    let out
    try { out = await explain(alertUser(orgId), inc, cluster) }
    catch (e) { return { skipped: `the AI could not answer: ${e.message}` } }
    // fixed while the AI was thinking: no follow-up about something already gone
    const now = incidentDetector.find(ev.incidentId)
    if (!now || ['resolved', 'cleared'].includes(now.status)) return { skipped: 'resolved meanwhile' }
    const { notifier } = deps.notifier ? { notifier: deps.notifier } : await import('../notifier.js')
    const engine = out.engine ? ` · ${out.engine.provider}${out.engine.model ? ` (${out.engine.model})` : ''}` : ''
    const r = await notifier.sendTo(orgId, {
        type: 'ai_explain', followUp: true, severity: ev.severity,
        title: `🤖 AI: likely cause & fix — ${String(ev.title || '').slice(0, 150)}`,
        text: `${followUpText(out.answer)}\n\nWritten by the connected AI${engine} — check before acting.`,
        clusterId: ev.clusterId, clusterName: ev.clusterName, link: `/incidents?open=${ev.incidentId}`
    }, sent)
    return { sent: r.sent }
}

export function _reset() { explained.clear(); recent.clear() }
