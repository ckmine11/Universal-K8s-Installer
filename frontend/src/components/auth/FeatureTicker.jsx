import { useEffect, useState } from 'react'

// Feature groups as tabs that rotate on their own (pause while hovered).
export default function FeatureTicker({ groups, compact = false }) {
    const [i, setI] = useState(0)
    const [paused, setPaused] = useState(false)
    useEffect(() => {
        if (paused) return
        const t = setTimeout(() => setI(n => (n + 1) % groups.length), 6500)
        return () => clearTimeout(t)
    }, [i, paused, groups.length])
    const g = groups[i]

    return (
        <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
            <div className="flex gap-1.5 flex-wrap" role="tablist">
                {groups.map((x, k) => (
                    <button key={x.group} role="tab" aria-selected={k === i} onClick={() => setI(k)}
                        className={`relative overflow-hidden rounded-full px-3.5 py-1.5 text-xs font-bold transition ${k === i ? 'text-white bg-white/[0.08] border border-white/15' : 'text-slate-400 border border-transparent hover:text-white'}`}>
                        {x.group}
                        {k === i && !paused && <span key={i} className="absolute left-0 bottom-0 h-[2px] bg-gradient-to-r from-blue-400 to-violet-400 animate-[kzTicker_6.5s_linear_forwards]" />}
                    </button>
                ))}
            </div>
            <div key={g.group} className={`mt-4 grid gap-3 ${compact ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
                {g.features.map((f, k) => (
                    <div key={f.title} className="kz-rise flex gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4" style={{ animationDelay: `${k * 70}ms` }}>
                        <span className="w-9 h-9 shrink-0 rounded-xl border border-white/10 bg-white/[0.04] flex items-center justify-center"><f.Icon className={`w-4 h-4 ${f.color}`} /></span>
                        <div className="min-w-0">
                            <p className="text-sm font-bold text-white">{f.title}</p>
                            <p className="mt-0.5 text-xs text-slate-400 leading-relaxed">{f.desc}</p>
                        </div>
                    </div>
                ))}
            </div>
            <style>{`@keyframes kzTicker { from { width: 0 } to { width: 100% } }`}</style>
        </div>
    )
}
