import { useState } from 'react'
import { Loader2, ShieldCheck, Play, Undo2, CheckCircle2, AlertTriangle, Eye } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'

// A fix KubeEZ AI suggested: preview (current state, the change, a server-side
// dry-run, how to undo) → apply (two-person approval if the workspace wants
// it) → undo. Also used for the list of applied fixes on the cluster page.
const RISK = { low: 'text-emerald-300 border-emerald-400/30', medium: 'text-amber-300 border-amber-400/30', high: 'text-red-300 border-red-400/30' }
const TYPE = { restart: 'Restart', rollback: 'Roll back', scale: 'Scale', 'delete-pod': 'Delete pod' }
export const actionLabel = (s) => `${TYPE[s.type] || s.type} ${s.kind === 'pod' ? 'pod' : s.kind} ${s.namespace}/${s.name}${s.type === 'scale' ? ` to ${s.replicas}` : ''}`

async function post(url, body) {
    const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(d.error || 'Request failed')
    return d
}

export function UndoButton({ clusterId, rec, onDone }) {
    const { toast } = useToast()
    const [busy, setBusy] = useState(false)
    if (!rec.canUndo) return null
    const undo = async () => {
        if (!window.confirm(`Undo "${rec.title}"?\n\n${rec.undo?.text || ''}`)) return
        setBusy(true)
        try { const r = await post(`/api/clusters/${clusterId}/ai-actions/${rec.id}/undo`); toast({ title: 'Undone', message: r.title, type: 'success' }); onDone?.(r) }
        catch (e) { toast({ title: 'Undo failed', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }
    return <button onClick={undo} disabled={busy} className="kz-btn-ghost !py-1.5 !text-xs">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Undo</button>
}

export default function FixPreview({ clusterId, spec, incidentId }) {
    const { toast } = useToast()
    const [plan, setPlan] = useState(null)
    const [busy, setBusy] = useState(null)   // 'preview' | 'apply'
    const [reason, setReason] = useState('')
    const [done, setDone] = useState(null)

    const preview = async () => {
        setBusy('preview')
        try { setPlan(await post(`/api/clusters/${clusterId}/ai-actions/preview`, { spec })) }
        catch (e) { toast({ title: 'No preview', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }
    const apply = async () => {
        setBusy('apply')
        try {
            const r = await post(`/api/clusters/${clusterId}/ai-actions`, { spec, incidentId: incidentId || null, reason: reason.trim() || null })
            setDone(r); toast({ title: 'Fix applied', message: r.title, type: 'success' })
        } catch (e) { if (!/approval/i.test(e.message)) toast({ title: 'Not applied', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }

    if (done) return (
        <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/[0.06] p-3 space-y-2">
            <p className="flex items-center gap-2 text-xs font-semibold text-emerald-200"><CheckCircle2 className="w-4 h-4" /> {done.status === 'undone' ? `Undone: ${done.title}` : `Applied: ${done.title}`}</p>
            <p className="text-[11px] text-slate-400">{done.change}</p>
            {done.status !== 'undone' && <div className="flex items-center gap-2"><UndoButton clusterId={clusterId} rec={done} onDone={setDone} /><span className="text-[11px] text-slate-500">{done.undo?.text}</span></div>}
        </div>
    )

    return (
        <div className="rounded-xl border border-blue-400/25 bg-blue-500/[0.05] p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-blue-300" />
                <span className="text-xs font-semibold text-white flex-1">Suggested fix: {actionLabel(spec)}</span>
                {!plan && <button onClick={preview} disabled={!!busy} className="kz-btn-ghost !py-1.5 !text-xs">{busy === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Preview (dry-run)</button>}
            </div>
            {plan && (
                <div className="space-y-2 text-xs">
                    <div className="flex flex-wrap gap-2">
                        <span className={`kz-chip ${RISK[plan.risk] || ''}`}>risk: {plan.risk}</span>
                        {plan.before?.images?.length > 0 && <span className="kz-chip font-mono">now: {plan.before.images.join(', ')}{plan.before.replicas != null ? ` · ${plan.before.replicas} replica(s)` : ''}</span>}
                    </div>
                    <p className="text-slate-200">{plan.change}</p>
                    {plan.blocked
                        ? <p className="flex items-start gap-1.5 text-amber-200"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{plan.blocked}</p>
                        : <p className={`flex items-start gap-1.5 ${plan.dryRun.ok ? 'text-emerald-300' : 'text-red-300'}`}>{plan.dryRun.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}Dry-run on the cluster {plan.dryRun.ok ? 'passed' : 'failed'}{plan.dryRun.output ? `: ${plan.dryRun.output}` : ''}</p>}
                    <p className="text-slate-400"><Undo2 className="inline w-3.5 h-3.5 mr-1" />{plan.undo.text}</p>
                    {plan.ok && <>
                        <input className="kz-input !py-1.5 !text-xs" value={reason} onChange={e => setReason(e.target.value)} maxLength={300} placeholder="Why (optional — goes into the audit trail)" aria-label="Reason" />
                        <div className="flex gap-2">
                            <button onClick={apply} disabled={!!busy} className="kz-btn-primary !py-1.5 !text-xs">{busy === 'apply' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Apply</button>
                            <button onClick={() => setPlan(null)} disabled={!!busy} className="kz-btn-ghost !py-1.5 !text-xs">Cancel</button>
                        </div>
                    </>}
                </div>
            )}
        </div>
    )
}
