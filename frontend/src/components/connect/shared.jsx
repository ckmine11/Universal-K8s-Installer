import { useState } from 'react'
import { Copy, Check, CheckCircle2, XCircle, Cloud, Server, Boxes } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// Shared pieces of "Connected clusters": the API, copyable commands, provider
// badges, the connection status and what works on a cluster.
export async function call(url, opts = {}) {
    const res = await apiFetch(url, opts.body !== undefined ? { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : opts)
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(d.error || `Request failed (HTTP ${res.status})`), { data: d, status: res.status })
    return d
}

export function CopyBlock({ text, label, multiline = false }) {
    const [done, setDone] = useState(false)
    const copy = () => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }
    return (
        <div className="group relative rounded-xl border border-white/10 bg-black/40">
            {label && <div className="px-3 pt-2 text-[10px] uppercase tracking-wider text-slate-500">{label}</div>}
            <pre className={`px-3 py-2.5 pr-12 text-xs font-mono text-sky-100 ${multiline ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-x-auto'} break-all`}>{text}</pre>
            <button type="button" onClick={copy} aria-label="Copy" title="Copy" className="absolute right-2 top-2 rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:text-white">
                {done ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
        </div>
    )
}

// a short tag per provider (no brand logos — the name says it)
const SHORT = { eks: 'EKS', aks: 'AKS', gke: 'GKE', oke: 'OKE', doks: 'DO', lke: 'LKE', vke: 'VKE', iks: 'IBM', ack: 'ACK', tke: 'TKE', civo: 'CIVO', scaleway: 'SCW', ovh: 'OVH', hetzner: 'HZ', 'cloud-other': 'CLOUD', kubeadm: 'KADM', k3s: 'K3S', rke2: 'RKE2', rancher: 'RNCH', openshift: 'OCP', microk8s: 'MK8S', k0s: 'K0S', tanzu: 'TKG', talos: 'TLOS', 'eks-anywhere': 'EKS-A', 'aks-arc': 'ARC', 'onprem-other': 'K8S', kind: 'KIND', unknown: 'K8S' }
const TONE = { cloud: 'from-sky-500/30 to-blue-500/10 text-sky-100 border-sky-400/30', onprem: 'from-violet-500/30 to-fuchsia-500/10 text-violet-100 border-violet-400/30', other: 'from-slate-500/30 to-slate-500/10 text-slate-100 border-white/15' }
export function ProviderBadge({ provider, group, size = 'md' }) {
    const s = size === 'sm' ? 'w-9 h-9 text-[9px]' : 'w-11 h-11 text-[10px]'
    return <span className={`inline-flex shrink-0 items-center justify-center rounded-xl border bg-gradient-to-br font-black tracking-wide ${s} ${TONE[group] || TONE.other}`}>{SHORT[provider] || 'K8S'}</span>
}
export const GroupIcon = ({ group, className = 'w-4 h-4' }) => group === 'cloud' ? <Cloud className={className} /> : group === 'onprem' ? <Server className={className} /> : <Boxes className={className} />

export const METHOD_LABEL = { agent: 'KubeEZ agent', direct: 'Direct (kubeconfig)', gateway: 'Through the Gateway Agent', ssh: 'SSH' }
export const LEVEL_LABEL = { read: 'Read-only', full: 'Full manage' }

export function StatusDot({ status }) {
    const m = { live: ['bg-emerald-400', 'Connected'], stale: ['bg-amber-400', 'Not checked lately'], lost: ['bg-red-400', 'Cannot reach it'], ssh: ['bg-emerald-400', 'SSH'] }[status] || ['bg-slate-500', status]
    return <span className="inline-flex items-center gap-1.5 text-xs text-slate-300"><span className={`w-2 h-2 rounded-full ${m[0]} ${status === 'live' ? 'animate-pulse' : ''}`} />{m[1]}</span>
}

const FEATURE_NAMES = { etcdBackup: 'etcd backups', upgrade: 'Kubernetes upgrades', scale: 'Add / remove nodes', nodeTerminal: 'Shell on the nodes', resume: 'Resume an install', certRotation: 'Control-plane certificates', addons: 'Install add-ons', healing: 'Automatic fixes', actions: 'AI fixes', yamlApply: 'Apply YAML', backup: 'Volume backups (Velero)', namespaceAccess: 'Per-namespace access', terminal: 'Cluster terminal', kubeconfig: 'Scoped kubeconfig' }
const ALWAYS = ['Dashboard & health', 'Explorer (read)', 'Incidents & alerts', 'KubeEZ AI: Ask, explain, summaries', 'Advisor', 'What changed', 'Fleet & risk score', 'Compliance (Kubernetes checks)', 'Team roles & cluster rules']
export function FeatureList({ features, compact = false }) {
    const entries = Object.entries(features || {})
    const ok = entries.filter(([, v]) => v.ok), no = entries.filter(([, v]) => !v.ok)
    return (
        <div className={`grid gap-4 ${compact ? '' : 'md:grid-cols-2'}`}>
            <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">Works</p>
                <ul className="space-y-1.5 text-xs text-slate-300">
                    {[...ALWAYS, ...ok.map(([k]) => FEATURE_NAMES[k] || k)].map(n => <li key={n} className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-300 shrink-0" />{n}</li>)}
                </ul>
            </div>
            {no.length > 0 && (
                <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Not available here</p>
                    <ul className="space-y-2 text-xs text-slate-400">
                        {no.map(([k, v]) => <li key={k} className="flex items-start gap-1.5"><XCircle className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" /><span><span className="text-slate-200">{FEATURE_NAMES[k] || k}</span> — {v.why}</span></li>)}
                    </ul>
                </div>
            )}
        </div>
    )
}

export const ago = (iso) => {
    if (!iso) return 'never'
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString()
}
