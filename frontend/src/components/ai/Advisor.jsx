import { useState, useEffect, useCallback } from 'react'
import { ShieldAlert, Coins, Loader2, RefreshCw, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { aiJob } from './aiJob'
import Feedback from './Feedback'
import Markdown from './Markdown'

// AI → Advisor: security and cost per workload, facts first, AI summary on demand.
const SEV = { high: 'text-red-300 border-red-400/30 bg-red-500/10', medium: 'text-amber-300 border-amber-400/30 bg-amber-500/10', low: 'text-slate-300 border-white/15 bg-white/5' }
const KIND = { over: ['Asks for more than it uses', 'text-amber-300'], under: ['Uses more than it asks for', 'text-red-300'], 'no-requests': ['No requests', 'text-amber-300'], idle: ['Idle', 'text-slate-400'] }
const cores = (c) => c >= 1 ? `${+c.toFixed(2)}` : `${Math.max(1, Math.round(c * 1000))}m`
const mem = (b) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}Gi` : `${Math.max(1, Math.round(b / 1024 ** 2))}Mi`
const pct = (a, b) => b ? Math.round(100 * a / b) : 0

function Bar({ label, used, requested, total, fmt }) {
    return (
        <div>
            <div className="flex justify-between text-[11px] text-slate-400"><span>{label}</span><span>used {fmt(used)} · requested {fmt(requested)} · of {fmt(total)}</span></div>
            <div className="mt-1 h-2 rounded-full bg-white/10 overflow-hidden relative">
                <div className="absolute inset-y-0 left-0 bg-blue-400/40" style={{ width: `${Math.min(100, pct(requested, total))}%` }} />
                <div className="absolute inset-y-0 left-0 bg-emerald-400" style={{ width: `${Math.min(100, pct(used, total))}%` }} />
            </div>
        </div>
    )
}

export default function Advisor({ clusterId }) {
    const { user } = useAuth()
    const [a, setA] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [showSystem, setShowSystem] = useState(false)
    const [summary, setSummary] = useState(null)
    const [open, setOpen] = useState(null)

    const load = useCallback(async (refresh = false) => {
        setLoading(true); setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/advisor${refresh ? '?refresh=1' : ''}`)
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not read the cluster')
            setA(d)
        } catch (e) { setError(e.message) } finally { setLoading(false) }
    }, [clusterId])
    useEffect(() => { load() }, [load])

    const summarize = async () => {
        setSummary({ loading: true })
        const { ok, data } = await aiJob(`/api/ai/advisor/${clusterId}/summary`, {})
        setSummary(ok ? data : { error: data.error })
    }

    if (!a) return <div className="kz-card p-6 text-sm text-slate-400 flex items-center gap-2">{loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Looking at every workload…</> : error || 'No data'}</div>
    const findings = a.security.findings.filter(f => showSystem || f.scope === 'app')
    const tone = a.security.score >= 80 ? 'text-emerald-300' : a.security.score >= 50 ? 'text-amber-300' : 'text-red-300'

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-slate-500 flex-1">Checked {new Date(a.checkedAt).toLocaleTimeString()} — usage is what the workloads use right now; check again at a busy time before cutting requests.{a.limited ? ' You see only your namespaces.' : ''}</p>
                <button onClick={() => load(true)} disabled={loading} className="kz-btn-ghost !py-1.5 !text-xs"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Check again</button>
                {can(user?.role, 'ai:use', clusterId) && <button onClick={summarize} disabled={summary?.loading} className="kz-btn-primary !py-1.5 !text-xs">{summary?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} What to fix first (AI)</button>}
            </div>
            {summary && !summary.loading && (
                <div className={`rounded-2xl border p-4 text-sm ${summary.error ? 'border-amber-400/25 text-amber-100' : 'border-violet-400/25 bg-violet-500/[0.05] text-slate-200'}`}>
                    {summary.error || <><div className="leading-relaxed"><Markdown text={summary.summary} /></div><div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500"><span>{summary.engine?.provider} · {summary.engine?.model}</span><Feedback traceId={summary.engine?.traceId} /></div></>}
                </div>
            )}

            <section className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <ShieldAlert className="w-5 h-5 text-blue-300" />
                    <h3 className="text-base font-semibold text-white flex-1">Security <span className={`ml-2 font-display ${tone}`}>{a.security.score}/100</span></h3>
                    <span className="text-xs text-slate-400">{a.security.counts.high} high · {a.security.counts.medium} medium · {a.security.counts.low} low</span>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" checked={showSystem} onChange={e => setShowSystem(e.target.checked)} /> show system & add-ons</label>
                </div>
                {!findings.length && <p className="text-sm text-emerald-300">No findings in your workloads.</p>}
                <ul className="space-y-1.5">
                    {findings.slice(0, 80).map((f, i) => (
                        <li key={i} className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
                            <button onClick={() => setOpen(open === i ? null : i)} className="w-full flex items-center gap-2 p-2.5 text-left text-xs">
                                {open === i ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                                <span className={`kz-chip ${SEV[f.severity]}`}>{f.severity}</span>
                                <span className="font-mono text-slate-400">{f.namespace}/{f.workload}</span>
                                <span className="text-slate-200 flex-1">{f.text}</span>
                                {f.scope !== 'app' && <span className="kz-chip !text-slate-500">{f.scope}</span>}
                            </button>
                            {open === i && <p className="px-9 pb-2.5 text-xs text-blue-200">{f.fix}</p>}
                        </li>
                    ))}
                </ul>
            </section>

            <section className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <Coins className="w-5 h-5 text-amber-300" />
                    <h3 className="text-base font-semibold text-white flex-1">Cost</h3>
                    {a.cost.savings && <span className="text-sm text-emerald-300">{a.cost.savings.text}</span>}
                </div>
                {a.cost.nodes && (
                    <div className="space-y-2">
                        <Bar label={`CPU · ${a.cost.nodes.count} node(s)`} used={a.cost.nodes.used.cpu} requested={a.cost.nodes.requested.cpu} total={a.cost.nodes.total.cpu} fmt={cores} />
                        <Bar label="Memory" used={a.cost.nodes.used.mem} requested={a.cost.nodes.requested.mem} total={a.cost.nodes.total.mem} fmt={mem} />
                        <p className="text-[10px] text-slate-500"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-400 mr-1" />used now <span className="inline-block w-2 h-2 rounded-sm bg-blue-400/40 ml-3 mr-1" />requested. Prices: {a.cost.rates.currency}{a.cost.rates.cpu} per core and {a.cost.rates.currency}{a.cost.rates.memGb} per GiB a month (AI settings).</p>
                    </div>
                )}
                {!a.cost.workloads.length && <p className="text-sm text-emerald-300">Requests match what the workloads use.</p>}
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <tbody>
                            {a.cost.workloads.filter(w => showSystem || w.scope === 'app').slice(0, 60).map((w, i) => (
                                <tr key={i} className="border-t border-white/5 align-top">
                                    <td className="py-2 pr-3 font-mono text-slate-400 whitespace-nowrap">{w.namespace}/{w.workload}</td>
                                    <td className={`py-2 pr-3 whitespace-nowrap ${KIND[w.advice.kind][1]}`}>{KIND[w.advice.kind][0]}</td>
                                    <td className="py-2 pr-3 text-slate-300">{w.advice.text}</td>
                                    <td className="py-2 font-mono text-[11px] text-blue-200 whitespace-nowrap">{w.advice.suggest ? `requests: cpu ${cores(w.advice.suggest.cpu / Math.max(1, w.pods))}, memory ${mem(w.advice.suggest.mem / Math.max(1, w.pods))}${w.pods > 1 ? ' per pod' : ''}` : ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    )
}
