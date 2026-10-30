import express from 'express'
import { requireFeature } from '../services/features.js'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { requireApproval, protectedTarget } from '../services/approvals.js'
import { capabilities } from '../services/clusterAccess.js'
import { deliveryStore, checkFreeze } from '../services/deliveryStore.js'
import { readRollouts, rolloutAction, ROLLOUT_ACTIONS, readScaledObjects, cleanScaledObject, applyScaledObject, deleteScaledObject } from '../services/progressive.js'
import { workloadMetrics, syncRegistry } from '../services/appMetrics.js'

// Progressive delivery, autoscaling, app metrics and pull secrets (mounted at /api/clusters):
//   GET  /:id/rollouts                       Argo Rollouts
//   POST /:id/rollouts/action                { namespace, name, action: promote | promote-full | abort | retry }
//   GET  /:id/autoscale                      KEDA ScaledObjects
//   POST /:id/autoscale                      create / update one (wizard)
//   DELETE /:id/autoscale/:ns/:name          remove one KubeEZ made
//   GET  /:id/metrics?namespace&kind&name&range   CPU, memory, restarts, network
//   POST /:id/registries/sync                { registryId, namespaces, defaultServiceAccount }
// Promoting in a protected environment needs a second person; aborting never
// does and works during a freeze (it is the way back).
const router = express.Router()
// feature flags (services/features.js): a feature that is off answers 403 FEATURE_OFF
router.use('/:id/rollouts', requireFeature('rollouts'))
router.use('/:id/autoscale', requireFeature('autoscale'))
router.use('/:id/metrics', requireFeature('appMetrics'))
router.use('/:id/registries', requireFeature('registries'))
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) })
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('The cluster did not answer in time'), { status: 504 })), ms).unref?.())])
async function visibleCluster(req, res) {
    const c = (await clusterStore.getClusters().catch(() => [])).find(x => x.id === req.params.id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
const matcher = (user, cluster) => { const n = accessOn(user, cluster).namespaces; return n ? (ns) => nsMatches(n, ns) : null }
const writable = (cluster) => { const w = capabilities(cluster).helmApps; if (w?.ok === false) throw Object.assign(new Error(w.why), { status: 409 }) }
const inScope = (req, cluster, ns) => { const m = matcher(req.user, cluster); if (m && !m(ns)) throw Object.assign(new Error(`You may not change namespace ${ns}`), { status: 403 }) }

router.get('/:id/rollouts', requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const r = await withTimeout(readRollouts(cluster), 130e3)
        const m = matcher(req.user, cluster)
        const envs = deliveryStore.environments(cluster.orgId).filter(e => e.clusterId === cluster.id)
        res.json({ ...r, rollouts: r.rollouts.filter(x => !m || m(x.namespace)).map(x => ({ ...x, protected: !!envs.find(e => e.namespace === x.namespace)?.protected })), actions: Object.fromEntries(Object.entries(ROLLOUT_ACTIONS).map(([k, a]) => [k, a.label])) })
    } catch (e) { fail(res, e) }
})
const validRollout = (req, res, next) => ROLLOUT_ACTIONS[req.body?.action] ? next() : res.status(400).json({ error: `action: ${Object.keys(ROLLOUT_ACTIONS).join(', ')}` })
router.post('/:id/rollouts/action', requirePermission('app:deploy'), validRollout,
    requireApproval('rollout', { always: (req) => req.body.action !== 'abort' && protectedTarget(req.user.orgId, 'rollout', req.params.id, '', req.body) }), async (req, res) => {
        const cluster = await visibleCluster(req, res)
        if (!cluster) return
        try {
            const { namespace, name, action } = req.body
            writable(cluster); inScope(req, cluster, String(namespace))
            const override = action === 'abort' ? null : checkFreeze(req.user, cluster, req.body)
            req.auditDetail = `rollout ${action} ${namespace}/${name}${override ? ` — ${override}` : ''}`
            res.json({ success: true, ...await withTimeout(rolloutAction(cluster, namespace, name, action), 60e3) })
        } catch (e) { fail(res, e) }
    })

router.get('/:id/autoscale', requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const r = await withTimeout(readScaledObjects(cluster), 130e3)
        const m = matcher(req.user, cluster)
        res.json({ ...r, scaledObjects: r.scaledObjects.filter(x => !m || m(x.namespace)) })
    } catch (e) { fail(res, e) }
})
router.post('/:id/autoscale', requirePermission('autoscale:manage'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const spec = cleanScaledObject(req.body)
        writable(cluster); inScope(req, cluster, spec.namespace)
        const override = checkFreeze(req.user, cluster, req.body)
        req.auditDetail = `autoscale ${spec.namespace}/${spec.target.kind}/${spec.target.name} ${spec.min}–${spec.max} on ${spec.triggers.map(t => t.type).join(', ')}${override ? ` — ${override}` : ''}`
        res.json({ success: true, ...await withTimeout(applyScaledObject(cluster, spec, { by: req.user.username }), 60e3) })
    } catch (e) { fail(res, e) }
})
router.delete('/:id/autoscale/:ns/:name', requirePermission('autoscale:manage'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        writable(cluster); inScope(req, cluster, req.params.ns)
        req.auditDetail = `remove ScaledObject ${req.params.ns}/${req.params.name}`
        res.json({ success: true, ...await withTimeout(deleteScaledObject(cluster, req.params.ns, req.params.name), 60e3) })
    } catch (e) { fail(res, e) }
})

router.get('/:id/metrics', requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const { namespace, kind, name, range } = req.query
        const m = matcher(req.user, cluster)
        if (m && !m(String(namespace))) return res.status(404).json({ error: 'Workload not found' })
        res.json(await withTimeout(workloadMetrics(cluster, { namespace: String(namespace || ''), kind: String(kind || 'Deployment'), name: String(name || ''), range: String(range || '1h') }), 100e3))
    } catch (e) { fail(res, e) }
})

router.post('/:id/registries/sync', requirePermission('registry:manage'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        writable(cluster)
        const reg = deliveryStore.registryCredentials(req.user.orgId, String(req.body?.registryId || ''))
        if (!reg) return res.status(400).json({ error: 'Pick one of the workspace\'s registries' })
        const nss = Array.isArray(req.body?.namespaces) ? req.body.namespaces.map(String) : []
        for (const ns of nss) inScope(req, cluster, ns)
        const r = await withTimeout(syncRegistry(cluster, reg, nss, { defaultServiceAccount: !!req.body?.defaultServiceAccount }), 100e3)
        req.auditDetail = `pull secret ${r.secret} (${reg.server}) to ${r.namespaces.join(', ')}${r.linked.length ? `; default ServiceAccount in ${r.linked.join(', ')}` : ''}`
        res.json({ success: true, ...r })
    } catch (e) { fail(res, e) }
})

export default router
