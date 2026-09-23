import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useState, useEffect } from 'react'
import { Server, Github, BookOpen, LogOut, User, Settings, Wifi, Users, Zap } from 'lucide-react'

export default function Header() {
    const { logout, user } = useAuth()
    const [isSaasMode, setIsSaasMode] = useState(false)

    useEffect(() => {
        fetch('/api/config')
            .then(r => r.json())
            .then(d => setIsSaasMode(d.mode === 'saas'))
            .catch(() => {})
    }, [])

    return (
        <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-black/20 backdrop-blur-xl">
            <div className="container mx-auto px-6 py-4">
                <div className="flex items-center justify-between">
                    <Link to="/" className="flex items-center space-x-4 group cursor-pointer hover:opacity-90 transition-opacity">
                        <div className="relative">
                            <div className="absolute inset-0 bg-blue-500 blur-xl opacity-20 group-hover:opacity-40 transition-opacity"></div>
                            <div className="relative w-11 h-11 bg-gradient-to-br from-blue-500 to-blue-700 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20 group-hover:rotate-6 transition-transform duration-500">
                                <Server className="w-6 h-6 text-white" />
                            </div>
                        </div>
                        <div className="flex items-center space-x-6">
                            <div>
                                <h1 className="text-xl font-black tracking-tighter text-white">
                                    Universal <span className="text-blue-500">K8s</span> Installer
                                </h1>
                                <div className="flex items-center space-x-1.5">
                                    <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                                    <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-500">v2.1.0</p>
                                </div>
                            </div>
                            <div className="hidden md:flex flex-col items-end">
                                <span className="text-[10px] font-black text-blue-500 uppercase tracking-[0.2em] mb-0.5">Engine Status</span>
                                <div className="flex items-center space-x-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                                    <span className="text-xs font-bold text-slate-300">v2.1.0 Production</span>
                                </div>
                            </div>
                        </div>
                    </Link>

                    <div className="flex items-center space-x-4">
                        <Link to="/docs" className="flex items-center space-x-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-bold transition-all active:scale-95 text-blue-400">
                            <BookOpen className="w-4 h-4" />
                            <span>Docs</span>
                        </Link>

                        <Link to="/pricing" className="flex items-center space-x-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-bold transition-all active:scale-95 text-emerald-400">
                            <Zap className="w-4 h-4" />
                            <span>Pricing</span>
                        </Link>

                        {user && (user.role === 'admin' || user.role === 'superadmin') && (
                            <Link to="/settings" className="flex items-center space-x-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-bold transition-all active:scale-95">
                                <Settings className="w-4 h-4 text-purple-400" />
                                <span>Settings</span>
                            </Link>
                        )}

                        <Link to="/agents" className="flex items-center space-x-2 px-5 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-xl text-sm font-bold transition-all active:scale-95 text-emerald-400 group">
                            <Wifi className="w-4 h-4 animate-pulse" />
                            <span>SaaS Tunnels</span>
                        </Link>

                        <Link to="/incidents" className="flex items-center space-x-2 px-5 py-2.5 bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 rounded-xl text-sm font-bold transition-all active:scale-95 text-red-400 group">
                            <div className="relative">
                                <div className="absolute inset-0 bg-red-500 blur-sm opacity-50 group-hover:animate-ping"></div>
                                <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse"></div>
                            </div>
                            <span>Incidents</span>
                        </Link>

                        {user && (
                            <div className="flex items-center space-x-4">
                                <div className="hidden sm:flex items-center space-x-2 bg-white/5 border border-white/5 rounded-xl px-4 py-2 shadow-inner">
                                    <User className="w-3.5 h-3.5 text-blue-400" />
                                    <span className="text-xs font-bold text-slate-200">{user.username}</span>
                                    <span className={`text-[8px] px-1.5 py-0.5 rounded font-black tracking-widest ${user.role === 'superadmin' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/20' : user.role === 'admin' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/20' : 'bg-slate-500/20 text-slate-400 border border-slate-500/20'}`}>
                                        {user.role}
                                    </span>
                                </div>
                                <button
                                    onClick={logout}
                                    className="flex items-center space-x-2 px-5 py-2.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-sm font-bold text-red-400 transition-all active:scale-95"
                                >
                                    <LogOut className="w-4 h-4" />
                                    <span>Logout</span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </header>
    )
}
