import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { UserCheck, Loader2, Check, X, Clock, ShieldCheck, Timer, Ban, Sparkles, Users, Info } from 'lucide-react'
import { apiFetch, useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import PageHeader from '../components/ui/PageHeader'

// Two-person approval and temporary access, in one place:
// approvers decide here, members follow their own requests here,
// admins choose which actions need a second person.
const STATUS = {
    pending: ['Waiting', 'text-amber-200 bg-amber-500/10 border-amber-400/25'],
    approved: ['Approved — run it', 'text-emerald-200 bg-emerald-500/10 border-emerald-400/25'],
    active: ['Active', 'text-emerald-200 bg-emerald-500/10 border-emerald-400/25'],
    used: ['Done', 'text-slate-300 bg-white/5 border-white/10'],
    ended: ['Ended', 'text-slate-300 bg-white/5 border-white/10'],
    denied: ['Denied', 'text-rose-200 bg-rose-500/10 border-rose-400/25'],
    expired: ['Expired', 'text-slate-400 bg-white/5 border-white/10'],
    cancelled: ['Cancelled', 'text-slate-400 bg-white/5 border-white/10']
}
const when = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''
function left(iso) {
    const ms = new Date(iso).getTime() - Date.now()
    if (ms <= 0) return 'ending'
    const m = Math.round(ms / 60000)
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`
}

function RequestRow({ r, me, canApprove, onAct, busy }) {
    const [comment, setComment] = useState('')
    const mine = r.requestedBy?.id === me?.id
    const [label, tone] = STATUS[r.status] || [r.status, 'text-slate-300 bg-white/5 border-white/10']
    return (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start gap-3">
                <div className={`p-2 rounded-xl border ${r.kind === 'action' ? 'border-blue-400/25 bg-blue-500/10' : 'border-sky-400/25 bg-sky-500/10'}`}>
                    {r.kind === 'action' ? <ShieldCheck className="w-4 h-4 text-blue-200" /> : <Timer className="w-4 h-4 text-sky-200" />}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-white">
                        {r.kind === 'action' ? r.summary : <>{r.roleName} on {r.clusterName} for {r.minutes} min</>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">
                        {mine ? 'You' : r.requestedBy?.username} · {when(r.createdAt)} · “{r.reason}”
                    </div>
                    {r.decidedBy && <div className="mt-0.5 text-[11px] text-slate-500">{r.status === 'denied' ? 'Denied' : 'Approved'} by {r.decidedBy.username} {when(r.decidedAt)}{r.comment ? ` — “${r.comment}”` : ''}</div>}
                    {r.status === 'active' && <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-300"><Clock className="w-3 h-3" />until {new Date(r.until).toLocaleTimeString([], { timeStyle: 'short' })} · {left(r.until)}</div>}
                    {r.status === 'approved' && mine && <div className="mt-1 text-[11px] text-emerald-300">Run the action again now — the approval is used then (valid for an hour).</div>}
                </div>
                <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>
            </div>
            {(r.status === 'pending' && canApprove && !mine) && (
                <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
                    <input className="kz-input !py-2 flex-1 min-w-[180px]" placeholder="Comment (optional)" value={comment} onChange={e => setComment(e.target.value)} maxLength={300} aria-label="Comment" />
                    <button disabled={busy} onClick={() => onAct(r, 'deny', comment)} className="kz-btn-ghost !py-2"><X className="w-4 h-4" /> Deny</button>
                    <button disabled={busy} onClick={() => onAct(r, 'approve', comment)} className="kz-btn-primary !py-2"><Check className="w-4 h-4" /> Approve</button>
                </div>
            )}
            {r.status === 'pending' && mine && <div className="mt-3 pl-11"><button disabled={busy} onClick={() => onAct(r, 'cancel')} className="kz-btn-ghost !py-1.5 !text-xs"><Ban className="w-3.5 h-3.5" /> Cancel request</button></div>}
            {r.status === 'active' && (mine || canApprove) && <div className="mt-3 pl-11"><button disabled={busy} onClick={() => onAct(r, 'end')} className="kz-btn-ghost !py-1.5 !text-xs"><Ban className="w-3.5 h-3.5" /> End now</button></div>}
        </div>
    )
}

export default function Approvals() {
    const { user } = useAuth()
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [busy, setBusy] = useState(false)
    const [saving, setSaving] = useState(false)
    const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'

    const load = useCallback(async () => {
        const r = await apiFetch('/api/approvals').catch(() => null)
        if (r?.ok) setData(await r.json())
    }, [])
    useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [load])

    const act = async (r, what, comment) => {
        setBusy(true)
        try {
            const res = await apiFetch(`/api/approvals/${r.id}/${what}`, { method: 'POST', body: JSON.stringify({ comment }) })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not do that')
            toast({ title: { approve: 'Approved', deny: 'Denied', cancel: 'Cancelled', end: 'Ended' }[what], message: r.kind === 'action' ? r.summary : `${r.requestedBy.username}: ${r.roleName} on ${r.clusterName}`, type: 'success' })
            load()
        } catch (e) { toast({ title: 'Approvals', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }

    const toggle = async (key, on) => {
        setSaving(true)
        try {
            const actions = { ...(data.settings.actions || {}), [key]: on }
            const r = await apiFetch('/api/approvals/settings', { method: 'PUT', body: JSON.stringify({ actions }) })
            const d = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(d.error || 'Could not save')
            setData(x => ({ ...x, settings: d }))
        } catch (e) { toast({ title: 'Two-person approval', message: e.message, type: 'error' }) } finally { setSaving(false) }
    }

    if (!data) return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 text-slate-500 animate-spin" /></div>
    const reqs = data.requests || []
    const waiting = reqs.filter(r => r.status === 'pending' && r.requestedBy.id !== user?.id)
    const mine = reqs.filter(r => r.requestedBy.id === user?.id)
    const history = reqs.filter(r => !['pending'].includes(r.status) && r.requestedBy.id !== user?.id)
    const protectedCount = Object.values(data.settings.actions || {}).filter(Boolean).length

    return (
        <div className="max-w-6xl mx-auto space-y-8">
            <PageHeader icon={UserCheck} eyebrow="Workspace" title="Approvals"
                description="Dangerous actions that need a second person, and temporary access to clusters — asked, decided and recorded here." />

            {!data.allowed && (
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-blue-400/25 bg-blue-500/[0.06] p-4">
                    <Sparkles className="w-5 h-5 text-blue-300" />
                    <p className="text-sm text-slate-200 flex-1">Two-person approval and temporary access are part of <b>Pro</b>.</p>
                    <Link to="/pricing" className="kz-btn-primary !py-2">See plans</Link>
                </div>
            )}

            {data.canApprove && (
                <section>
                    <h3 className="text-lg font-semibold text-white mb-1">Waiting for you</h3>
                    <p className="text-xs text-slate-400 mb-3">You cannot approve your own requests — that is the point of a second person.</p>
                    <div className="space-y-3">
                        {waiting.length ? waiting.map(r => <RequestRow key={r.id} r={r} me={user} canApprove onAct={act} busy={busy} />)
                            : <p className="rounded-2xl border border-white/[0.07] p-5 text-sm text-slate-500">Nothing waiting.</p>}
                    </div>
                </section>
            )}

            <section>
                <h3 className="text-lg font-semibold text-white mb-1">Your requests</h3>
                <p className="text-xs text-slate-400 mb-3">Ask for temporary access on a cluster's page (<b className="text-slate-300">Request access</b>). Protected actions ask by themselves when you run them.</p>
                <div className="space-y-3">
                    {mine.length ? mine.map(r => <RequestRow key={r.id} r={r} me={user} canApprove={data.canApprove} onAct={act} busy={busy} />)
                        : <p className="rounded-2xl border border-white/[0.07] p-5 text-sm text-slate-500">You have not asked for anything yet.</p>}
                </div>
            </section>

            {isAdmin && (
                <section className="kz-card p-6">
                    <div className="flex flex-wrap items-start gap-3">
                        <ShieldCheck className="w-5 h-5 text-blue-300 mt-0.5" />
                        <div className="flex-1 min-w-[240px]">
                            <h3 className="text-lg font-semibold text-white">Two-person rule</h3>
                            <p className="text-xs text-slate-400 mt-0.5">The actions you tick need a second person's approval — for everyone, admins included. {protectedCount ? `${protectedCount} protected.` : 'None protected yet.'}</p>
                        </div>
                        <div className="text-[11px] text-slate-400 flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> Can approve: {data.approvers.join(', ') || '—'}</div>
                    </div>
                    <div className="mt-4 grid sm:grid-cols-2 gap-2">
                        {data.actions.map(a => (
                            <label key={a.key} className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/20 px-4 py-3 cursor-pointer hover:border-white/15">
                                <input type="checkbox" className="w-4 h-4" disabled={saving || !data.allowed} checked={!!data.settings.actions?.[a.key]} onChange={e => toggle(a.key, e.target.checked)} />
                                <span className="text-sm text-slate-200">{a.label}</span>
                            </label>
                        ))}
                    </div>
                    {data.approvers.length < 2 && <p className="mt-3 flex gap-2 text-[11px] text-amber-200"><Info className="w-3.5 h-3.5 shrink-0" />Needs at least two people who can approve — invite a second admin (or give a custom role “Approve terminal access requests”).</p>}
                </section>
            )}

            {data.canApprove && history.length > 0 && (
                <section>
                    <h3 className="text-lg font-semibold text-white mb-3">Recent decisions</h3>
                    <div className="space-y-3">{history.slice(0, 30).map(r => <RequestRow key={r.id} r={r} me={user} canApprove onAct={act} busy={busy} />)}</div>
                </section>
            )}
        </div>
    )
}
