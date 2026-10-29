import { useState, useEffect, useCallback } from 'react'
import { Gauge, RefreshCw, Loader2, AlertTriangle, Rocket, XCircle, Timer, GitCommitHorizontal, Table2, BarChart3 } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// DORA delivery metrics of one cluster: deployment frequency, change failure
// rate, recovery time (lead time needs Git — said so, not faked), a daily
// chart of rollouts and the rollouts that failed.
const WINDOWS = [7, 14, 30]
// Elite / High / Medium / Low always shown as words, the colour only helps
const LEVEL = {
    elite: ['Elite', 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10'],
    high: ['High', 'text-blue-300 border-blue-400/30 bg-blue-500/10'],
    medium: ['Medium', 'text-amber-200 border-amber-400/30 bg-amber-500/10'],
    low: ['Low', 'text-red-300 border-red-400/30 bg-red-500/10']
}
// chart colours (validated for both skins: categorical blue + status red), not
// Tailwind classes — the zen skin re-colours those
const CHART_CSS = `.kz-dora{--dora-ok:#3b82f6;--dora-fail:#ef4444;--dora-grid:rgba(255,255,255,.08)}
:root[data-skin="zen"] .kz-dora{--dora-ok:#2563eb;--dora-fail:#dc2626;--dora-grid:rgba(0,0,0,.08)}`

const dur = (m) => m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.round(m / 144) / 10} days`
const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })

function Level({ level, empty = 'not enough data' }) {
    if (!level) return <span className="text-[10px] text-slate-500">{empty}</span>
    const [l, c] = LEVEL[level]
    return <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${c}`}>{l}</span>
}

function Tile({ Icon, title, value, sub, level, empty }) {
    return (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-1.5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><Icon className="w-3.5 h-3.5" />{title}</p>
            <p className="text-2xl font-bold text-white">{value}</p>
            <p className="text-[11px] text-slate-500">{sub}</p>
            <Level level={level} empty={empty} />
        </div>
    )
}

// one bar per day: rollouts that held (bottom) and failed ones (top), 2px apart
function DailyChart({ daily }) {
    const [hover, setHover] = useState(null)
    const max = Math.max(1, ...daily.map(d => d.deploys))
    const H = 120
    const ticks = [0, Math.floor(daily.length / 2), daily.length - 1].filter((v, i, a) => a.indexOf(v) === i)
    return (
        <div className="kz-dora">
            <style>{CHART_CSS}</style>
            <div className="flex items-center gap-4 text-[11px] text-slate-400 mb-2">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--dora-ok)' }} />Rollouts</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: 'var(--dora-fail)' }} />Failed (rolled back or broke within 1 h)</span>
            </div>
            <div className="relative" style={{ height: H + 20 }}>
                <span className="absolute left-0 top-0 text-[10px] text-slate-500">{max}</span>
                <div className="absolute left-6 right-0 top-1.5 border-t" style={{ borderColor: 'var(--dora-grid)' }} />
                <div className="absolute left-6 right-0 border-t" style={{ top: H, borderColor: 'var(--dora-grid)' }} />
                <div className="absolute left-6 right-0 top-0 flex items-end gap-[2px]" style={{ height: H }} onMouseLeave={() => setHover(null)}>
                    {daily.map((d, i) => {
                        const ok = d.deploys - d.failed
                        return (
                            // the whole column is the hover target, not only the bar
                            <div key={d.date} className="relative flex-1 h-full flex flex-col justify-end items-center" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${dayLabel(d.date)}: ${d.deploys} rollouts, ${d.failed} failed`}>
                                <div className="w-full max-w-[22px] flex flex-col gap-[2px]">
                                    {d.failed > 0 && <div style={{ height: (d.failed / max) * (H - 8), background: 'var(--dora-fail)', borderRadius: '4px 4px 0 0' }} />}
                                    {ok > 0 && <div style={{ height: (ok / max) * (H - 8), background: 'var(--dora-ok)', borderRadius: d.failed ? 0 : '4px 4px 0 0' }} />}
                                </div>
                                {hover === i && (
                                    <div className={`absolute bottom-full mb-1 z-10 whitespace-nowrap rounded-lg border border-white/10 bg-[#16161b] px-2 py-1 text-[11px] text-slate-200 shadow-lg ${i > daily.length / 2 ? 'right-0' : 'left-0'}`}>
                                        <span className="font-semibold">{dayLabel(d.date)}</span> · {d.deploys} rollout{d.deploys === 1 ? '' : 's'}{d.failed ? ` · ${d.failed} failed` : ''}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
                <div className="absolute left-6 right-0 flex text-[10px] text-slate-500" style={{ top: H + 4 }}>
                    {daily.map((d, i) => <span key={d.date} className="flex-1 text-center">{ticks.includes(i) ? dayLabel(d.date) : ''}</span>)}
                </div>
                <span className="absolute left-0 text-[10px] text-slate-500" style={{ top: H - 6 }}>0</span>
            </div>
        </div>
    )
}

export default function DoraTab({ clusterId }) {
    const [days, setDays] = useState(7)
    const [platform, setPlatform] = useState(false)
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [table, setTable] = useState(false)

    const load = useCallback(async (fresh = false) => {
        setLoading(true); setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/dora?days=${days}${platform ? '&platform=1' : ''}${fresh ? '&fresh=1' : ''}`)
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not read the delivery metrics')
            setData(d)
        } catch (e) { setError(e.message) } finally { setLoading(false) }
    }, [clusterId, days, platform])
    useEffect(() => { load() }, [load])

    const f = data?.frequency, cf = data?.changeFailure, rc = data?.recovery
    return (
        <div className="space-y-5">
            <div className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <Gauge className="w-5 h-5 text-blue-300" />
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="text-base font-semibold text-white">Delivery (DORA)</h3>
                        <p className="text-xs text-slate-400">How often you ship to this cluster, how often a change breaks something, and how fast it is back — from the rollouts and KubeEZ's incidents.</p>
                    </div>
                    <select className="kz-input !w-auto !py-1.5 !text-xs" value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Time range">
                        {WINDOWS.map(d => <option key={d} value={d}>Last {d} days</option>)}
                    </select>
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" checked={platform} onChange={e => setPlatform(e.target.checked)} /> Include platform namespaces</label>
                    <button onClick={() => load(true)} disabled={loading} className="kz-btn-ghost !py-1.5 !text-xs" aria-label="Read again"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
                </div>
                {error && <p className="flex items-center gap-1.5 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
                {loading && !data && <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>}

                {data && (
                    <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                            <Tile Icon={Rocket} title="Deployment frequency" value={f.deploys ? `${f.perDay < 1 ? f.perWeek : f.perDay} / ${f.perDay < 1 ? 'week' : 'day'}` : '0'}
                                sub={`${f.deploys} rollout${f.deploys === 1 ? '' : 's'} in ${data.window.days} days`} level={f.level} empty="no rollouts" />
                            <Tile Icon={XCircle} title="Change failure rate" value={cf.percent == null ? '—' : `${cf.percent}%`}
                                sub={`${cf.failed} of ${cf.deploys} rollouts failed`} level={cf.level} empty={cf.tooFew ? 'too few rollouts to grade' : 'no rollouts'} />
                            <Tile Icon={Timer} title="Failed deployment recovery" value={dur(rc.medianMinutes)}
                                sub={rc.measured ? `median of ${rc.measured}${rc.unrecovered ? ` · ${rc.unrecovered} not recovered yet` : ''}` : rc.unrecovered ? `${rc.unrecovered} not recovered yet` : 'no failed rollouts'} level={rc.level} empty="nothing to measure" />
                            <div className="rounded-xl border border-dashed border-white/10 p-4 space-y-1.5">
                                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><GitCommitHorizontal className="w-3.5 h-3.5" />Lead time for changes</p>
                                <p className="text-2xl font-bold text-slate-500">—</p>
                                <p className="text-[11px] text-slate-500">{data.leadTime.why}</p>
                            </div>
                        </div>

                        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Rollouts per day</p>
                                <button onClick={() => setTable(v => !v)} className="kz-btn-ghost !py-1 !px-2 !text-[11px]">{table ? <><BarChart3 className="w-3 h-3" /> Chart</> : <><Table2 className="w-3 h-3" /> Table</>}</button>
                            </div>
                            {table ? (
                                <table className="w-full text-[11px]">
                                    <thead><tr className="text-left text-slate-500 border-b border-white/10"><th className="py-1 font-semibold">Day (UTC)</th><th className="py-1 font-semibold text-right">Rollouts</th><th className="py-1 font-semibold text-right">Failed</th></tr></thead>
                                    <tbody>{data.daily.map(d => <tr key={d.date} className="border-b border-white/[0.05]"><td className="py-1 text-slate-300">{dayLabel(d.date)}</td><td className="py-1 text-right text-slate-200">{d.deploys}</td><td className="py-1 text-right text-slate-200">{d.failed}</td></tr>)}</tbody>
                                </table>
                            ) : <DailyChart daily={data.daily} />}
                        </div>

                        {data.incidentRestore.incidents > 0 && (
                            <p className="text-[11px] text-slate-500">All incidents on this cluster closed in this time: {data.incidentRestore.incidents}, median time to restore {dur(data.incidentRestore.medianMinutes)}.</p>
                        )}

                        <div className="grid lg:grid-cols-2 gap-4">
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Failed rollouts</p>
                                {data.failures.length ? (
                                    <ul className="space-y-1.5">{data.failures.map((d, i) => (
                                        <li key={i} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 text-[11px]">
                                            <p className="text-slate-200"><span className="font-semibold">{d.name}</span> <span className="text-slate-500">{d.kind} · {d.namespace} · revision {d.revision} · {when(d.at)}</span></p>
                                            <p className="text-red-300/90 break-words">{d.why}</p>
                                            <p className="text-slate-500">{d.recoveryMinutes != null ? `back after ${dur(d.recoveryMinutes)}` : 'not recovered yet'}{d.images?.length ? ` · ${d.images.join(', ')}` : ''}</p>
                                        </li>
                                    ))}</ul>
                                ) : <p className="text-sm text-slate-500">None in this time.</p>}
                            </div>
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Most rolled-out workloads</p>
                                {data.workloads.length ? (
                                    <table className="w-full text-[11px]">
                                        <thead><tr className="text-left text-slate-500 border-b border-white/10"><th className="py-1 font-semibold">Workload</th><th className="py-1 font-semibold text-right">Rollouts</th><th className="py-1 font-semibold text-right">Failed</th><th className="py-1 font-semibold text-right">Last</th></tr></thead>
                                        <tbody>{data.workloads.map(w => (
                                            <tr key={`${w.kind}|${w.namespace}|${w.name}`} className="border-b border-white/[0.05]">
                                                <td className="py-1 text-slate-200 break-all">{w.name} <span className="text-slate-500">{w.namespace}</span></td>
                                                <td className="py-1 text-right text-slate-200">{w.deploys}</td>
                                                <td className="py-1 text-right text-slate-200">{w.failed}</td>
                                                <td className="py-1 text-right text-slate-500">{when(w.lastAt)}</td>
                                            </tr>
                                        ))}</tbody>
                                    </table>
                                ) : <p className="text-sm text-slate-500">No rollouts in this time{platform ? '' : ' (platform namespaces hidden)'}.</p>}
                            </div>
                        </div>

                        <p className="text-[10px] text-slate-500 leading-relaxed">
                            A rollout is a new ReplicaSet (Deployment) or revision (StatefulSet / DaemonSet). It failed when it was rolled back, or when a crash loop, image pull failure, out-of-memory kill, repeated restarts, a pod stuck pending, an unavailable workload or an unhealthy GitOps app started within an hour after it (and before the next rollout).
                            Kubernetes keeps about 10 old ReplicaSets per Deployment and KubeEZ keeps incidents for 7 days, so older rollouts and failures may be missing. Levels follow the DORA research bands.
                        </p>
                    </>
                )}
            </div>
        </div>
    )
}
