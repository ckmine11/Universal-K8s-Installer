import { useState } from 'react'
import { CheckCircle2, Zap, Shield, Server, ArrowRight, X, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function Pricing() {
    const navigate = useNavigate()
    const [upgrading, setUpgrading] = useState(false)

    const handleUpgrade = async (plan) => {
        setUpgrading(true)
        try {
            const token = localStorage.getItem('token')
            if (!token) {
                navigate('/login')
                return
            }
            const res = await fetch('/api/billing/upgrade', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ plan })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Upgrade failed')
            alert(`Upgrade Successful! You are now on the ${plan} plan.`)
            navigate('/settings')
        } catch (err) {
            alert(`Upgrade Error: ${err.message}`)
        } finally {
            setUpgrading(false)
        }
    }

    return (
        <div className="min-h-screen pt-24 pb-20 px-4">
            <div className="max-w-6xl mx-auto text-center mb-16 relative">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-blue-500/20 rounded-full blur-[120px] pointer-events-none" />
                <h1 className="text-4xl md:text-5xl font-black text-white uppercase tracking-tight mb-4 relative z-10">
                    Choose Your Scale
                </h1>
                <p className="text-lg text-slate-400 max-w-2xl mx-auto relative z-10">
                    From hobbyist experiments to enterprise-grade production clusters. 
                    Start free, upgrade when you need power.
                </p>
            </div>

            <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8 relative z-10">
                {/* Free Tier */}
                <div className="glass rounded-[40px] p-10 border border-white/5 relative overflow-hidden flex flex-col">
                    <div className="mb-8">
                        <div className="inline-flex px-4 py-1.5 rounded-full bg-slate-500/10 border border-slate-500/20 text-slate-400 text-xs font-black uppercase tracking-widest mb-6">
                            Developer Edition
                        </div>
                        <h2 className="text-4xl font-black text-white mb-2">Free</h2>
                        <p className="text-slate-400 text-sm">Perfect for learning and small projects.</p>
                    </div>

                    <div className="space-y-4 mb-10 flex-1">
                        <FeatureItem checked text="1 Kubernetes Cluster" />
                        <FeatureItem checked text="Up to 3 Nodes (1 Master, 2 Workers)" />
                        <FeatureItem checked text="Standard Installation Engine" />
                        <FeatureItem checked text="1 Admin User" />
                        <FeatureItem checked={false} text="Auto-Healing & AI Diagnostics" />
                        <FeatureItem checked={false} text="Secure Node Agents (Tunnels)" />
                        <FeatureItem checked={false} text="Multi-Tenancy (RBAC)" />
                        <FeatureItem checked={false} text="Automated Config Backups" />
                    </div>

                    <button className="w-full py-4 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-black text-xs uppercase tracking-wider transition-all active:scale-95">
                        Current Plan
                    </button>
                </div>

                {/* Pro Tier */}
                <div className="glass rounded-[40px] p-10 border border-amber-500/30 bg-amber-500/5 relative overflow-hidden flex flex-col shadow-2xl shadow-amber-500/10">
                    <div className="absolute top-0 right-0 p-8">
                        <Zap className="w-12 h-12 text-amber-500/20" />
                    </div>
                    <div className="absolute top-4 right-4 rotate-12">
                        <span className="px-3 py-1 bg-amber-500 text-black text-[10px] font-black uppercase tracking-widest rounded-lg shadow-lg">Most Popular</span>
                    </div>

                    <div className="mb-8">
                        <div className="inline-flex px-4 py-1.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-400 text-xs font-black uppercase tracking-widest mb-6 flex items-center gap-2">
                            <Shield className="w-3.5 h-3.5" />
                            Enterprise Edition
                        </div>
                        <h2 className="text-4xl font-black text-white mb-2 flex items-baseline gap-2">
                            $49 <span className="text-lg text-slate-400 font-bold lowercase">/mo</span>
                        </h2>
                        <p className="text-slate-400 text-sm">For agencies and production environments.</p>
                    </div>

                    <div className="space-y-4 mb-10 flex-1">
                        <FeatureItem checked color="text-amber-400" text="Unlimited Clusters" />
                        <FeatureItem checked color="text-amber-400" text="Unlimited Nodes" />
                        <FeatureItem checked color="text-amber-400" text="Auto-Healing & Pre-flight Diagnostics" />
                        <FeatureItem checked color="text-amber-400" text="Multi-Tenancy (Unlimited Users & RBAC)" />
                        <FeatureItem checked color="text-amber-400" text="Secure Node Agents (WebSocket Tunnels)" />
                        <FeatureItem checked color="text-amber-400" text="Automated Config Snapshots (24h)" />
                        <FeatureItem checked color="text-amber-400" text="Priority Support" />
                    </div>

                    <button 
                        onClick={() => handleUpgrade('PRO')}
                        disabled={upgrading}
                        className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-black text-xs uppercase tracking-wider shadow-lg shadow-amber-500/25 transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        {upgrading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Upgrade to Pro <ArrowRight className="w-4 h-4" /></>}
                    </button>
                </div>
            </div>
            
            <div className="mt-16 text-center">
                <p className="text-slate-500 text-sm">Need a custom on-premise license for your enterprise? <a href="#" className="text-blue-400 hover:underline">Contact Sales</a></p>
            </div>
        </div>
    )
}

function FeatureItem({ checked, text, color = "text-emerald-400" }) {
    return (
        <div className="flex items-center gap-3">
            {checked ? (
                <div className={`p-0.5 rounded-full bg-white/5 ${color}`}>
                    <CheckCircle2 className="w-4 h-4" />
                </div>
            ) : (
                <div className="p-0.5 rounded-full bg-white/5 text-slate-600">
                    <X className="w-4 h-4" />
                </div>
            )}
            <span className={`text-sm ${checked ? 'text-slate-200' : 'text-slate-500'}`}>{text}</span>
        </div>
    )
}
