import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../context/AuthContext'
import { explorerBase } from './explorerLinks'
import {
    Compass, ExternalLink, RefreshCw, Loader2, Download, AlertTriangle, Maximize2, Minimize2,
    Boxes, GitBranch, History, ShieldCheck, ArrowUpCircle, Network, ScrollText, Lock
} from 'lucide-react'

const FEATURES = [
    [Boxes, 'Every resource', 'Browse all objects and CRDs — YAML, events, logs, problems first'],
    [Network, 'Topology', 'How deployments, pods, services and ingresses connect'],
    [History, 'Timeline', 'What changed and when — diffs of every change'],
    [GitBranch, 'Helm & GitOps', 'Releases, values, rollbacks; Argo CD / Flux sync and drift'],
    [ShieldCheck, 'Cluster audit', '31 security, reliability and efficiency checks'],
    [ArrowUpCircle, 'Upgrade impact', 'Blockers for the next Kubernetes version, before you upgrade']
]

/**
 * The Cluster Explorer inside the cluster page. Radar runs in the cluster;
 * KubeEZ is its only door (your login, your role → Kubernetes RBAC).
 */
export default function ExplorerTab({ clusterId, installed, canInstall, role }) {
    const navigate = useNavigate()
    const [state, setState] = useState(installed ? 'checking' : 'absent')   // checking | ready | absent | error
    const [error, setError] = useState(null)
    const [installing, setInstalling] = useState(false)
    const [full, setFull] = useState(false)
    const frame = useRef(null)
    const src = `${explorerBase(clusterId)}/`

    const probe = async () => {
        setState('checking'); setError(null)
        try {
            const r = await apiFetch(`${explorerBase(clusterId)}/api/health`)
            if (r.ok) return setState('ready')
            const j = await r.json().catch(() => ({}))
            if (r.status === 404 && j.code === 'NOT_INSTALLED') return setState('absent')
            setError(j.error || `The Explorer answered ${r.status}`); setState('error')
        } catch (e) { setError(e.message); setState('error') }
    }
    useEffect(() => { if (installed) probe(); else setState('absent') }, [clusterId, installed])

    const install = async () => {
        setInstalling(true)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/addons`, { method: 'POST', body: JSON.stringify({ addons: { explorer: true } }) })
            const j = await r.json().catch(() => ({}))
            if (!r.ok || !j.newInstallationId) throw new Error(j.error || 'Could not start the install')
            navigate(`/dashboard/${j.newInstallationId}`)
        } catch (e) { setError(e.message); setState('error') } finally { setInstalling(false) }
    }

    if (state === 'absent' || (state === 'error' && !installed)) {
        return (
            <div className="glass rounded-2xl border border-white/8 p-8 relative overflow-hidden">
                <div className="absolute -top-24 -right-20 w-80 h-80 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
                <div className="relative max-w-3xl">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20"><Compass className="w-6 h-6 text-cyan-400" /></div>
                        <div>
                            <h2 className="text-xl font-black text-white">Cluster Explorer</h2>
                            <p className="text-xs text-slate-500">A full Kubernetes UI — right here, with your KubeEZ login</p>
                        </div>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 my-6">
                        {FEATURES.map(([Icon, t, d]) => (
                            <div key={t} className="flex gap-3 rounded-xl border border-white/8 bg-white/[0.02] p-3">
                                <Icon className="w-4 h-4 text-cyan-300 shrink-0 mt-0.5" />
                                <div><p className="text-sm font-bold text-white">{t}</p><p className="text-[11px] text-slate-400">{d}</p></div>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mb-6">
                        <span className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1"><Lock className="w-3 h-3" /> No open ports — through KubeEZ's tunnel</span>
                        <span className="rounded-lg border border-white/10 px-2 py-1">Your role decides what you may change (Kubernetes RBAC)</span>
                        <span className="rounded-lg border border-white/10 px-2 py-1">Also powers the upgrade safety check & health score</span>
                    </div>
                    {error && <p className="text-xs text-red-300 mb-3">{error}</p>}
                    {canInstall ? (
                        <button onClick={install} disabled={installing}
                            className="flex items-center gap-2 px-5 py-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-black disabled:opacity-50">
                            {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Install the Explorer
                        </button>
                    ) : <p className="text-sm text-slate-400">Ask an Org Admin or Operator to install the Explorer.</p>}
                    <p className="text-[10px] text-slate-600 mt-4">Powered by Radar (Apache-2.0) by Skyhook — runs inside your cluster, ~200 MB memory.</p>
                </div>
            </div>
        )
    }

    return (
        <div className={full ? 'fixed inset-0 z-40 bg-[#0B0F1E] flex flex-col' : 'glass rounded-2xl border border-white/8 overflow-hidden flex flex-col'}>
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-white/8 bg-black/20">
                <div className="flex items-center gap-2 min-w-0">
                    <Compass className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span className="text-sm font-black text-white">Cluster Explorer</span>
                    <span className="hidden sm:inline text-[10px] text-slate-500 truncate">signed in as you · {role === 'viewer' ? 'read-only' : role === 'operator' ? 'edit' : 'full access'} · powered by Radar</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <button onClick={() => { if (frame.current) frame.current.src = src; probe() }} aria-label="Reload" className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"><RefreshCw className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setFull(f => !f)} aria-label={full ? 'Exit full screen' : 'Full screen'} className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5">
                        {full ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                    </button>
                    <a href={src} target="_blank" rel="noopener" className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 text-[11px] font-bold">
                        <ExternalLink className="w-3.5 h-3.5" /> New tab
                    </a>
                </div>
            </div>
            {state === 'checking' && (
                <div className="flex-1 min-h-[60vh] flex flex-col items-center justify-center gap-3 text-sm text-slate-500"><Loader2 className="w-6 h-6 animate-spin text-cyan-400" /> Connecting to the Explorer through the tunnel…</div>
            )}
            {state === 'error' && (
                <div className="flex-1 min-h-[40vh] flex flex-col items-center justify-center gap-3 p-6 text-center">
                    <AlertTriangle className="w-7 h-7 text-amber-400" />
                    <p className="text-sm text-slate-300 max-w-lg">{error}</p>
                    <button onClick={probe} className="text-xs font-bold text-blue-300 hover:underline">Try again</button>
                    <p className="text-[11px] text-slate-500">If it keeps failing: Add-ons → Cluster Explorer → Logs / Repair.</p>
                </div>
            )}
            {state === 'ready' && (
                <iframe ref={frame} title="Cluster Explorer" src={src}
                    className={full ? 'flex-1 w-full border-0' : 'w-full h-[78vh] border-0'}
                    allow="clipboard-read; clipboard-write" />
            )}
        </div>
    )
}
