import { useState, useEffect, useRef } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { Sparkles, Plug, Send, Loader2, Wand2, Coins, History, Bot, Server } from 'lucide-react'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can, kubeLevel } from '../config/permissions'
import { PageTitle } from '../components/ui/PageHeader'
import { aiJob } from '../components/ai/aiJob'
import YamlStudio from '../components/ai/YamlStudio'
import Advisor from '../components/ai/Advisor'
import WhatChanged from '../components/ai/WhatChanged'
import FixPreview, { actionLabel } from '../components/ai/FixPreview'

// The AI section of the sidebar: Ask AI (chat about your clusters, in English,
// Hindi or Hinglish; answers in English) and the per-cluster AI tools with a cluster picker.
const TOOLS = {
    create: { title: 'Create YAML', icon: Wand2, description: 'Describe what you want — KubeEZ AI writes the YAML, checks it, dry-runs it on the cluster; Apply can be undone.' },
    advisor: { title: 'Advisor', icon: Coins, description: 'Security and cost advice for every workload of a cluster.' },
    changes: { title: 'What changed', icon: History, description: 'Everything that changed on a cluster — by KubeEZ and inside Kubernetes.' }
}
const SUGGESTIONS = ['sab theek hai?', 'kitne namespace hain?', 'kaunse pod fail ho rahe hain?', 'crash wala pod check karo', 'nodes dikhao', 'kya problem hai', 'why 1', 'what changed in the last 6h', 'What is a DaemonSet?']
const STORE = 'kz.ai.chat'

// links in answers become clickable; nothing else is interpreted
function Linkified({ text }) {
    return text.split(/(https?:\/\/\S+)/g).map((p, i) => /^https?:\/\//.test(p)
        ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline break-all">{p}</a> : p)
}

function AskAi() {
    const { user } = useAuth()
    // every answer comes from the AI connected to the workspace — none yet: connect one first
    const [engines, setEngines] = useState(null)
    useEffect(() => { apiFetch('/api/ai').then(r => r.ok ? r.json() : null).then(d => setEngines(d ? d.engines.filter(e => e.enabled !== false).length : null)).catch(() => { }) }, [])
    const [msgs, setMsgs] = useState(() => { try { return JSON.parse(sessionStorage.getItem(STORE)) || [] } catch { return [] } })
    const [text, setText] = useState('')
    const [busy, setBusy] = useState(false)
    const end = useRef(null)
    useEffect(() => { try { sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-40))) } catch { } end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [msgs])

    const send = async (q) => {
        const question = (q ?? text).trim()
        if (!question || busy) return
        setText(''); setBusy(true)
        setMsgs(m => [...m, { who: 'me', text: question }])
        const { ok, data } = await aiJob('/api/ai/chat', { text: question })
        setMsgs(m => [...m, { who: 'ai', text: ok ? data.reply : `⚠ ${data.error}`, engine: ok ? data.engine || null : null, needsAi: ok && !!data.needsAi, fix: ok ? data.fix || null : null }])
        if (ok && data.needsAi) setEngines(0)
        setBusy(false)
    }

    return (
        <>
        {engines === 0 && (
            <div className="mb-3 rounded-2xl border border-amber-400/30 bg-amber-500/[0.07] p-4 flex flex-wrap items-center gap-3">
                <Plug className="w-5 h-5 text-amber-300 shrink-0" />
                <div className="flex-1 min-w-[240px] text-xs text-amber-100 leading-relaxed">
                    <div className="text-sm font-semibold text-white">Connect an AI model first</div>
                    Ask AI answers through the AI connected to this workspace, with live data from your clusters. Connect any model — Claude, Gemini, OpenAI, OpenRouter, Groq… or your own offline model (Ollama, LM Studio, vLLM…).
                    {!can(user?.role, 'ai:manage') && ' Ask an admin of your workspace to connect one.'}
                </div>
                {can(user?.role, 'ai:manage') && <Link to="/ai/settings" className="kz-btn-primary !text-xs"><Plug className="w-4 h-4" /> Connect AI</Link>}
            </div>
        )}
        <div className="kz-card flex flex-col h-[calc(100vh-260px)] min-h-[420px]">
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {!msgs.length && (
                    <div className="text-center py-10">
                        <Bot className="w-10 h-10 mx-auto text-violet-300" />
                        <p className="mt-3 text-sm text-slate-300">Ask about your clusters — in English, हिन्दी or Hinglish. Answers are always in clear English.</p>
                        <p className="mt-1 text-xs text-slate-500">Ask anything about what runs in your clusters, or say “web-2 ka log check karo”. KubeEZ reads your clusters live (pods, logs, events, problems) and your connected AI answers from that. Only about what you may see; a fix runs only after you preview (dry-run) and apply it.</p>
                    </div>
                )}
                {msgs.map((m, i) => (
                    <div key={i} className={`flex ${m.who === 'me' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${m.who === 'me' ? 'bg-blue-500/20 text-white' : 'bg-white/[0.04] border border-white/[0.07] text-slate-200'}`}>
                            <Linkified text={m.text} />
                            {m.engine && <div className="mt-1.5 text-[10px] text-slate-500">Answered by {m.engine.provider}{m.engine.model ? ` · ${m.engine.model}` : ''} · live cluster data</div>}
                            {m.needsAi && can(user?.role, 'ai:manage') && <div className="mt-2 whitespace-normal"><Link to="/ai/settings" className="kz-btn-primary !py-1.5 !text-xs inline-flex"><Plug className="w-3.5 h-3.5" /> Connect AI</Link></div>}
                            {m.fix && <div className="mt-3 whitespace-normal">{m.fix.canAct
                                ? <FixPreview clusterId={m.fix.clusterId} spec={m.fix.spec} />
                                : <p className="text-[11px] text-slate-500">Suggested fix: {actionLabel(m.fix.spec)} — someone who may act on incidents can apply it.</p>}</div>}
                        </div>
                    </div>
                ))}
                {busy && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="w-4 h-4 animate-spin text-violet-300" /> Reading your clusters and asking the AI… (a model on CPU can take up to a minute)</div>}
                <div ref={end} />
            </div>
            <div className="border-t border-white/[0.07] p-3 space-y-2">
                <div className="flex flex-wrap gap-1.5">{SUGGESTIONS.map(x => <button key={x} onClick={() => send(x)} disabled={busy || engines === 0} className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-slate-400 hover:text-white hover:border-white/20 disabled:opacity-40">{x}</button>)}</div>
                <form onSubmit={e => { e.preventDefault(); send() }} className="flex gap-2">
                    <input className="kz-input flex-1" value={text} onChange={e => setText(e.target.value)} maxLength={2000} disabled={engines === 0} placeholder={engines === 0 ? 'Connect an AI model first (AI settings → Connect AI)' : 'e.g. web-2 ka log check karo  ·  kitne namespace hain?  ·  prod pe kya badla aaj?'} aria-label="Ask KubeEZ AI" autoFocus />
                    <button type="submit" disabled={busy || !text.trim() || engines === 0} className="kz-btn-primary">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}</button>
                    {msgs.length > 0 && <button type="button" onClick={() => setMsgs([])} className="kz-btn-ghost !text-xs">Clear</button>}
                </form>
            </div>
        </div>
        </>
    )
}

function ClusterTool({ tool }) {
    const { user } = useAuth()
    const [params, setParams] = useSearchParams()
    const [clusters, setClusters] = useState(null)
    useEffect(() => { apiFetch('/api/clusters/list').then(r => r.ok ? r.json() : []).then(l => setClusters(Array.isArray(l) ? l.filter(c => c.status !== 'failed') : [])).catch(() => setClusters([])) }, [])
    const id = params.get('cluster') || clusters?.[0]?.id || ''
    if (!clusters) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>
    if (!clusters.length) return <div className="kz-card p-6 text-sm text-slate-400">No clusters yet — <Link to="/install" className="text-blue-400 hover:underline">deploy one</Link> first.</div>
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <Server className="w-4 h-4 text-slate-400" />
                <label className="text-xs text-slate-400" htmlFor="ai-cluster-pick">Cluster</label>
                <select id="ai-cluster-pick" className="kz-input !w-auto !py-1.5" value={id} onChange={e => setParams({ cluster: e.target.value }, { replace: true })}>
                    {clusters.map(c => <option key={c.id} value={c.id}>{c.clusterName} · v{c.k8sVersion}</option>)}
                </select>
                <Link to={`/cluster/${id}`} className="text-xs text-blue-300 hover:underline">Open cluster →</Link>
            </div>
            {tool === 'create' && <YamlStudio key={id} clusterId={id} canEdit={['edit', 'admin'].includes(kubeLevel(user?.role, id))} />}
            {tool === 'advisor' && <Advisor key={id} clusterId={id} />}
            {tool === 'changes' && <WhatChanged key={id} clusterId={id} />}
        </div>
    )
}

export default function AiHub() {
    const { tool } = useParams()
    const { user } = useAuth()
    const t = TOOLS[tool]
    if (!can(user?.role, 'ai:use') && tool !== 'advisor' && tool !== 'changes') return (
        <div className="max-w-3xl mx-auto kz-card p-6 text-sm text-slate-300">Your role may not use KubeEZ AI. Ask an admin to add the permission <code>ai:use</code> to your role.</div>
    )
    return (
        <div className="max-w-7xl mx-auto space-y-5">
            {t ? <PageTitle icon={t.icon} eyebrow="AI" title={t.title} description={t.description} />
                : <PageTitle icon={Sparkles} eyebrow="AI" title="Ask AI" description="Chat about your clusters: what is wrong, why, what changed, what to do — answers from your real cluster data." />}
            {t ? <ClusterTool tool={tool} /> : <AskAi />}
        </div>
    )
}
