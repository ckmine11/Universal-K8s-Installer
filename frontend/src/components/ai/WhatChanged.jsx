import { useState, useEffect, useCallback } from 'react'
import { History, Loader2, RefreshCw, Sparkles, Rocket, Package, FileCog, Server, FolderPlus, ShieldCheck, AlertTriangle, Undo2 } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { UndoButton } from './FixPreview'
import { aiJob } from './aiJob'
import Feedback from './Feedback'

// "What changed?" for one cluster: KubeEZ's own actions and the changes inside
// Kubernetes on one timeline, plus the fixes applied from KubeEZ AI (with undo).
const RANGES = [[1, '1 hour'], [6, '6 hours'], [24, '24 hours'], [72, '3 days'], [168, '7 days']]
const ICON = { rollout: Rocket, created: Rocket, helm: Package, config: FileCog, node: Server, namespace: FolderPlus, kubeez: ShieldCheck }
const TONE = { rollout: 'text-blue-300', created: 'text-blue-300', helm: 'text-violet-300', config: 'text-amber-300', node: 'text-emerald-300', namespace: 'text-slate-300', kubeez: 'text-fuchsia-300' }
const FILTERS = [['all', 'All'], ['kubeez', 'KubeEZ'], ['rollout', 'Rollouts'], ['helm', 'Helm'], ['config', 'Config'], ['node', 'Nodes']]

export default function WhatChanged({ clusterId }) {
    const { user } = useAuth()
    const [hours, setHours] = useState(24)
    const [filter, setFilter] = useState('all')
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [summary, setSummary] = useState(null)
    const [actions, setActions] = useState([])
    const canAi = can(user?.role, 'ai:use', clusterId)

    const load = useCallback(async () => {
        setLoading(true); setError(null); setSummary(null)
        try {
            const res = await apiFetch(`/api/ai/changes/${clusterId}?hours=${hours}`)
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not load the changes')
            setData(d)
        } catch (e) { setError(e.message) } finally { setLoading(false) }
        apiFetch(`/api/clusters/${clusterId}/ai-actions`).then(r => r.ok ? r.json() : { actions: [] }).then(d => setActions(d.actions || [])).catch(() => { })
    }, [clusterId, hours])
    useEffect(() => { load() }, [load])

    const summarize = async () => {
        setSummary({ loading: true })
        try {
            const { ok, data: d } = await aiJob(`/api/ai/changes/${clusterId}/summary`, { hours })
            setSummary(ok ? d : { error: d.error || 'No answer' })
        } catch (e) { setSummary({ error: e.message }) }
    }

    const items = (data?.items || []).filter(i => filter === 'all' || (filter === 'rollout' ? ['rollout', 'created'].includes(i.kind) : i.kind === filter))
    const byDay = items.reduce((m, i) => { const d = new Date(i.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); (m[d] ||= []).push(i); return m }, {})

    return (
        <div className="space-y-5">
            <div className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <History className="w-5 h-5 text-blue-300" />
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="text-base font-semibold text-white">What changed?</h3>
                        <p className="text-xs text-slate-400">Everything that changed on this cluster — by KubeEZ and inside Kubernetes (rollouts with the image, Helm, ConfigMaps / Secrets by name, nodes). The first place to look when something breaks.</p>
                    </div>
                    <select className="kz-input !w-auto !py-1.5 !text-xs" value={hours} onChange={e => setHours(Number(e.target.value))} aria-label="Time range">
                        {RANGES.map(([h, l]) => <option key={h} value={h}>Last {l}</option>)}
                    </select>
                    <button onClick={load} disabled={loading} className="kz-btn-ghost !py-1.5 !text-xs" aria-label="Refresh"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
                    {canAi && <button onClick={summarize} disabled={!data?.items?.length || summary?.loading} className="kz-btn-primary !py-1.5 !text-xs">{summary?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Summarize with AI</button>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {FILTERS.map(([k, l]) => <button key={k} onClick={() => setFilter(k)} className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${filter === k ? 'bg-blue-500/20 text-white' : 'text-slate-400 hover:bg-white/5'}`}>{l}{data ? ` ${k === 'all' ? data.items.length : data.items.filter(i => k === 'rollout' ? ['rollout', 'created'].includes(i.kind) : i.kind === k).length}` : ''}</button>)}
                </div>
                {summary && !summary.loading && (
                    <div className={`rounded-xl border p-3 text-xs ${summary.error ? 'border-amber-400/25 text-amber-100' : 'border-violet-400/25 bg-violet-500/[0.05] text-slate-200'}`}>
                        {summary.error ? summary.error : <><p className="whitespace-pre-wrap leading-relaxed">{summary.summary}</p><p className="mt-2 text-[10px] text-slate-500">{summary.engine?.provider} · {summary.engine?.model}</p><div className="mt-2"><Feedback traceId={summary.engine?.traceId} /></div></>}
                    </div>
                )}
                {data?.clusterError && <p className="flex items-center gap-1.5 text-xs text-amber-200"><AlertTriangle className="w-3.5 h-3.5" />{data.clusterError} — showing KubeEZ's own changes only.</p>}
                {error && <p className="text-xs text-red-300">{error}</p>}
                {loading && !data && <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>}
                {data && !items.length && <p className="text-sm text-slate-500 py-4">No changes in this time.</p>}
                {Object.entries(byDay).map(([day, list]) => (
                    <div key={day}>
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">{day}</p>
                        <ol className="relative border-l border-white/10 ml-2 space-y-2.5">
                            {list.map((i, k) => {
                                const Icon = ICON[i.kind] || History
                                return (
                                    <li key={k} className="pl-5 relative">
                                        <span className="absolute -left-[9px] top-0.5 w-4 h-4 rounded-full bg-[#0b0b0f] border border-white/10 flex items-center justify-center"><Icon className={`w-2.5 h-2.5 ${TONE[i.kind] || 'text-slate-300'}`} /></span>
                                        <p className="text-xs text-slate-200 break-words"><span className="text-slate-500 font-mono mr-2">{new Date(i.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{i.ns && <span className="text-slate-400">{i.ns} · </span>}{i.title}{i.actor && <span className="text-slate-500"> — {i.actor}</span>}</p>
                                        {i.detail && <p className="text-[11px] text-slate-500 font-mono break-all">{i.detail}</p>}
                                    </li>
                                )
                            })}
                        </ol>
                    </div>
                ))}
            </div>

            {actions.length > 0 && (
                <div className="kz-card p-5 space-y-3">
                    <h3 className="flex items-center gap-2 text-base font-semibold text-white"><Undo2 className="w-4 h-4 text-blue-300" /> Fixes applied from KubeEZ AI</h3>
                    <ul className="space-y-2">
                        {actions.map(a => (
                            <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                                <div className="flex-1 min-w-[220px]">
                                    <p className="text-xs font-semibold text-white">{a.title} {a.status === 'undone' && <span className="kz-chip !text-slate-400 ml-1">undone by {a.undoneBy}</span>}</p>
                                    <p className="text-[11px] text-slate-500">{new Date(a.at).toLocaleString()} · {a.by}{a.reason ? ` · “${a.reason}”` : ''} · {a.change}</p>
                                </div>
                                <UndoButton clusterId={clusterId} rec={a} onDone={load} />
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}
