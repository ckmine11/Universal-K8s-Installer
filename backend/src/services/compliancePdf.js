import PDFDocument from 'pdfkit'
import { FRAMEWORKS, DOMAINS, ATTESTATIONS, attestationStatus, gradeOf } from '../config/compliance.js'

// The compliance report as a PDF (A4): cover, executive summary, framework
// scorecards, every control with its evidence and fix, node evidence, CIS
// failures, attestations, ready-made fixes, and the tamper seal.

const C = {
    ink: '#0f172a', muted: '#64748b', line: '#e2e8f0', band: '#0b1220', accent: '#0891b2',
    pass: '#16a34a', partial: '#d97706', fail: '#dc2626', todo: '#7c3aed', na: '#94a3b8'
}
const LABEL = { pass: 'PASS', partial: 'PARTIAL', fail: 'FAIL', todo: 'TO CONFIRM', na: 'N/A' }
// the built-in PDF fonts know Latin-1 + a few typographic signs only
const t = (s) => String(s ?? '').replace(/→/g, '->').replace(/[✓✔]/g, 'OK').replace(/≥/g, '>=').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF—–…‘’“”•]/g, '')

export const AUDIT_POLICY = `apiVersion: audit.k8s.io/v1
kind: Policy
omitStages: ["RequestReceived"]
rules:
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
  - level: None
    nonResourceURLs: ["/healthz*", "/readyz*", "/livez*", "/version"]
  - level: Metadata
    resources: [{ group: "", resources: ["secrets", "configmaps"] }]
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete"]
  - level: Metadata`

export const AUDIT_FLAGS = `# /etc/kubernetes/manifests/kube-apiserver.yaml (every control-plane)
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=365      # CERT-In: 180 days, DPDP: 1 year
    - --audit-log-maxbackup=30
    - --audit-log-maxsize=100
# plus hostPath volumes for /etc/kubernetes/audit-policy.yaml and /var/log/kubernetes/audit/`

export const ENCRYPTION_CONFIG = `# /etc/kubernetes/enc/encryption-config.yaml  (key: head -c 32 /dev/urandom | base64)
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources: ["secrets"]
    providers:
      - aescbc: { keys: [{ name: key1, secret: <32-byte base64 key> }] }
      - identity: {}
# kube-apiserver: --encryption-provider-config=/etc/kubernetes/enc/encryption-config.yaml
# then: kubectl get secrets -A -o json | kubectl replace -f -`

export function reportPdf(report, org = {}) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 60, left: 50, right: 50 }, bufferPages: true, info: { Title: t(`Compliance report — ${report.clusterName}`), Author: 'KubeEZ', Subject: 'CERT-In / DPDP / ISO 27001 / CIS evidence', CreationDate: new Date(report.at) } })
        const chunks = []
        doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
        const W = doc.page.width - 100, L = 50
        const date = new Date(report.at)
        const when = `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`

        const ensure = (h) => { if (doc.y + h > doc.page.height - 70) doc.addPage() }
        const h1 = (s) => { doc.addPage(); doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(18).text(t(s), L, 56); doc.moveTo(L, doc.y + 4).lineTo(L + W, doc.y + 4).strokeColor(C.accent).lineWidth(2).stroke(); doc.moveDown(1) }
        const h2 = (s) => { ensure(110); doc.moveDown(0.6).fillColor(C.ink).font('Helvetica-Bold').fontSize(12.5).text(t(s), L); doc.moveDown(0.3) }
        const p = (s, o = {}) => doc.fillColor(o.color || C.ink).font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 9.5).text(t(s), o.x ?? L, o.y, { width: o.width || W, lineGap: 1.5, ...o.opts })
        const pill = (status, x, y) => {
            const label = LABEL[status] || status.toUpperCase()
            doc.font('Helvetica-Bold').fontSize(7.5)
            const w = doc.widthOfString(label) + 10
            doc.roundedRect(x, y, w, 13, 3).fill(C[status] || C.na)
            doc.fillColor('#ffffff').text(label, x + 5, y + 3.2, { lineBreak: false })
            return w
        }
        const code = (s) => {
            doc.font('Courier').fontSize(7.8)
            const h = doc.heightOfString(t(s), { width: W - 16 }) + 12
            ensure(h)
            const y = doc.y
            doc.rect(L, y, W, h).fill('#f1f5f9')
            doc.fillColor(C.ink).font('Courier').fontSize(7.8).text(t(s), L + 8, y + 6, { width: W - 16 })
            doc.y = y + h + 6
        }

        // ── cover ──────────────────────────────────────────────────────────
        doc.rect(0, 0, doc.page.width, 250).fill(C.band)
        doc.fillColor('#67e8f9').font('Helvetica-Bold').fontSize(10).text('KUBEEZ  ·  COMPLIANCE EVIDENCE REPORT', L, 60, { characterSpacing: 1.5 })
        doc.fillColor('#ffffff').fontSize(26).text(t(report.clusterName), L, 84, { width: W })
        doc.fillColor('#cbd5e1').font('Helvetica').fontSize(10.5).text(t(`Kubernetes ${report.k8sVersion || ''}  ·  scanned ${when}  ·  by ${typeof report.by === 'string' ? report.by : report.by?.username || 'KubeEZ'}`), L, doc.y + 6, { width: W })
        doc.fillColor('#94a3b8').fontSize(9).text('CERT-In Directions 2022  ·  DPDP Act 2023 & Rules 2025  ·  ISO/IEC 27001:2022 Annex A  ·  CIS Kubernetes Benchmark', L, doc.y + 8, { width: W })
        // score ring
        const cx = L + 70, cy = 340, r = 52, score = report.score ?? 0
        doc.circle(cx, cy, r).lineWidth(12).strokeColor('#e2e8f0').stroke()
        const color = score >= 75 ? C.pass : score >= 50 ? C.partial : C.fail
        if (score > 0) {
            const a0 = -Math.PI / 2, a1 = a0 + 2 * Math.PI * Math.min(score, 99.9) / 100
            doc.path(`M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}`).lineWidth(12).strokeColor(color).stroke()
        }
        doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(30).text(String(report.score ?? '—'), cx - 50, cy - 20, { width: 100, align: 'center' })
        doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('of 100', cx - 50, cy + 12, { width: 100, align: 'center' })
        doc.fillColor(color).font('Helvetica-Bold').fontSize(40).text(gradeOf(report.score), L + 150, cy - 30)
        doc.fillColor(C.muted).font('Helvetica').fontSize(9.5).text('overall grade', L + 150, cy + 16)
        const tt = report.totals
        doc.fillColor(C.ink).font('Helvetica').fontSize(10).text(t(`${tt.pass} passed · ${tt.partial} partial · ${tt.fail} failed · ${tt.todo} to confirm · ${tt.na} not applicable`), L + 230, cy - 16, { width: W - 230 })
        doc.fillColor(C.muted).fontSize(8.5).text('Weighted by severity (high 3, medium 2, low 1); partial counts half.', L + 230, doc.y + 6, { width: W - 230 })
        // framework cards
        const keys = Object.keys(FRAMEWORKS), cw = (W - 30) / 4
        keys.forEach((k, i) => {
            const f = report.frameworks[k] || {}, x = L + i * (cw + 10), y = 430
            doc.roundedRect(x, y, cw, 92, 6).lineWidth(1).strokeColor(C.line).stroke()
            doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(t(FRAMEWORKS[k].short.toUpperCase()), x + 10, y + 10, { width: cw - 20 })
            const s = f.score
            doc.fillColor(s == null ? C.na : s >= 75 ? C.pass : s >= 50 ? C.partial : C.fail).fontSize(24).text(s == null ? '—' : String(s), x + 10, y + 26, { width: cw - 20 })
            doc.fillColor(C.muted).font('Helvetica').fontSize(7.8).text(`${f.pass || 0} of ${f.controls || 0} controls pass`, x + 10, y + 62, { width: cw - 20 })
        })
        doc.fillColor(C.muted).font('Helvetica').fontSize(8).text(t('This report shows technical evidence that KubeEZ collected from the cluster and its own records, mapped to the frameworks above. The mapping is an aid for audits and questionnaires — it is not legal advice or a certification. Items marked TO CONFIRM need a person to confirm them under Compliance → Attestations.'), L, 560, { width: W })

        // ── executive summary ──────────────────────────────────────────────
        h1('Executive summary')
        const order = { high: 0, medium: 1, low: 2 }
        const bad = report.results.filter(x => x.status === 'fail' || x.status === 'partial').sort((a, b) => order[a.severity] - order[b.severity] || (a.status === 'fail' ? -1 : 1))
        p(bad.length ? `${bad.length} control${bad.length === 1 ? ' needs' : 's need'} attention. The most important first:` : 'Every automated control passes.', { size: 10.5 })
        doc.moveDown(0.5)
        for (const x of bad.slice(0, 10)) {
            ensure(46)
            const y = doc.y
            pill(x.status, L, y)
            doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text(t(`${x.id}  ${x.title}`), L + 80, y + 1.5, { width: W - 80 })
            if (x.fix) p(`Fix: ${x.fix}`, { x: L + 80, width: W - 80, color: C.muted, size: 8.5 })
            doc.moveDown(0.45)
        }
        const todo = report.results.filter(x => x.status === 'todo')
        if (todo.length) { h2('Needs confirmation'); for (const x of todo) p(`•  ${x.title}`) }

        // ── frameworks ─────────────────────────────────────────────────────
        h1('Framework scorecards')
        for (const k of keys) {
            const f = report.frameworks[k] || {}
            h2(`${FRAMEWORKS[k].full} — ${f.score ?? '—'}/100`)
            for (const x of report.results.filter(r => r.refs?.[k])) {
                ensure(20)
                const y = doc.y
                pill(x.status, L, y)
                doc.fillColor(C.ink).font('Helvetica').fontSize(8.6).text(t(`${x.refs[k].join('; ')}  —  ${x.id} ${x.title}`), L + 80, y + 2, { width: W - 80 })
                doc.moveDown(0.25)
            }
        }

        // ── all controls ───────────────────────────────────────────────────
        h1('Controls, evidence and fixes')
        for (const [d, label] of Object.entries(DOMAINS)) {
            const rows = report.results.filter(x => x.domain === d)
            if (!rows.length) continue
            h2(label)
            for (const x of rows) {
                ensure(70)
                const y = doc.y
                pill(x.status, L, y)
                doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.8).text(t(`${x.id}  ${x.title}`), L + 80, y + 1.5, { width: W - 140 })
                doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(t(x.severity.toUpperCase()), L + W - 55, y + 3, { width: 55, align: 'right' })
                p(`Evidence: ${x.evidence}`, { x: L + 80, width: W - 80, size: 8.6 })
                if (x.fix) p(`How to fix: ${x.fix}`, { x: L + 80, width: W - 80, size: 8.6, color: '#0e7490' })
                p(Object.entries(x.refs || {}).map(([k, v]) => `${FRAMEWORKS[k].short}: ${v.join('; ')}`).join('   |   '), { x: L + 80, width: W - 80, size: 7.4, color: C.muted })
                doc.moveDown(0.55)
            }
        }

        // ── node evidence ──────────────────────────────────────────────────
        const nodes = report.evidence?.nodes || []
        if (nodes.length) {
            h1('Node evidence')
            const cols = [['Node', 100], ['OS', 110], ['Time sync', 125], ['SSH', 85], ['Security updates', 75]]
            const row = (cells, bold) => {
                ensure(26)
                const y = doc.y
                let x = L
                let hmax = 0
                cells.forEach((c, i) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(bold ? C.muted : C.ink); const h = doc.heightOfString(t(c), { width: cols[i][1] - 6 }); hmax = Math.max(hmax, h); doc.text(t(c), x, y, { width: cols[i][1] - 6 }); x += cols[i][1] })
                doc.y = y + hmax + 5
                doc.moveTo(L, doc.y - 2).lineTo(L + W, doc.y - 2).strokeColor(C.line).lineWidth(0.5).stroke()
            }
            row(cols.map(c => c[0]), true)
            for (const n of nodes) row([`${n.name}\n${n.ip} · ${n.role}`, n.error ? `not reachable: ${n.error}` : n.os.pretty, n.error ? '—' : `${n.ntp.synced ? 'synchronised' : 'NOT synchronised'}\n${n.ntp.servers.slice(0, 3).join(', ') || 'default'}`, n.ssh ? `root: ${n.ssh.permitrootlogin}\npassword: ${n.ssh.passwordauthentication}` : '—', n.os.securityUpdates == null ? 'unknown' : `${n.os.securityUpdates}${n.os.rebootRequired ? ' (reboot pending)' : ''}`])
        }

        // ── CIS ────────────────────────────────────────────────────────────
        const kb = report.evidence?.kubeBench
        if (kb?.ran) {
            h1('CIS Kubernetes Benchmark (kube-bench)')
            p(`${kb.pass} automated checks passed, ${kb.fail} failed, ${kb.warn} need a manual review${kb.version ? ` · benchmark ${kb.version}` : ''}. Checked on the control-plane node (API server, controller manager, scheduler, etcd, kubelet).`)
            doc.moveDown(0.5)
            for (const f of kb.failures) {
                ensure(40)
                const y = doc.y
                pill('fail', L, y)
                doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(8.8).text(t(`${f.id}  ${f.text}`), L + 50, y + 1.5, { width: W - 50 })
                if (f.fix) p(f.fix, { x: L + 50, width: W - 50, size: 7.8, color: C.muted })
                doc.moveDown(0.4)
            }
        }

        // ── attestations ───────────────────────────────────────────────────
        h1('Attestations')
        p('What a scan cannot see is confirmed by a person in KubeEZ and is valid one year.')
        doc.moveDown(0.4)
        for (const [k, a] of Object.entries(ATTESTATIONS)) {
            const v = org.attestations?.[k], st = attestationStatus(v)
            ensure(36)
            const y = doc.y
            pill(st === 'valid' ? 'pass' : st === 'expired' ? 'partial' : 'todo', L, y)
            doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.2).text(t(a.title), L + 80, y + 1.5, { width: W - 80 })
            p(v ? `${a.fields.map(([f, l]) => v.values?.[f] ? `${l}: ${v.values[f]}` : null).filter(Boolean).join(' · ')} — confirmed by ${v.by} on ${v.at.slice(0, 10)}` : 'Not confirmed yet.', { x: L + 80, width: W - 80, size: 8.4, color: C.muted })
            doc.moveDown(0.4)
        }

        // ── ready-made fixes ───────────────────────────────────────────────
        const need = (id) => report.results.find(x => x.id === id && x.status !== 'pass')
        if (need('LOG-1') || need('LOG-2') || need('ENC-1')) {
            h1('Ready-made fixes')
            if (need('LOG-1') || need('LOG-2')) { h2('API audit log (LOG-1, LOG-2)'); p('Save as /etc/kubernetes/audit-policy.yaml on every control-plane:'); code(AUDIT_POLICY); code(AUDIT_FLAGS) }
            if (need('ENC-1')) { h2('Secrets encrypted at rest (ENC-1)'); code(ENCRYPTION_CONFIG); p('Keep the key safe and together with your backups — without it, an etcd snapshot cannot be restored.', { color: C.fail, size: 8.6 }) }
        }

        // ── seal ───────────────────────────────────────────────────────────
        h1('Verification')
        p('This report is sealed: the SHA-256 below is computed over the report data, and KubeEZ signs it (HMAC-SHA256). Anyone with access can check the seal under Compliance → Verify, or with GET /api/compliance/reports/<id>/verify — a changed report no longer matches.')
        doc.moveDown(0.5)
        code(`Report ID : ${report.id}\nCluster   : ${report.clusterName} (${report.clusterId})\nScanned   : ${report.at}\nSHA-256   : ${report.seal?.sha256}\nSignature : ${report.seal?.hmac}`)

        // footer on every page
        const range = doc.bufferedPageRange()
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i)
            const y = doc.page.height - 40
            doc.page.margins.bottom = 0
            doc.fillColor(C.muted).font('Helvetica').fontSize(7.2)
                .text(t(`KubeEZ compliance report · ${report.clusterName} · ${when} · seal ${String(report.seal?.sha256 || '').slice(0, 16)}`), L, y, { width: W - 60, lineBreak: false })
                .text(`${i + 1} / ${range.count}`, L + W - 60, y, { width: 60, align: 'right', lineBreak: false })
        }
        doc.end()
    })
}

// ── CERT-In incident report (Directions 2022, Annexure I) ───────────────────
export const CERTIN_TYPES = [
    'Targeted scanning / probing of critical networks / systems',
    'Compromise of critical systems / information',
    'Unauthorised access of IT systems / data',
    'Defacement of website or intrusion into a website and unauthorised changes',
    'Malicious code attacks (virus, worm, Trojan, bots, spyware, ransomware, cryptominers)',
    'Attack on servers (database, mail, DNS) and network devices (routers)',
    'Identity theft, spoofing and phishing attacks',
    'Denial of Service (DoS) and Distributed Denial of Service (DDoS) attacks',
    'Attacks on critical infrastructure, SCADA, operational technology systems and wireless networks',
    'Attacks on applications such as e-governance, e-commerce etc.',
    'Data breach',
    'Data leak',
    'Attacks on Internet of Things (IoT) devices and associated systems, networks, software, servers',
    'Attacks or incidents affecting digital payment systems',
    'Attacks through malicious mobile apps',
    'Fake mobile apps',
    'Unauthorised access to social media accounts',
    'Attacks or malicious / suspicious activities affecting cloud computing systems / servers / software / applications',
    'Attacks or malicious / suspicious activities affecting systems related to big data, blockchain, virtual assets, robotics, 3D/4D printing, additive manufacturing, drones',
    'Attacks or malicious / suspicious activities affecting systems related to artificial intelligence and machine learning'
]

export function certinReportPdf({ incident, org = {}, form = {} }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, info: { Title: 'CERT-In incident report', Author: 'KubeEZ' } })
        const chunks = []
        doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
        const W = doc.page.width - 100, L = 50
        const poc = org.attestations?.certin_poc?.values || {}
        const detected = new Date(incident.timestamp)
        const deadline = new Date(detected.getTime() + 6 * 3600e3)
        const ist = (d) => `${new Date(d.getTime() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)} IST`
        const field = (label, value) => {
            if (doc.y > doc.page.height - 100) doc.addPage()
            doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8).text(t(label.toUpperCase()), L, doc.y, { width: W, characterSpacing: 0.5 })
            doc.fillColor(C.ink).font('Helvetica').fontSize(10).text(t(value || '—'), L, doc.y + 2, { width: W, lineGap: 1.5 })
            doc.moveDown(0.7)
        }
        doc.rect(0, 0, doc.page.width, 92).fill(C.band)
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('Cyber security incident report', L, 30)
        doc.fillColor('#cbd5e1').font('Helvetica').fontSize(9.5).text('To CERT-In (incident@cert-in.org.in) — under the CERT-In Directions of 28 April 2022, section 70B(6) IT Act', L, 58, { width: W })
        doc.y = 112
        doc.roundedRect(L, doc.y, W, 34, 5).fill(Date.now() > deadline ? '#fee2e2' : '#fef3c7')
        doc.fillColor(Date.now() > deadline ? C.fail : C.partial).font('Helvetica-Bold').fontSize(10).text(t(`Report within 6 hours of noticing: by ${ist(deadline)}${Date.now() > deadline ? ' — deadline passed, report now and state why' : ''}`), L + 10, doc.y + 11, { width: W - 20 })
        doc.y += 48
        field('Reporting organisation / contact (point of contact)', [form.organisation, poc.name, poc.designation, poc.email, poc.phone].filter(Boolean).join(' · ') || 'Fill in the CERT-In point of contact under Compliance → Attestations')
        field('Type of incident (Annexure I)', form.type || '—')
        field('Date and time of occurrence', form.occurredAt || 'Not known — first noticed as below')
        field('Date and time of detection (noticed)', ist(detected))
        field('Affected systems', [`Kubernetes cluster ${incident.clusterName || incident.clusterId}`, incident.nodeName && `node ${incident.nodeName}${incident.nodeIp ? ` (${incident.nodeIp})` : ''}`, incident.namespace && `namespace ${incident.namespace}`, incident.target && `object ${incident.target}`].filter(Boolean).join(' · '))
        field('Description', [form.description, `KubeEZ detected: ${incident.reason} — ${incident.message || ''}`].filter(Boolean).join('\n\n'))
        field('Symptoms / evidence', (incident.evidence || []).map(e => typeof e === 'string' ? e : `${e.label || e.kind || ''}: ${e.text || e.value || ''}`).join('\n') || incident.details || '—')
        field('Actions taken so far', [form.actions, ...(incident.timeline || []).map(x => `${ist(new Date(x.at))} — ${x.text}${x.by ? ` (${x.by})` : ''}`)].filter(Boolean).join('\n'))
        field('Status', `${incident.status}${incident.closedAt ? ` (closed ${incident.closedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}`)
        field('Logs available', form.logs || 'KubeEZ audit trail (sealed); Kubernetes API audit log and pod logs as configured — provided to CERT-In on request')
        doc.moveDown(0.5)
        doc.fillColor(C.muted).font('Helvetica').fontSize(8).text(t(`Prepared with KubeEZ from incident ${incident.id}. Check every field before sending; CERT-In also accepts reports on its website (www.cert-in.org.in) and by phone (1800-11-4949).`), L, doc.y, { width: W })
        doc.end()
    })
}
