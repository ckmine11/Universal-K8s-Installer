import { useState, useEffect } from 'react'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import OffsiteBackup from './OffsiteBackup'
import RestoreWizard from './backups/RestoreWizard'
import RecoverWizard from './backups/RecoverWizard'
import JobProgress from './backups/JobProgress'
import { useEtcdJob, startJob } from './backups/useEtcdJob'
import {
    Database, RefreshCw, Loader2, ShieldCheck, HardDriveDownload,
    RotateCcw, AlertTriangle, Clock, Zap, Lock, Info, CheckCircle2,
    ChevronDown, Hand, Archive, Cloud, Undo2, BadgeCheck, LifeBuoy, DownloadCloud, X
} from 'lucide-react'

function fmtBytes(b) {
    if (!b) return '0 B'
    const k = 1024, s = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(b) / Math.log(k))
    return `${parseFloat((b / Math.pow(k, i)).toFixed(2))} ${s[i]}`
}

const DAY_MS = 24 * 60 * 60 * 1000

function fmtWhen(iso) {
    return new Date(iso).toLocaleString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    })
}

function fmtAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.round(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
    const days = Math.round(diff / DAY_MS)
    return `${days} day${days === 1 ? '' : 's'} ago`
}

// Snapshot kind → label, short label (for the dropdown) and badge style
const TYPES = {
    'pre-upgrade': { label: 'Before upgrade (automatic)', short: 'Before upgrade', icon: Zap, cls: 'text-blue-300 bg-blue-500/10 border-blue-500/20' },
    'pre-restore': { label: 'Before a restore (automatic undo point)', short: 'Before restore', icon: Undo2, cls: 'text-violet-300 bg-violet-500/10 border-violet-500/20' },
    manual: { label: 'Manual (Backup Now)', short: 'Manual', icon: Hand, cls: 'text-slate-300 bg-white/5 border-white/10' },
    other: { label: 'Snapshot', short: 'Snapshot', icon: Archive, cls: 'text-slate-300 bg-white/5 border-white/10' }
}
const typeOf = (b) => TYPES[b.type] || (b.auto ? TYPES['pre-upgrade'] : TYPES.manual)
const typeFromName = (n) => /pre-upgrade/.test(n) ? 'pre-upgrade' : /pre-restore/.test(n) ? 'pre-restore' : /-manual-/.test(n) ? 'manual' : 'other'
// etcd-<kind>-YYYYmmdd-HHMMSS → Date (node local time; good enough for offsite-only entries)
function timeFromName(n) {
    const m = n.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : new Date(0).toISOString()
}

// Group snapshots by age for the dropdown (list is already newest-first)
function groupByAge(backups) {
    const buckets = [
        { label: 'Last 7 days', max: 7, items: [] },
        { label: '8 – 30 days ago', max: 30, items: [] },
        { label: '31 – 45 days ago', max: 45, items: [] },
        { label: 'Older (newest kept as a safety copy)', max: Infinity, items: [] }
    ]
    for (const b of backups) {
        const age = (Date.now() - new Date(b.created).getTime()) / DAY_MS
        buckets.find(g => age <= g.max).items.push(b)
    }
    return buckets.filter(g => g.items.length)
}

export default function EtcdBackupPanel({ clusterId, clusterName, masterIp, canManage = false }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [notice, setNotice] = useState(null)
    const [locked, setLocked] = useState(false)     // true when plan doesn't include etcd backup
    const [showInfo, setShowInfo] = useState(false)
    const [selected, setSelected] = useState('')    // filename chosen in the dropdown
    const [verify, setVerify] = useState({})        // filename → { busy } | { ok, ... } | { ok:false, error }
    const [wizard, setWizard] = useState(null)      // { snapshot, resumeJobId }
    const [recover, setRecover] = useState(null)    // { resumeJobId } | {}
    const { user } = useAuth()

    // Backup Now / download-from-offsite run as jobs too (offsite upload can take minutes)
    const inline = useEtcdJob(clusterId, (j) => {
        if (j.status === 'succeeded') {
            const f = j.result?.filename
            if (j.kind === 'fetch') { setNotice({ type: 'success', msg: `${f} is on the control-plane now — preview and restore it below.` }); setSelected(f) }
            else {
                setNotice({ type: 'success', msg: `Snapshot ${f} taken and verified${j.result?.offsite ? (j.result.offsite.uploaded ? ' · encrypted copy uploaded offsite' : ` · offsite upload failed: ${j.result.offsite.error}`) : ''}.` })
                if (f) setSelected(f)
            }
        } else setNotice({ type: 'error', msg: j.error || 'The operation failed' })
        fetchBackups()
    })

    const fetchBackups = async () => {
        setLoading(true); setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/etcd/backups`)
            const json = await res.json().catch(() => ({}))
            if (res.status === 402 || json.upgradeRequired) { setLocked(true); return }
            if (!res.ok) throw new Error(json.error || 'Failed to load etcd backups')
            setLocked(false)
            setData(json)
            // Re-attach to an operation that is still running (page reload, other tab)
            const aj = json.activeJob
            if (aj && aj.status === 'running') {
                if (aj.kind === 'restore') setWizard(w => w || { snapshot: { filename: aj.meta?.filename, created: null }, resumeJobId: aj.id })
                else if (aj.kind === 'recover') setRecover(r => r || { resumeJobId: aj.id })
                else if (!inline.job) inline.watch(aj.id)
            }
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }
    useEffect(() => { fetchBackups() }, [clusterId])

    // Local snapshots + offsite-only ones (bundle name = <snapshot>.tar.gz.enc)
    const local = data?.backups || []
    const offsiteNames = new Set((data?.offsite?.remote || []).map(n => n.replace(/\.tar\.gz\.enc$/, '.db')))
    const localNames = new Set(local.map(b => b.filename))
    const offsiteOnly = [...offsiteNames].filter(n => !localNames.has(n)).map(n => ({
        filename: n, created: timeFromName(n), type: typeFromName(n), size: 0, offsiteOnly: true
    }))
    const all = [...local, ...offsiteOnly].sort((a, b) => new Date(b.created) - new Date(a.created))
    const isOffsite = (b) => offsiteNames.has(b.filename)
    const retentionDays = data?.retentionDays || 45
    const sel = all.find(b => b.filename === selected)
    const vs = sel ? verify[sel.filename] : null
    const busyJob = inline.job?.status === 'running'

    // Keep a valid selection: default to the newest snapshot
    useEffect(() => {
        if (!all.length) { setSelected(''); return }
        if (!all.some(b => b.filename === selected)) setSelected(all[0].filename)
    }, [data])

    const run = async (path, body) => {
        setNotice(null)
        try { inline.watch(await startJob(path, body)) } catch (e) {
            if (e.jobId) inline.watch(e.jobId); else setNotice({ type: 'error', msg: e.message })
        }
    }
    const backupNow = () => run(`/api/clusters/${clusterId}/etcd/backups`)
    const fetchOffsite = (f) => run(`/api/clusters/${clusterId}/etcd/offsite/fetch`, { filename: f })

    const verifyNow = async (f) => {
        setVerify(v => ({ ...v, [f]: { busy: true } }))
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/etcd/verify`, { method: 'POST', body: JSON.stringify({ filename: f }) })
            const j = await r.json().catch(() => ({}))
            setVerify(v => ({ ...v, [f]: r.ok ? j : { ok: false, error: j.error } }))
            if (r.ok && j.ok) fetchBackups()
        } catch (e) { setVerify(v => ({ ...v, [f]: { ok: false, error: e.message } })) }
    }

    const offsiteConnected = !!data?.offsite?.connected
    const recoverCard = canManage && !locked && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/[0.03] px-4 py-3">
            <div className="flex gap-3 min-w-0">
                <LifeBuoy className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
                <div className="text-xs">
                    <p className="text-white font-bold">Control-plane machine lost?</p>
                    <p className="text-slate-400">Rebuild it on a fresh machine (same IP) from an encrypted offsite backup — workers and apps come back.{!offsiteConnected && data ? ' Needs offsite storage connected (below).' : ''}</p>
                </div>
            </div>
            <button onClick={() => setRecover({})} disabled={data && !offsiteConnected}
                className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-sky-500/30 text-sky-300 hover:bg-sky-500/10 text-xs font-black shrink-0 disabled:opacity-40">
                <LifeBuoy className="w-3.5 h-3.5" /> Recover…
            </button>
        </div>
    )

    return (
        <div className="glass rounded-2xl border border-white/8 p-6">
            <div className="flex items-center justify-between mb-5 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                    <div className="min-w-0">
                        <h3 className="text-lg font-black text-white tracking-tight">etcd Snapshots</h3>
                        <p className="text-slate-500 text-xs mt-0.5">The whole cluster state (every Kubernetes object) — verified, restorable in one click</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {canManage && !locked && (
                        <button onClick={backupNow} disabled={busyJob}
                            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black transition-all active:scale-95 disabled:opacity-50">
                            {busyJob && inline.job?.kind === 'backup' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <HardDriveDownload className="w-3.5 h-3.5" />}
                            {busyJob && inline.job?.kind === 'backup' ? 'Backing up…' : 'Backup Now'}
                        </button>
                    )}
                    <button onClick={() => setShowInfo(s => !s)} title="What is backed up & how restore works" aria-label="How it works"
                        className={`p-2 rounded-xl border transition-all active:scale-95 ${showInfo ? 'bg-blue-500/15 border-blue-500/30 text-blue-400' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>
                        <Info className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={fetchBackups} disabled={loading} aria-label="Refresh"
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition-all active:scale-95 disabled:opacity-50">
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Transparency: what is backed up & how restore works */}
            {showInfo && (
                <div className="mb-5 rounded-2xl border border-blue-500/20 bg-blue-500/[0.03] p-4 text-xs animate-in fade-in duration-200">
                    <p className="text-slate-300 leading-relaxed mb-3">
                        An <span className="font-bold text-white">etcd snapshot</span> captures the <span className="font-bold text-white">entire Kubernetes cluster state</span> —
                        it's the cluster's database. Use it to roll the whole cluster back after a bad change or a failed upgrade.
                    </p>
                    <div className="grid sm:grid-cols-2 gap-3 mb-3">
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
                            <div className="flex items-center gap-1.5 mb-2 text-emerald-300 font-black uppercase tracking-wider text-[10px]"><CheckCircle2 className="w-3.5 h-3.5" /> Backed Up</div>
                            <ul className="space-y-1 text-slate-400">
                                <li>• Deployments, Services, Ingress, Pods</li>
                                <li>• ConfigMaps & Secrets</li>
                                <li>• Namespaces, RBAC, ServiceAccounts</li>
                                <li>• CRDs & custom resources</li>
                                <li>• Offsite copies also hold the cluster certificates</li>
                            </ul>
                        </div>
                        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3">
                            <div className="flex items-center gap-1.5 mb-2 text-red-300 font-black uppercase tracking-wider text-[10px]"><AlertTriangle className="w-3.5 h-3.5" /> NOT in an etcd snapshot</div>
                            <ul className="space-y-1 text-slate-400">
                                <li>• Files inside Persistent Volumes (databases, uploads) → <span className="text-white font-bold">Volume Backups</span> below</li>
                                <li>• Container images</li>
                                <li>• The Kubernetes version (binaries stay as they are)</li>
                            </ul>
                        </div>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 mb-3">
                        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-slate-400 leading-relaxed">
                            <div className="flex items-center gap-1.5 mb-2 text-slate-200 font-black uppercase tracking-wider text-[10px]"><Clock className="w-3.5 h-3.5" /> When Snapshots Are Taken</div>
                            <ul className="space-y-1">
                                <li>• <span className="text-white font-bold">Automatically before every upgrade</span> and <span className="text-white font-bold">before every restore</span> (undo point)</li>
                                <li>• <span className="text-white font-bold">Manually, anytime</span> with "Backup Now" — e.g. before deleting namespaces or big config edits</li>
                            </ul>
                            <p className="mt-2">
                                Every snapshot is <span className="text-white font-bold">verified</span> (etcd's own integrity check) and gets a checksum. Kept for <span className="text-white font-bold">{retentionDays} days</span> — the newest is always kept.
                                With offsite storage connected, an encrypted copy goes there automatically.
                            </p>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-slate-400 leading-relaxed">
                            <div className="flex items-center gap-1.5 mb-2 text-slate-200 font-black uppercase tracking-wider text-[10px]"><RotateCcw className="w-3.5 h-3.5" /> How Restore Works</div>
                            <ol className="space-y-0.5 list-decimal list-inside">
                                <li>shows exactly what will be removed, come back or be reverted</li>
                                <li>checks the snapshot — a damaged one is refused before anything stops</li>
                                <li>takes a safety snapshot of the current state (one-click undo)</li>
                                <li>restores etcd and restarts the control plane{data?.controlPlanes > 1 ? ' — every control-plane re-joins' : ''}</li>
                                <li>rolls back automatically if the control plane doesn't come back</li>
                            </ol>
                            <p className="mt-1.5">About 1–3 minutes of API downtime; running pods keep running.</p>
                        </div>
                    </div>
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-amber-300/90 leading-relaxed space-y-1">
                        <p>⚠️ Everything changed <span className="font-bold">after</span> the chosen snapshot is lost — the preview lists it before you confirm.</p>
                        <p>💡 Restoring a snapshot from before an upgrade brings the objects back, not the old Kubernetes version.</p>
                    </div>
                </div>
            )}

            {notice && (
                <div className={`mb-4 flex items-start gap-2 rounded-xl p-3 text-xs ${notice.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'}`}>
                    {notice.type === 'success' ? <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                    <span className="flex-1">{notice.msg}</span>
                    <button onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
                </div>
            )}

            {busyJob && (
                <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                    <JobProgress job={inline.job} runningTitle={inline.job.kind === 'fetch' ? 'Downloading from offsite…' : 'Taking a snapshot…'} />
                </div>
            )}

            {locked ? (
                <div className="py-8 text-center max-w-lg mx-auto">
                    <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
                        <Lock className="w-7 h-7 text-amber-400" />
                    </div>
                    <h2 className="text-lg font-black text-white mb-2">Backup & Restore is a Pro Feature</h2>
                    <p className="text-slate-400 text-sm mb-5">
                        Verified snapshots of your entire cluster state, a preview of every restore with one-click undo, encrypted offsite copies,
                        disaster recovery of a lost control-plane and volume data backups. Available on <span className="text-amber-400 font-bold">Pro</span> and <span className="text-purple-400 font-bold">Enterprise</span>.
                    </p>
                    <a href="/pricing" className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl bg-amber-500 hover:bg-amber-400 text-black font-black text-xs uppercase tracking-wider transition-colors">
                        <Zap className="w-4 h-4" /> Upgrade to Pro
                    </a>
                </div>
            ) : loading && !data ? (
                <div className="py-10 flex flex-col items-center gap-3 text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
                    <p className="text-sm">Reading snapshots from the control-plane...</p>
                </div>
            ) : error ? (
                <div className="space-y-4">
                    <div className="py-6 text-center">
                        <p className="text-red-400 text-sm mb-2">{error}</p>
                        <button onClick={fetchBackups} className="text-xs font-bold text-blue-400 hover:underline">Try again</button>
                    </div>
                    {recoverCard}
                </div>
            ) : (
                <div className="space-y-4">
                    {/* Summary */}
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300">
                            <Database className="w-3.5 h-3.5 text-slate-400" /> {local.length} on the control-plane{offsiteOnly.length ? ` · ${offsiteOnly.length} offsite only` : ''}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300">
                            <Archive className="w-3.5 h-3.5 text-slate-400" /> Kept {retentionDays} days
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/20 bg-blue-500/[0.06] px-2.5 py-1 text-blue-300">
                            <Zap className="w-3.5 h-3.5" /> Auto before upgrades & restores
                        </span>
                        {data?.controlPlanes > 1 && (
                            <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300">HA · {data.controlPlanes} control-planes</span>
                        )}
                    </div>

                    {!all.length ? (
                        <div className="py-8 text-center rounded-xl border border-dashed border-white/10">
                            <Database className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                            <p className="text-slate-400 text-sm">No etcd snapshots yet.</p>
                            <p className="text-slate-600 text-xs mt-1">One is taken automatically before every upgrade — or click "Backup Now" to take one now.</p>
                        </div>
                    ) : (
                        <>
                            <div>
                                <label htmlFor="etcd-snapshot" className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5">Choose a snapshot</label>
                                <div className="relative">
                                    <select id="etcd-snapshot" value={selected} onChange={(e) => setSelected(e.target.value)}
                                        className="w-full appearance-none cursor-pointer bg-black/40 border border-white/10 hover:border-white/20 focus:border-emerald-500/50 rounded-xl pl-4 pr-10 py-3 text-sm text-white outline-none transition-colors">
                                        {groupByAge(all).map(g => (
                                            <optgroup key={g.label} label={g.label} className="bg-slate-900 text-slate-400">
                                                {g.items.map(b => (
                                                    <option key={b.filename} value={b.filename} className="bg-slate-900 text-white">
                                                        {fmtWhen(b.created)} — {typeOf(b).short}{b.offsiteOnly ? ' · ☁ offsite only' : ` · ${fmtBytes(b.size)}${isOffsite(b) ? ' · ☁' : ''}${b.verified ? ' · ✓' : ''}`}
                                                    </option>
                                                ))}
                                            </optgroup>
                                        ))}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                                </div>
                            </div>

                            {sel && (() => {
                                const t = typeOf(sel)
                                const TypeIcon = t.icon
                                return (
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white/[0.03] border border-white/8 rounded-xl px-4 py-3">
                                        <div className="min-w-0 space-y-1.5">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className={`inline-flex items-center gap-1 text-[10px] font-bold border rounded px-1.5 py-0.5 ${t.cls}`}><TypeIcon className="w-3 h-3" /> {t.label}</span>
                                                {sel.filename === all[0].filename && <span className="text-[10px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">Latest</span>}
                                                {sel.verified && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5"><BadgeCheck className="w-3 h-3" /> Verified</span>}
                                                {offsiteConnected && (sel.offsiteOnly
                                                    ? <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5"><Cloud className="w-3 h-3" /> Offsite only — download it to restore</span>
                                                    : isOffsite(sel)
                                                        ? <span className="inline-flex items-center gap-1 text-[10px] font-bold text-sky-300 bg-sky-500/10 border border-sky-500/20 rounded px-1.5 py-0.5"><Cloud className="w-3 h-3" /> Stored offsite</span>
                                                        : <span className="text-[10px] font-bold text-slate-400 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Local only — not uploaded yet</span>)}
                                            </div>
                                            <div className="flex items-center gap-3 flex-wrap text-[11px] text-slate-400">
                                                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmtWhen(sel.created)}</span>
                                                <span className="text-slate-500">({fmtAgo(sel.created)})</span>
                                                {!sel.offsiteOnly && <span>{fmtBytes(sel.size)}</span>}
                                            </div>
                                            <p className="font-mono text-[10px] text-slate-600 truncate">{sel.filename}</p>
                                            {vs && !vs.busy && (
                                                <p className={`text-[11px] ${vs.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                                                    {vs.ok ? `✓ Intact — checksum matches, etcd can read it (revision ${vs.revision}, ${vs.keys} keys)` : `✗ ${vs.error}`}
                                                </p>
                                            )}
                                        </div>
                                        {canManage && (
                                            <div className="flex flex-wrap gap-2 shrink-0">
                                                {sel.offsiteOnly ? (
                                                    <button onClick={() => fetchOffsite(sel.filename)} disabled={busyJob}
                                                        className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-sky-500/30 bg-sky-500/5 hover:bg-sky-500/10 text-sky-300 text-xs font-black disabled:opacity-50">
                                                        <DownloadCloud className="w-3.5 h-3.5" /> Download from offsite
                                                    </button>
                                                ) : (
                                                    <>
                                                        <button onClick={() => verifyNow(sel.filename)} disabled={vs?.busy}
                                                            className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-slate-300 text-xs font-bold disabled:opacity-50">
                                                            {vs?.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BadgeCheck className="w-3.5 h-3.5" />} Verify
                                                        </button>
                                                        <button onClick={() => setWizard({ snapshot: sel })} disabled={busyJob}
                                                            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 text-amber-400 text-xs font-black transition-all active:scale-95 disabled:opacity-50">
                                                            <RotateCcw className="w-3.5 h-3.5" /> Restore…
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )
                            })()}
                        </>
                    )}

                    {recoverCard}

                    <OffsiteBackup
                        clusterId={clusterId}
                        offsite={data?.offsite}
                        canConfigure={can(user?.role, 'backup:manage')}
                        canSync={canManage}
                        onChanged={fetchBackups}
                    />
                </div>
            )}

            {data?.node && (
                <p className="text-[11px] text-slate-600 mt-4 text-center">
                    Stored on the control-plane <code className="text-slate-400">{data.node}</code> at <code className="text-slate-400">/var/lib/etcd-backup</code>
                </p>
            )}

            {wizard && (
                <RestoreWizard
                    key={wizard.key || wizard.snapshot?.filename}
                    clusterId={clusterId}
                    clusterName={clusterName}
                    snapshot={wizard.snapshot}
                    resumeJobId={wizard.resumeJobId}
                    controlPlanes={data?.controlPlanes || 1}
                    onClose={() => { setWizard(null); fetchBackups() }}
                    onFinished={fetchBackups}
                    onUndo={(f) => setWizard({ snapshot: { filename: f, created: new Date().toISOString(), type: 'pre-restore' }, key: Date.now() })}
                />
            )}
            {recover && (
                <RecoverWizard
                    clusterId={clusterId}
                    clusterName={clusterName}
                    masterIp={masterIp}
                    controlPlanes={data?.controlPlanes || 1}
                    resumeJobId={recover.resumeJobId}
                    onClose={() => { setRecover(null); fetchBackups() }}
                    onFinished={fetchBackups}
                />
            )}
        </div>
    )
}
