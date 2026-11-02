import express from 'express'
import { requireFeature } from '../services/features.js'
import { requirePermission } from '../middleware/authMiddleware.js'
import { canSeeCluster, canOn, accessOn, nsMatches } from '../services/accessControl.js'
import { canAccessResource } from '../utils/access.js'
import { clusterStore } from '../services/clusterStore.js'
import { capabilities } from '../services/clusterAccess.js'
import { requireApproval } from '../services/approvals.js'
import { readCerts, summarizeCerts, limitCerts, renewCert, NAME, NAMESPACE } from '../services/certManager.js'

// cert-manager of one cluster (mounted at /api/clusters):
//   GET  /:id/certificates          Certificates, Issuers / ClusterIssuers, stuck ACME Challenges
//   POST /:id/certificates/renew    { namespace, name } — issue it again now
// Members limited to some namespaces see (and renew) only theirs.
const router = express.Router()
router.use('/:id/certificates', requireFeature('certManager'))
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(msg), { status: 504 })), ms).unref?.())])

async function visibleCluster(req, res) {
    const c = (await clusterStore.getClusters().catch(() => [])).find(x => x.id === req.params.id)
    if (!c || !canAccessResource(req.user, c) || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
const matcherFor = (user, cluster) => { const nss = accessOn(user, cluster).namespaces; return nss ? (ns) => nsMatches(nss, ns) : null }

router.get('/:id/certificates', requirePermission('security:view'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    try {
        const r = limitCerts(await withTimeout(readCerts(cluster, { fresh: req.query.fresh === '1' }), 130e3, 'The cluster did not answer in time'), matcherFor(req.user, cluster))
        const write = capabilities(cluster).gitopsSync
        res.json({ ...r, summary: summarizeCerts(r), canRenew: canOn(req.user, 'cert:renew', cluster) && write?.ok !== false, readOnlyReason: write?.ok === false ? write.why : null })
    } catch (e) { fail(res, e) }
})

const validRenew = (req, res, next) => NAMESPACE.test(String(req.body?.namespace || '')) && NAME.test(String(req.body?.name || '')) ? next() : res.status(400).json({ error: 'Not a valid certificate' })
router.post('/:id/certificates/renew', requirePermission('cert:renew'), validRenew, requireApproval('cert:renew'), async (req, res) => {
    const cluster = await visibleCluster(req, res)
    if (!cluster) return
    const write = capabilities(cluster).gitopsSync
    if (write?.ok === false) return res.status(409).json({ error: write.why })
    try {
        // always against the cluster as it is now
        const r = limitCerts(await withTimeout(readCerts(cluster, { fresh: true }), 130e3, 'The cluster did not answer in time'), matcherFor(req.user, cluster))
        const cert = r.certificates.find(c => c.namespace === req.body.namespace && c.name === req.body.name)
        if (!cert) return res.status(404).json({ error: 'Certificate not found on this cluster' })
        req.auditDetail = `renew certificate ${cert.namespace}/${cert.name} (${cert.dnsNames.slice(0, 3).join(', ')}; was ${cert.state}${cert.notAfter ? `, valid until ${cert.notAfter.slice(0, 10)}` : ''})`
        res.json({ success: true, ...await withTimeout(renewCert(cluster, cert, { by: req.user.username }), 90e3, 'The cluster did not answer in time') })
    } catch (e) { fail(res, e) }
})

export default router
