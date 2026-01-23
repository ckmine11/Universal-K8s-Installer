import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    Activity,
    Server,
    Cpu,
    Network,
    Zap,
    Download,
    Plus,
    ArrowLeft,
    Trash2,
    Layers,
    Box,
    List
} from 'lucide-react'
import ClusterTopology3D from '../components/ClusterTopology3D'

export default function ClusterDetails({ onScaleCluster }) {
    const { id } = useParams()
    const navigate = useNavigate()
    const [cluster, setCluster] = useState(null)
    const [loading, setLoading] = useState(true)
    const [health, setHealth] = useState(null)
    const [healthLoading, setHealthLoading] = useState(true)

    const [viewMode, setViewMode] = useState('3d') // 'list' | '3d'

    useEffect(() => {
        const token = localStorage.getItem('token')
        // 1. Fetch Cluster Config
        fetch('/api/clusters/list', {
            headers: { 'Authorization': `Bearer ${token}` }
        })
            .then(res => res.json())
            .then(data => {
                const found = data.find(c => c.id === id)
                if (found) {
                    setCluster(found)
                } else {
                    navigate('/')
                }
            })
            .catch(() => navigate('/'))
            .finally(() => setLoading(false))

        // 2. Fetch Real Health Data
        fetchHealthData()
        const interval = setInterval(fetchHealthData, 30000) // Poll every 30s
        return () => clearInterval(interval)
    }, [id, navigate])

    const fetchHealthData = () => {
        const token = localStorage.getItem('token')
        fetch(`/api/clusters/${id}/health`, {
            headers: { 'Authorization': `Bearer ${token}` }
        })
            .then(res => res.json())
            .then(data => {
                if (!data.error) {
                    setHealth(data)
                }
            })
            .catch(err => console.error("Health fetch failed:", err))
            .finally(() => setHealthLoading(false))
    }

    const downloadKubeconfig = () => {
        // Trigger download from backend API
        const token = localStorage.getItem('token')
        window.location.href = `/api/clusters/${id}/kubeconfig?token=${token}`
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen text-blue-500">
                <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-current"></div>
            </div>
        )
    }

    if (!cluster) return null

    // Determine nodes list (merge with real status if available)
    const masterNodes = cluster.masterNodes || []
    const workerNodes = cluster.workerNodes || []
    let allNodes = [...masterNodes.map(n => ({ ...n, role: 'master' })), ...workerNodes.map(n => ({ ...n, role: 'worker' }))]

    if (health?.nodes) {
        // Update status based on real data
        allNodes = allNodes.map(node => {
            // Match by name or IP (simple heuristic)
            const realNode = health.nodes.find(n => n.name.includes(node.hostname) || n.name.includes(node.ip) || n.name.includes(node.role))
            return {
                ...node,
                status: realNode ? realNode.status : 'Unknown'
            }
        })
    }

    return (
        <div className="max-w-7xl mx-auto py-8 px-4">
            {/* Header */}
            <div className="flex items-center space-x-4 mb-8">
                <button
                    onClick={() => navigate('/')}
                    className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                    <ArrowLeft className="w-6 h-6 text-slate-400" />
                </button>
                <div>
                    <h1 className="text-3xl font-black text-white tracking-tight">{cluster.clusterName}</h1>
                    <div className="flex items-center space-x-3 text-slate-400 text-sm mt-1">
                        <span className="flex items-center"><Activity className="w-4 h-4 mr-1 text-green-400" /> Active</span>
                        <span>•</span>
                        <span>ID: {cluster.id}</span>
                        <span>•</span>
                        <span>Created: {new Date(cluster.createdAt).toLocaleDateString()}</span>
                    </div>
                </div>
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div className="glass p-6 rounded-2xl border border-white/5">
                    <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-2">Kubernetes Version</p>
                    <p className="text-xl font-bold text-white flex items-center">
                        <Layers className="w-6 h-6 mr-2 text-blue-400" />
                        v{cluster.k8sVersion}
                    </p>
                </div>
                <div className="glass p-6 rounded-2xl border border-white/5">
                    <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-2">Network Plugin</p>
                    <p className="text-xl font-bold text-white flex items-center">
                        <Network className="w-5 h-5 mr-2 text-blue-400" />
                        {cluster.networkPlugin}
                    </p>
                </div>
                <div className="glass p-6 rounded-2xl border border-white/5">
                    <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-2">Total Nodes</p>
                    <p className="text-xl font-bold text-white flex items-center">
                        <Server className="w-5 h-5 mr-2 text-purple-400" />
                        {allNodes.length} Nodes
                    </p>
                </div>
                <div className="glass p-6 rounded-2xl border border-white/5">
                    <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-2">API Endpoint</p>
                    <p className="text-sm font-mono text-slate-300 truncate" title={`https://${masterNodes[0]?.ip}:6443`}>
                        https://{masterNodes[0]?.ip}:6443
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Actions & Nodes */}
                <div className="lg:col-span-2 space-y-6">

                    {/* Action Bar */}
                    <div className="glass p-4 rounded-2xl border border-white/5 flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                            <div className={`w-2 h-2 rounded-full animate-pulse ${health ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                            <span className={`text-sm font-bold uppercase tracking-wide ${health ? 'text-green-400' : 'text-yellow-400'}`}>
                                {health ? 'System Healthy' : 'Connecting...'}
                            </span>
                        </div>
                        <div className="flex items-center space-x-3">
                            <button
                                onClick={downloadKubeconfig}
                                className="flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-sm font-bold transition-all border border-white/5"
                            >
                                <Download className="w-4 h-4 mr-2" />
                                Kubeconfig
                            </button>
                            <button
                                onClick={() => onScaleCluster(cluster)}
                                className="flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold transition-all shadow-lg shadow-blue-600/20"
                            >
                                <Plus className="w-4 h-4 mr-2" />
                                Scale Cluster
                            </button>
                        </div>
                    </div>

                    {/* Nodes List */}
                    {/* Nodes Visualization */}
                    <div className="glass rounded-[32px] p-8 border border-white/5 overflow-hidden relative">
                        <div className="flex items-center justify-between mb-6 relative z-10">
                            <h3 className="text-xl font-bold text-white">Cluster Topology</h3>
                            <div className="flex bg-white/5 p-1 rounded-xl border border-white/5">
                                <button
                                    onClick={() => setViewMode('list')}
                                    className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-blue-500 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
                                    title="List View"
                                >
                                    <List className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => setViewMode('3d')}
                                    className={`p-2 rounded-lg transition-all ${viewMode === '3d' ? 'bg-blue-500 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
                                    title="3D View"
                                >
                                    <Box className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        {viewMode === '3d' ? (
                            <div className="h-[500px] w-full bg-black/20 rounded-2xl border border-white/5 overflow-hidden">
                                <ClusterTopology3D clusterInfo={{
                                    nodes: allNodes.map((n, idx) => ({
                                        ip: n.ip || `10.0.0.${idx}`,
                                        hostname: n.hostname || `node-${idx}`,
                                        role: n.role,
                                        status: n.status
                                    }))
                                }} />
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {allNodes.map((node, i) => (
                                    <div key={i} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5 hover:border-white/10 transition-colors group">
                                        <div className="flex items-center space-x-4">
                                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${node.role === 'master' ? 'bg-purple-500/10 text-purple-400' : 'bg-blue-500/10 text-blue-400'}`}>
                                                <Server className="w-5 h-5" />
                                            </div>
                                            <div>
                                                <p className="font-bold text-white">{node.hostname || `${node.role.charAt(0).toUpperCase() + node.role.slice(1)} Node`}</p>
                                                <p className="text-xs text-slate-500 font-mono">{node.ip}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center space-x-6">
                                            <div className="text-right">
                                                <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest">Role</p>
                                                <p className="text-sm font-bold text-slate-300 capitalize">{node.role}</p>
                                            </div>
                                            <div className="text-right">
                                                <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest">Status</p>
                                                <div className={`flex items-center justify-end text-sm font-bold ${node.status === 'Ready' ? 'text-emerald-400' : 'text-yellow-400'}`}>
                                                    <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${node.status === 'Ready' ? 'bg-emerald-400' : 'bg-yellow-400'}`}></span>
                                                    {node.status || 'Unknown'}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Right Column: Health & Diagnostics (Real Data) */}
                <div className="space-y-6">
                    {/* Health Monitor */}
                    <div className="glass rounded-[32px] p-8 border border-white/5 relative overflow-hidden">
                        <div className="absolute -top-20 -right-20 w-60 h-60 bg-blue-500/10 blur-[80px] rounded-full pointer-events-none"></div>
                        <div className="flex items-center justify-between mb-6 relative z-10">
                            <h3 className="text-xl font-bold text-white">Live Metrics</h3>
                            {healthLoading && <div className="text-xs text-blue-400 animate-pulse">Syncing...</div>}
                        </div>

                        {health ? (
                            <div className="space-y-6 relative z-10 animate-in fade-in duration-500">
                                <div>
                                    <div className="flex justify-between text-sm mb-2">
                                        <span className="text-slate-400">Cluster CPU</span>
                                        <span className="text-blue-400 font-bold">{health.cpu}%</span>
                                    </div>
                                    <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                                        <div className="h-full bg-blue-500 rounded-full transition-all duration-1000" style={{ width: `${Math.min(health.cpu, 100)}%` }}></div>
                                    </div>
                                </div>
                                <div>
                                    <div className="flex justify-between text-sm mb-2">
                                        <span className="text-slate-400">Cluster Memory</span>
                                        <span className="text-purple-400 font-bold">{health.ram}%</span>
                                    </div>
                                    <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                                        <div className="h-full bg-purple-500 rounded-full transition-all duration-1000" style={{ width: `${Math.min(health.ram, 100)}%` }}></div>
                                    </div>
                                </div>
                                <div>
                                    <div className="flex justify-between text-sm mb-2">
                                        <span className="text-slate-400">Storage (Root)</span>
                                        <span className="text-green-400 font-bold">{health.disk}%</span>
                                    </div>
                                    <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                                        <div className="h-full bg-green-500 rounded-full transition-all duration-1000" style={{ width: `${Math.min(health.disk, 100)}%` }}></div>
                                    </div>
                                </div>
                                <div className="text-right text-[10px] text-slate-600 font-mono mt-2">
                                    Last Check: {new Date(health.timestamp).toLocaleTimeString()}
                                </div>
                            </div>
                        ) : (
                            <div className="py-8 text-center text-slate-500 text-sm">
                                {healthLoading ? 'Connecting to Cluster...' : 'Metrics Unavailable'}
                            </div>
                        )}

                        <div className="mt-8 pt-6 border-t border-white/10">
                            <div className="flex items-center space-x-3 text-sm text-slate-400">
                                <Zap className="w-4 h-4 text-yellow-400" />
                                <span>Optimization Tips:</span>
                            </div>
                            <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                                {health && health.cpu > 80 ? 'High CPU usage detected. Consider adding more worker nodes.' :
                                    health && health.ram > 80 ? 'High Memory usage detected. Check for memory leaks or scale up.' :
                                        'Cluster is running within optimal parameters.'}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
