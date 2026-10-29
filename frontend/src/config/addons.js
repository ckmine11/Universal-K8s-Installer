
// tier: 'free' → available on all plans; 'pro' → Pro & Enterprise only
export const ADDONS_LIST = [
    {
        key: 'ingress',
        name: 'Nginx Ingress',
        desc: 'Enterprise-grade traffic routing & load balancing',
        iconName: 'Network',
        gradient: 'from-emerald-500 via-green-500 to-teal-600',
        badge: '🔥 Popular',
        badgeColor: 'text-emerald-400 border-emerald-500/30',
        tier: 'pro'
    },
    {
        key: 'dashboard',
        name: 'Kubernetes Dashboard',
        desc: 'Official web-based UI for cluster management',
        iconName: 'LayoutDashboard',
        gradient: 'from-blue-500 via-cyan-500 to-sky-600',
        tier: 'free'
    },
    {
        key: 'monitoring',
        name: 'Prometheus + Grafana',
        desc: 'Complete observability & metrics stack',
        iconName: 'BarChart3',
        gradient: 'from-orange-500 via-red-500 to-pink-600',
        badge: '⭐ Recommended',
        badgeColor: 'text-orange-400 border-orange-500/30',
        tier: 'pro'
    },
    {
        key: 'cert-manager',
        name: 'cert-manager',
        desc: 'Automatic SSL/TLS certificate management',
        iconName: 'Shield',
        gradient: 'from-purple-500 via-fuchsia-500 to-pink-600',
        badge: '✨ New',
        badgeColor: 'text-purple-400 border-purple-500/30',
        tier: 'pro'
    },
    {
        key: 'longhorn',
        name: 'Longhorn Storage',
        desc: 'Cloud-native distributed block storage',
        iconName: 'Database',
        gradient: 'from-amber-500 via-yellow-500 to-orange-600',
        badge: '✨ New',
        badgeColor: 'text-amber-400 border-amber-500/30',
        tier: 'pro'
    },
    {
        key: 'seaweedfs',
        name: 'S3 Object Storage',
        desc: 'SeaweedFS — S3-compatible storage for your apps and for offsite backups of OTHER clusters',
        iconName: 'Database',
        gradient: 'from-sky-500 via-cyan-500 to-teal-600',
        badge: '✨ New',
        badgeColor: 'text-sky-400 border-sky-500/30',
        tier: 'pro'
    },
    {
        key: 'explorer',
        name: 'KubeEZ Explorer',
        desc: 'Full Kubernetes UI inside KubeEZ — resources, logs, topology, timeline, Helm, audit, upgrade checks',
        iconName: 'Compass',
        gradient: 'from-cyan-500 via-blue-500 to-indigo-600',
        badge: '✨ New',
        badgeColor: 'text-cyan-400 border-cyan-500/30',
        tier: 'pro'
    },
    {
        key: 'kubeez-ai',
        name: 'KubeEZ AI',
        desc: 'A free, private AI model in your cluster — explains failures and incidents; nothing leaves your network',
        iconName: 'Bot',
        gradient: 'from-violet-500 via-fuchsia-500 to-pink-600',
        badge: '✨ New',
        badgeColor: 'text-violet-400 border-violet-500/30',
        tier: 'free',
        helm: true
    },
    {
        key: 'argocd',
        name: 'ArgoCD',
        desc: 'Declarative GitOps continuous delivery',
        iconName: 'GitBranch',
        gradient: 'from-indigo-500 via-blue-500 to-cyan-600',
        badge: '✨ New',
        badgeColor: 'text-indigo-400 border-indigo-500/30',
        tier: 'pro'
    },
    // ── Helm add-ons with settings (form, change later, advanced YAML on Pro) ──
    {
        key: 'metrics-server',
        name: 'Metrics Server',
        desc: 'CPU / memory per pod and node — "kubectl top" and autoscaling (HPA)',
        iconName: 'BarChart3',
        gradient: 'from-teal-500 via-emerald-500 to-green-600',
        badge: '✨ New',
        badgeColor: 'text-teal-400 border-teal-500/30',
        tier: 'free',
        helm: true
    },
    {
        key: 'metallb',
        name: 'MetalLB',
        desc: 'Real IPs for LoadBalancer Services on your own servers',
        iconName: 'Network',
        gradient: 'from-sky-500 via-blue-500 to-indigo-600',
        badge: '✨ New',
        badgeColor: 'text-sky-400 border-sky-500/30',
        tier: 'pro',
        helm: true,
        needsSettings: true   // its IP range is chosen on the cluster page
    },
    {
        key: 'loki',
        name: 'Loki logs',
        desc: 'Logs of every pod, searchable in Grafana (Fluent Bit on every node)',
        iconName: 'Database',
        gradient: 'from-yellow-500 via-orange-500 to-red-600',
        badge: '✨ New',
        badgeColor: 'text-yellow-400 border-yellow-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'sealed-secrets',
        name: 'Sealed Secrets',
        desc: 'Encrypted Secrets you can keep in Git — only this cluster opens them',
        iconName: 'Shield',
        gradient: 'from-fuchsia-500 via-purple-500 to-violet-600',
        badge: '✨ New',
        badgeColor: 'text-fuchsia-400 border-fuchsia-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'external-secrets',
        name: 'External Secrets',
        desc: 'Secrets from Vault, AWS, GCP or Azure, synced into the cluster',
        iconName: 'KeyRound',
        gradient: 'from-emerald-500 via-teal-500 to-cyan-600',
        badge: '✨ New',
        badgeColor: 'text-emerald-400 border-emerald-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'argo-rollouts',
        name: 'Argo Rollouts',
        desc: 'Canary and blue-green releases — promote or abort from KubeEZ',
        iconName: 'GitMerge',
        gradient: 'from-orange-500 via-amber-500 to-yellow-500',
        badge: '✨ New',
        badgeColor: 'text-orange-400 border-orange-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'keda',
        name: 'KEDA autoscaling',
        desc: 'Scale on a schedule, CPU, Prometheus or queues — down to zero',
        iconName: 'Zap',
        gradient: 'from-sky-500 via-blue-500 to-indigo-600',
        badge: '✨ New',
        badgeColor: 'text-sky-400 border-sky-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'kyverno',
        name: 'Kyverno policies',
        desc: 'Rules for what may run — no "latest" images, limits required, no privileged pods',
        iconName: 'Shield',
        gradient: 'from-rose-500 via-red-500 to-orange-600',
        badge: '✨ New',
        badgeColor: 'text-rose-400 border-rose-500/30',
        tier: 'pro',
        helm: true
    },
    // ── Storage ──
    {
        key: 'nfs-provisioner',
        name: 'NFS storage',
        desc: 'Volumes on your NFS server — shared (ReadWriteMany) volumes for any app',
        iconName: 'HardDrive',
        gradient: 'from-slate-500 via-zinc-500 to-stone-600',
        badge: '✨ New',
        badgeColor: 'text-slate-300 border-slate-500/30',
        tier: 'pro',
        helm: true,
        needsSettings: true   // the NFS server and folder are chosen on the cluster page
    },
    {
        key: 'snapshot-controller',
        name: 'Volume snapshots',
        desc: 'Point-in-time copies of volumes — Longhorn snapshots, CSI backups with Velero',
        iconName: 'Camera',
        gradient: 'from-cyan-500 via-sky-500 to-blue-600',
        badge: '✨ New',
        badgeColor: 'text-cyan-400 border-cyan-500/30',
        tier: 'pro',
        helm: true
    },
    // ── Logs ──
    {
        key: 'elasticsearch',
        name: 'Elasticsearch + Kibana',
        desc: 'Search and log storage (official ECK operator), Kibana to explore it',
        iconName: 'Search',
        gradient: 'from-yellow-400 via-amber-500 to-teal-600',
        badge: '✨ New',
        badgeColor: 'text-amber-400 border-amber-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'fluentd',
        name: 'Fluentd',
        desc: 'Log router — receives logs from Fluent Bit and sends them to Elasticsearch',
        iconName: 'ScrollText',
        gradient: 'from-sky-500 via-blue-500 to-indigo-600',
        badge: '✨ New',
        badgeColor: 'text-sky-400 border-sky-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'fluent-bit',
        name: 'Fluent Bit',
        desc: 'Lightweight log collector on every node → Elasticsearch, Fluentd or elsewhere',
        iconName: 'Feather',
        gradient: 'from-blue-500 via-indigo-500 to-violet-600',
        badge: '✨ New',
        badgeColor: 'text-blue-400 border-blue-500/30',
        tier: 'pro',
        helm: true
    },
    // ── Delivery ──
    {
        key: 'harbor',
        name: 'Harbor registry',
        desc: 'Your own container registry with vulnerability scans — nodes pull from it directly',
        iconName: 'Container',
        gradient: 'from-teal-500 via-cyan-500 to-blue-600',
        badge: '✨ New',
        badgeColor: 'text-teal-400 border-teal-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'flux',
        name: 'Flux CD',
        desc: 'GitOps — keeps the cluster in sync with a Git repository',
        iconName: 'GitMerge',
        gradient: 'from-indigo-500 via-violet-500 to-purple-600',
        badge: '✨ New',
        badgeColor: 'text-violet-400 border-violet-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'jenkins',
        name: 'Jenkins',
        desc: 'CI/CD server — builds run as pods in the cluster',
        iconName: 'Hammer',
        gradient: 'from-red-500 via-rose-500 to-pink-600',
        badge: '✨ New',
        badgeColor: 'text-red-400 border-red-500/30',
        tier: 'pro',
        helm: true
    },
    // ── Security ──
    {
        key: 'vault',
        name: 'HashiCorp Vault',
        desc: 'Secrets management — secrets injected into pods, Kubernetes login ready',
        iconName: 'KeyRound',
        gradient: 'from-yellow-500 via-amber-500 to-orange-600',
        badge: '✨ New',
        badgeColor: 'text-yellow-400 border-yellow-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'gatekeeper',
        name: 'OPA Gatekeeper',
        desc: 'Policies in Rego — no "latest" images, limits required, no privileged pods',
        iconName: 'ShieldCheck',
        gradient: 'from-emerald-500 via-teal-500 to-cyan-600',
        badge: '✨ New',
        badgeColor: 'text-emerald-400 border-emerald-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'falco',
        name: 'Falco',
        desc: 'Runtime security — alerts on shells in containers, sensitive files read and more',
        iconName: 'Radar',
        gradient: 'from-cyan-500 via-teal-500 to-emerald-600',
        badge: '✨ New',
        badgeColor: 'text-cyan-400 border-cyan-500/30',
        tier: 'pro',
        helm: true
    },
    {
        key: 'trivy-operator',
        name: 'Trivy Operator',
        desc: 'Continuous vulnerability and misconfiguration scans of everything running',
        iconName: 'ScanSearch',
        gradient: 'from-sky-500 via-cyan-500 to-teal-600',
        badge: '✨ New',
        badgeColor: 'text-sky-400 border-sky-500/30',
        tier: 'pro',
        helm: true
    }
];

// Add-ons that can be ticked when creating a cluster (the rest need settings first)
export const WIZARD_ADDONS = ADDONS_LIST.filter(a => !a.needsSettings)

// Addon keys allowed on the Free plan (basic add-ons only)
export const FREE_ADDONS = ADDONS_LIST.filter(a => a.tier === 'free').map(a => a.key)
