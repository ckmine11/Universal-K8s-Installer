import { useState } from 'react'
import { CheckCircle2, Zap, Shield, ArrowRight, X, Loader2, Mail } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../context/AuthContext'

export default function Pricing() {
    const navigate = useNavigate()
    const [loading, setLoading] = useState(false)

    const handleUpgrade = async (planId) => {
        setLoading(true)
        try {
            const res = await apiFetch('/api/stripe/create-checkout-session', {
                method: 'POST',
                body: JSON.stringify({ planId })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to start checkout')
            window.location.href = data.url
        } catch (err) {
            alert(`Error: ${err.message}`)
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen pt-24 pb-20 px-4">

            {/* Header */}
            <div className="max-w-5xl mx-auto text-center mb-16 relative">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-blue-500/20 rounded-full blur-[120px] pointer-events-none" />
                <h1 className="text-4xl md:text-5xl font-black text-white uppercase tracking-tight mb-4 relative z-10">
                    Simple Pricing
                </h1>
                <p className="text-lg text-slate-400 max-w-2xl mx-auto relative z-10">
                    Production Kubernetes on any VPS — no DevOps engineer needed.
                    Start free, scale when ready.
                </p>
            </div>

            {/* 3-tier grid */}
            <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-6 relative z-10 items-start">

                {/* FREE */}
                <div className="glass rounded-[32px] p-8 border border-white/5 flex flex-col">
                    <div className="mb-8">
                        <div className="inline-flex px-3 py-1 rounded-full bg-slate-500/10 border border-slate-500/20 text-slate-400 text-xs font-black uppercase tracking-widest mb-5">
                            Free
                        </div>
                        <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-4xl font-black text-white">$0</span>
                            <span className="text-slate-500 text-sm">/month</span>
                        </div>
                        <p className="text-slate-500 text-sm">For learning and side projects.</p>
                    </div>

                    <div className="space-y-3 mb-8 flex-1">
                        <Feature text="1 Kubernetes Cluster" />
                        <Feature text="2 Nodes (1 Master + 1 Worker)" />
                        <Feature text="1 Admin User" />
                        <Feature text="Standard Installation Engine" />
                        <Feature text="Gateway Agent (Remote Tunnel)" />
                        <Feature text="Basic Addons (Ingress, Dashboard)" />
                        <Feature disabled text="Auto-Healing & AI Diagnostics" />
                        <Feature disabled text="Team Members & RBAC" />
                        <Feature disabled text="Automated Backups" />
                        <Feature disabled text="Priority Support" />
                    </div>

                    <button className="w-full py-3.5 rounded-2xl bg-white/5 border border-white/10 text-slate-500 font-black text-xs uppercase tracking-wider cursor-default">
                        Current Plan
                    </button>
                </div>

                {/* PRO — highlighted */}
                <div className="glass rounded-[32px] p-8 border border-amber-500/40 bg-amber-500/5 flex flex-col relative shadow-2xl shadow-amber-500/10 md:-mt-4 md:mb-0">
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                        <span className="px-4 py-1.5 bg-amber-500 text-black text-[10px] font-black uppercase tracking-widest rounded-full shadow-lg whitespace-nowrap">
                            Most Popular
                        </span>
                    </div>

                    <div className="mb-8 mt-2">
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-400 text-xs font-black uppercase tracking-widest mb-5">
                            <Zap className="w-3 h-3" /> Pro
                        </div>
                        <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-4xl font-black text-white">$49</span>
                            <span className="text-slate-500 text-sm">/month</span>
                        </div>
                        <p className="text-slate-500 text-sm">For startups and growing teams.</p>
                    </div>

                    <div className="space-y-3 mb-8 flex-1">
                        <Feature color="text-amber-400" text="10 Clusters" />
                        <Feature color="text-amber-400" text="Up to 50 Nodes" />
                        <Feature color="text-amber-400" text="5 Team Members (RBAC)" />
                        <Feature color="text-amber-400" text="Auto-Healing & AI Diagnostics" />
                        <Feature color="text-amber-400" text="Gateway Agents (WebSocket Tunnels)" />
                        <Feature color="text-amber-400" text="Automated Config Backups (24h)" />
                        <Feature color="text-amber-400" text="All Addons (ArgoCD, Longhorn, Cert-Manager)" />
                        <Feature color="text-amber-400" text="Priority Email Support" />
                    </div>

                    <button
                        onClick={() => handleUpgrade('pro')}
                        disabled={loading}
                        className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-black text-xs uppercase tracking-wider shadow-lg shadow-amber-500/25 transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        {loading
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <>Upgrade to Pro <ArrowRight className="w-4 h-4" /></>
                        }
                    </button>
                </div>

                {/* ENTERPRISE */}
                <div className="glass rounded-[32px] p-8 border border-blue-500/20 bg-blue-500/5 flex flex-col">
                    <div className="mb-8">
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-black uppercase tracking-widest mb-5">
                            <Shield className="w-3 h-3" /> Enterprise
                        </div>
                        <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-4xl font-black text-white">Custom</span>
                        </div>
                        <p className="text-slate-500 text-sm">For agencies and large teams.</p>
                    </div>

                    <div className="space-y-3 mb-8 flex-1">
                        <Feature color="text-blue-400" text="Unlimited Clusters" />
                        <Feature color="text-blue-400" text="Unlimited Nodes" />
                        <Feature color="text-blue-400" text="Unlimited Team Members" />
                        <Feature color="text-blue-400" text="Everything in Pro" />
                        <Feature color="text-blue-400" text="Dedicated Support + SLA" />
                        <Feature color="text-blue-400" text="Custom Branding / White-label" />
                        <Feature color="text-blue-400" text="On-premise License" />
                        <Feature color="text-blue-400" text="SSO / SAML (coming soon)" />
                    </div>

                    <a
                        href="mailto:sales@k8scluster.space"
                        className="w-full py-3.5 rounded-2xl bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 text-blue-400 font-black text-xs uppercase tracking-wider transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                        <Mail className="w-4 h-4" /> Contact Sales
                    </a>
                </div>
            </div>

            {/* Bottom note */}
            <p className="mt-14 text-center text-slate-600 text-sm">
                All plans include SSL, WebSocket support, and Cloudflare compatibility. Cancel anytime.
            </p>
        </div>
    )
}

function Feature({ text, disabled = false, color = 'text-emerald-400' }) {
    return (
        <div className="flex items-center gap-3">
            {disabled
                ? <X className="w-4 h-4 flex-shrink-0 text-slate-700" />
                : <CheckCircle2 className={`w-4 h-4 flex-shrink-0 ${color}`} />
            }
            <span className={`text-sm ${disabled ? 'text-slate-600' : 'text-slate-300'}`}>{text}</span>
        </div>
    )
}
