import { useState, useEffect } from 'react'
import { Loader2, ShieldCheck, Eye, Play, Undo2, CheckCircle2, XCircle, AlertTriangle, Boxes, FileCode2 } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { kubeLevel } from '../../config/permissions'
import { useToast } from '../ToastProvider'

// YAML in an AI answer → applied from the chat, safely: Check & fix (KubeEZ's
// rules, random passwords for placeholders) → Dry-run on the cluster (diff) →
// Apply (with the workspace's approvals) → Undo. Nothing runs without a click.
export const yamlBlocksOf = (text) => [...String(text || '').matchAll(/```(?:ya?ml)?\s*\n([\s\S]*?)```/gi)]
    .map(m => m[1].trim()).filter(y => /^\s*apiVersion:/m.test(y) && /^\s*kind:/m.test(y))

async function post(url, body) {
    const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(d.error || 'Request failed'), { data: d, status: res.status })
    return d
}

export default function ChatYaml({ yaml: initial, question }) {
    const { user } = useAuth()
    const { toast } = useToast()
    const [clusters, setClusters] = useState(null)
    const [clusterId, setClusterId] = useState('')
    const [ns, setNs] = useState(() => (/^\s*namespace:\s*([a-z0-9-]+)/m.exec(initial) || [])[1] || 'default')
    const [yaml, setYaml] = useState(initial)
    const [checked, setChecked] = useState(null)
    const [preview, setPreview] = useState(null)
    const [done, setDone] = useState(null)
    const [busy, setBusy] = useState(null)
    const [error, setError] = useState(null)
    useEffect(() => { apiFetch('/api/clusters/list').then(r => r.ok ? r.json() : []).then(l => { const ok = (Array.isArray(l) ? l : []).filter(c => c.status !== 'failed'); setClusters(ok); if (ok.length === 1) setClusterId(ok[0].id) }).catch(() => setClusters([])) }, [])
    const canEdit = clusterId && ['edit', 'admin'].includes(kubeLevel(user?.role, clusterId))

    const run = async (what, fn) => { setBusy(what); setError(null); try { await fn() } catch (e) { if (!/approval/i.test(e.message)) setError(e.message); else toast({ title: 'Waiting for approval', message: e.message, type: 'info' }) } finally { setBusy(null) } }
    const check = () => run('check', async () => { const r = await post('/api/ai/check-yaml', { yaml, namespace: ns, fix: true }); setYaml(r.yaml); setChecked(r); setPreview(null) })
    const dryRun = () => run('dry', async () => { try { const p = await post(`/api/clusters/${clusterId}/ai-manifests/preview`, { yaml, namespace: ns }); setPreview(p); setChecked(p) } catch (e) { if (e.data?.problems) setChecked({ problems: e.data.problems, blocked: true }); throw e } })
    const apply = () => run('apply', async () => { const r = await post(`/api/clusters/${clusterId}/ai-manifests`, { yaml, namespace: ns, description: `Ask AI: ${String(question || '').slice(0, 120)}` }); setDone(r); toast({ title: 'Applied', message: `Created: ${r.created.join(', ') || '—'} · Changed: ${r.changed.join(', ') || '—'}`, type: 'success' }) })
    const undo = () => run('undo', async () => { if (!window.confirm(`Undo this apply?\n\nDeletes: ${done.created.join(', ') || '—'}\nPuts back: ${done.changed.join(', ') || '—'}`)) return; const r = await post(`/api/clusters/${clusterId}/ai-manifests/${done.id}/undo`); setDone({ ...r, undone: true }); toast({ title: 'Undone', type: 'success' }) })

    const blocks = (checked?.problems || []).filter(p => p.level === 'block')
    return (
        <div className="mt-3 rounded-xl border border-violet-400/25 bg-violet-500/[0.05] p-3 space-y-2.5 whitespace-normal">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-violet-200"><FileCode2 className="w-3.5 h-3.5" /> Use this YAML</p>
            {clusters && !clusters.length && <p className="text-[11px] text-slate-400">No cluster to apply it to — check it here, then copy it.</p>}
            {clusters && !done && (
                <div className="flex flex-wrap items-end gap-2">
                    {clusters.length > 1 && (
                        <select className="kz-input !w-auto !py-1 !text-xs" value={clusterId} onChange={e => { setClusterId(e.target.value); setPreview(null) }} aria-label="Cluster">
                            <option value="">Cluster…</option>
                            {clusters.map(c => <option key={c.id} value={c.id}>{c.clusterName}</option>)}
                        </select>
                    )}
                    {clusters.length > 0 && <input className="kz-input !w-36 !py-1 !text-xs font-mono" value={ns} onChange={e => { setNs(e.target.value.trim()); setPreview(null) }} aria-label="Namespace" title="Namespace" />}
                    <button onClick={check} disabled={!!busy} className="kz-btn-ghost !py-1 !text-xs">{busy === 'check' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />} Check & fix</button>
                    {clusters.length > 0 && <button onClick={dryRun} disabled={!!busy || !clusterId || !canEdit || !checked || checked.blocked} className="kz-btn-ghost !py-1 !text-xs" title={!checked ? 'Check it first' : !canEdit && clusterId ? 'Needs Kubernetes edit access on this cluster' : ''}>{busy === 'dry' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Dry-run</button>}
                    {preview?.ok && <button onClick={apply} disabled={!!busy} className="kz-btn-primary !py-1 !text-xs">{busy === 'apply' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Apply</button>}
                </div>
            )}
            {clusterId && !canEdit && clusters?.length > 0 && <p className="text-[11px] text-slate-500">Applying needs Kubernetes edit access on this cluster.</p>}
            {checked && (
                <div className="space-y-1 text-[11px]">
                    {checked.objects?.length > 0 && <p className="flex flex-wrap items-center gap-1 text-slate-300"><Boxes className="w-3.5 h-3.5 text-blue-300" />{checked.objects.map((o, i) => <span key={i} className="kz-chip font-mono">{o.kind} {o.name}</span>)}<span className="text-slate-500">in {ns}</span></p>}
                    {checked.fixes?.length > 0 && <p className="text-slate-400">KubeEZ fixed {checked.fixes.length} thing(s): {checked.fixes.slice(0, 4).join(' · ')}{checked.fixes.length > 4 ? ' …' : ''}</p>}
                    {blocks.map((p, i) => <p key={i} className="flex items-start gap-1 text-red-300"><XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span><b>{p.object}</b> — {p.text}</span></p>)}
                    {!blocks.length && <p className="flex items-center gap-1 text-emerald-300"><CheckCircle2 className="w-3.5 h-3.5" /> Passes KubeEZ's checks{(checked.problems || []).length ? ` (${checked.problems.length} warning${checked.problems.length > 1 ? 's' : ''})` : ''}</p>}
                </div>
            )}
            {preview && <p className={`flex items-center gap-1 text-[11px] ${preview.ok ? 'text-emerald-300' : 'text-red-300'}`}>{preview.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} Dry-run {preview.ok ? 'passed' : `failed: ${String(preview.dryRun || '').slice(0, 200)}`}{preview.ok && (preview.existing?.length ? ` — changes: ${preview.existing.join(', ')}` : ' — everything is new')}</p>}
            {done && (
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className={done.undone ? 'text-slate-400' : 'text-emerald-300'}>{done.undone ? 'Undone.' : `Applied — created ${done.created.join(', ') || '—'}${done.changed.length ? `, changed ${done.changed.join(', ')}` : ''}`}</span>
                    {!done.undone && done.canUndo && <button onClick={undo} disabled={!!busy} className="kz-btn-ghost !py-1 !text-xs">{busy === 'undo' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Undo</button>}
                </div>
            )}
            {error && <p className="flex items-start gap-1 text-[11px] text-red-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</p>}
        </div>
    )
}
