// 45-day track of etcd snapshots: one marker per snapshot, colored by kind,
// ringed when verified, hollow when it exists only offsite. Click = select.
const DAY = 24 * 60 * 60 * 1000

export const KIND_COLORS = {
    'pre-upgrade': { dot: 'bg-blue-400', ring: 'ring-blue-400/40', text: 'text-blue-300', label: 'Before upgrade' },
    'pre-restore': { dot: 'bg-violet-400', ring: 'ring-violet-400/40', text: 'text-violet-300', label: 'Before restore' },
    manual: { dot: 'bg-emerald-400', ring: 'ring-emerald-400/40', text: 'text-emerald-300', label: 'Manual' },
    other: { dot: 'bg-slate-400', ring: 'ring-slate-400/40', text: 'text-slate-300', label: 'Snapshot' }
}

export default function SnapshotTimeline({ snapshots, selected, onSelect, days = 45 }) {
    const now = Date.now()
    const pos = (iso) => {
        const age = Math.max(0, (now - new Date(iso).getTime()) / DAY)
        return 100 - Math.min(age, days) / days * 100
    }
    const ticks = [days, 30, 14, 7, 0].filter(d => d <= days)

    return (
        <div className="relative select-none">
            <div className="relative h-14 mx-2">
                {/* track */}
                <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-gradient-to-r from-white/[0.03] via-white/[0.07] to-emerald-500/20" />
                {/* last 7 days glow */}
                <div className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-emerald-500/25" style={{ left: `${100 - 7 / days * 100}%`, right: 0 }} />
                {ticks.map(d => (
                    <div key={d} className="absolute top-1/2 h-3 w-px bg-white/10 -translate-y-1/2" style={{ left: `${100 - d / days * 100}%` }} />
                ))}
                {snapshots.map(s => {
                    const c = KIND_COLORS[s.type] || KIND_COLORS.other
                    const isSel = s.filename === selected
                    return (
                        <button key={s.filename} onClick={() => onSelect(s.filename)}
                            title={`${new Date(s.created).toLocaleString()} — ${c.label}${s.offsiteOnly ? ' (offsite only)' : s.verified ? ' · verified' : ''}`}
                            aria-label={`${c.label} snapshot ${new Date(s.created).toLocaleString()}`}
                            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-200 hover:scale-150 focus:outline-none
                                ${isSel ? `w-4 h-4 ring-4 ${c.ring} z-10` : 'w-2.5 h-2.5'}
                                ${s.offsiteOnly ? `border-2 border-sky-400 bg-slate-950` : c.dot}
                                ${s.verified && !isSel ? 'ring-2 ring-white/20' : ''}`}
                            style={{ left: `${pos(s.created)}%` }} />
                    )
                })}
            </div>
            <div className="relative h-4 mx-2 text-[9px] font-bold uppercase tracking-wider text-slate-600">
                {ticks.map(d => (
                    <span key={d} className="absolute -translate-x-1/2" style={{ left: `${100 - d / days * 100}%` }}>{d === 0 ? 'now' : `${d}d`}</span>
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[10px] text-slate-500">
                {Object.entries(KIND_COLORS).filter(([k]) => k !== 'other').map(([k, c]) => (
                    <span key={k} className="flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${c.dot}`} /> {c.label}</span>
                ))}
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full border-2 border-sky-400" /> Offsite only</span>
                <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-400 ring-2 ring-white/20" /> Verified</span>
            </div>
        </div>
    )
}
