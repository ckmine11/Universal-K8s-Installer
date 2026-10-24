import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { UserCheck, Loader2, X, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import useBackdropClose from '../ui/useBackdropClose'
import { whenVisible } from '../../utils/whenVisible'

// Two-person rule, in one place: when an action answers "needs a second
// admin's approval" (428), this dialog asks for it (with a reason), waits for
// the decision and then runs the very same request again — the page that
// started it just receives the result. Closing keeps the request; the
// Approvals page shows it.
export default function ApprovalGate() {
    const [ctx, setCtx] = useState(null)            // { url, options, info, response, resolve }
    const [phase, setPhase] = useState('ask')       // ask | waiting | denied | running | error
    const [reason, setReason] = useState('')
    const [req, setReq] = useState(null)
    const [error, setError] = useState('')
    const timer = useRef(null)

    useEffect(() => {
        window.__kubeezApprovalGate = (c) => new Promise(resolve => {
            setCtx({ ...c, resolve }); setReason(''); setError('')
            const ex = c.info.existing
            if (ex?.status === 'approved') { setReq(ex); setPhase('running'); run({ ...c, resolve }, ex.id) }
            else if (ex?.status === 'pending') { setReq(ex); setPhase('waiting') }
            else { setReq(null); setPhase('ask') }
        })
        return () => { delete window.__kubeezApprovalGate }
    }, [])

    const finish = (response) => { clearInterval(timer.current); ctx?.resolve?.(response); setCtx(null) }
    const close = () => finish(ctx?.response)
    const backdrop = useBackdropClose(close)

    const run = async (c, id) => {
        try {
            const res = await apiFetch(c.url, { ...c.options, skipApprovalGate: true, headers: { ...(c.options.headers || {}), 'x-kubeez-approval': id } })
            clearInterval(timer.current); c.resolve(res); setCtx(null)
        } catch (e) { setError(e.message); setPhase('error') }
    }

    // waiting: check every few seconds
    useEffect(() => {
        clearInterval(timer.current)
        if (phase !== 'waiting' || !req?.id) return
        const check = async () => {
            const r = await apiFetch(`/api/approvals/${req.id}`).catch(() => null)
            const d = r?.ok ? await r.json() : null
            if (!d) return
            if (d.status === 'approved') { setReq(d); setPhase('running'); run(ctx, d.id) }
            else if (['denied', 'expired', 'cancelled'].includes(d.status)) { setReq(d); setPhase('denied') }
        }
        timer.current = setInterval(whenVisible(check), 3000)
        return () => clearInterval(timer.current)
    }, [phase, req?.id])

    const ask = async (e) => {
        e.preventDefault(); setError('')
        let body = {}
        try { body = ctx.options.body ? JSON.parse(ctx.options.body) : {} } catch { }
        const path = new URL(ctx.url, window.location.origin).pathname
        const r = await apiFetch('/api/approvals', { method: 'POST', body: JSON.stringify({ kind: 'action', action: ctx.info.action, clusterId: ctx.info.clusterId, method: ctx.options.method || 'GET', path, body, reason }) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) return setError(d.error || 'Could not ask for approval')
        setReq(d); setPhase(d.status === 'approved' ? 'running' : 'waiting')
        if (d.status === 'approved') run(ctx, d.id)
    }

    if (!ctx) return null
    return createPortal(
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" {...backdrop}>
            <div onClick={e => e.stopPropagation()} className="kz-card w-full max-w-lg p-7" role="dialog" aria-label="Approval needed">
                <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-2xl border border-white/10 bg-[#15151c]"><UserCheck className="w-5 h-5 text-blue-300" /></div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-semibold text-white">A second admin has to approve this</h3>
                        <p className="mt-1 text-sm text-slate-300">{ctx.info.summary}</p>
                    </div>
                    <button onClick={close} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-4 h-4" /></button>
                </div>

                {phase === 'ask' && (
                    <form onSubmit={ask} className="mt-5 space-y-3">
                        <p className="text-xs text-slate-400">Your workspace protects this action with the two-person rule. Say why — the approver sees it, and both of you are in the audit trail.</p>
                        <textarea className="kz-input min-h-[84px]" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Monthly patch window, change CHG-1042" autoFocus maxLength={300} />
                        {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2" role="alert">{error}</p>}
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={close} className="kz-btn-ghost">Cancel</button>
                            <button type="submit" disabled={reason.trim().length < 5} className="kz-btn-primary">Ask for approval</button>
                        </div>
                    </form>
                )}
                {phase === 'waiting' && (
                    <div className="mt-5 rounded-2xl border border-white/[0.07] bg-black/25 p-4">
                        <div className="flex items-center gap-2 text-sm text-white"><Loader2 className="w-4 h-4 animate-spin text-blue-300" /> Waiting for a second admin…</div>
                        <p className="mt-2 text-xs text-slate-400 leading-relaxed">They got an alert. As soon as someone approves, this runs by itself. You can close this window — the request stays on the <Link to="/approvals" onClick={close} className="text-blue-300 hover:underline">Approvals</Link> page, and the approval is valid for an hour.</p>
                    </div>
                )}
                {phase === 'running' && (
                    <div className="mt-5 flex items-center gap-2 text-sm text-emerald-300"><CheckCircle2 className="w-4 h-4" /> Approved{req?.decidedBy ? ` by ${req.decidedBy.username}` : ''} — running it now…</div>
                )}
                {phase === 'denied' && (
                    <div className="mt-5 space-y-3">
                        <div className="flex items-start gap-2 text-sm text-rose-300"><XCircle className="w-4 h-4 mt-0.5" />
                            <span>{req?.status === 'denied' ? <>Denied{req.decidedBy ? ` by ${req.decidedBy.username}` : ''}{req.comment ? `: “${req.comment}”` : ''}</> : req?.status === 'expired' ? 'The request expired.' : 'The request was cancelled.'}</span>
                        </div>
                        <div className="flex justify-end"><button onClick={close} className="kz-btn-ghost">Close</button></div>
                    </div>
                )}
                {phase === 'error' && <p className="mt-4 text-xs text-rose-300">{error}</p>}
                <p className="mt-5 flex items-center gap-1.5 text-[11px] text-slate-500"><Clock className="w-3.5 h-3.5" /> An approval is for exactly this request, once.</p>
            </div>
        </div>
    , document.body)
}
