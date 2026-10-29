import { useState, useEffect, useCallback } from 'react'
import { KeyRound, Loader2, RefreshCw, CheckCircle2, XCircle } from 'lucide-react'
import { apiFetch, useAuth } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useToast } from '../ToastProvider'

// External Secrets sync status: each ExternalSecret (store → target Secret,
// last sync, why it fails) and the stores. Names and status only.
export default function ExternalSecretsCard({ clusterId }) {
    const { user } = useAuth()
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [busy, setBusy] = useState(null)
    const canSync = can(user?.role, 'app:deploy', clusterId)
    const load = useCallback(() => apiFetch(`/api/clusters/${clusterId}/external-secrets`).then(r => r.json().then(d => r.ok ? d : { error: d.error })).then(setData).catch(e => setData({ error: e.message })), [clusterId])
    useEffect(() => { load() }, [load])
    const sync = async (e) => {
        setBusy(`${e.namespace}/${e.name}`)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/external-secrets/refresh`, { method: 'POST', body: JSON.stringify({ namespace: e.namespace, name: e.name }) })
            const d = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(d.error || 'Not synced')
            toast({ title: 'Syncing', message: d.message, type: 'success' }); setTimeout(load, 3000)
        } catch (err) { toast({ title: 'Not synced', message: err.message, type: 'error' }) } finally { setBusy(null) }
    }
    // nothing to show on a cluster without the operator
    if (data && !data.error && !data.installed) return null
    return (
        <div className="kz-card p-5 space-y-3">
            <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-blue-300" /><h3 className="text-sm font-semibold text-white flex-1">External Secrets</h3>
                <button onClick={load} className="kz-btn-ghost !py-1 !px-2 !text-[11px]" aria-label="Read again"><RefreshCw className="w-3 h-3" /></button>
            </div>
            {!data && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
            {data?.error && <p className="text-xs text-amber-200">{data.error}</p>}
            {data?.stores?.length > 0 && <p className="text-[11px] text-slate-400">Stores: {data.stores.map(s => <span key={`${s.kind}/${s.name}`} className={s.ready ? 'text-emerald-300' : 'text-red-300'} title={s.message || ''}>{s.name} ({s.provider}{s.ready ? '' : ', not ready'}) </span>)}</p>}
            {data?.externalSecrets && (data.externalSecrets.length ? (
                <ul className="space-y-1.5">{data.externalSecrets.map(e => (
                    <li key={`${e.namespace}/${e.name}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 text-[11px]">
                        {e.ready ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" /> : <XCircle className="w-3.5 h-3.5 text-red-300" />}
                        <span className="font-semibold text-white">{e.namespace}/{e.name}</span>
                        <span className="text-slate-400">{e.store || '—'} → Secret {e.target} · every {e.refreshInterval}{e.lastSync ? ` · synced ${new Date(e.lastSync).toLocaleString()}` : ''}</span>
                        {canSync && <button onClick={() => sync(e)} disabled={!!busy} className="ml-auto kz-btn-ghost !py-0.5 !px-1.5 !text-[10px]">{busy === `${e.namespace}/${e.name}` ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Sync now'}</button>}
                        {e.message && <span className="w-full text-red-300/90 break-words">{e.message}</span>}
                    </li>
                ))}</ul>
            ) : <p className="text-xs text-slate-500">No ExternalSecrets yet.</p>)}
        </div>
    )
}
