import { useState } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../context/AuthContext'
import { X, Loader2, Lock, Plus, Trash2, Copy, Check, Download } from 'lucide-react'

// Encrypt a Secret with the cluster's Sealed Secrets key. The values go to
// the cluster once (over KubeEZ's SSH / agent tunnel) and are not stored; the
// result is safe to commit to Git.
const inputCls = 'w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500/50'

export default function SealSecretDialog({ clusterId, onClose }) {
    const [name, setName] = useState('')
    const [namespace, setNamespace] = useState('default')
    const [scope, setScope] = useState('strict')
    const [rows, setRows] = useState([{ k: '', v: '' }])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)
    const [yaml, setYaml] = useState(null)
    const [copied, setCopied] = useState(false)

    const seal = async () => {
        setBusy(true); setError(null)
        try {
            const data = Object.fromEntries(rows.filter(r => r.k).map(r => [r.k.trim(), r.v]))
            const r = await apiFetch(`/api/clusters/${clusterId}/addons/sealed-secrets/seal`, { method: 'POST', body: JSON.stringify({ name: name.trim(), namespace: namespace.trim(), scope, data }) })
            const j = await r.json()
            if (!r.ok) throw new Error(j.error || 'Could not seal')
            setYaml(j.yaml)
            setRows(rs => rs.map(x => ({ ...x, v: '' })))   // plain values do not stay on screen
        } catch (e) { setError(e.message) } finally { setBusy(false) }
    }
    const download = () => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }))
        a.download = `${name || 'secret'}-sealed.yaml`
        a.click()
        URL.revokeObjectURL(a.href)
    }

    return createPortal(
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <div className="glass w-full max-w-xl max-h-[90vh] flex flex-col rounded-2xl border border-white/10" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Seal a secret">
                <div className="flex items-start gap-3 p-5 border-b border-white/5">
                    <Lock className="w-5 h-5 text-fuchsia-300 mt-0.5" />
                    <div className="flex-1">
                        <h3 className="text-white font-black">Seal a secret</h3>
                        <p className="text-xs text-slate-400 mt-0.5">Encrypted with this cluster's key — commit the result to Git; only this cluster can open it. KubeEZ does not keep the values.</p>
                    </div>
                    <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400"><X className="w-4 h-4" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-5 space-y-3">
                    <div className="grid sm:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1" htmlFor="ss-name">Secret name</label>
                            <input id="ss-name" className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="db-credentials" />
                        </div>
                        <div>
                            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1" htmlFor="ss-ns">Namespace</label>
                            <input id="ss-ns" className={inputCls} value={namespace} onChange={e => setNamespace(e.target.value)} />
                        </div>
                    </div>
                    <div>
                        <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1" htmlFor="ss-scope">Can be opened</label>
                        <select id="ss-scope" className={inputCls} value={scope} onChange={e => setScope(e.target.value)}>
                            <option value="strict" className="bg-slate-950">Only with this name in this namespace (safest)</option>
                            <option value="namespace-wide" className="bg-slate-950">Under any name in this namespace</option>
                            <option value="cluster-wide" className="bg-slate-950">Anywhere in the cluster</option>
                        </select>
                    </div>
                    <div className="space-y-2">
                        <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Keys and values</p>
                        {rows.map((r, i) => (
                            <div key={i} className="flex gap-2">
                                <input aria-label="Key" className={`${inputCls} !w-2/5`} placeholder="password" value={r.k} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
                                <input aria-label="Value" type="password" autoComplete="off" className={inputCls} placeholder="value" value={r.v} onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
                                <button aria-label="Remove" onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, j) => j !== i) : [{ k: '', v: '' }])} className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>
                            </div>
                        ))}
                        <button onClick={() => setRows(rs => [...rs, { k: '', v: '' }])} className="flex items-center gap-1 text-xs font-bold text-sky-300 hover:text-sky-200"><Plus className="w-3.5 h-3.5" /> Add a key</button>
                    </div>
                    {error && <p className="text-xs text-red-300">{error}</p>}
                    {yaml && (
                        <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.04]">
                            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                                <span className="text-[11px] font-bold text-emerald-300">Sealed — safe to commit</span>
                                <span className="flex gap-1">
                                    <button onClick={() => { navigator.clipboard.writeText(yaml); setCopied(true); setTimeout(() => setCopied(false), 1500) }} className="p-1.5 rounded-lg border border-white/10 text-slate-300" aria-label="Copy">{copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}</button>
                                    <button onClick={download} className="p-1.5 rounded-lg border border-white/10 text-slate-300" aria-label="Download"><Download className="w-3.5 h-3.5" /></button>
                                </span>
                            </div>
                            <pre className="max-h-56 overflow-auto p-3 text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all">{yaml}</pre>
                        </div>
                    )}
                </div>
                <div className="flex justify-end gap-2 p-4 border-t border-white/5">
                    <button onClick={onClose} className="px-4 py-2 rounded-xl border border-white/10 text-slate-300 text-xs font-bold">Close</button>
                    <button onClick={seal} disabled={busy || !name.trim() || !rows.some(r => r.k)} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs font-black disabled:opacity-50">
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />} Seal
                    </button>
                </div>
            </div>
        </div>,
        document.body
    )
}
