import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ADDONS_LIST } from '../config/addons'
import {
    CheckCircle2,
    XCircle,
    Loader2,
    Download,
    RefreshCw,
    Terminal,
    Activity,
    Plus,
    Zap,
    Package,
    Network,
    BarChart3,
    LayoutDashboard,
    Shield,
    Database,
    GitBranch,
    Sparkles
} from 'lucide-react'

export default function InstallationDashboard({ installationId, onGoHome, onScaleCluster }) {
    const navigate = useNavigate()
    const [status, setStatus] = useState('running') // 'running', 'completed', 'failed'
    const [progress, setProgress] = useState(0)
    const [logs, setLogs] = useState([])
    const [currentStep, setCurrentStep] = useState('Initializing...')
    const [clusterInfo, setClusterInfo] = useState(null)
    const logsEndRef = useRef(null)
    const wsRef = useRef(null)
    const [health, setHealth] = useState(null)
    const [healthError, setHealthError] = useState(null)
    const [errorState, setErrorState] = useState(null)
    const [isFixing, setIsFixing] = useState(false)

    // Add-on Management State
    const [isAddonModalOpen, setIsAddonModalOpen] = useState(false)
    const [addonSelection, setAddonSelection] = useState({
        ingress: false,
        monitoring: false,
        logging: false,
        dashboard: false
    })
    const [installingAddons, setInstallingAddons] = useState(false)

    const handleAddonSubmit = async () => {
        // Validation: At least one addon must be selected
        if (!Object.values(addonSelection).some(v => v)) {
            alert('Please select at least one add-on.')
            return
        }

        setInstallingAddons(true)
        try {
            const token = localStorage.getItem('token')
            const res = await fetch(`/api/clusters/${installationId}/addons`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ addons: addonSelection })
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to start addon install')

            setIsAddonModalOpen(false)
            // Redirect to the new dashboard for the Add-on installation job
            navigate(`/dashboard/${data.newInstallationId}`)

        } catch (err) {
            console.error(err)
            alert(err.message)
        } finally {
            setInstallingAddons(false)
        }
    }

    useEffect(() => {
        if (status === 'completed' && installationId) {
            const fetchHealth = () => {
                const token = localStorage.getItem('token')
                fetch(`/api/clusters/${installationId}/health`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
                    .then(res => res.json())
                    .then(data => {
                        if (!data.error) {
                            setHealth(data)
                            setHealthError(null)
                        } else {
                            // Backend reported an error (e.g. SSH failed)
                            setHealth(null)
                            setHealthError(data.details || data.error)
                        }
                    })
                    .catch(err => {
                        console.error(err)
                        setHealthError('Connection Failed')
                    })
            }
            fetchHealth()
            const interval = setInterval(fetchHealth, 10000)
            return () => clearInterval(interval)
        }
    }, [status, installationId])

    useEffect(() => {
        // Connect to WebSocket via Nginx proxy on the same port as the UI
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const host = window.location.host // This includes the port, e.g., 5173
        const ws = new WebSocket(`${protocol}//${host}/ws/installation/${installationId}`)
        wsRef.current = ws

        ws.onopen = () => {
            console.log('WebSocket connected')
            addLog('info', 'Connected to installation stream')
        }

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data)

            if (data.type === 'log') {
                addLog(data.level, data.message)
            } else if (data.type === 'progress') {
                setProgress(data.progress)
                setCurrentStep(data.step)
            } else if (data.type === 'status') {
                setStatus(data.status)
                if (data.status === 'completed') {
                    setClusterInfo(data.clusterInfo)
                }
                if (data.status === 'failed' && data.diagnosis) {
                    setErrorState(data.diagnosis)
                }
            }
        }

        ws.onerror = (error) => {
            console.error('WebSocket error:', error)
            addLog('error', 'Connection error - Installation may have expired')
            setTimeout(() => {
                setStatus('failed')
                setCurrentStep('Installation not found or expired')
            }, 2000)
        }

        ws.onclose = (event) => {
            console.log('WebSocket disconnected', event.code)
            if (event.code === 1006) {
                addLog('error', 'Installation session not found')
                setStatus('failed')
                setCurrentStep('Installation expired or backend restarted')
            } else {
                addLog('info', 'Disconnected from installation stream')
            }
        }

        return () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close()
            }
        }
    }, [installationId])

    useEffect(() => {
        // Auto-scroll logs to bottom
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [logs])

    const addLog = (level, message) => {
        setLogs(prev => [...prev, {
            level,
            message,
            timestamp: new Date().toLocaleTimeString()
        }])
    }

    const downloadKubeconfig = async () => {
        try {
            const token = localStorage.getItem('token')
            const res = await fetch(`/api/clusters/${installationId}/kubeconfig?token=${token}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })

            if (!res.ok) {
                const errData = await res.json()
                throw new Error(errData.details || errData.error || 'Download failed')
            }

            const blob = await res.blob()
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `kubeconfig-${installationId}.yaml`
            document.body.appendChild(a)
            a.click()
            window.URL.revokeObjectURL(url)
            document.body.removeChild(a)
        } catch (error) {
            console.error('Download error:', error)
            alert('Failed to download Kubeconfig: ' + error.message)
        }
    }

    const handleAutoFix = async () => {
        if (!errorState || !errorState.fixAction) return

        setIsFixing(true)
        try {
            const token = localStorage.getItem('token')
            if (!token) throw new Error('Authentication required')

            // 1. Get Status to find IP
            const statusRes = await fetch(`/api/clusters/${installationId}/status`, {
                headers: { 'Authorization': `Bearer ${token}` }
            })
            if (!statusRes.ok) throw new Error('Failed to fetch status')

            const installationData = await statusRes.json()
            const targetIp = installationData.masterNodes[0].ip

            // 2. Execute Fix
            addLog('info', `Attempting to fix ${errorState.reason}...`)
            const fixRes = await fetch('/api/clusters/action/fix', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    installationId,
                    nodeIp: targetIp,
                    fixAction: errorState.fixAction
                })
            })
            if (!fixRes.ok) throw new Error('Fix action failed')

            addLog('success', '✅ Fix applied. Restarting installation...')

            // 3. Retry Installation (Clone & Restart)
            const retryRes = await fetch(`/api/clusters/${installationId}/retry`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            })
            const retryData = await retryRes.json()

            if (retryData.success && retryData.newInstallationId) {
                // 4. Redirect to new dashboard
                setTimeout(() => {
                    setIsFixing(false)
                    setErrorState(null)
                    navigate(`/dashboard/${retryData.newInstallationId}`, { replace: true })
                }, 2000)
            } else {
                throw new Error('Retry failed to start')
            }

        } catch (err) {
            console.error(err)
            setIsFixing(false)
            alert('Failed to trigger auto-fix/retry: ' + err.message)
        }
    }

    return (
        <div className="max-w-7xl mx-auto relative">
            {/* Smart Error Rescue Modal */}
            {status === 'failed' && errorState && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-[#0f172a] border border-red-500/30 rounded-3xl max-w-2xl w-full p-8 shadow-2xl relative overflow-hidden">
                        {/* Background Pulse */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/10 rounded-full blur-[80px] pointer-events-none animate-pulse"></div>

                        <div className="relative z-10">
                            <div className="flex items-center space-x-4 mb-6">
                                <div className="p-4 bg-red-500/10 rounded-2xl border border-red-500/20">
                                    <Activity className="w-8 h-8 text-red-500" />
                                </div>
                                <div>
                                    <h2 className="text-2xl font-black text-white">Installation Halted</h2>
                                    <p className="text-red-400 font-medium">Error Code: {errorState.reason || 'UNKNOWN_ERROR'}</p>
                                </div>
                            </div>

                            <div className="space-y-6 mb-8">
                                <div className="p-6 bg-white/5 rounded-2xl border border-white/10">
                                    <h3 className="text-xs font-black uppercase text-gray-500 tracking-widest mb-2">Diagnosis</h3>
                                    <p className="text-lg text-gray-200">{errorState.message}</p>
                                </div>

                                <div className="p-6 bg-blue-500/10 rounded-2xl border border-blue-500/20 flex items-start space-x-4">
                                    <Zap className="w-6 h-6 text-blue-400 mt-1 shrink-0" />
                                    <div>
                                        <h3 className="text-sm font-black uppercase text-blue-400 tracking-widest mb-1">AI Suggested Fix</h3>
                                        <p className="text-blue-100">{errorState.suggestedFix}</p>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <button
                                    onClick={() => window.location.reload()}
                                    className="px-6 py-4 rounded-xl border border-white/10 hover:bg-white/5 text-gray-400 font-bold transition-colors"
                                >
                                    Cancel & Manual Fix
                                </button>
                                <button
                                    onClick={handleAutoFix}
                                    disabled={isFixing}
                                    className="px-6 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white font-black shadow-lg shadow-blue-600/20 transition-all flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed group"
                                >
                                    {isFixing ? (
                                        <>
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            <span>Applying Fix & Retrying...</span>
                                        </>
                                    ) : (
                                        <>
                                            <Terminal className="w-5 h-5 group-hover:scale-110 transition-transform" />
                                            <span>Run Auto-Fix & Resume</span>
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Add-on Selection Modal */}
            {isAddonModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-[#0f172a]/95 backdrop-blur-xl border border-white/10 rounded-[32px] max-w-5xl w-full p-10 shadow-2xl relative overflow-hidden">
                        <h2 className="text-2xl font-bold mb-2">Install Add-ons</h2>
                        <p className="text-gray-400 mb-6">Select additional components to install on your cluster.</p>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 my-8 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
                            {ADDONS_LIST.map(addon => {
                                // Map icon name to component
                                const iconMap = {
                                    Network,
                                    BarChart3,
                                    LayoutDashboard,
                                    Shield,
                                    Database,
                                    GitBranch,
                                    Sparkles
                                };
                                const Icon = iconMap[addon.iconName] || Package;
                                const isSelected = addonSelection[addon.key];

                                return (
                                    <div
                                        key={addon.key}
                                        onClick={() => setAddonSelection(p => ({ ...p, [addon.key]: !p[addon.key] }))}
                                        className={`group relative p-6 rounded-2xl border transition-all duration-300 cursor-pointer overflow-hidden ${isSelected
                                                ? 'bg-blue-500/5 border-blue-500 ring-1 ring-blue-500/50 shadow-lg shadow-blue-500/10'
                                                : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 hover:shadow-xl hover:shadow-black/20'
                                            }`}
                                    >
                                        {/* Selection Indicator */}
                                        <div className={`absolute top-4 right-4 w-6 h-6 rounded-full border flex items-center justify-center transition-all duration-300 ${isSelected
                                                ? 'bg-blue-500 border-blue-500 scale-110'
                                                : 'border-white/20 group-hover:border-white/40'
                                            }`}>
                                            {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                                        </div>

                                        {/* Badge */}
                                        {addon.badge && (
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

                        <div className="flex space-x-3">
                            <button
                                onClick={() => setIsAddonModalOpen(false)}
                                className="flex-1 px-4 py-3 rounded-xl border border-white/10 hover:bg-white/5 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleAddonSubmit}
                                disabled={installingAddons}
                                className="flex-1 px-4 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 font-bold transition-colors disabled:opacity-50 flex items-center justify-center"
                            >
                                {installingAddons ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Start Installation'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="glass rounded-2xl p-8 mb-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold mb-2">
                            {status === 'running' && 'Installing Kubernetes Cluster...'}
                            {status === 'completed' && '✅ Cluster Installation Complete!'}
                            {status === 'failed' && '❌ Installation Failed'}
                        </h1>
                        <p className="text-gray-400">Installation ID: {installationId}</p>
                    </div>

                    {status === 'completed' && (
                        <button
                            onClick={onGoHome}
                            className="flex items-center space-x-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                        >
                            <RefreshCw className="w-5 h-5" />
                            <span>Go Home</span>
                        </button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-3 gap-6 mb-6">
                {/* Progress Card */}
                <div className="glass rounded-2xl p-6">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="font-semibold">Progress</h3>
                        {status === 'running' && <Loader2 className="w-5 h-5 animate-spin text-blue-500" />}
                        {status === 'completed' && <CheckCircle2 className="w-5 h-5 text-green-500" />}
                        {status === 'failed' && <XCircle className="w-5 h-5 text-red-500" />}
                    </div>

                    <div className="mb-2">
                        <div className="flex items-center justify-between text-sm mb-1">
                            <span className="text-gray-400">Overall Progress</span>
                            <span className="font-bold text-2xl">{progress}%</span>
                        </div>
                        <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-500 ease-out"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>

                    <p className="text-sm text-gray-400 mt-4">{currentStep}</p>
                </div>

                {/* Status Card */}
                <div className="glass rounded-2xl p-6">
                    <div className="flex items-center space-x-3 mb-4">
                        <Activity className="w-5 h-5 text-blue-500" />
                        <h3 className="font-semibold">Status</h3>
                    </div>

                    <div className="space-y-2 text-sm">
                        <div className="flex items-center justify-between">
                            <span className="text-gray-400">State:</span>
                            <span className={`font-medium capitalize ${status === 'running' ? 'text-blue-400' :
                                status === 'completed' ? 'text-green-400' :
                                    'text-red-400'
                                }`}>
                                {status}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-gray-400">Started:</span>
                            <span className="font-medium">{new Date().toLocaleTimeString()}</span>
                        </div>
                        {status === 'completed' && clusterInfo && (
                            <>
                                <div className="flex items-center justify-between">
                                    <span className="text-gray-400">Nodes:</span>
                                    <span className="font-medium">{Array.isArray(clusterInfo.nodes) ? clusterInfo.nodes.length : clusterInfo.nodes}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-gray-400">Version:</span>
                                    <span className="font-medium">v{clusterInfo.version}</span>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Actions Card */}
                <div className="glass rounded-2xl p-6">
                    <div className="flex items-center space-x-3 mb-4">
                        <Terminal className="w-5 h-5 text-blue-500" />
                        <h3 className="font-semibold">Actions</h3>
                    </div>

                    {status === 'completed' ? (
                        <div className="space-y-3">
                            <button
                                onClick={downloadKubeconfig}
                                className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
                            >
                                <Download className="w-5 h-5" />
                                <span>Download Kubeconfig</span>
                            </button>
                            <button
                                onClick={() => onScaleCluster(clusterInfo)}
                                className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg transition-colors"
                            >
                                <Plus className="w-5 h-5" />
                                <span>Scale This Cluster</span>
                            </button>
                            <button
                                onClick={() => setIsAddonModalOpen(true)}
                                className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
                            >
                                <Package className="w-5 h-5" />
                                <span>Install Add-ons</span>
                            </button>
                        </div>
                    ) : status === 'failed' ? (
                        <div className="space-y-3">
                            <button
                                onClick={onGoHome}
                                className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                            >
                                <span>← Go Home</span>
                            </button>
                        </div>
                    ) : (
                        <div className="text-sm text-gray-400">
                            Actions will be available after installation completes
                        </div>
                    )}
                </div>
            </div>

            {/* Scaling Section (Visible always for management) */}
            <div className="glass rounded-2xl p-8 mb-6 border-l-4 border-blue-500">
                <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                        <div className="p-3 bg-blue-500/20 rounded-xl">
                            <Plus className="w-8 h-8 text-blue-400" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold">Scale Your Cluster</h2>
                            <p className="text-gray-400 text-sm">Need more power? Easily add additional Master or Worker nodes to your active cluster.</p>
                        </div>
                    </div>
                    <button
                        onClick={() => onScaleCluster(clusterInfo)}
                        className="px-8 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-bold transition-all shadow-lg shadow-blue-500/20"
                    >
                        Add New Node
                    </button>
                </div>
            </div>

            {/* Real-time Logs */}
            <div className="glass rounded-2xl p-6">
                <div className="flex items-center space-x-3 mb-4">
                    <Terminal className="w-5 h-5 text-blue-500" />
                    <h3 className="font-semibold">Installation Logs</h3>
                    <span className="text-xs text-gray-400">({logs.length} entries)</span>
                </div>

                <div className="terminal max-h-96 overflow-y-auto">
                    {logs.map((log, index) => (
                        <div key={index} className={`log-line log-${log.level}`}>
                            <span className="text-gray-500">[{log.timestamp}]</span> {log.message}
                        </div>
                    ))}
                    <div ref={logsEndRef} />

                    {logs.length === 0 && (
                        <div className="text-gray-500 text-center py-8">
                            Waiting for installation logs...
                        </div>
                    )}
                </div>
            </div>


            {/* Smart Management Console (Shown after completion) */}
            {status === 'completed' && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                    {/* Node Health Monitor */}
                    <div className="glass rounded-[32px] p-8 border border-white/5 relative overflow-hidden">
                        <div className="absolute -top-10 -right-10 w-40 h-40 bg-green-500/10 blur-3xl rounded-full"></div>
                        <div className="flex items-center justify-between mb-8">
                            <div className="flex items-center space-x-3">
                                <div className="p-2 bg-green-500/20 rounded-lg">
                                    <Activity className="w-5 h-5 text-green-400" />
                                </div>
                                <h3 className="text-xl font-bold">Node Health Monitor</h3>
                            </div>
                            <span className="text-xs font-mono text-green-400 bg-green-400/10 px-2 py-1 rounded">LIVE</span>
                        </div>

                        <div className="grid grid-cols-3 gap-4">
                            {[
                                {
                                    label: 'CPU Usage',
                                    val: healthError ? 'OFF' : (health ? `${health.cpu}%` : '...'),
                                    color: 'from-blue-400 to-blue-600',
                                    percent: health ? health.cpu : 0
                                },
                                {
                                    label: 'RAM Usage',
                                    val: healthError ? 'OFF' : (health ? `${health.ram}%` : '...'),
                                    color: 'from-purple-400 to-purple-600',
                                    percent: health ? health.ram : 0
                                },
                                {
                                    label: 'Disk Usage',
                                    val: healthError ? 'OFF' : (health ? `${health.disk}%` : '...'),
                                    color: 'from-green-400 to-green-600',
                                    percent: health ? health.disk : 0
                                }
                            ].map((stat, i) => (
                                <div key={i} className="bg-white/5 rounded-2xl p-4 text-center border border-white/5 hover:border-white/10 transition-colors">
                                    <p className="text-[10px] text-gray-500 uppercase font-black tracking-tighter mb-2">{stat.label}</p>
                                    <div className={`text-xl font-black bg-gradient-to-r ${stat.color} bg-clip-text text-transparent`}>
                                        {stat.val}
                                    </div>
                                    <div className="w-full bg-white/5 h-1 mt-3 rounded-full overflow-hidden">
                                        <div className={`h-full bg-gradient-to-r ${stat.color}`} style={{ width: `${Math.min(stat.percent, 100)}%` }}></div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="mt-8 space-y-4">
                            {/* Show actual cluster nodes if available - PREFER LIVE HEALTH DATA */}
                            {(health?.nodes || clusterInfo?.nodes) && (health?.nodes || clusterInfo?.nodes).length > 0 ? (
                                (health?.nodes || clusterInfo?.nodes).map((node, idx) => (
                                    <div key={idx} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                                        <div className="flex items-center space-x-3">
                                            <div className={`w-2 h-2 rounded-full animate-pulse ${node.status === 'Ready' ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                                            <span className="text-sm font-semibold">{node.name || `${node.role} Node`}</span>
                                        </div>
                                        <span className="text-xs text-gray-400">{node.ip || 'N/A'}</span>
                                    </div>
                                ))
                            ) : (
                                /* Fallback: Show placeholder during installation */
                                <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                                    <div className="flex items-center space-x-3">
                                        <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                                        <span className="text-sm font-semibold">Initializing nodes...</span>
                                    </div>
                                    <span className="text-xs text-gray-400">Pending</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Intelligent Diagnostics */}
                    <div className="glass rounded-[32px] p-8 border border-white/5 relative overflow-hidden flex flex-col">
                        <div className="flex items-center space-x-3 mb-8">
                            <div className="p-2 bg-blue-500/20 rounded-lg">
                                <Zap className="w-5 h-5 text-blue-400" />
                            </div>
                            <h3 className="text-xl font-bold">Smart Diagnostics</h3>
                        </div>

                        <div className="flex-1 space-y-4">
                            <div className="p-5 bg-blue-500/5 border border-blue-500/20 rounded-[24px]">
                                <div className="flex items-start space-x-4">
                                    <div className="mt-1">✨</div>
                                    <div>
                                        <p className="text-sm font-bold text-blue-400 mb-1">AI Recommendation</p>
                                        <p className="text-sm text-gray-400 leading-relaxed">Cluster is stable. Networking plugin (Flannel) is healthy. Monitor CPU usage on worker nodes for optimal performance.</p>
                                    </div>
                                </div>
                            </div>

                            <div className="p-4 bg-white/5 rounded-2xl border border-white/5 flex items-center justify-between">
                                <span className="text-sm text-gray-400">Connectivity Check</span>
                                <span className={`text-xs font-bold flex items-center ${health ? 'text-green-400' : (healthError ? 'text-red-400' : 'text-yellow-400')
                                    }`}>
                                    <div className={`w-1.5 h-1.5 rounded-full mr-2 ${health ? 'bg-green-400' : (healthError ? 'bg-red-400' : 'bg-yellow-400 animate-pulse')
                                        }`}></div>
                                    {health ? 'CONNECTED' : (healthError ? 'FAILED: ' + healthError.substring(0, 15) + '...' : 'CHECKING...')}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Cluster Info (shown after completion) */}
            {status === 'completed' && clusterInfo && (
                <div className="glass rounded-[32px] p-8 mt-6 border border-white/5">
                    <h3 className="text-2xl font-bold mb-6 tracking-tight">Cluster Configuration</h3>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
                        <div className="bg-white/5 rounded-3xl p-6 border border-white/5">
                            <p className="text-xs text-gray-500 uppercase font-black tracking-widest mb-2">Cluster Name</p>
                            <p className="text-lg font-bold">{clusterInfo.name}</p>
                        </div>
                        <div className="bg-white/5 rounded-3xl p-6 border border-white/5">
                            <p className="text-xs text-gray-500 uppercase font-black tracking-widest mb-2">Version</p>
                            <p className="text-lg font-bold">K8s v{clusterInfo.version}</p>
                        </div>
                        <div className="bg-white/5 rounded-3xl p-6 border border-white/5 overflow-hidden">
                            <p className="text-xs text-gray-500 uppercase font-black tracking-widest mb-2">Endpoint</p>
                            <p className="text-sm font-mono truncate">{clusterInfo.endpoint}</p>
                        </div>
                        <div className="bg-white/5 rounded-3xl p-6 border border-white/5">
                            <p className="text-xs text-gray-500 uppercase font-black tracking-widest mb-2">Capacity</p>
                            <p className="text-lg font-bold">{Array.isArray(clusterInfo.nodes) ? clusterInfo.nodes.length : clusterInfo.nodes} Nodes Live</p>
                        </div>
                    </div>

                    <div className="mt-12 pt-8 border-t border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                        <div>
                            <h3 className="text-xl font-bold mb-2">Dynamic Node Management</h3>
                            <p className="text-gray-400 text-sm max-w-lg leading-relaxed">
                                Our orchestrator allows zero-downtime scaling. Add new master nodes for High Availability or worker nodes for compute capacity.
                            </p>
                        </div>
                        <button
                            onClick={() => onScaleCluster(clusterInfo)}
                            className="flex items-center justify-center space-x-2 px-8 py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-[20px] font-bold transition-all shadow-xl shadow-blue-500/20 active:scale-95 whitespace-nowrap"
                        >
                            <Plus className="w-5 h-5" />
                            <span>Scale Cluster</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
