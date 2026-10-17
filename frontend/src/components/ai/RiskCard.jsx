import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert, ShieldCheck, Loader2, RefreshCw, CheckCircle2, ChevronRight } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// The cluster's risk score: what could break soon, why, and how to lower it.
export const RISK_TONE = {
    low: { label: 'Low risk', text: 'text-emerald-300', ring: 'stroke-emerald-400', chip: 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10' },
    medium: { label: 'Medium risk', text: 'text-amber-300', ring: 'stroke-amber-400', chip: 'text-amber-300 border-amber-400/30 bg-amber-500/10' },
    high: { label: 'High risk', text: 'text-red-300', ring: 'stroke-red-400', chip: 'text-red-300 border-red-400/30 bg-red-500/10' }
}

export default function RiskCard({ clusterId }) {
    const [r, setR] = useState(null)
    const [loading, setLoading] = useState(true)
    const load = () => {
        setLoading(true)
        apiFetch(`/api/clusters/${clusterId}/risk`).then(x => x.ok ? x.json() : null).then(setR).catch(() => setR(null)).finally(() => setLoading(false))
    }
    useEffect(load, [clusterId])   // eslint-disable-line react-hooks/exhaustive-deps

    if (!r) return (
        <div className="kz-card p-5 flex items-center gap-3 text-sm text-slate-400">
            {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Checking what could break…</> : 'Risk score not available right now.'}
        </div>
    )
    const t = RISK_TONE[r.level] || RISK_TONE.medium
    const C = 2 * Math.PI * 26
    return (
        <div className="kz-card p-5">
            <div className="flex flex-wrap items-center gap-5">
                <div className="relative w-16 h-16 shrink-0">
                    <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90"><circle cx="32" cy="32" r="26" className="stroke-white/10" strokeWidth="6" fill="none" /><circle cx="32" cy="32" r="26" className={t.ring} strokeWidth="6" fill="none" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - r.score / 100)} /></svg>
                    <span className={`absolute inset-0 flex items-center justify-center font-display text-lg font-bold ${t.text}`}>{r.score}</span>
                </div>
                <div className="flex-1 min-w-[200px]">
                    <p className="flex items-center gap-2 text-base font-semibold text-white">{r.level === 'low' ? <ShieldCheck className="w-4 h-4 text-emerald-300" /> : <ShieldAlert className={`w-4 h-4 ${t.text}`} />} {t.label}</p>
                    <p className="text-xs text-slate-400">How likely this cluster is to break soon — every point off has a reason and a fix below.</p>
                </div>
                <button onClick={load} disabled={loading} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Check again"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
            </div>
            {r.factors.length > 0 && (
                <ul className="mt-4 space-y-2">
                    {r.factors.map(f => (
                        <li key={f.key} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                            <div className="flex items-start gap-3">
                                <span className="font-mono text-xs font-bold text-red-300 w-9 shrink-0">−{f.points}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-slate-100">{f.label}</p>
                                    {f.detail && <p className="text-xs text-slate-400 break-words">{f.detail}</p>}
                                    <p className="mt-1 text-xs text-blue-200">{f.fix}</p>
                                </div>
                                {f.link && <Link to={f.link} className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label={`Open: ${f.label}`}><ChevronRight className="w-4 h-4" /></Link>}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {r.good.length > 0 && <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">{r.good.map(g => <span key={g} className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-400/70" />{g}</span>)}</p>}
        </div>
    )
}
