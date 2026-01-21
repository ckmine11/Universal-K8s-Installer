import { useState } from 'react'
import {
    CheckCircle2,
    XCircle,
    AlertTriangle,
    Loader2,
    Server,
    Cpu,
    HardDrive,
    Wifi,
    RefreshCw,
    Info,
    Shield,
    Package,
    Terminal,
    ChevronDown,
    ChevronUp,
    ChevronRight
} from 'lucide-react'

export default function NodeVerificationCard({ node, nodeType, index, onVerify, onRemove }) {
    const [verifying, setVerifying] = useState(false)
    const [verificationResult, setVerificationResult] = useState(null)
    const [retryCount, setRetryCount] = useState(0)
    const [showBlueprint, setShowBlueprint] = useState(false)

    const handleVerify = async (isRetry = false) => {
        console.log('[NodeVerification] handleVerify called with node:', {
            ip: node.ip,
            username: node.username,
            hasPassword: !!node.password,
            hasSSHKey: !!node.sshKey
        })

        if (!node.ip || !node.username || (!node.password && !node.sshKey)) {
            console.warn('[NodeVerification] Missing required fields')
            return
        }

        if (isRetry) {
            setRetryCount(prev => prev + 1)
        }

        setVerifying(true)
        setVerificationResult(null)

        try {
            const token = localStorage.getItem('token')
            const response = await fetch('/api/nodes/verify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(node)
            })

            console.log('Verification response status:', response.status)

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }

            const result = await response.json()
            console.log('Verification result:', result)
            setVerificationResult(result)

            if (onVerify) {
                onVerify(nodeType, index, result)
            }
        } catch (error) {
            setVerificationResult({
                status: 'error',
                errors: [`Failed to verify node: ${error.message}`]
            })
        } finally {
            setVerifying(false)
        }
    }

    const getStatusTheme = () => {
        if (verifying) return { color: 'text-blue-400', border: 'border-blue-500/30', bg: 'bg-blue-500/5' }
        if (!verificationResult) return { color: 'text-slate-500', border: 'border-white/5', bg: 'bg-white/5' }

        switch (verificationResult.status) {
            case 'ready':
                return { color: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5' }
            case 'ready-with-warnings':
                return { color: 'text-yellow-400', border: 'border-yellow-500/30', bg: 'bg-yellow-500/5' }
            default:
                return { color: 'text-red-400', border: 'border-red-500/30', bg: 'bg-red-500/5' }
        }
    }

    const getDeploymentStrategy = (osId) => {
        const strategies = {
            ubuntu: {
                manager: 'APT (Advanced Package Tool)',
                runtime: 'containerd.io (Docker Registry)',
                k8sRepo: 'pkgs.k8s.io (Debian stable)',
                steps: ['UFW Configuration', 'Kernel Modules (overlay, br_netfilter)', 'Systemd-resolved tweak']
            },
            centos: {
                manager: 'YUM/DNF Package Manager',
                runtime: 'containerd (Docker-ce repo)',
                k8sRepo: 'pkgs.k8s.io (RPM stable)',
                steps: ['Firewalld Port Mapping', 'SELinux Permissive auto-apply', 'Swap dynamic disable']
            },
            debian: {
                manager: 'APT',
                runtime: 'containerd',
                k8sRepo: 'GPG verified Kubernetes Repo',
                steps: ['Iptables-legacy handling', 'Cgroup driver alignment', 'Bridge-nf-call configuration']
            }
        }
        return strategies[osId] || strategies['ubuntu']
    }

    const theme = getStatusTheme()

    return (
        <div className={`mt-6 rounded-2xl border transition-all duration-500 overflow-hidden ${theme.border} ${theme.bg}`}>
            <div className="p-5 flex items-center justify-between">
                <div className="flex items-center space-x-4">
                    <div className={`p-3 rounded-2xl border ${theme.border} ${theme.color} bg-black/40 shadow-inner`}>
                        {verifying ? <Loader2 className="w-6 h-6 animate-spin" /> : <Shield className="w-64 h-64 text-white" style={{ width: '24px', height: '24px' }} />}
                    </div>
                    <div>
                        <div className="flex items-center space-x-2 mb-1">
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">System Assessment</span>
                            {verificationResult && (
                                <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${theme.border} ${theme.color} bg-white/5`}>
                                    {verificationResult.status.replace(/-/g, ' ')}
                                </span>
                            )}
                        </div>
                        <h4 className="font-bold text-base text-white">Advanced Diagnostic Engine</h4>
                    </div>
                </div>

                <div className="flex items-center space-x-3">
                    {verificationResult && verificationResult.status !== 'ready' && (
                        <button
                            onClick={() => handleVerify(true)}
                            disabled={verifying}
                            className="p-2.5 text-slate-400 hover:text-white transition-all bg-white/5 rounded-xl border border-white/5 hover:border-white/10"
                            title="Retry Diagnostics"
                        >
                            <RefreshCw className={`w-4 h-4 ${verifying ? 'animate-spin' : ''}`} />
                        </button>
                    )}
                    <button
                        onClick={() => handleVerify(false)}
                        disabled={verifying || !node.ip || !node.username}
                        className={`px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-tight transition-all flex items-center space-x-2 ${verifying
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                            : !node.ip || !node.username
                                ? 'bg-white/5 text-slate-600 border border-white/5 cursor-not-allowed'
                                : 'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-xl shadow-blue-600/20 border border-blue-500/50 hover:scale-105 active:scale-95'
                            }`}
                    >
                        {verifying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <span>{verifying ? 'Scanning...' : 'Kickstart Diagnostics'}</span>
                    </button>
                </div>
            </div>

            {verificationResult && (
                <div className="px-5 pb-5 animate-in">
                    {/* OS Infostrip */}
                    <div className="flex items-center justify-between py-4 border-t border-white/5 bg-black/20 px-5 -mx-5 mb-5 group">
                        <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                                <Server className="w-4 h-4 text-blue-400" />
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Environment Detected</p>
                                <p className="text-sm font-bold text-white">
                                    {verificationResult.osInfo?.prettyName || 'Unknown OS'} <span className="text-blue-500 font-black ml-1">[{verificationResult.osInfo?.id?.toUpperCase()}]</span>
                                </p>
                            </div>
                        </div>
                        {verificationResult.status !== 'error' && (
                            <button
                                onClick={() => setShowBlueprint(!showBlueprint)}
                                className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 text-[10px] font-black uppercase tracking-widest text-blue-400 transition-all"
                            >
                                <Package className="w-3.5 h-3.5" />
                                <span>{showBlueprint ? 'Hide Blueprint' : 'View Blueprint'}</span>
                                {showBlueprint ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>
                        )}
                    </div>

                    {/* BluePrint Overlay Section (New requested feature) */}
                    {showBlueprint && verificationResult.osInfo && (
                        <div className="mb-6 p-5 bg-gradient-to-br from-blue-500/10 to-transparent rounded-2xl border border-blue-500/20 animate-in">
                            <div className="flex items-center space-x-2 mb-4">
                                <Terminal className="w-4 h-4 text-blue-400" />
                                <h5 className="text-[11px] font-black uppercase tracking-widest text-blue-400">Node Implementation Blueprint</h5>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-3">
                                    <div className="flex items-start space-x-3">
                                        <div className="mt-1 w-1 h-1 rounded-full bg-blue-400"></div>
                                        <div>
                                            <p className="text-[10px] font-black text-slate-500 uppercase">Package Engine</p>
                                            <p className="text-xs text-slate-200">{getDeploymentStrategy(verificationResult.osInfo.id).manager}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-start space-x-3">
                                        <div className="mt-1 w-1 h-1 rounded-full bg-blue-400"></div>
                                        <div>
                                            <p className="text-[10px] font-black text-slate-500 uppercase">Container Mesh</p>
                                            <p className="text-xs text-slate-200">{getDeploymentStrategy(verificationResult.osInfo.id).runtime}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    <p className="text-[10px] font-black text-slate-500 uppercase mb-1">Target Actions:</p>
                                    <ul className="text-[10px] space-y-1.5 text-slate-400 font-medium">
                                        {getDeploymentStrategy(verificationResult.osInfo.id).steps.map((s, i) => (
                                            <li key={i} className="flex items-center">
                                                <ChevronRight size={10} className="text-blue-500 mr-1" />
                                                {s}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-3 gap-4">
                        {verificationResult.resources && (
                            <>
                                <div className="p-4 bg-black/40 rounded-2xl border border-white/5 group hover:border-purple-500/30 transition-all">
                                    <div className="flex items-center space-x-1.5 mb-2">
                                        <Cpu size={14} className="text-purple-400" />
                                        <span className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Compute</span>
                                    </div>
                                    <div className="flex items-end space-x-2">
                                        <span className="text-2xl font-black text-white leading-none">{verificationResult.resources.cpu.cores}</span>
                                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${verificationResult.resources.cpu.cores >= 2 ? 'text-emerald-400 bg-emerald-400/10' : 'text-red-400 bg-red-400/10'}`}>
                                            {verificationResult.resources.cpu.cores >= 2 ? 'PASS' : 'FAIL'}
                                        </span>
                                    </div>
                                </div>
                                <div className="p-4 bg-black/40 rounded-2xl border border-white/5 group hover:border-blue-500/30 transition-all">
                                    <div className="flex items-center space-x-1.5 mb-2">
                                        <HardDrive size={14} className="text-blue-400" />
                                        <span className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Memory</span>
                                    </div>
                                    <div className="flex items-end space-x-2">
                                        <span className="text-2xl font-black text-white leading-none">{verificationResult.resources.memory.totalGB}G</span>
                                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${verificationResult.resources.memory.totalGB >= 2 ? 'text-emerald-400 bg-emerald-400/10' : 'text-red-400 bg-red-400/10'}`}>
                                            {verificationResult.resources.memory.totalGB >= 2 ? 'PASS' : 'FAIL'}
                                        </span>
                                    </div>
                                </div>
                                <div className="p-4 bg-black/40 rounded-2xl border border-white/5 group hover:border-emerald-500/30 transition-all">
                                    <div className="flex items-center space-x-1.5 mb-2">
                                        <Wifi size={14} className="text-emerald-400" />
                                        <span className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Latency</span>
                                    </div>
                                    <div className="flex items-end space-x-2">
                                        <span className="text-2xl font-black text-white leading-none">{verificationResult.internet?.latency || '—'}</span>
                                        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${verificationResult.internet?.connected ? 'text-emerald-400 bg-emerald-400/10' : 'text-red-400 bg-red-400/10'}`}>
                                            {verificationResult.internet?.connected ? 'READY' : 'LOST'}
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Error & Warning Feed */}
                    {(verificationResult.errors?.length > 0 || verificationResult.warnings?.length > 0) && (
                        <div className="mt-5 space-y-3">
                            {verificationResult.errors?.map((err, i) => (
                                <div key={i} className="flex items-start space-x-3 text-[12px] text-red-400 bg-red-400/5 p-4 rounded-xl border border-red-400/20 shadow-lg shadow-red-500/5 animate-shake">
                                    <XCircle size={16} className="mt-0.5 shrink-0" />
                                    <span className="font-medium">{err}</span>
                                </div>
                            ))}
                            {verificationResult.warnings?.map((warn, i) => (
                                <div key={i} className="flex items-start space-x-3 text-[12px] text-yellow-500 bg-yellow-500/5 p-4 rounded-xl border border-yellow-500/20 shadow-lg shadow-yellow-500/5">
                                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                                    <span className="font-medium">{warn}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
