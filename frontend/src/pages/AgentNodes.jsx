import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import {
    Server, Plus, Wifi, WifiOff, Clock, Copy, Check,
    Trash2, Loader2, RefreshCw, Shield, AlertTriangle,
    Terminal, ChevronRight, Activity, Info
} from 'lucide-react'

// ─── Status Badge ─────────────────────────────────────────────────
function StatusBadge({ status }) {
    const styles = {
        online: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20 shadow-[0_0_12px_rgba(16,185,129,0.1)]',
        offline: 'text-rose-400 bg-rose-500/10 border-rose-500/20',
        pending: 'text-amber-400 bg-amber-500/10 border-amber-500/20'
    }
    const icons = {
        online: <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />,
        offline: <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />,
        pending: <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
    }
    return (
        <span className={`flex items-center gap-1.5 text-xs font-black uppercase tracking-widest px-3 py-1 rounded-full border ${styles[status] || styles.offline}`}>
            {icons[status] || icons.offline}
            {status}
        </span>
    )
}

// ─── Copy Button ──────────────────────────────────────────────────
function CopyButton({ text, className = '' }) {
    const [copied, setCopied] = useState(false)
    const copy = () => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }
    return (
        <button
            onClick={copy}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-300 text-xs font-bold transition-all active:scale-95 ${className}`}
        >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy'}
        </button>
    )
}

// ─── Prerequisite Info Banner ─────────────────────────────────────
function PrerequisiteBanner() {
    return (
        <div className="glass rounded-3xl border border-amber-500/20 bg-amber-500/5 p-6 mb-8">
            <div className="flex items-start gap-4">
                <div className="p-2.5 bg-amber-500/15 rounded-2xl border border-amber-500/20 shrink-0 mt-0.5">
                    <Info className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                    <h3 className="text-sm font-black text-amber-300 uppercase tracking-wider mb-2">
                        Prerequisite for Deploying Local Clusters via SaaS (Gateway Agent)
                    </h3>
                    <p className="text-xs text-amber-200/70 leading-relaxed mb-3">
                        Since KubeEZ is hosted on the SaaS cloud, your local servers are not directly reachable. <strong className="text-amber-300">To deploy a local cluster, you must install a "Gateway Agent" on your Windows, Mac, or Linux PC.</strong> This acts as a secure SSH tunnel bridging KubeEZ and your internal Linux VMs.
                    </p>
                    <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                        {[
                            '✅ Generate a Gateway Token (below)',
                            '✅ Run the generated terminal command on your PC',
                            '✅ Deploy your cluster once the Agent is "Online"'
                        ].map((step, i) => (
                            <span key={i} className="text-[11px] font-bold text-amber-300/80">{step}</span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── New Agent Flow ───────────────────────────────────────────────
function GenerateAgentCard({ onGenerated }) {
    const { toast } = useToast()
    const [label, setLabel] = useState('')
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState(null)
    const [osTab, setOsTab] = useState('windows')

    const handleGenerate = async () => {
        setLoading(true)
        try {
            const token = localStorage.getItem('token')
            const res = await fetch('/api/agent/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ label: label.trim() || undefined })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to generate token')
            setResult(data)
            onGenerated?.()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }

    if (result) {
        return (
            <div className="glass rounded-3xl border border-emerald-500/20 bg-emerald-500/5 p-8 animate-in fade-in duration-300">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2.5 bg-emerald-500/15 rounded-2xl border border-emerald-500/20">
                        <Check className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                        <h3 className="text-lg font-black text-white uppercase tracking-wide">Agent Token Generated!</h3>
                        <p className="text-xs text-slate-400 mt-0.5">Label: <span className="text-emerald-400 font-bold">{result.label}</span></p>
                    </div>
                </div>

                {/* Steps */}
                <div className="space-y-5">
                    {/* Step 1 */}
                    <div className="bg-black/30 rounded-2xl p-5 border border-white/5">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-black flex items-center justify-center">1</span>
                                <span className="text-xs font-black text-slate-300 uppercase tracking-wider">Run this command on your PC</span>
                            </div>
                            <div className="flex bg-black/40 p-1 rounded-lg border border-white/5">
                                <button
                                    onClick={() => setOsTab('windows')}
                                    className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-md transition-all ${
                                        osTab === 'windows' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                                    }`}
                                >
                                    Windows (PowerShell)
                                </button>
                                <button
                                    onClick={() => setOsTab('linux')}
                                    className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-wider rounded-md transition-all ${
                                        osTab === 'linux' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'
                                    }`}
                                >
                                    Mac / Linux (Bash)
                                </button>
                            </div>
                        </div>
                        <div className="relative mt-2">
                            <pre className="text-xs font-mono text-emerald-300 bg-black/40 rounded-xl p-4 pr-24 border border-white/5 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                                {osTab === 'windows' ? result.installCommandWindows : result.installCommandLinux}
                            </pre>
                            <div className="absolute top-2 right-2">
                                <CopyButton text={osTab === 'windows' ? result.installCommandWindows : result.installCommandLinux} />
                            </div>
                        </div>
                    </div>

                    {/* Step 2 */}
                    <div className="bg-black/30 rounded-2xl p-5 border border-white/5">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-black flex items-center justify-center">2</span>
                            <span className="text-xs font-black text-slate-300 uppercase tracking-wider">Check Agent Status</span>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                            After installing, the agent will appear in the list below with an <span className="text-emerald-400 font-bold">"Online"</span> status. Click the refresh button or reload the page to check.
                        </p>
                    </div>

                    {/* Step 3 */}
                    <div className="bg-black/30 rounded-2xl p-5 border border-white/5">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-black flex items-center justify-center">3</span>
                            <span className="text-xs font-black text-slate-300 uppercase tracking-wider">Deploy Your Cluster</span>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">
                            Once the agent is online, proceed to <strong className="text-white">"Deploy New Cluster"</strong>. When entering Node IPs, the system will automatically detect if an agent is available for those nodes.
                        </p>
                    </div>
                </div>

                <button
                    onClick={() => setResult(null)}
                    className="mt-6 text-xs text-slate-500 hover:text-white transition-colors font-bold uppercase tracking-wider"
                >
                    ← Generate another agent
                </button>
            </div>
        )
    }

    return (
        <div className="glass rounded-3xl border border-white/5 p-8">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2.5 bg-blue-500/15 rounded-2xl border border-blue-500/20">
                    <Plus className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                    <h3 className="text-lg font-black text-white uppercase tracking-wide">Add a New Gateway Agent</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Generate an agent registration token</p>
                </div>
            </div>

            <div className="space-y-4">
                <div>
                    <label className="text-xs font-black text-slate-400 uppercase tracking-wider block mb-2">
                        Gateway Label (optional)
                    </label>
                    <input
                        type="text"
                        value={label}
                        onChange={e => setLabel(e.target.value)}
                        placeholder="e.g. windows-laptop-gateway, office-mac-bridge"
                        className="w-full bg-black/35 hover:bg-black/50 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors"
                        onKeyDown={e => e.key === 'Enter' && handleGenerate()}
                    />
                </div>
                <button
                    onClick={handleGenerate}
                    disabled={loading}
                    className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 disabled:from-blue-600/50 disabled:to-blue-700/50 text-white font-black text-xs uppercase tracking-wider shadow-lg shadow-blue-600/20 active:scale-[0.98] transition-all duration-300 flex items-center justify-center gap-2"
                >
                    {loading ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /><span>Generating...</span></>
                    ) : (
                        <><Plus className="w-4 h-4" /><span>Generate Token</span></>
                    )}
                </button>
            </div>
        </div>
    )
}

// ─── Agent Card ───────────────────────────────────────────────────
function AgentCard({ agent, onDelete }) {
    const { toast } = useToast()
    const [deleting, setDeleting] = useState(false)
    const [confirm, setConfirm] = useState(false)

    const handleDelete = async () => {
        setDeleting(true)
        try {
            const token = localStorage.getItem('token')
            const res = await fetch(`/api/agent/${agent.agentId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast({ title: 'Agent Removed', message: `${agent.label} successfully removed`, type: 'success' })
            onDelete?.()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setDeleting(false)
            setConfirm(false)
        }
    }

    const timeSince = (isoDate) => {
        if (!isoDate) return 'Never'
        const seconds = Math.floor((Date.now() - new Date(isoDate)) / 1000)
        if (seconds < 60) return `${seconds}s ago`
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
        return `${Math.floor(seconds / 86400)}d ago`
    }

    return (
        <div className={`glass rounded-3xl border p-6 transition-all duration-300 ${
            agent.status === 'online'
                ? 'border-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.05)]'
                : 'border-white/5'
        }`}>
            <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className={`p-2.5 rounded-2xl border ${
                        agent.status === 'online'
                            ? 'bg-emerald-500/10 border-emerald-500/20'
                            : 'bg-white/5 border-white/5'
                    }`}>
                        {agent.status === 'online'
                            ? <Wifi className="w-5 h-5 text-emerald-400" />
                            : <WifiOff className="w-5 h-5 text-slate-500" />
                        }
                    </div>
                    <div>
                        <h4 className="font-black text-white">{agent.label}</h4>
                        <p className="text-[10px] font-mono text-slate-500 mt-0.5">{agent.agentId.slice(0, 16)}...</p>
                    </div>
                </div>
                <StatusBadge status={agent.status} />
            </div>

            {/* Node IPs */}
            {agent.registeredNodeIps && agent.registeredNodeIps.length > 0 && (
                <div className="mb-4">
                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Registered Node IPs</p>
                    <div className="flex flex-wrap gap-1.5">
                        {agent.registeredNodeIps.map(ip => (
                            <span key={ip} className="px-2.5 py-1 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs font-mono font-bold text-blue-400">
                                {ip}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {agent.registeredNodeIps?.length === 0 && agent.status !== 'pending' && (
                <div className="mb-4 text-[11px] text-slate-500 flex items-center gap-1.5">
                    <Info className="w-3 h-3" />
                    Agent connected but no Node IPs were found. Please run the script again.
                </div>
            )}

            {/* Meta */}
            <div className="flex items-center justify-between border-t border-white/5 pt-4">
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold">
                    <Clock className="w-3 h-3" />
                    Last seen: {timeSince(agent.lastSeen)}
                </div>

                {!confirm ? (
                    <button
                        onClick={() => setConfirm(true)}
                        className="p-2 rounded-xl text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-all"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                ) : (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setConfirm(false)}
                            className="text-[10px] text-slate-500 hover:text-white font-bold uppercase tracking-wider px-2"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleDelete}
                            disabled={deleting}
                            className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[10px] font-black uppercase tracking-wider transition-colors flex items-center gap-1"
                        >
                            {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            Delete
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}

// ─── Main Page ────────────────────────────────────────────────────
export default function AgentNodes() {
    const { user } = useAuth()
    const [agents, setAgents] = useState([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)

    const fetchAgents = useCallback(async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true)
        try {
            const token = localStorage.getItem('token')
            const res = await fetch('/api/agent/list', {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            if (res.ok) {
                const data = await res.json()
                setAgents(data)
            }
        } catch (e) {
            console.error('Failed to fetch agents:', e)
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [])

    useEffect(() => {
        fetchAgents()
        // Poll every 15s to update online/offline status
        const interval = setInterval(() => fetchAgents(true), 15000)
        return () => clearInterval(interval)
    }, [fetchAgents])

    const onlineCount = agents.filter(a => a.status === 'online').length

    return (
        <div className="max-w-5xl mx-auto py-4">
            {/* Header */}
            <div className="glass rounded-3xl p-8 mb-8 relative overflow-hidden border border-white/5">
                <div className="absolute top-0 right-0 w-72 h-72 bg-emerald-500/5 rounded-full blur-[100px] pointer-events-none" />
                <div className="flex items-start justify-between relative z-10">
                    <div>
                        <div className="flex items-center gap-3 mb-3">
                            <div className="p-3 bg-emerald-500/10 rounded-2xl border border-emerald-500/20">
                                <Shield className="w-6 h-6 text-emerald-400" />
                            </div>
                            <div>
                                <h1 className="text-3xl font-black text-white uppercase tracking-tight">Gateway Agents</h1>
                                <p className="text-slate-400 text-sm mt-0.5">Local cluster deployment ke liye apni machine ko reverse tunnel gateway banayein</p>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-3">
                        {onlineCount > 0 && (
                            <div className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
                                <Activity className="w-4 h-4 text-emerald-400" />
                                <span className="text-xs font-black text-emerald-400 uppercase tracking-widest">{onlineCount} Online</span>
                            </div>
                        )}
                        <button
                            onClick={() => fetchAgents(true)}
                            disabled={refreshing}
                            className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl transition-all active:scale-95 text-slate-300"
                        >
                            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>

                {/* Stats bar */}
                <div className="flex gap-6 mt-6 pt-6 border-t border-white/5 relative z-10">
                    {[
                        { label: 'Total Agents', value: agents.length, color: 'text-white' },
                        { label: 'Online', value: agents.filter(a => a.status === 'online').length, color: 'text-emerald-400' },
                        { label: 'Offline', value: agents.filter(a => a.status === 'offline').length, color: 'text-rose-400' },
                        { label: 'Pending Setup', value: agents.filter(a => a.status === 'pending').length, color: 'text-amber-400' },
                    ].map(s => (
                        <div key={s.label}>
                            <p className="text-xs font-black uppercase text-slate-500 tracking-widest">{s.label}</p>
                            <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Prerequisite Banner */}
            <PrerequisiteBanner />

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Left: Generate Agent */}
                <div>
                    <GenerateAgentCard onGenerated={() => setTimeout(() => fetchAgents(true), 1500)} />
                </div>

                {/* Right: Existing Agents */}
                <div>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xs font-black uppercase text-slate-400 tracking-widest">Registered Agents</h2>
                        <div className="flex items-center gap-3">
                            <span className="text-xs font-bold text-slate-600">{agents.length} total</span>
                            <button
                                onClick={() => fetchAgents(true)}
                                disabled={refreshing}
                                className="p-1.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-lg transition-all active:scale-95 text-slate-300"
                                title="Refresh Agents"
                            >
                                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                            </button>
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-16 gap-4">
                            <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                            <p className="text-xs text-slate-500 uppercase font-black tracking-widest">Loading agents...</p>
                        </div>
                    ) : agents.length === 0 ? (
                        <div className="glass rounded-3xl border border-white/5 p-10 text-center">
                            <div className="p-4 bg-white/5 rounded-2xl border border-white/5 inline-flex mb-4">
                                <Terminal className="w-8 h-8 text-slate-600" />
                            </div>
                            <p className="text-slate-400 font-bold mb-1">No agents registered</p>
                            <p className="text-xs text-slate-600">Generate a token and install it on your local server.</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {agents.map(agent => (
                                <AgentCard
                                    key={agent.agentId}
                                    agent={agent}
                                    onDelete={() => fetchAgents(true)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div className="mt-8 border-t border-white/5 pt-8">
                <h3 className="text-sm font-black text-white uppercase tracking-wider mb-6 text-center">How It Works</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[
                        {
                            icon: <Plus className="w-5 h-5 text-blue-400" />,
                            step: '01',
                            title: 'Generate Token',
                            desc: 'Click "Generate Token" above. You will receive a unique gateway registration token.'
                        },
                        {
                            icon: <Terminal className="w-5 h-5 text-purple-400" />,
                            step: '02',
                            title: 'Start Gateway',
                            desc: 'Run the generated terminal command on your PC. It will securely handle the background SSH tunnel.'
                        },
                        {
                            icon: <ChevronRight className="w-5 h-5 text-emerald-400" />,
                            step: '03',
                            title: 'Deploy Cluster',
                            desc: 'Once the Agent appears as "Online", use the normal wizard to create a cluster. KubeEZ will automatically route SSH traffic through this gateway.'
                        }
                    ].map((item, i) => (
                        <div key={i} className="relative">
                            <div className="flex items-center gap-3 mb-3">
                                <div className="p-2 bg-white/5 border border-white/5 rounded-xl">
                                    {item.icon}
                                </div>
                                <span className="text-[10px] font-black text-slate-600 tracking-widest">STEP {item.step}</span>
                            </div>
                            <h3 className="font-black text-white mb-2">{item.title}</h3>
                            <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
