import { useState, useEffect, useCallback } from 'react'
import { GitBranch, RefreshCw, Loader2, AlertTriangle, CheckCircle2, XCircle, PauseCircle, CircleDashed, ChevronDown, ChevronRight, Search, Lock, ExternalLink, Play } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useToast } from '../ToastProvider'
import AiExplain from '../ai/AiExplain'

// GitOps view of one cluster: Argo CD Applications and Flux Kustomizations /
// HelmReleases — sync and health, repo and revision, what drifted — with
// "Sync now" / "Refresh" for members with gitops:sync (backend enforces it).
const SYNC_TONE = { Synced: 'text-emerald-300 border-emerald-400/25 bg-emerald-500/10', OutOfSync: 'text-amber-200 border-amber-400/30 bg-amber-500/10', Failed: 'text-red-300 border-red-400/30 bg-red-500/10', Unknown: 'text-slate-300 border-white/10 bg-white/5' }
const HEALTH_TONE = { Healthy: 'text-emerald-300', Progressing: 'text-blue-300', Degraded: 'text-red-300', Missing: 'text-red-300', Suspended: 'text-slate-400', Unknown: 'text-slate-400' }
const HEALTH_ICON = { Healthy: CheckCircle2, Progressing: Loader2, Degraded: XCircle, Missing: XCircle, Suspended: PauseCircle, Unknown: CircleDashed }
const FILTERS = [
    ['all', 'All', () => true],
    ['problem', 'Needs attention', a => ['Failed', 'OutOfSync'].includes(a.sync) || ['Degraded', 'Missing'].includes(a.health)],
    ['synced', 'Synced', a => a.sync === 'Synced'],
    ['progressing', 'Progressing', a => a.health === 'Progressing' || a.running],
    ['suspended', 'Suspended', a => a.suspended]
]
const TOOL_NAME = { argocd: 'Argo CD', flux: 'Flux' }
// same rule as the backend (services/gitops.js problemOf): what can be explained
const hasProblem = (a) => !a.suspended && (a.sync === 'Failed' || ['Degraded', 'Missing'].includes(a.health) || (a.sync === 'OutOfSync' && !a.running))
const ago = (iso) => {
    if (!iso) return null
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

function ToolStatus({ tool, status, canInstall, onInstall }) {
    if (!status || status.state === 'ok') return null
    if (status.state === 'missing') return (
        <p className="text-[11px] text-slate-500">{TOOL_NAME[tool]} is not installed on this cluster.{canInstall && <> <button onClick={onInstall} className="text-blue-300 hover:underline">Install it from Add-ons</button>.</>}</p>
    )
    return <p className="flex items-start gap-1.5 text-[11px] text-amber-200"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{TOOL_NAME[tool]}: {status.message}</p>
}

function SyncButtons({ app, busy, onAct }) {
    const [confirm, setConfirm] = useState(false)
    useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 5000); return () => clearTimeout(t) }, [confirm])
    if (!app.canSync) return null
    const working = busy === app.id
    return (
        <div className="flex items-center gap-1.5">
            {app.tool === 'argocd' && (
                <button onClick={() => onAct(app, 'refresh')} disabled={working} className="kz-btn-ghost !py-1 !px-2 !text-[11px]" title="Compare with Git again (changes nothing)">
                    <RefreshCw className="w-3 h-3" /> Refresh
                </button>
            )}
            <button
                onClick={() => confirm ? (setConfirm(false), onAct(app, 'sync')) : setConfirm(true)}
                disabled={working || app.suspended || (app.tool === 'argocd' && app.running)}
                title={app.suspended ? 'Suspended in Flux — resume it first' : app.running ? 'A sync is already running' : app.tool === 'argocd' ? 'Sync from Git now (no prune)' : 'Ask Flux to reconcile now'}
                className={`${confirm ? 'kz-btn-primary' : 'kz-btn-ghost'} !py-1 !px-2 !text-[11px]`}
            >
                {working ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} {confirm ? 'Confirm sync' : 'Sync now'}
            </button>
        </div>
    )
}

function AppRow({ app, busy, onAct, clusterId, canAi }) {
    const [open, setOpen] = useState(false)
    const HIcon = HEALTH_ICON[app.health] || CircleDashed
    const src = app.source || {}
    const explain = canAi && hasProblem(app)
    const detail = app.drift?.length || app.operation || app.message || explain
    return (
        <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-3">
                <button onClick={() => setOpen(o => !o)} disabled={!detail} className="text-slate-500 disabled:opacity-30" aria-label={open ? 'Hide details' : 'Show details'}>
                    {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <div className="flex-1 min-w-[220px]">
                    <p className="text-sm font-semibold text-white break-all">
                        {app.name}
                        <span className="ml-2 text-[10px] font-medium text-slate-500">{TOOL_NAME[app.tool]} · {app.kind} · {app.namespace}</span>
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono break-all">
                        {src.repo || '—'}{src.path ? ` · ${src.path}` : ''}{src.chart ? ` · chart ${src.chart}` : ''}{src.revision ? ` @ ${src.revision}` : ''}{src.count > 1 ? ` (+${src.count - 1} more sources)` : ''}
                    </p>
                    <p className="text-[11px] text-slate-500">
                        → {app.destination?.external ? <span className="text-amber-200">{app.destination.server}</span> : 'this cluster'}{app.targetNamespaces?.length ? ` · ${app.targetNamespaces.join(', ')}` : ''}
                        {app.revision && <> · at <span className="font-mono text-slate-400">{app.revision}</span></>}
                        {app.lastSyncAt && <> · {ago(app.lastSyncAt)}</>}
                        {app.automated && app.tool === 'argocd' && <> · auto-sync</>}
                    </p>
                </div>
                <span className={`rounded-lg border px-2 py-0.5 text-[11px] font-semibold ${SYNC_TONE[app.sync] || SYNC_TONE.Unknown}`}>{app.sync === 'OutOfSync' ? 'Out of sync' : app.sync}</span>
                <span className={`flex items-center gap-1 text-[11px] font-semibold ${HEALTH_TONE[app.health] || 'text-slate-400'}`}>
                    <HIcon className={`w-3.5 h-3.5 ${app.health === 'Progressing' ? 'animate-spin' : ''}`} />{app.health}
                </span>
                <SyncButtons app={app} busy={busy} onAct={onAct} />
            </div>
            {app.message && !open && <p className="mt-2 ml-7 text-[11px] text-red-300/90 break-words line-clamp-2">{app.message}</p>}
            {open && (
                <div className="mt-3 ml-7 space-y-2">
                    {app.message && <p className="text-[11px] text-red-300/90 break-words whitespace-pre-wrap">{app.message}</p>}
                    {app.operation && (
                        <p className="text-[11px] text-slate-400">
                            Last operation: <span className="text-slate-200">{app.operation.phase}</span>
                            {app.operation.by && <> by {app.operation.by}</>}
                            {app.operation.finishedAt && <> · {new Date(app.operation.finishedAt).toLocaleString()}</>}
                            {app.operation.message && <> · {app.operation.message}</>}
                        </p>
                    )}
                    {app.drift?.length > 0 && (
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Drift — {app.driftCount} resource{app.driftCount === 1 ? '' : 's'} differ from Git or are unhealthy{app.driftCount > app.drift.length ? ` (first ${app.drift.length})` : ''}</p>
                            <ul className="space-y-1">
                                {app.drift.map((r, i) => (
                                    <li key={i} className="text-[11px] font-mono text-slate-300 break-all">
                                        {r.kind} {r.namespace ? `${r.namespace}/` : ''}{r.name}
                                        {r.sync && r.sync !== 'Synced' && <span className="text-amber-200"> · {r.sync}</span>}
                                        {r.health && r.health !== 'Healthy' && <span className="text-red-300"> · {r.health}</span>}
                                        {r.message && <span className="text-slate-500"> · {r.message}</span>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {explain && (
                        <AiExplain url={`/api/ai/explain/gitops/${clusterId}`} body={{ kind: app.kind, namespace: app.namespace, name: app.name }} clusterId={clusterId}
                            label="Explain with AI" hint="KubeEZ AI reads Argo CD / Flux status, events and what changed, and says why — and what to change in Git. Secrets are masked first." />
                    )}
                </div>
            )}
        </li>
    )
}

export default function GitOpsTab({ clusterId, canInstall, onOpenAddons }) {
    const { toast } = useToast()
    const { user } = useAuth()
    const canAi = can(user?.role, 'ai:use', clusterId)
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [filter, setFilter] = useState('all')
    const [q, setQ] = useState('')
    const [busy, setBusy] = useState(null)

    const load = useCallback(async (fresh = false) => {
        setLoading(true); setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/gitops${fresh ? '?fresh=1' : ''}`)
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not read the GitOps apps')
            setData(d)
        } catch (e) { setError(e.message) } finally { setLoading(false) }
    }, [clusterId])
    useEffect(() => { load() }, [load])

    const act = async (app, action) => {
        setBusy(app.id)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/gitops/sync`, { method: 'POST', body: JSON.stringify({ kind: app.kind, namespace: app.namespace, name: app.name, action }) })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'The sync was refused')
            toast({ title: action === 'refresh' ? 'Refresh requested' : 'Sync started', message: d.message, type: 'success' })
            setTimeout(() => load(true), 3000)
        } catch (e) {
            toast({ title: 'Sync failed', message: e.message, type: 'error' })
        } finally { setBusy(null) }
    }

    const apps = data?.apps || []
    const match = FILTERS.find(f => f[0] === filter)?.[2] || (() => true)
    const needle = q.trim().toLowerCase()
    const shown = apps.filter(match).filter(a => !needle || [a.name, a.namespace, a.source?.repo, a.source?.path, a.source?.chart, ...(a.targetNamespaces || [])].some(v => v && String(v).toLowerCase().includes(needle)))
    const s = data?.summary
    const noTools = data && data.tools?.argocd?.state === 'missing' && data.tools?.flux?.state === 'missing'

    return (
        <div className="space-y-5">
            <div className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <GitBranch className="w-5 h-5 text-blue-300" />
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="text-base font-semibold text-white">GitOps</h3>
                        <p className="text-xs text-slate-400">Argo CD and Flux apps on this cluster — are they in sync with Git and healthy, from which repo and revision, and what drifted.</p>
                    </div>
                    {data?.at && <span className="text-[11px] text-slate-500">read {ago(data.at)}</span>}
                    <button onClick={() => load(true)} disabled={loading} className="kz-btn-ghost !py-1.5 !text-xs" aria-label="Read again"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
                </div>

                {s && s.total > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        {[['Apps', s.total, 'text-white'], ['Synced', s.synced, 'text-emerald-300'], ['Out of sync', s.outOfSync, 'text-amber-200'], ['Failed / degraded', Math.max(s.failed, s.degraded), 'text-red-300'], ['Progressing', s.progressing, 'text-blue-300']].map(([l, n, tone]) => (
                            <div key={l} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                                <p className={`text-xl font-bold ${tone}`}>{n}</p>
                                <p className="text-[11px] text-slate-500">{l}</p>
                            </div>
                        ))}
                    </div>
                )}

                {data && (
                    <div className="space-y-1">
                        <ToolStatus tool="argocd" status={data.tools?.argocd} canInstall={canInstall} onInstall={onOpenAddons} />
                        <ToolStatus tool="flux" status={data.tools?.flux} canInstall={canInstall} onInstall={onOpenAddons} />
                    </div>
                )}
                {data?.readOnlyReason && <p className="flex items-center gap-1.5 text-[11px] text-slate-400"><Lock className="w-3.5 h-3.5" />{data.readOnlyReason}</p>}
                {data?.hidden > 0 && <p className="text-[11px] text-slate-500">{data.hidden} app{data.hidden === 1 ? '' : 's'} not shown — they deploy outside your namespaces, cluster-wide or to another cluster.</p>}
                {error && <p className="flex items-center gap-1.5 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
                {loading && !data && <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>}

                {noTools && (
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 text-sm text-slate-300">
                        Neither Argo CD nor Flux runs on this cluster yet. Install one to deploy your apps from Git.
                        {canInstall && <button onClick={onOpenAddons} className="ml-2 inline-flex items-center gap-1 text-blue-300 hover:underline">Open Add-ons <ExternalLink className="w-3 h-3" /></button>}
                    </div>
                )}

                {apps.length > 0 && (
                    <>
                        <div className="flex flex-wrap items-center gap-2">
                            {FILTERS.map(([k, l, f]) => (
                                <button key={k} onClick={() => setFilter(k)} className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${filter === k ? 'bg-blue-500/20 text-white' : 'text-slate-400 hover:bg-white/5'}`}>{l} {apps.filter(f).length}</button>
                            ))}
                            <div className="relative ml-auto">
                                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search apps, repos, namespaces" className="kz-input !py-1.5 !pl-8 !text-xs !w-56" aria-label="Search apps" />
                            </div>
                        </div>
                        {shown.length ? (
                            <ul className="space-y-2">{shown.map(a => <AppRow key={a.id} app={a} busy={busy} onAct={act} clusterId={clusterId} canAi={canAi} />)}</ul>
                        ) : <p className="text-sm text-slate-500 py-2">No apps match.</p>}
                    </>
                )}
                {data && !noTools && !apps.length && !error && <p className="text-sm text-slate-500 py-2">No GitOps apps{data.hidden ? ' you can see' : ''} on this cluster yet.</p>}
            </div>
        </div>
    )
}
