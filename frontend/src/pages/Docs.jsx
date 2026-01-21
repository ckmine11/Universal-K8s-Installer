import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import {
    BookOpen,
    Server,
    Terminal,
    CheckCircle2,
    ArrowRight,
    Copy,
    ChevronRight,
    Cloud,
    Cpu
} from 'lucide-react'

export default function Docs() {
    const [activeSection, setActiveSection] = useState('quickstart')

    const scrollTo = (id) => {
        setActiveSection(id)
        const element = document.getElementById(id)
        if (element) {
            element.scrollIntoView({ behavior: 'smooth' })
        }
    }

    return (
        <div className="min-h-screen pt-24 pb-12 px-6">
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-8">

                {/* Sidebar Navigation */}
                <div className="hidden lg:block lg:col-span-1">
                    <div className="sticky top-28 space-y-8">
                        <div>
                            <h3 className="text-xs font-black uppercase tracking-widest text-gray-500 mb-4">Getting Started</h3>
                            <ul className="space-y-2">
                                <li>
                                    <button
                                        onClick={() => scrollTo('intro')}
                                        className={`text-sm hover:text-blue-400 transition-colors ${activeSection === 'intro' ? 'text-blue-400 font-bold' : 'text-gray-400'}`}
                                    >
                                        Introduction
                                    </button>
                                </li>
                                <li>
                                    <button
                                        onClick={() => scrollTo('requirements')}
                                        className={`text-sm hover:text-blue-400 transition-colors ${activeSection === 'requirements' ? 'text-blue-400 font-bold' : 'text-gray-400'}`}
                                    >
                                        System Requirements
                                    </button>
                                </li>
                            </ul>
                        </div>

                        <div>
                            <h3 className="text-xs font-black uppercase tracking-widest text-gray-500 mb-4">Installation</h3>
                            <ul className="space-y-2">
                                <li>
                                    <button
                                        onClick={() => scrollTo('virtualbox')}
                                        className={`text-sm hover:text-blue-400 transition-colors ${activeSection === 'virtualbox' ? 'text-blue-400 font-bold' : 'text-gray-400'}`}
                                    >
                                        VirtualBox Setup (Free)
                                    </button>
                                </li>
                                <li>
                                    <button
                                        onClick={() => scrollTo('aws')}
                                        className={`text-sm hover:text-blue-400 transition-colors ${activeSection === 'aws' ? 'text-blue-400 font-bold' : 'text-gray-400'}`}
                                    >
                                        AWS EC2 Setup
                                    </button>
                                </li>
                            </ul>
                        </div>

                        <div>
                            <h3 className="text-xs font-black uppercase tracking-widest text-gray-500 mb-4">Usage</h3>
                            <ul className="space-y-2">
                                <li>
                                    <button
                                        onClick={() => scrollTo('deploy')}
                                        className={`text-sm hover:text-blue-400 transition-colors ${activeSection === 'deploy' ? 'text-blue-400 font-bold' : 'text-gray-400'}`}
                                    >
                                        Deploying a Cluster
                                    </button>
                                </li>
                                <li>
                                    <button
                                        onClick={() => scrollTo('access')}
                                        className={`text-sm hover:text-blue-400 transition-colors ${activeSection === 'access' ? 'text-blue-400 font-bold' : 'text-gray-400'}`}
                                    >
                                        Accessing Your Cluster
                                    </button>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>

                {/* Main Content */}
                <div className="lg:col-span-3 space-y-16">

                    {/* Introduction */}
                    <section id="intro" className="space-y-6">
                        <div className="flex items-center space-x-3 mb-6">
                            <div className="p-3 bg-blue-500/20 rounded-xl">
                                <BookOpen className="w-8 h-8 text-blue-400" />
                            </div>
                            <h1 className="text-4xl font-bold">Documentation</h1>
                        </div>
                        <p className="text-xl text-gray-300 leading-relaxed">
                            Welcome to the official KubeEZ documentation. Learn how to provision, manage, and scale production-grade Kubernetes clusters on your own infrastructure or cloud providers.
                        </p>
                    </section>

                    {/* Requirements */}
                    <section id="requirements" className="space-y-6 pt-16 border-t border-white/5">
                        <h2 className="text-2xl font-bold flex items-center">
                            <Server className="w-6 h-6 mr-3 text-purple-400" />
                            System Requirements
                        </h2>
                        <div className="glass rounded-2xl p-6 border border-white/5">
                            <ul className="space-y-4">
                                <li className="flex items-start">
                                    <CheckCircle2 className="w-5 h-5 text-green-400 mr-3 mt-0.5" />
                                    <div>
                                        <span className="font-bold text-white block">3 Linux Machines</span>
                                        <span className="text-sm text-gray-400">Physical servers or Virtual Machines (Ubuntu 20.04+ Recommended)</span>
                                    </div>
                                </li>
                                <li className="flex items-start">
                                    <CheckCircle2 className="w-5 h-5 text-green-400 mr-3 mt-0.5" />
                                    <div>
                                        <span className="font-bold text-white block">SSH Access</span>
                                        <span className="text-sm text-gray-400">Root or sudo user with password or SSH key authentication</span>
                                    </div>
                                </li>
                                <li className="flex items-start">
                                    <CheckCircle2 className="w-5 h-5 text-green-400 mr-3 mt-0.5" />
                                    <div>
                                        <span className="font-bold text-white block">Hardware Specs (Per Node)</span>
                                        <span className="text-sm text-gray-400">Min: 2 vCPU, 2GB RAM. Recommended: 2 vCPU, 4GB RAM</span>
                                    </div>
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* VirtualBox Setup */}
                    <section id="virtualbox" className="space-y-6 pt-16 border-t border-white/5">
                        <h2 className="text-2xl font-bold flex items-center">
                            <Cpu className="w-6 h-6 mr-3 text-orange-400" />
                            Quick Setup: VirtualBox (Free)
                        </h2>
                        <p className="text-gray-400">The easiest way to test KubeEZ locally is using VirtualBox.</p>

                        <div className="space-y-4">
                            <h3 className="text-lg font-semibold text-white">1. Create 3 VMs</h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                                    <p className="font-bold text-blue-400 mb-2">Master Node</p>
                                    <ul className="text-sm text-gray-400 space-y-1">
                                        <li>RAM: 4GB</li>
                                        <li>CPU: 2 Cores</li>
                                        <li>Network: Bridged</li>
                                    </ul>
                                </div>
                                <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                                    <p className="font-bold text-purple-400 mb-2">Worker 1</p>
                                    <ul className="text-sm text-gray-400 space-y-1">
                                        <li>RAM: 4GB</li>
                                        <li>CPU: 2 Cores</li>
                                        <li>Network: Bridged</li>
                                    </ul>
                                </div>
                                <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                                    <p className="font-bold text-purple-400 mb-2">Worker 2</p>
                                    <ul className="text-sm text-gray-400 space-y-1">
                                        <li>RAM: 4GB</li>
                                        <li>CPU: 2 Cores</li>
                                        <li>Network: Bridged</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <h3 className="text-lg font-semibold text-white">2. Prepare Environment</h3>
                            <div className="bg-black/40 rounded-xl p-4 font-mono text-sm text-gray-300 border border-white/10 relative group">
                                <button
                                    onClick={() => navigator.clipboard.writeText('sudo apt-get update && sudo apt-get install -y openssh-server')}
                                    className="absolute top-3 right-3 p-1.5 hover:bg-white/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                                >
                                    <Copy className="w-4 h-4" />
                                </button>
                                <p className="text-gray-500 mb-2"># Run on all nodes:</p>
                                <p>sudo apt-get update</p>
                                <p>sudo apt-get install -y openssh-server</p>
                                <p>sudo systemctl enable ssh --now</p>
                            </div>
                        </div>
                    </section>

                    {/* Usage */}
                    <section id="deploy" className="space-y-6 pt-16 border-t border-white/5">
                        <h2 className="text-2xl font-bold flex items-center">
                            <Terminal className="w-6 h-6 mr-3 text-green-400" />
                            Deploying Your First Cluster
                        </h2>
                        <ol className="relative border-l border-white/10 ml-3 space-y-8">
                            <li className="pl-8 relative">
                                <span className="absolute -left-[9px] top-0 w-4 h-4 bg-blue-500 rounded-full ring-4 ring-black"></span>
                                <h3 className="font-bold text-lg mb-2">Start New Cluster</h3>
                                <p className="text-gray-400 text-sm">Click "Start New Cluster" on the home page. Enter a unique name for your cluster.</p>
                            </li>
                            <li className="pl-8 relative">
                                <span className="absolute -left-[9px] top-0 w-4 h-4 bg-gray-700 rounded-full ring-4 ring-black"></span>
                                <h3 className="font-bold text-lg mb-2">Add Nodes</h3>
                                <p className="text-gray-400 text-sm">Enter the IP addresses, username, and password/key for your Master and Worker nodes. Click "Verify Connection" to ensure KubeEZ can reach them.</p>
                            </li>
                            <li className="pl-8 relative">
                                <span className="absolute -left-[9px] top-0 w-4 h-4 bg-gray-700 rounded-full ring-4 ring-black"></span>
                                <h3 className="font-bold text-lg mb-2">Install</h3>
                                <p className="text-gray-400 text-sm">Review the deployment plan and click "Install". Sit back while KubeEZ handles the complexity.</p>
                            </li>
                        </ol>
                    </section>
                </div>
            </div>
        </div>
    )
}
