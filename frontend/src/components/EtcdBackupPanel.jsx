import { useState, useEffect } from 'react'
import { apiFetch } from '../context/AuthContext'
import {
    Database, RefreshCw, Loader2, ShieldCheck, HardDriveDownload,
    RotateCcw, AlertTriangle, Clock, Zap, X, Lock, Info, CheckCircle2,
    ChevronDown, CalendarClock, Hand, Archive
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
    daily: { label: 'Daily (automatic)', short: 'Daily', icon: CalendarClock, cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
    'pre-upgrade': { label: 'Before upgrade (automatic)', short: 'Before upgrade', icon: Zap, cls: 'text-blue-300 bg-blue-500/10 border-blue-500/20' },
    manual: { label: 'Manual (Backup Now)', short: 'Manual', icon: Hand, cls: 'text-slate-300 bg-white/5 border-white/10' },
    other: { label: 'Snapshot', short: 'Snapshot', icon: Archive, cls: 'text-slate-300 bg-white/5 border-white/10' }
}
const typeOf = (b) => TYPES[b.type] || (b.auto ? TYPES['pre-upgrade'] : TYPES.manual)

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

export default function EtcdBackupPanel({ clusterId, canManage = false }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [backingUp, setBackingUp] = useState(false)
    const [restoreTarget, setRestoreTarget] = useState(null) // filename pending confirm
    const [restoring, setRestoring] = useState(false)
    const [restoreLogs, setRestoreLogs] = useState([])
    const [restoreDone, setRestoreDone] = useState(false)
    const [notice, setNotice] = useState(null)
    const [locked, setLocked] = useState(false)     // true when plan doesn't include etcd backup
    const [showInfo, setShowInfo] = useState(true)  // shown by default; ⓘ button hides it
    const [selected, setSelected] = useState('')    // filename chosen in the dropdown

    // Keep a valid selection: default to the newest snapshot
    useEffect(() => {
        const list = data?.backups || []
        if (!list.length) { setSelected(''); return }
        if (!list.some(b => b.filename === selected)) setSelected(list[0].filename)
    }, [data])

    const selectedBackup = data?.backups?.find(b => b.filename === selected)
    const retentionDays = data?.retentionDays || 45

    const fetchBackups = async () => {
        setLoading(true); setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/etcd/backups`)
            const json = await res.json().catch(() => ({}))
            if (res.status === 402 || json.upgradeRequired) { setLocked(true); return }
            if (!res.ok) throw new Error(json.error || 'Failed to load etcd backups')
            setLocked(false)
            setData(json)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { fetchBackups() }, [clusterId])

    const handleBackupNow = async () => {
        setBackingUp(true); setNotice(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/etcd/backups`, { method: 'POST' })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Backup failed')
            setNotice({ type: 'success', msg: `Snapshot created: ${json.filename}` })
            fetchBackups()
        } catch (err) {
            setNotice({ type: 'error', msg: err.message })
        } finally {
            setBackingUp(false)
        }
    }

    const handleRestore = async () => {
        setRestoring(true); setNotice(null); setRestoreLogs([]); setRestoreDone(false)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/etcd/restore`, {
                method: 'POST',
                body: JSON.stringify({ filename: restoreTarget })
            })
            const json = await res.json().catch(() => ({}))
            if (Array.isArray(json.logs)) setRestoreLogs(json.logs)   // backend step-by-step logs
            setRestoreDone(true)
            if (!res.ok || !json.success) throw new Error(json.error || 'Restore failed')
            setNotice({ type: 'success', msg: 'etcd restore completed. The control plane was restarted on the restored data.' })
            fetchBackups()
        } catch (err) {
            setNotice({ type: 'error', msg: err.message })
        } finally {
            setRestoring(false)
        }
    }

    return (
        <div className="glass rounded-2xl border border-white/8 p-6">
            <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    <div>
                        <h3 className="text-lg font-black text-white tracking-tight">etcd Snapshots</h3>
                        <p className="text-slate-500 text-xs mt-0.5">Cluster-state backups — daily, before upgrades & on demand · kept {retentionDays} days</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {canManage && !locked && (
                        <button
                            onClick={handleBackupNow}
                            disabled={backingUp}
                            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black transition-all active:scale-95 disabled:opacity-50"
                        >
                            {backingUp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <HardDriveDownload className="w-3.5 h-3.5" />}
                            {backingUp ? 'Backing up...' : 'Backup Now'}
                        </button>
                    )}
                    <button onClick={() => setShowInfo(s => !s)} title="What is backed up & how restore works"
                        className={`p-2 rounded-xl border transition-all active:scale-95 ${showInfo ? 'bg-blue-500/15 border-blue-500/30 text-blue-400' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`}>
                        <Info className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={fetchBackups} disabled={loading}
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
                                <li>• Deployments, Pods, Services, Ingress</li>
                                <li>• ConfigMaps & Secrets</li>
                                <li>• Namespaces, RBAC, ServiceAccounts</li>
                                <li>• CRDs & custom resources</li>
                                <li>• All object metadata & cluster config</li>
                            </ul>
                        </div>
                        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3">
                            <div className="flex items-center gap-1.5 mb-2 text-red-300 font-black uppercase tracking-wider text-[10px]"><AlertTriangle className="w-3.5 h-3.5" /> NOT Backed Up</div>
                            <ul className="space-y-1 text-slate-400">
                                <li>• Persistent Volume DATA (DB/app files on disk)</li>
                                <li>• Container images</li>
                                <li>• Anything outside etcd</li>
                            </ul>
                        </div>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 mb-3">
                        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-slate-400 leading-relaxed">
                            <div className="flex items-center gap-1.5 mb-2 text-slate-200 font-black uppercase tracking-wider text-[10px]"><CalendarClock className="w-3.5 h-3.5" /> When Snapshots Are Taken</div>
                            <ul className="space-y-1">
                                <li>• <span className="text-white font-bold">Every day</span> automatically (around 02:00, node time)</li>
                                <li>• <span className="text-white font-bold">Before every upgrade</span> automatically</li>
                                <li>• <span className="text-white font-bold">Anytime</span> with "Backup Now" (e.g. before a risky change)</li>
                            </ul>
                            <p className="mt-2">
                                Kept for <span className="text-white font-bold">{retentionDays} days</span>, then removed automatically —
                                the newest snapshot is always kept. Stored on the control-plane at <code className="text-slate-300">/var/lib/etcd-backup</code>.
                                Daily snapshots keep running even if KubeEZ is offline.
                            </p>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-slate-400 leading-relaxed">
                            <div className="flex items-center gap-1.5 mb-2 text-slate-200 font-black uppercase tracking-wider text-[10px]"><RotateCcw className="w-3.5 h-3.5" /> How Restore Works</div>
                            <p>Pick a snapshot in the dropdown below → <span className="text-white font-bold">Restore this snapshot</span>. KubeEZ then safely:</p>
                            <ol className="mt-1 space-y-0.5 list-decimal list-inside">
                                <li>stops the API server &amp; etcd</li>
                                <li>keeps your current data as a rollback copy on the node</li>
                                <li>restores the snapshot</li>
                                <li>restarts the control plane and waits until it's healthy</li>
                            </ol>
                            <p className="mt-1.5">Takes about 1–3 minutes; the Kubernetes API is briefly unavailable, then your workloads are brought back in line with the snapshot.</p>
                        </div>
                    </div>
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-3 text-amber-300/90 leading-relaxed space-y-1">
                        <p>⚠️ Everything changed <span className="font-bold">after</span> the chosen snapshot is lost (new deployments, config edits, etc.).</p>
                        <p>⚠️ Automated restore supports <span className="font-bold">single control-plane</span> clusters. For HA clusters, restore etcd manually on each member.</p>
                        <p>💡 For app data in Persistent Volumes, use a storage backup (e.g. Longhorn snapshots) — etcd snapshots don't include it.</p>
                    </div>
                </div>
            )}

            {notice && (
                <div className={`mb-4 flex items-start gap-2 rounded-xl p-3 text-xs ${notice.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'}`}>
                    {notice.type === 'success' ? <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                    <span>{notice.msg}</span>
                </div>
            )}

            {locked ? (
                <div className="py-8 text-center max-w-lg mx-auto">
                    <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-4">
                        <Lock className="w-7 h-7 text-amber-400" />
                    </div>
                    <h2 className="text-lg font-black text-white mb-2">etcd Backup & Restore is a Pro Feature</h2>
                    <p className="text-slate-400 text-sm mb-5">
                        Snapshot your entire cluster state on demand and restore it in one click — plus automatic
                        snapshots before every upgrade. Available on <span className="text-amber-400 font-bold">Pro</span> and <span className="text-purple-400 font-bold">Enterprise</span>.
                    </p>
                    <a href="/pricing" className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl bg-amber-500 hover:bg-amber-400 text-black font-black text-xs uppercase tracking-wider transition-colors">
                        <Zap className="w-4 h-4" /> Upgrade to Pro
                    </a>
                </div>
            ) : loading ? (
                <div className="py-10 flex flex-col items-center gap-3 text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
                    <p className="text-sm">Reading snapshots from the control-plane...</p>
                </div>
            ) : error ? (
                <div className="py-6 text-center">
                    <p className="text-red-400 text-sm mb-2">{error}</p>
                    <button onClick={fetchBackups} className="text-xs font-bold text-blue-400 hover:underline">Try again</button>
                </div>
            ) : (
                <div className="space-y-4">
                    {/* Summary: how many, retention, next automatic snapshot */}
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300">
                            <Database className="w-3.5 h-3.5 text-slate-400" /> {data?.backups?.length || 0} snapshot{data?.backups?.length === 1 ? '' : 's'}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300">
                            <Archive className="w-3.5 h-3.5 text-slate-400" /> Kept {retentionDays} days
                        </span>
                        {data?.schedule?.enabled ? (
                            <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-2.5 py-1 text-emerald-300">
                                <CalendarClock className="w-3.5 h-3.5" /> Daily auto-backup
                                {data.schedule.nextRun && <span className="text-emerald-400/70">· next {fmtWhen(data.schedule.nextRun)}</span>}
                            </span>
                        ) : data?.schedule?.error ? (
                            <span title={data.schedule.error} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-2.5 py-1 text-amber-300">
                                <AlertTriangle className="w-3.5 h-3.5" /> Daily auto-backup not active — click refresh to retry
                            </span>
                        ) : null}
                    </div>

                    {!data?.backups?.length ? (
                        <div className="py-8 text-center rounded-xl border border-dashed border-white/10">
                            <Database className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                            <p className="text-slate-400 text-sm">No etcd snapshots yet.</p>
                            <p className="text-slate-600 text-xs mt-1">The first daily snapshot runs automatically, one is taken before every upgrade, or click "Backup Now".</p>
                        </div>
                    ) : (
                        <>
                            {/* Snapshot picker */}
                            <div>
                                <label htmlFor="etcd-snapshot" className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1.5">
                                    Choose a snapshot
                                </label>
                                <div className="relative">
                                    <select
                                        id="etcd-snapshot"
                                        value={selected}
                                        onChange={(e) => setSelected(e.target.value)}
                                        className="w-full appearance-none cursor-pointer bg-black/40 border border-white/10 hover:border-white/20 focus:border-emerald-500/50 rounded-xl pl-4 pr-10 py-3 text-sm text-white outline-none transition-colors"
                                    >
                                        {groupByAge(data.backups).map(g => (
                                            <optgroup key={g.label} label={g.label} className="bg-slate-900 text-slate-400">
                                                {g.items.map(b => (
                                                    <option key={b.filename} value={b.filename} className="bg-slate-900 text-white">
                                                        {fmtWhen(b.created)} — {typeOf(b).short} · {fmtBytes(b.size)}
                                                    </option>
                                                ))}
                                            </optgroup>
                                        ))}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                                </div>
                            </div>

                            {/* Selected snapshot details */}
                            {selectedBackup && (() => {
                                const t = typeOf(selectedBackup)
                                const TypeIcon = t.icon
                                return (
                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white/[0.03] border border-white/8 rounded-xl px-4 py-3">
                                        <div className="min-w-0 space-y-1.5">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className={`inline-flex items-center gap-1 text-[10px] font-bold border rounded px-1.5 py-0.5 ${t.cls}`}>
                                                    <TypeIcon className="w-3 h-3" /> {t.label}
                                                </span>
                                                {selectedBackup.filename === data.backups[0].filename && (
                                                    <span className="text-[10px] font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">Latest</span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-3 flex-wrap text-[11px] text-slate-400">
                                                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmtWhen(selectedBackup.created)}</span>
                                                <span className="text-slate-500">({fmtAgo(selectedBackup.created)})</span>
                                                <span>{fmtBytes(selectedBackup.size)}</span>
                                            </div>
                                            <p className="font-mono text-[10px] text-slate-600 truncate">{selectedBackup.filename}</p>
                                        </div>
                                        {canManage && (
                                            <button
                                                onClick={() => setRestoreTarget(selectedBackup.filename)}
                                                className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 text-amber-400 text-xs font-black transition-all active:scale-95 shrink-0"
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" /> Restore this snapshot
                                            </button>
                                        )}
                                    </div>
                                )
                            })()}
                        </>
                    )}
                </div>
            )}

            {data?.node && (
                <p className="text-[11px] text-slate-600 mt-4 text-center">
                    Stored on the control-plane <code className="text-slate-400">{data.node}</code> at <code className="text-slate-400">/var/lib/etcd-backup</code>
                </p>
            )}

            {/* Restore confirmation */}
            {restoreTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
                    <div className="glass border border-amber-500/30 rounded-3xl max-w-lg w-full p-8 shadow-2xl relative max-h-[90vh] overflow-y-auto">
                        <button onClick={() => { if (!restoring) { setRestoreTarget(null); setRestoreLogs([]); setRestoreDone(false) } }} className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>

                        {/* Phase 1 — confirm */}
                        {!restoring && !restoreDone && (
                            <div className="text-center">
                                <div className="p-4 bg-amber-500/10 rounded-2xl border border-amber-500/20 inline-block mb-4">
                                    <AlertTriangle className="w-8 h-8 text-amber-500" />
                                </div>
                                <h2 className="text-xl font-black text-white uppercase mb-2">Restore etcd?</h2>
                                <p className="text-slate-400 text-sm mb-3 leading-relaxed">
                                    This rolls the ENTIRE cluster state back to:
                                    <span className="font-mono text-white text-xs block mt-1 break-all">{restoreTarget}</span>
                                </p>
                                <div className="text-left text-[11px] text-amber-300/90 bg-amber-500/[0.06] border border-amber-500/20 rounded-xl p-3 mb-6 space-y-1">
                                    <p>• The control plane (api-server + etcd) restarts during restore.</p>
                                    <p>• Any changes made AFTER this snapshot are lost.</p>
                                    <p>• Your current data is kept as a rollback copy on the node.</p>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => setRestoreTarget(null)}
                                        className="px-4 py-3 rounded-xl border border-white/10 hover:bg-white/5 text-slate-300 font-bold text-xs uppercase tracking-wider transition-colors">
                                        Cancel
                                    </button>
                                    <button onClick={handleRestore}
                                        className="px-4 py-3 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-black text-xs uppercase tracking-wider transition-colors">
                                        Confirm Restore
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Phase 2/3 — progress + backend transparency logs */}
                        {(restoring || restoreDone) && (
                            <div>
                                <div className="flex items-center gap-3 mb-4">
                                    {restoring
                                        ? <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
                                        : (notice?.type === 'success' ? <ShieldCheck className="w-6 h-6 text-emerald-400" /> : <AlertTriangle className="w-6 h-6 text-red-400" />)}
                                    <div>
                                        <h2 className="text-lg font-black text-white">
                                            {restoring ? 'Restoring etcd…' : (notice?.type === 'success' ? 'Restore Complete' : 'Restore Failed')}
                                        </h2>
                                        <p className="text-[11px] text-slate-500">
                                            {restoring ? 'This can take 1–3 minutes — the control plane is restarting.' : 'Backend step-by-step log below.'}
                                        </p>
                                    </div>
                                </div>

                                {restoring && (
                                    <div className="mb-4 space-y-1.5 text-[11px] text-slate-400">
                                        {['Preparing etcdutl (restore tool)', 'Stopping API server + etcd', 'Preserving current data (rollback copy)', 'Restoring snapshot', 'Restarting control plane', 'Waiting for cluster healthy'].map((s, i) => (
                                            <div key={i} className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />{s}</div>
                                        ))}
                                    </div>
                                )}

                                {restoreLogs.length > 0 && (
                                    <div className="bg-black/50 border border-white/10 rounded-xl p-3 max-h-64 overflow-y-auto font-mono text-[10px] leading-relaxed">
                                        {restoreLogs.map((l, i) => (
                                            <div key={i} className={l.level === 'warning' ? 'text-amber-400' : l.level === 'error' ? 'text-red-400' : 'text-slate-300'}>{l.msg}</div>
                                        ))}
                                    </div>
                                )}

                                {restoreDone && (
                                    <button onClick={() => { setRestoreTarget(null); setRestoreLogs([]); setRestoreDone(false); fetchBackups() }}
                                        className="mt-4 w-full px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold text-xs uppercase tracking-wider">
                                        Close
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
