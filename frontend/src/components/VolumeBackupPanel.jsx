import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import {
    HardDrive, Loader2, RefreshCw, Cloud, Server, Boxes, AlertTriangle, CheckCircle2, X,
    Play, RotateCcw, Trash2, CalendarClock, FileText, Settings2, Lock, Zap, Copy, Undo2
} from 'lucide-react'

// Volume backups = Velero: the FILES inside persistent volumes (databases,
// uploads) + the namespace's objects, copied to S3-compatible storage.

const input = 'w-full bg-black/40 border border-white/10 focus:border-emerald-500/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors'
const label = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1'
const PROVIDERS = {
    aws: { name: 'AWS S3', icon: Cloud },
    minio: { name: 'MinIO', icon: Server },
    other: { name: 'Other S3-compatible', icon: Boxes }
}
const RUNNING = ['New', 'InProgress', 'WaitingForPluginOperations', 'WaitingForPluginOperationsPartiallyFailed', 'Finalizing', 'FinalizingPartiallyFailed', 'Deleting']
const PHASE_CLS = {
    Completed: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
    PartiallyFailed: 'text-amber-300 bg-amber-500/10 border-amber-500/20',
    Failed: 'text-red-300 bg-red-500/10 border-red-500/20',
    FailedValidation: 'text-red-300 bg-red-500/10 border-red-500/20'
}
const fmt = (iso) => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
// Velero TTL "720h0m0s" → "30 days"
const ttlDays = (ttl) => { const h = parseInt(String(ttl || '').match(/^(\d+)h/)?.[1], 10); return h ? (h % 24 ? `${h} hours` : `${h / 24} days`) : '30 days' }
const nsLabel = (list) => !list?.length || list.includes('*') ? 'All namespaces' : list.join(', ')

function Phase({ phase }) {
    const run = RUNNING.includes(phase)
    return (
        <span className={`inline-flex items-center gap-1 text-[10px] font-bold border rounded px-1.5 py-0.5 ${PHASE_CLS[phase] || 'text-slate-300 bg-white/5 border-white/10'}`}>
            {run && <Loader2 className="w-3 h-3 animate-spin" />} {phase}
        </span>
    )
}

export default function VolumeBackupPanel({ clusterId, clusterName, canManage = false }) {
    const navigate = useNavigate()
    const { user } = useAuth()
    const canConfigure = can(user?.role, 'backup:manage')
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [locked, setLocked] = useState(false)
    const [notice, setNotice] = useState(null)
    const [setup, setSetup] = useState(false)
    const [form, setForm] = useState({ useOffsite: true, provider: 'other', endpoint: '', region: '', bucket: '', accessKey: '', secretKey: '', insecureTls: false })
    const [busy, setBusy] = useState(null)
    const [sameCluster, setSameCluster] = useState(null)   // warning: storage is on this cluster
    const [backupNs, setBackupNs] = useState([])
    const [restore, setRestore] = useState(null)     // { backup, namespaces, mode, confirm }
    const [details, setDetails] = useState(null)     // { title, text }
    const [sched, setSched] = useState({ cron: '0 2 * * *', ttlDays: 30 })

    const load = async (quiet) => {
        if (!quiet) setLoading(true)
        setError(null)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/volume-backups`)
            const j = await r.json().catch(() => ({}))
            if (r.status === 402 || j.upgradeRequired) { setLocked(true); return }
            if (!r.ok) throw new Error(j.error || 'Could not load volume backups')
            setData(j)
            if (!j.offsite?.connected) setForm(f => ({ ...f, useOffsite: false }))
        } catch (e) { setError(e.message) } finally { setLoading(false) }
    }
    useEffect(() => { load() }, [clusterId])
    // Follow running backups / restores
    const active = data && [...(data.backups || []), ...(data.restores || [])].some(x => RUNNING.includes(x.phase))
    useEffect(() => {
        if (!active) return
        const t = setTimeout(() => load(true), 5000)
        return () => clearTimeout(t)
    }, [data])

    const call = async (key, method, path, body, okMsg) => {
        setBusy(key); setNotice(null)
        try {
            const r = await apiFetch(path, { method, body: body ? JSON.stringify(body) : undefined })
            const j = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(j.error || 'Request failed')
            if (okMsg) setNotice({ ok: true, msg: typeof okMsg === 'function' ? okMsg(j) : okMsg })
            await load(true)
            return j
        } catch (e) { setNotice({ ok: false, msg: e.message }); return null } finally { setBusy(null) }
    }

    // Storage on a node of THIS cluster is refused first (backups would die
    // with the cluster); the user may still accept it, e.g. for testing.
    const saveConfig = async (allowSameCluster = false) => {
        const body = { ...(form.useOffsite ? { useOffsite: true } : { ...form, useOffsite: false }), allowSameCluster }
        setBusy('config'); setNotice(null); setSameCluster(null)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/volume-backups/config`, { method: 'PUT', body: JSON.stringify(body) })
            const j = await r.json().catch(() => ({}))
            if (r.status === 400 && j.sameCluster) { setSameCluster(j.error); return }
            if (!r.ok) throw new Error(j.error || 'Could not save the settings')
            if (j.newInstallationId) navigate(`/dashboard/${j.newInstallationId}`)
        } catch (e) { setNotice({ ok: false, msg: e.message }) } finally { setBusy(null) }
    }
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

    const header = (
        <div className="flex items-center justify-between mb-5 gap-3">
            <div className="flex items-center gap-3 min-w-0">
                <HardDrive className="w-5 h-5 text-violet-400 shrink-0" />
                <div className="min-w-0">
                    <h3 className="text-lg font-black text-white tracking-tight">Volume Backups</h3>
                    <p className="text-slate-500 text-xs mt-0.5">The files inside persistent volumes (databases, uploads) + their namespace — with Velero</p>
                </div>
            </div>
            <button onClick={() => load()} disabled={loading} aria-label="Refresh" className="p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 disabled:opacity-50 shrink-0">
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
        </div>
    )

    if (locked) {
        return (
            <div className="glass rounded-2xl border border-white/8 p-6">
                {header}
                <div className="py-6 text-center">
                    <Lock className="w-7 h-7 text-amber-400 mx-auto mb-3" />
                    <p className="text-slate-400 text-sm mb-4">Volume backups are part of <span className="text-amber-400 font-bold">Pro</span>.</p>
                    <a href="/pricing" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-amber-500 hover:bg-amber-400 text-black font-black text-xs uppercase tracking-wider"><Zap className="w-4 h-4" /> Upgrade to Pro</a>
                </div>
            </div>
        )
    }

    const showSetup = setup || (data && !data.config?.configured)
    const storageOk = data?.storage?.phase === 'Available'

    return (
        <div className="glass rounded-2xl border border-white/8 p-6">
            {header}

            {notice && (
                <div className={`mb-4 flex items-start gap-2 rounded-xl p-3 text-xs ${notice.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'}`}>
                    {notice.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
                    <span className="flex-1">{notice.msg}</span>
                    <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
                </div>
            )}

            {loading && !data ? (
                <div className="py-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-violet-400" /></div>
            ) : error ? (
                <div className="py-6 text-center"><p className="text-red-400 text-sm mb-2">{error}</p><button onClick={() => load()} className="text-xs font-bold text-blue-400 hover:underline">Try again</button></div>
            ) : showSetup ? (
                /* ── Setup ── */
                <div className="space-y-4">
                    <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3 text-xs text-slate-300 leading-relaxed">
                        etcd snapshots never contain the data <span className="text-white font-bold">inside</span> volumes. Volume Backups copy those files (through a small agent on every node) together with the namespace's
                        objects to S3-compatible storage — restore a deleted app with its data, or a copy next to the original.
                    </div>
                    {!canConfigure ? (
                        <p className="text-sm text-slate-400">An Org Admin has to choose where volume backups are stored.</p>
                    ) : (
                        <>
                            {data?.offsite?.connected && (
                                <label className={`flex gap-3 rounded-xl border p-3 cursor-pointer ${form.useOffsite ? 'border-emerald-500/40 bg-emerald-500/[0.05]' : 'border-white/10'}`}>
                                    <input type="radio" checked={form.useOffsite} onChange={() => setForm(f => ({ ...f, useOffsite: true }))} className="mt-1" />
                                    <span className="text-xs">
                                        <span className="text-white font-bold block">Use the workspace's offsite storage</span>
                                        <span className="text-slate-400">Bucket <span className="font-mono">{data.offsite.bucket}</span> on {data.offsite.endpoint}, in its own folder. Velero runs inside the cluster, so these keys are stored in the cluster (Secret velero/cloud-credentials).</span>
                                    </span>
                                </label>
                            )}
                            <label className={`flex gap-3 rounded-xl border p-3 cursor-pointer ${!form.useOffsite ? 'border-emerald-500/40 bg-emerald-500/[0.05]' : 'border-white/10'}`}>
                                <input type="radio" checked={!form.useOffsite} onChange={() => setForm(f => ({ ...f, useOffsite: false }))} className="mt-1" />
                                <span className="text-xs">
                                    <span className="text-white font-bold block">Separate storage / keys (recommended)</span>
                                    <span className="text-slate-400">Best: a key that can only reach one bucket — it lives inside the cluster.</span>
                                </span>
                            </label>
                            {!form.useOffsite && (
                                <div className="grid sm:grid-cols-2 gap-3">
                                    <div className="sm:col-span-2 flex gap-2 flex-wrap">
                                        {Object.entries(PROVIDERS).map(([k, p]) => (
                                            <button key={k} onClick={() => setForm(f => ({ ...f, provider: k, region: k === 'aws' ? 'ap-south-1' : f.region }))}
                                                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold ${form.provider === k ? 'border-emerald-500/40 text-white bg-emerald-500/10' : 'border-white/10 text-slate-400'}`}>
                                                <p.icon className="w-3.5 h-3.5" /> {p.name}
                                            </button>
                                        ))}
                                    </div>
                                    {form.provider !== 'aws' && (
                                        <div className="sm:col-span-2"><label className={label} htmlFor="vb-endpoint">Endpoint</label>
                                            <input id="vb-endpoint" className={input} value={form.endpoint} onChange={set('endpoint')} placeholder="https://minio.example.com:9000" /></div>
                                    )}
                                    <div><label className={label} htmlFor="vb-bucket">Bucket</label><input id="vb-bucket" className={input} value={form.bucket} onChange={set('bucket')} placeholder="velero-backups" /></div>
                                    <div><label className={label} htmlFor="vb-region">Region</label><input id="vb-region" className={input} value={form.region} onChange={set('region')} placeholder={form.provider === 'aws' ? 'ap-south-1' : 'us-east-1'} /></div>
                                    <div><label className={label} htmlFor="vb-ak">Access key</label><input id="vb-ak" className={input} value={form.accessKey} onChange={set('accessKey')} autoComplete="off" /></div>
                                    <div><label className={label} htmlFor="vb-sk">Secret key</label><input id="vb-sk" type="password" className={input} value={form.secretKey} onChange={set('secretKey')} autoComplete="new-password" placeholder={data?.config?.configured ? 'unchanged' : ''} /></div>
                                    {form.provider !== 'aws' && (
                                        <label className="sm:col-span-2 flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={form.insecureTls} onChange={set('insecureTls')} /> Allow a self-signed certificate</label>
                                    )}
                                </div>
                            )}
                            {sameCluster && (
                                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-amber-200 space-y-2">
                                    <p className="flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" /> {sameCluster}</p>
                                    <p className="text-amber-200/80">Fine for trying Volume Backups out — for real protection use storage outside this cluster.</p>
                                    <div className="flex gap-2 justify-end">
                                        <button onClick={() => setSameCluster(null)} className="px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 font-bold">Cancel</button>
                                        <button onClick={() => saveConfig(true)} disabled={busy === 'config'} className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-black disabled:opacity-50">Use it anyway (testing only)</button>
                                    </div>
                                </div>
                            )}
                            <div className="flex gap-2 justify-end">
                                {data?.config?.configured && <button onClick={() => setSetup(false)} className="px-4 py-2.5 rounded-xl border border-white/10 text-slate-300 text-xs font-bold">Cancel</button>}
                                <button onClick={() => saveConfig()} disabled={busy === 'config'} className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-black disabled:opacity-50">
                                    {busy === 'config' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Settings2 className="w-3.5 h-3.5" />}
                                    {data?.installed ? 'Save & apply' : 'Save & install Velero'}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            ) : !data.installed ? (
                <div className="py-6 text-center space-y-3">
                    <p className="text-sm text-slate-400">Storage is configured ({data.config.bucket}), but Velero is not installed{data.runningJob ? ' yet — an operation is running on this cluster' : ''}.</p>
                    {data.error && <p className="text-xs text-red-400">{data.error}</p>}
                    {canConfigure && <button onClick={() => saveConfig()} disabled={busy === 'config' || !!data.runningJob} className="px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-black disabled:opacity-50">Install Velero</button>}
                </div>
            ) : (
                /* ── Installed ── */
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 ${storageOk ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-300' : 'border-red-500/20 bg-red-500/[0.06] text-red-300'}`}>
                            {storageOk ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />} Storage {data.storage?.phase || 'unknown'}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300"><Cloud className="w-3.5 h-3.5" /> {data.config.bucket}/{data.config.prefix}</span>
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-slate-300">Node agents {data.nodeAgent || '?'}</span>
                        {canConfigure && <button onClick={() => setSetup(true)} className="text-[11px] text-blue-300 hover:underline">Change storage</button>}
                    </div>
                    {!storageOk && data.storage?.message && <p className="text-xs text-red-300">{data.storage.message}</p>}

                    {canManage && (
                        <div className="grid md:grid-cols-2 gap-3">
                            {/* Back up now */}
                            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                                <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Back up now</p>
                                <div className="relative mb-2">
                                    <select multiple value={backupNs} onChange={e => setBackupNs([...e.target.selectedOptions].map(o => o.value))} aria-label="Namespaces"
                                        className="w-full h-24 bg-black/40 border border-white/10 rounded-xl px-2 py-1 text-xs text-white outline-none">
                                        {(data.namespaces || []).filter(n => !/^kube-|^velero$/.test(n)).map(n => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-[10px] text-slate-500">{backupNs.length ? `${backupNs.length} selected` : 'Nothing selected = all namespaces (Velero and its own storage are skipped)'} · kept 30 days</span>
                                    <button onClick={() => call('backup', 'POST', `/api/clusters/${clusterId}/volume-backups/backups`, { namespaces: backupNs, ttlDays: 30 }, (j) => `Backup ${j.name} started.`)}
                                        disabled={busy === 'backup' || !storageOk} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-black disabled:opacity-50">
                                        {busy === 'backup' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Back up
                                    </button>
                                </div>
                            </div>
                            {/* Schedule */}
                            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                                <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1"><CalendarClock className="w-3.5 h-3.5" /> Automatic backups</p>
                                {data.schedule ? (
                                    <p className="text-xs text-slate-300 mb-2">Everything, on <span className="font-mono text-white">{data.schedule.cron}</span> (node time) · kept {ttlDays(data.schedule.ttl)}{data.schedule.lastBackup ? ` · last ${fmt(data.schedule.lastBackup)}` : ''}</p>
                                ) : <p className="text-xs text-slate-400 mb-2">Off — only manual backups.</p>}
                                <div className="flex items-center gap-2">
                                    <input aria-label="Schedule (cron)" value={sched.cron} onChange={e => setSched(s => ({ ...s, cron: e.target.value }))} className={`${input} !py-1.5 font-mono text-xs`} />
                                    <button onClick={() => call('sched', 'PUT', `/api/clusters/${clusterId}/volume-backups/schedule`, { enabled: true, ...sched }, 'Automatic backups scheduled.')}
                                        disabled={busy === 'sched'} className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-white text-xs font-bold shrink-0">{data.schedule ? 'Update' : 'Turn on'}</button>
                                    {data.schedule && <button onClick={() => call('sched', 'PUT', `/api/clusters/${clusterId}/volume-backups/schedule`, { enabled: false }, 'Automatic backups turned off.')}
                                        disabled={busy === 'sched'} className="px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 text-xs font-bold shrink-0">Off</button>}
                                </div>
                                <p className="text-[10px] text-slate-500 mt-1">Daily at 02:00 = <span className="font-mono">0 2 * * *</span></p>
                            </div>
                        </div>
                    )}

                    {/* Backups */}
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Backups ({data.backups.length})</p>
                        {!data.backups.length ? <p className="text-xs text-slate-500 rounded-xl border border-dashed border-white/10 p-4 text-center">No volume backups yet.</p> : (
                            <div className="space-y-1.5 max-h-80 overflow-y-auto">
                                {data.backups.map(b => (
                                    <div key={b.name} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2">
                                        <div className="min-w-0 text-[11px]">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <Phase phase={b.phase} />
                                                <span className="text-white font-bold">{fmt(b.started)}</span>
                                                {b.schedule && <span className="text-[10px] text-slate-500">scheduled</span>}
                                                {(b.errors > 0 || b.warnings > 0) && <span className="text-[10px] text-amber-300">{b.errors} errors · {b.warnings} warnings</span>}
                                            </div>
                                            <p className="text-slate-400 truncate">{nsLabel(b.namespaces)}{b.items ? ` · ${b.items.done}/${b.items.total} items` : ''}{b.expires ? ` · until ${fmt(b.expires)}` : ''}</p>
                                            {(b.failureReason || b.validationErrors?.length > 0) && <p className="text-red-300 text-[10px]">{[b.failureReason, ...(b.validationErrors || [])].filter(Boolean).join(' · ')}</p>}
                                            <p className="font-mono text-[10px] text-slate-600 truncate">{b.name}</p>
                                        </div>
                                        <div className="flex gap-1.5 shrink-0">
                                            <button onClick={async () => { const r = await apiFetch(`/api/clusters/${clusterId}/volume-backups/describe/backup/${b.name}`); const j = await r.json().catch(() => ({})); setDetails({ title: b.name, text: j.text || j.error }) }}
                                                aria-label="Details" className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"><FileText className="w-3.5 h-3.5" /></button>
                                            {canManage && (b.phase === 'Completed' || b.phase === 'PartiallyFailed') && (
                                                <button onClick={() => setRestore({ backup: b.name, namespaces: b.namespaces.includes('*') ? [] : b.namespaces, mode: 'missing', confirm: '' })}
                                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-amber-500/30 text-amber-300 hover:bg-amber-500/10 text-[11px] font-bold"><RotateCcw className="w-3 h-3" /> Restore</button>
                                            )}
                                            {canManage && !RUNNING.includes(b.phase) && (
                                                <button onClick={() => { if (window.confirm(`Delete backup ${b.name} (also from the storage)?`)) call(`del-${b.name}`, 'DELETE', `/api/clusters/${clusterId}/volume-backups/backups/${b.name}`, null, 'Backup is being deleted.') }}
                                                    aria-label="Delete backup" className="p-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-red-300 hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5" /></button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {data.restores?.length > 0 && (
                        <div>
                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Recent restores</p>
                            <div className="space-y-1.5">
                                {data.restores.slice(0, 5).map(r => (
                                    <div key={r.name} className="flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2 text-[11px]">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2"><Phase phase={r.phase} /> <span className="text-white">{fmt(r.started)}</span> <span className="text-slate-500 truncate">from {r.backup}</span></div>
                                            <p className="text-slate-400 truncate">{r.mappings ? Object.entries(r.mappings).map(([a, b]) => `${a} → ${b}`).join(', ') : nsLabel(r.namespaces)}{(r.errors || r.warnings) ? ` · ${r.errors} errors · ${r.warnings} warnings` : ''}</p>
                                            {(r.failureReason || r.validationErrors?.length > 0) && <p className="text-red-300 text-[10px]">{[r.failureReason, ...(r.validationErrors || [])].filter(Boolean).join(' · ')}</p>}
                                        </div>
                                        <button onClick={async () => { const x = await apiFetch(`/api/clusters/${clusterId}/volume-backups/describe/restore/${r.name}`); const j = await x.json().catch(() => ({})); setDetails({ title: r.name, text: j.text || j.error }) }}
                                            aria-label="Details" className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 shrink-0"><FileText className="w-3.5 h-3.5" /></button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Restore dialog */}
            {restore && createPortal(
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
                    <div className="glass border border-amber-500/30 rounded-3xl max-w-lg w-full p-6 relative max-h-[90vh] overflow-y-auto">
                        <button onClick={() => setRestore(null)} aria-label="Close" className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
                        <h2 className="text-lg font-black text-white mb-1">Restore volume backup</h2>
                        <p className="font-mono text-[11px] text-slate-500 mb-4">{restore.backup}</p>
                        <label className={label} htmlFor="vr-ns">Namespaces</label>
                        <select id="vr-ns" multiple value={restore.namespaces} onChange={e => setRestore(r => ({ ...r, namespaces: [...e.target.selectedOptions].map(o => o.value) }))}
                            className="w-full h-24 bg-black/40 border border-white/10 rounded-xl px-2 py-1 text-xs text-white outline-none mb-1">
                            {[...new Set([...(data.backups.find(b => b.name === restore.backup)?.namespaces.filter(n => n !== '*') || []), ...(data.namespaces || [])])].filter(n => !/^kube-|^velero$/.test(n)).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <p className="text-[10px] text-slate-500 mb-3">{restore.namespaces.length ? `${restore.namespaces.length} selected` : 'Nothing selected = everything in the backup'}</p>
                        <div className="space-y-2 mb-4">
                            {[
                                ['missing', Undo2, 'Bring back what is missing', 'Deleted apps come back with their volume data. Existing objects are not touched.'],
                                ['copy', Copy, 'Restore as a copy', 'Into new namespaces "<name>-restored-…" next to the original — compare or recover single files.'],
                                ['replace', AlertTriangle, 'Replace (delete first)', 'Deletes the chosen namespaces now, then restores them with the backed-up data. Data written since the backup is lost.']
                            ].map(([k, Icon, t, d]) => (
                                <label key={k} className={`flex gap-3 rounded-xl border p-3 cursor-pointer ${restore.mode === k ? (k === 'replace' ? 'border-red-500/40 bg-red-500/[0.05]' : 'border-emerald-500/40 bg-emerald-500/[0.05]') : 'border-white/10'}`}>
                                    <input type="radio" checked={restore.mode === k} onChange={() => setRestore(r => ({ ...r, mode: k }))} className="mt-1" />
                                    <span className="text-xs"><span className="text-white font-bold flex items-center gap-1"><Icon className="w-3.5 h-3.5" /> {t}</span><span className="text-slate-400">{d}</span></span>
                                </label>
                            ))}
                        </div>
                        {restore.mode === 'replace' && (
                            <div className="mb-3">
                                <label htmlFor="vr-confirm" className="block text-[11px] text-slate-400 mb-1">Type <span className="font-mono text-white">{clusterName}</span> to confirm</label>
                                <input id="vr-confirm" value={restore.confirm} onChange={e => setRestore(r => ({ ...r, confirm: e.target.value }))} className={input} autoComplete="off" />
                            </div>
                        )}
                        <div className="flex gap-2 justify-end">
                            <button onClick={() => setRestore(null)} className="px-4 py-2.5 rounded-xl border border-white/10 text-slate-300 text-xs font-bold">Cancel</button>
                            <button onClick={async () => { const j = await call('restore', 'POST', `/api/clusters/${clusterId}/volume-backups/restores`, restore, (x) => `Restore ${x.name} started${x.mappings?.length ? ` → ${x.mappings.map(m => m.split(':')[1]).join(', ')}` : ''}.`); if (j) setRestore(null) }}
                                disabled={busy === 'restore' || (restore.mode !== 'missing' && !restore.namespaces.length) || (restore.mode === 'replace' && restore.confirm.trim() !== String(clusterName).trim())}
                                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-black disabled:opacity-40">
                                {busy === 'restore' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Restore
                            </button>
                        </div>
                    </div>
                </div>, document.body
            )}

            {details && createPortal(
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={() => setDetails(null)}>
                    <div className="glass border border-white/10 rounded-3xl max-w-3xl w-full p-6 relative" onClick={e => e.stopPropagation()}>
                        <button onClick={() => setDetails(null)} aria-label="Close" className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
                        <h2 className="text-sm font-black text-white mb-3 font-mono">{details.title}</h2>
                        <pre className="bg-black/50 border border-white/10 rounded-xl p-3 max-h-[60vh] overflow-auto text-[10px] text-slate-300 whitespace-pre-wrap">{details.text}</pre>
                    </div>
                </div>, document.body
            )}
        </div>
    )
}
