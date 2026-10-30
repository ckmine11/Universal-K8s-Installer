import { useState, useEffect, useCallback } from 'react'
import { Layers, Package, Snowflake, GitCompare, Plus, Trash2, Lock, Loader2, AlertTriangle, Save, KeyRound, GitPullRequest, Container } from 'lucide-react'
import { apiFetch } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import PageHeader from '../components/ui/PageHeader'
import { useFeatures } from '../config/features'

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
    const featureOn = useFeatures()
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
    const [tokens, setTokens] = useState(null)      // null: not allowed to manage tokens
    const [newToken, setNewToken] = useState(null)
    const [tokForm, setTokForm] = useState({ name: '', clusterId: '', namespace: '', release: '', repoId: '', chart: '', keys: 'image.tag', expiresDays: 90 })
    const [regs, setRegs] = useState(null)
    const [regForm, setRegForm] = useState({ name: '', server: '', username: '', password: '' })
    const [sync, setSync] = useState({ registryId: '', clusterId: '', namespaces: '', defaultServiceAccount: false })
    const [git, setGit] = useState(null)
    const [gitForm, setGitForm] = useState({ name: '', apiUrl: 'https://api.github.com', token: '' })
    const [pr, setPr] = useState({ accountId: '', repo: '', base: 'main', path: '', set: '', busy: false, result: null })

    const load = useCallback(async () => {
        try {
            const [e, r, f, g, rg] = await Promise.all(['/api/delivery/environments', '/api/delivery/repos', '/api/delivery/freezes', '/api/delivery/git', '/api/delivery/registries'].map(u => apiFetch(u).then(json)))
            setEnvs(e); setRepos(r); setFreezes(f); setGit(g); setRegs(rg); setError(null)
        } catch (err) { setError(err.message) }
        apiFetch('/api/delivery/tokens').then(r => r.ok ? r.json() : null).then(d => setTokens(d ? d.tokens : null)).catch(() => setTokens(null))
        apiFetch('/api/clusters').then(r => r.ok ? r.json() : []).then(l => setClusters(Array.isArray(l) ? l : l.clusters || [])).catch(() => { })
    }, [])
    useEffect(() => { load() }, [load])

    const send = async (url, method, body, ok) => {
        try { await json(await apiFetch(url, { method, body: body ? JSON.stringify(body) : undefined })); toast({ title: ok, type: 'success' }); load(); return true }
        catch (e) { toast({ title: 'Not saved', message: e.message, type: 'error' }); return false }
    }
    const syncRegistry = async () => {
        try {
            const d = await json(await apiFetch(`/api/clusters/${sync.clusterId}/registries/sync`, { method: 'POST', body: JSON.stringify({ registryId: sync.registryId, namespaces: sync.namespaces.split(',').map(s => s.trim()).filter(Boolean), defaultServiceAccount: sync.defaultServiceAccount }) }))
            toast({ title: 'Pull secret written', message: d.message, type: 'success' })
        } catch (e) { toast({ title: 'Not written', message: e.message, type: 'error' }) }
    }
    const createToken = async () => {
        try {
            const d = await json(await apiFetch('/api/delivery/tokens', { method: 'POST', body: JSON.stringify({ ...tokForm, allowedKeys: tokForm.keys.split(',').map(s => s.trim()).filter(Boolean) }) }))
            setNewToken(d.token); toast({ title: 'Token created', message: 'Copy it now — it is shown once.', type: 'success' }); load()
        } catch (e) { toast({ title: 'No token', message: e.message, type: 'error' }) }
    }
    // "image.tag=1.4.2, replicas=3" → { "image.tag": "1.4.2", replicas: 3 }
    const parseSet = (s) => Object.fromEntries(s.split(',').map(x => x.trim()).filter(Boolean).map(x => { const i = x.indexOf('='); const v = x.slice(i + 1).trim(); return [x.slice(0, i).trim(), /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v] }))
    const promote = async () => {
        setPr(p => ({ ...p, busy: true, result: null }))
        try {
            const d = await json(await apiFetch('/api/delivery/promote', { method: 'POST', body: JSON.stringify({ accountId: pr.accountId, repo: pr.repo, base: pr.base || 'main', path: pr.path, set: parseSet(pr.set) }) }))
            setPr(p => ({ ...p, busy: false, result: d }))
        } catch (e) { setPr(p => ({ ...p, busy: false })); toast({ title: 'No pull request', message: e.message, type: 'error' }) }
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
                                {envs.canManage ? (
                                    <select className="kz-input !w-auto !py-1 !text-[11px]" value={e.cvePolicy ? `${e.cvePolicy.mode}:${e.cvePolicy.severity}` : 'off'} aria-label={`CVE policy of ${e.name}`}
                                        onChange={ev => { const [mode, severity] = ev.target.value.split(':'); send(`/api/delivery/environments/${e.id}`, 'PUT', { ...e, cvePolicy: mode === 'off' ? { mode: 'off' } : { mode, severity } }, 'CVE policy saved') }}>
                                        <option value="off">CVE gate: off</option><option value="warn:CRITICAL">warn on critical</option><option value="block:CRITICAL">block critical</option><option value="warn:HIGH">warn on high+</option><option value="block:HIGH">block high+</option>
                                    </select>
                                ) : e.cvePolicy && <span className="text-slate-400">CVE gate: {e.cvePolicy.mode} {e.cvePolicy.severity.toLowerCase()}</span>}
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

            {regs && featureOn('registries') && (
                <Section Icon={Container} title="Registries (pull secrets)" hint="A private registry's login, written as a pull secret (kubeez-registry-<name>) into the namespaces you pick — optionally used by their default ServiceAccount, so pods pull without changing manifests. The password is stored encrypted and sent to the cluster on stdin.">
                    <ul className="space-y-1.5">{regs.registries.map(r => (
                        <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 text-xs">
                            <span className="font-semibold text-white">{r.name}</span><span className="font-mono text-slate-400">{r.server}</span><span className="text-slate-500">as {r.username}</span>
                            {regs.canManage && <button onClick={() => window.confirm(`Remove ${r.name}? Secrets already in clusters stay.`) && send(`/api/delivery/registries/${r.id}`, 'DELETE', null, 'Removed')} className="ml-auto kz-btn-ghost !py-1 !px-2 !text-[11px] text-red-300" aria-label={`Remove ${r.name}`}><Trash2 className="w-3 h-3" /></button>}
                        </li>
                    ))}{!regs.registries.length && <li className="text-sm text-slate-500">None yet.</li>}</ul>
                    {regs.canManage && (
                        <>
                            <div className="flex flex-wrap items-end gap-2">
                                <input className="kz-input !w-28" placeholder="name" value={regForm.name} onChange={e => setRegForm(f => ({ ...f, name: e.target.value }))} aria-label="Registry name" />
                                <input className="kz-input !w-52" placeholder="ghcr.io" value={regForm.server} onChange={e => setRegForm(f => ({ ...f, server: e.target.value }))} aria-label="Registry server" />
                                <input className="kz-input !w-32" placeholder="user" value={regForm.username} onChange={e => setRegForm(f => ({ ...f, username: e.target.value }))} aria-label="User name" autoComplete="off" />
                                <input className="kz-input !w-40" type="password" placeholder="password / token" value={regForm.password} onChange={e => setRegForm(f => ({ ...f, password: e.target.value }))} aria-label="Password" autoComplete="new-password" />
                                <button onClick={async () => { if (await send('/api/delivery/registries', 'POST', regForm, 'Registry added')) setRegForm({ name: '', server: '', username: '', password: '' }) }} className="kz-btn-primary !py-2 !text-xs"><Plus className="w-3.5 h-3.5" /> Add</button>
                            </div>
                            {regs.registries.length > 0 && (
                                <div className="flex flex-wrap items-end gap-2 rounded-lg border border-white/[0.07] p-3">
                                    <select className="kz-input !w-36" value={sync.registryId} onChange={e => setSync(s => ({ ...s, registryId: e.target.value }))} aria-label="Registry"><option value="">Registry…</option>{regs.registries.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                                    <select className="kz-input !w-40" value={sync.clusterId} onChange={e => setSync(s => ({ ...s, clusterId: e.target.value }))} aria-label="Cluster"><option value="">Cluster…</option>{clusters.map(c => <option key={c.id} value={c.id}>{c.clusterName || c.id}</option>)}</select>
                                    <input className="kz-input !w-56" placeholder="namespaces: shop, dev" value={sync.namespaces} onChange={e => setSync(s => ({ ...s, namespaces: e.target.value }))} aria-label="Namespaces (comma separated)" />
                                    <label className="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" checked={sync.defaultServiceAccount} onChange={e => setSync(s => ({ ...s, defaultServiceAccount: e.target.checked }))} /> Use for the default ServiceAccount</label>
                                    <button onClick={syncRegistry} disabled={!sync.registryId || !sync.clusterId || !sync.namespaces.trim()} className="kz-btn-primary !py-2 !text-xs">Write pull secret</button>
                                </div>
                            )}
                        </>
                    )}
                </Section>
            )}

            {tokens && featureOn('deployTokens') && (
                <Section Icon={KeyRound} title="Deploy tokens (CI)" hint="A token deploys one app from your pipeline (GitHub Actions, GitLab CI, Jenkins) — one release, one chart, only the values you list (e.g. image.tag). Protected environments, freezes and the CVE gate still apply. The token is shown once.">
                    {newToken && (
                        <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/[0.05] p-3 text-[11px] space-y-1.5">
                            <p className="text-emerald-100 font-semibold">Copy it now — it is not shown again.</p>
                            <code className="block font-mono text-slate-200 break-all">{newToken}</code>
                            <pre className="whitespace-pre-wrap font-mono text-slate-400">{`curl -fsS -X POST ${window.location.origin}/api/hooks/deploy \\\n  -H "Authorization: Bearer $KUBEEZ_TOKEN" -H "Content-Type: application/json" \\\n  -d '{"set": {"image.tag": "'"$GIT_SHA"'"}}'`}</pre>
                        </div>
                    )}
                    <ul className="space-y-1.5">{tokens.map(t => (
                        <li key={t.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 text-xs">
                            <span className="font-semibold text-white">{t.name}</span><span className="font-mono text-slate-500">{t.hint}</span>
                            <span className="text-slate-400">{clusters.find(c => c.id === t.clusterId)?.clusterName || t.clusterId} · {t.namespace}/{t.release} · may set {t.allowedKeys.join(', ')}</span>
                            <span className={t.revokedAt || t.expired ? 'text-red-300' : 'text-slate-500'}>{t.revokedAt ? 'revoked' : t.expired ? 'expired' : `until ${t.expiresAt.slice(0, 10)}`}{t.lastUsedAt ? ` · used ${new Date(t.lastUsedAt).toLocaleString()}` : ' · never used'}</span>
                            {!t.revokedAt && <button onClick={() => window.confirm(`Revoke ${t.name}? Pipelines using it stop deploying.`) && send(`/api/delivery/tokens/${t.id}`, 'DELETE', null, 'Revoked')} className="ml-auto kz-btn-ghost !py-1 !px-2 !text-[11px] text-red-300">Revoke</button>}
                        </li>
                    ))}{!tokens.length && <li className="text-sm text-slate-500">No tokens yet.</li>}</ul>
                    <div className="flex flex-wrap items-end gap-2">
                        <input className="kz-input !w-44" placeholder="name (ci web prod)" value={tokForm.name} onChange={e => setTokForm(f => ({ ...f, name: e.target.value }))} aria-label="Token name" />
                        <select className="kz-input !w-40" value={tokForm.clusterId} onChange={e => setTokForm(f => ({ ...f, clusterId: e.target.value }))} aria-label="Cluster"><option value="">Cluster…</option>{clusters.map(c => <option key={c.id} value={c.id}>{c.clusterName || c.id}</option>)}</select>
                        <input className="kz-input !w-32" placeholder="namespace" value={tokForm.namespace} onChange={e => setTokForm(f => ({ ...f, namespace: e.target.value }))} aria-label="Namespace" />
                        <input className="kz-input !w-32" placeholder="release" value={tokForm.release} onChange={e => setTokForm(f => ({ ...f, release: e.target.value }))} aria-label="Release" />
                        <select className="kz-input !w-36" value={tokForm.repoId} onChange={e => setTokForm(f => ({ ...f, repoId: e.target.value }))} aria-label="Repository"><option value="">Repository…</option>{(repos?.repos || []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
                        <input className="kz-input !w-32" placeholder="chart" value={tokForm.chart} onChange={e => setTokForm(f => ({ ...f, chart: e.target.value }))} aria-label="Chart" />
                        <input className="kz-input !w-40" placeholder="image.tag" value={tokForm.keys} onChange={e => setTokForm(f => ({ ...f, keys: e.target.value }))} aria-label="Values it may change (comma separated)" />
                        <select className="kz-input !w-28" value={tokForm.expiresDays} onChange={e => setTokForm(f => ({ ...f, expiresDays: Number(e.target.value) }))} aria-label="Expires after">{[30, 90, 180, 365].map(d => <option key={d} value={d}>{d} days</option>)}</select>
                        <button onClick={createToken} className="kz-btn-primary !py-2 !text-xs"><Plus className="w-3.5 h-3.5" /> Create token</button>
                    </div>
                </Section>
            )}

            {git && featureOn('gitopsPromote') && (
                <Section Icon={GitPullRequest} title="Promote by pull request" hint="Change values in a YAML file of a GitHub repository (e.g. image.tag in apps/web/prod.yaml) — KubeEZ opens a pull request; Argo CD / Flux deploy it once it is merged. The token needs Contents and Pull requests: read and write.">
                    <ul className="space-y-1.5">{git.accounts.map(a => (
                        <li key={a.id} className="flex items-center gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2.5 text-xs">
                            <span className="font-semibold text-white">{a.name}</span><span className="text-slate-400 font-mono">{a.apiUrl}</span>{a.hasToken && <span className="text-slate-500">(token set)</span>}
                            {git.canManage && <button onClick={() => window.confirm(`Remove ${a.name}?`) && send(`/api/delivery/git/${a.id}`, 'DELETE', null, 'Removed')} className="ml-auto kz-btn-ghost !py-1 !px-2 !text-[11px] text-red-300" aria-label={`Remove ${a.name}`}><Trash2 className="w-3 h-3" /></button>}
                        </li>
                    ))}</ul>
                    {git.canManage && (
                        <div className="flex flex-wrap items-end gap-2">
                            <input className="kz-input !w-32" placeholder="name (github)" value={gitForm.name} onChange={e => setGitForm(f => ({ ...f, name: e.target.value }))} aria-label="Account name" />
                            <input className="kz-input !w-60" placeholder="https://api.github.com" value={gitForm.apiUrl} onChange={e => setGitForm(f => ({ ...f, apiUrl: e.target.value }))} aria-label="API address" />
                            <input className="kz-input !w-56" type="password" placeholder="token" value={gitForm.token} onChange={e => setGitForm(f => ({ ...f, token: e.target.value }))} aria-label="GitHub token" autoComplete="new-password" />
                            <button onClick={async () => { if (await send('/api/delivery/git', 'POST', gitForm, 'Git account added')) setGitForm({ name: '', apiUrl: 'https://api.github.com', token: '' }) }} className="kz-btn-primary !py-2 !text-xs"><Plus className="w-3.5 h-3.5" /> Add</button>
                        </div>
                    )}
                    {git.accounts.length > 0 && (
                        <div className="rounded-lg border border-white/[0.07] p-3 space-y-2">
                            <div className="flex flex-wrap items-end gap-2">
                                <select className="kz-input !w-36" value={pr.accountId} onChange={e => setPr(p => ({ ...p, accountId: e.target.value }))} aria-label="Git account"><option value="">Account…</option>{git.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                                <input className="kz-input !w-44" placeholder="owner/repo" value={pr.repo} onChange={e => setPr(p => ({ ...p, repo: e.target.value }))} aria-label="Repository" />
                                <input className="kz-input !w-24" placeholder="main" value={pr.base} onChange={e => setPr(p => ({ ...p, base: e.target.value }))} aria-label="Base branch" />
                                <input className="kz-input !w-56" placeholder="apps/web/prod.yaml" value={pr.path} onChange={e => setPr(p => ({ ...p, path: e.target.value }))} aria-label="File" />
                                <input className="kz-input !w-56" placeholder="image.tag=1.4.2, replicas=3" value={pr.set} onChange={e => setPr(p => ({ ...p, set: e.target.value }))} aria-label="Values to set" />
                                <button onClick={promote} disabled={pr.busy} className="kz-btn-primary !py-2 !text-xs">{pr.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitPullRequest className="w-3.5 h-3.5" />} Open pull request</button>
                            </div>
                            {pr.result && <p className="text-xs text-emerald-200">Pull request <a href={pr.result.url} target="_blank" rel="noopener noreferrer" className="underline">#{pr.result.number}</a> opened: {pr.result.changes.map(c => `${c.key} ${c.from ?? '—'} → ${c.to}`).join(', ')}</p>}
                        </div>
                    )}
                </Section>
            )}

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
