import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Timer, Loader2, X, Ban, KeyRound } from 'lucide-react'
import { apiFetch, useAuth } from '../context/AuthContext'
import { useToast } from './ToastProvider'
import useBackdropClose from './ui/useBackdropClose'
import { whenVisible } from '../utils/whenVisible'

// Temporary access on this cluster (members, not admins): ask for a role for
// some minutes; see it waiting / active with its end; end it early.
function RequestDialog({ clusterId, clusterName, onClose, onSent }) {
    const backdrop = useBackdropClose(onClose)
    const { toast } = useToast()
    const [opts, setOpts] = useState(null)
    const [role, setRole] = useState('operator')
    const [minutes, setMinutes] = useState(60)
    const [reason, setReason] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    useEffect(() => { apiFetch('/api/approvals/options').then(r => r.ok ? r.json() : null).then(setOpts).catch(() => { }) }, [])
    const send = async (e) => {
        e.preventDefault(); setBusy(true); setError('')
        try {
            const r = await apiFetch('/api/approvals', { method: 'POST', body: JSON.stringify({ kind: 'elevation', clusterId, role, minutes, reason }) })
            const d = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(d.error || 'Could not send the request')
            toast({ title: 'Request sent', message: 'An approver got an alert. The access starts as soon as it is approved.', type: 'success' })
            onSent()
        } catch (err) { setError(err.message) } finally { setBusy(false) }
    }
    return createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" {...backdrop}>
            <form onSubmit={send} onClick={e => e.stopPropagation()} className="kz-card w-full max-w-md p-7 space-y-4" role="dialog" aria-label="Request temporary access">
                <div className="flex items-start gap-3">
                    <div className="p-2.5 rounded-2xl border border-white/10 bg-[#15151c]"><KeyRound className="w-5 h-5 text-blue-300" /></div>
                    <div className="flex-1">
                        <h3 className="text-lg font-semibold text-white">Temporary access · {clusterName}</h3>
                        <p className="text-xs text-slate-400">More rights for a while — an approver decides, and it ends by itself.</p>
                    </div>
                    <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-4 h-4" /></button>
                </div>
                {!opts ? <Loader2 className="w-5 h-5 animate-spin text-slate-500" /> : !opts.allowed ? <p className="text-sm text-slate-300">Temporary access is part of Pro.</p> : (<>
                    <div>
                        <label className="kz-label" htmlFor="el-role">Role on this cluster</label>
                        <select id="el-role" className="kz-input" value={role} onChange={e => setRole(e.target.value)}>
                            {opts.roles.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}
                        </select>
                    </div>
                    <div>
                        <span className="kz-label">For</span>
                        <div className="flex flex-wrap gap-2">
                            {opts.minutes.map(m => (
                                <button type="button" key={m} onClick={() => setMinutes(m)}
                                    className={`rounded-xl border px-3 py-1.5 text-sm ${minutes === m ? 'border-blue-400/60 bg-blue-500/10 text-white' : 'border-white/10 text-slate-300 hover:border-white/20'}`}>
                                    {m < 60 ? `${m} min` : `${m / 60} h`}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="kz-label" htmlFor="el-reason">Why</label>
                        <textarea id="el-reason" className="kz-input min-h-[80px]" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Incident INC-221: restart the payments deployment" maxLength={300} />
                    </div>
                    {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2" role="alert">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={onClose} className="kz-btn-ghost">Cancel</button>
                        <button type="submit" disabled={busy || reason.trim().length < 5} className="kz-btn-primary">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Send request</button>
                    </div>
                </>)}
            </form>
        </div>
    , document.body)
}

export default function ElevationBar({ clusterId, clusterName }) {
    const { user, refreshAccess } = useAuth()
    const { toast } = useToast()
    const [mine, setMine] = useState([])
    const [asking, setAsking] = useState(false)
    const [busy, setBusy] = useState(false)
    const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'

    const load = useCallback(async () => {
        const r = await apiFetch('/api/approvals').catch(() => null)
        if (!r?.ok) return
        const d = await r.json()
        const list = (d.requests || []).filter(x => x.kind === 'elevation' && x.requestedBy.id === user?.id && (x.clusterId === clusterId || x.clusterId === '*'))
        setMine(prev => {
            const wasActive = prev.some(x => x.status === 'active'), isActive = list.some(x => x.status === 'active')
            if (wasActive !== isActive) refreshAccess?.()   // permissions on this page change now
            return list
        })
    }, [clusterId, user?.id])
    useEffect(() => { if (!isAdmin) { load(); const t = setInterval(whenVisible(load), 15000); return () => clearInterval(t) } }, [load, isAdmin])

    if (isAdmin) return null
    const active = mine.find(x => x.status === 'active')
    const pending = mine.find(x => x.status === 'pending')
    const act = async (r, what) => {
        setBusy(true)
        try {
            const res = await apiFetch(`/api/approvals/${r.id}/${what}`, { method: 'POST' })
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not do that')
            await load(); refreshAccess?.()
        } catch (e) { toast({ title: 'Temporary access', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }

    return (
        <>
            {active ? (
                <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-500/[0.08] px-3 py-1.5 text-xs text-emerald-200">
                    <Timer className="w-3.5 h-3.5" /> Temporary <b>{active.roleName}</b> until {new Date(active.until).toLocaleTimeString([], { timeStyle: 'short' })}{active.decidedBy ? ` · approved by ${active.decidedBy.username}` : ''}
                    <button disabled={busy} onClick={() => act(active, 'end')} className="ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 hover:bg-white/10"><Ban className="w-3 h-3" /> End now</button>
                </div>
            ) : pending ? (
                <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-3 py-1.5 text-xs text-amber-200">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Waiting for approval: {pending.roleName} for {pending.minutes} min
                    <button disabled={busy} onClick={() => act(pending, 'cancel')} className="ml-1 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 hover:bg-white/10"><X className="w-3 h-3" /> Cancel</button>
                </div>
            ) : (
                <button onClick={() => setAsking(true)} className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-white/20">
                    <KeyRound className="w-3.5 h-3.5" /> Request temporary access
                </button>
            )}
            {asking && <RequestDialog clusterId={clusterId} clusterName={clusterName} onClose={() => setAsking(false)} onSent={() => { setAsking(false); load() }} />}
        </>
    )
}
