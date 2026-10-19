import { useState } from 'react'
import { Sparkles, Loader2, RefreshCw, Quote, ListChecks, GitCommitHorizontal, AlertTriangle, EyeOff, HelpCircle } from 'lucide-react'
import { aiJob } from './aiJob'
import FixPreview from './FixPreview'
import Feedback from './Feedback'
import { Inline } from './Markdown'

// "Explain with AI" for a failed job or an incident. Shows the cause, the
// proof (lines checked against the real data), the steps, what changed
// before it, and — for incidents — a fix that can be previewed and applied.
const CONF = { high: ['High confidence', 'text-emerald-300 border-emerald-400/30'], medium: ['Medium confidence', 'text-amber-300 border-amber-400/30'], low: ['Low confidence — check it', 'text-red-300 border-red-400/30'] }

function Steps({ items, caution = [] }) {
    return <ol className="mt-1.5 space-y-1.5 list-decimal list-inside text-xs text-slate-300 leading-relaxed">{items.map((s, i) => <li key={i}><Inline text={s} />{caution.includes(s) && <span className="block ml-4 mt-0.5 text-[11px] text-red-300">⚠ Destroys data or setup on that machine — only if it is not part of a working cluster, and after a snapshot.</span>}</li>)}</ol>
}

export default function AiExplain({ url, label = 'Explain with AI', hint, clusterId, incidentId, onFallback }) {
    const [state, setState] = useState({ status: 'idle' })
    const run = async (fresh = false) => {
        setState({ status: 'loading' })
        try {
            const { ok, data: d } = await aiJob(url, { fresh })
            if (!ok) { setState({ status: 'error', error: d.error || 'No answer', attempts: d.attempts }); onFallback?.(d); return }
            setState({ status: 'done', data: d })
        } catch (e) { setState({ status: 'error', error: e.message }) }
    }

    if (state.status === 'idle') return (
        <button onClick={() => run()} className="w-full flex items-center gap-3 rounded-2xl border border-violet-400/25 bg-gradient-to-r from-violet-500/10 to-fuchsia-500/5 p-4 text-left hover:from-violet-500/15 transition">
            <Sparkles className="w-5 h-5 text-violet-300 shrink-0" />
            <span className="flex-1"><span className="block text-sm font-semibold text-white">{label}</span><span className="block text-[11px] text-slate-400">{hint || 'KubeEZ AI reads the evidence and says why it happened, with proof — secrets are masked first.'}</span></span>
        </button>
    )
    if (state.status === 'loading') return (
        <div className="flex items-center gap-3 rounded-2xl border border-violet-400/25 bg-violet-500/[0.06] p-4 text-sm text-slate-300">
            <Loader2 className="w-5 h-5 animate-spin text-violet-300" /> Reading the evidence… a local model on CPU can take up to a minute.
        </div>
    )
    if (state.status === 'error') return (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-500/[0.05] p-4 space-y-2">
            <p className="flex items-center gap-2 text-sm text-amber-100"><AlertTriangle className="w-4 h-4" /> {state.error}</p>
            <p className="text-[11px] text-slate-400">KubeEZ's own diagnosis above still applies.{state.attempts?.length ? ` Tried: ${state.attempts.map(a => `${a.provider} (${a.skipped || a.error || 'failed'})`).join(', ')}.` : ''}</p>
            <button onClick={() => run(true)} className="kz-btn-ghost !py-1.5 !text-xs"><RefreshCw className="w-3.5 h-3.5" /> Try again</button>
        </div>
    )

    const { answer: a, engine, changes, freshError, canAct, cached, specialist, runbook, allowedActions = [] } = state.data
    // the fix that worked before, for THIS incident's pod / workload
    const rbSpec = runbook && (() => { const x = allowedActions.find(s => s.type === runbook.action.type && (s.kind === 'pod' || s.name === runbook.action.name)); return x ? { ...x, ...(runbook.action.type === 'scale' ? { replicas: runbook.action.replicas } : {}) } : null })()
    const conf = CONF[a.confidence] || CONF.medium
    return (
        <div className="rounded-2xl border border-violet-400/25 bg-violet-500/[0.04] p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-300" />
                <span className="text-sm font-semibold text-white flex-1">KubeEZ AI{specialist && <span className="ml-2 kz-chip !text-violet-300">{specialist}</span>}</span>
                <span className={`kz-chip ${conf[1]}`}>{conf[0]}</span>
                <button onClick={() => run(true)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" title="Ask again" aria-label="Ask again"><RefreshCw className="w-3.5 h-3.5" /></button>
            </div>
            <div>
                <p className="text-sm text-slate-100 leading-relaxed"><Inline text={a.summary} /></p>
                {a.cause && <p className="mt-2 text-xs text-slate-300"><span className="font-semibold text-slate-200">Cause: </span><Inline text={a.cause} /></p>}
            </div>
            {a.change && (
                <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.05] p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-200"><GitCommitHorizontal className="w-3.5 h-3.5" /> Likely triggered by this change</p>
                    <p className="mt-1 font-mono text-[11px] text-amber-100 break-words">{a.change}</p>
                </div>
            )}
            {a.evidence?.length > 0 && (
                <div>
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><Quote className="w-3.5 h-3.5" /> Proof — lines found in the real data</p>
                    <div className="mt-1.5 space-y-1">{a.evidence.map((e, i) => <pre key={i} className="rounded-lg border border-white/[0.07] bg-black/40 px-2.5 py-1.5 text-[11px] text-slate-300 whitespace-pre-wrap break-words">{e}</pre>)}</div>
                </div>
            )}
            {a.unverified > 0 && <p className="text-[11px] text-amber-300/80">{a.unverified} quoted line(s) were not in the data and were removed.</p>}
            {a.fix?.length > 0 && <div><p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400"><ListChecks className="w-3.5 h-3.5" /> What to do</p><Steps items={a.fix} caution={a.cautionSteps || []} /></div>}
            {a.blockedSteps?.length > 0 && <p className="flex items-start gap-1.5 text-[11px] text-red-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> KubeEZ removed {a.blockedSteps.length} step(s) that would damage the cluster{engine.suspicious ? ' — the data contained text trying to give the AI orders' : ''}. Do not run: <code className="font-mono break-all">{a.blockedSteps.join(' · ')}</code></p>}
            {runbook && (
                <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/[0.05] p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-emerald-200">Worked before on this workload: {runbook.action.type} {runbook.scope} — {runbook.successes} of {runbook.successes + runbook.failures} times{runbook.auto ? ' (runs by itself)' : ''}</p>
                    {rbSpec && clusterId && canAct && !(a.action && a.action.type === rbSpec.type && a.action.name === rbSpec.name) && <FixPreview clusterId={clusterId} spec={rbSpec} incidentId={incidentId} />}
                </div>
            )}
            {a.action && clusterId && (canAct ? <FixPreview clusterId={clusterId} spec={a.action} incidentId={incidentId} /> : <p className="text-[11px] text-slate-500">Suggested fix: {a.action.type} {a.action.kind}/{a.action.name} — someone who may act on incidents can apply it.</p>)}
            {a.missing && <p className="flex items-start gap-1.5 text-[11px] text-slate-500"><HelpCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> To be sure: {a.missing}</p>}
            {changes?.length > 0 && !a.change && (
                <details className="text-[11px] text-slate-400">
                    <summary className="cursor-pointer hover:text-slate-200">{changes.length} change(s) in the 3 hours before</summary>
                    <ul className="mt-1.5 space-y-0.5">{changes.map((c, i) => <li key={i} className="font-mono break-words">{new Date(c.at).toLocaleTimeString()} {c.ns ? `${c.ns}: ` : ''}{c.title}{c.detail ? ` — ${c.detail}` : ''}</li>)}</ul>
                </details>
            )}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
                <span>{engine.provider} · {engine.model} · {(engine.ms / 1000).toFixed(1)} s{cached ? ' · saved answer' : ''}</span>
                {engine.masked > 0 && <span className="flex items-center gap-1"><EyeOff className="w-3 h-3" />{engine.masked} secret(s) masked</span>}
                {engine.suspicious && <span className="text-amber-300">trick text in the data was ignored</span>}
                {freshError && <span>live cluster data: {freshError}</span>}
            </p>
            <Feedback key={engine.traceId} traceId={engine.traceId} />
        </div>
    )
}
