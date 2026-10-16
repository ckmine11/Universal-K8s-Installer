import { useState } from 'react'
import { Tag, Plus, X, Loader2, Check } from 'lucide-react'
import { apiFetch } from '../context/AuthContext'
import { useToast } from './ToastProvider'

// Cluster labels (env=prod, team=payments). Access rules in Team & Roles can
// give members a role on "every cluster labelled env=prod". Admins edit.
const OK = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i

export default function ClusterLabels({ cluster, canEdit, onSaved }) {
    const { toast } = useToast()
    const labels = cluster.labels || {}
    const [adding, setAdding] = useState(false)
    const [k, setK] = useState('env')
    const [v, setV] = useState('')
    const [busy, setBusy] = useState(false)

    const save = async (next) => {
        setBusy(true)
        try {
            const r = await apiFetch(`/api/clusters/${cluster.id}/labels`, { method: 'PUT', body: JSON.stringify({ labels: next }) })
            const d = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(d.error || 'Could not save the labels')
            onSaved?.(d.labels || {})
            setAdding(false); setV('')
        } catch (e) { toast({ title: 'Labels', message: e.message, type: 'error' }) }
        finally { setBusy(false) }
    }
    const add = (e) => {
        e.preventDefault()
        const key = k.trim().toLowerCase(), value = v.trim().toLowerCase()
        if (!OK.test(key) || !OK.test(value)) return toast({ title: 'Labels', message: 'Use letters, numbers, ".", "_" or "-" — e.g. env = prod', type: 'error' })
        save({ ...labels, [key]: value })
    }
    const remove = (key) => { const next = { ...labels }; delete next[key]; save(next) }

    const entries = Object.entries(labels)
    if (!entries.length && !canEdit) return null
    return (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Tag className="w-3.5 h-3.5 text-slate-500" />
            {entries.map(([key, value]) => (
                <span key={key} className="inline-flex items-center gap-1 rounded-full border border-blue-400/25 bg-blue-500/10 px-2.5 py-0.5 text-[11px] font-mono text-blue-100">
                    {key}={value}
                    {canEdit && <button onClick={() => remove(key)} disabled={busy} className="text-blue-200/60 hover:text-white" aria-label={`Remove ${key}`}><X className="w-3 h-3" /></button>}
                </span>
            ))}
            {canEdit && !adding && (
                <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 rounded-full border border-dashed border-white/15 px-2.5 py-0.5 text-[11px] text-slate-400 hover:text-white hover:border-white/30"
                    title="Labels group clusters for access rules, e.g. env=prod">
                    <Plus className="w-3 h-3" /> {entries.length ? 'Label' : 'Add a label (e.g. env=prod)'}
                </button>
            )}
            {canEdit && adding && (
                <form onSubmit={add} className="inline-flex items-center gap-1">
                    <input value={k} onChange={e => setK(e.target.value)} placeholder="key" aria-label="Label key" autoComplete="off" spellCheck={false}
                        className="w-20 rounded-lg bg-black/40 border border-white/10 px-2 py-0.5 text-[11px] font-mono text-white" />
                    <span className="text-slate-500 text-xs">=</span>
                    <input value={v} onChange={e => setV(e.target.value)} placeholder="value" aria-label="Label value" autoComplete="off" spellCheck={false} autoFocus
                        className="w-24 rounded-lg bg-black/40 border border-white/10 px-2 py-0.5 text-[11px] font-mono text-white" />
                    <button type="submit" disabled={busy} className="p-1 rounded-md text-emerald-300 hover:bg-white/5" aria-label="Save label">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}</button>
                    <button type="button" onClick={() => setAdding(false)} className="p-1 rounded-md text-slate-400 hover:bg-white/5" aria-label="Cancel"><X className="w-3.5 h-3.5" /></button>
                </form>
            )}
        </div>
    )
}
