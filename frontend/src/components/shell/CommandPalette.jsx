import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Search, Server, CornerDownLeft, LogOut, Rocket } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// Ctrl/⌘ + K: jump to any page or cluster by typing.
export default function CommandPalette({ open, onClose, sections, onLogout }) {
    const navigate = useNavigate()
    const [q, setQ] = useState('')
    const [clusters, setClusters] = useState([])
    const [sel, setSel] = useState(0)
    const inputRef = useRef(null)
    const listRef = useRef(null)

    useEffect(() => {
        if (!open) return
        setQ(''); setSel(0)
        setTimeout(() => inputRef.current?.focus(), 10)
        apiFetch('/api/clusters/list').then(r => r.ok ? r.json() : []).then(d => setClusters(Array.isArray(d) ? d : [])).catch(() => { })
    }, [open])

    const items = useMemo(() => {
        const pages = sections.flatMap(s => s.items.map(i => ({ kind: 'Pages', label: i.label, hint: s.title, icon: i.icon, run: () => navigate(i.to) })))
        const cl = clusters.map(c => ({
            kind: 'Clusters', label: c.clusterName || c.name || c.id, icon: Server,
            hint: [c.k8sVersion && `v${c.k8sVersion}`, c.status].filter(Boolean).join(' · '),
            run: () => navigate(`/cluster/${c.id}`)
        }))
        const actions = [
            { kind: 'Actions', label: 'Deploy a new cluster', icon: Rocket, run: () => navigate('/install') },
            { kind: 'Actions', label: 'Sign out', icon: LogOut, run: onLogout }
        ]
        const all = [...cl, ...pages, ...actions]
        const t = q.trim().toLowerCase()
        return t ? all.filter(i => `${i.label} ${i.hint || ''}`.toLowerCase().includes(t)) : all
    }, [sections, clusters, q, navigate, onLogout])

    useEffect(() => { setSel(0) }, [q])
    useEffect(() => { listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }) }, [sel])

    if (!open) return null
    const run = (i) => { onClose(); i?.run() }
    const onKey = (e) => {
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)) }
        else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]) }
    }
    let lastKind = null

    return createPortal(
        <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-xl kz-card overflow-hidden kz-rise" onKeyDown={onKey}>
                <div className="flex items-center gap-3 px-4 border-b border-white/[0.07]">
                    <Search className="w-5 h-5 text-blue-300" />
                    <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search clusters, pages, actions…"
                        className="flex-1 !bg-transparent !border-0 !shadow-none py-4 text-base text-white placeholder:text-slate-500 outline-none" />
                    <span className="kz-kbd">Esc</span>
                </div>
                <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-2">
                    {!items.length && <p className="px-3 py-8 text-center text-sm text-slate-500">Nothing found for “{q}”</p>}
                    {items.map((i, idx) => {
                        const head = i.kind !== lastKind ? (lastKind = i.kind) : null
                        const Icon = i.icon
                        return (
                            <div key={`${i.kind}-${i.label}-${idx}`}>
                                {head && <div className="px-3 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{head}</div>}
                                <button data-i={idx} onMouseEnter={() => setSel(idx)} onClick={() => run(i)}
                                    className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${idx === sel ? 'bg-gradient-to-r from-blue-500/15 to-violet-500/10 text-white' : 'text-slate-300'}`}>
                                    <Icon className={`w-4 h-4 shrink-0 ${idx === sel ? 'text-blue-300' : 'text-slate-500'}`} />
                                    <span className="flex-1 truncate text-sm font-semibold">{i.label}</span>
                                    {i.hint && <span className="text-[11px] text-slate-500 truncate max-w-[40%]">{i.hint}</span>}
                                    {idx === sel && <CornerDownLeft className="w-3.5 h-3.5 text-slate-400" />}
                                </button>
                            </div>
                        )
                    })}
                </div>
                <div className="flex items-center gap-4 px-4 py-2.5 border-t border-white/[0.07] text-[11px] text-slate-500">
                    <span className="flex items-center gap-1"><span className="kz-kbd">↑</span><span className="kz-kbd">↓</span> move</span>
                    <span className="flex items-center gap-1"><span className="kz-kbd">Enter</span> open</span>
                </div>
            </div>
        </div>,
        document.body
    )
}
