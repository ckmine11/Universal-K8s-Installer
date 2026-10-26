import { useState, useEffect, useCallback, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useAuth, apiFetch } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import { PageTitle } from '../components/ui/PageHeader'
import {
    Users, Shield, User, Trash2, Crown, RefreshCw, Loader2,
    Lock, AlertTriangle, Check, Clock, Eye, Wrench,
    KeyRound, Search, UserCheck, UserX, MoreVertical, X, Layers, Download, ShieldCheck, Sparkles, EyeOff
} from 'lucide-react'
import RolesPanel from '../components/team/RolesPanel'
import ClusterAccessDialog from '../components/team/ClusterAccessDialog'
import useBackdropClose from '../components/ui/useBackdropClose'

// Role metadata — single source for labels/colors/descriptions on the client
const ROLE_META = {
    superadmin: { label: 'Super Admin', icon: Crown, color: 'text-violet-300 bg-violet-500/10 border-violet-500/20', desc: 'Runs the whole KubeEZ platform.' },
    admin:   { label: 'Org Admin', icon: Crown,  color: 'text-amber-400 bg-amber-500/10 border-amber-500/20',   desc: 'Full control: clusters, team, billing.' },
    operator: { label: 'Operator',  icon: Wrench, color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',      desc: 'Create & manage clusters/add-ons. No team or billing.' },
    viewer:   { label: 'Viewer',    icon: Eye,    color: 'text-slate-300 bg-white/5 border-white/10',            desc: 'Read-only access to clusters & health.' }
}
const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer']

// ─── Role Badge ───────────────────────────────────────────────────
const CUSTOM_META = { icon: ShieldCheck, color: 'text-sky-200 bg-sky-500/10 border-sky-400/25' }
// KubeEZ AI per member: only admins have it by default — an admin gives it
const AI_LEVELS = [
    { key: 'none', name: 'No AI', hint: 'KubeEZ AI is hidden for this member' },
    { key: 'ask', name: 'Ask AI', hint: 'Ask AI, explanations, summaries, Create YAML — nothing is changed' },
    { key: 'apply', name: 'Ask & apply', hint: 'Also applies AI-written YAML and AI fixes — only where their role has Kubernetes edit access' }
]

function RoleBadge({ role, name }) {
    const meta = ROLE_META[role] || { ...CUSTOM_META, label: name || 'Custom role' }
    const Icon = meta.icon
    return (
        <span className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border ${meta.color}`}>
            <Icon className="w-3 h-3" />
            {meta.label}
        </span>
    )
}

// ─── Reset Password Modal ─────────────────────────────────────────
function ResetPasswordModal({ user, onClose, onSuccess }) {
    const { toast } = useToast()
    const [password, setPassword] = useState('')
    // a typed password is not lost to an Escape (meant for a browser popup) or a stray click
    const backdrop = useBackdropClose(onClose, { keepOpen: () => !!password })
    const [loading, setLoading] = useState(false)

    const handleReset = async () => {
        if (password.length < 8) {
            toast({ title: 'Error', message: 'Password must be at least 8 characters', type: 'error' })
            return
        }
        setLoading(true)
        try {
            const res = await apiFetch(`/api/admin/users/${user.id}/reset-password`, {
                method: 'POST',
                body: JSON.stringify({ newPassword: password })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast({ title: 'Password Reset', message: data.message, type: 'success' })
            onSuccess()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }

    // a portal: the page's animated / blurred containers must not move or clip the dialog
    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" {...backdrop}>
            <div className="glass rounded-3xl border border-white/10 p-8 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2.5 bg-amber-500/15 rounded-2xl border border-amber-500/20">
                        <KeyRound className="w-5 h-5 text-amber-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-white">Reset Password</h3>
                        <p className="text-xs text-slate-500">For: <span className="text-slate-300 font-bold">{user.username}</span></p>
                    </div>
                </div>
                <div className="space-y-4">
                    <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden aria-hidden="true" tabIndex={-1} />
                    <input
                        type="password"
                        name="new-password"
                        autoComplete="new-password"
                        placeholder="New password (min 8 characters)"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleReset()}
                        className="w-full bg-black/35 border border-white/5 focus:border-amber-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors"
                        autoFocus
                    />
                    <div className="flex gap-3">
                        <button onClick={onClose} className="flex-1 py-3 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-xs font-black uppercase tracking-wider text-slate-400 transition-all">
                            Cancel
                        </button>
                        <button
                            onClick={handleReset}
                            disabled={loading}
                            className="flex-1 py-3 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-xl text-xs font-black uppercase tracking-wider text-white transition-all flex items-center justify-center gap-2"
                        >
                            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                            Reset
                        </button>
                    </div>
                </div>
            </div>
        </div>
    , document.body)
}

// ─── Create User Modal ─────────────────────────────────────────────
function CreateUserModal({ onClose, onSuccess, roleOptions }) {
    const { toast } = useToast()
    const [formData, setFormData] = useState({ username: '', email: '', password: '', role: 'viewer', aiAccess: 'none' })
    const [loading, setLoading] = useState(false)
    const [showPwd, setShowPwd] = useState(false)
    // once something is typed, only Cancel closes it (not Escape, not a click outside)
    const backdrop = useBackdropClose(onClose, { keepOpen: () => !!(formData.username || formData.email || formData.password) })
    // each field updates only itself — a password manager filling one field at the same moment cannot wipe another
    const field = (k) => (e) => { const v = e.target.value; setFormData(f => ({ ...f, [k]: v })) }

    const handleCreate = async (e) => {
        e?.preventDefault?.()
        if (formData.password.length < 8) {
            toast({ title: 'Error', message: 'Password must be at least 8 characters', type: 'error' })
            return
        }
        if (!formData.username || !formData.email) {
            toast({ title: 'Error', message: 'Username and Email are required', type: 'error' })
            return
        }
        setLoading(true)
        try {
            const res = await apiFetch('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify(formData)
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast({ title: 'Success', message: 'Team member created successfully', type: 'success' })
            onSuccess()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" {...backdrop}>
            <div className="glass rounded-3xl border border-white/10 p-8 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2.5 bg-blue-500/15 rounded-2xl border border-blue-500/20">
                        <User className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-white">Add Team Member</h3>
                        <p className="text-xs text-slate-500">Create a new user in your workspace</p>
                    </div>
                </div>
                {/* not a login form: password managers are asked not to fill it with your own saved login */}
                <form className="space-y-3" autoComplete="off" onSubmit={handleCreate} data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other">
                    <input type="text" name="new-member-username" aria-label="Username" autoComplete="off" spellCheck={false} placeholder="Username" value={formData.username} onChange={field('username')} data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors" />
                    <input type="email" name="new-member-email" aria-label="Email" autoComplete="off" placeholder="Email" value={formData.email} onChange={field('email')} data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors" />
                    <div className="relative">
                        <input type={showPwd ? 'text' : 'password'} name="new-member-password" aria-label="Password" autoComplete="new-password" placeholder="Password (min 8 characters)" value={formData.password} onChange={field('password')} data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl pl-4 pr-11 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors" />
                        <button type="button" onClick={() => setShowPwd(s => !s)} aria-label={showPwd ? 'Hide password' : 'Show password'} title={showPwd ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">{showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
                    </div>
                    <div>
                        <select value={formData.role} onChange={field('role')} className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white outline-none transition-colors appearance-none">
                            {roleOptions.map(r => (
                                <option key={r.key} value={r.key}>{r.name}{r.custom ? ' (custom)' : ''}</option>
                            ))}
                        </select>
                        <p className="text-[11px] text-slate-500 mt-1.5 px-1">{roleOptions.find(r => r.key === formData.role)?.description}</p>
                    </div>
                    {formData.role !== 'admin' && (
                        <div>
                            <label htmlFor="new-ai" className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2 px-1"><Sparkles className="w-3 h-3 text-violet-300" /> KubeEZ AI</label>
                            <select id="new-ai" value={formData.aiAccess} onChange={field('aiAccess')} className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white outline-none transition-colors appearance-none">
                                {AI_LEVELS.map(l => <option key={l.key} value={l.key}>{l.name}</option>)}
                            </select>
                            <p className="text-[11px] text-slate-500 mt-1.5 px-1">{AI_LEVELS.find(l => l.key === formData.aiAccess)?.hint}</p>
                        </div>
                    )}

                    <div className="flex gap-3 pt-2">
                        <button type="button" onClick={onClose} className="flex-1 py-3 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-xs font-black uppercase tracking-wider text-slate-400 transition-all">Cancel</button>
                        <button type="submit" disabled={loading} className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl text-xs font-black uppercase tracking-wider text-white transition-all flex items-center justify-center gap-2">
                            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Create'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}

// ─── User Card ─────────────────────────────────────────────────────
const AI_BADGE = { ask: 'AI: ask', apply: 'AI: ask & apply' }

function AiAccess({ userItem, onRefresh }) {
    const { toast } = useToast()
    const [saving, setSaving] = useState(false)
    const fromRole = userItem.ai !== 'none' && (userItem.aiAccess || 'none') === 'none'   // a custom role that includes AI
    const change = async (level) => {
        setSaving(true)
        try {
            const res = await apiFetch(`/api/admin/users/${userItem.id}/ai-access`, { method: 'PUT', body: JSON.stringify({ aiAccess: level }) })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast({ title: 'AI access updated', message: data.message, type: 'success' })
            onRefresh()
        } catch (err) { toast({ title: 'Error', message: err.message, type: 'error' }) } finally { setSaving(false) }
    }
    return (
        <div className="mt-3 flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-violet-300 shrink-0" />
            <label className="text-[11px] text-slate-400 shrink-0" htmlFor={`ai-${userItem.id}`}>KubeEZ AI</label>
            <select id={`ai-${userItem.id}`} value={userItem.aiAccess || 'none'} disabled={saving} onChange={e => change(e.target.value)}
                title={AI_LEVELS.find(l => l.key === (userItem.aiAccess || 'none'))?.hint}
                className="flex-1 py-1.5 pl-2 pr-6 rounded-lg text-[11px] font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 outline-none disabled:opacity-50">
                {AI_LEVELS.map(l => <option key={l.key} value={l.key}>{l.key === 'none' && fromRole ? `From their role (${userItem.ai === 'apply' ? 'Ask & apply' : 'Ask AI'})` : l.name}</option>)}
            </select>
            {saving && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
        </div>
    )
}

function UserCard({ userItem, currentUser, onRefresh, roleOptions, onClusterAccess }) {
    const { toast } = useToast()
    const [menu, setMenu] = useState(false)
    const [deletingConfirm, setDeletingConfirm] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [changingRole, setChangingRole] = useState(false)
    const [showResetPwd, setShowResetPwd] = useState(false)

    const isSelf = userItem.id === currentUser?.id

    const timeSince = (isoDate) => {
        if (!isoDate) return 'Unknown'
        const seconds = Math.floor((Date.now() - new Date(isoDate)) / 1000)
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
        return new Date(isoDate).toLocaleDateString()
    }

    const handleRoleChange = async (newRole) => {
        if (newRole === userItem.role) return
        setChangingRole(true)
        try {
            const res = await apiFetch(`/api/admin/users/${userItem.id}/role`, {
                method: 'PUT',
                body: JSON.stringify({ role: newRole })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast({ title: 'Role Updated', message: `${userItem.username} is now ${roleOptions.find(r => r.key === newRole)?.name || newRole}`, type: 'success' })
            onRefresh()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setChangingRole(false)
        }
    }

    const handleDelete = async () => {
        setDeleting(true)
        try {
            const res = await apiFetch(`/api/admin/users/${userItem.id}`, {
                method: 'DELETE'
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast({ title: 'User Deleted', message: data.message, type: 'success' })
            onRefresh()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setDeleting(false)
            setDeletingConfirm(false)
        }
    }

    return (
        <>
            {showResetPwd && (
                <ResetPasswordModal
                    user={userItem}
                    onClose={() => setShowResetPwd(false)}
                    onSuccess={() => setShowResetPwd(false)}
                />
            )}
            <div className={`glass rounded-3xl border p-6 transition-all duration-300 relative ${
                isSelf ? 'border-blue-500/20 bg-blue-500/5' : 'border-white/5'
            }`}>
                {isSelf && (
                    <span className="absolute top-4 right-4 text-[9px] font-black uppercase tracking-widest text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
                        You
                    </span>
                )}

                <div className="flex items-start gap-4">
                    {/* Avatar */}
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-lg border shrink-0 ${
                        userItem.role === 'admin'
                            ? 'bg-amber-500/15 border-amber-500/20 text-amber-400'
                            : 'bg-white/5 border-white/10 text-slate-400'
                    }`}>
                        {userItem.username.charAt(0).toUpperCase()}
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            <span className="font-black text-white">{userItem.username}</span>
                            <RoleBadge role={userItem.role} name={userItem.roleName} />
                            {!!userItem.clusterAccess?.length && (
                                <span title="Has a different role on some clusters" className="inline-flex items-center gap-1 text-[10px] font-semibold text-sky-200 bg-sky-500/10 border border-sky-400/20 px-2 py-0.5 rounded-full">
                                    <Layers className="w-3 h-3" /> {userItem.clusterAccess.length} cluster rule{userItem.clusterAccess.length > 1 ? 's' : ''}
                                </span>
                            )}
                            {AI_BADGE[userItem.ai] && (
                                <span title={userItem.role === 'admin' ? 'Admins always have KubeEZ AI' : 'Can use KubeEZ AI'} className="inline-flex items-center gap-1 text-[10px] font-semibold text-violet-200 bg-violet-500/10 border border-violet-400/20 px-2 py-0.5 rounded-full">
                                    <Sparkles className="w-3 h-3" /> {AI_BADGE[userItem.ai]}
                                </span>
                            )}
                            {userItem.isOwner && (
                                <span title="Holds the plan and billing — other admins cannot change this account"
                                    className="text-[9px] font-black uppercase tracking-widest text-slate-300 bg-white/5 border border-white/10 px-2 py-0.5 rounded-full">Owner</span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold">
                            <Clock className="w-3 h-3" />
                            Joined {timeSince(userItem.createdAt)}
                        </div>
                        <div className="text-[10px] font-mono text-slate-600 mt-0.5">ID: {userItem.id.slice(0, 16)}...</div>
                    </div>
                </div>

                {/* Actions — the workspace owner's account can only be changed by the owner */}
                {!isSelf && userItem.isOwner && (
                    <p className="mt-5 pt-5 border-t border-white/5 text-[11px] text-slate-500">
                        Workspace owner — holds the plan and billing. Only the owner can change this account.
                    </p>
                )}
                {!isSelf && !userItem.isOwner && (
                    <div className="flex items-center gap-2 mt-5 pt-5 border-t border-white/5">
                        {/* Role selector */}
                        <div className="flex-1 relative">
                            <select
                                value={userItem.role}
                                onChange={e => handleRoleChange(e.target.value)}
                                disabled={changingRole}
                                className="w-full py-2.5 pl-3 pr-8 rounded-xl text-xs font-semibold bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 outline-none transition-all appearance-none cursor-pointer disabled:opacity-50"
                                aria-label="Role"
                            >
                                {roleOptions.map(r => (
                                    <option key={r.key} value={r.key}>{r.name}{r.custom ? ' (custom)' : ''}</option>
                                ))}
                            </select>
                            {changingRole && <Loader2 className="w-3 h-3 animate-spin absolute right-8 top-1/2 -translate-y-1/2 text-slate-400" />}
                        </div>

                        {/* Cluster access: a different role on some clusters (not for admins — they have everything) */}
                        {userItem.role !== 'admin' && (
                            <button onClick={() => onClusterAccess(userItem)}
                                className="py-2.5 px-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-400 hover:text-white transition-all"
                                title="Cluster access — a different role on some clusters">
                                <Layers className="w-3.5 h-3.5" />
                            </button>
                        )}

                        {/* Reset Password */}
                        <button
                            onClick={() => setShowResetPwd(true)}
                            className="py-2.5 px-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 text-slate-400 hover:text-white transition-all"
                            title="Reset Password"
                        >
                            <KeyRound className="w-3.5 h-3.5" />
                        </button>

                        {/* Delete */}
                        {!deletingConfirm ? (
                            <button
                                onClick={() => setDeletingConfirm(true)}
                                className="py-2.5 px-3 rounded-xl text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-all"
                                title="Delete user"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        ) : (
                            <div className="flex items-center gap-2">
                                <button onClick={() => setDeletingConfirm(false)} className="text-[10px] text-slate-500 hover:text-white font-bold uppercase tracking-wider px-2">
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-[10px] font-black uppercase tracking-wider flex items-center gap-1"
                                >
                                    {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                    Confirm
                                </button>
                            </div>
                        )}
                    </div>
                )}
                {!isSelf && !userItem.isOwner && userItem.role !== 'admin' && <AiAccess userItem={userItem} onRefresh={onRefresh} />}
            </div>
        </>
    )
}

// ─── Main Admin Users Page ────────────────────────────────────────
export default function AdminUsers() {
    const { user: currentUser } = useAuth()
    const { toast } = useToast()
    const [users, setUsers] = useState([])
    const [seats, setSeats] = useState({ used: 0, max: 1 })
    const [rbac, setRbac] = useState(null)
    const [rolesMeta, setRolesMeta] = useState(null)
    const [clusters, setClusters] = useState([])
    const [showMatrix, setShowMatrix] = useState(false)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [search, setSearch] = useState('')
    const [filterRole, setFilterRole] = useState('all')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [accessFor, setAccessFor] = useState(null)
    const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') === 'roles' ? 'roles' : 'members')
    const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'superadmin')

    const fetchUsers = useCallback(async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true)
        try {
            const res = await apiFetch('/api/admin/users')
            if (!res.ok) throw new Error('Failed to load users')
            const data = await res.json()
            setUsers(Array.isArray(data) ? data : (data.users || []))
            if (data.seats) setSeats(data.seats)
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [])
    const fetchRoles = useCallback(async () => {
        try {
            const [r, b, c] = await Promise.all([apiFetch('/api/roles'), apiFetch('/api/rbac'), apiFetch('/api/clusters/list')])
            if (r.ok) setRolesMeta(await r.json())
            if (b.ok) setRbac(await b.json())
            if (c.ok) { const list = await c.json(); setClusters(Array.isArray(list) ? list.map(x => ({ id: x.id, clusterName: x.clusterName || x.id, labels: x.labels || {} })) : []) }
        } catch { /* non-critical */ }
    }, [])
    const refreshAll = () => { fetchUsers(true); fetchRoles() }

    useEffect(() => { if (isAdmin) { fetchUsers(); fetchRoles() } }, [isAdmin])
    useEffect(() => { const p = new URLSearchParams(window.location.search); p.set('tab', tab); window.history.replaceState(null, '', `${window.location.pathname}?${p}`) }, [tab])

    // RBAC guard — only Org Admins / Super Admins may manage the team.
    if (!isAdmin) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
                <div className="p-5 bg-rose-500/10 border border-rose-500/20 rounded-3xl mb-6">
                    <Lock className="w-10 h-10 text-rose-400" />
                </div>
                <h1 className="text-2xl font-black text-white mb-2">Access Restricted</h1>
                <p className="text-slate-400 max-w-md mb-1">Team &amp; role management is available to workspace admins only.</p>
                <a href="/" className="mt-7 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold transition-all">Back to Dashboard</a>
            </div>
        )
    }

    // every role a member can have: built-in first, then the workspace's own
    const roleOptions = [
        ...(rolesMeta?.builtin || [{ key: 'admin', name: 'Org Admin' }, { key: 'operator', name: 'Operator' }, { key: 'viewer', name: 'Viewer' }])
            .map(b => ({ key: b.key, name: b.name, description: ROLE_META[b.key]?.desc || b.description })),
        ...(rolesMeta?.custom || []).map(r => ({ key: r.key, name: r.name, description: r.description, custom: true }))
    ]

    const exportReview = async () => {
        try {
            const r = await fetch('/api/admin/access-review?format=csv', { credentials: 'include' })
            if (!r.ok) throw new Error('Could not build the access review')
            const url = URL.createObjectURL(await r.blob())
            const a = document.createElement('a'); a.href = url; a.download = `kubeez-access-review-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            toast({ title: 'Access review downloaded', message: 'Who has what, on which cluster — keep it with your audit evidence.', type: 'success' })
        } catch (e) { toast({ title: 'Access review', message: e.message, type: 'error' }) }
    }

    const seatsFull = seats.used >= seats.max
    const filtered = users.filter(u => {
        const matchSearch = u.username.toLowerCase().includes(search.toLowerCase())
        const matchRole = filterRole === 'all' || (filterRole === 'custom' ? u.role.startsWith('custom:') : u.role === filterRole)
        return matchSearch && matchRole
    })
    const adminCount = users.filter(u => u.role === 'admin').length
    const builtinOthers = users.filter(u => u.role === 'operator' || u.role === 'viewer').length
    const customCount = users.filter(u => u.role.startsWith('custom:')).length
    const withRules = users.filter(u => u.clusterAccess?.length).length

    return (
        <div className="max-w-7xl mx-auto">
            {/* Header */}
            <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
                <PageTitle icon={Users} eyebrow="Workspace" title="Team & Roles"
                    description={<>Who is in the workspace, what each role may do, and where</>} />
                <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => setShowMatrix(true)} className="kz-btn-ghost !py-2"><Shield className="w-4 h-4" /> Who can do what?</button>
                    <button onClick={exportReview} className="kz-btn-ghost !py-2" title="CSV: every member, every cluster, what they may do"><Download className="w-4 h-4" /> Access review</button>
                    <button
                        onClick={() => seatsFull ? toast({ title: 'Seat limit reached', message: `Your plan allows ${seats.max} member(s). Upgrade to add more.`, type: 'error' }) : setShowCreateModal(true)}
                        className={seatsFull ? 'kz-btn-ghost !py-2 opacity-60' : 'kz-btn-primary !py-2'}
                        title={seatsFull ? 'Seat limit reached — upgrade your plan' : 'Invite a team member'}
                    >+ Invite user</button>
                    <button onClick={refreshAll} disabled={refreshing} className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl transition-all active:scale-95 text-slate-300" aria-label="Refresh">
                        <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="mb-7 inline-flex rounded-2xl border border-white/10 bg-black/25 p-1" role="tablist">
                {[['members', 'Members', Users], ['roles', 'Roles', ShieldCheck]].map(([k, label, Icon]) => (
                    <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                        className={`flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-semibold transition ${tab === k ? 'bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.08)]' : 'text-slate-400 hover:text-white'}`}>
                        <Icon className="w-4 h-4" /> {label}
                        {k === 'roles' && !!rolesMeta?.custom?.length && <span className="rounded-full bg-blue-500/20 px-1.5 text-[10px] text-blue-200">{rolesMeta.custom.length}</span>}
                    </button>
                ))}
            </div>

            {tab === 'roles' ? (
                rolesMeta ? <RolesPanel meta={rolesMeta} onChanged={refreshAll} /> : <div className="flex justify-center py-20"><Loader2 className="w-7 h-7 text-slate-500 animate-spin" /></div>
            ) : (<>
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                {[
                    { label: 'Seats used', value: <>{seats.used}<span className="text-lg text-slate-600">/{seats.max}</span></>, color: seatsFull ? 'text-amber-400' : 'text-white' },
                    { label: 'Admins', value: adminCount, color: 'text-amber-400' },
                    { label: 'Operators & viewers', value: builtinOthers, color: 'text-blue-300' },
                    { label: 'Custom roles · cluster rules', value: <>{customCount}<span className="text-lg text-slate-600"> · {withRules}</span></>, color: 'text-sky-300' },
                ].map(s => (
                    <div key={s.label} className="glass rounded-2xl border border-white/8 p-6">
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-1">{s.label}</p>
                        <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
                    </div>
                ))}
            </div>

            {/* Search & Filter */}
            <div className="flex flex-wrap items-center gap-4 mb-6">
                <div className="relative flex-1 min-w-[220px]">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                        type="search"
                        name="team-search"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Search by username..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full pl-11 pr-4 py-3 bg-black/35 border border-white/5 focus:border-blue-500/40 rounded-2xl text-sm text-white placeholder-slate-600 outline-none transition-colors"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {['all', 'admin', 'operator', 'viewer', 'custom'].map(role => (
                        <button key={role} onClick={() => setFilterRole(role)}
                            className={`px-4 py-2.5 rounded-2xl text-xs font-semibold capitalize transition-all ${filterRole === role ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-white/5'}`}>
                            {role}
                        </button>
                    ))}
                </div>
            </div>

            {/* Users Grid */}
            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                    <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
                    <p className="text-xs text-slate-500">Loading members…</p>
                </div>
            ) : filtered.length === 0 ? (
                <div className="glass rounded-3xl border border-white/5 p-16 text-center">
                    <div className="p-5 bg-white/5 rounded-2xl border border-white/5 inline-flex mb-5">
                        <UserX className="w-10 h-10 text-slate-600" />
                    </div>
                    <p className="text-slate-400 font-bold mb-1">{search ? `No members found for "${search}"` : 'Nobody with this role yet'}</p>
                    <p className="text-xs text-slate-600">{search ? 'Try a different search term' : 'Invite a member, or give someone this role'}</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {filtered.map(u => (
                        <UserCard key={u.id} userItem={u} currentUser={currentUser} roleOptions={roleOptions}
                            onClusterAccess={(m) => rolesMeta && !rolesMeta.allowed
                                ? toast({ title: 'Pro feature', message: 'Per-cluster access is part of Pro. On Free, everyone has their role on every cluster.', type: 'info' })
                                : setAccessFor(m)}
                            onRefresh={() => fetchUsers(true)} />
                    ))}
                </div>
            )}
            </>)}

            {showCreateModal && (
                <CreateUserModal roleOptions={roleOptions}
                    onClose={() => setShowCreateModal(false)}
                    onSuccess={() => { setShowCreateModal(false); fetchUsers(true) }}
                />
            )}
            {accessFor && (
                <ClusterAccessDialog member={accessFor} roleOptions={roleOptions} clusters={clusters}
                    onClose={() => setAccessFor(null)}
                    onSaved={() => { setAccessFor(null); fetchUsers(true); fetchRoles() }} />
            )}
            {showMatrix && rbac && (
                <PermissionsMatrixModal rbac={rbac} onClose={() => setShowMatrix(false)} />
            )}
        </div>
    )
}

// ─── Permissions Matrix (transparency) ────────────────────────────
function PermissionsMatrixModal({ rbac, onClose }) {
    const backdrop = useBackdropClose(onClose)
    const builtin = ['admin', 'operator', 'viewer'].map(r => ({ key: r, name: ROLE_META[r].label, has: (k, item) => item.roles.includes(r) }))
    const custom = (rbac.customRoles || []).map(c => ({ key: c.key, name: c.name, has: (k) => c.permissions.includes(k), custom: true }))
    const cols = [...builtin, ...custom]
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" {...backdrop}>
            <div className="glass rounded-3xl border border-white/10 w-full max-w-5xl max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-7 pt-7 pb-4 border-b border-white/5">
                    <div className="flex items-center gap-3">
                        <Shield className="w-5 h-5 text-blue-400" />
                        <div>
                            <h3 className="text-lg font-black text-white">Who Can Do What</h3>
                            <p className="text-xs text-slate-500 mt-0.5">What each role may do in your workspace. Cluster rules can change it on some clusters (see Members → Cluster access).</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors" aria-label="Close">
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>
                <div className="overflow-auto px-7 py-4">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-slate-500 text-[10px] uppercase tracking-widest">
                                <th className="text-left font-black py-2 min-w-[220px]">Capability</th>
                                {cols.map(c => <th key={c.key} className={`text-center font-black py-2 px-2 min-w-[84px] ${c.custom ? 'text-sky-300/90' : ''}`}>{c.name}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {rbac.matrix.map(group => (
                                <Fragment key={group.group}>
                                    <tr>
                                        <td colSpan={cols.length + 1} className="pt-4 pb-1 text-[10px] font-black uppercase tracking-widest text-blue-400">{group.group}</td>
                                    </tr>
                                    {group.items.map(item => (
                                        <tr key={item.key} className="border-t border-white/5">
                                            <td className="py-2.5 text-slate-300">{item.label}</td>
                                            {cols.map(c => (
                                                <td key={c.key} className="text-center">
                                                    {c.has(item.key, item)
                                                        ? <Check className="w-4 h-4 text-emerald-400 mx-auto" />
                                                        : <X className="w-3.5 h-3.5 text-slate-700 mx-auto" />}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}
