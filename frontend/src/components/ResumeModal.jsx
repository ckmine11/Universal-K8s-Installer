import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, XCircle, Loader2, AlertTriangle, PlayCircle, X, SkipForward } from 'lucide-react'
import { apiFetch } from '../context/AuthContext'

const STEP_LABELS = {
    installContainerRuntime:     'Install Container Runtime',
    installKubernetesComponents: 'Install Kubernetes Components',
    initializeControlPlane:      'Initialize Control Plane',
    installNetworkPlugin:        'Install Network Plugin',
    joinNodes:                   'Join Worker Nodes',
    installAddons:               'Install Add-ons',
    postValidation:              'Post-install Validation'
}

export default function ResumeModal({ cluster, onClose }) {
    const navigate = useNavigate()
    const [phase, setPhase] = useState('analyzing') // analyzing | ready | resuming | error
    const [analysis, setAnalysis] = useState(null)
    const [error, setError] = useState(null)

    useEffect(() => {
        analyze()
    }, [])

    const analyze = async () => {
        setPhase('analyzing')
        setError(null)
        try {
            const res = await apiFetch(`/api/clusters/${cluster.id}/analyze`, {
                method: 'POST'
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Analysis failed')
            setAnalysis(data)
            setPhase('ready')
        } catch (err) {
            setError(err.message)
            setPhase('error')
        }
    }

    const handleResume = async () => {
        setPhase('resuming')
        try {
            const res = await apiFetch(`/api/clusters/${cluster.id}/resume`, {
                method: 'POST',
                body: JSON.stringify({ analysis })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Resume failed to start')
            onClose()
            navigate(`/dashboard/${data.resumeInstallationId}`)
        } catch (err) {
            setError(err.message)
            setPhase('error')
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
            <div className="w-full max-w-lg bg-[#0d0d0f] border border-white/10 rounded-[28px] shadow-2xl overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between px-7 pt-7 pb-4">
                    <div>
                        <h2 className="text-xl font-black text-white">Resume Installation</h2>
                        <p className="text-slate-400 text-sm mt-0.5">{cluster.clusterName}</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>

                <div className="px-7 pb-7">

                    {/* Analyzing */}
                    {phase === 'analyzing' && (
                        <div className="py-10 flex flex-col items-center gap-4">
                            <div className="relative">
                                <div className="w-14 h-14 rounded-full border-2 border-blue-500/20 flex items-center justify-center">
                                    <Loader2 className="w-7 h-7 text-blue-400 animate-spin" />
                                </div>
                                <span className="absolute -bottom-1 -right-1 flex h-4 w-4">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-40"></span>
                                    <span className="relative inline-flex rounded-full h-4 w-4 bg-blue-500"></span>
                                </span>
                            </div>
                            <div className="text-center">
                                <p className="text-white font-semibold">Analyzing cluster state...</p>
                                <p className="text-slate-500 text-sm mt-1">
                                    Connecting via SSH to detect what completed
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Error */}
                    {phase === 'error' && (
                        <div className="py-6 space-y-4">
                            <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl">
                                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                                <p className="text-red-300 text-sm">{error}</p>
                            </div>
                            <button
                                onClick={analyze}
                                className="w-full py-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold text-sm transition-all"
                            >
                                Retry Analysis
                            </button>
                        </div>
                    )}

                    {/* Ready */}
                    {phase === 'ready' && analysis && (
                        <div className="space-y-5">

                            {/* Analysis checklist */}
                            <div className="space-y-2">
                                {analysis.checks.map((check) => (
                                    <div key={check.key}
                                        className={`flex items-start gap-3 px-4 py-3 rounded-xl border transition-all
                                            ${check.done
                                                ? 'bg-emerald-500/5 border-emerald-500/15'
                                                : check.skipped
                                                    ? 'bg-white/3 border-white/5 opacity-50'
                                                    : check.key === analysis.resumeFromStep
                                                        ? 'bg-amber-500/10 border-amber-500/30'
                                                        : 'bg-red-500/5 border-red-500/15'
                                            }`}
                                    >
                                        <div className="flex-shrink-0 mt-0.5">
                                            {check.done
                                                ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                                                : check.skipped
                                                    ? <SkipForward className="w-4 h-4 text-slate-600" />
                                                    : check.key === analysis.resumeFromStep
                                                        ? <PlayCircle className="w-4 h-4 text-amber-400" />
                                                        : <XCircle className="w-4 h-4 text-red-400" />
                                            }
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className={`text-sm font-semibold ${
                                                check.done ? 'text-slate-200'
                                                : check.skipped ? 'text-slate-600'
                                                : check.key === analysis.resumeFromStep ? 'text-amber-300'
                                                : 'text-slate-300'
                                            }`}>
                                                {check.label}
                                                {check.key === analysis.resumeFromStep && (
                                                    <span className="ml-2 px-2 py-0.5 bg-amber-500/20 text-amber-400 text-[10px] font-black uppercase tracking-wider rounded-full">
                                                        Resume Point
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-xs text-slate-500 mt-0.5 truncate">{check.detail}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Summary banner */}
                            <div className="flex items-center gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl">
                                <PlayCircle className="w-5 h-5 text-blue-400 flex-shrink-0" />
                                <p className="text-blue-300 text-sm font-medium">{analysis.summary}</p>
                            </div>

                            {/* Actions */}
                            <div className="flex gap-3 pt-1">
                                <button
                                    onClick={onClose}
                                    className="flex-1 py-3 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 font-bold text-sm transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleResume}
                                    className="flex-1 py-3 rounded-2xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-black text-sm shadow-lg shadow-blue-500/20 transition-all active:scale-95 flex items-center justify-center gap-2"
                                >
                                    <PlayCircle className="w-4 h-4" />
                                    Resume Now
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Resuming */}
                    {phase === 'resuming' && (
                        <div className="py-10 flex flex-col items-center gap-4">
                            <Loader2 className="w-10 h-10 text-blue-400 animate-spin" />
                            <div className="text-center">
                                <p className="text-white font-semibold">Starting resume...</p>
                                <p className="text-slate-500 text-sm mt-1">Redirecting to installation stream</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
