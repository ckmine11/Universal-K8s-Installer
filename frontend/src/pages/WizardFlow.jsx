import { useState, useEffect } from 'react'
import { useToast } from '../components/ToastProvider'
import { ADDONS_LIST } from '../config/addons'
import { K8S_VERSIONS } from '../config/versions'
import {
    ChevronRight,
    Server,
    Settings,
    Package,
    Rocket,
    Plus,
    Trash2,
    Eye,
    EyeOff,
    Terminal,
    Shield,
    Cpu,
    Globe,
    ChevronLeft,
    CheckCircle2,
    Info,
    AlertTriangle,
    FileCode,
    Network,
    Zap,
    Activity,
    BarChart3,
    LayoutDashboard,
    Database,
    GitBranch,
    Sparkles
} from 'lucide-react'
import NodeVerificationCard from '../components/NodeVerificationCard'
import DeploymentPlan from '../components/DeploymentPlan'

export default function WizardFlow({ onStartInstallation, onCancel, mode = 'install', initialData = null }) {
    const { toast } = useToast()
    const [currentStep, setCurrentStep] = useState(mode === 'scale' ? 2 : 1)
    const [formData, setFormData] = useState({
        clusterName: mode === 'scale' ? 'Existing Cluster' : '',
        k8sVersion: '1.28.0',
        networkPlugin: 'flannel',
        masterNodes: [{ ip: '', username: 'root', password: '', sshKey: '', verified: false, verificationResult: null }],
        workerNodes: [],
        addons: {
            ingress: true,
            monitoring: false,
            dashboard: false,
            'cert-manager': false,
            longhorn: false,
            argocd: false
        }
    })

    useEffect(() => {
        if (initialData) {
            setFormData({
                clusterName: initialData.clusterName || formData.clusterName,
                k8sVersion: initialData.k8sVersion || formData.k8sVersion,
                networkPlugin: initialData.networkPlugin || formData.networkPlugin,
                addons: initialData.addons || formData.addons,
                // Ensure nodes are marked as not verified initially in the wizard view, 
                // but keep their data. If no masters found, initialize with one empty node.
                masterNodes: (initialData.masterNodes && initialData.masterNodes.length > 0)
                    ? initialData.masterNodes.map(n => ({
                        ...n,
                        verified: false,
                        verificationResult: null
                    }))
                    : [{ id: 1, ip: '', username: 'root', password: '', verified: false, verificationResult: null }],

                workerNodes: (initialData.workerNodes || []).map(n => ({
                    ...n,
                    verified: false,
                    verificationResult: null
                }))
            })
        }
    }, [initialData])
    const [showPasswords, setShowPasswords] = useState({})
    const [showDeploymentPlan, setShowDeploymentPlan] = useState(false)
    const [isInstalling, setIsInstalling] = useState(false)

    // Compute derived state for all nodes and their verification results
    const allNodes = formData.masterNodes.map(n => ({ ...n, role: 'master' }))
        .concat(formData.workerNodes.map(n => ({ ...n, role: 'worker' })))

    const verificationResults = allNodes.reduce((acc, node) => {
        if (node.ip && node.verificationResult) {
            acc[node.ip] = node.verificationResult
        }
        return acc
    }, {})

    const steps = [
        ...(mode === 'install' ? [{ id: 1, title: 'Cluster Basics', icon: Globe }] : []),
        { id: 2, title: 'Configure Nodes', icon: Server },
        ...(mode === 'install' ? [{ id: 3, title: 'Select Add-ons', icon: Package }] : []),
        { id: 4, title: 'Review & Launch', icon: Rocket }
    ]

    const addNode = (type) => {
        const newNode = { ip: '', username: 'root', password: '', sshKey: '', verified: false, verificationResult: null }
        if (type === 'master') {
            setFormData({ ...formData, masterNodes: [...formData.masterNodes, newNode] })
        } else {
            setFormData({ ...formData, workerNodes: [...formData.workerNodes, newNode] })
        }
    }

    const removeNode = (type, index) => {
        if (type === 'master') {
            const newMasters = formData.masterNodes.filter((_, i) => i !== index)
            setFormData({ ...formData, masterNodes: newMasters })
        } else {
            const newWorkers = formData.workerNodes.filter((_, i) => i !== index)
            setFormData({ ...formData, workerNodes: newWorkers })
        }
    }

    const updateNode = (type, index, field, value) => {
        const nodesKey = type === 'master' ? 'masterNodes' : 'workerNodes'
        const newNodes = [...formData[nodesKey]]
        newNodes[index][field] = value

        // Reset verification when node details change
        if (['ip', 'username', 'password', 'sshKey'].includes(field)) {
            newNodes[index].verified = false
            newNodes[index].verificationResult = null
        }

        setFormData({ ...formData, [nodesKey]: newNodes })
    }

    const handleNodeVerification = (type, index, result) => {
        const nodesKey = type === 'master' ? 'masterNodes' : 'workerNodes'
        const newNodes = [...formData[nodesKey]]
        newNodes[index].verified = true
        newNodes[index].verificationResult = result
        setFormData({ ...formData, [nodesKey]: newNodes })
    }

    const togglePasswordVisibility = (key) => {
        setShowPasswords(prev => ({ ...prev, [key]: !prev[key] }))
    }

    const canProceedToNextStep = () => {
        if (currentStep === 1) {
            return formData.clusterName.trim() !== ''
        }
        if (currentStep === 2) {
            // Check if all nodes are verified and ready
            const allMastersVerified = formData.masterNodes.every(node =>
                node.verified &&
                node.verificationResult &&
                (node.verificationResult.status === 'ready' || node.verificationResult.status === 'ready-with-warnings')
            )

            const allWorkersVerified = formData.workerNodes.length === 0 || formData.workerNodes.every(node =>
                node.verified &&
                node.verificationResult &&
                (node.verificationResult.status === 'ready' || node.verificationResult.status === 'ready-with-warnings')
            )

            return allMastersVerified && allWorkersVerified
        }
        return true
    }

    const nextStep = () => {
        if (canProceedToNextStep()) {
            if (mode === 'scale' && currentStep === 2) {
                setCurrentStep(4)
            } else {
                setCurrentStep(prev => Math.min(4, prev + 1))
            }
        }
    }

    const prevStep = () => {
        if (mode === 'scale' && currentStep === 2) {
            onCancel()
        } else if (mode === 'scale' && currentStep === 4) {
            setCurrentStep(2)
        } else if (mode === 'install' && currentStep === 1) {
            onCancel()
        } else {
            setCurrentStep(prev => Math.max(1, prev - 1))
        }
    }

    const handleInstallClick = () => {
        setShowDeploymentPlan(true)
    }

    // Helper to remove circular references from node data
    const sanitizeNodeData = (nodes) => {
        return nodes.map(node => ({
            ip: node.ip,
            username: node.username,
            password: node.password,
            sshKey: node.sshKey,
            hostname: node.hostname
        }))
    }

    const handleConfirmInstall = async () => {
        try {
            setIsInstalling(true)

            // Sanitize formData - be COMPLETELY explicit to avoid any circular references
            const sanitizedData = {
                clusterName: formData.clusterName,
                k8sVersion: formData.k8sVersion,
                networkPlugin: formData.networkPlugin,
                addons: formData.addons ? {
                    ingress: !!formData.addons.ingress,
                    monitoring: !!formData.addons.monitoring,
                    logging: !!formData.addons.logging,
                    dashboard: !!formData.addons.dashboard
                } : {},
                mode: mode,
                masterNodes: sanitizeNodeData(formData.masterNodes),
                workerNodes: sanitizeNodeData(formData.workerNodes || [])
            }

            console.log('FormData state:', {
                clusterName: formData.clusterName,
                masterNodesCount: formData.masterNodes?.length,
                workerNodesCount: formData.workerNodes?.length,
                masterNodes: formData.masterNodes,
                workerNodes: formData.workerNodes
            })
            console.log('Sending to backend:', sanitizedData)

            const token = localStorage.getItem('token')
            const response = await fetch('/api/clusters/install', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(sanitizedData)
            })

            const result = await response.json()

            if (result.installationId) {
                // Keep modal open for a split second to show success state if we wanted, 
                // but navigating immediately is fine too.
                onStartInstallation(result.installationId)
            } else {
                throw new Error(result.error || 'Failed to start installation')
            }
        } catch (error) {
            console.error('Installation trigger error:', error)
            toast({
                title: 'Installation Failed',
                message: error.message,
                type: 'error'
            })
            setIsInstalling(false)
        }
        // Do NOT set isInstalling(false) on success, because we are navigating away 
        // and we don't want the button to re-enable before unmount.
    }

    return (
        <div className="max-w-5xl mx-auto py-8 px-4 selection:bg-blue-500/30">
            {/* Horizontal Step Indicator */}
            <div className="flex items-center justify-center mb-16 animate-in">
                {steps.map((step, idx) => (
                    <div key={step.id} className="flex items-center">
                        <div className="flex flex-col items-center relative">
                            <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-500 shadow-xl ${currentStep >= step.id
                                ? 'bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-blue-500/20'
                                : 'bg-white/5 text-slate-500 border border-white/10'
                                }`}>
                                <step.icon className="w-5 h-5" />
                                {currentStep === step.id && (
                                    <div className="absolute -inset-1 bg-blue-500 blur-md opacity-20 animate-pulse rounded-xl"></div>
                                )}
                            </div>
                            <span className={`absolute -bottom-8 text-[10px] font-black uppercase tracking-widest whitespace-nowrap ${currentStep >= step.id ? 'text-blue-400' : 'text-slate-500'
                                }`}>
                                {step.title}
                            </span>
                        </div>
                        {idx < steps.length - 1 && (
                            <div className={`w-16 md:w-24 h-px mx-4 transition-colors duration-500 ${currentStep > step.id ? 'bg-blue-500' : 'bg-white/10'
                                }`} />
                        )}
                    </div>
                ))}
            </div>

            <div className="glass-card rounded-[40px] p-8 md:p-12 relative overflow-hidden animate-in [animation-delay:200ms]">
                <div className="absolute top-0 right-0 p-12 opacity-[0.02] pointer-events-none">
                    <Shield className="w-64 h-64 text-white" />
                </div>

                <div className="relative z-10">
                    {/* Step 1: Basics */}
                    {currentStep === 1 && (
                        <div className="animate-in">
                            <div className="mb-10">
                                <h2 className="text-4xl font-black mb-2 tracking-tight">Cluster Parameters</h2>
                                <p className="text-slate-400">Define the core identity and runtime for your infrastructure.</p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                <div className="space-y-2">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-500 ml-1">Cluster Identifier</label>
                                    <input
                                        type="text"
                                        placeholder="e.g. production-omega"
                                        className="w-full px-6 py-4 rounded-2xl font-medium"
                                        value={formData.clusterName}
                                        onChange={(e) => setFormData({ ...formData, clusterName: e.target.value })}
                                        required
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-500 ml-1">K8s Runtime Version</label>
                                    <select
                                        className="w-full px-6 py-4 rounded-2xl bg-white/5 border border-white/10 text-white focus:outline-none focus:border-blue-500 transition-all font-medium appearance-none"
                                        value={formData.k8sVersion}
                                        onChange={(e) => setFormData({ ...formData, k8sVersion: e.target.value })}
                                    >
                                        {K8S_VERSIONS.map(v => (
                                            <option key={v.value} value={v.value} className="bg-slate-900">
                                                {v.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="md:col-span-2 space-y-2">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-500 ml-1">Networking Fabric Overlay</label>
                                    <div className="grid grid-cols-2 gap-4">
                                        {['flannel', 'calico'].map(plugin => (
                                            <button
                                                key={plugin}
                                                type="button"
                                                onClick={() => setFormData({ ...formData, networkPlugin: plugin })}
                                                className={`px-6 py-4 rounded-2xl border transition-all text-sm font-bold flex items-center justify-center space-x-2 ${formData.networkPlugin === plugin
                                                    ? 'border-blue-500 bg-blue-500/10 text-blue-400'
                                                    : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10'
                                                    }`}
                                            >
                                                <div className={`w-2 h-2 rounded-full ${formData.networkPlugin === plugin ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]' : 'bg-slate-600'}`}></div>
                                                <span className="capitalize">{plugin} CNI Fabric</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Step 2: Nodes & Verification */}
                    {currentStep === 2 && (
                        <div className="animate-in">
                            <div className="mb-10 flex items-center justify-between">
                                <div>
                                    <h2 className="text-4xl font-black mb-2 tracking-tight">Compute Resources</h2>
                                    <p className="text-slate-400">Map your nodes and perform <span className="text-white font-medium">Pre-flight verification</span>.</p>
                                </div>
                                {mode === 'scale' && (
                                    <div className="px-4 py-2 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-center space-x-2">
                                        <Info className="w-4 h-4 text-blue-400" />
                                        <span className="text-xs font-bold text-blue-400 uppercase">Scaling Active Fabric</span>
                                    </div>
                                )}
                            </div>

                            {/* Master Nodes Section - Redesigned for Scaling */}
                            {mode === 'scale' ? (
                                <>
                                    {/* Scale Mode Header Banner */}
                                    <div className="mb-8 p-6 bg-gradient-to-r from-purple-500/10 via-blue-500/10 to-cyan-500/10 border border-purple-500/20 rounded-2xl">
                                        <div className="flex items-start space-x-4">
                                            <div className="p-3 bg-purple-500/20 rounded-xl">
                                                <Zap className="w-6 h-6 text-purple-400" />
                                            </div>
                                            <div className="flex-1">
                                                <h3 className="text-lg font-black text-white mb-2">Intelligent Cluster Scaling</h3>
                                                <p className="text-sm text-slate-300 leading-relaxed mb-3">
                                                    Add new control plane (HA masters) or worker nodes to your existing cluster.
                                                    The system will automatically configure HA support and join new nodes seamlessly.
                                                </p>
                                                <div className="flex items-center space-x-4 text-xs">
                                                    <div className="flex items-center space-x-2 text-emerald-400">
                                                        <CheckCircle2 className="w-4 h-4" />
                                                        <span>Zero Downtime</span>
                                                    </div>
                                                    <div className="flex items-center space-x-2 text-blue-400">
                                                        <Shield className="w-4 h-4" />
                                                        <span>HA Auto-Config</span>
                                                    </div>
                                                    <div className="flex items-center space-x-2 text-purple-400">
                                                        <Activity className="w-4 h-4" />
                                                        <span>Live Migration</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Bridge Master Section (Existing Cluster) */}
                                    <div className="space-y-6 mb-12">
                                        <div className="flex items-center justify-between px-2">
                                            <div className="flex items-center space-x-3">
                                                <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center border border-blue-400/50 shadow-lg shadow-blue-500/20">
                                                    <Shield className="w-5 h-5 text-white" />
                                                </div>
                                                <div>
                                                    <h3 className="text-base font-black uppercase tracking-wider text-white">Bridge Master Connection</h3>
                                                    <p className="text-[11px] text-slate-400 uppercase tracking-wide">Existing Cluster Authentication</p>
                                                </div>
                                            </div>
                                            <div className="px-4 py-2 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                                                <span className="text-xs font-black text-blue-400 uppercase tracking-wider">Step 1 of 2</span>
                                            </div>
                                        </div>

                                        <div className="p-6 bg-blue-500/5 border-2 border-blue-500/20 rounded-2xl">
                                            <div className="flex items-start space-x-3 mb-4">
                                                <Info className="w-5 h-5 text-blue-400 mt-0.5" />
                                                <div className="text-sm text-slate-300 leading-relaxed">
                                                    <p className="font-semibold text-white mb-1">Connect to your existing cluster master node</p>
                                                    <p>Provide SSH credentials for the current control plane. This allows us to patch the cluster configuration for HA support and generate join tokens for new nodes.</p>
                                                </div>
                                            </div>
                                        </div>

                                        {(formData.masterNodes.length > 0 ? formData.masterNodes : [{ id: 'fallback', ip: '', username: 'root', password: '', verified: false }]).slice(0, 1).map((node, idx) => (
                                            <div key={idx} className="p-8 bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl border-2 border-blue-500/30 space-y-6 relative overflow-hidden shadow-2xl">
                                                <div className="absolute top-0 right-0 px-5 py-2 bg-gradient-to-r from-blue-600 to-blue-700 text-white text-[10px] font-black uppercase tracking-widest rounded-bl-2xl shadow-lg z-10 flex items-center space-x-2">
                                                    <Server className="w-3.5 h-3.5" />
                                                    <span>Primary Control Plane</span>
                                                </div>
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">Host IP Address</label>
                                                        <input
                                                            type="text"
                                                            placeholder="e.g. 192.168.1.100"
                                                            className="w-full px-5 py-3 rounded-xl bg-black/40 border border-blue-500/20 focus:border-blue-500 outline-none placeholder:text-slate-700"
                                                            value={node.ip}
                                                            onChange={(e) => updateNode('master', idx, 'ip', e.target.value)}
                                                        />
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Username</label>
                                                        <input
                                                            type="text"
                                                            placeholder="root"
                                                            className="w-full px-5 py-3 rounded-xl bg-black/40 border border-blue-500/20 focus:border-blue-500 outline-none placeholder:text-slate-700"
                                                            value={node.username}
                                                            onChange={(e) => updateNode('master', idx, 'username', e.target.value)}
                                                        />
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Authentication</label>
                                                        <div className="relative">
                                                            <input
                                                                type={showPasswords[`m-${idx}`] ? "text" : "password"}
                                                                placeholder="SSH Password"
                                                                className="w-full px-5 py-3 rounded-xl bg-black/40 border border-blue-500/20 focus:border-blue-500 outline-none placeholder:text-slate-700"
                                                                value={node.password}
                                                                onChange={(e) => updateNode('master', idx, 'password', e.target.value)}
                                                            />
                                                            <button
                                                                onClick={() => togglePasswordVisibility(`m-${idx}`)}
                                                                className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500"
                                                            >
                                                                {showPasswords[`m-${idx}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Private Key Path (Optional)</label>
                                                        <input
                                                            type="text"
                                                            placeholder="/root/.ssh/id_rsa"
                                                            className="w-full px-5 py-3 rounded-xl bg-black/40 border border-blue-500/20 focus:border-blue-500 outline-none placeholder:text-slate-700"
                                                            value={node.sshKey}
                                                            onChange={(e) => updateNode('master', idx, 'sshKey', e.target.value)}
                                                        />
                                                    </div>
                                                </div>
                                                <NodeVerificationCard
                                                    node={node}
                                                    nodeType="master"
                                                    index={idx}
                                                    onVerify={handleNodeVerification}
                                                />
                                            </div>
                                        ))}
                                    </div>

                                    {/* New HA Masters Section */}
                                    <div className="space-y-6 mb-12">
                                        <div className="flex items-center justify-between px-2">
                                            <div className="flex items-center space-x-3">
                                                <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center border border-emerald-400/50 shadow-lg shadow-emerald-500/20">
                                                    <Plus className="w-5 h-5 text-white" />
                                                </div>
                                                <div>
                                                    <h3 className="text-base font-black uppercase tracking-wider text-white">Add HA Control Plane Nodes</h3>
                                                    <p className="text-[11px] text-slate-400 uppercase tracking-wide">Optional - High Availability Masters</p>
                                                </div>
                                            </div>
                                            <div className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl">
                                                <span className="text-xs font-black text-emerald-400 uppercase tracking-wider">Step 2 of 2</span>
                                            </div>
                                        </div>

                                        <div className="p-6 bg-emerald-500/5 border-2 border-emerald-500/20 rounded-2xl">
                                            <div className="flex items-start space-x-3">
                                                <Info className="w-5 h-5 text-emerald-400 mt-0.5" />
                                                <div className="text-sm text-slate-300 leading-relaxed">
                                                    <p className="font-semibold text-white mb-1">Enable High Availability (HA) for your cluster</p>
                                                    <p className="mb-2">Add 2 or more control plane nodes for fault tolerance. If one master fails, your cluster continues to operate.</p>
                                                    <div className="flex items-center space-x-4 text-xs mt-3">
                                                        <div className="flex items-center space-x-1.5 text-emerald-400">
                                                            <CheckCircle2 className="w-3.5 h-3.5" />
                                                            <span>Automatic Failover</span>
                                                        </div>
                                                        <div className="flex items-center space-x-1.5 text-blue-400">
                                                            <Shield className="w-3.5 h-3.5" />
                                                            <span>etcd Quorum</span>
                                                        </div>
                                                        <div className="flex items-center space-x-1.5 text-purple-400">
                                                            <Activity className="w-3.5 h-3.5" />
                                                            <span>Load Balancing</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() => addNode('master')}
                                            className="w-full py-4 bg-gradient-to-r from-emerald-600 to-emerald-700 text-white font-black uppercase tracking-wider rounded-xl border border-emerald-500/50 hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-emerald-600/20 flex items-center justify-center space-x-2"
                                        >
                                            <Plus className="w-5 h-5" />
                                            <span>Add HA Master Node</span>
                                        </button>

                                        {formData.masterNodes.slice(1).map((node, idx) => {
                                            const actualIdx = idx + 1;
                                            return (
                                                <div key={actualIdx} className="p-8 bg-gradient-to-br from-emerald-500/5 to-emerald-500/10 rounded-[32px] border-2 border-emerald-500/30 space-y-6 relative overflow-hidden">
                                                    <div className="absolute top-0 right-0 px-4 py-1.5 bg-emerald-600 text-white text-[9px] font-black uppercase tracking-widest rounded-bl-xl shadow-lg z-10">
                                                        New HA Node #{idx + 1}
                                                    </div>
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                        <div className="space-y-1.5">
                                                            <label className="text-[10px] font-black uppercase text-slate-500 ml-1">Host IP Address</label>
                                                            <input
                                                                type="text"
                                                                placeholder="e.g. 192.168.1.100"
                                                                className="w-full px-5 py-3 rounded-xl bg-black/40 border border-emerald-500/20 focus:border-emerald-500 outline-none placeholder:text-slate-700"
                                                                value={node.ip}
                                                                onChange={(e) => updateNode('master', actualIdx, 'ip', e.target.value)}
                                                            />
                                                        </div>
                                                        <div className="space-y-1.5">
                                                            <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Username</label>
                                                            <input
                                                                type="text"
                                                                placeholder="root"
                                                                className="w-full px-5 py-3 rounded-xl bg-black/40 border border-emerald-500/20 focus:border-emerald-500 outline-none placeholder:text-slate-700"
                                                                value={node.username}
                                                                onChange={(e) => updateNode('master', actualIdx, 'username', e.target.value)}
                                                            />
                                                        </div>
                                                        <div className="space-y-1.5">
                                                            <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Authentication</label>
                                                            <div className="relative">
                                                                <input
                                                                    type={showPasswords[`m-${actualIdx}`] ? "text" : "password"}
                                                                    placeholder="SSH Password"
                                                                    className="w-full px-5 py-3 rounded-xl bg-black/40 border border-emerald-500/20 focus:border-emerald-500 outline-none placeholder:text-slate-700"
                                                                    value={node.password}
                                                                    onChange={(e) => updateNode('master', actualIdx, 'password', e.target.value)}
                                                                />
                                                                <button
                                                                    onClick={() => togglePasswordVisibility(`m-${actualIdx}`)}
                                                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500"
                                                                >
                                                                    {showPasswords[`m-${actualIdx}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                                                                </button>
                                                            </div>
                                                        </div>
                                                        <div className="space-y-1.5">
                                                            <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Private Key (Paste Content)</label>
                                                            <div className="flex space-x-2">
                                                                <textarea
                                                                    placeholder="Paste Private Key Content (starts with -----BEGIN...)"
                                                                    className="flex-1 px-5 py-3 rounded-xl bg-black/40 border border-emerald-500/20 focus:border-emerald-500 outline-none placeholder:text-slate-700 font-mono text-[10px] h-[52px] min-h-[52px] resize-y"
                                                                    value={node.sshKey}
                                                                    onChange={(e) => updateNode('master', actualIdx, 'sshKey', e.target.value)}
                                                                />
                                                                <button
                                                                    onClick={() => removeNode('master', actualIdx)}
                                                                    className="p-3 text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded-xl transition-all h-[52px]"
                                                                >
                                                                    <Trash2 size={18} />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <NodeVerificationCard
                                                        node={node}
                                                        nodeType="master"
                                                        index={actualIdx}
                                                        onVerify={handleNodeVerification}
                                                    />
                                                </div>
                                            );
                                        })}

                                        {formData.masterNodes.length === 1 && (
                                            <div className="p-6 bg-emerald-500/5 border border-emerald-500/20 rounded-2xl text-center">
                                                <p className="text-sm text-slate-400">No additional HA masters configured. Click "Add HA Master" to expand control plane redundancy.</p>
                                            </div>
                                        )}
                                    </div>
                                </>
                            ) : (
                                /* Install Mode - Original Design */
                                <div className="space-y-8 mb-12">
                                    <div className="flex items-center justify-between px-2">
                                        <h3 className="text-xs font-black uppercase tracking-[0.2em] text-blue-500 flex items-center">
                                            <Shield className="w-3.5 h-3.5 mr-2" />
                                            Control Plane Instances
                                        </h3>
                                        <button
                                            type="button"
                                            onClick={() => addNode('master')}
                                            className="text-[10px] font-black uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 px-3 py-1.5 rounded-lg hover:bg-blue-500/20 transition-all flex items-center space-x-1"
                                        >
                                            <Plus className="w-3 h-3" />
                                            <span>Add Master Node</span>
                                        </button>
                                    </div>
                                    {formData.masterNodes.map((node, idx) => (
                                        <div key={idx} className="space-y-4">
                                            <div className="p-8 bg-white/5 rounded-[32px] border border-white/5 space-y-6 group hover:border-blue-500/30 transition-all duration-300 relative overflow-hidden">
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">Host IP Address</label>
                                                        <input
                                                            type="text"
                                                            placeholder="e.g. 192.168.1.100"
                                                            className="w-full px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-blue-500 outline-none placeholder:text-slate-700"
                                                            value={node.ip}
                                                            onChange={(e) => updateNode('master', idx, 'ip', e.target.value)}
                                                        />
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Username</label>
                                                        <input
                                                            type="text"
                                                            placeholder="root"
                                                            className="w-full px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-blue-500 outline-none placeholder:text-slate-700"
                                                            value={node.username}
                                                            onChange={(e) => updateNode('master', idx, 'username', e.target.value)}
                                                        />
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Authentication</label>
                                                        <div className="relative">
                                                            <input
                                                                type={showPasswords[`m-${idx}`] ? "text" : "password"}
                                                                placeholder="SSH Password"
                                                                className="w-full px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-blue-500 outline-none placeholder:text-slate-700"
                                                                value={node.password}
                                                                onChange={(e) => updateNode('master', idx, 'password', e.target.value)}
                                                            />
                                                            <button
                                                                onClick={() => togglePasswordVisibility(`m-${idx}`)}
                                                                className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500"
                                                            >
                                                                {showPasswords[`m-${idx}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="space-y-1.5 relative">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Private Key (Paste Content)</label>
                                                        <div className="flex space-x-2">
                                                            <textarea
                                                                placeholder="Paste Private Key Content (starts with -----BEGIN...)"
                                                                className="flex-1 px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-blue-500 outline-none placeholder:text-slate-700 font-mono text-[10px] h-[52px] min-h-[52px] resize-y"
                                                                value={node.sshKey}
                                                                onChange={(e) => updateNode('master', idx, 'sshKey', e.target.value)}
                                                            />
                                                            {formData.masterNodes.length > 1 && (
                                                                <button
                                                                    onClick={() => removeNode('master', idx)}
                                                                    className="p-3 text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded-xl transition-all h-[52px]"
                                                                >
                                                                    <Trash2 size={18} />
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                                <NodeVerificationCard
                                                    node={node}
                                                    nodeType="master"
                                                    index={idx}
                                                    onVerify={handleNodeVerification}
                                                />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Worker Nodes Section - Redesigned for Scaling */}
                            <div className="space-y-6">
                                <div className="flex items-center justify-between px-2">
                                    <div className="flex items-center space-x-3">
                                        <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center border border-purple-400/50 shadow-lg shadow-purple-500/20">
                                            <Cpu className="w-5 h-5 text-white" />
                                        </div>
                                        <div>
                                            <h3 className="text-base font-black uppercase tracking-wider text-white">Execution Workers</h3>
                                            <p className="text-[11px] text-slate-400 uppercase tracking-wide">Scalable Compute Resources</p>
                                        </div>
                                    </div>
                                    {mode === 'scale' && (
                                        <div className="px-4 py-2 bg-purple-500/10 border border-purple-500/30 rounded-xl">
                                            <span className="text-xs font-black text-purple-400 uppercase tracking-wider">Step 3 (Optional)</span>
                                        </div>
                                    )}
                                </div>

                                {mode === 'scale' && (
                                    <div className="p-6 bg-purple-500/5 border-2 border-purple-500/20 rounded-2xl">
                                        <div className="flex items-start space-x-3">
                                            <Info className="w-5 h-5 text-purple-400 mt-0.5" />
                                            <div className="text-sm text-slate-300 leading-relaxed">
                                                <p className="font-semibold text-white mb-1">Expand your cluster's processing power</p>
                                                <p className="mb-2">Add worker nodes to run your application workloads and containers. Scale horizontally as your needs grow.</p>
                                                <div className="flex items-center space-x-4 text-xs mt-3">
                                                    <div className="flex items-center space-x-1.5 text-purple-400">
                                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                                        <span>Scalable Compute</span>
                                                    </div>
                                                    <div className="flex items-center space-x-1.5 text-blue-400">
                                                        <Shield className="w-3.5 h-3.5" />
                                                        <span>Workload Isolation</span>
                                                    </div>
                                                    <div className="flex items-center space-x-1.5 text-emerald-400">
                                                        <Network className="w-3.5 h-3.5" />
                                                        <span>Auto-Discovery</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <button
                                    type="button"
                                    onClick={() => addNode('worker')}
                                    className="w-full py-4 bg-gradient-to-r from-purple-600 to-purple-700 text-white font-black uppercase tracking-wider rounded-xl border border-purple-500/50 hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-purple-600/20 flex items-center justify-center space-x-2"
                                >
                                    <Plus className="w-5 h-5" />
                                    <span>Add Worker Node</span>
                                </button>
                                {formData.workerNodes.length === 0 ? (
                                    <div className="p-12 border-2 border-dashed border-white/5 rounded-[32px] text-center text-slate-500">
                                        <p className="font-medium">No workers registered yet. Master will host all workloads.</p>
                                    </div>
                                ) : (
                                    formData.workerNodes.map((node, idx) => (
                                        <div key={idx} className="space-y-4">
                                            <div className="p-8 bg-white/5 rounded-[32px] border border-white/5 space-y-6 group hover:border-purple-500/30 transition-all duration-300">
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">Host IP Address</label>
                                                        <input
                                                            type="text"
                                                            placeholder="e.g. 192.168.1.101"
                                                            className="w-full px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-purple-500 outline-none placeholder:text-slate-700"
                                                            value={node.ip}
                                                            onChange={(e) => updateNode('worker', idx, 'ip', e.target.value)}
                                                        />
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Username</label>
                                                        <input
                                                            type="text"
                                                            placeholder="root"
                                                            className="w-full px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-purple-500 outline-none placeholder:text-slate-700"
                                                            value={node.username}
                                                            onChange={(e) => updateNode('worker', idx, 'username', e.target.value)}
                                                        />
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Authentication</label>
                                                        <div className="relative">
                                                            <input
                                                                type={showPasswords[`w-${idx}`] ? "text" : "password"}
                                                                placeholder="SSH Password"
                                                                className="w-full px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-purple-500 outline-none placeholder:text-slate-700"
                                                                value={node.password}
                                                                onChange={(e) => updateNode('worker', idx, 'password', e.target.value)}
                                                            />
                                                            <button
                                                                onClick={() => togglePasswordVisibility(`w-${idx}`)}
                                                                className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500"
                                                            >
                                                                {showPasswords[`w-${idx}`] ? <EyeOff size={16} /> : <Eye size={16} />}
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="space-y-1.5 relative">
                                                        <label className="text-[10px] font-black uppercase text-slate-500 ml-1">SSH Private Key (Paste Content)</label>
                                                        <div className="flex space-x-2">
                                                            <textarea
                                                                placeholder="Paste Private Key Content (starts with -----BEGIN...)"
                                                                className="flex-1 px-5 py-3 rounded-xl bg-black/40 border border-white/10 focus:border-purple-500 outline-none placeholder:text-slate-700 font-mono text-[10px] h-[52px] min-h-[52px] resize-y"
                                                                value={node.sshKey}
                                                                onChange={(e) => updateNode('worker', idx, 'sshKey', e.target.value)}
                                                            />
                                                            <button
                                                                onClick={() => removeNode('worker', idx)}
                                                                className="p-3 text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded-xl transition-all h-[52px]"
                                                            >
                                                                <Trash2 size={18} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Pre-check Component */}
                                                <NodeVerificationCard
                                                    node={node}
                                                    nodeType="worker"
                                                    index={idx}
                                                    onVerify={handleNodeVerification}
                                                />
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}

                    {/* Step 3: Add-ons */}
                    {currentStep === 3 && (
                        <div className="animate-in">
                            <div className="mb-10">
                                <h2 className="text-4xl font-black mb-2 tracking-tight">Select OS Add-ons</h2>
                                <p className="text-slate-400">Enhance your cluster with industrial-grade tools.</p>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                {ADDONS_LIST.map((addon) => {
                                    const iconMap = {
                                        Network,
                                        BarChart3,
                                        LayoutDashboard,
                                        Shield,
                                        Database,
                                        GitBranch,
                                        Sparkles
                                    }
                                    const Icon = iconMap[addon.iconName] || Package;
                                    const isSelected = formData.addons[addon.key];

                                    return (
                                        <button
                                            key={addon.key}
                                            onClick={() => setFormData({
                                                ...formData,
                                                addons: { ...formData.addons, [addon.key]: !formData.addons[addon.key] }
                                            })}
                                            className={`group relative p-6 rounded-2xl border transition-all duration-300 text-left overflow-hidden ${isSelected
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
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Step 4: Final Review (Synthesized Manifest) */}
                    {currentStep === 4 && (
                        <div className="animate-in">
                            <div className="mb-10">
                                <h2 className="text-4xl font-black mb-2 tracking-tight">Final Synthesis</h2>
                                <p className="text-slate-400">Review the generated deployment manifest and tactical plan.</p>
                            </div>

                            <div className="space-y-6">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div className="p-8 bg-white/5 rounded-[32px] border border-white/5 group hover:border-blue-500/30 transition-all">
                                        <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4">Cluster Identity</div>
                                        <div className="flex items-center space-x-4">
                                            <div className="w-12 h-12 bg-blue-500/10 rounded-2xl flex items-center justify-center border border-blue-500/20">
                                                <Globe className="w-6 h-6 text-blue-400" />
                                            </div>
                                            <div>
                                                <p className="text-2xl font-black text-white">{formData.clusterName}</p>
                                                <p className="text-xs text-blue-400 font-bold uppercase tracking-widest">Runtime: K8s v{formData.k8sVersion}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="p-8 bg-white/5 rounded-[32px] border border-white/5 group hover:border-purple-500/30 transition-all">
                                        <div className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-4">Network Fabric</div>
                                        <div className="flex items-center space-x-4">
                                            <div className="w-12 h-12 bg-purple-500/10 rounded-2xl flex items-center justify-center border border-purple-500/20">
                                                <Network className="w-6 h-6 text-purple-400" />
                                            </div>
                                            <div>
                                                <p className="text-2xl font-black text-white uppercase">{formData.networkPlugin}</p>
                                                <p className="text-xs text-purple-400 font-bold uppercase tracking-widest">Protocol: VXLAN/BGP Overlay</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div className="p-10 bg-black/40 rounded-[40px] border border-white/10 relative overflow-hidden">
                                    <div className="absolute top-0 right-0 p-12 opacity-[0.03] pointer-events-none">
                                        <FileCode className="w-64 h-64 text-blue-400" />
                                    </div>

                                    {mode === 'scale' && verificationResults[formData.masterNodes[0]?.ip]?.clusterTopology && (
                                        <div className="mb-10 p-8 bg-blue-500/5 rounded-[32px] border border-blue-500/20 animate-in fade-in slide-in-from-bottom-4 duration-700">
                                            <div className="flex items-center justify-between mb-6">
                                                <div className="text-[10px] font-black uppercase text-blue-400 tracking-[0.2em]">Live Cluster State (Pre-expansion)</div>
                                                <div className="px-2 py-0.5 bg-blue-500/20 rounded text-[8px] font-black text-blue-300 tracking-widest uppercase">Authorized via Bridge</div>
                                            </div>
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                                {verificationResults[formData.masterNodes[0]?.ip].clusterTopology.map((node, i) => (
                                                    <div key={i} className="p-3 bg-white/5 rounded-2xl border border-white/5 flex items-center space-x-3 group hover:border-blue-500/30 transition-all">
                                                        <div className={`w-2 h-2 rounded-full ${node.status === 'Ready' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500 animate-pulse'}`}></div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="text-[10px] font-mono text-slate-300 truncate leading-none mb-1">{node.name}</div>
                                                            <div className="text-[9px] font-mono text-blue-400 truncate leading-none mb-1">{node.ip}</div>
                                                            <div className="text-[8px] font-black text-slate-500 uppercase tracking-tighter">{node.role} • {node.status}</div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center justify-between mb-8">
                                        <div className="flex items-center space-x-3">
                                            <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"></div>
                                            <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-emerald-400">Implementation Manifest</h3>
                                        </div>
                                        <span className="text-[10px] font-mono text-slate-600">YAML Auto-generated</span>
                                    </div>

                                    {(() => {
                                        const firstMaster = formData.masterNodes[0]?.ip;
                                        const osId = (verificationResults[firstMaster]?.osInfo?.id || 'linux').toLowerCase();
                                        const isRedHat = osId === 'centos' || osId === 'rhel' || osId === 'rocky';

                                        return (
                                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                                                <div className="space-y-6">
                                                    <div>
                                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Target Nodes Strategy</p>
                                                        <div className="space-y-2 border-l-2 border-white/5 pl-4">
                                                            {allNodes.map((node, i) => (
                                                                <div key={i} className="flex items-center justify-between group">
                                                                    <div className="flex items-center space-x-3">
                                                                        <div className={`w-1.5 h-1.5 rounded-full ${node.role === 'master' ? 'bg-blue-400' : 'bg-purple-400'} ${mode === 'scale' && i === 0 ? 'opacity-50' : ''}`}></div>
                                                                        <span className={`text-sm font-mono ${mode === 'scale' && i === 0 ? 'text-slate-500 line-through decoration-slate-600' : 'text-slate-300'}`}>{node.ip}</span>
                                                                    </div>
                                                                    <div className="flex items-center space-x-2">
                                                                        <span className="text-[9px] font-black px-2 py-0.5 rounded bg-black/40 border border-white/5 text-slate-500 group-hover:text-white transition-colors uppercase">
                                                                            {verificationResults[node.ip]?.osInfo?.prettyName?.split(' ')[0] || 'LINUX'}
                                                                        </span>
                                                                        <span className={`text-[8px] font-black uppercase ${mode === 'scale' && i === 0 ? 'text-slate-500' : 'text-blue-500'}`}>
                                                                            {mode === 'scale' && i === 0 ? 'EXISTING (IGNORED)' : node.role}
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">OS Specific Strategy ({isRedHat ? 'RHEL' : 'DEB'})</p>
                                                        <div className="space-y-2 border-l-2 border-white/5 pl-4 text-[11px] font-medium text-slate-400">
                                                            {isRedHat ? (
                                                                <>
                                                                    <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-orange-500"></div><span>YUM/DNF Repository Automation</span></div>
                                                                    <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-orange-500"></div><span>Firewalld / SELinux Management</span></div>
                                                                    <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-orange-500"></div><span>Resilient modprobe Execution</span></div>
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-blue-500"></div><span>APT GPG Keyring Setup</span></div>
                                                                    <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-blue-500"></div><span>UFW / Iptables Persistence</span></div>
                                                                    <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-blue-500"></div><span>AppArmor Profile Optimization</span></div>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="space-y-6">
                                                    <div>
                                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Base Components</p>
                                                        <div className="grid grid-cols-1 gap-2 text-[11px] font-medium text-slate-400">
                                                            <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-blue-500"></div><span>Containerd v1.7+ ({isRedHat ? 'RHEL Pkgs' : 'Docker-DEB'})</span></div>
                                                            <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-blue-500"></div><span>Kubernetes Binaries v{formData.k8sVersion}</span></div>
                                                            <div className="flex items-center space-x-2"><div className="w-1 h-1 rounded-full bg-emerald-500"></div><span>{formData.networkPlugin.toUpperCase()} Network Fabric</span></div>
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Add-on Ecosystem</p>
                                                        <div className="grid grid-cols-2 gap-3">
                                                            {Object.entries(formData.addons).filter(([_, v]) => v).map(([k, _]) => (
                                                                <div key={k} className="p-2 bg-white/5 border border-white/5 rounded-xl flex items-center space-x-2">
                                                                    <Package size={12} className="text-blue-400" />
                                                                    <span className="text-[10px] font-bold text-slate-200 capitalize truncate">{k.replace('-', ' ')}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                    <div className="p-4 bg-blue-500/5 rounded-2xl border border-blue-500/20">
                                                        <div className="flex items-center space-x-2 mb-2">
                                                            <Info size={14} className="text-blue-400" />
                                                            <span className="text-[10px] font-black uppercase text-blue-400">Tactical Strategy</span>
                                                        </div>
                                                        <p className="text-[10px] text-slate-400 leading-relaxed font-medium">
                                                            Converging {allNodes.length} nodes on {isRedHat ? 'RedHat' : 'Debian'} architecture. Master fleet priority 1.
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })()}
                                </div>
                            </div>
                        </div>
                    )}



                    {/* Footer Navigation */}
                    <div className="mt-16 flex items-center justify-between pt-10 border-t border-white/5">
                        <button
                            onClick={prevStep}
                            className="flex items-center space-x-2 px-8 py-4 text-slate-500 hover:text-white transition-all font-bold group"
                        >
                            <ChevronLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
                            <span>{currentStep === 1 || (mode === 'scale' && currentStep === 2) ? 'Abort' : 'Back'}</span>
                        </button>

                        <div className="flex items-center space-x-4">
                            {currentStep === 2 && !canProceedToNextStep() && (
                                <div className="hidden md:flex items-center space-x-2 px-4 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-500">
                                    <AlertTriangle className="w-4 h-4" />
                                    <span className="text-[10px] font-black uppercase tracking-widest">Verify All Nodes</span>
                                </div>
                            )}

                            {currentStep < 4 ? (
                                <button
                                    onClick={nextStep}
                                    disabled={!canProceedToNextStep()}
                                    className="px-12 py-4 bg-white text-black rounded-[20px] font-black shadow-xl hover:shadow-white/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100 disabled:shadow-none flex items-center space-x-2"
                                >
                                    <span>Continue</span>
                                    <ChevronRight className="w-5 h-5" />
                                </button>
                            ) : (
                                <button
                                    onClick={handleInstallClick}
                                    className="px-12 py-5 bg-gradient-to-r from-blue-500 to-blue-700 text-white rounded-[24px] font-black shadow-2xl shadow-blue-500/40 hover:scale-105 active:scale-95 transition-all flex items-center space-x-3"
                                >
                                    <Rocket className="w-5 h-5" />
                                    <span>Launch Cluster</span>
                                </button>
                            )}
                        </div>
                    </div>


                    {/* Support Modals */}
                    {showDeploymentPlan && (
                        <DeploymentPlan
                            config={{
                                ...formData,
                                masterNodes: sanitizeNodeData(formData.masterNodes),
                                workerNodes: sanitizeNodeData(formData.workerNodes || [])
                            }}
                            verificationResults={verificationResults}
                            onConfirm={handleConfirmInstall}
                            onCancel={() => setShowDeploymentPlan(false)}
                            isInstalling={isInstalling}
                        />
                    )}
                </div>
            </div>
        </div >
    )
}
