import { useState, useEffect, useRef } from 'react'
import { Link, NavLink, useLocation, useNavigate, matchPath } from 'react-router-dom'
import {
    Sun, Moon, LayoutDashboard, Rocket, Wifi, ShieldAlert, ShieldCheck, Users, Settings, Bell, BookOpen, Zap, Crown,
    LogOut, Search, Menu, X, ChevronsLeft, ChevronsRight, ChevronDown, ChevronsUpDown, Check, Loader2, Wrench, Eye, Plus, Mail, KeyRound, UserCheck, Globe2,
    Sparkles, Wand2, Coins, History, Bot, PlugZap, Layers, ToggleLeft, Boxes
} from 'lucide-react'
import { useFeatures } from '../../config/features'
import { visibleSections, sectionLink } from '../../config/clusterSections'
import { readLastCluster } from '../../utils/lastCluster'
import { useAuth, apiFetch } from '../../context/AuthContext'
import { can } from '../../config/permissions'
import { useInstallationTracker } from '../../context/InstallationTrackerContext'
import { LogoMark, LogoWord } from './Logo'
import CommandPalette from './CommandPalette'
import UpdatesMenu from './UpdatesMenu'
import AuroraBackground from './AuroraBackground'
import ChangePasswordDialog from './ChangePasswordDialog'
import ApprovalGate from './ApprovalGate'
import UpgradeNotice from './UpgradeNotice'
import TrialNotice, { usePlan } from './TrialNotice'
import { whenVisible } from '../../utils/whenVisible'
import { getTheme, setTheme } from '../../utils/theme'

const ROLE_META = {
    superadmin: { label: 'Super Admin', icon: Crown, tone: 'text-violet-300 bg-violet-500/10 border-violet-400/20' },
    admin: { label: 'Org Admin', icon: Crown, tone: 'text-blue-300 bg-blue-500/10 border-blue-400/20' },
    operator: { label: 'Operator', icon: Wrench, tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-400/20' },
    viewer: { label: 'Viewer', icon: Eye, tone: 'text-slate-300 bg-slate-500/10 border-slate-400/20' }
}

// The open (or last opened) cluster's sections — the same list as the cluster
// page's (config/clusterSections.js). Its heading switches the cluster.
const tabOf = (loc) => new URLSearchParams(loc.search).get('tab') || 'overview'
function clusterSection(role, cluster, featureOn, badges) {
    if (!cluster) return { id: 'cluster', title: 'Cluster', items: [{ to: '/', label: 'Choose a cluster', icon: Boxes, end: true, match: () => false }] }
    const base = sectionLink(cluster.id)
    return {
        id: 'cluster', title: `Cluster · ${cluster.name}`, cluster,
        items: visibleSections(role, cluster.id, featureOn)
            .map(s => ({ to: sectionLink(cluster.id, s.key), label: s.label, icon: s.icon, match: (loc) => loc.pathname === base && tabOf(loc) === s.key,
                // Security: critical CVEs · Certificates: expired, failing or expiring (GET /:id/badges)
                badge: badges?.[s.key]?.count, badgeTone: badges?.[s.key]?.tone, badgeTitle: badges?.[s.key]?.title }))
    }
}

// Navigation, grouped; each page appears once. Items gate by role (the API enforces it too).
export function navSections(user, approvalsWaiting = 0, { cluster = null, featureOn = () => true, clusterBadges = null } = {}) {
    const role = user?.role
    const isAdmin = role === 'admin' || role === 'superadmin'
    // what the member may do decides the menu (custom roles included)
    const canAgents = can(role, 'agent:view')
    const canDeploy = can(role, 'cluster:create')
    const canAi = can(role, 'ai:use')
    return [
        {
            id: 'home', title: 'Home', items: [
                { to: '/', label: 'Clusters', icon: LayoutDashboard, end: true },
                { to: '/incidents', label: 'Incidents', icon: ShieldAlert },
                { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
            ]
        },
        // one cluster's work: Explorer, Apps, GitOps, Security…
        clusterSection(role, cluster, featureOn, clusterBadges),
        // new clusters: installed by KubeEZ, or existing ones connected (its page has
        // the connect wizard, connection agents and setup guides as tabs)
        {
            id: 'add', title: 'Add & connect', items: [
                canDeploy && { to: '/install', label: 'Deploy new cluster', icon: Rocket },
                { to: '/connect', label: 'Existing clusters', icon: PlugZap },
                canAgents && { to: '/agents', label: 'Gateway agents', icon: Wifi },
            ].filter(Boolean)
        },
        // every AI feature in one place
        {
            id: 'ai', title: 'AI', items: [
                canAi && { to: '/ai', label: 'Ask AI', icon: Sparkles, end: true },
                { to: '/fleet', label: 'Fleet', icon: Globe2 },
                canAi && { to: '/ai/create', label: 'Create YAML', icon: Wand2 },
                { to: '/ai/advisor', label: 'Advisor', icon: Coins },
                { to: '/ai/changes', label: 'What changed', icon: History },
                can(role, 'ai:manage') && { to: '/ai/settings', label: 'AI settings', icon: Bot },
            ].filter(Boolean)
        },
        {
            id: 'workspace', title: 'Workspace', items: [
                { to: '/delivery', label: 'Delivery settings', icon: Layers },
                isAdmin && { to: '/users', label: 'Team & Roles', icon: Users },
                { to: '/approvals', label: 'Approvals', icon: UserCheck, badge: approvalsWaiting },
                (isAdmin || can(role, 'alerts:manage')) && { to: '/alerts', label: 'Alerts', icon: Bell },
                isAdmin && { to: '/settings', label: 'Settings', icon: Settings },
                isAdmin && { to: '/features', label: 'Features', icon: ToggleLeft },
            ].filter(Boolean)
        },
        {
            id: 'help', title: 'Help', items: [
                { to: '/docs', label: 'Docs', icon: BookOpen },
                { to: '/pricing', label: 'Plan & usage', icon: Zap },
            ]
        },
        role === 'superadmin' && { id: 'platform', title: 'Platform', items: [{ to: '/admin', label: 'Admin Console', icon: Crown }] },
    ].filter(s => s && s.items.length)
}

const TITLES = [
    [/^\/$/, 'Clusters'], [/^\/install/, 'Deploy a cluster'], [/^\/scale/, 'Scale cluster'], [/^\/(dashboard|installation)\//, 'Installation'],
    [/^\/cluster\//, 'Cluster'], [/^\/explorer/, 'KubeEZ Explorer'], [/^\/incidents/, 'Incidents'], [/^\/compliance/, 'Compliance'], [/^\/alerts/, 'Alerts'], [/^\/agents/, 'Gateway agents'], [/^\/delivery/, 'Delivery settings'], [/^\/features/, 'Features'], [/^\/users/, 'Team & Roles'], [/^\/approvals/, 'Approvals'],
    [/^\/settings/, 'Settings'], [/^\/ai\/settings/, 'AI settings'], [/^\/ai\/create/, 'Create YAML'], [/^\/ai\/advisor/, 'Advisor'], [/^\/ai\/changes/, 'What changed'], [/^\/ai/, 'Ask AI'], [/^\/fleet/, 'Fleet'], [/^\/connect\/new/, 'Add existing cluster'], [/^\/connect\/agents/, 'Connection agents'], [/^\/connect\/guides/, 'Setup guides'], [/^\/connect/, 'Existing clusters'], [/^\/docs/, 'Docs'], [/^\/pricing/, 'Plan & usage'], [/^\/admin/, 'Admin Console'], [/^\/vendor-portal/, 'Vendor Portal']
]

const readCollapsed = () => { try { return localStorage.getItem('kz.sidebar') === 'collapsed' } catch { return false } }
// sidebar groups folded by the person (ids), per browser
const readFolded = () => { try { const v = JSON.parse(localStorage.getItem('kz.sidebar.folded') || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
const isOn = (item, loc) => item.match ? item.match(loc) : !!matchPath({ path: item.to, end: !!item.end }, loc.pathname)

// Zen (default) or Midnight — the person's choice, for every page (utils/theme.js)
function useTheme() {
    const [theme, set] = useState(getTheme)
    useEffect(() => { const on = (e) => set(e.detail); window.addEventListener('kz-theme', on); return () => window.removeEventListener('kz-theme', on) }, [])
    return [theme, () => setTheme(theme === 'dark' ? 'zen' : 'dark')]
}

export default function AppShell({ children }) {
    const { user, logout, refreshAccess } = useAuth()
    const location = useLocation()
    const navigate = useNavigate()
    const { activeInstallations } = useInstallationTracker()
    const [collapsed, setCollapsed] = useState(readCollapsed)
    const [folded, setFolded] = useState(readFolded)
    const toggleFold = (id) => setFolded(f => f.includes(id) ? f.filter(x => x !== id) : [...f, id])
    const [mobileOpen, setMobileOpen] = useState(false)
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [theme, toggleTheme] = useTheme()
    const [openIncidents, setOpenIncidents] = useState(0)
    const running = activeInstallations.filter(i => i.status === 'running')
    const [approvalsWaiting, setApprovalsWaiting] = useState(0)
    const featureOn = useFeatures()
    const plan = usePlan(user?.id)   // the top-bar chip and the trial notice
    const [lastCluster, setLastCluster] = useState(readLastCluster)
    useEffect(() => {
        const on = (e) => setLastCluster(e.detail ? { id: e.detail.id, name: e.detail.name } : null)
        window.addEventListener('kz-last-cluster', on)
        return () => window.removeEventListener('kz-last-cluster', on)
    }, [])
    // the cluster group's badges, from what KubeEZ last read (polling never loads the cluster)
    const [clusterBadges, setClusterBadges] = useState(null)
    useEffect(() => {
        setClusterBadges(null)
        if (!lastCluster?.id) return
        let stop = false
        const load = async () => {
            try {
                const r = await apiFetch(`/api/clusters/${encodeURIComponent(lastCluster.id)}/badges`)
                if (!stop && r.ok) setClusterBadges(await r.json())
            } catch { }
        }
        load()
        const t = setInterval(whenVisible(load), 60000)
        // a section was just looked at (utils/badgeSeen.js)
        const now = (e) => { if (e.detail?.clusterId === lastCluster.id) load() }
        window.addEventListener('kz-badges-refresh', now)
        return () => { stop = true; clearInterval(t); window.removeEventListener('kz-badges-refresh', now) }
    }, [lastCluster?.id])
    const sections = navSections(user, approvalsWaiting, { cluster: lastCluster, featureOn, clusterBadges })
    const title = TITLES.find(([re]) => re.test(location.pathname))?.[1] || 'KubeEZ'

    useEffect(() => { try { localStorage.setItem('kz.sidebar', collapsed ? 'collapsed' : 'open') } catch { } }, [collapsed])
    useEffect(() => { try { localStorage.setItem('kz.sidebar.folded', JSON.stringify(folded)) } catch { } }, [folded])
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
            <div className={`flex items-center gap-3 px-4 h-14 shrink-0 ${collapsed && !mobile ? 'justify-center px-0' : ''}`}>
                <Link to="/" className="flex items-center gap-2.5 group" aria-label="KubeEZ home">
                    <LogoMark className="w-8 h-8 group-hover:rotate-[30deg] transition-transform duration-700" />
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

            <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-4" aria-label="Main">
                {sections.map(s => {
                    const compact = collapsed && !mobile
                    // a folded group still shows the page you are on
                    const shut = !compact && folded.includes(s.id)
                    const items = shut ? s.items.filter(it => isOn(it, location)) : s.items
                    return (
                        <div key={s.id}>
                            {compact ? <div className="kz-divider mx-2 mb-2" /> : (
                                <div className="flex items-center gap-1 px-1 pb-1">
                                    {s.cluster ? <ClusterSwitcher current={s.cluster} location={location} /> : (
                                        <span className="flex-1 min-w-0 truncate px-1.5 text-[11.5px] font-medium text-slate-500">{s.title}</span>
                                    )}
                                    <button type="button" onClick={() => toggleFold(s.id)} aria-expanded={!shut} aria-label={`${shut ? 'Show' : 'Hide'} ${s.title}`}
                                        className="p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-white/5">
                                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${shut ? '-rotate-90' : ''}`} />
                                    </button>
                                </div>
                            )}
                            <ul className="space-y-1">
                                {items.map(it => <SideLink key={it.label} item={it} compact={compact} location={location} />)}
                            </ul>
                        </div>
                    )
                })}
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
            <aside className="hidden lg:block sticky top-0 h-screen shrink-0 z-40">
                <div className="h-full border-r border-white/[0.07] bg-[#0b0c0e]">
                    {sidebar(false)}
                </div>
            </aside>

            {/* Mobile drawer */}
            {mobileOpen && (
                <div className="lg:hidden fixed inset-0 z-[60]">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
                    <aside className="absolute inset-y-0 left-0 border-r border-white/[0.08] bg-[#0b0c0e] kz-rise">
                        {sidebar(true)}
                    </aside>
                </div>
            )}

            <div className="flex-1 min-w-0 flex flex-col">
                {/* Top bar */}
                <header className="sticky top-0 z-30 h-14 flex items-center gap-3 px-4 sm:px-6 lg:px-8 border-b border-white/[0.06] bg-[#08090a]/85 backdrop-blur-md">
                    <button onClick={() => setMobileOpen(true)} className="lg:hidden p-2 -ml-2 rounded-lg text-slate-300 hover:bg-white/5" aria-label="Open menu"><Menu className="w-5 h-5" /></button>
                    <Link to="/" className="lg:hidden" aria-label="KubeEZ home"><LogoMark className="w-8 h-8" /></Link>
                    <h1 className="hidden sm:block font-display text-[15px] font-medium text-slate-300 truncate">{title}</h1>

                    <button onClick={() => setPaletteOpen(true)}
                        className="ml-auto sm:ml-6 flex items-center gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/15 px-3 py-1.5 text-[13px] text-slate-500 transition w-full max-w-xs min-w-0"
                        aria-label="Search">
                        <Search className="w-4 h-4" />
                        <span className="flex-1 text-left truncate">Search clusters, pages…</span>
                        <span className="hidden md:flex items-center gap-1"><span className="kz-kbd">Ctrl</span><span className="kz-kbd">K</span></span>
                    </button>

                    <div className="flex items-center gap-2 sm:ml-auto shrink-0">
                        <PlanChip plan={plan} />
                        <button type="button" onClick={toggleTheme} className="p-2.5 rounded-xl text-slate-300 hover:text-white hover:bg-white/5 transition"
                            aria-label={theme === 'zen' ? 'Switch to dark theme' : 'Switch to Zen theme'} title={theme === 'zen' ? 'Dark theme' : 'Zen theme'}>
                            {theme === 'zen' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
                        </button>
                        <UpdatesMenu />
                        <Link to="/incidents" className="relative p-2.5 rounded-xl text-slate-300 hover:text-white hover:bg-white/5 transition" aria-label={`Incidents${openIncidents ? ` (${openIncidents} open)` : ''}`}>
                            <Bell className="w-5 h-5" />
                            {openIncidents > 0 && (
                                <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-[9px] font-black text-white flex items-center justify-center ring-2 ring-[var(--kz-bg)]">{openIncidents > 9 ? '9+' : openIncidents}</span>
                            )}
                        </Link>
                        {can(user?.role, 'cluster:create') && (
                            <Link to="/install" className="kz-btn-primary hidden sm:inline-flex !py-2"><Plus className="w-4 h-4" /> New cluster</Link>
                        )}
                    </div>
                </header>

                <main className="flex-1 w-full max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
                    <TrialNotice plan={plan} userId={user?.id} />
                    <div key={location.pathname} className="kz-rise">{children}</div>
                </main>
            </div>

            <ApprovalGate />
            <UpgradeNotice />
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} sections={sections} onLogout={logout} />
        </div>
    )
}

const BADGE_TONE = { blue: 'bg-blue-500', red: 'bg-red-500', amber: 'bg-amber-500' }

// The plan in the top bar: a running Pro trial (days left), an ended one, or
// Free — each leads to Plan & usage. Paid plans show nothing.
function PlanChip({ plan: p }) {
    if (!p || p.superadmin) return null
    const days = p.trial?.daysLeft
    if (!days && p.plan !== 'FREE') return null
    const ended = !days && !!p.trial?.endedAt
    const tone = days ? (days <= 3 ? 'border-amber-400/40 bg-amber-500/10 text-amber-200' : 'border-blue-400/30 bg-blue-500/10 text-blue-200')
        : ended ? 'border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:text-white'
    return (
        <Link to="/pricing" title={days ? 'Every feature during the trial — see what stays in Free' : ended ? 'Your Pro trial has ended — see what is locked and how to get it back' : 'See what Free includes and what comes with Pro'}
            className={`hidden md:inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold transition ${tone}`}>
            <Sparkles className="w-3.5 h-3.5" />
            {days ? `Pro trial · ${days} day${days === 1 ? '' : 's'} left` : ended ? <>Trial ended · <span className="text-white">Upgrade</span></> : <>Free · <span className="text-blue-300">Upgrade</span></>}
        </Link>
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
                    return `group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium transition-colors ${compact ? 'justify-center px-0' : ''} ${active
                        ? 'text-white bg-white/[0.07]'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04]'}`
                }}>
                {({ isActive }) => {
                    const active = custom ?? isActive
                    return <>
                                                <Icon className={`w-4 h-4 shrink-0 transition-colors ${active ? 'text-blue-300' : 'text-slate-500 group-hover:text-slate-300'}`} />
                        {!compact && <span className="truncate">{item.label}</span>}
                        {!!item.badge && <span title={item.badgeTitle} className={`${compact ? 'absolute top-1 right-1' : 'ml-auto'} min-w-[18px] h-[18px] px-1 rounded-full ${BADGE_TONE[item.badgeTone] || BADGE_TONE.blue} text-[10px] font-bold text-white flex items-center justify-center`}>{item.badge > 9 ? '9+' : item.badge}</span>}
                    </>
                }}
            </NavLink>
        </li>
    )
}

// The cluster group's heading: opens another cluster on the same section
function ClusterSwitcher({ current, location }) {
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const [list, setList] = useState(null)
    const ref = useRef(null)
    useEffect(() => {
        if (!open) return
        apiFetch('/api/clusters/list').then(r => r.ok ? r.json() : []).then(d => setList(Array.isArray(d) ? d : [])).catch(() => setList([]))
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
    }, [open])
    const go = (id) => {
        setOpen(false)
        const here = location.pathname.startsWith('/cluster/') ? tabOf(location) : 'overview'
        navigate(sectionLink(id, here))
    }
    return (
        <div className="relative flex-1 min-w-0" ref={ref}>
            <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title="Switch cluster"
                className="w-full flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] font-medium text-slate-500 hover:text-slate-200 hover:bg-white/5">
                <span className="truncate">Cluster · <span className="text-slate-300">{current.name}</span></span>
                <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-70" />
            </button>
            {open && (
                <div role="listbox" aria-label="Clusters" className="absolute left-0 right-0 top-full mt-1 z-50 kz-card p-1 max-h-72 overflow-y-auto kz-rise">
                    {!list ? <div className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin text-slate-500" /></div>
                        : !list.length ? <p className="px-3 py-2 text-xs text-slate-500">No clusters</p>
                            : list.map(c => (
                                <button key={c.id} type="button" role="option" aria-selected={c.id === current.id} onClick={() => go(c.id)}
                                    className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-300 hover:bg-white/5 hover:text-white">
                                    <span className="flex-1 truncate">{c.clusterName || c.id}</span>
                                    {c.id === current.id && <Check className="w-3.5 h-3.5 text-blue-300" />}
                                </button>
                            ))}
                    <div className="kz-divider my-1" />
                    <Link to="/" onClick={() => setOpen(false)} className="block rounded-lg px-2.5 py-2 text-[12px] text-slate-400 hover:bg-white/5 hover:text-white">All clusters</Link>
                </div>
            )}
        </div>
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
