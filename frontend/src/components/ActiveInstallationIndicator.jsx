import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useInstallationTracker } from '../context/InstallationTrackerContext'
import {
    Terminal, X, ChevronUp, ChevronDown, Loader2,
    CheckCircle2, XCircle, ArrowRight, Minimize2, Maximize2, Rocket
} from 'lucide-react'

export default function ActiveInstallationIndicator() {
    const navigate = useNavigate()
    const location = useLocation()
    const { activeInstallations, removeInstallation } = useInstallationTracker()
    const [isExpanded, setIsExpanded] = useState(false)
    const [isMinimized, setIsMinimized] = useState(false)
    const [dismissedIds, setDismissedIds] = useState(new Set())

    // Filter: show only running or recently completed/failed (not dismissed)
    const visibleInstallations = activeInstallations.filter(
        i => !dismissedIds.has(i.id)
    )

    const runningCount = visibleInstallations.filter(i => i.status === 'running').length

    // Don't show if nothing to track
    if (visibleInstallations.length === 0) return null

    // Don't show on the installation dashboard itself (user is already there)
    const currentDashboardId = location.pathname.match(/\/dashboard\/(.+)/)?.[1]
        || location.pathname.match(/\/installation\/(.+)/)?.[1]

    // If there's only one installation and user is on its dashboard, hide
    if (visibleInstallations.length === 1 && visibleInstallations[0].id === currentDashboardId) {
        return null
    }

    const handleDismiss = (e, id) => {
        e.stopPropagation()
        setDismissedIds(prev => new Set([...prev, id]))
        // Auto-remove from tracker after dismissal if completed/failed
        const inst = activeInstallations.find(i => i.id === id)
        if (inst && inst.status !== 'running') {
            removeInstallation(id)
        }
    }

    const handleNavigate = (id) => {
        navigate(`/dashboard/${id}`)
        setIsExpanded(false)
    }

    const getModeLabel = (mode) => {
        switch (mode) {
            case 'install': return 'Cluster Install'
            case 'scale': return 'Node Scaling'
            case 'upgrade': return 'Version Upgrade'
            case 'addon-only': return 'Add-on Install'
            default: return 'Installation'
        }
    }

    const getStatusIcon = (status) => {
        switch (status) {
            case 'running':
                return <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
            case 'completed':
                return <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            case 'failed':
                return <XCircle className="w-4 h-4 text-rose-400" />
            default:
                return <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
        }
    }

    const getStatusColor = (status) => {
        switch (status) {
            case 'running': return 'border-blue-500/30 bg-blue-500/5'
            case 'completed': return 'border-emerald-500/30 bg-emerald-500/5'
            case 'failed': return 'border-rose-500/30 bg-rose-500/5'
            default: return 'border-blue-500/30 bg-blue-500/5'
        }
    }

    if (isMinimized) {
        return (
            <div className="fixed bottom-6 right-6 z-[9999]">
                <button
                    onClick={() => setIsMinimized(false)}
                    className="relative group flex items-center gap-2 px-4 py-3 bg-[#0d1117]/95 backdrop-blur-xl border border-blue-500/30 rounded-2xl shadow-2xl shadow-blue-500/10 hover:border-blue-500/50 transition-all duration-300 active:scale-95"
                >
                    {/* Pulse ring for running */}
                    {runningCount > 0 && (
                        <span className="absolute -top-1 -right-1 flex h-4 w-4">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-4 w-4 bg-blue-500 items-center justify-center text-[8px] font-black text-white">{runningCount}</span>
                        </span>
                    )}
                    <Terminal className="w-5 h-5 text-blue-400" />
                    <Maximize2 className="w-3.5 h-3.5 text-slate-500 group-hover:text-white transition-colors" />
                </button>
            </div>
        )
    }

    return (
        <div className="fixed bottom-6 right-6 z-[9999] w-[380px] animate-in slide-in-from-bottom-4 duration-300">
            <div className="bg-[#0d1117]/95 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl shadow-black/40 overflow-hidden">
                {/* Header Bar */}
                <div
                    className="flex items-center justify-between px-5 py-4 border-b border-white/5 cursor-pointer hover:bg-white/[0.02] transition-colors"
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    <div className="flex items-center gap-3">
                        <div className="relative">
                            <div className="p-2 bg-blue-500/15 rounded-xl border border-blue-500/20">
                                <Terminal className="w-4 h-4 text-blue-400" />
                            </div>
                            {runningCount > 0 && (
                                <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-blue-500"></span>
                                </span>
                            )}
                        </div>
                        <div>
                            <h4 className="text-xs font-black text-white uppercase tracking-wider">
                                Active Processes
                            </h4>
                            <p className="text-[10px] text-slate-500 font-bold">
                                {runningCount > 0
                                    ? `${runningCount} running`
                                    : 'All completed'
                                } · {visibleInstallations.length} total
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsMinimized(true) }}
                            className="p-1.5 rounded-lg text-slate-600 hover:text-white hover:bg-white/10 transition-all"
                            title="Minimize"
                        >
                            <Minimize2 className="w-3.5 h-3.5" />
                        </button>
                        <div className="p-1.5 rounded-lg text-slate-600">
                            {isExpanded
                                ? <ChevronDown className="w-3.5 h-3.5" />
                                : <ChevronUp className="w-3.5 h-3.5" />
                            }
                        </div>
                    </div>
                </div>

                {/* Installations List - Always show at least the compact view */}
                <div className={`transition-all duration-300 ${isExpanded ? 'max-h-[400px]' : 'max-h-[180px]'} overflow-y-auto`}>
                    <div className="p-3 space-y-2">
                        {visibleInstallations.map(inst => {
                            const isCurrentDashboard = inst.id === currentDashboardId

                            return (
                                <div
                                    key={inst.id}
                                    className={`group relative rounded-2xl border p-3.5 transition-all duration-200 ${
                                        isCurrentDashboard
                                            ? 'border-blue-500/40 bg-blue-500/10'
                                            : `${getStatusColor(inst.status)} hover:bg-white/[0.03] cursor-pointer`
                                    }`}
                                    onClick={() => !isCurrentDashboard && handleNavigate(inst.id)}
                                >
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2.5">
                                            {getStatusIcon(inst.status)}
                                            <div>
                                                <p className="text-xs font-black text-white leading-none">
                                                    {inst.clusterName || 'Cluster'}
                                                </p>
                                                <p className="text-[10px] text-slate-500 font-bold mt-0.5">
                                                    {getModeLabel(inst.mode)}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1.5">
                                            {isCurrentDashboard ? (
                                                <span className="text-[9px] px-2 py-0.5 bg-blue-500/20 border border-blue-500/30 rounded-full text-blue-400 font-black uppercase tracking-wider">
                                                    Viewing
                                                </span>
                                            ) : (
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); handleNavigate(inst.id) }}
                                                    className="flex items-center gap-1 px-2.5 py-1 bg-white/5 hover:bg-blue-500/20 border border-white/5 hover:border-blue-500/30 rounded-lg text-[10px] font-black text-slate-400 hover:text-blue-400 transition-all"
                                                >
                                                    <span>View</span>
                                                    <ArrowRight className="w-3 h-3" />
                                                </button>
                                            )}
                                            {inst.status !== 'running' && (
                                                <button
                                                    onClick={(e) => handleDismiss(e, inst.id)}
                                                    className="p-1 rounded-lg text-slate-600 hover:text-white hover:bg-white/10 transition-all opacity-0 group-hover:opacity-100"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Progress Bar */}
                                    {inst.status === 'running' && (
                                        <div className="mt-2">
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="text-[10px] text-slate-500 font-bold truncate max-w-[200px]">
                                                    {inst.currentStep || 'Processing...'}
                                                </span>
                                                <span className="text-[10px] font-black text-blue-400 ml-2">
                                                    {inst.progress || 0}%
                                                </span>
                                            </div>
                                            <div className="w-full bg-white/5 rounded-full h-1.5 overflow-hidden">
                                                <div
                                                    className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-700 ease-out"
                                                    style={{ width: `${inst.progress || 0}%` }}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {inst.status === 'completed' && (
                                        <p className="text-[10px] text-emerald-400/80 font-bold mt-1">
                                            ✅ Successfully completed
                                        </p>
                                    )}

                                    {inst.status === 'failed' && (
                                        <p className="text-[10px] text-rose-400/80 font-bold mt-1">
                                            ❌ Process failed — click to view details
                                        </p>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>
        </div>
    )
}
