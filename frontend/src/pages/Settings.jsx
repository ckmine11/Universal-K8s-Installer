import { useState, useEffect } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { PageTitle } from '../components/ui/PageHeader'
import { useToast } from '../components/ToastProvider'
import { useAuth, apiFetch } from '../context/AuthContext'
import { Bell, SlidersHorizontal,
    Activity,
    Database,
    RefreshCw,
    Cpu,
    Clock,
    Server,
    AlertTriangle,
    CheckCircle2,
    Loader2,
    Lock,
    Key,
    Shield,
    Eye,
    EyeOff,
    Check,
    Users,
    ArrowRight,
    Zap,
    Download,
    X
} from 'lucide-react'

// Compact row used in the restore preview diff
function DiffRow({ sym, color, name, detail }) {
    return (
        <div className="flex items-center gap-2 text-xs bg-white/[0.02] border border-white/5 rounded-lg px-3 py-2">
            <span className={`font-black ${color} w-3`}>{sym}</span>
            <span className="font-bold text-white truncate">{name}</span>
            <span className="text-slate-500 truncate">— {detail}</span>
        </div>
    )
}


export default function Settings() {
    const { toast } = useToast()
    const { user } = useAuth()
    const [searchParams, setSearchParams] = useSearchParams()
    const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') || 'licensing')
    useEffect(() => { const t = searchParams.get('tab'); if (t && t !== activeTab) setActiveTab(t); if (!t && user) setActiveTab('licensing') }, [searchParams])
    const selectTab = (t) => { setActiveTab(t); setSearchParams({ tab: t }, { replace: true }) }
    
    // Health state
    const [healthData, setHealthData] = useState(null)
    const [healthLoading, setHealthLoading] = useState(true)
    
    // Backup state
    const [backupData, setBackupData] = useState(null)
    const [backupLoading, setBackupLoading] = useState(true)
    const [isBackingUp, setIsBackingUp] = useState(false)
    const [isRestoring, setIsRestoring] = useState(null) // holds filename of restore target
    const [confirmRestore, setConfirmRestore] = useState(false)
    const [restorePreview, setRestorePreview] = useState(null)
    const [previewLoading, setPreviewLoading] = useState(false)

    // Licensing state
    const [configMode, setConfigMode] = useState('self-hosted')
    const [licenseStatus, setLicenseStatus] = useState(null)
    const [licenseLoading, setLicenseLoading] = useState(true)
    const [licenseKeyInput, setLicenseKeyInput] = useState('')
    const [activatingLicense, setActivatingLicense] = useState(false)

    // Password change state
    const [pwdForm, setPwdForm] = useState({ current: '', newPwd: '', confirm: '' })
    const [pwdLoading, setPwdLoading] = useState(false)
    const [pwdSuccess, setPwdSuccess] = useState(false)
    const [showPwds, setShowPwds] = useState({ current: false, newPwd: false, confirm: false })

    const fetchConfig = async () => {
        try {
            const res = await fetch('/api/config')
            if (res.ok) {
                const data = await res.json()
                setConfigMode(data.mode)
            }
        } catch (err) {
            console.error('Failed to fetch config mode:', err)
        }
    }

    const fetchLicenseStatus = async () => {
        setLicenseLoading(true)
        try {
            const res = await apiFetch('/api/license/status')
            const data = await res.ok ? await res.json() : null
            if (data) {
                setLicenseStatus(data)
            } else {
                throw new Error('Failed to load license status')
            }
        } catch (err) {
            console.error('License status load error:', err.message)
        } finally {
            setLicenseLoading(false)
        }
    }

    useEffect(() => {
        fetchConfig()
    }, [])

    // Always know the plan (needed to gate the Backups tab) — cheap call.
    useEffect(() => {
        if (user) fetchLicenseStatus()
    }, [user])

    useEffect(() => {
        if (user) {
            if (activeTab === 'health' && user.role === 'superadmin') {
                fetchHealth()
            } else if (activeTab === 'licensing') {
                fetchLicenseStatus()
            }
        }
    }, [user])

    useEffect(() => {
        if (user) {
            if (activeTab === 'health' && user.role === 'superadmin') {
                fetchHealth()
            } else if (activeTab === 'licensing') {
                fetchLicenseStatus()
            }
        }
    }, [activeTab])

    // Fetch backups once the user is on the Backups tab AND is entitled (Pro/Enterprise/superadmin)
    useEffect(() => {
        const entitled = user && (user.role === 'superadmin' ||
            ['PRO', 'ENTERPRISE'].includes(String(licenseStatus?.planCode || '').toUpperCase()))
        if (activeTab === 'backups' && entitled) fetchBackups()
    }, [activeTab, licenseStatus, user])

    const handlePasswordChange = async () => {
        if (!pwdForm.current || !pwdForm.newPwd || !pwdForm.confirm) {
            toast({ title: 'Error', message: 'Please fill all password fields', type: 'error' }); return
        }
        if (pwdForm.newPwd !== pwdForm.confirm) {
            toast({ title: 'Error', message: 'New password and confirmation do not match', type: 'error' }); return
        }
        if (pwdForm.newPwd.length < 8) {
            toast({ title: 'Error', message: 'New password must be at least 8 characters', type: 'error' }); return
        }
        setPwdLoading(true)
        try {
            const res = await apiFetch('/api/auth/change-password', {
                method: 'POST',
                body: JSON.stringify({ currentPassword: pwdForm.current, newPassword: pwdForm.newPwd })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            setPwdSuccess(true)
            setPwdForm({ current: '', newPwd: '', confirm: '' })
            toast({ title: 'Password Changed', message: 'Your password has been updated successfully', type: 'success' })
            setTimeout(() => setPwdSuccess(false), 3000)
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setPwdLoading(false)
        }
    }

    const fetchHealth = async () => {
        setHealthLoading(true)
        try {
            const res = await apiFetch('/api/health/detailed')
            const data = await res.ok ? await res.json() : null
            if (data) {
                setHealthData(data)
            } else {
                throw new Error('Failed to load health metrics')
            }
        } catch (err) {
            toast({
                title: 'Error',
                message: err.message,
                type: 'error'
            })
        } finally {
            setHealthLoading(false)
        }
    }

    const fetchBackups = async () => {
        setBackupLoading(true)
        try {
            const res = await apiFetch('/api/health/backups')
            const data = await res.ok ? await res.json() : null
            if (data) {
                setBackupData(data.backupSystem)
            } else {
                throw new Error('Failed to load backup logs')
            }
        } catch (err) {
            toast({
                title: 'Error',
                message: err.message,
                type: 'error'
            })
        } finally {
            setBackupLoading(false)
        }
    }

    const handleCreateBackup = async () => {
        setIsBackingUp(true)
        try {
            const res = await apiFetch('/api/health/backups', {
                method: 'POST'
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Backup failed')

            toast({
                title: 'Backup Successful',
                message: `Created config snapshot: ${data.filename}`,
                type: 'success'
            })
            fetchBackups()
        } catch (err) {
            toast({
                title: 'Operation Failed',
                message: err.message,
                type: 'error'
            })
        } finally {
            setIsBackingUp(false)
        }
    }

    const handleRestoreBackup = async (filename) => {
        setIsRestoring(filename)
        try {
            const res = await apiFetch('/api/health/backups/restore', {
                method: 'POST',
                body: JSON.stringify({ filename })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Restore failed')

            toast({
                title: 'Restore Completed',
                message: 'Platform configurations restored to match snapshot.',
                type: 'success'
            })
            setConfirmRestore(false)
            setRestorePreview(null)
            setIsRestoring(null)
            fetchBackups()
        } catch (err) {
            toast({
                title: 'Restore Failed',
                message: err.message,
                type: 'error'
            })
            setIsRestoring(null)
        }
    }

    // Download a backup file (credentials stay encrypted inside the file)
    const handleDownloadBackup = async (filename) => {
        try {
            const res = await apiFetch(`/api/health/backups/download?filename=${encodeURIComponent(filename)}`)
            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                throw new Error(data.error || 'Download failed')
            }
            const blob = await res.blob()
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = filename
            document.body.appendChild(a)
            a.click()
            a.remove()
            window.URL.revokeObjectURL(url)
        } catch (err) {
            toast({ title: 'Download Failed', message: err.message, type: 'error' })
        }
    }

    // Open the restore modal and load a preview of what will change
    const openRestore = async (filename) => {
        setConfirmRestore(filename)
        setRestorePreview(null)
        setPreviewLoading(true)
        try {
            const res = await apiFetch(`/api/health/backups/preview?filename=${encodeURIComponent(filename)}`)
            const data = await res.json()
            if (res.ok && data.success) setRestorePreview(data)
        } catch {
            // Preview is best-effort; restore still works without it
        } finally {
            setPreviewLoading(false)
        }
    }

    if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                <Lock className="w-16 h-16 text-red-500 mb-4 animate-bounce" />
                <h1 className="text-3xl font-black text-white mb-2">Access Denied</h1>
                <p className="text-slate-400 max-w-sm">
                    Only administrators are authorized to access the workspace settings.
                </p>
            </div>
        )
    }

    const isSuperAdmin = user.role === 'superadmin';
    const isAdmin = user.role === 'admin' || isSuperAdmin;
    const planCode = String(licenseStatus?.planCode || '').toUpperCase();
    const isPaidPlan = planCode === 'PRO' || planCode === 'ENTERPRISE';
    const canBackup = isSuperAdmin || isPaidPlan; // Daily backups = Pro feature

    if (searchParams.get('tab') === 'alerts') return <Navigate to="/alerts" replace />
    if (searchParams.get('tab') === 'tenants') return <Navigate to="/admin" replace />

    return (
        <div className="max-w-7xl mx-auto relative">
            {/* Header */}
            <div className="mb-6">
                <PageTitle icon={SlidersHorizontal} eyebrow="Workspace"
                    title={isSuperAdmin ? 'Platform settings' : 'Workspace settings'}
                    description={isSuperAdmin
                        ? 'Config backups, plans and security of this KubeEZ server — tenants are in the Admin Console.'
                        : 'Config backups, your plan and security for this workspace.'} />
            </div>

            {/* Navigation Tabs */}
            <div className="flex gap-1 p-1 mb-8 rounded-2xl border border-white/10 bg-black/25 w-fit max-w-full overflow-x-auto" role="tablist">

                {isAdmin && (
                    <button
                        onClick={() => selectTab('backups')}
                        className={`flex items-center space-x-2 whitespace-nowrap px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
                            activeTab === 'backups'
                                ? 'bg-gradient-to-r from-blue-500/25 to-violet-500/20 text-white shadow-[inset_0_0_0_1px_rgba(44,203,238,.35)]'
                                : 'text-slate-400 hover:bg-white/5 hover:text-white'
                        }`}
                    >
                        <Database className="w-4 h-4" />
                        <span>Config Backups</span>
                        {!canBackup && <Lock className="w-3 h-3 text-amber-400" />}
                    </button>
                )}
                <button
                    onClick={() => selectTab('licensing')}
                    className={`flex items-center space-x-2 whitespace-nowrap px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
                        activeTab === 'licensing'
                            ? 'bg-gradient-to-r from-blue-500/25 to-violet-500/20 text-white shadow-[inset_0_0_0_1px_rgba(44,203,238,.35)]'
                            : 'text-slate-400 hover:bg-white/5 hover:text-white'
                    }`}
                >
                    <Key className="w-4 h-4" />
                    <span>{configMode === 'saas' ? 'Plans & Quotas' : 'Licensing & Plans'}</span>
                </button>
                <button
                    onClick={() => selectTab('security')}
                    className={`flex items-center space-x-2 whitespace-nowrap px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
                        activeTab === 'security'
                            ? 'bg-gradient-to-r from-blue-500/25 to-violet-500/20 text-white shadow-[inset_0_0_0_1px_rgba(44,203,238,.35)]'
                            : 'text-slate-400 hover:bg-white/5 hover:text-white'
                    }`}
                >
                    <Shield className="w-4 h-4" />
                    <span>Security</span>
                </button>
            </div>

            {/* Tab Views */}
            <div className="space-y-6">
                {activeTab === 'health' && (
                    <div className="space-y-6">
                        {healthLoading ? (
                            <div className="flex flex-col items-center justify-center py-20 gap-4">
                                <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                                <p className="text-xs tracking-widest text-slate-500 uppercase font-black">Refetching server load metrics...</p>
                            </div>
                        ) : (
                            healthData && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in duration-300">
                                    {/* Server Specs Card */}
                                    <div className="glass rounded-3xl p-8 border border-white/5 relative overflow-hidden">
                                        <div className="flex items-center justify-between mb-6">
                                            <h3 className="text-lg font-black uppercase tracking-wider text-slate-200">Server Configuration</h3>
                                            <button onClick={fetchHealth} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl transition-all active:scale-95 text-slate-300">
                                                <RefreshCw className="w-4 h-4" />
                                            </button>
                                        </div>
                                        <div className="space-y-4 text-sm">
                                            <div className="flex items-center justify-between border-b border-white/5 pb-3">
                                                <span className="text-slate-500 font-bold uppercase tracking-wider text-xs">Hostname:</span>
                                                <span className="font-bold text-white">{healthData.system.hostname}</span>
                                            </div>
                                            <div className="flex items-center justify-between border-b border-white/5 pb-3">
                                                <span className="text-slate-500 font-bold uppercase tracking-wider text-xs">OS Profile:</span>
                                                <span className="font-bold text-white capitalize">{healthData.system.platform} ({healthData.system.type})</span>
                                            </div>
                                            <div className="flex items-center justify-between border-b border-white/5 pb-3">
                                                <span className="text-slate-500 font-bold uppercase tracking-wider text-xs">CPU Architecture:</span>
                                                <span className="font-bold text-white uppercase">{healthData.process.arch} ({healthData.cpu.cores} Cores)</span>
                                            </div>
                                            <div className="flex items-center justify-between border-b border-white/5 pb-3">
                                                <span className="text-slate-500 font-bold uppercase tracking-wider text-xs">Runtime Engine:</span>
                                                <span className="font-bold text-white">{healthData.process.version}</span>
                                            </div>
                                            <div className="flex items-center justify-between pb-1">
                                                <span className="text-slate-500 font-bold uppercase tracking-wider text-xs">System Uptime:</span>
                                                <span className="font-bold text-blue-400">{healthData.uptime.formatted}</span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Resources & Load Card */}
                                    <div className="glass rounded-3xl p-8 border border-white/5">
                                        <h3 className="text-lg font-black uppercase tracking-wider text-slate-200 mb-6">Load Monitor</h3>
                                        <div className="space-y-6">
                                            {/* System Memory Bar */}
                                            <div>
                                                <div className="flex justify-between text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                                                    <span>System Memory ({healthData.memory.system.used} / {healthData.memory.system.total})</span>
                                                    <span className="text-blue-400">{healthData.memory.system.usedPercentage}</span>
                                                </div>
                                                <div className="w-full bg-white/5 border border-white/5 rounded-full h-3.5 overflow-hidden">
                                                    <div
                                                        className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-500"
                                                        style={{ width: healthData.memory.system.usedPercentage }}
                                                    ></div>
                                                </div>
                                            </div>

                                            {/* Node Process Memory Bar */}
                                            <div>
                                                <div className="flex justify-between text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">
                                                    <span>Process Heap ({healthData.memory.process.heapUsed} / {healthData.memory.process.heapTotal})</span>
                                                    <span className="text-purple-400">{healthData.memory.process.heapUsedPercentage}</span>
                                                </div>
                                                <div className="w-full bg-white/5 border border-white/5 rounded-full h-3.5 overflow-hidden">
                                                    <div
                                                        className="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-500"
                                                        style={{ width: healthData.memory.process.heapUsedPercentage }}
                                                    ></div>
                                                </div>
                                            </div>

                                            {/* Load Averages */}
                                            <div>
                                                <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Load Averages (1m, 5m, 15m)</p>
                                                <div className="grid grid-cols-3 gap-4">
                                                    {healthData.cpu.loadAverage.map((load, index) => (
                                                        <div key={index} className="bg-white/5 border border-white/5 rounded-2xl p-4 text-center">
                                                            <p className="text-2xl font-black text-white">{load.toFixed(2)}</p>
                                                            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">
                                                                {index === 0 ? '1 Min' : index === 1 ? '5 Min' : '15 Min'}
                                                            </p>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )
                        )}
                    </div>
                )}

                {/* Free plan: feature locked — upsell to Pro */}
                {activeTab === 'backups' && !canBackup && (
                    <div className="glass rounded-3xl border border-amber-500/20 bg-amber-500/[0.03] p-10 text-center animate-in fade-in duration-300 max-w-2xl mx-auto">
                        <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-5">
                            <Lock className="w-8 h-8 text-amber-400" />
                        </div>
                        <h2 className="text-2xl font-black text-white mb-2">Daily Config Backups is a Pro Feature</h2>
                        <p className="text-slate-400 text-sm max-w-md mx-auto mb-6">
                            Automatically snapshot your cluster configuration every day and restore any previous
                            state in one click. Never lose your setup to an accidental change or a failed upgrade.
                        </p>
                        <div className="grid sm:grid-cols-3 gap-3 mb-8 text-left">
                            {[
                                { t: 'Automatic Daily Snapshots', d: 'Your config is saved every 24h — hands-off.' },
                                { t: '1-Click Restore', d: 'Roll back to any earlier snapshot instantly.' },
                                { t: 'Safe Pre-Restore Backup', d: 'Current state is saved before every restore.' },
                            ].map(f => (
                                <div key={f.t} className="bg-white/5 border border-white/5 rounded-2xl p-4">
                                    <CheckCircle2 className="w-4 h-4 text-emerald-400 mb-2" />
                                    <p className="text-xs font-black text-white">{f.t}</p>
                                    <p className="text-[11px] text-slate-500 mt-1">{f.d}</p>
                                </div>
                            ))}
                        </div>
                        <a href="/pricing" className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-amber-500 hover:bg-amber-400 text-black font-black text-xs uppercase tracking-wider transition-colors">
                            <Zap className="w-4 h-4" /> Upgrade to Pro — $49/mo
                        </a>
                    </div>
                )}

                {activeTab === 'backups' && canBackup && (
                    <div className="space-y-6">
                        {/* Transparency panel — exactly what is and isn't backed up */}
                        <div className="glass rounded-3xl border border-white/5 p-6 animate-in fade-in duration-300">
                            <div className="flex items-center gap-2 mb-4">
                                <Database className="w-4 h-4 text-blue-400" />
                                <h3 className="text-sm font-black uppercase tracking-wider text-slate-200">What This Backup Includes</h3>
                            </div>
                            <p className="text-xs text-slate-400 mb-5 leading-relaxed">
                                Config Backups save your <span className="text-slate-200 font-bold">cluster setup & connection records</span> managed by KubeEZ —
                                <span className="text-slate-200 font-bold"> not the data running inside your Kubernetes cluster</span>.
                                Use it to recover your cluster definitions after an accidental change, deletion, or a failed upgrade.
                            </p>
                            <div className="grid md:grid-cols-2 gap-5">
                                {/* Included */}
                                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4">
                                    <div className="flex items-center gap-2 mb-3">
                                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                                        <span className="text-xs font-black uppercase tracking-wider text-emerald-300">Backed Up</span>
                                    </div>
                                    <ul className="space-y-2">
                                        {[
                                            'Cluster name, ID & creation date',
                                            'Kubernetes version & network plugin (CNI)',
                                            'Master & worker nodes — IP, hostname, username',
                                            'Node SSH credentials (encrypted at rest)',
                                            'Installed add-ons list (Dashboard, Ingress, etc.)',
                                            'Cluster status & KubeEZ configuration record',
                                        ].map(item => (
                                            <li key={item} className="flex items-start gap-2 text-xs text-slate-300">
                                                <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                                                <span>{item}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                                {/* Not included */}
                                <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.03] p-4">
                                    <div className="flex items-center gap-2 mb-3">
                                        <AlertTriangle className="w-4 h-4 text-red-400" />
                                        <span className="text-xs font-black uppercase tracking-wider text-red-300">NOT Backed Up</span>
                                    </div>
                                    <ul className="space-y-2">
                                        {[
                                            'Your pods, deployments & running workloads',
                                            'Persistent volumes & database data',
                                            'Kubernetes secrets & configmaps',
                                            'Application data inside the cluster',
                                            'Container images',
                                            'Cluster etcd state / live resources',
                                        ].map(item => (
                                            <li key={item} className="flex items-start gap-2 text-xs text-slate-400">
                                                <X className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                                                <span>{item}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                            <div className="flex items-start gap-2 mt-5 text-[11px] text-slate-500 bg-white/[0.03] border border-white/5 rounded-xl p-3">
                                <Shield className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
                                <span>
                                    For backing up <span className="text-slate-300 font-bold">in-cluster data</span> (volumes, databases),
                                    use a workload backup tool like <span className="text-slate-300 font-bold">Velero</span> or storage snapshots
                                    (e.g. <span className="text-slate-300 font-bold">Longhorn</span>). This feature protects your KubeEZ cluster definitions only.
                                </span>
                            </div>
                        </div>

                        {/* Stats & Actions */}
                        {backupData && (
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 align-stretch animate-in fade-in duration-300">
                                <div className="glass rounded-3xl p-6 border border-white/5 flex flex-col justify-between">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">Config Backups</span>
                                        <Database className="w-4 h-4 text-blue-500" />
                                    </div>
                                    <div>
                                        <h2 className="text-3xl font-black text-white">{backupData.stats.totalBackups}</h2>
                                        <p className="text-xs text-slate-400 mt-1">Saved configuration snapshots</p>
                                    </div>
                                </div>

                                <div className="glass rounded-3xl p-6 border border-white/5 flex flex-col justify-between">
                                    <div className="flex items-center justify-between mb-4">
                                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">Total Storage</span>
                                        <Activity className="w-4 h-4 text-purple-500" />
                                    </div>
                                    <div>
                                        <h2 className="text-3xl font-black text-white">{backupData.stats.totalSizeMB} MB</h2>
                                        <p className="text-xs text-slate-400 mt-1">Backup folder memory load</p>
                                    </div>
                                </div>

                                <div className="glass rounded-3xl p-6 border border-white/5 flex flex-col justify-center">
                                    <button
                                        onClick={handleCreateBackup}
                                        disabled={isBackingUp}
                                        className="w-full py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white text-xs font-black uppercase tracking-wider shadow-lg shadow-blue-600/20 active:scale-95 transition-all flex items-center justify-center space-x-2"
                                    >
                                        {isBackingUp ? (
                                            <>
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                <span>Creating Backup...</span>
                                            </>
                                        ) : (
                                            <>
                                                <Database className="w-4 h-4" />
                                                <span>Create Manual Backup</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Backup Table */}
                        <div className="glass rounded-3xl border border-white/5 overflow-hidden">
                            <div className="p-6 border-b border-white/5 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <h3 className="text-lg font-black uppercase tracking-wider text-slate-200">Snapshot Registry</h3>
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-2 py-0.5">
                                        <Lock className="w-3 h-3" /> Credentials Encrypted
                                    </span>
                                </div>
                                <button onClick={fetchBackups} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl transition-all text-slate-300">
                                    <RefreshCw className="w-4 h-4" />
                                </button>
                            </div>
                            
                            {backupLoading ? (
                                <div className="flex flex-col items-center justify-center py-20 gap-4">
                                    <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                                    <p className="text-xs tracking-widest text-slate-500 uppercase font-black">Fetching storage directory logs...</p>
                                </div>
                            ) : (
                                backupData && (
                                    <div className="overflow-x-auto">
                                        <table className="w-full border-collapse text-left">
                                            <thead>
                                                <tr className="border-b border-white/5 text-slate-500 text-[10px] font-black uppercase tracking-widest bg-black/25">
                                                    <th className="px-6 py-4">Filename</th>
                                                    <th className="px-6 py-4">Size</th>
                                                    <th className="px-6 py-4">Created At</th>
                                                    <th className="px-6 py-4 text-right">Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {backupData.recentBackups.length === 0 ? (
                                                    <tr>
                                                        <td colSpan="4" className="text-center py-10 text-slate-500 font-bold uppercase tracking-wider text-xs">
                                                            No configuration backups found.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    backupData.recentBackups.map((backup, idx) => (
                                                        <tr key={idx} className="border-b border-white/5 hover:bg-white/[0.01] transition-colors text-sm">
                                                            <td className="px-6 py-4 font-mono font-bold text-white text-xs">{backup.filename}</td>
                                                            <td className="px-6 py-4 font-medium text-slate-300">{backup.size}</td>
                                                            <td className="px-6 py-4 text-slate-400">{new Date(backup.created).toLocaleString()}</td>
                                                            <td className="px-6 py-4 text-right">
                                                                <div className="flex items-center justify-end gap-2">
                                                                    <button
                                                                        onClick={() => handleDownloadBackup(backup.filename)}
                                                                        title="Download backup (credentials encrypted)"
                                                                        className="px-3 py-2 border border-white/10 hover:border-white/25 bg-white/5 hover:bg-white/10 text-slate-300 text-xs font-black uppercase tracking-wider rounded-xl transition-all active:scale-95 flex items-center gap-1.5"
                                                                    >
                                                                        <Download className="w-3.5 h-3.5" /> Download
                                                                    </button>
                                                                    <button
                                                                        onClick={() => openRestore(backup.filename)}
                                                                        className="px-4 py-2 border border-blue-500/20 hover:border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10 text-blue-400 text-xs font-black uppercase tracking-wider rounded-xl transition-all active:scale-95"
                                                                    >
                                                                        Restore
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                )
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'licensing' && (
                    <div className="space-y-6 animate-in fade-in duration-300">
                        {licenseLoading ? (
                            <div className="flex flex-col items-center justify-center py-20 gap-4">
                                <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                                <p className="text-xs tracking-widest text-slate-500 uppercase font-black">Fetching licensing parameters...</p>
                            </div>
                        ) : (
                            licenseStatus && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    {/* Plan and Status Info */}
                                    <div className="glass rounded-[32px] p-8 border border-white/8 relative overflow-hidden flex flex-col justify-between bg-slate-950/80 backdrop-blur-3xl shadow-2xl group hover:border-white/15 transition-all duration-500">
                                        {/* Premium Ambient Glow */}
                                        <div className="absolute top-0 right-0 w-[150%] h-[150%] bg-gradient-to-br from-blue-500/10 via-transparent to-transparent -translate-y-1/2 translate-x-1/4 rounded-full pointer-events-none group-hover:from-blue-500/20 transition-all duration-700"></div>
                                        
                                        <div className="relative z-10">
                                            <div className="flex items-center justify-between mb-8">
                                                <h3 className="text-[13px] font-black uppercase tracking-[0.2em] text-white flex items-center gap-3">
                                                    <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.8)]"></div>
                                                    {configMode === 'saas' ? 'SaaS Subscription Plan' : 'Instance Licensing'}
                                                </h3>
                                                <button onClick={fetchLicenseStatus} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-xl transition-all active:scale-95 text-slate-300">
                                                    <RefreshCw className="w-4 h-4" />
                                                </button>
                                            </div>

                                            <div className="space-y-5 text-sm">
                                                <div className="flex items-center justify-between border-b border-white/[0.05] pb-4">
                                                    <span className="text-slate-500 font-bold uppercase tracking-[0.15em] text-[10px]">Running Mode</span>
                                                    <span className="font-black text-blue-400 uppercase tracking-widest text-[10px] bg-blue-500/10 px-4 py-1.5 rounded-full border border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.15)]">
                                                        {configMode}
                                                    </span>
                                                </div>
                                                <div className="flex items-center justify-between border-b border-white/[0.05] pb-4">
                                                    <span className="text-slate-500 font-bold uppercase tracking-[0.15em] text-[10px]">Current Plan</span>
                                                    <span className="font-black text-white tracking-wide text-sm">{licenseStatus.plan}</span>
                                                </div>
                                                {licenseStatus.systemId && (
                                                    <div className="flex items-center justify-between border-b border-white/[0.05] pb-4">
                                                        <span className="text-slate-500 font-bold uppercase tracking-[0.15em] text-[10px]">System ID</span>
                                                        <span className="font-mono font-bold text-blue-300 text-[11px] bg-blue-950/30 px-3 py-1.5 rounded-lg border border-blue-500/20 select-all tracking-wider">{licenseStatus.systemId}</span>
                                                    </div>
                                                )}
                                                <div className="flex items-center justify-between border-b border-white/[0.05] pb-4">
                                                    <span className="text-slate-500 font-bold uppercase tracking-[0.15em] text-[10px]">License Status</span>
                                                    {licenseStatus.status === 'active' && (
                                                        <span className="flex items-center gap-2 font-black text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-4 py-1.5 rounded-full text-[10px] uppercase tracking-wider shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                                                            <CheckCircle2 className="w-3.5 h-3.5" />
                                                            Active
                                                        </span>
                                                    )}
                                                    {licenseStatus.status === 'expired' && (
                                                        <span className="flex items-center gap-2 font-black text-rose-400 bg-rose-500/10 border border-rose-500/20 px-4 py-1.5 rounded-full text-[10px] uppercase tracking-wider shadow-[0_0_20px_rgba(244,63,94,0.15)] animate-pulse">
                                                            <AlertTriangle className="w-3.5 h-3.5" />
                                                            Expired
                                                        </span>
                                                    )}
                                                    {licenseStatus.status === 'unlicensed' && (
                                                        <span className="flex items-center gap-2 font-black text-amber-400 bg-amber-500/10 border border-amber-500/20 px-4 py-1.5 rounded-full text-[10px] uppercase tracking-wider shadow-[0_0_20px_rgba(245,158,11,0.15)]">
                                                            <AlertTriangle className="w-3.5 h-3.5" />
                                                            Unlicensed
                                                        </span>
                                                    )}
                                                </div>
                                                {/* Subscription lifecycle — accurate to the plan */}
                                                {licenseStatus.autoRenew ? (
                                                    <div className="flex items-center justify-between pb-2">
                                                        <span className="text-slate-500 font-bold uppercase tracking-[0.15em] text-[10px]">Billing</span>
                                                        <span className="font-bold text-emerald-400 tracking-wide text-xs">
                                                            {licenseStatus.expiresAt
                                                                ? `Renews ${new Date(licenseStatus.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`
                                                                : `Auto-renews ${licenseStatus.billingCycle || 'monthly'}`}
                                                        </span>
                                                    </div>
                                                ) : licenseStatus.expiresAt ? (
                                                    <div className="flex items-center justify-between pb-2">
                                                        <span className="text-slate-500 font-bold uppercase tracking-[0.15em] text-[10px]">Expires On</span>
                                                        <span className="font-bold text-slate-300 tracking-wide text-xs">
                                                            {new Date(licenseStatus.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-center justify-between pb-2">
                                                        <span className="text-slate-500 font-bold uppercase tracking-[0.15em] text-[10px]">Expiry</span>
                                                        <span className="font-bold text-slate-300 tracking-wide text-xs">Free — no expiry</span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {configMode === 'saas' && (
                                            <div className="mt-10 pt-6 border-t border-white/[0.05] relative z-10 space-y-4">
                                                <p className="text-[11px] text-slate-400 mb-5 leading-relaxed font-medium">
                                                    Upgrade your workspace to unlock more nodes and clusters. Payments are securely processed via Stripe.
                                                </p>
                                                {licenseStatus.plan === 'Free Tier' && (
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                        {/* PRO */}
                                                        <button
                                                            onClick={async () => {
                                                                try {
                                                                    const res = await apiFetch('/api/stripe/create-checkout-session', {
                                                                        method: 'POST',
                                                                        body: JSON.stringify({ planId: 'pro' })
                                                                    });
                                                                    const data = await res.json();
                                                                    if (!res.ok) throw new Error(data.error || 'Checkout unavailable');
                                                                    if (data.url) window.location.href = data.url;
                                                                } catch(err) {
                                                                    toast({ title: 'Upgrade unavailable', message: err.message, type: 'error' });
                                                                }
                                                            }}
                                                            className="w-full py-4 bg-gradient-to-br from-amber-500 to-amber-700 hover:from-amber-400 hover:to-amber-600 border border-amber-500/30 text-black font-black text-[10px] uppercase tracking-[0.15em] rounded-2xl transition-all shadow-[0_0_20px_rgba(245,158,11,0.2)] hover:shadow-[0_0_30px_rgba(245,158,11,0.4)] flex flex-col items-center justify-center gap-1 active:scale-95"
                                                        >
                                                            <span>Upgrade to Pro</span>
                                                            <span className="text-[9px] opacity-80 normal-case tracking-normal font-medium">$49/mo · 10 Clusters · 50 Nodes · 5 Members</span>
                                                        </button>
                                                        {/* ENTERPRISE */}
                                                        <a
                                                            href="mailto:sales@k8scluster.space"
                                                            className="w-full py-4 bg-white/5 hover:bg-white/10 border border-blue-500/30 text-blue-400 font-black text-[10px] uppercase tracking-[0.15em] rounded-2xl transition-all flex flex-col items-center justify-center gap-1 active:scale-95"
                                                        >
                                                            <span>Enterprise</span>
                                                            <span className="text-[9px] opacity-80 normal-case tracking-normal font-medium">Custom · Unlimited · Contact Sales</span>
                                                        </a>
                                                    </div>
                                                )}
                                                {licenseStatus.plan !== 'Free Tier' && (
                                                    <button
                                                        onClick={() => toast({ title: 'Billing Portal', message: 'Manage your active subscription via Stripe.', type: 'info'})}
                                                        className="w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 text-white font-black text-[10px] uppercase tracking-[0.2em] rounded-2xl transition-all shadow-inner flex items-center justify-center gap-2 group active:scale-95"
                                                    >
                                                        Manage Billing Portal
                                                        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Quotas and Utilization */}
                                    <div className="glass rounded-[32px] p-8 border border-white/8 flex flex-col justify-between bg-slate-950/80 backdrop-blur-3xl shadow-2xl group hover:border-white/15 transition-all duration-500 relative overflow-hidden">
                                        <div className="absolute top-0 right-0 w-[150%] h-[150%] bg-gradient-to-bl from-purple-500/10 via-transparent to-transparent -translate-y-1/2 translate-x-1/4 rounded-full pointer-events-none group-hover:from-purple-500/20 transition-all duration-700"></div>
                                        
                                        <div className="relative z-10">
                                            <h3 className="text-[13px] font-black uppercase tracking-[0.2em] text-white mb-10 flex items-center gap-3">
                                                <div className="w-2 h-2 rounded-full bg-purple-500 shadow-[0_0_10px_rgba(168,85,247,0.8)]"></div>
                                                Resource Allocation Limits
                                            </h3>
                                            
                                            <div className="space-y-10">
                                                {/* Cluster utilization bar */}
                                                <div>
                                                    <div className="flex justify-between items-end mb-3">
                                                        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">Clusters Provisioned</span>
                                                        <span className="text-blue-400 font-black text-[11px] bg-blue-500/10 px-3 py-1 rounded-lg border border-blue-500/20">
                                                            {licenseStatus.activeClustersCount} / {licenseStatus.maxClusters === 0 ? '0' : (licenseStatus.maxClusters || '∞')}
                                                        </span>
                                                    </div>
                                                    <div className="w-full bg-black/60 border border-white/5 rounded-full h-3 overflow-hidden p-[2px] shadow-inner">
                                                        <div
                                                            className="h-full bg-gradient-to-r from-blue-600 via-blue-400 to-cyan-400 rounded-full transition-all duration-1000 relative"
                                                            style={{
                                                                width: `${Math.min(100, licenseStatus.maxClusters ? (licenseStatus.activeClustersCount / licenseStatus.maxClusters) * 100 : 0)}%`,
                                                                boxShadow: '0 0 20px rgba(56, 189, 248, 0.4)'
                                                            }}
                                                        >
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Node utilization bar */}
                                                <div>
                                                    <div className="flex justify-between items-end mb-3">
                                                        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">Master & Worker Nodes</span>
                                                        <span className="text-purple-400 font-black text-[11px] bg-purple-500/10 px-3 py-1 rounded-lg border border-purple-500/20">
                                                            {licenseStatus.activeNodesCount} / {licenseStatus.maxNodes === 0 ? '0' : (licenseStatus.maxNodes || '∞')}
                                                        </span>
                                                    </div>
                                                    <div className="w-full bg-black/60 border border-white/5 rounded-full h-3 overflow-hidden p-[2px] shadow-inner">
                                                        <div
                                                            className="h-full bg-gradient-to-r from-purple-600 via-purple-400 to-pink-400 rounded-full transition-all duration-1000 relative"
                                                            style={{
                                                                width: `${Math.min(100, licenseStatus.maxNodes ? (licenseStatus.activeNodesCount / licenseStatus.maxNodes) * 100 : 0)}%`,
                                                                boxShadow: '0 0 20px rgba(232, 121, 249, 0.4)'
                                                            }}
                                                        >
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {configMode === 'self-hosted' && (
                                            <div className="mt-10 pt-6 border-t border-white/[0.05] relative z-10">
                                                <h4 className="text-[10px] font-black uppercase text-slate-200 tracking-[0.15em] mb-3">Activate License Key</h4>
                                                <p className="text-[11px] text-slate-400 mb-5 leading-relaxed font-medium">
                                                    Paste your secure Enterprise License Token (JWT) to unlock your server quotas.
                                                </p>
                                                <div className="flex gap-3">
                                                    <input
                                                        type="text"
                                                        value={licenseKeyInput}
                                                        onChange={(e) => setLicenseKeyInput(e.target.value)}
                                                        placeholder="eyJhbGciOiJSUzI1Ni..."
                                                        className="flex-1 bg-black/60 border border-white/10 focus:border-blue-500/50 rounded-2xl px-5 py-4 text-xs text-blue-100 placeholder-slate-600 outline-none font-mono transition-colors shadow-inner focus:shadow-[0_0_15px_rgba(59,130,246,0.2)]"
                                                    />
                                                    <button
                                                        onClick={async () => {
                                                            if (!licenseKeyInput.trim()) return
                                                            setActivatingLicense(true)
                                                            try {
                                                                const res = await apiFetch('/api/license/activate', {
                                                                    method: 'POST',
                                                                    body: JSON.stringify({ licenseKey: licenseKeyInput.trim() })
                                                                })
                                                                const data = await res.json()
                                                                if (!res.ok) throw new Error(data.error || 'Activation failed')

                                                                toast({
                                                                    title: 'Activation Successful',
                                                                    message: `Licensed under plan: ${data.plan}`,
                                                                    type: 'success'
                                                                })
                                                                setLicenseKeyInput('')
                                                                fetchLicenseStatus()
                                                            } catch (err) {
                                                                toast({
                                                                    title: 'Activation Failed',
                                                                    message: err.message,
                                                                    type: 'error'
                                                                })
                                                            } finally {
                                                                setActivatingLicense(false)
                                                            }
                                                        }}
                                                        disabled={activatingLicense}
                                                        className="px-6 py-4 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white font-black text-[10px] uppercase tracking-[0.15em] transition-all active:scale-[0.98] shadow-[0_0_20px_rgba(79,70,229,0.3)] flex items-center justify-center whitespace-nowrap min-w-[140px]"
                                                    >
                                                        {activatingLicense ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            'Activate Key'
                                                        )}
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )
                        )}
                    </div>
                )}
            </div>


            {/* Restore Confirmation Dialog */}
            {confirmRestore && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
                    <div className="glass border border-orange-500/30 rounded-3xl max-w-lg w-full p-8 shadow-2xl relative overflow-hidden max-h-[90vh] overflow-y-auto">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-orange-500/10 rounded-full blur-[80px] pointer-events-none animate-pulse"></div>

                        <div className="relative z-10 text-center">
                            <div className="p-4 bg-orange-500/10 rounded-2xl border border-orange-500/20 inline-block mb-4">
                                <AlertTriangle className="w-8 h-8 text-orange-500" />
                            </div>
                            <h2 className="text-xl font-black text-white uppercase mb-2">Confirm Restore</h2>
                            <p className="text-slate-400 text-sm mb-4 leading-relaxed">
                                Restoring snapshot: <span className="font-mono text-white text-xs block mt-1 break-all">{confirmRestore}</span>
                            </p>

                            {/* Preview diff — exactly what will change */}
                            <div className="text-left mb-6">
                                {previewLoading ? (
                                    <div className="flex items-center justify-center gap-2 py-6 text-slate-500 text-xs">
                                        <Loader2 className="w-4 h-4 animate-spin" /> Analyzing changes...
                                    </div>
                                ) : restorePreview ? (
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-2 flex-wrap text-[11px] font-bold">
                                            <span className="px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">+{restorePreview.counts.added} added</span>
                                            <span className="px-2 py-1 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">~{restorePreview.counts.changed} changed</span>
                                            <span className="px-2 py-1 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">-{restorePreview.counts.removed} removed</span>
                                            <span className="px-2 py-1 rounded-lg bg-white/5 text-slate-400 border border-white/10">{restorePreview.counts.unchanged} unchanged</span>
                                        </div>
                                        <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                                            {restorePreview.added.map((c, i) => (
                                                <DiffRow key={'a' + i} sym="+" color="text-emerald-400" name={c.clusterName} detail={`${c.nodeCount} nodes · ${c.k8sVersion} · will be re-created`} />
                                            ))}
                                            {restorePreview.changed.map((c, i) => (
                                                <DiffRow key={'c' + i} sym="~" color="text-blue-400" name={c.to.clusterName} detail={`overwrite: ${c.from.nodeCount}→${c.to.nodeCount} nodes, ${c.to.addons.length} addons`} />
                                            ))}
                                            {restorePreview.removed.map((c, i) => (
                                                <DiffRow key={'r' + i} sym="−" color="text-red-400" name={c.clusterName} detail={`${c.nodeCount} nodes · NOT in snapshot → will be dropped`} />
                                            ))}
                                            {restorePreview.counts.added === 0 && restorePreview.counts.changed === 0 && restorePreview.counts.removed === 0 && (
                                                <p className="text-xs text-slate-500 py-2 text-center">No differences — your current state already matches this snapshot.</p>
                                            )}
                                        </div>
                                        <div className="flex items-start gap-2 text-[11px] text-slate-500 bg-white/[0.03] border border-white/5 rounded-xl p-3">
                                            <Shield className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                                            A safety backup of your current state is taken automatically before restoring, so this is reversible.
                                        </div>
                                    </div>
                                ) : (
                                    <p className="text-[11px] text-orange-400 text-center py-2">Preview unavailable — restore will still overwrite current cluster definitions.</p>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <button
                                    onClick={() => { setConfirmRestore(null); setRestorePreview(null) }}
                                    disabled={isRestoring === confirmRestore}
                                    className="px-4 py-3 rounded-xl border border-white/10 hover:bg-white/5 text-slate-300 font-bold text-xs uppercase tracking-wider transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => handleRestoreBackup(confirmRestore)}
                                    disabled={isRestoring === confirmRestore}
                                    className="px-4 py-3 rounded-xl bg-orange-600 hover:bg-orange-700 text-white font-black text-xs uppercase tracking-wider transition-colors flex items-center justify-center space-x-1"
                                >
                                    {isRestoring === confirmRestore ? (
                                        <>
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            <span>Restoring...</span>
                                        </>
                                    ) : (
                                        <span>Confirm Restore</span>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Security Tab */}
            {activeTab === 'security' && (
                <div className="animate-in fade-in duration-300 max-w-xl">
                    <div className="glass rounded-3xl border border-white/5 p-8">
                        <div className="flex items-center gap-3 mb-8">
                            <div className="p-3 bg-blue-500/10 rounded-2xl border border-blue-500/20">
                                <Lock className="w-5 h-5 text-blue-400" />
                            </div>
                            <div>
                                <h2 className="text-xl font-black text-white uppercase tracking-wide">Change Password</h2>
                                <p className="text-xs text-slate-400 mt-0.5">Update your account password</p>
                            </div>
                        </div>

                        {pwdSuccess && (
                            <div className="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl mb-6">
                                <div className="p-1.5 bg-emerald-500/20 rounded-lg">
                                    <Check className="w-4 h-4 text-emerald-400" />
                                </div>
                                <p className="text-sm font-bold text-emerald-400">Password changed successfully!</p>
                            </div>
                        )}

                        <div className="space-y-5">
                            {/* Current Password */}
                            <div>
                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Current Password</label>
                                <div className="relative">
                                    <input
                                        type={showPwds.current ? 'text' : 'password'}
                                        placeholder="Enter current password"
                                        value={pwdForm.current}
                                        onChange={e => setPwdForm(p => ({ ...p, current: e.target.value }))}
                                        className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3.5 pr-12 text-sm text-white placeholder-slate-600 outline-none transition-colors"
                                    />
                                    <button
                                        onClick={() => setShowPwds(p => ({ ...p, current: !p.current }))}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
                                    >
                                        {showPwds.current ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>

                            {/* New Password */}
                            <div>
                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">New Password</label>
                                <div className="relative">
                                    <input
                                        type={showPwds.newPwd ? 'text' : 'password'}
                                        placeholder="Min 8 characters"
                                        value={pwdForm.newPwd}
                                        onChange={e => setPwdForm(p => ({ ...p, newPwd: e.target.value }))}
                                        className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3.5 pr-12 text-sm text-white placeholder-slate-600 outline-none transition-colors"
                                    />
                                    <button
                                        onClick={() => setShowPwds(p => ({ ...p, newPwd: !p.newPwd }))}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
                                    >
                                        {showPwds.newPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                                {/* Strength indicator */}
                                {pwdForm.newPwd && (
                                    <div className="mt-2 flex gap-1">
                                        {[1,2,3,4].map(level => {
                                            const strength = Math.min(4, Math.floor(pwdForm.newPwd.length / 3))
                                            const colors = ['bg-rose-500', 'bg-amber-500', 'bg-blue-500', 'bg-emerald-500']
                                            return <div key={level} className={`h-1 flex-1 rounded-full transition-all duration-300 ${level <= strength ? colors[strength-1] : 'bg-white/10'}`} />
                                        })}
                                        <span className="text-[10px] text-slate-500 font-bold ml-1">
                                            {['', 'Weak', 'Fair', 'Good', 'Strong'][Math.min(4, Math.floor(pwdForm.newPwd.length / 3))]}
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* Confirm Password */}
                            <div>
                                <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Confirm New Password</label>
                                <div className="relative">
                                    <input
                                        type={showPwds.confirm ? 'text' : 'password'}
                                        placeholder="Repeat new password"
                                        value={pwdForm.confirm}
                                        onChange={e => setPwdForm(p => ({ ...p, confirm: e.target.value }))}
                                        onKeyDown={e => e.key === 'Enter' && handlePasswordChange()}
                                        className={`w-full bg-black/35 border focus:border-blue-500/50 rounded-xl px-4 py-3.5 pr-12 text-sm text-white placeholder-slate-600 outline-none transition-colors ${
                                            pwdForm.confirm && pwdForm.newPwd !== pwdForm.confirm
                                                ? 'border-rose-500/50'
                                                : 'border-white/5'
                                        }`}
                                    />
                                    <button
                                        onClick={() => setShowPwds(p => ({ ...p, confirm: !p.confirm }))}
                                        className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
                                    >
                                        {showPwds.confirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                                {pwdForm.confirm && pwdForm.newPwd !== pwdForm.confirm && (
                                    <p className="text-[11px] text-rose-400 font-bold mt-1.5 flex items-center gap-1">
                                        <AlertTriangle className="w-3 h-3" /> Passwords do not match
                                    </p>
                                )}
                            </div>

                            <button
                                onClick={handlePasswordChange}
                                disabled={pwdLoading || (pwdForm.confirm && pwdForm.newPwd !== pwdForm.confirm)}
                                className="w-full py-4 mt-2 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 disabled:from-blue-600/50 disabled:to-blue-700/50 text-white font-black text-xs uppercase tracking-wider shadow-lg shadow-blue-600/20 active:scale-[0.98] transition-all duration-300 flex items-center justify-center gap-2"
                            >
                                {pwdLoading ? (
                                    <><Loader2 className="w-4 h-4 animate-spin" /><span>Changing...</span></>
                                ) : pwdSuccess ? (
                                    <><Check className="w-4 h-4" /><span>Password Changed!</span></>
                                ) : (
                                    <><Lock className="w-4 h-4" /><span>Update Password</span></>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
