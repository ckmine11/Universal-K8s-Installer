import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    Rocket, Server, Zap, Shield, Network, BarChart3,
    Package, ArrowRight, ChevronRight, Star, Check,
    Terminal, GitBranch, Globe, Play, Cpu
} from 'lucide-react'

// ─── Animated Counter ─────────────────────────────────────────────
function Counter({ target, suffix = '' }) {
    const [count, setCount] = useState(0)
    const ref = useRef(null)
    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                let start = 0
                const step = target / 60
                const timer = setInterval(() => {
                    start += step
                    if (start >= target) { setCount(target); clearInterval(timer) }
                    else setCount(Math.floor(start))
                }, 16)
            }
        }, { threshold: 0.5 })
        if (ref.current) observer.observe(ref.current)
        return () => observer.disconnect()
    }, [target])
    return <span ref={ref}>{count}{suffix}</span>
}

// ─── Feature Card ─────────────────────────────────────────────────
function FeatureCard({ icon: Icon, title, desc, gradient, delay = 0 }) {
    return (
        <div
            className="group relative p-8 rounded-3xl bg-white/[0.03] border border-white/5 hover:border-white/15 transition-all duration-500 overflow-hidden"
            style={{ animationDelay: `${delay}ms` }}
        >
            <div className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
            <div className="relative z-10">
                <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${gradient} opacity-100 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300 shadow-lg`}>
                    <Icon className="w-7 h-7 text-white" />
                </div>
                <h3 className="text-xl font-black text-white mb-3 tracking-tight">{title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed group-hover:text-slate-300 transition-colors">{desc}</p>
            </div>
        </div>
    )
}

// ─── Terminal Demo ────────────────────────────────────────────────
function TerminalDemo() {
    const lines = [
        { delay: 0,    color: 'text-slate-500', text: '$ kubeez init --cluster production' },
        { delay: 400,  color: 'text-blue-400',  text: '✓ Connecting to nodes via SSH...' },
        { delay: 800,  color: 'text-slate-300',  text: '  → master-01: 192.168.1.10 [OK]' },
        { delay: 1100, color: 'text-slate-300',  text: '  → worker-01:  192.168.1.11 [OK]' },
        { delay: 1400, color: 'text-slate-300',  text: '  → worker-02:  192.168.1.12 [OK]' },
        { delay: 1800, color: 'text-blue-400',  text: '✓ Pre-flight checks passed' },
        { delay: 2100, color: 'text-blue-400',  text: '✓ Installing containerd runtime...' },
        { delay: 2500, color: 'text-blue-400',  text: '✓ Installing kubeadm, kubelet...' },
        { delay: 2900, color: 'text-blue-400',  text: '✓ Initializing control plane...' },
        { delay: 3300, color: 'text-blue-400',  text: '✓ Installing Flannel CNI...' },
        { delay: 3600, color: 'text-emerald-400', text: '🚀 Cluster READY! Endpoint: https://192.168.1.10:6443' },
    ]
    const [visibleLines, setVisibleLines] = useState([])
    useEffect(() => {
        lines.forEach((line, i) => {
            setTimeout(() => {
                setVisibleLines(prev => [...prev, i])
            }, line.delay + 800)
        })
    }, [])
    return (
        <div className="relative rounded-2xl bg-slate-950 border border-white/10 overflow-hidden shadow-2xl shadow-black/50">
            {/* Window controls */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5 bg-white/[0.02]">
                <div className="w-3 h-3 rounded-full bg-red-500/70" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
                <div className="w-3 h-3 rounded-full bg-emerald-500/70" />
                <span className="ml-3 text-xs text-slate-500 font-mono">kubeez terminal</span>
            </div>
            <div className="p-6 font-mono text-sm space-y-2 min-h-[280px]">
                {lines.map((line, i) => (
                    <div
                        key={i}
                        className={`transition-all duration-300 ${visibleLines.includes(i) ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-2'} ${line.color}`}
                    >
                        {line.text}
                    </div>
                ))}
                {visibleLines.length === lines.length && (
                    <div className="flex items-center gap-1 text-white mt-2">
                        <span>$</span>
                        <span className="w-2 h-4 bg-white animate-pulse rounded-sm" />
                    </div>
                )}
            </div>
        </div>
    )
}

// ─── Main Landing Page ────────────────────────────────────────────
export default function LandingPage() {
    const navigate = useNavigate()

    const goToApp = () => navigate('/login')

    const features = [
        { icon: Terminal, title: 'Zero Config Deploy', desc: 'SSH credentials provide — baaki sab KubeEZ karta hai. Automated preflight checks, runtime install, control plane init.', gradient: 'from-blue-500/20 to-cyan-500/10' },
        { icon: Network, title: 'Multi-OS Support', desc: 'Ubuntu, Debian, CentOS 7/8/9, RHEL, Rocky Linux — sabhi pe ek jaisa experience. CentOS 7 EOL bhi handle hota hai.', gradient: 'from-emerald-500/20 to-teal-500/10' },
        { icon: Zap, title: 'Intelligent Scale', desc: 'Ek click mein nodes add karo bina cluster downtime ke. HA multi-master setup bhi supported hai.', gradient: 'from-purple-500/20 to-violet-500/10' },
        { icon: Shield, title: 'Auto-Healing', desc: 'DNS failures, swap issues, port conflicts — sab automatically detect aur fix hote hain. Production-grade reliability.', gradient: 'from-orange-500/20 to-amber-500/10' },
        { icon: BarChart3, title: 'Live Monitoring', desc: 'Real-time CPU, RAM, disk, pods status. 3D cluster topology visualization. Incident detection with auto-remediation.', gradient: 'from-pink-500/20 to-rose-500/10' },
        { icon: Package, title: 'Add-on Marketplace', desc: 'Nginx Ingress, Prometheus, ArgoCD, Longhorn, Cert-Manager — ek click install. Production-ready configurations.', gradient: 'from-indigo-500/20 to-blue-500/10' },
    ]

    const steps = [
        { num: '01', title: 'Connect Nodes', desc: 'Master aur worker nodes ke IP aur SSH credentials enter karo.', icon: Server },
        { num: '02', title: 'Auto Provision', desc: 'KubeEZ automatically sab configure karta hai — runtime, networking, control plane.', icon: Zap },
        { num: '03', title: 'Manage & Scale', desc: 'Dashboard se clusters manage karo, add-ons lagao, nodes badhao.', icon: BarChart3 },
    ]

    return (
        <div className="min-h-screen bg-slate-950 text-white overflow-x-hidden">

            {/* ─── NAVBAR ─────────────────────────────────────────── */}
            <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-slate-950/80 backdrop-blur-xl">
                <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center">
                            <Cpu className="w-4 h-4 text-white" />
                        </div>
                        <div>
                            <span className="font-black text-white tracking-tight">KubeEZ</span>
                            <span className="ml-2 text-[10px] text-blue-400 font-bold uppercase tracking-widest">v2.1.0</span>
                        </div>
                    </div>
                    <div className="hidden md:flex items-center gap-8 text-sm text-slate-400">
                        <a href="#features" className="hover:text-white transition-colors">Features</a>
                        <a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a>
                        <a href="#pricing" onClick={(e) => { e.preventDefault(); navigate('/pricing') }} className="hover:text-white transition-colors">Pricing</a>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={goToApp}
                            className="px-4 py-2 text-sm font-bold text-slate-300 hover:text-white transition-colors"
                        >
                            Login
                        </button>
                        <button
                            onClick={goToApp}
                            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-black transition-all active:scale-95 flex items-center gap-2"
                        >
                            Get Started <ArrowRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </nav>

            {/* ─── HERO ────────────────────────────────────────────── */}
            <section className="relative pt-32 pb-24 px-6 overflow-hidden">
                {/* Background glows */}
                <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-blue-500/10 rounded-full blur-[120px] pointer-events-none" />
                <div className="absolute top-40 left-1/4 w-96 h-96 bg-purple-500/8 rounded-full blur-[100px] pointer-events-none" />
                <div className="absolute top-40 right-1/4 w-96 h-96 bg-cyan-500/8 rounded-full blur-[100px] pointer-events-none" />

                <div className="max-w-6xl mx-auto relative z-10">
                    {/* Badge */}
                    <div className="flex justify-center mb-8">
                        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-black uppercase tracking-widest">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                            Universal Kubernetes Installer — Production Ready
                        </div>
                    </div>

                    {/* Headline */}
                    <h1 className="text-center text-5xl md:text-7xl font-black tracking-tight leading-[1.05] mb-8">
                        <span className="text-white">Kubernetes Deploy karo</span>
                        <br />
                        <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-blue-500 bg-clip-text text-transparent">
                            Bina Kisi Tension Ke
                        </span>
                    </h1>

                    <p className="text-center text-xl text-slate-400 max-w-2xl mx-auto mb-12 leading-relaxed">
                        Sirf SSH credentials do — KubeEZ baaki sab karta hai. Multi-OS support, auto-healing, 
                        live monitoring aur one-click scaling ke saath.
                    </p>

                    {/* CTA Buttons */}
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
                        <button
                            onClick={goToApp}
                            className="group relative flex items-center gap-3 px-8 py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black text-base transition-all duration-300 active:scale-[0.97] shadow-2xl shadow-blue-600/30 hover:shadow-blue-500/40"
                        >
                            <Rocket className="w-5 h-5 group-hover:animate-pulse" />
                            Launch Dashboard
                            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                        </button>
                        <button
                            onClick={() => document.getElementById('how-it-works').scrollIntoView({ behavior: 'smooth' })}
                            className="flex items-center gap-3 px-8 py-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-white rounded-2xl font-bold text-base transition-all duration-300"
                        >
                            <Play className="w-5 h-5" />
                            See How It Works
                        </button>
                    </div>

                    {/* Terminal Demo */}
                    <div className="max-w-3xl mx-auto">
                        <TerminalDemo />
                    </div>
                </div>
            </section>

            {/* ─── STATS ───────────────────────────────────────────── */}
            <section className="border-y border-white/5 bg-white/[0.02] py-14 px-6">
                <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
                    {[
                        { target: 5, suffix: '+', label: 'OS Supported' },
                        { target: 20, suffix: '+', label: 'K8s Versions' },
                        { target: 99, suffix: '%', label: 'Auto-Heal Rate' },
                        { target: 6, suffix: '+', label: 'Add-ons Ready' },
                    ].map((stat, i) => (
                        <div key={i}>
                            <div className="text-4xl font-black text-white mb-2">
                                <Counter target={stat.target} suffix={stat.suffix} />
                            </div>
                            <div className="text-xs text-slate-500 uppercase tracking-widest font-bold">{stat.label}</div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ─── FEATURES ────────────────────────────────────────── */}
            <section id="features" className="py-24 px-6">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16">
                        <h2 className="text-4xl font-black text-white mb-4 tracking-tight">
                            Enterprise Features,<br />
                            <span className="text-slate-400">Zero Complexity</span>
                        </h2>
                        <p className="text-slate-500 max-w-lg mx-auto">
                            Sab kuch built-in — alag alag tools install karne ki zaroorat nahi
                        </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {features.map((f, i) => (
                            <FeatureCard key={i} {...f} delay={i * 100} />
                        ))}
                    </div>
                </div>
            </section>

            {/* ─── HOW IT WORKS ─────────────────────────────────────── */}
            <section id="how-it-works" className="py-24 px-6 bg-white/[0.015]">
                <div className="max-w-5xl mx-auto">
                    <div className="text-center mb-16">
                        <h2 className="text-4xl font-black text-white mb-4 tracking-tight">3 Steps Mein Ready</h2>
                        <p className="text-slate-500">Configure → Deploy → Manage — itna hi</p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
                        {/* Connecting line */}
                        <div className="absolute top-16 left-[20%] right-[20%] h-px bg-gradient-to-r from-blue-500/0 via-blue-500/50 to-blue-500/0 hidden md:block" />

                        {steps.map((step, i) => (
                            <div key={i} className="relative flex flex-col items-center text-center group">
                                <div className="relative w-32 h-32 mb-8">
                                    <div className="absolute inset-0 bg-blue-500/10 rounded-3xl blur-xl group-hover:bg-blue-500/20 transition-all duration-500" />
                                    <div className="relative w-full h-full bg-gradient-to-br from-slate-900 to-slate-950 rounded-3xl border border-blue-500/20 group-hover:border-blue-500/50 flex flex-col items-center justify-center transition-all duration-300 group-hover:scale-105">
                                        <step.icon className="w-10 h-10 text-blue-400 mb-2" />
                                        <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest">{step.num}</span>
                                    </div>
                                </div>
                                <h3 className="text-xl font-black text-white mb-3">{step.title}</h3>
                                <p className="text-slate-400 text-sm leading-relaxed max-w-[220px]">{step.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ─── OS SUPPORT BANNER ────────────────────────────────── */}
            <section className="py-16 px-6">
                <div className="max-w-4xl mx-auto">
                    <div className="p-8 rounded-3xl bg-gradient-to-br from-blue-500/5 via-transparent to-purple-500/5 border border-white/5">
                        <div className="text-center mb-8">
                            <h3 className="text-2xl font-black text-white mb-2">Sabhi OS pe Kaam Karta Hai</h3>
                            <p className="text-slate-500 text-sm">CentOS 7 EOL, RHEL 8/9, Rocky, Alma, Ubuntu — sab supported</p>
                        </div>
                        <div className="flex flex-wrap justify-center gap-4">
                            {[
                                { name: 'Ubuntu 20/22/24', color: 'text-orange-400 border-orange-500/20 bg-orange-500/5' },
                                { name: 'CentOS 7 (EOL)', color: 'text-purple-400 border-purple-500/20 bg-purple-500/5' },
                                { name: 'RHEL 8/9', color: 'text-red-400 border-red-500/20 bg-red-500/5' },
                                { name: 'Rocky Linux', color: 'text-green-400 border-green-500/20 bg-green-500/5' },
                                { name: 'AlmaLinux', color: 'text-blue-400 border-blue-500/20 bg-blue-500/5' },
                                { name: 'Debian 11/12', color: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/5' },
                            ].map((os, i) => (
                                <div key={i} className={`flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-bold ${os.color}`}>
                                    <Check className="w-4 h-4" />
                                    {os.name}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {/* ─── CTA SECTION ─────────────────────────────────────── */}
            <section className="py-24 px-6">
                <div className="max-w-4xl mx-auto text-center relative">
                    <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-cyan-500/10 rounded-[40px] blur-3xl" />
                    <div className="relative p-16 rounded-[40px] bg-gradient-to-br from-white/[0.04] to-white/[0.01] border border-white/10">
                        <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-2xl shadow-blue-500/30">
                            <Rocket className="w-8 h-8 text-white" />
                        </div>
                        <h2 className="text-4xl md:text-5xl font-black text-white mb-6 tracking-tight">
                            Ready to Deploy?
                        </h2>
                        <p className="text-xl text-slate-400 mb-10 max-w-xl mx-auto">
                            Ab koi SSH scripts manually chalane ki zaroorat nahi. KubeEZ se minutes mein production-grade Kubernetes cluster ready karo.
                        </p>
                        <button
                            onClick={goToApp}
                            className="group inline-flex items-center gap-3 px-10 py-5 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white rounded-2xl font-black text-lg transition-all duration-300 active:scale-[0.97] shadow-2xl shadow-blue-600/30 hover:shadow-blue-500/40"
                        >
                            <Rocket className="w-6 h-6 group-hover:animate-pulse" />
                            Launch Dashboard
                            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                        </button>
                    </div>
                </div>
            </section>

            {/* ─── FOOTER ──────────────────────────────────────────── */}
            <footer className="border-t border-white/5 py-10 px-6">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                        <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center">
                            <Cpu className="w-3.5 h-3.5 text-white" />
                        </div>
                        <span className="font-black text-white">KubeEZ</span>
                        <span className="text-slate-600 text-sm">© 2025</span>
                    </div>
                    <div className="flex items-center gap-6 text-sm text-slate-500">
                        <span className="flex items-center gap-1.5">
                            <Globe className="w-3.5 h-3.5" />
                            k8scluster.space
                        </span>
                        <span className="flex items-center gap-1.5">
                            <GitBranch className="w-3.5 h-3.5" />
                            v2.1.0 Production
                        </span>
                    </div>
                </div>
            </footer>
        </div>
    )
}
