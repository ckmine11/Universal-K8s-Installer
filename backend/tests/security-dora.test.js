// Security (Trivy reports) and DORA delivery metrics: parsing what kubectl
// prints (fixtures are real kubectl 1.36 output of the scripts' jsonpaths),
// per-workload / per-CVE summaries, the four keys, and the API gates.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 's1', clusterName: 'prod', orgId: 'org-s', ownerId: 's-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.60', username: 'root', password: 'x' }], workerNodes: [] }
]))

const sec = await import('../src/services/security.js')
const dora = await import('../src/services/dora.js')
after(() => { sec._test.useConnect(null); dora._test.useConnect(null); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const t = (...f) => f.join('\t')
// what kubectl printed for the VULN / AUDIT jsonpaths (plus more reports in the same format)
const VULN = [
    t('R', 'shop', 'replicaset-web-7d9fc8b6c-web', 'ReplicaSet', 'web-7d9fc8b6c', 'web', 'index.docker.io', 'library/nginx', '1.25', '1', '1', '4', '9', '2026-10-29T10:00:00Z'),
    t('V', 'CRITICAL', 'CVE-2026-1', 'zlib', '1.2', '', '9.8', 'zlib overflow'),
    t('V', 'HIGH', 'CVE-2026-2', 'libssl3', '3.0.1', '3.0.9', '7.5', 'openssl: bad thing'),
    // an older ReplicaSet of the same Deployment: replaced by the newer report
    t('R', 'shop', 'replicaset-web-55b7c9d8f-web', 'ReplicaSet', 'web-55b7c9d8f', 'web', 'index.docker.io', 'library/nginx', '1.21', '9', '9', '9', '9', '2026-10-01T10:00:00Z'),
    t('V', 'CRITICAL', 'CVE-OLD-1', 'zlib', '1.1', '', '9.0', 'old'),
    t('R', 'shop', 'replicaset-api-6c8d7f9b4-api', 'ReplicaSet', 'api-6c8d7f9b4', 'api', 'ghcr.io', 'acme/api', 'v2', '0', '2', '1', '0', '2026-10-29T11:00:00Z'),
    t('V', 'HIGH', 'CVE-2026-2', 'libssl3', '3.0.1', '3.0.9', '7.5', 'openssl: bad thing'),
    t('V', 'HIGH', 'CVE-2026-9', 'busybox', '1.36', '1.36.1', '', 'busybox: with\ta tab'),
    t('R', 'db', 'statefulset-pg-pg', 'StatefulSet', 'pg', 'pg', 'index.docker.io', 'library/postgres', '16', '0', '0', '2', '5', '2026-10-29T09:00:00Z'),
    t('R', 'team-b', 'replicaset-x-7d9fc8b6c-x', 'ReplicaSet', 'x-7d9fc8b6c', 'x', '', 'x', 'latest', '3', '0', '0', '0', '2026-10-29T09:00:00Z'),
    t('V', 'CRITICAL', 'CVE-2026-5', 'glibc', '2.36', '2.36-9', '9.1', 'glibc')
].join('\n')
const AUDIT = [
    t('C', 'shop', 'ReplicaSet', 'web-7d9fc8b6c', '0', '2', '3', '5'),
    t('K', 'HIGH', 'KSV017', 'false', 'Privileged container'),
    t('K', 'HIGH', 'KSV014', 'true', 'Root file system is not read-only'),
    t('C', 'db', 'StatefulSet', 'pg', '0', '0', '1', '0')
].join('\n')
const SEC_OUT = `==KZSEC:VULN==\n${VULN}\n==KZSEC:AUDIT==\n${AUDIT}\n==KZSEC:END==`

describe('Trivy reports', () => {
    const parsed = sec.parseSecurity(SEC_OUT)

    test('reports per container; ReplicaSets shown as their Deployment; images readable', () => {
        assert.deepEqual(parsed.tools, { vulnerabilities: { state: 'ok' }, configAudit: { state: 'ok' } })
        const web = parsed.reports.find(r => r.name === 'web' && r.image === 'nginx:1.25')
        assert.equal(web.kind, 'Deployment'); assert.equal(web.container, 'web')
        assert.deepEqual(web.counts, { critical: 1, high: 1, medium: 4, low: 9 })
        assert.deepEqual(web.vulns[1], { severity: 'HIGH', id: 'CVE-2026-2', pkg: 'libssl3', installed: '3.0.1', fixed: '3.0.9', score: 7.5, title: 'openssl: bad thing' })
        assert.equal(parsed.reports.find(r => r.name === 'api').image, 'ghcr.io/acme/api:v2')
        assert.equal(parsed.reports.find(r => r.name === 'pg').kind, 'StatefulSet')
        assert.equal(parsed.reports.find(r => r.name === 'api').vulns[1].title, 'busybox: with a tab')
        assert.deepEqual(sec.workloadOf('Job', 'backup-29001234'), { kind: 'CronJob', name: 'backup' })
        assert.deepEqual(sec.workloadOf('Pod', 'standalone'), { kind: 'Pod', name: 'standalone' })
        assert.equal(sec.imageName('docker.io', 'bitnami/redis', '7'), 'bitnami/redis:7')
    })

    test('misconfigurations: only failed critical / high checks', () => {
        const a = parsed.audits.find(x => x.name === 'web')
        assert.equal(a.kind, 'Deployment')
        assert.deepEqual(a.checks, [{ severity: 'HIGH', id: 'KSV017', title: 'Privileged container' }])
    })

    test('summary: newest report per workload, totals, CVEs across workloads, fixable', () => {
        const s = sec.summarizeSecurity(parsed)
        const web = s.workloads.find(w => w.name === 'web')
        assert.deepEqual(web.counts, { critical: 1, high: 1, medium: 4, low: 9 }, 'the old ReplicaSet\'s report is not added')
        assert.equal(web.vulns.some(v => v.id === 'CVE-OLD-1'), false)
        assert.equal(web.misconfig.checks[0].id, 'KSV017')
        assert.equal(s.workloads[0].name, 'x', 'most critical first')
        assert.deepEqual(s.totals, { critical: 4, high: 3, medium: 7, low: 14, images: 4, workloads: 4, cves: 4, fixableCves: 3 })
        const shared = s.cves.find(c => c.id === 'CVE-2026-2')
        assert.equal(shared.workloads, 2); assert.deepEqual(shared.fixed, ['3.0.9']); assert.deepEqual(shared.images.sort(), ['ghcr.io/acme/api:v2', 'nginx:1.25'])
        assert.equal(s.cves[0].severity, 'CRITICAL')
        assert.equal(s.misconfig.workloads, 1); assert.equal(s.misconfig.high, 2)
        assert.equal(s.newestReport, '2026-10-29T11:00:00.000Z')
    })

    test('a namespace-limited member sees only their namespaces', () => {
        const s = sec.summarizeSecurity(parsed, { match: (ns) => ns === 'shop' })
        assert.deepEqual(s.workloads.map(w => w.name).sort(), ['api', 'web'])
        assert.equal(s.cves.some(c => c.id === 'CVE-2026-5'), false)
        assert.equal(s.totals.critical, 1)
    })

    test('Trivy not installed, or not readable', () => {
        const none = sec.parseSecurity('==KZSEC:VULN_ERR==\nerror: the server doesn\'t have a resource type "vulnerabilityreports"\n==KZSEC:AUDIT_ERR==\nerror: the server doesn\'t have a resource type "x"\n==KZSEC:END==')
        assert.deepEqual(none.tools, { vulnerabilities: { state: 'missing' }, configAudit: { state: 'missing' } })
        const denied = sec.parseSecurity('==KZSEC:VULN_ERR==\nError from server (Forbidden): vulnerabilityreports.aquasecurity.github.io is forbidden\n==KZSEC:AUDIT==\n\n==KZSEC:END==')
        assert.equal(denied.tools.vulnerabilities.state, 'forbidden'); assert.equal(denied.tools.configAudit.state, 'ok')
    })

    test('the script reads the two report kinds only — never exposed-secret reports, never writes', () => {
        assert.equal(/exposedsecret|get secrets?\b/i.test(sec.SECURITY_SCRIPT), false)
        assert.equal(/\b(patch|annotate|apply|delete|edit|create|replace)\b/.test(sec.SECURITY_SCRIPT), false)
        assert.match(sec.SECURITY_SCRIPT, /vulnerabilityreports\.aquasecurity\.github\.io/)
        assert.match(sec.SECURITY_SCRIPT, /\[\?\(@\.severity=="CRITICAL"\)\]/)
    })
})

const H = 3600e3, D = 24 * H
const NOW = Date.parse('2026-10-30T12:00:00Z')
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
const RS = [
    // web: 1 → 2 → 3 (ReplicaSets in creation order)
    t(iso(20 * D), 'shop', 'Deployment', 'web', '1', 'web:1.0 '),
    t(iso(5 * D), 'shop', 'Deployment', 'web', '2', 'web:1.1 '),
    t(iso(2 * D), 'shop', 'Deployment', 'web', '3', 'web:1.2 '),
    // api: 2 was rolled back to 1 (the old ReplicaSet now has revision 3)
    t(iso(10 * D), 'shop', 'Deployment', 'api', '3', 'api:1 '),
    t(iso(1 * D), 'shop', 'Deployment', 'api', '2', 'api:2 '),
    // web-api: a different Deployment whose pods start with "web-"
    t(iso(3 * D), 'shop', 'Deployment', 'web-api', '1', 'wa:1 '),
    t(iso(6 * H), 'kube-system', 'Deployment', 'coredns', '2', 'coredns:1.11 '),
    t(iso(4 * H), 'team-b', 'Deployment', 'x', '5', 'x:5 '),
    t(iso(1 * H), 'shop', 'ReplicaSet', 'orphan', '', 'o:1 ')
].join('\n')
const CR = [t(iso(30 * D), 'db', 'StatefulSet', 'pg', '1'), t(iso(3 * D), 'db', 'StatefulSet', 'pg', '2'), t(iso(3 * D), 'db', 'Deployment', 'nope', '1')].join('\n')
const DORA_OUT = `==KZDORA:RS==\n${RS}\n==KZDORA:CR==\n${CR}\n==KZDORA:END==`

describe('DORA', () => {
    const rollouts = dora.parseRollouts(DORA_OUT)
    const inc = (o) => ({ id: o.id || Math.random().toString(36).slice(2), status: 'unresolved', ...o })
    const incidents = [
        // web revision 3 (2 days ago): its pod crashes 20 minutes later, fixed after 90 minutes
        inc({ id: 'i-web', reason: 'CrashLoopBackOff', namespace: 'shop', target: 'web-7d9fc8b6c-x2x9z', timestamp: iso(2 * D - 20 * 60e3), status: 'resolved', closedAt: iso(2 * D - 90 * 60e3) }),
        // a crash of web-api's pod 10 minutes after web-api's rollout: web-api's failure, not web's (still open)
        inc({ reason: 'CrashLoopBackOff', namespace: 'shop', target: 'web-api-5c6d7e8f9-abcde', timestamp: iso(3 * D - 10 * 60e3) }),
        // web revision 2: an incident 3 hours later is not caused by that rollout
        inc({ reason: 'CrashLoopBackOff', namespace: 'shop', target: 'web-7d9fc8b6c-aaaaa', timestamp: iso(5 * D - 3 * H) }),
        // pg revision 2: the workload itself unavailable
        inc({ reason: 'WorkloadUnavailable', namespace: 'db', target: 'statefulset/pg', timestamp: iso(3 * D - 5 * 60e3), status: 'cleared', closedAt: iso(3 * D - 65 * 60e3) }),
        // not a deployment failure
        inc({ reason: 'NodeNotReady', namespace: null, target: 'w1', timestamp: iso(2 * D - 10 * 60e3), status: 'resolved', closedAt: iso(2 * D - 40 * 60e3) })
    ]

    test('rollouts from ReplicaSets and ControllerRevisions; a rollback is found', () => {
        const by = (n) => rollouts.filter(r => r.name === n)
        assert.equal(by('web').length, 3); assert.deepEqual(by('web').map(r => r.revision), [1, 2, 3])
        assert.equal(by('web')[0].first, true); assert.equal(by('web')[2].first, false)
        assert.deepEqual(by('web')[1].images, ['web:1.1'])
        const api = by('api')
        assert.equal(api.find(r => r.revision === 2).rolledBack, true, 'api:2 was rolled back')
        assert.equal(api.find(r => r.revision === 3).rolledBack, false)
        assert.equal(by('web').some(r => r.rolledBack), false)
        assert.equal(by('pg').length, 2); assert.equal(by('pg')[0].kind, 'statefulset')
        assert.equal(by('orphan').length, 0); assert.equal(by('nope').length, 0)
    })

    test('the four keys over 7 days (your namespaces only)', () => {
        const r = dora.computeDora({ rollouts, incidents, from: NOW - 7 * D, to: NOW })
        // web 2, web 3, api 2, web-api 1, pg 2, x 5 (coredns is Kubernetes' own)
        assert.equal(r.frequency.deploys, 6)
        assert.equal(r.frequency.perDay, 0.86); assert.equal(r.frequency.level, 'high')
        const failed = r.failures.map(f => `${f.name}@${f.revision}`).sort()
        assert.deepEqual(failed, ['api@2', 'pg@2', 'web-api@1', 'web@3'])
        assert.equal(r.failures.find(f => f.name === 'api').why, 'rolled back')
        assert.match(r.failures.find(f => f.name === 'web').why, /^CrashLoopBackOff/)
        assert.equal(r.failures.find(f => f.name === 'web').incidentId, 'i-web', 'web\'s own pod, not web-api\'s')
        assert.equal(r.changeFailure.percent, 66.7); assert.equal(r.changeFailure.level, 'low'); assert.equal(r.changeFailure.tooFew, false)
        // web@3: its incident closed 90 min after the rollout; pg@2: 65 min; api@2 and web-api@1: not recovered yet
        assert.equal(r.failures.find(f => f.name === 'web').recoveryMinutes, 90)
        assert.equal(r.failures.find(f => f.name === 'pg').recoveryMinutes, 65)
        assert.equal(r.recovery.medianMinutes, 78); assert.equal(r.recovery.measured, 2); assert.equal(r.recovery.unrecovered, 2)
        assert.equal(r.recovery.level, 'high')
        assert.equal(r.incidentRestore.incidents, 3); assert.equal(r.incidentRestore.medianMinutes, 60)
        assert.equal(r.leadTime.available, false)
        assert.equal(r.daily.length, 8); assert.equal(r.daily.reduce((n, d) => n + d.deploys, 0), 6)
        assert.equal(r.workloads[0].name, 'web'); assert.equal(r.workloads[0].deploys, 2)
        assert.equal(r.recent[0].name, 'x')
    })

    test('platform namespaces on request; namespace limits; small numbers are not graded', () => {
        assert.equal(dora.computeDora({ rollouts, incidents, from: NOW - 7 * D, to: NOW, platform: true }).frequency.deploys, 7)
        const scoped = dora.computeDora({ rollouts, incidents, from: NOW - 7 * D, to: NOW, match: (ns) => ns === 'team-b' })
        assert.equal(scoped.frequency.deploys, 1); assert.equal(scoped.changeFailure.level, null); assert.equal(scoped.changeFailure.tooFew, true)
        assert.equal(scoped.incidentRestore.incidents, 1, 'cluster-wide incidents (node) count, other namespaces not')
        const none = dora.computeDora({ rollouts: [], incidents: [], from: NOW - 7 * D, to: NOW })
        assert.equal(none.frequency.level, null); assert.equal(none.changeFailure.percent, null); assert.equal(none.recovery.medianMinutes, null)
    })

    test('DORA bands', () => {
        assert.equal(dora.levelOf('frequency', 3), 'elite'); assert.equal(dora.levelOf('frequency', 0.2), 'high'); assert.equal(dora.levelOf('frequency', 0.05), 'medium'); assert.equal(dora.levelOf('frequency', 0.01), 'low')
        assert.equal(dora.levelOf('failure', 4), 'elite'); assert.equal(dora.levelOf('failure', 12), 'medium'); assert.equal(dora.levelOf('failure', 40), 'low')
        assert.equal(dora.levelOf('recovery', 30), 'elite'); assert.equal(dora.levelOf('recovery', 600), 'high'); assert.equal(dora.levelOf('recovery', 3000), 'medium'); assert.equal(dora.levelOf('recovery', 20000), 'low')
    })

    test('incidents belong to the right workload', () => {
        const d = { namespace: 'shop', kind: 'deployment', name: 'web' }
        assert.equal(dora.aboutWorkload({ namespace: 'shop', target: 'web-7d9fc8b6c-x2x9z' }, d), true)
        assert.equal(dora.aboutWorkload({ namespace: 'shop', target: 'web-api-5c6d7e8f9-abcde' }, d), false)
        assert.equal(dora.aboutWorkload({ namespace: 'other', target: 'web-7d9fc8b6c-x2x9z' }, d), false)
        assert.equal(dora.aboutWorkload({ namespace: 'shop', target: 'deployment/web' }, d), true)
        assert.equal(dora.aboutWorkload({ namespace: 'shop', target: 'x', owner: 'ReplicaSet/web-7d9fc8b6c' }, d), true)
        assert.equal(dora.aboutWorkload({ namespace: 'db', target: 'pg-0' }, { namespace: 'db', kind: 'statefulset', name: 'pg' }), true)
        assert.equal(dora.aboutWorkload({ namespace: 'shop', target: 'web.*-x' }, { namespace: 'shop', kind: 'deployment', name: 'web.*' }), false, 'names are not patterns')
    })

    test('the script only reads', () => {
        assert.equal(/\b(patch|annotate|apply|delete|edit|create|replace)\b|secret/i.test(dora.DORA_SCRIPT), false)
    })
})

describe('API: who sees security and DORA', () => {
    let base, server, roleStore
    const U = {
        admin: { id: 's-admin', username: 'sadmin', orgId: 'org-s', role: 'admin' },
        viewer: { id: 's-view', username: 'sview', orgId: 'org-s', role: 'viewer' },
        scoped: { id: 's-sc', username: 'ssc', orgId: 'org-s', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 's1', role: 'viewer', namespaces: ['shop'] }] },
        custom: { id: 's-cu', username: 'scu', orgId: 'org-s', role: 'custom:x' },
        stranger: { id: 's-x', username: 'sx', orgId: 'org-x', role: 'admin' }
    }
    const get = async (who, p) => { const r = await fetch(base + p, { headers: { 'x-test-user': who } }); return { status: r.status, data: await r.json().catch(() => null) } }

    before(async () => {
        const express = (await import('express')).default
        const { default: router } = await import('../src/routes/clusterReports.js');
        ({ roleStore } = await import('../src/services/roleStore.js'))
        U.custom.role = `custom:${roleStore.create('org-s', { name: 'Clusters only', permissions: ['cluster:view'], kube: 'view' }).id}`
        sec._test.useConnect(async () => ({ execCommand: async () => ({ stdout: SEC_OUT }), dispose() { } }))
        dora._test.useConnect(async () => ({ execCommand: async () => ({ stdout: DORA_OUT }), dispose() { } }))
        const app = express()
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use('/api/clusters', router)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('viewers see both; limited members only their namespaces', async () => {
        const s = await get('viewer', '/api/clusters/s1/security')
        assert.equal(s.status, 200, JSON.stringify(s.data)); assert.equal(s.data.totals.workloads, 4); assert.equal(s.data.limited, false)
        const sc = await get('scoped', '/api/clusters/s1/security')
        assert.deepEqual(sc.data.workloads.map(w => w.namespace).filter((v, i, a) => a.indexOf(v) === i), ['shop']); assert.equal(sc.data.limited, true)
        const d = await get('viewer', '/api/clusters/s1/dora?days=30')
        assert.equal(d.status, 200, JSON.stringify(d.data)); assert.equal(d.data.days, 30); assert.equal(d.data.window.days, 30)
        const ds = await get('scoped', '/api/clusters/s1/dora?days=30')
        assert.ok(ds.data.recent.every(x => x.namespace === 'shop'))
        assert.equal((await get('viewer', '/api/clusters/s1/dora?days=999')).data.days, 7, 'unknown windows fall back to 7 days')
        assert.equal((await get('admin', '/api/clusters/s1/dora?platform=1')).data.platform, true)
    })

    test('a role without the permission 403; another workspace or unknown cluster 404; not signed in 401', async () => {
        const a = await get('custom', '/api/clusters/s1/security'); assert.equal(a.status, 403); assert.equal(a.data.requiredPermission, 'security:view')
        const b = await get('custom', '/api/clusters/s1/dora'); assert.equal(b.status, 403); assert.equal(b.data.requiredPermission, 'metrics:view')
        assert.equal((await get('stranger', '/api/clusters/s1/security')).status, 404)
        assert.equal((await get('stranger', '/api/clusters/s1/dora')).status, 404)
        assert.equal((await get('admin', '/api/clusters/nope/security')).status, 404)
        assert.equal((await get('nobody', '/api/clusters/s1/dora')).status, 401)
    })

    test('a cluster that does not answer is an error, not an empty report', async () => {
        sec._test.useConnect(async () => ({ execCommand: async () => ({ stdout: '==KZSEC:VULN==\nR\t', stderr: 'timed out' }), dispose() { } }))
        const r = await get('admin', '/api/clusters/s1/security?fresh=1')
        assert.equal(r.status, 502); assert.match(r.data.error, /timed out/)
    })
})
