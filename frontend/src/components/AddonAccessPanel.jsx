import { useState, useEffect } from 'react'
import { apiFetch } from '../context/AuthContext'
import {
    Globe, Activity, BarChart3, LayoutDashboard, Shield, Database, GitBranch,
    ExternalLink, Copy, Check, Eye, EyeOff, RefreshCw, Loader2, KeyRound, Package
} from 'lucide-react'

const ICONS = {
    globe: Globe,
    activity: Activity,
    'bar-chart': BarChart3,
    'layout-dashboard': LayoutDashboard,
    shield: Shield,
    database: Database,
    'git-branch': GitBranch
}

function CopyBtn({ text }) {
    const [copied, setCopied] = useState(false)
    if (!text) return null
    return (
        <button
            onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
            className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 transition-all active:scale-95"
            title="Copy"
        >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
    )
}

function Secret({ value }) {
    const [show, setShow] = useState(false)
    if (!value) return null
    return (
        <div className="flex items-center gap-2 flex-1 min-w-0">
            <code className="flex-1 min-w-0 truncate font-mono text-sm text-slate-200 bg-black/40 rounded-lg px-3 py-1.5 border border-white/5">
                {show ? value : '•'.repeat(Math.min(value.length, 16))}
            </code>
            <button
                onClick={() => setShow(s => !s)}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 transition-all active:scale-95"
                title={show ? 'Hide' : 'Reveal'}
            >
                {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
            <CopyBtn text={value} />
        </div>
    )
}

export default function AddonAccessPanel({ clusterId }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    const fetchAccess = async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${clusterId}/addons/access`)
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Failed to load addon access')
            setData(json)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { fetchAccess() }, [clusterId])

    return (
        <div className="glass rounded-2xl border border-white/8 p-6">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <Package className="w-5 h-5 text-blue-400" />
                    <div>
                        <h3 className="text-lg font-black text-white tracking-tight">Installed Add-ons</h3>
                        <p className="text-slate-500 text-xs mt-0.5">Access URLs & credentials — no server login needed</p>
                    </div>
                </div>
                <button
                    onClick={fetchAccess}
                    disabled={loading}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-xs font-bold transition-all active:scale-95 disabled:opacity-50"
                >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {loading && (
                <div className="py-12 flex flex-col items-center gap-3 text-slate-500">
                    <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
                    <p className="text-sm">Discovering add-ons on the cluster...</p>
                </div>
            )}

            {error && !loading && (
                <div className="py-8 text-center">
                    <p className="text-red-400 text-sm mb-3">{error}</p>
                    <button onClick={fetchAccess} className="text-xs font-bold text-blue-400 hover:underline">Try again</button>
                </div>
            )}

            {!loading && !error && data && data.addons.length === 0 && (
                <div className="py-12 text-center">
                    <Package className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                    <p className="text-slate-400 text-sm">No add-ons installed on this cluster yet.</p>
                    <p className="text-slate-600 text-xs mt-1">Install add-ons from the cluster actions to see access details here.</p>
                </div>
            )}

            {!loading && !error && data && data.addons.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {data.addons.map(addon => {
                        const Icon = ICONS[addon.icon] || Package
                        return (
                            <div key={addon.key} className="bg-white/[0.03] border border-white/8 rounded-2xl p-5">
                                {/* Header */}
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
                                            <Icon className="w-4 h-4 text-blue-400" />
                                        </div>
                                        <span className="font-black text-white text-sm">{addon.name}</span>
                                    </div>
                                    <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-black uppercase tracking-widest">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Running
                                    </span>
                                </div>

                                {/* URL */}
                                {addon.url && (
                                    <div className="mb-3">
                                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">Access URL</label>
                                        <div className="flex items-center gap-2">
                                            <a
                                                href={addon.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex-1 min-w-0 flex items-center gap-2 font-mono text-sm text-blue-400 hover:text-blue-300 bg-black/40 rounded-lg px-3 py-1.5 border border-white/5 truncate"
                                            >
                                                <span className="truncate">{addon.url}</span>
                                                <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                                            </a>
                                            <CopyBtn text={addon.url} />
                                        </div>
                                        {addon.urlHttps && (
                                            <div className="flex items-center gap-2 mt-2">
                                                <a href={addon.urlHttps} target="_blank" rel="noopener noreferrer"
                                                   className="flex-1 min-w-0 flex items-center gap-2 font-mono text-xs text-slate-400 hover:text-slate-300 bg-black/40 rounded-lg px-3 py-1.5 border border-white/5 truncate">
                                                    <span className="truncate">{addon.urlHttps}</span>
                                                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
                                                </a>
                                                <CopyBtn text={addon.urlHttps} />
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Credentials */}
                                {addon.auth && (
                                    <div className="space-y-2 mb-3">
                                        {addon.auth.username && (
                                            <div>
                                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">Username</label>
                                                <div className="flex items-center gap-2">
                                                    <code className="flex-1 font-mono text-sm text-slate-200 bg-black/40 rounded-lg px-3 py-1.5 border border-white/5">{addon.auth.username}</code>
                                                    <CopyBtn text={addon.auth.username} />
                                                </div>
                                            </div>
                                        )}
                                        {addon.auth.password && (
                                            <div>
                                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-1.5">Password</label>
                                                <Secret value={addon.auth.password} />
                                            </div>
                                        )}
                                        {addon.auth.token && (
                                            <div>
                                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-1 mb-1.5">
                                                    <KeyRound className="w-3 h-3" /> Login Token
                                                </label>
                                                <Secret value={addon.auth.token} />
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Note */}
                                {addon.note && (
                                    <p className="text-[11px] text-slate-500 leading-relaxed border-t border-white/5 pt-3">{addon.note}</p>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            {data?.nodeIp && (
                <p className="text-[11px] text-slate-600 mt-4 text-center">
                    Services exposed via NodePort on <code className="text-slate-400">{data.nodeIp}</code> — reachable from your internal network.
                </p>
            )}
        </div>
    )
}
