import { useEffect, useState } from 'react'
import { CheckCircle2, HeartPulse, ArrowUpCircle, DatabaseBackup, Wifi, Rocket } from 'lucide-react'

// A living cluster: the control plane in the middle, nodes on orbits, traffic
// travelling along the links, and what KubeEZ is doing right now popping up.
const EVENTS = [
    { icon: Rocket, text: 'prod-mumbai · 3/3 nodes Ready', tone: 'text-blue-300' },
    { icon: HeartPulse, text: 'worker-2 healed · kubelet restarted', tone: 'text-emerald-300' },
    { icon: DatabaseBackup, text: 'etcd snapshot verified · offsite copy', tone: 'text-violet-300' },
    { icon: ArrowUpCircle, text: 'Upgrade 1.36 → 1.37 · no blockers', tone: 'text-cyan-300' },
    { icon: Wifi, text: 'Gateway Agent online · no open ports', tone: 'text-indigo-300' },
    { icon: CheckCircle2, text: 'Alert sent to Telegram & Slack', tone: 'text-amber-300' }
]

const ORBITS = [
    { rx: 120, ry: 62, dur: 26, nodes: 3 },
    { rx: 200, ry: 104, dur: 38, nodes: 4 },
    { rx: 272, ry: 142, dur: 52, nodes: 5 }
]
const ellipse = (rx, ry) => `M ${300 - rx} 220 a ${rx} ${ry} 0 1 0 ${2 * rx} 0 a ${rx} ${ry} 0 1 0 ${-2 * rx} 0`

export default function Constellation() {
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const [ev, setEv] = useState(0)
    useEffect(() => {
        if (reduced) return
        const t = setInterval(() => setEv(e => (e + 1) % EVENTS.length), 2600)
        return () => clearInterval(t)
    }, [reduced])
    const shown = [EVENTS[ev], EVENTS[(ev + 2) % EVENTS.length], EVENTS[(ev + 4) % EVENTS.length]]

    return (
        <div className="relative w-full aspect-[600/440] select-none" aria-hidden="true">
            <svg viewBox="0 0 600 440" className="absolute inset-0 w-full h-full">
                <defs>
                    <radialGradient id="core" cx="50%" cy="50%" r="50%">
                        <stop offset="0" stopColor="#67e0f9" stopOpacity=".9" />
                        <stop offset=".5" stopColor="#6d7cff" stopOpacity=".35" />
                        <stop offset="1" stopColor="#a855f7" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient id="orb" x1="0" x2="1">
                        <stop offset="0" stopColor="#2ccbee" />
                        <stop offset="1" stopColor="#a855f7" />
                    </linearGradient>
                    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="3" result="b" />
                        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                </defs>

                <g transform="rotate(-10 300 220)">
                    {ORBITS.map((o, i) => (
                        <path key={i} d={ellipse(o.rx, o.ry)} fill="none" stroke="url(#orb)" strokeOpacity={0.32 - i * 0.07} strokeWidth="1" strokeDasharray={i === 1 ? '3 7' : undefined} />
                    ))}

                    {/* nodes riding their orbits */}
                    {ORBITS.map((o, i) => Array.from({ length: o.nodes }, (_, k) => {
                        const begin = `-${(o.dur / o.nodes) * k}s`
                        const r = i === 0 ? 7 : i === 1 ? 6 : 5
                        return (
                            <g key={`${i}-${k}`} filter="url(#glow)">
                                <circle r={r} fill={k % 2 ? '#a78bfa' : '#2ccbee'} cx={reduced ? 300 + o.rx * Math.cos(k * 2 * Math.PI / o.nodes) : 0} cy={reduced ? 220 + o.ry * Math.sin(k * 2 * Math.PI / o.nodes) : 0}>
                                    {!reduced && <animateMotion dur={`${o.dur}s`} begin={begin} repeatCount="indefinite" path={ellipse(o.rx, o.ry)} />}
                                </circle>
                                <circle r={r + 5} fill="none" stroke={k % 2 ? '#a78bfa' : '#2ccbee'} strokeOpacity=".25" cx={reduced ? 300 + o.rx * Math.cos(k * 2 * Math.PI / o.nodes) : 0} cy={reduced ? 220 + o.ry * Math.sin(k * 2 * Math.PI / o.nodes) : 0}>
                                    {!reduced && <animateMotion dur={`${o.dur}s`} begin={begin} repeatCount="indefinite" path={ellipse(o.rx, o.ry)} />}
                                </circle>
                            </g>
                        )
                    }))}

                    {/* spokes with travelling packets */}
                    {[[-160, -90], [190, -70], [-210, 80], [150, 115], [20, -140], [-30, 145]].map(([dx, dy], k) => {
                        const p = `M 300 220 L ${300 + dx} ${220 + dy}`
                        return (
                            <g key={k}>
                                <path d={p} stroke="url(#orb)" strokeOpacity=".18" strokeDasharray="2 5" />
                                <circle cx={300 + dx} cy={220 + dy} r="3" fill="#b6c1d6" fillOpacity=".55" />
                                {!reduced && (
                                    <circle r="2.4" fill="#e0f7ff" filter="url(#glow)">
                                        <animateMotion dur={`${2.4 + k * 0.45}s`} begin={`${k * 0.6}s`} repeatCount="indefinite" path={k % 2 ? p : `M ${300 + dx} ${220 + dy} L 300 220`} />
                                    </circle>
                                )}
                            </g>
                        )
                    })}
                </g>

                {/* control plane core */}
                <circle cx="300" cy="220" r="70" fill="url(#core)">
                    {!reduced && <animate attributeName="r" values="62;74;62" dur="5s" repeatCount="indefinite" />}
                </circle>
                <g transform="translate(272 192)" filter="url(#glow)">
                    <path d="M28 2.5 49.2 14.75v24.5L28 51.5 6.8 39.25v-24.5Z" fill="#0b1120" stroke="url(#orb)" strokeWidth="2" />
                    <circle cx="28" cy="27" r="7" fill="none" stroke="#e8edf7" strokeWidth="2.4" />
                    {[0, 60, 120, 180, 240, 300].map(a => (
                        <line key={a} x1={28 + 9 * Math.cos((a - 90) * Math.PI / 180)} y1={27 + 9 * Math.sin((a - 90) * Math.PI / 180)}
                            x2={28 + 15 * Math.cos((a - 90) * Math.PI / 180)} y2={27 + 15 * Math.sin((a - 90) * Math.PI / 180)}
                            stroke="#e8edf7" strokeWidth="2.4" strokeLinecap="round" />
                    ))}
                </g>
                <text x="300" y="282" textAnchor="middle" fill="#8794ae" fontSize="10" fontFamily="JetBrains Mono, monospace" letterSpacing="2">CONTROL PLANE</text>
            </svg>

            {/* live events */}
            {shown.map((e, k) => {
                const pos = ['left-[2%] top-[10%]', 'right-[0%] top-[42%]', 'left-[8%] bottom-[6%]'][k]
                return (
                    <div key={`${ev}-${k}`} className={`absolute ${pos} kz-rise`} style={{ animationDelay: `${k * 120}ms` }}>
                        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#0b1120]/80 backdrop-blur-md px-3 py-1.5 shadow-glass">
                            <e.icon className={`w-3.5 h-3.5 ${e.tone}`} />
                            <span className="text-[11px] font-semibold text-slate-200 whitespace-nowrap">{e.text}</span>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
