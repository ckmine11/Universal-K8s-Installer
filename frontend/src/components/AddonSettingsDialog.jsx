import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { apiFetch } from '../context/AuthContext'
import { X, Loader2, Settings2, FileCode2, History, Eye, CheckCircle2, XCircle, Lock, Sparkles, AlertTriangle, Play } from 'lucide-react'

// Settings of a Helm add-on: simple form (everyone), advanced Helm values
// (Pro), version, a preview of what changes, then Apply = a job with live logs.
// Helm rolls the add-on back by itself if the new settings do not work.

const inputCls = 'w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500/50'

function Field({ f, value, onChange }) {
    const id = `f-${f.key}`
    if (f.type === 'bool') {
        return (
            <label className="flex items-start gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5 cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={!!value} onChange={e => onChange(e.target.checked)} />
                <span className="min-w-0"><span className="block text-sm text-slate-200">{f.label}</span>{f.help && <span className="block text-[11px] text-slate-500 mt-0.5">{f.help}</span>}</span>
            </label>
        )
    }
    return (
        <div>
            <label htmlFor={id} className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1">{f.label}{f.unit ? ` (${f.unit})` : ''}</label>
            {f.type === 'select' ? (
                <select id={id} className={inputCls} value={String(value ?? '')} onChange={e => onChange(e.target.value)}>
                    {f.options.map(([v, l]) => <option key={v} value={v} className="bg-slate-950">{l}</option>)}
                </select>
            ) : (
                <input id={id} className={inputCls} type={f.type === 'number' ? 'number' : 'text'} min={f.min} max={f.max} placeholder={f.placeholder || ''}
                    value={value ?? ''} onChange={e => onChange(f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
            )}
            {f.help && <p className="mt-1 text-[11px] text-slate-500">{f.help}</p>}
        </div>
    )
}

export default function AddonSettingsDialog({ clusterId, addonKey, installed, onClose, onStarted }) {
    const [data, setData] = useState(null)
    const [error, setError] = useState(null)
    const [tab, setTab] = useState('settings')
    const [settings, setSettings] = useState({})
    const [advanced, setAdvanced] = useState('')
    const [version, setVersion] = useState('')
    const [preview, setPreview] = useState(null)
    const [busy, setBusy] = useState(null)
    const [msg, setMsg] = useState(null)

    useEffect(() => {
        (async () => {
            try {
                const r = await apiFetch(`/api/clusters/${clusterId}/addons/${addonKey}/settings`)
                const j = await r.json()
                if (!r.ok) throw new Error(j.error || 'Could not load the settings')
                setData(j)
                const cur = j.applied || j.lastSettings
                setSettings({ ...j.schema.defaults, ...(cur?.settings || {}) })
                setAdvanced(cur?.advanced || '')
                setVersion(cur?.version || j.schema.versions[0].id)
            } catch (e) { setError(e.message) }
        })()
    }, [clusterId, addonKey])

    // editing makes an old preview stale
    useEffect(() => { setPreview(null) }, [JSON.stringify(settings), advanced, version])

    const body = () => ({ settings, advanced, version })
    const doPreview = async () => {
        setBusy('preview'); setMsg(null)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/addons/${addonKey}/preview`, { method: 'POST', body: JSON.stringify(body()) })
            const j = await r.json()
            if (!r.ok) throw Object.assign(new Error(j.error || 'Not valid'), { upgrade: j.upgrade })
            setPreview(j)
        } catch (e) { setMsg({ ok: false, text: e.message, upgrade: e.upgrade }) } finally { setBusy(null) }
    }
    const apply = async () => {
        setBusy('apply'); setMsg(null)
        try {
            const r = await apiFetch(`/api/clusters/${clusterId}/addons/${addonKey}/settings`, { method: 'POST', body: JSON.stringify(body()) })
            const j = await r.json()
            if (!r.ok) throw Object.assign(new Error(j.error || 'Could not start'), { upgrade: j.upgrade || j.limitExceeded })
            onStarted(j.newInstallationId)
        } catch (e) { setMsg({ ok: false, text: e.message, upgrade: e.upgrade }) } finally { setBusy(null) }
    }

    const s = data?.schema
    const visible = (f) => !f.showIf || Object.entries(f.showIf).every(([k, v]) => settings[k] === v)
    const fields = s?.fields.filter(visible) || []
    const groups = [...new Set(fields.map(f => f.group || ''))]
    const tabBtn = (k, label, Icon, locked) => (
        <button onClick={() => setTab(k)} className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold ${tab === k ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
            <Icon className="w-3.5 h-3.5" /> {label}{locked && <Lock className="w-3 h-3 text-amber-300" />}
        </button>
    )

    return createPortal(
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <div className="glass w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-white/10" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${s?.label || 'Add-on'} settings`}>
                <div className="flex items-start gap-3 p-5 border-b border-white/5">
                    <Settings2 className="w-5 h-5 text-sky-400 mt-0.5" />
                    <div className="min-w-0 flex-1">
                        <h3 className="text-white font-black">{s ? `${installed ? '' : 'Install '}${s.label}` : 'Add-on'}{installed ? ' — settings' : ''}</h3>
                        {s && <p className="text-xs text-slate-400 mt-0.5">{s.summary}</p>}
                    </div>
                    <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400"><X className="w-4 h-4" /></button>
                </div>

                {!data && !error && <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-sky-400" /></div>}
                {error && <p className="p-5 text-sm text-red-300">{error}</p>}

                {data && (<>
                    <div className="flex flex-wrap items-center gap-1 px-5 pt-3">
                        {tabBtn('settings', 'Settings', Settings2)}
                        {tabBtn('advanced', 'Advanced (YAML)', FileCode2, !data.advancedAllowed)}
                        {tabBtn('history', `History${data.history.length ? ` (${data.history.length})` : ''}`, History)}
                        <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
                            Version
                            <select aria-label="Version" value={version} onChange={e => setVersion(e.target.value)} className="bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-200">
                                {s.versions.map(v => <option key={v.id} value={v.id} className="bg-slate-950">{v.id} (app {v.app}){v.recommended ? ' — recommended' : ''}</option>)}
                            </select>
                        </div>
                    </div>
                    {data.updateAvailable && version !== s.versions[0].id && (
                        <p className="mx-5 mt-2 flex items-center gap-1.5 text-[11px] text-sky-300"><Sparkles className="w-3.5 h-3.5" /> Version {s.versions[0].id} is available — choose it above and Apply to update (rolled back automatically if it fails).</p>
                    )}

                    <div className="flex-1 overflow-y-auto p-5 space-y-3">
                        {tab === 'settings' && groups.map(g => (
                            <div key={g || 'main'} className="space-y-3">
                                {g && <p className="pt-1 text-[10px] font-black uppercase tracking-wider text-slate-500">{g}</p>}
                                {fields.filter(f => (f.group || '') === g).map(f => <Field key={f.key} f={f} value={settings[f.key]} onChange={v => setSettings(x => ({ ...x, [f.key]: v }))} />)}
                            </div>
                        ))}

                        {tab === 'advanced' && (data.advancedAllowed ? (
                            <div>
                                <p className="text-[11px] text-slate-400 mb-2">
                                    Helm values, merged over the settings form{s.releases.length > 1 ? <> — one block per release: <code className="text-slate-200">{s.releases.join(':')}:</code></> : ''}. A few keys KubeEZ needs to find and repair the add-on cannot be changed; the preview lists them if you set one.
                                </p>
                                <textarea aria-label="Advanced values" spellCheck={false} value={advanced} onChange={e => setAdvanced(e.target.value)} rows={14}
                                    placeholder={s.releases.length > 1 ? `${s.releases[0]}:\n  # values of the ${s.releases[0]} chart\n${s.releases[1]}:\n  # …` : '# e.g.\n# podLabels:\n#   team: ops'}
                                    className={`${inputCls} font-mono text-xs leading-relaxed`} />
                            </div>
                        ) : (
                            <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.05] p-4 text-sm text-slate-300">
                                <p className="flex items-center gap-2 font-semibold text-white"><Lock className="w-4 h-4 text-amber-300" /> Advanced Helm values are part of Pro</p>
                                <p className="mt-1 text-xs text-slate-400">Every Helm value of the chart, with a preview of the change and automatic rollback. The settings form works on every plan.</p>
                                <Link to="/pricing" className="inline-flex mt-3 kz-btn-primary !py-2 !text-xs">See Pro</Link>
                            </div>
                        ))}

                        {tab === 'history' && (data.history.length ? (
                            <div className="space-y-1.5">
                                {data.history.map((h, i) => (
                                    <div key={i} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px]">
                                        <div className="flex items-center gap-2">
                                            {h.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <XCircle className="w-3.5 h-3.5 text-red-400" />}
                                            <span className="text-slate-200">{h.ok ? 'Applied' : 'Failed — rolled back'}</span>
                                            <span className="text-slate-500">· {h.version}{h.advanced ? ' · advanced values' : ''} · {h.by} · {new Date(h.at).toLocaleString()}</span>
                                        </div>
                                        <p className="mt-1 font-mono text-slate-400 break-all">{Object.entries(h.settings || {}).map(([k, v]) => `${k}=${v}`).join('  ')}</p>
                                        {h.error && <p className="mt-1 text-red-300/90 break-all">{h.error}</p>}
                                    </div>
                                ))}
                            </div>
                        ) : <p className="text-xs text-slate-500">No changes yet.</p>)}

                        {preview && (
                            <div className="rounded-xl border border-white/8 bg-black/30">
                                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 text-[11px]">
                                    <span className="font-bold text-slate-300">{installed ? (preview.changed ? 'What changes' : 'Nothing changes') : 'Values that will be installed'}</span>
                                    <span className="text-slate-500">Helm values · {preview.version}</span>
                                </div>
                                {preview.ignored?.length > 0 && <p className="px-3 pt-2 text-[11px] text-amber-300 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" /> Kept by KubeEZ (your value ignored): {preview.ignored.join(', ')}</p>}
                                <pre className="max-h-64 overflow-auto p-3 text-[11px] font-mono leading-relaxed">
                                    {(installed ? preview.diff : preview.diff.map(d => ({ ...d, t: ' ' }))).map((d, i) => (
                                        <div key={i} className={d.t === '+' ? 'text-emerald-300 bg-emerald-500/10' : d.t === '-' ? 'text-red-300 bg-red-500/10 line-through decoration-red-400/40' : 'text-slate-500'}>{d.t === ' ' ? '  ' : d.t + ' '}{d.l}</div>
                                    ))}
                                </pre>
                            </div>
                        )}
                        {msg && <p className={`text-xs flex items-start gap-1.5 ${msg.ok ? 'text-emerald-300' : 'text-red-300'}`}><XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{msg.text}{msg.upgrade && <> <Link to="/pricing" className="underline font-bold">See Pro</Link></>}</span></p>}
                        {data.pending && <p className="text-xs text-sky-300 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> A change by {data.pending.by} is being applied right now.</p>}
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 p-4 border-t border-white/5">
                        <p className="mr-auto text-[11px] text-slate-500 max-w-xs">{installed ? 'Runs as a job with live logs. If the add-on does not come up healthy, Helm puts back the version that worked.' : 'Installs as a job with live logs.'}</p>
                        <button onClick={doPreview} disabled={!!busy} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 text-slate-200 text-xs font-bold hover:bg-white/5 disabled:opacity-50">
                            {busy === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Preview
                        </button>
                        <button onClick={apply} disabled={!!busy || !!data.pending} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-black disabled:opacity-50">
                            {busy === 'apply' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} {installed ? 'Apply' : 'Install'}
                        </button>
                    </div>
                </>)}
            </div>
        </div>,
        document.body
    )
}
