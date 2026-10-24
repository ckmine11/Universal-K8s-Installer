import { useState, useEffect, useCallback } from 'react'
import { Loader2, RefreshCw, Cloud, KeyRound, Trash2, ArrowUpCircle, AlertTriangle, CheckCircle2, Info, Minus, Plus } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useToast } from '../ToastProvider'
import { call, CopyBlock, ago } from './shared'

// A managed cloud cluster (EKS, AKS, GKE, OKE, DOKS, LKE): its cloud account,
// then its node pools and Kubernetes upgrades through the provider's API.
// The keys go to the server once and never come back to the page.
export default function CloudAccount({ c, onChanged }) {
    const { user } = useAuth()
    const cloud = c.cloud
    const mayConnect = can(user?.role, 'cluster:delete', c.id)
    const [editing, setEditing] = useState(false)
    if (!cloud?.supported) return null
    return (
        <div className="kz-card p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Cloud className="w-4 h-4 text-sky-300" />
                <h3 className="flex-1 text-sm font-semibold text-white">Node pools & upgrades <span className="font-normal text-slate-400">— through {cloud.providerName}</span></h3>
                {cloud.connected && <span className="text-[11px] text-slate-400">as <span className="font-mono text-slate-200">{cloud.identity}</span> · since {ago(cloud.connectedAt)}</span>}
                {cloud.connected && mayConnect && !editing && <button type="button" onClick={() => setEditing(true)} className="kz-btn-ghost !py-1 !text-[11px]"><KeyRound className="w-3.5 h-3.5" /> Change account</button>}
            </div>
            {(!cloud.connected || editing)
                ? mayConnect
                    ? <AccountForm c={c} onDone={() => { setEditing(false); onChanged() }} onCancel={cloud.connected ? () => setEditing(false) : null} />
                    : <p className="text-xs text-slate-400">No cloud account connected. An admin can add one here to scale node pools and upgrade Kubernetes from KubeEZ.</p>
                : <Pools c={c} onChanged={onChanged} />}
        </div>
    )
}

function AccountForm({ c, onDone, onCancel }) {
    const { toast } = useToast()
    const cloud = c.cloud
    const [ref, setRef] = useState(() => ({ ...cloud.defaults, ...(cloud.ref || {}) }))
    const [creds, setCreds] = useState({})
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const setup = cloud.setup || {}
    const save = async (e) => {
        e.preventDefault(); setBusy(true); setError(null)
        try {
            const r = await call(`/api/connect/clusters/${c.id}/cloud`, { method: 'PUT', body: { ref, creds } })
            setCreds({})   // never kept in the page
            toast({ title: 'Cloud account connected', message: `KubeEZ reaches ${cloud.providerName} as ${r.identity}.`, type: 'success' })
            onDone()
        } catch (err) { setError(err.data?.hint ? `${err.message} ${err.data.hint}` : err.message) } finally { setBusy(false) }
    }
    const disconnect = async () => {
        if (!window.confirm(`Forget the ${cloud.providerName} account? KubeEZ stops showing node pools and offering upgrades for ${c.name}. (Delete the key in ${cloud.providerName} too.)`)) return
        setBusy(true)
        try { await call(`/api/connect/clusters/${c.id}/cloud`, { method: 'DELETE' }); toast({ title: 'Cloud account removed', type: 'success' }); onDone() }
        catch (err) { toast({ title: 'Not removed', message: err.message, type: 'error' }) } finally { setBusy(false) }
    }
    const input = (f, value, onChange) => f.multiline
        ? <textarea rows={5} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={cloud.connected && f.secret ? 'kept — paste to replace' : f.placeholder || ''} className="kz-input mt-1 w-full font-mono !text-xs" spellCheck={false} />
        : <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={value || ''} onChange={e => onChange(e.target.value)} placeholder={cloud.connected && f.secret ? 'kept — type to replace' : f.placeholder || ''} className="kz-input mt-1 w-full !text-xs" />
    return (
        <div className="grid gap-5 lg:grid-cols-2">
            <form onSubmit={save} className="min-w-0 space-y-3">
                <p className="text-xs text-slate-400">Give KubeEZ a cloud login that may only read and update this cluster. It is checked against {c.name} before it is kept, stored encrypted, and never shown again.</p>
                <p className="text-[11px] uppercase tracking-wider text-slate-500">Where the cluster is</p>
                {cloud.fields.ref.map(f => <label key={f.key} className="block text-xs text-slate-300">{f.label}{f.optional ? '' : ' *'}{input(f, ref[f.key], v => setRef(r => ({ ...r, [f.key]: v })))}</label>)}
                <p className="text-[11px] uppercase tracking-wider text-slate-500">The login</p>
                {cloud.fields.creds.map(f => <label key={f.key} className="block text-xs text-slate-300">{f.label}{f.optional || (cloud.connected && f.secret) ? '' : ' *'}{input(f, creds[f.key], v => setCreds(r => ({ ...r, [f.key]: v })))}</label>)}
                {error && <p className="flex items-start gap-1.5 text-xs text-red-200"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</p>}
                <div className="flex flex-wrap gap-2">
                    <button type="submit" disabled={busy} className="kz-btn-primary !text-xs">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Check and connect</button>
                    {onCancel && <button type="button" onClick={onCancel} className="kz-btn-ghost !text-xs">Cancel</button>}
                    {cloud.connected && <button type="button" disabled={busy} onClick={disconnect} className="kz-btn-ghost !text-xs !text-red-300 ml-auto"><Trash2 className="w-3.5 h-3.5" /> Remove account</button>}
                </div>
            </form>
            <div className="min-w-0 space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-white"><Info className="w-3.5 h-3.5 text-sky-300" /> Create the login in {cloud.providerName}</p>
                {setup.intro && <p className="text-xs text-slate-400">{setup.intro}</p>}
                {(setup.commands || []).map((cmd, i) => <CopyBlock key={i} text={cmd} multiline={cmd.includes('\n') || cmd.length > 90} />)}
                {setup.after && <p className="text-xs text-slate-400">{setup.after}</p>}
            </div>
        </div>
    )
}

function Pools({ c, onChanged }) {
    const { user } = useAuth()
    const { toast } = useToast()
    const [o, setO] = useState(null)
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(null)
    const [sizes, setSizes] = useState({})     // poolId → { count } | { min, max } being edited
    const [target, setTarget] = useState('')
    const mayScale = can(user?.role, 'cluster:scale', c.id)
    const mayUpgrade = can(user?.role, 'cluster:upgrade', c.id)
    const load = useCallback(() => call(`/api/connect/clusters/${c.id}/cloud/overview`).then(d => { setO(d); setError(null); setTarget(t => t || d.upgrades?.[d.upgrades.length - 1] || '') }).catch(e => setError(e.data?.hint ? `${e.message} ${e.data.hint}` : e.message)), [c.id])
    // faster while something is changing
    useEffect(() => { load(); const busyNow = o?.busy || o?.pools?.some(p => p.busy); const t = setInterval(load, busyNow ? 15000 : 60000); return () => clearInterval(t) }, [load, o?.busy, o?.pools?.some(p => p.busy)])  // eslint-disable-line react-hooks/exhaustive-deps
    const act = async (what, fn) => { setBusy(what); try { await fn(); await load() } catch (e) { toast({ title: 'Not done', message: e.message, type: 'error' }) } finally { setBusy(null) } }

    if (error && !o) return (
        <div className="space-y-2">
            <p className="flex items-start gap-1.5 text-xs text-red-200"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</p>
            <button type="button" onClick={load} className="kz-btn-ghost !text-xs"><RefreshCw className="w-3.5 h-3.5" /> Try again</button>
        </div>
    )
    if (!o) return <Loader2 className="w-5 h-5 animate-spin text-slate-400" />

    const scale = (p) => act(`scale:${p.id}`, async () => {
        const s = sizes[p.id]
        const r = await call(`/api/connect/clusters/${c.id}/cloud/pools/${encodeURIComponent(p.id)}/scale`, { method: 'POST', body: s })
        toast({ title: `${r.pool}: resizing`, message: `${o.providerName} is changing the pool — it takes a few minutes.`, type: 'success' })
        setSizes(x => { const { [p.id]: _, ...rest } = x; return rest })
    })
    const upgrade = () => {
        if (!window.confirm(`Upgrade the ${o.providerName} control plane of ${c.name} from ${o.version} to ${target}? This cannot be undone.${o.poolUpgrades ? ' Upgrade the node pools after it.' : ''}`)) return
        act('upgrade', async () => {
            const r = await call(`/api/connect/clusters/${c.id}/cloud/upgrade`, { method: 'POST', body: { targetVersion: target } })
            toast({ title: 'Upgrade started', message: `${r.from} → ${r.to}. ${o.providerName} takes 10–30 minutes.`, type: 'success' })
            setTarget(''); onChanged()
        })
    }
    const upgradePool = (p) => {
        const recycle = p.upgradeTo === 'recycle'
        if (!window.confirm(recycle ? `Recycle the nodes of ${p.name}? They are replaced one by one and come back on ${o.version}.` : `Upgrade node pool ${p.name} from ${p.version} to ${p.upgradeTo}? Its nodes are replaced one by one.`)) return
        act(`up:${p.id}`, async () => {
            const r = await call(`/api/connect/clusters/${c.id}/cloud/pools/${encodeURIComponent(p.id)}/upgrade`, { method: 'POST', body: recycle ? {} : { targetVersion: p.upgradeTo } })
            toast({ title: `${r.pool}: ${recycle ? 'recycling nodes' : 'upgrade started'}`, type: 'success' })
        })
    }
    const sizeFor = (p) => sizes[p.id] || (p.autoscale ? { min: p.min ?? 0, max: p.max ?? 0 } : { count: p.count ?? 0 })
    const setSize = (p, patch) => setSizes(x => ({ ...x, [p.id]: { ...sizeFor(p), ...patch } }))
    const num = (v) => Math.max(0, Math.min(1000, parseInt(v, 10) || 0))

    return (
        <div className="space-y-4">
            {error && <p className="flex items-start gap-1.5 text-xs text-amber-200"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />Last refresh failed: {error}</p>}
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div><p className="text-[11px] text-slate-500">Control plane</p><p className="text-sm text-white">Kubernetes {o.version || '?'}{o.platform ? <span className="text-xs text-slate-400"> · {o.platform}</span> : null}</p></div>
                <div><p className="text-[11px] text-slate-500">Status</p><p className={`text-sm ${o.busy ? 'text-amber-200' : 'text-slate-200'}`}>{o.busy && <Loader2 className="inline w-3.5 h-3.5 mr-1 animate-spin" />}{o.status || '—'}</p></div>
                <div className="flex-1" />
                {o.upgrades?.length > 0 ? (mayUpgrade ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <select value={target} onChange={e => setTarget(e.target.value)} className="kz-input !w-auto !py-1 !text-xs" aria-label="Upgrade to">{o.upgrades.map(v => <option key={v} value={v}>{v}</option>)}</select>
                        <button type="button" disabled={!!busy || o.busy || !target} onClick={upgrade} className="kz-btn-primary !text-xs">{busy === 'upgrade' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />} Upgrade control plane</button>
                    </div>
                ) : <p className="text-xs text-slate-400">Upgrade available: {o.upgrades.join(', ')}</p>) : <p className="text-xs text-emerald-200">No upgrade offered — up to date</p>}
                <button type="button" onClick={() => act('refresh', async () => {})} disabled={!!busy} className="kz-btn-ghost !py-1 !text-[11px]" title="Refresh">{busy === 'refresh' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}</button>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead><tr className="text-left text-slate-500"><th className="py-1.5 font-medium">Node pool</th><th className="font-medium">Machine</th><th className="font-medium">Version</th><th className="font-medium">Status</th><th className="font-medium">Nodes (cloud / ready)</th><th className="font-medium">Size</th><th /></tr></thead>
                    <tbody className="text-slate-300">
                        {o.pools.map(p => {
                            const s = sizeFor(p), changed = !!sizes[p.id]
                            return (
                                <tr key={p.id} className="border-t border-white/5 align-middle">
                                    <td className="py-2"><span className="font-mono text-white">{p.name}</span>{p.mode && <span className="ml-1.5 text-slate-500">{p.mode}</span>}{p.problems?.length > 0 && <span className="block text-amber-200" title={p.problems.join('\n')}>{p.problems[0]}</span>}</td>
                                    <td>{p.machine || '—'}{p.capacity && p.capacity !== 'ON_DEMAND' ? <span className="text-slate-500"> · {p.capacity.toLowerCase()}</span> : null}</td>
                                    <td>{p.version || '—'}</td>
                                    <td className={p.busy ? 'text-amber-200' : ''}>{p.busy && <Loader2 className="inline w-3 h-3 mr-1 animate-spin" />}{p.status || '—'}</td>
                                    <td>{p.count ?? '?'}{p.perZone ? <span className="text-slate-500"> ({p.perZone} zones)</span> : null} / {p.live ? <span className={p.live.ready < p.live.nodes ? 'text-amber-200' : 'text-emerald-300'}>{p.live.ready}</span> : '—'}</td>
                                    <td>
                                        {!mayScale ? (p.autoscale ? `${p.min}–${p.max} (autoscale)` : p.count) : p.autoscale ? (
                                            <span className="inline-flex items-center gap-1">min <input type="number" min={0} max={1000} value={s.min} onChange={e => setSize(p, { min: num(e.target.value) })} className="kz-input !w-14 !py-0.5 !text-xs" aria-label={`${p.name} min`} /> max <input type="number" min={0} max={1000} value={s.max} onChange={e => setSize(p, { max: num(e.target.value) })} className="kz-input !w-14 !py-0.5 !text-xs" aria-label={`${p.name} max`} /></span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1">
                                                <button type="button" onClick={() => setSize(p, { count: Math.max(0, s.count - 1) })} className="kz-btn-ghost !p-1" aria-label="One node fewer"><Minus className="w-3 h-3" /></button>
                                                <input type="number" min={0} max={1000} value={s.count} onChange={e => setSize(p, { count: num(e.target.value) })} className="kz-input !w-14 !py-0.5 !text-xs text-center" aria-label={`${p.name} nodes`} />
                                                <button type="button" onClick={() => setSize(p, { count: s.count + 1 })} className="kz-btn-ghost !p-1" aria-label="One node more"><Plus className="w-3 h-3" /></button>
                                                {p.perZone && <span className="text-slate-500">per zone</span>}
                                            </span>
                                        )}
                                    </td>
                                    <td className="text-right whitespace-nowrap">
                                        {mayScale && changed && <><button type="button" disabled={!!busy || p.busy} onClick={() => scale(p)} className="kz-btn-primary !py-1 !text-[11px]">{busy === `scale:${p.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Apply</button><button type="button" onClick={() => setSizes(x => { const { [p.id]: _, ...rest } = x; return rest })} className="kz-btn-ghost !py-1 !text-[11px] ml-1">Undo</button></>}
                                        {mayUpgrade && !changed && p.upgradeTo && <button type="button" disabled={!!busy || p.busy || o.busy} onClick={() => upgradePool(p)} className="kz-btn-ghost !py-1 !text-[11px]">{busy === `up:${p.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUpCircle className="w-3 h-3" />} {p.upgradeTo === 'recycle' ? 'Recycle nodes' : `Upgrade to ${p.upgradeTo}`}</button>}
                                    </td>
                                </tr>
                            )
                        })}
                        {!o.pools.length && <tr><td colSpan={7} className="py-3 text-slate-500">No node pools (Fargate / Autopilot / self-managed nodes are not listed here).</td></tr>}
                    </tbody>
                </table>
            </div>
            {o.notes?.length > 0 && <ul className="space-y-1 text-[11px] text-slate-500">{o.notes.map(n => <li key={n} className="flex items-start gap-1.5"><Info className="w-3 h-3 mt-0.5 shrink-0" />{n}</li>)}</ul>}
            <p className="text-[11px] text-slate-600">Checked {ago(o.checkedAt)}. Every change is in the audit log{mayUpgrade ? '; upgrades need a second admin when the two-person rule is on' : ''}.</p>
        </div>
    )
}
