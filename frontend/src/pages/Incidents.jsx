import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../context/AuthContext'
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Activity, Eye, EyeOff, RotateCcw, WifiOff, Compass } from 'lucide-react'
import { explorerResourceLink, explorerPages } from '../components/explorer/explorerLinks'
import { PageTitle } from '../components/ui/PageHeader'

// Friendly names (same as the toast notifications)
const REASON_LABEL = {
    NodeNotReady: 'Node Down',
    DiskPressure: 'Disk Pressure',
    MemoryPressure: 'Memory Pressure',
    PIDPressure: 'Process Pressure',
    CrashLoopBackOff: 'Pod Crash Loop',
    OOMKilled: 'Out of Memory',
    ImagePullBackOff: 'Image Pull Failed',
    PodPendingTooLong: 'Pod Stuck Pending'
}
const CLOSED = new Set(['resolved', 'cleared'])

function when(iso) {
    if (!iso) return ''
    const d = new Date(iso)
    const mins = Math.round((Date.now() - d.getTime()) / 60000)
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`
    return { ago, full: d.toLocaleString() }
}

function Status({ inc }) {
    const map = {
        detecting: { cls: 'text-blue-400', Icon: Loader2, spin: true, text: 'Analyzing...' },
        remediating: { cls: 'text-amber-400', Icon: RotateCcw, spin: true, text: inc.details || 'Applying fix...' },
        resolved: { cls: 'text-emerald-400', Icon: CheckCircle2, text: inc.details || 'Fixed automatically' },
        cleared: { cls: 'text-emerald-300/80', Icon: CheckCircle2, text: inc.details || 'Problem went away' },
        failed: { cls: 'text-red-400', Icon: XCircle, text: inc.details || 'Auto-fix failed — needs attention' },
        unresolved: { cls: 'text-slate-300', Icon: AlertTriangle, text: inc.details || 'No auto-fix — needs attention' }
    }
    const m = map[inc.status] || map.unresolved
    return (
        <div className={`flex items-start gap-2 ${m.cls}`}>
            <m.Icon className={`w-4 h-4 shrink-0 mt-px ${m.spin ? 'animate-spin' : ''}`} />
            <span className="text-xs font-bold leading-relaxed">{m.text}</span>
        </div>
    )
}

export default function Incidents() {
    const [incidents, setIncidents] = useState([])
    const [monitor, setMonitor] = useState(null)   // { clusters, connected }
    const [loading, setLoading] = useState(true)
    const [showAll, setShowAll] = useState(false)
    const [explorerOn, setExplorerOn] = useState(new Set())   // cluster ids with the Explorer installed

    const load = async () => {
        try {
            const [i, m] = await Promise.all([apiFetch('/api/incidents'), apiFetch('/api/incidents/monitoring')])
            if (i.ok) setIncidents(await i.json())
            if (m.ok) setMonitor(await m.json())
        } catch (e) {
            console.error('Failed to fetch incidents', e)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        load()
        const t = setInterval(load, 10000)
        apiFetch('/api/clusters/list').then(r => r.ok ? r.json() : []).then(list => {
            setExplorerOn(new Set((Array.isArray(list) ? list : []).filter(c => c.addons?.explorer).map(c => c.id)))
        }).catch(() => {})
        return () => clearInterval(t)
    }, [])

    // Where to look in the Explorer: the pod, the node, or the cluster's timeline
    const investigate = (inc) => {
        if (!explorerOn.has(inc.clusterId)) return null
        if (inc.namespace && inc.target && inc.target !== 'cluster-wide') return explorerResourceLink(inc.clusterId, 'Pod', inc.namespace, inc.target)
        if (!inc.namespace && inc.target && inc.target !== 'cluster-wide') return explorerResourceLink(inc.clusterId, 'Node', '', inc.target)
        return explorerPages(inc.clusterId).timeline
    }

    const open = incidents.filter(i => !CLOSED.has(i.status))
    const shown = showAll ? incidents : open
    const watching = monitor?.clusters?.length || 0
    const offline = (monitor?.clusters || []).filter(c => !c.connected)

    return (
        <div className="max-w-7xl mx-auto">
            <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
                <PageTitle icon={Activity} eyebrow="Overview" title="Incidents & Auto-Healing"
                    description={<>Nodes and pods of every healthy cluster are checked about every minute. Known problems are fixed automatically; the rest are explained here.</>} />
                {monitor && (watching > 0 ? (
                    <div className={`flex items-center gap-3 px-4 py-2 rounded-2xl border ${offline.length ? 'bg-amber-500/10 border-amber-500/20' : 'bg-emerald-500/10 border-emerald-500/20'}`}>
                        <span className={`h-2.5 w-2.5 rounded-full ${offline.length ? 'bg-amber-400' : 'bg-emerald-500 animate-pulse'}`} />
                        <span className={`text-xs font-black uppercase tracking-widest ${offline.length ? 'text-amber-300' : 'text-emerald-400'}`}>
                            Watching {watching} cluster{watching === 1 ? '' : 's'}{offline.length ? ` · ${offline.length} unreachable` : ''}
                        </span>
                    </div>
                ) : (
                    <div className="flex items-center gap-3 px-4 py-2 rounded-2xl border bg-white/5 border-white/10">
                        <span className="h-2.5 w-2.5 rounded-full bg-slate-500" />
                        <span className="text-xs font-black uppercase tracking-widest text-slate-400">No clusters monitored</span>
                    </div>
                ))}
            </div>

            {offline.length > 0 && (
                <div className="mb-4 flex items-start gap-3 p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 text-sm text-amber-200">
                    <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                        Can&apos;t reach {offline.map(c => c.clusterName).join(', ')} right now — problems there are not detected until the connection is back
                        (it retries automatically). In SaaS mode, check that the Gateway Agent is online on the <Link to="/agents" className="underline">Gateway Agents</Link> page.
                    </span>
                </div>
            )}

            {monitor?.skipped?.length > 0 && (
                <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm">
                    <p className="font-semibold text-white flex items-center gap-2"><EyeOff className="w-4 h-4 text-slate-400" /> Not watched ({monitor.skipped.length})</p>
                    <ul className="mt-2 space-y-1.5">
                        {monitor.skipped.map(c => (
                            <li key={c.clusterId} className="text-slate-400">
                                <Link to={`/cluster/${c.clusterId}`} className="font-semibold text-blue-300 hover:text-white">{c.clusterName}</Link> — {c.reason}.
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="flex items-center gap-2 mb-3">
                <button onClick={() => setShowAll(false)} className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${!showAll ? 'bg-white/10 text-white border-white/10' : 'text-slate-400 border-transparent hover:text-white'}`}>
                    <EyeOff className="w-3.5 h-3.5 inline mr-1.5" />Needs attention ({open.length})
                </button>
                <button onClick={() => setShowAll(true)} className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${showAll ? 'bg-white/10 text-white border-white/10' : 'text-slate-400 border-transparent hover:text-white'}`}>
                    <Eye className="w-3.5 h-3.5 inline mr-1.5" />All, last 24 h ({incidents.length})
                </button>
            </div>

            <div className="glass rounded-2xl border border-white/8 overflow-hidden">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-4">
                        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                        <p className="text-xs text-slate-500 uppercase font-black tracking-widest">Loading incidents...</p>
                    </div>
                ) : shown.length === 0 ? (
                    <div className="py-20 text-center">
                        {watching === 0 ? (
                            <>
                                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/5 border border-white/10 mb-5">
                                    <Activity className="w-8 h-8 text-slate-500" />
                                </div>
                                <h3 className="text-lg font-black text-white">Nothing to monitor yet</h3>
                                <p className="text-slate-400 text-sm mt-1">{monitor?.skipped?.length ? 'Your clusters are listed above with the reason they are not watched.' : 'Monitoring starts within a minute for every cluster that is installed and running.'}</p>
                            </>
                        ) : (
                            <>
                                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 mb-5">
                                    <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                                </div>
                                <h3 className="text-lg font-black text-white">{showAll ? 'No incidents in the last 24 hours' : 'Nothing needs attention'}</h3>
                                <p className="text-slate-400 text-sm mt-1">No problems detected on {watching === 1 ? 'your cluster' : `your ${watching} clusters`}.</p>
                            </>
                        )}
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm text-slate-300">
                            <thead className="bg-white/[0.03] text-slate-500 border-b border-white/8">
                                <tr>
                                    {['Detected', 'Cluster', 'Problem', 'Target', 'Auto-fix'].map(h => (
                                        <th key={h} className="px-5 py-4 text-[10px] font-black uppercase tracking-widest">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {shown.map(inc => {
                                    const first = when(inc.timestamp)
                                    const last = when(inc.lastSeen)
                                    return (
                                        <tr key={inc.id} className={`align-top hover:bg-white/[0.02] transition-colors ${CLOSED.has(inc.status) ? 'opacity-60' : ''}`}>
                                            <td className="px-5 py-4 text-xs whitespace-nowrap">
                                                <div className="text-slate-300 font-bold" title={first.full}>{first.ago}</div>
                                                {inc.count > 1 && (
                                                    <div className="text-slate-500 mt-0.5" title={last.full}>seen {inc.count}× · last {last.ago}</div>
                                                )}
                                            </td>
                                            <td className="px-5 py-4 font-bold text-slate-200">{inc.clusterName}</td>
                                            <td className="px-5 py-4 max-w-md">
                                                <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                                                    {REASON_LABEL[inc.reason] || inc.reason}
                                                </span>
                                                <div className="text-xs text-slate-500 mt-1.5 break-words">{inc.message}</div>
                                            </td>
                                            <td className="px-5 py-4 font-mono text-xs text-slate-400 break-all">
                                                {inc.namespace ? `${inc.namespace}/` : ''}{inc.target || 'cluster-wide'}
                                                {investigate(inc) && (
                                                    <a href={investigate(inc)} target="_blank" rel="noopener" className="mt-1.5 flex items-center gap-1 font-sans text-[11px] font-bold text-cyan-300 hover:underline">
                                                        <Compass className="w-3 h-3" /> Investigate in Explorer
                                                    </a>
                                                )}
                                            </td>
                                            <td className="px-5 py-4 max-w-sm"><Status inc={inc} /></td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    )
}
