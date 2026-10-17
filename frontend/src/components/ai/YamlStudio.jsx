import { useState, useEffect, useCallback } from 'react'
import { Wand2, Loader2, ShieldCheck, Eye, Play, Undo2, AlertTriangle, XCircle, CheckCircle2, Copy, History } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import { aiJob } from './aiJob'
import Feedback from './Feedback'

// Cluster → Create: describe what you want, KubeEZ AI writes the YAML, KubeEZ
// checks it, dry-runs it on the cluster and shows the diff; Apply can be undone.
const EXAMPLES = [
    'nginx 1.27 with 2 replicas, 64Mi memory, a service on port 80',
    'redis 7 with a 1Gi volume, only reachable inside the namespace',
    'a cronjob that runs busybox every night at 2am and prints the date'
]
async function call(url, body) {
    const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(d.error || 'Request failed'), { data: d })
    return d
}

function Problems({ list }) {
    if (!list?.length) return <p className="flex items-center gap-1.5 text-xs text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> All checks passed</p>
    return (
        <ul className="space-y-1">
            {list.map((p, i) => (
                <li key={i} className={`flex items-start gap-1.5 text-xs ${p.level === 'block' ? 'text-red-300' : 'text-amber-200'}`}>
                    {p.level === 'block' ? <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
                    <span><b>{p.object}</b> — {p.text}</span>
                </li>
            ))}
        </ul>
    )
}

export default function YamlStudio({ clusterId, canEdit }) {
    const { toast } = useToast()
    const [desc, setDesc] = useState('')
    const [ns, setNs] = useState('default')
    const [busy, setBusy] = useState(null)       // 'gen' | 'check' | 'preview' | 'apply'
    const [yaml, setYaml] = useState('')
    const [checked, setChecked] = useState(null) // { problems, blocked, objects }
    const [engine, setEngine] = useState(null)
    const [preview, setPreview] = useState(null)
    const [history, setHistory] = useState([])
    const [error, setError] = useState(null)

    const loadHistory = useCallback(() => apiFetch(`/api/clusters/${clusterId}/ai-manifests`).then(r => r.ok ? r.json() : { applied: [] }).then(d => setHistory(d.applied || [])).catch(() => { }), [clusterId])
    useEffect(() => { loadHistory() }, [loadHistory])

    const generate = async () => {
        setBusy('gen'); setError(null); setPreview(null)
        const { ok, data } = await aiJob('/api/ai/generate-yaml', { clusterId, namespace: ns, description: desc })
        setBusy(null)
        if (!ok) return setError(data.error)
        setYaml(data.yaml); setChecked(data); setEngine(data.engine)
    }
    const check = async () => {
        setBusy('check'); setError(null); setPreview(null)
        try { setChecked(await call('/api/ai/check-yaml', { yaml, namespace: ns })) } catch (e) { setError(e.message) } finally { setBusy(null) }
    }
    const doPreview = async () => {
        setBusy('preview'); setError(null)
        try { const p = await call(`/api/clusters/${clusterId}/ai-manifests/preview`, { yaml, namespace: ns }); setPreview(p); setChecked(p) }
        catch (e) { setError(e.message); if (e.data?.problems) setChecked({ problems: e.data.problems, blocked: true }) } finally { setBusy(null) }
    }
    const apply = async () => {
        setBusy('apply'); setError(null)
        try {
            const r = await call(`/api/clusters/${clusterId}/ai-manifests`, { yaml, namespace: ns, description: desc })
            toast({ title: 'Applied', message: `Created: ${r.created.join(', ') || '—'} · Changed: ${r.changed.join(', ') || '—'}`, type: 'success' })
            setPreview(null); loadHistory()
        } catch (e) { if (!/approval/i.test(e.message)) setError(e.message) } finally { setBusy(null) }
    }
    const undo = async (m) => {
        if (!window.confirm(`Undo this apply?\n\nDeletes: ${m.created.join(', ') || '—'}\nPuts back: ${m.changed.join(', ') || '—'}`)) return
        try { await call(`/api/clusters/${clusterId}/ai-manifests/${m.id}/undo`); toast({ title: 'Undone', type: 'success' }); loadHistory() }
        catch (e) { toast({ title: 'Undo failed', message: e.message, type: 'error' }) }
    }

    return (
        <div className="space-y-5">
            <div className="kz-card p-5 space-y-4">
                <div className="flex items-start gap-3">
                    <Wand2 className="w-5 h-5 text-violet-300 mt-0.5" />
                    <div>
                        <h3 className="text-base font-semibold text-white">Create from a description</h3>
                        <p className="text-xs text-slate-400">Describe what you want — KubeEZ AI writes the YAML, KubeEZ checks it (no privileged or host access, limits, pinned images), dry-runs it on this cluster and shows the diff. Apply can be undone for 24 hours.</p>
                    </div>
                </div>
                <textarea className="kz-input min-h-[70px]" value={desc} onChange={e => setDesc(e.target.value)} maxLength={2000} placeholder={EXAMPLES[0]} aria-label="What do you want to create?" />
                <div className="flex flex-wrap gap-1.5">{EXAMPLES.map(x => <button key={x} onClick={() => setDesc(x)} className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-400 hover:text-white">{x}</button>)}</div>
                <div className="flex flex-wrap items-end gap-3">
                    <div>
                        <label className="kz-label" htmlFor="yaml-ns">Namespace</label>
                        <input id="yaml-ns" className="kz-input !w-48 font-mono" value={ns} onChange={e => setNs(e.target.value.trim())} />
                    </div>
                    <button onClick={generate} disabled={!!busy || desc.trim().length < 8} className="kz-btn-primary">{busy === 'gen' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Write YAML</button>
                    {busy === 'gen' && <span className="text-xs text-slate-500">A local model on CPU can take a minute…</span>}
                </div>
                {error && <p className="flex items-start gap-1.5 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</p>}
            </div>

            {yaml && (
                <div className="kz-card p-5 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-white flex-1">YAML <span className="text-xs font-normal text-slate-500">— edit it if you like, then check again</span></h3>
                        <button onClick={() => { navigator.clipboard?.writeText(yaml); toast({ title: 'Copied', type: 'success' }) }} className="kz-btn-ghost !py-1.5 !text-xs"><Copy className="w-3.5 h-3.5" /> Copy</button>
                    </div>
                    <textarea className="kz-input font-mono !text-[12px] min-h-[280px] leading-relaxed" value={yaml} onChange={e => { setYaml(e.target.value); setPreview(null) }} spellCheck={false} aria-label="YAML" />
                    <Problems list={checked?.problems} />
                    {engine && <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-500"><span>{engine.provider} · {engine.model}</span><Feedback traceId={engine.traceId} /></div>}
                    <div className="flex flex-wrap gap-2">
                        <button onClick={check} disabled={!!busy} className="kz-btn-ghost !py-2">{busy === 'check' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Check</button>
                        <button onClick={doPreview} disabled={!!busy || !canEdit || checked?.blocked} className="kz-btn-ghost !py-2" title={!canEdit ? 'Needs Kubernetes edit access on this cluster' : ''}>{busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} Dry-run on the cluster</button>
                        {preview?.ok && <button onClick={apply} disabled={!!busy} className="kz-btn-primary !py-2">{busy === 'apply' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Apply</button>}
                    </div>
                    {!canEdit && <p className="text-[11px] text-slate-500">You can check and copy the YAML; applying needs Kubernetes edit access on this cluster.</p>}
                    {preview && (
                        <div className="space-y-2">
                            <p className={`flex items-center gap-1.5 text-xs ${preview.ok ? 'text-emerald-300' : 'text-red-300'}`}>{preview.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} Dry-run on the cluster {preview.ok ? 'passed' : 'failed'}{preview.existing?.length ? ` — changes existing: ${preview.existing.join(', ')}` : ' — everything is new'}</p>
                            <pre className="max-h-40 overflow-auto rounded-xl border border-white/[0.07] bg-black/40 p-3 text-[11px] text-slate-300 whitespace-pre-wrap">{preview.dryRun}</pre>
                            {preview.diff && <pre className="max-h-72 overflow-auto rounded-xl border border-white/[0.07] bg-black/40 p-3 text-[11px] whitespace-pre-wrap">{preview.diff.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') ? 'text-emerald-300' : l.startsWith('-') ? 'text-red-300' : 'text-slate-500'}>{l}{'\n'}</span>)}</pre>}
                        </div>
                    )}
                </div>
            )}

            {history.length > 0 && (
                <div className="kz-card p-5 space-y-3">
                    <h3 className="flex items-center gap-2 text-base font-semibold text-white"><History className="w-4 h-4 text-blue-300" /> Applied from here</h3>
                    <ul className="space-y-2">
                        {history.map(m => (
                            <li key={m.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-xs">
                                <div className="flex-1 min-w-[220px]">
                                    <p className="text-slate-200">{m.description || 'YAML'} {m.status === 'undone' && <span className="kz-chip !text-slate-400 ml-1">undone by {m.undoneBy}</span>}</p>
                                    <p className="text-slate-500">{new Date(m.at).toLocaleString()} · {m.by} · created {m.created.join(', ') || '—'} · changed {m.changed.join(', ') || '—'}</p>
                                </div>
                                {m.canUndo && canEdit && <button onClick={() => undo(m)} className="kz-btn-ghost !py-1.5 !text-xs"><Undo2 className="w-3.5 h-3.5" /> Undo</button>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}
