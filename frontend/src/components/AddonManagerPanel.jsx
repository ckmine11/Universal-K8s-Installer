import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../context/AuthContext'
import { useToast } from './ToastProvider'
import { ADDONS_LIST } from '../config/addons'
import {
    Network, LayoutDashboard, BarChart3, Shield, Database, GitBranch, Package,
    RefreshCw, Loader2, ScrollText, Wrench, Trash2, Download, X, ChevronDown, RotateCcw,
    AlertTriangle, CheckCircle2, CircleDashed, XCircle, Settings2, ExternalLink
} from 'lucide-react'

const ICONS = { Network, LayoutDashboard, BarChart3, Shield, Database, GitBranch }

const HEALTH = {
    healthy:         { label: 'Healthy',       cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20', Icon: CheckCircle2 },
    starting:        { label: 'Starting',      cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20',     Icon: Loader2, spin: true },
    failed:          { label: 'Failing',       cls: 'text-red-400 bg-red-500/10 border-red-500/20',           Icon: XCircle },
    removing:        { label: 'Removing',      cls: 'text-slate-300 bg-white/5 border-white/10',              Icon: Loader2, spin: true },
    'not-installed': { label: 'Not installed', cls: 'text-slate-500 bg-white/[0.03] border-white/10',         Icon: CircleDashed }
}

// What an uninstall removes — shown in the confirmation dialog
const UNINSTALL_NOTES = {
    ingress: 'Ingress resources stop receiving traffic. Your Ingress objects stay.',
    monitoring: 'Prometheus data and the Grafana dashboards are deleted.',
    dashboard: 'The dashboard and its login accounts are removed.',
    'cert-manager': 'Every Certificate, Issuer and ClusterIssuer in the cluster is removed (existing TLS secrets stay).',
    longhorn: 'Refused while any volume still uses Longhorn — delete those PVCs first. Longhorn\'s own uninstaller then runs (takes a few minutes).',
    argocd: 'ArgoCD and its Applications are removed. Apps it already deployed keep running.',
    seaweedfs: 'Every bucket and object is deleted (data stored directly on a node folder is kept there).'
}

function fmtAge(iso) {
    if (!iso) return ''
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (m < 60) return `${m}m`
    if (m < 1440) return `${Math.round(m / 60)}h`
    return `${Math.round(m / 1440)}d`
}

function LogsModal({ clusterId, addon, onClose }) {
    const [pod, setPod] = useState('')
    const [tail, setTail] = useState(200)
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [follow, setFollow] = useState(false)
    const bottom = useRef(null)

    const load = async (quiet) => {
        if (!quiet) setLoading(true)
        setError(null)
        try {
            const q = new URLSearchParams({ tail: String(tail), ...(pod ? { pod } : {}) })
            const res = await apiFetch(`/api/clusters/${clusterId}/addons/${addon.key}/logs?${q}`)
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Could not load logs')
            setData(json)
        } catch (e) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { load() }, [pod, tail])
    useEffect(() => {
        if (!follow) return
        const t = setInterval(() => load(true), 5000)
        return () => clearInterval(t)
    }, [follow, pod, tail])
    useEffect(() => { if (follow) bottom.current?.scrollIntoView() }, [data])

    return (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <div className="glass w-full max-w-5xl max-h-[88vh] flex flex-col rounded-2xl border border-white/10" onClick={e => e.stopPropagation()}>
                <div className="flex flex-wrap items-center gap-3 p-4 border-b border-white/5">
                    <ScrollText className="w-5 h-5 text-blue-400" />
                    <div className="mr-auto">
                        <h3 className="text-white font-black">{addon.label} — logs</h3>
                        <p className="text-slate-500 text-xs">namespace {addon.namespace}</p>
                    </div>
                    <select value={pod} onChange={e => setPod(e.target.value)}
                        className="bg-black/40 border border-white/10 rounded-lg text-xs text-slate-200 px-2 py-1.5 max-w-[16rem]">
                        <option value="">All pods (first 6)</option>
                        {(data?.pods || addon.pods).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </select>
                    <select value={tail} onChange={e => setTail(Number(e.target.value))}
                        className="bg-black/40 border border-white/10 rounded-lg text-xs text-slate-200 px-2 py-1.5">
                        {[100, 200, 500, 1000].map(n => <option key={n} value={n}>last {n} lines</option>)}
                    </select>
                    <label className="flex items-center gap-1.5 text-xs text-slate-400 select-none">
                        <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> Auto-refresh
                    </label>
                    <button onClick={() => load()} className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300" title="Refresh">
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-slate-400" title="Close"><X className="w-4 h-4" /></button>
                </div>

                <div className="overflow-auto p-4 space-y-4 text-[11px] font-mono leading-relaxed">
                    {loading && !data && <div className="py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>}
                    {error && <p className="text-red-400 font-sans text-sm">{error}</p>}
                    {data && data.logs.length === 0 && <p className="text-slate-500 font-sans text-sm">No pods in this add-on right now.</p>}
                    {data?.logs.map(l => (
                        <div key={l.pod}>
                            <div className="text-blue-300 font-bold mb-1">▸ {l.pod}</div>
                            {l.previous && (
                                <details className="mb-2">
                                    <summary className="cursor-pointer text-amber-300 font-sans text-xs">This pod restarted — show the log of the run that crashed</summary>
                                    <pre className="mt-1 whitespace-pre-wrap break-all text-amber-200/80 bg-amber-500/5 border border-amber-500/10 rounded-lg p-3">{l.previous}</pre>
                                </details>
                            )}
                            <pre className="whitespace-pre-wrap break-all text-slate-300 bg-black/40 border border-white/5 rounded-lg p-3">{l.log}</pre>
                        </div>
                    ))}
                    {data?.events && (
                        <div>
                            <div className="text-blue-300 font-bold mb-1">▸ Recent events</div>
                            <pre className="whitespace-pre-wrap break-all text-slate-400 bg-black/40 border border-white/5 rounded-lg p-3">{data.events}</pre>
                        </div>
                    )}
                    <div ref={bottom} />
                </div>
            </div>
        </div>
    )
}

function UninstallModal({ addon, action, onCancel, onConfirm, busy }) {
    const [typed, setTyped] = useState('')
    const ok = !addon.keepsData || typed.trim() === addon.key
    const reinstall = action === 'reinstall'
    const ActionIcon = reinstall ? RotateCcw : Trash2
    return (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={onCancel}>
            <div className="glass w-full max-w-md rounded-2xl border border-red-500/20 p-6" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 rounded-xl bg-red-500/10 border border-red-500/20"><ActionIcon className="w-5 h-5 text-red-400" /></div>
                    <h3 className="text-white font-black text-lg">{reinstall ? 'Reinstall' : 'Uninstall'} {addon.label}?</h3>
                </div>
                <p className="text-slate-300 text-sm mb-2">
                    {reinstall
                        ? <>Completely removes the add-on (the <span className="font-mono">{addon.namespace}</span> namespace and everything it created), then installs it fresh with new settings and credentials. Use <b>Repair</b> instead to fix it while keeping data.</>
                        : <>Removes the <span className="font-mono">{addon.namespace}</span> namespace and everything the add-on created in the cluster.</>}
                </p>
                <p className="text-slate-400 text-sm mb-4">{UNINSTALL_NOTES[addon.key]}</p>
                {addon.keepsData && (
                    <div className="mb-4">
                        <label className="text-xs text-red-300 block mb-1.5">
                            This deletes data. Type <span className="font-mono font-bold">{addon.key}</span> to confirm:
                        </label>
                        <input autoFocus value={typed} onChange={e => setTyped(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono" />
                    </div>
                )}
                <div className="flex justify-end gap-2">
                    <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm font-bold text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10">Cancel</button>
                    <button disabled={!ok || busy} onClick={onConfirm}
                        className="px-4 py-2 rounded-xl text-sm font-black text-white bg-red-600 hover:bg-red-500 disabled:opacity-40 flex items-center gap-2">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ActionIcon className="w-4 h-4" />} {reinstall ? 'Reinstall' : 'Uninstall'}
                    </button>
                </div>
            </div>
        </div>
    )
}

export default function AddonManagerPanel({ clusterId, canManage = false }) {
    const navigate = useNavigate()
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [open, setOpen] = useState({})            // key → pods table expanded
    const [logsFor, setLogsFor] = useState(null)    // addon
    const [uninstallFor, setUninstallFor] = useState(null) // { addon, action: 'uninstall' | 'reinstall' }
    const [starting, setStarting] = useState(null)  // key of the action being started

    const load = async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/addons/status`)
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Could not read add-on status')
            setData(json)
        } catch (e) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { load() }, [clusterId])

    // Install / repair = run the add-on's (idempotent) installer as a job
    const install = async (addon, repair) => {
        setStarting(addon.key)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/addons`, {
                method: 'POST', body: JSON.stringify({ addons: { [addon.key]: true } })
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Could not start')
            toast({ title: repair ? 'Repair started' : 'Install started', message: addon.label, type: 'success' })
            navigate(`/dashboard/${json.newInstallationId}`)
        } catch (e) {
            toast({ title: 'Not started', message: e.message, type: 'error' })
        } finally {
            setStarting(null)
        }
    }

    const uninstall = async () => {
        const { addon, action } = uninstallFor
        setStarting(addon.key)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/addons/${addon.key}/${action}`, {
                method: 'POST', body: JSON.stringify({ confirm: addon.key })
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Could not start')
            navigate(`/dashboard/${json.newInstallationId}`)
        } catch (e) {
            toast({ title: 'Not started', message: e.message, type: 'error' })
        } finally {
            setStarting(null)
            setUninstallFor(null)
        }
    }

    const job = data?.runningJob
    const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none'

    return (
        <div className="glass rounded-2xl border border-white/8 p-6">
            <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                    <Settings2 className="w-5 h-5 text-blue-400" />
                    <div>
                        <h3 className="text-lg font-black text-white tracking-tight">Manage Add-ons</h3>
                        <p className="text-slate-500 text-xs mt-0.5">Live status, logs, install, repair and uninstall — no terminal needed</p>
                    </div>
                </div>
                <button onClick={load} disabled={loading}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-xs font-bold transition-all active:scale-95 disabled:opacity-50">
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
                </button>
            </div>

            {job && (
                <div className="mb-4 flex items-center gap-3 p-3 rounded-xl border border-blue-500/20 bg-blue-500/5 text-sm text-blue-200">
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    <span className="flex-1">An operation is running on this cluster — actions are paused until it finishes.</span>
                    <button onClick={() => navigate(`/dashboard/${job.id}`)} className="flex items-center gap-1 text-xs font-bold text-blue-300 hover:underline">
                        View progress <ExternalLink className="w-3 h-3" />
                    </button>
                </div>
            )}

            {loading && !data && (
                <div className="py-10 flex flex-col items-center gap-3 text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
                    <p className="text-sm">Reading add-on status from the cluster...</p>
                </div>
            )}
            {error && (
                <div className="py-6 text-center">
                    <p className="text-red-400 text-sm mb-2">{error}</p>
                    <button onClick={load} className="text-xs font-bold text-blue-400 hover:underline">Try again</button>
                </div>
            )}

            {data && (
                <div className="divide-y divide-white/5">
                    {data.addons.map(a => {
                        const meta = ADDONS_LIST.find(x => x.key === a.key)
                        const Icon = ICONS[meta?.iconName] || Package
                        const h = HEALTH[a.health] || HEALTH['not-installed']
                        const live = a.pods.filter(p => p.phase !== 'Succeeded')
                        const ready = live.filter(p => p.phase === 'Running' && p.allReady).length
                        const restarts = live.reduce((n, p) => n + p.restarts, 0)
                        const present = a.health !== 'not-installed'
                        const disabled = !!job || a.health === 'removing' || starting === a.key
                        return (
                            <div key={a.key} className="py-3">
                                <div className="flex flex-wrap items-center gap-3">
                                    <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20"><Icon className="w-4 h-4 text-blue-400" /></div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-black text-white text-sm">{a.label}</span>
                                            <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black uppercase tracking-widest ${h.cls}`}>
                                                <h.Icon className={`w-3 h-3 ${h.spin ? 'animate-spin' : ''}`} /> {h.label}
                                            </span>
                                        </div>
                                        {present && (
                                            <button onClick={() => setOpen(o => ({ ...o, [a.key]: !o[a.key] }))}
                                                className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300">
                                                {ready}/{live.length} pods ready{restarts ? ` · ${restarts} restarts` : ''} · {a.namespace}
                                                <ChevronDown className={`w-3 h-3 transition-transform ${open[a.key] ? 'rotate-180' : ''}`} />
                                            </button>
                                        )}
                                    </div>

                                    {canManage && (
                                        <div className="flex items-center gap-1.5">
                                            {present ? (
                                                <>
                                                    <button className={`${btn} text-slate-200 bg-white/5 hover:bg-white/10 border-white/10`} onClick={() => setLogsFor(a)}>
                                                        <ScrollText className="w-3.5 h-3.5" /> Logs
                                                    </button>
                                                    <button className={`${btn} text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/20`} disabled={disabled}
                                                        title="Run the installer again — fixes missing or broken parts, keeps data and settings"
                                                        onClick={() => install(a, true)}>
                                                        {starting === a.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />} Repair
                                                    </button>
                                                    <button className={`${btn} text-orange-200 bg-orange-500/10 hover:bg-orange-500/20 border-orange-500/20`} disabled={disabled}
                                                        title="Remove completely, then install fresh"
                                                        onClick={() => setUninstallFor({ addon: a, action: 'reinstall' })}>
                                                        <RotateCcw className="w-3.5 h-3.5" /> Reinstall
                                                    </button>
                                                    <button className={`${btn} text-red-300 bg-red-500/10 hover:bg-red-500/20 border-red-500/20`} disabled={disabled}
                                                        onClick={() => setUninstallFor({ addon: a, action: 'uninstall' })}>
                                                        <Trash2 className="w-3.5 h-3.5" /> Uninstall
                                                    </button>
                                                </>
                                            ) : (
                                                <button className={`${btn} text-blue-200 bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/20`} disabled={disabled}
                                                    onClick={() => install(a, false)}>
                                                    {starting === a.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Install
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {a.health === 'failed' && (
                                    <p className="mt-2 ml-11 flex items-start gap-1.5 text-[11px] text-red-300/90">
                                        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                                        {live.filter(p => p.reason).map(p => `${p.name}: ${p.reason}`).join(' · ') || 'A pod is failing.'} — open Logs to see why, fix it, then Repair.
                                    </p>
                                )}

                                {open[a.key] && present && (
                                    <div className="mt-2 ml-11 overflow-x-auto">
                                        <table className="w-full text-[11px]">
                                            <thead className="text-slate-500 text-left">
                                                <tr><th className="py-1 pr-3 font-bold">Pod</th><th className="pr-3 font-bold">Ready</th><th className="pr-3 font-bold">Status</th><th className="pr-3 font-bold">Restarts</th><th className="pr-3 font-bold">Node</th><th className="font-bold">Age</th></tr>
                                            </thead>
                                            <tbody className="text-slate-300 font-mono">
                                                {a.pods.map(p => (
                                                    <tr key={p.name} className="border-t border-white/5">
                                                        <td className="py-1 pr-3 truncate max-w-[18rem]">{p.name}</td>
                                                        <td className="pr-3">{p.ready}</td>
                                                        <td className={`pr-3 ${p.reason && p.phase !== 'Succeeded' ? 'text-red-300' : ''}`}>{p.reason || p.phase}</td>
                                                        <td className="pr-3">{p.restarts}</td>
                                                        <td className="pr-3">{p.node || '—'}</td>
                                                        <td>{fmtAge(p.createdAt)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            {logsFor && <LogsModal clusterId={clusterId} addon={logsFor} onClose={() => setLogsFor(null)} />}
            {uninstallFor && <UninstallModal addon={uninstallFor.addon} action={uninstallFor.action} busy={starting === uninstallFor.addon.key} onCancel={() => setUninstallFor(null)} onConfirm={uninstall} />}
        </div>
    )
}
