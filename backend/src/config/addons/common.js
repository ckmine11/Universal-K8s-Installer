import net from 'net'
// Shared pieces of the add-on definitions (config/addons/*.js).
//
// An add-on definition:
//   label, ns, detect, tier ('free'|'pro'), summary, keepsData, needsSettings
//   versions   [{ id, app, charts: { <release>: <chart version> }, kube: [minMinor, maxMinor] }]
//              newest first; the first one the cluster supports is recommended
//   fields     the settings form (bool | number | select | text, showIf, group, help)
//   validate   (form, ctx) → clean settings, or throw bad(reason)
//   releases   (settings, ctx, version) → [{ name, repo | local, chart, version, values,
//              crds (apply the chart's CRDs first), rollback (default true) }]
//   locked     { <release>: ['dot.path', …] } — values KubeEZ needs; advanced YAML cannot change them
//   pre / post (settings, ctx, version) → shell / { manifests, script }
//   takeover   { detect, migrate?, note } — an install made before KubeEZ managed it with Helm:
//              Helm takes the objects over (same names), migrate runs first when needed
//   stepUpgrade  upgrade one release line at a time (the node checks the running version)
//   probe      workload whose image tag is the running version
//   prepare    extra hand-over before install ('velero': the storage keys)
//   example    settings that make the form valid when a field has no usable default
//              (e.g. an address) — used to show the release names and to find new versions
//   appSource  { url, releases(text) } — the app's versions come from this URL instead of
//              the first chart (Elasticsearch: the stack version; the charts follow their newest)
//
// Everything that ends up in a shell line is built from validated values only.

export const bad = (msg) => Object.assign(new Error(msg), { status: 400 })

export const REPOS = {
    'metrics-server': { name: 'kubeez-metrics-server', url: 'https://kubernetes-sigs.github.io/metrics-server/' },
    metallb: { name: 'kubeez-metallb', url: 'https://metallb.github.io/metallb' },
    grafana: { name: 'kubeez-grafana', url: 'https://grafana.github.io/helm-charts' },
    fluent: { name: 'kubeez-fluent', url: 'https://fluent.github.io/helm-charts' },
    'sealed-secrets': { name: 'kubeez-sealed-secrets', url: 'https://bitnami.github.io/sealed-secrets' },
    'external-secrets': { name: 'kubeez-external-secrets', url: 'https://charts.external-secrets.io' },
    kyverno: { name: 'kubeez-kyverno', url: 'https://kyverno.github.io/kyverno/' },
    'ingress-nginx': { name: 'kubeez-ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx' },
    jetstack: { name: 'kubeez-jetstack', url: 'https://charts.jetstack.io' },
    longhorn: { name: 'kubeez-longhorn', url: 'https://charts.longhorn.io' },
    argo: { name: 'kubeez-argo', url: 'https://argoproj.github.io/argo-helm' },
    'vmware-tanzu': { name: 'kubeez-vmware-tanzu', url: 'https://vmware-tanzu.github.io/helm-charts' },
    'prometheus-community': { name: 'kubeez-prometheus-community', url: 'https://prometheus-community.github.io/helm-charts' },
    skyhook: { name: 'kubeez-skyhook', url: 'https://skyhook-io.github.io/helm-charts' },
    ollama: { name: 'kubeez-ollama', url: 'https://otwld.github.io/ollama-helm/' },
    harbor: { name: 'kubeez-harbor', url: 'https://helm.goharbor.io' },
    elastic: { name: 'kubeez-elastic', url: 'https://helm.elastic.co' },
    'nfs-subdir': { name: 'kubeez-nfs-subdir', url: 'https://kubernetes-sigs.github.io/nfs-subdir-external-provisioner/' },
    piraeus: { name: 'kubeez-piraeus', url: 'https://piraeus.io/helm-charts/' },
    fluxcd: { name: 'kubeez-fluxcd', url: 'https://fluxcd-community.github.io/helm-charts' },
    jenkins: { name: 'kubeez-jenkins', url: 'https://charts.jenkins.io' },
    hashicorp: { name: 'kubeez-hashicorp', url: 'https://helm.releases.hashicorp.com' },
    gatekeeper: { name: 'kubeez-gatekeeper', url: 'https://open-policy-agent.github.io/gatekeeper/charts' },
    falcosecurity: { name: 'kubeez-falcosecurity', url: 'https://falcosecurity.github.io/charts' },
    aqua: { name: 'kubeez-aqua', url: 'https://aquasecurity.github.io/helm-charts/' }
}

// Namespaces of the platform itself — policies and admission webhooks never touch them
export const SYSTEM_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx', 'monitoring', 'kubernetes-dashboard',
    'cert-manager', 'longhorn-system', 'argocd', 'seaweedfs', 'velero', 'kubeez-explorer',
    'metrics-server', 'metallb-system', 'logging', 'sealed-secrets', 'kyverno',
    'harbor', 'fluent-bit', 'fluentd', 'elastic-system', 'nfs-provisioner', 'snapshot-controller', 'flux-system',
    'jenkins', 'vault', 'gatekeeper-system', 'falco', 'trivy-system', 'external-secrets']

export const int = (v, { min, max, label }) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label}: a whole number from ${min} to ${max}`)
    return n
}
export const oneOf = (v, list, label) => {
    if (!list.includes(v)) throw bad(`${label}: choose ${list.join(', ')}`)
    return v
}
export const bool = (v) => v === true || v === 'true'
export const boolOr = (v, dflt) => v === undefined || v === null || v === '' ? dflt : bool(v)
// a NodePort in Kubernetes' default range, or 0 = "let Kubernetes choose / keep the current one"
export const nodePort = (v, label) => {
    const n = Number(v || 0)
    if (n === 0) return 0
    return int(n, { min: 30000, max: 32767, label })
}
// "20Gi" style size from a number of GiB
export const gi = (v, label, max = 2000) => int(v, { min: 1, max, label })
// a Kubernetes DNS label (namespace / object name)
export const dnsLabel = (v, label) => {
    const s = String(v || '')
    if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(s)) throw bad(`${label}: lowercase letters, numbers and "-"`)
    return s
}
// an absolute path without anything a shell or YAML could misread
export const safePath = (v, label) => {
    const s = String(v || '')
    if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(s) || s.includes('..')) throw bad(`${label}: an absolute path like /var/lib/data`)
    return s
}
export const email = (v, label) => {
    const s = String(v || '').trim()
    if (!/^[^\s@'"`$\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/.test(s)) throw bad(`${label}: a valid email address`)
    return s
}
// the image tag of a running workload, e.g. "v1.11.3@sha256:…" → "1.11.3"
export const tagVersion = (tag) => (String(tag || '').match(/(\d+)\.(\d+)\.(\d+)/) || [])[0] || null
export const minorOf = (v) => (String(v || '').replace(/^v/, '').match(/^(\d+)\.(\d+)/) || []).slice(1, 3).join('.') || null
// A cluster and settings that make every definition valid — to list its
// release names and charts (the form, new versions) without a real cluster
export const SAMPLE_CTX = Object.freeze({
    clusterId: 'c', k8sMinor: 35, nodeCount: 3, workerCount: 2, nodeIps: ['192.0.2.1', '192.0.2.2', '192.0.2.3'],
    addons: { longhorn: true, monitoring: true }, velero: { bucket: 'b' }
})
export const sampleSettings = (def) => ({ ...Object.fromEntries(def.fields.map(f => [f.key, f.default])), ...(def.example || {}) })

// an IPv4 address or a DNS name (a registry / server address)
export const hostAddress = (v, label) => {
    const s = String(v || '').trim()
    if (net.isIPv4(s) || /^(?=.{1,253}$)([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/i.test(s)) return s
    throw bad(`${label}: an IPv4 address or a DNS name`)
}

// ── Where an add-on keeps its data ───────────────────────────────────────────
export const NFS_STORAGE_CLASS = 'nfs-client'
export const STORAGE_OPTIONS = [
    ['auto', 'Longhorn or NFS if installed, else the node'],
    ['longhorn', 'Longhorn volume (kept if the pod moves)'],
    ['nfs', 'NFS share (NFS provisioner add-on)'],
    ['default', 'The cluster\'s default StorageClass'],
    ['node', 'Node only (lost when the pod is recreated)']
]
export const storageField = (label = 'Where data is stored', extra = {}) => ({ key: 'storage', type: 'select', label, default: 'auto', options: STORAGE_OPTIONS, ...extra })
/** "auto" → Longhorn, else NFS, else the node; a chosen Longhorn / NFS must be installed */
export function resolveStorage(v, ctx, { needsVolume = false, what = 'This add-on' } = {}) {
    let s = oneOf(v || 'auto', STORAGE_OPTIONS.map(o => o[0]), 'Storage')
    if (s === 'auto') s = ctx.addons?.longhorn ? 'longhorn' : ctx.addons?.['nfs-provisioner'] ? 'nfs' : needsVolume ? null : 'node'
    if (s === null) throw bad(`Storage: ${what} keeps its data on a volume — install Longhorn or the NFS provisioner first, or choose "The cluster's default StorageClass"`)
    if (s === 'longhorn' && !ctx.addons?.longhorn) throw bad('Storage: Longhorn is not installed on this cluster — install it first or choose another option')
    if (s === 'nfs' && !ctx.addons?.['nfs-provisioner']) throw bad('Storage: the NFS provisioner is not installed on this cluster — install it first or choose another option')
    if (s === 'node' && needsVolume) throw bad(`Storage: ${what} cannot keep its data on the node only — choose Longhorn, NFS or the default StorageClass`)
    return s
}
/** StorageClass name for a resolved storage choice; null = the cluster's default */
export const storageClassOf = (s) => s === 'longhorn' ? 'longhorn' : s === 'nfs' ? NFS_STORAGE_CLASS : null
/** pre.sh lines: the chosen StorageClass must exist before anything is installed */
export function storageCheck(s) {
    if (s === 'default') return [
        `if ! kubectl get sc -o jsonpath='{range .items[*]}{.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}{"\\n"}{end}' 2>/dev/null | grep -qx true; then`,
        '    fail NO_DEFAULT_STORAGECLASS "The cluster has no default StorageClass, so the volume would never be created." "Install Longhorn or the NFS provisioner (and choose it under Storage), or mark a StorageClass as default."',
        'fi'
    ].join('\n')
    if (s === 'node') return 'log "⚠ Data is kept on the node only — it is lost when the pod is recreated. Choose Longhorn or NFS under Storage to keep it."'
    const sc = storageClassOf(s)
    return `kubectl get sc ${sc} >/dev/null 2>&1 || fail STORAGECLASS_MISSING "The StorageClass ${sc} does not exist." "Check that the ${s === 'nfs' ? 'NFS provisioner' : 'Longhorn'} add-on is healthy, or choose another Storage option."`
}

// 24 random letters and digits, made on the node (never seen by KubeEZ's server)
export const RANDOM = '$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)'
/** pre.sh lines: a Secret created once on the cluster (random values), kept afterwards */
export function ensureSecret(ns, name, keys) {
    const lit = keys.map(([k, value]) => `--from-literal=${k}="${value}"`).join(' ')
    return [
        `kubectl get ns ${ns} >/dev/null 2>&1 || kubectl create ns ${ns} >/dev/null`,
        `kubectl -n ${ns} get secret ${name} >/dev/null 2>&1 || kubectl -n ${ns} create secret generic ${name} ${lit} >/dev/null \\`,
        `    || fail SECRET_FAILED "Could not create the Secret ${ns}/${name}." "Check the cluster (kubectl get ns ${ns}), then apply again."`
    ].join('\n')
}

/** Shell lines that apply one object (a heredoc — any content is safe) */
export const applyObject = (obj, what = 'configuration') => [
    "kubectl apply -f - >/dev/null <<'KUBEEZ_OBJECT' \\",
    `    || fail CONFIG_FAILED "Could not apply the ${what}." "Check the add-on's Logs, then apply again."`,
    JSON.stringify(obj),
    'KUBEEZ_OBJECT'
].join('\n')

/**
 * A DaemonSet that prepares every node once (an init container that sees the
 * node: hostPID, privileged — "nsenter -t 1 -m -u -i -n -p --" runs a command
 * on the node itself), then idles so the rollout shows it is done everywhere.
 */
export function nodeSetupDaemonSet({ name, ns, script, env = [], volumes = [], mounts = [] }) {
    return {
        apiVersion: 'apps/v1', kind: 'DaemonSet',
        metadata: { name, namespace: ns, labels: { app: name, 'app.kubernetes.io/managed-by': 'kubeez' } },
        spec: {
            selector: { matchLabels: { app: name } },
            template: {
                metadata: { labels: { app: name } },
                spec: {
                    hostPID: true,
                    tolerations: [{ operator: 'Exists' }],
                    initContainers: [{ name: 'setup', image: 'busybox:1.37', securityContext: { privileged: true }, command: ['sh', '-c', script], env, volumeMounts: mounts }],
                    containers: [{
                        name: 'ready', image: 'busybox:1.37', command: ['sh', '-c', 'exec sleep 2147483647'],
                        resources: { requests: { cpu: '1m', memory: '4Mi' }, limits: { memory: '16Mi' } }
                    }],
                    terminationGracePeriodSeconds: 1,
                    volumes
                }
            }
        }
    }
}
