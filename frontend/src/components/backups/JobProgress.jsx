import { useEffect, useRef } from 'react'
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'

// Progress bar + current step + live log of an etcd job
export default function JobProgress({ job, runningTitle, doneTitle, failedTitle, hint }) {
    const logRef = useRef(null)
    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    }, [job?.logs?.length])
    if (!job) return null
    const running = job.status === 'running'
    const ok = job.status === 'succeeded'

    return (
        <div>
            <div className="flex items-center gap-3 mb-3">
                {running ? <Loader2 className="w-6 h-6 animate-spin text-amber-400 shrink-0" />
                    : ok ? <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                        : <AlertTriangle className="w-6 h-6 text-red-400 shrink-0" />}
                <div className="min-w-0">
                    <h2 className="text-lg font-black text-white">{running ? runningTitle : ok ? doneTitle : failedTitle}</h2>
                    <p className="text-[11px] text-slate-500 truncate">{running ? (job.step || 'Starting…') : hint}</p>
                </div>
            </div>

            <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-3" role="progressbar" aria-valuenow={job.progress || 0} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-full transition-all duration-700 ${ok ? 'bg-emerald-500' : !running ? 'bg-red-500' : 'bg-amber-400'}`} style={{ width: `${Math.max(3, job.progress || 0)}%` }} />
            </div>

            {!running && job.error && (
                <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-xs text-red-300 leading-relaxed">{job.error}</div>
            )}

            {job.logs?.length > 0 && (
                <div ref={logRef} className="bg-black/50 border border-white/10 rounded-xl p-3 max-h-64 overflow-y-auto font-mono text-[10px] leading-relaxed">
                    {job.logs.map((l, i) => (
                        <div key={i} className={l.level === 'warning' || /⚠️/.test(l.msg) ? 'text-amber-400' : l.level === 'error' || /❌/.test(l.msg) ? 'text-red-400' : /✓/.test(l.msg) ? 'text-emerald-300/90' : 'text-slate-300'}>{l.msg}</div>
                    ))}
                </div>
            )}
        </div>
    )
}
