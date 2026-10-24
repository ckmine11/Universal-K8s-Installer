import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { clusterStore } from '../services/clusterStore.js'
import { canAccessResource } from '../utils/access.js'
import { authService } from '../services/authService.js'
import { isPaidPlan } from '../config/planFeatures.js'
import { CONTROLS, FRAMEWORKS, DOMAINS, ATTESTATIONS, attestationStatus } from '../config/compliance.js'
import { complianceStore, complianceJobs, runScan, runNtpFix, summaryOf, sealOf } from '../services/complianceService.js'
import { reportPdf, certinReportPdf, CERTIN_TYPES } from '../services/compliancePdf.js'
import { auditLog } from '../services/auditLog.js'
import { canSeeCluster, canOn, kubeLevelOn } from '../services/accessControl.js'

// Compliance Center: scans, reports (screen, PDF, sealed evidence), fixes,
// attestations, monthly reports, CERT-In incident reports, the audit trail.
// Scans and on-screen results on every plan; PDF / evidence / schedule /
// fixes / CERT-In report on Pro.
const router = express.Router()

const paid = (req) => req.user.role === 'superadmin' || isPaidPlan(authService.getOrgPlan(req.user.orgId))
const needPro = (req, res) => {
    if (paid(req)) return false
    res.status(402).json({ error: 'Reports as PDF, the evidence bundle, monthly reports, fixes and CERT-In reports are part of Pro.', upgrade: true })
    return true
}
async function clusterFor(req, res, id) {
    const c = (await clusterStore.getClusters()).find(x => x.id === id)
    if (!c || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Cluster not found' }); return null }
    return c
}
async function reportFor(req, res) {
    const r = complianceStore.report(req.params.id)
    const c = r && (await clusterStore.getClusters()).find(x => x.id === r.clusterId)
    if (!r || !c || !canSeeCluster(req.user, c)) { res.status(404).json({ error: 'Report not found' }); return null }
    return r
}
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, jobId: e.jobId })
const orgOf = (req) => complianceStore.org(req.user.orgId)

router.use(requirePermission('compliance:view'))

router.get('/meta', (req, res) => {
    res.json({
        frameworks: FRAMEWORKS, domains: DOMAINS, certinTypes: CERTIN_TYPES,
        attestations: Object.fromEntries(Object.entries(ATTESTATIONS).map(([k, a]) => [k, { title: a.title, refs: a.refs, fields: a.fields }])),
        controls: CONTROLS.map(c => ({ id: c.id, domain: c.domain, severity: c.severity, title: c.title, refs: c.refs, attestation: c.attestation || null, fixAction: c.fixAction || null }))
    })
})

router.get('/overview', async (req, res) => {
    try {
        const clusters = (await clusterStore.getClusters()).filter(c => canSeeCluster(req.user, c))
        const org = orgOf(req)
        res.json({
            pro: paid(req),
            clusters: clusters.map(c => ({ id: c.id, name: c.clusterName || c.id, k8sVersion: c.k8sVersion, status: c.status, latest: summaryOf(complianceStore.reports(c.id)[0]), history: complianceStore.reports(c.id).slice(0, 12).map(r => ({ id: r.id, at: r.at, score: r.score })).reverse() })),
            attestations: Object.fromEntries(Object.keys(ATTESTATIONS).map(k => [k, org.attestations[k] ? { ...org.attestations[k], state: attestationStatus(org.attestations[k]) } : { state: 'todo' }])),
            schedule: org.schedule, lastScheduledAt: org.lastScheduledAt, addonScan: org.addonScan || 'off'
        })
    } catch (e) { fail(res, e) }
})

router.get('/clusters/:id/reports', async (req, res) => {
    const c = await clusterFor(req, res, req.params.id); if (!c) return
    res.json({ reports: complianceStore.reports(c.id).map(summaryOf) })
})

router.get('/reports/:id', async (req, res) => {
    const r = await reportFor(req, res); if (!r) return
    res.json(r)
})

router.get('/reports/:id/verify', async (req, res) => {
    const r = await reportFor(req, res); if (!r) return
    const now = sealOf(r)
    const ok = now.sha256 === r.seal?.sha256 && now.hmac === r.seal?.hmac
    const given = String(req.query.sha256 || '').trim().toLowerCase()
    res.json({ ok: ok && (!given || given === r.seal.sha256), sha256: r.seal?.sha256, matchesGiven: given ? given === r.seal?.sha256 : null })
})

router.get('/reports/:id/pdf', async (req, res) => {
    if (needPro(req, res)) return
    const r = await reportFor(req, res); if (!r) return
    try {
        const pdf = await reportPdf(r, complianceStore.org(r.orgId))
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'compliance.report_downloaded', target: { clusterId: r.clusterId, clusterName: r.clusterName }, detail: r.id })
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="kubeez-compliance-${r.clusterName.replace(/[^A-Za-z0-9._-]/g, '_')}-${r.at.slice(0, 10)}.pdf"`)
        res.send(pdf)
    } catch (e) { fail(res, e) }
})

router.get('/reports/:id/evidence', async (req, res) => {
    if (needPro(req, res)) return
    const r = await reportFor(req, res); if (!r) return
    res.setHeader('Content-Disposition', `attachment; filename="kubeez-evidence-${r.clusterName.replace(/[^A-Za-z0-9._-]/g, '_')}-${r.at.slice(0, 10)}.json"`)
    res.json({ format: 'kubeez-compliance-evidence/1', ...r })
})

router.post('/clusters/:id/scan', requirePermission('compliance:manage'), async (req, res) => {
    const c = await clusterFor(req, res, req.params.id); if (!c) return
    try {
        const job = complianceJobs.start(c.id, 'scan', (ctx) => runScan(c, { by: { id: req.user.id, username: req.user.username, role: req.user.role }, cis: req.body?.cis !== false, onProgress: ctx.progress }).then(summaryOf))
        res.status(202).json({ jobId: job.id })
    } catch (e) { fail(res, e) }
})

router.post('/clusters/:id/fix/:action', requirePermission('compliance:manage'), async (req, res) => {
    if (needPro(req, res)) return
    if (req.params.action !== 'ntp') return res.status(404).json({ error: 'Unknown fix' })
    const c = await clusterFor(req, res, req.params.id); if (!c) return
    try {
        const job = complianceJobs.start(c.id, 'fix-ntp', (ctx) => runNtpFix(c, req.user, ctx))
        res.status(202).json({ jobId: job.id })
    } catch (e) { fail(res, e) }
})

router.get('/jobs/:id', async (req, res) => {
    const j = complianceJobs.get(req.params.id)
    // only a job on a cluster of this workspace
    const c = j && (await clusterStore.getClusters()).find(x => x.id === j.clusterId)
    if (!j || !c || !canSeeCluster(req.user, c)) return res.status(404).json({ error: 'Job not found (finished jobs are kept one hour)' })
    res.json(j)
})

router.put('/attestations/:key', requirePermission('compliance:manage'), (req, res) => {
    try {
        const a = complianceStore.setAttestation(req.user.orgId, req.params.key, req.body?.values, req.user.username)
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'compliance.attest', detail: `${ATTESTATIONS[req.params.key].title}` })
        res.json({ ...a, state: attestationStatus(a) })
    } catch (e) { fail(res, e) }
})
router.delete('/attestations/:key', requirePermission('compliance:manage'), (req, res) => {
    complianceStore.removeAttestation(req.user.orgId, req.params.key)
    auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'compliance.attest_removed', detail: ATTESTATIONS[req.params.key]?.title || req.params.key })
    res.json({ ok: true })
})

router.put('/schedule', requirePermission('compliance:manage'), (req, res) => {
    if (needPro(req, res)) return
    res.json(complianceStore.setSchedule(req.user.orgId, req.body || {}))
})

// Add-on images scanned for critical vulnerabilities before install: off | warn | block
router.put('/addon-scan', requirePermission('compliance:manage'), (req, res) => {
    try {
        const mode = complianceStore.setAddonScan(req.user.orgId, req.body?.mode)
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'compliance.addon_scan', detail: mode })
        res.json({ addonScan: mode })
    } catch (e) { fail(res, e) }
})

// CERT-In report for an incident (form: { type, occurredAt, description, actions, organisation })
router.post('/incidents/:id/certin', async (req, res) => {
    if (needPro(req, res)) return
    try {
        const { incidentDetector } = await import('../services/incidentDetector.js')
        const inc = incidentDetector.find(req.params.id)
        const c = inc && (await clusterStore.getClusters()).find(x => x.id === inc.clusterId)
        if (!inc || !c || !canSeeCluster(req.user, c)) return res.status(404).json({ error: 'Incident not found (incidents are kept 7 days)' })
        const form = Object.fromEntries(['type', 'occurredAt', 'description', 'actions', 'organisation', 'logs'].map(k => [k, String(req.body?.[k] || '').slice(0, 4000)]))
        if (form.type && !CERTIN_TYPES.includes(form.type)) return res.status(400).json({ error: 'Choose an incident type from the list' })
        const pdf = await certinReportPdf({ incident: inc, org: orgOf(req), form })
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'compliance.certin_report', target: { clusterId: c.id, clusterName: c.clusterName }, detail: `${inc.reason} (${inc.id})` })
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="cert-in-incident-${inc.id.slice(0, 8)}.pdf"`)
        res.send(pdf)
    } catch (e) { fail(res, e) }
})

// ── audit trail ─────────────────────────────────────────────────────────────
const auditQuery = (req) => ({
    orgId: req.user.role === 'superadmin' && req.query.all === '1' ? undefined : req.user.orgId,
    from: req.query.from || Date.now() - 30 * 86400e3, to: req.query.to || undefined,
    clusterId: req.query.clusterId || undefined, actor: req.query.actor || undefined, action: req.query.action || undefined,
    limit: Math.min(5000, Number(req.query.limit) || 500)
})
router.get('/audit', requirePermission('audit:view'), (req, res) => {
    res.json({ entries: auditLog.query(auditQuery(req)), coverage: auditLog.coverage(req.user.orgId), chain: auditLog.verify() })
})
router.get('/audit.csv', requirePermission('audit:view'), (req, res) => {
    // a cell starting with = + - @ is shown as text, never run as a spreadsheet
    // formula (failed sign-ins record the username an attacker typed)
    const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"` }
    const rows = auditLog.query({ ...auditQuery(req), limit: 50000 })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="kubeez-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send(['time,user,role,ip,action,cluster,ok,status,detail,hash', ...rows.map(r => [r.at, r.actor?.username || 'KubeEZ', r.actor?.role, r.ip, r.action, r.target?.clusterName || r.target?.clusterId, r.ok, r.status, r.detail, r.hash].map(esc).join(','))].join('\n'))
})

export default router
