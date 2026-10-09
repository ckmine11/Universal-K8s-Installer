import { useState, useEffect } from 'react'
import { useAuth, apiFetch } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import TenantManager from '../components/TenantManager'
import { PageTitle } from '../components/ui/PageHeader'
import {
    LayoutDashboard, Users, Server, ShieldAlert, Activity, DollarSign,
    Boxes, TrendingUp, Loader2, Crown, RefreshCw, Cpu, Database,
    AlertTriangle, CheckCircle2, ArrowUpRight, Building2, Zap
} from 'lucide-react'

const SECTIONS = [
    { key: 'overview',  label: 'Overview',   icon: LayoutDashboard },
    { key: 'tenants',   label: 'Tenants',    icon: Users },
    { key: 'clusters',  label: 'Clusters',   icon: Server },
    { key: 'incidents', label: 'Incidents',  icon: ShieldAlert },
    { key: 'system',    label: 'System',     icon: Activity },
]

export default function AdminConsole() {
    const { user } = useAuth()
    const [section, setSection] = useState('overview')

    // Gate: superadmin only
    if (!user) return null
    if (user.role !== 'superadmin') {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                <ShieldAlert className="w-12 h-12 text-red-500 mb-4" />
                <h1 className="text-2xl font-black text-white mb-2">Access Denied</h1>
                <p className="text-slate-400">The Super Admin Console is restricted to platform owners.</p>
            </div>
        )
    }

    return (
        <div className="max-w-7xl mx-auto animate-in fade-in duration-300">
            {/* Header */}
            <div className="mb-8">
                <PageTitle icon={Crown} eyebrow="Platform" title="Admin Console"
                    description="The whole platform — tenants, clusters, revenue and system health." />
            </div>

            <div className="flex flex-col lg:flex-row gap-6">
                {/* Sidebar nav */}
                <aside className="lg:w-56 shrink-0">
                    <nav className="glass rounded-3xl border border-white/5 p-3 flex lg:flex-col gap-1 overflow-x-auto">
                        {SECTIONS.map(s => {
                            const Icon = s.icon
                            const active = section === s.key
                            return (
                                <button
                                    key={s.key}
                                    onClick={() => setSection(s.key)}
                                    className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all whitespace-nowrap ${
                                        active
                                            ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/20'
                                            : 'text-slate-400 hover:bg-white/5 hover:text-white'
                                    }`}
                                >
                                    <Icon className="w-4 h-4" />
                                    {s.label}
                                </button>
                            )
                        })}
                    </nav>
                </aside>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    {section === 'overview' && <OverviewSection onGoto={setSection} />}
                    {section === 'tenants' && <TenantManager />}
                    {section === 'clusters' && <ClustersSection />}
                    {section === 'incidents' && <IncidentsSection />}
                    {section === 'system' && <SystemSection />}
                </div>
            </div>
        </div>
    )
}

/* ─── Overview ──────────────────────────────────────────────────────────── */
function OverviewSection({ onGoto }) {
    const { toast } = useToast()
    const [stats, setStats] = useState(null)
    const [loading, setLoading] = useState(true)

    const load = async () => {
        setLoading(true)
        try {
            const res = await apiFetch('/api/superadmin/stats')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to load stats')
            setStats(data)
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { load() }, [])

    if (loading) return <Loading label="Loading platform metrics..." />
    if (!stats) return null

    const cards = [
        { label: 'Monthly Revenue', value: `$${stats.revenue.mrr.toLocaleString()}`, sub: `$${stats.revenue.arr.toLocaleString()} ARR`, icon: DollarSign, color: 'emerald' },
        { label: 'Total Tenants',   value: stats.tenants.total, sub: `${stats.tenants.owners} orgs · ${stats.tenants.teamMembers} members`, icon: Users, color: 'blue' },
        { label: 'Clusters',        value: stats.clusters.total, sub: `${stats.clusters.totalNodes} nodes total`, icon: Server, color: 'purple' },
        { label: 'Open Incidents',  value: stats.incidents.unresolved, sub: `${stats.incidents.total} all-time`, icon: ShieldAlert, color: stats.incidents.unresolved > 0 ? 'red' : 'slate' },
    ]
    const colorMap = {
        emerald: 'from-emerald-500/20 to-emerald-700/5 text-emerald-400 border-emerald-500/20',
        blue: 'from-blue-500/20 to-blue-700/5 text-blue-400 border-blue-500/20',
        purple: 'from-purple-500/20 to-purple-700/5 text-purple-400 border-purple-500/20',
        red: 'from-red-500/20 to-red-700/5 text-red-400 border-red-500/20',
        slate: 'from-slate-500/20 to-slate-700/5 text-slate-400 border-slate-500/20',
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-black uppercase tracking-wider text-slate-200">Platform Overview</h2>
                <button onClick={load} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl transition-all active:scale-95 text-slate-300">
                    <RefreshCw className="w-4 h-4" />
                </button>
            </div>

            {/* Metric cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {cards.map(c => {
                    const Icon = c.icon
                    return (
                        <div key={c.label} className={`glass rounded-3xl p-6 border bg-gradient-to-br ${colorMap[c.color]}`}>
                            <div className="flex items-center justify-between mb-4">
                                <span className="text-[10px] font-black uppercase text-slate-400 tracking-wider">{c.label}</span>
                                <Icon className="w-4 h-4" />
                            </div>
                            <h3 className="text-3xl font-black text-white">{c.value}</h3>
                            <p className="text-[11px] text-slate-500 mt-1">{c.sub}</p>
                        </div>
                    )
                })}
            </div>

            {/* Plan distribution + revenue breakdown */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center gap-2 mb-5">
                        <Boxes className="w-4 h-4 text-blue-400" />
                        <h3 className="text-sm font-black uppercase tracking-wider text-slate-200">Plan Distribution</h3>
                    </div>
                    <PlanBar label="Free" count={stats.plans.FREE} total={stats.tenants.owners} color="bg-slate-500" />
                    <PlanBar label="Pro" count={stats.plans.PRO} total={stats.tenants.owners} color="bg-blue-500" />
                    <PlanBar label="Enterprise" count={stats.plans.ENTERPRISE} total={stats.tenants.owners} color="bg-purple-500" />
                </div>

                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center gap-2 mb-5">
                        <TrendingUp className="w-4 h-4 text-emerald-400" />
                        <h3 className="text-sm font-black uppercase tracking-wider text-slate-200">Cluster Status</h3>
                    </div>
                    {Object.keys(stats.clusters.byStatus).length === 0 ? (
                        <p className="text-sm text-slate-500">No clusters deployed yet.</p>
                    ) : (
                        <div className="space-y-2">
                            {Object.entries(stats.clusters.byStatus).map(([status, count]) => (
                                <div key={status} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                                    <span className="text-sm text-slate-300 capitalize">{status}</span>
                                    <span className="text-sm font-black text-white">{count}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Quick actions */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <QuickAction icon={Users} label="Manage Tenants" onClick={() => onGoto('tenants')} />
                <QuickAction icon={Server} label="View All Clusters" onClick={() => onGoto('clusters')} />
                <QuickAction icon={Activity} label="System Health" onClick={() => onGoto('system')} />
            </div>
        </div>
    )
}

function PlanBar({ label, count, total, color }) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0
    return (
        <div className="mb-4 last:mb-0">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-slate-300">{label}</span>
                <span className="text-xs font-black text-white">{count} <span className="text-slate-500 font-normal">({pct}%)</span></span>
            </div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
            </div>
        </div>
    )
}

function QuickAction({ icon: Icon, label, onClick }) {
    return (
        <button onClick={onClick} className="glass rounded-2xl p-5 border border-white/5 hover:border-white/20 transition-all flex items-center justify-between group">
            <span className="flex items-center gap-3 text-sm font-bold text-slate-200">
                <Icon className="w-4 h-4 text-purple-400" />
                {label}
            </span>
            <ArrowUpRight className="w-4 h-4 text-slate-500 group-hover:text-white transition-colors" />
        </button>
    )
}

/* ─── Clusters ──────────────────────────────────────────────────────────── */
function ClustersSection() {
    const { toast } = useToast()
    const [clusters, setClusters] = useState([])
    const [loading, setLoading] = useState(true)

    const load = async () => {
        setLoading(true)
        try {
            const res = await apiFetch('/api/superadmin/clusters')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to load clusters')
            setClusters(Array.isArray(data) ? data : [])
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { load() }, [])

    if (loading) return <Loading label="Loading all clusters..." />

    const statusColor = (s) => {
        if (s === 'healthy' || s === 'completed') return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
        if (s === 'failed') return 'bg-red-500/10 text-red-400 border-red-500/20'
        if (s === 'cancelled') return 'bg-amber-500/10 text-amber-400 border-amber-500/20'
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
    }

    return (
        <div className="glass rounded-3xl border border-white/5 overflow-hidden animate-in fade-in duration-300">
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-lg font-black uppercase tracking-wider text-slate-200">All Clusters ({clusters.length})</h3>
                <button onClick={load} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-slate-300"><RefreshCw className="w-4 h-4" /></button>
            </div>
            {clusters.length === 0 ? (
                <div className="p-12 text-center text-slate-500">No clusters deployed across any tenant yet.</div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-300">
                        <thead className="bg-black/20 text-slate-500 border-b border-white/5 text-[10px] font-black uppercase tracking-widest">
                            <tr>
                                <th className="px-6 py-4">Cluster</th>
                                <th className="px-6 py-4">Owner</th>
                                <th className="px-6 py-4">Plan</th>
                                <th className="px-6 py-4">Version</th>
                                <th className="px-6 py-4">Nodes</th>
                                <th className="px-6 py-4">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {clusters.map(c => (
                                <tr key={c.id} className="hover:bg-white/[0.02] transition-colors">
                                    <td className="px-6 py-4 font-bold text-white">{c.clusterName || c.id}</td>
                                    <td className="px-6 py-4">
                                        <div className="text-slate-200">{c.ownerName}</div>
                                        <div className="text-[10px] text-slate-500">{c.ownerEmail}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`text-[10px] font-black ${c.ownerPlan === 'ENTERPRISE' ? 'text-purple-400' : c.ownerPlan === 'PRO' ? 'text-blue-400' : 'text-slate-400'}`}>{c.ownerPlan}</span>
                                    </td>
                                    <td className="px-6 py-4 font-mono text-xs text-slate-400">{c.k8sVersion || '—'}</td>
                                    <td className="px-6 py-4 font-mono">{c.nodeCount}</td>
                                    <td className="px-6 py-4">
                                        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${statusColor(c.status)}`}>{c.status}</span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

/* ─── Incidents ─────────────────────────────────────────────────────────── */
function IncidentsSection() {
    const { toast } = useToast()
    const [incidents, setIncidents] = useState([])
    const [loading, setLoading] = useState(true)

    const load = async () => {
        setLoading(true)
        try {
            const res = await apiFetch('/api/incidents')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to load incidents')
            setIncidents(Array.isArray(data) ? data : (data.incidents || []))
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { load() }, [])

    if (loading) return <Loading label="Loading incidents..." />

    return (
        <div className="glass rounded-3xl border border-white/5 overflow-hidden animate-in fade-in duration-300">
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-lg font-black uppercase tracking-wider text-slate-200">Platform Incidents ({incidents.length})</h3>
                <button onClick={load} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-slate-300"><RefreshCw className="w-4 h-4" /></button>
            </div>
            {incidents.length === 0 ? (
                <div className="p-12 text-center text-slate-500 flex flex-col items-center gap-3">
                    <CheckCircle2 className="w-10 h-10 text-emerald-500" />
                    No incidents — everything is healthy.
                </div>
            ) : (
                <div className="divide-y divide-white/5">
                    {incidents.slice(0, 50).map((inc, i) => (
                        <div key={inc.id || i} className="p-5 flex items-start gap-4 hover:bg-white/[0.02]">
                            <div className={`mt-0.5 ${inc.resolved ? 'text-emerald-500' : 'text-red-500'}`}>
                                {inc.resolved ? <CheckCircle2 className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-bold text-white text-sm">{inc.title || inc.type || 'Incident'}</span>
                                    {inc.severity && <span className="text-[10px] font-black uppercase text-amber-400">{inc.severity}</span>}
                                </div>
                                <p className="text-xs text-slate-400 mt-0.5">{inc.message || inc.description}</p>
                                <p className="text-[10px] text-slate-600 mt-1">
                                    {inc.clusterName && <span className="mr-2">Cluster: {inc.clusterName}</span>}
                                    {inc.timestamp && new Date(inc.timestamp).toLocaleString()}
                                </p>
                            </div>
                            <span className={`shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded-full border ${inc.resolved ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                                {inc.resolved ? 'Resolved' : 'Open'}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

/* ─── System ────────────────────────────────────────────────────────────── */
function SystemSection() {
    const { toast } = useToast()
    const [health, setHealth] = useState(null)
    const [loading, setLoading] = useState(true)

    const load = async () => {
        setLoading(true)
        try {
            const res = await apiFetch('/api/health/detailed')
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to load system health')
            setHealth(data)
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { load() }, [])

    if (loading) return <Loading label="Reading server metrics..." />
    if (!health) return null

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-black uppercase tracking-wider text-slate-200">System Health</h2>
                <button onClick={load} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-slate-300"><RefreshCw className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center gap-2 mb-5"><Cpu className="w-4 h-4 text-blue-400" /><h3 className="text-sm font-black uppercase tracking-wider text-slate-200">Compute</h3></div>
                    <Row label="CPU Cores" value={health.cpu?.cores} />
                    <Row label="CPU Model" value={health.cpu?.model} />
                    <Row label="Load Avg" value={health.cpu?.loadAverage?.map(n => n.toFixed(2)).join(' · ')} />
                    <Row label="Uptime" value={health.uptime?.formatted} />
                </div>
                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center gap-2 mb-5"><Database className="w-4 h-4 text-purple-400" /><h3 className="text-sm font-black uppercase tracking-wider text-slate-200">Memory</h3></div>
                    <Row label="Heap Used" value={health.memory?.process?.heapUsed} />
                    <Row label="Heap Total" value={health.memory?.process?.heapTotal} />
                    <Row label="Heap %" value={health.memory?.process?.heapUsedPercentage} />
                    <Row label="RSS" value={health.memory?.process?.rss} />
                </div>
            </div>
            <div className="glass rounded-2xl p-5 border border-white/5 text-xs text-slate-500 flex items-center gap-2">
                <Zap className="w-4 h-4 text-emerald-400" />
                For config backups, go to <span className="text-slate-300 font-bold">Settings → Config Backups</span>.
            </div>
        </div>
    )
}

function Row({ label, value }) {
    return (
        <div className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0">
            <span className="text-xs text-slate-400">{label}</span>
            <span className="text-xs font-bold text-slate-200 text-right max-w-[60%] truncate">{value ?? '—'}</span>
        </div>
    )
}

/* ─── shared ────────────────────────────────────────────────────────────── */
function Loading({ label }) {
    return (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
            <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
            <p className="text-xs tracking-widest text-slate-500 uppercase font-black">{label}</p>
        </div>
    )
}
