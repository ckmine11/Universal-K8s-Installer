import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence, useReducedMotion, useScroll, useSpring } from 'framer-motion'
import {
    ArrowRight, ArrowUpCircle, Compass, DatabaseBackup, HeartPulse, ShieldCheck, Wifi, Terminal,
    Server, CheckCircle2, Sparkles, Lock, Zap, Activity, GitBranch, Cloud, PlugZap, Bot, XCircle,
    Gauge, Boxes, LayoutDashboard, Bell, Radio, Camera, RotateCcw
} from 'lucide-react'
import { LogoMark, LogoWord } from '../components/shell/Logo'
import SpotlightCard from '../components/ui/Spotlight'
import { ShinyText } from '@/components/lightswind/shiny-text'
import { BorderBeam } from '@/components/lightswind/border-beam'
import { CountUp } from '@/components/lightswind/count-up'

// WebGL globe: loaded on its own so the page paints first
const Globe = lazy(() => import('@/components/lightswind/globe'))

const MARKERS = [
    [19.07, 72.87], [28.61, 77.2], [12.97, 77.59], [17.38, 78.48], [1.35, 103.82], [25.2, 55.27],
    [50.11, 8.68], [51.5, -0.12], [38.9, -77.03], [37.77, -122.42], [35.68, 139.69], [-33.86, 151.2]
].map(location => ({ location, size: 0.03 }))

const ADDONS = ['Prometheus', 'Grafana', 'Longhorn', 'ArgoCD', 'Flux CD', 'cert-manager', 'Velero', 'Harbor', 'Vault', 'Jenkins',
    'Falco', 'Trivy', 'Kyverno', 'Gatekeeper', 'MetalLB', 'Loki', 'Elasticsearch', 'Fluent Bit', 'Sealed Secrets', 'NFS', 'Nginx Ingress', 'KubeEZ Explorer']
const PLATFORMS = ['Amazon EKS', 'Azure AKS', 'Google GKE', 'Oracle OKE', 'DigitalOcean', 'Linode / Akamai', 'Civo', 'Hetzner', 'Scaleway', 'OVHcloud',
    'kubeadm', 'k3s', 'RKE2', 'Rancher', 'OpenShift', 'MicroK8s', 'k0s', 'Talos', 'Tanzu', 'Bare metal', 'VMware VMs', 'Proxmox']

const EASE = [.16, 1, .3, 1]
const fade = { hidden: { opacity: 0, y: 28 }, show: { opacity: 1, y: 0, transition: { duration: .9, ease: EASE } } }
const Reveal = ({ children, delay = 0, className = '' }) => (
    <motion.div className={className} variants={fade} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }} transition={{ delay }}>{children}</motion.div>
)

// a heading that rises in word by word
function Words({ text, className = '', delay = 0 }) {
    const reduce = useReducedMotion()
    return (
        <span className={className}>
            {text.split(' ').map((w, i) => (
                <span key={i} className="inline-block overflow-hidden pb-[0.12em] -mb-[0.12em] align-bottom">
                    <motion.span className="inline-block" initial={reduce ? false : { y: '110%' }} animate={{ y: 0 }} transition={{ duration: .9, ease: EASE, delay: delay + i * .06 }}>
                        {w}{' '}
                    </motion.span>
                </span>
            ))}
        </span>
    )
}

// runs a step counter while visible; reduced motion → the final state at once
function useTicker(steps, ms, { loop = true, active = true } = {}) {
    const reduce = useReducedMotion()
    const [n, setN] = useState(reduce ? steps : 0)
    useEffect(() => { setN(reduce ? steps : 0) }, [reduce, steps, active])
    useEffect(() => {
        if (reduce || !active) return
        const t = setTimeout(() => setN(v => (v >= steps ? (loop ? 0 : v) : v + 1)), n >= steps ? ms * 4 : ms)
        return () => clearTimeout(t)
    }, [n, steps, ms, loop, reduce, active])
    return n
}

// ══ the product window: four real KubeEZ flows ═════════════════════════════
const DEPLOY_LOG = [
    ['text-slate-500', '$ kubeez deploy prod-mumbai --nodes 3+5 --k8s 1.36'],
    ['text-blue-300', '✓ Pre-flight: 8 nodes reachable — OS, CPU, memory, ports'],
    ['text-blue-300', '✓ containerd 2.1 · kubeadm · kubelet installed'],
    ['text-blue-300', '✓ Control plane up — virtual IP 10.0.0.50 (kube-vip)'],
    ['text-blue-300', '✓ 5 workers joined · Calico ready'],
    ['text-sky-300', '✓ Add-ons: Ingress, Explorer, Prometheus + Grafana'],
    ['text-emerald-300', '● Cluster ready — https://10.0.0.50:6443'],
]
function DeployPanel() {
    const n = useTicker(DEPLOY_LOG.length, 700, { loop: false })
    const nodes = Math.min(8, Math.round((n / DEPLOY_LOG.length) * 8))
    return (
        <div className="grid md:grid-cols-5 h-full">
            <div className="md:col-span-3 p-5 sm:p-6 font-mono text-[12px] sm:text-[12.5px] leading-7 border-b md:border-b-0 md:border-r border-white/[0.06]">
                {DEPLOY_LOG.map(([c, t], i) => (
                    <div key={i} className={`${c} truncate transition-all duration-500 ${i < n ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}`}>{t}</div>
                ))}
                {n >= DEPLOY_LOG.length && <div className="flex items-center gap-1.5 text-white"><span>$</span><span className="w-2 h-4 bg-white/80 animate-pulse rounded-sm" /></div>}
            </div>
            <div className="md:col-span-2 p-5 sm:p-6 space-y-5">
                <div>
                    <div className="flex justify-between text-[11px] uppercase tracking-[0.18em] text-slate-500"><span>Progress</span><span className="text-slate-300 tabular-nums">{Math.round((n / DEPLOY_LOG.length) * 100)}%</span></div>
                    <div className="mt-2 h-1.5 rounded-full bg-white/[0.06] overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-[#8069fb] via-[#4f7dff] to-[#38bdf8] transition-all duration-700" style={{ width: `${(n / DEPLOY_LOG.length) * 100}%` }} /></div>
                </div>
                <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Nodes</div>
                    <div className="mt-3 grid grid-cols-4 gap-2">
                        {Array.from({ length: 8 }, (_, i) => (
                            <div key={i} className={`rounded-xl border px-2 py-2.5 text-center transition-all duration-500 ${i < nodes ? 'border-emerald-400/30 bg-emerald-400/[0.07]' : 'border-white/[0.06] bg-white/[0.02]'}`}>
                                <Server className={`mx-auto w-4 h-4 ${i < nodes ? 'text-emerald-300' : 'text-slate-600'}`} />
                                <div className="mt-1 text-[10px] text-slate-500">{i < 3 ? `cp-${i + 1}` : `w-${i - 2}`}</div>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-[13px] text-slate-300 flex items-center gap-2">
                    <Radio className="w-4 h-4 text-blue-300 shrink-0" /> Live log for every step — a failure comes with the reason and Resume.
                </div>
            </div>
        </div>
    )
}

const HEAL = [
    ['Detected', 'worker-4 NotReady — kubelet stopped', 'text-red-300', 'bg-red-400'],
    ['Diagnosed', 'disk pressure on /var — 97% full', 'text-amber-200', 'bg-amber-300'],
    ['Fixed', 'cleaned images, restarted kubelet', 'text-blue-200', 'bg-blue-400'],
    ['Healthy', 'back in 41 s · alert closed on Slack', 'text-emerald-200', 'bg-emerald-400'],
]
function HealPanel() {
    const n = useTicker(HEAL.length, 1100, { loop: false })
    const ok = n >= HEAL.length
    return (
        <div className="grid md:grid-cols-5 h-full">
            <div className="md:col-span-3 p-5 sm:p-6 border-b md:border-b-0 md:border-r border-white/[0.06]">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Incident timeline</div>
                <ol className="mt-4 relative space-y-4 before:absolute before:left-[7px] before:top-2 before:bottom-2 before:w-px before:bg-white/10">
                    {HEAL.map(([k, v, tc, dot], i) => (
                        <li key={k} className={`relative pl-7 transition-all duration-500 ${i < n ? 'opacity-100' : 'opacity-25'}`}>
                            <span className={`absolute left-0 top-1 w-[15px] h-[15px] rounded-full border-2 border-[#0c0c11] ${i < n ? dot : 'bg-white/10'} ${i === n - 1 && !ok ? 'animate-pulse' : ''}`} />
                            <div className={`text-sm font-semibold ${tc}`}>{k}</div>
                            <div className="text-[13px] text-slate-400">{v}</div>
                        </li>
                    ))}
                </ol>
            </div>
            <div className="md:col-span-2 p-5 sm:p-6 flex flex-col gap-4">
                <div className={`rounded-2xl border p-5 transition-all duration-700 ${ok ? 'border-emerald-400/30 bg-emerald-400/[0.06]' : 'border-red-400/30 bg-red-400/[0.06]'}`}>
                    <div className="flex items-center justify-between">
                        <span className="font-mono text-sm text-white">worker-4</span>
                        <span className={`text-xs font-semibold ${ok ? 'text-emerald-300' : 'text-red-300'}`}>{ok ? '● Ready' : '● NotReady'}</span>
                    </div>
                    <svg viewBox="0 0 200 40" className="mt-4 w-full h-10" aria-hidden="true">
                        <path d="M0 20 H60 L70 6 L80 34 L90 20 H120 L128 12 L136 28 L144 20 H200" fill="none" stroke={ok ? '#34d399' : '#f87171'} strokeWidth="2" className="kz-ecg" />
                    </svg>
                </div>
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-[13px] text-slate-300 flex items-start gap-2">
                    <HeartPulse className="w-4 h-4 mt-0.5 text-emerald-300 shrink-0" /> Nodes down, disks full, crash loops — fixed automatically, explained when they cannot be.
                </div>
            </div>
        </div>
    )
}

const UPGRADE = ['Safety check: 0 blockers', 'etcd snapshot taken · verified', 'Control plane 1.35 → 1.36', 'Workers drained one by one', 'All 8 nodes on 1.36']
function UpgradePanel() {
    const n = useTicker(UPGRADE.length, 950, { loop: false })
    const v = n >= 3 ? '1.36' : '1.35'
    return (
        <div className="grid md:grid-cols-5 h-full">
            <div className="md:col-span-2 p-5 sm:p-6 border-b md:border-b-0 md:border-r border-white/[0.06] flex flex-col items-center justify-center text-center">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Kubernetes</div>
                <div className="mt-3 flex items-center gap-3 font-mono">
                    <span className="text-lg text-slate-500 line-through decoration-slate-600">1.35</span>
                    <ArrowRight className="w-4 h-4 text-slate-500" />
                    <AnimatePresence mode="popLayout">
                        <motion.span key={v} initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -16, opacity: 0 }} className="text-5xl font-semibold text-white">{v}</motion.span>
                    </AnimatePresence>
                </div>
                <div className="mt-4 kz-chip text-emerald-200"><Camera className="w-3.5 h-3.5" /> one-click undo from the snapshot</div>
            </div>
            <div className="md:col-span-3 p-5 sm:p-6">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">One version at a time</div>
                <ul className="mt-4 space-y-2.5">
                    {UPGRADE.map((s, i) => (
                        <li key={s} className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm transition-all duration-500 ${i < n ? 'border-white/[0.08] bg-white/[0.03] text-slate-200' : 'border-transparent text-slate-600'}`}>
                            {i < n ? <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" /> : <span className="w-4 h-4 rounded-full border border-white/15 shrink-0" />}{s}
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    )
}

const CONNECT = [['EKS', 'agent', 'online'], ['AKS', 'direct', 'online'], ['GKE', 'agent', 'online'], ['k3s', 'agent', 'online'], ['OpenShift', 'direct', 'online'], ['RKE2', 'SSH', 'online']]
function ConnectPanel() {
    const n = useTicker(CONNECT.length, 600, { loop: false })
    return (
        <div className="grid md:grid-cols-5 h-full">
            <div className="md:col-span-2 p-5 sm:p-6 border-b md:border-b-0 md:border-r border-white/[0.06]">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Add an existing cluster</div>
                <div className="mt-4 rounded-xl border border-white/[0.08] bg-black/40 p-3 font-mono text-[11.5px] leading-6 text-sky-100 break-all">
                    <span className="text-slate-500">$</span> kubectl apply -f https://kubeez…/connect/<span className="text-blue-300">k7Qx…</span>
                </div>
                <p className="mt-4 text-[13px] text-slate-400 leading-relaxed">The KubeEZ agent connects <b className="text-slate-200">out</b> over HTTPS — private endpoints and clusters behind NAT included. Read-only by default.</p>
            </div>
            <div className="md:col-span-3 p-5 sm:p-6">
                <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Connected clusters</div>
                <ul className="mt-4 grid grid-cols-2 gap-2.5">
                    {CONNECT.map(([p, m], i) => (
                        <li key={p} className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 transition-all duration-500 ${i < n ? 'border-white/[0.08] bg-white/[0.03]' : 'border-white/[0.04] opacity-30'}`}>
                            <span className="text-sm text-white">{p}<span className="ml-1.5 text-[11px] text-slate-500">{m}</span></span>
                            <span className={`w-2 h-2 rounded-full ${i < n ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]' : 'bg-slate-600'}`} />
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    )
}

const TABS = [
    { id: 'deploy', label: 'Deploy', Icon: Zap, Panel: DeployPanel, title: 'prod-mumbai · new cluster' },
    { id: 'heal', label: 'Self-heal', Icon: HeartPulse, Panel: HealPanel, title: 'prod-mumbai · incidents' },
    { id: 'upgrade', label: 'Upgrade', Icon: ArrowUpCircle, Panel: UpgradePanel, title: 'prod-mumbai · upgrade' },
    { id: 'connect', label: 'Connect', Icon: PlugZap, Panel: ConnectPanel, title: 'connected clusters' },
]
function ProductWindow() {
    const reduce = useReducedMotion()
    const [tab, setTab] = useState(0)
    const [paused, setPaused] = useState(false)
    useEffect(() => {
        if (reduce || paused) return
        const t = setTimeout(() => setTab(v => (v + 1) % TABS.length), 7500)
        return () => clearTimeout(t)
    }, [tab, paused, reduce])
    const { Panel, title } = TABS[tab]
    return (
        <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
            className="relative rounded-[28px] border border-white/10 bg-[#0c0c11]/90 backdrop-blur-xl shadow-[0_60px_160px_-40px_rgba(128,105,251,.5),inset_0_1px_0_rgba(255,255,255,.08)] overflow-hidden">
            <BorderBeam size={300} duration={9} colorFrom="#b6a8ff" colorTo="#38bdf8" borderThickness={1} />
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-white/[0.06]">
                <span className="w-3 h-3 rounded-full bg-[#ff5f57]/80" /><span className="w-3 h-3 rounded-full bg-[#febc2e]/80" /><span className="w-3 h-3 rounded-full bg-[#28c840]/80" />
                <span className="ml-3 text-xs text-slate-500 font-mono truncate">console.kubeez · {title}</span>
                <span className="ml-auto hidden sm:inline-flex items-center gap-1.5 text-[11px] text-emerald-300"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />live</span>
            </div>
            <div className="flex">
                {/* the console's own sidebar, in miniature */}
                <div className="hidden sm:flex flex-col items-center gap-3 border-r border-white/[0.06] px-3 py-5" aria-hidden="true">
                    {[LayoutDashboard, Server, Activity, Bot, ShieldCheck, Bell].map((I, i) => <span key={i} className={`grid place-items-center w-9 h-9 rounded-xl ${i === 0 ? 'bg-white/[0.07] text-white' : 'text-slate-600'}`}><I className="w-4 h-4" /></span>)}
                </div>
                <div className="flex-1 min-w-0">
                    <div role="tablist" aria-label="KubeEZ flows" className="flex gap-1 overflow-x-auto border-b border-white/[0.06] px-3 sm:px-4 pt-3">
                        {TABS.map((t, i) => (
                            <button key={t.id} role="tab" aria-selected={i === tab} onClick={() => { setTab(i); setPaused(true) }}
                                className={`relative flex items-center gap-2 whitespace-nowrap rounded-t-xl px-3.5 py-2.5 text-[13px] font-medium transition-colors ${i === tab ? 'text-white' : 'text-slate-500 hover:text-slate-300'}`}>
                                <t.Icon className="w-3.5 h-3.5" />{t.label}
                                {i === tab && <motion.span layoutId="tab-line" className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-gradient-to-r from-[#8069fb] to-[#38bdf8]" />}
                                {i === tab && !paused && !reduce && <span className="absolute inset-x-2 -bottom-px h-[2px] origin-left bg-white/40 kz-tab-timer" />}
                            </button>
                        ))}
                    </div>
                    <div className="min-h-[340px] sm:min-h-[320px]">
                        <AnimatePresence mode="wait">
                            <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: .35, ease: EASE }} className="h-full">
                                <Panel />
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ══ bento tiles: each shows the feature moving ═══════════════════════════════
function NodesViz() {
    const n = useTicker(12, 260)
    return (
        <div className="mt-6 grid grid-cols-6 gap-2" aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
                <div key={i} className={`h-9 rounded-lg border transition-all duration-500 ${i < n ? (i < 3 ? 'border-[#8069fb]/50 bg-[#8069fb]/15' : 'border-sky-400/30 bg-sky-400/10') : 'border-white/[0.06] bg-white/[0.02]'}`} />
            ))}
        </div>
    )
}
function VersionViz() {
    const n = useTicker(3, 1200)
    const vs = ['1.34', '1.35', '1.36', '1.37']
    return (
        <div className="mt-6 flex items-center gap-1.5 font-mono text-xs" aria-hidden="true">
            {vs.map((v, i) => <span key={v} className={`flex-1 rounded-lg border py-2 text-center transition-all duration-500 ${i === n ? 'border-blue-400/50 bg-blue-500/15 text-white' : i < n ? 'border-white/[0.06] text-slate-500' : 'border-white/[0.06] text-slate-600'}`}>{v}</span>)}
        </div>
    )
}
function SnapViz() {
    return (
        <ul className="mt-6 space-y-1.5 font-mono text-[11.5px]" aria-hidden="true">
            {['02:00 nightly', '01:00 nightly', '23:41 pre-upgrade'].map((s, i) => (
                <li key={s} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-slate-400">
                    <span>etcd · {s}</span><span className="flex items-center gap-1 text-emerald-300"><CheckCircle2 className="w-3 h-3" />{i === 0 ? 'offsite' : 'verified'}</span>
                </li>
            ))}
        </ul>
    )
}
function PulseViz() {
    return (
        <svg viewBox="0 0 240 48" className="mt-6 w-full h-12" aria-hidden="true">
            <path d="M0 24 H70 L80 8 L92 40 L102 24 H150 L158 14 L166 34 L174 24 H240" fill="none" stroke="#34d399" strokeWidth="2" className="kz-ecg" />
        </svg>
    )
}
function ChatViz() {
    const n = useTicker(2, 1400)
    return (
        <div className="mt-6 space-y-2 text-[12.5px]" aria-hidden="true">
            <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.07] px-3.5 py-2 text-slate-200">Why is checkout crashing?</div>
            <div className={`w-fit max-w-[92%] rounded-2xl rounded-bl-md border border-[#8069fb]/30 bg-[#8069fb]/10 px-3.5 py-2 text-slate-200 transition-all duration-500 ${n >= 1 ? 'opacity-100' : 'opacity-0 translate-y-1'}`}>
                OOMKilled — the limit is 256Mi, it peaks at 410Mi. <span className="text-blue-200">Raise to 512Mi?</span>
            </div>
        </div>
    )
}
function RingsViz() {
    return (
        <div className="mt-6 grid grid-cols-4 gap-3" aria-hidden="true">
            {[['CERT-In', 92], ['DPDP', 95], ['ISO 27001', 90], ['CIS', 88]].map(([k, v]) => (
                <div key={k} className="text-center">
                    <svg viewBox="0 0 36 36" className="mx-auto w-14 h-14 -rotate-90">
                        <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="3" />
                        <motion.circle cx="18" cy="18" r="15.5" fill="none" stroke="url(#ring)" strokeWidth="3" strokeLinecap="round"
                            initial={{ strokeDasharray: '0 97.4' }} whileInView={{ strokeDasharray: `${v / 100 * 97.4} 97.4` }} viewport={{ once: true }} transition={{ duration: 1.4, ease: EASE }} />
                        <defs><linearGradient id="ring"><stop offset="0" stopColor="#8069fb" /><stop offset="1" stopColor="#38bdf8" /></linearGradient></defs>
                    </svg>
                    <div className="mt-1 text-sm font-semibold text-white tabular-nums">{v}</div>
                    <div className="text-[10.5px] text-slate-500">{k}</div>
                </div>
            ))}
        </div>
    )
}
function OutboundViz() {
    return (
        <div className="mt-6 flex items-center gap-3 text-[11px] text-slate-400" aria-hidden="true">
            <span className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">your network</span>
            <span className="relative flex-1 h-px bg-white/10 overflow-hidden"><span className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-sky-300 to-transparent kz-flow" /></span>
            <span className="rounded-lg border border-[#8069fb]/40 bg-[#8069fb]/10 px-2.5 py-1.5 text-white">KubeEZ</span>
        </div>
    )
}

const BENTO = [
    { Icon: Server, title: 'Deploy in one flow', text: 'IPs and an SSH login — KubeEZ checks every server, installs Kubernetes 1.27 – 1.37, joins workers and sets up a highly available API with a virtual IP.', span: 'md:col-span-2', color: '128,105,251', Viz: NodesViz },
    { Icon: ArrowUpCircle, title: 'Upgrades without fear', text: 'A safety check finds what breaks first, a snapshot is taken, then one version at a time.', color: '79,125,255', Viz: VersionViz },
    { Icon: DatabaseBackup, title: 'Backups you can trust', text: 'Verified snapshots, a preview of every restore, one-click undo and encrypted offsite copies.', color: '56,189,248', Viz: SnapViz },
    { Icon: HeartPulse, title: 'It heals itself', text: 'Nodes down, disks full, crash loops — fixed automatically, explained when they cannot be.', color: '52,211,153', Viz: PulseViz },
    { Icon: Bot, title: 'KubeEZ AI on call', text: 'Ask why something broke, get the cause from your cluster and a safe fix with dry-run and undo. Bring your own AI.', color: '182,168,255', Viz: ChatViz },
    { Icon: ShieldCheck, title: 'Audit-ready, always', text: 'CERT-In, DPDP, ISO 27001 and CIS checks with a sealed PDF report, a tamper-evident audit trail and recorded terminal sessions.', span: 'md:col-span-2', color: '182,168,255', Viz: RingsViz },
    { Icon: Wifi, title: 'No inbound ports', text: 'The Gateway Agent connects out from your network. Private data centres, no VPN.', color: '125,211,252', Viz: OutboundViz },
]

// the globe is decoration: start it once the page has loaded and the browser is
// idle, so it never competes with the first paint or the first click
function useIdleReady(enabled) {
    const [ready, setReady] = useState(false)
    useEffect(() => {
        if (!enabled) return
        let idle, t
        const go = () => { idle = 'requestIdleCallback' in window ? window.requestIdleCallback(() => setReady(true), { timeout: 3000 }) : setTimeout(() => setReady(true), 1200) }
        if (document.readyState === 'complete') t = setTimeout(go, 400)
        else window.addEventListener('load', go, { once: true })
        return () => { window.removeEventListener('load', go); clearTimeout(t); if (idle && 'cancelIdleCallback' in window) window.cancelIdleCallback(idle) }
    }, [enabled])
    return ready
}

// ══ the page ═════════════════════════════════════════════════════════════════
export default function LandingPage() {
    const reduce = useReducedMotion()
    // not on phones: it sits behind the product window there and costs the most on low-power devices
    const showGlobe = useIdleReady(!reduce && typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches)
    const [scrolled, setScrolled] = useState(false)
    const hero = useRef(null)
    useEffect(() => {
        const on = () => setScrolled(window.scrollY > 24)
        on(); window.addEventListener('scroll', on, { passive: true })
        return () => window.removeEventListener('scroll', on)
    }, [])
    useEffect(() => { document.title = 'KubeEZ — Kubernetes on your own servers' }, [])
    // the hero light follows the pointer
    const onMove = (e) => {
        if (reduce || !hero.current) return
        const r = hero.current.getBoundingClientRect()
        hero.current.style.setProperty('--mx', `${e.clientX - r.left}px`)
        hero.current.style.setProperty('--my', `${e.clientY - r.top}px`)
    }
    const how = useRef(null)
    const { scrollYProgress } = useScroll({ target: how, offset: ['start 75%', 'end 60%'] })
    const line = useSpring(scrollYProgress, { stiffness: 120, damping: 30 })
    const page = useScroll().scrollYProgress

    return (
        <div className="relative min-h-screen bg-[#060608] text-white overflow-x-clip">
            {/* reading progress */}
            <motion.div aria-hidden="true" style={{ scaleX: page }} className="fixed inset-x-0 top-0 z-[60] h-[2px] origin-left bg-gradient-to-r from-[#8069fb] via-[#4f7dff] to-[#38bdf8]" />

            {/* ── light ── */}
            <div aria-hidden="true" className="kz-deco pointer-events-none absolute inset-x-0 top-0 h-[1200px] overflow-hidden">
                <div className="absolute left-1/2 -top-[340px] -translate-x-1/2 w-[1300px] h-[800px] rounded-full bg-[radial-gradient(closest-side,rgba(128,105,251,.34),transparent)] blur-2xl" />
                <div className="absolute left-[10%] top-[120px] w-[520px] h-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(79,125,255,.18),transparent)] blur-2xl animate-aurora-1" />
                <div className="absolute right-[6%] top-[60px] w-[520px] h-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(56,189,248,.13),transparent)] blur-2xl animate-aurora-2" />
                <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.045)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(ellipse_65%_55%_at_50%_0%,#000_10%,transparent_70%)]" />
                <span className="kz-beam left-[22%]" /><span className="kz-beam left-[61%] [animation-delay:2.4s]" /><span className="kz-beam left-[83%] [animation-delay:4.1s]" />
            </div>

            {/* ── nav ── */}
            <header className="fixed top-4 inset-x-0 z-50 px-4">
                <nav className={`mx-auto max-w-5xl flex items-center gap-2 rounded-full border px-3 py-2 transition-all duration-500 ${scrolled ? 'border-white/10 bg-[#0c0c11]/75 backdrop-blur-2xl shadow-[0_20px_60px_-20px_rgba(0,0,0,.8)]' : 'border-transparent bg-transparent'}`}>
                    <Link to="/" className="flex items-center gap-2 pl-2 pr-3" aria-label="KubeEZ home">
                        <LogoMark className="w-8 h-8 drop-shadow-[0_0_16px_rgba(128,105,251,.6)]" />
                        <LogoWord className="text-[17px]" />
                    </Link>
                    <div className="hidden md:flex items-center gap-1 text-sm text-slate-400">
                        {[['#product', 'Product'], ['#features', 'Features'], ['#connect', 'Any cluster'], ['#how', 'How it works'], ['#security', 'Security']].map(([h, l]) => (
                            <a key={h} href={h} className="px-3 py-1.5 rounded-full hover:text-white hover:bg-white/5 transition">{l}</a>
                        ))}
                    </div>
                    <div className="ml-auto flex items-center gap-1.5">
                        <Link to="/login" className="px-4 py-2 rounded-full text-sm text-slate-300 hover:text-white transition">Sign in</Link>
                        <Link to="/login?mode=register" className="kz-btn-light !rounded-full !px-4 !py-2">Get started</Link>
                    </div>
                </nav>
            </header>

            {/* ── hero ── */}
            <section ref={hero} onMouseMove={onMove} className="kz-hero relative pt-40 sm:pt-48 px-4 text-center">
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 kz-hero-glow" />
                <Reveal>
                    <a href="#connect" className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] backdrop-blur px-1.5 py-1.5 pr-4 text-xs text-slate-300 hover:border-white/20 transition">
                        <span className="rounded-full bg-blue-500/20 border border-blue-400/30 px-2 py-0.5 text-[11px] font-semibold text-blue-200">New</span>
                        <ShinyText size="xs" baseColor="var(--kz-shiny-base, #b9b6cc)" shineColor="var(--kz-shiny, #ffffff)" speed={3}>Connect EKS, AKS, GKE, k3s, OpenShift — any cluster</ShinyText>
                        <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                    </a>
                </Reveal>
                <h1 className="relative mx-auto mt-8 max-w-6xl text-[42px] leading-[1.02] sm:text-7xl lg:text-[88px] font-semibold tracking-[-0.045em]">
                    <Words text="Kubernetes on your servers," className="gradient-text" delay={.1} /><br />
                    <motion.span initial={reduce ? false : { opacity: 0, filter: 'blur(12px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }} transition={{ duration: 1.1, delay: .55, ease: EASE }}
                        className="kz-serif aurora-text inline-block pr-2 text-[52px] sm:text-[88px] lg:text-[110px] leading-none">calm as a cloud.</motion.span>
                </h1>
                <Reveal delay={.15}>
                    <p className="mx-auto mt-7 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed">
                        KubeEZ installs production Kubernetes on servers you own — or connects the clusters you already run — then upgrades, backs up, heals and audits them for you.
                    </p>
                </Reveal>
                <Reveal delay={.25}>
                    <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
                        <Link to="/login?mode=register" className="kz-btn-light kz-shine !rounded-full !px-7 !py-3.5 text-[15px] group">
                            Start free <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                        </Link>
                        <a href="#product" className="kz-btn-ghost !rounded-full !px-6 !py-3.5 text-[15px]">See it work</a>
                    </div>
                    <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-slate-500">
                        {['Free for one cluster', 'No card needed', 'Bare metal · VMs · any cloud'].map(t => <span key={t} className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/80" />{t}</span>)}
                    </div>
                </Reveal>

                {/* globe + product */}
                <div id="product" className="relative mx-auto mt-16 max-w-6xl scroll-mt-28">
                    <div aria-hidden="true" className="kz-deco absolute left-1/2 -translate-x-1/2 -top-16 sm:-top-24 w-[480px] h-[480px] sm:w-[760px] sm:h-[760px] max-w-[120vw] opacity-70 [mask-image:radial-gradient(closest-side,#000_55%,transparent)]">
                        {showGlobe && <Suspense fallback={null}>
                            <Globe className="!min-h-0 h-full" dark={1} diffuse={1.1} mapSamples={10000} mapBrightness={5} scale={1}
                                baseColor={[0.22, 0.2, 0.32]} markerColor={[0.62, 0.55, 1]} glowColor={[0.32, 0.27, 0.62]}
                                markers={MARKERS} enableZoom={false} autoRotateSpeed={0.0025} theta={0.3} />
                        </Suspense>}
                    </div>
                    <motion.div initial={reduce ? false : { opacity: 0, y: 60, rotateX: 18 }} animate={{ opacity: 1, y: 0, rotateX: 0 }} transition={{ duration: 1.3, delay: .7, ease: EASE }}
                        style={{ transformPerspective: 1400 }} className="kz-globe-space relative pt-[200px] sm:pt-[340px] text-left">
                        <div className="kz-dark rounded-[28px]"><ProductWindow /></div>
                    </motion.div>
                </div>
            </section>

            {/* ── add-on marquee ── */}
            <section id="addons" className="relative mt-24 scroll-mt-28">
                <p className="text-center text-xs uppercase tracking-[0.25em] text-slate-500">25+ add-ons, installed and kept up to date</p>
                <div className="mt-7 space-y-3 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
                    {[0, 1].map(row => (
                        <div key={row} className={`flex w-max gap-3 animate-marquee hover:[animation-play-state:paused] ${row ? '[animation-direction:reverse] [animation-duration:55s]' : ''}`}>
                            {[...ADDONS, ...ADDONS].slice(row ? 7 : 0).concat(row ? ADDONS.slice(0, 7) : []).map((a, i) => (
                                <span key={i} className="shrink-0 rounded-full border border-white/[0.07] bg-white/[0.03] px-5 py-2.5 text-sm text-slate-300 hover:text-white hover:border-white/20 transition-colors">{a}</span>
                            ))}
                        </div>
                    ))}
                </div>
            </section>

            {/* ── features (bento) ── */}
            <section id="features" className="relative mx-auto max-w-6xl px-4 mt-32 scroll-mt-28">
                <Reveal className="text-center">
                    <div className="kz-eyebrow justify-center">Everything day 2 needs</div>
                    <h2 className="mt-4 text-4xl sm:text-6xl font-semibold tracking-[-0.045em] gradient-text">From the first server <span className="kz-serif aurora-text">to the audit.</span></h2>
                    <p className="mx-auto mt-5 max-w-xl text-slate-400">The work your platform team does every night — done by KubeEZ, shown to you live.</p>
                </Reveal>
                <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-4">
                    {BENTO.map(({ Icon, title, text, span = '', color, Viz }, i) => (
                        <Reveal key={title} delay={(i % 3) * .06} className={span}>
                            <SpotlightCard color={color} className="h-full p-7 transition-transform duration-300 hover:-translate-y-1">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center border border-white/10 bg-white/[0.04]" style={{ boxShadow: `0 10px 30px -12px rgba(${color},.7), inset 0 1px 0 rgba(255,255,255,.08)` }}>
                                    <Icon className="w-5 h-5" style={{ color: `rgb(${color})` }} />
                                </div>
                                <h3 className="mt-6 text-lg font-semibold tracking-tight text-white">{title}</h3>
                                <p className="mt-2 text-sm leading-relaxed text-slate-400">{text}</p>
                                <Viz />
                            </SpotlightCard>
                        </Reveal>
                    ))}
                </div>
            </section>

            {/* ── numbers ── */}
            <section className="relative mx-auto max-w-6xl px-4 mt-28">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-px overflow-hidden rounded-3xl border border-white/[0.07] bg-white/[0.06]">
                    {[[25, '+', 'managed add-ons'], [11, '', 'Kubernetes versions, 1.27 – 1.37'], [30, '', 'compliance controls'], [0, '', 'inbound ports needed']].map(([v, s, l]) => (
                        <div key={l} className="bg-[#0b0b0f] px-6 py-10 text-center">
                            <div className="text-4xl sm:text-6xl font-semibold tracking-tight text-white">
                                <CountUp value={v} suffix={s} duration={2} triggerOnView colorScheme="custom" />
                            </div>
                            <div className="mt-2 text-sm text-slate-500">{l}</div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── any cluster ── */}
            <section id="connect" className="relative mx-auto max-w-6xl px-4 mt-32 scroll-mt-28">
                <div className="grid lg:grid-cols-2 gap-12 items-center">
                    <Reveal>
                        <div className="kz-eyebrow">Already running Kubernetes?</div>
                        <h2 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-[-0.04em] gradient-text">Bring every cluster. <span className="kz-serif aurora-text">One calm console.</span></h2>
                        <p className="mt-5 text-slate-400 leading-relaxed">Connect clusters in any cloud or data centre with one command. KubeEZ detects the provider and distribution, starts read-only, and turns on health, incidents, AI, compliance and add-ons — node pools and upgrades too, through your cloud account.</p>
                        <div className="mt-7 grid grid-cols-3 gap-3 text-center">
                            {[[Radio, 'Agent', 'outbound only'], [PlugZap, 'Direct', 'kubeconfig'], [Terminal, 'SSH', 'on-prem extras']].map(([I, t, d]) => (
                                <div key={t} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
                                    <I className="mx-auto w-5 h-5 text-blue-300" />
                                    <div className="mt-2 text-sm font-semibold text-white">{t}</div>
                                    <div className="text-[11.5px] text-slate-500">{d}</div>
                                </div>
                            ))}
                        </div>
                    </Reveal>
                    <Reveal delay={.1}>
                        <div className="relative rounded-3xl border border-white/[0.07] bg-gradient-to-b from-white/[0.04] to-transparent p-6">
                            <div className="flex flex-wrap gap-2">
                                {PLATFORMS.map((p, i) => (
                                    <motion.span key={p} initial={reduce ? false : { opacity: 0, scale: .9 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ delay: i * .025, duration: .4 }}
                                        className={`rounded-full border px-3.5 py-1.5 text-[13px] ${i < 10 ? 'border-sky-400/20 bg-sky-400/[0.06] text-sky-100' : 'border-[#8069fb]/25 bg-[#8069fb]/[0.07] text-violet-100'}`}>{p}</motion.span>
                                ))}
                            </div>
                            <div className="mt-6 flex items-center gap-4 text-[11px] text-slate-500">
                                <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-sky-400" />Cloud</span>
                                <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#8069fb]" />On-prem</span>
                                <span className="ml-auto inline-flex items-center gap-1.5"><Boxes className="w-3.5 h-3.5" />and any other Kubernetes</span>
                            </div>
                        </div>
                    </Reveal>
                </div>
            </section>

            {/* ── without / with ── */}
            <section className="relative mx-auto max-w-6xl px-4 mt-32">
                <Reveal className="text-center">
                    <div className="kz-eyebrow justify-center">The 3 a.m. test</div>
                    <h2 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-[-0.04em] gradient-text">Same outage. <span className="kz-serif aurora-text">Different night.</span></h2>
                </Reveal>
                <div className="mt-12 grid md:grid-cols-2 gap-4">
                    <Reveal>
                        <div className="h-full rounded-3xl border border-white/[0.06] bg-white/[0.015] p-7">
                            <div className="text-sm font-semibold text-slate-400">Without KubeEZ</div>
                            <ul className="mt-5 space-y-3.5">
                                {['A pager wakes you at 03:12', 'SSH into eight servers to find the one', 'Guess: disk? kubelet? network?', 'No recent etcd snapshot to fall back on', 'Write the incident report by hand'].map(t => (
                                    <li key={t} className="flex items-start gap-3 text-[15px] text-slate-500"><XCircle className="w-5 h-5 mt-0.5 shrink-0 text-red-400/60" />{t}</li>
                                ))}
                            </ul>
                        </div>
                    </Reveal>
                    <Reveal delay={.08}>
                        <SpotlightCard color="52,211,153" className="h-full p-7">
                            <div className="text-sm font-semibold text-emerald-300">With KubeEZ</div>
                            <ul className="mt-5 space-y-3.5">
                                {['Detected in seconds, fixed in 41', 'The node, the cause and the fix — on one screen', 'Telegram: “worker-4 healed, nothing to do”', 'Verified snapshot from 02:00, offsite copy too', 'Timeline and audit trail written for you'].map(t => (
                                    <li key={t} className="flex items-start gap-3 text-[15px] text-slate-200"><CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0 text-emerald-400" />{t}</li>
                                ))}
                            </ul>
                        </SpotlightCard>
                    </Reveal>
                </div>
            </section>

            {/* ── how it works ── */}
            <section id="how" ref={how} className="relative mx-auto max-w-6xl px-4 mt-32 scroll-mt-28">
                <Reveal className="text-center">
                    <div className="kz-eyebrow justify-center">How it works</div>
                    <h2 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-[-0.04em] gradient-text">Three steps. <span className="kz-serif aurora-text">Then it runs itself.</span></h2>
                </Reveal>
                <div className="relative mt-14">
                    <div aria-hidden="true" className="hidden md:block absolute left-[16.6%] right-[16.6%] top-[42px] h-px bg-white/[0.08]">
                        <motion.div style={{ scaleX: line }} className="h-full origin-left bg-gradient-to-r from-[#8069fb] via-[#4f7dff] to-[#38bdf8]" />
                    </div>
                    <div className="grid md:grid-cols-3 gap-4">
                        {[
                            [Wifi, '01', 'Connect', 'Run one command on any machine in your network — the Gateway Agent connects out. Or connect a cluster you already run.'],
                            [Zap, '02', 'Deploy', 'Enter the servers, pick the version and add-ons. Every step streams a live log; a failure comes with the reason and Resume.'],
                            [Activity, '03', 'Relax', 'Auto-healing, alerts on Telegram, Slack, Teams, WhatsApp or email, nightly backups and monthly compliance reports.']
                        ].map(([Icon, num, title, text], i) => (
                            <Reveal key={num} delay={i * .1}>
                                <div className="relative h-full rounded-3xl border border-white/[0.07] bg-gradient-to-b from-white/[0.04] to-transparent p-7 text-center md:text-left">
                                    <span className="relative z-10 mx-auto md:mx-0 grid place-items-center w-14 h-14 rounded-2xl border border-white/10 bg-[#0c0c11] shadow-[0_0_40px_-8px_rgba(128,105,251,.7)]">
                                        <Icon className="w-6 h-6 text-blue-200" />
                                    </span>
                                    <div className="mt-6 flex items-baseline gap-3 justify-center md:justify-start">
                                        <span className="kz-serif text-3xl text-white/25">{num}</span>
                                        <h3 className="text-xl font-semibold text-white">{title}</h3>
                                    </div>
                                    <p className="mt-2 text-sm leading-relaxed text-slate-400">{text}</p>
                                </div>
                            </Reveal>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── security ── */}
            <section id="security" className="relative mx-auto max-w-6xl px-4 mt-32 scroll-mt-28">
                <SpotlightCard className="p-8 sm:p-12" color="182,168,255">
                    <div className="grid lg:grid-cols-2 gap-10 items-center">
                        <div>
                            <div className="kz-eyebrow">Security & compliance</div>
                            <h2 className="mt-4 text-3xl sm:text-4xl font-semibold tracking-[-0.035em] gradient-text">Ready for the auditor. <span className="kz-serif aurora-text">Calm for the night shift.</span></h2>
                            <p className="mt-4 text-slate-400 leading-relaxed">A live scan maps every cluster to CERT-In Directions 2022, the DPDP Act, ISO/IEC 27001 and the CIS Kubernetes Benchmark — with a fix for each finding and a sealed report for your auditor.</p>
                            <div className="mt-6 flex flex-wrap gap-2">
                                {['CERT-In', 'DPDP 2023', 'ISO 27001', 'CIS Benchmark'].map(b => <span key={b} className="kz-chip text-slate-200"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />{b}</span>)}
                            </div>
                        </div>
                        <ul className="grid sm:grid-cols-2 gap-3">
                            {[
                                [Lock, 'Credentials encrypted', 'Server keys, tokens and cloud keys never shown again.'],
                                [Terminal, 'Just-in-time terminal', 'Time-limited, approved, every session recorded.'],
                                [GitBranch, 'Tamper-evident trail', 'Every change and sign-in, kept 400 days.'],
                                [RotateCcw, 'Two-person rule', 'Upgrades and restores can need a second admin.']
                            ].map(([Icon, t, d]) => (
                                <li key={t} className="rounded-2xl border border-white/[0.07] bg-black/20 p-5 transition-colors hover:border-white/15">
                                    <Icon className="w-5 h-5 text-blue-300" />
                                    <div className="mt-3 font-semibold text-white text-sm">{t}</div>
                                    <div className="mt-1 text-[13px] text-slate-400 leading-relaxed">{d}</div>
                                </li>
                            ))}
                        </ul>
                    </div>
                </SpotlightCard>
            </section>

            {/* ── final call ── */}
            <section className="relative mx-auto max-w-5xl px-4 mt-36">
                <div className="kz-conic relative rounded-[36px] p-px">
                    <div className="relative overflow-hidden rounded-[35px] bg-[#09090d] px-6 py-16 sm:py-20 text-center">
                        <div aria-hidden="true" className="absolute inset-x-0 -top-24 h-80 bg-[radial-gradient(closest-side,rgba(128,105,251,.35),transparent)] blur-2xl" />
                        <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,.06)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_60%_60%_at_50%_40%,#000,transparent)]" />
                        <Reveal className="relative">
                            <Sparkles className="mx-auto w-6 h-6 text-blue-300" />
                            <h2 className="mt-6 text-5xl sm:text-7xl font-semibold tracking-[-0.05em] gradient-text">Your servers.<br /><span className="kz-serif aurora-text">Our calm.</span></h2>
                            <p className="mt-5 text-slate-400">Start free with one cluster. No card needed.</p>
                            <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center">
                                <Link to="/login?mode=register" className="kz-btn-light kz-shine !rounded-full !px-7 !py-3.5 text-[15px]">Create your workspace <ArrowRight className="w-4 h-4" /></Link>
                                <Link to="/login" className="kz-btn-ghost !rounded-full !px-7 !py-3.5 text-[15px]">Sign in</Link>
                            </div>
                        </Reveal>
                    </div>
                </div>
            </section>

            <footer className="relative mt-32 border-t border-white/[0.06]">
                <div className="mx-auto max-w-6xl px-4 py-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                    <div className="lg:col-span-2">
                        <div className="flex items-center gap-2"><LogoMark className="w-7 h-7" /><LogoWord className="text-base" /></div>
                        <p className="mt-3 max-w-sm text-slate-500 leading-relaxed">Production Kubernetes on servers you own — installed, upgraded, backed up, healed and audited.</p>
                        <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/[0.07] px-3 py-1.5 text-xs text-slate-400"><Gauge className="w-3.5 h-3.5 text-emerald-400" />All systems normal</div>
                    </div>
                    <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Product</div>
                        <ul className="mt-4 space-y-2.5 text-slate-400">
                            {[['#product', 'Live demo'], ['#features', 'Features'], ['#connect', 'Connect any cluster'], ['#addons', 'Add-ons']].map(([h, l]) => <li key={h}><a href={h} className="hover:text-white transition-colors">{l}</a></li>)}
                        </ul>
                    </div>
                    <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Get started</div>
                        <ul className="mt-4 space-y-2.5 text-slate-400">
                            <li><Link to="/login?mode=register" className="hover:text-white transition-colors">Create a workspace</Link></li>
                            <li><Link to="/login" className="hover:text-white transition-colors">Sign in</Link></li>
                            <li><a href="#security" className="hover:text-white transition-colors">Security</a></li>
                            <li><a href="#how" className="hover:text-white transition-colors">How it works</a></li>
                        </ul>
                    </div>
                </div>
                <div className="border-t border-white/[0.05]">
                    <div className="mx-auto max-w-6xl px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-600">
                        <span>© {new Date().getFullYear()} KubeEZ — Kubernetes made easy</span>
                        <span className="inline-flex items-center gap-1.5"><Compass className="w-3.5 h-3.5" />Made for platform teams who like to sleep</span>
                    </div>
                </div>
            </footer>
        </div>
    )
}
