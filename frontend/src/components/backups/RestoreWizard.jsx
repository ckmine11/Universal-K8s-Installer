import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../context/AuthContext'
import JobProgress from './JobProgress'
import { explorerResourceLink } from '../explorer/explorerLinks'
import { useEtcdJob, startJob } from './useEtcdJob'
import {
    X, Loader2, AlertTriangle, RotateCcw, Trash2, Undo2, PencilLine, ShieldCheck,
    ChevronDown, ChevronRight, Eye, RefreshCw, Info
} from 'lucide-react'

const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease', 'kube-flannel', 'calico-system', 'tigera-operator'])

function fmtWhen(iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

// One list of objects (removed / back / reverted), app objects first, system ones folded
// linkTo(o): Explorer link for an object that exists right now (removed / reverted)
function ObjectList({ items, total, icon: Icon, title, tone, empty, linkTo }) {
    const [showSystem, setShowSystem] = useState(false)
    const app = items.filter(o => !SYSTEM_NS.has(o.namespace))
    const sys = items.filter(o => SYSTEM_NS.has(o.namespace))
    const tones = {
        red: 'border-red-500/20 bg-red-500/[0.04] text-red-300',
        emerald: 'border-emerald-500/20 bg-emerald-500/[0.04] text-emerald-300',
        amber: 'border-amber-500/20 bg-amber-500/[0.04] text-amber-300'
    }
    const row = (o, i) => {
        const href = linkTo?.(o)
        const label = <>{o.namespace ? <span className="text-slate-400">{o.namespace}/</span> : null}{o.name}</>
        return (
            <li key={i} className="flex items-baseline gap-2 min-w-0">
                <span className="text-slate-500 shrink-0">{o.kind}</span>
                {href ? <a href={href} target="_blank" rel="noopener" className="text-white truncate hover:underline hover:text-cyan-200" title="Open in the KubeEZ Explorer">{label}</a>
                    : <span className="text-white truncate">{label}</span>}
            </li>
        )
    }
    return (
        <div className={`rounded-xl border p-3 ${tones[tone]}`}>
            <div className="flex items-center gap-1.5 font-black uppercase tracking-wider text-[10px] mb-2">
                <Icon className="w-3.5 h-3.5" /> {title} <span className="ml-auto font-mono">{total}</span>
            </div>
            {!total ? <p className="text-[11px] text-slate-500">{empty}</p> : (
                <ul className="space-y-0.5 text-[11px] font-mono max-h-40 overflow-y-auto">
                    {app.map(row)}
                    {sys.length > 0 && (
                        <li>
                            <button onClick={() => setShowSystem(s => !s)} className="flex items-center gap-1 text-slate-500 hover:text-slate-300 font-sans text-[10px] mt-1">
                                {showSystem ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                {sys.length} system object{sys.length === 1 ? '' : 's'} (kube-system…)
                            </button>
                            {showSystem && <ul className="space-y-0.5 mt-1">{sys.map(row)}</ul>}
                        </li>
                    )}
                    {total > items.length && <li className="text-slate-500 font-sans text-[10px]">…and {total - items.length} more</li>}
                </ul>
            )}
        </div>
    )
}

/**
 * Restore one snapshot: what will change → typed confirmation → live progress
 * → result (with one-click undo via the safety snapshot).
 */
export default function RestoreWizard({ clusterId, clusterName, snapshot, controlPlanes = 1, resumeJobId = null, onClose, onFinished, onUndo, explorer = false }) {
    const live = explorer ? (o) => explorerResourceLink(clusterId, o.kind, o.namespace, o.name) : null
    const [phase, setPhase] = useState(resumeJobId ? 'running' : 'preview')
    const [preview, setPreview] = useState(null)
    const [previewErr, setPreviewErr] = useState(null)
    const [typed, setTyped] = useState('')
    const [startErr, setStartErr] = useState(null)
    const [refreshing, setRefreshing] = useState(false)
    const [refreshMsg, setRefreshMsg] = useState(null)
    const { job, watch } = useEtcdJob(clusterId, () => { setPhase('done'); onFinished?.() })

    useEffect(() => { if (resumeJobId) watch(resumeJobId) }, [resumeJobId])

    useEffect(() => {
        if (phase !== 'preview' || !snapshot) return
        let gone = false
        ;(async () => {
            try {
                const r = await apiFetch(`/api/clusters/${clusterId}/etcd/preview?filename=${encodeURIComponent(snapshot.filename)}`)
                const j = await r.json().catch(() => ({}))
                if (gone) return
                if (!r.ok) throw new Error(j.error || 'Could not compute the preview')
                if (!j.ok) throw new Error(j.error || 'Could not compute the preview')
                setPreview(j)
            } catch (e) {
                if (!gone) setPreviewErr(e.message)
            }
        })()
        return () => { gone = true }
    }, [snapshot?.filename])

    const start = async () => {
        setStartErr(null)
        try {
            const id = await startJob(`/api/clusters/${clusterId}/etcd/restore`, { filename: snapshot.filename, confirm: typed })
            setPhase('running'); watch(id)
        } catch (e) {
            if (e.jobId) { setPhase('running'); watch(e.jobId) } else setStartErr(e.message)
        }
    }

    const refreshWorkers = async () => {
        setRefreshing(true); setRefreshMsg(null)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/etcd/refresh-workers`, { method: 'POST' })
            const j = await r.json().catch(() => ({}))
            const bad = (j.results || []).filter(x => !x.ok)
            setRefreshMsg(r.ok && !bad.length ? { ok: true, msg: 'Kubelet restarted on every worker.' } : { ok: false, msg: bad.map(b => `${b.ip}: ${b.error}`).join(' · ') || j.error })
        } catch (e) { setRefreshMsg({ ok: false, msg: e.message }) } finally { setRefreshing(false) }
    }

    const running = phase === 'running' && job?.status !== 'succeeded' && job?.status !== 'failed'
    const result = job?.result || {}

    // Portal: the panels use backdrop-filter, which would trap position:fixed inside them
    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
            <div className="glass border border-amber-500/30 rounded-3xl max-w-2xl w-full p-6 sm:p-8 shadow-2xl relative max-h-[92vh] overflow-y-auto">
                {!running && <button onClick={onClose} aria-label="Close" className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>}

                {/* ── 1. What will change ── */}
                {phase === 'preview' && (
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <Eye className="w-5 h-5 text-amber-400" />
                            <h2 className="text-xl font-black text-white">What this restore changes</h2>
                        </div>
                        <p className="text-xs text-slate-400 mb-4">Back to <span className="text-white font-bold">{fmtWhen(snapshot.created)}</span> <span className="font-mono text-slate-500">({snapshot.filename})</span>. Read from the snapshot — nothing has been touched yet.</p>

                        {!preview && !previewErr && (
                            <div className="py-10 flex flex-col items-center gap-3 text-slate-500 text-sm">
                                <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
                                Comparing the snapshot with the live cluster…
                            </div>
                        )}
                        {previewErr && (
                            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-xs text-amber-300 mb-4">
                                Could not compute the preview: {previewErr}. You can still restore — everything changed after the snapshot will be lost.
                            </div>
                        )}
                        {preview && (
                            <div className="space-y-3 mb-4">
                                <div className="grid sm:grid-cols-3 gap-3">
                                    <ObjectList linkTo={live} items={preview.removed} total={preview.counts.removed} icon={Trash2} tone="red" title="Removed" empty="Nothing was created after the snapshot." />
                                    <ObjectList items={preview.restored} total={preview.counts.restored} icon={Undo2} tone="emerald" title="Comes back" empty="Nothing was deleted after the snapshot." />
                                    <ObjectList linkTo={live} items={preview.reverted} total={preview.counts.reverted} icon={PencilLine} tone="amber" title="Reverted" empty="No tracked object was edited after the snapshot." />
                                </div>
                                <p className="text-[10px] text-slate-500 leading-relaxed">
                                    <span className="text-slate-400 font-bold">Removed</span> = created after the snapshot. <span className="text-slate-400 font-bold">Comes back</span> = deleted after it. <span className="text-slate-400 font-bold">Reverted</span> = edited after it (configs, secrets, services, workloads — for workloads this includes status-only changes like replicas becoming ready). Pods are recreated by their controllers either way.
                                </p>
                                {preview.warnings?.map(w => (
                                    <div key={w.code} className="flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[11px] text-amber-200 leading-relaxed">
                                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" /> {w.message}
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-3 justify-end">
                            <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-white/10 hover:bg-white/5 text-slate-300 font-bold text-xs uppercase tracking-wider">Cancel</button>
                            <button onClick={() => setPhase('confirm')} disabled={!preview && !previewErr}
                                className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-black text-xs uppercase tracking-wider disabled:opacity-40">Continue</button>
                        </div>
                    </div>
                )}

                {/* ── 2. Confirm ── */}
                {phase === 'confirm' && (
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <div className="p-3 bg-amber-500/10 rounded-2xl border border-amber-500/20"><AlertTriangle className="w-6 h-6 text-amber-500" /></div>
                            <div>
                                <h2 className="text-xl font-black text-white">Restore the whole cluster state?</h2>
                                <p className="text-xs text-slate-400">Back to {fmtWhen(snapshot.created)}</p>
                            </div>
                        </div>
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 mb-3 text-[11px] text-slate-300 space-y-1">
                            <p className="flex items-center gap-1.5 text-emerald-300 font-black uppercase tracking-wider text-[10px] mb-1"><ShieldCheck className="w-3.5 h-3.5" /> Safety net</p>
                            <p>• The snapshot is checked first (checksum + etcd integrity) — a damaged one is refused before anything stops.</p>
                            <p>• A <span className="text-white font-bold">safety snapshot</span> of the current state is taken → one click undoes this restore.</p>
                            <p>• If the control plane does not come back on the restored data, KubeEZ <span className="text-white font-bold">rolls back automatically</span>.</p>
                        </div>
                        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 mb-4 text-[11px] text-amber-200/90 space-y-1">
                            <p>• The Kubernetes API is unavailable for about 1–3 minutes{controlPlanes > 1 ? ` (all ${controlPlanes} control-planes restart; their etcd members re-join one by one)` : ''}. Running pods keep running.</p>
                            <p>• Files inside persistent volumes are <span className="font-bold">not</span> part of an etcd snapshot — they stay as they are now.</p>
                        </div>
                        <label htmlFor="confirm-name" className="block text-[11px] text-slate-400 mb-1.5">Type <span className="font-mono text-white">{clusterName}</span> to confirm</label>
                        <input id="confirm-name" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" autoFocus
                            className="w-full bg-black/40 border border-white/10 focus:border-amber-500/50 rounded-xl px-3 py-2.5 text-sm text-white outline-none mb-3" />
                        {startErr && <p className="text-xs text-red-400 mb-3">{startErr}</p>}
                        <div className="flex gap-3 justify-end">
                            <button onClick={() => setPhase('preview')} className="px-4 py-2.5 rounded-xl border border-white/10 hover:bg-white/5 text-slate-300 font-bold text-xs uppercase tracking-wider">Back</button>
                            <button onClick={start} disabled={typed.trim() !== String(clusterName).trim()}
                                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-black text-xs uppercase tracking-wider disabled:opacity-40">
                                <RotateCcw className="w-3.5 h-3.5" /> Restore
                            </button>
                        </div>
                    </div>
                )}

                {/* ── 3/4. Progress + result ── */}
                {(phase === 'running' || phase === 'done') && (
                    <div>
                        <JobProgress job={job} runningTitle="Restoring etcd…" doneTitle="Restore complete" failedTitle="Restore failed"
                            hint={job?.status === 'succeeded' ? 'The control plane runs on the restored data.' : 'Step-by-step log below.'} />
                        {!job && <div className="py-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-amber-400" /></div>}

                        {job?.status === 'succeeded' && (
                            <div className="mt-4 space-y-3">
                                {result.warnings?.map((w, i) => (
                                    <div key={i} className="flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[11px] text-amber-200"><AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" /> {w}</div>
                                ))}
                                {result.unrefreshedWorkers?.length > 0 && (
                                    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] text-slate-300">
                                        <span>{refreshMsg ? <span className={refreshMsg.ok ? 'text-emerald-300' : 'text-red-300'}>{refreshMsg.msg}</span> : `Workers not refreshed yet: ${result.unrefreshedWorkers.join(', ')}`}</span>
                                        <button onClick={refreshWorkers} disabled={refreshing} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white font-bold shrink-0 disabled:opacity-50">
                                            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh workers
                                        </button>
                                    </div>
                                )}
                                {result.safetySnapshot && (
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 text-[11px] text-slate-300">
                                        <span className="flex gap-2"><Info className="w-4 h-4 text-emerald-400 shrink-0" /> Changed your mind? The state from right before this restore was saved as <span className="font-mono text-white break-all">{result.safetySnapshot}</span>.</span>
                                        {onUndo && <button onClick={() => onUndo(result.safetySnapshot)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 font-bold shrink-0"><Undo2 className="w-3 h-3" /> Undo this restore</button>}
                                    </div>
                                )}
                            </div>
                        )}
                        {job?.status === 'failed' && result.safetySnapshot && (
                            <p className="mt-3 text-[11px] text-slate-400">The safety snapshot taken before this attempt is kept: <span className="font-mono text-slate-300">{result.safetySnapshot}</span>.</p>
                        )}
                        {job && job.status !== 'running' && (
                            <button onClick={onClose} className="mt-4 w-full px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold text-xs uppercase tracking-wider">Close</button>
                        )}
                    </div>
                )}
            </div>
        </div>,
        document.body
    )
}
