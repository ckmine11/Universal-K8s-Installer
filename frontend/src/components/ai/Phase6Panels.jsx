import { useState, useEffect, useCallback } from 'react'
import { Loader2, Trash2, Copy, Download, KeyRound, Plus, Check } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'

// Settings → AI: MCP tokens, the AI-BOM, and learning from 👍 answers.
const copy = (text, toast) => { navigator.clipboard?.writeText(text); toast({ title: 'Copied', type: 'success' }) }
const origin = () => window.location.origin

async function download(url, name) {
    const r = await apiFetch(url)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Download failed')
    const blob = await r.blob()
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export function McpPanel() {
    const { toast } = useToast()
    const [tokens, setTokens] = useState(null)
    const [name, setName] = useState('')
    const [days, setDays] = useState(90)
    const [fresh, setFresh] = useState(null)
    const load = useCallback(() => apiFetch('/api/ai/mcp/tokens').then(r => r.json()).then(d => setTokens(d.tokens || [])).catch(() => setTokens([])), [])
    useEffect(() => { load() }, [load])
    const create = async () => {
        const r = await apiFetch('/api/ai/mcp/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, days }) })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) return toast({ title: 'Not created', message: d.error, type: 'error' })
        setFresh(d); setName(''); load()
    }
    const revoke = async (t) => { if (!window.confirm(`Revoke "${t.name}"? Clients using it stop working.`)) return; await apiFetch(`/api/ai/mcp/tokens/${t.id}`, { method: 'DELETE' }); load() }
    const url = `${origin()}/api/mcp`
    const cmd = fresh ? `claude mcp add --transport http kubeez ${url} --header "Authorization: Bearer ${fresh.token}"` : ''
    const json = fresh ? JSON.stringify({ mcpServers: { kubeez: { type: 'http', url, headers: { Authorization: `Bearer ${fresh.token}` } } } }, null, 2) : ''

    return (
        <div className="space-y-3">
            <p className="text-xs text-slate-400 leading-relaxed">Connect an AI assistant (Claude Code, Claude Desktop, Cursor…) to KubeEZ: it can list your clusters, their risk and problems, explain a problem, show what changed and give security and cost advice — <b className="text-slate-200">read-only</b>, with <b className="text-slate-200">your</b> permissions. Every call is in the audit trail.</p>
            <div className="flex flex-wrap items-end gap-2">
                <div><label className="kz-label" htmlFor="mcp-name">Token name</label><input id="mcp-name" className="kz-input !w-64" value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="Claude Code on my laptop" /></div>
                <div><label className="kz-label" htmlFor="mcp-days">Valid for</label><select id="mcp-days" className="kz-input !w-32" value={days} onChange={e => setDays(Number(e.target.value))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></div>
                <button onClick={create} disabled={name.trim().length < 2} className="kz-btn-primary !py-2"><Plus className="w-4 h-4" /> Create token</button>
            </div>
            {fresh && (
                <div className="rounded-2xl border border-emerald-400/25 bg-emerald-500/[0.05] p-4 space-y-2 text-xs">
                    <p className="flex items-center gap-1.5 font-semibold text-emerald-200"><Check className="w-4 h-4" /> Copy it now — it is not shown again.</p>
                    <div className="flex items-center gap-2"><code className="flex-1 truncate rounded bg-black/40 px-2 py-1.5 text-blue-200">{fresh.token}</code><button onClick={() => copy(fresh.token, toast)} className="kz-btn-ghost !py-1 !text-xs"><Copy className="w-3 h-3" /></button></div>
                    <p className="text-slate-400">Claude Code:</p>
                    <div className="flex items-start gap-2"><code className="flex-1 break-all rounded bg-black/40 px-2 py-1.5 text-slate-200">{cmd}</code><button onClick={() => copy(cmd, toast)} className="kz-btn-ghost !py-1 !text-xs"><Copy className="w-3 h-3" /></button></div>
                    <p className="text-slate-400">Other clients (JSON config):</p>
                    <div className="flex items-start gap-2"><pre className="flex-1 overflow-auto rounded bg-black/40 px-2 py-1.5 text-slate-200">{json}</pre><button onClick={() => copy(json, toast)} className="kz-btn-ghost !py-1 !text-xs"><Copy className="w-3 h-3" /></button></div>
                    <p className="text-slate-500">Then ask it, e.g. “Which of my clusters is most at risk, and why?” or “Explain the open problems on prod”.</p>
                </div>
            )}
            {tokens?.length > 0 && (
                <ul className="space-y-1.5">
                    {tokens.map(t => (
                        <li key={t.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5 text-xs">
                            <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                            <span className="font-semibold text-white">{t.name}</span>
                            <code className="text-slate-500">{t.prefix}…</code>
                            <span className="text-slate-500 flex-1">until {new Date(t.expiresAt).toLocaleDateString()} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : 'never used'}</span>
                            <button onClick={() => revoke(t)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-300 hover:bg-red-500/10" aria-label={`Revoke ${t.name}`}><Trash2 className="w-3.5 h-3.5" /></button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

export function AiBomPanel() {
    const { toast } = useToast()
    const [b, setB] = useState(null)
    useEffect(() => { apiFetch('/api/ai/bom').then(r => r.ok ? r.json() : null).then(setB).catch(() => setB(null)) }, [])
    if (!b) return <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
    return (
        <div className="space-y-4 text-xs">
            <div className="flex flex-wrap items-center gap-3">
                <p className="text-slate-400 flex-1">What KubeEZ AI is made of in this workspace — for audits (DPDP, ISO 27001, EU AI Act). A changed model or prompt shows up as a changed digest.</p>
                <button onClick={() => download('/api/ai/bom?format=cyclonedx', `kubeez-ai-bom-${b.generatedAt.slice(0, 10)}.cdx.json`).catch(e => toast({ title: 'Not downloaded', message: e.message, type: 'error' }))} className="kz-btn-primary !py-2"><Download className="w-4 h-4" /> Download (CycloneDX)</button>
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/[0.07]">
                <table className="w-full">
                    <thead className="text-left text-slate-500 bg-white/[0.02]"><tr><th className="p-2">Model</th><th className="p-2">Engine</th><th className="p-2">Where data goes</th><th className="p-2">Digest</th><th className="p-2">Used for</th><th className="p-2">Quality</th></tr></thead>
                    <tbody>
                        {b.models.map(m => (
                            <tr key={m.id} className="border-t border-white/5">
                                <td className="p-2 font-mono text-slate-200">{m.model}{m.details?.parameters ? <span className="text-slate-500"> · {m.details.parameters}{m.details.quantization ? ` ${m.details.quantization}` : ''}</span> : ''}</td>
                                <td className="p-2 text-slate-300">{m.name}{!m.enabled && <span className="text-slate-500"> (off)</span>}</td>
                                <td className={`p-2 ${m.dataLeaves ? 'text-amber-300' : 'text-emerald-300'}`}>{m.dataLeaves ? `leaves your network → ${m.endpoint}` : `stays inside (${m.endpoint})`}</td>
                                <td className="p-2 font-mono text-slate-500">{m.details?.digest ? m.details.digest.slice(0, 19) : '—'}</td>
                                <td className="p-2 text-slate-400">{m.usedFor.join(', ') || '—'}</td>
                                <td className="p-2 text-slate-400">{m.quality ? `${m.quality.score}/100${m.quality.stale ? ' (model changed)' : ''}` : 'not tested'}</td>
                            </tr>
                        ))}
                        {!b.models.length && <tr><td colSpan={6} className="p-2 text-slate-500">No engines yet.</td></tr>}
                    </tbody>
                </table>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/[0.07] p-3 space-y-1">
                    <p className="font-semibold text-slate-200">Safety controls</p>
                    {b.controls.map(([k, v]) => <p key={k}><span className="text-slate-400">{k}:</span> <span className="text-slate-200">{v}</span></p>)}
                </div>
                <div className="rounded-xl border border-white/[0.07] p-3 space-y-1">
                    <p className="font-semibold text-slate-200">Prompts ({b.prompts.length}) and what is kept</p>
                    {b.prompts.map(p => <p key={p.name} className="text-slate-400">{p.name} <code className="text-slate-500">{p.sha256.slice(0, 10)}</code></p>)}
                    <div className="pt-1 border-t border-white/5 mt-1">{b.retention.map(([k, v]) => <p key={k}><span className="text-slate-400">{k}:</span> <span className="text-slate-200">{v}</span></p>)}</div>
                </div>
            </div>
        </div>
    )
}

export function LearningPanel() {
    const { toast } = useToast()
    const [ex, setEx] = useState(null)
    const load = useCallback(() => apiFetch('/api/ai/learning').then(r => r.json()).then(d => setEx(d.examples || [])).catch(() => setEx([])), [])
    useEffect(() => { load() }, [load])
    const remove = async (x) => { await apiFetch(`/api/ai/learning/${x.id}`, { method: 'DELETE' }); load() }
    if (!ex) return <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
    return (
        <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
                <p className="text-slate-400 flex-1">When members mark an explanation 👍, it becomes a worked example: the next explanation of the same kind of problem sees it (with any model, no GPU). The dataset is every 👍 answer, masked, in chat format — for real fine-tuning elsewhere (needs a GPU; the result can be added back as an Ollama engine).</p>
                <button onClick={() => download('/api/ai/learning/dataset', 'kubeez-ai-dataset.jsonl').catch(e => toast({ title: 'Not downloaded', message: e.message, type: 'error' }))} className="kz-btn-ghost !py-2"><Download className="w-4 h-4" /> Dataset (JSONL)</button>
            </div>
            {!ex.length && <p className="text-slate-500">No examples yet — mark good explanations with 👍.</p>}
            <ul className="space-y-1.5">
                {ex.map(x => (
                    <li key={x.id} className="flex items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                        <div className="flex-1 min-w-0">
                            <p className="text-slate-200"><b>{x.kind}</b> — {x.answer.summary}</p>
                            <p className="text-slate-500">Cause: {x.answer.cause || '—'} · by {x.by}, {new Date(x.at).toLocaleDateString()} · {x.provider} ({x.model})</p>
                        </div>
                        <button onClick={() => remove(x)} className="p-1.5 rounded-lg text-slate-500 hover:text-red-300 hover:bg-red-500/10" aria-label="Forget this example"><Trash2 className="w-3.5 h-3.5" /></button>
                    </li>
                ))}
            </ul>
        </div>
    )
}
