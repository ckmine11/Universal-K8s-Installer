import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { useToast } from '../components/ToastProvider'
import PageHeader from '../components/ui/PageHeader'
import {
    ShieldCheck, Play, Loader2, FileDown, FileJson, BadgeCheck, CheckCircle2, XCircle, AlertTriangle, CircleDashed, MinusCircle,
    ChevronDown, Wrench, ScrollText, Siren, CalendarClock, Fingerprint, Server, ListChecks, Lock, RotateCcw, Download, Clock
} from 'lucide-react'

const ST = {
    pass: { label: 'Pass', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/25', Icon: CheckCircle2 },
    partial: { label: 'Partial', cls: 'text-amber-300 bg-amber-500/10 border-amber-400/25', Icon: AlertTriangle },
    fail: { label: 'Fail', cls: 'text-red-300 bg-red-500/10 border-red-400/25', Icon: XCircle },
    todo: { label: 'To confirm', cls: 'text-violet-300 bg-violet-500/10 border-violet-400/25', Icon: CircleDashed },
    na: { label: 'N/A', cls: 'text-slate-400 bg-white/5 border-white/10', Icon: MinusCircle }
}
const tone = (s) => s == null ? 'text-slate-400' : s >= 75 ? 'text-emerald-300' : s >= 50 ? 'text-amber-300' : 'text-red-300'
const stroke = (s) => s == null ? '#64748b' : s >= 75 ? '#34d399' : s >= 50 ? '#fbbf24' : '#f87171'
const fmt = (iso) => iso ? new Date(iso).toLocaleString() : '—'

function Chip({ status }) {
    const s = ST[status] || ST.na
    return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-black uppercase tracking-wider ${s.cls}`}><s.Icon className="w-3 h-3" />{s.label}</span>
}

function Ring({ score, grade }) {
    const r = 46, c = 2 * Math.PI * r
    return (
        <div className="relative w-32 h-32 shrink-0">
            <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="11" />
                <circle cx="60" cy="60" r={r} fill="none" stroke={stroke(score)} strokeWidth="11" strokeLinecap="round" strokeDasharray={`${c * (score || 0) / 100} ${c}`} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`font-display text-3xl font-bold ${tone(score)}`}>{score ?? '—'}</span>
                <span className="text-[10px] uppercase tracking-widest text-slate-500">grade {grade}</span>
            </div>
        </div>
    )
}

function Trend({ history }) {
    if (!history || history.length < 2) return null
    const w = 160, h = 40, max = 100
    const pts = history.map((p, i) => `${(i / (history.length - 1)) * w},${h - (p.score || 0) / max * h}`).join(' ')
    return (
        <div className="text-[10px] text-slate-500">
            <svg width={w} height={h} className="overflow-visible"><polyline points={pts} fill="none" stroke="#67e8f9" strokeWidth="2" strokeLinejoin="round" /></svg>
            <div className="mt-1">Score over the last {history.length} scans</div>
        </div>
    )
}

async function download(path, fallbackName, toast) {
    const r = await apiFetch(path)
    if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        toast({ title: r.status === 402 ? 'Part of Pro' : 'Download failed', message: j.error || r.statusText, type: 'error' })
        return
    }
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallbackName
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function useJob(onDone) {
    const [job, setJob] = useState(null)
    const t = useRef(null)
    const watch = (id) => {
        clearInterval(t.current)
        t.current = setInterval(async () => {
            const r = await apiFetch(`/api/compliance/jobs/${id}`)
            if (!r.ok) return
            const j = await r.json()
            setJob(j)
            if (j.status !== 'running') { clearInterval(t.current); onDone?.(j) }
        }, 2500)
    }
    useEffect(() => () => clearInterval(t.current), [])
    return [job, setJob, watch]
}

export default function Compliance() {
    const { user } = useAuth()
    const { toast } = useToast()
    const [params, setParams] = useSearchParams()
    const canManage = can(user?.role, 'compliance:manage')
    const canAudit = can(user?.role, 'audit:view')
    const canApprove = can(user?.role, 'access:approve')
    const [meta, setMeta] = useState(null)
    const [ov, setOv] = useState(null)
    const [report, setReport] = useState(null)
    const [tab, setTab] = useState(params.get('tab') || 'controls')
    const [cis, setCis] = useState(true)
    const clusterId = params.get('cluster') || ov?.clusters?.[0]?.id || ''
    const cluster = ov?.clusters?.find(c => c.id === clusterId)

    const loadOverview = async () => {
        const r = await apiFetch('/api/compliance/overview')
        if (r.ok) setOv(await r.json())
    }
    const loadReport = async (id) => {
        if (!id) { setReport(null); return }
        const r = await apiFetch(`/api/compliance/reports/${id}`)
        setReport(r.ok ? await r.json() : null)
    }
    useEffect(() => {
        apiFetch('/api/compliance/meta').then(r => r.ok ? r.json() : null).then(setMeta).catch(() => { })
        loadOverview()
    }, [])
    useEffect(() => { loadReport(cluster?.latest?.id) }, [cluster?.latest?.id])

    const [job, setJob, watch] = useJob(async (j) => {
        if (j.status === 'succeeded') toast({ title: j.kind === 'scan' ? 'Scan finished' : 'Fix applied', message: j.kind === 'scan' ? `Score ${j.result?.score}/100` : 'Run the scan again to see the result', type: 'success' })
        else toast({ title: 'Did not finish', message: j.error, type: 'error' })
        await loadOverview()
    })
    const running = job?.status === 'running'

    const scan = async () => {
        const r = await apiFetch(`/api/compliance/clusters/${clusterId}/scan`, { method: 'POST', body: JSON.stringify({ cis }) })
        const j = await r.json()
        if (!r.ok) return toast({ title: 'Scan not started', message: j.error, type: 'error' })
        setJob({ status: 'running', progress: 2, step: 'Starting', kind: 'scan' }); watch(j.jobId)
    }
    const fix = async (action) => {
        const r = await apiFetch(`/api/compliance/clusters/${clusterId}/fix/${action}`, { method: 'POST' })
        const j = await r.json()
        if (!r.ok) return toast({ title: r.status === 402 ? 'Part of Pro' : 'Fix not started', message: j.error, type: 'error' })
        setJob({ status: 'running', progress: 5, step: 'Setting NIC / NPL time servers on every node', kind: 'fix-ntp' }); watch(j.jobId)
    }
    const verify = async () => {
        const r = await apiFetch(`/api/compliance/reports/${report.id}/verify`)
        const j = await r.json()
        toast({ title: j.ok ? 'Seal verified' : 'Seal does NOT match', message: j.ok ? `SHA-256 ${j.sha256.slice(0, 16)}… — the report is unchanged.` : 'The stored report was changed after it was sealed.', type: j.ok ? 'success' : 'error' })
    }

    const TABS = [
        ['controls', 'Controls', ListChecks], ['attest', 'Attestations', BadgeCheck], ['certin', 'CERT-In report', Siren],
        ...(canAudit ? [['audit', 'Audit trail', ScrollText]] : []), ...(canApprove ? [['access', 'Access', Lock]] : []), ['schedule', 'Monthly report & settings', CalendarClock]
    ]
    const setTabUrl = (t) => { setTab(t); const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }) }

    if (!ov || !meta) return <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading compliance…</div>
    const todoAttest = Object.values(ov.attestations).filter(a => a.state !== 'valid').length

    return (
        <div>
            <PageHeader icon={ShieldCheck} eyebrow="Workspace" title="Compliance"
                description="Live evidence from your clusters mapped to CERT-In Directions 2022, the DPDP Act 2023 & Rules 2025, ISO/IEC 27001:2022 and the CIS Kubernetes Benchmark — with fixes, a sealed PDF report and the audit trail."
                actions={<>
                    <select aria-label="Cluster" value={clusterId} onChange={e => { const p = new URLSearchParams(params); p.set('cluster', e.target.value); setParams(p) }}
                        className="bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200">
                        {ov.clusters.map(c => <option key={c.id} value={c.id} className="bg-slate-950">{c.name}</option>)}
                    </select>
                    {canManage && <>
                        <label className="flex items-center gap-1.5 text-xs text-slate-400" title="kube-bench as a short Job on the control-plane (2–4 minutes)">
                            <input type="checkbox" checked={cis} onChange={e => setCis(e.target.checked)} /> CIS benchmark
                        </label>
                        <button onClick={scan} disabled={!clusterId || running} className="kz-btn-primary !py-2">{running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run scan</button>
                    </>}
                </>} />

            {!ov.clusters.length && <div className="kz-card p-8 text-center text-slate-400">No clusters yet — <Link to="/install" className="text-blue-300">deploy one</Link> to see its compliance.</div>}

            {running && (
                <div className="kz-card p-4 mb-6">
                    <div className="flex items-center justify-between text-sm text-slate-300"><span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin text-blue-300" />{job.step}</span><span>{job.progress}%</span></div>
                    <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden"><div className="h-full bg-gradient-to-r from-blue-400 to-cyan-300 transition-all" style={{ width: `${job.progress}%` }} /></div>
                    {job.logs?.length > 0 && <pre className="mt-3 max-h-32 overflow-auto text-[11px] text-slate-400 whitespace-pre-wrap">{job.logs.map(l => l.msg).join('\n')}</pre>}
                </div>
            )}

            {cluster && !report && !running && (
                <div className="kz-card p-8 text-center">
                    <ShieldCheck className="w-10 h-10 mx-auto text-blue-300/70" />
                    <p className="mt-3 text-slate-300">{cluster.name} has not been scanned yet.</p>
                    <p className="mt-1 text-sm text-slate-500">A scan reads the control-plane and every node over SSH (nothing is changed) and takes 1–5 minutes.</p>
                </div>
            )}

            {report && (<>
                {/* Score */}
                <section className="kz-card p-5 mb-6">
                    <div className="flex flex-col lg:flex-row lg:items-center gap-6">
                        <Ring score={report.score} grade={cluster?.latest?.grade} />
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 flex-1">
                            {Object.entries(meta.frameworks).map(([k, f]) => {
                                const s = report.frameworks[k]
                                return (
                                    <div key={k} className="rounded-xl border border-white/10 bg-white/[0.02] p-3" title={f.full}>
                                        <div className="text-[10px] font-black uppercase tracking-wider text-slate-500">{f.short}</div>
                                        <div className={`font-display text-2xl font-bold ${tone(s?.score)}`}>{s?.score ?? '—'}</div>
                                        <div className="text-[11px] text-slate-500">{s?.pass || 0} of {s?.controls || 0} pass</div>
                                    </div>
                                )
                            })}
                        </div>
                        <div className="flex flex-col gap-3 min-w-[12rem]">
                            <div className="text-xs text-slate-400">Scanned {fmt(report.at)}<br />by {typeof report.by === 'string' ? report.by : report.by?.username}</div>
                            <Trend history={cluster?.history} />
                            <div className="flex flex-wrap gap-2">
                                <button onClick={() => download(`/api/compliance/reports/${report.id}/pdf`, 'compliance.pdf', toast)} className="kz-btn-ghost !py-1.5 !text-xs"><FileDown className="w-3.5 h-3.5" /> PDF{!ov.pro && <Lock className="w-3 h-3 text-amber-300" />}</button>
                                <button onClick={() => download(`/api/compliance/reports/${report.id}/evidence`, 'evidence.json', toast)} className="kz-btn-ghost !py-1.5 !text-xs"><FileJson className="w-3.5 h-3.5" /> Evidence{!ov.pro && <Lock className="w-3 h-3 text-amber-300" />}</button>
                                <button onClick={verify} className="kz-btn-ghost !py-1.5 !text-xs" title={`SHA-256 ${report.seal?.sha256}`}><Fingerprint className="w-3.5 h-3.5" /> Verify seal</button>
                            </div>
                        </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3 text-xs">
                        {['pass', 'partial', 'fail', 'todo', 'na'].map(s => <span key={s} className="flex items-center gap-1.5"><Chip status={s} /><span className="text-slate-400">{report.totals[s]}</span></span>)}
                        {!ov.pro && <span className="ml-auto text-amber-200/80">PDF report, evidence bundle, fixes, monthly reports and CERT-In reports are part of <Link to="/pricing" className="underline">Pro</Link>.</span>}
                    </div>
                </section>
            </>)}

            {ov.clusters.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-4 border-b border-white/[0.06]">
                    {TABS.map(([k, label, Icon]) => (
                        <button key={k} onClick={() => setTabUrl(k)} className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition ${tab === k ? 'border-blue-400 text-white' : 'border-transparent text-slate-400 hover:text-white'}`}>
                            <Icon className="w-4 h-4" />{label}{k === 'attest' && todoAttest > 0 && <span className="px-1.5 rounded-full bg-violet-500/20 text-violet-200 text-[10px] font-black">{todoAttest}</span>}
                        </button>
                    ))}
                </div>
            )}

            {tab === 'controls' && report && <Controls report={report} meta={meta} canFix={canManage} pro={ov.pro} onFix={fix} running={running} />}
            {tab === 'attest' && <Attestations ov={ov} meta={meta} canManage={canManage} reload={loadOverview} toast={toast} />}
            {tab === 'certin' && <CertIn clusterId={clusterId} meta={meta} pro={ov.pro} toast={toast} attest={ov.attestations.certin_poc} />}
            {tab === 'audit' && canAudit && <Audit clusters={ov.clusters} toast={toast} />}
            {tab === 'access' && canApprove && <Access toast={toast} />}
            {tab === 'schedule' && <Schedule ov={ov} canManage={canManage} reload={loadOverview} toast={toast} />}
        </div>
    )
}

function Controls({ report, meta, canFix, pro, onFix, running }) {
    const [filter, setFilter] = useState('attention')
    const [open, setOpen] = useState({})
    const rows = report.results.filter(r => filter === 'all' || (filter === 'attention' ? ['fail', 'partial', 'todo'].includes(r.status) : r.status === filter))
    const kb = report.evidence?.kubeBench
    return (
        <div className="space-y-6">
            <div className="flex flex-wrap gap-2 text-xs">
                {[['attention', 'Needs attention'], ['all', 'All controls'], ['pass', 'Passed']].map(([k, l]) => (
                    <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1.5 rounded-lg border ${filter === k ? 'bg-white/10 border-white/20 text-white' : 'border-white/10 text-slate-400 hover:text-white'}`}>{l}</button>
                ))}
            </div>
            {Object.entries(meta.domains).map(([d, label]) => {
                const list = rows.filter(r => r.domain === d)
                if (!list.length) return null
                return (
                    <section key={d}>
                        <h3 className="mb-2 text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">{label}</h3>
                        <div className="kz-card divide-y divide-white/[0.05]">
                            {list.map(r => (
                                <div key={r.id} className="p-4">
                                    <button onClick={() => setOpen(o => ({ ...o, [r.id]: !o[r.id] }))} className="w-full flex items-start gap-3 text-left">
                                        <Chip status={r.status} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-semibold text-white"><span className="text-slate-500 font-mono text-xs mr-2">{r.id}</span>{r.title}</div>
                                            <div className="mt-0.5 text-xs text-slate-400">{r.evidence}</div>
                                        </div>
                                        <span className="text-[10px] uppercase tracking-wider text-slate-500">{r.severity}</span>
                                        <ChevronDown className={`w-4 h-4 text-slate-500 transition ${open[r.id] ? 'rotate-180' : ''}`} />
                                    </button>
                                    {open[r.id] && (
                                        <div className="mt-3 ml-1 pl-3 border-l border-white/10 space-y-2 text-xs">
                                            {r.fix && <div className="text-cyan-200/90"><b className="text-cyan-300">How to fix: </b>{r.fix}</div>}
                                            {r.fixAction === 'ntp' && r.status !== 'pass' && canFix && (
                                                <button onClick={() => onFix('ntp')} disabled={running} className="kz-btn-ghost !py-1.5 !text-xs"><Wrench className="w-3.5 h-3.5" /> Fix: set NIC / NPL time servers on every node{!pro && <Lock className="w-3 h-3 text-amber-300" />}</button>
                                            )}
                                            <div className="flex flex-wrap gap-1.5">
                                                {Object.entries(r.refs || {}).flatMap(([k, refs]) => refs.map(x => (
                                                    <span key={k + x} className="px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/10 text-slate-300"><b className="text-slate-400">{meta.frameworks[k].short}</b> {x}</span>
                                                )))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>
                )
            })}
            {!rows.length && <div className="kz-card p-6 text-sm text-slate-400">Nothing here — every control in this view passes.</div>}

            <section>
                <h3 className="mb-2 text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">Nodes</h3>
                <div className="kz-card overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead className="text-slate-500 text-left"><tr>{['Node', 'OS', 'Time sync', 'SSH', 'Security updates'].map(h => <th key={h} className="px-4 py-2 font-semibold">{h}</th>)}</tr></thead>
                        <tbody className="divide-y divide-white/[0.05] text-slate-300">
                            {(report.evidence?.nodes || []).map(n => (
                                <tr key={n.ip}>
                                    <td className="px-4 py-2"><Server className="inline w-3.5 h-3.5 mr-1 text-slate-500" />{n.name}<div className="text-slate-500">{n.ip} · {n.role}</div></td>
                                    <td className="px-4 py-2">{n.error ? <span className="text-red-300">not reachable: {n.error}</span> : n.os.pretty}</td>
                                    <td className="px-4 py-2">{n.ntp.synced ? <span className="text-emerald-300">synchronised</span> : <span className="text-red-300">not synchronised</span>}<div className="text-slate-500">{n.ntp.servers.slice(0, 3).join(', ') || 'default servers'}</div></td>
                                    <td className="px-4 py-2">{n.ssh ? <>root: {n.ssh.permitrootlogin}<div className="text-slate-500">password: {n.ssh.passwordauthentication}</div></> : '—'}</td>
                                    <td className="px-4 py-2">{n.os.securityUpdates == null ? '—' : n.os.securityUpdates}{n.os.rebootRequired && <span className="ml-1 text-amber-300">reboot pending</span>}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {kb?.ran && kb.failures?.length > 0 && (
                <details className="kz-card p-4">
                    <summary className="cursor-pointer text-sm font-semibold text-white">CIS benchmark: {kb.fail} failed checks <span className="text-slate-500 font-normal">({kb.pass} passed, {kb.warn} to review)</span></summary>
                    <div className="mt-3 space-y-2">
                        {kb.failures.map(f => <div key={f.id} className="text-xs"><span className="font-mono text-red-300 mr-2">{f.id}</span><span className="text-slate-200">{f.text}</span>{f.fix && <div className="text-slate-500 mt-0.5">{f.fix}</div>}</div>)}
                    </div>
                </details>
            )}
        </div>
    )
}

function Attestations({ ov, meta, canManage, reload, toast }) {
    const [draft, setDraft] = useState({})
    const save = async (key) => {
        const values = { ...(ov.attestations[key]?.values || {}), ...(draft[key] || {}) }
        const r = await apiFetch(`/api/compliance/attestations/${key}`, { method: 'PUT', body: JSON.stringify({ values }) })
        const j = await r.json()
        if (!r.ok) return toast({ title: 'Not saved', message: j.error, type: 'error' })
        toast({ title: 'Confirmed', message: `${meta.attestations[key].title} — valid one year`, type: 'success' })
        setDraft(d => ({ ...d, [key]: undefined })); reload()
    }
    return (
        <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(meta.attestations).map(([key, a]) => {
                const cur = ov.attestations[key] || { state: 'todo' }
                return (
                    <div key={key} className="kz-card p-4">
                        <div className="flex items-start justify-between gap-2">
                            <div>
                                <div className="text-sm font-semibold text-white">{a.title}</div>
                                <div className="mt-1 flex flex-wrap gap-1">{Object.entries(a.refs).flatMap(([k, r]) => r.map(x => <span key={k + x} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-400"><b>{meta.frameworks[k].short}</b> {x}</span>))}</div>
                            </div>
                            <Chip status={cur.state === 'valid' ? 'pass' : cur.state === 'expired' ? 'partial' : 'todo'} />
                        </div>
                        <div className="mt-3 grid gap-2">
                            {a.fields.map(([f, label]) => (
                                <label key={f} className="text-xs text-slate-400">{label}
                                    <input disabled={!canManage} value={draft[key]?.[f] ?? cur.values?.[f] ?? ''} onChange={e => setDraft(d => ({ ...d, [key]: { ...(d[key] || {}), [f]: e.target.value } }))}
                                        className="mt-1 w-full bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-slate-200 disabled:opacity-60" />
                                </label>
                            ))}
                        </div>
                        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
                            <span>{cur.at ? `Confirmed by ${cur.by} on ${new Date(cur.at).toLocaleDateString()}` : 'Not confirmed yet'}</span>
                            {canManage && <button onClick={() => save(key)} className="kz-btn-ghost !py-1 !text-xs"><BadgeCheck className="w-3.5 h-3.5" /> {cur.at ? 'Confirm again' : 'Confirm'}</button>}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

function CertIn({ clusterId, meta, pro, toast, attest }) {
    const [incidents, setIncidents] = useState([])
    const [sel, setSel] = useState(null)
    const [form, setForm] = useState({ type: '', occurredAt: '', description: '', actions: '', organisation: '' })
    const [busy, setBusy] = useState(false)
    useEffect(() => { apiFetch('/api/incidents').then(r => r.ok ? r.json() : []).then(l => setIncidents((Array.isArray(l) ? l : []).filter(i => !clusterId || i.clusterId === clusterId))).catch(() => { }) }, [clusterId])
    const make = async () => {
        setBusy(true)
        try {
            const r = await apiFetch(`/api/compliance/incidents/${sel.id}/certin`, { method: 'POST', body: JSON.stringify(form) })
            if (!r.ok) { const j = await r.json().catch(() => ({})); return toast({ title: r.status === 402 ? 'Part of Pro' : 'Not created', message: j.error, type: 'error' }) }
            const url = URL.createObjectURL(await r.blob())
            const a = document.createElement('a'); a.href = url; a.download = `cert-in-incident-${sel.id.slice(0, 8)}.pdf`; a.click()
        } finally { setBusy(false) }
    }
    const left = (i) => Math.round((Date.parse(i.timestamp) + 6 * 3600e3 - Date.now()) / 60e3)
    return (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
            <div className="kz-card p-4">
                <p className="text-xs text-slate-400 mb-3">CERT-In Directions 2022: report cyber security incidents within <b className="text-white">6 hours</b> of noticing them (incident@cert-in.org.in). Pick the incident — KubeEZ fills in the systems, times, evidence and actions taken.</p>
                {!attest?.values?.name && <div className="mb-3 text-xs text-violet-200 bg-violet-500/10 border border-violet-400/20 rounded-lg p-2">Tip: confirm the CERT-In point of contact under Attestations — it goes on every report.</div>}
                <div className="space-y-1 max-h-[26rem] overflow-auto">
                    {incidents.length === 0 && <div className="text-sm text-slate-500">No incidents in the last 7 days.</div>}
                    {incidents.map(i => {
                        const m = left(i)
                        return (
                            <button key={i.id} onClick={() => setSel(i)} className={`w-full text-left rounded-lg px-3 py-2 border ${sel?.id === i.id ? 'border-blue-400/40 bg-blue-500/10' : 'border-transparent hover:bg-white/[0.03]'}`}>
                                <div className="flex items-center gap-2 text-sm text-white"><span className={`w-2 h-2 rounded-full ${i.severity === 'critical' ? 'bg-red-400' : 'bg-amber-400'}`} />{i.reason}</div>
                                <div className="text-[11px] text-slate-500 flex items-center gap-1"><Clock className="w-3 h-3" />{fmt(i.timestamp)} · {m > 0 ? <span className="text-amber-300">{Math.floor(m / 60)}h {m % 60}m left to report</span> : <span>6-hour window passed</span>}</div>
                            </button>
                        )
                    })}
                </div>
            </div>
            <div className="kz-card p-4">
                {!sel ? <div className="text-sm text-slate-500">Choose an incident on the left.</div> : (
                    <div className="space-y-3 text-xs">
                        <div className="text-sm font-semibold text-white">{sel.reason} <span className="text-slate-500 font-normal">— {sel.clusterName}</span></div>
                        <label className="block text-slate-400">Type of incident (Annexure I)
                            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="mt-1 w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200">
                                <option value="" className="bg-slate-950">— choose —</option>
                                {meta.certinTypes.map(t => <option key={t} value={t} className="bg-slate-950">{t}</option>)}
                            </select>
                        </label>
                        {[['organisation', 'Organisation name'], ['occurredAt', 'When did it start (if known)']].map(([k, l]) => (
                            <label key={k} className="block text-slate-400">{l}<input value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} className="mt-1 w-full bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-slate-200" /></label>
                        ))}
                        {[['description', 'What happened (your words)'], ['actions', 'Actions taken']].map(([k, l]) => (
                            <label key={k} className="block text-slate-400">{l}<textarea rows={3} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} className="mt-1 w-full bg-black/40 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-slate-200" /></label>
                        ))}
                        <button onClick={make} disabled={busy} className="kz-btn-primary !py-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CERT-In report (PDF){!pro && <Lock className="w-3.5 h-3.5" />}</button>
                    </div>
                )}
            </div>
        </div>
    )
}

function Audit({ clusters, toast }) {
    const [data, setData] = useState(null)
    const [days, setDays] = useState(30)
    const [action, setAction] = useState('')
    const q = useMemo(() => `from=${Date.now() - days * 86400e3}${action ? `&action=${encodeURIComponent(action)}` : ''}`, [days, action])
    const load = () => apiFetch(`/api/compliance/audit?${q}`).then(r => r.ok ? r.json() : null).then(setData).catch(() => { })
    useEffect(() => { load() }, [q])
    const name = (id) => clusters.find(c => c.id === id)?.name || id
    return (
        <div className="kz-card">
            <div className="flex flex-wrap items-center gap-2 p-3 border-b border-white/[0.05] text-xs">
                <select value={days} onChange={e => setDays(Number(e.target.value))} className="bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200">
                    {[7, 30, 90, 180, 365].map(d => <option key={d} value={d} className="bg-slate-950">Last {d} days</option>)}
                </select>
                <input placeholder="Filter action (e.g. etcd, login, addons)" value={action} onChange={e => setAction(e.target.value)} className="bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-slate-200 w-64" />
                {data && <span className={`flex items-center gap-1 ${data.chain.ok ? 'text-emerald-300' : 'text-red-300'}`}><Fingerprint className="w-3.5 h-3.5" />{data.chain.ok ? `Hash chain intact (${data.chain.count} entries)` : `Hash chain BROKEN: ${data.chain.reason}`}</span>}
                {data && <span className="text-slate-500">kept {data.coverage.retentionDays} days{data.coverage.oldest ? ` · since ${new Date(data.coverage.oldest).toLocaleDateString()}` : ''}</span>}
                <button onClick={load} className="kz-btn-ghost !py-1 !text-xs ml-auto"><RotateCcw className="w-3.5 h-3.5" /></button>
                <button onClick={() => download(`/api/compliance/audit.csv?${q}`, 'audit.csv', toast)} className="kz-btn-ghost !py-1 !text-xs"><Download className="w-3.5 h-3.5" /> CSV</button>
            </div>
            <div className="overflow-x-auto max-h-[32rem]">
                <table className="w-full text-xs">
                    <thead className="text-slate-500 text-left sticky top-0 bg-[#0e0e13]"><tr>{['Time', 'Who', 'Action', 'Cluster', 'Result', 'IP'].map(h => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                    <tbody className="divide-y divide-white/[0.04] text-slate-300">
                        {(data?.entries || []).map(e => (
                            <tr key={e.hash}>
                                <td className="px-3 py-1.5 whitespace-nowrap text-slate-400">{fmt(e.at)}</td>
                                <td className="px-3 py-1.5">{e.actor?.username || <span className="text-slate-500">KubeEZ</span>}{e.actor?.role && <span className="text-slate-500"> · {e.actor.role}</span>}</td>
                                <td className="px-3 py-1.5 font-mono text-[11px]">{e.action}{e.detail && <div className="font-sans text-slate-500">{e.detail}</div>}</td>
                                <td className="px-3 py-1.5">{e.target?.clusterName || (e.target?.clusterId ? name(e.target.clusterId) : '')}</td>
                                <td className="px-3 py-1.5">{e.ok ? <span className="text-emerald-300">ok</span> : <span className="text-red-300">failed{e.status ? ` (${e.status})` : ''}</span>}</td>
                                <td className="px-3 py-1.5 text-slate-500">{e.ip}</td>
                            </tr>
                        ))}
                        {data && !data.entries.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Nothing recorded in this period.</td></tr>}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

function Schedule({ ov, canManage, reload, toast }) {
    const s = ov.schedule || {}
    const save = async (next) => {
        const r = await apiFetch('/api/compliance/schedule', { method: 'PUT', body: JSON.stringify(next) })
        const j = await r.json()
        if (!r.ok) return toast({ title: r.status === 402 ? 'Part of Pro' : 'Not saved', message: j.error, type: 'error' })
        toast({ title: next.enabled ? 'Monthly report on' : 'Monthly report off', type: 'success' }); reload()
    }
    return (
        <div className="kz-card p-5 max-w-2xl">
            <div className="text-sm font-semibold text-white">Monthly compliance report</div>
            <p className="mt-1 text-xs text-slate-400">Every 30 days KubeEZ scans every cluster of the workspace, emails the sealed PDF to the admins and alerts when a control got worse. The reports stay here, with the score history.</p>
            <div className="mt-4 flex flex-col gap-2 text-sm text-slate-300">
                <label className="flex items-center gap-2"><input type="checkbox" disabled={!canManage} checked={!!s.enabled} onChange={e => save({ ...s, enabled: e.target.checked })} /> Scan monthly and email the report{!ov.pro && <Lock className="w-3.5 h-3.5 text-amber-300" />}</label>
                <label className="flex items-center gap-2"><input type="checkbox" disabled={!canManage || !s.enabled} checked={s.cis !== false} onChange={e => save({ ...s, cis: e.target.checked })} /> Include the CIS benchmark</label>
            </div>
            <div className="mt-3 text-[11px] text-slate-500">Last monthly run: {fmt(ov.lastScheduledAt)}</div>
            <div className="mt-6 pt-5 border-t border-white/[0.06]">
                <div className="text-sm font-semibold text-white">Scan add-on images before install</div>
                <p className="mt-1 text-xs text-slate-400">Before an add-on is installed or updated, KubeEZ renders its chart and scans every image with Trivy for critical vulnerabilities that have a fix. The first scan on a cluster downloads the scanner and its database (about 2 minutes).</p>
                <select disabled={!canManage} value={ov.addonScan || 'off'} onChange={async e => {
                    const r = await apiFetch('/api/compliance/addon-scan', { method: 'PUT', body: JSON.stringify({ mode: e.target.value }) })
                    const j = await r.json()
                    if (!r.ok) return toast({ title: 'Not saved', message: j.error, type: 'error' })
                    toast({ title: 'Add-on scan: ' + j.addonScan, type: 'success' }); reload()
                }} className="mt-3 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200">
                    <option value="off" className="bg-slate-950">Off</option>
                    <option value="warn" className="bg-slate-950">Warn — report findings in the install log</option>
                    <option value="block" className="bg-slate-950">Block — refuse images with fixable critical vulnerabilities</option>
                </select>
            </div>
        </div>
    )
}

function Access({ toast }) {
    const [data, setData] = useState(null)
    const [sessions, setSessions] = useState([])
    const [view, setView] = useState(null)
    const load = async () => {
        const [g, s] = await Promise.all([apiFetch('/api/terminal/grants'), apiFetch('/api/terminal/sessions')])
        if (g.ok) setData(await g.json())
        if (s.ok) setSessions((await s.json()).sessions)
    }
    useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [])
    const act = async (id, what) => {
        const r = await apiFetch(`/api/terminal/grants/${id}/${what}`, { method: 'POST' })
        const j = await r.json()
        if (!r.ok) return toast({ title: 'Not done', message: j.error, type: 'error' })
        toast({ title: what === 'approve' ? 'Access approved' : what === 'deny' ? 'Request denied' : 'Access ended', message: `${j.username} → ${j.clusterName}`, type: 'success' })
        load()
    }
    const setApproval = async (v) => {
        const r = await apiFetch('/api/terminal/settings', { method: 'PUT', body: JSON.stringify({ requireApproval: v }) })
        if (r.ok) load()
    }
    const open = async (id) => {
        const r = await apiFetch(`/api/terminal/sessions/${id}`)
        if (r.ok) setView({ id, events: (await r.json()).events })
    }
    if (!data) return <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
    const pending = data.grants.filter(g => g.status === 'pending')
    const live = data.grants.filter(g => g.status === 'active')
    const row = (g, actions) => (
        <div key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <div className="flex-1 min-w-0">
                <div className="text-white">{g.username} <span className="text-slate-500">({g.role})</span> → {g.clusterName} · {g.minutes} min</div>
                <div className="text-xs text-slate-400">"{g.reason}" · asked {fmt(g.requestedAt)}{g.expiresAt && g.status === 'active' ? ` · until ${new Date(g.expiresAt).toLocaleTimeString()}` : ''}{g.decidedBy ? ` · by ${g.decidedBy}` : ''}</div>
            </div>
            {actions}
        </div>
    )
    const transcript = (events) => events.map(e => e.type === 'start' ? `# ${e.user?.username} on ${e.clusterName} — ${e.t}\n# reason: ${e.reason || '—'}\n`
        : e.type === 'cmd' ? `\n[${new Date(e.t).toLocaleTimeString()}] $ ${e.command}\n`
            : e.type === 'out' ? e.text.split('\n').map(l => l ? `[${e.node}] ${l}` : '').join('\n')
                : e.type === 'end' ? `\n# ended ${e.t} (${e.why})\n` : `\n# ${e.text}\n`).join('')
    return (
        <div className="space-y-6">
            <section className="kz-card p-4 flex flex-wrap items-center gap-3 text-sm">
                <Lock className="w-4 h-4 text-amber-300" />
                <span className="text-slate-300 flex-1">Terminal access is just in time: a reason and a time limit for every session, and every session is recorded.</span>
                <label className="flex items-center gap-2 text-slate-300"><input type="checkbox" checked={data.settings.requireApproval} onChange={e => setApproval(e.target.checked)} /> Operators need an admin's approval</label>
            </section>
            <section>
                <h3 className="mb-2 text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">Waiting for approval ({pending.length})</h3>
                <div className="kz-card divide-y divide-white/[0.05]">
                    {pending.length ? pending.map(g => row(g, <>
                        <button onClick={() => act(g.id, 'approve')} className="kz-btn-primary !py-1.5 !text-xs"><CheckCircle2 className="w-3.5 h-3.5" /> Approve</button>
                        <button onClick={() => act(g.id, 'deny')} className="kz-btn-ghost !py-1.5 !text-xs"><XCircle className="w-3.5 h-3.5" /> Deny</button>
                    </>)) : <div className="px-4 py-4 text-sm text-slate-500">No requests.</div>}
                </div>
            </section>
            <section>
                <h3 className="mb-2 text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">Access right now ({live.length})</h3>
                <div className="kz-card divide-y divide-white/[0.05]">
                    {live.length ? live.map(g => row(g, <button onClick={() => act(g.id, 'revoke')} className="kz-btn-ghost !py-1.5 !text-xs text-red-300"><XCircle className="w-3.5 h-3.5" /> End now</button>))
                        : <div className="px-4 py-4 text-sm text-slate-500">Nobody has terminal access now.</div>}
                </div>
            </section>
            <section>
                <h3 className="mb-2 text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">Recorded sessions</h3>
                <div className="kz-card overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead className="text-slate-500 text-left"><tr>{['Started', 'Who', 'Cluster', 'Reason', 'Commands', ''].map(h => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
                        <tbody className="divide-y divide-white/[0.04] text-slate-300">
                            {sessions.map(s => (
                                <tr key={s.id}>
                                    <td className="px-3 py-2 whitespace-nowrap">{fmt(s.at)}{s.live && <span className="ml-2 text-red-300">● live</span>}</td>
                                    <td className="px-3 py-2">{s.user} <span className="text-slate-500">{s.role}</span></td>
                                    <td className="px-3 py-2">{s.clusterName}</td>
                                    <td className="px-3 py-2 text-slate-400">{s.reason}</td>
                                    <td className="px-3 py-2">{s.commands}</td>
                                    <td className="px-3 py-2 whitespace-nowrap">
                                        <button onClick={() => open(s.id)} className="kz-btn-ghost !py-1 !text-xs">Replay</button>
                                        <button onClick={() => download(`/api/terminal/sessions/${s.id}?format=text`, 'terminal.txt', toast)} className="kz-btn-ghost !py-1 !text-xs"><Download className="w-3.5 h-3.5" /></button>
                                    </td>
                                </tr>
                            ))}
                            {!sessions.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No terminal sessions yet.</td></tr>}
                        </tbody>
                    </table>
                </div>
            </section>
            {view && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setView(null)}>
                    <div className="kz-card w-full max-w-4xl max-h-[80vh] overflow-auto p-4" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-3"><span className="text-sm font-semibold text-white">Session {view.id.slice(0, 8)}</span><button onClick={() => setView(null)} className="kz-btn-ghost !py-1 !text-xs">Close</button></div>
                        <pre className="text-[11px] font-mono whitespace-pre-wrap text-slate-300">{transcript(view.events)}</pre>
                    </div>
                </div>
            )}
        </div>
    )
}
