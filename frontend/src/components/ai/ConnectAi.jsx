import { useState, useEffect, useMemo } from 'react'
import { X, Loader2, ArrowLeft, PlugZap, CheckCircle2, AlertTriangle, Search, Server, Cloud, Boxes, Bot, ExternalLink, Sparkles, Zap, Star, Download } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import useBackdropClose from '../ui/useBackdropClose'

// Connect AI: any model, offline or cloud.
//   1. pick where it runs — an offline runtime on your own machine / server
//      (Ollama, LM Studio, vLLM, llama.cpp, LocalAI, TGI, Jan… or any
//      OpenAI-compatible server), the KubeEZ AI add-on, or a cloud API
//   2. connect: KubeEZ reads the engine's models live (so new models show
//      up by themselves), tells which runtime answered, suggests one
//   3. add it — and, if wanted, run the quality test on it straight away
// A model on the user's own network (e.g. a GPU server at 192.168.1.50) can be
// reached through one of their clusters — nothing needs to be exposed.
async function call(url, opts) {
    const res = await apiFetch(url, opts)
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(d.error || 'Request failed'), { data: d })
    return d
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const iconOf = (p) => p.kind === 'cluster' ? Boxes : p.kind === 'ollama' ? Bot : p.group === 'offline' ? Server : Cloud

function Tag({ children, className = '' }) { return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${className}`}>{children}</span> }

function ModelList({ models, value, onPick }) {
    const [q, setQ] = useState('')
    const shown = useMemo(() => models.filter(m => m.id.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 300), [models, q])
    return (
        <div className="rounded-xl border border-white/10">
            {models.length > 8 && (
                <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
                    <Search className="w-3.5 h-3.5 text-slate-500" />
                    <input className="flex-1 bg-transparent text-xs text-white outline-none" placeholder={`Search ${models.length} models…`} value={q} onChange={e => setQ(e.target.value)} aria-label="Search models" />
                </div>
            )}
            <div className="max-h-56 overflow-y-auto divide-y divide-white/5" role="listbox" aria-label="Models">
                {shown.map(m => (
                    <button type="button" key={m.id} role="option" aria-selected={value === m.id} onClick={() => onPick(m.id)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition ${value === m.id ? 'bg-blue-500/15 text-white' : 'text-slate-300 hover:bg-white/5'}`}>
                        <span className={`w-3 h-3 rounded-full border ${value === m.id ? 'border-blue-300 bg-blue-400' : 'border-white/30'}`} />
                        <span className="flex-1 font-mono truncate">{m.id}</span>
                        {m.new && <Tag className="bg-fuchsia-500/20 text-fuchsia-200">NEW</Tag>}
                        {m.recommended && <Tag className="bg-emerald-500/15 text-emerald-200">Recommended</Tag>}
                        {m.fast && <Tag className="bg-sky-500/15 text-sky-200">Fast</Tag>}
                        {m.large && <Tag className="bg-violet-500/15 text-violet-200">Large</Tag>}
                    </button>
                ))}
                {!shown.length && <p className="px-3 py-3 text-xs text-slate-500">No model matches.</p>}
            </div>
        </div>
    )
}

export default function ConnectAi({ data, initial, onClose, onSaved }) {
    const { toast } = useToast()
    const backdrop = useBackdropClose(onClose)
    const editing = !!initial
    const presets = data.presets || []
    const [presetId, setPresetId] = useState(initial?.preset || null)
    const preset = presets.find(p => p.id === presetId) || null
    const [f, setF] = useState(() => ({ name: initial?.name || '', baseUrl: initial?.baseUrl || '', apiKey: '', clusterId: initial?.clusterId || '', viaClusterId: initial?.viaClusterId || '', model: initial?.model || '' }))
    const [disc, setDisc] = useState(null)        // the live result: runtime, models
    const [connecting, setConnecting] = useState(false)
    const [saving, setSaving] = useState(false)
    const [quality, setQuality] = useState(true)
    const set = (k, v) => setF(p => ({ ...p, [k]: v }))

    const pick = (p) => {
        setPresetId(p.id); setDisc(null)
        setF(x => ({ ...x, name: p.label, baseUrl: p.baseUrl || '', model: '', apiKey: '', clusterId: '', viaClusterId: '' }))
    }
    const needsUrl = preset && ['openai', 'ollama'].includes(preset.kind)
    const offline = preset?.group === 'offline'
    const canVia = offline && needsUrl && data.clusters.length > 0
    const viaName = data.clusters.find(c => c.id === f.viaClusterId)?.name

    const connect = async () => {
        setConnecting(true); setDisc(null)
        try {
            const r = editing
                ? await call(`/api/ai/providers/${initial.id}/models`)
                : await call('/api/ai/discover', json('POST', { preset: preset.id, baseUrl: f.baseUrl || undefined, apiKey: f.apiKey || undefined, clusterId: f.clusterId || undefined, viaClusterId: f.viaClusterId || undefined }))
            setDisc(r)
            if (r.baseUrl && r.baseUrl !== f.baseUrl) set('baseUrl', r.baseUrl)
            if (!f.model && r.suggested) set('model', r.suggested)
        } catch (e) { setDisc({ ok: false, detail: e.message, models: [] }) } finally { setConnecting(false) }
    }
    // editing: read the engine's models right away
    useEffect(() => { if (editing && preset) connect() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

    const empty = disc && disc.ok && !disc.models.length && ['ollama', 'cluster'].includes(preset?.kind)
    const canSave = preset && f.name.trim().length >= 2 && f.model.trim() && (!needsUrl || f.baseUrl.trim()) && (preset.kind !== 'cluster' || f.clusterId) && (!preset.needsKey || f.apiKey || (editing && initial.hasKey))

    const save = async (ev) => {
        ev.preventDefault(); setSaving(true)
        try {
            const body = { name: f.name.trim(), model: f.model.trim(), ...(needsUrl ? { baseUrl: f.baseUrl.trim() } : {}), ...(preset.kind === 'cluster' ? { clusterId: f.clusterId } : {}), ...(canVia ? { viaClusterId: f.viaClusterId || null } : {}), ...(f.apiKey ? { apiKey: f.apiKey } : {}) }
            let saved
            if (editing) saved = await call(`/api/ai/providers/${initial.id}`, json('PUT', body))
            else saved = await call('/api/ai/providers', json('POST', { ...body, preset: preset.id, qualityCheck: quality }))
            // an Ollama-type engine without that model yet: download it now
            const has = disc?.models?.some(m => m.id === f.model.trim())
            if (['ollama', 'cluster'].includes(preset.kind) && disc?.ok && !has) {
                await call(`/api/ai/providers/${saved.id}/pull`, json('POST', { model: f.model.trim() })).catch(() => { })
                toast({ title: editing ? 'Engine saved' : 'AI connected', message: `Downloading ${f.model.trim()} into it — this can take a few minutes.`, type: 'success' })
            } else {
                toast({ title: editing ? 'Engine saved' : 'AI connected', message: saved.qualityCheck === 'started' ? 'The quality test is running on it now — the score shows on its card.' : 'Use "Test" on its card to check it answers.', type: 'success' })
            }
            onSaved()
        } catch (e) { toast({ title: 'Not saved', message: e.message, type: 'error' }) } finally { setSaving(false) }
    }

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" {...backdrop}>
            <div onClick={e => e.stopPropagation()} className="kz-card w-full max-w-2xl max-h-[92vh] overflow-y-auto p-6 space-y-4" role="dialog" aria-label={editing ? `Edit ${initial.name}` : 'Connect AI'}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {preset && !editing && <button type="button" onClick={() => { setPresetId(null); setDisc(null) }} className="kz-btn-ghost !p-2" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>}
                        <h3 className="text-lg font-semibold text-white">{editing ? `Edit ${initial.name}` : preset ? `Connect ${preset.label}` : 'Connect AI'}</h3>
                    </div>
                    <button type="button" onClick={onClose} className="kz-btn-ghost !p-2" aria-label="Close"><X className="w-4 h-4" /></button>
                </div>

                {/* 1 · where the model runs */}
                {!preset && (
                    <div className="space-y-5">
                        <p className="text-xs text-slate-400">Use any model you like. KubeEZ reads the engine's model list live, so new models appear here on their own.</p>
                        {[['offline', 'Offline — on your own machine or server', 'Free, private: the data stays with you. Any model your runtime can run.'], ['cloud', 'Cloud — with your own API key', 'Fast and strong models; billed to your account. Secrets are masked before anything is sent.']].map(([g, title, hint]) => (
                            <div key={g}>
                                <div className="text-sm font-semibold text-white">{title}</div>
                                <p className="text-[11px] text-slate-500 mb-2">{hint}{g === 'offline' && data.saas ? ' On KubeEZ Cloud your server must be reachable over https — or use the KubeEZ AI add-on, which needs nothing exposed.' : ''}</p>
                                <div className="grid sm:grid-cols-2 gap-2">
                                    {presets.filter(p => p.group === g).map(p => {
                                        const Icon = iconOf(p)
                                        return (
                                            <button type="button" key={p.id} onClick={() => pick(p)} className="text-left rounded-xl border border-white/10 px-3 py-2.5 hover:bg-white/5 hover:border-blue-400/40 transition">
                                                <div className="flex items-center gap-2 text-xs font-semibold text-white"><Icon className="w-4 h-4 text-blue-300" />{p.label}</div>
                                                <div className="text-[11px] text-slate-500 mt-1 leading-snug">{p.note}</div>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* 2 · connect and pick a model */}
                {preset && (
                    <form onSubmit={save} className="space-y-4">
                        <p className="text-[11px] text-slate-400 leading-relaxed">{preset.note}</p>
                        {preset.kind === 'cluster' && (
                            <div>
                                <label className="kz-label" htmlFor="ca-cluster">Cluster</label>
                                <select id="ca-cluster" className="kz-input" value={f.clusterId} onChange={e => set('clusterId', e.target.value)} disabled={editing}>
                                    <option value="">Pick a cluster…</option>
                                    {data.clusters.map(c => <option key={c.id} value={c.id}>{c.name}{c.hasAi ? ' — KubeEZ AI installed' : ''}</option>)}
                                </select>
                                {!data.clusters.some(c => c.hasAi) && <p className="text-[11px] text-amber-300/90 mt-1">Install the <b>KubeEZ AI</b> add-on on a cluster first (cluster page → Add-ons). It is free.</p>}
                            </div>
                        )}
                        {canVia && (
                            <div>
                                <label className="kz-label" htmlFor="ca-via">How KubeEZ reaches it</label>
                                <select id="ca-via" className="kz-input" value={f.viaClusterId} onChange={e => { set('viaClusterId', e.target.value); setDisc(null) }}>
                                    <option value="">Directly — the address is reachable from KubeEZ</option>
                                    {data.clusters.map(c => <option key={c.id} value={c.id}>Through cluster {c.name} — a server on that cluster's network</option>)}
                                </select>
                                {f.viaClusterId && <p className="text-[11px] text-emerald-200/80 mt-1">KubeEZ goes through its secure tunnel to {viaName}; that cluster's control-plane node reaches the server. No public address, no open port — nothing is exposed.</p>}
                            </div>
                        )}
                        {needsUrl && (
                            <div>
                                <label className="kz-label" htmlFor="ca-url">Address</label>
                                <input id="ca-url" className="kz-input font-mono" value={f.baseUrl} onChange={e => { set('baseUrl', e.target.value); setDisc(null) }} placeholder={preset.baseUrl || 'http://192.168.1.50:8000/v1'} autoComplete="off" />
                                {offline && f.viaClusterId && <p className="text-[11px] text-slate-500 mt-1">As the control-plane node of {viaName} sees it, e.g. <span className="font-mono">http://192.168.1.50:8000/v1</span> — plain http (the tunnel is already encrypted).</p>}
                                {offline && !f.viaClusterId && <p className="text-[11px] text-slate-500 mt-1">Where it listens{preset.baseUrl ? ` (default ${preset.baseUrl.replace('localhost', 'your-server')})` : ''}. "localhost" is the KubeEZ server itself — use the machine's address if the model runs elsewhere.</p>}
                            </div>
                        )}
                        {preset.kind !== 'cluster' && (preset.needsKey || offline) && preset.kind !== 'ollama' && (
                            <div>
                                <label className="kz-label" htmlFor="ca-key">API key {!preset.needsKey && <span className="text-slate-500 font-normal">(only if your server asks for one)</span>}</label>
                                <input id="ca-key" type="password" className="kz-input font-mono" value={f.apiKey} onChange={e => { set('apiKey', e.target.value); setDisc(null) }} placeholder={editing && initial.hasKey ? 'Saved — type to replace' : ''} autoComplete="new-password" />
                                <p className="text-[11px] text-slate-500 mt-1">Stored encrypted on the KubeEZ server; never shown again.{preset.keyUrl && <> <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline inline-flex items-center gap-0.5">Get a key <ExternalLink className="w-3 h-3" /></a></>}</p>
                            </div>
                        )}

                        <div className="flex flex-wrap items-center gap-3">
                            <button type="button" onClick={connect} disabled={connecting || (needsUrl && !f.baseUrl.trim()) || (preset.kind === 'cluster' && !f.clusterId) || (!editing && preset.needsKey && !f.apiKey)} className="kz-btn-ghost">
                                {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />} {disc ? 'Connect again' : 'Connect & find models'}
                            </button>
                            {disc && (
                                <span className={`text-xs flex items-center gap-1.5 ${disc.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                                    {disc.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                                    {disc.ok ? `Connected${disc.runtime ? ` — ${disc.runtime}` : ''} · ${disc.models.length} chat model${disc.models.length === 1 ? '' : 's'}` : disc.detail}
                                </span>
                            )}
                        </div>

                        {disc && !disc.ok && offline && /https|private|internal|not allowed/i.test(disc.detail || '') && (
                            <p className="rounded-xl border border-amber-400/25 bg-amber-500/[0.05] p-3 text-[11px] text-amber-100 leading-relaxed">
                                KubeEZ Cloud reaches your model over the internet, so it needs a <b>public https address</b> (e.g. behind a reverse proxy or a tunnel such as Cloudflare Tunnel).
                                {' '}For a model on your own network with nothing exposed, {canVia ? <><button type="button" className="underline text-amber-200" onClick={() => { set('viaClusterId', data.clusters[0].id); setDisc(null) }}>reach it through your cluster {data.clusters[0].name}</button> ("How KubeEZ reaches it" above), or </> : ''}use the <button type="button" className="underline text-amber-200" onClick={() => pick(presets.find(p => p.id === 'kubeez-addon'))}>KubeEZ AI add-on</button> in your cluster.
                            </p>
                        )}
                        {disc?.models?.length > 0 && (
                            <div>
                                <label className="kz-label">Model</label>
                                <ModelList models={disc.models} value={f.model} onPick={(m) => set('model', m)} />
                                {disc.models.some(m => m.new) && <p className="text-[11px] text-fuchsia-200/80 mt-1 flex items-center gap-1"><Sparkles className="w-3 h-3" /> NEW = added by the provider in the last 14 days.</p>}
                            </div>
                        )}
                        {empty && (
                            <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.05] p-3 space-y-2">
                                <p className="text-xs text-amber-200 flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> No model downloaded yet — pick one; KubeEZ downloads it after adding:</p>
                                <div className="grid sm:grid-cols-2 gap-1.5">
                                    {(data.ollamaSuggestions || []).map(s => (
                                        <button type="button" key={s.id} onClick={() => set('model', s.id)} className={`text-left rounded-lg border px-2.5 py-1.5 text-[11px] ${f.model === s.id ? 'border-blue-400/60 bg-blue-500/10 text-white' : 'border-white/10 text-slate-300 hover:bg-white/5'}`}>
                                            <span className="font-mono">{s.id}</span> <span className="text-slate-500">· {s.ramGb} GB · {s.note}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {(disc || editing) && (
                            <div className="grid sm:grid-cols-2 gap-3">
                                <div>
                                    <label className="kz-label" htmlFor="ca-model">{disc?.models?.length ? 'Or type a model name' : 'Model'}</label>
                                    <input id="ca-model" className="kz-input font-mono" value={f.model} onChange={e => set('model', e.target.value)} placeholder="e.g. qwen2.5:7b" autoComplete="off" />
                                </div>
                                <div>
                                    <label className="kz-label" htmlFor="ca-name">Name</label>
                                    <input id="ca-name" className="kz-input" value={f.name} onChange={e => set('name', e.target.value)} maxLength={60} autoComplete="off" />
                                </div>
                            </div>
                        )}
                        {!editing && disc?.ok && (
                            <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                                <input type="checkbox" className="mt-0.5" checked={quality} onChange={e => setQuality(e.target.checked)} />
                                <span><b>Run the quality test after adding</b> (recommended) — 16 real KubeEZ cases; a weak model is flagged before people rely on it. {offline ? 'On a CPU model this takes a while; it runs in the background.' : 'About a minute.'}</span>
                            </label>
                        )}
                        {disc?.models?.length > 0 && f.model && (() => { const m = disc.models.find(x => x.id === f.model); return m && !m.recommended && !m.large ? <p className="text-[11px] text-slate-500 flex items-center gap-1"><Zap className="w-3 h-3" />Small or unknown models can give weak answers — the quality test will tell.</p> : m?.recommended ? <p className="text-[11px] text-emerald-300/80 flex items-center gap-1"><Star className="w-3 h-3" />A good choice for KubeEZ.</p> : null })()}

                        <div className="flex justify-end gap-2 pt-1">
                            <button type="button" onClick={onClose} className="kz-btn-ghost">Cancel</button>
                            <button type="submit" disabled={!canSave || saving} className="kz-btn-primary">{saving && <Loader2 className="w-4 h-4 animate-spin" />}{editing ? 'Save' : 'Connect'}</button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    )
}
