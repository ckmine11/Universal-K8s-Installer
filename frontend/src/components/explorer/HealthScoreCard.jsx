import { useState, useEffect } from 'react'
import { apiFetch } from '../../context/AuthContext'
import { Activity, Loader2, ExternalLink, Compass, RefreshCw } from 'lucide-react'

const CAT_COLOR = { Security: 'bg-rose-400', Reliability: 'bg-sky-400', Efficiency: 'bg-amber-400' }

/** Best-practice health score of the cluster (KubeEZ Explorer audit). */
export default function HealthScoreCard({ clusterId, installed, onOpenExplorer }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)

    const load = () => {
        setLoading(true)
        apiFetch(`/api/clusters/${clusterId}/explorer-insights/health`)
            .then(r => r.json()).then(setData).catch(e => setData({ installed: true, error: e.message }))
            .finally(() => setLoading(false))
    }
    useEffect(() => { if (installed) load() }, [clusterId, installed])

    if (!installed) return (
        <div className="glass rounded-2xl border border-white/8 p-5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
                <Activity className="w-5 h-5 text-slate-500" />
                <div>
                    <p className="text-sm font-black text-white">Cluster health score</p>
                    <p className="text-[11px] text-slate-500">31 security, reliability and efficiency checks — with the KubeEZ Explorer add-on.</p>
                </div>
            </div>
            <button onClick={onOpenExplorer} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 text-xs font-bold shrink-0"><Compass className="w-3.5 h-3.5" /> Get it</button>
        </div>
    )

    const score = data?.score
    const color = score == null ? '#475569' : score >= 85 ? '#34d399' : score >= 65 ? '#fbbf24' : '#f87171'
    const r = 26, c = 2 * Math.PI * r
    return (
        <div className="glass rounded-2xl border border-white/8 p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2"><Activity className="w-5 h-5 text-cyan-400" /><p className="text-sm font-black text-white">Cluster health</p></div>
                <div className="flex items-center gap-1.5">
                    <button onClick={load} disabled={loading} aria-label="Refresh" className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
                    {data?.detailsUrl && <a href={data.detailsUrl} target="_blank" rel="noopener" className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-white/10 text-[11px] font-bold text-slate-300 hover:bg-white/5"><ExternalLink className="w-3 h-3" /> All checks</a>}
                </div>
            </div>
            {!data || loading && !data ? (
                <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Scanning the cluster…</div>
            ) : data.error ? (
                <p className="text-xs text-amber-300">The health check could not run: {data.error}</p>
            ) : (
                <div className="flex flex-col sm:flex-row gap-5">
                    <div className="flex items-center gap-4 shrink-0">
                        <div className="relative w-16 h-16">
                            <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
                                <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="6" />
                                <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - ((score || 0) / 100) * c} style={{ transition: 'stroke-dashoffset 1s' }} />
                            </svg>
                            <span className="absolute inset-0 flex items-center justify-center text-lg font-black text-white">{score}</span>
                        </div>
                        <div className="text-[11px] space-y-0.5">
                            <p className="text-emerald-300">{data.passing} passing</p>
                            <p className="text-amber-300">{data.warning} warnings</p>
                            <p className="text-red-300">{data.danger} critical</p>
                        </div>
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex gap-3 text-[10px] text-slate-400">
                            {Object.entries(data.categories || {}).map(([k, v]) => (
                                <span key={k} className="flex items-center gap-1"><span className={`w-1.5 h-1.5 rounded-full ${CAT_COLOR[k] || 'bg-slate-400'}`} /> {k}: {v.danger + v.warning} issues</span>
                            ))}
                        </div>
                        <ul className="space-y-1">
                            {data.top.slice(0, 4).map((t, i) => (
                                <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                                    <span className="flex items-center gap-1.5 min-w-0"><span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.severity === 'danger' ? 'bg-red-400' : 'bg-amber-400'}`} /><span className="text-slate-300 truncate">{t.title}</span></span>
                                    <span className="text-slate-500 shrink-0">{t.resources} resource{t.resources === 1 ? '' : 's'}</span>
                                </li>
                            ))}
                            {!data.top.length && <li className="text-[11px] text-emerald-300">No warnings — nicely done.</li>}
                        </ul>
                    </div>
                </div>
            )}
        </div>
    )
}
