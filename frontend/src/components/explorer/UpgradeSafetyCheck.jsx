import { useState, useEffect } from 'react'
import { apiFetch } from '../../context/AuthContext'
import { explorerResourceLink } from './explorerLinks'
import { ShieldCheck, ShieldAlert, ShieldX, Loader2, ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react'

const VERDICT = {
    blocked: { Icon: ShieldX, cls: 'border-red-500/30 bg-red-500/[0.07] text-red-200', title: 'Blocked — fix these before upgrading' },
    warning: { Icon: ShieldAlert, cls: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-200', title: 'Warnings — likely impact, review before upgrading' },
    review: { Icon: ShieldAlert, cls: 'border-sky-500/30 bg-sky-500/[0.06] text-sky-200', title: 'Nothing blocking — a few things to review' },
    no_known_blockers: { Icon: ShieldCheck, cls: 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-200', title: 'No known blockers for this upgrade' },
    unknown: { Icon: ShieldAlert, cls: 'border-white/10 bg-white/[0.03] text-slate-300', title: 'Incomplete — some evidence could not be read' }
}

function Finding({ f, clusterId }) {
    const [open, setOpen] = useState(false)
    const link = f.resource && explorerResourceLink(clusterId, f.resource.kind, f.resource.namespace, f.resource.name)
    return (
        <li className="rounded-lg bg-black/20 border border-white/5">
            <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 text-left px-2.5 py-2">
                {open ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                <span className="min-w-0">
                    <span className="block text-[12px] font-bold text-white">{f.title}</span>
                    {f.resource && <span className="block text-[10px] font-mono text-slate-400 truncate">{f.resource.kind} {f.resource.namespace ? `${f.resource.namespace}/` : ''}{f.resource.name}</span>}
                </span>
            </button>
            {open && (
                <div className="px-8 pb-2.5 space-y-1.5 text-[11px] text-slate-300">
                    {f.impact && <p><span className="text-slate-500">Impact: </span>{f.impact}</p>}
                    {f.remediation && <p><span className="text-slate-500">Fix: </span>{f.remediation}</p>}
                    {link && <a href={link} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-cyan-300 hover:underline"><ExternalLink className="w-3 h-3" /> Open in Explorer</a>}
                </div>
            )}
        </li>
    )
}

/**
 * Upgrade safety check (powered by the Cluster Explorer): runs when a target
 * version is chosen, reports the verdict to the parent (onResult).
 */
export default function UpgradeSafetyCheck({ clusterId, target, onResult }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [showWarn, setShowWarn] = useState(false)

    useEffect(() => {
        if (!target) { setData(null); onResult?.(null); return }
        let gone = false
        setLoading(true); setData(null); onResult?.(null)
        apiFetch(`/api/clusters/${clusterId}/explorer-insights/upgrade?target=${encodeURIComponent(target)}`)
            .then(r => r.json())
            .then(j => { if (!gone) { setData(j); onResult?.(j) } })
            .catch(e => { if (!gone) { const j = { installed: true, error: e.message }; setData(j); onResult?.(j) } })
            .finally(() => { if (!gone) setLoading(false) })
        return () => { gone = true }
    }, [clusterId, target])

    if (!target) return null
    if (loading) return (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin text-cyan-400" /> Running the upgrade safety check (removed APIs, version skew, disruption budgets…)
        </div>
    )
    if (!data) return null
    if (!data.installed) return (
        <div className="flex gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-[11px] text-slate-400">
            <Info className="w-4 h-4 shrink-0 text-slate-500" />
            <span>Install the <span className="text-white font-bold">Cluster Explorer</span> add-on to check this upgrade for removed APIs, skew and other blockers before it starts. An etcd snapshot is taken automatically either way.</span>
        </div>
    )
    if (data.error) return (
        <div className="flex gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-[11px] text-amber-200">
            <ShieldAlert className="w-4 h-4 shrink-0" /> The safety check could not run ({data.error}). The upgrade can still start.
        </div>
    )
    const v = VERDICT[data.verdict] || VERDICT.unknown
    const s = data.summary || {}
    return (
        <div className={`rounded-xl border p-3 ${v.cls}`}>
            <div className="flex items-start gap-2">
                <v.Icon className="w-5 h-5 shrink-0" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-black">{v.title}</p>
                    <p className="text-[11px] opacity-80">
                        v{data.currentVersion?.replace(/^v/, '')} → v{data.targetVersion?.replace(/^v/, '')} · {s.blocked || 0} blocked · {s.warnings || 0} warnings · {s.reviews || 0} to review · {s.passed || 0} passed
                        {data.reviewedThrough ? ` · checks reviewed through ${data.reviewedThrough}` : ''}
                    </p>
                </div>
            </div>
            {data.blockers?.length > 0 && <ul className="mt-2.5 space-y-1.5">{data.blockers.map((f, i) => <Finding key={i} f={f} clusterId={clusterId} />)}</ul>}
            {data.warnings?.length > 0 && (
                <div className="mt-2">
                    <button onClick={() => setShowWarn(w => !w)} className="flex items-center gap-1 text-[11px] font-bold opacity-90">
                        {showWarn ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} {data.warnings.length} warning{data.warnings.length === 1 ? '' : 's'}
                    </button>
                    {showWarn && <ul className="mt-1.5 space-y-1.5">{data.warnings.map((f, i) => <Finding key={i} f={f} clusterId={clusterId} />)}</ul>}
                </div>
            )}
            <a href={data.detailsUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1 mt-2.5 text-[11px] font-bold text-cyan-300 hover:underline">
                <ExternalLink className="w-3 h-3" /> Full report in the Explorer
            </a>
        </div>
    )
}
