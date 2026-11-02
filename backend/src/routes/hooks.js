import express from 'express'
import { apiTokens, applySet } from '../services/apiTokens.js'
import { features, upgradeBody } from '../services/features.js'
import { clusterStore } from '../services/clusterStore.js'
import { deliveryStore, checkFreeze } from '../services/deliveryStore.js'
import { capabilities } from '../services/clusterAccess.js'
import { auditLog } from '../services/auditLog.js'
import { valuesOf, cleanDeploy, deploy, findJob, jobView, VERSION } from '../services/helmApps.js'
import { leadTimes, cleanCommit } from '../services/leadTime.js'
import { previewKey, previewNamespace, startPreview, removePreview } from '../services/previews.js'

// The deploy webhook for CI (mounted at /api/hooks, no session — a deploy token):
//   POST /api/hooks/deploy     Authorization: Bearer kzt_…   { set: { "image.tag": "1.4.2" }, version?, commit?: { sha, time } }
//                              a commit makes the deploy count for DORA lead time once it succeeds
//   GET  /api/hooks/jobs/:id   the job it started
// The token decides everything else (cluster, namespace, release, repository,
// chart, which values may change). Change freezes, protected environments and
// the CVE policy apply — a token never overrides them.
const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) })

async function tokenOf(req, res) {
    const t = apiTokens.verify(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''))
    if (!t) { res.status(401).json({ error: 'Unknown, expired or revoked deploy token' }); return null }
    if (!features.isOn(t.orgId, 'deployTokens')) { res.status(403).json({ error: 'Deploy tokens are turned off for this workspace', code: 'FEATURE_OFF', feature: 'deployTokens' }); return null }
    if (!features.planOk(t.orgId, 'deployTokens')) { res.status(402).json(upgradeBody('deployTokens')); return null }
    const cluster = (await clusterStore.getClusters().catch(() => [])).find(c => c.id === t.clusterId && c.orgId === t.orgId)
    if (!cluster) { res.status(404).json({ error: 'The cluster of this token is gone' }); return null }
    return { t, cluster }
}
const actor = (t) => ({ id: `token:${t.id}`, username: `token:${t.name}`, role: 'token' })

router.post('/deploy', async (req, res) => {
    const ctx = await tokenOf(req, res)
    if (!ctx) return
    const { t, cluster } = ctx
    const record = (ok, status, detail) => auditLog.record({ orgId: t.orgId, actor: actor(t), ip: req.ip, action: 'hook.deploy', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, ok, status, detail })
    try {
        const w = capabilities(cluster).helmApps
        if (w?.ok === false) throw Object.assign(new Error(w.why), { status: 409 })
        const env = deliveryStore.environmentAt(t.orgId, cluster.id, t.namespace)
        if (env?.protected) throw Object.assign(new Error(`${env.name} is a protected environment — deploys there need a second person in KubeEZ; a token cannot do that.`), { status: 403, code: 'PROTECTED' })
        checkFreeze({ role: 'token' }, cluster, {})
        const version = req.body?.version ?? t.version
        if (version != null && !VERSION.test(String(version))) throw Object.assign(new Error('version is not valid'), { status: 400 })
        const commit = cleanCommit(req.body?.commit)
        const repo = deliveryStore.repoCredentials(t.orgId, t.repoId)
        if (!repo) throw Object.assign(new Error('The chart repository of this token was removed'), { status: 409 })
        const d = cleanDeploy({ release: t.release, namespace: t.namespace, chart: t.chart, version }, repo)
        const values = applySet(await valuesOf(cluster, t.namespace, t.release), req.body?.set, t.allowedKeys)
        const what = `${t.namespace}/${t.release} ${t.chart}${version ? ` ${version}` : ''}${req.body?.set ? ` set ${Object.entries(req.body.set).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`
        const j = await deploy(cluster, d, { by: `token:${t.name}`, values, gate: env?.cvePolicy && features.usable(t.orgId, 'cveGate') ? { policy: env.cvePolicy, override: null } : null })
        if (commit) j.promise?.then(() => { if (j.status === 'done') leadTimes.record(t.orgId, { clusterId: cluster.id, namespace: t.namespace, release: t.release, ...commit, deployedAt: j.finishedAt, by: `token:${t.name}` }) }).catch(() => { })
        record(true, 202, `deploy ${what}${commit ? ` commit ${commit.sha.slice(0, 12)}` : ''}`)
        res.status(202).json(jobView(j))
    } catch (e) { record(false, e.status || 500, e.message.slice(0, 300)); fail(res, e) }
})

// ── preview environments from CI (a token made with "previews") ──
//   POST   /api/hooks/preview        { pr: 42 | branch: "feature/login", set: { "image.tag": "pr-42" }, ttlHours? }
//   DELETE /api/hooks/preview        { pr | branch } — when the pull request is closed
// The preview copies the token's release (its namespace) into <release>-pr-42.
async function previewToken(req, res) {
    const ctx = await tokenOf(req, res)
    if (!ctx) return null
    if (!ctx.t.previews) { res.status(403).json({ error: 'This token may not make preview environments — create one with "previews" on' }); return null }
    if (!features.isOn(ctx.t.orgId, 'previews')) { res.status(403).json({ error: 'Preview environments are turned off for this workspace', code: 'FEATURE_OFF', feature: 'previews' }); return null }
    if (!features.planOk(ctx.t.orgId, 'previews')) { res.status(402).json(upgradeBody('previews')); return null }
    return ctx
}
router.post('/preview', async (req, res) => {
    const ctx = await previewToken(req, res)
    if (!ctx) return
    const { t, cluster } = ctx
    const record = (ok, status, detail) => auditLog.record({ orgId: t.orgId, actor: actor(t), ip: req.ip, action: 'hook.preview', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, ok, status, detail })
    try {
        const w = capabilities(cluster).helmApps
        if (w?.ok === false) throw Object.assign(new Error(w.why), { status: 409 })
        checkFreeze({ role: 'token' }, cluster, {})
        const { key, label } = previewKey(req.body)
        const repo = deliveryStore.repoCredentials(t.orgId, t.repoId)
        if (!repo) throw Object.assign(new Error('The chart repository of this token was removed'), { status: 409 })
        // the base environment's CVE policy also guards its previews
        const env = deliveryStore.environmentAt(t.orgId, cluster.id, t.namespace)
        const r = await startPreview({ orgId: t.orgId, cluster, base: { namespace: t.namespace, release: t.release }, key, label, set: req.body?.set, allowedKeys: t.allowedKeys, ttlHours: req.body?.ttlHours, repo, by: `token:${t.name}`, gate: env?.cvePolicy && features.usable(t.orgId, 'cveGate') ? { policy: env.cvePolicy, override: null } : null })
        record(true, 202, `preview ${r.preview.namespace} (${label})${req.body?.set ? ` set ${Object.entries(req.body.set).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`)
        res.status(202).json({ preview: { id: r.preview.id, namespace: r.preview.namespace, expiresAt: r.preview.expiresAt }, job: jobView(r.job) })
    } catch (e) { record(false, e.status || 500, e.message.slice(0, 300)); fail(res, e) }
})
router.delete('/preview', async (req, res) => {
    const ctx = await previewToken(req, res)
    if (!ctx) return
    const { t, cluster } = ctx
    try {
        const { key } = previewKey({ ...req.query, ...(req.body || {}) })
        const p = deliveryStore.previewAt(t.orgId, cluster.id, previewNamespace(t.release, key))
        if (!p || p.release !== t.release || p.baseNamespace !== t.namespace) return res.status(404).json({ error: 'No such preview' })
        await removePreview(t.orgId, cluster, p)
        auditLog.record({ orgId: t.orgId, actor: actor(t), ip: req.ip, action: 'hook.preview', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, ok: true, status: 200, detail: `remove preview ${p.namespace}` })
        res.json({ success: true, namespace: p.namespace })
    } catch (e) { fail(res, e) }
})

router.get('/jobs/:jobId', async (req, res) => {
    const ctx = await tokenOf(req, res)
    if (!ctx) return
    const j = findJob(req.params.jobId)
    // only the jobs of this token's release (and of its previews)
    const t = ctx.t
    const preview = t.previews && j && deliveryStore.previewAt(t.orgId, j.clusterId, j.namespace)
    const mine = j && j.clusterId === t.clusterId && j.release === t.release && (j.namespace === t.namespace || (preview && preview.baseNamespace === t.namespace && preview.release === t.release))
    if (!mine) return res.status(404).json({ error: 'Job not found' })
    res.json(jobView(j))
})

export default router
