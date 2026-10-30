import { useState, useEffect, useCallback } from 'react'
import { GitMerge, Zap, Loader2, Lock, Plus, Trash2, X } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useToast } from '../ToastProvider'

// Canary / blue-green rollouts (Argo Rollouts) and autoscaling (KEDA) of a
// cluster. Hidden when neither add-on is installed. The server checks every
// permission, protected environments and freezes.
const json = async (res) => { const d = await res.json().catch(() => ({})); if (!res.ok) throw Object.assign(new Error(d.error || `Request failed (${res.status})`), { status: res.status, data: d }); return d }
const PHASE = { Healthy: 'text-emerald-300', Progressing: 'text-blue-300', Paused: 'text-amber-200', Degraded: 'text-red-300' }

function Rollouts({ clusterId, isAdmin, canAct }) {
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [busy, setBusy] = useState(null)
    const load = useCallback(() => apiFetch(`/api/clusters/${clusterId}/rollouts`).then(json).then(setData).catch(e => setData({ error: e.message })), [clusterId])
    useEffect(() => { load() }, [load])
    const act = async (r, action, overrideFreeze) => {
        if (action === 'abort' && !window.confirm(`Abort ${r.namespace}/${r.name}? Traffic goes back to the stable version.`)) return
        setBusy(`${r.namespace}/${r.name}`)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/rollouts/action`, { method: 'POST', body: JSON.stringify({ namespace: r.namespace, name: r.name, action, ...(overrideFreeze ? { overrideFreeze } : {}) }) })
            if (res.status === 423 && isAdmin && !overrideFreeze) { const d = await res.json().catch(() => ({})); const why = window.prompt(`${d.error}\n\nOverride as admin — why?`); setBusy(null); return why ? act(r, action, why) : undefined }
            const d = await json(res)
            toast({ title: 'Done', message: d.message, type: 'success' }); setTimeout(load, 2000)
        } catch (e) { toast({ title: 'Not done', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }
    if (!data || (!data.error && !data.installed)) return null
    return (
        <div className="kz-card p-5 space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><GitMerge className="w-4 h-4 text-blue-300" /> Rollouts (canary / blue-green)</h3>
            {data.error && <p className="text-xs text-amber-200">{data.error}</p>}
            {data.rollouts?.length ? <ul className="space-y-2">{data.rollouts.map(r => {
                const key = `${r.namespace}/${r.name}`
                return (
                    <li key={key} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-semibold text-white">{r.name}</span><span className="text-slate-500">{r.namespace} · {r.strategy}</span>
                            {r.protected && <span className="flex items-center gap-0.5 text-amber-200"><Lock className="w-3 h-3" />protected</span>}
                            <span className={`font-semibold ${PHASE[r.phase] || 'text-slate-300'}`}>{r.aborted ? 'Aborted' : r.phase}</span>
                            {r.step && <span className="text-slate-400">step {Math.min((r.step.index ?? r.step.total), r.step.total)}/{r.step.total}</span>}
                            {r.weight != null && <span className="text-slate-400">· new version gets {r.weight}% of traffic</span>}
                            <span className="text-slate-500">· {r.replicas.ready}/{r.replicas.desired ?? '?'} ready</span>
                        </div>
                        {r.strategy === 'canary' && r.weight != null && (
                            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden" role="img" aria-label={`${r.weight}% of traffic on the new version`}>
                                <div className="h-full rounded-full bg-blue-400" style={{ width: `${r.weight}%` }} />
                            </div>
                        )}
                        <p className="text-[11px] text-slate-500 font-mono break-all">{r.images.join(', ')}{r.pauseReasons.length ? ` · paused: ${r.pauseReasons.join(', ')}` : ''}</p>
                        {r.message && <p className="text-[11px] text-red-300/90 break-words">{r.message}</p>}
                        {canAct && (
                            <div className="flex flex-wrap gap-1.5">
                                {busy === key && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />}
                                {r.paused && !r.aborted && <button onClick={() => act(r, 'promote')} disabled={!!busy} className="kz-btn-primary !py-1 !px-2 !text-[11px]">Promote</button>}
                                {r.phase !== 'Healthy' && !r.aborted && <button onClick={() => act(r, 'promote-full')} disabled={!!busy} className="kz-btn-ghost !py-1 !px-2 !text-[11px]">Promote fully</button>}
                                {r.phase !== 'Healthy' && !r.aborted && <button onClick={() => act(r, 'abort')} disabled={!!busy} className="kz-btn-ghost !py-1 !px-2 !text-[11px] text-red-300">Abort</button>}
                                {r.aborted && <button onClick={() => act(r, 'retry')} disabled={!!busy} className="kz-btn-ghost !py-1 !px-2 !text-[11px]">Retry</button>}
                            </div>
                        )}
                    </li>
                )
            })}</ul> : !data.error && <p className="text-xs text-slate-500">No rollouts yet — a Rollout replaces a Deployment to release step by step.</p>}
        </div>
    )
}

const TRIGGER_DEFAULT = { cron: { type: 'cron', timezone: 'Asia/Kolkata', start: '0 9 * * 1-5', end: '0 19 * * 1-5', desiredReplicas: 3 }, cpu: { type: 'cpu', value: 70 }, memory: { type: 'memory', value: 80 }, prometheus: { type: 'prometheus', serverAddress: 'http://prometheus-operated.monitoring.svc:9090', query: '', threshold: 100 } }

function Autoscale({ clusterId, canManage }) {
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [open, setOpen] = useState(false)
    const [f, setF] = useState({ namespace: '', kind: 'Deployment', name: '', min: 1, max: 5, triggers: [TRIGGER_DEFAULT.cpu] })
    const [busy, setBusy] = useState(false)
    const load = useCallback(() => apiFetch(`/api/clusters/${clusterId}/autoscale`).then(json).then(setData).catch(e => setData({ error: e.message })), [clusterId])
    useEffect(() => { load() }, [load])
    const setT = (i, k, v) => setF(x => ({ ...x, triggers: x.triggers.map((t, j) => j === i ? { ...t, [k]: v } : t) }))
    const save = async () => {
        setBusy(true)
        try {
            const d = await json(await apiFetch(`/api/clusters/${clusterId}/autoscale`, { method: 'POST', body: JSON.stringify({ namespace: f.namespace, target: { kind: f.kind, name: f.name }, min: Number(f.min), max: Number(f.max), triggers: f.triggers }) }))
            toast({ title: 'Autoscaling on', message: d.message, type: 'success' }); setOpen(false); load()
        } catch (e) { toast({ title: 'Not saved', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }
    const remove = async (s) => {
        if (!window.confirm(`Remove ${s.namespace}/${s.name}? The workload keeps its current replicas.`)) return
        try { const d = await json(await apiFetch(`/api/clusters/${clusterId}/autoscale/${s.namespace}/${s.name}`, { method: 'DELETE' })); toast({ title: 'Removed', message: d.message, type: 'success' }); load() }
        catch (e) { toast({ title: 'Not removed', message: e.message, type: 'error' }) }
    }
    if (!data || (!data.error && !data.installed)) return null
    return (
        <div className="kz-card p-5 space-y-3">
            <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-blue-300" /><h3 className="flex-1 text-sm font-semibold text-white">Autoscaling (KEDA)</h3>
                {canManage && !open && <button onClick={() => setOpen(true)} className="kz-btn-primary !py-1 !px-2 !text-[11px]"><Plus className="w-3 h-3" /> Scale a workload</button>}
            </div>
            {data.error && <p className="text-xs text-amber-200">{data.error}</p>}
            {data.scaledObjects?.length > 0 && <ul className="space-y-1.5">{data.scaledObjects.map(s => (
                <li key={`${s.namespace}/${s.name}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 text-[11px]">
                    <span className="font-semibold text-white">{s.namespace}/{s.target}</span>
                    <span className="text-slate-400">{s.min}–{s.max} replicas on {s.triggers.join(', ')}</span>
                    <span className={s.ready ? 'text-emerald-300' : 'text-red-300'}>{s.ready ? (s.active ? 'scaling (active)' : 'ready') : 'not ready'}</span>
                    {canManage && s.managed && <button onClick={() => remove(s)} className="ml-auto kz-btn-ghost !py-0.5 !px-1.5 !text-[10px] text-red-300" aria-label={`Remove ${s.name}`}><Trash2 className="w-3 h-3" /></button>}
                    {s.message && <span className="w-full text-red-300/90">{s.message}</span>}
                </li>
            ))}</ul>}
            {open && (
                <div className="rounded-xl border border-blue-400/20 bg-blue-500/[0.04] p-3 space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        <input className="kz-input !text-xs" placeholder="namespace" value={f.namespace} onChange={e => setF(x => ({ ...x, namespace: e.target.value }))} aria-label="Namespace" />
                        <select className="kz-input !text-xs" value={f.kind} onChange={e => setF(x => ({ ...x, kind: e.target.value }))} aria-label="Kind"><option>Deployment</option><option>StatefulSet</option></select>
                        <input className="kz-input !text-xs" placeholder="workload" value={f.name} onChange={e => setF(x => ({ ...x, name: e.target.value }))} aria-label="Workload" />
                        <input className="kz-input !text-xs" type="number" min="0" max="100" value={f.min} onChange={e => setF(x => ({ ...x, min: e.target.value }))} aria-label="Min replicas" title="min replicas (0 = scale to zero)" />
                        <input className="kz-input !text-xs" type="number" min="1" max="100" value={f.max} onChange={e => setF(x => ({ ...x, max: e.target.value }))} aria-label="Max replicas" title="max replicas" />
                    </div>
                    {f.triggers.map((t, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                            <select className="kz-input !w-32 !text-xs" value={t.type} onChange={e => setF(x => ({ ...x, triggers: x.triggers.map((y, j) => j === i ? TRIGGER_DEFAULT[e.target.value] : y) }))} aria-label="Trigger"><option value="cron">Schedule</option><option value="cpu">CPU %</option><option value="memory">Memory %</option><option value="prometheus">Prometheus</option></select>
                            {t.type === 'cron' && <>
                                <input className="kz-input !w-36 !text-xs" value={t.start} onChange={e => setT(i, 'start', e.target.value)} aria-label="Start (cron)" title="start, cron" />
                                <input className="kz-input !w-36 !text-xs" value={t.end} onChange={e => setT(i, 'end', e.target.value)} aria-label="End (cron)" title="end, cron" />
                                <input className="kz-input !w-32 !text-xs" value={t.timezone} onChange={e => setT(i, 'timezone', e.target.value)} aria-label="Time zone" />
                                <input className="kz-input !w-20 !text-xs" type="number" value={t.desiredReplicas} onChange={e => setT(i, 'desiredReplicas', Number(e.target.value))} aria-label="Replicas during the schedule" title="replicas during the schedule" />
                            </>}
                            {(t.type === 'cpu' || t.type === 'memory') && <><input className="kz-input !w-20 !text-xs" type="number" value={t.value} onChange={e => setT(i, 'value', Number(e.target.value))} aria-label="Target %" /><span className="text-[11px] text-slate-400">% of requests (needs min ≥ 1)</span></>}
                            {t.type === 'prometheus' && <>
                                <input className="kz-input !w-64 !text-xs" value={t.serverAddress} onChange={e => setT(i, 'serverAddress', e.target.value)} aria-label="Prometheus address" />
                                <input className="kz-input !w-72 !text-xs font-mono" placeholder="sum(rate(http_requests_total[1m]))" value={t.query} onChange={e => setT(i, 'query', e.target.value)} aria-label="Query" />
                                <input className="kz-input !w-24 !text-xs" type="number" value={t.threshold} onChange={e => setT(i, 'threshold', Number(e.target.value))} aria-label="Threshold per replica" title="value per replica" />
                            </>}
                            {f.triggers.length > 1 && <button onClick={() => setF(x => ({ ...x, triggers: x.triggers.filter((_, j) => j !== i) }))} aria-label="Remove trigger"><X className="w-3.5 h-3.5 text-slate-400" /></button>}
                        </div>
                    ))}
                    <div className="flex gap-2">
                        {f.triggers.length < 5 && <button onClick={() => setF(x => ({ ...x, triggers: [...x.triggers, TRIGGER_DEFAULT.cron] }))} className="kz-btn-ghost !py-1 !px-2 !text-[11px]"><Plus className="w-3 h-3" /> Trigger</button>}
                        <span className="flex-1" />
                        <button onClick={() => setOpen(false)} className="kz-btn-ghost !py-1 !px-2 !text-[11px]">Cancel</button>
                        <button onClick={save} disabled={busy || !f.namespace || !f.name} className="kz-btn-primary !py-1 !px-2 !text-[11px]">{busy && <Loader2 className="w-3 h-3 animate-spin" />} Save</button>
                    </div>
                </div>
            )}
        </div>
    )
}

export default function ProgressivePanel({ clusterId }) {
    const { user } = useAuth()
    const isAdmin = ['admin', 'superadmin'].includes(user?.role)
    return (
        <div className="grid lg:grid-cols-2 gap-4 items-start">
            <Rollouts clusterId={clusterId} isAdmin={isAdmin} canAct={can(user?.role, 'app:deploy', clusterId)} />
            <Autoscale clusterId={clusterId} canManage={can(user?.role, 'autoscale:manage', clusterId)} />
        </div>
    )
}
