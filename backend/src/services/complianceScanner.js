import { automationEngine } from './automationEngine.js'
import { HELM_ADDONS, SYSTEM_NAMESPACES } from '../config/helmAddons.js'

// Evidence for the compliance report, collected live:
//   control-plane (one SSH round-trip): API server flags, certificates, RBAC,
//     pods, network policies, Ingress TLS, add-ons, Trivy / Kyverno /
//     Gatekeeper results, Velero, and the CIS benchmark (kube-bench as a Job)
//   every node: time sync, SSH settings, OS security updates
//   KubeEZ itself: audit trail, alert channels, incidents, backups, accounts
// (the KubeEZ part is added by complianceService.js)

export const LATEST_K8S_MINOR = 37   // upstream supports the newest three minors
const KUBE_BENCH_IMAGE = 'docker.io/aquasec/kube-bench:v0.16.0'
const KB = 'kubectl'   // the scripts run as root with KUBECONFIG set

const b64 = (s) => Buffer.from(s).toString('base64')
// run a script as root on a node; works for root and sudo users alike
const asRoot = (script) => `echo ${b64(script)} | base64 -d | sudo -n bash 2>/dev/null || echo ${b64(script)} | base64 -d | bash`

const kubeBenchJob = () => ({
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: 'kubeez-kube-bench', namespace: 'kube-system', labels: { 'app.kubernetes.io/managed-by': 'kubeez' } },
    spec: {
        backoffLimit: 0, ttlSecondsAfterFinished: 600,
        template: {
            metadata: { labels: { app: 'kubeez-kube-bench' } },
            spec: {
                hostPID: true, restartPolicy: 'Never',
                nodeSelector: { 'node-role.kubernetes.io/control-plane': '' },
                tolerations: [{ operator: 'Exists' }],
                containers: [{
                    name: 'kube-bench', image: KUBE_BENCH_IMAGE, command: ['kube-bench', '--json'],
                    volumeMounts: [
                        ['var-lib-cni', '/var/lib/cni'], ['var-lib-etcd', '/var/lib/etcd'], ['var-lib-kubelet', '/var/lib/kubelet'],
                        ['var-lib-kube-scheduler', '/var/lib/kube-scheduler'], ['var-lib-kube-controller-manager', '/var/lib/kube-controller-manager'],
                        ['etc-systemd', '/etc/systemd'], ['lib-systemd', '/lib/systemd/'], ['srv-kubernetes', '/srv/kubernetes/'],
                        ['etc-kubernetes', '/etc/kubernetes'], ['usr-bin', '/usr/local/mount-from-host/bin'], ['etc-cni-netd', '/etc/cni/net.d/'], ['opt-cni-bin', '/opt/cni/bin/']
                    ].map(([name, mountPath]) => ({ name, mountPath, readOnly: true }))
                }],
                volumes: [
                    ['var-lib-cni', '/var/lib/cni'], ['var-lib-etcd', '/var/lib/etcd'], ['var-lib-kubelet', '/var/lib/kubelet'],
                    ['var-lib-kube-scheduler', '/var/lib/kube-scheduler'], ['var-lib-kube-controller-manager', '/var/lib/kube-controller-manager'],
                    ['etc-systemd', '/etc/systemd'], ['lib-systemd', '/lib/systemd'], ['srv-kubernetes', '/srv/kubernetes'],
                    ['etc-kubernetes', '/etc/kubernetes'], ['usr-bin', '/usr/bin'], ['etc-cni-netd', '/etc/cni/net.d/'], ['opt-cni-bin', '/opt/cni/bin/']
                ].map(([name, path]) => ({ name, hostPath: { path } }))
            }
        }
    }
})

// add-ons whose presence counts as evidence
const EVIDENCE_ADDONS = ['loki', 'elasticsearch', 'fluent-bit', 'fluentd', 'falco', 'vault', 'sealed-secrets', 'kyverno', 'gatekeeper', 'trivy-operator']

export function masterScript({ cis = true } = {}) {
    const detect = EVIDENCE_ADDONS.map(k => `${KB} -n ${HELM_ADDONS[k].ns} get ${HELM_ADDONS[k].detect} -o name >/dev/null 2>&1 && echo ${k}`).join('\n')
    return `export KUBECONFIG=/etc/kubernetes/admin.conf
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin
echo "@@APISERVER"; grep -E '^ *- --' /etc/kubernetes/manifests/kube-apiserver.yaml 2>/dev/null
echo "@@CERTS"; kubeadm certs check-expiration 2>/dev/null
echo "@@VERSION"; ${KB} version -o json 2>/dev/null | grep -E '"(major|minor|gitVersion)"' | tail -3
echo "@@CRB"; ${KB} get clusterrolebindings -o jsonpath='{range .items[?(@.roleRef.name=="cluster-admin")]}{.metadata.name}{"\\t"}{range .subjects[*]}{.kind}:{.namespace}/{.name},{end}{"\\n"}{end}' 2>/dev/null
echo "@@PODS"; ${KB} get pods -A --field-selector=status.phase!=Succeeded,status.phase!=Failed -o jsonpath='{range .items[*]}{.metadata.namespace}{"\\t"}{.metadata.name}{"\\t"}{.spec.hostNetwork}{"\\t"}{.spec.hostPID}{"\\t"}{.spec.hostIPC}{"\\t"}{range .spec.containers[*]}{.securityContext.privileged}{","}{end}{"\\n"}{end}' 2>/dev/null
echo "@@NETPOL"; ${KB} get networkpolicies -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\\n"}{end}' 2>/dev/null
echo "@@INGRESS"; ${KB} get ingress -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\\t"}{.spec.tls[0].secretName}{.spec.tls[0].hosts[0]}{"\\n"}{end}' 2>/dev/null
echo "@@PV"; ${KB} get pv --no-headers 2>/dev/null | grep -c .
echo "@@ADDONS"
${detect}
${KB} -n velero get deploy velero -o name >/dev/null 2>&1 && echo velero
echo "@@LOKI"; ${KB} -n logging get cm loki -o yaml 2>/dev/null | grep -oE 'retention_period: *[0-9]+h' | head -1
echo "@@VELERO"; ${KB} -n velero get schedules.velero.io --no-headers 2>/dev/null | grep -c .; ${KB} -n velero get backups.velero.io -o jsonpath='{range .items[*]}{.status.completionTimestamp}{"\\n"}{end}' 2>/dev/null | sort | tail -1
echo "@@TRIVY"; ${KB} get vulnerabilityreports -A -o jsonpath='{range .items[*]}{.report.artifact.repository}:{.report.artifact.tag}{"\\t"}{.report.summary.criticalCount}{"\\t"}{.report.summary.highCount}{"\\n"}{end}' 2>/dev/null
echo "@@KYVERNO"; ${KB} get validatingpolicies.policies.kyverno.io -l app.kubernetes.io/managed-by=kubeez -o jsonpath='{range .items[*]}{.metadata.name}{"\\t"}{.spec.validationActions[0]}{"\\n"}{end}' 2>/dev/null
echo "@@KYVERNO_FAIL"; ${KB} get policyreports.wgpolicyk8s.io -A -o jsonpath='{range .items[*]}{.summary.fail}{"\\n"}{end}' 2>/dev/null
echo "@@GATEKEEPER"; ${KB} get constraints -o jsonpath='{range .items[*]}{.metadata.name}{"\\t"}{.spec.enforcementAction}{"\\t"}{.status.totalViolations}{"\\n"}{end}' 2>/dev/null
${cis ? `echo "@@KUBEBENCH"
${KB} -n kube-system delete job kubeez-kube-bench --ignore-not-found --wait=true >/dev/null 2>&1
cat <<'KUBEEZ_JOB' | ${KB} apply -f - >/dev/null 2>&1
${JSON.stringify(kubeBenchJob())}
KUBEEZ_JOB
for i in $(seq 1 60); do
    S=$(${KB} -n kube-system get job kubeez-kube-bench -o jsonpath='{.status.succeeded}{.status.failed}' 2>/dev/null)
    [ -n "$S" ] && break
    sleep 4
done
${KB} -n kube-system logs job/kubeez-kube-bench --tail=-1 2>&1 | tr -d '\\r' | grep -E '^\\{' | tail -1
${KB} -n kube-system delete job kubeez-kube-bench --ignore-not-found --wait=false >/dev/null 2>&1` : ''}
echo "@@END"`
}

export const NODE_SCRIPT = `echo "@@TIME"; timedatectl show -p NTP -p NTPSynchronized 2>/dev/null
IS_CHRONY=""; (systemctl is-active chrony 2>/dev/null; systemctl is-active chronyd 2>/dev/null) | grep -qx active && IS_CHRONY=1
echo "@@CHRONY"; [ -n "$IS_CHRONY" ] && echo chrony || echo timesyncd
# the servers of the time service that actually runs
echo "@@TIMESRC"
if [ -n "$IS_CHRONY" ]; then
    grep -hE '^[[:space:]]*(server|pool)[[:space:]]' /etc/chrony/chrony.conf /etc/chrony.conf /etc/chrony/sources.d/*.sources /etc/chrony.d/*.conf 2>/dev/null | awk '{print $2}'
else
    S=$(grep -hE '^NTP=.' /etc/systemd/timesyncd.conf /etc/systemd/timesyncd.conf.d/*.conf 2>/dev/null | tail -1 | sed 's/^NTP=//')
    if [ -n "$S" ]; then echo "$S" | tr ' ' '\\n'; else timedatectl show-timesync -p ServerName --value 2>/dev/null; timedatectl show-timesync -p FallbackNTPServers --value 2>/dev/null | tr ' ' '\\n'; fi
fi
echo "@@SSHD"; sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication) '
echo "@@OS"; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"
echo "@@UPDATES"
if command -v apt-get >/dev/null 2>&1; then apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep -ciE '^Inst .*securi'
elif command -v dnf >/dev/null 2>&1; then dnf -q --cacheonly updateinfo list --security 2>/dev/null | grep -c .
else echo "?"; fi
echo "@@REBOOT"; [ -f /var/run/reboot-required ] && echo yes || echo no
echo "@@END"`

// ── parsers (pure — unit tested) ────────────────────────────────────────────
export function sections(text) {
    const out = {}
    let cur = null
    for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
        const m = /^@@([A-Z_]+)$/.exec(line.trim())
        if (m) { cur = m[1]; out[cur] = []; continue }
        if (cur) out[cur].push(line)
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]))
}

/** "- --audit-log-maxage=30" lines → { 'audit-log-maxage': '30' } */
export function parseApiserver(text) {
    if (!text) return null
    const flags = {}
    for (const l of text.split('\n')) {
        const m = /^\s*-\s*--([a-z0-9-]+)(?:=(.*))?$/.exec(l)
        if (m) flags[m[1]] = (m[2] ?? 'true').trim().replace(/^["']|["']$/g, '')
    }
    return Object.keys(flags).length ? flags : null
}

/** kubeadm certs check-expiration → [{ name, days }] */
export function parseCerts(text) {
    const out = []
    for (const l of String(text || '').split('\n')) {
        const m = /^(\S+)\s+[A-Z][a-z]{2} \d{2}, \d{4} \d{2}:\d{2} \w+\s+(\d+)([ydhm])\s/.exec(l)
        if (!m) continue
        const n = Number(m[2]), u = m[3]
        out.push({ name: m[1], days: u === 'y' ? n * 365 : u === 'd' ? n : 0 })
    }
    return out
}

export function parseNode(text) {
    const s = sections(text)
    const kv = Object.fromEntries((s.TIME || '').split('\n').map(l => l.split('=')).filter(p => p.length === 2))
    const servers = [...new Set((s.TIMESRC || '').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#')))]
    const ssh = Object.fromEntries((s.SSHD || '').split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length === 2))
    const upd = (s.UPDATES || '').trim()
    return {
        ntp: { synced: kv.NTPSynchronized === 'yes', enabled: kv.NTP === 'yes', servers, daemon: (s.CHRONY || '').trim() || 'timesyncd' },
        ssh: Object.keys(ssh).length ? ssh : null,
        os: { pretty: (s.OS || '').trim() || 'Linux', securityUpdates: /^\d+$/.test(upd) ? Number(upd) : null, rebootRequired: (s.REBOOT || '').trim() === 'yes' }
    }
}

/** kube-bench --json → totals + the failed checks (for the appendix) */
export function parseKubeBench(text) {
    if (!text) return { ran: false, error: 'no output (the job did not finish within 4 minutes, or the image could not be pulled)' }
    let j
    try { j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) } catch { return { ran: false, error: 'unreadable output' } }
    const controls = j.Controls || (Array.isArray(j) ? j : [])
    const t = j.Totals || controls.reduce((a, c) => ({ total_pass: a.total_pass + (c.total_pass || 0), total_fail: a.total_fail + (c.total_fail || 0), total_warn: a.total_warn + (c.total_warn || 0) }), { total_pass: 0, total_fail: 0, total_warn: 0 })
    const failures = []
    for (const c of controls) for (const g of c.tests || []) for (const r of g.results || []) {
        if (r.status === 'FAIL') failures.push({ id: r.test_number, text: r.test_desc, fix: String(r.remediation || '').replace(/\s+/g, ' ').trim().slice(0, 400) })
    }
    return { ran: true, version: controls[0]?.version || null, pass: t.total_pass || 0, fail: t.total_fail || 0, warn: t.total_warn || 0, failures }
}

export function parseMaster(text, { systemNamespaces = SYSTEM_NAMESPACES } = {}) {
    const s = sections(text)
    const lines = (k) => (s[k] || '').split('\n').map(l => l.trim()).filter(Boolean)
    const sys = new Set([...systemNamespaces, 'kube-system', 'kube-public', 'kube-node-lease', 'kube-flannel', 'calico-system', 'tigera-operator', 'velero'])

    // cluster-admin bound to anything but system accounts
    const admins = []
    for (const l of lines('CRB')) {
        const [, subj = ''] = l.split('\t')
        for (const x of subj.split(',').filter(Boolean)) {
            const i = x.indexOf(':'), kind = x.slice(0, i), rest = x.slice(i + 1)
            if (/^system:/.test(rest?.split('/').pop() || '') || /\/system:/.test(rest || '')) continue
            if (kind === 'ServiceAccount' && sys.has((rest || '').split('/')[0])) continue
            admins.push(`${kind === 'ServiceAccount' ? `sa ${rest}` : `${kind.toLowerCase()} ${(rest || '').split('/').pop()}`}`)
        }
    }
    const pods = lines('PODS').map(l => { const [ns, name, hn, hp, hi, priv = ''] = l.split('\t'); return { ns, name, host: [hn, hp, hi].includes('true'), privileged: priv.split(',').includes('true') } })
    const appNs = [...new Set(pods.map(p => p.ns).filter(ns => ns && !sys.has(ns)))].sort()
    const withNetpol = new Set(lines('NETPOL'))
    const minor = Number(((s.VERSION || '').match(/"minor":\s*"(\d+)/g) || []).pop()?.match(/(\d+)/)?.[1]) || null
    const trivyRows = lines('TRIVY').map(l => { const [img, c, h] = l.split('\t'); return { img, critical: Number(c) || 0, high: Number(h) || 0 } })
    const ky = lines('KYVERNO').map(l => l.split('\t'))
    const gk = lines('GATEKEEPER').map(l => l.split('\t'))
    const installed = new Set(lines('ADDONS'))
    const lokiH = Number(((s.LOKI || '').match(/(\d+)h/) || [])[1]) || 0
    const [vsched = '0', vlast = ''] = lines('VELERO')
    const addons = Object.fromEntries([...EVIDENCE_ADDONS, 'velero'].map(k => [k, { installed: installed.has(k) }]))
    addons.loki.retentionDays = Math.floor(lokiH / 24)
    addons.velero.schedules = Number(vsched) || 0
    addons.velero.lastBackup = vlast || null
    Object.assign(addons['trivy-operator'], {
        images: trivyRows.length, critical: trivyRows.reduce((n, r) => n + r.critical, 0), high: trivyRows.reduce((n, r) => n + r.high, 0),
        worst: trivyRows.filter(r => r.critical).sort((a, b) => b.critical - a.critical).slice(0, 4).map(r => `${r.img} (${r.critical})`)
    })
    Object.assign(addons.kyverno, { rules: ky.length, blocking: ky.some(r => r[1] === 'Deny'), violations: lines('KYVERNO_FAIL').reduce((n, x) => n + (Number(x) || 0), 0) })
    Object.assign(addons.gatekeeper, { rules: gk.length, blocking: gk.some(r => r[1] === 'deny'), violations: gk.reduce((n, r) => n + (Number(r[2]) || 0), 0) })
    return {
        apiserver: parseApiserver(s.APISERVER),
        certs: parseCerts(s.CERTS),
        k8s: {
            minor,
            clusterAdmins: s.CRB === undefined ? null : [...new Set(admins)],
            privilegedPods: pods.filter(p => !sys.has(p.ns) && (p.host || p.privileged)).map(p => `${p.ns}/${p.name}`),
            appNamespaces: appNs,
            namespacesWithoutNetpol: appNs.filter(ns => !withNetpol.has(ns)),
            ingresses: lines('INGRESS').map(l => { const [name, tls] = l.split('\t'); return { name, tls: !!tls } }),
            pvCount: Number(lines('PV')[0]) || 0
        },
        addons,
        kubeBench: s.KUBEBENCH === undefined ? { ran: false, error: 'skipped' } : parseKubeBench(s.KUBEBENCH),
        complete: s.END !== undefined
    }
}

// ── collection ──────────────────────────────────────────────────────────────
async function onNode(node, script, timeoutMs) {
    const ssh = await automationEngine.connectSSH(node)
    try {
        const r = await ssh.execCommand(asRoot(script), { timeoutMs })
        return r.stdout || ''
    } finally { ssh.dispose?.() }
}

export async function scanNodes(cluster, onProgress = () => { }) {
    const nodes = [...(cluster.masterNodes || []).map(n => ({ ...n, role: 'control-plane' })), ...(cluster.workerNodes || []).map(n => ({ ...n, role: 'worker' }))]
    const out = []
    for (let i = 0; i < nodes.length; i += 4) {
        const batch = nodes.slice(i, i + 4)
        out.push(...await Promise.all(batch.map(async (n) => {
            const base = { name: n.hostname || n.name || n.ip, ip: n.ip, role: n.role }
            try {
                const text = await onNode(n, NODE_SCRIPT, 60e3)
                if (!text.includes('@@END')) throw new Error('no answer')
                return { ...base, ...parseNode(text) }
            } catch (e) {
                return { ...base, error: e.message, ntp: { synced: false, servers: [] }, ssh: null, os: { pretty: '?', securityUpdates: null } }
            }
        })))
        onProgress(Math.round(30 + 30 * Math.min(1, (i + 4) / nodes.length)), `Checked ${Math.min(i + 4, nodes.length)} of ${nodes.length} nodes`)
    }
    return out
}

export async function scanControlPlane(cluster, { cis = true } = {}) {
    const master = cluster.masterNodes?.[0]
    if (!master) throw new Error('This cluster has no control-plane node')
    const text = await onNode(master, masterScript({ cis }), cis ? 360e3 : 120e3)
    if (!text.includes('@@APISERVER')) throw new Error('The control-plane did not answer the scan (is it reachable over SSH?)')
    return parseMaster(text)
}

// ── fix: NIC / NPL time servers on every node ───────────────────────────────
export const NTP_FIX_SERVERS = ['time.nplindia.org', 'samay1.nic.in', 'samay2.nic.in']
// Every installed time service is configured (chrony and timesyncd): "timedatectl
// set-ntp true" may start either one — on nodes with chrony installed it starts chrony.
export const NTP_FIX_SCRIPT = `SERVERS="${NTP_FIX_SERVERS.join(' ')}"
C=/etc/chrony/chrony.conf; [ -f "$C" ] || C=/etc/chrony.conf
if [ -f "$C" ]; then
    cp -n "$C" "$C.kubeez.bak" 2>/dev/null
    sed -i '/# KubeEZ: NIC \\/ NPL time servers/,$d' "$C"
    sed -i -E 's/^([[:space:]]*(pool|server)[[:space:]])/# kubeez: \\1/' "$C"
    { echo "# KubeEZ: NIC / NPL time servers (CERT-In)"; for s in $SERVERS; do echo "server $s iburst"; done; } >> "$C"
    for d in /etc/chrony/sources.d /etc/chrony.d; do [ -d "$d" ] && for f in "$d"/*; do [ -f "$f" ] && sed -i -E 's/^([[:space:]]*(pool|server)[[:space:]])/# kubeez: \\1/' "$f"; done; done
fi
mkdir -p /etc/systemd/timesyncd.conf.d
printf '[Time]\\nNTP=%s\\nFallbackNTP=\\n' "$SERVERS" > /etc/systemd/timesyncd.conf.d/kubeez-india.conf
timedatectl set-ntp true 2>/dev/null
if (systemctl is-active chrony 2>/dev/null; systemctl is-active chronyd 2>/dev/null) | grep -qx active; then
    systemctl restart chrony 2>/dev/null || systemctl restart chronyd
    chronyc -a makestep >/dev/null 2>&1
    D=chrony
else
    systemctl restart systemd-timesyncd 2>/dev/null
    D=timesyncd
fi
for i in $(seq 1 20); do [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && break; sleep 3; done
echo "RESULT $D $(timedatectl show -p NTPSynchronized --value 2>/dev/null)"`

export async function fixNtp(cluster, log = () => { }) {
    const nodes = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])]
    const results = []
    for (const n of nodes) {
        const name = n.hostname || n.ip
        try {
            const out = await onNode(n, NTP_FIX_SCRIPT, 120e3)
            const m = /RESULT (\S+) (\S*)/.exec(out)
            const ok = m?.[2] === 'yes'
            results.push({ node: name, ok, daemon: m?.[1] || '?' })
            log(ok ? 'success' : 'warning', `${name}: ${m?.[1] || '?'} → ${ok ? 'synchronised with NIC / NPL' : 'set, not synchronised yet (is UDP 123 to the internet allowed?)'}`)
        } catch (e) {
            results.push({ node: name, ok: false, error: e.message })
            log('error', `${name}: ${e.message}`)
        }
    }
    return results
}
