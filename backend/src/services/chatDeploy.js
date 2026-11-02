import { randomInt } from 'crypto'
import { deliveryStore } from './deliveryStore.js'
import { features } from './features.js'
import { clusterStore } from './clusterStore.js'
import { auditLog } from './auditLog.js'
import { capabilities } from './clusterAccess.js'
import { listReleases, valuesOf, cleanDeploy, deploy, RELEASE } from './helmApps.js'
import { applySet } from './apiTokens.js'
import { signGateFor } from './signGate.js'

// Deploy from chat (Slack / Telegram ChatOps):
//   "deploy web 1.4.2 to staging" / "web 1.4.2 staging pe deploy karo"
//        → KubeEZ repeats what it will do and asks for a code: "confirm 4821"
//   "confirm 4821"    the same person, within 5 minutes → the deploy runs; the
//                     result is posted in the chat when it finishes
//   "cancel"          drops what was asked
//   "deploy list"     what this chat may deploy
// A chat deploys only what an admin allowed for that channel (one app, one
// environment, one value such as image.tag — like a deploy token), optionally
// only for some chat users. Protected environments and change freezes always
// refuse (they need a person in KubeEZ); the environment's CVE policy applies.
const CONFIRM_MS = 5 * 60e3
const RATE = 10, RATE_MS = 3600e3
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,127}$/
const FILLER = new Set(['deploy', 'karo', 'kar', 'kardo', 'do', 'to', 'on', 'in', 'into', 'pe', 'par', 'me', 'mein', 'please', 'pls', 'the', 'version', 'tag', 'env', 'environment', 'app', 'with'])
const pending = new Map()   // chatKey → { code, ruleId, tag, who, at }
const asked = new Map()     // chatKey → [ts]

/** What a chat message asks of deploys, or null (not about deploying). */
export function deployIntent(raw) {
    const orig = String(raw || '').trim().replace(/^\/(ask|kubeez)(@\w+)?\s*/i, '').replace(/^\/deploy(@\w+)?\b/i, 'deploy').replace(/^\/(confirm|cancel)(@\w+)?\b/i, '$1').trim()
    const t = orig.toLowerCase()
    const c = /^(confirm|yes|haan)\s+(\d{4})$/.exec(t)
    if (c) return { kind: 'confirm', code: c[2] }
    if (/^(cancel|ruko|mat karo)$/.test(t)) return { kind: 'cancel' }
    if (/^deploy\s*(list|targets|help|\?)?$|^deploys$|^what can (you|i) deploy\??$/.test(t)) return { kind: 'list' }
    // a command, not a question about deploying ("how to deploy nginx" goes to the AI)
    if (!/^deploy\s/.test(t) && !/\bdeploy\s+(karo|kar\s*do|kardo)[.!]?$/.test(t)) return null
    // the version keeps its case (image tags are case-sensitive)
    const words = orig.replace(/[@:](?=[A-Za-z0-9_])/g, ' ').split(/\s+/).map(w => w.replace(/[?!,]+$/, '').replace(/\.$/, '')).filter(w => w && !FILLER.has(w.toLowerCase()))
    return { kind: 'deploy', words }
}

/** The rule, environment name and tag a "deploy" names, or { error }. */
export function matchDeploy(words, rules, envName) {
    const lower = words.map(w => w.toLowerCase())
    const named = rules.filter(r => lower.includes(r.release) && lower.includes(envName(r)))
    if (!named.length) return { error: 'Name an app and an environment this chat may deploy — send "deploy list".' }
    const r = named[0]
    // the app's and the environment's names once each; what is left is the version
    const rest = [...words]
    for (const n of [r.release, envName(r)]) rest.splice(rest.findIndex(w => w.toLowerCase() === n), 1)
    if (rest.length !== 1) return { error: `Say the version once, e.g. "deploy ${r.release} 1.4.2 to ${envName(r)}".` }
    if (!TAG.test(rest[0])) return { error: `${rest[0]} is not a valid version / image tag.` }
    return { rule: r, tag: rest[0] }
}

const allowedFor = (rule, who) => !rule.allowedUsers?.length || rule.allowedUsers.includes(String(who).toLowerCase().replace(/^@/, ''))
async function placeOf(orgId, rule) {
    const env = deliveryStore.environment(orgId, rule.envId)
    const cluster = env && (await clusterStore.getClusters().catch(() => [])).find(c => c.id === env.clusterId && c.orgId === orgId)
    return { env, cluster }
}
// what refuses a deploy right now (a person in KubeEZ can still do it)
function blocked(orgId, env, cluster) {
    if (!env || !cluster) return 'That environment or its cluster is gone.'
    if (env.protected) return `${env.name} is a protected environment — deploys there need a second person in KubeEZ.`
    const f = deliveryStore.activeFreeze(orgId, cluster.id)
    if (f) return `Change freeze until ${new Date(f.until).toUTCString()}: ${f.reason}.`
    const w = capabilities(cluster).helmApps
    if (w?.ok === false) return w.why
    return null
}

/**
 * One chat message → { reply } when it is about deploying, else null.
 * ctx: { orgId, channelId, chatKey, who, source, text, later?(text) } — later posts the result of the deploy.
 */
export async function handleDeployChat(ctx, { now = Date.now() } = {}) {
    const intent = deployIntent(ctx.text)
    if (!intent || !ctx.channelId) return null
    const { orgId, chatKey, who, source } = ctx
    if (!features.usable(orgId, 'chatDeploy') || !features.usable(orgId, 'helmApps')) return intent.kind === 'deploy' || intent.kind === 'confirm' ? { reply: 'Deploying from chat is not available for this workspace (KubeEZ → Features, Pro plan).' } : null
    const rules = deliveryStore.chatDeployRules(orgId, ctx.channelId)
    const envName = (r) => deliveryStore.environment(orgId, r.envId)?.name || '?'
    if (!rules.length) return { reply: 'This chat may not deploy anything. An admin allows apps for it in KubeEZ → Delivery → Deploy from chat.' }

    if (intent.kind === 'list') {
        return { reply: `This chat may deploy:\n${rules.map(r => `• ${r.release} → ${envName(r)} (sets ${r.key})${r.allowedUsers?.length ? ` — only ${r.allowedUsers.join(', ')}` : ''}`).join('\n')}\n\nSend "deploy ${rules[0].release} <version> to ${envName(rules[0])}".` }
    }
    if (intent.kind === 'cancel') {
        if (!pending.has(chatKey)) return { reply: 'Nothing is waiting for a confirmation.' }
        pending.delete(chatKey)
        return { reply: 'Cancelled — nothing was deployed.' }
    }
    if (intent.kind === 'deploy') {
        const list = (asked.get(chatKey) || []).filter(t => now - t < RATE_MS)
        if (list.length >= RATE) return { reply: `Too many deploy requests from this chat — try again in ${Math.ceil((RATE_MS - (now - list[0])) / 60e3)} min.` }
        asked.set(chatKey, [...list, now])
        const m = matchDeploy(intent.words, rules, envName)
        if (m.error) return { reply: m.error }
        if (!allowedFor(m.rule, who)) return { reply: `${who} may not deploy ${m.rule.release} from this chat.` }
        const { env, cluster } = await placeOf(orgId, m.rule)
        const no = blocked(orgId, env, cluster)
        if (no) return { reply: `⛔ ${no}` }
        const code = String(randomInt(1000, 10000))
        pending.set(chatKey, { code, ruleId: m.rule.id, tag: m.tag, who, at: now })
        return { reply: `About to deploy ${m.rule.release} to ${env.name} (${cluster.clusterName} / ${env.namespace}): ${m.rule.key} = ${m.tag}.\nReply "confirm ${code}" within 5 minutes to go ahead, or "cancel".` }
    }

    // confirm
    const p = pending.get(chatKey)
    if (!p || p.code !== intent.code || now - p.at > CONFIRM_MS) return { reply: p && now - p.at > CONFIRM_MS ? 'That code expired — ask for the deploy again.' : 'That code does not match a deploy waiting here.' }
    if (p.who !== who) return { reply: `Only ${p.who}, who asked for this deploy, may confirm it.` }
    pending.delete(chatKey)
    const rule = deliveryStore.chatDeployRules(orgId, ctx.channelId).find(r => r.id === p.ruleId)
    if (!rule || !allowedFor(rule, who)) return { reply: 'This chat may no longer deploy that app.' }
    const { env, cluster } = await placeOf(orgId, rule)
    const no = blocked(orgId, env, cluster)
    const by = `${who} (${source})`
    const audit = (ok, detail) => auditLog.record({ orgId, actor: { id: `chat:${source}`, username: by }, action: 'chatops.deploy', target: cluster ? { clusterId: cluster.id, clusterName: cluster.clusterName } : undefined, ok, detail })
    if (no) { audit(false, `deploy ${rule.release} ${p.tag}: ${no}`); return { reply: `⛔ ${no}` } }
    try {
        const repo = deliveryStore.repoCredentials(orgId, rule.repoId)
        if (!repo) throw new Error('The chart repository of this app was removed')
        // the chart and version that run now — a chat deploy changes only the one value
        const cur = (await listReleases(cluster)).find(r => r.namespace === env.namespace && r.name === rule.release)
        if (!cur) throw new Error(`${rule.release} is not installed in ${env.name} — install it once in KubeEZ`)
        const values = applySet(await valuesOf(cluster, env.namespace, rule.release), { [rule.key]: p.tag }, [rule.key])
        const d = cleanDeploy({ release: rule.release, namespace: env.namespace, chart: cur.chart, version: cur.version }, repo)
        const j = await deploy(cluster, d, { by: `chat:${by}`, values, gate: env.cvePolicy && features.usable(orgId, 'cveGate') ? { policy: env.cvePolicy, override: null } : null, sign: await signGateFor(orgId, env) })
        audit(true, `deploy ${env.namespace}/${rule.release} ${cur.chart} ${cur.version || ''} set ${rule.key}=${p.tag} (job ${j.id})`)
        j.promise?.then(() => ctx.later?.(j.status === 'done' ? `✅ ${rule.release} ${p.tag} is running in ${env.name}.` : `❌ ${rule.release} ${p.tag} was not deployed to ${env.name}: ${String(j.error || '').slice(0, 500)}`)).catch(() => { })
        return { reply: `🚀 Deploying ${rule.release} ${p.tag} to ${env.name}… I will post here when it is done.`, jobId: j.id }
    } catch (e) {
        audit(false, `deploy ${rule.release} ${p.tag}: ${e.message}`)
        return { reply: `⚠ ${e.message}` }
    }
}

const NAME_LIST = /^[\w.@+-]{1,60}$/
/** An admin's rule for a channel → checked (what a channel may deploy). */
export function cleanRule(b, { channels, environments, repos }) {
    const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }) }
    const ch = channels.find(c => c.id === b?.channelId)
    if (!ch || !['slack', 'telegram'].includes(ch.type)) bad('Pick a Slack or Telegram alert channel')
    const env = environments.find(e => e.id === b?.envId)
    if (!env) bad('Pick an environment')
    if (env.protected) bad(`${env.name} is protected — deploys there need a second person, so a chat cannot deploy there`)
    if (!RELEASE.test(String(b?.release || ''))) bad('Release name is not valid')
    if (!repos.some(r => r.id === b?.repoId)) bad('Pick the chart repository the app comes from')
    const key = String(b?.key || 'image.tag')
    if (!/^[A-Za-z0-9_-]{1,60}(\.[A-Za-z0-9_-]{1,60}){0,5}$/.test(key) || key.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) bad('Value: a path like image.tag')
    const users = (Array.isArray(b?.allowedUsers) ? b.allowedUsers : String(b?.allowedUsers || '').split(',')).map(s => String(s).trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    if (users.length > 50 || users.some(u => !NAME_LIST.test(u))) bad('Allowed users: chat user names, comma separated')
    return { channelId: ch.id, channelName: ch.name, channelType: ch.type, envId: env.id, release: b.release, repoId: b.repoId, key, allowedUsers: [...new Set(users)] }
}

export const _test = { reset() { pending.clear(); asked.clear() }, pending }
