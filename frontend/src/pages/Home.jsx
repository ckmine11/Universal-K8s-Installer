import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, Link } from 'react-router-dom'
import { useToast } from '../components/ToastProvider'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { CardSkeleton } from '../components/Skeleton'
import { ADDONS_LIST } from '../config/addons'
import {
    Server, Zap, Plus, Cpu, Network, Trash2, Package, Loader2, CheckCircle2, BarChart3, LayoutDashboard, Shield,
    Database, GitBranch, Sparkles, Lock, Eye, HeartPulse, Compass, ArrowRight, Wifi, Bell, BookOpen, ShieldAlert,
    Layers, Activity, X, Scaling, MoreHorizontal, Rocket
} from 'lucide-react'

const ADDON_ICONS = { Compass, Network, BarChart3, LayoutDashboard, Shield, Database, GitBranch, Sparkles }

// What a cluster's saved status means for the user
const STATUS = {
    healthy: { label: 'Healthy', dot: 'bg-emerald-400', tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20' },
    failed: { label: 'Install failed', dot: 'bg-red-400', tone: 'text-red-300 bg-red-500/10 border-red-400/20' },
    cancelled: { label: 'Paused', dot: 'bg-amber-400', tone: 'text-amber-300 bg-amber-500/10 border-amber-400/20' },
    installing: { label: 'Installing', dot: 'bg-blue-400 animate-pulse', tone: 'text-blue-200 bg-blue-500/10 border-blue-400/20' },
    attention: { label: 'Needs attention', dot: 'bg-amber-400 animate-pulse', tone: 'text-amber-300 bg-amber-500/10 border-amber-400/20' }
}

const greeting = () => {
    const h = new Date().getHours()
    return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

const ago = (iso) => {
    if (!iso) return ''
    const d = (Date.now() - new Date(iso)) / 86400000
    return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString()
}

export default function Home({ onStartNew, onScaleExisting }) {
    const { toast } = useToast()
    const { user } = useAuth()
    const navigate = useNavigate()
    const canDelete = can(user?.role, 'cluster:delete')
    const canCreate = can(user?.role, 'cluster:create')
    const [savedClusters, setSavedClusters] = useState([])
    const [incidents, setIncidents] = useState([])
    const [loading, setLoading] = useState(true)
    const [isFreePlan, setIsFreePlan] = useState(false)

    // Add-on install dialog
    const [isAddonModalOpen, setIsAddonModalOpen] = useState(false)
    const [selectedClusterId, setSelectedClusterId] = useState(null)
    const [addonSelection, setAddonSelection] = useState({})
    const [installingAddons, setInstallingAddons] = useState(false)

    const handleAddonSubmit = async () => {
        if (!Object.values(addonSelection).some(v => v)) {
            toast({ title: 'Pick an add-on', message: 'Select at least one add-on to install.', type: 'info' })
            return
        }
        setInstallingAddons(true)
        try {
            const res = await apiFetch(`/api/clusters/${selectedClusterId}/addons`, { method: 'POST', body: JSON.stringify({ addons: addonSelection }) })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to start add-on install')
            toast({ title: 'Installing add-ons', message: 'Follow the live log on the next screen.', type: 'success' })
            setIsAddonModalOpen(false)
            navigate(`/dashboard/${data.newInstallationId}`)
        } catch (err) {
            toast({ title: 'Could not start', message: err.message, type: 'error' })
        } finally {
            setInstallingAddons(false)
        }
    }

    useEffect(() => {
        fetchSavedClusters()
        apiFetch('/api/billing/subscription')
            .then(r => r.ok ? r.json() : null)
            .then(sub => { if (sub) setIsFreePlan(!sub.plan || String(sub.plan).toUpperCase() === 'FREE') })
            .catch(() => { })
        apiFetch('/api/incidents').then(r => r.ok ? r.json() : []).then(l => setIncidents(Array.isArray(l) ? l : [])).catch(() => { })
    }, [])

    const fetchSavedClusters = async () => {
        setLoading(true)
        try {
            const response = await apiFetch('/api/clusters/list')
            const data = await response.json()
            setSavedClusters(Array.isArray(data) ? data : [])
        } catch {
            toast({ title: 'Connection error', message: 'Could not load your clusters.', type: 'error' })
        } finally {
            setLoading(false)
        }
    }

    const handleDeleteCluster = async (id) => {
        if (!canDelete) return toast({ title: 'Not allowed', message: 'Your role does not permit removing clusters.', type: 'error' })
        if (!window.confirm('Remove this cluster from KubeEZ? The cluster itself keeps running.')) return
        try {
            const res = await apiFetch(`/api/clusters/${id}`, { method: 'DELETE' })
            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                throw new Error(data.error || (res.status === 403 ? 'You do not have permission to remove clusters.' : 'Failed to remove the cluster.'))
            }
            setSavedClusters(prev => prev.filter(c => c.id !== id))
            toast({ title: 'Removed', message: 'The cluster is no longer managed here.', type: 'success' })
        } catch (error) {
            toast({ title: 'Action failed', message: error.message, type: 'error' })
        }
    }

    const openIncidents = incidents.filter(i => i.status !== 'resolved' && i.status !== 'cleared')
    const stats = useMemo(() => {
        const nodes = savedClusters.reduce((n, c) => n + (c.masterNodes?.length || 0) + (c.workerNodes?.length || 0), 0)
        const healthy = savedClusters.filter(c => (c.status || 'healthy') === 'healthy').length
        return { clusters: savedClusters.length, nodes, healthy }
    }, [savedClusters])
    const statusOf = (c) => {
        const s = c.status || 'healthy'
        if (s === 'healthy' && openIncidents.some(i => i.clusterId === c.id)) return STATUS.attention
        return STATUS[s] || STATUS.installing
    }

    const empty = !loading && savedClusters.length === 0

    return (
        <div className="space-y-8">
            {/* Greeting + actions */}
            <section className="relative overflow-hidden rounded-[28px] kz-card p-6 sm:p-8">
                <div className="absolute -top-24 -right-16 w-80 h-80 rounded-full bg-violet-500/20 blur-3xl pointer-events-none" />
                <div className="absolute -bottom-28 left-10 w-80 h-80 rounded-full bg-blue-500/20 blur-3xl pointer-events-none" />
                <div className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
                    <div>
                        <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-blue-300/80">{greeting()}, {user?.username}</p>
                        <h2 className="mt-2 font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">
                            {empty ? <>Let’s launch your <span className="aurora-text">first cluster</span></> : <>Your fleet <span className="aurora-text">at a glance</span></>}
                        </h2>
                        <p className="mt-2 text-slate-400 max-w-xl">
                            {empty ? 'Bring your own servers — KubeEZ checks them, installs Kubernetes and keeps it healthy.' : 'Health, versions and nodes of every cluster you manage — open one for backups, upgrades and the Explorer.'}
                        </p>
                    </div>
                    {canCreate && (
                        <div className="flex flex-wrap gap-2">
                            <button onClick={onStartNew} className="kz-btn-primary !px-5 !py-3"><Plus className="w-4 h-4" /> Deploy cluster</button>
                            {savedClusters.length > 0 && (
                                <button onClick={() => onScaleExisting(savedClusters[0])} className="kz-btn-ghost !px-5 !py-3"><Scaling className="w-4 h-4" /> Add nodes</button>
                            )}
                        </div>
                    )}
                </div>

                {!empty && (
                    <div className="relative mt-8 grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <Stat icon={Layers} label="Clusters" value={stats.clusters} tone="from-blue-400/25" />
                        <Stat icon={Server} label="Nodes" value={stats.nodes} tone="from-indigo-400/25" />
                        <Stat icon={HeartPulse} label="Healthy" value={`${stats.healthy}/${stats.clusters}`} tone="from-emerald-400/25" />
                        <Stat icon={ShieldAlert} label="Open incidents" value={openIncidents.length} tone={openIncidents.length ? 'from-red-400/30' : 'from-violet-400/25'}
                            onClick={() => navigate('/incidents')} />
                    </div>
                )}
            </section>

            {!canCreate && (
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">
                    <Eye className="w-4 h-4 text-slate-400 shrink-0" />
                    You have <b className="text-white mx-1">read-only</b> access — you can watch clusters, health and incidents. Ask an Operator or Admin to make changes.
                </div>
            )}

            {/* Clusters */}
            {loading ? (
                <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3"><CardSkeleton /><CardSkeleton /></div>
            ) : empty ? (
                <EmptyFleet canCreate={canCreate} onStartNew={onStartNew} />
            ) : (
                <section>
                    <div className="flex items-end justify-between mb-4">
                        <h3 className="font-display text-lg font-semibold text-white">Clusters</h3>
                        <span className="text-xs text-slate-500">{stats.clusters} managed · {stats.nodes} nodes</span>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                        {savedClusters.map((c, i) => (
                            <ClusterCard key={c.id} c={c} i={i} status={statusOf(c)} canCreate={canCreate} canDelete={canDelete}
                                onOpen={() => navigate(`/cluster/${c.id}`)}
                                onAddons={() => { setSelectedClusterId(c.id); setAddonSelection({}); setIsAddonModalOpen(true) }}
                                onScale={() => onScaleExisting(c)}
                                onDelete={() => handleDeleteCluster(c.id)} />
                        ))}
                        {canCreate && (
                            <button onClick={onStartNew} className="group min-h-[220px] rounded-3xl border border-dashed border-white/15 hover:border-blue-400/50 bg-white/[0.015] hover:bg-blue-500/[0.04] flex flex-col items-center justify-center gap-3 text-slate-400 hover:text-white transition">
                                <span className="w-12 h-12 rounded-2xl border border-white/10 flex items-center justify-center group-hover:shadow-glow group-hover:border-blue-400/40 transition"><Plus className="w-5 h-5" /></span>
                                <span className="font-semibold">Deploy another cluster</span>
                            </button>
                        )}
                    </div>
                </section>
            )}

            {/* Shortcuts */}
            {!empty && (
                <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                        { to: '/agents', icon: Wifi, title: 'Gateway Agents', desc: 'Reach servers in private networks' },
                        { to: '/alerts', icon: Bell, title: 'Alerts', desc: 'Telegram, Slack, Teams, WhatsApp, email' },
                        { to: '/incidents', icon: Activity, title: 'Auto-healing', desc: 'What was detected and fixed' },
                        { to: '/docs', icon: BookOpen, title: 'Docs', desc: 'Guides and troubleshooting' }
                    ].map(s => (
                        <Link key={s.to} to={s.to} className="group kz-card kz-card-hover !rounded-2xl p-4 flex items-center gap-4">
                            <span className="w-10 h-10 rounded-xl bg-white/[0.05] border border-white/10 flex items-center justify-center group-hover:border-blue-400/40"><s.icon className="w-5 h-5 text-blue-300" /></span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-bold text-white">{s.title}</span>
                                <span className="block text-xs text-slate-400 truncate">{s.desc}</span>
                            </span>
                            <ArrowRight className="w-4 h-4 text-slate-500 group-hover:text-white group-hover:translate-x-0.5 transition" />
                        </Link>
                    ))}
                </section>
            )}

            {isAddonModalOpen && createPortal(
                <AddonDialog
                    cluster={savedClusters.find(c => c.id === selectedClusterId)}
                    selection={addonSelection} setSelection={setAddonSelection}
                    isFreePlan={isFreePlan} busy={installingAddons} toast={toast}
                    onClose={() => setIsAddonModalOpen(false)} onSubmit={handleAddonSubmit} />,
                document.body
            )}
        </div>
    )
}

function Stat({ icon: Icon, label, value, tone, onClick }) {
    const Tag = onClick ? 'button' : 'div'
    return (
        <Tag onClick={onClick} className={`relative overflow-hidden text-left rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 ${onClick ? 'hover:border-white/20 transition' : ''}`}>
            <div className={`absolute -top-10 -right-8 w-28 h-28 rounded-full bg-gradient-to-br ${tone} to-transparent blur-2xl`} />
            <Icon className="relative w-4 h-4 text-slate-400" />
            <div className="relative mt-3 font-display text-3xl font-bold text-white tabular-nums">{value}</div>
            <div className="relative text-xs font-semibold text-slate-400">{label}</div>
        </Tag>
    )
}

function ClusterCard({ c, i, status, canCreate, canDelete, onOpen, onAddons, onScale, onDelete }) {
    const [menu, setMenu] = useState(false)
    const masters = c.masterNodes || [], workers = c.workerNodes || []
    const addons = Object.entries(c.addons || {}).filter(([, v]) => v).map(([k]) => ADDONS_LIST.find(a => a.key === k)?.name || k)
    return (
        <div onClick={onOpen} role="link" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen() }}
            className="group relative kz-card kz-card-hover p-5 cursor-pointer kz-rise" style={{ animationDelay: `${i * 60}ms` }}>
            <div className="flex items-start gap-4">
                <div className="relative w-12 h-12 shrink-0 rounded-2xl border border-white/10 bg-gradient-to-br from-blue-500/15 to-violet-500/15 flex items-center justify-center">
                    <Cpu className="w-6 h-6 text-blue-200" />
                    <span className={`absolute -top-1 -right-1 w-3 h-3 rounded-full ring-4 ring-[#0b1120] ${status.dot}`} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-display text-lg font-semibold text-white truncate">{c.clusterName}</h4>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${status.tone}`}>{status.label}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-slate-400 flex-wrap">
                        <span className="font-mono">v{c.k8sVersion}</span>
                        <span className="w-1 h-1 rounded-full bg-slate-600" />
                        <span className="capitalize">{c.networkPlugin}</span>
                        {c.controlPlaneVip && <><span className="w-1 h-1 rounded-full bg-slate-600" /><span className="font-mono">VIP {c.controlPlaneVip}</span></>}
                    </div>
                </div>
                {(canCreate || canDelete) && (
                    <div className="relative" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setMenu(m => !m)} className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/5" aria-label="Cluster actions"><MoreHorizontal className="w-4 h-4" /></button>
                        {menu && (
                            <div className="absolute right-0 top-9 z-20 w-44 kz-card !rounded-xl p-1.5 kz-rise" onMouseLeave={() => setMenu(false)}>
                                {canCreate && <button onClick={() => { setMenu(false); onScale() }} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/5"><Scaling className="w-4 h-4" /> Add nodes</button>}
                                {canDelete && <button onClick={() => { setMenu(false); onDelete() }} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"><Trash2 className="w-4 h-4" /> Remove</button>}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Nodes as a little constellation */}
            <div className="mt-5 rounded-2xl border border-white/[0.06] bg-black/20 p-3">
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2">
                    <span><b className="text-white">{masters.length}</b> control-plane · <b className="text-white">{workers.length}</b> worker{workers.length === 1 ? '' : 's'}</span>
                    <span className="font-mono text-slate-500">{masters[0]?.ip}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {masters.map((n, k) => <span key={`m${k}`} title={n.hostname || n.ip} className="h-2.5 w-7 rounded-full bg-gradient-to-r from-blue-400 to-indigo-400 shadow-[0_0_10px_rgba(44,203,238,.45)]" />)}
                    {workers.map((n, k) => <span key={`w${k}`} title={n.hostname || n.ip} className="h-2.5 w-5 rounded-full bg-violet-400/70" />)}
                    {!masters.length && !workers.length && <span className="text-xs text-slate-500">No nodes saved</span>}
                </div>
            </div>

            <div className="mt-4 flex items-center gap-1.5 flex-wrap min-h-[24px]">
                {addons.slice(0, 4).map(a => <span key={a} className="kz-chip text-slate-300">{a}</span>)}
                {addons.length > 4 && <span className="kz-chip text-slate-400">+{addons.length - 4}</span>}
                {!addons.length && <span className="text-xs text-slate-500">No add-ons yet</span>}
            </div>

            <div className="mt-4 pt-4 border-t border-white/[0.06] flex items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">Added {ago(c.createdAt)}</span>
                <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    {canCreate && <button onClick={onAddons} className="kz-btn-ghost !py-1.5 !px-3 !text-xs"><Package className="w-3.5 h-3.5" /> Add-ons</button>}
                    <button onClick={onOpen} className="kz-btn !py-1.5 !px-3 !text-xs text-blue-200 bg-blue-500/10 border border-blue-400/20 hover:bg-blue-500/20">Open <ArrowRight className="w-3.5 h-3.5" /></button>
                </div>
            </div>
        </div>
    )
}

function EmptyFleet({ canCreate, onStartNew }) {
    return (
        <section className="grid lg:grid-cols-5 gap-4">
            <div className="lg:col-span-3 kz-card p-6 sm:p-8 relative overflow-hidden">
                <Orbit />
                <h3 className="relative font-display text-2xl font-bold text-white">Three steps to a production cluster</h3>
                <ol className="relative mt-6 space-y-5">
                    {[
                        { icon: Server, t: 'Add your servers', d: 'IP + SSH user and password or key. Private network? Start a Gateway Agent first — no inbound ports.' },
                        { icon: CheckCircle2, t: 'Pre-flight checks', d: 'OS, CPU, memory, ports and connectivity are verified before anything is installed.' },
                        { icon: Rocket, t: 'Install & operate', d: 'Live log for every step. Then upgrades, backups, add-ons and auto-healing from one page.' }
                    ].map((s, k) => (
                        <li key={k} className="flex gap-4">
                            <span className="relative w-10 h-10 shrink-0 rounded-xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-white/10 flex items-center justify-center font-display font-bold text-white">{k + 1}</span>
                            <div><p className="font-semibold text-white flex items-center gap-2"><s.icon className="w-4 h-4 text-blue-300" />{s.t}</p><p className="text-sm text-slate-400 mt-0.5">{s.d}</p></div>
                        </li>
                    ))}
                </ol>
                {canCreate && <button onClick={onStartNew} className="relative mt-8 kz-btn-primary !px-6 !py-3">Deploy your first cluster <ArrowRight className="w-4 h-4" /></button>}
            </div>
            <div className="lg:col-span-2 grid gap-4">
                {[
                    { icon: Wifi, t: 'Servers behind a firewall?', d: 'A Gateway Agent connects out to KubeEZ — nothing to open.', to: '/agents', cta: 'Set up an agent' },
                    { icon: Bell, t: 'Know when something breaks', d: 'Alerts on Telegram, Slack, Teams, WhatsApp or email.', to: '/alerts', cta: 'Add a channel' },
                    { icon: BookOpen, t: 'New to Kubernetes?', d: 'Short guides for every screen and the common fixes.', to: '/docs', cta: 'Read the docs' }
                ].map(x => (
                    <Link key={x.t} to={x.to} className="group kz-card kz-card-hover p-5">
                        <x.icon className="w-5 h-5 text-blue-300" />
                        <p className="mt-3 font-semibold text-white">{x.t}</p>
                        <p className="text-sm text-slate-400 mt-1">{x.d}</p>
                        <span className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-blue-300 group-hover:gap-2 transition-all">{x.cta} <ArrowRight className="w-3.5 h-3.5" /></span>
                    </Link>
                ))}
            </div>
        </section>
    )
}

// Decorative orbit of nodes for the empty state
function Orbit() {
    return (
        <svg className="absolute -right-24 -top-24 w-[420px] h-[420px] opacity-40 pointer-events-none" viewBox="0 0 400 400" aria-hidden="true">
            <defs><linearGradient id="og" x1="0" x2="1"><stop offset="0" stopColor="#2ccbee" /><stop offset="1" stopColor="#a855f7" /></linearGradient></defs>
            {[70, 120, 170].map((r, k) => <circle key={r} cx="200" cy="200" r={r} fill="none" stroke="url(#og)" strokeOpacity={0.35 - k * 0.08} strokeDasharray="2 6" />)}
            <g className="animate-spin-slow" style={{ transformOrigin: '200px 200px', animationDuration: '40s' }}>
                {[[200, 80], [320, 200], [200, 370], [80, 200], [285, 115]].map(([x, y], k) => <circle key={k} cx={x} cy={y} r={k === 4 ? 4 : 6} fill="url(#og)" />)}
            </g>
            <circle cx="200" cy="200" r="22" fill="url(#og)" opacity=".8" />
        </svg>
    )
}

function AddonDialog({ cluster, selection, setSelection, isFreePlan, busy, toast, onClose, onSubmit }) {
    const count = Object.values(selection).filter(Boolean).length
    return (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-4xl max-h-[90vh] flex flex-col kz-card overflow-hidden kz-rise">
                <div className="flex items-center gap-4 p-6 border-b border-white/[0.07]">
                    <span className="w-11 h-11 rounded-2xl bg-aurora-gradient flex items-center justify-center shadow-glow"><Sparkles className="w-5 h-5 text-white" /></span>
                    <div className="min-w-0">
                        <h2 className="font-display text-xl font-bold text-white">Install add-ons</h2>
                        <p className="text-sm text-slate-400 truncate">on <b className="text-slate-200">{cluster?.clusterName}</b> — pick what this cluster should get</p>
                    </div>
                    <button onClick={onClose} className="ml-auto p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>
                <div className="p-6 overflow-y-auto grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {ADDONS_LIST.map(addon => {
                        const Icon = ADDON_ICONS[addon.iconName] || Package
                        const locked = addon.tier === 'pro' && isFreePlan
                        const on = selection[addon.key] && !locked
                        return (
                            <button key={addon.key} type="button"
                                onClick={() => locked
                                    ? toast({ title: 'Pro add-on', message: `${addon.name} is on the Pro and Enterprise plans.`, type: 'info' })
                                    : setSelection(p => ({ ...p, [addon.key]: !p[addon.key] }))}
                                className={`relative text-left rounded-2xl border p-4 transition ${locked ? 'opacity-50 cursor-not-allowed border-white/5' : on ? 'border-blue-400/60 bg-blue-500/[0.08] shadow-glow' : 'border-white/10 bg-white/[0.02] hover:border-white/25'}`}>
                                <span className={`absolute top-3 right-3 w-5 h-5 rounded-full border flex items-center justify-center ${on ? 'bg-blue-400 border-blue-400' : 'border-white/20'}`}>
                                    {on && <CheckCircle2 className="w-4 h-4 text-[#05070d]" />}
                                    {locked && <Lock className="w-3 h-3 text-amber-300" />}
                                </span>
                                <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${on ? `bg-gradient-to-br ${addon.gradient}` : 'bg-white/[0.05] border border-white/10'}`}><Icon className="w-5 h-5 text-white" /></span>
                                <p className="mt-3 font-semibold text-white flex items-center gap-2">{addon.name}{addon.badge && !locked && <span className="kz-chip !py-0 !text-[9px] text-slate-300">{addon.badge}</span>}</p>
                                <p className="mt-1 text-xs text-slate-400 leading-relaxed">{addon.desc}</p>
                            </button>
                        )
                    })}
                </div>
                <div className="flex items-center gap-3 p-4 sm:p-6 border-t border-white/[0.07]">
                    <span className="text-sm text-slate-400">{count ? `${count} selected` : 'Nothing selected yet'}</span>
                    <button onClick={onClose} className="ml-auto kz-btn-ghost">Cancel</button>
                    <button onClick={onSubmit} disabled={busy || !count} className="kz-btn-primary">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />} Install{count ? ` ${count}` : ''}
                    </button>
                </div>
            </div>
        </div>
    )
}
