import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Globe2, Loader2, RefreshCw, Sparkles, Layers, GitCompareArrows, AlertTriangle } from 'lucide-react'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { PageTitle } from '../components/ui/PageHeader'
import { RISK_TONE } from '../components/ai/RiskCard'
import { aiJob } from '../components/ai/aiJob'
import Feedback from '../components/ai/Feedback'

// Fleet: every cluster on one page — riskiest first, the same problem on
// several clusters, Kubernetes and add-on version drift.
function Tile({ label, value, tone = 'text-white', sub }) {
    return (
        <div className="kz-card p-4">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
            <p className={`mt-1 font-display text-2xl font-bold ${tone}`}>{value}</p>
            {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
        </div>
    )
}

export default function Fleet() {
    const { user } = useAuth()
    const [f, setF] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [summary, setSummary] = useState(null)
    const load = useCallback(() => {
        setLoading(true)
        apiFetch('/api/clusters/fleet').then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setF(d); setError(null) }).catch(e => setError(e.message)).finally(() => setLoading(false))
    }, [])
    useEffect(() => { load() }, [load])
    const summarize = async () => { setSummary({ loading: true }); const { ok, data } = await aiJob('/api/ai/fleet/summary', {}); setSummary(ok ? data : { error: data.error }) }

    return (
        <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1"><PageTitle icon={Globe2} eyebrow="Overview" title="Fleet" description="Every cluster on one page — riskiest first, problems shared by several clusters, versions that drifted apart." /></div>
                <button onClick={load} disabled={loading} className="kz-btn-ghost !py-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
                {can(user?.role, 'ai:use') && f?.clusters.length > 0 && <button onClick={summarize} disabled={summary?.loading} className="kz-btn-primary !py-2">{summary?.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} What needs attention (AI)</button>}
            </div>
            {error && <p className="text-sm text-red-300">{error}</p>}
            {!f && loading && <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>}
            {summary && !summary.loading && (
                <div className={`rounded-2xl border p-4 text-sm ${summary.error ? 'border-amber-400/25 text-amber-100' : 'border-violet-400/25 bg-violet-500/[0.05] text-slate-200'}`}>
                    {summary.error || <><p className="whitespace-pre-wrap leading-relaxed">{summary.summary}</p><div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500"><span>{summary.engine?.provider} · {summary.engine?.model}</span><Feedback traceId={summary.engine?.traceId} /></div></>}
                </div>
            )}
            {f && (
                <>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <Tile label="Clusters" value={f.totals.clusters} />
                        <Tile label="High risk" value={f.totals.high} tone={f.totals.high ? 'text-red-300' : 'text-emerald-300'} />
                        <Tile label="Open problems" value={f.totals.open} tone={f.totals.open ? 'text-amber-300' : 'text-emerald-300'} sub={f.totals.critical ? `${f.totals.critical} critical` : null} />
                        <Tile label="Out of support" value={f.totals.unsupported} tone={f.totals.unsupported ? 'text-red-300' : 'text-emerald-300'} sub="Kubernetes version" />
                        <Tile label="Version spread" value={`${f.k8s.spread} minor`} tone={f.k8s.spread > 1 ? 'text-amber-300' : 'text-emerald-300'} />
                    </div>

                    {f.shared.length > 0 && (
                        <section className="kz-card p-5 space-y-3">
                            <h3 className="flex items-center gap-2 text-base font-semibold text-white"><Layers className="w-4 h-4 text-amber-300" /> The same problem on several clusters</h3>
                            <p className="text-xs text-slate-400">Often one root cause — the same image, setting or dependency rolled out everywhere. Fix it once.</p>
                            <ul className="space-y-2">
                                {f.shared.map((s, i) => (
                                    <li key={i} className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.04] p-3 text-sm">
                                        <AlertTriangle className="w-4 h-4 text-amber-300" />
                                        <span className="text-white font-semibold">{s.label}</span>
                                        {s.workload && <span className="font-mono text-xs text-slate-400">{s.workload}</span>}
                                        <span className="text-xs text-slate-400 flex-1">on {s.clusters.length} clusters: {s.clusters.join(', ')}</span>
                                        <Link to="/incidents" className="text-xs text-blue-300 hover:underline">Incidents →</Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    <section className="kz-card p-5">
                        <h3 className="text-base font-semibold text-white mb-3">Clusters — riskiest first</h3>
                        {!f.clusters.length && <p className="text-sm text-slate-400">No clusters yet.</p>}
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="text-left text-[11px] uppercase tracking-wider text-slate-500"><tr><th className="py-2 pr-3">Cluster</th><th className="pr-3">Risk</th><th className="pr-3">Biggest risk</th><th className="pr-3">Kubernetes</th><th className="pr-3">Nodes</th><th className="pr-3">Open</th><th>Add-ons</th></tr></thead>
                                <tbody>
                                    {f.clusters.map(c => (
                                        <tr key={c.id} className="border-t border-white/5 align-top">
                                            <td className="py-2.5 pr-3"><Link to={`/cluster/${c.id}`} className="font-semibold text-white hover:text-blue-300">{c.name}</Link></td>
                                            <td className="pr-3">{c.risk ? <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${RISK_TONE[c.risk.level]?.chip}`}>{c.risk.score}</span> : '—'}</td>
                                            <td className="pr-3 text-xs text-slate-400">{c.risk?.top || '—'}</td>
                                            <td className="pr-3 font-mono text-xs text-slate-300">{c.k8sVersion}</td>
                                            <td className="pr-3 text-xs text-slate-400">{c.nodes}{c.controlPlanes > 1 ? ` (${c.controlPlanes} CP)` : ''}</td>
                                            <td className={`pr-3 text-xs ${c.critical ? 'text-red-300' : c.open ? 'text-amber-300' : 'text-slate-500'}`}>{c.open}{c.critical ? ` (${c.critical} critical)` : ''}</td>
                                            <td className="text-[11px] text-slate-500">{c.addons.join(', ') || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <div className="grid md:grid-cols-2 gap-4">
                        <section className="kz-card p-5 space-y-2">
                            <h3 className="flex items-center gap-2 text-base font-semibold text-white"><GitCompareArrows className="w-4 h-4 text-blue-300" /> Kubernetes versions</h3>
                            {f.k8s.versions.map(v => (
                                <p key={v.version} className="text-xs"><span className={`font-mono font-semibold ${v.supported === false ? 'text-red-300' : 'text-slate-200'}`}>{v.version}</span>{v.supported === false && <span className="ml-1 text-red-300">out of support</span>} <span className="text-slate-400">— {v.clusters.join(', ')}</span></p>
                            ))}
                        </section>
                        <section className="kz-card p-5 space-y-2">
                            <h3 className="flex items-center gap-2 text-base font-semibold text-white"><GitCompareArrows className="w-4 h-4 text-violet-300" /> Add-ons on different versions</h3>
                            {!f.addonDrift.length && <p className="text-xs text-emerald-300">The same versions everywhere.</p>}
                            {f.addonDrift.map(d => (
                                <div key={d.addon} className="text-xs"><p className="font-semibold text-slate-200">{d.addon}</p>{d.versions.map(v => <p key={v.version} className="ml-3 text-slate-400"><span className="font-mono text-slate-300">{v.version}</span> — {v.clusters.join(', ')}</p>)}</div>
                            ))}
                        </section>
                    </div>
                </>
            )}
        </div>
    )
}
