
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
        tier: 'free'
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
        key: 'argocd',
        name: 'ArgoCD',
        desc: 'Declarative GitOps continuous delivery',
        iconName: 'GitBranch',
        gradient: 'from-indigo-500 via-blue-500 to-cyan-600',
        badge: '✨ New',
        badgeColor: 'text-indigo-400 border-indigo-500/30',
        tier: 'pro'
    }
];

// Addon keys allowed on the Free plan (basic add-ons only)
export const FREE_ADDONS = ADDONS_LIST.filter(a => a.tier === 'free').map(a => a.key)
