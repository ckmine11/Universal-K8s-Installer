import { useState, useEffect, useCallback } from 'react'
import { useAuth, apiFetch } from '../context/AuthContext'
import { useToast } from '../components/ToastProvider'
import {
    Users, Shield, User, Trash2, Crown, RefreshCw, Loader2,
    ChevronRight, Lock, AlertTriangle, Check, Clock,
    KeyRound, Search, UserCheck, UserX, MoreVertical
} from 'lucide-react'

// ─── Role Badge ───────────────────────────────────────────────────
function RoleBadge({ role }) {
    const styles = {
        admin: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
        user: 'text-slate-400 bg-white/5 border-white/10'
    }
    return (
        <span className={`flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-lg border ${styles[role] || styles.user}`}>
            {role === 'admin' ? <Crown className="w-3 h-3" /> : <User className="w-3 h-3" />}
            {role}
        </span>
    )
}

// ─── Reset Password Modal ─────────────────────────────────────────
function ResetPasswordModal({ user, onClose, onSuccess }) {
    const { toast } = useToast()
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)

    const handleReset = async () => {
        if (password.length < 6) {
            toast({ title: 'Error', message: 'Password must be at least 6 characters', type: 'error' })
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

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
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
                    <input
                        type="password"
                        placeholder="New password (min 6 chars)"
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
    )
}

// ─── Create User Modal ─────────────────────────────────────────────
function CreateUserModal({ onClose, onSuccess }) {
    const { toast } = useToast()
    const [formData, setFormData] = useState({ username: '', email: '', password: '', role: 'user' })
    const [loading, setLoading] = useState(false)

    const handleCreate = async () => {
        if (formData.password.length < 6) {
            toast({ title: 'Error', message: 'Password must be at least 6 characters', type: 'error' })
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
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
                <div className="space-y-3">
                    <input type="text" placeholder="Username" value={formData.username} onChange={e => setFormData({...formData, username: e.target.value})} className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors" />
                    <input type="email" placeholder="Email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors" />
                    <input type="password" placeholder="Password (min 6 chars)" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors" />
                    <select value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})} className="w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white outline-none transition-colors appearance-none">
                        <option value="user" className="bg-slate-950">Tenant User</option>
                        <option value="admin" className="bg-slate-950">Tenant Admin</option>
                    </select>
                    
                    <div className="flex gap-3 pt-2">
                        <button onClick={onClose} className="flex-1 py-3 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-xs font-black uppercase tracking-wider text-slate-400 transition-all">Cancel</button>
                        <button onClick={handleCreate} disabled={loading} className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl text-xs font-black uppercase tracking-wider text-white transition-all flex items-center justify-center gap-2">
                            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Create'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── User Card ─────────────────────────────────────────────────────
function UserCard({ userItem, currentUser, onRefresh }) {
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

    const handleRoleToggle = async () => {
        setMenu(false)
        setChangingRole(true)
        const newRole = userItem.role === 'admin' ? 'user' : 'admin'
        try {
            const res = await apiFetch(`/api/admin/users/${userItem.id}/role`, {
                method: 'PUT',
                body: JSON.stringify({ role: newRole })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error)
            toast({ title: 'Role Updated', message: `${userItem.username} is now ${newRole}`, type: 'success' })
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
                            <RoleBadge role={userItem.role} />
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold">
                            <Clock className="w-3 h-3" />
                            Joined {timeSince(userItem.createdAt)}
                        </div>
                        <div className="text-[10px] font-mono text-slate-600 mt-0.5">ID: {userItem.id.slice(0, 16)}...</div>
                    </div>
                </div>

                {/* Actions */}
                {!isSelf && (
                    <div className="flex items-center gap-2 mt-5 pt-5 border-t border-white/5">
                        {/* Role Toggle */}
                        <button
                            onClick={handleRoleToggle}
                            disabled={changingRole}
                            className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 ${
                                userItem.role === 'admin'
                                    ? 'bg-slate-500/10 hover:bg-slate-500/20 border border-slate-500/20 text-slate-400'
                                    : 'bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-400'
                            }`}
                        >
                            {changingRole ? <Loader2 className="w-3 h-3 animate-spin" /> : <Crown className="w-3 h-3" />}
                            {userItem.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                        </button>

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
            </div>
        </>
    )
}

// ─── Main Admin Users Page ────────────────────────────────────────
export default function AdminUsers() {
    const { user: currentUser } = useAuth()
    const { toast } = useToast()
    const [users, setUsers] = useState([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [search, setSearch] = useState('')
    const [filterRole, setFilterRole] = useState('all')
    const [showCreateModal, setShowCreateModal] = useState(false)

    const fetchUsers = useCallback(async (isRefresh = false) => {
        if (isRefresh) setRefreshing(true)
        try {
            const res = await apiFetch('/api/admin/users')
            if (!res.ok) throw new Error('Failed to load users')
            const data = await res.json()
            setUsers(data)
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [])

    useEffect(() => { fetchUsers() }, [fetchUsers])

    const filtered = users.filter(u => {
        const matchSearch = u.username.toLowerCase().includes(search.toLowerCase())
        const matchRole = filterRole === 'all' || u.role === filterRole
        return matchSearch && matchRole
    })

    const adminCount = users.filter(u => u.role === 'admin').length
    const userCount = users.filter(u => u.role === 'user').length

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <Users className="w-6 h-6 text-amber-400" />
                        <h1 className="text-2xl font-black text-white tracking-tight">Workspace Team</h1>
                    </div>
                    <p className="text-slate-400 text-sm mt-1">Manage team members, roles, and access in your workspace</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-black uppercase tracking-widest text-[10px] rounded-xl transition-all shadow-lg shadow-blue-500/20"
                    >
                        + Invite User
                    </button>
                    <button
                        onClick={() => fetchUsers(true)}
                        disabled={refreshing}
                        className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl transition-all active:scale-95 text-slate-300"
                    >
                        <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mb-8">
                {[
                    { label: 'Total Users', value: users.length, color: 'text-white' },
                    { label: 'Admins', value: adminCount, color: 'text-amber-400' },
                    { label: 'Members', value: userCount, color: 'text-blue-400' },
                ].map(s => (
                    <div key={s.label} className="glass rounded-2xl border border-white/8 p-6">
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest mb-1">{s.label}</p>
                        <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
                    </div>
                ))}
            </div>

            {/* Search & Filter */}
            <div className="flex items-center gap-4 mb-6">
                <div className="relative flex-1">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                        type="text"
                        placeholder="Search by username..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full pl-11 pr-4 py-3 bg-black/35 border border-white/5 focus:border-blue-500/40 rounded-2xl text-sm text-white placeholder-slate-600 outline-none transition-colors"
                    />
                </div>
                <div className="flex items-center gap-2">
                    {['all', 'admin', 'user'].map(role => (
                        <button
                            key={role}
                            onClick={() => setFilterRole(role)}
                            className={`px-4 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${
                                filterRole === role
                                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20'
                                    : 'bg-white/5 text-slate-400 hover:bg-white/10 border border-white/5'
                            }`}
                        >
                            {role}
                        </button>
                    ))}
                </div>
            </div>

            {/* Users Grid */}
            {loading ? (
                <div className="flex flex-col items-center justify-center py-20 gap-4">
                    <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
                    <p className="text-xs text-slate-500 uppercase font-black tracking-widest">Loading users...</p>
                </div>
            ) : filtered.length === 0 ? (
                <div className="glass rounded-3xl border border-white/5 p-16 text-center">
                    <div className="p-5 bg-white/5 rounded-2xl border border-white/5 inline-flex mb-5">
                        <UserX className="w-10 h-10 text-slate-600" />
                    </div>
                    <p className="text-slate-400 font-bold mb-1">
                        {search ? `No users found for "${search}"` : 'No users registered yet'}
                    </p>
                    <p className="text-xs text-slate-600">
                        {search ? 'Try a different search term' : 'Users will appear here after registration'}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {filtered.map(u => (
                        <UserCard
                            key={u.id}
                            userItem={u}
                            currentUser={currentUser}
                            onRefresh={() => fetchUsers(true)}
                        />
                    ))}
                </div>
            )}

            {showCreateModal && (
                <CreateUserModal
                    onClose={() => setShowCreateModal(false)}
                    onSuccess={() => {
                        setShowCreateModal(false)
                        fetchUsers(true)
                    }}
                />
            )}
        </div>
    )
}
