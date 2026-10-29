import { useState, useEffect, useCallback } from 'react'
import { Layers, Package, Snowflake, GitCompare, Plus, Trash2, Lock, Loader2, AlertTriangle, Save } from 'lucide-react'
import { apiFetch } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import PageHeader from '../components/ui/PageHeader'

// Delivery settings of the workspace: environments (and which are protected),
// chart repositories, change freezes — and comparing one app across two
// environments. Who may change what is decided by the server.
const json = async (res) => { const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`); return d }
const local = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }

function Section({ Icon, title, hint, children }) {
    return (
        <section className="kz-card p-5 space-y-4">
            <div className="flex items-start gap-3"><Icon className="w-5 h-5 text-blue-300 mt-0.5" /><div><h2 className="text-base font-semibold text-white">{title}</h2><p className="text-xs text-slate-400">{hint}</p></div></div>
            {children}
        </section>
    )
}

export default function DeliverySettings() {
    const { toast } = useToast()
    const [clusters, setClusters] = useState([])
    const [envs, setEnvs] = useState(null)
    const [repos, setRepos] = useState(null)
    const [freezes, setFreezes] = useState(null)
    const [error, setError] = useState(null)
    const [envForm, setEnvForm] = useState({ name: '', clusterId: '', namespace: '', protected: false })
    const [repoForm, setRepoForm] = useState({ name: '', url: '', username: '', password: '' })
    const [freezeForm, setFreezeForm] = useState(() => ({ from: local(new Date()), until: local(new Date(Date.now() + 86400e3)), reason: '', clusterIds: [] }))
    const [cmp, setCmp] = useState({ release: '', a: '', b: '' })
    const [cmpResult, setCmpResult] = useState(null)

    const load = useCallback(async () => {
        try {
            const [e, r, f] = await Promise.all(['/api/delivery/environments', '/api/delivery/repos', '/api/delivery/freezes'].map(u => apiFetch(u).then(json)))
            setEnvs(e); setRepos(r); setFreezes(f); setError(null)
        } catch (err) { setError(err.message) }
        apiFetch('/api/clusters').then(r => r.ok ? r.json() : []).then(l => setClusters(Array.isArray(l) ? l : l.clusters || [])).catch(() => { })
    }, [])
    useEffect(() => { load() }, [load])

    const send = async (url, method, body, ok) => {
        try { await json(await apiFetch(url, { method, body: body ? JSON.stringify(body) : undefined })); toast({ title: ok, type: 'success' }); load(); return true }
        catch (e) { toast({ title: 'Not saved', message: e.message, type: 'error' }); return false }
    }
    const compare = async () => {
        setCmpResult({ loading: true })
        try { setCmpResult(await json(await apiFetch('/api/delivery/compare', { method: 'POST', body: JSON.stringify(cmp) }))) } catch (e) { setCmpResult({ error: e.message }) }
    }

    return (
        <div className="max-w-5xl mx-auto space-y-5">
            <PageHeader eyebrow="Apps" title="Delivery" icon={Layers} description="Environments, chart repositories and change freezes for deploying apps with KubeEZ." />
            {error && <p className="flex items-center gap-1.5 text-sm text-red-300"><AlertTriangle className="w-4 h-4" />{error}</p>}

            <Section Icon={Layers} title="Environments" hint="A name for a namespace on a cluster (dev, staging, prod). A protected environment needs a second person (Approvals) for every deploy, roll back and uninstall — so the workspace needs two admins.">
                {!envs ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> : (
                    <>
                        <ul className="space-y-1.5">{envs.environments.map(e => (
                            <li key={e.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 text-xs">
                                <span className="font-semibold text-white">{e.name}</span><span className="text-slate-400">{e.clusterName} · {e.namespace}</span>
                                {e.protected && <span className="flex items-center gap-1 text-amber-200"><Lock className="w-3 h-3" />protected</span>}
                                {envs.canManage && <span className="ml-auto flex gap-2">
                                    <button onClick={() => send(`/api/delivery/environments/${e.id}`, 'PUT', { ...e, protected: !e.protected }, e.protected ? 'No longer protected' : 'Protected')} className="kz-btn-ghost !py-1 !px-2 !text-[11px]">{e.protected ? 'Unprotect' : 'Protect'}</button>
                                    <button onClick={() => window.confirm(`Remove environment ${e.name}? Nothing on the cluster changes.`) && send(`/api/delivery/environments/${e.id}`, 'DELETE', null, 'Removed')} className="kz-btn-ghost !py-1 !px-2 !text-[11px] text-red-300" aria-label={`Remove ${e.name}`}><Trash2 className="w-3 h-3" /></button>
                                </span>}
                            </li>
                        ))}{!envs.environments.length && <li className="text-sm text-slate-500">None yet.</li>}</ul>
                        {envs.canManage && (
                            <div className="flex flex-wrap items-end gap-2">
                                <input className="kz-input !w-32" placeholder="prod" value={envForm.name} onChange={e => setEnvForm(f => ({ ...f, name: e.target.value }))} aria-label="Environment name" />
                                <select className="kz-input !w-48" value={envForm.clusterId} onChange={e => setEnvForm(f => ({ ...f, clusterId: e.target.value }))} aria-label="Cluster"><option value="">Cluster…</option>{clusters.map(c => <option key={c.id} value={c.id}>{c.clusterName || c.id}</option>)}</select>
                                <input className="kz-input !w-40" placeholder="namespace" value={envForm.namespace} onChange={e => setEnvForm(f => ({ ...f, namespace: e.target.value }))} aria-label="Namespace" />
                                <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={envForm.protected} onChange={e => setEnvForm(f => ({ ...f, protected: e.target.checked }))} /> Protected</label>
                                <button onClick={async () => { if (await send('/api/delivery/environments', 'POST', envForm, 'Environment added')) setEnvForm({ name: '', clusterId: '', namespace: '', protected: false }) }} className="kz-btn-primary !py-2 !text-xs"><Plus className="w-3.5 h-3.5" /> Add</button>
                            </div>
                        )}
                    </>
                )}
            </Section>

            <Section Icon={Package} title="Chart repositories" hint="The only places apps may be deployed from. https:// Helm repositories (with a chart list) or oci:// registries. A password is stored encrypted and never shown again; it is passed to Helm on the control-plane when deploying.">
                {!repos ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> : (
                    <>
                        <ul className="space-y-1.5">{repos.repos.map(r => (
                            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 text-xs">
                                <span className="font-semibold text-white">{r.name}</span><span className="font-mono text-slate-400 break-all">{r.url}</span>
                                {r.username && <span className="text-slate-500">as {r.username}{r.hasPassword ? ' (password set)' : ''}</span>}
                                {repos.canManage && <button onClick={() => window.confirm(`Remove repository ${r.name}?`) && send(`/api/delivery/repos/${r.id}`, 'DELETE', null, 'Removed')} className="ml-auto kz-btn-ghost !py-1 !px-2 !text-[11px] text-red-300" aria-label={`Remove ${r.name}`}><Trash2 className="w-3 h-3" /></button>}
                            </li>
                        ))}{!repos.repos.length && <li className="text-sm text-slate-500">None yet — add e.g. bitnami: https://charts.bitnami.com/bitnami</li>}</ul>
                        {repos.canManage && (
                            <div className="flex flex-wrap items-end gap-2">
                                <input className="kz-input !w-32" placeholder="name" value={repoForm.name} onChange={e => setRepoForm(f => ({ ...f, name: e.target.value }))} aria-label="Repository name" />
                                <input className="kz-input !w-72" placeholder="https://charts.example.com or oci://…" value={repoForm.url} onChange={e => setRepoForm(f => ({ ...f, url: e.target.value }))} aria-label="Repository address" />
                                <input className="kz-input !w-32" placeholder="user (optional)" value={repoForm.username} onChange={e => setRepoForm(f => ({ ...f, username: e.target.value }))} aria-label="User name" autoComplete="off" />
                                <input className="kz-input !w-36" type="password" placeholder="password" value={repoForm.password} onChange={e => setRepoForm(f => ({ ...f, password: e.target.value }))} aria-label="Password" autoComplete="new-password" />
                                <button onClick={async () => { if (await send('/api/delivery/repos', 'POST', repoForm, 'Repository added')) setRepoForm({ name: '', url: '', username: '', password: '' }) }} className="kz-btn-primary !py-2 !text-xs"><Plus className="w-3.5 h-3.5" /> Add</button>
                            </div>
                        )}
                    </>
                )}
            </Section>

            <Section Icon={Snowflake} title="Change freezes" hint="While a freeze runs, nobody deploys, rolls back, uninstalls or syncs GitOps apps on the clusters it covers. An admin can still push an urgent fix by giving a reason — it is recorded in the audit trail.">
                {!freezes ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> : (
                    <>
                        <ul className="space-y-1.5">{freezes.freezes.map(f => (
                            <li key={f.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 text-xs">
                                <span className="font-semibold text-white">{f.reason}</span>
                                <span className="text-slate-400">{new Date(f.from).toLocaleString()} → {new Date(f.until).toLocaleString()}</span>
                                <span className="text-slate-500">{f.clusterIds.length ? f.clusterIds.map(id => clusters.find(c => c.id === id)?.clusterName || id).join(', ') : 'all clusters'}</span>
                                {Date.parse(f.from) <= Date.now() && <span className="text-sky-200">active</span>}
                                {freezes.canManage && <button onClick={() => send(`/api/delivery/freezes/${f.id}`, 'DELETE', null, 'Freeze ended')} className="ml-auto kz-btn-ghost !py-1 !px-2 !text-[11px]">End</button>}
                            </li>
                        ))}{!freezes.freezes.length && <li className="text-sm text-slate-500">No freeze planned.</li>}</ul>
                        {freezes.canManage && (
                            <div className="flex flex-wrap items-end gap-2">
                                <input className="kz-input !w-52" placeholder="Why (e.g. Diwali sale)" value={freezeForm.reason} onChange={e => setFreezeForm(f => ({ ...f, reason: e.target.value }))} aria-label="Reason" />
                                <input className="kz-input !w-48" type="datetime-local" value={freezeForm.from} onChange={e => setFreezeForm(f => ({ ...f, from: e.target.value }))} aria-label="From" />
                                <input className="kz-input !w-48" type="datetime-local" value={freezeForm.until} onChange={e => setFreezeForm(f => ({ ...f, until: e.target.value }))} aria-label="Until" />
                                <select multiple className="kz-input !w-48 !h-20" value={freezeForm.clusterIds} onChange={e => setFreezeForm(f => ({ ...f, clusterIds: [...e.target.selectedOptions].map(o => o.value) }))} aria-label="Clusters (none = all)">{clusters.map(c => <option key={c.id} value={c.id}>{c.clusterName || c.id}</option>)}</select>
                                <button onClick={() => send('/api/delivery/freezes', 'POST', { ...freezeForm, from: new Date(freezeForm.from).toISOString(), until: new Date(freezeForm.until).toISOString() }, 'Freeze planned')} className="kz-btn-primary !py-2 !text-xs"><Save className="w-3.5 h-3.5" /> Plan freeze</button>
                                <span className="text-[11px] text-slate-500">No cluster picked = every cluster.</span>
                            </div>
                        )}
                    </>
                )}
            </Section>

            <Section Icon={GitCompare} title="Compare environments" hint="The same app in two environments: chart version and every value that differs (secrets masked). Finds config drift before a promotion.">
                <div className="flex flex-wrap items-end gap-2">
                    <input className="kz-input !w-40" placeholder="release name" value={cmp.release} onChange={e => setCmp(c => ({ ...c, release: e.target.value }))} aria-label="Release" />
                    {['a', 'b'].map(k => <select key={k} className="kz-input !w-48" value={cmp[k]} onChange={e => setCmp(c => ({ ...c, [k]: e.target.value }))} aria-label={k === 'a' ? 'First environment' : 'Second environment'}><option value="">{k === 'a' ? 'From…' : 'To…'}</option>{(envs?.environments || []).map(e => <option key={e.id} value={e.id}>{e.name} ({e.clusterName}/{e.namespace})</option>)}</select>)}
                    <button onClick={compare} disabled={!cmp.release || !cmp.a || !cmp.b || cmpResult?.loading} className="kz-btn-primary !py-2 !text-xs">{cmpResult?.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCompare className="w-3.5 h-3.5" />} Compare</button>
                </div>
                {cmpResult?.error && <p className="text-xs text-red-300">{cmpResult.error}</p>}
                {cmpResult?.release && (
                    <div className="space-y-2 text-xs">
                        <div className="grid grid-cols-2 gap-2">{['a', 'b'].map(k => (
                            <div key={k} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5">
                                <p className="font-semibold text-white">{cmpResult[k].env.name}</p>
                                <p className="text-slate-400 font-mono">{cmpResult[k].release ? `${cmpResult[k].release.chart} ${cmpResult[k].release.version || ''} · revision ${cmpResult[k].release.revision} · ${cmpResult[k].release.status}` : 'not installed here'}</p>
                            </div>
                        ))}</div>
                        {cmpResult.chartDiffers && <p className="text-amber-200">The chart or its version differs.</p>}
                        {cmpResult.values && (cmpResult.values.length ? (
                            <table className="w-full text-[11px]"><thead><tr className="text-left text-slate-500 border-b border-white/10"><th className="py-1 font-semibold">Value</th><th className="py-1 font-semibold">{cmpResult.a.env.name}</th><th className="py-1 font-semibold">{cmpResult.b.env.name}</th></tr></thead>
                                <tbody>{cmpResult.values.map(v => <tr key={v.key} className="border-b border-white/[0.05] align-top"><td className="py-1 font-mono text-slate-300">{v.key}</td><td className="py-1 font-mono text-slate-200 break-all">{v.only === 'b' ? <span className="text-slate-500">—</span> : JSON.stringify(v.a)}</td><td className="py-1 font-mono text-slate-200 break-all">{v.only === 'a' ? <span className="text-slate-500">—</span> : JSON.stringify(v.b)}</td></tr>)}</tbody></table>
                        ) : <p className="text-emerald-300">Same values in both.</p>)}
                    </div>
                )}
            </Section>
        </div>
    )
}
