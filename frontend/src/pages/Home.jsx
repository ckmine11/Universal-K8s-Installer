import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/ToastProvider'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { CardSkeleton } from '../components/Skeleton'
import { ADDONS_LIST } from '../config/addons'
import { Server, Zap, Plus, Settings, Cpu, Network, Rocket, Trash2, ExternalLink, Package, Loader2, CheckCircle2, BarChart3, LayoutDashboard, Shield, Database, GitBranch, Sparkles, Lock, Eye, HeartPulse, Users, RotateCcw , Compass } from 'lucide-react'

// Full class names per colour (Tailwind drops classes built from `${color}`)
const TONE = {
    blue:    { text: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    ring: 'border-blue-500/30',    from: 'from-blue-500/10' },
    cyan:    { text: 'text-cyan-400',    bg: 'bg-cyan-500/10',    border: 'border-cyan-500/20',    ring: 'border-cyan-500/30',    from: 'from-cyan-500/10' },
    pink:    { text: 'text-pink-400',    bg: 'bg-pink-500/10',    border: 'border-pink-500/20',    ring: 'border-pink-500/30',    from: 'from-pink-500/10' },
    emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', ring: 'border-emerald-500/30', from: 'from-emerald-500/10' },
    orange:  { text: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/20',  ring: 'border-orange-500/30',  from: 'from-orange-500/10' },
    purple:  { text: 'text-purple-400',  bg: 'bg-purple-500/10',  border: 'border-purple-500/20',  ring: 'border-purple-500/30',  from: 'from-purple-500/10' }
}

export default function Home({ onStartNew, onScaleExisting }) {
    const { toast } = useToast()
    const { user } = useAuth()
    const navigate = useNavigate()
    const canDelete = can(user?.role, 'cluster:delete')
    const canCreate = can(user?.role, 'cluster:create')
    const [savedClusters, setSavedClusters] = useState([])
    const [loading, setLoading] = useState(true)
    const [isFreePlan, setIsFreePlan] = useState(false)

    // Add-on Management State
    const [isAddonModalOpen, setIsAddonModalOpen] = useState(false)
    const [selectedClusterId, setSelectedClusterId] = useState(null)
    const [addonSelection, setAddonSelection] = useState({
        ingress: false,
        monitoring: false,
        dashboard: false,
        'cert-manager': false,
        longhorn: false,
        argocd: false,
        seaweedfs: false
    })
    const [installingAddons, setInstallingAddons] = useState(false)

    const handleAddonSubmit = async () => {
        if (!Object.values(addonSelection).some(v => v)) {
            toast({
                title: 'Selection Required',
                message: 'Please select at least one add-on to install.',
                type: 'info'
            })
            return
        }
        setInstallingAddons(true)
        toast({
            title: 'Initializing',
            message: 'Preparing add-on installation pipeline...',
            type: 'loading',
            duration: 3000
        })
        try {
            const res = await apiFetch(`/api/clusters/${selectedClusterId}/addons`, {
                method: 'POST',
                body: JSON.stringify({ addons: addonSelection })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to start addon install')

            toast({
                title: 'Success',
                message: 'Add-on installation triggered successfully.',
                type: 'success'
            })
            setIsAddonModalOpen(false)
            navigate(`/dashboard/${data.newInstallationId}`)
        } catch (err) {
            toast({
                title: 'Error',
                message: err.message,
                type: 'error'
            })
        } finally {
            setInstallingAddons(false)
        }
    }

    useEffect(() => {
        fetchSavedClusters()
        // Determine plan to gate premium add-ons
        apiFetch('/api/billing/subscription')
            .then(r => r.ok ? r.json() : null)
            .then(sub => { if (sub) setIsFreePlan(!sub.plan || String(sub.plan).toUpperCase() === 'FREE') })
            .catch(() => {})
    }, [])

    const fetchSavedClusters = async () => {
        setLoading(true)
        try {
            const response = await apiFetch('/api/clusters/list')
            const data = await response.json()
            setSavedClusters(data)
        } catch (error) {
            console.error('Failed to fetch clusters:', error)
            toast({
                title: 'Connection Error',
                message: 'Could not fetch managed clusters from backend.',
                type: 'error'
            })
        } finally {
            setLoading(false)
        }
    }

    const handleDeleteCluster = async (e, id) => {
        e.stopPropagation()
        if (!canDelete) {
            toast({ title: 'Not Allowed', message: 'Your role does not permit deleting clusters.', type: 'error' })
            return
        }
        if (!window.confirm('Are you sure you want to remove this cluster from management?')) return

        try {
            const res = await apiFetch(`/api/clusters/${id}`, {
                method: 'DELETE'
            })
            // apiFetch does not throw on non-2xx — must check the status explicitly,
            // otherwise a 403 (permission denied) would still remove it from the UI.
            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                throw new Error(data.error || (res.status === 403
                    ? 'You do not have permission to delete clusters.'
                    : 'Failed to delete cluster record.'))
            }
            setSavedClusters(prev => prev.filter(c => c.id !== id))
            toast({
                title: 'Removed',
                message: 'Cluster management record deleted.',
                type: 'success'
            })
        } catch (error) {
            toast({
                title: 'Action Failed',
                message: error.message || 'Failed to delete cluster record.',
                type: 'error'
            })
        }
    }
    return (
        <div className="relative max-w-7xl mx-auto py-8 px-4 sm:px-6 min-h-[calc(100vh-100px)] flex flex-col justify-center items-center overflow-hidden">

            {/* Add-on Selection Modal - ULTRA PREMIUM UI */}
            {isAddonModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-in fade-in" onClick={(e) => e.stopPropagation()}>
                    <div className="bg-[#0f172a]/95 backdrop-blur-xl border border-white/10 rounded-[32px] max-w-5xl w-full p-10 shadow-2xl relative overflow-hidden" onClick={(e) => e.stopPropagation()}>
                        {/* Animated Background Gradients */}
                        <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-br from-blue-500/20 to-cyan-500/20 rounded-full blur-[120px] pointer-events-none animate-pulse"></div>
                        <div className="absolute bottom-0 left-0 w-96 h-96 bg-gradient-to-tr from-purple-500/20 to-pink-500/20 rounded-full blur-[120px] pointer-events-none animate-pulse" style={{ animationDelay: '1s' }}></div>
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 rounded-full blur-[100px] pointer-events-none"></div>

                        <div className="relative z-10">
                            {/* Premium Header */}
                            <div className="flex items-center justify-between mb-8">
                                <div className="flex items-center space-x-4">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl blur-xl opacity-50 animate-pulse"></div>
                                        <div className="relative p-4 bg-gradient-to-br from-blue-500 via-purple-500 to-pink-500 rounded-2xl shadow-2xl">
                                            <Sparkles className="w-7 h-7 text-white animate-pulse" />
                                        </div>
                                    </div>
                                    <div>
                                        <h2 className="text-4xl font-black bg-gradient-to-r from-white via-blue-100 to-purple-100 bg-clip-text text-transparent mb-1">
                                            Install Add-ons
                                        </h2>
                                        <p className="text-gray-300 text-sm font-medium">✨ Supercharge your cluster with powerful components</p>
                                    </div>
                                </div>
                            </div>

                            {/* Premium Add-ons Grid */}
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 my-8 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
                                {ADDONS_LIST.map(addon => {
                                    // Map icon name to component
                                    const iconMap = {
                                        Compass,
                                        Network,
                                        BarChart3,
                                        LayoutDashboard,
                                        Shield,
                                        Database,
                                        GitBranch,
                                        Sparkles
                                    };
                                    const Icon = iconMap[addon.iconName] || Package;
                                    const locked = addon.tier === 'pro' && isFreePlan;
                                    const isSelected = addonSelection[addon.key] && !locked;

                                    return (
                                        <div
                                            key={addon.key}
                                            onClick={() => {
                                                if (locked) {
                                                    toast({ title: 'Pro add-on', message: `${addon.name} is available on Pro & Enterprise plans. Upgrade to unlock.`, type: 'info' })
                                                    return
                                                }
                                                setAddonSelection(p => ({ ...p, [addon.key]: !p[addon.key] }))
                                            }}
                                            className={`group relative p-6 rounded-2xl border transition-all duration-300 overflow-hidden ${locked
                                                ? 'bg-white/[0.02] border-white/5 opacity-60 cursor-not-allowed'
                                                : isSelected
                                                ? 'bg-blue-500/5 border-blue-500 ring-1 ring-blue-500/50 shadow-lg shadow-blue-500/10 cursor-pointer'
                                                : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 hover:shadow-xl hover:shadow-black/20 cursor-pointer'
                                                }`}
                                        >
                                            {/* Selection Indicator / Lock */}
                                            {locked ? (
                                                <div className="absolute top-4 right-4 flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[9px] font-black uppercase tracking-widest">
                                                    <Lock className="w-3 h-3" /> Pro
                                                </div>
                                            ) : (
                                                <div className={`absolute top-4 right-4 w-6 h-6 rounded-full border flex items-center justify-center transition-all duration-300 ${isSelected
                                                    ? 'bg-blue-500 border-blue-500 scale-110'
                                                    : 'border-white/20 group-hover:border-white/40'
                                                    }`}>
                                                    {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                                                </div>
                                            )}

                                            {/* Badge */}
                                            {addon.badge && !locked && (
                                                <div className={`absolute top-4 left-4 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider border ${addon.badgeColor} backdrop-blur-md bg-black/20`}>
                                                    {addon.badge}
                                                </div>
                                            )}

                                            <div className="mt-8">
                                                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-4 transition-all duration-300 ${isSelected
                                                    ? `bg-gradient-to-br ${addon.gradient} shadow-lg scale-110`
                                                    : 'bg-white/5 border border-white/10 group-hover:scale-110 group-hover:bg-white/10'
                                                    }`}>
                                                    <Icon className="w-6 h-6 text-white" />
                                                </div>

                                                <h3 className={`font-bold text-lg mb-2 transition-colors ${isSelected ? 'text-white' : 'text-slate-200 group-hover:text-white'}`}>
                                                    {addon.name}
                                                </h3>
                                                <p className={`text-sm leading-relaxed transition-colors ${isSelected ? 'text-blue-100/80' : 'text-slate-400 group-hover:text-slate-300'}`}>
                                                    {addon.desc}
                                                </p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Premium Footer */}
                            <div className="flex space-x-4 pt-6 border-t-2 border-white/20">
                                <button
                                    onClick={(e) => { e.stopPropagation(); setIsAddonModalOpen(false) }}
                                    className="flex-1 px-8 py-4 rounded-2xl border-2 border-white/20 hover:bg-white/10 hover:border-white/30 transition-all duration-300 font-bold text-gray-200 hover:text-white hover:scale-105 backdrop-blur-sm"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleAddonSubmit() }}
                                    disabled={installingAddons}
                                    className="relative flex-1 px-8 py-4 rounded-2xl font-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-3 overflow-hidden group hover:scale-105"
                                >
                                    <div className="absolute inset-0 bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 transition-all duration-300 group-hover:scale-110"></div>
                                    <div className="absolute inset-0 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-xl"></div>
                                    <div className="relative flex items-center space-x-3">
                                        {installingAddons ? (
                                            <>
                                                <Loader2 className="w-6 h-6 animate-spin" />
                                                <span className="text-lg">Installing Magic...</span>
                                            </>
                                        ) : (
                                            <>
                                                <Zap className="w-6 h-6 group-hover:animate-pulse" />
                                                <span className="text-lg">Start Installation</span>
                                            </>
                                        )}
                                    </div>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}


            {/* Ambient Background Glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-blue-500/20 rounded-full blur-[120px] pointer-events-none opacity-50 animate-pulse"></div>

            {/* Main Action Cards — create/scale entry points (hidden for read-only viewers) */}
            {canCreate ? (
            <div className={`grid grid-cols-1 md:grid-cols-2 gap-8 mb-20 relative z-10 w-full max-w-4xl transition-all duration-500 ${savedClusters.length > 0 ? 'scale-95 opacity-90 hover:scale-100 hover:opacity-100' : 'scale-100'}`}>
                {/* Deployment Card */}
                <button
                    onClick={onStartNew}
                    className="group relative h-[380px] bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-[40px] p-10 text-left overflow-hidden hover:border-blue-500/50 hover:bg-slate-900/60 transition-all duration-500 shadow-2xl shadow-black/50 hover:shadow-blue-500/20"
                >
                    {/* Hover Gradient Overlay */}
                    <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

                    {/* Decorative Icon */}
                    <div className="absolute -right-12 -top-12 opacity-[0.05] group-hover:opacity-[0.1] transition-all duration-500 rotate-12 group-hover:rotate-0 group-hover:scale-110">
                        <Plus className="w-72 h-72 text-blue-400" />
                    </div>

                    <div className="relative z-10 h-full flex flex-col justify-between">
                        <div>
                            <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/30 mb-8 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500 ring-1 ring-white/20">
                                <Plus className="w-8 h-8 text-white" />
                            </div>

                            <h2 className="text-4xl font-black text-white tracking-tight mb-3 group-hover:text-blue-200 transition-colors">Smart Deploy</h2>
                            <p className="text-slate-400 text-lg leading-relaxed font-medium max-w-sm group-hover:text-slate-300 transition-colors">
                                Automated cluster provisioning with pre-flight checks and HA configuration.
                            </p>
                        </div>

                        <div className="flex items-center justify-between mt-8 border-t border-white/5 pt-6 group-hover:border-white/10 transition-colors">
                            <div className="flex items-center text-blue-400 font-bold group-hover:translate-x-2 transition-transform duration-300">
                                <span className="uppercase tracking-widest text-xs font-black">Start New Cluster</span>
                                <Zap className="w-5 h-5 ml-2 group-hover:text-yellow-400 transition-colors" />
                            </div>
                            <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-blue-500 group-hover:text-white transition-all">
                                <ExternalLink className="w-4 h-4" />
                            </div>
                        </div>
                    </div>
                </button>

                {/* Scaling Card */}
                <button
                    onClick={() => onScaleExisting(savedClusters.length > 0 ? savedClusters[0] : null)}
                    className="group relative h-[380px] bg-slate-900/40 backdrop-blur-xl border border-white/5 rounded-[40px] p-10 text-left overflow-hidden hover:border-purple-500/50 hover:bg-slate-900/60 transition-all duration-500 shadow-2xl shadow-black/50 hover:shadow-purple-500/20"
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

                    <div className="absolute -right-12 -top-12 opacity-[0.05] group-hover:opacity-[0.1] transition-all duration-500 -rotate-12 group-hover:rotate-0 group-hover:scale-110">
                        <Settings className="w-72 h-72 text-purple-400" />
                    </div>

                    <div className="relative z-10 h-full flex flex-col justify-between">
                        <div>
                            <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-500/30 mb-8 group-hover:scale-110 group-hover:-rotate-3 transition-all duration-500 ring-1 ring-white/20">
                                <Settings className="w-8 h-8 text-white" />
                            </div>

                            <h2 className="text-4xl font-black text-white tracking-tight mb-3 group-hover:text-purple-200 transition-colors">Intelligent Scale</h2>
                            <p className="text-slate-400 text-lg leading-relaxed font-medium max-w-sm group-hover:text-slate-300 transition-colors">
                                Seamlessly scale compute capacity without affecting production workloads.
                            </p>
                        </div>

                        <div className="flex items-center justify-between mt-8 border-t border-white/5 pt-6 group-hover:border-white/10 transition-colors">
                            <div className="flex items-center text-purple-400 font-bold group-hover:translate-x-2 transition-transform duration-300">
                                <span className="uppercase tracking-widest text-xs font-black">Expand Capacity</span>
                                <Server className="w-5 h-5 ml-2" />
                            </div>
                            <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-purple-500 group-hover:text-white transition-all">
                                <ExternalLink className="w-4 h-4" />
                            </div>
                        </div>
                    </div>
                </button>
            </div>
            ) : (
                <div className="relative z-10 w-full max-w-4xl mb-20">
                    <div className="glass rounded-3xl border border-white/5 p-8 text-center">
                        <div className="w-14 h-14 rounded-2xl bg-slate-500/10 border border-slate-500/20 flex items-center justify-center mx-auto mb-4">
                            <Eye className="w-7 h-7 text-slate-400" />
                        </div>
                        <h2 className="text-xl font-black text-white mb-2">Read-only Access</h2>
                        <p className="text-slate-400 text-sm max-w-md mx-auto">
                            Your role is <span className="text-slate-200 font-bold">Viewer</span> — you can monitor clusters, health and
                            incidents, but cannot create, scale, upgrade or delete. Ask an Operator or Admin to make changes.
                        </p>
                    </div>
                </div>
            )}

            {/* Managed Fleet Section - Only shows if relevant */}
            {savedClusters.length > 0 && (
                <div className="animate-in [animation-delay:500ms] mb-20 w-full max-w-5xl">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-2xl font-black text-white tracking-tight">Active Infrastructure</h3>
                            <p className="text-slate-400 text-sm mt-1">Managed Kubernetes Fleet</p>
                        </div>
                        <span className="px-4 py-2 bg-blue-500/10 border border-blue-500/20 rounded-2xl text-xs font-black text-blue-400 uppercase tracking-widest flex items-center gap-2">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                            </span>
                            {savedClusters.length} Cluster{savedClusters.length !== 1 ? 's' : ''} Online
                        </span>
                    </div>

                    <div className="grid grid-cols-1 gap-4">
                        {loading ? (
                            <>
                                <CardSkeleton />
                                <CardSkeleton />
                            </>
                        ) : savedClusters.map((cluster) => (
                            <div
                                key={cluster.id}
                                onClick={() => navigate(`/cluster/${cluster.id}`)}
                                className="group glass-card rounded-[32px] p-8 border border-white/5 hover:border-blue-500/30 transition-all cursor-pointer flex items-center justify-between hover:bg-white/[0.02]"
                            >
                                <div className="flex items-center space-x-8">
                                    <div className="w-16 h-16 bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl flex items-center justify-center border border-white/10 group-hover:border-blue-500/30 transition-colors shadow-lg">
                                        <Rocket className="w-7 h-7 text-slate-400 group-hover:text-blue-400 transition-colors" />
                                    </div>
                                    <div>
                                        <div className="flex items-center space-x-3 mb-2">
                                            <h4 className="text-xl font-black text-white uppercase tracking-tight">{cluster.clusterName}</h4>
                                            <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-500 text-[10px] font-black uppercase rounded-lg border border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.1)]">
                                                Active & Ready
                                            </span>
                                        </div>
                                        <div className="flex items-center space-x-6 text-xs font-bold text-slate-500 uppercase tracking-wide">
                                            <span className="flex items-center group-hover:text-slate-300 transition-colors"><Cpu className="w-4 h-4 mr-2 text-slate-600" /> v{cluster.k8sVersion}</span>
                                            <span className="flex items-center group-hover:text-slate-300 transition-colors"><Network className="w-4 h-4 mr-2 text-slate-600" /> {cluster.networkPlugin}</span>
                                            <span className="flex items-center text-slate-600 group-hover:text-blue-400 transition-colors"><ExternalLink className="w-4 h-4 mr-2" /> {cluster.masterNodes[0].ip}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center space-x-4">
                                    {canDelete && (
                                        <button
                                            onClick={(e) => handleDeleteCluster(e, cluster.id)}
                                            className="p-4 bg-white/5 hover:bg-red-500/10 text-slate-600 hover:text-red-400 rounded-2xl border border-white/5 hover:border-red-500/20 transition-all opacity-0 group-hover:opacity-100"
                                            title="Remove from dashboard"
                                        >
                                            <Trash2 className="w-5 h-5" />
                                        </button>
                                    )}
                                    {canCreate && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                setSelectedClusterId(cluster.id)
                                                setIsAddonModalOpen(true)
                                            }}
                                            className="px-6 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg shadow-indigo-600/20 group-hover:scale-105 transition-all flex items-center gap-2"
                                        >
                                            <Package className="w-4 h-4" />
                                            <span>Add-ons</span>
                                        </button>
                                    )}
                                    <div className="px-8 py-4 bg-blue-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg shadow-blue-600/20 group-hover:scale-105 transition-all flex items-center gap-2">
                                        <Settings className="w-4 h-4" />
                                        <span>{canCreate ? 'Manage & Scale' : 'View Details'}</span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* How It Works Section */}
            <div className={`w-full max-w-5xl mb-20 transition-all duration-700 delay-100 ${savedClusters.length > 0 ? 'opacity-50 hover:opacity-100' : 'opacity-100'}`}>
                <div className="text-center mb-12">
                    <h3 className="text-2xl font-black text-white uppercase tracking-widest mb-2">How It Works</h3>
                    <div className="h-1 w-20 bg-blue-500 mx-auto rounded-full"></div>
                </div>

                <div className="relative grid grid-cols-1 md:grid-cols-3 gap-8">
                    {/* Connecting Line */}
                    <div className="absolute top-1/2 left-0 w-full h-0.5 bg-gradient-to-r from-blue-500/0 via-blue-500/50 to-blue-500/0 -translate-y-1/2 hidden md:block"></div>

                    {[
                        { title: "Configure", icon: Settings, desc: "Add master and worker nodes (SSH or Gateway Agent). Pre-flight checks verify every node first.", color: "blue" },
                        { title: "Automate", icon: Zap, desc: "KubeEZ installs everything with a live log. If a step fails you get the reason — and Resume skips what is done.", color: "purple" },
                        { title: "Operate", icon: LayoutDashboard, desc: "Upgrade, back up, manage add-ons and watch health — all from the cluster page.", color: "pink" }
                    ].map((step, i) => (
                        <div key={i} className="relative z-10 flex flex-col items-center text-center group">
                            <div className={`w-20 h-20 rounded-2xl bg-slate-900 border ${TONE[step.color].ring} flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(0,0,0,0.5)] group-hover:scale-110 transition-transform duration-300 relative overflow-hidden`}>
                                <div className={`absolute inset-0 bg-gradient-to-br ${TONE[step.color].from} to-transparent`}></div>
                                <step.icon className={`w-8 h-8 ${TONE[step.color].text}`} />
                            </div>
                            <h4 className="text-lg font-bold text-white mb-2">{step.title}</h4>
                            <p className="text-slate-400 text-sm max-w-[200px]">{step.desc}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Features Grid */}
            <div className={`w-full max-w-6xl transition-all duration-700 delay-200 mb-20 ${savedClusters.length > 0 ? 'opacity-50 hover:opacity-100' : 'opacity-100'}`}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {[
                        { title: "Multi-OS", icon: Server, desc: "Ubuntu, Debian, RHEL, Rocky, Alma, Fedora, Amazon Linux — and CentOS 7 up to Kubernetes 1.34.", color: "blue" },
                        { title: "Safe Upgrades", icon: Rocket, desc: "Kubernetes 1.27 → 1.37, one version at a time. Safety check for blockers, automatic etcd snapshot first, clear failure reasons, auto-retry.", color: "cyan" },
                        { title: "Add-ons, Managed", icon: Package, desc: "Ingress, Prometheus + Grafana, Dashboard, cert-manager, Longhorn, ArgoCD, S3, Velero, Explorer — install, repair, uninstall and logs from the UI.", color: "pink" },
                        { title: "Backups & Restore", icon: Database, desc: "Verified etcd snapshots, a preview of every restore with automatic rollback and undo, volume data backups (Velero), encrypted offsite copies and disaster recovery.", color: "emerald" },
                        { title: "Auto-Healing", icon: HeartPulse, desc: "Detects NotReady nodes, disk / memory pressure and crash-looping pods, fixes what it safely can, and alerts you on Telegram, Slack, Teams, WhatsApp or email.", color: "orange" },
                        { title: "Resume & Scale", icon: RotateCcw, desc: "A stopped install resumes where it left off; add nodes any time. HA control-planes share a floating virtual IP (kube-vip).", color: "purple" },
                        { title: "Topology & Terminal", icon: Network, desc: "Live 3D topology, CPU / memory / disk and a browser terminal on every node.", color: "blue" },
                        { title: "KubeEZ Explorer", icon: Compass, desc: "Every resource, logs, timeline, Helm, GitOps and a 31-check health audit — inside KubeEZ, with your login and role.", color: "cyan" },
                        { title: "Gateway Agent", icon: Shield, desc: "Manage private servers through an outbound tunnel — no inbound firewall ports.", color: "cyan" },
                        { title: "Teams & Roles", icon: Users, desc: "Admin, Operator and Viewer roles in isolated workspaces. Viewers never see credentials.", color: "emerald" }
                    ].map((feature, i) => (
                        <div key={i} className="p-8 rounded-[32px] bg-slate-900/40 backdrop-blur-xl border border-white/5 hover:border-white/20 transition-all group relative overflow-hidden">
                            <div className={`absolute -right-8 -bottom-8 w-24 h-24 ${TONE[feature.color].bg} blur-2xl rounded-full group-hover:scale-150 transition-transform`}></div>
                            <div className={`w-14 h-14 rounded-2xl ${TONE[feature.color].bg} flex items-center justify-center mb-6 group-hover:scale-110 transition-transform border ${TONE[feature.color].border}`}>
                                <feature.icon className={`w-7 h-7 ${TONE[feature.color].text}`} />
                            </div>
                            <h4 className="text-xl font-bold text-white mb-3 tracking-tight">{feature.title}</h4>
                            <p className="text-slate-400 text-sm leading-relaxed">{feature.desc}</p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
