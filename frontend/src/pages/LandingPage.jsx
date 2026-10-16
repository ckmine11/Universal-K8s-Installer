import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
    ArrowRight, ArrowUpCircle, Compass, DatabaseBackup, HeartPulse, Puzzle, ShieldCheck, Wifi, Terminal,
    Server, CheckCircle2, Sparkles, Lock, Zap, Activity, GitBranch, Cloud
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

const fade = { hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0, transition: { duration: .8, ease: [.16, 1, .3, 1] } } }
const Reveal = ({ children, delay = 0, className = '' }) => (
    <motion.div className={className} variants={fade} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }} transition={{ delay }}>{children}</motion.div>
)

// ── a live-looking console, built from real KubeEZ screens ─────────────────
const LOG = [
    ['text-slate-500', '$ kubeez deploy prod-mumbai --nodes 3+5 --k8s 1.36'],
    ['text-blue-300', '✓ Pre-flight: 8 nodes reachable, OS, CPU, memory, ports'],
    ['text-blue-300', '✓ containerd 2.1 · kubeadm · kubelet installed'],
    ['text-blue-300', '✓ Control plane up — virtual IP 10.0.0.50 (kube-vip)'],
    ['text-blue-300', '✓ 5 workers joined · Calico ready'],
    ['text-sky-300', '✓ Add-ons: Ingress, Explorer, Prometheus + Grafana'],
    ['text-emerald-300', '● Cluster ready — https://10.0.0.50:6443'],
]

function ConsolePreview() {
    const [n, setN] = useState(0)
    useEffect(() => {
        if (n >= LOG.length) return
        const t = setTimeout(() => setN(v => v + 1), n === 0 ? 900 : 650)
        return () => clearTimeout(t)
    }, [n])
    return (
        <div className="relative rounded-[28px] border border-white/10 bg-[#0c0c11]/90 backdrop-blur-xl shadow-[0_60px_160px_-40px_rgba(128,105,251,.45),inset_0_1px_0_rgba(255,255,255,.08)] overflow-hidden">
            <BorderBeam size={260} duration={10} colorFrom="#b6a8ff" colorTo="#38bdf8" borderThickness={1} />
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-white/[0.06]">
                <span className="w-3 h-3 rounded-full bg-white/10" /><span className="w-3 h-3 rounded-full bg-white/10" /><span className="w-3 h-3 rounded-full bg-white/10" />
                <span className="ml-3 text-xs text-slate-500 font-mono">console.kubeez · prod-mumbai</span>
            </div>
            <div className="grid md:grid-cols-5">
                <div className="md:col-span-3 p-6 font-mono text-[12.5px] leading-7 min-h-[300px] border-b md:border-b-0 md:border-r border-white/[0.06]">
                    {LOG.map(([c, t], i) => (
                        <div key={i} className={`${c} transition-all duration-500 ${i < n ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}`}>{t}</div>
                    ))}
                    {n >= LOG.length && <div className="flex items-center gap-1.5 text-white"><span>$</span><span className="w-2 h-4 bg-white/80 animate-pulse rounded-sm" /></div>}
                </div>
                <div className="md:col-span-2 p-6 space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Health score</div>
                            <div className="mt-1 text-4xl font-semibold tracking-tight text-white">96<span className="text-lg text-slate-500">/100</span></div>
                        </div>
                        <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90">
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="3" />
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke="url(#lp)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${0.96 * 97.4} 97.4`} />
                            <defs><linearGradient id="lp"><stop offset="0" stopColor="#8069fb" /><stop offset="1" stopColor="#38bdf8" /></linearGradient></defs>
                        </svg>
                    </div>
                    {[['Control planes', '3 / 3 ready', 'bg-emerald-400'], ['Workers', '5 / 5 ready', 'bg-emerald-400'], ['Last snapshot', '12 min ago · offsite ✓', 'bg-blue-400'], ['Compliance', 'CERT-In 92 · CIS 88', 'bg-sky-400']].map(([k, v, dot]) => (
                        <div key={k} className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                            <span className="text-sm text-slate-400">{k}</span>
                            <span className="flex items-center gap-2 text-sm text-slate-200"><span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{v}</span>
                        </div>
                    ))}
                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-[13px] text-emerald-200 flex items-start gap-2">
                        <HeartPulse className="w-4 h-4 mt-0.5 shrink-0" /> worker-4 went NotReady — restarted kubelet, back in 41 s.
                    </div>
                </div>
            </div>
        </div>
    )
}

const FEATURES = [
    { Icon: Server, title: 'Deploy in one flow', text: 'IPs and an SSH login — KubeEZ checks every server, installs Kubernetes 1.27 – 1.37, joins workers and sets up a highly available API with a virtual IP.', span: 'md:col-span-2', color: '128,105,251' },
    { Icon: ArrowUpCircle, title: 'Upgrades without fear', text: 'A safety check finds what breaks first, a snapshot is taken, then one version at a time.', color: '79,125,255' },
    { Icon: DatabaseBackup, title: 'Backups you can trust', text: 'Verified snapshots, a preview of every restore, one-click undo, encrypted offsite copies and full disaster recovery.', color: '56,189,248' },
    { Icon: HeartPulse, title: 'It heals itself', text: 'Nodes down, disks full, crash loops — fixed automatically, explained when they cannot be.', color: '52,211,153' },
    { Icon: Compass, title: 'Explorer built in', text: 'Every resource, log, topology and change — with your KubeEZ login, no open port.', color: '125,211,252' },
    { Icon: ShieldCheck, title: 'Audit-ready, always', text: 'CERT-In, DPDP, ISO 27001 and CIS checks with a sealed PDF report, a tamper-evident audit trail and recorded terminal sessions.', span: 'md:col-span-2', color: '182,168,255' },
    { Icon: Wifi, title: 'No inbound ports', text: 'The Gateway Agent connects out from your network. Private data centres, no VPN.', color: '128,105,251' },
    { Icon: Puzzle, title: '25+ add-ons, managed', text: 'Monitoring, storage, GitOps, registry, secrets, policies, runtime security, logging — install, configure, update and repair from one place, and know when a new version is out.', span: 'md:col-span-3', color: '79,125,255' },
]

export default function LandingPage() {
    const [scrolled, setScrolled] = useState(false)
    useEffect(() => {
        const on = () => setScrolled(window.scrollY > 24)
        on(); window.addEventListener('scroll', on, { passive: true })
        return () => window.removeEventListener('scroll', on)
    }, [])
    useEffect(() => { document.title = 'KubeEZ — Kubernetes on your own servers' }, [])

    return (
        <div className="relative min-h-screen bg-[#060608] text-white overflow-x-clip">
            {/* ── light ── */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[1100px] overflow-hidden">
                <div className="absolute left-1/2 -top-[340px] -translate-x-1/2 w-[1300px] h-[800px] rounded-full bg-[radial-gradient(closest-side,rgba(128,105,251,.32),transparent)] blur-2xl" />
                <div className="absolute left-[12%] top-[120px] w-[520px] h-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(79,125,255,.16),transparent)] blur-2xl animate-aurora-1" />
                <div className="absolute right-[8%] top-[60px] w-[520px] h-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(56,189,248,.12),transparent)] blur-2xl animate-aurora-2" />
                <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,.07)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000_10%,transparent_70%)]" />
            </div>

            {/* ── nav ── */}
            <header className="fixed top-4 inset-x-0 z-50 px-4">
                <nav className={`mx-auto max-w-5xl flex items-center gap-2 rounded-full border px-3 py-2 transition-all duration-500 ${scrolled ? 'border-white/10 bg-[#0c0c11]/75 backdrop-blur-2xl shadow-[0_20px_60px_-20px_rgba(0,0,0,.8)]' : 'border-transparent bg-transparent'}`}>
                    <Link to="/" className="flex items-center gap-2 pl-2 pr-3" aria-label="KubeEZ">
                        <LogoMark className="w-8 h-8 drop-shadow-[0_0_16px_rgba(128,105,251,.6)]" />
                        <LogoWord className="text-[17px]" />
                    </Link>
                    <div className="hidden md:flex items-center gap-1 text-sm text-slate-400">
                        {[['#features', 'Features'], ['#how', 'How it works'], ['#addons', 'Add-ons'], ['#security', 'Security']].map(([h, l]) => (
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
            <section className="relative pt-40 sm:pt-48 px-4 text-center">
                <Reveal>
                    <a href="#security" className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] backdrop-blur px-1.5 py-1.5 pr-4 text-xs text-slate-300 hover:border-white/20 transition">
                        <span className="rounded-full bg-blue-500/20 border border-blue-400/30 px-2 py-0.5 text-[11px] font-semibold text-blue-200">New</span>
                        <ShinyText size="xs" baseColor="#b9b6cc" shineColor="#ffffff" speed={3}>Compliance Center for CERT-In &amp; DPDP</ShinyText>
                        <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                    </a>
                </Reveal>
                <Reveal delay={.08}>
                    <h1 className="mx-auto mt-8 max-w-6xl text-[42px] leading-[1.02] sm:text-7xl lg:text-[84px] font-semibold tracking-[-0.045em] gradient-text">
                        Kubernetes on your servers,<br />
                        <span className="kz-serif aurora-text pr-2 text-[52px] sm:text-[84px] lg:text-[104px] leading-none">calm as a cloud.</span>
                    </h1>
                </Reveal>
                <Reveal delay={.16}>
                    <p className="mx-auto mt-7 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed">
                        KubeEZ installs production Kubernetes on servers you own — then upgrades, backs up, heals and audits it for you. One console, a live log for every step, and a clear fix when something goes wrong.
                    </p>
                </Reveal>
                <Reveal delay={.24}>
                    <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
                        <Link to="/login?mode=register" className="kz-btn-light !rounded-full !px-6 !py-3.5 text-[15px] group">
                            Start free <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                        </Link>
                        <Link to="/login" className="kz-btn-ghost !rounded-full !px-6 !py-3.5 text-[15px]">Sign in to your console</Link>
                    </div>
                    <p className="mt-5 text-xs text-slate-500">Bare metal · VMs · any cloud — Ubuntu, Debian, RHEL, Rocky, Alma, Fedora, Amazon Linux</p>
                </Reveal>

                {/* globe + console */}
                <div className="relative mx-auto mt-16 max-w-6xl">
                    <div aria-hidden="true" className="absolute left-1/2 -translate-x-1/2 -top-24 w-[760px] max-w-[120vw] h-[760px] opacity-70 [mask-image:radial-gradient(closest-side,#000_55%,transparent)]">
                        <Suspense fallback={null}>
                            <Globe className="!min-h-0 h-full" dark={1} diffuse={1.1} mapSamples={16000} mapBrightness={5} scale={1}
                                baseColor={[0.22, 0.2, 0.32]} markerColor={[0.62, 0.55, 1]} glowColor={[0.32, 0.27, 0.62]}
                                markers={MARKERS} enableZoom={false} autoRotateSpeed={0.0025} theta={0.3} />
                        </Suspense>
                    </div>
                    <Reveal delay={.3} className="relative pt-[300px] sm:pt-[340px] text-left">
                        <ConsolePreview />
                    </Reveal>
                </div>
            </section>

            {/* ── add-on marquee ── */}
            <section id="addons" className="relative mt-24 scroll-mt-28">
                <p className="text-center text-xs uppercase tracking-[0.25em] text-slate-500">25+ add-ons, installed and kept up to date</p>
                <div className="mt-7 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
                    <div className="flex w-max gap-3 animate-marquee hover:[animation-play-state:paused]">
                        {[...ADDONS, ...ADDONS].map((a, i) => (
                            <span key={i} className="shrink-0 rounded-full border border-white/[0.07] bg-white/[0.03] px-5 py-2.5 text-sm text-slate-300">{a}</span>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── features (bento) ── */}
            <section id="features" className="relative mx-auto max-w-6xl px-4 mt-32 scroll-mt-28">
                <Reveal className="text-center">
                    <div className="kz-eyebrow justify-center">Everything day 2 needs</div>
                    <h2 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-[-0.04em] gradient-text">From the first server <span className="kz-serif aurora-text">to the audit.</span></h2>
                </Reveal>
                <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-4">
                    {FEATURES.map(({ Icon, title, text, span = '', color }, i) => (
                        <Reveal key={title} delay={i * .04} className={span}>
                            <SpotlightCard color={color} className="h-full p-7">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center border border-white/10 bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,.08)]" style={{ boxShadow: `0 10px 30px -12px rgba(${color},.7), inset 0 1px 0 rgba(255,255,255,.08)` }}>
                                    <Icon className="w-5 h-5" style={{ color: `rgb(${color})` }} />
                                </div>
                                <h3 className="mt-6 text-lg font-semibold tracking-tight text-white">{title}</h3>
                                <p className="mt-2 text-sm leading-relaxed text-slate-400">{text}</p>
                            </SpotlightCard>
                        </Reveal>
                    ))}
                </div>
            </section>

            {/* ── numbers ── */}
            <section className="relative mx-auto max-w-6xl px-4 mt-28">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-px overflow-hidden rounded-3xl border border-white/[0.07] bg-white/[0.06]">
                    {[[25, '+', 'managed add-ons'], [11, '', 'Kubernetes versions, 1.27 – 1.37'], [30, '', 'compliance controls'], [0, '', 'inbound ports needed']].map(([v, s, l]) => (
                        <div key={l} className="bg-[#0b0b0f] px-6 py-9 text-center">
                            <div className="text-4xl sm:text-5xl font-semibold tracking-tight text-white">
                                <CountUp value={v} suffix={s} duration={2} triggerOnView colorScheme="custom" />
                            </div>
                            <div className="mt-2 text-sm text-slate-500">{l}</div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── how it works ── */}
            <section id="how" className="relative mx-auto max-w-6xl px-4 mt-32 scroll-mt-28">
                <Reveal className="text-center">
                    <div className="kz-eyebrow justify-center">How it works</div>
                    <h2 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-[-0.04em] gradient-text">Three steps. <span className="kz-serif aurora-text">Then it runs itself.</span></h2>
                </Reveal>
                <div className="mt-14 grid md:grid-cols-3 gap-4">
                    {[
                        [Wifi, '01', 'Connect', 'Run one command on any machine in your network — the Gateway Agent connects out. Or let a self-hosted KubeEZ reach the servers directly.'],
                        [Zap, '02', 'Deploy', 'Enter the servers, pick the version and add-ons. Every step streams a live log; a failure comes with the reason and Resume.'],
                        [Activity, '03', 'Relax', 'Auto-healing, alerts on Telegram, Slack, Teams, WhatsApp or email, nightly backups and monthly compliance reports.']
                    ].map(([Icon, num, title, text], i) => (
                        <Reveal key={num} delay={i * .08}>
                            <div className="relative h-full rounded-3xl border border-white/[0.07] bg-gradient-to-b from-white/[0.04] to-transparent p-7">
                                <div className="flex items-center justify-between">
                                    <span className="kz-serif text-5xl text-white/20">{num}</span>
                                    <Icon className="w-5 h-5 text-blue-300" />
                                </div>
                                <h3 className="mt-6 text-xl font-semibold text-white">{title}</h3>
                                <p className="mt-2 text-sm leading-relaxed text-slate-400">{text}</p>
                            </div>
                        </Reveal>
                    ))}
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
                                [Lock, 'Credentials encrypted', 'Server keys, tokens and storage keys never shown again.'],
                                [Terminal, 'Just-in-time terminal', 'Time-limited, approved, every session recorded.'],
                                [GitBranch, 'Tamper-evident trail', 'Every change and sign-in, kept 400 days.'],
                                [Cloud, 'Your keys, your backups', 'Offsite copies encrypted with a key you hold.']
                            ].map(([Icon, t, d]) => (
                                <li key={t} className="rounded-2xl border border-white/[0.07] bg-black/20 p-5">
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
            <section className="relative mx-auto max-w-4xl px-4 mt-32 text-center">
                <div aria-hidden="true" className="absolute inset-x-0 -top-20 h-80 bg-[radial-gradient(closest-side,rgba(128,105,251,.28),transparent)] blur-2xl" />
                <Reveal className="relative">
                    <Sparkles className="mx-auto w-6 h-6 text-blue-300" />
                    <h2 className="mt-6 text-5xl sm:text-6xl font-semibold tracking-[-0.045em] gradient-text">Your servers.<br /><span className="kz-serif aurora-text">Our calm.</span></h2>
                    <p className="mt-5 text-slate-400">Start free with one cluster. No card needed.</p>
                    <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center">
                        <Link to="/login?mode=register" className="kz-btn-light !rounded-full !px-7 !py-3.5 text-[15px]">Create your workspace <ArrowRight className="w-4 h-4" /></Link>
                        <Link to="/login" className="kz-btn-ghost !rounded-full !px-7 !py-3.5 text-[15px]">Sign in</Link>
                    </div>
                </Reveal>
            </section>

            <footer className="relative mt-32 border-t border-white/[0.06]">
                <div className="mx-auto max-w-6xl px-4 py-10 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-500">
                    <div className="flex items-center gap-2"><LogoMark className="w-6 h-6" /><span>KubeEZ — Kubernetes made easy</span></div>
                    <div className="flex items-center gap-5">
                        <a href="#features" className="hover:text-white">Features</a>
                        <a href="#security" className="hover:text-white">Security</a>
                        <Link to="/login" className="hover:text-white">Sign in</Link>
                    </div>
                </div>
            </footer>
        </div>
    )
}
