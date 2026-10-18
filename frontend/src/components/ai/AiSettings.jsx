import { useState, useEffect, useCallback } from 'react'
import { Plug, FileBadge, Brain, MessageCircle, Coins, BookOpenCheck, GraduationCap, ThumbsUp, ThumbsDown, Bot, Plus, Pencil, Trash2, Loader2, PlugZap, Download, ArrowUp, ArrowDown, X, ShieldCheck, Route, Send, History, Power, CheckCircle2, AlertTriangle, EyeOff, Server, Cloud, Boxes } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import useBackdropClose from '../ui/useBackdropClose'
import QualityPanel from './QualityPanel'
import RunbooksPanel from './RunbooksPanel'
import ChatOpsPanel from './ChatOpsPanel'
import { McpPanel, AiBomPanel, LearningPanel } from './Phase6Panels'
import Feedback from './Feedback'
import ConnectAi from './ConnectAi'

// AI settings: the engines (models) KubeEZ AI may use, which engine does
// which job (with fallbacks), the safety switches, a test box and the log.
const AUTONOMY_INFO = {
    suggest: ['Suggest only', 'AI explains and suggests; it never runs anything.'],
    approve: ['Ask first (recommended)', 'AI may prepare a fix; a person approves before it runs.'],
    auto: ['Auto for low-risk', 'Low-risk fixes (e.g. restart a crashed pod) run on their own; everything else asks first.']
}
const kindIcon = (k) => k === 'server' ? Server : k === 'cluster' ? Boxes : (k === 'ollama' ? Bot : Cloud)
const isLocal = (k) => ['ollama', 'server', 'cluster'].includes(k)   // engines that can download models

async function call(url, opts) {
    const res = await apiFetch(url, opts)
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(d.error || 'Request failed'), { data: d })
    return d
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function Toggle({ on, onChange, label, disabled }) {
    return (
        <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-blue-500' : 'bg-white/15'} disabled:opacity-40`}>
            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-5' : 'left-1'}`} />
        </button>
    )
}

function EngineStatus({ e }) {
    if (e.kind === 'server') {
        const st = e.state?.status
        if (st === 'ready') return <span className="kz-chip !text-emerald-300">ready</span>
        if (st === 'downloading') return <span className="kz-chip !text-amber-300"><Loader2 className="w-3 h-3 animate-spin" /> downloading model</span>
        if (st === 'waiting' || st === 'unknown') return <span className="kz-chip !text-amber-300">starting</span>
        return <span className="kz-chip !text-red-300">unavailable</span>
    }
    if (e.enabled === false) return <span className="kz-chip !text-slate-400">off</span>
    if (e.breaker?.open) return <span className="kz-chip !text-red-300" title="It failed 3 times in a row; KubeEZ skips it for 2 minutes and uses the next engine">paused — failing</span>
    if (e.pull?.status === 'downloading') return <span className="kz-chip !text-amber-300"><Loader2 className="w-3 h-3 animate-spin" /> downloading {e.pull.model}</span>
    if (e.pull?.status === 'failed') return <span className="kz-chip !text-red-300" title={e.pull.error}>download failed</span>
    return <span className="kz-chip !text-emerald-300">on</span>
}

function RouteEditor({ data, onSave }) {
    const [routes, setRoutes] = useState(() => Object.fromEntries(Object.keys(data.tasks).map(t => [t, data.routes[t]?.length ? data.routes[t] : []])))
    const [dirty, setDirty] = useState(false)
    const names = Object.fromEntries(data.engines.map(e => [e.id, e.name]))
    const change = (t, list) => { setRoutes(r => ({ ...r, [t]: list })); setDirty(true) }
    const move = (t, i, d) => { const l = [...routes[t]]; const j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; change(t, l) }

    return (
        <div className="space-y-3">
            {Object.entries(data.tasks).map(([t, label]) => {
                const list = routes[t]
                const shown = list.length ? list : data.effectiveRoutes[t]
                const unused = data.engines.filter(e => !list.includes(e.id))
                return (
                    <div key={t} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-white">{label}</div>
                            {!list.length && <span className="text-[11px] text-slate-500">Automatic: every engine, in list order</span>}
                        </div>
                        <ol className="mt-2 flex flex-wrap items-center gap-2">
                            {shown.map((id, i) => (
                                <li key={id} className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${list.length ? 'border-blue-400/30 bg-blue-500/10 text-white' : 'border-white/10 text-slate-400'}`}>
                                    <span className="text-slate-500">{i === 0 ? 'first' : 'then'}</span> {names[id] || id}
                                    {list.length > 0 && <>
                                        <button type="button" onClick={() => move(t, i, -1)} className="p-0.5 hover:text-blue-300" aria-label="Earlier"><ArrowUp className="w-3 h-3" /></button>
                                        <button type="button" onClick={() => move(t, i, 1)} className="p-0.5 hover:text-blue-300" aria-label="Later"><ArrowDown className="w-3 h-3" /></button>
                                        <button type="button" onClick={() => change(t, list.filter(x => x !== id))} className="p-0.5 hover:text-red-300" aria-label="Remove"><X className="w-3 h-3" /></button>
                                    </>}
                                </li>
                            ))}
                            {unused.length > 0 && (
                                <select className="kz-input !w-auto !py-1 !text-xs" value="" onChange={e => e.target.value && change(t, [...list, e.target.value])} aria-label={`Add an engine to ${label}`}>
                                    <option value="">+ add engine</option>
                                    {unused.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                                </select>
                            )}
                            {list.length > 0 && <button type="button" onClick={() => change(t, [])} className="text-[11px] text-slate-500 hover:text-white underline">automatic</button>}
                        </ol>
                    </div>
                )
            })}
            <div className="flex justify-end">
                <button type="button" disabled={!dirty} onClick={async () => { if (await onSave({ routes })) setDirty(false) }} className="kz-btn-primary">Save routing</button>
            </div>
        </div>
    )
}

function TryIt() {
    const { toast } = useToast()
    const [q, setQ] = useState('A pod is in CrashLoopBackOff. What should I check first?')
    const [busy, setBusy] = useState(false)
    const [r, setR] = useState(null)
    const ask = async () => {
        setBusy(true); setR(null)
        try { setR(await call('/api/ai/ask', json('POST', { question: q }))) }
        catch (e) { setR({ error: e.message, attempts: e.data?.attempts }); if (!e.data?.attempts) toast({ title: 'No answer', message: e.message, type: 'error' }) }
        finally { setBusy(false) }
    }
    return (
        <div className="space-y-3">
            <textarea className="kz-input min-h-[80px]" value={q} onChange={e => setQ(e.target.value)} maxLength={4000} aria-label="Question for KubeEZ AI" />
            <div className="flex items-center gap-3">
                <button type="button" onClick={ask} disabled={busy || q.trim().length < 3} className="kz-btn-primary">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Ask</button>
                {busy && <span className="text-xs text-slate-500">A local model on CPU can take 10–60 seconds…</span>}
            </div>
            {r && (
                <div className={`rounded-2xl border p-4 text-sm ${r.error ? 'border-red-400/25 bg-red-500/[0.05]' : 'border-white/10 bg-white/[0.02]'}`}>
                    {r.error ? <p className="text-red-200 flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{r.error}</p>
                        : <p className="text-slate-200 whitespace-pre-wrap leading-relaxed">{r.answer}</p>}
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                        {r.provider && <span className="kz-chip">{r.provider} · {r.model} · {(r.ms / 1000).toFixed(1)} s</span>}
                        {r.masked > 0 && <span className="kz-chip !text-amber-300"><EyeOff className="w-3 h-3" />{r.masked} secret(s) masked before sending</span>}
                        {(r.attempts || []).filter(a => !a.ok).map((a, i) => <span key={i} className="kz-chip !text-slate-400" title={a.error || a.skipped}>{a.provider}: {a.skipped || 'failed'} → next</span>)}
                    </div>
                    {!r.error && <div className="mt-2"><Feedback traceId={r.traceId} /></div>}
                </div>
            )}
        </div>
    )
}

function Activity() {
    const [list, setList] = useState(null)
    useEffect(() => { call('/api/ai/activity?limit=50').then(d => setList(d.traces)).catch(() => setList([])) }, [])
    if (!list) return <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
    if (!list.length) return <p className="text-sm text-slate-500">Nothing yet — questions to KubeEZ AI show up here (with secrets masked).</p>
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead className="text-left text-slate-500"><tr><th className="py-2 pr-3">When</th><th className="pr-3">Who</th><th className="pr-3">For</th><th className="pr-3">Engine</th><th className="pr-3">Time</th><th className="pr-3">Rated</th><th>Notes</th></tr></thead>
                <tbody>
                    {list.map(t => (
                        <tr key={t.id} className="border-t border-white/5 text-slate-300 align-top">
                            <td className="py-2 pr-3 whitespace-nowrap">{new Date(t.at).toLocaleString()}</td>
                            <td className="pr-3">{t.user}</td>
                            <td className="pr-3">{t.purpose}</td>
                            <td className="pr-3">{t.ok ? `${t.provider} (${t.model})` : <span className="text-red-300">no answer</span>}</td>
                            <td className="pr-3 whitespace-nowrap">{(t.ms / 1000).toFixed(1)} s</td>
                            <td className="pr-3" title={t.feedback ? `${t.feedback.by}${t.feedback.reason ? ` — ${t.feedback.reason}` : ''}${t.feedback.comment ? `: ${t.feedback.comment}` : ''}` : ''}>{t.feedback ? (t.feedback.rating === 'up' ? <ThumbsUp className="w-3.5 h-3.5 text-emerald-300" /> : <ThumbsDown className="w-3.5 h-3.5 text-red-300" />) : ''}</td>
                            <td className="space-x-1">
                                {t.attempts?.length > 1 && <span className="kz-chip" title={t.attempts.map(a => `${a.provider}: ${a.ok ? 'ok' : a.skipped || a.error}`).join('\n')}>{t.attempts.length} attempts</span>}
                                {t.masked > 0 && <span className="kz-chip !text-amber-300">{t.masked} masked</span>}
                                {t.suspicious && <span className="kz-chip !text-red-300" title={t.injectionHits?.join(', ')}>trick text flagged</span>}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

const Section = ({ icon: Icon, title, hint, children, right }) => (
    <section className="kz-card p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h3 className="text-base font-semibold text-white flex items-center gap-2"><Icon className="w-4 h-4 text-blue-300" />{title}</h3>
                {hint && <p className="text-xs text-slate-400 mt-1 max-w-2xl leading-relaxed">{hint}</p>}
            </div>
            {right}
        </div>
        {children}
    </section>
)

export default function AiSettings() {
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [error, setError] = useState(null)
    const [dialog, setDialog] = useState(null)    // null | 'new' | engine
    const [busy, setBusy] = useState(null)        // engine id being tested / pulled
    const [tests, setTests] = useState({})

    const load = useCallback(() => call('/api/ai').then(d => { setData(d); setError(null) }).catch(e => setError(e.message)), [])
    useEffect(() => { load() }, [load])
    // while a model downloads, keep the list fresh
    const downloading = data?.engines.some(e => e.pull?.status === 'downloading' || ['downloading', 'waiting'].includes(e.state?.status))
    useEffect(() => { if (!downloading) return; const t = setInterval(load, 5000); return () => clearInterval(t) }, [downloading, load])
    const testing = data?.engines.some(e => e.qualityRunning)
    useEffect(() => { if (!testing) return; const t = setInterval(load, 10000); return () => clearInterval(t) }, [testing, load])

    const saveSettings = async (patch, msg) => {
        try { await call('/api/ai/settings', json('PUT', patch)); if (msg) toast({ title: msg, type: 'success' }); await load(); return true }
        catch (e) { toast({ title: 'Not saved', message: e.message, type: 'error' }); return false }
    }
    const test = async (e) => {
        setBusy(e.id)
        try { const r = await call(`/api/ai/providers/${e.id}/test`, { method: 'POST' }); setTests(t => ({ ...t, [e.id]: r })) }
        catch (err) { setTests(t => ({ ...t, [e.id]: { ok: false, detail: err.message } })) } finally { setBusy(null) }
    }
    const pull = async (e) => {
        const model = window.prompt('Which model should this engine download? (e.g. qwen2.5:3b, llama3.2:3b)', e.model || 'qwen2.5:3b')
        if (!model) return
        try { await call(`/api/ai/providers/${e.id}/pull`, json('POST', { model })); toast({ title: 'Download started', message: `${model} — this can take a few minutes.`, type: 'success' }); load() }
        catch (err) { toast({ title: 'Download not started', message: err.message, type: 'error' }) }
    }
    const remove = async (e) => {
        if (!window.confirm(`Remove the AI engine "${e.name}"?`)) return
        try { await call(`/api/ai/providers/${e.id}`, { method: 'DELETE' }); load() } catch (err) { toast({ title: 'Not removed', message: err.message, type: 'error' }) }
    }
    const toggleEngine = async (e, enabled) => {
        try { await call(`/api/ai/providers/${e.id}`, json('PUT', { enabled })); load() } catch (err) { toast({ title: 'Not saved', message: err.message, type: 'error' }) }
    }

    if (error) return <div className="kz-card p-6 text-sm text-red-200">{error}</div>
    if (!data) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>

    return (
        <div className="space-y-6">
            {/* on/off + how it works */}
            <section className="kz-card p-6">
                <div className="flex flex-wrap items-center gap-4">
                    <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center"><Bot className="w-5 h-5 text-white" /></div>
                    <div className="flex-1 min-w-[220px]">
                        <h2 className="text-lg font-semibold text-white">KubeEZ AI</h2>
                        <p className="text-xs text-slate-400">Bring your own AI: any model on your own machine or server, the KubeEZ AI add-on in your cluster, or a cloud API with your key. Secrets are masked before any model sees the data.</p>
                    </div>
                    <span className="text-xs text-slate-400">{data.enabled ? 'On' : 'Off'} for this workspace</span>
                    <Toggle on={data.enabled} label="KubeEZ AI on" onChange={v => saveSettings({ enabled: v }, v ? 'KubeEZ AI is on' : 'KubeEZ AI is off')} />
                </div>
                <div className="grid md:grid-cols-3 gap-3 mt-5">
                    {[
                        ['1 · Engines', 'Connect any AI: a model on your own machine or server (any runtime), the KubeEZ AI add-on in your cluster, or a cloud API with your key.'],
                        ['2 · Routing', 'Pick which engines do each job and in what order. If one is slow or down, the next one answers — automatically.'],
                        ['3 · Safety', 'AI never runs anything alone unless you allow it. One switch stops all AI actions at once. Every call is logged.']
                    ].map(([t, d]) => (
                        <div key={t} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
                            <div className="text-sm font-semibold text-white">{t}</div>
                            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">{d}</p>
                        </div>
                    ))}
                </div>
            </section>

            <Section icon={PlugZap} title="Engines" hint="Connect any AI you like. Offline: a model on your own machine or server — Ollama, LM Studio, vLLM, llama.cpp, LocalAI, TGI, Jan or any OpenAI-compatible server, or the KubeEZ AI add-on in your cluster. Cloud: Claude, Gemini, OpenAI, OpenRouter, Groq, Mistral, DeepSeek… with your own key. Model lists are read live, so new models show up by themselves."
                right={<button onClick={() => setDialog('new')} className="kz-btn-primary"><Plus className="w-4 h-4" /> Connect AI</button>}>
                {!data.engines.length && <p className="text-sm text-slate-400">No AI connected yet. KubeEZ still answers what it can read from your clusters itself (counts, pod checks, quick diagnosis); connect an AI for deeper explanations — <button type="button" onClick={() => setDialog('new')} className="text-blue-300 hover:underline">Connect AI</button>.</p>}
                <div className="grid md:grid-cols-2 gap-3">
                    {data.engines.map(e => {
                        const Icon = kindIcon(e.kind)
                        const t = tests[e.id]
                        return (
                            <div key={e.id} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
                                <div className="flex items-start gap-3">
                                    <Icon className="w-5 h-5 text-blue-300 mt-0.5" />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-semibold text-white truncate">{e.name}</div>
                                        <div className="text-[11px] text-slate-500 truncate">{(data.presets || []).find(p => p.id === e.preset)?.label || data.kinds[e.kind]?.label}{e.offline || isLocal(e.kind) ? ' · offline' : ' · cloud'}{e.viaClusterName ? ` · through cluster ${e.viaClusterName}` : ''} · <span className="font-mono">{e.model || 'default model'}</span>{e.hasKey ? ' · key saved' : ''}</div>
                                    </div>
                                    <EngineStatus e={e} />
                                    {!e.builtin && <Toggle on={e.enabled !== false} label={`${e.name} on`} onChange={v => toggleEngine(e, v)} />}
                                </div>
                                {e.kind === 'server' && e.state?.status === 'downloading' && <p className="text-[11px] text-amber-300/90">First start: the server downloads {e.model} once (a few minutes).</p>}
                                <div className="flex flex-wrap gap-1.5 text-[11px]">
                                    {e.quality ? <span className={`kz-chip ${e.quality.score >= 80 ? '!text-emerald-300' : e.quality.score >= 60 ? '!text-amber-300' : '!text-red-300'}`} title="Last quality test (Quality below)"><GraduationCap className="w-3 h-3" />{e.quality.score}/100</span> : e.qualityRunning ? <span className="kz-chip !text-blue-300"><Loader2 className="w-3 h-3 animate-spin" />quality test running</span> : <span className="kz-chip !text-slate-500">not tested yet</span>}
                                    {e.quality && e.quality.score < 60 && !e.quality.stale && <span className="kz-chip !text-red-300" title="It failed many of the 16 test cases"><AlertTriangle className="w-3 h-3" />answers may be wrong — try a bigger model</span>}
                                    {e.newModels > 0 && !e.builtin && <button type="button" onClick={() => setDialog(e)} className="kz-chip !text-fuchsia-200 hover:!border-fuchsia-300/50" title="Models the provider added in the last 14 days">{e.newModels} new model{e.newModels > 1 ? 's' : ''}</button>}
                                    {e.quality?.stale && <span className="kz-chip !text-amber-300">model changed — test again</span>}
                                    {e.feedback && e.feedback.up + e.feedback.down >= 5 && e.feedback.rate < 60 && <span className="kz-chip !text-red-300" title={Object.entries(e.feedback.reasons).map(([k, v]) => `${k}: ${v}`).join(', ')}><ThumbsDown className="w-3 h-3" />members marked {100 - e.feedback.rate}% of its answers wrong</span>}
                                </div>
                                {e.queue?.busy > 0 && <p className="text-[11px] text-slate-500">Answering now{e.queue.waiting ? ` · ${e.queue.waiting} waiting` : ''}</p>}
                                {t && <p className={`text-[11px] flex items-center gap-1.5 ${t.ok ? 'text-emerald-300' : 'text-red-300'}`}>{t.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}{t.detail}{t.ms != null ? ` (${t.ms} ms)` : ''}</p>}
                                <div className="flex flex-wrap gap-2">
                                    <button onClick={() => test(e)} disabled={busy === e.id} className="kz-btn-ghost !py-1.5 !text-xs">{busy === e.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />} Test</button>
                                    {isLocal(e.kind) && <button onClick={() => pull(e)} disabled={e.pull?.status === 'downloading'} className="kz-btn-ghost !py-1.5 !text-xs"><Download className="w-3.5 h-3.5" /> Download model</button>}
                                    {!e.builtin && <button onClick={() => setDialog(e)} className="kz-btn-ghost !py-1.5 !text-xs"><Pencil className="w-3.5 h-3.5" /> Model & settings</button>}
                                    {!e.builtin && <button onClick={() => remove(e)} className="kz-btn-ghost !py-1.5 !text-xs hover:!text-red-300"><Trash2 className="w-3.5 h-3.5" /> Remove</button>}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </Section>

            {data.engines.length > 0 && (
                <Section icon={Route} title="Routing" hint="For each job, the engines to try in order. Each engine gets a time limit and one retry; one that keeps failing is paused for 2 minutes and the next engine answers.">
                    <RouteEditor key={JSON.stringify(data.routes) + data.engines.length} data={data} onSave={(p) => saveSettings(p, 'Routing saved')} />
                </Section>
            )}

            <Section icon={ShieldCheck} title="Safety">
                <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
                    <Power className={`w-5 h-5 ${data.actionsEnabled ? 'text-emerald-300' : 'text-red-300'}`} />
                    <div className="flex-1 min-w-[220px]">
                        <div className="text-sm font-semibold text-white">AI actions {data.actionsEnabled ? 'allowed' : 'stopped'}</div>
                        <p className="text-xs text-slate-400">The kill switch. Off = AI can only explain; nothing it suggests can run until you switch it back on.</p>
                    </div>
                    <Toggle on={data.actionsEnabled} label="AI actions allowed" onChange={v => saveSettings({ actionsEnabled: v }, v ? 'AI actions allowed again' : 'All AI actions stopped')} />
                </div>
                <div>
                    <label className="kz-label">When AI suggests a fix</label>
                    <div className="grid md:grid-cols-3 gap-2">
                        {data.autonomyLevels.map(a => (
                            <button type="button" key={a} onClick={() => saveSettings({ autonomy: a }, 'Saved')}
                                className={`text-left rounded-xl border px-3 py-2.5 transition ${data.autonomy === a ? 'border-blue-400/60 bg-blue-500/10' : 'border-white/10 hover:bg-white/5'}`}>
                                <div className="text-xs font-semibold text-white">{AUTONOMY_INFO[a][0]}</div>
                                <div className="text-[11px] text-slate-400 mt-0.5">{AUTONOMY_INFO[a][1]}</div>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="grid md:grid-cols-2 gap-3">
                    <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] p-3">
                        <div className="flex-1"><div className="text-xs font-semibold text-white">Mask e-mail addresses</div><div className="text-[11px] text-slate-500">Passwords, tokens and keys are always masked.</div></div>
                        <Toggle on={data.maskEmails} label="Mask e-mail addresses" onChange={v => saveSettings({ maskEmails: v })} />
                    </div>
                    <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] p-3">
                        <div className="flex-1"><div className="text-xs font-semibold text-white">Mask IP addresses</div><div className="text-[11px] text-slate-500">Hides IPs from models (answers get less specific).</div></div>
                        <Toggle on={data.maskIps} label="Mask IP addresses" onChange={v => saveSettings({ maskIps: v })} />
                    </div>
                    {data.server && (
                        <div className="rounded-xl border border-white/[0.07] p-3">
                            <label className="kz-label" htmlFor="ai-limit">Server model: questions per day</label>
                            <input id="ai-limit" type="number" min={0} max={10000} className="kz-input" defaultValue={data.dailyLimit}
                                onBlur={e => Number(e.target.value) !== data.dailyLimit && saveSettings({ dailyLimit: Number(e.target.value) }, 'Saved')} />
                            <p className="text-[11px] text-slate-500 mt-1">{data.usedToday} used today. Your own engines have no limit.</p>
                        </div>
                    )}
                </div>
            </Section>

            {data.engines.length > 0 && (
                <Section icon={GraduationCap} title="Quality" hint="Test your engines on real-looking Kubernetes failures and compare them — so a weak model or a worse new version never goes unnoticed.">
                    <QualityPanel settings={data} onRoutesSaved={load} />
                </Section>
            )}

            <Section icon={MessageCircle} title="ChatOps" hint="Ask KubeEZ from your Telegram or Slack alert channel — ask in English, हिन्दी or Hinglish — answers are always in English.">
                <ChatOpsPanel channels={data.chatops || []} onChanged={load} />
            </Section>

            <Section icon={Coins} title="Cost prices" hint="What a CPU core and a GiB of memory cost you a month — the Advisor uses them to estimate savings.">
                <div className="flex flex-wrap items-end gap-3">
                    <div><label className="kz-label" htmlFor="rate-cur">Currency</label><select id="rate-cur" className="kz-input !w-24" value={data.costRates?.currency || '₹'} onChange={e => saveSettings({ costRates: { ...data.costRates, currency: e.target.value } }, 'Saved')}>{['₹', '$', '€', '£'].map(c => <option key={c}>{c}</option>)}</select></div>
                    <div><label className="kz-label" htmlFor="rate-cpu">Per CPU core / month</label><input id="rate-cpu" type="number" min={0} className="kz-input !w-40" defaultValue={data.costRates?.cpu} onBlur={e => Number(e.target.value) !== data.costRates?.cpu && saveSettings({ costRates: { ...data.costRates, cpu: Number(e.target.value) } }, 'Saved')} /></div>
                    <div><label className="kz-label" htmlFor="rate-mem">Per GiB memory / month</label><input id="rate-mem" type="number" min={0} className="kz-input !w-40" defaultValue={data.costRates?.memGb} onBlur={e => Number(e.target.value) !== data.costRates?.memGb && saveSettings({ costRates: { ...data.costRates, memGb: Number(e.target.value) } }, 'Saved')} /></div>
                </div>
            </Section>

            <Section icon={BookOpenCheck} title="Runbooks" hint="Fixes KubeEZ learned: what really made a problem go away on a workload. They are offered first next time; proven restarts can run by themselves.">
                <RunbooksPanel autonomy={data.autonomy} />
            </Section>

            <Section icon={Brain} title="Learning" hint="KubeEZ AI gets better from your 👍 — without training a model.">
                <LearningPanel />
            </Section>

            <Section icon={Plug} title="MCP — use KubeEZ from your AI assistant" hint="Personal tokens for Claude Code, Claude Desktop, Cursor and other MCP clients.">
                <McpPanel />
            </Section>

            <Section icon={FileBadge} title="AI-BOM" hint="The bill of materials of KubeEZ AI: models with digests, prompts, where data goes, safety controls.">
                <AiBomPanel />
            </Section>

            <Section icon={Send} title="Try it" hint="Ask anything — it goes through the same routing, masking and fallbacks as the real features.">
                <TryIt />
            </Section>

            <Section icon={History} title="Activity" hint="The last questions and which engine answered. Prompts are stored masked; API keys are never stored here.">
                <Activity />
            </Section>

            {dialog && <ConnectAi data={data} initial={dialog === 'new' ? null : dialog} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load() }} />}
        </div>
    )
}
