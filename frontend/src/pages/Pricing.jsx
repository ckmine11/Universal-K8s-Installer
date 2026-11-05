import { useState, useEffect } from 'react'
import { BorderBeam } from '@/components/lightswind/border-beam'
import { CheckCircle2, Zap, Shield, ArrowRight, X, Loader2, Mail, ChevronDown, Lock, Sparkles } from 'lucide-react'
import { apiFetch } from '../context/AuthContext'

const MONTHLY_PRICE = 49
const ANNUAL_PRICE  = 39   // billed as $468/yr

// Plans, and what THIS workspace can use: GET /api/billing/plan lists every
// feature and paid capability as included or not (the same checks the server
// enforces), with the limits, the usage and the Pro trial.
export default function Pricing() {
    const [annual, setAnnual]   = useState(false)
    const [loading, setLoading] = useState(false)
    const [mine, setMine] = useState(null)

    const price = annual ? ANNUAL_PRICE : MONTHLY_PRICE

    useEffect(() => {
        apiFetch('/api/billing/plan').then(r => r.ok ? r.json() : null).then(setMine).catch(() => { })
    }, [])

    const trial = mine?.trial?.daysLeft ? mine.trial : null
    const free = mine?.limitsByPlan?.FREE || { maxClusters: 1, maxNodes: 5, maxMembers: 1 }
    const pro = mine?.limitsByPlan?.PRO || { maxClusters: 10, maxNodes: 50, maxMembers: 5 }
    const plan = mine?.plan || 'FREE'
    const isFree = plan === 'FREE'
    const isPaidPro = plan === 'PRO' && !trial
    const trialDays = mine?.trialDays ?? 14

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
        <div className="pb-16 overflow-x-clip">

            {/* Header */}
            <div className="max-w-5xl mx-auto text-center mb-8 relative">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(600px,100%)] h-[300px] bg-blue-500/20 rounded-full blur-[120px] pointer-events-none" />
                <div className="text-[11px] font-bold uppercase tracking-[0.24em] text-blue-300/80 mb-3 relative z-10">Plans</div>
                <h1 className="font-display text-4xl md:text-5xl font-bold text-white tracking-tight mb-4 relative z-10">
                    Simple, <span className="kz-serif aurora-text pr-1">honest pricing.</span>
                </h1>
                <p className="text-lg text-slate-400 max-w-2xl mx-auto relative z-10">
                    Free runs one cluster for real. Pro adds what a team in production needs: alerts, guards, pipelines and more clusters.
                </p>
            </div>

            {mine && <YourPlan mine={mine} trial={trial} onUpgrade={() => handleUpgrade('pro')} loading={loading} />}

            {/* Annual / Monthly Toggle */}
            <div className="flex items-center justify-center gap-4 mb-12 relative z-10">
                <span className={`text-sm font-bold transition-colors ${!annual ? 'text-white' : 'text-slate-500'}`}>
                    Monthly
                </span>
                <button
                    onClick={() => setAnnual(v => !v)}
                    className="relative w-14 h-7 rounded-full transition-colors duration-300 focus:outline-none"
                    style={{ background: annual ? 'rgb(245 158 11)' : 'rgba(255,255,255,0.1)' }}
                    aria-label={annual ? 'Show monthly prices' : 'Show annual prices'}
                >
                    <span
                        className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-all duration-300 ${annual ? 'left-8' : 'left-1'}`}
                    />
                </button>
                <span className={`text-sm font-bold transition-colors ${annual ? 'text-white' : 'text-slate-500'}`}>
                    Annual
                </span>
                {annual && (
                    <span className="px-2.5 py-1 bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-[10px] font-black uppercase tracking-widest rounded-full">
                        Save $120/yr
                    </span>
                )}
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
                        <p className="text-slate-500 text-sm">One person, one cluster — for real.</p>
                    </div>

                    <div className="space-y-3 mb-8 flex-1">
                        <Feature text={`${free.maxClusters} cluster, up to ${free.maxNodes} nodes, ${free.maxMembers} admin`} />
                        <Feature text="Install, upgrade and scale clusters, or connect EKS / AKS / GKE / k3s…" />
                        <Feature text="Apps: Helm install, upgrade, roll back — with drift check" />
                        <Feature text="GitOps: view, sync and create Argo CD / Flux apps" />
                        <Feature text="Security scans, certificates, delivery (DORA) metrics, costs" />
                        <Feature text="Registry pull secrets and debug containers" />
                        <Feature text="Auto-healing and Ask AI (with your AI engine)" />
                        <Feature text="Critical alerts on 1 channel (Telegram, email or webhook)" />
                        <Feature disabled text="Alerts on Slack / Teams, CVE and certificate alerts" />
                        <Feature disabled text="Deploy guards, CI tokens, previews, team & approvals" />
                    </div>

                    <button className="w-full py-3.5 rounded-2xl bg-white/5 border border-white/10 text-slate-500 font-black text-xs uppercase tracking-wider cursor-default">
                        {isFree ? '✓ Current Plan' : 'Free'}
                    </button>
                </div>

                {/* PRO — highlighted */}
                <div className="glass rounded-[32px] p-8 border border-blue-400/30 bg-blue-500/[0.05] flex flex-col relative shadow-[0_40px_100px_-40px_rgba(128,105,251,.6)] md:-mt-4">
                    <BorderBeam size={200} duration={9} colorFrom="#b6a8ff" colorTo="#38bdf8" />
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                        <span className="px-4 py-1.5 bg-gradient-to-r from-blue-400 to-sky-400 text-[#0b0b0f] text-[10px] font-bold uppercase tracking-widest rounded-full shadow-lg whitespace-nowrap">
                            Most Popular
                        </span>
                    </div>

                    <div className="mb-8 mt-2">
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/15 border border-blue-400/30 text-blue-200 text-xs font-bold uppercase tracking-widest mb-5">
                            <Zap className="w-3 h-3" /> Pro
                        </div>

                        {/* Price */}
                        <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-4xl font-black text-white">${price}</span>
                            <span className="text-slate-500 text-sm">/month</span>
                            {annual && (
                                <span className="text-slate-500 text-xs line-through ml-1">${MONTHLY_PRICE}</span>
                            )}
                        </div>
                        {annual
                            ? <p className="text-emerald-400 text-xs font-bold">Billed as ${ANNUAL_PRICE * 12}/year</p>
                            : <p className="text-slate-500 text-sm">For teams running production.</p>
                        }
                    </div>

                    <div className="space-y-3 mb-6 flex-1">
                        <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Everything in Free, plus:</p>
                        <Feature color="text-blue-300" text={`${pro.maxClusters} clusters, up to ${pro.maxNodes} nodes, ${pro.maxMembers} team members`} />
                        <Feature color="text-blue-300" text="Alerts on every channel with rules — plus CVE, certificate and GitOps alerts" />
                        <Feature color="text-blue-300" text="Deploy guards: CVE gate, image signatures, deploy risk, auto-rollback" />
                        <Feature color="text-blue-300" text="Pipelines: CI deploy tokens, preview environments, promote by pull request, deploy from chat" />
                        <Feature color="text-blue-300" text="Canary / blue-green rollouts, autoscaling, sleep schedules, External Secrets" />
                        <Feature color="text-blue-300" text="Two-person approvals, custom roles, compliance reports" />
                        <Feature color="text-blue-300" text="Daily config backups, etcd and off-site backups" />
                        <Feature color="text-blue-300" text="Support response within 24 hours" />
                    </div>

                    {isPaidPro ? (
                        <button
                            disabled
                            className="w-full py-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-default"
                        >
                            <CheckCircle2 className="w-4 h-4" /> Current Plan
                        </button>
                    ) : plan === 'ENTERPRISE' ? null : (
                        <button
                            onClick={() => handleUpgrade('pro')}
                            disabled={loading}
                            className="kz-btn-light w-full !py-3.5 !rounded-2xl"
                        >
                            {loading
                                ? <Loader2 className="w-4 h-4 animate-spin" />
                                : <>{trial ? 'Keep Pro after the trial' : 'Upgrade to Pro'} <ArrowRight className="w-4 h-4" /></>
                            }
                        </button>
                    )}

                    {/* Trust signals */}
                    <p className="text-center text-slate-600 text-[11px] mt-3">
                        ✓ New workspaces get {trialDays} days of Pro free &nbsp;·&nbsp; ✓ Secure Stripe billing
                    </p>
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
                        <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Every Pro feature, plus:</p>
                        <Feature color="text-blue-400" text="As many clusters, nodes and members as you need" />
                        <Feature color="text-blue-400" text="Self-hosted license for your own servers" />
                        <Feature color="text-blue-400" text="Single sign-on (OIDC) set up with you" />
                        <Feature color="text-blue-400" text="Dedicated support and SLA" />
                    </div>

                    <a
                        href="mailto:sales@k8scluster.space"
                        className="w-full py-3.5 rounded-2xl bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 text-blue-400 font-black text-xs uppercase tracking-wider transition-all active:scale-95 flex items-center justify-center gap-2"
                    >
                        <Mail className="w-4 h-4" /> Contact Sales
                    </a>
                </div>
            </div>

            {mine && <Compare mine={mine} />}

            {/* FAQ */}
            <div className="max-w-3xl mx-auto mt-16">
                <h2 className="text-2xl font-black text-white text-center mb-8">Frequently Asked Questions</h2>
                <div className="space-y-3">
                    {[
                        { q: 'What is the Pro trial?', a: `Every new workspace gets ${trialDays} days of Pro: every feature and Pro limits. No card needed. When it ends the workspace is Free again — nothing is deleted.` },
                        { q: 'What happens when the trial ends, or I hit a limit?', a: 'Clusters, apps and settings stay and keep running. You cannot add more than the Free limits allow, and Pro sections show an upgrade card instead of their content until you upgrade.' },
                        { q: 'Can I change plans later?', a: 'Yes. Upgrade or downgrade anytime. Changes apply immediately and billing is prorated.' },
                        { q: 'Do I need a credit card for the Free plan?', a: 'No. The Free plan is free forever — no card required.' },
                        { q: 'Where do my clusters run?', a: 'On your own servers, VPS or cloud. KubeEZ reaches them over SSH or a secure agent — your workloads never leave your infrastructure.' },
                    ].map((faq, i) => <FAQItem key={i} q={faq.q} a={faq.a} />)}
                </div>
            </div>

            {/* Bottom note */}
            <p className="mt-12 text-center text-slate-600 text-sm">
                Questions? <a href="mailto:sales@k8scluster.space" className="text-blue-400 hover:underline">Talk to us</a>.
            </p>
        </div>
    )
}

// This workspace: plan, trial, and how much of each limit is used
function YourPlan({ mine, trial, onUpgrade, loading }) {
    const name = trial ? 'Pro trial' : mine.plan === 'FREE' ? 'Free' : mine.plan === 'ENTERPRISE' ? 'Enterprise' : 'Pro'
    const meters = [['Clusters', 'clusters'], ['Nodes', 'nodes'], ['Team members', 'members']]
    return (
        <section className="max-w-5xl mx-auto mb-12 kz-card p-5 relative z-10" aria-label="Your plan">
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[14rem]">
                    <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Your workspace</p>
                    <p className="text-lg font-semibold text-white">{name}{trial && <span className="ml-2 text-sm font-medium text-amber-200">{trial.daysLeft} day{trial.daysLeft === 1 ? '' : 's'} left</span>}</p>
                    <p className="text-xs text-slate-400">
                        {trial ? `Every feature until ${new Date(trial.endsAt).toLocaleDateString()} — then Free, unless you upgrade. Nothing is deleted.`
                            : mine.trial?.endedAt ? 'Your Pro trial has ended. Pro sections show an upgrade card; everything you made is still there.'
                                : mine.plan === 'FREE' ? 'The table below shows what is included and what comes with Pro.' : 'Every feature is included.'}
                    </p>
                </div>
                {(mine.plan === 'FREE' || trial) && !mine.superadmin && (
                    <button onClick={onUpgrade} disabled={loading} className="kz-btn-primary !text-xs">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Sparkles className="w-3.5 h-3.5" /> {trial ? 'Keep Pro' : 'Upgrade to Pro'}</>}</button>
                )}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {meters.map(([label, k]) => {
                    const used = mine.usage?.[k] ?? 0, max = mine.limits?.[k]
                    const unlimited = max == null || max >= 9999
                    const full = !unlimited && used >= max
                    return (
                        <div key={k}>
                            <div className="flex justify-between text-xs"><span className="text-slate-400">{label}</span><span className={full ? 'text-amber-200 font-semibold' : 'text-slate-300'}>{used} / {unlimited ? '∞' : max}</span></div>
                            <div className="mt-1 h-1.5 rounded-full bg-white/5 overflow-hidden" role="meter" aria-label={label} aria-valuenow={used} aria-valuemax={unlimited ? undefined : max}>
                                <div className={`h-full rounded-full ${full ? 'bg-amber-400' : 'bg-blue-400'}`} style={{ width: unlimited ? '4%' : `${Math.min(100, max ? (used / max) * 100 : 100)}%` }} />
                            </div>
                        </div>
                    )
                })}
            </div>
        </section>
    )
}

// Every feature and paid capability: Free or Pro, and whether this workspace has it
function Compare({ mine }) {
    const rows = [...(mine.features || []), ...(mine.capabilities || [])]
    const groups = [...new Set(rows.map(r => r.group))]
    return (
        <section className="max-w-5xl mx-auto mt-14" aria-label="What each plan includes">
            <h2 className="text-2xl font-black text-white text-center mb-2">What each plan includes</h2>
            <p className="text-center text-sm text-slate-400 mb-6">The last column is your workspace — <CheckCircle2 className="inline w-3.5 h-3.5 text-emerald-400" /> you can use it, <Lock className="inline w-3.5 h-3.5 text-amber-300" /> it comes with Pro.</p>
            <div className="kz-card overflow-x-auto">
                <table className="w-full text-sm">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                        <th className="px-4 py-3 font-medium">Feature</th><th className="px-3 font-medium text-center">Free</th><th className="px-3 font-medium text-center">Pro &amp; Enterprise</th><th className="px-4 font-medium text-center">You</th>
                    </tr></thead>
                    <tbody>
                        {groups.map(g => [
                            <tr key={`g-${g}`}><td colSpan={4} className="px-4 pt-4 pb-1 text-[11px] font-bold uppercase tracking-widest text-slate-500">{g}</td></tr>,
                            ...rows.filter(r => r.group === g).map(r => (
                                <tr key={r.key} className="border-t border-white/5">
                                    <td className="px-4 py-2.5"><span className="text-slate-200">{r.label}</span>{r.description && <span className="block text-[11px] text-slate-500">{r.description}</span>}</td>
                                    <td className="px-3 text-center">{r.plan === 'free' ? <CheckCircle2 className="inline w-4 h-4 text-emerald-400" aria-label="included" /> : <X className="inline w-4 h-4 text-slate-600" aria-label="not included" />}</td>
                                    <td className="px-3 text-center"><CheckCircle2 className="inline w-4 h-4 text-blue-300" aria-label="included" /></td>
                                    <td className="px-4 text-center">{!r.on ? <span className="text-[11px] text-slate-500">turned off</span>
                                        : r.included ? <CheckCircle2 className="inline w-4 h-4 text-emerald-400" aria-label="you have it" />
                                            : <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-200"><Lock className="w-3.5 h-3.5" /> Pro</span>}</td>
                                </tr>
                            ))
                        ])}
                    </tbody>
                </table>
            </div>
        </section>
    )
}

function FAQItem({ q, a }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="glass rounded-2xl border border-white/8 overflow-hidden">
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-white/[0.02] transition-colors"
            >
                <span className="text-sm font-bold text-white">{q}</span>
                <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="px-5 pb-4 text-sm text-slate-400 leading-relaxed">{a}</div>
            )}
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
