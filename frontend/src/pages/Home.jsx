import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Server, Zap, Plus, Settings, Cpu, Network, Rocket, Trash2, ExternalLink } from 'lucide-react'

export default function Home({ onStartNew, onScaleExisting }) {
    const navigate = useNavigate()
    const [savedClusters, setSavedClusters] = useState([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetchSavedClusters()
    }, [])

    const fetchSavedClusters = async () => {
        try {
            const token = localStorage.getItem('token')
            const response = await fetch('/api/clusters/list', {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            const data = await response.json()
            setSavedClusters(data)
        } catch (error) {
            console.error('Failed to fetch clusters:', error)
        } finally {
            setLoading(false)
        }
    }

    const handleDeleteCluster = async (e, id) => {
        e.stopPropagation()
        if (!window.confirm('Are you sure you want to remove this cluster from management?')) return

        try {
            const token = localStorage.getItem('token')
            await fetch(`/api/clusters/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            })
            setSavedClusters(prev => prev.filter(c => c.id !== id))
        } catch (error) {
            alert('Failed to delete cluster record')
        }
    }
    return (
        <div className="relative max-w-7xl mx-auto py-8 px-4 min-h-[calc(100vh-100px)] flex flex-col justify-center items-center overflow-hidden">

            {/* Ambient Background Glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-blue-500/20 rounded-full blur-[120px] pointer-events-none opacity-50 animate-pulse"></div>

            {/* Main Action Cards */}
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

            {/* Managed Fleet Section - Only shows if relevant */}
            {savedClusters.length > 0 && (
                <div className="animate-in [animation-delay:500ms]">
                    <div className="flex items-center justify-between mb-8 px-4">
                        <div className="flex items-center space-x-4">
                            <div className="w-2 h-8 bg-gradient-to-b from-blue-500 to-blue-600 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.5)]"></div>
                            <div>
                                <h3 className="text-2xl font-black uppercase tracking-tight text-white">Active Infrastructure</h3>
                                <p className="text-slate-500 text-xs uppercase tracking-widest font-bold mt-1">Managed Kubernetes Fleet</p>
                            </div>
                        </div>
                        <span className="px-4 py-2 bg-blue-500/10 border border-blue-500/20 rounded-xl text-xs font-black text-blue-400 uppercase tracking-widest flex items-center gap-2">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                            </span>
                            {savedClusters.length} Clusters Online
                        </span>
                    </div>

                    <div className="grid grid-cols-1 gap-4">
                        {savedClusters.map((cluster) => (
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
                                    <button
                                        onClick={(e) => handleDeleteCluster(e, cluster.id)}
                                        className="p-4 bg-white/5 hover:bg-red-500/10 text-slate-600 hover:text-red-400 rounded-2xl border border-white/5 hover:border-red-500/20 transition-all opacity-0 group-hover:opacity-100"
                                        title="Remove from dashboard"
                                    >
                                        <Trash2 className="w-5 h-5" />
                                    </button>
                                    <div className="px-8 py-4 bg-blue-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg shadow-blue-600/20 group-hover:scale-105 transition-all flex items-center gap-2">
                                        <Settings className="w-4 h-4" />
                                        <span>Manage & Scale</span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
