import { randomBytes } from 'crypto'
import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches, kubeLevelOn } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { installationManager } from '../services/installationManager.js'
import { incidentDetector } from '../services/incidentDetector.js'
import { CATALOG } from '../config/incidentCatalog.js'
import { auditLog } from '../services/auditLog.js'
import { requireApproval } from '../services/approvals.js'
import { AiUnavailable, actionPolicy, ask } from '../services/ai/engine.js'
import { aiStore } from '../services/ai/aiStore.js'
import { explainInstall, explainIncident, summarizeChanges, collectIncidentData, resolveWorkload } from '../services/ai/doctor.js'
import { suggest as suggestRunbook, onUndone, runbooksOf, setAuto, remove as removeRunbook } from '../services/ai/runbooks.js'
import { collectChanges } from '../services/ai/changes.js'
import { explainIncidentFull, explainKey } from '../services/ai/incidentExplain.js'
import { planAction, applyAction, undoAction, actionLog, view, cleanSpec, ACTION_TYPES } from '../services/ai/actions.js'
import { riskScore, newestSnapshot, cachedSnapshot } from '../services/ai/risk.js'
import { fleetText } from '../services/ai/fleet.js'
import { handleChat } from '../services/ai/chatops.js'
import { riskOf, fleetFor, advisorFor } from '../services/ai/insights.js'
import { addonSettingsStore } from '../services/addonSettings.js'
import { ADVISOR_SCRIPT, analyze as analyzeAdvisor, advisorText } from '../services/ai/advisor.js'
import { autoFix } from '../services/ai/yamlBuilder.js'
import { generateManifests, parseManifests, checkManifests, previewManifests, applyManifests, undoManifests, manifestLog, manifestView, workloadSelector } from '../services/ai/manifests.js'
import { offsiteStore } from '../services/offsiteStore.js'
import { complianceStore } from '../services/complianceService.js'

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
    await runJob(req, res, explainKey(inc), () => explainIncidentFull(req.user, inc, cluster, { fresh: !!req.body?.fresh }),
        { fresh: !!req.body?.fresh, decorate: (v) => ({ ...v, canAct }) })
})

// ── Ask AI (the web chat): the same answers as ChatOps, only about what this member may see ──
router.post('/chat', requirePermission('ai:use'), async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 2000)
    if (!text) return res.status(400).json({ error: 'Ask something' })
    await runJob(req, res, `chat:${req.user.id}:${randomBytes(6).toString('hex')}`,
        () => handleChat({ orgId: req.user.orgId, chatKey: `web:${req.user.id}`, who: req.user.username, source: 'Web', text, user: req.user, rate: 60 }))
})

// ── Text → YAML (generating runs as a job; nothing touches a cluster here) ──
router.post('/generate-yaml', requirePermission('ai:use'), async (req, res) => {
    const cluster = await visibleCluster(req, res, req.body?.clusterId)
    if (!cluster) return
    const namespace = String(req.body?.namespace || 'default')
    const description = String(req.body?.description || '').slice(0, 2000)
    const context = `Kubernetes ${cluster.k8sVersion}; installed add-ons: ${Object.entries(cluster.addons || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`
    await runJob(req, res, `yaml:${req.user.id}:${cluster.id}:${namespace}:${Buffer.from(description).toString('base64').slice(0, 200)}`,
        () => generateManifests(req.user, { description, namespace, context, addons: Object.entries(cluster.addons || {}).filter(([, v]) => v).map(([k]) => k), lookup: (kind, name) => selectorOf(cluster, namespace, kind, name) }), { fresh: true })
})
// what an existing workload's pods are labelled and listen on — for "expose deployment web"
const selectorOf = (cluster, namespace, kind, name) => withTimeout(onCluster(cluster, (ssh) => workloadSelector(ssh, namespace, kind, name)), 25000, 'timeout')
// the user's own edits are checked the same way (no AI)
router.post('/check-yaml', (req, res) => {
    try {
        const docs = parseManifests(req.body?.yaml)
        // "Auto-fix": pin images, add resources / probes / labels, fix units and apiVersions first
        const f = req.body?.fix ? autoFix(docs) : { docs, fixes: [] }
        res.json({ ...checkManifests(f.docs, { namespace: String(req.body?.namespace || 'default') }), fixes: f.fixes })
    } catch (e) { fail(res, e) }
})

// ── Advisor: the AI summary of the security and cost findings ──
router.post('/advisor/:clusterId/summary', requirePermission('ai:use'), async (req, res) => {
    const cluster = await visibleCluster(req, res, req.params.clusterId)
    if (!cluster) return
    await runJob(req, res, `adv:${req.user.id}:${cluster.id}:${Math.floor(Date.now() / 300e3)}`, async () => {
        const a = await advisorFor(req.user, cluster, false)
        const r = await ask(req.user, { task: 'summarize', purpose: 'advisor', maxTokens: 600, clusterId: cluster.id, clusterName: cluster.clusterName,
            system: 'You are a Kubernetes security and cost advisor. From the findings, give the 5 most important things to do first, most valuable first: one line each, what and why, naming the workload. High security risks before cost. Only use the findings given.',
            data: [{ label: 'findings', text: advisorText(a) }], question: 'What should we fix first?' })
        return { summary: r.text, engine: { provider: r.provider, model: r.model, ms: r.ms, traceId: r.traceId } }
    })
})

// ── Fleet: the AI summary ──
router.post('/fleet/summary', requirePermission('ai:use'), async (req, res) => {
    await runJob(req, res, `fleet:${req.user.id}:${Math.floor(Date.now() / 300e3)}`, async () => {
        const f = await fleetFor(req.user)
        const r = await ask(req.user, { task: 'summarize', purpose: 'fleet', maxTokens: 600,
            system: 'You look after a fleet of Kubernetes clusters. From the facts, say in at most 6 short bullet points what needs attention across the fleet, most urgent first: clusters at risk and why, problems shared by several clusters (one root cause?), Kubernetes versions to upgrade, add-ons on different versions. Only use the facts.',
            data: [{ label: 'fleet facts', text: fleetText(f) }], question: 'What needs attention across the fleet?' })
        return { summary: r.text, engine: { provider: r.provider, model: r.model, ms: r.ms, traceId: r.traceId } }
    })
})

// ── Learned runbooks ──
router.get('/runbooks', requirePermission('ai:manage'), (req, res) => res.json({ runbooks: runbooksOf(req.user.orgId) }))
router.put('/runbooks/:id', requirePermission('ai:manage'), (req, res) => {
    try {
        const rb = setAuto(req.user.orgId, req.params.id, !!req.body?.auto)
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: rb.auto ? 'ai.runbook_auto_on' : 'ai.runbook_auto_off', target: rb.clusterId ? { clusterId: rb.clusterId, clusterName: rb.clusterName } : null, detail: `${rb.reason} on ${rb.scope}: ${rb.action.type}` })
        res.json(rb)
    } catch (e) { fail(res, e) }
})
router.delete('/runbooks/:id', requirePermission('ai:manage'), (req, res) => { removeRunbook(req.user.orgId, req.params.id); res.json({ success: true }) })

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

// ── Risk score (facts, no AI) ──
actionsRouter.get('/fleet', async (req, res) => { try { res.json(await fleetFor(req.user)) } catch (e) { fail(res, e) } })

// every cluster the member can see — quick (no cluster calls), for lists
actionsRouter.get('/risk-summary', async (req, res) => {
    const clusters = (await clusterStore.getClusters().catch(() => [])).filter(c => canAccessResource(req.user, c) && canSeeCluster(req.user, c))
    const out = {}
    for (const c of clusters) { const r = await riskOf(c, { deep: false }); out[c.id] = { score: r.score, level: r.level, top: r.factors[0]?.label || null } }
    res.json(out)
})
// one cluster — with its backups checked
actionsRouter.get('/:id/risk', requirePermission('cluster:view'), async (req, res) => {
    const c = req.permissionCluster
    if (!c || !canSeeCluster(req.user, c)) return res.status(404).json({ error: 'Cluster not found' })
    try { res.json(await riskOf(c, { deep: req.query.quick !== '1' })) } catch (e) { fail(res, e) }
})

// ── Advisor facts (read-only, cached 5 minutes) ──
actionsRouter.get('/:id/advisor', requirePermission('cluster:view'), async (req, res) => {
    const cluster = req.permissionCluster
    if (!cluster || !canSeeCluster(req.user, cluster)) return res.status(404).json({ error: 'Cluster not found' })
    try { res.json(await advisorFor(req.user, cluster, req.query.refresh === '1')) } catch (e) { fail(res, e) }
})

// ── Text → YAML on a cluster: preview (dry-run + diff), apply, undo ──
function checkWrite(req, res) {
    const cluster = req.permissionCluster
    if (!cluster || !canSeeCluster(req.user, cluster)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    if (!['edit', 'admin'].includes(kubeLevelOn(req.user, cluster))) { res.status(403).json({ error: 'Your role may not change things inside this cluster (needs Kubernetes edit access)' }); return null }
    let checked
    const namespace = String(req.body?.namespace || 'default')
    try { checked = checkManifests(parseManifests(req.body?.yaml), { namespace }) } catch (e) { res.status(e.status || 400).json({ error: e.message }); return null }
    if (checked.blocked) { res.status(400).json({ error: 'Some objects are not allowed — fix the problems marked as blocking', problems: checked.problems }); return null }
    const nss = accessOn(req.user, cluster).namespaces
    if (nss && !nsMatches(nss, namespace)) { res.status(403).json({ error: `You may only change: ${nss.join(', ')}` }); return null }
    const policy = actionPolicy(req.user.orgId, { risk: 'medium' })
    if (policy === 'blocked') { res.status(403).json({ error: 'AI actions are stopped in this workspace (AI settings → kill switch).', code: 'AI_ACTIONS_STOPPED' }); return null }
    if (policy === 'suggest') { res.status(403).json({ error: 'KubeEZ AI is set to "Suggest only" — copy the YAML and apply it yourself.', code: 'AI_SUGGEST_ONLY' }); return null }
    return { cluster, checked, namespace }
}
actionsRouter.get('/:id/ai-manifests', requirePermission('cluster:view'), (req, res) => {
    if (!req.permissionCluster) return res.status(404).json({ error: 'Cluster not found' })
    res.json({ applied: manifestLog.list(req.user.orgId, req.permissionCluster.id).slice(0, 30).map(manifestView) })
})
actionsRouter.post('/:id/ai-manifests/preview', requirePermission('cluster:view'), async (req, res) => {
    const ok = checkWrite(req, res); if (!ok) return
    try { res.json({ ...ok.checked, ...(await withTimeout(onCluster(ok.cluster, (ssh) => previewManifests(ssh, ok.checked.yaml, ok.checked.objects)), 60000, 'The cluster did not answer in time')) }) }
    catch (e) { fail(res, e) }
})
actionsRouter.post('/:id/ai-manifests', requirePermission('cluster:view'), requireApproval('ai:apply'), async (req, res) => {
    const ok = checkWrite(req, res); if (!ok) return
    try {
        const rec = await withTimeout(onCluster(ok.cluster, async (ssh) => {
            const p = await previewManifests(ssh, ok.checked.yaml, ok.checked.objects)
            if (!p.ok) throw Object.assign(new Error(`The dry-run failed, nothing was changed: ${p.dryRun.slice(0, 300)}`), { status: 400 })
            return applyManifests(ssh, ok.checked, { orgId: req.user.orgId, cluster: ok.cluster, user: req.user, description: req.body?.description })
        }), 90000, 'The cluster did not answer in time — check the cluster before trying again')
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.manifests_applied', target: { clusterId: ok.cluster.id, clusterName: ok.cluster.clusterName }, detail: `${ok.namespace}: created ${rec.created.join(', ') || '—'}; changed ${rec.changed.join(', ') || '—'}` })
        res.json(manifestView(rec))
    } catch (e) { fail(res, e) }
})
actionsRouter.post('/:id/ai-manifests/:mid/undo', requirePermission('cluster:view'), async (req, res) => {
    const cluster = req.permissionCluster
    const rec = manifestLog.get(req.params.mid)
    if (!cluster || !rec || rec.orgId !== req.user.orgId || rec.clusterId !== cluster.id) return res.status(404).json({ error: 'Not found' })
    if (!['edit', 'admin'].includes(kubeLevelOn(req.user, cluster))) return res.status(403).json({ error: 'Your role may not change things inside this cluster' })
    const nss = accessOn(req.user, cluster).namespaces
    if (nss && !rec.objects.every(o => nsMatches(nss, o.namespace))) return res.status(403).json({ error: `You may only change: ${nss.join(', ')}` })
    try {
        const done = await withTimeout(onCluster(cluster, (ssh) => undoManifests(ssh, rec, req.user)), 90000, 'The cluster did not answer in time')
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.manifests_undone', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: done.undoOutput.slice(0, 400) })
        res.json(manifestView(done))
    } catch (e) { fail(res, e) }
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
    if (policy === 'blocked') { res.status(403).json({ error: 'AI actions are stopped in this workspace (AI settings → kill switch).', code: 'AI_ACTIONS_STOPPED' }); return null }
    if (policy === 'suggest') { res.status(403).json({ error: 'KubeEZ AI is set to "Suggest only" — fixes are not run from here (AI settings).', code: 'AI_SUGGEST_ONLY' }); return null }
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
        const rec = await withTimeout(onCluster(ok.cluster, async (ssh) => {
            const r = await applyAction(ssh, ok.spec, { orgId: req.user.orgId, cluster: ok.cluster, user: req.user, incidentId, reason })
            // which workload it was for — what a learned runbook is about
            const forInc = incidentId && incidentDetector.find(incidentId)
            if (forInc && forInc.clusterId === ok.cluster.id) { r.workload = await resolveWorkload(ssh, forInc).catch(() => null); actionLog._persist() }
            return r
        }), 90000, 'The cluster did not answer in time — check the cluster before trying again')
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
        onUndone(done, done.incidentId ? incidentDetector.find(done.incidentId)?.reason : null)
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.action_undone', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `Undo: ${done.title}` })
        res.json(view(done))
    } catch (e) { fail(res, e) }
})

export default router
