import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { randomUUID } from 'crypto'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { evaluateControls, ATTESTATIONS, CONTROLS, FRAMEWORKS, gradeOf } from '../config/compliance.js'
import { scanControlPlane, scanNodes, fixNtp, LATEST_K8S_MINOR } from './complianceScanner.js'
import { auditLog, AUDIT_RETENTION_DAYS } from './auditLog.js'

// Compliance reports: scan → evidence → controls → score, kept per cluster
// with a tamper seal; attestations and the monthly schedule per workspace.

const FILE = path.join(DATA_DIR, 'compliance.json')
const KEEP_REPORTS = 24
const SEAL_KEY = () => process.env.APP_SECRET || 'kubeez'

const canonical = (v) => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x)
export const sealOf = (report) => {
    const { seal, ...body } = report
    const sha256 = crypto.createHash('sha256').update(canonical(body)).digest('hex')
    const hmac = crypto.createHmac('sha256', SEAL_KEY()).update(sha256).digest('hex')
    return { sha256, hmac }
}

class ComplianceStore {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { orgs: {}, reports: {} } } }
    _write(d) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(d)) }
    _org(d, orgId) { return (d.orgs[orgId || '_'] ||= { attestations: {}, schedule: { enabled: false }, lastScheduledAt: null }) }

    org(orgId) { return this._org(this._read(), orgId) }
    setAttestation(orgId, key, values, by) {
        if (!ATTESTATIONS[key]) throw Object.assign(new Error('Unknown attestation'), { status: 400 })
        const clean = {}
        for (const [k] of ATTESTATIONS[key].fields) clean[k] = String(values?.[k] ?? '').trim().slice(0, 200)
        if (!Object.values(clean).some(Boolean)) throw Object.assign(new Error('Fill in at least one field'), { status: 400 })
        const d = this._read()
        this._org(d, orgId).attestations[key] = { values: clean, by, at: new Date().toISOString() }
        this._write(d)
        return this._org(d, orgId).attestations[key]
    }
    removeAttestation(orgId, key) { const d = this._read(); delete this._org(d, orgId).attestations[key]; this._write(d) }
    setSchedule(orgId, schedule) {
        const d = this._read()
        const o = this._org(d, orgId)
        o.schedule = { enabled: !!schedule.enabled, cis: schedule.cis !== false }
        this._write(d)
        return o.schedule
    }
    setAddonScan(orgId, mode) {
        if (!['off', 'warn', 'block'].includes(mode)) throw Object.assign(new Error('Choose off, warn or block'), { status: 400 })
        const d = this._read(); this._org(d, orgId).addonScan = mode; this._write(d); return mode
    }
    markScheduled(orgId) { const d = this._read(); this._org(d, orgId).lastScheduledAt = new Date().toISOString(); this._write(d) }

    save(report) {
        const d = this._read()
        const list = (d.reports[report.clusterId] ||= [])
        list.unshift(report)
        d.reports[report.clusterId] = list.slice(0, KEEP_REPORTS)
        this._write(d)
    }
    reports(clusterId) { return this._read().reports[clusterId] || [] }
    report(id) {
        for (const list of Object.values(this._read().reports)) { const r = list.find(x => x.id === id); if (r) return r }
        return null
    }
    dropCluster(clusterId) { const d = this._read(); delete d.reports[clusterId]; this._write(d) }
}
export const complianceStore = new ComplianceStore()

/** A report without the bulky parts — for lists and the overview */
export const summaryOf = (r) => r && ({ id: r.id, clusterId: r.clusterId, clusterName: r.clusterName, at: r.at, by: r.by, score: r.score, grade: gradeOf(r.score), frameworks: r.frameworks, totals: r.totals, cis: r.evidence?.kubeBench?.ran ? { pass: r.evidence.kubeBench.pass, fail: r.evidence.kubeBench.fail } : null })

// ── what KubeEZ itself knows ────────────────────────────────────────────────
async function kubeezEvidence(cluster, now) {
    const { authService } = await import('./authService.js')
    const { notificationStore } = await import('./notificationStore.js')
    const { incidentDetector } = await import('./incidentDetector.js')
    const { offsiteStore } = await import('./offsiteStore.js')
    const { etcdBackupService } = await import('./etcdBackupService.js')
    const orgId = cluster.orgId || null

    const users = (orgId ? authService.getUsersByOrgId(orgId) : []).filter(u => u.role !== 'superadmin')
    const inactive = users.filter(u => !u.isSuspended && (u.lastLoginAt ? now - Date.parse(u.lastLoginAt) > 90 * 86400e3 : now - Date.parse(u.createdAt || 0) > 90 * 86400e3)).map(u => u.username)

    const channels = (orgId ? notificationStore.publicView(orgId, 0).channels : []).filter(c => c.enabled).map(c => c.type)

    const inc = incidentDetector.getIncidents().filter(i => i.clusterId === cluster.id)
    const closed = new Set(['resolved', 'cleared'])
    const crit = inc.filter(i => i.severity === 'critical')
    const acked = inc.filter(i => i.ackAt)
    const incidents = {
        days: 7, count: inc.length, critical: crit.length,
        overdue: crit.filter(i => !closed.has(i.status) && now - Date.parse(i.timestamp) > 6 * 3600e3).map(i => `${i.reason} (${i.target || i.nodeName || ''})`),
        unacked: crit.filter(i => !i.ackAt && !closed.has(i.status)).length,
        mttaMinutes: acked.length ? Math.round(acked.reduce((n, i) => n + (Date.parse(i.ackAt) - Date.parse(i.timestamp)), 0) / acked.length / 60e3) : null
    }

    let backups = { latest: null, count: 0, verified: 0 }
    try {
        const b = await etcdBackupService.listBackups(cluster)
        backups = { latest: b.backups?.[0]?.created || null, count: b.backups?.length || 0, verified: (b.backups || []).filter(x => x.verified).length }
    } catch (e) { backups.error = e.message }
    const off = orgId ? offsiteStore.publicView(orgId) : { connected: false }
    const sync = off.lastSync?.[cluster.id]
    backups.offsite = {
        connected: !!off.connected, provider: off.provider || null, bucket: off.bucket || null,
        inIndia: /ap-south-|mumbai|hyderabad|\bin-|india/i.test(`${off.region || ''} ${off.endpoint || ''}`),
        lastAt: sync?.at || null, lastOk: !!sync?.ok, error: sync?.error || null
    }
    const tested = auditLog.query({ orgId: orgId ?? undefined, clusterId: cluster.id, from: now - 90 * 86400e3, limit: 200 })
        .find(e => e.ok && (e.action === 'etcd.verify' || e.action === 'etcd.restore' || e.action === 'etcd.recover'))
    backups.tested = tested ? { action: tested.action, at: tested.at, detail: tested.detail } : null

    const chain = auditLog.verify()
    const cov = auditLog.coverage(orgId)
    return {
        users: { total: users.length, admins: users.filter(u => u.role === 'admin').length, suspended: users.filter(u => u.isSuspended).length, inactive },
        channels, incidents, backups,
        audit: { retentionDays: AUDIT_RETENTION_DAYS, oldest: cov.oldest, count: chain.count, chainOk: chain.ok, brokenAt: chain.brokenAt, reason: chain.reason }
    }
}

/** Full scan of a cluster → a saved, sealed report */
export async function runScan(cluster, { by = 'KubeEZ', cis = true, onProgress = () => { } } = {}) {
    const now = Date.now()
    onProgress(5, cis ? 'Scanning the control-plane and running the CIS benchmark (2–4 min)' : 'Scanning the control-plane')
    const [cp, nodes] = await Promise.all([
        scanControlPlane(cluster, { cis }),
        scanNodes(cluster, onProgress)
    ])
    onProgress(75, 'Collecting backups, alerts, incidents and accounts')
    const kubeez = await kubeezEvidence(cluster, now)
    const org = complianceStore.org(cluster.orgId)
    // an imported cluster: which controls its provider covers (config/compliance.js HOST_CONTROLS)
    const { usesApi } = await import('./clusterAccess.js')
    const { providerById } = await import('../config/clusterProviders.js')
    const imported = usesApi(cluster) ? { provider: providerById(cluster.provider)?.name || cluster.provider || 'the provider', cloud: providerById(cluster.provider)?.group === 'cloud' } : null
    const evidence = { ...cp, nodes, kubeez: { ...kubeez, addonScan: org.addonScan || 'off' }, attestations: org.attestations, now, latestMinor: LATEST_K8S_MINOR, ...(imported ? { imported } : {}) }
    onProgress(90, 'Scoring')
    const ev = evaluateControls(evidence)
    const prev = complianceStore.reports(cluster.id)[0] || null
    const report = {
        id: randomUUID(), clusterId: cluster.id, clusterName: cluster.clusterName || cluster.id, orgId: cluster.orgId || null,
        at: new Date(now).toISOString(), by, k8sVersion: cluster.k8sVersion || null,
        score: ev.score, frameworks: ev.frameworks, totals: ev.totals, results: ev.results,
        evidence: { ...evidence, attestations: undefined, now: undefined }
    }
    report.seal = sealOf(report)
    complianceStore.save(report)
    auditLog.record({ orgId: cluster.orgId || null, actor: typeof by === 'object' ? by : null, action: 'compliance.scan', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `score ${report.score} (${gradeOf(report.score)})` })
    await announceRegressions(cluster, prev, report).catch(() => { })
    onProgress(100, 'Done')
    return report
}

/** Controls that got worse since the last report → one alert */
export function regressions(prev, cur) {
    if (!prev) return []
    const rank = { pass: 3, na: 3, partial: 2, todo: 1, fail: 0 }
    return cur.results.filter(r => {
        const p = prev.results.find(x => x.id === r.id)
        return p && rank[r.status] < rank[p.status]
    }).map(r => ({ id: r.id, title: r.title, from: prev.results.find(x => x.id === r.id).status, to: r.status }))
}
export async function announceRegressions(cluster, prev, cur) {
    const worse = regressions(prev, cur)
    if (!worse.length || !cluster.orgId) return
    const { notifier } = await import('./notifier.js')
    notifier.emit(cluster.orgId, {
        type: 'compliance_regression', severity: 'warning', key: `compliance|${cluster.id}|${cur.id}`,
        title: `Compliance: ${worse.length} control${worse.length === 1 ? '' : 's'} got worse`,
        text: `${cluster.clusterName}: ${worse.map(w => `${w.id} ${w.title} (${w.from} → ${w.to})`).join('; ')}. Score ${prev.score} → ${cur.score}.`,
        clusterId: cluster.id, clusterName: cluster.clusterName, link: `/compliance?cluster=${cluster.id}`
    })
}

// ── background jobs (a scan takes minutes) ──────────────────────────────────
const jobs = new Map()
export const complianceJobs = {
    start(clusterId, kind, fn) {
        for (const j of jobs.values()) if (j.clusterId === clusterId && j.status === 'running') throw Object.assign(new Error('A compliance scan or fix is already running on this cluster.'), { status: 409, jobId: j.id })
        for (const [id, j] of jobs) if (j.finishedAt && Date.now() - Date.parse(j.finishedAt) > 3600e3) jobs.delete(id)
        const job = { id: randomUUID(), clusterId, kind, status: 'running', progress: 0, step: 'Starting', logs: [], result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null }
        jobs.set(job.id, job)
        const ctx = {
            progress: (p, step) => { job.progress = Math.max(job.progress, p); if (step) job.step = step },
            log: (level, msg) => job.logs.push({ level, msg, at: Date.now() })
        }
        Promise.resolve().then(() => fn(ctx))
            .then(r => { job.status = 'succeeded'; job.result = r; job.progress = 100 })
            .catch(e => { job.status = 'failed'; job.error = e.message })
            .finally(() => { job.finishedAt = new Date().toISOString() })
        return job
    },
    get(id) { return jobs.get(id) || null }
}

export async function runNtpFix(cluster, by, ctx) {
    const results = await fixNtp(cluster, ctx.log)
    auditLog.record({ orgId: cluster.orgId || null, actor: by, action: 'compliance.fix_ntp', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, ok: results.every(r => r.ok), detail: results.map(r => `${r.node}: ${r.ok ? 'ok' : r.error || 'not synced'}`).join('; ') })
    return { results }
}

// ── monthly reports ─────────────────────────────────────────────────────────
export async function runSchedule(now = Date.now()) {
    const { clusterStore } = await import('./clusterStore.js')
    const { authService } = await import('./authService.js')
    const { reportPdf } = await import('./compliancePdf.js')
    const { sendAccountEmail } = await import('../utils/accountEmails.js')
    const { mailConfigured } = await import('../utils/mailer.js')
    const all = complianceStore._read()
    const clusters = await clusterStore.getClusters()
    let ran = 0
    for (const [orgId, o] of Object.entries(all.orgs)) {
        if (!o.schedule?.enabled || orgId === '_') continue
        if (o.lastScheduledAt && now - Date.parse(o.lastScheduledAt) < 30 * 86400e3) continue
        complianceStore.markScheduled(orgId)
        const admins = authService.getUsersByOrgId(orgId).filter(u => u.role === 'admin' && u.email && !u.isSuspended)
        for (const c of clusters.filter(x => x.orgId === orgId && x.status !== 'failed')) {
            try {
                const r = await runScan(c, { by: 'KubeEZ (monthly)', cis: o.schedule.cis !== false })
                ran++
                if (mailConfigured() && admins.length) {
                    const pdf = await reportPdf(r, complianceStore.org(orgId))
                    for (const a of admins) await sendAccountEmail(a.email, {
                        subject: `Monthly compliance report — ${r.clusterName}: ${r.score}/100 (${gradeOf(r.score)})`,
                        text: `The monthly compliance scan of ${r.clusterName} finished.\n\nScore: ${r.score}/100 (${gradeOf(r.score)})\n${Object.entries(r.frameworks).map(([k, f]) => `${FRAMEWORKS[k].short}: ${f.score ?? '—'}`).join(' · ')}\n\nPassed ${r.totals.pass}, partial ${r.totals.partial}, failed ${r.totals.fail}, to confirm ${r.totals.todo}.\nThe full report is attached (PDF, sealed).`,
                        attachments: [{ filename: `kubeez-compliance-${r.clusterName}-${r.at.slice(0, 10)}.pdf`, content: pdf }]
                    }).catch(e => console.warn('[Compliance] report email failed:', e.message))
                }
            } catch (e) { console.warn(`[Compliance] monthly scan of ${c.clusterName} failed:`, e.message) }
        }
    }
    return ran
}
export function startComplianceSchedule() {
    const tick = () => runSchedule().catch(e => console.warn('[Compliance] schedule failed:', e.message))
    setTimeout(tick, 5 * 60e3).unref?.()
    setInterval(tick, 6 * 3600e3).unref?.()
}

export { CONTROLS, ATTESTATIONS, FRAMEWORKS }
