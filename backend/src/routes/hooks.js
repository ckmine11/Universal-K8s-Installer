import express from 'express'
import { apiTokens, applySet } from '../services/apiTokens.js'
import { clusterStore } from '../services/clusterStore.js'
import { deliveryStore, checkFreeze } from '../services/deliveryStore.js'
import { capabilities } from '../services/clusterAccess.js'
import { auditLog } from '../services/auditLog.js'
import { valuesOf, cleanDeploy, deploy, findJob, jobView, VERSION } from '../services/helmApps.js'

// The deploy webhook for CI (mounted at /api/hooks, no session — a deploy token):
//   POST /api/hooks/deploy     Authorization: Bearer kzt_…   { set: { "image.tag": "1.4.2" }, version? }
//   GET  /api/hooks/jobs/:id   the job it started
// The token decides everything else (cluster, namespace, release, repository,
// chart, which values may change). Change freezes, protected environments and
// the CVE policy apply — a token never overrides them.
const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) })

async function tokenOf(req, res) {
    const t = apiTokens.verify(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''))
    if (!t) { res.status(401).json({ error: 'Unknown, expired or revoked deploy token' }); return null }
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
        const repo = deliveryStore.repoCredentials(t.orgId, t.repoId)
        if (!repo) throw Object.assign(new Error('The chart repository of this token was removed'), { status: 409 })
        const d = cleanDeploy({ release: t.release, namespace: t.namespace, chart: t.chart, version }, repo)
        const values = applySet(await valuesOf(cluster, t.namespace, t.release), req.body?.set, t.allowedKeys)
        const what = `${t.namespace}/${t.release} ${t.chart}${version ? ` ${version}` : ''}${req.body?.set ? ` set ${Object.entries(req.body.set).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`
        const j = await deploy(cluster, d, { by: `token:${t.name}`, values, gate: env?.cvePolicy ? { policy: env.cvePolicy, override: null } : null })
        record(true, 202, `deploy ${what}`)
        res.status(202).json(jobView(j))
    } catch (e) { record(false, e.status || 500, e.message.slice(0, 300)); fail(res, e) }
})

router.get('/jobs/:jobId', async (req, res) => {
    const ctx = await tokenOf(req, res)
    if (!ctx) return
    const j = findJob(req.params.jobId)
    // only the jobs of this token's release
    if (!j || j.clusterId !== ctx.t.clusterId || j.namespace !== ctx.t.namespace || j.release !== ctx.t.release) return res.status(404).json({ error: 'Job not found' })
    res.json(jobView(j))
})

export default router
