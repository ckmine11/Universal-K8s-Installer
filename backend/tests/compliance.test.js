// Compliance Center: the audit trail (tamper-evident), the evidence parsers,
// the controls and scores, sealed reports, PDFs, and who may do what.
// (A real scan of a cluster: tests/e2e/compliance-check.mjs)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'

const { auditLog, auditTrail } = await import('../src/services/auditLog.js')
const { parseApiserver, parseCerts, parseNode, parseKubeBench, parseMaster, masterScript, NODE_SCRIPT, NTP_FIX_SCRIPT } = await import('../src/services/complianceScanner.js')
const { evaluateControls, CONTROLS, FRAMEWORKS, ATTESTATIONS, attestationStatus, gradeOf } = await import('../src/config/compliance.js')
const { sealOf, regressions, complianceStore } = await import('../src/services/complianceService.js')
const { reportPdf, certinReportPdf, CERTIN_TYPES } = await import('../src/services/compliancePdf.js')

after(() => fs.rmSync(DATA, { recursive: true, force: true }))

// ── audit trail ──
test('audit trail: entries chained by SHA-256; a changed or removed line is detected', () => {
    auditLog.record({ orgId: 'o1', actor: { id: 'u1', username: 'asha', role: 'admin' }, ip: '10.1.1.1', action: 'auth.login' })
    auditLog.record({ orgId: 'o1', actor: { username: 'asha' }, action: 'etcd.restore', target: { clusterId: 'c1' }, detail: 'snap.db' })
    auditLog.record({ orgId: 'o2', actor: { username: 'ravi' }, action: 'auth.login' })
    assert.equal(auditLog.verify().ok, true)
    assert.deepEqual(auditLog.query({ orgId: 'o1' }).map(e => e.action), ['etcd.restore', 'auth.login'], 'newest first, own workspace only')
    assert.equal(auditLog.query({ orgId: 'o1', clusterId: 'c1' }).length, 1)
    assert.ok(auditLog.coverage('o1').oldest)

    const file = path.join(DATA, 'audit', `${new Date().toISOString().slice(0, 7)}.jsonl`)
    const original = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, original.replace('snap.db', 'other.db'))
    assert.deepEqual([auditLog.verify().ok, auditLog.verify().reason], [false, 'an entry was changed'])
    const lines = original.trim().split('\n')
    fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n')
    assert.deepEqual([auditLog.verify().ok, auditLog.verify().reason], [false, 'an entry is missing or was inserted'])
    fs.writeFileSync(file, original)
    assert.equal(auditLog.verify().ok, true)
})

test('audit trail: months older than the retention are removed', () => {
    const dir = path.join(DATA, 'audit')
    fs.writeFileSync(path.join(dir, '2020-01.jsonl'), '')
    assert.equal(auditLog.prune(), 1)
    assert.ok(!fs.existsSync(path.join(dir, '2020-01.jsonl')))
})

test('audit middleware: changes by signed-in users are recorded, reads are not', async () => {
    const app = express()
    app.use(express.json())
    app.use(auditTrail)
    app.use((req, res, next) => { req.user = { id: 'u9', username: 'mira', role: 'operator', orgId: 'o3' }; next() })
    app.post('/api/clusters/:id/addons', (req, res) => res.status(202).json({}))
    app.get('/api/clusters/:id', (req, res) => res.json({}))
    app.delete('/api/clusters/:id', (req, res) => res.status(403).json({}))
    const srv = http.createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const u = `http://127.0.0.1:${srv.address().port}`
    await fetch(`${u}/api/clusters/c7/addons`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    await fetch(`${u}/api/clusters/c7`)
    await fetch(`${u}/api/clusters/c7`, { method: 'DELETE' })
    await new Promise(r => setTimeout(r, 50))
    srv.close()
    const rows = auditLog.query({ orgId: 'o3' })
    assert.deepEqual(rows.map(r => [r.action, r.ok, r.target?.clusterId]), [['DELETE /api/clusters/:id', false, 'c7'], ['POST /api/clusters/:id/addons', true, 'c7']])
    assert.equal(rows[0].actor.username, 'mira')
})

// ── parsers ──
const MASTER = `@@APISERVER
    - --audit-log-path=/var/log/k/audit.log
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-log-maxage=365
    - --encryption-provider-config=/etc/kubernetes/enc/enc.yaml
@@CERTS
CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED
admin.conf                 Oct 12, 2027 08:00 UTC   364d            ca                      no
apiserver                  Oct 15, 2026 08:00 UTC   2d              ca                      no

CERTIFICATE AUTHORITY   EXPIRES                  RESIDUAL TIME   EXTERNALLY MANAGED
ca                      Oct 08, 2035 08:00 UTC   9y              no
@@VERSION
    "minor": "36",
@@CRB
cluster-admin\tGroup:/system:masters,
ops\tUser:/alice,ServiceAccount:ci/deployer,ServiceAccount:argocd/argocd-server,
@@PODS
shop\tweb-1\tfalse\tfalse\tfalse\t,
shop\tdebug\tfalse\ttrue\tfalse\t,
tools\tdind\tfalse\tfalse\tfalse\ttrue,false,
kube-system\tkube-proxy\ttrue\tfalse\tfalse\ttrue,
falco\tfalco-x\tfalse\tfalse\tfalse\ttrue,
@@NETPOL
shop
@@INGRESS
shop/web\tweb-tls
@@PV
2
@@ADDONS
falco
loki
gatekeeper
velero
@@LOKI
retention_period: 4320h
@@VELERO
1
2026-10-11T02:00:00Z
@@TRIVY
@@KYVERNO
@@KYVERNO_FAIL
@@GATEKEEPER
kubeez-disallow-latest-tag\tdeny\t2
kubeez-disallow-privileged\tdryrun\t1
@@END`

test('parsers: API server flags, certificates, RBAC, pods, add-ons', () => {
    const m = parseMaster(MASTER)
    assert.equal(m.apiserver['audit-log-maxage'], '365')
    assert.deepEqual(m.certs.map(c => [c.name, c.days]), [['admin.conf', 364], ['apiserver', 2], ['ca', 3285]])
    assert.equal(m.k8s.minor, 36)
    assert.deepEqual(m.k8s.clusterAdmins, ['user alice', 'sa ci/deployer'], 'system groups and platform add-ons are left out')
    assert.deepEqual(m.k8s.privilegedPods, ['shop/debug', 'tools/dind'], 'hostPID or privileged, outside platform namespaces')
    assert.deepEqual(m.k8s.namespacesWithoutNetpol, ['tools'])
    assert.equal(m.addons.loki.retentionDays, 180)
    assert.deepEqual([m.addons.velero.installed, m.addons.velero.schedules, m.addons.velero.lastBackup], [true, 1, '2026-10-11T02:00:00Z'])
    assert.deepEqual([m.addons.gatekeeper.rules, m.addons.gatekeeper.blocking, m.addons.gatekeeper.violations], [2, true, 3])
    assert.deepEqual(m.kubeBench, { ran: false, error: 'skipped' })
    assert.equal(parseApiserver(''), null)
    assert.deepEqual(parseCerts('garbage'), [])
})

test('parsers: node time sync, SSH, OS updates; kube-bench JSON', () => {
    const n = parseNode('@@TIME\nNTP=yes\nNTPSynchronized=no\n@@TIMESRC\ntime.nplindia.org\nsamay1.nic.in\n# x\n@@CHRONY\nchrony\n@@SSHD\npermitrootlogin prohibit-password\npasswordauthentication no\n@@OS\nRocky Linux 9.4\n@@UPDATES\n?\n@@REBOOT\nyes\n@@END')
    assert.deepEqual(n.ntp, { synced: false, enabled: true, servers: ['time.nplindia.org', 'samay1.nic.in'], daemon: 'chrony' })
    assert.deepEqual(n.ssh, { permitrootlogin: 'prohibit-password', passwordauthentication: 'no' })
    assert.deepEqual(n.os, { pretty: 'Rocky Linux 9.4', securityUpdates: null, rebootRequired: true })
    const kb = parseKubeBench('[INFO] x\n{"Controls":[{"version":"cis-1.10","tests":[{"results":[{"test_number":"1.1.1","test_desc":"perms","status":"FAIL","remediation":"chmod  600\\n x"},{"test_number":"1.1.2","status":"PASS"}]}]}],"Totals":{"total_pass":70,"total_fail":5,"total_warn":30}}')
    assert.deepEqual([kb.ran, kb.pass, kb.fail, kb.warn, kb.version], [true, 70, 5, 30, 'cis-1.10'])
    assert.deepEqual(kb.failures, [{ id: '1.1.1', text: 'perms', fix: 'chmod 600 x' }])
    assert.equal(parseKubeBench('').ran, false)
})

test('scripts: valid shell; the CIS job is optional; NTP fix uses NIC / NPL servers', () => {
    assert.match(masterScript({ cis: true }), /kubeez-kube-bench[\s\S]*aquasec\/kube-bench:v/)
    assert.doesNotMatch(masterScript({ cis: false }), /kube-bench/)
    assert.match(NODE_SCRIPT, /timedatectl show/)
    assert.match(NTP_FIX_SCRIPT, /time\.nplindia\.org samay1\.nic\.in samay2\.nic\.in/)
    assert.match(NTP_FIX_SCRIPT, /cp -n "\$C" "\$C\.kubeez\.bak"/, 'the old chrony config is kept')
})

// ── controls ──
const now = Date.parse('2026-10-12T10:00:00Z')
const nodeOk = { name: 'n1', ip: '10.0.0.4', role: 'control-plane', ntp: { synced: true, servers: ['time.nplindia.org'] }, ssh: { permitrootlogin: 'prohibit-password', passwordauthentication: 'no' }, os: { pretty: 'Ubuntu 24.04', securityUpdates: 0, rebootRequired: false } }
const kubeezOk = {
    users: { total: 3, admins: 1, suspended: 0, inactive: [] }, channels: ['telegram', 'email'],
    incidents: { days: 7, count: 2, critical: 0, overdue: [], unacked: 0, mttaMinutes: 5 },
    backups: { latest: '2026-10-10T00:00:00Z', count: 5, verified: 5, offsite: { connected: true, provider: 'aws', bucket: 'b', lastAt: '2026-10-10T00:00:00Z', lastOk: true, inIndia: true }, tested: { action: 'etcd.verify', at: '2026-10-01T00:00:00Z' } },
    audit: { retentionDays: 400, oldest: '2026-01-01', count: 50, chainOk: true }
}
const evidence = (over = {}) => ({ ...parseMaster(MASTER), nodes: [nodeOk], kubeez: kubeezOk, attestations: {}, now, latestMinor: 37, ...over })

test('controls: every control maps to frameworks and evaluates; scores per framework', () => {
    for (const c of CONTROLS) {
        assert.ok(Object.keys(c.refs).length && Object.keys(c.refs).every(k => FRAMEWORKS[k]), `${c.id} refs`)
        if (c.attestation) assert.ok(ATTESTATIONS[c.attestation], c.id)
    }
    assert.equal(new Set(CONTROLS.map(c => c.id)).size, CONTROLS.length, 'unique ids')
    const e = evaluateControls(evidence())
    const st = Object.fromEntries(e.results.map(r => [r.id, r.status]))
    assert.equal(st['TIME-1'], 'pass')
    assert.equal(st['LOG-1'], 'pass')
    assert.equal(st['LOG-2'], 'pass', '365 days')
    assert.equal(st['ENC-1'], 'pass')
    assert.equal(st['ENC-3'], 'fail', 'apiserver certificate expires in 2 days')
    assert.equal(st['POL-2'], 'fail')
    assert.equal(st['POL-1'], 'pass', 'Gatekeeper blocking')
    assert.equal(st['VUL-1'], 'fail', 'no Trivy')
    assert.equal(st['CIS-1'], 'partial', 'kube-bench skipped')
    assert.equal(st['IR-3'], 'todo')
    assert.equal(st['BCK-4'], 'pass')
    assert.ok(e.score > 0 && e.score < 100)
    for (const f of Object.keys(FRAMEWORKS)) assert.ok(e.frameworks[f].controls > 0, f)
    assert.equal(e.totals.pass + e.totals.partial + e.totals.fail + e.totals.todo + e.totals.na, CONTROLS.length)
})

test('controls: time servers that are not NIC / NPL, unsynced clocks, weak SSH, overdue incidents', () => {
    const r = (ev, id) => evaluateControls(ev).results.find(x => x.id === id)
    assert.equal(r(evidence({ nodes: [{ ...nodeOk, ntp: { synced: true, servers: ['ntp.ubuntu.com'] } }] }), 'TIME-1').status, 'partial')
    assert.equal(r(evidence({ nodes: [{ ...nodeOk, ntp: { synced: false, servers: [] } }] }), 'TIME-1').status, 'fail')
    assert.equal(r(evidence({ nodes: [{ ...nodeOk, ssh: { permitrootlogin: 'yes', passwordauthentication: 'yes' } }] }), 'ACC-3').status, 'fail')
    const late = { ...kubeezOk, incidents: { ...kubeezOk.incidents, critical: 1, overdue: ['NodeNotReady (n1)'] } }
    const ir = r(evidence({ kubeez: late }), 'IR-2')
    assert.equal(ir.status, 'fail')
    assert.match(ir.fix, /CERT-In/)
    assert.equal(r(evidence({ kubeez: { ...kubeezOk, audit: { ...kubeezOk.audit, chainOk: false, reason: 'an entry was changed', brokenAt: 'x' } } }), 'LOG-4').status, 'fail')
    assert.equal(r(evidence({ k8s: { ...parseMaster(MASTER).k8s, minor: 33 } }), 'VUL-3').status, 'fail')
})

test('attestations: confirmed → pass, older than a year → partial', () => {
    const fresh = { values: { name: 'Asha', email: 'a@x.in' }, by: 'admin', at: '2026-09-01T00:00:00Z' }
    const old = { ...fresh, at: '2025-01-01T00:00:00Z' }
    assert.equal(attestationStatus(fresh, now), 'valid')
    assert.equal(attestationStatus(old, now), 'expired')
    const r = (a) => evaluateControls(evidence({ attestations: { certin_poc: a } })).results.find(x => x.id === 'IR-3')
    assert.equal(r(fresh).status, 'pass')
    assert.match(r(fresh).evidence, /Asha/)
    assert.equal(r(old).status, 'partial')
    assert.equal(gradeOf(91), 'A'); assert.equal(gradeOf(40), 'D'); assert.equal(gradeOf(null), '—')
})

test('reports: sealed (a change breaks the seal); regressions between two scans; PDFs build', async () => {
    const e = evaluateControls(evidence())
    const report = { id: 'r1', clusterId: 'c1', clusterName: 'prod', orgId: 'o1', at: new Date(now).toISOString(), by: 'admin', k8sVersion: '1.36.2', ...e, evidence: evidence() }
    report.seal = sealOf(report)
    assert.deepEqual(sealOf(report), report.seal, 'stable')
    assert.notEqual(sealOf({ ...report, score: report.score + 1 }).sha256, report.seal.sha256)
    const worse = evaluateControls(evidence({ nodes: [{ ...nodeOk, ntp: { synced: false, servers: [] } }] }))
    assert.deepEqual(regressions(report, { ...report, ...worse }).map(x => [x.id, x.from, x.to]), [['TIME-1', 'pass', 'fail']])
    assert.deepEqual(regressions(null, report), [])
    const pdf = await reportPdf(report, { attestations: {} })
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
    assert.ok(pdf.length > 15000)
    const c = await certinReportPdf({ incident: { id: 'i1', clusterName: 'prod', timestamp: new Date(now).toISOString(), reason: 'X', status: 'unresolved', timeline: [] }, form: { type: CERTIN_TYPES[2] } })
    assert.equal(c.subarray(0, 5).toString(), '%PDF-')
    assert.equal(CERTIN_TYPES.length, 20)
})

// ── API ──
let srv, url
before(async () => {
    const { authService } = await import('../src/services/authService.js')
    const { requireAuth } = await import('../src/middleware/authMiddleware.js')
    const { clusterStore } = await import('../src/services/clusterStore.js')
    await clusterStore.saveCluster({ id: 'c-a', clusterName: 'shop', orgId: 'o1', ownerId: 'u1', k8sVersion: '1.36.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [] })
    await clusterStore.saveCluster({ id: 'c-b', clusterName: 'theirs', orgId: 'o2', ownerId: 'u9', k8sVersion: '1.36.0', masterNodes: [{ ip: '10.0.0.5' }], workerNodes: [] })
    const e = evaluateControls(evidence())
    for (const [id, cid, name, org] of [['rep-a', 'c-a', 'shop', 'o1'], ['rep-b', 'c-b', 'theirs', 'o2']]) {
        const r = { id, clusterId: cid, clusterName: name, orgId: org, at: new Date(now).toISOString(), by: 'admin', ...e, evidence: evidence() }
        r.seal = sealOf(r)
        complianceStore.save(r)
    }
    const users = { admin: { id: 'u1', username: 'asha', role: 'admin', orgId: 'o1' }, view: { id: 'u2', username: 'v', role: 'viewer', orgId: 'o1' }, free: { id: 'u3', username: 'f', role: 'admin', orgId: 'ofree' } }
    authService.verifyToken = (t) => users[t] || null
    authService.getOrgPlan = (o) => o === 'ofree' ? 'FREE' : 'PRO'
    const { default: routes } = await import('../src/routes/compliance.js')
    const app = express(); app.use(express.json()); app.use('/api/compliance', requireAuth, routes)
    srv = http.createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${srv.address().port}/api/compliance`
})
after(() => srv?.close())
const call = (method, p, tok, body) => fetch(url + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })

test('API: overview and reports of my workspace only; viewers read, admins act', async () => {
    let r = await call('GET', '/overview', 'view')
    let j = await r.json()
    assert.deepEqual(j.clusters.map(c => [c.name, c.latest?.id]), [['shop', 'rep-a']])
    assert.equal(j.attestations.certin_poc.state, 'todo')
    assert.equal((await call('GET', '/reports/rep-b', 'admin')).status, 404, 'another workspace')
    assert.equal((await call('GET', '/reports/rep-a', 'view')).status, 200)
    assert.equal((await call('POST', '/clusters/c-a/scan', 'view', {})).status, 403, 'viewers cannot scan')
    assert.equal((await call('PUT', '/attestations/certin_poc', 'view', { values: { name: 'x' } })).status, 403)
    r = await call('PUT', '/attestations/certin_poc', 'admin', { values: { name: 'Asha Rao', email: 'asha@shop.in', extra: 'ignored' } })
    j = await r.json()
    assert.deepEqual([r.status, j.state, j.by, j.values.extra], [200, 'valid', 'asha', undefined])
    assert.equal((await call('PUT', '/attestations/nope', 'admin', { values: { a: 1 } })).status, 400)
    assert.ok(auditLog.query({ orgId: 'o1', action: 'compliance.attest' }).length, 'confirmations are in the audit trail')
})

test('API: sealed report verifies; PDF and evidence on Pro (402 on Free); audit trail for admins', async () => {
    let j = await (await call('GET', '/reports/rep-a/verify', 'view')).json()
    assert.equal(j.ok, true)
    j = await (await call('GET', `/reports/rep-a/verify?sha256=${'0'.repeat(64)}`, 'view')).json()
    assert.deepEqual([j.ok, j.matchesGiven], [false, false])
    const pdf = await call('GET', '/reports/rep-a/pdf', 'admin')
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.equal((await pdf.arrayBuffer()).byteLength > 15000, true)
    assert.equal((await call('GET', '/reports/rep-a/pdf', 'free')).status, 402)
    assert.equal((await call('GET', '/reports/rep-a/evidence', 'admin')).status, 200)
    assert.equal((await call('GET', '/audit', 'view')).status, 403, 'only admins read the audit trail')
    j = await (await call('GET', '/audit', 'admin')).json()
    assert.ok(j.entries.every(e => e.orgId === 'o1') && j.chain.ok)
    const csv = await (await call('GET', '/audit.csv', 'admin')).text()
    assert.match(csv, /^time,user,role,ip,action/)
    assert.equal((await call('POST', '/incidents/nope/certin', 'admin', {})).status, 404)
    assert.equal((await call('PUT', '/schedule', 'free', { enabled: true })).status, 402)
    j = await (await call('PUT', '/schedule', 'admin', { enabled: true })).json()
    assert.equal(j.enabled, true)
})
