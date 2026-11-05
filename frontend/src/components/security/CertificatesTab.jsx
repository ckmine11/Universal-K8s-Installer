import { useState, useEffect, useCallback } from 'react'
import { BadgeCheck, RefreshCw, Loader2, AlertTriangle, Search, RotateCw, Lock } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import { Link } from 'react-router-dom'
import { featureOn, featureIncluded, featuresKnown } from '../../config/features'
import { markSeen } from '../../utils/badgeSeen'

// cert-manager of one cluster: every Certificate with its expiry and state
// (worst first), the Issuers / ClusterIssuers, and ACME Challenges that are
// stuck. "Renew now" asks cert-manager to issue a certificate again; the
// server checks the permission, namespace limits and approvals.
const STATE = {
    expired: { label: 'Expired', chip: 'text-red-300 border-red-400/30 bg-red-500/10' },
    failing: { label: 'Failing', chip: 'text-red-300 border-red-400/30 bg-red-500/10' },
    expiring: { label: 'Expiring', chip: 'text-amber-200 border-amber-400/30 bg-amber-500/10' },
    issuing: { label: 'Issuing', chip: 'text-blue-200 border-blue-400/30 bg-blue-500/10' },
    pending: { label: 'Pending', chip: 'text-slate-300 border-white/10' },
    ok: { label: 'Valid', chip: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10' }
}
const FILTERS = [['all', 'All', () => true], ['attention', 'Needs attention', c => ['expired', 'failing', 'expiring'].includes(c.state)], ['ok', 'Valid', c => c.state === 'ok']]

function Card({ label, value, tone }) {
    return <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3"><p className="text-[11px] text-slate-400">{label}</p><p className={`text-2xl font-bold ${value ? tone : 'text-slate-500'}`}>{value}</p></div>
}

export default function CertificatesTab({ clusterId, canInstall, onOpenAddons }) {
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(null)
    const [filter, setFilter] = useState('all')
    const [q, setQ] = useState('')
    const load = useCallback(async (fresh = false) => {
        setLoading(true); setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/certificates${fresh ? '?fresh=1' : ''}`)
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`)
            setData(d)
            markSeen(clusterId, 'certificates')   // seen: the sidebar badge clears until something new comes
        } catch (e) { setError(e.message) } finally { setLoading(false) }
    }, [clusterId])
    useEffect(() => { load() }, [load])

    const renew = async (c) => {
        if (!window.confirm(`Ask cert-manager to issue ${c.namespace}/${c.name} again now?${c.state === 'ok' ? ' It is still valid.' : ''}`)) return
        setBusy(`${c.namespace}/${c.name}`)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/certificates/renew`, { method: 'POST', body: JSON.stringify({ namespace: c.namespace, name: c.name }) })
            const d = await res.json().catch(() => ({}))
            if (res.status === 428) { toast({ title: 'Needs approval', message: d.error || 'A second person approves this in Approvals.', type: 'info' }); return }
            if (!res.ok) throw new Error(d.error || 'Not renewed')
            toast({ title: 'Renewal started', message: d.message, type: 'success' }); setTimeout(() => load(true), 5000)
        } catch (e) { toast({ title: 'Not renewed', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }

    const s = data?.summary
    const match = FILTERS.find(f => f[0] === filter)[2]
    const needle = q.trim().toLowerCase()
    const certs = (data?.certificates || []).filter(match).filter(c => !needle || [c.name, c.namespace, c.secretName, c.issuer?.name, ...(c.dnsNames || [])].some(v => v && String(v).toLowerCase().includes(needle)))
    const missing = data?.tool?.state === 'missing'

    return (
        <div className="space-y-5">
            <div className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <BadgeCheck className="w-5 h-5 text-blue-300" />
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="text-base font-semibold text-white">Certificates</h3>
                        <p className="text-xs text-slate-400">TLS certificates cert-manager issues on this cluster — when they expire, which fail and why, and ACME challenges that are stuck.</p>
                    </div>
                    <button onClick={() => load(true)} disabled={loading} className="kz-btn-ghost !py-1.5 !text-xs" aria-label="Read again"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
                </div>
                {error && <p className="flex items-center gap-1.5 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
                {loading && !data && <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>}
                {missing && <p className="text-sm text-slate-400">cert-manager is not installed on this cluster.{canInstall && <> <button onClick={onOpenAddons} className="text-blue-300 hover:underline">Install it from Add-ons</button>.</>}</p>}
                {data && !missing && data.tool?.state !== 'ok' && <p className="flex items-start gap-1.5 text-xs text-amber-200"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{data.tool.message}</p>}
                {data?.readOnlyReason && <p className="flex items-center gap-1.5 text-[11px] text-slate-400"><Lock className="w-3.5 h-3.5" />{data.readOnlyReason}</p>}
                {s && !missing && (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        <Card label="Certificates" value={s.total} tone="text-white" />
                        <Card label="Expired / failing" value={s.expired + s.failing} tone="text-red-300" />
                        <Card label="Expire within 14 days" value={s.expiring} tone="text-amber-200" />
                        <Card label="Being issued" value={s.issuing} tone="text-blue-200" />
                        <Card label="Stuck challenges" value={s.challenges} tone="text-amber-200" />
                    </div>
                )}
                {/* Free: certificates need attention, and Pro would have said so on its own */}
                {s && !missing && s.expired + s.failing + s.expiring > 0 && featuresKnown() && featureOn('certAlerts') && !featureIncluded('certAlerts') && (
                    <p className="flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-100">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        {s.expired + s.failing + s.expiring} certificate{s.expired + s.failing + s.expiring === 1 ? '' : 's'} need{s.expired + s.failing + s.expiring === 1 ? 's' : ''} attention. With Pro, KubeEZ alerts you (Slack, Teams, email…) 14, 7, 3 and 1 day before a certificate expires — you would not have to look.
                        <Link to="/pricing" className="font-semibold text-blue-300 hover:underline">Upgrade</Link>
                    </p>
                )}
            </div>

            {data && !missing && (
                <div className="kz-card p-5 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex gap-1" role="tablist" aria-label="Filter">{FILTERS.map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`${filter === k ? 'kz-btn-primary' : 'kz-btn-ghost'} !py-1 !px-2.5 !text-xs`}>{l}</button>)}</div>
                        <div className="relative ml-auto w-64"><Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search names and domains" className="kz-input !py-1.5 !pl-8 !text-xs" aria-label="Search certificates" /></div>
                    </div>
                    <ul className="space-y-2">{certs.map(c => (
                        <li key={`${c.namespace}/${c.name}`} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                            <div className="flex flex-wrap items-center gap-3">
                                <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${STATE[c.state]?.chip}`}>{STATE[c.state]?.label || c.state}</span>
                                <div className="flex-1 min-w-[220px]">
                                    <p className="text-sm font-semibold text-white break-all">{c.name} <span className="text-[10px] font-medium text-slate-500">{c.namespace}</span></p>
                                    <p className="text-[11px] text-slate-400 font-mono break-all">{c.dnsNames.join(', ') || c.secretName}</p>
                                </div>
                                <span className="text-[11px] text-slate-400 text-right">
                                    {c.notAfter ? <>{c.daysLeft < 0 ? `expired ${-c.daysLeft} day${c.daysLeft === -1 ? '' : 's'} ago` : `${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left`}<span className="block text-slate-500">until {new Date(c.notAfter).toLocaleDateString()}{c.renewalTime ? ` · renews ${new Date(c.renewalTime).toLocaleDateString()}` : ''}</span></> : 'not issued yet'}
                                </span>
                                <span className="text-[11px] text-slate-500">{c.issuer.kind} {c.issuer.name}</span>
                                {data.canRenew && <button onClick={() => renew(c)} disabled={busy === `${c.namespace}/${c.name}` || c.state === 'issuing'} className="kz-btn-ghost !py-1 !px-2 !text-[11px]">{busy === `${c.namespace}/${c.name}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />} Renew now</button>}
                            </div>
                            {c.message && <p className="mt-2 text-[11px] text-amber-100 break-words">{c.reason ? <span className="font-semibold">{c.reason}: </span> : null}{c.message}</p>}
                        </li>
                    ))}{!certs.length && <li className="text-sm text-slate-500 py-2">{data.certificates.length ? 'Nothing matches.' : 'No certificates on this cluster yet.'}</li>}</ul>
                </div>
            )}

            {data && !missing && (data.challenges.length > 0 || data.issuers.length > 0) && (
                <div className="grid md:grid-cols-2 gap-5">
                    <div className="kz-card p-5 space-y-2">
                        <h4 className="text-sm font-semibold text-white">Issuers</h4>
                        <ul className="space-y-1.5">{data.issuers.map(i => (
                            <li key={`${i.kind}/${i.namespace}/${i.name}`} className="text-[11px]">
                                <span className={i.ready ? 'text-emerald-300' : 'text-red-300'}>{i.ready ? '●' : '○'}</span> <span className="font-semibold text-slate-200">{i.name}</span> <span className="text-slate-500">{i.kind}{i.namespace ? ` · ${i.namespace}` : ''} · {i.type}{i.acmeServer ? ` · ${new URL(i.acmeServer).host}` : ''}</span>
                                {i.message && <span className="block text-amber-100">{i.message}</span>}
                            </li>
                        ))}{!data.issuers.length && <li className="text-[11px] text-slate-500">None you can see.</li>}</ul>
                    </div>
                    <div className="kz-card p-5 space-y-2">
                        <h4 className="text-sm font-semibold text-white">ACME challenges not done</h4>
                        <ul className="space-y-1.5">{data.challenges.map(c => (
                            <li key={`${c.namespace}/${c.name}`} className="text-[11px]">
                                <span className="font-mono text-slate-200">{c.dnsName || c.name}</span> <span className="text-slate-500">{c.type} · {c.state}{c.presented ? ' · presented' : ''} · {c.namespace}</span>
                                {c.reason && <span className="block text-amber-100 break-words">{c.reason}</span>}
                            </li>
                        ))}{!data.challenges.length && <li className="text-[11px] text-slate-500">None — every challenge passed.</li>}</ul>
                    </div>
                </div>
            )}
        </div>
    )
}
