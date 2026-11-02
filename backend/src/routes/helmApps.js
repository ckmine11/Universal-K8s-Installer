import express from 'express'
import { requireFeature, features } from '../services/features.js'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { requireApproval, protectedTarget } from '../services/approvals.js'
import { capabilities } from '../services/clusterAccess.js'
import { deliveryStore, checkFreeze } from '../services/deliveryStore.js'
import { listReleases, releaseDetail, cleanDeploy, previewDeploy, deploy, rollback, uninstall, findJob, jobView, RELEASE, NAMESPACE } from '../services/helmApps.js'
import { signGateFor } from '../services/signGate.js'
import { scoreRisk, riskFacts, explainRisk } from '../services/deployRisk.js'
import { checkDrift } from '../services/helmDrift.js'
import { incidentDetector } from '../services/incidentDetector.js'

// Helm apps of one cluster (mounted at /api/clusters):
//   GET    /:id/apps                         releases (+ environment, freeze, what you may do)
//   GET    /:id/apps/:ns/:name               history and values (values need app:values)
//   POST   /:id/apps/preview                 dry run + diff of what an install / upgrade changes
//   POST   /:id/apps                         install / upgrade → job
//   POST   /:id/apps/:ns/:name/rollback      { revision } → job
//   DELETE /:id/apps/:ns/:name               uninstall → job
//   GET    /:id/apps/jobs/:jobId             a job's state
// A protected environment always needs a second person; a change freeze stops
// changes (admins may override with a reason); namespace limits apply.
const router = express.Router()
// feature flags (services/features.js): a feature that is off answers 403 FEATURE_OFF
router.use('/:id/apps', requireFeature('helmApps'))
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.freeze ? { freeze: e.freeze } : {}) })
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { status: 504 })), ms).unref?.())])

async function visibleCluster(req, res) {
    const c = (await clusterStore.getClusters().catch(() => [])).find(x => x.id === req.params.id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
const inScope = (user, cluster, ns) => { const nss = accessOn(user, cluster).namespaces; return !nss || nsMatches(nss, ns) }
const writable = (cluster) => { const w = capabilities(cluster).helmApps; if (w?.ok === false) throw Object.assign(new Error(w.why), { status: 409 }) }
// the environment's CVE policy; only an admin may push past "block", with a reason
function gateFor(req, cluster, namespace) {
    const policy = deliveryStore.environmentAt(cluster.orgId, cluster.id, namespace)?.cvePolicy
    if (!policy || !features.usable(cluster.orgId, 'cveGate')) return null
    const why = String(req.body?.overrideCve || '').trim()
    return { policy, override: ['admin', 'superadmin'].includes(req.user.role) && why.length >= 3 ? why.slice(0, 200) : null }
}
// the environment's image signature policy; only an admin may push past "block", with a reason
function signFor(req, cluster, namespace) {
    const why = String(req.body?.overrideSign || '').trim()
    return signGateFor(cluster.orgId, deliveryStore.environmentAt(cluster.orgId, cluster.id, namespace), ['admin', 'superadmin'].includes(req.user.role) && why.length >= 3 ? why.slice(0, 200) : null)
}
const always = (action) => async (req) => protectedTarget(req.user.orgId, action, req.params.id, req.originalUrl.split('?')[0], req.body)

router.get('/:id/apps', requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const all = await withTimeout(listReleases(cluster), 90e3, 'The cluster did not answer in time')
        const nss = accessOn(req.user, cluster).namespaces
        const envs = deliveryStore.environments(cluster.orgId).filter(e => e.clusterId === cluster.id)
        const releases = all.filter(r => !nss || nsMatches(nss, r.namespace)).map(r => {
            const env = envs.find(e => e.namespace === r.namespace)
            return { ...r, environment: env ? { id: env.id, name: env.name, protected: env.protected } : null }
        })
        const write = capabilities(cluster).helmApps
        res.json({
            releases, hidden: all.length - releases.length,
            environments: envs.filter(e => !nss || nsMatches(nss, e.namespace)),
            freeze: deliveryStore.activeFreeze(cluster.orgId, cluster.id),
            can: { values: canOn(req.user, 'app:values', cluster), deploy: canOn(req.user, 'app:deploy', cluster) && write?.ok !== false, delete: canOn(req.user, 'app:delete', cluster) && write?.ok !== false },
            readOnlyReason: write?.ok === false ? write.why : null
        })
    } catch (e) { fail(res, e) }
})

router.get('/:id/apps/jobs/:jobId', requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const j = findJob(req.params.jobId)
    if (!j || j.clusterId !== cluster.id || !inScope(req.user, cluster, j.namespace)) return res.status(404).json({ error: 'Job not found' })
    res.json(jobView(j))
})

router.get('/:id/apps/:ns/:name', requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const { ns, name } = req.params
    if (!NAMESPACE.test(ns) || !RELEASE.test(name)) return res.status(400).json({ error: 'Not a valid release' })
    if (!inScope(req.user, cluster, ns)) return res.status(404).json({ error: 'Release not found' })
    try {
        const d = await withTimeout(releaseDetail(cluster, ns, name), 90e3, 'The cluster did not answer in time')
        res.json({ history: d.history, values: canOn(req.user, 'app:values', cluster) ? d.values : null })
    } catch (e) { fail(res, e) }
})

// checks shared by preview and deploy: valid request, workspace repository, namespace in scope
function deployRequest(req, cluster) {
    const repo = deliveryStore.repoCredentials(req.user.orgId, String(req.body?.repoId || ''))
    const d = cleanDeploy(req.body, repo)
    if (!inScope(req.user, cluster, d.namespace)) throw Object.assign(new Error(`You may not deploy into namespace ${d.namespace}`), { status: 403 })
    return d
}
// a bad request is 400 before anyone is asked to approve it
const validDeploy = (req, res, next) => {
    try { cleanDeploy(req.body, deliveryStore.repo(req.user.orgId, String(req.body?.repoId || ''))); next() } catch (e) { fail(res, e) }
}

router.post('/:id/apps/preview', requirePermission('app:deploy'), requirePermission('app:values'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const d = deployRequest(req, cluster)
        res.json(await withTimeout(previewDeploy(cluster, d, { gate: gateFor(req, cluster, d.namespace), sign: await signFor(req, cluster, d.namespace) }), 130e3, 'The dry run did not finish in time'))
    } catch (e) { fail(res, e) }
})

// deploy risk: KubeEZ's score from the dry run and what it knows, explained by the AI (when the member may ask it)
router.post('/:id/apps/risk', requireFeature('deployRisk'), requirePermission('app:deploy'), requirePermission('app:values'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const d = deployRequest(req, cluster)
        const env = deliveryStore.environmentAt(cluster.orgId, cluster.id, d.namespace)
        const [preview, releases] = await withTimeout(Promise.all([
            previewDeploy(cluster, d, { gate: gateFor(req, cluster, d.namespace), sign: await signFor(req, cluster, d.namespace) }),
            listReleases(cluster)
        ]), 130e3, 'The dry run did not finish in time')
        const current = releases.find(r => r.namespace === d.namespace && r.name === d.release) || null
        const history = current ? (await releaseDetail(cluster, d.namespace, d.release).catch(() => ({ history: [] }))).history : []
        const incidents = incidentDetector.getIncidents().filter(i => i.clusterId === cluster.id && i.namespace === d.namespace && !['resolved', 'cleared'].includes(i.status))
        const toVersion = d.version || /-(v?\d[\w.+-]*)$/.exec(preview.chart || '')?.[1] || null
        const risk = scoreRisk({ preview, current, toVersion, env, history, incidents })
        let ai = null
        if (!canOn(req.user, 'ai:use')) ai = { unavailable: 'Your role may not ask KubeEZ AI — the score above is KubeEZ\'s own.' }
        else {
            try { ai = await explainRisk(req.user, riskFacts({ release: d.release, namespace: d.namespace, cluster, preview, current, toVersion, env, history, incidents, risk })) }
            catch (e) { ai = { unavailable: e.none || e.code === 'AI_OFF' ? e.message : `The AI did not answer: ${String(e.message).slice(0, 200)}` } }
        }
        req.auditDetail = `deploy risk ${d.namespace}/${d.release}: ${risk.score}/100 ${risk.level}${ai?.level ? `, AI: ${ai.level}` : ''}`
        res.json({ risk, ai, preview })
    } catch (e) { fail(res, e) }
})

// Helm drift: what was changed by hand since Helm deployed it (a dry-run diff; nothing changes)
router.get('/:id/apps/drift', requireFeature('helmDrift'), requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const all = await withTimeout(listReleases(cluster), 90e3, 'The cluster did not answer in time')
        const mine = all.filter(r => inScope(req.user, cluster, r.namespace))
        const results = await withTimeout(checkDrift(cluster, mine), 600e3, 'The drift check did not finish in time')
        res.json({ releases: results, drifted: results.filter(r => r.drifted).length, checked: results.length, skipped: Math.max(0, mine.length - results.length), at: new Date().toISOString() })
    } catch (e) { fail(res, e) }
})
router.get('/:id/apps/:ns/:name/drift', requireFeature('helmDrift'), requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const { ns, name } = req.params
    if (!NAMESPACE.test(ns) || !RELEASE.test(name)) return res.status(400).json({ error: 'Not a valid release' })
    if (!inScope(req.user, cluster, ns)) return res.status(404).json({ error: 'Release not found' })
    try {
        const [r] = await withTimeout(checkDrift(cluster, [{ namespace: ns, name }]), 120e3, 'The drift check did not finish in time')
        res.json(r)
    } catch (e) { fail(res, e) }
})

router.post('/:id/apps', requirePermission('app:deploy'), validDeploy, requireApproval('app:deploy', { always: always('app:deploy') }), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        writable(cluster)
        const d = deployRequest(req, cluster)
        const override = checkFreeze(req.user, cluster, req.body)
        const gate = gateFor(req, cluster, d.namespace)
        const sign = await signFor(req, cluster, d.namespace)
        req.auditDetail = `deploy ${d.namespace}/${d.release} chart ${d.repo.name}/${d.chart}${d.version ? ` ${d.version}` : ''}${override ? ` — ${override}` : ''}${gate?.override ? ` — CVE policy overridden: ${gate.override}` : ''}${sign?.override ? ` — signature policy overridden: ${sign.override}` : ''}`
        const j = await deploy(cluster, d, { by: req.user.username, gate, sign })
        res.status(202).json(jobView(j))
    } catch (e) { fail(res, e) }
})

router.post('/:id/apps/:ns/:name/rollback', requirePermission('app:deploy'), requireApproval('app:deploy', { always: always('app:deploy') }), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const { ns, name } = req.params
    try {
        if (!NAMESPACE.test(ns) || !RELEASE.test(name)) throw Object.assign(new Error('Not a valid release'), { status: 400 })
        if (!inScope(req.user, cluster, ns)) return res.status(404).json({ error: 'Release not found' })
        writable(cluster)
        const override = checkFreeze(req.user, cluster, req.body)
        const revision = Number(req.body?.revision)
        req.auditDetail = `rollback ${ns}/${name} to revision ${revision}${override ? ` — ${override}` : ''}`
        res.status(202).json(jobView(rollback(cluster, ns, name, revision, { by: req.user.username })))
    } catch (e) { fail(res, e) }
})

router.delete('/:id/apps/:ns/:name', requirePermission('app:delete'), requireApproval('app:uninstall', { always: always('app:uninstall') }), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const { ns, name } = req.params
    try {
        if (!NAMESPACE.test(ns) || !RELEASE.test(name)) throw Object.assign(new Error('Not a valid release'), { status: 400 })
        if (!inScope(req.user, cluster, ns)) return res.status(404).json({ error: 'Release not found' })
        writable(cluster)
        const override = checkFreeze(req.user, cluster, req.body)
        req.auditDetail = `uninstall ${ns}/${name}${override ? ` — ${override}` : ''}`
        res.status(202).json(jobView(uninstall(cluster, ns, name, { by: req.user.username })))
    } catch (e) { fail(res, e) }
})

export default router
