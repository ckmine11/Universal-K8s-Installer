import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Loader2, RefreshCw, Plus, ArrowRight, ShieldCheck, ShieldAlert, KeyRound, PlugZap, Trash2, Radio, AlertTriangle, ChevronLeft, Server, BookOpen } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useToast } from '../ToastProvider'
import { call, CopyBlock, ProviderBadge, StatusDot, FeatureList, METHOD_LABEL, LEVEL_LABEL, ago } from './shared'
import Guide from './Guide'
import SshNodes from './SshNodes'
import CloudAccount from './CloudAccount'

const groupOf = (providers, id) => providers.find(p => p.id === id)?.group || 'other'

// ── every connected cluster ──
export function ClusterList({ providers }) {
    const { user } = useAuth()
    const [list, setList] = useState(null)
    const [error, setError] = useState(null)
    const [checking, setChecking] = useState(null)
    const load = useCallback(() => call('/api/connect/clusters').then(d => { setList(d.clusters); setError(null) }).catch(e => setError(e.message)), [])
    useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])
    const check = async (id) => { setChecking(id); try { await call(`/api/connect/clusters/${id}/check`, { method: 'POST' }); await load() } catch (e) { setError(e.message) } finally { setChecking(null) } }
    if (error) return <p className="kz-card p-4 text-sm text-red-200">{error}</p>
    if (!list) return <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
    if (!list.length) return (
        <div className="kz-card p-10 text-center">
            <PlugZap className="mx-auto w-8 h-8 text-blue-300" />
            <p className="mt-3 text-base font-semibold text-white">No existing cluster connected yet</p>
            <p className="mt-1 text-sm text-slate-400">Connect EKS, AKS, GKE, OKE, k3s, OpenShift… — any Kubernetes. KubeEZ watches it, explains problems and advises, without installing it.</p>
            {can(user?.role, 'cluster:create') && <Link to="/connect/new" className="kz-btn-primary !text-xs mt-4 inline-flex"><Plus className="w-3.5 h-3.5" /> Add existing cluster</Link>}
        </div>
    )
    return (
        <div className="kz-card overflow-x-auto">
            <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500"><th className="px-4 py-3 font-medium">Cluster</th><th className="font-medium">Status</th><th className="font-medium">Connected through</th><th className="font-medium">Access</th><th className="font-medium">Nodes</th><th className="font-medium">Last check</th><th /></tr></thead>
                <tbody>
                    {list.map(c => (
                        <tr key={c.id} className="border-t border-white/5 align-middle">
                            <td className="px-4 py-3">
                                <Link to={`/connect/cluster/${c.id}`} className="flex items-center gap-3 group">
                                    <ProviderBadge provider={c.provider} group={groupOf(providers, c.provider)} size="sm" />
                                    <span><span className="block font-medium text-white group-hover:underline">{c.name}</span><span className="text-[11px] text-slate-500">{c.providerName}{c.distro && c.distro !== c.provider ? ` · ${c.distro}` : ''} · Kubernetes {c.version || '?'}</span></span>
                                </Link>
                            </td>
                            <td><StatusDot status={c.status} />{c.status === 'lost' && <p className="text-[11px] text-red-300 max-w-[220px] truncate" title={c.lastError}>{c.lastError}</p>}</td>
                            <td className="text-xs text-slate-300">{METHOD_LABEL[c.method]}{c.method === 'agent' && <span className={`ml-1.5 text-[11px] ${c.agentOnline ? 'text-emerald-300' : 'text-red-300'}`}>{c.agentOnline ? '● online' : '● offline'}</span>}</td>
                            <td><span className={`kz-chip !text-[11px] ${c.level === 'full' ? '!text-amber-200' : '!text-sky-200'}`}>{LEVEL_LABEL[c.level]}</span></td>
                            <td className="text-xs text-slate-300">{c.nodeCount}</td>
                            <td className="text-xs text-slate-400">{ago(c.lastOk)}</td>
                            <td className="pr-4 text-right whitespace-nowrap">
                                <button type="button" onClick={() => check(c.id)} disabled={checking === c.id} className="kz-btn-ghost !py-1 !text-[11px]" title="Check the connection now">{checking === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}</button>
                                <Link to={`/cluster/${c.id}`} className="kz-btn-ghost !py-1 !text-[11px] ml-1">Open <ArrowRight className="w-3 h-3" /></Link>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

// ── one cluster: how it is connected, and changing that ──
export function ClusterConnection({ providers }) {
    const { id } = useParams()
    const navigate = useNavigate()
    const { user } = useAuth()
    const { toast } = useToast()
    const [c, setC] = useState(null)
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(null)
    const [command, setCommand] = useState(null)   // { title, session }
    const [confirmDel, setConfirmDel] = useState(false)
    const [cleanup, setCleanup] = useState(true)
    const mayChange = can(user?.role, 'cluster:delete', id)
    const load = useCallback(() => call(`/api/connect/clusters/${id}`).then(d => { setC(d); setError(null) }).catch(e => setError(e.message)), [id])
    useEffect(() => { load() }, [load])
    const act = async (what, fn) => { setBusy(what); try { await fn() } catch (e) { toast({ title: 'Not done', message: e.message, type: 'error' }) } finally { setBusy(null) } }
    if (error) return <p className="kz-card p-4 text-sm text-red-200">{error}</p>
    if (!c) return <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
    const p = providers.find(x => x.id === c.provider) || providers.find(x => x.id === 'cloud-other')

    const check = () => act('check', async () => { setC(await call(`/api/connect/clusters/${id}/check`, { method: 'POST' })); toast({ title: 'Checked', type: 'success' }) })
    const setLevel = (level) => act('level', async () => {
        const r = await call(`/api/connect/clusters/${id}/level`, { method: 'PUT', body: { level } })
        if (r.needsCommand) setCommand({ title: 'Run this as a cluster admin to give KubeEZ Full manage', session: r })
        else { toast({ title: `Now ${LEVEL_LABEL[level]}`, type: 'success' }); load() }
    })
    const rotate = () => act('rotate', async () => {
        const r = await call(`/api/connect/clusters/${id}/rotate`, { method: 'POST' })
        if (r.needsCommand) setCommand({ title: 'A read-only login cannot renew itself — run this to get a new token', session: r })
        else { toast({ title: 'New token in use', message: r.note || 'The old one stops working.', type: 'success' }); load() }
    })
    const reconnect = (method) => act('reconnect', async () => setCommand({ title: method === 'agent' ? 'Move it to the KubeEZ agent' : 'Connect it again', session: await call(`/api/connect/clusters/${id}/reconnect`, { method: 'POST', body: { method } }) }))
    const disconnect = () => act('delete', async () => {
        const r = await call(`/api/connect/clusters/${id}${cleanup && c.level === 'full' ? '?cleanup=1' : ''}`, { method: 'DELETE' })
        toast({ title: 'Disconnected', message: r.cleaned ? 'KubeEZ removed its login from the cluster.' : 'To remove KubeEZ\'s login from the cluster too, run the cleanup command shown.', type: 'success' })
        if (r.cleanup) setCommand({ title: 'Remove KubeEZ from the cluster (optional)', cleanup: r.cleanup })
        else navigate('/connect')
    })

    return (
        <div className="space-y-5">
            <Link to="/connect" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ChevronLeft className="w-3.5 h-3.5" /> Connected clusters</Link>
            <div className="kz-card p-5">
                <div className="flex flex-wrap items-start gap-4">
                    <ProviderBadge provider={c.provider} group={groupOf(providers, c.provider)} />
                    <div className="flex-1 min-w-[220px]">
                        <h2 className="text-lg font-semibold text-white">{c.name}</h2>
                        <p className="text-xs text-slate-400">{c.providerName}{c.distro ? ` · ${c.distro}` : ''} · Kubernetes {c.version || '?'} · {c.nodeCount} node{c.nodeCount === 1 ? '' : 's'}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3"><StatusDot status={c.status} /><span className="text-xs text-slate-400">last OK {ago(c.lastOk)}</span></div>
                        {c.lastError && c.status === 'lost' && <p className="mt-2 flex items-start gap-1.5 text-xs text-red-200"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{c.lastError}{c.lastHint && <span className="block text-red-200/70">{c.lastHint}</span>}</span></p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={check} disabled={!!busy} className="kz-btn-ghost !text-xs">{busy === 'check' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Check now</button>
                        <Link to={`/cluster/${c.id}`} className="kz-btn-primary !text-xs">Open cluster <ArrowRight className="w-3.5 h-3.5" /></Link>
                    </div>
                </div>
                <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                    <div><dt className="text-slate-500">Connected through</dt><dd className="mt-0.5 text-slate-200">{METHOD_LABEL[c.method]}{c.method === 'agent' && <span className={`ml-1.5 ${c.agentOnline ? 'text-emerald-300' : 'text-red-300'}`}>{c.agentOnline ? '● online' : '● offline'}</span>}</dd></div>
                    <div><dt className="text-slate-500">API server</dt><dd className="mt-0.5 font-mono text-slate-200 truncate" title={c.server || 'inside the cluster (agent)'}>{c.server || 'inside the cluster'}</dd></div>
                    <div><dt className="text-slate-500">Access</dt><dd className="mt-0.5 text-slate-200">{LEVEL_LABEL[c.level]}</dd></div>
                    <div><dt className="text-slate-500">Connected</dt><dd className="mt-0.5 text-slate-200">{c.connectedAt ? new Date(c.connectedAt).toLocaleString() : '—'}</dd></div>
                </dl>
            </div>

            {command && (
                <div className="kz-card p-5 space-y-3 ring-1 ring-blue-400/40">
                    <p className="text-sm font-semibold text-white">{command.title}</p>
                    {command.cleanup ? <CopyBlock text={command.cleanup} multiline /> : command.session.method === 'agent'
                        ? <><CopyBlock text={command.session.commands.agent} label="kubectl" /><CopyBlock text={command.session.commands.helm} label="or helm" /></>
                        : <><CopyBlock text={command.session.commands.connect.sh} label="Linux / macOS" /><CopyBlock text={command.session.commands.connect.ps1} label="Windows PowerShell" /></>}
                    <p className="text-[11px] text-slate-500">{command.cleanup ? 'Run it where kubectl works for the cluster.' : 'Run it where kubectl works for the cluster; this page updates when KubeEZ has checked it.'}</p>
                    <div className="flex gap-2">
                        {!command.cleanup && <button type="button" onClick={() => { setCommand(null); load() }} className="kz-btn-ghost !text-xs"><RefreshCw className="w-3.5 h-3.5" /> I ran it — refresh</button>}
                        <button type="button" onClick={() => { setCommand(null); if (command.cleanup) navigate('/connect') }} className="kz-btn-ghost !text-xs">Close</button>
                    </div>
                </div>
            )}

            <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
                <div className="kz-card p-5">
                    <h3 className="mb-4 text-sm font-semibold text-white">What KubeEZ can do on it</h3>
                    <FeatureList features={c.features} />
                </div>
                {mayChange && c.method !== 'ssh' && (
                    <div className="kz-card p-5 space-y-4">
                        <h3 className="text-sm font-semibold text-white">Connection settings</h3>
                        <div className="space-y-2">
                            <p className="text-[11px] uppercase tracking-wider text-slate-500">Access</p>
                            {c.level === 'read'
                                ? <button type="button" disabled={!!busy} onClick={() => setLevel('full')} className="kz-btn-ghost !text-xs w-full justify-start"><ShieldAlert className="w-3.5 h-3.5" /> Give Full manage (runs a command as cluster admin)</button>
                                : <button type="button" disabled={!!busy} onClick={() => window.confirm('Switch to Read-only? KubeEZ removes its cluster-admin binding; add-ons, fixes and backups stop.') && setLevel('read')} className="kz-btn-ghost !text-xs w-full justify-start"><ShieldCheck className="w-3.5 h-3.5" /> Switch to Read-only</button>}
                        </div>
                        <div className="space-y-2">
                            <p className="text-[11px] uppercase tracking-wider text-slate-500">Login</p>
                            <button type="button" disabled={!!busy} onClick={rotate} className="kz-btn-ghost !text-xs w-full justify-start"><KeyRound className="w-3.5 h-3.5" /> Renew the token</button>
                            <button type="button" disabled={!!busy} onClick={() => reconnect(c.method === 'agent' ? 'agent' : 'auto')} className="kz-btn-ghost !text-xs w-full justify-start"><PlugZap className="w-3.5 h-3.5" /> Reconnect (new command)</button>
                            {c.method !== 'agent' && <button type="button" disabled={!!busy} onClick={() => reconnect('agent')} className="kz-btn-ghost !text-xs w-full justify-start"><Radio className="w-3.5 h-3.5" /> Move to the KubeEZ agent</button>}
                        </div>
                        <div className="space-y-2">
                            <p className="text-[11px] uppercase tracking-wider text-slate-500">Nodes</p>
                            {groupOf(providers, c.provider) === 'cloud'
                                ? <p className="flex items-start gap-1.5 text-[11px] text-slate-400"><Server className="w-3.5 h-3.5 mt-0.5 shrink-0" />{c.cloud?.supported ? 'The provider runs the control plane and etcd. Node pools and upgrades: the cloud account below.' : 'The provider runs the control plane — etcd backups, upgrades and node pools happen in its console.'}</p>
                                : <SshNodes c={c} onChanged={load} />}
                        </div>
                        <div className="space-y-2 border-t border-white/5 pt-4">
                            {!confirmDel ? <button type="button" onClick={() => setConfirmDel(true)} className="kz-btn-ghost !text-xs !text-red-300 w-full justify-start"><Trash2 className="w-3.5 h-3.5" /> Disconnect</button> : (
                                <div className="space-y-2 rounded-xl border border-red-400/30 bg-red-500/5 p-3">
                                    <p className="text-xs text-red-100">KubeEZ forgets {c.name}: no more monitoring, alerts or AI for it. The cluster itself keeps running.</p>
                                    {c.level === 'full' && <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={cleanup} onChange={e => setCleanup(e.target.checked)} /> Also remove KubeEZ's login and agent from the cluster</label>}
                                    <div className="flex gap-2"><button type="button" onClick={() => setConfirmDel(false)} className="kz-btn-ghost !text-xs">Cancel</button><button type="button" disabled={!!busy} onClick={disconnect} className="kz-btn-primary !text-xs !bg-red-600">{busy === 'delete' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Disconnect</button></div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
            <CloudAccount c={c} onChanged={load} />
            {c.nodes?.length > 0 && (
                <div className="kz-card p-5 overflow-x-auto">
                    <h3 className="mb-3 text-sm font-semibold text-white">Nodes (as the cluster reports them)</h3>
                    <table className="w-full text-xs"><thead><tr className="text-left text-slate-500"><th className="py-1.5 font-medium">Name</th><th className="font-medium">Role</th><th className="font-medium">Ready</th><th className="font-medium">Address</th><th className="font-medium">OS</th><th className="font-medium">Kubelet</th></tr></thead>
                        <tbody className="text-slate-300">{c.nodes.map(n => <tr key={n.name} className="border-t border-white/5"><td className="py-1.5 font-mono">{n.name}</td><td>{n.role}</td><td className={n.ready ? 'text-emerald-300' : 'text-red-300'}>{n.ready ? 'Ready' : 'Not ready'}</td><td className="font-mono">{n.ip || '—'}</td><td>{n.os}</td><td>{n.version}</td></tr>)}</tbody></table>
                </div>
            )}
        </div>
    )
}

// ── the KubeEZ agents inside clusters ──
export function Agents() {
    const { user } = useAuth()
    const { toast } = useToast()
    const [list, setList] = useState(null)
    const [error, setError] = useState(null)
    const load = useCallback(() => call('/api/connect/agents').then(d => { setList(d.agents); setError(null) }).catch(e => setError(e.message)), [])
    useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])
    const remove = async (a) => {
        if (!window.confirm(`Remove the agent of ${a.clusterName || a.label}? KubeEZ stops reaching that cluster through it.`)) return
        try { const r = await call(`/api/connect/agents/${a.agentId}`, { method: 'DELETE' }); toast({ title: 'Agent removed', message: `In the cluster, also run: ${r.cleanup}`, type: 'success' }); load() } catch (e) { toast({ title: 'Not removed', message: e.message, type: 'error' }) }
    }
    if (error) return <p className="kz-card p-4 text-sm text-red-200">{error}</p>
    if (!list) return <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
    return (
        <div className="space-y-4">
            <div className="kz-card p-4 text-xs text-slate-400 leading-relaxed">
                The KubeEZ agent runs inside a connected cluster (namespace <code>kubeez-system</code>) and connects <b className="text-slate-200">out</b> to KubeEZ — no inbound port, and it only reaches that cluster's API and Services. It downloads its newest version each time it starts, so <b className="text-slate-200">updating it is a restart</b>:
                <div className="mt-2"><CopyBlock text="kubectl -n kubeez-system rollout restart deploy/kubeez-agent" /></div>
            </div>
            {!list.length ? <p className="kz-card p-6 text-sm text-slate-400">No agents yet — they appear when a cluster is connected with the KubeEZ agent method.</p> : (
                <div className="kz-card overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-500"><th className="px-4 py-3 font-medium">Cluster</th><th className="font-medium">Status</th><th className="font-medium">Last heard</th><th className="font-medium">Abilities</th><th className="font-medium">Created</th><th /></tr></thead>
                        <tbody>{list.map(a => (
                            <tr key={a.agentId} className="border-t border-white/5">
                                <td className="px-4 py-3">{a.clusterId && a.connected ? <Link to={`/connect/cluster/${a.clusterId}`} className="font-medium text-white hover:underline">{a.clusterName}</Link> : <span className="text-slate-300">{a.label}<span className="block text-[11px] text-amber-300">waiting for its first connection</span></span>}</td>
                                <td className={`text-xs ${a.online ? 'text-emerald-300' : 'text-red-300'}`}>{a.online ? '● online' : '● offline'}</td>
                                <td className="text-xs text-slate-400">{ago(a.lastSeen)}</td>
                                <td className="text-[11px] text-slate-400">{a.caps.length ? a.caps.join(', ') : '—'}</td>
                                <td className="text-xs text-slate-400">{new Date(a.createdAt).toLocaleDateString()}</td>
                                <td className="pr-4 text-right">{can(user?.role, 'cluster:delete') && <button type="button" onClick={() => remove(a)} className="kz-btn-ghost !py-1 !text-[11px] !text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>}</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

// ── setup guides ──
export function Guides({ providers }) {
    const { provider } = useParams()
    const p = providers.find(x => x.id === provider)
    if (p) return (
        <div className="space-y-4">
            <Link to="/connect/guides" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"><ChevronLeft className="w-3.5 h-3.5" /> All guides</Link>
            <div className="grid gap-5 lg:grid-cols-2">
                <div className="kz-card p-5"><h3 className="mb-4 flex items-center gap-3 text-sm font-semibold text-white"><ProviderBadge provider={p.id} group={p.group} size="sm" />{p.name} — with the KubeEZ agent (recommended)</h3><Guide provider={p} method="agent" /></div>
                {!p.agentOnly && <div className="kz-card p-5"><h3 className="mb-4 text-sm font-semibold text-white">{p.name} — with the connect command</h3><Guide provider={p} method="connect" /></div>}
            </div>
            <Link to="/connect/new" className="kz-btn-primary !text-xs inline-flex"><Plus className="w-3.5 h-3.5" /> Get your commands — Add existing cluster</Link>
        </div>
    )
    return (
        <div className="space-y-6">
            {[['cloud', 'Cloud'], ['onprem', 'On-prem'], ['other', 'Other']].map(([g, t]) => (
                <div key={g}>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{t}</p>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {providers.filter(x => x.group === g).map(x => (
                            <Link key={x.id} to={`/connect/guides/${x.id}`} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 hover:border-white/25">
                                <ProviderBadge provider={x.id} group={x.group} size="sm" />
                                <span><span className="block text-sm text-white">{x.name}</span><span className="text-[11px] text-slate-500 inline-flex items-center gap-1"><BookOpen className="w-3 h-3" /> setup guide</span></span>
                            </Link>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}
