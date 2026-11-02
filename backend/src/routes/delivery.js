import express from 'express'
import { requireFeature, features } from '../services/features.js'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { deliveryStore, checkFreeze } from '../services/deliveryStore.js'
import { listCharts } from '../services/chartCatalog.js'
import { listReleases, valuesOf, compareValues, RELEASE, cleanDeploy, deploy, jobView, findJob } from '../services/helmApps.js'
import { previewKey, previewNamespace, startPreview, removePreview, MAX_PREVIEWS } from '../services/previews.js'
import { cleanRule } from '../services/chatDeploy.js'
import { notificationStore } from '../services/notificationStore.js'
import { aiStore } from '../services/ai/aiStore.js'
import { requireApproval } from '../services/approvals.js'
import { capabilities } from '../services/clusterAccess.js'
import { apiTokens } from '../services/apiTokens.js'
import { cleanRegistry } from '../services/appMetrics.js'
import { cleanRates, DEFAULT_RATES } from '../services/costs.js'
import { cleanSchedule } from '../services/hibernateSchedule.js'
import { SYSTEM_NS } from '../services/gitops.js'
import { cleanPromotion, openPromotionPr, PROVIDERS } from '../services/gitPromote.js'

// Delivery settings of the workspace (mounted at /api/delivery):
//   environments  GET (members see those on clusters they see) · POST/PUT/DELETE env:manage
//   repos         GET (no passwords) · POST/PUT/DELETE chartrepo:manage · GET /repos/:id/charts
//   freezes       GET · POST/DELETE freeze:manage
//   compare       POST { release, a: envId, b: envId } — values and chart of one app in two environments
const router = express.Router()
// feature flags (services/features.js): a feature that is off answers 403 FEATURE_OFF
router.use('/repos', requireFeature('helmApps'))
router.use('/compare', requireFeature('helmApps'))
router.use('/costs', requireFeature('costs'))
router.use('/hibernate-schedules', requireFeature('hibernate'), requireFeature('hibernateSchedule'))
router.use('/promote-release', requireFeature('helmApps'), requireFeature('promotion'))
router.use('/tokens', requireFeature('deployTokens'))
router.use('/git', requireFeature('gitopsPromote'))
router.use('/promote', requireFeature('gitopsPromote'))
router.use('/registries', requireFeature('registries'))
router.use('/previews', requireFeature('helmApps'), requireFeature('previews'))
router.use('/chat-deploy', requireFeature('chatDeploy'))
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })
const clustersOf = async (user) => (await clusterStore.getClusters().catch(() => [])).filter(c => canAccessResource(user, c) && c.orgId === user.orgId)
const orgOnly = (req, res, next) => req.user?.orgId ? next() : res.status(400).json({ error: 'Delivery settings belong to a workspace' })
router.use(orgOnly)

// ── environments ──
router.get('/environments', async (req, res) => {
    const clusters = await clustersOf(req.user)
    const seen = new Map(clusters.filter(c => canSeeCluster(req.user, c)).map(c => [c.id, c]))
    res.json({
        environments: deliveryStore.environments(req.user.orgId).filter(e => seen.has(e.clusterId)).map(e => ({ ...e, clusterName: seen.get(e.clusterId).clusterName })),
        canManage: canOn(req.user, 'env:manage')
    })
})
const saveEnv = async (req, res) => {
    try {
        const clusterIds = (await clustersOf(req.user)).map(c => c.id)
        res.json(deliveryStore.saveEnvironment(req.user.orgId, { ...req.body, id: req.params.envId || undefined }, { clusterIds, by: req.user.username }))
    } catch (e) { fail(res, e) }
}
router.post('/environments', requirePermission('env:manage'), saveEnv)
router.put('/environments/:envId', requirePermission('env:manage'), saveEnv)
router.delete('/environments/:envId', requirePermission('env:manage'), (req, res) => deliveryStore.removeEnvironment(req.user.orgId, req.params.envId) ? res.json({ success: true }) : res.status(404).json({ error: 'Environment not found' }))

// ── chart repositories ──
router.get('/repos', (req, res) => res.json({ repos: deliveryStore.repos(req.user.orgId), canManage: canOn(req.user, 'chartrepo:manage') }))
const saveRepo = (req, res) => { try { res.json(deliveryStore.saveRepo(req.user.orgId, { ...req.body, id: req.params.repoId || undefined }, { by: req.user.username })) } catch (e) { fail(res, e) } }
router.post('/repos', requirePermission('chartrepo:manage'), saveRepo)
router.put('/repos/:repoId', requirePermission('chartrepo:manage'), saveRepo)
router.delete('/repos/:repoId', requirePermission('chartrepo:manage'), (req, res) => deliveryStore.removeRepo(req.user.orgId, req.params.repoId) ? res.json({ success: true }) : res.status(404).json({ error: 'Repository not found' }))
router.get('/repos/:repoId/charts', async (req, res) => {
    const repo = deliveryStore.repoCredentials(req.user.orgId, req.params.repoId)
    if (!repo) return res.status(404).json({ error: 'Repository not found' })
    try { res.json(await listCharts(repo, { q: String(req.query.q || '').slice(0, 100), fresh: req.query.fresh === '1' })) } catch (e) { fail(res, e) }
})

// ── change freezes ──
router.get('/freezes', (req, res) => res.json({ freezes: deliveryStore.freezes(req.user.orgId), canManage: canOn(req.user, 'freeze:manage') }))
router.post('/freezes', requirePermission('freeze:manage'), async (req, res) => {
    try { res.json(deliveryStore.saveFreeze(req.user.orgId, req.body, { clusterIds: (await clustersOf(req.user)).map(c => c.id), by: req.user.username })) } catch (e) { fail(res, e) }
})
router.delete('/freezes/:freezeId', requirePermission('freeze:manage'), (req, res) => deliveryStore.removeFreeze(req.user.orgId, req.params.freezeId) ? res.json({ success: true }) : res.status(404).json({ error: 'Freeze not found' }))

// ── compare one app across two environments (config drift) ──
router.post('/compare', async (req, res) => {
    const release = String(req.body?.release || '')
    if (!RELEASE.test(release)) return res.status(400).json({ error: 'Not a valid release name' })
    const clusters = await clustersOf(req.user)
    const sides = []
    for (const k of ['a', 'b']) {
        const env = deliveryStore.environment(req.user.orgId, req.body?.[k])
        const cluster = env && clusters.find(c => c.id === env.clusterId)
        const nss = cluster && accessOn(req.user, cluster).namespaces
        // an environment the member may not see is "not found", like a cluster
        if (!env || !cluster || !canSeeCluster(req.user, cluster) || (nss && !nsMatches(nss, env.namespace))) return res.status(404).json({ error: 'Environment not found' })
        if (!canOn(req.user, 'app:values', cluster)) return res.status(403).json({ error: `Your role may not see app values on ${cluster.clusterName}.`, requiredPermission: 'app:values' })
        sides.push({ env, cluster })
    }
    try {
        const out = await Promise.all(sides.map(async ({ env, cluster }) => {
            const rel = (await listReleases(cluster)).find(r => r.namespace === env.namespace && r.name === release) || null
            return { env: { id: env.id, name: env.name, clusterName: cluster.clusterName, namespace: env.namespace }, release: rel, values: rel ? await valuesOf(cluster, env.namespace, release) : null }
        }))
        const [a, b] = out
        res.json({
            release, a: { env: a.env, release: a.release }, b: { env: b.env, release: b.release },
            chartDiffers: !!(a.release && b.release && (a.release.chart !== b.release.chart || a.release.version !== b.release.version)),
            values: a.release && b.release ? compareValues(a.values, b.values) : null
        })
    } catch (e) { fail(res, e) }
})

// ── promotion pipeline: an app from one environment into the next ──
// The target gets the source's chart version and the chosen values (image.tag
// by default); everything else keeps the target's own values. Protected
// targets need a second person; freezes and the target's CVE policy apply.
const KEY = /^[A-Za-z0-9_-]{1,60}(\.[A-Za-z0-9_-]{1,60}){0,7}$/
async function promotionPlan(req) {
    const b = req.body || {}
    if (!RELEASE.test(String(b.release || ''))) throw Object.assign(new Error('Not a valid release name'), { status: 400 })
    const keys = Array.isArray(b.keys) && b.keys.length ? b.keys.map(String) : ['image.tag']
    if (keys.length > 20 || keys.some(k => !KEY.test(k) || k.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p)))) throw Object.assign(new Error('keys: up to 20 value paths like image.tag'), { status: 400 })
    if (b.from === b.to) throw Object.assign(new Error('Pick two different environments'), { status: 400 })
    const clusters = await clustersOf(req.user)
    const side = (envId) => {
        const env = deliveryStore.environment(req.user.orgId, envId)
        const cluster = env && clusters.find(c => c.id === env.clusterId)
        const nss = cluster && accessOn(req.user, cluster).namespaces
        if (!env || !cluster || !canSeeCluster(req.user, cluster) || (nss && !nsMatches(nss, env.namespace))) throw Object.assign(new Error('Environment not found'), { status: 404 })
        return { env, cluster }
    }
    const from = side(b.from), to = side(b.to)
    if (!canOn(req.user, 'app:values', from.cluster)) throw Object.assign(new Error(`Your role may not see app values on ${from.cluster.clusterName}.`), { status: 403 })
    if (!canOn(req.user, 'app:deploy', to.cluster)) throw Object.assign(new Error(`Your role may not deploy on ${to.cluster.clusterName}.`), { status: 403 })
    const repo = deliveryStore.repoCredentials(req.user.orgId, String(b.repoId || ''))
    if (!repo) throw Object.assign(new Error('Pick the chart repository the app comes from'), { status: 400 })
    return { b, keys, from, to, repo }
}
// the approval is asked on the target's cluster
const promoteTarget = async (req, res, next) => {
    try { const p = await promotionPlan(req); req.params.id = p.to.cluster.id; req.permissionCluster = p.to.cluster; next() } catch (e) { fail(res, e) }
}
router.post('/promote-release', requirePermission('app:deploy'), promoteTarget, requireApproval('app:promote', { always: (req) => !!deliveryStore.environment(req.user.orgId, req.body?.to)?.protected }), async (req, res) => {
    try {
        const { b, keys, from, to, repo } = await promotionPlan(req)
        const w = capabilities(to.cluster).helmApps
        if (w?.ok === false) return res.status(409).json({ error: w.why })
        const override = checkFreeze(req.user, to.cluster, b)
        const src = (await listReleases(from.cluster)).find(r => r.namespace === from.env.namespace && r.name === b.release)
        if (!src) return res.status(404).json({ error: `${b.release} is not installed in ${from.env.name}` })
        const [srcValues, dstValues] = await Promise.all([valuesOf(from.cluster, from.env.namespace, b.release), valuesOf(to.cluster, to.env.namespace, b.release)])
        const values = structuredClone(dstValues || {})
        const moved = []
        for (const k of keys) {
            const parts = k.split('.')
            const v = parts.reduce((o, p) => (o && typeof o === 'object' ? o[p] : undefined), srcValues)
            if (v === undefined) continue
            let o = values
            for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object' || Array.isArray(o[p])) o[p] = {}; o = o[p] }
            o[parts.at(-1)] = v; moved.push(`${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : v}`)
        }
        const d = cleanDeploy({ release: b.release, namespace: to.env.namespace, chart: src.chart, version: src.version }, repo)
        const policy = to.env.cvePolicy && features.usable(req.user.orgId, 'cveGate') ? to.env.cvePolicy : null
        req.auditDetail = `promote ${b.release} ${src.chart} ${src.version || ''} from ${from.env.name} to ${to.env.name}${moved.length ? ` (${moved.join(', ')})` : ''}${override ? ` — ${override}` : ''}`
        const j = await deploy(to.cluster, d, { by: req.user.username, values, gate: policy ? { policy, override: null } : null })
        res.status(202).json({ ...jobView(j), clusterId: to.cluster.id, promoted: { chart: src.chart, version: src.version, values: moved } })
    } catch (e) { fail(res, e) }
})

// ── preview environments: a short-lived copy of an app per pull request / branch ──
// Copying the base needs app:values there (its values are copied) and app:deploy;
// a member limited to some namespaces may only make previews whose namespace is theirs.
const previewView = (p, cluster) => ({ ...p, clusterName: cluster?.clusterName || p.clusterId, job: jobView(findJob(p.jobId)), expired: Date.parse(p.expiresAt) <= Date.now() })
router.get('/previews', async (req, res) => {
    const clusters = await clustersOf(req.user)
    res.json({
        previews: deliveryStore.previews(req.user.orgId).flatMap(p => { const c = clusters.find(x => x.id === p.clusterId); const n = c && accessOn(req.user, c).namespaces; return c && canSeeCluster(req.user, c) && (!n || nsMatches(n, p.namespace)) ? [previewView(p, c)] : [] }),
        canCreate: canOn(req.user, 'app:deploy'), max: MAX_PREVIEWS
    })
})
router.post('/previews', requirePermission('app:deploy'), async (req, res) => {
    try {
        const b = req.body || {}
        const env = deliveryStore.environment(req.user.orgId, String(b.envId || ''))
        const cluster = env && (await clustersOf(req.user)).find(c => c.id === env.clusterId)
        const nss = cluster && accessOn(req.user, cluster).namespaces
        if (!env || !cluster || !canSeeCluster(req.user, cluster) || (nss && !nsMatches(nss, env.namespace))) return res.status(404).json({ error: 'Environment not found' })
        if (!canOn(req.user, 'app:values', cluster) || !canOn(req.user, 'app:deploy', cluster)) return res.status(403).json({ error: `Your role may not copy and deploy apps on ${cluster.clusterName}.`, requiredPermission: 'app:deploy' })
        if (!RELEASE.test(String(b.release || ''))) return res.status(400).json({ error: 'Not a valid release name' })
        const { key, label } = previewKey(b)
        const namespace = previewNamespace(b.release, key)
        if (nss && !nsMatches(nss, namespace)) return res.status(403).json({ error: `You may not deploy into namespace ${namespace}` })
        const w = capabilities(cluster).helmApps
        if (w?.ok === false) return res.status(409).json({ error: w.why })
        const repo = deliveryStore.repoCredentials(req.user.orgId, String(b.repoId || ''))
        if (!repo) return res.status(400).json({ error: 'Pick the chart repository the app comes from' })
        const override = checkFreeze(req.user, cluster, b)
        const r = await startPreview({ orgId: req.user.orgId, cluster, base: { namespace: env.namespace, release: b.release }, key, label, set: b.set, ttlHours: b.ttlHours, repo, by: req.user.username })
        req.auditDetail = `preview ${r.preview.namespace} of ${env.name}/${b.release} (${label}) until ${r.preview.expiresAt.slice(0, 16)}${Object.keys(r.preview.set).length ? ` set ${Object.entries(r.preview.set).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}${override ? ` — ${override}` : ''}`
        res.status(202).json({ preview: previewView(r.preview, cluster), job: jobView(r.job) })
    } catch (e) { fail(res, e) }
})
router.delete('/previews/:pid', async (req, res) => {
    const p = deliveryStore.previews(req.user.orgId).find(x => x.id === req.params.pid)
    const cluster = p && (await clustersOf(req.user)).find(c => c.id === p.clusterId)
    const nss = cluster && accessOn(req.user, cluster).namespaces
    if (!p || !cluster || !canSeeCluster(req.user, cluster) || (nss && !nsMatches(nss, p.namespace))) return res.status(404).json({ error: 'Preview not found' })
    if (!canOn(req.user, 'app:delete', cluster)) return res.status(403).json({ error: 'Your role may not remove apps on this cluster', requiredPermission: 'app:delete' })
    try {
        await removePreview(req.user.orgId, cluster, p)
        req.auditDetail = `remove preview ${p.namespace} (${p.label})`
        res.json({ success: true })
    } catch (e) { fail(res, e) }
})

// ── deploy from chat: what each Slack / Telegram channel may deploy (admins, like deploy tokens) ──
router.get('/chat-deploy', requirePermission('token:manage'), (req, res) => {
    const envs = new Map(deliveryStore.environments(req.user.orgId).map(e => [e.id, e]))
    res.json({
        rules: deliveryStore.chatDeployRules(req.user.orgId).map(r => ({ ...r, envName: envs.get(r.envId)?.name || null })),
        channels: notificationStore.channels(req.user.orgId).filter(c => ['slack', 'telegram'].includes(c.type)).map(c => ({ id: c.id, name: c.name, type: c.type, chatops: aiStore.chatops(req.user.orgId, c.id).enabled }))
    })
})
router.post('/chat-deploy', requirePermission('token:manage'), async (req, res) => {
    try {
        const clusters = await clustersOf(req.user)
        const environments = deliveryStore.environments(req.user.orgId).filter(e => clusters.some(c => c.id === e.clusterId))
        const spec = cleanRule(req.body, { channels: notificationStore.channels(req.user.orgId), environments, repos: deliveryStore.repos(req.user.orgId) })
        const env = environments.find(e => e.id === spec.envId)
        // a chat can never do more than the person who allows it
        if (!canOn(req.user, 'app:deploy', clusters.find(c => c.id === env.clusterId))) return res.status(403).json({ error: 'You may not deploy on that cluster yourself', requiredPermission: 'app:deploy' })
        const r = deliveryStore.saveChatDeployRule(req.user.orgId, { ...spec, createdBy: req.user.username })
        req.auditDetail = `chat ${spec.channelName} (${spec.channelType}) may deploy ${spec.release} to ${env.name} (sets ${spec.key})${spec.allowedUsers.length ? `, only ${spec.allowedUsers.join(', ')}` : ''}`
        res.json({ ...r, envName: env.name })
    } catch (e) { fail(res, e) }
})
router.delete('/chat-deploy/:rid', requirePermission('token:manage'), (req, res) => deliveryStore.removeChatDeployRule(req.user.orgId, req.params.rid) ? res.json({ success: true }) : res.status(404).json({ error: 'Rule not found' }))

// ── cost prices ──
router.get('/costs', (req, res) => res.json({ rates: deliveryStore.costRates(req.user.orgId, DEFAULT_RATES), canManage: canOn(req.user, 'env:manage') }))
router.put('/costs', requirePermission('env:manage'), (req, res) => { try { res.json({ rates: deliveryStore.saveCostRates(req.user.orgId, cleanRates(req.body)) }) } catch (e) { fail(res, e) } })

// ── hibernate schedules ──
router.get('/hibernate-schedules', async (req, res) => {
    const clusters = await clustersOf(req.user)
    res.json({ schedules: deliveryStore.hibernateSchedules(req.user.orgId).filter(s => { const c = clusters.find(x => x.id === s.clusterId); const n = c && accessOn(req.user, c).namespaces; return c && canSeeCluster(req.user, c) && (!n || nsMatches(n, s.namespace)) }) })
})
router.post('/hibernate-schedules', async (req, res) => {
    try {
        const spec = cleanSchedule(req.body)
        const cluster = (await clustersOf(req.user)).find(c => c.id === spec.clusterId)
        if (!cluster || !canSeeCluster(req.user, cluster)) return res.status(404).json({ error: 'Cluster not found' })
        if (!canOn(req.user, 'hibernate:manage', cluster)) return res.status(403).json({ error: 'Your role may not hibernate on this cluster', requiredPermission: 'hibernate:manage' })
        const n = accessOn(req.user, cluster).namespaces
        if (n && !nsMatches(n, spec.namespace)) return res.status(403).json({ error: `You may not change namespace ${spec.namespace}` })
        const admin = ['admin', 'superadmin'].includes(req.user.role)
        if ((SYSTEM_NS.test(spec.namespace) || deliveryStore.environmentAt(req.user.orgId, cluster.id, spec.namespace)?.protected) && !admin) return res.status(403).json({ error: `${spec.namespace} is a system namespace or a protected environment — only an admin may schedule it.` })
        const s = deliveryStore.saveHibernateSchedule(req.user.orgId, spec, { by: req.user.username })
        req.auditDetail = `hibernate schedule ${cluster.clusterName}/${s.namespace}: sleep ${s.sleep}, wake ${s.wake} (${s.timezone}, days ${s.days.join(',')})`
        res.json(s)
    } catch (e) { fail(res, e) }
})
router.delete('/hibernate-schedules/:sid', async (req, res) => {
    const s = deliveryStore.hibernateSchedules(req.user.orgId).find(x => x.id === req.params.sid)
    const cluster = s && (await clustersOf(req.user)).find(c => c.id === s.clusterId)
    if (!s || !cluster || !canSeeCluster(req.user, cluster)) return res.status(404).json({ error: 'Schedule not found' })
    if (!canOn(req.user, 'hibernate:manage', cluster)) return res.status(403).json({ error: 'Your role may not hibernate on this cluster' })
    deliveryStore.removeHibernateSchedule(req.user.orgId, s.id)
    res.json({ success: true })
})

// ── container registries (pull secrets) ──
router.get('/registries', (req, res) => res.json({ registries: deliveryStore.registries(req.user.orgId), canManage: canOn(req.user, 'registry:manage') }))
const saveRegistry = (req, res) => { try { res.json(deliveryStore.saveRegistry(req.user.orgId, { ...req.body, id: req.params.regId || undefined }, { by: req.user.username, clean: cleanRegistry })) } catch (e) { fail(res, e) } }
router.post('/registries', requirePermission('registry:manage'), saveRegistry)
router.put('/registries/:regId', requirePermission('registry:manage'), saveRegistry)
router.delete('/registries/:regId', requirePermission('registry:manage'), (req, res) => deliveryStore.removeRegistry(req.user.orgId, req.params.regId) ? res.json({ success: true }) : res.status(404).json({ error: 'Registry not found' }))

// ── deploy tokens (CI webhook) ──
router.get('/tokens', requirePermission('token:manage'), (req, res) => res.json({ tokens: apiTokens.list(req.user.orgId) }))
router.post('/tokens', requirePermission('token:manage'), async (req, res) => {
    try {
        const clusters = await clustersOf(req.user)
        const cluster = clusters.find(c => c.id === req.body?.clusterId)
        // a token can never do more than the person who makes it
        if (cluster && !canOn(req.user, 'app:deploy', cluster)) return res.status(403).json({ error: `You may not deploy on ${cluster.clusterName} yourself`, requiredPermission: 'app:deploy' })
        const r = apiTokens.create(req.user.orgId, req.body, { by: req.user.username, clusterIds: clusters.map(c => c.id), repoIds: deliveryStore.repos(req.user.orgId).map(x => x.id) })
        req.auditDetail = `deploy token "${r.record.name}" for ${r.record.namespace}/${r.record.release} (${r.record.allowedKeys.join(', ')}), expires ${r.record.expiresAt.slice(0, 10)}`
        res.json(r)
    } catch (e) { fail(res, e) }
})
router.delete('/tokens/:tokenId', requirePermission('token:manage'), (req, res) => apiTokens.revoke(req.user.orgId, req.params.tokenId, req.user.username) ? res.json({ success: true }) : res.status(404).json({ error: 'Token not found' }))

// ── Git accounts and promotions by pull / merge request (GitOps level 3): GitHub, GitLab, Bitbucket ──
router.get('/git', (req, res) => res.json({ accounts: deliveryStore.gitAccounts(req.user.orgId), canManage: canOn(req.user, 'gitrepo:manage'), providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, api: p.api, request: p.request, tokenHint: p.tokenHint }])) }))
const saveGit = (req, res) => { try { res.json(deliveryStore.saveGitAccount(req.user.orgId, { ...req.body, id: req.params.accountId || undefined }, { by: req.user.username })) } catch (e) { fail(res, e) } }
router.post('/git', requirePermission('gitrepo:manage'), saveGit)
router.put('/git/:accountId', requirePermission('gitrepo:manage'), saveGit)
router.delete('/git/:accountId', requirePermission('gitrepo:manage'), (req, res) => deliveryStore.removeGitAccount(req.user.orgId, req.params.accountId) ? res.json({ success: true }) : res.status(404).json({ error: 'Git account not found' }))
router.post('/promote', requirePermission('gitops:create'), async (req, res) => {
    const account = deliveryStore.gitAccountCredentials(req.user.orgId, String(req.body?.accountId || ''))
    if (!account?.token) return res.status(400).json({ error: 'Pick one of the workspace\'s Git accounts' })
    try {
        const p = cleanPromotion(req.body, account.provider || 'github')
        const pr = await openPromotionPr(account, p, { by: req.user.username })
        req.auditDetail = `${PROVIDERS[pr.provider].label} ${PROVIDERS[pr.provider].request} #${pr.number} on ${p.repo} (${p.path}): ${pr.changes.map(c => `${c.key} → ${c.to}`).join(', ')}`
        res.json({ success: true, ...pr })
    } catch (e) { fail(res, e) }
})

export default router
