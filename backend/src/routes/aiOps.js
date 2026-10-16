import { randomBytes } from 'crypto'
import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { installationManager } from '../services/installationManager.js'
import { incidentDetector } from '../services/incidentDetector.js'
import { CATALOG } from '../config/incidentCatalog.js'
import { auditLog } from '../services/auditLog.js'
import { requireApproval } from '../services/approvals.js'
import { AiUnavailable, actionPolicy } from '../services/ai/engine.js'
import { explainInstall, explainIncident, summarizeChanges, collectIncidentData } from '../services/ai/doctor.js'
import { collectChanges } from '../services/ai/changes.js'
import { planAction, applyAction, undoAction, actionLog, view, cleanSpec, ACTION_TYPES } from '../services/ai/actions.js'

// KubeEZ AI operations: Install Doctor, incident explainer, "What changed?"
// (mounted at /api/ai), and the safe fixes with dry-run and undo
// (actionsRouter, mounted at /api/clusters → /api/clusters/:id/ai-actions).
const router = express.Router()
export const actionsRouter = express.Router()

const fail = (res, e) => {
    if (e instanceof AiUnavailable || e.code === 'AI_UNAVAILABLE' || e.code === 'AI_OFF') return res.status(e.status || 503).json({ error: e.message, code: e.code, attempts: e.attempts })
    res.status(e.status || 500).json({ error: e.message })
}
const clusterById = async (id) => (await clusterStore.getClusters().catch(() => [])).find(c => c.id === id) || null
async function visibleCluster(req, res, id) {
    const c = await clusterById(id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
async function onCluster(cluster, fn) {
    const { automationEngine } = await import('../services/automationEngine.js')
    const master = cluster.masterNodes?.[0]
    if (!master) throw Object.assign(new Error('No control-plane node saved for this cluster'), { status: 400 })
    const ssh = await automationEngine.connectSSH({ ...master, ownerId: cluster.ownerId, orgId: cluster.orgId })
    try { return await fn(ssh) } finally { ssh.dispose?.() }
}
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref?.())])

// AI work runs as a background job: the request answers within ~20 s with
// the result, or with { jobId } to poll — so a slow CPU model never hits a
// proxy's timeout (nginx 120 s, Cloudflare 100 s). Asking again for the
// same thing joins the running job; finished answers are kept 10 minutes.
const jobs = new Map()   // jobId → { key, owner, status: running|done|failed, value, error, at }
const byKey = new Map()  // key → jobId
const JOB_TTL = 10 * 60e3, WAIT_MS = Number(process.env.KUBEEZ_AI_JOB_WAIT_MS) || 20000
function sweep() { for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > JOB_TTL) { jobs.delete(id); if (byKey.get(j.key) === id) byKey.delete(j.key) } }
const jobView = (j) => j.status === 'done' ? { status: 200, body: j.value } : j.status === 'failed' ? { status: j.error.status || 500, body: j.error.body } : { status: 202, body: { jobId: j.id, status: 'running', since: j.started } }
const errorBody = (e, extra = {}) => ({ status: e instanceof AiUnavailable || e.code === 'AI_UNAVAILABLE' || e.code === 'AI_OFF' ? (e.status || 503) : (e.status || 500), body: { error: e.message, code: e.code, attempts: e.attempts, ...extra } })

/** Start (or join) the job for key; answer with its result if it is done within WAIT_MS. */
async function runJob(req, res, key, work, { fresh = false, decorate = (v) => v, onError = () => ({}) } = {}) {
    sweep()
    let id = byKey.get(key), j = id && jobs.get(id)
    if (j && fresh && j.status !== 'running') { jobs.delete(id); j = null }
    if (!j) {
        id = randomBytes(8).toString('hex')
        j = { id, key, owner: req.user.orgId, status: 'running', started: new Date().toISOString(), at: Date.now() }
        j.decorate = decorate
        jobs.set(id, j); byKey.set(key, id)
        j.promise = Promise.resolve().then(work)
            .then(v => Object.assign(j, { status: 'done', value: v, at: Date.now() }))
            .catch(e => Object.assign(j, { status: 'failed', error: errorBody(e, onError(e)), at: Date.now() }))
    } else if (j.status === 'done') {
        return res.json(decorate({ ...j.value, cached: true }))
    }
    await Promise.race([j.promise, new Promise(r => setTimeout(r, WAIT_MS).unref?.())])
    const v = jobView(j)
    res.status(v.status).json(v.status === 200 ? decorate(v.body) : v.body)
}

router.get('/jobs/:jobId', (req, res) => {
    const j = jobs.get(req.params.jobId)
    if (!j || j.owner !== req.user.orgId) return res.status(404).json({ error: 'This answer has expired — ask again' })
    const v = jobView(j)
    res.status(v.status).json(v.status === 200 ? (j.decorate ? j.decorate(v.body) : v.body) : v.body)   // backend still checks permissions on apply
})

// ── Install Doctor ──
router.post('/explain/install/:id', requirePermission('ai:use'), async (req, res) => {
    const inst = installationManager.getStatus(req.params.id)
    if (!inst || !canAccessResource(req.user, inst)) return res.status(404).json({ error: 'This job is no longer in memory — its log is gone (after a restart of KubeEZ). Start it again to get a new log.' })
    if (inst.status !== 'failed') return res.status(400).json({ error: 'Only a failed job can be explained' })
    const cid = inst.originalClusterId
    if (cid) { const c = await clusterById(cid); if (c && !canSeeCluster(req.user, c)) return res.status(404).json({ error: 'Job not found' }) }
    await runJob(req, res, `inst:${req.user.orgId}:${inst.id}:${inst.failedAt}`,
        async () => ({ ...(await explainInstall(req.user, inst)), diagnosis: inst.diagnosis || null }),
        { fresh: !!req.body?.fresh, onError: () => ({ diagnosis: inst.diagnosis || null }) })
})

// ── Incident explainer ──
router.post('/explain/incident/:id', requirePermission('ai:use'), async (req, res) => {
    const inc = incidentDetector.find(req.params.id)
    const cluster = inc && await clusterById(inc.clusterId)
    const mine = inc && (req.user.role === 'superadmin' || (inc.orgId && inc.orgId === req.user.orgId) || (!inc.orgId && inc.ownerId === req.user.id))
    if (!inc || !mine || !cluster || !canSeeCluster(req.user, cluster) || !canOn(req.user, 'incident:view', cluster)) return res.status(404).json({ error: 'Incident not found' })
    const canAct = canOn(req.user, 'incident:act', cluster)
    await runJob(req, res, `inc:${inc.id}:${inc.lastSeen}:${inc.status}`, async () => {
        // fresh cluster data and the changes before it, side by side — best effort, never blocks the answer
        const t0 = Date.parse(inc.timestamp)
        const [freshR, changes] = await Promise.all([
            withTimeout(onCluster(cluster, (ssh) => collectIncidentData(ssh, inc)), 35000, 'the cluster did not answer in time').then(v => ({ v }), e => ({ e })),
            withTimeout(collectChanges(cluster, { from: t0 - 3 * 3600e3, to: Math.max(Date.parse(inc.lastSeen || inc.timestamp), t0) + 60e3 }), 45000, 'timeout').then(c => c.items, () => [])
        ])
        const fresh = freshR.v || { data: [], workload: null }
        const related = inc.causedBy ? incidentDetector.find(inc.causedBy) : null
        const out = await explainIncident(req.user, { incident: inc, catalog: CATALOG[inc.reason], cluster, fresh, changes, related })
        return { ...out, changes: changes.slice(0, 15), freshError: freshR.e?.message || null }
    }, { fresh: !!req.body?.fresh, decorate: (v) => ({ ...v, canAct }) })
})

// ── What changed? (facts — no AI needed) ──
const HOURS = [1, 3, 6, 24, 72, 168]
router.get('/changes/:clusterId', async (req, res) => {
    const cluster = await visibleCluster(req, res, req.params.clusterId)
    if (!cluster) return
    const hours = HOURS.includes(Number(req.query.hours)) ? Number(req.query.hours) : 24
    try {
        const r = await withTimeout(collectChanges(cluster, { hours }), 60000, 'The cluster did not answer in time')
        // members limited to some namespaces only see changes there (and KubeEZ's own)
        const nss = accessOn(req.user, cluster).namespaces
        res.json({ ...r, hours, items: nss ? r.items.filter(i => !i.ns || nsMatches(nss, i.ns)) : r.items })
    } catch (e) { fail(res, e) }
})
router.post('/changes/:clusterId/summary', requirePermission('ai:use'), async (req, res) => {
    const cluster = await visibleCluster(req, res, req.params.clusterId)
    if (!cluster) return
    const hours = HOURS.includes(Number(req.body?.hours)) ? Number(req.body.hours) : 24
    const nss = accessOn(req.user, cluster).namespaces
    await runJob(req, res, `chg:${req.user.orgId}:${req.user.id}:${cluster.id}:${hours}:${Math.floor(Date.now() / 60e3)}`, async () => {
        const r = await withTimeout(collectChanges(cluster, { hours }), 60000, 'The cluster did not answer in time')
        const items = nss ? r.items.filter(i => !i.ns || nsMatches(nss, i.ns)) : r.items
        return summarizeChanges(req.user, cluster, { ...r, items })
    })
})

// ── Safe fixes: preview (dry-run), apply, undo ──
function checkAction(req, res) {
    let spec
    try { spec = cleanSpec(req.body?.spec) } catch (e) { res.status(400).json({ error: e.message }); return null }
    const cluster = req.permissionCluster
    if (!cluster) { res.status(404).json({ error: 'Cluster not found' }); return null }
    const nss = accessOn(req.user, cluster).namespaces
    if (nss && !nsMatches(nss, spec.namespace)) { res.status(403).json({ error: `You may only act in: ${nss.join(', ')}` }); return null }
    const risk = spec.type === 'scale' && spec.replicas === 0 ? 'high' : ACTION_TYPES[spec.type].risk
    const policy = actionPolicy(req.user.orgId, { risk })
    if (policy === 'blocked') { res.status(403).json({ error: 'AI actions are stopped in this workspace (Settings → AI → kill switch).', code: 'AI_ACTIONS_STOPPED' }); return null }
    if (policy === 'suggest') { res.status(403).json({ error: 'KubeEZ AI is set to "Suggest only" — fixes are not run from here (Settings → AI).', code: 'AI_SUGGEST_ONLY' }); return null }
    return { spec, cluster }
}

actionsRouter.get('/:id/ai-actions', requirePermission('incident:view'), (req, res) => {
    if (!req.permissionCluster) return res.status(404).json({ error: 'Cluster not found' })
    res.json({ actions: actionLog.list(req.user.orgId, req.permissionCluster.id).slice(0, 50).map(view), types: ACTION_TYPES })
})

actionsRouter.post('/:id/ai-actions/preview', requirePermission('incident:act'), async (req, res) => {
    const ok = checkAction(req, res); if (!ok) return
    try { const p = await withTimeout(onCluster(ok.cluster, (ssh) => planAction(ssh, ok.spec)), 60000, 'The cluster did not answer in time'); delete p.state; res.json(p) }
    catch (e) { fail(res, e) }
})

actionsRouter.post('/:id/ai-actions', requirePermission('incident:act'), requireApproval('ai:action'), async (req, res) => {
    const ok = checkAction(req, res); if (!ok) return
    const incidentId = typeof req.body?.incidentId === 'string' ? req.body.incidentId.slice(0, 40) : null
    const reason = String(req.body?.reason || '').slice(0, 300) || null
    try {
        const rec = await withTimeout(onCluster(ok.cluster, (ssh) => applyAction(ssh, ok.spec, { orgId: req.user.orgId, cluster: ok.cluster, user: req.user, incidentId, reason })), 90000, 'The cluster did not answer in time — check the cluster before trying again')
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.action_applied', target: { clusterId: ok.cluster.id, clusterName: ok.cluster.clusterName }, detail: `${rec.title} — ${rec.change}${reason ? ` (${reason})` : ''}` })
        const inc = incidentId && incidentDetector.find(incidentId)
        if (inc && inc.clusterId === ok.cluster.id) { incidentDetector._tl(inc, 'action', `${rec.title} — applied from the AI explanation`, req.user.username); incidentDetector._save() }
        res.json(view(rec))
    } catch (e) { fail(res, e) }
})

actionsRouter.post('/:id/ai-actions/:actionId/undo', requirePermission('incident:act'), async (req, res) => {
    const cluster = req.permissionCluster
    const rec = actionLog.get(req.params.actionId)
    if (!cluster || !rec || rec.orgId !== req.user.orgId || rec.clusterId !== cluster.id) return res.status(404).json({ error: 'Action not found' })
    const nss = accessOn(req.user, cluster).namespaces
    if (nss && !nsMatches(nss, rec.spec.namespace)) return res.status(403).json({ error: `You may only act in: ${nss.join(', ')}` })
    try {
        const done = await withTimeout(onCluster(cluster, (ssh) => undoAction(ssh, rec, req.user)), 90000, 'The cluster did not answer in time')
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.action_undone', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `Undo: ${done.title}` })
        res.json(view(done))
    } catch (e) { fail(res, e) }
})

export default router
