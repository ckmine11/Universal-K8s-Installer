import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { useToast } from '../components/ToastProvider'
import {
    CheckCircle2, XCircle, AlertTriangle, Loader2, Activity, EyeOff, RotateCcw, WifiOff, Compass, ShieldAlert, Wrench,
    Clock, Gauge, SlidersHorizontal, X, Search, BellOff, Hand, Play, Wifi, Pause, ChevronRight, FileText, History, Lightbulb, Link2
} from 'lucide-react'
import { explorerResourceLink, explorerPages } from '../components/explorer/explorerLinks'
import PageHeader from '../components/ui/PageHeader'

const CLOSED = new Set(['resolved', 'cleared'])
const SEV = {
    critical: { label: 'Critical', bar: 'bg-red-400', chip: 'text-red-300 bg-red-500/10 border-red-400/25', dot: 'bg-red-400' },
    warning: { label: 'Warning', bar: 'bg-amber-400', chip: 'text-amber-300 bg-amber-500/10 border-amber-400/25', dot: 'bg-amber-400' },
    info: { label: 'Info', bar: 'bg-blue-400', chip: 'text-blue-200 bg-blue-500/10 border-blue-400/25', dot: 'bg-blue-400' }
}
const STATUS = {
    detecting: { cls: 'text-blue-300', Icon: Loader2, spin: true, text: 'Analyzing…' },
    remediating: { cls: 'text-amber-300', Icon: RotateCcw, spin: true, text: 'Applying fix…' },
    resolved: { cls: 'text-emerald-300', Icon: CheckCircle2, text: 'Fixed automatically' },
    cleared: { cls: 'text-emerald-300/80', Icon: CheckCircle2, text: 'Problem went away' },
    failed: { cls: 'text-red-300', Icon: XCircle, text: 'Auto-fix failed — needs attention' },
    unresolved: { cls: 'text-slate-300', Icon: AlertTriangle, text: 'Needs attention' }
}
const CATEGORY = { cluster: 'Cluster', node: 'Nodes', 'control-plane': 'Control plane', pod: 'Pods', workload: 'Workloads', storage: 'Storage' }

function ago(iso) {
    if (!iso) return ''
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    return mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`
}
const dur = (m) => m == null ? '—' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 6) / 10}h` : `${Math.round(m / 144) / 10}d`
const sevOf = (i, catalog) => i.severity || catalog?.[i.reason]?.severity || 'warning'

export default function Incidents() {
    const { user } = useAuth()
    const { toast } = useToast()
    const canAct = can(user?.role, 'incident:act')
    const canManage = can(user?.role, 'healing:manage')
    const [incidents, setIncidents] = useState([])
    const [monitor, setMonitor] = useState(null)
    const [stats, setStats] = useState(null)
    const [catalog, setCatalog] = useState(null)
    const [loading, setLoading] = useState(true)
    const [view, setView] = useState('open')        // open | all
    const [sevFilter, setSevFilter] = useState('')
    const [clusterFilter, setClusterFilter] = useState('')
    const [q, setQ] = useState('')
    const [openId, setOpenId] = useState(null)
    const [policyOpen, setPolicyOpen] = useState(false)
    const [explorerOn, setExplorerOn] = useState(new Set())

    const load = async () => {
        try {
            const [i, m, s] = await Promise.all([apiFetch('/api/incidents'), apiFetch('/api/incidents/monitoring'), apiFetch('/api/incidents/stats?days=7')])
            if (i.ok) setIncidents(await i.json())
            if (m.ok) setMonitor(await m.json())
            if (s.ok) setStats(await s.json())
        } catch (e) { console.error('Failed to load incidents', e) } finally { setLoading(false) }
    }
    const loadCatalog = () => apiFetch('/api/incidents/catalog').then(r => r.ok ? r.json() : null).then(c => c && setCatalog(c)).catch(() => { })

    useEffect(() => {
        load(); loadCatalog()
        const t = setInterval(load, 10000)
        apiFetch('/api/clusters/list').then(r => r.ok ? r.json() : []).then(list => {
            setExplorerOn(new Set((Array.isArray(list) ? list : []).filter(c => c.addons?.explorer).map(c => c.id)))
        }).catch(() => { })
        return () => clearInterval(t)
    }, [])

    const cat = catalog?.catalog || {}
    const labelOf = (r) => cat[r]?.label || r

    const act = async (path, body, ok) => {
        const r = await apiFetch(path, { method: path.includes('/maintenance/') ? 'PUT' : 'POST', body: body ? JSON.stringify(body) : undefined })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) return toast({ title: 'Not done', message: j.error || 'Request failed', type: 'error' })
        if (ok) toast({ title: ok, type: 'success' })
        load()
    }

    // Where to look in the Explorer: the pod, the node, or the cluster's timeline
    const investigate = (inc) => {
        if (!explorerOn.has(inc.clusterId)) return null
        if (inc.namespace && inc.target && !inc.target.includes('/')) return explorerResourceLink(inc.clusterId, inc.reason === 'PVCPending' ? 'PersistentVolumeClaim' : inc.reason === 'JobFailed' ? 'Job' : 'Pod', inc.namespace, inc.target)
        if (inc.category === 'node' && inc.target) return explorerResourceLink(inc.clusterId, 'Node', '', inc.target)
        return explorerPages(inc.clusterId).timeline
    }

    // filters + root-cause grouping (consequences listed under their cause)
    const filtered = useMemo(() => {
        const t = q.trim().toLowerCase()
        return incidents.filter(i =>
            (view === 'all' || !CLOSED.has(i.status)) &&
            (!sevFilter || sevOf(i, cat) === sevFilter) &&
            (!clusterFilter || i.clusterId === clusterFilter) &&
            (!t || `${i.message} ${i.target} ${i.namespace || ''} ${labelOf(i.reason)} ${i.clusterName}`.toLowerCase().includes(t)))
    }, [incidents, view, sevFilter, clusterFilter, q, catalog])
    const children = useMemo(() => {
        const m = {}
        for (const i of filtered) if (i.causedBy) (m[i.causedBy] ||= []).push(i)
        return m
    }, [filtered])
    const ids = new Set(filtered.map(i => i.id))
    const roots = filtered.filter(i => !i.causedBy || !ids.has(i.causedBy))
        .sort((a, b) => (CLOSED.has(a.status) - CLOSED.has(b.status)) || (['critical', 'warning', 'info'].indexOf(sevOf(a, cat)) - ['critical', 'warning', 'info'].indexOf(sevOf(b, cat))) || (new Date(b.lastSeen) - new Date(a.lastSeen)))

    const watched = monitor?.clusters || []
    const offline = watched.filter(c => !c.connected && !c.maintenance)
    const current = incidents.find(i => i.id === openId)

    return (
        <div className="max-w-7xl mx-auto space-y-6">
            <PageHeader icon={ShieldAlert} eyebrow="Overview" title="Incidents & Auto-Healing"
                description="Nodes, pods, workloads, storage and the control plane are checked every 1–2 minutes. Known problems are fixed automatically; everything else is diagnosed and explained."
                actions={<>
                    {canManage && <button onClick={() => setPolicyOpen(true)} className="kz-btn-ghost"><SlidersHorizontal className="w-4 h-4" /> Policies</button>}
                    <button onClick={load} className="kz-btn-ghost" aria-label="Refresh"><RotateCcw className="w-4 h-4" /></button>
                </>} />

            {/* Numbers */}
            <section className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                <Stat icon={AlertTriangle} label="Open now" value={stats?.open.total ?? '—'} tone={stats?.open.critical ? 'from-red-400/30' : 'from-amber-400/20'}
                    sub={stats ? `${stats.open.critical} critical · ${stats.open.warning} warning` : ''} />
                <Stat icon={Wrench} label="Fixed automatically" value={stats?.autoFixed ?? '—'} tone="from-emerald-400/25" sub={stats ? `${stats.cleared} went away by themselves` : ''} />
                <Stat icon={Gauge} label="Auto-fix success" value={stats?.fixRate == null ? '—' : `${stats.fixRate}%`} tone="from-blue-400/25" sub={stats?.failed ? `${stats.failed} needed a person` : 'last 7 days'} />
                <Stat icon={Clock} label="Mean time to recover" value={dur(stats?.mttrMinutes)} tone="from-violet-400/25" sub="detected → closed" />
            </section>

            <section className="grid gap-4 lg:grid-cols-3">
                <div className="kz-card p-5 lg:col-span-2">
                    <div className="flex items-center justify-between">
                        <h3 className="font-display font-semibold text-white">Last 7 days</h3>
                        <div className="flex gap-3 text-[11px] text-slate-400">{Object.entries(SEV).map(([k, v]) => <span key={k} className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${v.dot}`} />{v.label}</span>)}</div>
                    </div>
                    <Bars daily={stats?.daily || []} />
                </div>
                <div className="kz-card p-5">
                    <h3 className="font-display font-semibold text-white">Most frequent</h3>
                    <div className="mt-4 space-y-2.5">
                        {(stats?.top || []).length === 0 && <p className="text-sm text-slate-500">Nothing in the last 7 days.</p>}
                        {(stats?.top || []).map(t => (
                            <div key={t.reason}>
                                <div className="flex justify-between text-xs"><span className="text-slate-300">{t.label}</span><span className="text-slate-400 tabular-nums">{t.count}</span></div>
                                <div className="mt-1 h-1.5 rounded-full bg-white/5 overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-blue-400 to-violet-400" style={{ width: `${(t.count / stats.top[0].count) * 100}%` }} /></div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Watched clusters */}
            <section className="kz-card p-5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h3 className="font-display font-semibold text-white">Watched clusters</h3>
                    <span className="text-xs text-slate-400">{watched.length} watched · {monitor?.connected || 0} connected</span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {watched.length === 0 && <p className="text-sm text-slate-500">No cluster is watched yet{monitor?.skipped?.length ? ' — see below why' : ''}.</p>}
                    {watched.map(c => {
                        const pc = stats?.perCluster?.find(p => p.clusterId === c.clusterId)
                        return (
                            <div key={c.clusterId} className={`rounded-2xl border p-3 ${c.maintenance ? 'border-slate-400/20 bg-slate-500/[0.04]' : 'border-white/[0.07] bg-white/[0.02]'}`}>
                                <div className="flex items-center gap-3">
                                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${c.maintenance ? 'bg-slate-500' : c.connected ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.6)]' : 'bg-amber-400 animate-pulse'}`} />
                                    <div className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2 min-w-0">
                                            <Link to={`/cluster/${c.clusterId}`} className="text-sm font-semibold text-white truncate hover:text-blue-200">{c.clusterName}</Link>
                                            {c.maintenance && <span className="shrink-0 rounded-full border border-slate-400/30 bg-slate-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-300">Maintenance</span>}
                                        </span>
                                        <span className="block text-[11px] text-slate-400 truncate" title={c.maintenance ? `until ${new Date(c.maintenance.until).toLocaleString()}` : ''}>
                                            {c.maintenance ? `Paused until ${new Date(c.maintenance.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${c.maintenance.by ? ` · by ${c.maintenance.by}` : ''}` : c.connected ? `Checked ${ago(c.lastCheck) || 'just now'}` : 'Unreachable — retrying'}
                                            {pc?.open ? ` · ${pc.open} open` : ''}
                                        </span>
                                    </div>
                                    {canAct && <MaintenanceMenu c={c} onSet={(h) => act(`/api/incidents/maintenance/${c.clusterId}`, { hours: h }, h ? `Paused for ${h} h — no checks, fixes or alerts` : `Watching ${c.clusterName} again`)} />}
                                </div>
                                {c.maintenance && (
                                    <div className="mt-2.5 flex items-center gap-2 pl-5">
                                        <span className="flex-1 text-[11px] text-slate-500">No checks, fixes or alerts while paused.</span>
                                        {canAct && (
                                            <button onClick={() => act(`/api/incidents/maintenance/${c.clusterId}`, { hours: 0 }, `Watching ${c.clusterName} again`)}
                                                className="flex items-center gap-1.5 shrink-0 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20">
                                                <Play className="w-3.5 h-3.5" /> Resume now
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
                {offline.length > 0 && (
                    <p className="mt-3 flex items-start gap-2 text-xs text-amber-200"><WifiOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        Can’t reach {offline.map(c => c.clusterName).join(', ')} — problems there are detected once the connection is back. Servers in a private network need their <Link to="/agents" className="underline">Gateway Agent</Link> online.</p>
                )}
                {monitor?.skipped?.length > 0 && (
                    <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-3 text-xs">
                        <p className="font-semibold text-slate-200 flex items-center gap-1.5"><EyeOff className="w-3.5 h-3.5" /> Not watched</p>
                        <ul className="mt-1.5 space-y-1 text-slate-400">
                            {monitor.skipped.map(c => <li key={c.clusterId}><Link to={`/cluster/${c.clusterId}`} className="font-semibold text-blue-300 hover:text-white">{c.clusterName}</Link> — {c.reason}.</li>)}
                        </ul>
                    </div>
                )}
            </section>

            {/* Incident list */}
            <section>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    <div className="flex p-1 rounded-xl border border-white/10 bg-black/25">
                        {[['open', `Open (${incidents.filter(i => !CLOSED.has(i.status)).length})`], ['all', `All 7 days (${incidents.length})`]].map(([k, l]) => (
                            <button key={k} onClick={() => setView(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${view === k ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>{l}</button>
                        ))}
                    </div>
                    <div className="flex gap-1">
                        {Object.entries(SEV).map(([k, v]) => (
                            <button key={k} onClick={() => setSevFilter(f => f === k ? '' : k)} className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold ${sevFilter === k ? v.chip : 'border-white/10 text-slate-400 hover:text-white'}`}>{v.label}</button>
                        ))}
                    </div>
                    {watched.length > 1 && (
                        <select value={clusterFilter} onChange={e => setClusterFilter(e.target.value)} className="rounded-lg px-2.5 py-1.5 text-xs text-slate-200 !bg-black/25">
                            <option value="">All clusters</option>
                            {watched.map(c => <option key={c.clusterId} value={c.clusterId}>{c.clusterName}</option>)}
                        </select>
                    )}
                    <div className="relative ml-auto w-full sm:w-64">
                        <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search incidents…" className="kz-input !py-2 !pl-9 !text-xs" />
                    </div>
                </div>

                {loading ? (
                    <div className="kz-card py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>
                ) : roots.length === 0 ? (
                    <div className="kz-card py-16 text-center">
                        <div className="inline-flex w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-400/20 items-center justify-center"><CheckCircle2 className="w-7 h-7 text-emerald-300" /></div>
                        <h3 className="mt-4 font-display text-lg font-semibold text-white">{watched.length ? 'All clear' : 'Nothing to watch yet'}</h3>
                        <p className="mt-1 text-sm text-slate-400">{watched.length ? (view === 'open' ? `No open problems on ${watched.length === 1 ? 'your cluster' : `your ${watched.length} clusters`}.` : 'No incidents match these filters.') : 'Monitoring starts within a minute for every installed, running cluster.'}</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {roots.map(inc => (
                            <IncidentRow key={inc.id} inc={inc} kids={children[inc.id] || []} cat={cat} labelOf={labelOf} onOpen={setOpenId} />
                        ))}
                    </div>
                )}
            </section>

            {current && createPortal(
                <IncidentDrawer inc={current} meta={cat[current.reason]} label={labelOf(current.reason)} sev={sevOf(current, cat)}
                    kids={incidents.filter(i => i.causedBy === current.id)} cause={incidents.find(i => i.id === current.causedBy)}
                    labelOf={labelOf} canAct={canAct} explorer={investigate(current)} onOpen={setOpenId}
                    onClose={() => setOpenId(null)}
                    onAck={() => act(`/api/incidents/${current.id}/ack`, null, 'Acknowledged')}
                    onRun={() => act(`/api/incidents/${current.id}/run`, null, 'Fix started — follow it in the timeline')}
                    onMute={(h) => act(`/api/incidents/${current.id}/mute`, { hours: h }, h ? `Muted for ${h} h` : 'Unmuted')} />,
                document.body)}
            {policyOpen && catalog && createPortal(
                <PolicyDialog catalog={catalog} onClose={() => setPolicyOpen(false)} onSaved={(p) => { setCatalog(c => ({ ...c, policies: p })); setPolicyOpen(false); toast({ title: 'Policies saved', type: 'success' }) }} />,
                document.body)}
        </div>
    )
}

function Stat({ icon: Icon, label, value, sub, tone }) {
    return (
        <div className="relative overflow-hidden kz-card !rounded-2xl p-4">
            <div className={`absolute -top-10 -right-8 w-28 h-28 rounded-full bg-gradient-to-br ${tone} to-transparent blur-2xl`} />
            <Icon className="relative w-4 h-4 text-slate-400" />
            <div className="relative mt-3 font-display text-3xl font-bold text-white tabular-nums">{value}</div>
            <div className="relative text-xs font-semibold text-slate-300">{label}</div>
            {sub && <div className="relative mt-0.5 text-[11px] text-slate-500 truncate">{sub}</div>}
        </div>
    )
}

function Bars({ daily }) {
    const max = Math.max(1, ...daily.map(d => d.critical + d.warning + d.info))
    return (
        <div className="mt-5 flex items-end gap-2 h-36">
            {daily.map(d => {
                const total = d.critical + d.warning + d.info
                return (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5 min-w-0" title={`${d.day}: ${d.critical} critical, ${d.warning} warning, ${d.info} info`}>
                        <span className="text-[10px] text-slate-500 tabular-nums">{total || ''}</span>
                        <div className="w-full max-w-[42px] flex flex-col-reverse rounded-lg overflow-hidden bg-white/[0.03]" style={{ height: `${Math.max(4, (total / max) * 100)}px` }}>
                            {d.critical > 0 && <div className="bg-red-400/80" style={{ flex: d.critical }} />}
                            {d.warning > 0 && <div className="bg-amber-400/80" style={{ flex: d.warning }} />}
                            {d.info > 0 && <div className="bg-blue-400/80" style={{ flex: d.info }} />}
                        </div>
                        <span className="text-[10px] text-slate-500">{new Date(d.day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short' })}</span>
                    </div>
                )
            })}
        </div>
    )
}

function StatusLine({ inc }) {
    const m = STATUS[inc.status] || STATUS.unresolved
    return (
        <span className={`flex items-start gap-1.5 text-xs ${m.cls}`}>
            <m.Icon className={`w-3.5 h-3.5 shrink-0 mt-px ${m.spin ? 'animate-spin' : ''}`} />
            <span className="line-clamp-2">{inc.details || m.text}</span>
        </span>
    )
}

function IncidentRow({ inc, kids, cat, labelOf, onOpen }) {
    const [expand, setExpand] = useState(false)
    const sev = SEV[sevOf(inc, cat)] || SEV.warning
    const closed = CLOSED.has(inc.status)
    return (
        <div className={`relative kz-card !rounded-2xl overflow-hidden ${closed ? 'opacity-60' : ''}`}>
            <span className={`absolute left-0 top-0 bottom-0 w-1 ${sev.bar}`} />
            <button onClick={() => onOpen(inc.id)} className="w-full text-left p-4 pl-5 hover:bg-white/[0.02] transition">
                <div className="flex items-start gap-3 flex-wrap">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${sev.chip}`}>{sev.label}</span>
                            <span className="font-semibold text-white">{labelOf(inc.reason)}</span>
                            <span className="font-mono text-xs text-slate-400 truncate">{inc.namespace ? `${inc.namespace}/` : ''}{inc.target}</span>
                            {inc.muted && <span className="kz-chip !py-0 text-slate-400"><BellOff className="w-3 h-3" /> muted</span>}
                            {inc.ackBy && <span className="kz-chip !py-0 text-slate-400"><Hand className="w-3 h-3" /> {inc.ackBy}</span>}
                        </div>
                        <p className="mt-1 text-xs text-slate-400 line-clamp-1">{inc.message}</p>
                        <div className="mt-2"><StatusLine inc={inc} /></div>
                    </div>
                    <div className="text-right shrink-0">
                        <p className="text-xs font-semibold text-slate-300">{inc.clusterName}</p>
                        <p className="text-[11px] text-slate-500">{ago(inc.timestamp)}{inc.count > 1 ? ` · seen ${inc.count}×` : ''}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-600 self-center hidden sm:block" />
                </div>
            </button>
            {kids.length > 0 && (
                <div className="border-t border-white/[0.06] px-5 py-2">
                    <button onClick={() => setExpand(e => !e)} className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 hover:text-white">
                        <Link2 className="w-3.5 h-3.5" /> {kids.length} related problem{kids.length > 1 ? 's' : ''} caused by this {expand ? '▴' : '▾'}
                    </button>
                    {expand && (
                        <ul className="mt-2 space-y-1">
                            {kids.map(k => (
                                <li key={k.id}><button onClick={() => onOpen(k.id)} className="text-xs text-slate-300 hover:text-white">
                                    {labelOf(k.reason)} · <span className="font-mono text-slate-400">{k.namespace ? `${k.namespace}/` : ''}{k.target}</span>
                                </button></li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}

function MaintenanceMenu({ c, onSet }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="relative">
            <button onClick={() => setOpen(o => !o)} className={`p-2 rounded-lg ${c.maintenance ? 'text-blue-200 bg-blue-500/10' : 'text-slate-400 hover:text-white hover:bg-white/5'}`} title="Maintenance mode" aria-label="Maintenance mode">
                <Pause className="w-4 h-4" />
            </button>
            {open && (
                <div className="absolute right-0 top-10 z-20 w-56 kz-card !rounded-xl p-1.5 kz-rise" onMouseLeave={() => setOpen(false)}>
                    <p className="px-3 py-2 text-[11px] text-slate-400">No checks, fixes or alerts while you work on it.</p>
                    {[1, 4, 24].map(h => <button key={h} onClick={() => { setOpen(false); onSet(h) }} className="w-full text-left rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-white/5">Pause for {h} hour{h > 1 ? 's' : ''}</button>)}
                    {c.maintenance && <button onClick={() => { setOpen(false); onSet(0) }} className="w-full text-left rounded-lg px-3 py-2 text-sm text-emerald-300 hover:bg-emerald-500/10">End maintenance now</button>}
                </div>
            )}
        </div>
    )
}

function IncidentDrawer({ inc, meta, label, sev, kids, cause, labelOf, canAct, explorer, onOpen, onClose, onAck, onRun, onMute }) {
    const s = SEV[sev] || SEV.warning
    const closed = CLOSED.has(inc.status)
    useEffect(() => {
        const k = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
    }, [onClose])
    return (
        <div className="fixed inset-0 z-[90] flex justify-end" role="dialog" aria-modal="true" aria-label={label}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            <aside className="relative w-full max-w-xl h-full overflow-y-auto bg-[#080d19]/95 border-l border-white/10 backdrop-blur-2xl kz-rise">
                <div className="sticky top-0 z-10 flex items-start gap-3 p-5 border-b border-white/[0.07] bg-[#080d19]/95 backdrop-blur-xl">
                    <div className="min-w-0 flex-1">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${s.chip}`}>{s.label}</span>
                        <h2 className="mt-2 font-display text-xl font-bold text-white">{label}</h2>
                        <p className="mt-0.5 font-mono text-xs text-slate-400 break-all">{inc.clusterName} · {inc.namespace ? `${inc.namespace}/` : ''}{inc.target}</p>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>

                <div className="p-5 space-y-5">
                    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
                        <p className="text-sm text-slate-200 break-words">{inc.message}</p>
                        <div className="mt-3"><StatusLine inc={inc} /></div>
                        <p className="mt-3 text-[11px] text-slate-500">First seen {new Date(inc.timestamp).toLocaleString()} · last {ago(inc.lastSeen)}{inc.count > 1 ? ` · seen ${inc.count}×` : ''}</p>
                    </div>

                    {cause && (
                        <button onClick={() => onOpen(cause.id)} className="w-full text-left rounded-2xl border border-amber-400/25 bg-amber-500/5 p-4 text-sm text-amber-100">
                            <span className="flex items-center gap-2 font-semibold"><Link2 className="w-4 h-4" /> Caused by: {labelOf(cause.reason)} on {cause.target}</span>
                            <span className="block mt-1 text-xs text-amber-200/80">This clears by itself once that problem is fixed.</span>
                        </button>
                    )}

                    {canAct && !closed && (
                        <div className="flex flex-wrap gap-2">
                            {meta?.fixable && <button onClick={onRun} className="kz-btn-primary !py-2"><Play className="w-4 h-4" /> Run fix now</button>}
                            {!inc.ackBy && <button onClick={onAck} className="kz-btn-ghost !py-2"><Hand className="w-4 h-4" /> Acknowledge</button>}
                            {inc.muted
                                ? <button onClick={() => onMute(0)} className="kz-btn-ghost !py-2"><Wifi className="w-4 h-4" /> Unmute</button>
                                : <button onClick={() => onMute(24)} className="kz-btn-ghost !py-2"><BellOff className="w-4 h-4" /> Mute 24 h</button>}
                            {explorer && <a href={explorer} target="_blank" rel="noopener noreferrer" className="kz-btn-ghost !py-2"><Compass className="w-4 h-4" /> Explorer</a>}
                        </div>
                    )}

                    {meta && (
                        <div className="grid gap-3">
                            <Block icon={Wrench} title="What KubeEZ does">
                                {meta.fixable ? meta.fix : 'Diagnoses it and collects evidence — this one needs a decision by a person.'}
                                {meta.fixable && meta.policy === 'notify' && <span className="block mt-1 text-slate-500">Alert only by default — start it with “Run fix now”.</span>}
                            </Block>
                            <Block icon={Lightbulb} title="What you can check">{meta.suggestion}</Block>
                        </div>
                    )}

                    {inc.evidence?.length > 0 && (
                        <div>
                            <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><FileText className="w-4 h-4 text-blue-300" /> Evidence</h3>
                            <div className="mt-2 space-y-3">
                                {inc.evidence.map(e => (
                                    <div key={e.title}>
                                        <p className="text-[11px] font-semibold text-slate-400">{e.title} · {ago(e.at)}</p>
                                        <pre className="mt-1 max-h-60 overflow-auto rounded-xl border border-white/[0.07] bg-black/40 p-3 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words">{e.text}</pre>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {kids.length > 0 && (
                        <div>
                            <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Link2 className="w-4 h-4 text-blue-300" /> Caused by this ({kids.length})</h3>
                            <ul className="mt-2 space-y-1">{kids.map(k => <li key={k.id}><button onClick={() => onOpen(k.id)} className="text-xs text-slate-300 hover:text-white">{labelOf(k.reason)} · <span className="font-mono text-slate-400">{k.namespace ? `${k.namespace}/` : ''}{k.target}</span></button></li>)}</ul>
                        </div>
                    )}

                    <div>
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><History className="w-4 h-4 text-blue-300" /> Timeline</h3>
                        <ol className="mt-3 relative border-l border-white/10 ml-1.5 space-y-3">
                            {[...(inc.timeline || [])].reverse().map((t, k) => (
                                <li key={k} className="pl-4 relative">
                                    <span className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ${t.kind === 'resolved' || t.kind === 'cleared' ? 'bg-emerald-400' : t.kind === 'failed' ? 'bg-red-400' : t.kind === 'remediating' || t.kind === 'manual' ? 'bg-amber-400' : 'bg-blue-400'}`} />
                                    <p className="text-xs text-slate-200 break-words">{t.text || t.kind}</p>
                                    <p className="text-[10px] text-slate-500">{new Date(t.at).toLocaleString()}</p>
                                </li>
                            ))}
                            {!inc.timeline?.length && <li className="pl-4 text-xs text-slate-500">No history recorded for this older incident.</li>}
                        </ol>
                    </div>
                </div>
            </aside>
        </div>
    )
}

function Block({ icon: Icon, title, children }) {
    return (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <p className="flex items-center gap-2 text-xs font-semibold text-slate-300"><Icon className="w-3.5 h-3.5 text-blue-300" /> {title}</p>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">{children}</p>
        </div>
    )
}

function PolicyDialog({ catalog, onClose, onSaved }) {
    const [p, setP] = useState(catalog.policies)
    const [busy, setBusy] = useState(false)
    const groups = {}
    for (const [k, v] of Object.entries(catalog.catalog)) (groups[v.category] ||= []).push([k, v])
    const save = async () => {
        setBusy(true)
        try {
            const r = await apiFetch('/api/incidents/policy', { method: 'PUT', body: JSON.stringify({ policies: p }) })
            const j = await r.json().catch(() => ({}))
            if (r.ok) onSaved(j.policies)
        } finally { setBusy(false) }
    }
    const opt = { auto: 'Fix automatically', notify: 'Alert only', off: 'Off' }
    return (
        <div className="fixed inset-0 z-[95] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Auto-healing policies">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-2xl max-h-[88vh] flex flex-col kz-card overflow-hidden kz-rise">
                <div className="flex items-center gap-3 p-5 border-b border-white/[0.07]">
                    <SlidersHorizontal className="w-5 h-5 text-blue-300" />
                    <div><h2 className="font-display text-lg font-bold text-white">Auto-healing policies</h2><p className="text-xs text-slate-400">What happens when each problem is found — for every cluster of this workspace.</p></div>
                    <button onClick={onClose} className="ml-auto p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>
                <div className="overflow-y-auto p-5 space-y-5">
                    {Object.entries(groups).map(([g, items]) => (
                        <div key={g}>
                            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 mb-2">{CATEGORY[g] || g}</p>
                            <div className="space-y-1.5">
                                {items.map(([k, v]) => (
                                    <div key={k} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 flex-wrap">
                                        <span className={`w-2 h-2 rounded-full ${SEV[v.severity]?.dot}`} />
                                        <span className="text-sm text-white flex-1 min-w-[140px]">{v.label}</span>
                                        <div className="flex p-0.5 rounded-lg border border-white/10 bg-black/30">
                                            {['auto', 'notify', 'off'].map(o => {
                                                const disabled = o === 'auto' && !v.fixable
                                                return <button key={o} disabled={disabled} onClick={() => setP(x => ({ ...x, [k]: o }))}
                                                    title={disabled ? 'KubeEZ has no automatic fix for this — it diagnoses and alerts' : ''}
                                                    className={`px-2.5 py-1 rounded-md text-[11px] font-semibold ${p[k] === o ? 'bg-gradient-to-r from-blue-500/30 to-violet-500/25 text-white' : 'text-slate-400 hover:text-white'} disabled:opacity-30 disabled:cursor-not-allowed`}>{opt[o]}</button>
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="flex items-center gap-3 p-4 border-t border-white/[0.07]">
                    <span className="text-[11px] text-slate-500">“Alert only” problems can still be fixed with one click.</span>
                    <button onClick={onClose} className="ml-auto kz-btn-ghost">Cancel</button>
                    <button onClick={save} disabled={busy} className="kz-btn-primary">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Save</button>
                </div>
            </div>
        </div>
    )
}
