import { useState, useEffect, useCallback } from 'react'
import { ShieldAlert, RefreshCw, Loader2, AlertTriangle, ChevronDown, ChevronRight, Search, ExternalLink, Wrench } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// Security of one cluster from the Trivy Operator's reports: image
// vulnerabilities per workload (critical / high listed, with the fixed
// version) and failed misconfiguration checks. Read-only.
const SEV = {
    CRITICAL: { label: 'Critical', chip: 'text-red-300 border-red-400/30 bg-red-500/10' },
    HIGH: { label: 'High', chip: 'text-orange-200 border-orange-400/30 bg-orange-500/10' }
}
const ago = (iso) => {
    if (!iso) return null
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
// public advisory page for a CVE / GHSA id
const advisory = (id) => /^CVE-\d{4}-\d+$/i.test(id) ? `https://nvd.nist.gov/vuln/detail/${id.toUpperCase()}` : /^GHSA-/i.test(id) ? `https://github.com/advisories/${id}` : null

function Counts({ c }) {
    return (
        <span className="flex flex-wrap gap-1 text-[11px] font-semibold">
            <span className={`rounded-md border px-1.5 py-0.5 ${c.critical ? SEV.CRITICAL.chip : 'border-white/10 text-slate-500'}`}>{c.critical} critical</span>
            <span className={`rounded-md border px-1.5 py-0.5 ${c.high ? SEV.HIGH.chip : 'border-white/10 text-slate-500'}`}>{c.high} high</span>
            <span className="rounded-md border border-white/10 px-1.5 py-0.5 text-slate-400">{c.medium} medium</span>
            <span className="rounded-md border border-white/10 px-1.5 py-0.5 text-slate-500">{c.low} low</span>
        </span>
    )
}

function Vuln({ v }) {
    const link = advisory(v.id)
    return (
        <li className="grid grid-cols-[auto,1fr] gap-x-2 text-[11px]">
            <span className={`rounded-md border px-1.5 py-0.5 font-semibold h-fit ${SEV[v.severity]?.chip}`}>{SEV[v.severity]?.label}</span>
            <span className="text-slate-300 break-words">
                {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-300 hover:underline">{v.id}</a> : <span className="font-mono">{v.id}</span>}
                {v.score ? <span className="text-slate-500"> · {v.score}</span> : null}
                {' · '}<span className="font-mono">{v.pkg} {v.installed}</span>
                {v.fixed ? <span className="text-emerald-300"> → fixed in {v.fixed}</span> : <span className="text-slate-500"> · no fix yet</span>}
                {v.container && <span className="text-slate-500"> · {v.container}</span>}
                {v.title && <span className="block text-slate-500">{v.title}</span>}
            </span>
        </li>
    )
}

function WorkloadRow({ w }) {
    const [open, setOpen] = useState(false)
    const mis = w.misconfig?.checks?.length || 0
    return (
        <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
            <button onClick={() => setOpen(o => !o)} className="w-full flex flex-wrap items-center gap-3 text-left" aria-expanded={open}>
                {open ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                <span className="flex-1 min-w-[200px]">
                    <span className="block text-sm font-semibold text-white break-all">{w.name} <span className="text-[10px] font-medium text-slate-500">{w.kind} · {w.namespace}</span></span>
                    <span className="block text-[11px] text-slate-400 font-mono break-all">{w.containers.map(c => c.image).filter(Boolean).join(', ') || '—'}</span>
                </span>
                {w.containers.length > 0 && <Counts c={w.counts} />}
                {w.fixable > 0 && <span className="flex items-center gap-1 text-[11px] text-emerald-300"><Wrench className="w-3 h-3" />{w.fixable} fixable</span>}
                {mis > 0 && <span className="text-[11px] text-amber-200">{mis} misconfiguration{mis === 1 ? '' : 's'}</span>}
            </button>
            {open && (
                <div className="mt-3 ml-7 space-y-3">
                    {w.vulns.length > 0 ? (
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Critical and high vulnerabilities{w.vulnCount > w.vulns.length ? ` (first ${w.vulns.length} of ${w.vulnCount})` : ''}</p>
                            <ul className="space-y-1.5">{w.vulns.map((v, i) => <Vuln key={i} v={v} />)}</ul>
                        </div>
                    ) : w.containers.length > 0 && <p className="text-[11px] text-slate-500">No critical or high vulnerabilities.</p>}
                    {mis > 0 && (
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Failed checks</p>
                            <ul className="space-y-1">{w.misconfig.checks.map((c, i) => (
                                <li key={i} className="text-[11px] text-slate-300"><span className={`rounded-md border px-1.5 py-0.5 font-semibold mr-1.5 ${SEV[c.severity]?.chip}`}>{SEV[c.severity]?.label}</span><span className="font-mono text-slate-400">{c.id}</span> {c.title}</li>
                            ))}</ul>
                        </div>
                    )}
                    <p className="text-[10px] text-slate-500">Scanned {w.containers.map(c => `${c.container} ${ago(c.updatedAt) || ''}`).join(' · ')}</p>
                </div>
            )}
        </li>
    )
}

export default function SecurityTab({ clusterId, canInstall, onOpenAddons }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [view, setView] = useState('workloads')
    const [q, setQ] = useState('')
    const [fixable, setFixable] = useState(false)

    const load = useCallback(async (fresh = false) => {
        setLoading(true); setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/security${fresh ? '?fresh=1' : ''}`)
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error || 'Could not read the security reports')
            setData(d)
        } catch (e) { setError(e.message) } finally { setLoading(false) }
    }, [clusterId])
    useEffect(() => { load() }, [load])

    const needle = q.trim().toLowerCase()
    const has = (...vals) => !needle || vals.some(v => v && String(v).toLowerCase().includes(needle))
    const workloads = (data?.workloads || []).filter(w => (!fixable || w.fixable > 0) && has(w.name, w.namespace, ...w.containers.map(c => c.image), ...w.vulns.map(v => v.id), ...w.vulns.map(v => v.pkg)))
    const cves = (data?.cves || []).filter(c => (!fixable || c.fixed.length) && has(c.id, c.title, ...c.packages, ...c.images))
    const vt = data?.tools?.vulnerabilities
    const missing = vt?.state === 'missing'
    const t = data?.totals

    return (
        <div className="space-y-5">
            <div className="kz-card p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                    <ShieldAlert className="w-5 h-5 text-blue-300" />
                    <div className="flex-1 min-w-[200px]">
                        <h3 className="text-base font-semibold text-white">Security</h3>
                        <p className="text-xs text-slate-400">What the Trivy Operator found in the images that run here, and in how they are configured — worst first, with the version that fixes it.</p>
                    </div>
                    {data?.newestReport && <span className="text-[11px] text-slate-500">newest scan {ago(data.newestReport)}</span>}
                    <button onClick={() => load(true)} disabled={loading} className="kz-btn-ghost !py-1.5 !text-xs" aria-label="Read again"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
                </div>

                {error && <p className="flex items-center gap-1.5 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>}
                {loading && !data && <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>}
                {vt && !['ok', 'missing'].includes(vt.state) && <p className="flex items-start gap-1.5 text-[11px] text-amber-200"><AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />{vt.message}</p>}
                {data?.limited && <p className="text-[11px] text-slate-500">Showing your namespaces only.</p>}

                {missing && (
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 text-sm text-slate-300">
                        The Trivy Operator is not installed on this cluster. It scans every image that runs here and checks how workloads are configured — install it and the results appear here after the first scans (a few minutes).
                        {canInstall && <button onClick={onOpenAddons} className="ml-2 inline-flex items-center gap-1 text-blue-300 hover:underline">Open Add-ons <ExternalLink className="w-3 h-3" /></button>}
                    </div>
                )}

                {t && !missing && (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        {[['Critical', t.critical, 'text-red-300'], ['High', t.high, 'text-orange-200'], ['CVEs with a fix', `${t.fixableCves} / ${t.cves}`, 'text-emerald-300'], ['Images scanned', t.images, 'text-white'], ['Misconfigured workloads', data.misconfig.workloads, 'text-amber-200']].map(([l, n, tone]) => (
                            <div key={l} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                                <p className={`text-xl font-bold ${tone}`}>{n}</p>
                                <p className="text-[11px] text-slate-500">{l}</p>
                            </div>
                        ))}
                    </div>
                )}

                {data && !missing && (data.workloads.length > 0 ? (
                    <>
                        <div className="flex flex-wrap items-center gap-2">
                            {[['workloads', `By workload ${data.workloads.length}`], ['cves', `By CVE ${data.cveTotal}`]].map(([k, l]) => (
                                <button key={k} onClick={() => setView(k)} className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold ${view === k ? 'bg-blue-500/20 text-white' : 'text-slate-400 hover:bg-white/5'}`}>{l}</button>
                            ))}
                            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 ml-2"><input type="checkbox" checked={fixable} onChange={e => setFixable(e.target.checked)} /> Only with a fix</label>
                            <div className="relative ml-auto">
                                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search workloads, images, CVEs" className="kz-input !py-1.5 !pl-8 !text-xs !w-56" aria-label="Search" />
                            </div>
                        </div>
                        {view === 'workloads' ? (
                            workloads.length ? <ul className="space-y-2">{workloads.map(w => <WorkloadRow key={w.id} w={w} />)}</ul> : <p className="text-sm text-slate-500 py-2">Nothing matches.</p>
                        ) : (
                            cves.length ? (
                                <div className="overflow-x-auto">
                                    <table className="w-full text-[11px]">
                                        <thead><tr className="text-left text-slate-500 border-b border-white/10">
                                            <th className="py-1.5 pr-2 font-semibold">Severity</th><th className="py-1.5 pr-2 font-semibold">CVE</th><th className="py-1.5 pr-2 font-semibold">Package</th><th className="py-1.5 pr-2 font-semibold">Fixed in</th><th className="py-1.5 pr-2 font-semibold text-right">Workloads</th><th className="py-1.5 font-semibold">Images</th>
                                        </tr></thead>
                                        <tbody>{cves.map(c => (
                                            <tr key={c.id} className="border-b border-white/[0.05] align-top">
                                                <td className="py-1.5 pr-2"><span className={`rounded-md border px-1.5 py-0.5 font-semibold ${SEV[c.severity]?.chip}`}>{SEV[c.severity]?.label}</span></td>
                                                <td className="py-1.5 pr-2">{advisory(c.id) ? <a href={advisory(c.id)} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-300 hover:underline">{c.id}</a> : <span className="font-mono">{c.id}</span>}{c.score ? <span className="text-slate-500"> · {c.score}</span> : null}{c.title && <span className="block text-slate-500">{c.title}</span>}</td>
                                                <td className="py-1.5 pr-2 font-mono text-slate-300">{c.packages.join(', ')}</td>
                                                <td className="py-1.5 pr-2 font-mono">{c.fixed.length ? <span className="text-emerald-300">{c.fixed.join(', ')}</span> : <span className="text-slate-500">no fix yet</span>}</td>
                                                <td className="py-1.5 pr-2 text-right text-slate-200">{c.workloads}</td>
                                                <td className="py-1.5 font-mono text-slate-400 break-all">{c.images.join(', ')}</td>
                                            </tr>
                                        ))}</tbody>
                                    </table>
                                    {data.cveTotal > data.cves.length && <p className="mt-2 text-[11px] text-slate-500">Showing the {data.cves.length} most severe of {data.cveTotal}.</p>}
                                </div>
                            ) : <p className="text-sm text-slate-500 py-2">Nothing matches.</p>
                        )}
                    </>
                ) : !error && vt?.state === 'ok' && <p className="text-sm text-slate-500 py-2">No scan results yet — the first scans take a few minutes after the Trivy Operator starts.</p>)}
            </div>
        </div>
    )
}
