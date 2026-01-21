import { useState } from 'react'
import {
    CheckCircle2,
    XCircle,
    AlertTriangle,
    ChevronRight,
    Server,
    Package,
    Network,
    Shield,
    Cpu,
    HardDrive,
    Clock,
    FileText,
    Activity,
    Zap,
    ChevronDown,
    Map,
    Rocket,
    Layout,
    ArrowRight
} from 'lucide-react'

export default function DeploymentPlan({ config, verificationResults, onConfirm, onCancel, isInstalling }) {
    const [expanded, setExpanded] = useState({ 1: true })

    const generatePlan = () => {
        const firstMaster = config.masterNodes[0]?.ip
        const osId = (verificationResults?.[firstMaster]?.osInfo?.id || 'linux').toLowerCase()
        const isRedHat = osId === 'centos' || osId === 'rhel' || osId === 'rocky'

        const plan = {
            summary: {
                clusterName: config.clusterName,
                k8sVersion: config.k8sVersion,
                networkPlugin: config.networkPlugin,
                totalNodes: config.masterNodes.length + config.workerNodes.length,
            },
            phases: [
                {
                    id: 1,
                    name: 'Pre-flight Validation',
                    icon: Shield,
                    duration: '2m',
                    color: 'blue',
                    tasks: [
                        'SSH Connectivity Check',
                        `OS Distribution Match: ${isRedHat ? 'RHEL-based' : 'DEB-based'}`,
                        'Resource Requirements Validation',
                        'Kernel Module Readiness Test'
                    ]
                },
                {
                    id: 2,
                    name: 'Container Runtime Engine',
                    icon: Package,
                    duration: '5m',
                    color: 'purple',
                    tasks: [
                        'Disable Swap Space',
                        isRedHat ? 'Load overlay/br_netfilter (Safe Mode)' : 'Setup Overlay/Br_netfilter',
                        isRedHat ? 'Configure YUM Docker-CE repo' : 'Configure APT Docker-GPG keyrings',
                        'Install Containerd 1.7+'
                    ]
                },
                {
                    id: 3,
                    name: 'Kubernetes Binaries',
                    icon: Server,
                    duration: '4m',
                    color: 'blue',
                    tasks: [
                        isRedHat ? 'Download RHEL K8s Repo keys' : 'Add k8s.io APT repositories',
                        `Install Kubeadm/Kubelet v${config.k8sVersion}`,
                        'Configure Systemd Units',
                        isRedHat ? 'Set SELinux Permissive' : 'Hold Package Versions'
                    ]
                },
                {
                    id: 4,
                    name: 'Control Plane Bootstrap',
                    icon: Zap,
                    duration: '4m',
                    color: 'blue',
                    tasks: ['Initialize Kubeadm', 'Setup Cluster Admin Context', 'Apply RBAC Policies', 'Generate Join Tokens']
                },
                {
                    id: 5,
                    name: 'SDN Networking Fabric',
                    icon: Network,
                    duration: '2m',
                    color: 'emerald',
                    tasks: [`Apply ${config.networkPlugin.toUpperCase()} Manifests`, 'Wait for Interface Convergence', 'Verify IPAM Allocation']
                },
                {
                    id: 6,
                    name: 'Resource Scaling (Workers)',
                    icon: Cpu,
                    duration: '5m',
                    color: 'purple',
                    tasks: ['Execute Join Sequence', 'Synchronize Certificates', 'Wait for Node Ready Status']
                },
                {
                    id: 7,
                    name: 'Industrial Add-ons',
                    icon: Activity,
                    duration: '6m',
                    color: 'blue',
                    tasks: ['Install Ingress Controller', 'Deploy Monitoring Stack', 'Configure Logging Dashboard']
                }
            ]
        }
        return plan
    }

    const togglePhase = (id) => {
        setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
    }

    const planData = generatePlan()
    const allNodes = config.masterNodes.concat(config.workerNodes)

    return (
        <div className="fixed inset-0 bg-black/95 backdrop-blur-3xl z-[100] flex items-center justify-center p-4 md:p-10 animate-in">
            <div className="bg-[#0B0F1A] rounded-[48px] max-w-6xl w-full max-h-[90vh] overflow-hidden shadow-[0_0_100px_rgba(59,130,246,0.15)] border border-white/5 flex flex-col relative">

                {/* Tactical Header */}
                <div className="p-8 md:p-10 border-b border-white/5 bg-gradient-to-r from-blue-500/5 to-transparent flex flex-col md:flex-row md:items-center justify-between gap-6 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-blue-500/50 to-transparent"></div>

                    <div className="flex items-center space-x-6 relative z-10">
                        <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-blue-700 rounded-2xl flex items-center justify-center shadow-2xl shadow-blue-500/40 rotate-3 border border-white/20">
                            <Map className="w-8 h-8 text-white" />
                        </div>
                        <div>
                            <h2 className="text-3xl font-black tracking-tight text-white mb-1 uppercase italic">Tactical Deployment Plan</h2>
                            <p className="text-slate-400 font-medium flex items-center">
                                <Layout className="w-4 h-4 mr-2" />
                                Target Fleet: <span className="text-blue-400 font-black ml-1 uppercase">{planData.summary.clusterName}</span>
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center space-x-8 bg-black/40 px-8 py-6 rounded-[28px] border border-white/10 shadow-inner">
                        <div className="text-center">
                            <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-1.5 underline decoration-blue-500/30">Total ETA</p>
                            <div className="flex items-center text-blue-400 font-black text-lg">
                                <Clock className="w-4 h-4 mr-2" />
                                <span>~24m</span>
                            </div>
                        </div>
                        <div className="w-px h-10 bg-white/10"></div>
                        <div className="text-center">
                            <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-1.5 underline decoration-purple-500/30">Node Count</p>
                            <p className="font-black text-white text-lg">{planData.summary.totalNodes}</p>
                        </div>
                    </div>
                </div>

                {/* Workflow Execution View */}
                <div className="flex-1 overflow-y-auto p-8 md:p-12 space-y-6 custom-scrollbar bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]">
                    {planData.phases.map((phase) => (
                        <div key={phase.id} className={`group rounded-[36px] border transition-all duration-500 ${expanded[phase.id] ? 'bg-white/5 border-blue-500/30 shadow-2xl' : 'bg-transparent border-white/5 hover:border-white/20'}`}>
                            <button
                                onClick={() => togglePhase(phase.id)}
                                className="w-full p-8 flex items-center justify-between group"
                            >
                                <div className="flex items-center space-x-7">
                                    <div className={`w-14 h-14 rounded-[20px] flex items-center justify-center font-black text-xl border transition-all duration-500 ${expanded[phase.id] ? 'bg-blue-600 text-white border-blue-400 scale-110 shadow-lg shadow-blue-500/40' : 'bg-white/5 text-slate-600 border-white/10 shadow-inner'}`}>
                                        {phase.id}
                                    </div>
                                    <div className="text-left">
                                        <h4 className={`text-xl font-black transition-colors flex items-center tracking-tight ${expanded[phase.id] ? 'text-white' : 'text-slate-500'}`}>
                                            {phase.name}
                                            {expanded[phase.id] && <div className="ml-3 w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shadow-[0_0_8px_rgba(59,130,246,1)]"></div>}
                                        </h4>
                                        <div className="flex items-center space-x-4 mt-1">
                                            <p className="text-[10px] font-black uppercase text-slate-600 tracking-[0.2em]">{phase.duration} EXTENSION</p>
                                            <div className="w-1 h-1 rounded-full bg-slate-800"></div>
                                            <p className="text-[10px] font-black uppercase text-blue-500/60 tracking-[0.1em]">Phase Status: Initialized</p>
                                        </div>
                                    </div>
                                </div>
                                <div className={`w-10 h-10 rounded-full border border-white/10 flex items-center justify-center transition-all duration-500 ${expanded[phase.id] ? 'rotate-180 bg-blue-500/10 text-blue-400 border-blue-500/30' : 'text-slate-600'}`}>
                                    <ChevronDown size={18} />
                                </div>
                            </button>

                            {expanded[phase.id] && (
                                <div className="px-8 pb-10 animate-in slide-in-from-top-4 duration-500">
                                    <div className="ml-7 border-l-2 border-dashed border-blue-500/20 pl-14 grid grid-cols-1 lg:grid-cols-2 gap-10">
                                        {/* Task Execution Matrix */}
                                        <div className="space-y-4">
                                            <div className="flex items-center space-x-2 text-[10px] font-black uppercase text-blue-400 mb-2 tracking-widest px-2">
                                                <Activity size={12} className="text-blue-500" />
                                                <span>Task Execution Matrix</span>
                                            </div>
                                            <div className="space-y-3">
                                                {phase.tasks.map((task, idx) => (
                                                    <div key={idx} className="flex items-center space-x-4 p-4 bg-black/60 rounded-2xl border border-white/5 group-hover:border-blue-500/10 transition-all">
                                                        <div className="w-6 h-6 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-[10px] font-bold text-blue-400">
                                                            {idx + 1}
                                                        </div>
                                                        <span className="text-xs font-bold text-slate-300 tracking-tight">{task}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Target Vector Area */}
                                        <div className="space-y-4">
                                            <div className="flex items-center space-x-2 text-[10px] font-black uppercase text-purple-400 mb-2 tracking-widest px-2">
                                                <Server size={12} className="text-purple-500" />
                                                <span>Target Vector Activity</span>
                                            </div>
                                            <div className="p-6 bg-gradient-to-br from-black/60 to-purple-900/10 rounded-[32px] border border-white/5 h-full min-h-[140px]">
                                                <div className="flex flex-wrap gap-4">
                                                    {allNodes.map((n, i) => (
                                                        <div key={i} className="flex flex-col items-center group/node">
                                                            <div className="w-14 h-14 rounded-2xl bg-black border-2 border-white/5 flex items-center justify-center relative overflow-hidden group-hover/node:border-blue-500/50 transition-all duration-300 shadow-xl">
                                                                <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-transparent"></div>
                                                                <span className="text-[12px] font-black text-blue-400 z-10">.{n.ip.split('.').pop()}</span>
                                                                {/* Animation pulse for "active" node in plan */}
                                                                <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                                                            </div>
                                                            <span className="text-[9px] font-black text-slate-600 mt-2 group-hover/node:text-slate-400 transition-colors uppercase tracking-tighter">
                                                                {i < config.masterNodes.length ? 'Master' : 'Worker'}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="mt-8 p-4 bg-white/5 rounded-2xl border border-white/5 border-dashed">
                                                    <p className="text-[10px] text-slate-500 leading-relaxed font-bold italic">
                                                        "System will provision core binaries and synchronize certificates across all {allNodes.length} target vectors."
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* Tactical Action Bar */}
                <div className="p-10 border-t border-white/5 bg-black/40 flex flex-col md:flex-row md:items-center justify-between gap-8 relative overflow-hidden backdrop-blur-xl">
                    <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500/0 via-blue-500/30 to-blue-500/0"></div>

                    <div className="flex items-center space-x-6 max-w-xl">
                        <div className="w-14 h-14 bg-blue-500/10 rounded-2xl flex items-center justify-center border border-blue-500/20 shadow-inner">
                            <Shield className="w-7 h-7 text-blue-400" />
                        </div>
                        <div>
                            <p className="text-sm text-slate-300 leading-relaxed font-bold tracking-tight">
                                Converging infrastructure for <span className="text-blue-400 underline decoration-2 decoration-blue-500/20 underline-offset-4">{allNodes.length} instances</span>.
                            </p>
                            <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest mt-1">
                                Warning: Non-destructive but network disruptive sequence.
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center space-x-6">
                        <button
                            onClick={onCancel}
                            className="px-10 py-5 text-slate-500 hover:text-white font-black uppercase text-xs tracking-[0.2em] transition-all active:scale-95 flex items-center"
                        >
                            <XCircle className="w-4 h-4 mr-2" />
                            Abort Sequence
                        </button>
                        <button
                            onClick={onConfirm}
                            disabled={isInstalling}
                            className={`group px-14 py-6 bg-gradient-to-r from-blue-600 via-blue-500 to-blue-700 text-white rounded-[28px] font-black shadow-[0_20px_40px_rgba(59,130,246,0.4)] hover:shadow-blue-500/60 hover:scale-[1.03] active:scale-[0.97] transition-all flex items-center space-x-4 border border-white/20 ${isInstalling ? 'opacity-80 cursor-wait' : ''}`}
                        >
                            {isInstalling ? (
                                <>
                                    <div className="w-6 h-6 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
                                    <span className="uppercase tracking-widest italic text-lg">Initializing...</span>
                                </>
                            ) : (
                                <>
                                    <Rocket className="w-6 h-6 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                                    <span className="uppercase tracking-widest italic text-lg">Initiate Deployment</span>
                                    <ArrowRight className="w-5 h-5 opacity-50" />
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
