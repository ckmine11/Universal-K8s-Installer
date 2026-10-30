import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ToggleLeft, Loader2, AlertTriangle, Server } from 'lucide-react'
import { apiFetch } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import PageHeader from '../components/ui/PageHeader'
import { setFeatures } from '../config/features'

// Feature flags: a workspace admin turns features on / off for the workspace;
// the Super Admin decides what the server offers at all (or follows the
// KUBEEZ_FEATURES / KUBEEZ_FEATURES_DEFAULT environment variables).
const json = async (res) => { const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`); return d }

export default function Features() {
    const { toast } = useToast()
    const [data, setData] = useState(null)
    const [platform, setPlatform] = useState(null)
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(null)
    const load = useCallback(async () => {
        try {
            const d = await json(await apiFetch('/api/features'))
            setData(d); setFeatures(d.enabled); setError(null)
            if (d.canManagePlatform) setPlatform((await json(await apiFetch('/api/features/platform'))).features)
        } catch (e) { setError(e.message) }
    }, [])
    useEffect(() => { load() }, [load])
    const put = async (url, body, ok) => {
        setBusy(Object.keys(body)[0])
        try { await json(await apiFetch(url, { method: 'PUT', body: JSON.stringify(body) })); toast({ title: ok, type: 'success' }); await load() }
        catch (e) { toast({ title: 'Not changed', message: e.message, type: 'error' }) } finally { setBusy(null) }
    }
    const groups = (data?.features || []).reduce((m, f) => { (m[f.group] ||= []).push(f); return m }, {})
    const plat = Object.fromEntries((platform || []).map(p => [p.key, p]))

    return (
        <div className="max-w-4xl mx-auto space-y-5">
            <PageHeader eyebrow="Workspace" title="Features" icon={ToggleLeft} description="Switch the newer features on step by step. A feature works only when this server offers it and your workspace has it on." />
            {error && <p className="flex items-center gap-1.5 text-sm text-red-300"><AlertTriangle className="w-4 h-4" />{error}</p>}
            {!data && !error && <Loader2 className="w-5 h-5 animate-spin text-blue-400" />}
            {Object.entries(groups).map(([group, list]) => (
                <section key={group} className="kz-card p-5 space-y-2">
                    <h2 className="text-sm font-semibold text-white">{group}</h2>
                    <ul className="divide-y divide-white/[0.06]">{list.map(f => (
                        <li key={f.key} className="flex flex-wrap items-center gap-3 py-2.5">
                            <div className="flex-1 min-w-[220px]">
                                <p className="text-sm text-white">{f.label}
                                    {f.plan !== 'free' && <span className={`ml-2 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${f.plan === 'enterprise' ? 'border-violet-400/30 text-violet-300' : 'border-amber-400/30 text-amber-200'}`}>{f.plan === 'enterprise' ? 'Enterprise' : 'Pro'}</span>}
                                    {f.background && <span className="ml-2 text-[10px] text-slate-500">runs in the background</span>}</p>
                                <p className="text-[11px] text-slate-400">{f.description}</p>
                                {!f.included && <p className="text-[11px] text-amber-200">Not in your plan ({String(data.plan || 'FREE').toLowerCase()}) — <Link to="/pricing" className="underline">upgrade to use it</Link>.</p>}
                                {!f.available && <p className="flex items-center gap-1 text-[11px] text-amber-200"><Server className="w-3 h-3" />Not offered on this server</p>}
                            </div>
                            {platform && (
                                <select className="kz-input !w-auto !py-1 !text-[11px]" aria-label={`${f.label} on the server`} value={plat[f.key]?.saved === null || plat[f.key]?.saved === undefined ? 'default' : plat[f.key].saved ? 'on' : 'off'}
                                    onChange={e => put('/api/features/platform', { [f.key]: e.target.value === 'default' ? null : e.target.value === 'on' }, 'Server setting saved')}>
                                    <option value="default">Server: from environment ({plat[f.key]?.available ? 'on' : 'off'})</option><option value="on">Server: on</option><option value="off">Server: off</option>
                                </select>
                            )}
                            <label className={`flex items-center gap-2 text-xs ${data.canManage && f.available ? 'text-slate-200' : 'text-slate-500'}`}>
                                {busy === f.key && <Loader2 className="w-3 h-3 animate-spin" />}
                                <input type="checkbox" role="switch" checked={f.on} disabled={!data.canManage || !f.available || !!busy}
                                    onChange={e => put('/api/features', { [f.key]: e.target.checked }, e.target.checked ? `${f.label} on` : `${f.label} off`)} aria-label={`${f.label} for this workspace`} />
                                {f.on ? 'On' : 'Off'}
                            </label>
                        </li>
                    ))}</ul>
                </section>
            ))}
            {data && !data.canManage && <p className="text-xs text-slate-500">Only an admin of the workspace changes these.</p>}
        </div>
    )
}
