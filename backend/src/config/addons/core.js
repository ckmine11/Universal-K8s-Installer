import { bad, REPOS, int, oneOf, bool, boolOr, nodePort, gi, safePath, email, minorOf } from './common.js'
import { LOKI_DATASOURCE_CM } from './extras.js'

// The original KubeEZ add-ons, now installed with Helm and customizable.
// Each one installed before (kubectl manifests / scripts) is taken over in
// place by Helm on the first Apply — same names, same ports, data kept.

const takeoverNote = (extra = '') => `Installed before KubeEZ managed add-ons with Helm. The first Apply takes it over in place — same names, ports and data${extra ? `; ${extra}` : ''}. Choose the version that runs now (preselected) to change nothing else.`

// ── Nginx Ingress ────────────────────────────────────────────────────────────
const ingress = {
    label: 'Nginx Ingress', ns: 'ingress-nginx', detect: 'deploy/ingress-nginx-controller', tier: 'pro',
    summary: 'HTTP/HTTPS routing for Ingress resources. Note: the ingress-nginx project was retired upstream in March 2026 — 1.15 is its last release.',
    versions: [
        { id: '4.15.1', app: '1.15.1', charts: { 'ingress-nginx': '4.15.1' } },
        { id: '4.14.5', app: '1.14.5', charts: { 'ingress-nginx': '4.14.5' } },
        { id: '4.13.9', app: '1.13.9', charts: { 'ingress-nginx': '4.13.9' } },
        { id: '4.12.8', app: '1.12.8', charts: { 'ingress-nginx': '4.12.8' } },
        { id: '4.11.8', app: '1.11.8', charts: { 'ingress-nginx': '4.11.8' } },
        { id: '4.7.5', app: '1.8.5', charts: { 'ingress-nginx': '4.7.5' } }
    ],
    probe: 'deploy/ingress-nginx-controller',
    takeover: { detect: 'deploy/ingress-nginx-controller', note: takeoverNote() },
    fields: [
        { key: 'serviceType', type: 'select', label: 'Service type', default: 'keep', options: [['keep', 'Keep as it is (new installs: NodePort)'], ['NodePort', 'NodePort — on every node\'s IP'], ['LoadBalancer', 'LoadBalancer — an IP from MetalLB']] },
        { key: 'httpNodePort', type: 'number', label: 'HTTP node port', default: 0, min: 0, max: 32767, help: '0 = keep the current port (a new install gets one from Kubernetes). Otherwise 30000–32767.' },
        { key: 'httpsNodePort', type: 'number', label: 'HTTPS node port', default: 0, min: 0, max: 32767 },
        { key: 'replicas', type: 'number', label: 'Controller replicas', default: 1, min: 1, max: 5 },
        { key: 'defaultClass', type: 'bool', label: 'Default IngressClass', default: false, help: 'Ingresses without ingressClassName use nginx.' },
        { key: 'admissionWebhook', type: 'bool', label: 'Check Ingress objects before they are saved', default: true }
    ],
    validate: (s) => {
        const out = {
            serviceType: oneOf(s.serviceType || 'keep', ['keep', 'NodePort', 'LoadBalancer'], 'Service type'),
            httpNodePort: nodePort(s.httpNodePort, 'HTTP node port'), httpsNodePort: nodePort(s.httpsNodePort, 'HTTPS node port'),
            replicas: int(s.replicas, { min: 1, max: 5, label: 'Replicas' }),
            defaultClass: boolOr(s.defaultClass, false), admissionWebhook: boolOr(s.admissionWebhook, true)
        }
        if (out.httpNodePort && out.httpNodePort === out.httpsNodePort) throw bad('HTTP and HTTPS need different node ports')
        return out
    },
    releases: (s, ctx, v) => [{
        name: 'ingress-nginx', repo: REPOS['ingress-nginx'], chart: 'ingress-nginx', version: v.charts['ingress-nginx'],
        values: {
            controller: {
                replicaCount: s.replicas,
                ingressClassResource: { default: s.defaultClass },
                admissionWebhooks: { enabled: s.admissionWebhook },
                service: {
                    ...(s.serviceType !== 'keep' ? { type: s.serviceType } : {}),
                    ...(s.httpNodePort || s.httpsNodePort ? { nodePorts: { ...(s.httpNodePort ? { http: s.httpNodePort } : {}), ...(s.httpsNodePort ? { https: s.httpsNodePort } : {}) } } : {})
                }
            }
        }
    }],
    // the Service type and node ports that run now stay (MetalLB may have set LoadBalancer)
    pre: () => [
        `T=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.type}' 2>/dev/null)`,
        `HP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}' 2>/dev/null)`,
        `SP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.ports[?(@.name=="https")].nodePort}' 2>/dev/null)`,
        '{ echo "controller:"; echo "  service:"; echo "    type: ${T:-NodePort}"',
        '  if [ -n "$HP$SP" ]; then echo "    nodePorts:"; [ -n "$HP" ] && echo "      http: $HP"; [ -n "$SP" ] && echo "      https: $SP"; fi',
        '} > "$DIR/ingress-nginx.auto.yaml"',
        '[ -n "$T" ] && log "Keeps Service type ${T}${HP:+, ports $HP/$SP} unless changed in the settings"'
    ].join('\n'),
    uninstallNote: 'Ingress resources stop receiving traffic. Your Ingress objects stay.'
}

// ── cert-manager ─────────────────────────────────────────────────────────────
const cmVersions = [['v1.21.2', '1.21'], ['v1.20.4', '1.20'], ['v1.19.6', '1.19'], ['v1.18.6', '1.18'], ['v1.17.4', '1.17'], ['v1.16.5', '1.16'], ['v1.15.5', '1.15'], ['v1.14.7', '1.14'], ['v1.13.6', '1.13']]
const certManager = {
    label: 'cert-manager', ns: 'cert-manager', detect: 'deploy/cert-manager', tier: 'pro',
    summary: 'Automatic TLS certificates — a self-signed issuer, and Let\'s Encrypt if you add an email.',
    versions: cmVersions.map(([id]) => ({ id, app: id, charts: { 'cert-manager': id } })),
    stepUpgrade: true, probe: 'deploy/cert-manager',
    takeover: { detect: 'deploy/cert-manager', note: takeoverNote('existing certificates and issuers stay') },
    fields: [
        { key: 'selfSigned', type: 'bool', label: 'Self-signed ClusterIssuer "selfsigned-issuer"', default: true },
        { key: 'letsEncryptEmail', type: 'text', label: 'Let\'s Encrypt email (optional)', default: '', placeholder: 'ops@company.com', help: 'Creates ClusterIssuers "letsencrypt-staging" and "letsencrypt-prod" (HTTP-01 through the Ingress class below). Let\'s Encrypt sends expiry warnings there.' },
        { key: 'ingressClass', type: 'text', label: 'Ingress class for HTTP-01', default: 'nginx', help: 'Used only with a Let\'s Encrypt email.' },
        { key: 'replicas', type: 'number', label: 'Controller replicas', default: 1, min: 1, max: 3 },
        { key: 'prometheus', type: 'bool', label: 'Metrics for Prometheus (ServiceMonitor)', default: false, help: 'Needs Prometheus + Grafana.' }
    ],
    validate: (s, ctx) => {
        const le = String(s.letsEncryptEmail || '').trim()
        const cls = String(s.ingressClass || 'nginx')
        if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(cls)) throw bad('Ingress class: lowercase letters, numbers and "-"')
        const prom = boolOr(s.prometheus, false)
        if (prom && !ctx.addons?.monitoring) throw bad('Metrics for Prometheus: install Prometheus + Grafana first')
        return { selfSigned: boolOr(s.selfSigned, true), letsEncryptEmail: le ? email(le, 'Let\'s Encrypt email') : '', ingressClass: cls, replicas: int(s.replicas, { min: 1, max: 3, label: 'Replicas' }), prometheus: prom }
    },
    releases: (s, ctx, v) => {
        const minor = Number(minorOf(v.app).split('.')[1])
        return [{
            name: 'cert-manager', repo: REPOS.jetstack, chart: 'cert-manager', version: v.charts['cert-manager'],
            values: {
                // CRDs managed by the chart and kept on uninstall (certificates survive a reinstall)
                ...(minor >= 15 ? { crds: { enabled: true, keep: true } } : { installCRDs: true }),
                replicaCount: s.replicas,
                prometheus: { enabled: s.prometheus, servicemonitor: { enabled: s.prometheus } }
            }
        }]
    },
    post: (s) => {
        const issuers = []
        if (s.selfSigned) issuers.push({ apiVersion: 'cert-manager.io/v1', kind: 'ClusterIssuer', metadata: { name: 'selfsigned-issuer' }, spec: { selfSigned: {} } })
        if (s.letsEncryptEmail) {
            for (const [name, server] of [['letsencrypt-staging', 'https://acme-staging-v02.api.letsencrypt.org/directory'], ['letsencrypt-prod', 'https://acme-v02.api.letsencrypt.org/directory']]) {
                issuers.push({ apiVersion: 'cert-manager.io/v1', kind: 'ClusterIssuer', metadata: { name },
                    spec: { acme: { email: s.letsEncryptEmail, server, privateKeySecretRef: { name: `${name}-account` }, solvers: [{ http01: { ingress: { ingressClassName: s.ingressClass } } }] } } })
            }
        }
        return { manifests: issuers, script: '' }
    },
    uninstallNote: 'Every Certificate, Issuer and ClusterIssuer in the cluster is removed (existing TLS secrets stay).'
}

// ── Longhorn ─────────────────────────────────────────────────────────────────
const lhVersions = [['1.13.0', 34], ['1.12.1', 25], ['1.11.3', 25], ['1.10.2', 25], ['1.9.2', 25], ['1.8.2', 25], ['1.7.3', 21], ['1.6.4', 21], ['1.5.5', 21]]
const longhorn = {
    label: 'Longhorn Storage', ns: 'longhorn-system', detect: 'ds/longhorn-manager', tier: 'pro', keepsData: true,
    summary: 'Replicated block storage for volumes (becomes the default StorageClass). Upgrades go one version line at a time, as Longhorn requires.',
    versions: lhVersions.map(([id, kube]) => ({ id, app: `v${id}`, charts: { longhorn: id }, kube: [kube, 99] })),
    stepUpgrade: true, probe: 'ds/longhorn-manager',
    takeover: { detect: 'ds/longhorn-manager', note: takeoverNote('volumes are not touched') },
    fields: [
        { key: 'replicaCount', type: 'number', label: 'Copies of each volume', default: 0, min: 0, max: 3, help: '0 = automatic: one per node, at most 3. A copy needs its own node.' },
        { key: 'defaultStorageClass', type: 'bool', label: 'Default StorageClass', default: true, help: 'Volume claims without a storageClassName use Longhorn.' },
        { key: 'dataPath', type: 'text', label: 'Data folder on each node', default: '/var/lib/longhorn/', help: 'Applies to nodes added after the change; existing data stays where it is.' },
        { key: 'uiNodePort', type: 'number', label: 'Web UI node port', default: 30080, min: 30000, max: 32767 }
    ],
    validate: (s, ctx) => {
        const rc = int(s.replicaCount ?? 0, { min: 0, max: 3, label: 'Copies of each volume' })
        const nodes = Math.max(1, ctx.nodeCount || 1)
        if (rc > nodes) throw bad(`Copies of each volume: the cluster has ${nodes} node${nodes > 1 ? 's' : ''} — at most ${nodes}`)
        let path = String(s.dataPath || '/var/lib/longhorn/')
        path = safePath(path.replace(/\/?$/, ''), 'Data folder') + '/'
        return { replicaCount: rc || Math.min(3, nodes), defaultStorageClass: boolOr(s.defaultStorageClass, true), dataPath: path, uiNodePort: nodePort(s.uiNodePort || 30080, 'Web UI node port') }
    },
    releases: (s, ctx, v) => [{
        name: 'longhorn', repo: REPOS.longhorn, chart: 'longhorn', version: v.charts.longhorn,
        rollback: false,   // Longhorn cannot be rolled back to an older version
        values: {
            persistence: { defaultClass: s.defaultStorageClass, defaultClassReplicaCount: s.replicaCount },
            defaultSettings: { defaultDataPath: s.dataPath, defaultReplicaCount: s.replicaCount }
        }
    }],
    // iSCSI / NFS on every node (official installers, they detect the distro).
    // Longhorn 1.12+ no longer ships them; the 1.8.2 ones are generic package installs.
    pre: (s, ctx, v) => [
        `BASE="https://raw.githubusercontent.com/longhorn/longhorn/${Number(v.id.split('.')[1]) >= 8 ? 'v1.8.2' : v.app}/deploy/prerequisite"`,
        // Longhorn cannot work without these — say so now instead of after a 10-minute wait
        'findmnt -no PROPAGATION / 2>/dev/null | grep -q shared || fail LONGHORN_NOT_SUPPORTED "The node\'s / is not a shared mount — Longhorn needs it (normal on servers and VMs; not inside containers or LXC)." "Run Longhorn on regular servers or VMs, or use another StorageClass."',
        '{ lsmod | grep -q "^iscsi_tcp" || modprobe iscsi_tcp 2>/dev/null; } || fail LONGHORN_NOT_SUPPORTED "The kernel has no iscsi_tcp module — Longhorn needs iSCSI." "Use a standard distribution kernel (Ubuntu, Debian, Rocky…) on the nodes, or another StorageClass."',
        // the installers run in longhorn-system, which Helm has not created yet
        'kubectl create namespace longhorn-system --dry-run=client -o yaml | kubectl apply -f - >/dev/null',
        'kubectl apply -f "$BASE/longhorn-iscsi-installation.yaml" >/dev/null 2>&1 && log "iSCSI installer running on every node" || log "⚠ iSCSI installer not applied"',
        'kubectl apply -f "$BASE/longhorn-nfs-installation.yaml" >/dev/null 2>&1 || true',
        'kubectl -n longhorn-system rollout status ds/longhorn-iscsi-installation --timeout=180s >/dev/null 2>&1 || kubectl rollout status ds/longhorn-iscsi-installation --timeout=60s >/dev/null 2>&1 || true'
    ].join('\n'),
    post: (s) => ({
        manifests: [{ apiVersion: 'v1', kind: 'Service', metadata: { name: 'longhorn-frontend-nodeport', namespace: 'longhorn-system' },
            spec: { type: 'NodePort', selector: { app: 'longhorn-ui' }, ports: [{ name: 'http', port: 80, targetPort: 8000, nodePort: s.uiNodePort }] } }],
        script: s.defaultStorageClass ? [
            'for sc in $(kubectl get storageclass -o jsonpath=\'{range .items[*]}{.metadata.name}{"\\n"}{end}\' 2>/dev/null); do',
            '    [ "$sc" != "longhorn" ] && kubectl patch storageclass "$sc" -p \'{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}\' >/dev/null 2>&1 || true',
            'done',
            'log "✓ longhorn is the default StorageClass"'
        ].join('\n') : ''
    }),
    uninstallNote: 'Refused while any volume still uses Longhorn — delete those PVCs first. Longhorn\'s own uninstaller then runs (takes a few minutes).'
}

// ── Argo CD ──────────────────────────────────────────────────────────────────
const argoVersions = [['10.10.2', 'v3.5.4'], ['10.2.2', 'v3.4.6'], ['9.5.11', 'v3.3.9'], ['9.3.7', 'v3.2.6'], ['9.0.6', 'v3.1.9'], ['8.2.7', 'v3.0.12'], ['7.9.1', 'v2.14.11'], ['7.7.23', 'v2.13.4']]
const argocd = {
    label: 'ArgoCD', ns: 'argocd', detect: 'deploy/argocd-server', tier: 'pro',
    summary: 'GitOps: deploys what is in your Git repositories and keeps it in sync. Upgrades go one release line at a time.',
    versions: argoVersions.map(([id, app]) => ({ id, app, charts: { 'argo-cd': id }, kube: [25, 99] })),
    stepUpgrade: true, probe: 'deploy/argocd-server',
    takeover: {
        detect: 'deploy/argocd-server',
        note: takeoverNote('its pods restart once (their labels change). Applications, projects, repositories and the admin password stay; settings made by hand in argocd-cm are replaced by these'),
        // Helm's workloads carry other selector labels (immutable) — recreate them
        migrate: () => 'kubectl -n argocd delete deploy,statefulset --all --wait=true 2>&1 | sed "s/^/  /"'
    },
    fields: [
        { key: 'httpsNodePort', type: 'number', label: 'Web UI node port (https)', default: 30443, min: 30000, max: 32767 },
        { key: 'dex', type: 'bool', label: 'Dex (single sign-on with GitHub, Google, LDAP…)', default: true },
        { key: 'notifications', type: 'bool', label: 'Notifications controller', default: true },
        { key: 'repoReplicas', type: 'number', label: 'Repo server replicas', default: 1, min: 1, max: 5 },
        { key: 'statusBadge', type: 'bool', label: 'Status badges for applications', default: false }
    ],
    validate: (s) => ({
        httpsNodePort: nodePort(s.httpsNodePort || 30443, 'Web UI node port'), dex: boolOr(s.dex, true), notifications: boolOr(s.notifications, true),
        repoReplicas: int(s.repoReplicas ?? 1, { min: 1, max: 5, label: 'Repo server replicas' }), statusBadge: boolOr(s.statusBadge, false)
    }),
    releases: (s, ctx, v) => [{
        name: 'argocd', repo: REPOS.argo, chart: 'argo-cd', version: v.charts['argo-cd'],
        values: {
            fullnameOverride: 'argocd',
            server: { service: { type: 'NodePort', nodePortHttps: s.httpsNodePort, nodePortHttp: 0 } },   // 0 = Kubernetes picks (30080 is Longhorn's UI)
            dex: { enabled: s.dex },
            notifications: { enabled: s.notifications },
            repoServer: { replicas: s.repoReplicas },
            configs: { cm: { 'statusbadge.enabled': s.statusBadge } }
        }
    }],
    // an Argo CD installed before keeps its admin password and server key
    pre: () => [
        'if kubectl -n argocd get secret argocd-secret >/dev/null 2>&1 && [ -z "$(kubectl -n argocd get secret argocd-secret -o jsonpath=\'{.metadata.labels.app\\.kubernetes\\.io/managed-by}\' 2>/dev/null)" ]; then',
        '    printf "configs:\\n  secret:\\n    createSecret: false\\n" > "$DIR/argocd.auto.yaml"',
        '    log "Keeps the existing admin password and server key"',
        'fi'
    ].join('\n'),
    locked: { argocd: ['fullnameOverride'] },
    uninstallNote: 'ArgoCD and its Applications are removed. Apps it already deployed keep running.'
}

// ── Velero (volume backups) ──────────────────────────────────────────────────
const veleroVersions = [['12.2.1', '1.18.2', 'v1.14.4'], ['11.4.0', '1.17.1', 'v1.13.1']]
const velero = {
    label: 'Velero (Volume Backups)', ns: 'velero', detect: 'deploy/velero', tier: 'pro', needsSettings: true,
    summary: 'Backs up the files inside volumes together with the namespace\'s objects. Where backups go is set under Backups → Volume Backups.',
    versions: veleroVersions.map(([id, app, plugin]) => ({ id, app, plugin, charts: { velero: id } })),
    probe: 'deploy/velero', prepare: 'velero',
    takeover: {
        detect: 'deploy/velero',
        note: takeoverNote('Velero restarts once; backups, schedules and the storage settings stay'),
        migrate: () => 'kubectl -n velero delete deploy/velero ds/node-agent --ignore-not-found --wait=true 2>&1 | sed "s/^/  /"'
    },
    fields: [
        { key: 'fsBackupDefault', type: 'bool', label: 'Back up the files of every volume by default', default: true, help: 'Off: only volumes whose pod has the annotation backup.velero.io/backup-volumes.' },
        { key: 'logLevel', type: 'select', label: 'Log level', default: 'info', options: [['info', 'info'], ['debug', 'debug'], ['warning', 'warning']] }
    ],
    validate: (s, ctx) => {
        if (!ctx.velero?.bucket) throw bad('Volume backups have no storage settings yet — set them up under Backups → Volume Backups')
        return { fsBackupDefault: boolOr(s.fsBackupDefault, true), logLevel: oneOf(s.logLevel || 'info', ['info', 'debug', 'warning'], 'Log level') }
    },
    releases: (s, ctx, v) => {
        const c = ctx.velero
        const config = { region: c.region || 'us-east-1' }
        if (c.provider && c.provider !== 'aws') Object.assign(config, { s3ForcePathStyle: 'true', s3Url: c.endpoint })
        if (c.insecureTls) config.insecureSkipTLSVerify = 'true'
        return [{
            name: 'velero', repo: REPOS['vmware-tanzu'], chart: 'velero', version: v.charts.velero,
            values: {
                initContainers: [{ name: 'velero-plugin-for-aws', image: `velero/velero-plugin-for-aws:${v.plugin}`, imagePullPolicy: 'IfNotPresent', volumeMounts: [{ mountPath: '/target', name: 'plugins' }] }],
                configuration: {
                    backupStorageLocation: [{ name: 'default', provider: 'aws', bucket: c.bucket, prefix: c.prefix || '', default: true, credential: { name: 'cloud-credentials', key: 'cloud' }, config }],
                    volumeSnapshotLocation: [],
                    defaultVolumesToFsBackup: s.fsBackupDefault,
                    uploaderType: 'kopia',
                    logLevel: s.logLevel
                },
                credentials: { useSecret: true, existingSecret: 'cloud-credentials' },
                snapshotsEnabled: false,
                deployNodeAgent: true
            }
        }]
    },
    // the keys KubeEZ handed over (/etc/kubeez/velero.env) → the cluster Secret
    pre: () => [
        'CFG=${KUBEEZ_ROOT:-}/etc/kubeez/velero.env',
        '[ -f "$CFG" ] || fail NOT_CONFIGURED "Volume backups have no storage settings on this node." "Save the settings again under Backups → Volume Backups."',
        'while IFS= read -r line; do k="${line%%=*}"; v="${line#*=}"; case "$k" in VB_ACCESS|VB_SECRET) printf -v "$k" "%s" "$(printf "%s" "$v" | base64 -d 2>/dev/null)" ;; esac; done < "$CFG"',
        'rm -f "$CFG"',
        '[ -n "${VB_ACCESS:-}" ] && [ -n "${VB_SECRET:-}" ] || fail NOT_CONFIGURED "The volume backup keys are missing." "Save the settings again under Backups → Volume Backups."',
        'kubectl create namespace velero --dry-run=client -o yaml | kubectl apply -f - >/dev/null',
        'printf "[default]\\naws_access_key_id=%s\\naws_secret_access_key=%s\\n" "$VB_ACCESS" "$VB_SECRET" | kubectl -n velero create secret generic cloud-credentials --from-file=cloud=/dev/stdin --dry-run=client -o yaml | kubectl apply -f - >/dev/null',
        'unset VB_ACCESS VB_SECRET',
        'log "✓ Storage keys stored in Secret velero/cloud-credentials"'
    ].join('\n'),
    post: (s, ctx, v) => ({
        manifests: [],
        script: [
            // the CLI on the control-plane — KubeEZ drives backups and restores with it
            `VV="v${v.app}"`,
            'if ! velero version --client-only 2>/dev/null | grep -q "$VV"; then',
            '    A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64; T=$(mktemp -d)',
            '    if curl -fsSL --retry 3 -m 300 "https://github.com/velero-io/velero/releases/download/${VV}/velero-${VV}-linux-${A}.tar.gz" -o "$T/v.tgz" && tar xzf "$T/v.tgz" -C "$T" && install -m0755 "$T/velero-${VV}-linux-${A}/velero" /usr/local/bin/velero; then log "✓ Velero CLI ${VV}"; else log "⚠ Could not download the Velero CLI — backups from KubeEZ need it; Repair to retry"; fi',
            '    rm -rf "$T"',
            'fi',
            'kubectl -n velero rollout restart deploy/velero >/dev/null 2>&1   # pick up changed keys',
            'kubectl -n velero rollout status deploy/velero --timeout=300s >/dev/null 2>&1 || log "⚠ Velero is still restarting"',
            'PHASE=""; for _ in $(seq 1 36); do PHASE=$(kubectl -n velero get backupstoragelocation default -o jsonpath=\'{.status.phase}\' 2>/dev/null); [ "$PHASE" = "Available" ] && break; sleep 5; done',
            'if [ "$PHASE" != "Available" ]; then',
            '    MSG=$(kubectl -n velero get backupstoragelocation default -o jsonpath=\'{.status.message}\' 2>/dev/null)',
            '    fail STORAGE_UNAVAILABLE "Velero is running but cannot use the storage: ${MSG:-no answer}" "Check endpoint, bucket and keys under Backups → Volume Backups (the bucket must exist; the nodes must reach the endpoint), save, then Repair."',
            'fi',
            'log "✓ Backup storage available"'
        ].join('\n')
    }),
    locked: { velero: ['configuration.backupStorageLocation', 'credentials', 'deployNodeAgent', 'snapshotsEnabled'] },
    uninstallNote: 'Volume backups stop. Backups already in the storage bucket are kept — set it up again under Backups to see them.'
}

// ── Prometheus + Grafana (kube-prometheus-stack) ─────────────────────────────
const KUBEEZ_DASHBOARD = {
    annotations: { list: [] }, editable: true, graphTooltip: 0, links: [],
    panels: [
        { title: 'Cluster CPU Usage', type: 'timeseries', gridPos: { h: 8, w: 12, x: 0, y: 0 }, targets: [{ expr: "sum(rate(node_cpu_seconds_total{mode!='idle'}[1m])) by (instance)", legendFormat: '{{instance}}', refId: 'A' }] },
        { title: 'Cluster Memory Usage', type: 'timeseries', gridPos: { h: 8, w: 12, x: 12, y: 0 }, targets: [{ expr: 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes', legendFormat: '{{instance}}', refId: 'A' }] },
        { title: 'Active Pods', type: 'stat', gridPos: { h: 4, w: 24, x: 0, y: 8 }, targets: [{ expr: 'sum(kube_pod_info)', legendFormat: 'Pods', refId: 'A' }] }
    ],
    refresh: '30s', schemaVersion: 30, tags: ['kubeez'], templating: { list: [] }, time: { from: 'now-1h', to: 'now' }, title: 'KubeEZ Cluster Overview', uid: 'kubeez-overview', version: 1
}
const monitoring = {
    label: 'Prometheus + Grafana', ns: 'monitoring', detect: 'deploy/grafana', tier: 'pro',
    summary: 'Metrics, alerts and dashboards (kube-prometheus-stack): Prometheus, Grafana with ready dashboards, node and Kubernetes metrics, optional Alertmanager.',
    versions: [{ id: '92.3.0', app: 'v0.94.1', charts: { monitoring: '92.3.0' }, kube: [25, 99] }, { id: '90.2.0', app: 'v0.93.1', charts: { monitoring: '90.2.0' }, kube: [25, 99] }],
    takeover: {
        detect: 'deploy/prometheus-operator',
        note: 'Installed before KubeEZ managed add-ons with Helm. The first Apply replaces it with the standard kube-prometheus-stack: Grafana and Prometheus stay on the same ports, ServiceMonitors in your namespaces keep working; the metrics collected so far and dashboards created by hand in the old Grafana are not carried over. Grafana gets its own password (shown in Access & logins).',
        migrate: () => [
            'log "Removing the previous Prometheus / Grafana installation (CRDs and your ServiceMonitors stay)..."',
            'kubectl -n monitoring delete prometheus.monitoring.coreos.com main --ignore-not-found --wait=true >/dev/null 2>&1',
            'kubectl -n monitoring delete servicemonitors.monitoring.coreos.com node-exporter kube-state-metrics --ignore-not-found >/dev/null 2>&1',
            'kubectl -n monitoring delete deploy grafana prometheus-operator kube-state-metrics --ignore-not-found --wait=true >/dev/null 2>&1',
            'kubectl -n monitoring delete ds node-exporter --ignore-not-found --wait=true >/dev/null 2>&1',
            'kubectl -n monitoring delete svc grafana prometheus-nodeport node-exporter kube-state-metrics prometheus-operator --ignore-not-found >/dev/null 2>&1',
            'kubectl -n monitoring delete cm grafana-config grafana-dashboards --ignore-not-found >/dev/null 2>&1',
            'kubectl -n monitoring delete sa prometheus prometheus-operator kube-state-metrics --ignore-not-found >/dev/null 2>&1',
            'kubectl delete clusterrole,clusterrolebinding prometheus prometheus-operator kube-state-metrics --ignore-not-found >/dev/null 2>&1',
            'log "✓ Previous installation removed"'
        ].join('\n')
    },
    fields: [
        { key: 'retentionDays', type: 'number', label: 'Keep metrics for', unit: 'days', default: 10, min: 1, max: 365 },
        { key: 'storage', type: 'select', label: 'Where metrics are stored', default: 'auto', options: [['auto', 'Longhorn if installed, else the node'], ['longhorn', 'Longhorn volume'], ['default', 'The cluster\'s default StorageClass'], ['node', 'Pod storage only (lost when Prometheus restarts)']] },
        { key: 'sizeGi', type: 'number', label: 'Disk for metrics', unit: 'GiB', default: 20, min: 1, max: 2000 },
        { key: 'alertmanager', type: 'bool', label: 'Alertmanager (send Prometheus alerts by email, Slack…)', default: false },
        { key: 'grafanaNodePort', type: 'number', label: 'Grafana node port', default: 30000, min: 30000, max: 32767 },
        { key: 'prometheusNodePort', type: 'number', label: 'Prometheus node port', default: 30090, min: 30000, max: 32767 },
        { key: 'controlPlaneMetrics', type: 'bool', label: 'Scrape etcd, scheduler and controller-manager', default: false, help: 'kubeadm binds them to localhost — enable only if you changed that, otherwise their targets show as down.' }
    ],
    validate: (s, ctx) => {
        let storage = oneOf(s.storage || 'auto', ['auto', 'longhorn', 'default', 'node'], 'Storage')
        if (storage === 'auto') storage = ctx.addons?.longhorn ? 'longhorn' : 'node'
        if (storage === 'longhorn' && !ctx.addons?.longhorn) throw bad('Storage: Longhorn is not installed on this cluster — install it first or choose another option')
        const g = nodePort(s.grafanaNodePort || 30000, 'Grafana node port'), p = nodePort(s.prometheusNodePort || 30090, 'Prometheus node port')
        if (g === p) throw bad('Grafana and Prometheus need different node ports')
        return { retentionDays: int(s.retentionDays, { min: 1, max: 365, label: 'Keep metrics for (days)' }), storage, sizeGi: gi(s.sizeGi, 'Disk for metrics (GiB)'),
            alertmanager: boolOr(s.alertmanager, false), grafanaNodePort: g, prometheusNodePort: p, controlPlaneMetrics: boolOr(s.controlPlaneMetrics, false) }
    },
    releases: (s, ctx, v) => [{
        name: 'monitoring', repo: REPOS['prometheus-community'], chart: 'kube-prometheus-stack', version: v.charts.monitoring, crds: true,
        values: {
            fullnameOverride: 'kubeez',
            alertmanager: { enabled: s.alertmanager },
            kubeEtcd: { enabled: s.controlPlaneMetrics }, kubeControllerManager: { enabled: s.controlPlaneMetrics }, kubeScheduler: { enabled: s.controlPlaneMetrics },
            grafana: {
                fullnameOverride: 'grafana',
                service: { type: 'NodePort', nodePort: s.grafanaNodePort },
                admin: { existingSecret: 'grafana-admin', userKey: 'admin-user', passwordKey: 'admin-password' },
                sidecar: { dashboards: { enabled: true }, datasources: { enabled: true } }
            },
            prometheus: {
                service: { type: 'NodePort', nodePort: s.prometheusNodePort },
                prometheusSpec: {
                    retention: `${s.retentionDays}d`,
                    // every ServiceMonitor / PodMonitor / rule in the cluster, like before
                    serviceMonitorSelectorNilUsesHelmValues: false, podMonitorSelectorNilUsesHelmValues: false,
                    ruleSelectorNilUsesHelmValues: false, probeSelectorNilUsesHelmValues: false,
                    resources: { requests: { cpu: '200m', memory: '512Mi' }, limits: { memory: '2Gi' } },
                    ...(s.storage === 'node' ? {} : { storageSpec: { volumeClaimTemplate: { spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: `${s.sizeGi}Gi` } }, ...(s.storage === 'longhorn' ? { storageClassName: 'longhorn' } : {}) } } } })
                }
            }
        }
    }],
    // Grafana's admin login: generated once, kept in a Secret
    pre: () => [
        // node-exporter mounts the node's "/" with HostToContainer propagation,
        // which needs "/" to be a shared mount (normal servers). Where it is
        // private (LXC, nested containers) the pod could never start.
        'if [ "$(findmnt -no PROPAGATION / 2>/dev/null)" = "private" ]; then',
        '    printf "prometheus-node-exporter:\\n  hostRootFsMount:\\n    mountPropagation: None\\n" > "$DIR/monitoring.auto.yaml"',
        '    log "The node\'s / is a private mount — node-exporter reads it without mount propagation"',
        'fi',
        'kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null',
        'if ! kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1; then',
        '    PW="$(openssl rand -base64 24 | tr -d \'/+=\\n\' | cut -c1-20)"',
        '    kubectl -n monitoring create secret generic grafana-admin --from-literal=admin-user=admin --from-literal=admin-password="$PW" >/dev/null && log "Generated the Grafana login (user admin — password in Access & logins)"',
        'fi'
    ].join('\n'),
    post: () => ({
        manifests: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kubeez-overview-dashboard', namespace: 'monitoring', labels: { grafana_dashboard: '1' } }, data: { 'kubeez-overview.json': JSON.stringify(KUBEEZ_DASHBOARD) } }],
        script: [
            'if kubectl -n logging get svc loki >/dev/null 2>&1; then',
            `    echo '${JSON.stringify(LOKI_DATASOURCE_CM)}' | kubectl apply -f - >/dev/null && log "✓ Loki logs added to Grafana"`,
            'fi'
        ].join('\n')
    }),
    locked: { monitoring: ['fullnameOverride', 'grafana.fullnameOverride', 'grafana.admin'] },
    uninstallNote: 'Prometheus data and the Grafana dashboards are deleted.'
}

// ── Kubernetes Dashboard (KubeEZ chart — the upstream project is archived) ──
const dashboard = {
    label: 'Kubernetes Dashboard', ns: 'kubernetes-dashboard', detect: 'deploy/kubernetes-dashboard', tier: 'free',
    summary: 'The official web UI (v2.7) with a 24-hour login token in KubeEZ. The upstream project is archived — the KubeEZ Explorer is the maintained alternative.',
    versions: [{ id: '2.7.0', app: 'v2.7.0', charts: { 'kubernetes-dashboard': '2.7.0' } }],
    takeover: { detect: 'deploy/kubernetes-dashboard', note: takeoverNote() },
    fields: [
        { key: 'nodePort', type: 'number', label: 'Node port (https)', default: 30643, min: 30000, max: 32767 },
        { key: 'replicas', type: 'number', label: 'Replicas', default: 1, min: 1, max: 3 },
        { key: 'adminAccount', type: 'bool', label: 'Admin login (full access)', default: true },
        { key: 'viewerAccount', type: 'bool', label: 'Read-only login', default: true },
        { key: 'sessionMinutes', type: 'number', label: 'Log out after inactivity', unit: 'minutes', default: 15, min: 1, max: 1440 },
        { key: 'metricsScraper', type: 'bool', label: 'CPU / memory graphs (needs Metrics Server)', default: true }
    ],
    validate: (s) => ({
        nodePort: nodePort(s.nodePort || 30643, 'Node port'), replicas: int(s.replicas ?? 1, { min: 1, max: 3, label: 'Replicas' }),
        adminAccount: boolOr(s.adminAccount, true), viewerAccount: boolOr(s.viewerAccount, true),
        sessionMinutes: int(s.sessionMinutes ?? 15, { min: 1, max: 1440, label: 'Log out after (minutes)' }), metricsScraper: boolOr(s.metricsScraper, true)
    }),
    releases: (s) => [{
        name: 'kubernetes-dashboard', local: 'kubeez-dashboard', chart: 'kubeez-dashboard', version: '2.7.0',
        values: {
            replicas: s.replicas, service: { type: 'NodePort', nodePort: s.nodePort },
            adminAccount: s.adminAccount, viewerAccount: s.viewerAccount,
            extraArgs: s.sessionMinutes === 15 ? [] : [`--token-ttl=${s.sessionMinutes * 60}`],
            metricsScraper: { enabled: s.metricsScraper }
        }
    }],
    uninstallNote: 'The dashboard and its login accounts are removed.'
}

// ── S3 Object Storage (SeaweedFS, KubeEZ chart) ──────────────────────────────
const seaweedfs = {
    label: 'S3 Object Storage (SeaweedFS)', ns: 'seaweedfs', detect: 'deploy/seaweedfs', tier: 'pro', keepsData: true,
    summary: 'S3-compatible storage with a ready "backups" bucket and a web admin UI — for your apps and as the offsite backup target of OTHER clusters.',
    versions: [{ id: '1.0.0', app: '4.48', charts: { seaweedfs: '1.0.0' } }],
    takeover: { detect: 'deploy/seaweedfs', note: takeoverNote('keys and buckets stay') },
    fields: [
        { key: 'imageTag', type: 'text', label: 'SeaweedFS version (image tag)', default: '4.48', help: 'chrislusf/seaweedfs:<tag> — newer tags upgrade in place.' },
        { key: 'sizeGi', type: 'number', label: 'Disk size', unit: 'GiB', default: 20, min: 1, max: 10000, help: 'Volumes can grow, not shrink.' },
        { key: 'storage', type: 'select', label: 'Where data is stored (new installs)', default: 'auto', options: [['auto', 'Default StorageClass if there is one, else a node folder'], ['pvc', 'Default StorageClass (e.g. Longhorn)'], ['hostPath', 'A folder on one node']], help: 'An existing install keeps its storage — data is never moved.' },
        { key: 's3NodePort', type: 'number', label: 'S3 node port', default: 30833, min: 30000, max: 32767 },
        { key: 'adminUi', type: 'bool', label: 'Web admin UI (login required)', default: true },
        { key: 'adminNodePort', type: 'number', label: 'Web UI node port', default: 30834, min: 30000, max: 32767 },
        { key: 'volumeSizeLimitMB', type: 'number', label: 'Size of one volume file', unit: 'MB', default: 1024, min: 100, max: 30000 }
    ],
    validate: (s) => {
        const tag = String(s.imageTag || '4.48')
        if (!/^[0-9][0-9A-Za-z._-]{0,30}$/.test(tag)) throw bad('SeaweedFS version: a tag like 4.48')
        const out = { imageTag: tag, sizeGi: gi(s.sizeGi, 'Disk size (GiB)', 10000), storage: oneOf(s.storage || 'auto', ['auto', 'pvc', 'hostPath'], 'Storage'),
            s3NodePort: nodePort(s.s3NodePort || 30833, 'S3 node port'), adminUi: boolOr(s.adminUi, true), adminNodePort: nodePort(s.adminNodePort || 30834, 'Web UI node port'),
            volumeSizeLimitMB: int(s.volumeSizeLimitMB ?? 1024, { min: 100, max: 30000, label: 'Size of one volume file (MB)' }) }
        if (out.adminUi && out.s3NodePort === out.adminNodePort) throw bad('S3 and the web UI need different node ports')
        return out
    },
    releases: (s) => [{
        name: 'seaweedfs', local: 'kubeez-seaweedfs', chart: 'kubeez-seaweedfs', version: '1.0.0', rollback: false,
        values: {
            image: `chrislusf/seaweedfs:${s.imageTag}`,
            storage: { size: `${s.sizeGi}Gi` },
            s3: { nodePort: s.s3NodePort }, admin: { enabled: s.adminUi, nodePort: s.adminNodePort },
            volumeSizeLimitMB: s.volumeSizeLimitMB
        }
    }],
    // keys (created once, never replaced) and where the data lives (never moved)
    pre: (s) => [
        'NS=seaweedfs',
        'kubectl create namespace $NS --dry-run=client -o yaml | kubectl apply -f - >/dev/null',
        'if ! kubectl -n $NS get secret seaweedfs-s3 >/dev/null 2>&1; then',
        '    ACCESS="KZ$(openssl rand -hex 9 | tr \'a-f\' \'A-F\')"; SECRET="$(openssl rand -base64 48 | tr -d \'/+=\\n\' | cut -c1-40)"',
        '    S3JSON=$(printf \'{"identities":[{"name":"kubeez","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\' "$ACCESS" "$SECRET")',
        '    kubectl -n $NS create secret generic seaweedfs-s3 --from-literal=accessKey="$ACCESS" --from-literal=secretKey="$SECRET" --from-literal=s3.json="$S3JSON" >/dev/null',
        '    log "Generated new S3 credentials (Secret $NS/seaweedfs-s3)"',
        'fi',
        'if [ -z "$(kubectl -n $NS get secret seaweedfs-s3 -o jsonpath=\'{.data.adminPassword}\' 2>/dev/null)" ]; then',
        '    ADMIN_PW="$(openssl rand -base64 24 | tr -d \'/+=\\n\' | cut -c1-20)"',
        '    kubectl -n $NS patch secret seaweedfs-s3 --type=merge -p "{\\"stringData\\":{\\"adminUser\\":\\"admin\\",\\"adminPassword\\":\\"$ADMIN_PW\\"}}" >/dev/null',
        'fi',
        'AUTO="$DIR/seaweedfs.auto.yaml"',
        'if kubectl -n $NS get pvc seaweedfs-data >/dev/null 2>&1; then',
        '    SC=$(kubectl -n $NS get pvc seaweedfs-data -o jsonpath=\'{.spec.storageClassName}\')',
        '    CUR=$(kubectl -n $NS get pvc seaweedfs-data -o jsonpath=\'{.spec.resources.requests.storage}\')',
        `    WANT=${s.sizeGi}`,
        '    CURGI=$(echo "$CUR" | sed -n \'s/^\\([0-9]*\\)Gi$/\\1/p\')',
        '    [ -n "$CURGI" ] && [ "$WANT" -lt "$CURGI" ] && fail CANNOT_SHRINK "The data volume is ${CUR}; volumes can grow but not shrink." "Set the disk size to ${CURGI} GiB or more."',
        '    printf "storage:\\n  mode: pvc\\n  storageClass: \\"%s\\"\\n" "$SC" > "$AUTO"',
        '    log "Keeps its volume (StorageClass ${SC:-default}, ${CUR})"',
        'elif kubectl -n $NS get deploy seaweedfs >/dev/null 2>&1; then',
        '    PIN=$(kubectl -n $NS get deploy seaweedfs -o jsonpath=\'{.spec.template.spec.nodeSelector.kubernetes\\.io/hostname}\' 2>/dev/null)',
        '    [ -z "$PIN" ] && PIN=$(kubectl -n $NS get pods -l app=seaweedfs -o jsonpath=\'{.items[0].spec.nodeName}\' 2>/dev/null)',
        '    printf "storage:\\n  mode: hostPath\\n  nodeName: \\"%s\\"\\n" "$PIN" > "$AUTO"',
        '    log "Keeps its data folder on node ${PIN}"',
        'else',
        '    DEFAULT_SC=$(kubectl get storageclass -o jsonpath=\'{range .items[?(@.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class=="true")]}{.metadata.name}{"\\n"}{end}\' 2>/dev/null | head -1)',
        `    MODE=${s.storage}`,
        '    [ "$MODE" = auto ] && { [ -n "$DEFAULT_SC" ] && MODE=pvc || MODE=hostPath; }',
        '    [ "$MODE" = pvc ] && [ -z "$DEFAULT_SC" ] && fail NO_STORAGECLASS "There is no default StorageClass for the data volume." "Install Longhorn first, or choose \\"A folder on one node\\"."',
        '    if [ "$MODE" = pvc ]; then printf "storage:\\n  mode: pvc\\n" > "$AUTO"; log "Data on StorageClass $DEFAULT_SC"',
        '    else',
        '        PIN=$(kubectl get nodes -l \'!node-role.kubernetes.io/control-plane\' -o jsonpath=\'{.items[0].metadata.name}\' 2>/dev/null)',
        '        [ -z "$PIN" ] && PIN=$(kubectl get nodes -o jsonpath=\'{.items[0].metadata.name}\')',
        '        printf "storage:\\n  mode: hostPath\\n  nodeName: \\"%s\\"\\n" "$PIN" > "$AUTO"; log "Data in /var/lib/kubeez-seaweedfs on node $PIN (install Longhorn for replicated storage)"',
        '    fi',
        'fi'
    ].join('\n'),
    post: () => ({
        manifests: [],
        script: [
            'for _ in $(seq 1 6); do',
            '    kubectl -n seaweedfs exec deploy/seaweedfs -c seaweedfs -- sh -c \'echo "s3.bucket.list" | weed shell 2>/dev/null\' | grep -qw backups && break',
            '    kubectl -n seaweedfs exec deploy/seaweedfs -c seaweedfs -- sh -c \'echo "s3.bucket.create -name backups" | weed shell\' 2>&1 | grep -qiE "created|exist" && { log "✓ Bucket \\"backups\\" created"; break; }',
            '    sleep 10',
            'done'
        ].join('\n')
    }),
    locked: { seaweedfs: ['credentialsSecret'] },
    uninstallNote: 'Every bucket and object is deleted (data stored directly on a node folder is kept there).'
}

// ── KubeEZ Explorer (Radar by Skyhook) ───────────────────────────────────────
const EXPLORER_RBAC = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeez-explorer-cluster-read
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
rules:
  - apiGroups: [""]
    resources: ["nodes", "namespaces", "persistentvolumes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses", "csidrivers", "csinodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apiextensions.k8s.io"]
    resources: ["customresourcedefinitions"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingressclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["nodes", "pods"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-admins
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: Group, name: "kubeez:admins", apiGroup: rbac.authorization.k8s.io }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-operators
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: edit }
subjects: [{ kind: Group, name: "kubeez:operators", apiGroup: rbac.authorization.k8s.io }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-viewers
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: Group, name: "kubeez:viewers", apiGroup: rbac.authorization.k8s.io }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-cluster-read
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kubeez-explorer-cluster-read }
subjects:
  - { kind: Group, name: "kubeez:operators", apiGroup: rbac.authorization.k8s.io }
  - { kind: Group, name: "kubeez:viewers", apiGroup: rbac.authorization.k8s.io }
---
# Helm installs from the Explorer: Radar opens its Helm-write gate only if its
# service account may create Secrets; installs then run AS THE SIGNED-IN USER
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeez-explorer-helm-gate
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-helm-gate
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kubeez-explorer-helm-gate }
subjects: [{ kind: ServiceAccount, name: kubeez-explorer, namespace: kubeez-explorer }]`
const explorer = {
    label: 'KubeEZ Explorer', ns: 'kubeez-explorer', detect: 'deploy/kubeez-explorer deploy/radar', tier: 'pro',
    summary: 'A full Kubernetes UI inside KubeEZ (Radar by Skyhook): resources, logs, topology, timeline, Helm, audit — with your KubeEZ login, no open ports.',
    versions: [{ id: '1.16.0', app: '1.16.0', charts: { 'kubeez-explorer': '1.16.0' } }, { id: '1.15.0', app: '1.15.0', charts: { 'kubeez-explorer': '1.15.0' } }],
    fields: [
        { key: 'memoryMi', type: 'number', label: 'Memory limit', unit: 'MiB', default: 768, min: 256, max: 8192, help: 'Raise it for clusters with thousands of objects.' },
        { key: 'cpu', type: 'select', label: 'CPU limit', default: '1', options: [['1', '1 core'], ['2', '2 cores'], ['500m', '0.5 core']] }
    ],
    validate: (s, ctx) => {
        if (!/^[A-Za-z0-9-]+$/.test(String(ctx.clusterId || ''))) throw bad('The Explorer is installed on a saved cluster (its address includes the cluster)')
        return { memoryMi: int(s.memoryMi ?? 768, { min: 256, max: 8192, label: 'Memory limit (MiB)' }), cpu: oneOf(String(s.cpu || '1'), ['1', '2', '500m'], 'CPU limit') }
    },
    releases: (s, ctx, v) => [{
        name: 'kubeez-explorer', repo: REPOS.skyhook, chart: 'radar', version: v.charts['kubeez-explorer'],
        values: {
            fullnameOverride: 'kubeez-explorer',
            basePath: `/api/clusters/${ctx.clusterId}/explorer`,
            service: { type: 'ClusterIP', port: 9280 },
            auth: { mode: 'proxy' },
            mcp: { enabled: false }, usageReporting: { enabled: false },
            resources: { requests: { cpu: '100m', memory: '192Mi' }, limits: { cpu: s.cpu, memory: `${s.memoryMi}Mi` } }
        }
    }],
    // installs from before the rename used release "radar"
    pre: () => 'if helm -n kubeez-explorer status radar >/dev/null 2>&1; then log "Moving the Explorer to its new resource names..."; helm -n kubeez-explorer uninstall radar --wait --timeout 3m >/dev/null 2>&1 || true; fi',
    post: (s, ctx) => ({
        manifests: [EXPLORER_RBAC],
        script: [
            `BP="/api/clusters/${ctx.clusterId}/explorer"`,
            'IP=$(kubectl -n kubeez-explorer get svc kubeez-explorer -o jsonpath=\'{.spec.clusterIP}\' 2>/dev/null); CODE=""',
            // (an imported cluster: KubeEZ is outside the cluster network — asked through the API server)
            'for _ in $(seq 1 24); do if [ -n "${KUBEEZ_IMPORTED:-}" ]; then kubectl get --raw "/api/v1/namespaces/kubeez-explorer/services/http:kubeez-explorer:9280/proxy${BP}/api/health" >/dev/null 2>&1 && CODE=200; else CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 5 "http://$IP:9280${BP}/api/health" 2>/dev/null); fi; [ "$CODE" = "200" ] && break; sleep 5; done',
            '[ "$CODE" = "200" ] || fail NOT_READY "The Explorer runs but does not answer on ${IP}:9280 (HTTP ${CODE:-none})." "Check \'kubectl -n kubeez-explorer logs deploy/kubeez-explorer\', then Repair."',
            'log "✓ Explorer answers — open it from the cluster page (Explorer tab)"'
        ].join('\n')
    }),
    locked: { 'kubeez-explorer': ['fullnameOverride', 'basePath', 'service', 'auth', 'mcp'] },
    uninstallNote: 'The KubeEZ Explorer and its role bindings are removed. Nothing in your workloads changes.'
}

export const CORE_ADDONS = { ingress, monitoring, dashboard, 'cert-manager': certManager, longhorn, argocd, seaweedfs, velero, explorer }
