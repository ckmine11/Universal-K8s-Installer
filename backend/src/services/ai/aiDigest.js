// The AI digest: once a day or once a week (AI settings), the connected AI
// writes a short summary of the workspace — what broke and what is still open,
// what changed through KubeEZ, the riskiest clusters, what to do next — and it
// goes to the alert channels. Without an AI the facts go out alone. Sent at
// the chosen hour in the workspace's time zone (Alerts → quiet hours).
import { aiStore } from './aiStore.js'
import { ask, routeFor } from './engine.js'
import { alertUser } from './alertExplain.js'

export const DIGEST_MODES = ['off', 'daily', 'weekly']
const DAY = 86400e3
// changes made in KubeEZ that belong in a digest (not logins, AI questions, page views…)
const QUIET = /^(auth\.|ai\.ask|ai\.feedback|ai\.models_new|session\.|user\.login|audit\.)/

const localParts = (now, tz) => {
    let p
    try { p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hour12: false }).formatToParts(now).map(x => [x.type, x.value])) }
    catch { return localParts(now, 'UTC') }
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday }
}

/** Is a digest due now? → the key that marks it sent (one per day / week), or null */
export function dueKey(s, tz, now = new Date()) {
    if (!DIGEST_MODES.includes(s.digest) || s.digest === 'off') return null
    const l = localParts(now, tz)
    if (l.hour < (s.digestHour ?? 9)) return null
    if (s.digest === 'weekly' && l.weekday !== 'Mon') return null
    const key = `${s.digest}:${l.date}`
    return s.digestLast === key ? null : key
}

/** The facts of the period, as text for the AI (and for a digest without one). */
export async function digestFacts(orgId, { days, now = Date.now(), deps = {} } = {}) {
    const from = now - days * DAY
    const { incidentDetector } = deps.incidents ? { incidentDetector: { getIncidents: () => deps.incidents } } : await import('../incidentDetector.js')
    const { auditLog } = deps.audit ? { auditLog: { query: () => deps.audit } } : await import('../auditLog.js')
    const mine = incidentDetector.getIncidents().filter(i => i.orgId === orgId)
    const fresh = mine.filter(i => Date.parse(i.timestamp) >= from)
    const open = mine.filter(i => !['resolved', 'cleared'].includes(i.status))
    const byReason = {}
    for (const i of fresh) byReason[i.reason] = (byReason[i.reason] || 0) + 1
    const line = (i) => `${i.severity || 'warning'} ${i.reason} — ${i.clusterName || i.clusterId}: ${i.namespace ? `${i.namespace}/` : ''}${i.target} (${i.status}${i.causedBy ? ', caused by another incident' : ''})`
    const changes = auditLog.query({ orgId, from, to: now, limit: 400 }).filter(r => !QUIET.test(r.action))
    const byAction = {}
    for (const r of changes) byAction[r.action] = (byAction[r.action] || 0) + 1
    let fleet = ''
    try {
        const { fleetFor } = await import('./insights.js')
        const { fleetText } = await import('./fleet.js')
        fleet = fleetText(deps.fleet || await fleetFor(alertUser(orgId)))
    } catch (e) { fleet = `Fleet facts not available (${e.message}).` }
    const usage = (await import('./usage.js')).usageSummary(orgId, { now })
    return {
        counts: { fresh: fresh.length, open: open.length, critical: open.filter(i => i.severity === 'critical').length, changes: changes.length },
        text: [
            `Period: the last ${days === 1 ? '24 hours' : `${days} days`}.`,
            `New incidents: ${fresh.length}${fresh.length ? ` — ${Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ×${n}`).join(', ')}` : ''}.`,
            fresh.length ? `Newest: ${fresh.slice(0, 8).map(line).join('; ')}` : '',
            `Still open now: ${open.length}${open.length ? ` — ${open.slice(0, 8).map(line).join('; ')}` : ''}.`,
            `Changes made through KubeEZ: ${changes.length}${changes.length ? ` — ${Object.entries(byAction).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a, n]) => `${a} ×${n}`).join(', ')}` : ''}.`,
            changes.length ? `Latest changes: ${changes.slice(0, 10).map(r => `${r.at.slice(0, 16).replace('T', ' ')} ${r.action}${r.target?.clusterName ? ` on ${r.target.clusterName}` : ''}${r.actor?.username ? ` by ${r.actor.username}` : ''}${r.ok === false ? ' (failed)' : ''}`).join('; ')}` : '',
            fleet,
            usage.month.calls ? `AI use this month: ${usage.month.calls} answers, ${usage.month.costText}${usage.budget ? ` of a ${usage.budgetText} budget` : ''}.` : ''
        ].filter(Boolean).join('\n')
    }
}

/** Build the digest (AI-written when an AI is connected) and send it. */
export async function sendDigest(orgId, { mode, now = Date.now(), deps = {} } = {}) {
    const s = aiStore.get(orgId)
    mode = mode || (s.digest === 'weekly' ? 'weekly' : 'daily')
    const days = mode === 'weekly' ? 7 : 1
    const facts = await digestFacts(orgId, { days, now, deps })
    let body = null, engine = null, aiError = null
    if (s.enabled && routeFor(orgId, 'summarize').length) {
        try {
            const r = await ask(alertUser(orgId), {
                task: 'summarize', purpose: `${mode} digest`, maxTokens: 900,
                system: `Write the ${mode} digest of this Kubernetes workspace for the team's chat channel. At most 8 short lines, each starting with "- ", most important first: what broke and whether it is still open, problems that repeat (one root cause?), the riskiest clusters and why, notable changes, and the 1–3 things to do next. Plain text only — no headings, no bold, no tables. Only use the facts; if nothing happened, say so in one line.`,
                data: [{ label: 'workspace facts', text: facts.text }], question: `Write the ${mode} digest.`
            })
            body = r.text.trim(); engine = `${r.provider}${r.model ? ` (${r.model})` : ''}`
        } catch (e) { aiError = e.message }
    }
    if (!body) body = `${facts.text}${aiError ? `\n\n(The AI could not write the summary: ${aiError})` : '\n\n(Connect an AI in KubeEZ → AI settings for a written summary.)'}`
    const { notifier } = deps.notifier ? { notifier: deps.notifier } : await import('../notifier.js')
    const c = facts.counts
    const r = await notifier.sendTo(orgId, {
        type: 'ai_digest', followUp: true, long: true, severity: c.critical ? 'warning' : 'info',
        title: `📋 KubeEZ ${mode} digest — ${c.fresh} new incident${c.fresh === 1 ? '' : 's'}, ${c.open} open, ${c.changes} change${c.changes === 1 ? '' : 's'}`,
        text: `${body}${engine ? `\n\nWritten by the connected AI · ${engine}` : ''}`, link: '/incidents'
    })
    return { sent: r.sent, text: body, engine, aiError }
}

let timer = null
/** Every 10 minutes: send the digests that are due. */
export function startAiDigest({ everyMs = 10 * 60e3 } = {}) {
    if (timer || process.env.NODE_ENV === 'test') return
    const tick = async () => {
        const { notificationStore } = await import('../notificationStore.js')
        for (const orgId of aiStore.orgIds()) {
            try {
                const s = aiStore.get(orgId)
                const key = dueKey(s, notificationStore.rules(orgId)?.quietHours?.timezone || 'Asia/Kolkata')
                if (!key) continue
                aiStore.save(orgId, { digestLast: key })   // first: a failure is not retried every 10 minutes
                await sendDigest(orgId)
            } catch (e) { console.error('[AI digest]', orgId, e.message) }
        }
    }
    timer = setInterval(() => { tick().catch(() => { }) }, everyMs)
    timer.unref?.()
}
