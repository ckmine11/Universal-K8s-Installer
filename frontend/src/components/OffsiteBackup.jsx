import { useState, useEffect } from 'react'
import { apiFetch } from '../context/AuthContext'
import {
    Cloud, Server, Boxes, Loader2, CheckCircle2, AlertTriangle, KeyRound,
    RefreshCw, Unplug, Pencil, Download, Copy, X, HardDrive, ShieldCheck
} from 'lucide-react'

// Offsite (S3 / MinIO) target for etcd backups — one per workspace.
// Uploads run on the cluster's control-plane, so tests/connects name this cluster.

const PROVIDERS = {
    aws: { name: 'AWS S3', icon: Cloud, desc: 'Amazon S3 in the region you choose' },
    minio: { name: 'MinIO', icon: Server, desc: 'An existing MinIO server (on another machine)' },
    other: { name: 'Other S3-compatible', icon: Boxes, desc: 'SeaweedFS (KubeEZ add-on on another cluster), Cloudflare R2, Wasabi, Backblaze B2, E2E Networks…' }
}

const AWS_REGIONS = [
    ['ap-south-1', 'Asia Pacific (Mumbai)'], ['ap-south-2', 'Asia Pacific (Hyderabad)'],
    ['ap-southeast-1', 'Asia Pacific (Singapore)'], ['me-central-1', 'Middle East (UAE)'],
    ['eu-west-1', 'Europe (Ireland)'], ['eu-central-1', 'Europe (Frankfurt)'],
    ['us-east-1', 'US East (N. Virginia)'], ['us-west-2', 'US West (Oregon)']
]

const EMPTY = { endpoint: '', region: 'ap-south-1', bucket: '', prefix: 'kubeez', accessKey: '', secretKey: '', insecureTls: false }
const DEFAULT_REGION = { aws: 'ap-south-1', minio: 'us-east-1', other: '' }

const input = 'w-full bg-black/40 border border-white/10 focus:border-emerald-500/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors'
const label = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1'

function fmtWhen(iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
}

function recoveryFile(key) {
    return [
        'KubeEZ — offsite backup RECOVERY KEY',
        '====================================',
        '',
        key,
        '',
        'Keep this file somewhere safe and separate from the cluster (password manager, vault).',
        'Without it, the encrypted backups in your S3 / MinIO bucket cannot be opened if KubeEZ is lost.',
        '',
        'Decrypt a backup bundle manually:',
        `  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:${key} -in <file>.tar.gz.enc | tar xz`,
        '',
        'The bundle contains: etcd-snapshot.db, pki/ (cluster certificates), kubeadm-config.yaml, MANIFEST.'
    ].join('\n')
}

export default function OffsiteBackup({ clusterId, offsite, canConfigure, canSync, onChanged }) {
    const [cfg, setCfg] = useState(null)          // GET /api/offsite (no secrets)
    const [editing, setEditing] = useState(null)  // provider key while the form is open
    const [form, setForm] = useState(EMPTY)
    const [busy, setBusy] = useState(null)        // 'test' | 'save' | 'sync' | 'disconnect'
    const [result, setResult] = useState(null)    // { ok, msg }
    const [recoveryKey, setRecoveryKey] = useState(null)
    const [savedKey, setSavedKey] = useState(false)

    const load = async () => {
        try {
            const r = await apiFetch('/api/offsite')
            if (r.ok) setCfg(await r.json())
        } catch { /* panel still works without it */ }
    }
    useEffect(() => { load() }, [])

    const openForm = (provider, prefill = null) => {
        setResult(null)
        setEditing(provider)
        setForm(prefill
            ? { ...EMPTY, endpoint: prefill.endpoint || '', region: prefill.region || DEFAULT_REGION[provider], bucket: prefill.bucket, prefix: prefill.prefix, insecureTls: prefill.insecureTls }
            : { ...EMPTY, region: DEFAULT_REGION[provider] })
    }

    const body = () => ({ ...form, provider: editing, clusterId })
    const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

    const call = async (method, path, payload) => {
        const r = await apiFetch(path, { method, body: payload ? JSON.stringify(payload) : undefined })
        const data = await r.json().catch(() => ({}))
        return { ok: r.ok && data.ok !== false, data }
    }

    const test = async () => {
        setBusy('test'); setResult(null)
        const { ok, data } = await call('POST', '/api/offsite/test', body())
        setResult(ok ? { ok: true, msg: 'Connection works — this node can write to the bucket.', warning: data.warning } : { ok: false, msg: data.error || 'Test failed' })
        setBusy(null)
    }

    const connect = async () => {
        setBusy('save'); setResult(null)
        const { ok, data } = await call('PUT', '/api/offsite', body())
        setBusy(null)
        if (!ok) { setResult({ ok: false, msg: data.error || 'Could not connect' }); return }
        setEditing(null)
        setCfg(data)
        if (data.recoveryKey) { setRecoveryKey(data.recoveryKey); setSavedKey(false) }
        onChanged?.()
    }

    const syncNow = async () => {
        setBusy('sync'); setResult(null)
        const { ok, data } = await call('POST', '/api/offsite/sync', { clusterId })
        setBusy(null)
        setResult(ok
            ? { ok: true, msg: `Synced — ${data.uploaded || 0} uploaded, ${data.total || 0} stored offsite.` }
            : { ok: false, msg: data.error || 'Sync failed' })
        load(); onChanged?.()
    }

    const disconnect = async () => {
        if (!window.confirm('Disconnect offsite storage? New snapshots will stay on the node only. Backups already in the bucket are NOT deleted.')) return
        setBusy('disconnect')
        const { data } = await call('DELETE', '/api/offsite')
        setBusy(null); setCfg(data); setResult(null); onChanged?.()
    }

    const showRecoveryKey = async () => {
        const { ok, data } = await call('GET', '/api/offsite/recovery-key')
        if (ok) { setRecoveryKey(data.recoveryKey); setSavedKey(true) }
        else setResult({ ok: false, msg: data.error || 'Could not load the recovery key' })
    }

    const download = () => {
        const url = URL.createObjectURL(new Blob([recoveryFile(recoveryKey)], { type: 'text/plain' }))
        const a = Object.assign(document.createElement('a'), { href: url, download: 'kubeez-recovery-key.txt' })
        a.click(); URL.revokeObjectURL(url); setSavedKey(true)
    }

    const connected = cfg?.connected
    const P = connected ? PROVIDERS[cfg.provider] || PROVIDERS.other : null
    const sync = offsite?.lastSync || cfg?.lastSync?.[clusterId]

    return (
        <div className="mt-5 pt-5 border-t border-white/[0.06]">
            <div className="flex items-center gap-2 mb-1">
                <Cloud className="w-4 h-4 text-sky-400" />
                <h4 className="text-sm font-black text-white">Offsite Backup</h4>
            </div>
            <p className="text-[11px] text-slate-500 mb-3">
                Keep an encrypted copy of every snapshot outside this cluster — it survives losing the control-plane disk.
            </p>

            {result && (
                <div className={`mb-3 flex items-start gap-2 rounded-xl p-3 text-xs ${result.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'}`}>
                    {result.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                    <span>{result.msg}{result.warning && <span className="block mt-1 text-amber-300">⚠ {result.warning}</span>}</span>
                </div>
            )}

            {/* ── Connected ─────────────────────────────────────────────── */}
            {connected && !editing && (
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.04] p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex items-start gap-3 min-w-0">
                            <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/20"><P.icon className="w-5 h-5 text-sky-300" /></div>
                            <div className="min-w-0">
                                <p className="text-sm font-bold text-white flex items-center gap-2">
                                    {P.name} <span className="text-[10px] font-black text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">Connected</span>
                                </p>
                                <p className="text-[11px] text-slate-400 truncate">
                                    bucket <code className="text-slate-300">{cfg.bucket}</code>{cfg.prefix && <> · folder <code className="text-slate-300">{cfg.prefix}/</code></>}
                                    {cfg.provider === 'aws' ? <> · {cfg.region}</> : <> · {cfg.endpoint}</>}
                                </p>
                                <p className="text-[11px] text-slate-500 mt-1">
                                    {offsite?.connected && !offsite.error && <>{offsite.remote.length} snapshot{offsite.remote.length === 1 ? '' : 's'} stored offsite · </>}
                                    Last upload: {sync?.at ? (sync.ok ? fmtWhen(sync.at) : <span className="text-red-300">failed {fmtWhen(sync.at)} — {sync.error}</span>) : 'not yet'}
                                    · Encrypted (AES-256) · kept 45 days
                                </p>
                                {offsite?.error && <p className="text-[11px] text-red-300 mt-1">Cannot read the bucket right now: {offsite.error}</p>}
                                {offsite?.warning && <p className="text-[11px] text-amber-300 mt-1">⚠ Not really offsite: {offsite.warning}</p>}
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {canSync && (
                                <button onClick={syncNow} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-black disabled:opacity-50">
                                    {busy === 'sync' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync now
                                </button>
                            )}
                            {canConfigure && (
                                <>
                                    <button onClick={() => openForm(cfg.provider, cfg)} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-200 text-xs font-bold disabled:opacity-50"><Pencil className="w-3.5 h-3.5" /> Change</button>
                                    <button onClick={showRecoveryKey} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-200 text-xs font-bold disabled:opacity-50"><KeyRound className="w-3.5 h-3.5" /> Recovery key</button>
                                    <button onClick={disconnect} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 text-red-300 text-xs font-bold disabled:opacity-50"><Unplug className="w-3.5 h-3.5" /> Disconnect</button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Not connected: choose a target ─────────────────────────── */}
            {!connected && !editing && (
                <div>
                    <p className={label}>Where should backups be stored?</p>
                    <div className="flex items-center gap-2 mb-3 text-xs text-slate-300 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                        <HardDrive className="w-4 h-4 text-slate-400" /> <span className="font-bold">This node only</span>
                        <span className="text-slate-500">— current setting. A disk failure on the control-plane would lose the backups too.</span>
                    </div>
                    <div className="grid sm:grid-cols-3 gap-3">
                        {Object.entries(PROVIDERS).map(([key, p]) => (
                            <div key={key} className="rounded-xl border border-white/10 bg-white/[0.02] p-3 flex flex-col">
                                <div className="flex items-center gap-2 mb-1"><p.icon className="w-4 h-4 text-sky-300" /><span className="text-sm font-bold text-white">{p.name}</span></div>
                                <p className="text-[11px] text-slate-500 flex-1 mb-3">{p.desc}</p>
                                {canConfigure ? (
                                    <button onClick={() => openForm(key)} className="px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-black">Connect</button>
                                ) : (
                                    <p className="text-[10px] text-slate-600">Ask a workspace admin to connect.</p>
                                )}
                            </div>
                        ))}
                    </div>
                    {cfg?.hasRecoveryKey && canConfigure && (
                        <button onClick={showRecoveryKey} className="mt-3 text-[11px] font-bold text-sky-400 hover:underline flex items-center gap-1"><KeyRound className="w-3 h-3" /> Show recovery key for backups uploaded earlier</button>
                    )}
                </div>
            )}

            {/* ── Connect / change form ──────────────────────────────────── */}
            {editing && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                    <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-bold text-white">Connect {PROVIDERS[editing].name}</p>
                        <button onClick={() => { setEditing(null); setResult(null) }} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3">
                        {editing === 'aws' ? (
                            <div>
                                <label className={label}>Region</label>
                                <select value={form.region} onChange={set('region')} className={input}>
                                    {AWS_REGIONS.map(([v, n]) => <option key={v} value={v} className="bg-slate-900">{n} — {v}</option>)}
                                </select>
                            </div>
                        ) : (
                            <div>
                                <label className={label}>Endpoint URL</label>
                                <input value={form.endpoint} onChange={set('endpoint')} className={input}
                                    placeholder={editing === 'minio' ? 'https://minio.mycompany.local:9000' : 'https://<account>.r2.cloudflarestorage.com'} />
                            </div>
                        )}
                        <div>
                            <label className={label}>Bucket</label>
                            <input value={form.bucket} onChange={set('bucket')} className={input} placeholder="kubeez-backups" />
                        </div>
                        <div>
                            <label className={label}>Access key</label>
                            <input value={form.accessKey} onChange={set('accessKey')} className={input} autoComplete="off"
                                placeholder={cfg?.connected ? `keep current (${cfg.accessKeyHint})` : 'AKIA… / minio user'} />
                        </div>
                        <div>
                            <label className={label}>Secret key</label>
                            <input type="password" value={form.secretKey} onChange={set('secretKey')} className={input} autoComplete="new-password"
                                placeholder={cfg?.connected ? 'keep current' : '••••••••'} />
                        </div>
                        <div>
                            <label className={label}>Folder in bucket</label>
                            <input value={form.prefix} onChange={set('prefix')} className={input} placeholder="kubeez" />
                            <p className="text-[10px] text-slate-600 mt-1">Each cluster gets its own sub-folder.</p>
                        </div>
                        {editing !== 'aws' && (
                            <div>
                                <label className={label}>Region <span className="normal-case font-normal text-slate-600">(optional)</span></label>
                                <input value={form.region} onChange={set('region')} className={input} placeholder="us-east-1" />
                                <p className="text-[10px] text-slate-600 mt-1">MinIO: us-east-1 (default) · Cloudflare R2: auto</p>
                            </div>
                        )}
                        {editing !== 'aws' && (
                            <label className="flex items-start gap-2 text-xs text-slate-300 mt-5 cursor-pointer">
                                <input type="checkbox" checked={form.insecureTls} onChange={set('insecureTls')} className="mt-0.5" />
                                <span>Allow self-signed certificate <span className="block text-[10px] text-slate-500">Common for on-prem MinIO. Leave off for public endpoints.</span></span>
                            </label>
                        )}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-3 flex items-start gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        The test runs from this cluster's control-plane (that's where uploads happen). Your keys stay encrypted in KubeEZ — the node only gets short-lived signed links — and backups are encrypted before they leave the node.
                    </p>
                    <div className="flex flex-wrap gap-2 mt-3">
                        <button onClick={test} disabled={!!busy} className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white text-xs font-bold disabled:opacity-50">
                            {busy === 'test' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Test connection
                        </button>
                        <button onClick={connect} disabled={!!busy} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-black disabled:opacity-50">
                            {busy === 'save' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Test & Connect
                        </button>
                    </div>
                </div>
            )}

            {/* ── Recovery key ───────────────────────────────────────────── */}
            {recoveryKey && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
                    <div className="glass border border-amber-500/30 rounded-3xl max-w-lg w-full p-7 shadow-2xl">
                        <div className="flex items-center gap-3 mb-3">
                            <KeyRound className="w-6 h-6 text-amber-400" />
                            <h2 className="text-lg font-black text-white">Save your recovery key</h2>
                        </div>
                        <p className="text-sm text-slate-300 mb-3">
                            Your offsite backups are encrypted with this key. If KubeEZ itself is ever lost, you need it to open
                            the backups in your bucket. <span className="text-amber-300 font-bold">Store it outside the cluster</span> (password manager / vault).
                        </p>
                        <code className="block break-all text-xs bg-black/50 border border-white/10 rounded-xl p-3 text-emerald-300 mb-4 select-all">{recoveryKey}</code>
                        <div className="flex flex-wrap gap-2 mb-4">
                            <button onClick={download} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-black"><Download className="w-3.5 h-3.5" /> Download key file</button>
                            <button onClick={() => { navigator.clipboard?.writeText(recoveryKey); setSavedKey(true) }} className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white text-xs font-bold"><Copy className="w-3.5 h-3.5" /> Copy</button>
                        </div>
                        <button onClick={() => setRecoveryKey(null)} disabled={!savedKey}
                            className="w-full px-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold text-xs uppercase tracking-wider disabled:opacity-40">
                            {savedKey ? 'I have saved it — close' : 'Download or copy the key first'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
