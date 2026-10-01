import { useState, useEffect } from 'react'
import { apiFetch } from '../context/AuthContext'
import {
    Database, RefreshCw, Loader2, ShieldCheck, HardDriveDownload,
    RotateCcw, AlertTriangle, Clock, Zap, X, Lock, Info, CheckCircle2
} from 'lucide-react'

function fmtBytes(b) {
    if (!b) return '0 B'
    const k = 1024, s = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(b) / Math.log(k))
    return `${parseFloat((b / Math.pow(k, i)).toFixed(2))} ${s[i]}`
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
                        <p className="text-slate-500 text-xs mt-0.5">Cluster-state backups — auto before upgrades + on-demand</p>
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
                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-slate-400 leading-relaxed">
                        <div className="flex items-center gap-1.5 mb-1.5 text-slate-200 font-black uppercase tracking-wider text-[10px]"><RotateCcw className="w-3.5 h-3.5" /> How Restore Works</div>
                        <p>Click <span className="text-white font-bold">Restore</span> on a snapshot → KubeEZ safely: (1) stops the API server &amp; etcd,
                        (2) keeps your current data as a rollback copy on the node, (3) restores the snapshot, (4) restarts the control plane and waits until it's healthy.</p>
                        <p className="mt-1.5 text-amber-300/90">⚠️ Changes made <span className="font-bold">after</span> the snapshot are lost. A snapshot is also taken <span className="font-bold">automatically before every upgrade</span>. Automated restore supports single control-plane clusters.</p>
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
            ) : !data?.backups?.length ? (
                <div className="py-10 text-center">
                    <Database className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                    <p className="text-slate-400 text-sm">No etcd snapshots yet.</p>
                    <p className="text-slate-600 text-xs mt-1">A snapshot is taken automatically before every upgrade, or click "Backup Now".</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {data.backups.map(b => (
                        <div key={b.filename} className="flex items-center justify-between gap-3 bg-white/[0.03] border border-white/8 rounded-xl px-4 py-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-xs font-bold text-white truncate">{b.filename}</span>
                                    {b.auto
                                        ? <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0.5"><Zap className="w-3 h-3" /> Auto (pre-upgrade)</span>
                                        : <span className="text-[10px] font-bold text-slate-400 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Manual</span>}
                                </div>
                                <div className="flex items-center gap-3 text-[11px] text-slate-500 mt-1">
                                    <span>{fmtBytes(b.size)}</span>
                                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{new Date(b.created).toLocaleString()}</span>
                                </div>
                            </div>
                            {canManage && (
                                <button
                                    onClick={() => setRestoreTarget(b.filename)}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 text-amber-400 text-xs font-black transition-all active:scale-95 shrink-0"
                                >
                                    <RotateCcw className="w-3.5 h-3.5" /> Restore
                                </button>
                            )}
                        </div>
                    ))}
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
