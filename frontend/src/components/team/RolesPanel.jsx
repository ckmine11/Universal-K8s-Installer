import { useState } from 'react'
import { Plus, Pencil, Trash2, Lock, Copy, Users, ShieldCheck, Layers, Tag, Sparkles, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import SpotlightCard from '../ui/Spotlight'
import RoleEditor, { KUBE_INFO } from './RoleEditor'

// Roles tab of Team & Roles: how it works, the built-in roles, the custom ones.
export default function RolesPanel({ meta, onChanged }) {
    const { toast } = useToast()
    const [editing, setEditing] = useState(null)   // null | 'new' | role | { copyOf }
    const [deleting, setDeleting] = useState(null)

    const del = async (r) => {
        if (!window.confirm(`Delete the role "${r.name}"?`)) return
        setDeleting(r.id)
        try {
            const res = await apiFetch(`/api/roles/${r.id}`, { method: 'DELETE' })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not delete the role')
            toast({ title: 'Role deleted', message: d.message, type: 'success' }); onChanged()
        } catch (e) { toast({ title: 'Role still in use', message: e.message, type: 'error' }) } finally { setDeleting(null) }
    }

    return (
        <div className="space-y-6">
            {/* how it works */}
            <div className="grid md:grid-cols-3 gap-3">
                {[
                    [ShieldCheck, '1 · Make a role', 'Tick what it may do, and how much it may do inside the cluster. Start from a template like On-call or Auditor.'],
                    [Users, '2 · Give it to a member', 'Members → the role menu on their card. It applies to every cluster.'],
                    [Layers, '3 · Different on some clusters', 'Members → Cluster access: e.g. Operator on staging, Viewer on everything labelled env=prod, no access to finance.']
                ].map(([Icon, t, d]) => (
                    <div key={t} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
                        <div className="flex items-center gap-2 text-sm font-semibold text-white"><Icon className="w-4 h-4 text-blue-300" />{t}</div>
                        <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">{d}</p>
                    </div>
                ))}
            </div>

            {!meta.allowed && (
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-blue-400/25 bg-blue-500/[0.06] p-4">
                    <Sparkles className="w-5 h-5 text-blue-300" />
                    <p className="text-sm text-slate-200 flex-1 min-w-[240px]">Custom roles and per-cluster access are part of <b>Pro</b>. On Free, use Admin, Operator and Viewer.</p>
                    <Link to="/pricing" className="kz-btn-primary !py-2">See plans</Link>
                </div>
            )}

            <div className="flex items-end justify-between gap-3">
                <div>
                    <h3 className="text-lg font-semibold text-white">Custom roles</h3>
                    <p className="text-xs text-slate-400">{meta.custom.length ? `${meta.custom.length} role${meta.custom.length > 1 ? 's' : ''} in this workspace` : 'None yet — start from a template.'}</p>
                </div>
                <button onClick={() => setEditing('new')} disabled={!meta.allowed} className="kz-btn-primary"><Plus className="w-4 h-4" /> New role</button>
            </div>

            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
                {meta.custom.map(r => (
                    <SpotlightCard key={r.id} className="p-5">
                        <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="font-semibold text-white truncate">{r.name}</div>
                                <p className="mt-0.5 text-xs text-slate-400 line-clamp-2 min-h-[2rem]">{r.description || '—'}</p>
                            </div>
                            <button onClick={() => setEditing(r)} disabled={!meta.allowed} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label={`Edit ${r.name}`}><Pencil className="w-4 h-4" /></button>
                            <button onClick={() => del(r)} disabled={deleting === r.id} className="p-2 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/10" aria-label={`Delete ${r.name}`}>{deleting === r.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}</button>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                            <span className="kz-chip text-slate-300">{r.permissions.length} permissions</span>
                            <span className="kz-chip text-slate-300">Kubernetes: {KUBE_INFO[r.kube]?.label}</span>
                        </div>
                        <div className="mt-3 pt-3 border-t border-white/[0.06] text-[11px] text-slate-400 flex items-center gap-1.5">
                            <Users className="w-3.5 h-3.5" />
                            {r.members.length ? r.members.join(', ') : 'Nobody has it yet'}
                            {!!r.inClusterRules.length && <span className="ml-auto flex items-center gap-1 text-sky-300/80"><Tag className="w-3 h-3" />in {r.inClusterRules.length} cluster rule{r.inClusterRules.length > 1 ? 's' : ''}</span>}
                        </div>
                    </SpotlightCard>
                ))}
            </div>

            <div>
                <h3 className="text-lg font-semibold text-white">Built-in roles</h3>
                <p className="text-xs text-slate-400 mb-3">Fixed. Duplicate one to make a variant.</p>
                <div className="grid md:grid-cols-3 gap-4">
                    {meta.builtin.map(b => (
                        <div key={b.key} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
                            <div className="flex items-center gap-2">
                                <span className="font-semibold text-white">{b.name}</span>
                                <Lock className="w-3.5 h-3.5 text-slate-500" />
                                {b.key !== 'admin' && <button onClick={() => setEditing({ copyOf: b })} disabled={!meta.allowed} className="ml-auto inline-flex items-center gap-1 text-[11px] text-blue-300 hover:text-white disabled:opacity-40"><Copy className="w-3.5 h-3.5" /> Duplicate</button>}
                            </div>
                            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">{b.description}</p>
                            <div className="mt-3 text-[11px] text-slate-500">{b.members.length} member{b.members.length === 1 ? '' : 's'} · Kubernetes: {KUBE_INFO[b.kube]?.label}</div>
                        </div>
                    ))}
                </div>
            </div>

            {editing && (
                <RoleEditor meta={meta}
                    role={editing === 'new' ? null : editing.copyOf ? null : editing}
                    key={editing === 'new' ? 'new' : editing.copyOf ? `copy-${editing.copyOf.key}` : editing.id}
                    onClose={() => setEditing(null)}
                    onSaved={() => { setEditing(null); onChanged() }}
                    initial={editing.copyOf ? { name: `${editing.copyOf.name} (copy)`, description: editing.copyOf.description, permissions: editing.copyOf.permissions, kube: editing.copyOf.kube } : null} />
            )}
        </div>
    )
}
