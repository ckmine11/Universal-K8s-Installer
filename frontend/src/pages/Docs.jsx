import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import {
    BookOpen,
    Server,
    Terminal,
    CheckCircle2,
    Cloud,
    Cpu,
    Shield,
    Users,
    Key,
    Activity,
    Copy,
    ArrowRight
} from 'lucide-react'

export default function Docs() {
    const [activeSection, setActiveSection] = useState('intro')

    const scrollTo = (id) => {
        setActiveSection(id)
        const element = document.getElementById(id)
        if (element) {
            element.scrollIntoView({ behavior: 'smooth' })
        }
    }

    const sections = [
        {
            title: 'Getting Started',
            items: [
                { id: 'intro', label: 'Platform Overview' },
                { id: 'modes', label: 'SaaS vs Self-Hosted' },
                { id: 'requirements', label: 'System Requirements' }
            ]
        },
        {
            title: 'Core Features',
            items: [
                { id: 'agents', label: 'Node Agents (Tunnels)' },
                { id: 'users', label: 'User & Role Management' },
                { id: 'security', label: 'Security & Passwords' }
            ]
        },
        {
            title: 'Usage',
            items: [
                { id: 'deploy', label: 'Deploying a Cluster' },
                { id: 'manage', label: 'Managing Infrastructure' }
            ]
        }
    ]

    return (
        <div className="min-h-screen py-8 px-4 sm:px-6">
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-8">

                {/* Sidebar Navigation */}
                <div className="hidden lg:block lg:col-span-1">
                    <div className="sticky top-24 space-y-8">
                        {sections.map(section => (
                            <div key={section.title}>
                                <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-4">{section.title}</h3>
                                <ul className="space-y-3">
                                    {section.items.map(item => (
                                        <li key={item.id}>
                                            <button
                                                onClick={() => scrollTo(item.id)}
                                                className={`text-xs font-bold tracking-wide transition-all ${
                                                    activeSection === item.id
                                                        ? 'text-blue-400 pl-2 border-l-2 border-blue-400'
                                                        : 'text-slate-400 hover:text-white border-l-2 border-transparent'
                                                }`}
                                            >
                                                {item.label}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Main Content */}
                <div className="lg:col-span-3 space-y-16 pb-16">

                    {/* Introduction */}
                    <section id="intro" className="space-y-6 scroll-mt-24">
                        <div className="flex items-center gap-4 mb-6">
                            <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-2xl">
                                <BookOpen className="w-6 h-6 text-blue-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-black text-white tracking-tight">KubeEZ Documentation</h1>
                                <p className="text-sm text-slate-400 mt-1">The Intelligent Kubernetes Deployment Platform</p>
                            </div>
                        </div>
                        <p className="text-base text-slate-300 leading-relaxed max-w-3xl">
                            Welcome to the official KubeEZ documentation. KubeEZ simplifies the complexity of Kubernetes by providing a premium, "No-Ops" platform to provision, scale, and manage production-grade clusters across any infrastructure.
                        </p>
                    </section>

                    {/* Modes */}
                    <section id="modes" className="space-y-6 pt-16 border-t border-white/5 scroll-mt-24">
                        <h2 className="text-2xl font-black uppercase tracking-wide flex items-center">
                            <Cloud className="w-6 h-6 mr-3 text-purple-400" />
                            Deployment Modes
                        </h2>
                        <p className="text-slate-400 text-sm max-w-3xl leading-relaxed">
                            KubeEZ operates in two distinct modes configured via the <code className="text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded">KUBEEZ_MODE</code> environment variable.
                        </p>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
                            <div className="glass p-6 rounded-3xl border border-white/5">
                                <h3 className="text-lg font-black text-white flex items-center gap-2 mb-3">
                                    <Server className="w-5 h-5 text-blue-400" /> Self-Hosted Mode
                                </h3>
                                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                                    Run KubeEZ on your own infrastructure. The platform connects directly to your nodes via SSH over the local network or VPN.
                                </p>
                                <ul className="space-y-2 text-xs font-bold text-slate-300">
                                    <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-blue-400" /> Direct SSH connections</li>
                                    <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-blue-400" /> Maximum privacy & control</li>
                                    <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-blue-400" /> License-key activated</li>
                                </ul>
                            </div>
                            <div className="glass p-6 rounded-3xl border border-white/5 bg-amber-500/5">
                                <h3 className="text-lg font-black text-white flex items-center gap-2 mb-3">
                                    <Cloud className="w-5 h-5 text-amber-400" /> SaaS Mode
                                </h3>
                                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                                    The hosted version of KubeEZ. Uses <strong className="text-amber-400">Node Agents</strong> to establish secure reverse-tunnels to your private servers.
                                </p>
                                <ul className="space-y-2 text-xs font-bold text-slate-300">
                                    <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-amber-400" /> No inbound firewall rules needed</li>
                                    <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-amber-400" /> WebSocket reverse tunnels</li>
                                    <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-amber-400" /> Subscription-based quotas</li>
                                </ul>
                            </div>
                        </div>
                    </section>

                    {/* Node Agents */}
                    <section id="agents" className="space-y-6 pt-16 border-t border-white/5 scroll-mt-24">
                        <div className="glass rounded-3xl p-8 border border-white/5 relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/10 rounded-full blur-[80px] pointer-events-none"></div>
                            <h2 className="text-2xl font-black uppercase tracking-wide flex items-center mb-4">
                                <Activity className="w-6 h-6 mr-3 text-emerald-400" />
                                Node Agents (SaaS Tunnels)
                            </h2>
                            <p className="text-sm text-slate-300 leading-relaxed mb-6 max-w-3xl relative z-10">
                                In SaaS mode, KubeEZ cannot directly SSH into your private servers. Instead, you install a lightweight <strong>Node Agent</strong> on your target servers. This agent establishes an outbound secure WebSocket tunnel to the KubeEZ platform.
                            </p>
                            
                            <div className="bg-black/40 rounded-2xl p-5 border border-white/5 relative z-10">
                                <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Installation Workflow</h4>
                                <ol className="space-y-3">
                                    <li className="flex items-start gap-3 text-xs text-slate-300">
                                        <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-black shrink-0">1</span>
                                        Navigate to the "Node Agents" page from the header.
                                    </li>
                                    <li className="flex items-start gap-3 text-xs text-slate-300">
                                        <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-black shrink-0">2</span>
                                        Click "Generate Token" to create a unique secure registration token.
                                    </li>
                                    <li className="flex items-start gap-3 text-xs text-slate-300">
                                        <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-black shrink-0">3</span>
                                        Paste the generated zero-install script into your target server terminal (Windows/Mac/Linux). The script will automatically download a portable Node.js runtime if missing and securely connect your server.
                                    </li>
                                    <li className="flex items-start gap-3 text-xs text-slate-300">
                                        <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-black shrink-0">4</span>
                                        Once the agent connects, it will appear as "Online" (use the refresh button) and you can proceed to deploy your cluster.
                                    </li>
                                </ol>
                            </div>
                        </div>
                    </section>

                    {/* Users & Roles */}
                    <section id="users" className="space-y-6 pt-16 border-t border-white/5 scroll-mt-24">
                        <h2 className="text-2xl font-black uppercase tracking-wide flex items-center">
                            <Users className="w-6 h-6 mr-3 text-blue-400" />
                            User & Role Management
                        </h2>
                        <p className="text-sm text-slate-400 leading-relaxed max-w-3xl">
                            KubeEZ is a multi-tenant platform supporting multiple users with strict data isolation. Users only see and manage the clusters they create.
                        </p>
                        
                        <div className="space-y-4 mt-6">
                            <div className="flex gap-4 p-5 glass rounded-2xl border border-white/5">
                                <Shield className="w-6 h-6 text-amber-400 shrink-0" />
                                <div>
                                    <h4 className="font-black text-white text-sm mb-1">Administrators</h4>
                                    <p className="text-xs text-slate-400 leading-relaxed">
                                        Admins have full access to the platform. They can view all clusters across all tenants, manage user accounts (promote, demote, delete), trigger database backups, and modify system settings. The first registered user automatically becomes an Admin.
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-4 p-5 glass rounded-2xl border border-white/5">
                                <Users className="w-6 h-6 text-slate-400 shrink-0" />
                                <div>
                                    <h4 className="font-black text-white text-sm mb-1">Regular Users</h4>
                                    <p className="text-xs text-slate-400 leading-relaxed">
                                        Standard users operate within their own isolated tenant. They can deploy clusters, view telemetry for their own nodes, and manage their own account security (password).
                                    </p>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Requirements */}
                    <section id="requirements" className="space-y-6 pt-16 border-t border-white/5 scroll-mt-24">
                        <h2 className="text-2xl font-black uppercase tracking-wide flex items-center">
                            <Cpu className="w-6 h-6 mr-3 text-orange-400" />
                            Target Node Requirements
                        </h2>
                        <div className="glass rounded-3xl p-6 border border-white/5">
                            <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <li className="flex items-start gap-3 bg-white/5 p-4 rounded-2xl">
                                    <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                                    <div>
                                        <span className="font-black text-white text-sm block mb-1">OS Distribution</span>
                                        <span className="text-xs text-slate-400">Ubuntu 20.04/22.04+, Debian, CentOS, Rocky Linux.</span>
                                    </div>
                                </li>
                                <li className="flex items-start gap-3 bg-white/5 p-4 rounded-2xl">
                                    <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                                    <div>
                                        <span className="font-black text-white text-sm block mb-1">Hardware Specs</span>
                                        <span className="text-xs text-slate-400">Min: 2 vCPU, 2GB RAM per node (Master requires 4GB).</span>
                                    </div>
                                </li>
                                <li className="flex items-start gap-3 bg-white/5 p-4 rounded-2xl">
                                    <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                                    <div>
                                        <span className="font-black text-white text-sm block mb-1">Network Access</span>
                                        <span className="text-xs text-slate-400">Outbound internet access to pull Docker images.</span>
                                    </div>
                                </li>
                                <li className="flex items-start gap-3 bg-white/5 p-4 rounded-2xl">
                                    <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                                    <div>
                                        <span className="font-black text-white text-sm block mb-1">Privileges</span>
                                        <span className="text-xs text-slate-400">Root or sudo access required for installation.</span>
                                    </div>
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* Deploy */}
                    <section id="deploy" className="space-y-6 pt-16 border-t border-white/5 scroll-mt-24">
                        <h2 className="text-2xl font-black uppercase tracking-wide flex items-center">
                            <Terminal className="w-6 h-6 mr-3 text-rose-400" />
                            Deploying a Cluster
                        </h2>
                        <ol className="relative border-l-2 border-white/10 ml-4 space-y-10">
                            <li className="pl-10 relative">
                                <span className="absolute -left-[11px] top-0 w-5 h-5 bg-rose-500 rounded-full ring-4 ring-black"></span>
                                <h3 className="font-black text-white text-lg mb-2">1. Start Wizard</h3>
                                <p className="text-slate-400 text-sm leading-relaxed">Click "Deploy New Cluster" from the dashboard. If using SaaS mode, ensure your Node Agents are online first.</p>
                            </li>
                            <li className="pl-10 relative">
                                <span className="absolute -left-[11px] top-0 w-5 h-5 bg-white/20 rounded-full ring-4 ring-black"></span>
                                <h3 className="font-black text-white text-lg mb-2">2. Define Topology</h3>
                                <p className="text-slate-400 text-sm leading-relaxed">Enter the details for your Master and Worker nodes. Provide SSH credentials (Self-Hosted) or select from online agents (SaaS).</p>
                            </li>
                            <li className="pl-10 relative">
                                <span className="absolute -left-[11px] top-0 w-5 h-5 bg-white/20 rounded-full ring-4 ring-black"></span>
                                <h3 className="font-black text-white text-lg mb-2">3. Pre-flight Verification</h3>
                                <p className="text-slate-400 text-sm leading-relaxed">KubeEZ will automatically verify connectivity, OS compatibility, and hardware requirements before allowing installation to proceed.</p>
                            </li>
                            <li className="pl-10 relative">
                                <span className="absolute -left-[11px] top-0 w-5 h-5 bg-white/20 rounded-full ring-4 ring-black"></span>
                                <h3 className="font-black text-white text-lg mb-2">4. Install & Relax</h3>
                                <p className="text-slate-400 text-sm leading-relaxed">Confirm the deployment plan. KubeEZ will orchestrate the entire installation, displaying real-time streaming logs from all nodes simultaneously.</p>
                            </li>
                        </ol>
                    </section>
                </div>
            </div>
        </div>
    )
}
