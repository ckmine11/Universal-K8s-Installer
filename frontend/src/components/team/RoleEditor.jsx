import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Lock, Check, Layers, Sparkles, ShieldCheck, Info } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import useBackdropClose from '../ui/useBackdropClose'

// The role builder: a name, the permissions (grouped, explained), and what the
// role may do INSIDE the cluster (Kubernetes access through the Explorer).
export const KUBE_INFO = {
    none: { label: 'None', desc: 'No Explorer, nothing inside the cluster.' },
    view: { label: 'View', desc: 'Read everything inside the cluster (no Secrets values).' },
    edit: { label: 'Edit', desc: 'Change workloads: deploy, scale, restart, edit — not RBAC.' },
    admin: { label: 'Full', desc: 'Everything inside the cluster (cluster-admin).' }
}

export default function RoleEditor({ meta, role, initial, onClose, onSaved }) {
    const { toast } = useToast()
    const backdrop = useBackdropClose(onClose)
    const editing = !!role
    const from = role || initial
    const adminOnly = new Set(meta.groups.flatMap(g => g.items).filter(i => i.adminOnly).map(i => i.key))
    const [name, setName] = useState(from?.name || '')
    const [description, setDescription] = useState(from?.description || '')
    const [perms, setPerms] = useState(new Set((from?.permissions || ['cluster:view']).filter(p => !adminOnly.has(p))))
    const [kube, setKube] = useState(from?.kube || 'view')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const starts = useMemo(() => [
        ...meta.templates.map(t => ({ key: `t:${t.key}`, name: t.name, description: t.description, permissions: t.permissions, kube: t.kube })),
        ...meta.builtin.filter(b => b.key !== 'admin').map(b => ({ key: `b:${b.key}`, name: `Copy of ${b.name}`, description: b.description, permissions: b.permissions.filter(p => meta.groups.some(g => g.items.some(i => i.key === p && !i.adminOnly))), kube: b.kube }))
    ], [meta])
    const startFrom = (key) => {
        const s = starts.find(x => x.key === key); if (!s) return
        if (!name || starts.some(x => x.name === name)) setName(s.name)
        setDescription(s.description); setPerms(new Set(s.permissions)); setKube(s.kube); setError('')
    }

    const toggle = (key) => setPerms(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n })
    const toggleGroup = (items, on) => setPerms(p => { const n = new Set(p); for (const i of items) if (!i.adminOnly) on ? n.add(i.key) : n.delete(i.key); return n })
    const noView = !perms.has('cluster:view')

    const save = async (e) => {
        e.preventDefault(); setError('')
        if (name.trim().length < 2) return setError('Give the role a name (2–40 characters).')
        if (!perms.size) return setError('Pick at least one permission.')
        setBusy(true)
        try {
            const r = await apiFetch(editing ? `/api/roles/${role.id}` : '/api/roles', {
                method: editing ? 'PUT' : 'POST',
                body: JSON.stringify({ name: name.trim(), description: description.trim(), permissions: [...perms], kube })
            })
            const d = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(d.error || 'Could not save the role')
            toast({ title: editing ? 'Role updated' : 'Role created', message: editing ? `${d.name}: members with it have the new permissions now.` : `${d.name} — give it to a member under Members.`, type: 'success' })
            onSaved?.(d)
        } catch (err) { setError(err.message) } finally { setBusy(false) }
    }

    return createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" {...backdrop}>
            <form onSubmit={save} onClick={e => e.stopPropagation()} className="kz-card w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden" role="dialog" aria-label={editing ? 'Edit role' : 'New role'}>
                <div className="flex items-center gap-3 px-7 pt-6 pb-4 border-b border-white/[0.06]">
                    <div className="p-2.5 rounded-2xl border border-white/10 bg-[#15151c]"><ShieldCheck className="w-5 h-5 text-blue-300" /></div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-semibold text-white">{editing ? `Edit role · ${role.name}` : 'New role'}</h3>
                        <p className="text-xs text-slate-400">Pick what this role may do. Members get it under Members — on every cluster, or only on some.</p>
                    </div>
                    <button type="button" onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>

                <div className="overflow-y-auto px-7 py-5 grid lg:grid-cols-[1fr_280px] gap-6">
                    <div className="space-y-5 min-w-0">
                        {!editing && (
                            <div>
                                <label className="kz-label flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Start from</label>
                                <div className="flex flex-wrap gap-2">
                                    {starts.map(s => (
                                        <button type="button" key={s.key} onClick={() => startFrom(s.key)}
                                            className="rounded-full border border-white/10 bg-white/[0.03] hover:border-blue-400/40 hover:bg-blue-500/10 px-3 py-1.5 text-xs text-slate-200">{s.name}</button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <div className="grid sm:grid-cols-2 gap-3">
                            <div>
                                <label className="kz-label" htmlFor="role-name">Name</label>
                                <input id="role-name" className="kz-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Prod on-call" maxLength={40} autoComplete="off" autoFocus />
                            </div>
                            <div>
                                <label className="kz-label" htmlFor="role-desc">Description</label>
                                <input id="role-desc" className="kz-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Who is it for?" maxLength={200} autoComplete="off" />
                            </div>
                        </div>

                        {meta.groups.map(g => {
                            const items = g.items
                            const selectable = items.filter(i => !i.adminOnly)
                            const all = selectable.length && selectable.every(i => perms.has(i.key))
                            return (
                                <div key={g.group} className="rounded-2xl border border-white/[0.07] bg-black/20">
                                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.05]">
                                        <span className="text-sm font-semibold text-white">{g.group}</span>
                                        {!!selectable.length && <button type="button" onClick={() => toggleGroup(items, !all)} className="text-[11px] text-blue-300 hover:text-white">{all ? 'Clear' : 'Select all'}</button>}
                                    </div>
                                    <div className="grid sm:grid-cols-2 gap-x-4">
                                        {items.map(i => (
                                            <label key={i.key} className={`flex items-start gap-3 px-4 py-2.5 ${i.adminOnly ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-white/[0.02]'}`}
                                                title={i.adminOnly ? 'Admins only — running the workspace stays with Admins' : ''}>
                                                <input type="checkbox" className="mt-0.5 w-4 h-4" disabled={i.adminOnly} checked={perms.has(i.key)} onChange={() => toggle(i.key)} />
                                                <span className="min-w-0">
                                                    <span className="block text-[13px] text-slate-200 leading-snug">{i.label}</span>
                                                    <span className="mt-0.5 flex gap-1.5">
                                                        {i.perCluster && <span className="inline-flex items-center gap-1 text-[10px] text-sky-300/90"><Layers className="w-3 h-3" /> per cluster</span>}
                                                        {i.adminOnly && <span className="inline-flex items-center gap-1 text-[10px] text-amber-300/90"><Lock className="w-3 h-3" /> Admins only</span>}
                                                    </span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )
                        })}

                        <div className="rounded-2xl border border-white/[0.07] bg-black/20 p-4">
                            <div className="text-sm font-semibold text-white">Inside the cluster (Kubernetes access)</div>
                            <p className="text-[11px] text-slate-400 mt-0.5">What the KubeEZ Explorer lets this role do in the cluster itself.</p>
                            <div className="mt-3 grid sm:grid-cols-4 gap-2">
                                {meta.kubeLevels.map(l => (
                                    <button type="button" key={l} onClick={() => setKube(l)}
                                        className={`text-left rounded-xl border p-3 transition ${kube === l ? 'border-blue-400/60 bg-blue-500/10' : 'border-white/10 bg-white/[0.02] hover:border-white/20'}`}>
                                        <div className="text-sm font-semibold text-white flex items-center gap-1.5">{kube === l && <Check className="w-3.5 h-3.5 text-blue-300" />}{KUBE_INFO[l].label}</div>
                                        <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">{KUBE_INFO[l].desc}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* summary */}
                    <aside className="lg:sticky lg:top-0 self-start rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-sm">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Summary</div>
                        <div className="mt-2 text-lg font-semibold text-white truncate">{name || 'Unnamed role'}</div>
                        <div className="mt-1 text-slate-400 text-xs">{perms.size} permission{perms.size === 1 ? '' : 's'} · Kubernetes: {KUBE_INFO[kube].label}</div>
                        <ul className="mt-3 space-y-1.5 max-h-64 overflow-y-auto">
                            {meta.groups.flatMap(g => g.items).filter(i => perms.has(i.key)).map(i => (
                                <li key={i.key} className="flex items-start gap-2 text-[12px] text-slate-300"><Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />{i.label}</li>
                            ))}
                        </ul>
                        {noView && (
                            <p className="mt-3 flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-2.5 text-[11px] text-amber-200"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />Without “View clusters & health” this role sees no clusters at all.</p>
                        )}
                        <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">Team and billing always stay with Admins. Members with this role are updated the moment you save.</p>
                    </aside>
                </div>

                <div className="flex items-center gap-3 px-7 py-4 border-t border-white/[0.06]">
                    {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2" role="alert">{error}</p>}
                    <button type="button" onClick={onClose} className="ml-auto kz-btn-ghost">Cancel</button>
                    <button type="submit" disabled={busy} className="kz-btn-primary">{busy && <Loader2 className="w-4 h-4 animate-spin" />}{editing ? 'Save changes' : 'Create role'}</button>
                </div>
            </form>
        </div>
    , document.body)
}
