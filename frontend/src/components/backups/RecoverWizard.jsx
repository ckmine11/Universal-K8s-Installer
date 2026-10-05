import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../context/AuthContext'
import JobProgress from './JobProgress'
import { useEtcdJob, startJob } from './useEtcdJob'
import { X, Loader2, LifeBuoy, AlertTriangle, ChevronDown, Server, CheckCircle2 } from 'lucide-react'

// etcd-<kind>-YYYYmmdd-HHMMSS.tar.gz.enc → readable time
function bundleWhen(name) {
    const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
    if (!m) return name
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Disaster recovery: the control-plane MACHINE is gone. The user brings up a
 * fresh machine with the same IP + login; KubeEZ rebuilds the control plane
 * from an encrypted offsite backup (certificates + etcd). Workers reconnect.
 */
export default function RecoverWizard({ clusterId, clusterName, masterIp, controlPlanes = 1, resumeJobId = null, onClose, onFinished }) {
    const [phase, setPhase] = useState(resumeJobId ? 'running' : 'intro')
    const [list, setList] = useState(null)
    const [listErr, setListErr] = useState(null)
    const [selected, setSelected] = useState('')
    const [typed, setTyped] = useState('')
    const [startErr, setStartErr] = useState(null)
    const { job, watch } = useEtcdJob(clusterId, () => { setPhase('done'); onFinished?.() })
    useEffect(() => { if (resumeJobId) watch(resumeJobId) }, [resumeJobId])

    const loadList = async () => {
        setList(null); setListErr(null)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/etcd/offsite`)
            const j = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(j.error || 'Could not list the offsite backups')
            if (!j.connected) throw new Error('No offsite storage is connected — recovery needs the offsite backups.')
            if (!j.ok) throw new Error(j.error || 'Could not list the offsite backups')
            const names = [...(j.remote || [])].sort().reverse()
            setList(names)
            setSelected(names[0] || '')
        } catch (e) { setListErr(e.message) }
    }

    const start = async () => {
        setStartErr(null)
        try {
            const id = await startJob(`/api/clusters/${clusterId}/etcd/recover`, { filename: selected.replace(/\.tar\.gz\.enc$/, '.db'), confirm: typed })
            setPhase('running'); watch(id)
        } catch (e) {
            if (e.jobId) { setPhase('running'); watch(e.jobId) } else setStartErr(e.message)
        }
    }
    const running = phase === 'running' && job?.status !== 'succeeded' && job?.status !== 'failed'

    // Portal: the panels use backdrop-filter, which would trap position:fixed inside them
    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
            <div className="glass border border-sky-500/30 rounded-3xl max-w-xl w-full p-6 sm:p-8 shadow-2xl relative max-h-[92vh] overflow-y-auto">
                {!running && <button onClick={onClose} aria-label="Close" className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>}

                {phase === 'intro' && (
                    <div>
                        <div className="flex items-center gap-3 mb-4">
                            <div className="p-3 bg-sky-500/10 rounded-2xl border border-sky-500/20"><LifeBuoy className="w-6 h-6 text-sky-400" /></div>
                            <div>
                                <h2 className="text-xl font-black text-white">Recover a lost control-plane</h2>
                                <p className="text-xs text-slate-400">For when the control-plane machine itself is gone — disk failure, deleted VM.</p>
                            </div>
                        </div>
                        <ol className="space-y-2.5 text-[12px] text-slate-300 mb-5">
                            <li className="flex gap-2.5"><span className="w-5 h-5 rounded-full bg-sky-500/15 text-sky-300 text-[10px] font-black flex items-center justify-center shrink-0">1</span>
                                <span>Bring up a fresh Linux machine with the <span className="text-white font-bold">same IP ({masterIp})</span> and the same SSH login. The workers find it again at that address.</span></li>
                            <li className="flex gap-2.5"><span className="w-5 h-5 rounded-full bg-sky-500/15 text-sky-300 text-[10px] font-black flex items-center justify-center shrink-0">2</span>
                                <span>KubeEZ prepares it, downloads + decrypts the offsite backup on it, and installs the Kubernetes version the backup was taken on.</span></li>
                            <li className="flex gap-2.5"><span className="w-5 h-5 rounded-full bg-sky-500/15 text-sky-300 text-[10px] font-black flex items-center justify-center shrink-0">3</span>
                                <span>It puts the cluster's <span className="text-white font-bold">certificate authorities</span> back and restores etcd, then kubeadm rebuilds the control plane around them — every worker, kubeconfig and token stays valid.</span></li>
                        </ol>
                        {controlPlanes > 1 && <p className="text-[11px] text-slate-400 mb-4">HA cluster: control-planes that are still alive are re-joined to the recovered etcd afterwards.</p>}
                        <div className="flex gap-3 justify-end">
                            <button onClick={onClose} className="px-4 py-2.5 rounded-xl border border-white/10 hover:bg-white/5 text-slate-300 font-bold text-xs uppercase tracking-wider">Cancel</button>
                            <button onClick={() => { setPhase('choose'); loadList() }} className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-black text-xs uppercase tracking-wider">
                                <Server className="w-3.5 h-3.5" /> The new machine is up
                            </button>
                        </div>
                    </div>
                )}

                {phase === 'choose' && (
                    <div>
                        <h2 className="text-xl font-black text-white mb-1">Choose the offsite backup</h2>
                        <p className="text-xs text-slate-400 mb-4">Listed from the storage through the new machine at {masterIp}.</p>
                        {!list && !listErr && <div className="py-8 flex flex-col items-center gap-2 text-sm text-slate-500"><Loader2 className="w-6 h-6 animate-spin text-sky-400" /> Connecting to {masterIp}…</div>}
                        {listErr && (
                            <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-xs text-red-300 mb-4">
                                {listErr}
                                <button onClick={loadList} className="block mt-2 text-blue-300 font-bold hover:underline">Try again</button>
                            </div>
                        )}
                        {list && !list.length && <p className="text-sm text-amber-300 mb-4">No offsite backups of this cluster were found.</p>}
                        {list?.length > 0 && (
                            <>
                                <div className="relative mb-4">
                                    <select value={selected} onChange={e => setSelected(e.target.value)} aria-label="Offsite backup"
                                        className="w-full appearance-none bg-black/40 border border-white/10 rounded-xl pl-4 pr-10 py-3 text-sm text-white outline-none">
                                        {list.map(n => <option key={n} value={n} className="bg-slate-900">{bundleWhen(n)} — {n.includes('pre-upgrade') ? 'before upgrade' : n.includes('pre-restore') ? 'before restore' : 'manual'}</option>)}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                                </div>
                                <div className="flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 mb-4 text-[11px] text-amber-200/90">
                                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                                    <span>Everything changed after this backup is lost. KubeEZ refuses to run if a control plane is still running on {masterIp} — use Restore for that.</span>
                                </div>
                                <label htmlFor="recover-confirm" className="block text-[11px] text-slate-400 mb-1.5">Type <span className="font-mono text-white">{clusterName}</span> to confirm</label>
                                <input id="recover-confirm" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off"
                                    className="w-full bg-black/40 border border-white/10 focus:border-sky-500/50 rounded-xl px-3 py-2.5 text-sm text-white outline-none mb-3" />
                                {startErr && <p className="text-xs text-red-400 mb-3">{startErr}</p>}
                            </>
                        )}
                        <div className="flex gap-3 justify-end">
                            <button onClick={() => setPhase('intro')} className="px-4 py-2.5 rounded-xl border border-white/10 hover:bg-white/5 text-slate-300 font-bold text-xs uppercase tracking-wider">Back</button>
                            <button onClick={start} disabled={!selected || typed.trim() !== String(clusterName).trim()}
                                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-black text-xs uppercase tracking-wider disabled:opacity-40">
                                <LifeBuoy className="w-3.5 h-3.5" /> Recover
                            </button>
                        </div>
                    </div>
                )}

                {(phase === 'running' || phase === 'done') && (
                    <div>
                        <JobProgress job={job} runningTitle="Recovering the control-plane…" doneTitle="Control-plane recovered" failedTitle="Recovery failed"
                            hint={job?.status === 'succeeded' ? 'The cluster runs again from the backup.' : 'Fix the reported problem, then run the recovery again.'} />
                        {!job && <div className="py-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-sky-400" /></div>}
                        {job?.status === 'succeeded' && (
                            <div className="mt-3 space-y-2">
                                {(job.result?.warnings || []).map((w, i) => <p key={i} className="text-[11px] text-amber-300">⚠️ {w}</p>)}
                                <p className="flex items-center gap-1.5 text-[11px] text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> Download a fresh kubeconfig if yours stops working — the certificate authorities are the same, so it usually keeps working.</p>
                            </div>
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
