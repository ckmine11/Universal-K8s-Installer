import { useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Plus, Trash2, Server, Tag, Layers, ArrowRight, EyeOff, Boxes } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import useBackdropClose from '../ui/useBackdropClose'

// A member's access per cluster: their main role applies everywhere, unless a
// rule here says otherwise — for one cluster, or for every cluster with a label.
// The preview shows the result on each cluster before saving.
const OK = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i

export default function ClusterAccessDialog({ member, roleOptions, clusters, onClose, onSaved }) {
    const { toast } = useToast()
    const backdrop = useBackdropClose(onClose)
    const [rules, setRules] = useState(() => (member.clusterAccess || []).map((r, i) => ({ ...r, _k: i, nsText: (r.namespaces || []).join(', ') })))
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const nameOf = (key) => key === 'none' ? 'No access' : roleOptions.find(r => r.key === key)?.name || key
    const labelKeys = useMemo(() => [...new Set(clusters.flatMap(c => Object.keys(c.labels || {})))], [clusters])

    const add = (type) => setRules(r => [...r, type === 'cluster'
        ? { _k: Date.now(), type, clusterId: clusters.find(c => !r.some(x => x.type === 'cluster' && x.clusterId === c.id))?.id || clusters[0]?.id || '', role: 'viewer' }
        : { _k: Date.now(), type, key: labelKeys[0] || 'env', value: 'prod', role: 'viewer' }])
    const update = (k, patch) => setRules(r => r.map(x => x._k === k ? { ...x, ...patch } : x))
    const remove = (k) => setRules(r => r.filter(x => x._k !== k))

    // the same rule as the server: exact cluster rule → label rules → main role
    const preview = useMemo(() => clusters.map(c => {
        const exact = rules.find(r => r.type === 'cluster' && r.clusterId === c.id)
        if (exact) return { c, access: nameOf(exact.role) + (exact.role !== 'none' && exact.nsText?.trim() ? ` · ${exact.nsText.trim()}` : ''), via: 'this cluster', none: exact.role === 'none' }
        const byLabel = rules.filter(r => r.type === 'label' && (c.labels || {})[String(r.key).toLowerCase()] === String(r.value).toLowerCase())
        if (byLabel.length) {
            const real = byLabel.filter(r => r.role !== 'none')
            const limited = real.length && real.every(r => r.nsText?.trim())
            return { c, access: (real.length ? real.map(r => nameOf(r.role)).join(' + ') : 'No access') + (limited ? ` · ${[...new Set(real.flatMap(r => r.nsText.split(',').map(x => x.trim()).filter(Boolean)))].join(', ')}` : ''), via: byLabel.map(r => `${r.key}=${r.value}`).join(', '), none: !real.length }
        }
        return { c, access: member.roleName, via: 'main role', none: false }
    }), [rules, clusters, member])

    const save = async () => {
        setError('')
        for (const r of rules) if (r.type === 'label' && (!OK.test(r.key) || !OK.test(r.value))) return setError(`Label rule "${r.key}=${r.value}": letters, numbers, ".", "_" and "-" only`)
        setBusy(true)
        try {
            const nsOf = (r) => r.role !== 'none' && r.nsText?.trim() ? { namespaces: r.nsText.split(',').map(x => x.trim()).filter(Boolean) } : {}
            const body = { rules: rules.map(({ _k, ...r }) => r.type === 'cluster' ? { type: 'cluster', clusterId: r.clusterId, role: r.role, ...nsOf(r) } : { type: 'label', key: r.key.trim(), value: r.value.trim(), role: r.role, ...nsOf(r) }) }
            const res = await apiFetch(`/api/admin/users/${member.id}/cluster-access`, { method: 'PUT', body: JSON.stringify(body) })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not save')
            toast({ title: 'Cluster access saved', message: `${member.username}: applies right away.`, type: 'success' })
            onSaved?.(d.clusterAccess || [])
        } catch (e) { setError(e.message) } finally { setBusy(false) }
    }

    const select = 'bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-white'
    return createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" {...backdrop}>
            <div onClick={e => e.stopPropagation()} className="kz-card w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden" role="dialog" aria-label="Cluster access">
                <div className="flex items-center gap-3 px-7 pt-6 pb-4 border-b border-white/[0.06]">
                    <div className="p-2.5 rounded-2xl border border-white/10 bg-[#15151c]"><Layers className="w-5 h-5 text-blue-300" /></div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-lg font-semibold text-white">Cluster access · {member.username}</h3>
                        <p className="text-xs text-slate-400">Main role <b className="text-slate-200">{member.roleName}</b> applies to every cluster — unless a rule below says otherwise.</p>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>

                <div className="overflow-y-auto px-7 py-5 space-y-5">
                    <div className="space-y-2.5">
                        {rules.length === 0 && <p className="text-sm text-slate-500">No rules — {member.username} has <b className="text-slate-300">{member.roleName}</b> on every cluster.</p>}
                        {rules.map(r => (
                            <div key={r._k} className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.07] bg-black/20 p-3">
                                {r.type === 'cluster' ? (
                                    <>
                                        <Server className="w-4 h-4 text-slate-400" />
                                        <span className="text-sm text-slate-400">On</span>
                                        <select aria-label="Cluster" className={select} value={r.clusterId} onChange={e => update(r._k, { clusterId: e.target.value })}>
                                            {clusters.map(c => <option key={c.id} value={c.id}>{c.clusterName}</option>)}
                                        </select>
                                    </>
                                ) : (
                                    <>
                                        <Tag className="w-4 h-4 text-slate-400" />
                                        <span className="text-sm text-slate-400">Clusters labelled</span>
                                        <input aria-label="Label key" list="kz-label-keys" className={`${select} w-24 font-mono`} value={r.key} onChange={e => update(r._k, { key: e.target.value })} autoComplete="off" spellCheck={false} />
                                        <span className="text-slate-500">=</span>
                                        <input aria-label="Label value" className={`${select} w-28 font-mono`} value={r.value} onChange={e => update(r._k, { value: e.target.value })} autoComplete="off" spellCheck={false} />
                                    </>
                                )}
                                <ArrowRight className="w-4 h-4 text-slate-500" />
                                <select aria-label="Role there" className={select} value={r.role} onChange={e => update(r._k, { role: e.target.value })}>
                                    {roleOptions.filter(o => o.key !== 'admin').map(o => <option key={o.key} value={o.key}>{o.name}</option>)}
                                    <option value="none">No access (hidden)</option>
                                </select>
                                <button onClick={() => remove(r._k)} className="ml-auto p-2 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-500/10" aria-label="Remove rule"><Trash2 className="w-4 h-4" /></button>
                                {r.role !== 'none' && (
                                    <div className="basis-full flex flex-wrap items-center gap-2 pl-6">
                                        <Boxes className="w-4 h-4 text-slate-500" />
                                        <select aria-label="Namespaces" className={`${select} !py-1.5 !text-xs`} value={r.nsText !== undefined && r.nsMode !== 'all' && (r.nsText.trim() || r.nsMode === 'some') ? 'some' : 'all'}
                                            onChange={e => update(r._k, e.target.value === 'all' ? { nsMode: 'all', nsText: '' } : { nsMode: 'some', nsText: r.nsText || '' })}>
                                            <option value="all">All namespaces</option>
                                            <option value="some">Only these namespaces…</option>
                                        </select>
                                        {(r.nsMode === 'some' || r.nsText?.trim()) && (
                                            <input aria-label="Namespace list" className={`${select} !py-1.5 !text-xs font-mono flex-1 min-w-[200px]`} value={r.nsText || ''} placeholder="payments-*, web" autoComplete="off" spellCheck={false}
                                                onChange={e => update(r._k, { nsText: e.target.value, nsMode: 'some' })} />
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                        <datalist id="kz-label-keys">{labelKeys.map(k => <option key={k} value={k} />)}</datalist>
                        <div className="flex flex-wrap gap-2 pt-1">
                            <button onClick={() => add('cluster')} disabled={!clusters.length} className="kz-btn-ghost !py-2 !text-xs"><Plus className="w-3.5 h-3.5" /> Rule for one cluster</button>
                            <button onClick={() => add('label')} className="kz-btn-ghost !py-2 !text-xs"><Plus className="w-3.5 h-3.5" /> Rule for a label (e.g. env=prod)</button>
                        </div>
                        {!labelKeys.length && <p className="text-[11px] text-slate-500">Tip: label clusters on their page (e.g. <span className="font-mono">env=prod</span>) — a label rule then covers new prod clusters automatically.</p>}
                    </div>

                    <div>
                        <div className="kz-label">Result on each cluster</div>
                        <div className="rounded-2xl border border-white/[0.07] overflow-hidden">
                            {preview.length === 0 && <p className="p-4 text-sm text-slate-500">No clusters yet.</p>}
                            {preview.map(({ c, access, via, none }) => (
                                <div key={c.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-white/[0.05] first:border-0 text-sm">
                                    <span className="font-medium text-white min-w-0 truncate">{c.clusterName}</span>
                                    {Object.entries(c.labels || {}).map(([k, v]) => <span key={k} className="hidden sm:inline font-mono text-[10px] text-slate-500">{k}={v}</span>)}
                                    <span className={`ml-auto flex items-center gap-1.5 font-semibold ${none ? 'text-rose-300' : 'text-emerald-300'}`}>{none && <EyeOff className="w-3.5 h-3.5" />}{access}</span>
                                    <span className="w-28 text-right text-[11px] text-slate-500 truncate">{via}</span>
                                </div>
                            ))}
                        </div>
                        <p className="mt-2 text-[11px] text-slate-500">A rule for one cluster wins over label rules; several matching label rules add up. Workspace things (agents, alerts, audit) always follow the main role. “Only these namespaces” is enforced by Kubernetes itself — in the Explorer and in a downloaded kubeconfig; <span className="font-mono">payments-*</span> covers every namespace starting with payments-.</p>
                    </div>
                </div>

                <div className="flex items-center gap-3 px-7 py-4 border-t border-white/[0.06]">
                    {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2" role="alert">{error}</p>}
                    <button onClick={onClose} className="ml-auto kz-btn-ghost">Cancel</button>
                    <button onClick={save} disabled={busy} className="kz-btn-primary">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Save access</button>
                </div>
            </div>
        </div>
    , document.body)
}
