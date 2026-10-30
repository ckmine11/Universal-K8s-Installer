import { useState } from 'react'
import { Activity, Loader2, Table2, BarChart3 } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// One workload's CPU, memory, restarts and network from the cluster's
// Prometheus: small multiples (one line each, same time axis), a hover
// crosshair with the value, and a table view.
const METRICS = [
    ['cpu', 'CPU', (v) => `${v < 1 ? Math.round(v * 1000) + 'm' : v.toFixed(2)} cores`],
    ['memory', 'Memory', (v) => `${(v / 1048576).toFixed(0)} MiB`],
    ['restarts', 'Restarts (per 5 min)', (v) => `${Math.round(v)}`],
    ['netIn', 'Network in', (v) => `${(v / 1024).toFixed(1)} KiB/s`],
    ['netOut', 'Network out', (v) => `${(v / 1024).toFixed(1)} KiB/s`]
]
// validated categorical blue for both skins (same as the Delivery chart)
const CSS = `.kz-met{--met-line:#3b82f6;--met-grid:rgba(255,255,255,.08)} :root[data-skin="zen"] .kz-met{--met-line:#2563eb;--met-grid:rgba(0,0,0,.08)}`
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Spark({ points, fmt, label }) {
    const [hover, setHover] = useState(null)
    const W = 300, H = 70
    if (!points?.length) return <p className="text-[11px] text-slate-500 h-[70px] flex items-center">No data</p>
    const t0 = points[0].t, t1 = points.at(-1).t || t0 + 1
    const max = Math.max(...points.map(p => p.v)) || 1
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W
    const y = (v) => H - 4 - (v / max) * (H - 12)
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
    const h = hover != null ? points[hover] : null
    return (
        <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[70px]" preserveAspectRatio="none" role="img" aria-label={`${label}: latest ${fmt(points.at(-1).v)}, highest ${fmt(max)}`}
                onMouseLeave={() => setHover(null)}
                onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const tx = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0); let best = 0; points.forEach((p, i) => { if (Math.abs(p.t - tx) < Math.abs(points[best].t - tx)) best = i }); setHover(best) }}>
                <line x1="0" x2={W} y1={H - 4} y2={H - 4} stroke="var(--met-grid)" vectorEffect="non-scaling-stroke" />
                <path d={d} fill="none" stroke="var(--met-line)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                {h && <line x1={x(h.t)} x2={x(h.t)} y1="0" y2={H} stroke="var(--met-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
            </svg>
            {h && <span className="absolute top-0 right-0 rounded-md border border-white/10 bg-[#16161b] px-1.5 py-0.5 text-[10px] text-slate-200">{time(h.t)} · {fmt(h.v)}</span>}
        </div>
    )
}

export default function MetricsPanel({ clusterId }) {
    const [f, setF] = useState({ namespace: '', kind: 'Deployment', name: '', range: '1h' })
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [table, setTable] = useState(false)
    const load = async (range = f.range) => {
        setLoading(true)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/metrics?${new URLSearchParams({ ...f, range })}`)
            const d = await res.json().catch(() => ({}))
            setData(res.ok ? d : { why: d.error || 'Could not read the metrics' })
        } catch (e) { setData({ why: e.message }) } finally { setLoading(false) }
    }
    return (
        <div className="kz-card p-5 space-y-3 kz-met">
            <style>{CSS}</style>
            <div className="flex flex-wrap items-center gap-2">
                <Activity className="w-4 h-4 text-blue-300" /><h3 className="text-sm font-semibold text-white mr-auto">App metrics</h3>
                <input className="kz-input !w-32 !text-xs" placeholder="namespace" value={f.namespace} onChange={e => setF(x => ({ ...x, namespace: e.target.value }))} aria-label="Namespace" />
                <select className="kz-input !w-32 !text-xs" value={f.kind} onChange={e => setF(x => ({ ...x, kind: e.target.value }))} aria-label="Kind"><option>Deployment</option><option>StatefulSet</option><option>DaemonSet</option></select>
                <input className="kz-input !w-36 !text-xs" placeholder="workload" value={f.name} onChange={e => setF(x => ({ ...x, name: e.target.value }))} aria-label="Workload" />
                <select className="kz-input !w-24 !text-xs" value={f.range} onChange={e => { setF(x => ({ ...x, range: e.target.value })); if (data?.series) load(e.target.value) }} aria-label="Time range"><option value="1h">1 hour</option><option value="6h">6 hours</option><option value="24h">24 hours</option></select>
                <button onClick={() => load()} disabled={loading || !f.namespace || !f.name} className="kz-btn-primary !py-1.5 !text-xs">{loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Show'}</button>
                {data?.series && <button onClick={() => setTable(v => !v)} className="kz-btn-ghost !py-1.5 !text-xs" aria-label={table ? 'Show charts' : 'Show table'}>{table ? <BarChart3 className="w-3.5 h-3.5" /> : <Table2 className="w-3.5 h-3.5" />}</button>}
            </div>
            {data?.why && <p className="text-xs text-amber-200">{data.why}</p>}
            {data?.series && (table ? (
                <table className="w-full text-[11px]">
                    <thead><tr className="text-left text-slate-500 border-b border-white/10"><th className="py-1 font-semibold">Metric</th><th className="py-1 font-semibold text-right">Now</th><th className="py-1 font-semibold text-right">Lowest</th><th className="py-1 font-semibold text-right">Highest</th></tr></thead>
                    <tbody>{METRICS.map(([k, label, fmt]) => { const s = data.series[k] || []; const vs = s.map(p => p.v); return (
                        <tr key={k} className="border-b border-white/[0.05]"><td className="py-1 text-slate-300">{label}</td><td className="py-1 text-right text-slate-200">{vs.length ? fmt(vs.at(-1)) : '—'}</td><td className="py-1 text-right text-slate-400">{vs.length ? fmt(Math.min(...vs)) : '—'}</td><td className="py-1 text-right text-slate-400">{vs.length ? fmt(Math.max(...vs)) : '—'}</td></tr>
                    ) })}</tbody>
                </table>
            ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {METRICS.map(([k, label, fmt]) => { const s = data.series[k]; return (
                        <div key={k} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
                            <p className="flex justify-between text-[11px]"><span className="text-slate-400">{label}</span><span className="text-slate-200 font-semibold">{s?.length ? fmt(s.at(-1).v) : ''}</span></p>
                            <Spark points={s} fmt={fmt} label={label} />
                        </div>
                    ) })}
                </div>
            ))}
            {data?.prometheus && <p className="text-[10px] text-slate-500">From {data.prometheus.namespace}/{data.prometheus.name} · one point every {Math.round(data.step / 60)} min</p>}
        </div>
    )
}
