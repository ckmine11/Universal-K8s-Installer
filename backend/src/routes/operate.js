import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { requireApproval, protectedTarget } from '../services/approvals.js'
import { capabilities } from '../services/clusterAccess.js'
import { checkFreeze } from '../services/deliveryStore.js'
import { SYSTEM_NS } from '../services/gitops.js'
import { hibernated, hibernate, wake, addDebugContainer } from '../services/hibernate.js'
import { readEso, refreshEso } from '../services/externalSecrets.js'

// Day-2 operations on one cluster (mounted at /api/clusters):
//   GET  /:id/hibernate                namespaces that are hibernated
//   POST /:id/hibernate { namespace }  scale its workloads to 0 (remembered)
//   POST /:id/wake      { namespace }  bring them back
//   POST /:id/debug     { namespace, pod, target?, image }  an ephemeral debug container
//   GET  /:id/external-secrets         External Secrets sync status
//   POST /:id/external-secrets/refresh { namespace, name }
// Namespace limits apply; system namespaces are admin-only; a protected
// environment needs a second person to hibernate; freezes stop changes.
const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) })
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('The cluster did not answer in time'), { status: 504 })), ms).unref?.())])
async function visibleCluster(req, res) {
    const c = (await clusterStore.getClusters().catch(() => [])).find(x => x.id === req.params.id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
const matcher = (user, cluster) => { const n = accessOn(user, cluster).namespaces; return n ? (ns) => nsMatches(n, ns) : null }
const isAdmin = (u) => ['admin', 'superadmin'].includes(u.role)
/** May this member change things in this namespace? (throws 403 / 409) */
function mayChange(req, cluster, ns) {
    const w = capabilities(cluster).helmApps
    if (w?.ok === false) throw Object.assign(new Error(w.why), { status: 409 })
    const m = matcher(req.user, cluster)
    if (m && !m(ns)) throw Object.assign(new Error(`You may not change namespace ${ns}`), { status: 403 })
    if (SYSTEM_NS.test(ns) && !isAdmin(req.user)) throw Object.assign(new Error(`${ns} is a system namespace — only an admin may do this there.`), { status: 403 })
}
const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const validNs = (req, res, next) => NS.test(String(req.body?.namespace || '')) ? next() : res.status(400).json({ error: 'namespace is not valid' })

router.get('/:id/hibernate', requirePermission('app:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const m = matcher(req.user, cluster)
        res.json({ namespaces: (await withTimeout(hibernated(cluster), 90e3)).filter(n => !m || m(n.namespace)) })
    } catch (e) { fail(res, e) }
})
router.post('/:id/hibernate', requirePermission('hibernate:manage'), validNs, requireApproval('hibernate', { always: (req) => protectedTarget(req.user.orgId, 'hibernate', req.params.id, '', req.body) }), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const ns = req.body.namespace
        mayChange(req, cluster, ns)
        const override = checkFreeze(req.user, cluster, req.body)
        const r = await withTimeout(hibernate(cluster, ns), 130e3)
        req.auditDetail = `hibernate ${ns}: ${r.changed.join(', ') || 'nothing running'}${override ? ` — ${override}` : ''}`
        res.json({ success: true, ...r })
    } catch (e) { fail(res, e) }
})
router.post('/:id/wake', requirePermission('hibernate:manage'), validNs, async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const ns = req.body.namespace
        mayChange(req, cluster, ns)
        const override = checkFreeze(req.user, cluster, req.body)
        const r = await withTimeout(wake(cluster, ns), 130e3)
        req.auditDetail = `wake ${ns}: ${r.changed.join(', ') || 'not hibernated'}${override ? ` — ${override}` : ''}`
        res.json({ success: true, ...r })
    } catch (e) { fail(res, e) }
})

router.post('/:id/debug', requirePermission('terminal:access'), requirePermission('debug:ephemeral'), validNs, requireApproval('debug:ephemeral'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const { namespace, pod, target, image } = req.body
        mayChange(req, cluster, namespace)
        const r = await withTimeout(addDebugContainer(cluster, { namespace, pod, target, image }), 90e3)
        req.auditDetail = `debug container ${r.container} (${r.image}) in ${namespace}/${pod}${target ? ` targeting ${target}` : ''}`
        res.json({ success: true, ...r })
    } catch (e) { fail(res, e) }
})

router.get('/:id/external-secrets', requirePermission('security:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const r = await withTimeout(readEso(cluster), 130e3)
        const m = matcher(req.user, cluster)
        res.json({ ...r, externalSecrets: r.externalSecrets.filter(e => !m || m(e.namespace)), stores: r.stores.filter(s => !m || (s.namespace && m(s.namespace))) })
    } catch (e) { fail(res, e) }
})
router.post('/:id/external-secrets/refresh', requirePermission('app:deploy'), validNs, async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const m = matcher(req.user, cluster)
        if (m && !m(req.body.namespace)) return res.status(404).json({ error: 'ExternalSecret not found' })
        const w = capabilities(cluster).helmApps
        if (w?.ok === false) return res.status(409).json({ error: w.why })
        req.auditDetail = `sync ExternalSecret ${req.body.namespace}/${req.body.name}`
        res.json({ success: true, ...await withTimeout(refreshEso(cluster, req.body.namespace, req.body.name), 60e3) })
    } catch (e) { fail(res, e) }
})

export default router
