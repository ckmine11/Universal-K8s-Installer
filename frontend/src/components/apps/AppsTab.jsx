import { useState, useEffect, useCallback, useRef } from 'react'
import { Boxes, RefreshCw, Loader2, AlertTriangle, Plus, ChevronDown, ChevronRight, Undo2, Trash2, ArrowUpCircle, Eye, Lock, Snowflake, Search, X, CheckCircle2, XCircle } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'
import OpsPanel from './OpsPanel'
import { useFeatures } from '../../config/features'
import ProgressivePanel from './ProgressivePanel'
import MetricsPanel from './MetricsPanel'
import CostPanel from './CostPanel'

// Helm apps of one cluster: releases with their environment, history with
// roll back, values (secrets masked), and install / upgrade with a preview of
// what changes. The server checks every permission, protected environments
// (second person), change freezes and namespace limits.
const STATUS = { deployed: 'text-emerald-300', failed: 'text-red-300', 'pending-install': 'text-blue-300', 'pending-upgrade': 'text-blue-300', 'pending-rollback': 'text-blue-300', superseded: 'text-slate-500', uninstalling: 'text-amber-200' }
const json = async (res) => { const d = await res.json().catch(() => ({})); if (!res.ok) throw Object.assign(new Error(d.error || `Request failed (${res.status})`), { status: res.status, data: d }); return d }
const yamlOf = (v) => {
    // a small YAML writer for showing values (the server accepts YAML or JSON)
    const esc = (s) => /^[\w./@:-]+$/.test(s) && !/^(true|false|null|yes|no|\d.*)$/i.test(s) ? s : JSON.stringify(s)
    const w = (x, ind) => {
        if (Array.isArray(x)) return x.length ? x.map(i => `\n${ind}- ${w(i, ind + '  ').replace(/^\n\s*/, '')}`).join('') : ' []'
        if (x && typeof x === 'object') return Object.keys(x).length ? Object.entries(x).map(([k, i]) => `\n${ind}${esc(k)}:${(i && typeof i === 'object') ? w(i, ind + '  ') : ` ${typeof i === 'string' ? esc(i) : JSON.stringify(i)}`}`).join('') : ' {}'
        return ` ${typeof x === 'string' ? esc(x) : JSON.stringify(x)}`
    }
    return v && Object.keys(v).length ? w(v, '').trim() + '\n' : ''
}

function useJob(clusterId, onDone) {
    const [job, setJob] = useState(null)
    const timer = useRef(null)
    useEffect(() => () => clearTimeout(timer.current), [])
    const follow = useCallback((j) => {
        setJob(j)
        const poll = async () => {
            try {
                const d = await json(await apiFetch(`/api/clusters/${clusterId}/apps/jobs/${j.id}`))
                setJob(d)
                if (d.status === 'running') timer.current = setTimeout(poll, 2500); else onDone?.(d)
            } catch { timer.current = setTimeout(poll, 5000) }
        }
        timer.current = setTimeout(poll, 1500)
    }, [clusterId, onDone])
    return [job, follow, () => setJob(null)]
}

function JobBar({ job, onClose }) {
    if (!job) return null
    const run = job.status === 'running', ok = job.status === 'done'
    return (
        <div className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${run ? 'border-blue-400/25 text-blue-100' : ok ? 'border-emerald-400/25 text-emerald-100' : 'border-red-400/25 text-red-200'}`}>
            {run ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
            <span className="flex-1 break-words">{job.action} {job.namespace}/{job.release} — {run ? 'running (Helm waits until the pods are ready)…' : ok ? 'done' : job.error}
                {(job.warnings || []).map((w, i) => <span key={i} className="block text-amber-200">⚠ {w}</span>)}</span>
            {!run && <button onClick={onClose} aria-label="Close"><X className="w-3.5 h-3.5" /></button>}
        </div>
    )
}

// ── install / upgrade ──
function DeployDialog({ clusterId, start, environments, isAdmin, freeze, onClose, onStarted }) {
    const { toast } = useToast()
    const [repos, setRepos] = useState([])
    const [repoId, setRepoId] = useState(start?.repoId || '')
    const [charts, setCharts] = useState(null)
    const [q, setQ] = useState('')
    const [form, setForm] = useState({ release: start?.release || '', namespace: start?.namespace || '', chart: start?.chart || '', version: start?.version || '', values: start?.values || '' })
    const [preview, setPreview] = useState(null)
    const [busy, setBusy] = useState(false)
    const [override, setOverride] = useState('')
    const [overrideCve, setOverrideCve] = useState('')
    const set = (k) => (e) => { setForm(f => ({ ...f, [k]: e.target.value })); setPreview(null) }
    const repo = repos.find(r => r.id === repoId)

    useEffect(() => { apiFetch('/api/delivery/repos').then(json).then(d => { setRepos(d.repos); if (!repoId && d.repos[0]) setRepoId(d.repos[0].id) }).catch(e => toast({ title: 'Repositories', message: e.message, type: 'error' })) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!repoId) return
        setCharts(null)
        const t = setTimeout(() => apiFetch(`/api/delivery/repos/${repoId}/charts?q=${encodeURIComponent(q)}`).then(json).then(setCharts).catch(e => setCharts({ error: e.message, charts: [] })), 300)
        return () => clearTimeout(t)
    }, [repoId, q])
    const chart = charts?.charts?.find(c => c.name === form.chart)
    const env = environments.find(e => e.namespace === form.namespace)
    const body = () => ({ ...form, repoId, version: form.version || undefined, ...(override ? { overrideFreeze: override } : {}), ...(overrideCve ? { overrideCve } : {}) })

    const doPreview = async () => {
        setBusy(true); setPreview(null)
        try { setPreview(await json(await apiFetch(`/api/clusters/${clusterId}/apps/preview`, { method: 'POST', body: JSON.stringify(body()) }))) }
        catch (e) { setPreview({ error: e.message }) } finally { setBusy(false) }
    }
    const doDeploy = async () => {
        setBusy(true)
        try { onStarted(await json(await apiFetch(`/api/clusters/${clusterId}/apps`, { method: 'POST', body: JSON.stringify(body()) }))); onClose() }
        catch (e) { toast({ title: 'Not deployed', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={start?.release ? `Upgrade ${start.release}` : 'Install an app'}>
            <div className="bg-[#16161b] border border-white/10 rounded-2xl w-full max-w-3xl p-6 shadow-2xl max-h-[92vh] overflow-y-auto space-y-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-white">{start?.release ? `Upgrade ${start.namespace}/${start.release}` : 'Install an app'}</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>
                {!repos.length && <p className="text-sm text-amber-200">No chart repositories yet — an admin adds them in Delivery settings.</p>}
                <div className="grid sm:grid-cols-2 gap-3">
                    <label className="text-xs text-slate-400 space-y-1">Repository
                        <select className="kz-input" value={repoId} onChange={e => { setRepoId(e.target.value); setForm(f => ({ ...f, chart: '', version: '' })); setPreview(null) }}>{repos.map(r => <option key={r.id} value={r.id}>{r.name} — {r.url}</option>)}</select>
                    </label>
                    <label className="text-xs text-slate-400 space-y-1">Chart
                        {charts?.oci || !charts ? (
                            <input className="kz-input" value={form.chart} onChange={set('chart')} placeholder={charts?.oci ? 'chart name in the registry' : 'loading…'} />
                        ) : (
                            <div className="space-y-1">
                                <div className="relative"><Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" /><input className="kz-input !pl-8" value={q} onChange={e => setQ(e.target.value)} placeholder="Search charts" aria-label="Search charts" /></div>
                                <select className="kz-input" value={form.chart} onChange={e => { setForm(f => ({ ...f, chart: e.target.value, version: '' })); setPreview(null) }}>
                                    <option value="">{charts.error ? charts.error : `Pick a chart (${charts.charts.length}${charts.total > charts.charts.length ? ` of ${charts.total}` : ''})`}</option>
                                    {charts.charts.map(c => <option key={c.name} value={c.name}>{c.name}{c.description ? ` — ${c.description.slice(0, 60)}` : ''}</option>)}
                                </select>
                            </div>
                        )}
                    </label>
                    <label className="text-xs text-slate-400 space-y-1">Version
                        {chart ? (
                            <select className="kz-input" value={form.version} onChange={set('version')}><option value="">Newest ({chart.versions[0]?.version})</option>{chart.versions.map(v => <option key={v.version} value={v.version}>{v.version}{v.appVersion ? ` (app ${v.appVersion})` : ''}</option>)}</select>
                        ) : <input className="kz-input" value={form.version} onChange={set('version')} placeholder="newest" />}
                    </label>
                    <label className="text-xs text-slate-400 space-y-1">Release name
                        <input className="kz-input" value={form.release} onChange={set('release')} disabled={!!start?.release} placeholder="web" />
                    </label>
                    <label className="text-xs text-slate-400 space-y-1 sm:col-span-2">Namespace{env && <span className={`ml-2 ${env.protected ? 'text-amber-200' : 'text-slate-500'}`}>environment {env.name}{env.protected ? ' — protected: a second person approves the deploy' : ''}</span>}
                        <div className="flex gap-2">
                            <input className="kz-input" value={form.namespace} onChange={set('namespace')} disabled={!!start?.release} placeholder="shop" />
                            {!start?.release && environments.length > 0 && <select className="kz-input !w-auto" value="" onChange={e => { setForm(f => ({ ...f, namespace: e.target.value })); setPreview(null) }} aria-label="Environment"><option value="">Environment…</option>{environments.map(e => <option key={e.id} value={e.namespace}>{e.name} ({e.namespace})</option>)}</select>}
                        </div>
                    </label>
                </div>
                <label className="block text-xs text-slate-400 space-y-1">Values (YAML) <span className="text-slate-500">— secrets show as ••••••; leave them so to keep the current value</span>
                    <textarea className="kz-input font-mono !text-xs min-h-[160px]" value={form.values} onChange={set('values')} spellCheck={false} placeholder="replicaCount: 2" />
                </label>
                {freeze && (
                    <div className="rounded-xl border border-sky-400/25 bg-sky-500/[0.05] p-3 text-xs text-sky-100 space-y-2">
                        <p className="flex items-center gap-1.5"><Snowflake className="w-3.5 h-3.5" />Change freeze until {new Date(freeze.until).toLocaleString()}: {freeze.reason}</p>
                        {isAdmin ? <input className="kz-input !text-xs" value={override} onChange={e => setOverride(e.target.value)} placeholder="Override as admin — why? (recorded in the audit trail)" /> : <p className="text-sky-200/80">Deploys are paused — ask an admin.</p>}
                    </div>
                )}
                {preview && (preview.error ? <p className="text-xs text-red-300 break-words">{preview.error}</p> : (
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 space-y-2">
                        <p className="text-xs text-slate-300">{preview.install ? 'Installs' : 'Upgrades to'} <span className="font-mono">{preview.chart}</span>{preview.appVersion ? ` (app ${preview.appVersion})` : ''} — {preview.changes.length} resource{preview.changes.length === 1 ? '' : 's'} change, {preview.unchanged} unchanged. The API server checked it (dry run).</p>
                        {preview.changes.map((c, i) => (
                            <details key={i} className="text-[11px]" open={preview.changes.length <= 3}>
                                <summary className="cursor-pointer"><span className={c.action === 'add' ? 'text-emerald-300' : c.action === 'remove' ? 'text-red-300' : 'text-amber-200'}>{c.action}</span> <span className="font-mono text-slate-200">{c.kind} {c.namespace ? `${c.namespace}/` : ''}{c.name}</span></summary>
                                {c.diff ? <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-black/30 p-2 font-mono leading-snug">{c.diff.map((l, k) => <div key={k} className={l[0] === '+' ? 'text-emerald-300' : l[0] === '-' ? 'text-red-300' : 'text-slate-500'}>{l}</div>)}</pre> : c.action !== 'remove' && <p className="text-slate-500">Too large to show.</p>}
                            </details>
                        ))}
                        {preview.cve && (
                            <div className={`rounded-lg border p-2.5 text-[11px] space-y-1 ${preview.cve.blocked ? 'border-red-400/30 text-red-200' : preview.cve.failing.length ? 'border-amber-400/30 text-amber-100' : 'border-emerald-400/25 text-emerald-100'}`}>
                                <p className="font-semibold">CVE policy of this environment: {preview.cve.mode} on {preview.cve.severity.toLowerCase()}{preview.cve.blocked ? ' — this deploy will be blocked' : preview.cve.failing.length ? ' — vulnerable images, deploy allowed' : ' — passed'}</p>
                                {preview.cve.failing.map(f => <p key={f.image} className="font-mono break-all">{f.image}: {f.critical} critical, {f.high} high{f.cves.length ? ` (${f.cves.join(', ')})` : ''}</p>)}
                                {preview.cve.unscanned.length > 0 && <p className="text-slate-400">Not scanned by Trivy yet: {preview.cve.unscanned.join(', ')}</p>}
                                {preview.cve.blocked && isAdmin && <input className="kz-input !text-xs" value={overrideCve} onChange={e => setOverrideCve(e.target.value)} placeholder="Deploy anyway as admin — why? (recorded in the audit trail)" />}
                            </div>
                        )}
                        {preview.notes && <pre className="text-[11px] text-slate-400 whitespace-pre-wrap max-h-32 overflow-auto">{preview.notes}</pre>}
                    </div>
                ))}
                <div className="flex justify-end gap-2">
                    <button onClick={doPreview} disabled={busy || !repoId || !form.chart || !form.release || !form.namespace} className="kz-btn-ghost !py-2 !text-xs">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Preview changes</button>
                    <button onClick={doDeploy} disabled={busy || !repoId || !form.chart || !form.release || !form.namespace || (freeze && !override)} className="kz-btn-primary !py-2 !text-xs"><ArrowUpCircle className="w-3.5 h-3.5" /> {start?.release ? 'Upgrade' : 'Install'}</button>
                </div>
            </div>
        </div>
    )
}

function ReleaseRow({ clusterId, r, can, isAdmin, freeze, onJob, onUpgrade }) {
    const { toast } = useToast()
    const [open, setOpen] = useState(false)
    const [detail, setDetail] = useState(null)
    const [busy, setBusy] = useState(null)
    const load = async () => { try { setDetail(await json(await apiFetch(`/api/clusters/${clusterId}/apps/${r.namespace}/${r.name}`))) } catch (e) { setDetail({ error: e.message }) } }
    const toggle = () => { setOpen(o => !o); if (!detail) load() }
    const askOverride = () => freeze ? (isAdmin ? window.prompt(`Change freeze: ${freeze.reason}. Override as admin — why?`) : null) : undefined
    const act = async (kind, revision) => {
        const ov = askOverride()
        if (freeze && !ov) return toast({ title: 'Change freeze', message: `${freeze.reason} — until ${new Date(freeze.until).toLocaleString()}`, type: 'error' })
        if (kind === 'uninstall' && !window.confirm(`Uninstall ${r.namespace}/${r.name}? Its resources are deleted.`)) return
        setBusy(kind)
        try {
            const url = kind === 'uninstall' ? `/api/clusters/${clusterId}/apps/${r.namespace}/${r.name}` : `/api/clusters/${clusterId}/apps/${r.namespace}/${r.name}/rollback`
            onJob(await json(await apiFetch(url, { method: kind === 'uninstall' ? 'DELETE' : 'POST', body: JSON.stringify({ ...(revision ? { revision } : {}), ...(ov ? { overrideFreeze: ov } : {}) }) })))
        } catch (e) { toast({ title: kind === 'uninstall' ? 'Not uninstalled' : 'Not rolled back', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }
    return (
        <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-3">
                <button onClick={toggle} className="text-slate-500" aria-expanded={open} aria-label={open ? 'Hide details' : 'Show details'}>{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button>
                <div className="flex-1 min-w-[200px]">
                    <p className="text-sm font-semibold text-white break-all">{r.name} <span className="text-[10px] font-medium text-slate-500">{r.namespace}</span>
                        {r.environment && <span className={`ml-2 rounded-md border px-1.5 py-0.5 text-[10px] ${r.environment.protected ? 'border-amber-400/30 text-amber-200' : 'border-white/10 text-slate-300'}`}>{r.environment.protected && <Lock className="inline w-2.5 h-2.5 mr-0.5" />}{r.environment.name}</span>}
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono">{r.chart}{r.version ? ` ${r.version}` : ''}{r.appVersion ? ` · app ${r.appVersion}` : ''} · revision {r.revision}{r.updated ? ` · ${String(r.updated).slice(0, 16)}` : ''}</p>
                </div>
                <span className={`text-[11px] font-semibold ${STATUS[r.status] || 'text-slate-300'}`}>{r.status}</span>
                {can.deploy && <button onClick={() => onUpgrade(r, detail)} className="kz-btn-ghost !py-1 !px-2 !text-[11px]"><ArrowUpCircle className="w-3 h-3" /> Upgrade</button>}
                {can.delete && <button onClick={() => act('uninstall')} disabled={!!busy} className="kz-btn-ghost !py-1 !px-2 !text-[11px] text-red-300"><Trash2 className="w-3 h-3" /> Uninstall</button>}
            </div>
            {open && (
                <div className="mt-3 ml-7 space-y-3">
                    {!detail && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
                    {detail?.error && <p className="text-xs text-red-300">{detail.error}</p>}
                    {detail?.history && (
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">History</p>
                            <ul className="space-y-1">{detail.history.map(h => (
                                <li key={h.revision} className="flex flex-wrap items-center gap-2 text-[11px]">
                                    <span className="font-mono text-slate-300">#{h.revision}</span><span className={STATUS[h.status] || 'text-slate-400'}>{h.status}</span>
                                    <span className="text-slate-400 font-mono">{h.chart}</span><span className="text-slate-500">{String(h.updated || '').slice(0, 16)} {h.description}</span>
                                    {can.deploy && h.revision !== r.revision && <button onClick={() => act('rollback', h.revision)} disabled={!!busy} className="kz-btn-ghost !py-0.5 !px-1.5 !text-[10px]"><Undo2 className="w-3 h-3" /> Roll back to #{h.revision}</button>}
                                </li>
                            ))}</ul>
                        </div>
                    )}
                    {detail && 'values' in detail && (detail.values ? (
                        <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Values (set at install / upgrade; secrets masked)</p>
                            <pre className="max-h-64 overflow-auto rounded-lg bg-black/30 p-2 text-[11px] font-mono text-slate-300">{yamlOf(detail.values) || '(chart defaults)'}</pre></div>
                    ) : <p className="text-[11px] text-slate-500">Your role may not see values.</p>)}
                </div>
            )}
        </li>
    )
}

export default function AppsTab({ clusterId }) {
    const { user } = useAuth()
    const featureOn = useFeatures()
    const isAdmin = ['admin', 'superadmin'].includes(user?.role)
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [dialog, setDialog] = useState(null)   // null | {} (install) | { release, namespace, … } (upgrade)
    const [q, setQ] = useState('')
    const load = useCallback(async () => {
        setLoading(true); setError(null)
        try { setData(await json(await apiFetch(`/api/clusters/${clusterId}/apps`))) } catch (e) { setError(e.message) } finally { setLoading(false) }
    }, [clusterId])
    useEffect(() => { load() }, [load])
    const [job, follow, clearJob] = useJob(clusterId, load)

    const needle = q.trim().toLowerCase()
    const releases = (data?.releases || []).filter(r => !needle || [r.name, r.namespace, r.chart, r.environment?.name].some(v => v && String(v).toLowerCase().includes(needle)))
    const upgrade = (r, detail) => setDialog({ release: r.name, namespace: r.namespace, chart: r.chart, version: '', values: detail?.values ? yamlOf(detail.values) : '' })

    return (
        <div className="space-y-5">
            <div className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <Boxes className="w-5 h-5 text-blue-300" />
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="text-base font-semibold text-white">Apps</h3>
                        <p className="text-xs text-slate-400">Helm releases on this cluster — install and upgrade with a preview of what changes, roll back to any revision, see the values.</p>
                    </div>
                    {data?.can?.deploy && <button onClick={() => setDialog({})} className="kz-btn-primary !py-1.5 !text-xs"><Plus className="w-3.5 h-3.5" /> Install an app</button>}
                    <button onClick={load} disabled={loading} className="kz-btn-ghost !py-1.5 !text-xs" aria-label="Read again"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
                </div>
                <JobBar job={job} onClose={clearJob} />
                {data?.freeze && <p className="flex items-center gap-1.5 rounded-xl border border-sky-400/25 bg-sky-500/[0.05] p-2.5 text-xs text-sky-100"><Snowflake className="w-3.5 h-3.5" />Change freeze until {new Date(data.freeze.until).toLocaleString()}: {data.freeze.reason}{isAdmin ? ' — admins may override with a reason.' : ''}</p>}
                {data?.readOnlyReason && <p className="flex items-center gap-1.5 text-[11px] text-slate-400"><Lock className="w-3.5 h-3.5" />{data.readOnlyReason}</p>}
                {data?.hidden > 0 && <p className="text-[11px] text-slate-500">{data.hidden} release{data.hidden === 1 ? '' : 's'} in namespaces you do not have.</p>}
                {error && <p className="flex items-center gap-1.5 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
                {loading && !data && <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>}
                {data && (data.releases.length ? (
                    <>
                        <div className="relative w-64"><Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search releases" className="kz-input !py-1.5 !pl-8 !text-xs" aria-label="Search releases" /></div>
                        <ul className="space-y-2">{releases.map(r => <ReleaseRow key={`${r.namespace}/${r.name}`} clusterId={clusterId} r={r} can={data.can} isAdmin={isAdmin} freeze={data.freeze} onJob={follow} onUpgrade={upgrade} />)}</ul>
                    </>
                ) : <p className="text-sm text-slate-500 py-2">No Helm releases{data.hidden ? ' you can see' : ''} on this cluster yet.</p>)}
            </div>
            {(featureOn('rollouts') || featureOn('autoscale')) && <ProgressivePanel clusterId={clusterId} rollouts={featureOn('rollouts')} autoscale={featureOn('autoscale')} />}
            {featureOn('appMetrics') && <MetricsPanel clusterId={clusterId} />}
            {featureOn('costs') && <CostPanel clusterId={clusterId} />}
            {(featureOn('hibernate') || featureOn('debug')) && <OpsPanel clusterId={clusterId} hibernate={featureOn('hibernate')} debug={featureOn('debug')} schedules={featureOn('hibernate') && featureOn('hibernateSchedule')} />}
            {dialog && <DeployDialog clusterId={clusterId} start={dialog.release ? dialog : null} environments={data?.environments || []} isAdmin={isAdmin} freeze={data?.freeze} onClose={() => setDialog(null)} onStarted={follow} />}
        </div>
    )
}
