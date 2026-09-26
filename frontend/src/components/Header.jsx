import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useInstallationTracker } from '../context/InstallationTrackerContext'
import { useState, useEffect, useRef } from 'react'
import {
    Server, BookOpen, LogOut, User, Settings, Wifi, Users, Zap,
    Loader2, Home, Shield, ChevronDown, Crown, Wrench, Eye, Mail
} from 'lucide-react'

// Client-side role capabilities (mirrors backend RBAC for UI gating only)
const ROLE_META = {
    superadmin: { label: 'Super Admin', icon: Crown, color: 'bg-purple-500/20 text-purple-400 border-purple-500/20' },
    admin:      { label: 'Org Admin',   icon: Crown, color: 'bg-blue-500/20 text-blue-400 border-blue-500/20' },
    operator:   { label: 'Operator',    icon: Wrench, color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/20' },
    viewer:     { label: 'Viewer',      icon: Eye,   color: 'bg-slate-500/20 text-slate-400 border-slate-500/20' }
}

export default function Header() {
    const { logout, user } = useAuth()
    const navigate = useNavigate()
    const { activeInstallations } = useInstallationTracker()
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef(null)

    const runningInstallations = activeInstallations.filter(i => i.status === 'running')

    // RBAC-driven UI gating
    const isAdmin = user && (user.role === 'admin' || user.role === 'superadmin')
    const canManageAgents = user && ['admin', 'operator', 'superadmin'].includes(user.role)

    // Close the profile menu on outside click
    useEffect(() => {
        const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
        document.addEventListener('mousedown', onClick)
        return () => document.removeEventListener('mousedown', onClick)
    }, [])

    const roleMeta = ROLE_META[user?.role] || ROLE_META.viewer
    const RoleIcon = roleMeta.icon

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
                        <div>
                            <h1 className="text-xl font-black tracking-tighter text-white">
                                Universal <span className="text-blue-500">K8s</span> Installer
                            </h1>
                            <div className="flex items-center space-x-1.5">
                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                                <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-500">v2.1.0 Production</p>
                            </div>
                        </div>
                    </Link>

                    <div className="flex items-center space-x-3">
                        {/* Running Installations Indicator */}
                        {runningInstallations.length > 0 && (
                            <button
                                onClick={() => navigate(`/dashboard/${runningInstallations[0].id}`)}
                                className="relative flex items-center space-x-2 px-4 py-2.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-xl text-sm font-bold transition-all active:scale-95 text-blue-400"
                            >
                                <span className="absolute -top-1 -right-1 flex h-4 w-4">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-4 w-4 bg-blue-500 items-center justify-center text-[8px] font-black text-white">{runningInstallations.length}</span>
                                </span>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span className="hidden lg:inline">Installing...</span>
                            </button>
                        )}

                        <NavLink to="/" icon={Home} label="Home" className="text-blue-400" />
                        <NavLink to="/docs" icon={BookOpen} label="Docs" className="text-slate-300" />
                        <NavLink to="/pricing" icon={Zap} label="Pricing" className="text-emerald-400" />
                        {canManageAgents && <NavLink to="/agents" icon={Wifi} label="Tunnels" className="text-emerald-400" />}

                        {/* Profile dropdown — shows the logged-in account's info + role-based links */}
                        {user && (
                            <div className="relative" ref={menuRef}>
                                <button
                                    onClick={() => setMenuOpen(o => !o)}
                                    className="flex items-center gap-2 pl-3 pr-2 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all active:scale-95"
                                >
                                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-black text-xs">
                                        {user.username?.charAt(0).toUpperCase()}
                                    </div>
                                    <span className="hidden sm:inline text-xs font-bold text-slate-200 max-w-[100px] truncate">{user.username}</span>
                                    <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
                                </button>

                                {menuOpen && (
                                    <div className="absolute right-0 mt-2 w-72 bg-[#0d0d0f] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                                        {/* Account header */}
                                        <div className="p-5 border-b border-white/5 bg-white/[0.02]">
                                            <div className="flex items-center gap-3">
                                                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-black text-lg">
                                                    {user.username?.charAt(0).toUpperCase()}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="font-black text-white text-sm truncate">{user.username}</p>
                                                    {user.email && <p className="text-[11px] text-slate-500 truncate flex items-center gap-1"><Mail className="w-3 h-3" />{user.email}</p>}
                                                </div>
                                            </div>
                                            <div className="mt-3 flex items-center gap-2">
                                                <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-lg border ${roleMeta.color}`}>
                                                    <RoleIcon className="w-3 h-3" /> {roleMeta.label}
                                                </span>
                                            </div>
                                        </div>

                                        {/* Links (role-gated) */}
                                        <div className="p-2">
                                            <MenuLink to="/incidents" icon={Shield} label="Incidents & Auto-Healing" onClick={() => setMenuOpen(false)} />
                                            {isAdmin && <MenuLink to="/users" icon={Users} label="Team & Roles" onClick={() => setMenuOpen(false)} />}
                                            {isAdmin && <MenuLink to="/settings" icon={Settings} label="Workspace Settings" onClick={() => setMenuOpen(false)} />}
                                            {canManageAgents && <MenuLink to="/agents" icon={Wifi} label="Gateway Agents" onClick={() => setMenuOpen(false)} />}
                                        </div>

                                        {/* Logout */}
                                        <div className="p-2 border-t border-white/5">
                                            <button
                                                onClick={() => { setMenuOpen(false); logout() }}
                                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-red-400 hover:bg-red-500/10 transition-colors text-sm font-bold"
                                            >
                                                <LogOut className="w-4 h-4" /> Sign Out
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </header>
    )
}

function NavLink({ to, icon: Icon, label, className = '' }) {
    return (
        <Link to={to} className={`hidden md:flex items-center space-x-2 px-4 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-bold transition-all active:scale-95 ${className}`}>
            <Icon className="w-4 h-4" />
            <span>{label}</span>
        </Link>
    )
}

function MenuLink({ to, icon: Icon, label, onClick }) {
    return (
        <Link to={to} onClick={onClick} className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-slate-300 hover:bg-white/5 hover:text-white transition-colors text-sm font-bold">
            <Icon className="w-4 h-4 text-slate-500" />
            {label}
        </Link>
    )
}
