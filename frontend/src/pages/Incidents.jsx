import { useState, useEffect } from 'react'
import { apiFetch } from '../context/AuthContext'
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Activity } from 'lucide-react'

export default function Incidents() {
    const [incidents, setIncidents] = useState([])
    const [loading, setLoading] = useState(true)

    const fetchIncidents = async () => {
        try {
            const res = await apiFetch('/api/incidents')
            if (res.ok) {
                const data = await res.json()
                setIncidents(data)
            }
        } catch (e) {
            console.error('Failed to fetch incidents', e)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchIncidents()
        const interval = setInterval(fetchIncidents, 3000) // Poll every 3s for real-time feel
        return () => clearInterval(interval)
    }, [])

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <Activity className="w-6 h-6 text-emerald-400" />
                        <h1 className="text-2xl font-black text-white tracking-tight">Automated Incident Response</h1>
                    </div>
                    <p className="text-slate-400 text-sm mt-1">Real-time detection and automated healing events via Gateway Agents</p>
                </div>
                <div className="flex items-center gap-3 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
                    <div className="relative flex items-center justify-center">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-30"></span>
                        <div className="h-2.5 w-2.5 rounded-full bg-emerald-500"></div>
                    </div>
                    <span className="text-emerald-400 text-xs font-black uppercase tracking-widest">Monitoring Active</span>
                </div>
            </div>

            <div className="glass rounded-2xl border border-white/8 overflow-hidden">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 gap-4">
                        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                        <p className="text-xs text-slate-500 uppercase font-black tracking-widest">Loading incidents...</p>
                    </div>
                ) : incidents.length === 0 ? (
                    <div className="py-20 text-center">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 mb-5">
                            <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                        </div>
                        <h3 className="text-lg font-black text-white">All Systems Healthy</h3>
                        <p className="text-slate-400 text-sm mt-1">No anomalies detected in your clusters.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm text-slate-300">
                            <thead className="bg-white/[0.03] text-slate-500 border-b border-white/8">
                                <tr>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest">Time</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest">Cluster</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest">Anomaly</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest">Target</th>
                                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest">Auto-Fix Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {incidents.map(inc => (
                                    <tr key={inc.id} className="hover:bg-white/[0.02] transition-colors">
                                        <td className="px-6 py-4 font-mono text-xs text-slate-500">
                                            {new Date(inc.timestamp).toLocaleTimeString()}
                                        </td>
                                        <td className="px-6 py-4 font-bold text-slate-200">{inc.clusterName}</td>
                                        <td className="px-6 py-4">
                                            <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                                                {inc.reason}
                                            </span>
                                            <div className="text-xs text-slate-500 mt-1 truncate max-w-xs">{inc.message}</div>
                                        </td>
                                        <td className="px-6 py-4 font-mono text-xs text-slate-400">{inc.target || 'Cluster-wide'}</td>
                                        <td className="px-6 py-4">
                                            {inc.status === 'detecting' && (
                                                <div className="flex items-center gap-2 text-blue-400">
                                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    <span className="text-xs font-bold">Analyzing...</span>
                                                </div>
                                            )}
                                            {inc.status === 'remediating' && (
                                                <div className="flex items-center gap-2 text-amber-400">
                                                    <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
                                                    <span className="text-xs font-bold">{inc.details || 'Applying Fix...'}</span>
                                                </div>
                                            )}
                                            {inc.status === 'resolved' && (
                                                <div className="flex items-center gap-2 text-emerald-400">
                                                    <CheckCircle2 className="w-4 h-4" />
                                                    <span className="text-xs font-bold">{inc.details || 'Resolved'}</span>
                                                </div>
                                            )}
                                            {inc.status === 'failed' && (
                                                <div className="flex items-center gap-2 text-red-400">
                                                    <XCircle className="w-4 h-4" />
                                                    <span className="text-xs font-bold">{inc.details || 'Fix Failed'}</span>
                                                </div>
                                            )}
                                            {inc.status === 'unresolved' && (
                                                <div className="flex items-center gap-2 text-slate-500">
                                                    <AlertTriangle className="w-3.5 h-3.5" />
                                                    <span className="text-xs font-bold">No auto-fix available</span>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    )
}
