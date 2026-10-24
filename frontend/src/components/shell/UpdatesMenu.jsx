import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, ArrowRight } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { whenVisible } from '../../utils/whenVisible'

// Top bar: new add-on versions on the user's clusters. KubeEZ looks them up in
// the chart repositories every 12 hours; nothing is updated until the user
// picks the version in the add-on's settings and applies it.
export default function UpdatesMenu() {
    const [updates, setUpdates] = useState([])
    const [lastCheck, setLastCheck] = useState(null)
    const [open, setOpen] = useState(false)
    const ref = useRef(null)

    useEffect(() => {
        let stop = false
        const load = async () => {
            try {
                const r = await apiFetch('/api/addon-catalog/updates')
                if (!r.ok) return
                const j = await r.json()
                if (!stop) { setUpdates(j.updates || []); setLastCheck(j.lastCheck || null) }
            } catch { }
        }
        load()
        const t = setInterval(whenVisible(load), 10 * 60 * 1000)
        return () => { stop = true; clearInterval(t) }
    }, [])

    useEffect(() => {
        if (!open) return
        const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
    }, [open])

    const n = updates.length
    return (
        <div ref={ref} className="relative">
            <button onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="relative p-2.5 rounded-xl text-slate-300 hover:text-white hover:bg-white/5 transition"
                aria-label={`Add-on updates${n ? ` (${n} available)` : ''}`} title="Add-on updates">
                <Sparkles className="w-5 h-5" />
                {n > 0 && (
                    <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-sky-500 text-[9px] font-black text-white flex items-center justify-center ring-2 ring-[#08080b]">{n > 9 ? '9+' : n}</span>
                )}
            </button>
            {open && (
                <div className="absolute right-0 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-white/10 bg-[#0a0e17]/95 backdrop-blur-2xl shadow-2xl z-50">
                    <div className="px-4 pt-3 pb-2 border-b border-white/[0.06]">
                        <p className="text-sm font-bold text-white">Add-on updates</p>
                        <p className="text-[11px] text-slate-500">{lastCheck?.at ? `Checked ${new Date(lastCheck.at).toLocaleString()}` : 'Checked every 12 hours'} · nothing changes until you apply</p>
                    </div>
                    {n === 0 ? (
                        <p className="px-4 py-6 text-center text-xs text-slate-500">All add-ons run the newest version.</p>
                    ) : (
                        <ul className="max-h-80 overflow-y-auto py-1">
                            {updates.map(u => {
                                const next = u.step || u.latest
                                return (
                                    <li key={`${u.clusterId}|${u.key}`}>
                                        <Link to={`/cluster/${u.clusterId}?tab=addons&section=manage`} onClick={() => setOpen(false)}
                                            className="block px-4 py-2.5 hover:bg-white/[0.04]">
                                            <div className="flex items-center gap-2 text-xs">
                                                <span className="font-bold text-white">{u.label}</span>
                                                <span className="text-slate-500 truncate">· {u.clusterName}</span>
                                                {!u.latest.tested && <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded-full border border-amber-400/25 bg-amber-500/10 text-[9px] font-black uppercase tracking-wider text-amber-300" title="Found in the chart repository; not yet tested by KubeEZ">New</span>}
                                            </div>
                                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                                                {u.currentApp || u.current} <ArrowRight className="w-3 h-3" /> <span className="text-sky-300">{u.latest.app}</span>
                                                {u.step && u.step.id !== u.latest.id && <span className="text-slate-500">(next step {next.app})</span>}
                                            </div>
                                        </Link>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}
