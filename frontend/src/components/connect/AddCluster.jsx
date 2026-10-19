import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2, ChevronLeft, ArrowRight, Radio, Terminal, FileCode2, ShieldCheck, ShieldAlert, CheckCircle2, XCircle, RefreshCw, Lock } from 'lucide-react'
import { call, CopyBlock, ProviderBadge, GroupIcon, FeatureList, METHOD_LABEL } from './shared'
import Guide from './Guide'

// Add existing cluster: where it runs → name and access → how to connect →
// the command (with the guide beside it) → KubeEZ checks it → what works.
const GROUPS = [
    { id: 'cloud', name: 'Cloud', hint: 'EKS, AKS, GKE, OKE, DigitalOcean, Linode…' },
    { id: 'onprem', name: 'On-prem', hint: 'kubeadm, k3s, RKE2, OpenShift, Rancher, Talos…' },
    { id: 'other', name: 'Other', hint: 'kind, Docker Desktop, minikube…' }
]

export default function AddCluster({ providers, saas }) {
    const navigate = useNavigate()
    const [step, setStep] = useState(1)
    const [group, setGroup] = useState(null)
    const [provider, setProvider] = useState(null)
    const [name, setName] = useState('')
    const [level, setLevel] = useState('read')
    const [env, setEnv] = useState('')
    const [method, setMethod] = useState('agent')
    const [session, setSession] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [kubeconfig, setKubeconfig] = useState('')
    const poll = useRef(null)

    const p = providers.find(x => x.id === provider)
    const list = providers.filter(x => x.group === group)
    useEffect(() => () => clearInterval(poll.current), [])
    // the connect command was run: wait for KubeEZ's check
    const watch = (code) => {
        clearInterval(poll.current)
        poll.current = setInterval(async () => {
            try {
                const s = await call(`/api/connect/sessions/${code}`)
                setSession(prev => ({ ...prev, ...s }))
                if (s.status === 'connected') { clearInterval(poll.current); setStep(5) }
            } catch { /* keep waiting */ }
        }, 2500)
    }
    const start = async () => {
        setBusy(true); setError(null)
        try {
            const s = await call('/api/connect/sessions', { method: 'POST', body: { name: name.trim(), provider, level, method: method === 'kubeconfig' ? 'auto' : method, labels: env ? { env } : undefined } })
            setSession(s); setStep(4)
            if (method !== 'kubeconfig') watch(s.code)
        } catch (e) { setError(e.message) } finally { setBusy(false) }
    }
    const sendKubeconfig = async () => {
        setBusy(true); setError(null)
        try {
            await call(`/api/connect/sessions/${session.code}/kubeconfig`, { method: 'POST', body: { kubeconfig } })
            setKubeconfig('')   // never kept in the page after use
            const s = await call(`/api/connect/sessions/${session.code}`)
            setSession(prev => ({ ...prev, ...s })); setStep(5)
        } catch (e) { setError(e.data?.hint ? `${e.message} — ${e.data.hint}` : e.message); const s = await call(`/api/connect/sessions/${session.code}`).catch(() => null); if (s) setSession(prev => ({ ...prev, ...s })) } finally { setBusy(false) }
    }
    const [result, setResult] = useState(null)
    useEffect(() => { if (step === 5 && session?.clusterId) call(`/api/connect/clusters/${session.clusterId}`).then(setResult).catch(() => { }) }, [step, session?.clusterId])

    const Steps = () => (
        <ol className="flex flex-wrap items-center gap-2 text-[11px]">
            {['Where it runs', 'Name & access', 'How to connect', 'Run the command', 'Connected'].map((t, i) => (
                <li key={t} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${step === i + 1 ? 'border-blue-400/50 bg-blue-500/10 text-blue-100' : step > i + 1 ? 'border-emerald-400/30 text-emerald-200' : 'border-white/10 text-slate-500'}`}>
                    {step > i + 1 ? <CheckCircle2 className="w-3 h-3" /> : <span>{i + 1}</span>}{t}
                </li>
            ))}
        </ol>
    )
    const back = (to) => <button type="button" onClick={() => { clearInterval(poll.current); setStep(to) }} className="kz-btn-ghost !text-xs"><ChevronLeft className="w-3.5 h-3.5" /> Back</button>

    return (
        <div className="space-y-5">
            <Steps />
            {error && <p className="rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}

            {step === 1 && (
                <div className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                        {GROUPS.map(g => (
                            <button key={g.id} type="button" onClick={() => { setGroup(g.id); setProvider(null) }} className={`kz-card p-4 text-left transition ${group === g.id ? 'ring-1 ring-blue-400/60' : 'hover:border-white/20'}`}>
                                <p className="flex items-center gap-2 font-semibold text-white"><GroupIcon group={g.id} className="w-4 h-4 text-blue-300" />{g.name}</p>
                                <p className="mt-1 text-xs text-slate-400">{g.hint}</p>
                            </button>
                        ))}
                    </div>
                    {group && (
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {list.map(x => (
                                <button key={x.id} type="button" onClick={() => { setProvider(x.id); if (!name) setName(''); setMethod(x.agentOnly ? 'agent' : 'agent'); setStep(2) }} className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${provider === x.id ? 'border-blue-400/60 bg-blue-500/10' : 'border-white/10 bg-white/[0.02] hover:border-white/25'}`}>
                                    <ProviderBadge provider={x.id} group={x.group} size="sm" />
                                    <span><span className="block text-sm font-medium text-white">{x.name}</span>{x.vendor && <span className="text-[11px] text-slate-500">{x.vendor}</span>}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {step === 2 && p && (
                <div className="kz-card p-5 space-y-4 max-w-2xl">
                    <p className="flex items-center gap-3 text-sm text-slate-300"><ProviderBadge provider={p.id} group={p.group} size="sm" /> {p.name}</p>
                    <div>
                        <label className="kz-label" htmlFor="imp-name">Name in KubeEZ</label>
                        <input id="imp-name" className="kz-input" value={name} onChange={e => setName(e.target.value)} placeholder={`${p.id}-prod`} maxLength={63} autoFocus />
                    </div>
                    <div>
                        <p className="kz-label">Access for KubeEZ</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {[['read', ShieldCheck, 'Read-only', 'Watch, alert, explain, advise. KubeEZ changes nothing in the cluster. No access to Secrets.'], ['full', ShieldAlert, 'Full manage', 'Also add-ons, fixes, backups, terminal — KubeEZ gets cluster-admin. Every action stays audited and follows your roles.']].map(([k, I, t, d]) => (
                                <button key={k} type="button" onClick={() => setLevel(k)} className={`rounded-xl border p-3 text-left ${level === k ? 'border-blue-400/60 bg-blue-500/10' : 'border-white/10 hover:border-white/25'}`}>
                                    <p className="flex items-center gap-1.5 text-sm font-medium text-white"><I className="w-4 h-4 text-blue-300" />{t}{k === 'read' && <span className="kz-chip !text-[10px]">default</span>}</p>
                                    <p className="mt-1 text-[11px] text-slate-400">{d}</p>
                                </button>
                            ))}
                        </div>
                        <p className="mt-1.5 text-[11px] text-slate-500">You can switch it later in the cluster's connection settings.</p>
                    </div>
                    <div>
                        <label className="kz-label" htmlFor="imp-env">Environment label (optional)</label>
                        <input id="imp-env" className="kz-input !w-48" value={env} onChange={e => setEnv(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} placeholder="prod" maxLength={40} />
                        <p className="mt-1 text-[11px] text-slate-500">Sets env=… on the cluster — team cluster rules can match it.</p>
                    </div>
                    <div className="flex gap-2">{back(1)}<button type="button" disabled={!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/.test(name.trim())} onClick={() => setStep(3)} className="kz-btn-primary !text-xs">Next <ArrowRight className="w-3.5 h-3.5" /></button></div>
                </div>
            )}

            {step === 3 && p && (
                <div className="space-y-4 max-w-3xl">
                    <div className="grid gap-3 md:grid-cols-3">
                        {[
                            ['agent', Radio, 'KubeEZ agent', 'Recommended', 'One kubectl apply. The agent connects OUT to KubeEZ — works for private endpoints, firewalls and on-prem behind NAT. Nothing opened towards the cluster.'],
                            ['auto', Terminal, 'Connect command', p.agentOnly ? 'Not for Rancher' : null, `Run one command where kubectl works. KubeEZ then talks to the API server directly${saas ? ' (public endpoints)' : ''}, or through your Gateway Agent for on-prem.`],
                            ['kubeconfig', FileCode2, 'Paste a kubeconfig', p.agentOnly ? 'Not for Rancher' : null, 'KubeEZ uses it once to create its own login, then forgets it. Not for kubeconfigs that log in through aws / gcloud / kubelogin.']
                        ].map(([k, I, t, tag, d]) => {
                            const off = p.agentOnly && k !== 'agent'
                            return (
                                <button key={k} type="button" disabled={off} onClick={() => setMethod(k)} className={`rounded-xl border p-3 text-left disabled:opacity-40 ${method === k ? 'border-blue-400/60 bg-blue-500/10' : 'border-white/10 hover:border-white/25'}`}>
                                    <p className="flex items-center gap-1.5 text-sm font-medium text-white"><I className="w-4 h-4 text-blue-300" />{t}</p>
                                    {tag && <span className={`kz-chip !text-[10px] mt-1 ${k === 'agent' ? '!text-emerald-200' : ''}`}>{tag}</span>}
                                    <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">{d}</p>
                                </button>
                            )
                        })}
                    </div>
                    {saas && method !== 'agent' && <p className="flex items-start gap-1.5 text-[11px] text-slate-400"><Lock className="w-3.5 h-3.5 mt-0.5 text-sky-300 shrink-0" />KubeEZ Cloud never connects to private addresses itself — a private API server is reached through your Gateway Agent (on-prem), or use the KubeEZ agent.</p>}
                    <div className="flex gap-2">{back(2)}<button type="button" disabled={busy} onClick={start} className="kz-btn-primary !text-xs">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Get the command <ArrowRight className="w-3.5 h-3.5" /></button></div>
                </div>
            )}

            {step === 4 && p && session && (
                <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
                    <div className="kz-card p-5 space-y-4">
                        <h3 className="text-sm font-semibold text-white">{method === 'kubeconfig' ? 'Paste the kubeconfig' : 'Run this where kubectl works for the cluster'}</h3>
                        {method === 'agent' && <CopyBlock text={session.commands.agent} label="kubectl" />}
                        {method === 'auto' && <><CopyBlock text={session.commands.connect.sh} label="Linux / macOS" /><CopyBlock text={session.commands.connect.ps1} label="Windows PowerShell" /></>}
                        {method === 'kubeconfig' && (
                            <div className="space-y-2">
                                <textarea className="kz-input font-mono !text-[11px] h-56" spellCheck={false} autoComplete="off" value={kubeconfig} onChange={e => setKubeconfig(e.target.value)} placeholder={'apiVersion: v1\nkind: Config\nclusters: …'} />
                                <p className="text-[11px] text-slate-500">Tip: <code>kubectl config view --raw --minify --flatten</code> gives the current context with its certificates inline. KubeEZ uses it once and keeps only its own <code>kubeez</code> token.</p>
                                <button type="button" disabled={busy || kubeconfig.length < 50} onClick={sendKubeconfig} className="kz-btn-primary !text-xs">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Connect</button>
                            </div>
                        )}
                        {method !== 'kubeconfig' && (
                            <div className={`rounded-xl border px-3 py-2.5 text-xs ${session.status === 'failed' ? 'border-red-400/30 bg-red-500/10 text-red-200' : 'border-white/10 bg-white/[0.03] text-slate-300'}`}>
                                {session.status === 'failed' ? <>
                                    <p className="flex items-center gap-1.5 font-medium"><XCircle className="w-4 h-4" />{session.error}</p>
                                    {session.hint && <p className="mt-1 text-red-200/80">{session.hint}</p>}
                                    <p className="mt-1 text-slate-400">Fix it and run the same command again — it stays valid for 24 hours.</p>
                                </> : session.status === 'checking'
                                    ? <p className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-blue-300" />The cluster answered — KubeEZ is checking it…</p>
                                    : <p className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-slate-400" />Waiting for the cluster{method === 'agent' ? ' (the agent connects within a minute after the pod starts)' : ''}…</p>}
                            </div>
                        )}
                        <div className="flex gap-2">{back(3)}</div>
                    </div>
                    <div className="kz-card p-5">
                        <h3 className="mb-4 text-sm font-semibold text-white">Guide — {p.name}</h3>
                        <Guide provider={p} commands={session.commands} method={method === 'agent' ? 'agent' : 'connect'} compact />
                        <Link to={`/connect/guides/${p.id}`} className="mt-4 inline-block text-[11px] text-blue-300 hover:underline">Full guide with troubleshooting →</Link>
                    </div>
                </div>
            )}

            {step === 5 && session && (
                <div className="kz-card p-5 space-y-4 max-w-3xl">
                    <p className="flex items-center gap-2 text-base font-semibold text-emerald-200"><CheckCircle2 className="w-5 h-5" /> {session.name} is connected</p>
                    {session.detected && <div className="flex flex-wrap gap-2 text-xs">
                        <span className="kz-chip">{providers.find(x => x.id === session.detected.provider)?.name || session.detected.provider}</span>
                        <span className="kz-chip">{session.detected.distro}</span>
                        <span className="kz-chip">Kubernetes {session.detected.version}</span>
                        <span className="kz-chip">{session.detected.nodes} node{session.detected.nodes === 1 ? '' : 's'}</span>
                        <span className="kz-chip">{METHOD_LABEL[session.route] || session.route}</span>
                    </div>}
                    {session.hint && <p className="text-xs text-amber-200">{session.hint}</p>}
                    {result ? <FeatureList features={result.features} /> : <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => navigate(`/cluster/${session.clusterId}`)} className="kz-btn-primary !text-xs">Open the cluster <ArrowRight className="w-3.5 h-3.5" /></button>
                        <button type="button" onClick={() => navigate('/connect')} className="kz-btn-ghost !text-xs">All connected clusters</button>
                        <button type="button" onClick={() => { setStep(1); setSession(null); setName(''); setProvider(null); setResult(null) }} className="kz-btn-ghost !text-xs"><RefreshCw className="w-3.5 h-3.5" /> Connect another</button>
                    </div>
                </div>
            )}
        </div>
    )
}
