import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { deliveryStore } from '../services/deliveryStore.js'
import { listCharts } from '../services/chartCatalog.js'
import { listReleases, valuesOf, compareValues, RELEASE } from '../services/helmApps.js'
import { apiTokens } from '../services/apiTokens.js'
import { cleanPromotion, openPromotionPr } from '../services/gitPromote.js'

// Delivery settings of the workspace (mounted at /api/delivery):
//   environments  GET (members see those on clusters they see) · POST/PUT/DELETE env:manage
//   repos         GET (no passwords) · POST/PUT/DELETE chartrepo:manage · GET /repos/:id/charts
//   freezes       GET · POST/DELETE freeze:manage
//   compare       POST { release, a: envId, b: envId } — values and chart of one app in two environments
const router = express.Router()
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

// ── Git accounts and promotions by pull request (GitOps level 3) ──
router.get('/git', (req, res) => res.json({ accounts: deliveryStore.gitAccounts(req.user.orgId), canManage: canOn(req.user, 'gitrepo:manage') }))
const saveGit = (req, res) => { try { res.json(deliveryStore.saveGitAccount(req.user.orgId, { ...req.body, id: req.params.accountId || undefined }, { by: req.user.username })) } catch (e) { fail(res, e) } }
router.post('/git', requirePermission('gitrepo:manage'), saveGit)
router.put('/git/:accountId', requirePermission('gitrepo:manage'), saveGit)
router.delete('/git/:accountId', requirePermission('gitrepo:manage'), (req, res) => deliveryStore.removeGitAccount(req.user.orgId, req.params.accountId) ? res.json({ success: true }) : res.status(404).json({ error: 'Git account not found' }))
router.post('/promote', requirePermission('gitops:create'), async (req, res) => {
    const account = deliveryStore.gitAccountCredentials(req.user.orgId, String(req.body?.accountId || ''))
    if (!account?.token) return res.status(400).json({ error: 'Pick one of the workspace\'s Git accounts' })
    try {
        const p = cleanPromotion(req.body)
        const pr = await openPromotionPr(account, p, { by: req.user.username })
        req.auditDetail = `pull request #${pr.number} on ${p.repo} (${p.path}): ${pr.changes.map(c => `${c.key} → ${c.to}`).join(', ')}`
        res.json({ success: true, ...pr })
    } catch (e) { fail(res, e) }
})

export default router
