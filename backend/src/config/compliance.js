// Compliance controls: what KubeEZ checks on a cluster, which rule of which
// framework it is evidence for, and how to fix it.
//
// Every control has evaluate(ev) → { status, evidence, fix? } where status is
//   pass | partial | fail | na (not applicable) | todo (needs an attestation)
// and ev is the evidence the scanner collected (services/complianceScanner.js).
// The mapping to legal texts is an aid for audits, not legal advice.

export const FRAMEWORKS = {
    certin: { name: 'CERT-In Directions 2022', short: 'CERT-In', full: 'CERT-In Directions under section 70B(6) of the IT Act, 2000 (28 April 2022)' },
    dpdp: { name: 'DPDP Act 2023 & Rules 2025', short: 'DPDP', full: 'Digital Personal Data Protection Act, 2023 and DPDP Rules, 2025' },
    iso: { name: 'ISO/IEC 27001:2022 Annex A', short: 'ISO 27001', full: 'ISO/IEC 27001:2022 Annex A controls' },
    cis: { name: 'CIS Kubernetes Benchmark', short: 'CIS', full: 'CIS Kubernetes Benchmark (checked with kube-bench)' }
}

export const DOMAINS = {
    time: 'Time & logging', incident: 'Incident response', backup: 'Backup & recovery', crypto: 'Encryption & certificates',
    access: 'Access control', hardening: 'Hardening & vulnerabilities', policy: 'Workload policy', governance: 'Governance'
}

// Things a scan cannot see — confirmed by a person, valid one year
export const ATTESTATIONS = {
    certin_poc: {
        title: 'CERT-In point of contact', refs: { certin: ['(iii) Point of contact for CERT-In'] },
        fields: [['name', 'Name'], ['designation', 'Designation'], ['email', 'Email'], ['phone', 'Phone']]
    },
    data_in_india: {
        title: 'Logs and backups are kept in India', refs: { certin: ['(iv) Logs maintained within Indian jurisdiction'], dpdp: ['s.16 Transfer outside India'] },
        fields: [['location', 'Data centre / region (e.g. Mumbai)']]
    },
    incident_plan: {
        title: 'Incident response plan in place', refs: { certin: ['(ii) Report incidents within 6 hours'], dpdp: ['Rules 2025, Rule 7 — breach intimation within 72 hours'], iso: ['5.24 Incident management planning', '5.26 Response to incidents'] },
        fields: [['document', 'Where the plan is kept'], ['lastDrill', 'Last tested (date)']]
    },
    dpdp_contact: {
        title: 'DPDP contact for data principals (grievances)', refs: { dpdp: ['s.8(9) Contact of a person who answers questions', 's.8(10) Grievance redressal'] },
        fields: [['name', 'Name'], ['email', 'Email']]
    },
    access_review: {
        title: 'Access review done (who can reach the clusters)', refs: { dpdp: ['Rules 2025, Rule 6 — access control'], iso: ['5.18 Access rights'] },
        fields: [['date', 'Date of the last review'], ['by', 'Reviewed by']]
    }
}

const ATTEST_VALID_DAYS = 365
export const attestationStatus = (a, now = Date.now()) => !a ? 'todo' : now - Date.parse(a.at) > ATTEST_VALID_DAYS * 86400e3 ? 'expired' : 'valid'

// NIC / NPL time servers (CERT-In asks for these or servers traceable to them)
export const INDIAN_NTP = ['time.nplindia.org', 'time.nplindia.in', 'samay1.nic.in', 'samay2.nic.in']
const isIndianNtp = (s) => /nplindia|samay\d?\.nic\.in|ntp\.nic\.in/i.test(s)

const days = (iso, now) => iso ? Math.floor((now - Date.parse(iso)) / 86400e3) : null
const plural = (n, w) => `${n} ${n === 1 ? w : w.endsWith('y') ? `${w.slice(0, -1)}ies` : w.endsWith('ss') ? `${w}es` : `${w}s`}`
const list = (a, max = 6) => a.length > max ? `${a.slice(0, max).join(', ')} … (+${a.length - max})` : a.join(', ')
const attested = (key) => (ev) => {
    const a = ev.attestations?.[key], st = attestationStatus(a, ev.now)
    if (st === 'todo') return { status: 'todo', evidence: 'Not confirmed yet.', fix: `Fill in "${ATTESTATIONS[key].title}" under Attestations.` }
    const what = ATTESTATIONS[key].fields.map(([k, l]) => a.values?.[k] ? `${l}: ${a.values[k]}` : null).filter(Boolean).join(' · ')
    if (st === 'expired') return { status: 'partial', evidence: `Confirmed by ${a.by} on ${a.at.slice(0, 10)} — older than a year. ${what}`, fix: 'Review and confirm it again.' }
    return { status: 'pass', evidence: `Confirmed by ${a.by} on ${a.at.slice(0, 10)}. ${what}` }
}

export const CONTROLS = [
    // ── Time & logging ──────────────────────────────────────────────────────
    {
        id: 'TIME-1', domain: 'time', severity: 'high', title: 'Node clocks synchronised with NIC / NPL time servers',
        refs: { certin: ['(i) Clocks synchronised to NIC / NPL NTP'], iso: ['8.17 Clock synchronization'] },
        fixAction: 'ntp',
        evaluate(ev) {
            const nodes = ev.nodes.filter(n => !n.error)
            if (!nodes.length) return { status: 'fail', evidence: 'No node could be checked.' }
            const unsynced = nodes.filter(n => !n.ntp.synced).map(n => n.name)
            const notIndian = nodes.filter(n => n.ntp.synced && !n.ntp.servers.some(isIndianNtp)).map(n => n.name)
            const srv = [...new Set(nodes.flatMap(n => n.ntp.servers))]
            if (unsynced.length) return { status: 'fail', evidence: `Clock not synchronised on ${list(unsynced)}.`, fix: 'Use "Fix: set NIC / NPL time servers" — KubeEZ configures chrony / timesyncd on every node.' }
            if (notIndian.length) return { status: 'partial', evidence: `All ${plural(nodes.length, 'node')} synchronised, but with ${list(srv) || 'default servers'} — not NIC / NPL.`, fix: 'CERT-In asks for NIC / NPL (or servers traceable to them). Use "Fix: set NIC / NPL time servers".' }
            return { status: 'pass', evidence: `All ${plural(nodes.length, 'node')} synchronised with ${list(srv)}.` }
        }
    },
    {
        id: 'LOG-1', domain: 'time', severity: 'high', title: 'Kubernetes API audit log enabled',
        refs: { certin: ['(iv) Logs of ICT systems'], dpdp: ['Rules 2025, Rule 6 — logs and monitoring of access'], iso: ['8.15 Logging'], cis: ['1.2 API server: audit log'] },
        evaluate(ev) {
            const a = ev.apiserver
            if (!a) return { status: 'fail', evidence: 'The API server settings could not be read.' }
            if (!a['audit-log-path']) return { status: 'fail', evidence: 'The API server writes no audit log (no --audit-log-path).', fix: 'Add --audit-policy-file and --audit-log-path to /etc/kubernetes/manifests/kube-apiserver.yaml on every control-plane (see the report appendix for a ready policy).' }
            if (!a['audit-policy-file']) return { status: 'partial', evidence: `Audit log at ${a['audit-log-path']}, but no audit policy (nothing is recorded).`, fix: 'Add --audit-policy-file with a policy that records at least Metadata for all requests.' }
            return { status: 'pass', evidence: `Audit log ${a['audit-log-path']} with policy ${a['audit-policy-file']}.` }
        }
    },
    {
        id: 'LOG-2', domain: 'time', severity: 'high', title: 'Logs kept 180 days (CERT-In) / 1 year (DPDP)',
        refs: { certin: ['(iv) Logs maintained for a rolling 180 days'], dpdp: ['Rules 2025, Rule 6 — logs retained for one year'], iso: ['8.15 Logging'] },
        evaluate(ev) {
            const age = Number(ev.apiserver?.['audit-log-maxage'] || 0)
            const loki = ev.addons.loki?.retentionDays || 0
            const es = ev.addons.elasticsearch?.installed
            const best = Math.max(age, loki)
            const parts = [`API audit log: ${age ? `${age} days` : 'not kept'}`, `pod logs (Loki): ${ev.addons.loki?.installed ? `${loki} days` : 'not installed'}`, `KubeEZ audit trail: ${ev.kubeez.audit.retentionDays} days`]
            if (best >= 365) return { status: 'pass', evidence: parts.join(' · ') }
            if (best >= 180) return { status: 'partial', evidence: `${parts.join(' · ')} — enough for CERT-In (180 days), not for DPDP (1 year).`, fix: 'Keep logs 365 days: --audit-log-maxage=365 and Loki "Keep logs for" 365 days (or ship them to Elasticsearch with a 1-year policy).' }
            return { status: 'fail', evidence: `${parts.join(' · ')}${es ? ' · Elasticsearch installed (check its index retention)' : ''}.`, fix: 'Set --audit-log-maxage=365 on the API server and keep pod logs 180+ days (Loki "Keep logs for", or Elasticsearch).' }
        }
    },
    {
        id: 'LOG-3', domain: 'time', severity: 'medium', title: 'Pod logs collected centrally',
        refs: { certin: ['(iv) Logs of ICT systems'], iso: ['8.15 Logging', '8.16 Monitoring activities'] },
        evaluate(ev) {
            const a = ev.addons
            const where = [a.loki?.installed && 'Loki', a.elasticsearch?.installed && (a['fluent-bit']?.installed || a.fluentd?.installed) && 'Elasticsearch (Fluent Bit / Fluentd)'].filter(Boolean)
            return where.length ? { status: 'pass', evidence: `Pod logs collected in ${where.join(' and ')}.` }
                : { status: 'fail', evidence: 'Pod logs only exist on the nodes and are lost when pods go away.', fix: 'Install "Loki logs", or Elasticsearch + Fluent Bit, from Add-ons.' }
        }
    },
    {
        id: 'LOG-4', domain: 'time', severity: 'medium', title: 'Tamper-evident audit trail of KubeEZ actions',
        refs: { certin: ['(iv) Logs of ICT systems'], dpdp: ['Rules 2025, Rule 6 — logs of access'], iso: ['8.15 Logging', '5.15 Access control'] },
        evaluate(ev) {
            const a = ev.kubeez.audit
            if (!a.chainOk) return { status: 'fail', evidence: `The audit trail's hash chain is broken (${a.reason || 'changed'} near ${a.brokenAt}).`, fix: 'Someone changed the audit files on the KubeEZ server — investigate and restore them from a backup.' }
            return { status: 'pass', evidence: `${plural(a.count, 'entry')} in an unbroken SHA-256 chain${a.oldest ? `, oldest ${a.oldest.slice(0, 10)}` : ''}; kept ${a.retentionDays} days.` }
        }
    },

    // ── Incident response ───────────────────────────────────────────────────
    {
        id: 'IR-1', domain: 'incident', severity: 'high', title: 'Alerts reach people (alert channels)',
        refs: { certin: ['(ii) Report incidents within 6 hours'], dpdp: ['Rules 2025, Rule 6 — monitoring to detect breaches'], iso: ['5.25 Assessment of information security events', '8.16 Monitoring activities'] },
        evaluate(ev) {
            const ch = ev.kubeez.channels
            if (!ch.length) return { status: 'fail', evidence: 'No alert channel — incidents are only visible inside KubeEZ.', fix: 'Add Telegram, WhatsApp, Slack or email under Alerts.' }
            if (ch.length === 1) return { status: 'partial', evidence: `One channel: ${ch[0]}.`, fix: 'Add a second channel (e.g. WhatsApp + email) so an alert is not missed when one fails.' }
            return { status: 'pass', evidence: `${plural(ch.length, 'channel')}: ${ch.join(', ')}.` }
        }
    },
    {
        id: 'IR-2', domain: 'incident', severity: 'high', title: 'Critical incidents handled within 6 hours',
        refs: { certin: ['(ii) Report incidents within 6 hours of noticing'], dpdp: ['s.8(6) Breach intimation', 'Rules 2025, Rule 7 — within 72 hours'], iso: ['5.26 Response to incidents'] },
        evaluate(ev) {
            const i = ev.kubeez.incidents
            const tail = `${plural(i.count, 'incident')} in the last ${i.days} days (${i.critical} critical)${i.mttaMinutes != null ? `, acknowledged after ${i.mttaMinutes} min on average` : ''}.`
            if (i.overdue.length) return { status: 'fail', evidence: `${plural(i.overdue.length, 'critical incident')} open longer than 6 hours: ${list(i.overdue)}. ${tail}`, fix: 'Acknowledge and resolve them; if one is a cyber security incident, report it to CERT-In (incident@cert-in.org.in) — KubeEZ prepares the report from the incident.' }
            if (i.critical && i.unacked) return { status: 'partial', evidence: `${plural(i.unacked, 'critical incident')} never acknowledged. ${tail}`, fix: 'Acknowledge incidents (Incidents → Acknowledge, or the button in Telegram) so the response time is on record.' }
            return { status: 'pass', evidence: tail }
        }
    },
    { id: 'IR-3', domain: 'incident', severity: 'high', title: 'CERT-In point of contact designated', refs: ATTESTATIONS.certin_poc.refs, attestation: 'certin_poc', evaluate: attested('certin_poc') },
    { id: 'IR-4', domain: 'incident', severity: 'medium', title: 'Incident response plan', refs: ATTESTATIONS.incident_plan.refs, attestation: 'incident_plan', evaluate: attested('incident_plan') },
    {
        id: 'RT-1', domain: 'incident', severity: 'medium', title: 'Runtime threat detection',
        refs: { dpdp: ['Rules 2025, Rule 6 — detect unauthorised access'], iso: ['8.7 Protection against malware', '8.16 Monitoring activities'] },
        evaluate(ev) {
            return ev.addons.falco?.installed ? { status: 'pass', evidence: 'Falco watches every node (shells in containers, sensitive files, unexpected tools).' }
                : { status: 'fail', evidence: 'Nothing watches what runs inside containers.', fix: 'Install Falco from Add-ons.' }
        }
    },

    // ── Backup & recovery ───────────────────────────────────────────────────
    {
        id: 'BCK-1', domain: 'backup', severity: 'high', title: 'Recent etcd snapshot (cluster state)',
        refs: { dpdp: ['Rules 2025, Rule 6 — backups for continued processing'], iso: ['8.13 Information backup'] },
        evaluate(ev) {
            const b = ev.kubeez.backups
            if (b.error) return { status: 'fail', evidence: `Snapshots could not be listed: ${b.error}` }
            if (!b.latest) return { status: 'fail', evidence: 'No etcd snapshot exists.', fix: 'Backups → Backup now (KubeEZ also takes one before every upgrade).' }
            const age = days(b.latest, ev.now)
            if (age > 30) return { status: 'partial', evidence: `Newest snapshot ${age} days old (${b.count} kept).`, fix: 'Take a snapshot after important changes — Backups → Backup now.' }
            return { status: 'pass', evidence: `Newest snapshot ${age === 0 ? 'today' : `${age} days ago`} (${b.latest.slice(0, 10)}), ${b.count} kept, ${b.verified} with a checksum.` }
        }
    },
    {
        id: 'BCK-2', domain: 'backup', severity: 'high', title: 'Encrypted offsite copy of backups',
        refs: { dpdp: ['Rules 2025, Rule 6 — backups and encryption'], iso: ['8.13 Information backup', '5.30 ICT readiness for business continuity'] },
        evaluate(ev) {
            const o = ev.kubeez.backups.offsite
            if (!o.connected) return { status: 'fail', evidence: 'Snapshots exist only on the control-plane — lost with it.', fix: 'Connect S3 / MinIO under Backups → Offsite.' }
            if (!o.lastAt) return { status: 'partial', evidence: `Offsite ${o.provider} connected (encrypted), but this cluster was never uploaded.`, fix: 'Take a snapshot — it is uploaded automatically.' }
            if (!o.lastOk) return { status: 'partial', evidence: `Last upload failed on ${o.lastAt.slice(0, 10)}: ${o.error}`, fix: 'Fix the offsite connection (Backups → Offsite) and take a snapshot.' }
            return { status: 'pass', evidence: `Encrypted bundles in ${o.provider} (${o.bucket}); last upload ${o.lastAt.slice(0, 10)}${o.inIndia ? ', region in India' : ''}.` }
        }
    },
    {
        id: 'BCK-3', domain: 'backup', severity: 'medium', title: 'Backups proven restorable',
        refs: { dpdp: ['Rules 2025, Rule 6 — continued processing'], iso: ['8.13 Information backup', '5.30 ICT readiness for business continuity'] },
        evaluate(ev) {
            const t = ev.kubeez.backups.tested
            if (!t) return { status: 'fail', evidence: 'No snapshot was verified or restored in the last 90 days.', fix: 'Backups → Verify on the newest snapshot (it is opened and checked, nothing changes).' }
            return { status: 'pass', evidence: `${t.action === 'etcd.verify' ? 'Snapshot verified' : 'Restore done'} on ${t.at.slice(0, 10)}${t.detail ? ` (${t.detail})` : ''}.` }
        }
    },
    {
        id: 'BCK-4', domain: 'backup', severity: 'medium', title: 'Application data (volumes) backed up',
        refs: { dpdp: ['Rules 2025, Rule 6 — backups'], iso: ['8.13 Information backup'] },
        evaluate(ev) {
            const v = ev.addons.velero
            if (!ev.k8s.pvCount) return { status: 'na', evidence: 'No persistent volumes — nothing to back up.' }
            if (!v?.installed) return { status: 'fail', evidence: `${plural(ev.k8s.pvCount, 'volume')} without a backup.`, fix: 'Backups → Volume data: set up Velero with a daily schedule.' }
            if (!v.schedules) return { status: 'partial', evidence: 'Velero installed, but no schedule.', fix: 'Turn on the daily schedule under Backups → Volume data.' }
            return { status: 'pass', evidence: `Velero with ${plural(v.schedules, 'schedule')}${v.lastBackup ? `, last backup ${v.lastBackup.slice(0, 10)}` : ''}.` }
        }
    },

    // ── Encryption & certificates ───────────────────────────────────────────
    {
        id: 'ENC-1', domain: 'crypto', severity: 'high', title: 'Secrets encrypted at rest in etcd',
        refs: { dpdp: ['Rules 2025, Rule 6 — encryption of personal data'], iso: ['8.24 Use of cryptography'], cis: ['1.2 API server: encryption provider'] },
        evaluate(ev) {
            if (!ev.apiserver) return { status: 'fail', evidence: 'The API server settings could not be read.' }
            return ev.apiserver['encryption-provider-config'] ? { status: 'pass', evidence: `Encryption config ${ev.apiserver['encryption-provider-config']}.` }
                : { status: 'fail', evidence: 'Kubernetes Secrets are stored in etcd in plain base64 — readable in every etcd snapshot.', fix: 'Add --encryption-provider-config with an aescbc / secretbox key on every control-plane, then rewrite the Secrets (kubectl get secrets -A -o json | kubectl replace -f -). Keep the key with the backups.' }
        }
    },
    {
        id: 'ENC-2', domain: 'crypto', severity: 'medium', title: 'Websites served over HTTPS',
        refs: { dpdp: ['Rules 2025, Rule 6 — encryption'], iso: ['8.24 Use of cryptography'] },
        evaluate(ev) {
            const all = ev.k8s.ingresses
            if (!all.length) return { status: 'na', evidence: 'No Ingress objects.' }
            const plain = all.filter(i => !i.tls).map(i => i.name)
            return plain.length ? { status: plain.length === all.length ? 'fail' : 'partial', evidence: `${plural(plain.length, 'Ingress')} without TLS: ${list(plain)}.`, fix: 'Add a tls: section (cert-manager issues the certificate automatically).' }
                : { status: 'pass', evidence: `All ${plural(all.length, 'Ingress')} use TLS.` }
        }
    },
    {
        id: 'ENC-3', domain: 'crypto', severity: 'high', title: 'Cluster certificates not about to expire',
        refs: { iso: ['8.24 Use of cryptography', '8.9 Configuration management'] },
        evaluate(ev) {
            const c = ev.certs
            if (!c?.length) return { status: 'partial', evidence: 'Certificate expiry could not be read (kubeadm certs check-expiration).' }
            const soon = c.filter(x => x.days < 30)
            const min = Math.min(...c.map(x => x.days))
            return soon.length ? { status: soon.some(x => x.days < 7) ? 'fail' : 'partial', evidence: `Expiring soon: ${list(soon.map(x => `${x.name} (${x.days} days)`))}.`, fix: 'Upgrade the cluster (renews them) or run "kubeadm certs renew all" and restart the control-plane pods.' }
                : { status: 'pass', evidence: `${plural(c.length, 'certificate')}, the first expires in ${min} days.` }
        }
    },

    // ── Access control ──────────────────────────────────────────────────────
    {
        id: 'ACC-1', domain: 'access', severity: 'high', title: 'KubeEZ accounts: personal, active, least privilege',
        refs: { dpdp: ['Rules 2025, Rule 6 — access control'], iso: ['5.15 Access control', '5.18 Access rights', '8.5 Secure authentication'] },
        evaluate(ev) {
            const u = ev.kubeez.users
            const issues = []
            if (u.inactive.length) issues.push(`not used for 90+ days: ${list(u.inactive)}`)
            if (u.admins > 3 && u.admins > u.total / 2) issues.push(`${u.admins} of ${u.total} accounts are admins`)
            const base = `${plural(u.total, 'account')} (${u.admins} admin, ${u.suspended} suspended); passwords bcrypt-hashed, 10 wrong attempts lock an account 15 min, sessions end after 24 h.`
            if (issues.length) return { status: 'partial', evidence: `${base} Findings: ${issues.join('; ')}.`, fix: 'Suspend or delete unused accounts and give people the smallest role they need (Team & Roles).' }
            return { status: 'pass', evidence: base }
        }
    },
    {
        id: 'ACC-2', domain: 'access', severity: 'high', title: 'Few cluster-admins in Kubernetes',
        refs: { dpdp: ['Rules 2025, Rule 6 — access control'], iso: ['5.18 Access rights'], cis: ['5.1 RBAC: cluster-admin only where needed'] },
        evaluate(ev) {
            const s = ev.k8s.clusterAdmins
            if (s == null) return { status: 'fail', evidence: 'RBAC could not be read.' }
            if (s.length > 3) return { status: 'partial', evidence: `cluster-admin is bound to ${plural(s.length, 'subject')}: ${list(s)}.`, fix: 'Bind people and apps to narrower roles (edit / view per namespace).' }
            return { status: 'pass', evidence: s.length ? `cluster-admin only for: ${list(s)}.` : 'cluster-admin bound only to system accounts.' }
        }
    },
    {
        id: 'ACC-3', domain: 'access', severity: 'high', title: 'Node SSH hardened (no root password logins)',
        refs: { dpdp: ['Rules 2025, Rule 6 — access control'], iso: ['8.5 Secure authentication', '8.9 Configuration management'] },
        evaluate(ev) {
            const nodes = ev.nodes.filter(n => !n.error && n.ssh)
            if (!nodes.length) return { status: 'fail', evidence: 'SSH settings could not be read.' }
            const weak = nodes.filter(n => n.ssh.permitrootlogin === 'yes' && n.ssh.passwordauthentication === 'yes').map(n => n.name)
            const pw = nodes.filter(n => n.ssh.passwordauthentication === 'yes').map(n => n.name)
            if (weak.length) return { status: 'fail', evidence: `Root can log in with a password on ${list(weak)}.`, fix: 'Use SSH keys; set PermitRootLogin prohibit-password and PasswordAuthentication no (update the node credentials in KubeEZ first).' }
            if (pw.length) return { status: 'partial', evidence: `Password logins allowed on ${list(pw)}.`, fix: 'Use SSH keys and set PasswordAuthentication no.' }
            return { status: 'pass', evidence: `Key-only SSH on all ${plural(nodes.length, 'node')}.` }
        }
    },
    { id: 'ACC-4', domain: 'access', severity: 'medium', title: 'Access review', refs: ATTESTATIONS.access_review.refs, attestation: 'access_review', evaluate: attested('access_review') },

    // ── Hardening & vulnerabilities ─────────────────────────────────────────
    {
        id: 'VUL-1', domain: 'hardening', severity: 'high', title: 'Images scanned for vulnerabilities',
        refs: { dpdp: ['Rules 2025, Rule 6 — security safeguards'], iso: ['8.8 Management of technical vulnerabilities'] },
        evaluate(ev) {
            const t = ev.addons['trivy-operator']
            if (!t?.installed) return { status: 'fail', evidence: 'Running images are not scanned.', fix: 'Install Trivy Operator from Add-ons.' }
            if (!t.images) return { status: 'partial', evidence: 'Trivy Operator installed; first scans still running.' }
            if (t.critical) return { status: 'partial', evidence: `${plural(t.images, 'image')} scanned: ${t.critical} critical and ${t.high} high vulnerabilities${t.worst?.length ? ` (worst: ${list(t.worst, 4)})` : ''}.`, fix: 'Update the images with critical findings (kubectl get vulnerabilityreports -A -o wide).' }
            return { status: 'pass', evidence: `${plural(t.images, 'image')} scanned: no critical vulnerabilities (${t.high} high).` }
        }
    },
    {
        id: 'VUL-2', domain: 'hardening', severity: 'high', title: 'Node OS security updates installed',
        refs: { iso: ['8.8 Management of technical vulnerabilities'] },
        evaluate(ev) {
            const nodes = ev.nodes.filter(n => !n.error)
            const pending = nodes.filter(n => n.os.securityUpdates > 0).map(n => `${n.name} (${n.os.securityUpdates})`)
            const reboot = nodes.filter(n => n.os.rebootRequired).map(n => n.name)
            const unknown = nodes.filter(n => n.os.securityUpdates == null).map(n => n.name)
            if (pending.length) return { status: 'fail', evidence: `Security updates waiting on ${list(pending)}.`, fix: 'Install them node by node (drain, apt/dnf upgrade, reboot, uncordon).' }
            if (reboot.length) return { status: 'partial', evidence: `Updates installed, reboot pending on ${list(reboot)}.`, fix: 'Reboot those nodes one at a time (drain first).' }
            if (unknown.length === nodes.length) return { status: 'partial', evidence: 'The package manager could not report security updates.' }
            return { status: 'pass', evidence: `No security updates waiting on ${plural(nodes.length - unknown.length, 'node')}. ${nodes.map(n => n.os.pretty).filter((v, i, a) => a.indexOf(v) === i).join(', ')}.` }
        }
    },
    {
        id: 'VUL-3', domain: 'hardening', severity: 'medium', title: 'Supported Kubernetes version',
        refs: { iso: ['8.8 Management of technical vulnerabilities'] },
        evaluate(ev) {
            const m = ev.k8s.minor, latest = ev.latestMinor
            if (!m) return { status: 'fail', evidence: 'The version could not be read.' }
            if (m >= latest - 2) return { status: 'pass', evidence: `Kubernetes 1.${m} (supported upstream; newest 1.${latest}).` }
            return { status: m >= latest - 3 ? 'partial' : 'fail', evidence: `Kubernetes 1.${m} no longer gets security fixes upstream (supported: 1.${latest - 2}–1.${latest}).`, fix: 'Upgrade one version at a time from the cluster page (snapshot first, automatic).' }
        }
    },
    {
        id: 'CIS-1', domain: 'hardening', severity: 'high', title: 'CIS Kubernetes Benchmark',
        refs: { cis: ['CIS Kubernetes Benchmark — control plane, etcd, kubelet'], iso: ['8.9 Configuration management'] },
        evaluate(ev) {
            const b = ev.kubeBench
            if (!b?.ran) return { status: 'partial', evidence: `kube-bench did not run${b?.error ? `: ${b.error}` : ' (skipped)'}.`, fix: 'Run the scan again with "CIS benchmark" on.' }
            const total = b.pass + b.fail
            const pct = total ? Math.round(b.pass * 100 / total) : 0
            return { status: b.fail === 0 ? 'pass' : pct >= 80 ? 'partial' : 'fail', evidence: `${b.pass} passed, ${b.fail} failed, ${b.warn} to review (manual) — ${pct}% of automated checks pass.`, fix: b.fail ? 'The failed checks and their fixes are listed in the report appendix.' : undefined }
        }
    },

    // ── Workload policy ─────────────────────────────────────────────────────
    {
        id: 'POL-1', domain: 'policy', severity: 'medium', title: 'Admission policies enforced',
        refs: { iso: ['8.9 Configuration management'], cis: ['5.2 Pod Security'] },
        evaluate(ev) {
            const k = ev.addons.kyverno, g = ev.addons.gatekeeper
            const engines = [k?.installed && `Kyverno (${plural(k.rules, 'rule')}, ${k.blocking ? 'blocking' : 'report only'})`, g?.installed && `Gatekeeper (${plural(g.rules, 'rule')}, ${g.blocking ? 'blocking' : 'report only'})`].filter(Boolean)
            if (!engines.length) return { status: 'fail', evidence: 'Anything may run: no admission policy engine.', fix: 'Install Kyverno or OPA Gatekeeper from Add-ons, start with "Report only".' }
            const violations = (k?.violations || 0) + (g?.violations || 0)
            if (!(k?.blocking || g?.blocking)) return { status: 'partial', evidence: `${engines.join(' · ')}; ${violations} violations reported.`, fix: 'Fix the reported workloads, then switch to "Block".' }
            return { status: 'pass', evidence: `${engines.join(' · ')}; ${violations} existing violations.` }
        }
    },
    {
        id: 'POL-2', domain: 'policy', severity: 'high', title: 'No privileged workloads outside the platform',
        refs: { iso: ['8.9 Configuration management'], cis: ['5.2 Pod Security: privileged containers, host namespaces'] },
        evaluate(ev) {
            const p = ev.k8s.privilegedPods
            return p.length ? { status: 'fail', evidence: `Privileged or host-namespace pods: ${list(p)}.`, fix: 'Remove privileged / hostNetwork / hostPID from these workloads, or move them to a platform namespace on purpose.' }
                : { status: 'pass', evidence: 'No privileged or host-namespace pods in application namespaces.' }
        }
    },
    {
        id: 'POL-3', domain: 'policy', severity: 'medium', title: 'Network policies segment applications',
        refs: { iso: ['8.20 Networks security', '8.22 Segregation of networks'], cis: ['5.3 Network Policies'] },
        evaluate(ev) {
            const ns = ev.k8s.appNamespaces, without = ev.k8s.namespacesWithoutNetpol
            if (!ns.length) return { status: 'na', evidence: 'No application namespaces yet.' }
            if (without.length === ns.length) return { status: 'fail', evidence: `None of the ${plural(ns.length, 'application namespace')} has a NetworkPolicy — every pod can reach every other.`, fix: 'Add a default-deny NetworkPolicy per namespace and allow only the traffic each app needs.' }
            if (without.length) return { status: 'partial', evidence: `Without a NetworkPolicy: ${list(without)}.`, fix: 'Add a default-deny NetworkPolicy to these namespaces.' }
            return { status: 'pass', evidence: `All ${plural(ns.length, 'application namespace')} have NetworkPolicies.` }
        }
    },
    {
        id: 'SEC-1', domain: 'policy', severity: 'low', title: 'Secrets management',
        refs: { dpdp: ['Rules 2025, Rule 6 — encryption, access control'], iso: ['8.24 Use of cryptography'] },
        evaluate(ev) {
            const a = ev.addons
            const tools = [a.vault?.installed && 'HashiCorp Vault', a['sealed-secrets']?.installed && 'Sealed Secrets'].filter(Boolean)
            return tools.length ? { status: 'pass', evidence: `${tools.join(' and ')} in use.` }
                : { status: 'partial', evidence: 'Secrets live only as Kubernetes Secrets (and in Git, if committed there).', fix: 'Use Sealed Secrets (safe in Git) or Vault (secrets injected at runtime) from Add-ons.' }
        }
    },

    // ── Governance ──────────────────────────────────────────────────────────
    { id: 'GOV-1', domain: 'governance', severity: 'high', title: 'Logs and backups kept in India', refs: ATTESTATIONS.data_in_india.refs, attestation: 'data_in_india', evaluate: attested('data_in_india') },
    { id: 'GOV-2', domain: 'governance', severity: 'medium', title: 'DPDP contact for data principals', refs: ATTESTATIONS.dpdp_contact.refs, attestation: 'dpdp_contact', evaluate: attested('dpdp_contact') }
]

const WEIGHT = { high: 3, medium: 2, low: 1 }
const VALUE = { pass: 1, partial: 0.5, fail: 0, todo: 0 }

/** Evaluate every control on the evidence; scores overall and per framework (0–100) */
export function evaluateControls(ev) {
    const results = CONTROLS.map(c => {
        let r
        try { r = c.evaluate(ev) } catch (e) { r = { status: 'fail', evidence: `Could not be evaluated: ${e.message}` } }
        return { id: c.id, domain: c.domain, severity: c.severity, title: c.title, refs: c.refs, attestation: c.attestation || null, fixAction: c.fixAction || null, ...r }
    })
    const score = (rows) => {
        const counted = rows.filter(r => r.status !== 'na')
        const max = counted.reduce((n, r) => n + WEIGHT[r.severity], 0)
        return max ? Math.round(counted.reduce((n, r) => n + WEIGHT[r.severity] * VALUE[r.status], 0) * 100 / max) : null
    }
    const frameworks = Object.fromEntries(Object.keys(FRAMEWORKS).map(f => {
        const rows = results.filter(r => r.refs?.[f])
        return [f, { score: score(rows), controls: rows.length, pass: rows.filter(r => r.status === 'pass').length, fail: rows.filter(r => r.status === 'fail' || r.status === 'todo').length }]
    }))
    const count = (s) => results.filter(r => r.status === s).length
    return { score: score(results), frameworks, results, totals: { pass: count('pass'), partial: count('partial'), fail: count('fail'), todo: count('todo'), na: count('na') } }
}

export const gradeOf = (score) => score == null ? '—' : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E'
