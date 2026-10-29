import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { requireApproval } from '../services/approvals.js'
import { capabilities } from '../services/clusterAccess.js'
import { readGitops, summarize, visibleTo, cleanSyncRequest, runSync, cleanCreateApp, createArgoApp, deleteArgoApp, SYSTEM_NS } from '../services/gitops.js'
import { checkFreeze } from '../services/deliveryStore.js'

// GitOps view (mounted at /api/clusters):
//   GET  /:id/gitops        Argo CD Applications + Flux Kustomizations / HelmReleases
//   POST /:id/gitops/sync   { kind, namespace, name, action: sync | refresh }
// Members limited to some namespaces see (and sync) only the apps that deploy
// into those namespaces alone — never another cluster, nothing cluster-wide.
const router = express.Router()

const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) })
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { status: 504 })), ms).unref?.())])

async function visibleCluster(req, res) {
    const c = (await clusterStore.getClusters().catch(() => [])).find(x => x.id === req.params.id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
const matcherFor = (user, cluster) => { const nss = accessOn(user, cluster).namespaces; return nss ? (ns) => nsMatches(nss, ns) : null }
const isAdmin = (user) => ['admin', 'superadmin'].includes(user.role)

router.get('/:id/gitops', requirePermission('gitops:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const r = await withTimeout(readGitops(cluster, { fresh: req.query.fresh === '1' }), 90e3, 'The cluster did not answer in time')
        const match = matcherFor(req.user, cluster)
        const apps = r.apps.filter(a => visibleTo(a, match))
        const write = capabilities(cluster).gitopsSync
        const mayAct = canOn(req.user, 'gitops:sync', cluster) && write?.ok !== false
        res.json({
            ...r, apps: apps.map(a => ({ ...a, canSync: mayAct && (!a.destination.external || isAdmin(req.user)), canDelete: !!a.managed && write?.ok !== false && canOn(req.user, 'gitops:delete', cluster) })),
            canCreate: write?.ok !== false && canOn(req.user, 'gitops:create', cluster) && r.tools.argocd.state === 'ok',
            summary: summarize(apps), hidden: r.apps.length - apps.length,
            canSync: mayAct, readOnlyReason: write?.ok === false ? write.why : null
        })
    } catch (e) { fail(res, e) }
})

// a bad request is 400 before a second person is asked to approve it
const validSync = (req, res, next) => { try { req.body = cleanSyncRequest(req.body); next() } catch (e) { fail(res, e) } }

router.post('/:id/gitops/sync', requirePermission('gitops:sync'), validSync, requireApproval('gitops:sync'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const { kind, namespace, name, action } = req.body
    const write = capabilities(cluster).gitopsSync
    if (write?.ok === false) return res.status(409).json({ error: write.why })
    try {
        // always against the cluster as it is now — never a cached list
        const r = await withTimeout(readGitops(cluster, { fresh: true }), 90e3, 'The cluster did not answer in time')
        const app = r.apps.find(a => a.kind === kind && a.namespace === namespace && a.name === name)
        if (!app || !visibleTo(app, matcherFor(req.user, cluster))) return res.status(404).json({ error: `${kind} ${namespace}/${name} not found on this cluster` })
        if (app.destination.external && !isAdmin(req.user)) return res.status(403).json({ error: `${name} deploys to another cluster (${app.destination.server}) — only an admin may sync it from here.` })
        const override = checkFreeze(req.user, cluster, req.body)
        req.auditDetail = `${action} ${app.tool} ${kind} ${namespace}/${name}${override ? ` — ${override}` : ''}`
        const out = await withTimeout(runSync(cluster, app, action, { by: req.user.username }), 70e3, 'The cluster did not answer in time')
        res.json({ success: true, ...out })
    } catch (e) { fail(res, e) }
})

// ── GitOps level 2: create / remove Argo CD apps (each locked to one repo and one namespace) ──
const validCreate = (req, res, next) => { try { req.body = { ...cleanCreateApp(req.body), overrideFreeze: req.body?.overrideFreeze }; next() } catch (e) { fail(res, e) } }

router.post('/:id/gitops/apps', requirePermission('gitops:create'), validCreate, async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const spec = req.body
    const write = capabilities(cluster).gitopsSync
    if (write?.ok === false) return res.status(409).json({ error: write.why })
    const match = matcherFor(req.user, cluster)
    if (match && !match(spec.namespace)) return res.status(403).json({ error: `You may not deploy into namespace ${spec.namespace}` })
    if (SYSTEM_NS.test(spec.namespace) && !isAdmin(req.user)) return res.status(403).json({ error: `${spec.namespace} is a system namespace — only an admin may deploy there.` })
    try {
        const r = await withTimeout(readGitops(cluster, { fresh: true }), 90e3, 'The cluster did not answer in time')
        if (r.tools.argocd.state !== 'ok') return res.status(409).json({ error: r.tools.argocd.state === 'missing' ? 'Argo CD is not installed on this cluster — install it from Add-ons first.' : r.tools.argocd.message })
        const override = checkFreeze(req.user, cluster, req.body)
        req.auditDetail = `create argocd Application ${spec.name} from ${spec.repoURL}${spec.path ? `/${spec.path}` : ''}@${spec.targetRevision} into ${spec.namespace}${spec.autoSync ? ' (auto-sync)' : ''}${override ? ` — ${override}` : ''}`
        res.json({ success: true, ...await withTimeout(createArgoApp(cluster, spec, { by: req.user.username }), 90e3, 'The cluster did not answer in time') })
    } catch (e) { fail(res, e) }
})

router.delete('/:id/gitops/apps/:ns/:name', requirePermission('gitops:delete'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const write = capabilities(cluster).gitopsSync
    if (write?.ok === false) return res.status(409).json({ error: write.why })
    try {
        const r = await withTimeout(readGitops(cluster, { fresh: true }), 90e3, 'The cluster did not answer in time')
        const app = r.apps.find(a => a.kind === 'Application' && a.namespace === req.params.ns && a.name === req.params.name)
        if (!app || !visibleTo(app, matcherFor(req.user, cluster))) return res.status(404).json({ error: 'App not found on this cluster' })
        const override = checkFreeze(req.user, cluster, req.body)
        req.auditDetail = `remove argocd Application ${app.namespace}/${app.name}${override ? ` — ${override}` : ''}`
        res.json({ success: true, ...await withTimeout(deleteArgoApp(cluster, app), 90e3, 'The cluster did not answer in time') })
    } catch (e) { fail(res, e) }
})

export default router
