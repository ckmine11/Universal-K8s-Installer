// Compliance scan on a REAL kubeadm cluster: the evidence is read correctly
// (API server, certificates, nodes, kube-bench CIS benchmark), the report and
// its PDF are built and sealed — and the fixes the report hands out really
// work: the audit policy from the PDF turns LOG-1 / LOG-2 green, and the
// NIC / NPL time-server fix configures the node.
// Run via: bash tests/e2e/e2e.sh compliance [distro]
process.env.APP_SECRET = 'e2e-only-secret-0123456789abcdef0123456789abcdef'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-compliance-'))
process.env.KUBEEZ_DATA_DIR = DATA

const NODE = process.env.NODE_CONTAINER
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd, input) => { const r = spawnSync('docker', ['exec', '-i', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, input, maxBuffer: 256 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nodeIp = dx('hostname -I').stdout.split(' ')[0]

const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
automationEngine.connectSSH = async () => ({ execCommand: async (cmd) => dx(cmd), dispose() { } })
const { runScan, runNtpFix } = await import('../../backend/src/services/complianceService.js')
const { reportPdf, AUDIT_POLICY } = await import('../../backend/src/services/compliancePdf.js')
const { auditLog } = await import('../../backend/src/services/auditLog.js')
const YAML = (await import('../../backend/node_modules/yaml/dist/index.js')).default

let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const cluster = { id: 'c-e2e', clusterName: 'e2e-compliance', orgId: 'o-e2e', k8sVersion: '1.35.0', masterNodes: [{ ip: nodeIp, hostname: NODE }], workerNodes: [] }
const st = (r, id) => r.results.find(x => x.id === id)
async function until(fn, ms, every = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every) } return null }

// ── 1. first scan with the CIS benchmark ──
console.log('== Scan (with kube-bench)')
let t = Date.now()
let r = await runScan(cluster, { by: 'e2e', cis: true, onProgress: (p, s) => s && console.log(`   ${p}% ${s}`) })
console.log(`   score ${r.score} in ${Math.round((Date.now() - t) / 1000)}s`)
const ev = r.evidence
ok(ev.apiserver && ev.apiserver['etcd-servers'], `API server flags read (${Object.keys(ev.apiserver || {}).length} flags)`)
ok(ev.certs.length >= 8 && ev.certs.every(c => c.days > 300), `certificates read: ${ev.certs.length}, first expires in ${Math.min(...ev.certs.map(c => c.days))} days`)
ok(ev.k8s.minor === 35, `Kubernetes minor ${ev.k8s.minor}`)
ok(ev.nodes.length === 1 && !ev.nodes[0].error && ev.nodes[0].os.pretty !== '?', `node evidence: ${ev.nodes[0].os.pretty}, time ${ev.nodes[0].ntp.synced ? 'synced' : 'not synced'}, ssh ${JSON.stringify(ev.nodes[0].ssh)}`)
ok(ev.kubeBench.ran && ev.kubeBench.pass > 20, `kube-bench ran: ${ev.kubeBench.pass} pass, ${ev.kubeBench.fail} fail, ${ev.kubeBench.warn} warn (${ev.kubeBench.version})`)
ok(K('-n kube-system get job kubeez-kube-bench').code !== 0 || /Terminating|Complete/.test(K('-n kube-system get job kubeez-kube-bench').stdout), 'the kube-bench job is cleaned up')
ok(st(r, 'LOG-1').status === 'fail' && st(r, 'ENC-1').status === 'fail', 'a fresh kubeadm cluster has no audit log and no Secret encryption (as expected)')
ok(st(r, 'VUL-3').status === 'pass' && st(r, 'ENC-3').status === 'pass', 'supported version, certificates valid')
ok(typeof r.score === 'number' && r.seal?.sha256?.length === 64, `report sealed (${r.seal.sha256.slice(0, 16)}…)`)
const pdf = await reportPdf(r, {})
ok(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 20000, `PDF ${Math.round(pdf.length / 1024)} KB`)
fs.writeFileSync(path.join(DATA, 'report.pdf'), pdf)

// ── 2. the audit-log fix from the PDF really works ──
console.log('== Apply the audit-log fix from the report')
const mf = '/etc/kubernetes/manifests/kube-apiserver.yaml'
const doc = YAML.parse(dx(`cat ${mf}`).stdout)
const c0 = doc.spec.containers[0]
c0.command.push('--audit-policy-file=/etc/kubernetes/audit-policy.yaml', '--audit-log-path=/var/log/kubernetes/audit/audit.log', '--audit-log-maxage=365', '--audit-log-maxbackup=30', '--audit-log-maxsize=100')
c0.volumeMounts.push({ name: 'audit-policy', mountPath: '/etc/kubernetes/audit-policy.yaml', readOnly: true }, { name: 'audit-log', mountPath: '/var/log/kubernetes/audit/' })
doc.spec.volumes.push({ name: 'audit-policy', hostPath: { path: '/etc/kubernetes/audit-policy.yaml', type: 'File' } }, { name: 'audit-log', hostPath: { path: '/var/log/kubernetes/audit/', type: 'DirectoryOrCreate' } })
dx('cat > /etc/kubernetes/audit-policy.yaml', AUDIT_POLICY + '\n')
dx(`cat > /tmp/apiserver.yaml && mv /tmp/apiserver.yaml ${mf}`, YAML.stringify(doc))
await sleep(20e3)
const back = await until(() => K('get --raw=/readyz').stdout === 'ok', 240e3)
ok(!!back, 'the API server came back with the audit policy')
await until(() => dx('test -s /var/log/kubernetes/audit/audit.log && echo y').stdout === 'y', 60e3)
ok(dx('head -c 300 /var/log/kubernetes/audit/audit.log').stdout.includes('"kind":"Event"'), 'audit events are written')

// ── 3. the NIC / NPL time fix ──
console.log('== Fix: NIC / NPL time servers')
const logs = []
const fix = await runNtpFix(cluster, { username: 'e2e' }, { log: (l, m) => { logs.push(m); console.log(`   ${m}`) }, progress() { } })
ok(fix.results.length === 1 && !fix.results[0].error, `fix ran on the node (${fix.results[0].daemon})`)
ok(/time\.nplindia\.org/.test(dx('cat /etc/systemd/timesyncd.conf.d/kubeez-india.conf /etc/chrony/chrony.conf /etc/chrony.conf 2>/dev/null').stdout), 'NIC / NPL servers configured')

// ── 4. rescan: the fixes show ──
console.log('== Rescan (without kube-bench)')
r = await runScan(cluster, { by: 'e2e', cis: false })
ok(st(r, 'LOG-1').status === 'pass', `LOG-1 audit log: ${st(r, 'LOG-1').status} — ${st(r, 'LOG-1').evidence}`)
ok(['pass', 'partial'].includes(st(r, 'LOG-2').status) && /365 days/.test(st(r, 'LOG-2').evidence), `LOG-2 retention: ${st(r, 'LOG-2').status}`)
const time = st(r, 'TIME-1')
ok(r.evidence.nodes[0].ntp.servers.some(s => /nplindia|nic\.in/.test(s)), `TIME-1 sees the NIC / NPL servers: ${time.status} — ${time.evidence}`)
ok(st(r, 'CIS-1').status === 'partial' && /skipped/.test(st(r, 'CIS-1').evidence), 'CIS skipped when not asked for')
ok(auditLog.query({ orgId: 'o-e2e' }).filter(e => e.action === 'compliance.scan').length === 2 && auditLog.query({ orgId: 'o-e2e', action: 'compliance.fix_ntp' }).length === 1 && auditLog.verify().ok, 'scans and the fix are in the audit trail (chain intact)')

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed')
fs.rmSync(DATA, { recursive: true, force: true })
process.exit(fails ? 1 : 0)
