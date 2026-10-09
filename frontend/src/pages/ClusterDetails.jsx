import { useState, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useToast } from '../components/ToastProvider'
import { apiFetch, useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { MAX_K8S_MINOR } from '../config/versions'
import Skeleton from '../components/Skeleton'
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
    Layers, Compass,
    List,
    Terminal,
    Globe,
    Command,
    Box,
    PlayCircle,
    AlertTriangle,
    ArrowUpCircle,
    Database,
    LayoutGrid,
    Package
} from 'lucide-react'
import ClusterTopology3D from '../components/ClusterTopology3D'
import OrbitalTerminal from '../components/OrbitalTerminal'
import ResumeModal from '../components/ResumeModal'
import AddonAccessPanel from '../components/AddonAccessPanel'
import AddonManagerPanel from '../components/AddonManagerPanel'
import BackupsTab from '../components/backups/BackupsTab'
import ExplorerTab from '../components/explorer/ExplorerTab'
import UpgradeSafetyCheck from '../components/explorer/UpgradeSafetyCheck'
import HealthScoreCard from '../components/explorer/HealthScoreCard'

// Page sections — one tab each, so nothing is buried in a long page
const TABS = [
    { key: 'overview', label: 'Overview', hint: 'nodes & health', Icon: LayoutGrid },
    { key: 'addons', label: 'Add-ons', hint: 'access, manage, logs', Icon: Package },
    { key: 'backups', label: 'Backups', hint: 'snapshots, volumes, recovery', Icon: Database },
    { key: 'explorer', label: 'Explorer', hint: 'resources, timeline, audit', Icon: Compass }
]
const ADDON_SECTIONS = [
    { key: 'access', label: 'Access & logins' },
    { key: 'manage', label: 'Manage & logs' }
]

export default function ClusterDetails({ onScaleCluster }) {
    const { toast } = useToast()
    const { user } = useAuth()
    const { id } = useParams()
    const navigate = useNavigate()

    // RBAC UI gating (backend enforces the real checks)
    const canUpgrade = can(user?.role, 'cluster:upgrade')
    const canScale = can(user?.role, 'cluster:scale')
    const canResume = can(user?.role, 'cluster:resume')
    const canManageAddons = can(user?.role, 'addon:install')
    const canKubeconfig = can(user?.role, 'kubeconfig:download')
    const canTerminal = can(user?.role, 'terminal:access')
    const [cluster, setCluster] = useState(null)
    const failedUpgrade = cluster?.status === 'failed' && cluster?.mode === 'upgrade'
    const [loading, setLoading] = useState(true)
    const [health, setHealth] = useState(null)
    const [healthLoading, setHealthLoading] = useState(true)
    const [healthError, setHealthError] = useState(null)   // { error, details } when live status can't be read

    const [viewMode, setViewMode] = useState('3d') // 'list' | '3d'
    const [isTerminalOpen, setIsTerminalOpen] = useState(false)
    const [upgradeModalOpen, setUpgradeModalOpen] = useState(false)
    const [targetVersion, setTargetVersion] = useState('')
    const [upgradeLoading, setUpgradeLoading] = useState(false)
    const [safety, setSafety] = useState(null)          // upgrade safety check result (Explorer)
    const [acceptBlockers, setAcceptBlockers] = useState(false)
    const [resumeModalOpen, setResumeModalOpen] = useState(false)

    // Open tab + add-on section live in the URL (?tab=addons&section=manage):
    // refresh, back button and shared links keep the user where they were
    const [params, setParams] = useSearchParams()
    const tab = TABS.some(t => t.key === params.get('tab')) ? params.get('tab') : 'overview'
    const section = ADDON_SECTIONS.some(s => s.key === params.get('section')) ? params.get('section') : 'access'
    const setTab = (key) => setParams(key === 'overview' ? {} : { tab: key })
    const setSection = (key) => setParams({ tab: 'addons', section: key }, { replace: true })

    // Calculate next version options
    const currentVersion = cluster?.k8sVersion || '1.28.0'
    const minorVersion = parseInt(currentVersion.split('.')[1])
    const availableUpgrades = []
    // STRICT SAFETY: Only allow next minor version (n+1) to prevent skip-level failures
    // Kubeadm cannot upgrade across multiple minor versions (e.g. 1.28 -> 1.30 is forbidden).
    // Cap at the highest supported minor (derived from K8S_VERSIONS, not hardcoded).
    if (minorVersion < MAX_K8S_MINOR) availableUpgrades.push(`1.${minorVersion + 1}.0`)

    const handleUpgrade = () => {
        if (!targetVersion) return
        setUpgradeLoading(true)

        apiFetch(`/api/clusters/${id}/upgrade`, {
            method: 'POST',
            body: JSON.stringify({ targetVersion, skipSafetyCheck: acceptBlockers })
        })
            .then(res => res.json())
            .then(data => {
                if (data.safetyCheck) setSafety(data.safetyCheck)
                if (data.success) {
                    // Redirect to installation view to watch progress
                    navigate(`/dashboard/${data.newInstallationId}`)
                } else {
                    toast({
                        title: 'Upgrade Failed',
                        message: data.error,
                        type: 'error'
                    })
                }
            })
            .catch(err => {
                toast({
                    title: 'Upgrade Error',
                    message: err.message,
                    type: 'error'
                })
            })
            .finally(() => setUpgradeLoading(false))
    }

    useEffect(() => {
        // 1. Fetch Cluster Config
        apiFetch('/api/clusters/list')
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
        const interval = setInterval(fetchHealthData, 15000) // Poll every 15s — catch transient node states
        return () => clearInterval(interval)
    }, [id, navigate])

    const fetchHealthData = () => {
        apiFetch(`/api/clusters/${id}/health`)
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    setHealthError({ error: data.error, details: data.details })
                } else {
                    setHealth(data)
                    setHealthError(data.nodesError ? { error: 'Connected, but the node list could not be read', details: data.nodesError } : null)
                }
            })
            .catch(err => setHealthError({ error: 'Could not reach KubeEZ', details: err.message }))
            .finally(() => setHealthLoading(false))
    }

    const downloadKubeconfig = async () => {
        const res = await apiFetch(`/api/clusters/${id}/kubeconfig`)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `kubeconfig-${id}.yaml`
        a.click()
        URL.revokeObjectURL(url)
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

    if (health?.nodes && health.nodes.length) {
        // Reliably map each configured node to its live kubectl status.
        // Old code matched on role ('worker') which mismapped multiple workers,
        // so a downed node could still show 'Ready'. Now: exact hostname match →
        // hostname substring → role+order fallback, each live node used once.
        const live = health.nodes.map(n => ({ ...n, _used: false }))
        const matchByHost = (node) => {
            if (!node.hostname) return null
            const h = node.hostname.toLowerCase()
            return live.find(n => !n._used && n.name.toLowerCase() === h)
                || live.find(n => !n._used && (n.name.toLowerCase().includes(h) || h.includes(n.name.toLowerCase())))
        }
        allNodes = allNodes.map(node => {
            let rn = matchByHost(node)
            if (!rn) {
                // Fallback: pair by role in order
                rn = live.find(n => !n._used && ((node.role === 'master') === (n.role === 'master')))
            }
            if (rn) rn._used = true
            return {
                ...node,
                status: rn ? rn.status : 'Unknown',
                // Fill IP/hostname from live cluster data if the stored config lacks it
                ip: node.ip || rn?.ip || node.host,
                hostname: node.hostname || rn?.name
            }
        })
    }

    const tabClass = (active) => `flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition-all ${active
        ? 'bg-gradient-to-r from-blue-500/25 to-violet-500/20 text-white shadow-[inset_0_0_0_1px_rgba(44,203,238,.35)]'
        : 'text-slate-400 hover:text-white hover:bg-white/5'}`
    const actionBtn = 'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all active:scale-95'

    return (
        <div className="max-w-7xl mx-auto">
            {/* Resume Modal — rendered at root so it overlays entire page */}
            {resumeModalOpen && (
                <ResumeModal
                    cluster={cluster}
                    onClose={() => setResumeModalOpen(false)}
                />
            )}

            {/* Header: name + status, and the cluster actions (available on every tab) */}
            <div className="flex flex-wrap items-center gap-4 mb-6">
                <button
                    onClick={() => navigate('/')}
                    className="p-2.5 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/10 transition-colors"
                    title="Back to clusters"
                >
                    <ArrowLeft className="w-5 h-5 text-slate-300" />
                </button>
                <div className="flex-1">
                    <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-300/80">Cluster</div>
                    <h1 className="font-display text-3xl font-bold text-white tracking-tight">{cluster.clusterName}</h1>
                    <div className="flex items-center space-x-3 text-slate-400 text-sm mt-1">
                        {(() => {
                            // Live health badge — derived from real node status, not the static field
                            const liveNodes = health?.nodes || []
                            const notReady = liveNodes.filter(n => n.status && n.status !== 'Ready')
                            if (cluster.status === 'failed') {
                                return <span className="flex items-center text-red-400"><AlertTriangle className="w-4 h-4 mr-1" /> {failedUpgrade ? 'Upgrade Failed' : 'Installation Failed'}</span>
                            }
                            if (cluster.status === 'cancelled') {
                                return <span className="flex items-center text-amber-400"><AlertTriangle className="w-4 h-4 mr-1" /> Installation Cancelled</span>
                            }
                            if (health?.error || (healthError && !health)) {
                                return <span className="flex items-center text-red-400"><AlertTriangle className="w-4 h-4 mr-1" /> Unreachable</span>
                            }
                            if (notReady.length > 0) {
                                return <span className="flex items-center text-amber-400"><AlertTriangle className="w-4 h-4 mr-1" /> Degraded — {notReady.length} node(s) not ready</span>
                            }
                            return <span className="flex items-center"><Activity className="w-4 h-4 mr-1 text-green-400" /> Active</span>
                        })()}
                        <span>•</span>
                        <span>ID: {cluster.id}</span>
                        <span>•</span>
                        <span>Created: {new Date(cluster.createdAt).toLocaleDateString()}</span>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canKubeconfig && (
                        <button onClick={downloadKubeconfig} className={`${actionBtn} bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/5`}>
                            <Download className="w-4 h-4" /> Kubeconfig
                        </button>
                    )}
                    {canTerminal && (
                        <button onClick={() => setIsTerminalOpen(true)} className={`${actionBtn} bg-slate-800 hover:bg-slate-700 text-blue-400 border border-blue-500/30`}>
                            <Terminal className="w-4 h-4" /> Terminal
                        </button>
                    )}
                    {canScale && (
                        <button onClick={() => onScaleCluster(cluster)} className={`${actionBtn} bg-white/5 hover:bg-white/10 text-white border border-white/10`}>
                            <Plus className="w-4 h-4" /> Scale
                        </button>
                    )}
                    {canUpgrade && availableUpgrades.length > 0 && (
                        <button onClick={() => setUpgradeModalOpen(true)} className={`${actionBtn} bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-600/20`}>
                            <ArrowUpCircle className="w-4 h-4" /> Upgrade to v{availableUpgrades[0]}
                        </button>
                    )}
                    {!canKubeconfig && !canUpgrade && !canTerminal && !canScale && (
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Read-only — view access</span>
                    )}
                </div>
            </div>

            {/* What went wrong + what to do — one place, with shortcuts */}
            {(cluster.status === 'failed' || cluster.status === 'cancelled') && (
                <div className="mb-6 flex flex-wrap items-center gap-3 p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 text-sm text-amber-200">
                    <AlertTriangle className="w-5 h-5 shrink-0 text-amber-400" />
                    <span className="flex-1 min-w-[16rem]">
                        {failedUpgrade
                            ? <>The upgrade failed. Usually the cluster still runs its previous version — retry the upgrade first. If the cluster is broken, restore the <b>Before upgrade (automatic)</b> snapshot.</>
                            : cluster.status === 'cancelled'
                                ? <>The installation was cancelled. Resume it to finish the remaining steps.</>
                                : <>The installation did not finish. Resume it — completed steps are skipped.</>}
                    </span>
                    {failedUpgrade ? (
                        <>
                            {canUpgrade && availableUpgrades.length > 0 && (
                                <button onClick={() => setUpgradeModalOpen(true)} className={`${actionBtn} bg-emerald-600 hover:bg-emerald-700 text-white`}>
                                    <ArrowUpCircle className="w-4 h-4" /> Retry upgrade
                                </button>
                            )}
                            <button onClick={() => setTab('backups')} className={`${actionBtn} bg-white/5 hover:bg-white/10 text-white border border-white/10`}>
                                <Database className="w-4 h-4" /> Restore a snapshot
                            </button>
                        </>
                    ) : canResume && (
                        <button onClick={() => setResumeModalOpen(true)} className={`${actionBtn} bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/20`}>
                            <PlayCircle className="w-4 h-4" /> Resume Installation
                        </button>
                    )}
                </div>
            )}

            {/* Tabs (the open tab is kept in the URL: ?tab=addons) */}
            <div role="tablist" className="sticky top-16 z-20 mb-6 p-1 rounded-2xl bg-[#070b16]/80 backdrop-blur-xl border border-white/10 flex gap-1 overflow-x-auto">
                {TABS.map(t => (
                    <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={tabClass(tab === t.key)}>
                        <t.Icon className="w-4 h-4" /> {t.label}
                        <span className="hidden md:inline text-[11px] font-medium opacity-60">{t.hint}</span>
                    </button>
                ))}
            </div>

            {/* ── Overview ─────────────────────────────────────────────── */}
            {tab === 'overview' && (
                <>
                    <div className="mb-6">
                        <HealthScoreCard clusterId={id} installed={!!cluster.addons?.explorer} onOpenExplorer={() => setTab('explorer')} />
                    </div>
                    {/* Quick Stats */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                        <div className="glass p-6 rounded-2xl border border-white/5 relative overflow-hidden">
                            <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-2">Kubernetes Version</p>
                            <p className="text-xl font-bold text-white flex items-center">
                                <Layers className="w-6 h-6 mr-2 text-blue-400" />
                                v{cluster.k8sVersion}
                            </p>
                            {availableUpgrades.length > 0 && (
                                <div className="absolute top-4 right-4">
                                    <span className="flex h-3 w-3 relative">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                                    </span>
                                </div>
                            )}
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
                        <div className="lg:col-span-2 space-y-6">
                            {/* Why live status is missing (instead of silent "Unknown" nodes) */}
                            {healthError && (
                                <div className="flex items-start gap-3 p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 text-sm text-amber-200">
                                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                                    <div className="min-w-0">
                                        <div className="font-bold">{healthError.error}{health ? ' — showing the last known status' : ''}</div>
                                        {healthError.details && <div className="text-xs text-amber-200/80 mt-1 break-words font-mono">{healthError.details}</div>}
                                        <div className="text-xs text-amber-200/70 mt-1">
                                            Retries every 15 s. In SaaS mode check that the Gateway Agent is online on the Tunnels page and can reach the control-plane.
                                        </div>
                                    </div>
                                </div>
                            )}
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
                                        <ClusterTopology3D
                                            clusterId={id}
                                            clusterInfo={{
                                                nodes: allNodes.map((n, idx) => ({
                                                    ip: n.ip || `10.0.0.${idx}`,
                                                    hostname: n.hostname || (n.role === 'master' ? 'master' : `worker-${idx}`),
                                                    role: n.role,
                                                    status: n.status || 'Pending'   // never assume Ready without live data
                                                }))
                                            }}
                                            stats={health && !health.error ? {
                                                cpu: health.cpu, mem: health.mem, disk: health.disk, pods: health.pods
                                            } : null}
                                            height="500px"
                                        />
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
                                                        <p className="text-xs text-slate-500 font-mono">{node.ip || 'IP pending...'}</p>
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

                                {!health && healthError ? (
                                    <div className="relative z-10 text-sm text-amber-200">
                                        <div className="font-bold mb-1">No live metrics</div>
                                        <div className="text-xs text-amber-200/80 break-words">{healthError.error}{healthError.details ? ` — ${healthError.details}` : ''}</div>
                                        <div className="text-xs text-slate-500 mt-2">Retrying every 15 seconds.</div>
                                    </div>
                                ) : health ? (
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
                                                <span className="text-purple-400 font-bold">{health.mem}%</span>
                                            </div>
                                            <div className="w-full bg-white/5 rounded-full h-2 overflow-hidden">
                                                <div className="h-full bg-purple-500 rounded-full transition-all duration-1000" style={{ width: `${Math.min(health.mem || 0, 100)}%` }}></div>
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
                                    <div className="space-y-6 relative z-10">
                                        <div className="space-y-2">
                                            <Skeleton className="w-24 h-4" />
                                            <Skeleton className="w-full h-8" />
                                        </div>
                                        <div className="space-y-2">
                                            <Skeleton className="w-24 h-4" />
                                            <Skeleton className="w-full h-8" />
                                        </div>
                                        <div className="space-y-2">
                                            <Skeleton className="w-24 h-4" />
                                            <Skeleton className="w-full h-8" />
                                        </div>
                                    </div>
                                )}

                                {health && <div className="mt-8 pt-6 border-t border-white/10">
                                    <div className="flex items-center space-x-3 text-sm text-slate-400">
                                        <Zap className="w-4 h-4 text-yellow-400" />
                                        <span>Optimization Tips:</span>
                                    </div>
                                    <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                                        {health && health.cpu > 80 ? 'High CPU usage detected. Consider adding more worker nodes.' :
                                            health && health.mem > 80 ? 'High Memory usage detected. Check for memory leaks or scale up.' :
                                                'Cluster is running within optimal parameters.'}
                                    </p>
                                </div>}
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* ── Add-ons ──────────────────────────────────────────────── */}
            {tab === 'addons' && (
                <>
                    <div className="mb-4 inline-flex bg-white/5 p-1 rounded-xl border border-white/5">
                        {ADDON_SECTIONS.map(s => (
                            <button key={s.key} onClick={() => setSection(s.key)}
                                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all ${section === s.key ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>
                                {s.label}
                            </button>
                        ))}
                    </div>
                    {section === 'manage'
                        ? <AddonManagerPanel clusterId={id} canManage={canManageAddons} />
                        : <AddonAccessPanel clusterId={id} />}
                </>
            )}

            {/* ── Backups ──────────────────────────────────────────────── */}
            {tab === 'backups' && (
                <BackupsTab clusterId={id} clusterName={cluster.clusterName} masterIp={cluster.masterNodes?.[0]?.ip} canManage={canUpgrade} explorer={!!cluster.addons?.explorer} />
            )}

            {/* ── Explorer (Radar behind KubeEZ) ─────────────────────── */}
            {tab === 'explorer' && (
                <ExplorerTab clusterId={id} installed={!!cluster.addons?.explorer} canInstall={can(user?.role, 'addon:install')} role={user?.role} />
            )}


            {/* UPGRADE MODAL */}
            {upgradeModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-[#0f172a] border border-white/10 rounded-2xl w-full max-w-2xl p-6 shadow-2xl animate-in zoom-in duration-200 max-h-[92vh] overflow-y-auto">
                        <h2 className="text-xl font-bold text-white mb-2">Upgrade Cluster Version</h2>
                        <p className="text-slate-400 text-sm mb-6">Select a target version to upgrade to. This process will sequentially upgrade control plane and worker nodes.</p>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Current Version</label>
                                <div className="p-3 bg-white/5 rounded-xl text-white font-mono text-sm border border-white/5">
                                    v{cluster.k8sVersion}
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-blue-400 uppercase tracking-wider mb-2">Target Version</label>
                                <select
                                    className="w-full p-3 bg-slate-800 rounded-xl text-white border border-white/10 focus:border-blue-500 outline-none appearance-none"
                                    value={targetVersion}
                                    onChange={(e) => { setTargetVersion(e.target.value); setAcceptBlockers(false) }}
                                >
                                    <option value="" disabled>Select Version</option>
                                    {availableUpgrades.map(v => (
                                        <option key={v} value={v}>v{v} (Recommended)</option>
                                    ))}
                                </select>
                            </div>

                            <UpgradeSafetyCheck clusterId={id} target={targetVersion} onResult={setSafety} />
                            {safety?.verdict === 'blocked' && (
                                ['admin', 'superadmin'].includes(user?.role) ? (
                                    <label className="flex items-start gap-2 text-[11px] text-red-200 cursor-pointer">
                                        <input type="checkbox" className="mt-0.5" checked={acceptBlockers} onChange={e => setAcceptBlockers(e.target.checked)} />
                                        I understand the blockers above and want to upgrade anyway (an etcd snapshot is still taken first).
                                    </label>
                                ) : <p className="text-[11px] text-red-200">Fix the blockers first — only a workspace admin can upgrade despite them.</p>
                            )}

                            <div className="pt-4 flex space-x-3">
                                <button
                                    onClick={() => setUpgradeModalOpen(false)}
                                    className="flex-1 py-3 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 font-bold transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleUpgrade}
                                    disabled={!targetVersion || upgradeLoading || (targetVersion && !safety) || (safety?.verdict === 'blocked' && !acceptBlockers)}
                                    className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-lg shadow-blue-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                >
                                    {upgradeLoading ? 'Starting...' : 'Start Upgrade'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Orbital Terminal Modal */}
            {isTerminalOpen && (
                <OrbitalTerminal
                    clusterId={id}
                    nodes={allNodes}
                    onClose={() => setIsTerminalOpen(false)}
                />
            )}
        </div>
    )
}
