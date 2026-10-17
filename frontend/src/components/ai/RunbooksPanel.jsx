import { useState, useEffect, useCallback } from 'react'
import { Loader2, Trash2, Zap } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'

// Settings → AI → Runbooks: the fixes KubeEZ learned (what really solved a
// problem on a workload), and which proven low-risk ones may run by themselves.
const TYPE = { restart: 'Restart', rollback: 'Roll back', scale: 'Scale', 'delete-pod': 'Delete the pod' }

function Toggle({ on, onChange, disabled, label }) {
    return (
        <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-blue-500' : 'bg-white/15'} disabled:opacity-40`}>
            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-5' : 'left-1'}`} />
        </button>
    )
}

export default function RunbooksPanel({ autonomy }) {
    const { toast } = useToast()
    const [list, setList] = useState(null)
    const load = useCallback(() => apiFetch('/api/ai/runbooks').then(r => r.json()).then(d => setList(d.runbooks || [])).catch(() => setList([])), [])
    useEffect(() => { load() }, [load])

    const setAuto = async (rb, auto) => {
        const res = await apiFetch(`/api/ai/runbooks/${rb.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) return toast({ title: 'Not changed', message: d.error, type: 'error' })
        toast({ title: auto ? 'Runs by itself now' : 'Asks a person again', message: auto && autonomy !== 'auto' ? 'It runs by itself only while "When AI suggests a fix" is set to "Auto for low-risk".' : `${TYPE[rb.action.type]} ${rb.scope}`, type: 'success' })
        load()
    }
    const remove = async (rb) => {
        if (!window.confirm('Forget this runbook?')) return
        await apiFetch(`/api/ai/runbooks/${rb.id}`, { method: 'DELETE' }); load()
    }

    if (!list) return <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
    if (!list.length) return <p className="text-sm text-slate-400">Nothing learned yet. When a fix applied from “Explain with AI” makes the problem go away, KubeEZ remembers it here and offers it first next time.</p>
    return (
        <div className="space-y-3">
            {autonomy !== 'auto' && <p className="text-[11px] text-slate-500">Runbooks can only run by themselves while “When AI suggests a fix” (Safety) is set to <b>Auto for low-risk</b>. Until then they are offered to a person.</p>}
            <ul className="space-y-2">
                {list.map(rb => (
                    <li key={rb.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
                        <div className="flex-1 min-w-[240px]">
                            <p className="text-sm font-semibold text-white">{TYPE[rb.action.type] || rb.action.type}{rb.action.type === 'scale' ? ` to ${rb.action.replicas}` : ''} <span className="font-mono text-xs text-slate-400">{rb.scope}</span></p>
                            <p className="text-[11px] text-slate-500">When: {rb.reasonLabel || rb.reason} · on {rb.clusterName} · worked <b className={rb.rate >= 80 ? 'text-emerald-300' : rb.rate >= 50 ? 'text-amber-300' : 'text-red-300'}>{rb.successes} of {rb.successes + rb.failures}</b>{rb.lastAt ? ` · last ${new Date(rb.lastAt).toLocaleDateString()} (${rb.lastNote || rb.lastResult})` : ''}{rb.autoRuns?.length ? ` · ran by itself ${rb.autoRuns.length}× today` : ''}</p>
                        </div>
                        <div className="flex items-center gap-2" title={rb.autoBlocked || 'Run it by itself when this problem comes back on this workload'}>
                            <Zap className={`w-3.5 h-3.5 ${rb.auto ? 'text-amber-300' : 'text-slate-600'}`} />
                            <span className="text-[11px] text-slate-400">Automatic</span>
                            <Toggle on={rb.auto} disabled={!rb.auto && !!rb.autoBlocked} onChange={v => setAuto(rb, v)} label={`Run ${rb.scope} automatically`} />
                        </div>
                        <button onClick={() => remove(rb)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-300 hover:bg-red-500/10" aria-label="Forget this runbook"><Trash2 className="w-3.5 h-3.5" /></button>
                        {!rb.auto && rb.autoBlocked && <p className="basis-full text-[11px] text-slate-500 ml-1">Automatic not possible yet: {rb.autoBlocked}.</p>}
                    </li>
                ))}
            </ul>
        </div>
    )
}
