import { useState, useEffect } from 'react'
import { apiFetch } from '../context/AuthContext'

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
        <div className="max-w-6xl mx-auto py-8 px-4">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-light text-white tracking-tight">Automated Incident Response</h1>
                    <p className="text-slate-400 mt-2">Real-time detection and automated healing events via Gateway Agents</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative flex items-center justify-center">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-20"></span>
                        <div className="h-3 w-3 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]"></div>
                    </div>
                    <span className="text-emerald-500 text-sm font-medium">Monitoring Active</span>
                </div>
            </div>

            <div className="bg-[#111113] border border-[#222] rounded-xl overflow-hidden shadow-2xl">
                {loading ? (
                    <div className="p-8 text-center text-slate-500">Loading incidents...</div>
                ) : incidents.length === 0 ? (
                    <div className="p-16 text-center">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/10 mb-4">
                            <svg className="w-8 h-8 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        </div>
                        <h3 className="text-lg font-medium text-white">All Systems Healthy</h3>
                        <p className="text-slate-400 mt-1">No anomalies detected in your clusters.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm text-slate-300">
                            <thead className="bg-[#0A0A0B] text-slate-500 border-b border-[#222]">
                                <tr>
                                    <th className="px-6 py-4 font-medium">Time</th>
                                    <th className="px-6 py-4 font-medium">Cluster</th>
                                    <th className="px-6 py-4 font-medium">Anomaly</th>
                                    <th className="px-6 py-4 font-medium">Target</th>
                                    <th className="px-6 py-4 font-medium">Auto-Fix Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#222]">
                                {incidents.map(inc => (
                                    <tr key={inc.id} className="hover:bg-[#1A1A1E] transition-colors">
                                        <td className="px-6 py-4 font-mono text-xs text-slate-500">
                                            {new Date(inc.timestamp).toLocaleTimeString()}
                                        </td>
                                        <td className="px-6 py-4 font-medium text-slate-200">{inc.clusterName}</td>
                                        <td className="px-6 py-4">
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                                                {inc.reason}
                                            </span>
                                            <div className="text-xs text-slate-500 mt-1 truncate max-w-xs">{inc.message}</div>
                                        </td>
                                        <td className="px-6 py-4 font-mono text-xs">{inc.target || 'Cluster-wide'}</td>
                                        <td className="px-6 py-4">
                                            {inc.status === 'detecting' && <span className="text-blue-400">Analyzing...</span>}
                                            {inc.status === 'remediating' && (
                                                <div className="flex items-center gap-2 text-amber-400">
                                                    <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></div>
                                                    {inc.details || 'Applying Fix...'}
                                                </div>
                                            )}
                                            {inc.status === 'resolved' && (
                                                <div className="flex items-center gap-2 text-emerald-400">
                                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                    {inc.details || 'Resolved'}
                                                </div>
                                            )}
                                            {inc.status === 'failed' && (
                                                <div className="flex items-center gap-2 text-red-400">
                                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                    {inc.details || 'Fix Failed'}
                                                </div>
                                            )}
                                            {inc.status === 'unresolved' && <span className="text-slate-500">No auto-fix available</span>}
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
