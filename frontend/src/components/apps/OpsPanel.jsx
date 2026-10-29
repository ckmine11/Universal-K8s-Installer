import { useState, useEffect, useCallback } from 'react'
import { Moon, Sun, Bug, Loader2, Copy } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useToast } from '../ToastProvider'

// Day-2 operations of a cluster: Hibernate / Wake a namespace (workloads to 0
// and back, e.g. dev at night) and a debug container in a running pod.
const json = async (res) => { const d = await res.json().catch(() => ({})); if (!res.ok) throw Object.assign(new Error(d.error || `Request failed (${res.status})`), { status: res.status }); return d }

export default function OpsPanel({ clusterId }) {
    const { user } = useAuth()
    const { toast } = useToast()
    const isAdmin = ['admin', 'superadmin'].includes(user?.role)
    const canHibernate = can(user?.role, 'hibernate:manage', clusterId)
    const canDebug = can(user?.role, 'debug:ephemeral', clusterId) && can(user?.role, 'terminal:access', clusterId)
    const [sleeping, setSleeping] = useState(null)
    const [ns, setNs] = useState('')
    const [busy, setBusy] = useState(null)
    const [dbg, setDbg] = useState({ namespace: '', pod: '', target: '', image: 'busybox' })
    const [dbgOut, setDbgOut] = useState(null)

    const load = useCallback(() => apiFetch(`/api/clusters/${clusterId}/hibernate`).then(json).then(d => setSleeping(d.namespaces)).catch(() => setSleeping([])), [clusterId])
    useEffect(() => { load() }, [load])

    // a change freeze: an admin may go ahead with a reason
    const post = async (url, body) => {
        let res = await apiFetch(url, { method: 'POST', body: JSON.stringify(body) })
        if (res.status === 423 && isAdmin) {
            const d = await res.json().catch(() => ({}))
            const why = window.prompt(`${d.error}\n\nOverride as admin — why?`)
            if (!why) throw new Error('Not done — change freeze')
            res = await apiFetch(url, { method: 'POST', body: JSON.stringify({ ...body, overrideFreeze: why }) })
        }
        return json(res)
    }
    const act = async (kind, namespace) => {
        if (kind === 'hibernate' && !window.confirm(`Scale every Deployment and StatefulSet in ${namespace} to 0? Wake brings them back.`)) return
        setBusy(`${kind}:${namespace}`)
        try { const d = await post(`/api/clusters/${clusterId}/${kind}`, { namespace }); toast({ title: kind === 'hibernate' ? 'Hibernated' : 'Awake', message: d.message, type: 'success' }); setNs(''); load() }
        catch (e) { toast({ title: 'Not done', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }
    const debug = async () => {
        setBusy('debug'); setDbgOut(null)
        try { setDbgOut(await post(`/api/clusters/${clusterId}/debug`, { ...dbg, target: dbg.target || undefined })) }
        catch (e) { toast({ title: 'No debug container', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }
    if (!canHibernate && !canDebug && !sleeping?.length) return null

    return (
        <div className="grid lg:grid-cols-2 gap-4">
            <div className="kz-card p-5 space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Moon className="w-4 h-4 text-blue-300" /> Hibernate</h3>
                <p className="text-[11px] text-slate-400">Scale a namespace's Deployments and StatefulSets to 0 (dev and test at night, a paused project) — each remembers its replicas for Wake.</p>
                {sleeping === null ? <Loader2 className="w-4 h-4 animate-spin text-blue-400" /> : sleeping.length > 0 && (
                    <ul className="space-y-1.5">{sleeping.map(s => (
                        <li key={s.namespace} className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 text-xs">
                            <Moon className="w-3.5 h-3.5 text-slate-400" /><span className="font-semibold text-white">{s.namespace}</span><span className="text-slate-500">{s.workloads} workload{s.workloads === 1 ? '' : 's'}, {s.replicas} replica{s.replicas === 1 ? '' : 's'} asleep</span>
                            {canHibernate && <button onClick={() => act('wake', s.namespace)} disabled={!!busy} className="ml-auto kz-btn-ghost !py-1 !px-2 !text-[11px]">{busy === `wake:${s.namespace}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sun className="w-3 h-3" />} Wake</button>}
                        </li>
                    ))}</ul>
                )}
                {canHibernate && (
                    <div className="flex gap-2">
                        <input className="kz-input !text-xs" placeholder="namespace" value={ns} onChange={e => setNs(e.target.value)} aria-label="Namespace to hibernate" />
                        <button onClick={() => act('hibernate', ns)} disabled={!ns || !!busy} className="kz-btn-primary !py-1.5 !text-xs">{busy?.startsWith('hibernate') ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Moon className="w-3.5 h-3.5" />} Hibernate</button>
                    </div>
                )}
            </div>
            {canDebug && (
                <div className="kz-card p-5 space-y-3">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-white"><Bug className="w-4 h-4 text-blue-300" /> Debug a pod</h3>
                    <p className="text-[11px] text-slate-400">Adds a debug container with a shell and network tools to a running pod — for images without them. It ends by itself after an hour; the pod is not restarted.</p>
                    <div className="grid grid-cols-2 gap-2">
                        <input className="kz-input !text-xs" placeholder="namespace" value={dbg.namespace} onChange={e => setDbg(d => ({ ...d, namespace: e.target.value }))} aria-label="Namespace" />
                        <input className="kz-input !text-xs" placeholder="pod" value={dbg.pod} onChange={e => setDbg(d => ({ ...d, pod: e.target.value }))} aria-label="Pod" />
                        <input className="kz-input !text-xs" placeholder="container to look into (optional)" value={dbg.target} onChange={e => setDbg(d => ({ ...d, target: e.target.value }))} aria-label="Target container" />
                        <select className="kz-input !text-xs" value={dbg.image} onChange={e => setDbg(d => ({ ...d, image: e.target.value }))} aria-label="Debug image"><option value="busybox">busybox (shell, small)</option><option value="netshoot">netshoot (curl, dig, tcpdump…)</option></select>
                    </div>
                    <button onClick={debug} disabled={!dbg.namespace || !dbg.pod || busy === 'debug'} className="kz-btn-primary !py-1.5 !text-xs">{busy === 'debug' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bug className="w-3.5 h-3.5" />} Add debug container</button>
                    {dbgOut && (
                        <div className="rounded-lg border border-emerald-400/20 bg-emerald-500/[0.05] p-2.5 text-[11px] space-y-1.5">
                            <p className="text-emerald-100">{dbgOut.message} Open it from the cluster terminal:</p>
                            <div className="flex items-center gap-2"><code className="flex-1 font-mono text-slate-200 break-all">{dbgOut.command}</code><button onClick={() => navigator.clipboard?.writeText(dbgOut.command)} aria-label="Copy command"><Copy className="w-3.5 h-3.5 text-slate-400" /></button></div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
