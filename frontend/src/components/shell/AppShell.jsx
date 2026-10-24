import { useState, useEffect, useRef } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
    LayoutDashboard, Rocket, Wifi, ShieldAlert, ShieldCheck, Users, Settings, Bell, BookOpen, Zap, Crown,
    LogOut, Search, Menu, X, ChevronsLeft, ChevronsRight, Loader2, Wrench, Eye, Plus, Mail, Compass, KeyRound, UserCheck, Globe2,
    Sparkles, Wand2, Coins, History, Bot, PlugZap, PlusCircle, Radio, BookMarked
} from 'lucide-react'
import { useAuth, apiFetch } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useInstallationTracker } from '../../context/InstallationTrackerContext'
import { LogoMark, LogoWord } from './Logo'
import CommandPalette from './CommandPalette'
import UpdatesMenu from './UpdatesMenu'
import AuroraBackground from './AuroraBackground'
import ChangePasswordDialog from './ChangePasswordDialog'
import ApprovalGate from './ApprovalGate'
import { whenVisible } from '../../utils/whenVisible'

const ROLE_META = {
    superadmin: { label: 'Super Admin', icon: Crown, tone: 'text-violet-300 bg-violet-500/10 border-violet-400/20' },
    admin: { label: 'Org Admin', icon: Crown, tone: 'text-blue-300 bg-blue-500/10 border-blue-400/20' },
    operator: { label: 'Operator', icon: Wrench, tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20' },
    viewer: { label: 'Viewer', icon: Eye, tone: 'text-slate-300 bg-slate-500/10 border-slate-400/20' }
}

// Navigation, grouped; `show` gates by role (the API enforces it too)
export function navSections(user, approvalsWaiting = 0) {
    const role = user?.role
    const isAdmin = role === 'admin' || role === 'superadmin'
    // what the member may do decides the menu (custom roles included)
    const canAgents = can(role, 'agent:view')
    const canDeploy = can(role, 'cluster:create')
    const canAi = can(role, 'ai:use')
    return [
        {
            title: 'Overview', items: [
                { to: '/', label: 'Clusters', icon: LayoutDashboard, end: true },
                { to: '/explorer', label: 'Explorer', icon: Compass },
                { to: '/incidents', label: 'Incidents', icon: ShieldAlert },
                { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
            ]
        },
        // every AI feature in one place
        {
            title: 'AI', items: [
                canAi && { to: '/ai', label: 'Ask AI', icon: Sparkles, end: true },
                { to: '/fleet', label: 'Fleet', icon: Globe2 },
                canAi && { to: '/ai/create', label: 'Create YAML', icon: Wand2 },
                { to: '/ai/advisor', label: 'Advisor', icon: Coins },
                { to: '/ai/changes', label: 'What changed', icon: History },
                can(role, 'ai:manage') && { to: '/ai/settings', label: 'AI settings', icon: Bot },
            ].filter(Boolean)
        },
        // existing clusters (cloud or on-prem) brought into KubeEZ
        {
            title: 'Connected clusters', items: [
                can(role, 'cluster:create') && { to: '/connect/new', label: 'Add existing cluster', icon: PlusCircle },
                { to: '/connect', label: 'Connected clusters', icon: PlugZap, end: true },
                { to: '/connect/agents', label: 'Connection agents', icon: Radio },
                { to: '/connect/guides', label: 'Setup guides', icon: BookMarked },
            ].filter(Boolean)
        },
        {
            title: 'Build', items: [
                canDeploy && { to: '/install', label: 'Deploy cluster', icon: Rocket },
                canAgents && { to: '/agents', label: 'Gateway Agents', icon: Wifi },
            ].filter(Boolean)
        },
        {
            title: 'Workspace', items: [
                isAdmin && { to: '/users', label: 'Team & Roles', icon: Users },
                { to: '/approvals', label: 'Approvals', icon: UserCheck, badge: approvalsWaiting },
                (isAdmin || can(role, 'alerts:manage')) && { to: '/alerts', label: 'Alerts', icon: Bell },
                isAdmin && { to: '/settings', label: 'Settings', icon: Settings },
            ].filter(Boolean)
        },
        {
            title: 'Help', items: [
                { to: '/docs', label: 'Docs', icon: BookOpen },
                { to: '/pricing', label: 'Plans', icon: Zap },
            ]
        },
        role === 'superadmin' && { title: 'Platform', items: [{ to: '/admin', label: 'Admin Console', icon: Crown }] },
    ].filter(s => s && s.items.length)
}

const TITLES = [
    [/^\/$/, 'Clusters'], [/^\/install/, 'Deploy a cluster'], [/^\/scale/, 'Scale cluster'], [/^\/(dashboard|installation)\//, 'Installation'],
    [/^\/cluster\//, 'Cluster'], [/^\/explorer/, 'KubeEZ Explorer'], [/^\/incidents/, 'Incidents'], [/^\/compliance/, 'Compliance'], [/^\/alerts/, 'Alerts'], [/^\/agents/, 'Gateway Agents'], [/^\/users/, 'Team & Roles'], [/^\/approvals/, 'Approvals'],
    [/^\/settings/, 'Settings'], [/^\/ai\/settings/, 'AI settings'], [/^\/ai\/create/, 'Create YAML'], [/^\/ai\/advisor/, 'Advisor'], [/^\/ai\/changes/, 'What changed'], [/^\/ai/, 'Ask AI'], [/^\/fleet/, 'Fleet'], [/^\/connect\/new/, 'Add existing cluster'], [/^\/connect\/agents/, 'Connection agents'], [/^\/connect\/guides/, 'Setup guides'], [/^\/connect/, 'Connected clusters'], [/^\/docs/, 'Docs'], [/^\/pricing/, 'Plans'], [/^\/admin/, 'Admin Console'], [/^\/vendor-portal/, 'Vendor Portal']
]

const readCollapsed = () => { try { return localStorage.getItem('kz.sidebar') === 'collapsed' } catch { return false } }

export default function AppShell({ children }) {
    const { user, logout, refreshAccess } = useAuth()
    const location = useLocation()
    const navigate = useNavigate()
    const { activeInstallations } = useInstallationTracker()
    const [collapsed, setCollapsed] = useState(readCollapsed)
    const [mobileOpen, setMobileOpen] = useState(false)
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [openIncidents, setOpenIncidents] = useState(0)
    const running = activeInstallations.filter(i => i.status === 'running')
    const [approvalsWaiting, setApprovalsWaiting] = useState(0)
    const sections = navSections(user, approvalsWaiting)
    const title = TITLES.find(([re]) => re.test(location.pathname))?.[1] || 'KubeEZ'

    useEffect(() => { try { localStorage.setItem('kz.sidebar', collapsed ? 'collapsed' : 'open') } catch { } }, [collapsed])
    useEffect(() => { setMobileOpen(false) }, [location.pathname, location.search])
    // role or cluster rules may have changed meanwhile
    useEffect(() => { refreshAccess?.() }, [location.pathname])
    useEffect(() => { document.title = `${title} · KubeEZ` }, [title])

    // ⌘K / Ctrl+K opens search from anywhere
    useEffect(() => {
        const onKey = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o) }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [])

    // Requests waiting for me (approvers) → badge on Approvals
    useEffect(() => {
        let stop = false
        const load = async () => {
            try {
                const r = await apiFetch('/api/approvals')
                const d = r.ok ? await r.json() : null
                if (!stop && d) setApprovalsWaiting(d.canApprove ? (d.requests || []).filter(x => x.status === 'pending' && x.requestedBy?.id !== user?.id).length : 0)
            } catch { }
        }
        load()
        const t = setInterval(whenVisible(load), 30000)
        return () => { stop = true; clearInterval(t) }
    }, [user?.id, location.pathname])

    // Open incidents → badge on the bell
    useEffect(() => {
        let stop = false
        const load = async () => {
            try {
                const r = await apiFetch('/api/incidents')
                const list = r.ok ? await r.json() : []
                if (!stop && Array.isArray(list)) setOpenIncidents(list.filter(i => i.status !== 'resolved' && i.status !== 'cleared').length)
            } catch { }
        }
        load()
        const t = setInterval(whenVisible(load), 30000)
        return () => { stop = true; clearInterval(t) }
    }, [])

    const sidebar = (mobile) => (
        <div className={`flex h-full flex-col ${mobile ? 'w-72' : collapsed ? 'w-[76px]' : 'w-64'} transition-[width] duration-300`}>
            <div className={`flex items-center gap-3 px-4 h-16 shrink-0 ${collapsed && !mobile ? 'justify-center px-0' : ''}`}>
                <Link to="/" className="flex items-center gap-2.5 group" aria-label="KubeEZ home">
                    <LogoMark className="w-9 h-9 drop-shadow-[0_0_18px_rgba(128,105,251,.55)] group-hover:rotate-[30deg] transition-transform duration-700" />
                    {(!collapsed || mobile) && <LogoWord className="text-lg" />}
                </Link>
                {mobile && <button onClick={() => setMobileOpen(false)} className="ml-auto p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close menu"><X className="w-5 h-5" /></button>}
            </div>

            {running.length > 0 && (
                <button onClick={() => navigate(`/dashboard/${running[0].id}`)}
                    className={`mx-3 mb-2 flex items-center gap-2.5 rounded-xl border border-blue-400/25 bg-blue-500/10 px-3 py-2.5 text-left text-blue-200 hover:bg-blue-500/15 transition ${collapsed && !mobile ? 'justify-center px-0' : ''}`}
                    title="Installation running">
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                    {(!collapsed || mobile) && <span className="text-xs font-bold truncate">{running.length} installation{running.length > 1 ? 's' : ''} running</span>}
                </button>
            )}

            <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5" aria-label="Main">
                {sections.map(s => (
                    <div key={s.title}>
                        {(!collapsed || mobile) ? <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-600">{s.title}</div> : <div className="kz-divider mx-2 mb-2" />}
                        <ul className="space-y-1">
                            {s.items.map(it => <SideLink key={it.label} item={it} compact={collapsed && !mobile} location={location} />)}
                        </ul>
                    </div>
                ))}
            </nav>

            <div className="p-3 shrink-0">
                <UserCard user={user} compact={collapsed && !mobile} onLogout={logout} />
                {!mobile && (
                    <button onClick={() => setCollapsed(c => !c)} className="mt-2 w-full flex items-center justify-center gap-2 rounded-xl py-2 text-[11px] font-bold text-slate-500 hover:text-white hover:bg-white/5 transition"
                        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
                        {collapsed ? <ChevronsRight className="w-4 h-4" /> : <><ChevronsLeft className="w-4 h-4" /> Collapse</>}
                    </button>
                )}
            </div>
        </div>
    )

    return (
        <div className="min-h-screen flex">
            <AuroraBackground />
            {/* Desktop sidebar */}
            <aside className="hidden lg:block sticky top-0 h-screen shrink-0 p-3 pr-0 z-40">
                <div className="h-full rounded-[22px] border border-white/[0.07] bg-[#0e0e13]/75 backdrop-blur-2xl shadow-[inset_0_1px_0_rgba(255,255,255,.06),0_30px_80px_-40px_rgba(0,0,0,.9)]">
                    {sidebar(false)}
                </div>
            </aside>

            {/* Mobile drawer */}
            {mobileOpen && (
                <div className="lg:hidden fixed inset-0 z-[60]">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
                    <aside className="absolute inset-y-0 left-0 border-r border-white/[0.08] bg-[#0b0b0f]/95 backdrop-blur-2xl kz-rise">
                        {sidebar(true)}
                    </aside>
                </div>
            )}

            <div className="flex-1 min-w-0 flex flex-col">
                {/* Top bar */}
                <header className="sticky top-0 z-30 h-16 flex items-center gap-3 px-4 sm:px-6 lg:px-8 bg-[#08080b]/55 backdrop-blur-2xl [mask-image:linear-gradient(#000_85%,transparent)]">
                    <button onClick={() => setMobileOpen(true)} className="lg:hidden p-2 -ml-2 rounded-lg text-slate-300 hover:bg-white/5" aria-label="Open menu"><Menu className="w-5 h-5" /></button>
                    <Link to="/" className="lg:hidden" aria-label="KubeEZ home"><LogoMark className="w-8 h-8" /></Link>
                    <h1 className="hidden sm:block font-display text-[15px] font-medium text-slate-300 truncate">{title}</h1>

                    <button onClick={() => setPaletteOpen(true)}
                        className="ml-auto sm:ml-6 flex items-center gap-2.5 rounded-full border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/15 px-4 py-2 text-sm text-slate-500 transition w-full max-w-xs min-w-0"
                        aria-label="Search">
                        <Search className="w-4 h-4" />
                        <span className="flex-1 text-left truncate">Search clusters, pages…</span>
                        <span className="hidden md:flex items-center gap-1"><span className="kz-kbd">Ctrl</span><span className="kz-kbd">K</span></span>
                    </button>

                    <div className="flex items-center gap-2 sm:ml-auto shrink-0">
                        <UpdatesMenu />
                        <Link to="/incidents" className="relative p-2.5 rounded-xl text-slate-300 hover:text-white hover:bg-white/5 transition" aria-label={`Incidents${openIncidents ? ` (${openIncidents} open)` : ''}`}>
                            <Bell className="w-5 h-5" />
                            {openIncidents > 0 && (
                                <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-[9px] font-black text-white flex items-center justify-center ring-2 ring-[#08080b]">{openIncidents > 9 ? '9+' : openIncidents}</span>
                            )}
                        </Link>
                        {can(user?.role, 'cluster:create') && (
                            <Link to="/install" className="kz-btn-primary hidden sm:inline-flex !py-2"><Plus className="w-4 h-4" /> New cluster</Link>
                        )}
                    </div>
                </header>

                <main className="flex-1 w-full max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
                    <div key={location.pathname} className="kz-rise">{children}</div>
                </main>
            </div>

            <ApprovalGate />
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} sections={sections} onLogout={logout} />
        </div>
    )
}

function SideLink({ item, compact, location }) {
    const Icon = item.icon
    const custom = item.match ? item.match(location) : null
    return (
        <li>
            <NavLink to={item.to} end={item.end} title={compact ? item.label : undefined}
                className={({ isActive }) => {
                    const active = custom ?? isActive
                    return `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all ${compact ? 'justify-center px-0' : ''} ${active
                        ? 'text-white bg-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,.06),inset_0_0_0_1px_rgba(255,255,255,.05)]'
                        : 'text-slate-400 hover:text-white hover:bg-white/[0.035]'}`
                }}>
                {({ isActive }) => {
                    const active = custom ?? isActive
                    return <>
                        {active && <span className="absolute -left-[10px] top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-blue-400 shadow-[0_0_12px_2px_rgba(128,105,251,.7)]" />}
                        <Icon className={`w-[18px] h-[18px] shrink-0 transition-colors ${active ? 'text-blue-300 drop-shadow-[0_0_8px_rgba(128,105,251,.6)]' : 'text-slate-500 group-hover:text-slate-300'}`} />
                        {!compact && <span className="truncate">{item.label}</span>}
                        {!!item.badge && <span className={`${compact ? 'absolute top-1 right-1' : 'ml-auto'} min-w-[18px] h-[18px] px-1 rounded-full bg-blue-500 text-[10px] font-bold text-white flex items-center justify-center`}>{item.badge > 9 ? '9+' : item.badge}</span>}
                    </>
                }}
            </NavLink>
        </li>
    )
}

function UserCard({ user, compact, onLogout }) {
    const { access } = useAuth()
    const [open, setOpen] = useState(false)
    const [changePwd, setChangePwd] = useState(false)
    const ref = useRef(null)
    useEffect(() => {
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
    }, [])
    if (!user) return null
    const meta = ROLE_META[user.role] || { ...ROLE_META.viewer, label: access?.roleName || 'Custom role', icon: Wrench, tone: 'text-blue-200 bg-blue-500/10 border-blue-400/20' }
    const RoleIcon = meta.icon
    const initial = user.username?.charAt(0).toUpperCase()
    return (
        <div className="relative" ref={ref}>
            {changePwd && <ChangePasswordDialog onClose={() => setChangePwd(false)} />}
            {open && (
                <div className="absolute bottom-full left-0 mb-2 w-64 kz-card p-2 kz-rise z-50">
                    <div className="px-3 py-3">
                        <p className="font-bold text-white text-sm truncate">{user.username}</p>
                        {user.email && <p className="text-[11px] text-slate-400 truncate flex items-center gap-1 mt-0.5"><Mail className="w-3 h-3" />{user.email}</p>}
                        <span className={`mt-2 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-lg border ${meta.tone}`}><RoleIcon className="w-3 h-3" />{meta.label}</span>
                    </div>
                    <div className="kz-divider my-1" />
                    <button onClick={() => { setOpen(false); setChangePwd(true) }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-slate-200 hover:bg-white/5">
                        <KeyRound className="w-4 h-4" /> Change password
                    </button>
                    <button onClick={() => { setOpen(false); onLogout() }} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-semibold text-red-300 hover:bg-red-500/10">
                        <LogOut className="w-4 h-4" /> Sign out
                    </button>
                </div>
            )}
            <button onClick={() => setOpen(o => !o)} className={`w-full flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06] p-2 transition ${compact ? 'justify-center' : ''}`}
                aria-label="Account menu" aria-expanded={open}>
                <span className="relative w-9 h-9 shrink-0 rounded-xl bg-aurora-gradient flex items-center justify-center font-display font-bold text-white">
                    {initial}
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 ring-2 ring-[#0b0b0f]" />
                </span>
                {!compact && (
                    <span className="min-w-0 text-left">
                        <span className="block text-sm font-bold text-white truncate">{user.username}</span>
                        <span className="block text-[11px] text-slate-400 truncate">{meta.label}</span>
                    </span>
                )}
            </button>
        </div>
    )
}
