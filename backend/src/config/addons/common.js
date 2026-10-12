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
//
// Everything that ends up in a shell line is built from validated values only.

export const bad = (msg) => Object.assign(new Error(msg), { status: 400 })

export const REPOS = {
    'metrics-server': { name: 'kubeez-metrics-server', url: 'https://kubernetes-sigs.github.io/metrics-server/' },
    metallb: { name: 'kubeez-metallb', url: 'https://metallb.github.io/metallb' },
    grafana: { name: 'kubeez-grafana', url: 'https://grafana.github.io/helm-charts' },
    fluent: { name: 'kubeez-fluent', url: 'https://fluent.github.io/helm-charts' },
    'sealed-secrets': { name: 'kubeez-sealed-secrets', url: 'https://bitnami.github.io/sealed-secrets' },
    kyverno: { name: 'kubeez-kyverno', url: 'https://kyverno.github.io/kyverno/' },
    'ingress-nginx': { name: 'kubeez-ingress-nginx', url: 'https://kubernetes.github.io/ingress-nginx' },
    jetstack: { name: 'kubeez-jetstack', url: 'https://charts.jetstack.io' },
    longhorn: { name: 'kubeez-longhorn', url: 'https://charts.longhorn.io' },
    argo: { name: 'kubeez-argo', url: 'https://argoproj.github.io/argo-helm' },
    'vmware-tanzu': { name: 'kubeez-vmware-tanzu', url: 'https://vmware-tanzu.github.io/helm-charts' },
    'prometheus-community': { name: 'kubeez-prometheus-community', url: 'https://prometheus-community.github.io/helm-charts' },
    skyhook: { name: 'kubeez-skyhook', url: 'https://skyhook-io.github.io/helm-charts' }
}

// Namespaces of the platform itself — policies and admission webhooks never touch them
export const SYSTEM_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx', 'monitoring', 'kubernetes-dashboard',
    'cert-manager', 'longhorn-system', 'argocd', 'seaweedfs', 'velero', 'kubeez-explorer',
    'metrics-server', 'metallb-system', 'logging', 'sealed-secrets', 'kyverno']

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
