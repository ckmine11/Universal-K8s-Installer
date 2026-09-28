import { useState, useEffect } from 'react'
import { useToast } from './ToastProvider'
import { apiFetch } from '../context/AuthContext'
import { Loader2, Users, Shield, AlertTriangle, CheckCircle2, ShieldOff, Edit3, X, CreditCard, ExternalLink, Building2, Trash2 } from 'lucide-react'

const EMPTY_BILLING = { amount: '', cycle: 'monthly', currency: 'USD', paymentLink: '', notes: '' }

// Human-readable role label + color (mirrors backend RBAC roles)
const ROLE_META = {
    superadmin: { label: 'Super Admin', cls: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
    admin:      { label: 'Org Admin',   cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
    operator:   { label: 'Operator',    cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
    viewer:     { label: 'Viewer',      cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
}
function RoleBadge({ role }) {
    const m = ROLE_META[role] || { label: role || 'Member', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' }
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider border ${m.cls}`}>{m.label}</span>
}
function StatusBadge({ suspended }) {
    return suspended
        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/20"><ShieldOff className="w-3 h-3" /> Suspended</span>
        : null
}

export default function TenantManager() {
    const { toast } = useToast()
    const [tenants, setTenants] = useState([])
    const [loading, setLoading] = useState(true)

    // Edit modal state
    const [editingTenant, setEditingTenant] = useState(null)
    const [editForm, setEditForm] = useState({ plan: '', maxClusters: 1, maxNodes: 2, maxMembers: 1, billing: { ...EMPTY_BILLING } })
    const [saving, setSaving] = useState(false)

    // Plan presets — selecting a plan auto-fills the standard quotas
    // (Unlimited = 9999, NOT 0 — the backend treats 0 as "block everything")
    const PLAN_PRESETS = {
        FREE:       { maxClusters: 1,    maxNodes: 2,    maxMembers: 1 },
        PRO:        { maxClusters: 10,   maxNodes: 50,   maxMembers: 5 },
        ENTERPRISE: { maxClusters: 9999, maxNodes: 9999, maxMembers: 9999 }
    }

    const fetchTenants = async () => {
        setLoading(true)
        try {
            const res = await apiFetch('/api/superadmin/users')
            const data = await res.ok ? await res.json() : null
            if (data && Array.isArray(data)) {
                setTenants(data)
            } else {
                throw new Error('Failed to load tenants data')
            }
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchTenants()
    }, [])

    const handleStatusToggle = async (tenant) => {
        const confirmMsg = tenant.isSuspended 
            ? `Are you sure you want to activate ${tenant.username}'s account?`
            : `Are you sure you want to suspend ${tenant.username}'s account? They will lose access immediately.`
            
        if (!window.confirm(confirmMsg)) return

        try {
            const res = await apiFetch(`/api/superadmin/users/${tenant.id}/status`, {
                method: 'PUT',
                body: JSON.stringify({ isSuspended: !tenant.isSuspended })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to update status')
            
            toast({ title: 'Success', message: data.message, type: 'success' })
            fetchTenants()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        }
    }

    const openEditModal = (tenant) => {
        setEditingTenant(tenant)
        setEditForm({
            plan: tenant.subscription?.plan || 'FREE',
            maxClusters: tenant.subscription?.maxClusters ?? 1,
            maxNodes: tenant.subscription?.maxNodes ?? 2,
            maxMembers: tenant.subscription?.maxMembers ?? 1,
            billing: { ...EMPTY_BILLING, ...(tenant.subscription?.billing || {}) }
        })
    }

    // When the plan changes, snap quotas to that plan's preset (editable after)
    const handlePlanChange = (plan) => {
        const preset = PLAN_PRESETS[plan] || {}
        setEditForm(f => ({ ...f, plan, ...preset }))
    }

    const handleSaveLimits = async () => {
        setSaving(true)
        try {
            const res = await apiFetch(`/api/superadmin/users/${editingTenant.id}/limits`, {
                method: 'PUT',
                body: JSON.stringify(editForm)
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to update limits')
            
            toast({ title: 'Success', message: 'Tenant limits updated successfully', type: 'success' })
            setEditingTenant(null)
            fetchTenants()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async (tenant) => {
        if (!window.confirm(`Permanently DELETE ${tenant.username}? This removes the account and cannot be undone. Their clusters/data are not auto-deleted.`)) return
        try {
            const res = await apiFetch(`/api/superadmin/users/${tenant.id}`, { method: 'DELETE' })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to delete user')
            toast({ title: 'Deleted', message: data.message, type: 'success' })
            fetchTenants()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        }
    }

    const handleRoleToggle = async (tenant) => {
        const newRole = tenant.role === 'superadmin' ? 'admin' : 'superadmin'
        if (!window.confirm(`Are you sure you want to make ${tenant.username} a ${newRole}?`)) return

        try {
            const res = await apiFetch(`/api/superadmin/users/${tenant.id}/role`, {
                method: 'PUT',
                body: JSON.stringify({ role: newRole })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to update role')
            
            toast({ title: 'Success', message: data.message, type: 'success' })
            fetchTenants()
        } catch (err) {
            toast({ title: 'Error', message: err.message, type: 'error' })
        }
    }

    // Group users by workspace (orgId): owner = the account that holds the
    // subscription (plan !== MEMBER); everyone else is a team member.
    const groups = {}
    tenants.forEach(t => { (groups[t.orgId] = groups[t.orgId] || []).push(t) })
    const workspaces = Object.entries(groups).map(([orgId, members]) => {
        const owner = members.find(m => String(m.subscription?.plan || 'FREE').toUpperCase() !== 'MEMBER') || members[0]
        const team = members.filter(m => m.id !== owner.id)
        return { orgId, owner, members: team }
    }).sort((a, b) => b.members.length - a.members.length) // workspaces with teams first

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
                <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                <p className="text-xs tracking-widest text-slate-500 uppercase font-black">Loading Global Tenants...</p>
            </div>
        )
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            {/* Stats Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center justify-between mb-4">
                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">Total Tenants</span>
                        <Users className="w-4 h-4 text-blue-500" />
                    </div>
                    <h2 className="text-3xl font-black text-white">{tenants.length}</h2>
                </div>
                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center justify-between mb-4">
                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">Workspaces</span>
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    </div>
                    <h2 className="text-3xl font-black text-white">{workspaces.length}</h2>
                </div>
                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center justify-between mb-4">
                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">Super Admins</span>
                        <Shield className="w-4 h-4 text-purple-500" />
                    </div>
                    <h2 className="text-3xl font-black text-white">{tenants.filter(t => t.role === 'superadmin').length}</h2>
                </div>
            </div>

            {/* Workspaces — grouped by org, owner + their team members */}
            <div className="space-y-5">
                <h3 className="text-lg font-black uppercase tracking-wider text-slate-200">Workspaces & Members</h3>
                {workspaces.map(ws => (
                    <div key={ws.orgId} className="glass rounded-3xl border border-white/5 overflow-hidden">
                        {/* Owner header */}
                        <div className="p-5 border-b border-white/5 bg-white/[0.02]">
                            <div className="flex items-start justify-between gap-4 flex-wrap">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-black shrink-0">
                                        {ws.owner.username?.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-black text-white">{ws.owner.username}</span>
                                            <RoleBadge role={ws.owner.role} />
                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-400 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
                                                <Building2 className="w-3 h-3" /> Owner
                                            </span>
                                            {ws.owner.isSuspended && <StatusBadge suspended />}
                                        </div>
                                        <div className="text-xs text-slate-500">{ws.owner.email || 'No email'}</div>
                                        <div className="text-[10px] font-mono text-slate-600 mt-0.5 select-all">org: {ws.orgId}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="text-right">
                                        <div className={`font-black text-xs ${ws.owner.subscription?.plan === 'ENTERPRISE' ? 'text-purple-400' : ws.owner.subscription?.plan === 'PRO' ? 'text-blue-400' : 'text-slate-400'}`}>
                                            {ws.owner.subscription?.plan || 'FREE'}
                                        </div>
                                        <div className="text-[10px] text-slate-500">
                                            {ws.owner.subscription?.maxClusters} Clusters • {ws.owner.subscription?.maxNodes} Nodes
                                        </div>
                                        <div className="text-[10px] text-slate-500">
                                            Seats: <span className="text-slate-300 font-bold">{ws.members.length}/{ws.owner.subscription?.maxMembers ?? 1}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => openEditModal(ws.owner)} title="Edit Plan & Quotas"
                                            className="p-2 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 rounded-lg transition-colors">
                                            <Edit3 className="w-4 h-4" />
                                        </button>
                                        <button onClick={() => handleStatusToggle(ws.owner)} title={ws.owner.isSuspended ? 'Activate' : 'Suspend'}
                                            className={`p-2 border rounded-lg transition-colors ${ws.owner.isSuspended ? 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 hover:bg-red-500/20 border-red-500/20 text-red-400'}`}>
                                            {ws.owner.isSuspended ? <CheckCircle2 className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                                        </button>
                                        {ws.owner.role !== 'superadmin' && (
                                            <button onClick={() => handleDelete(ws.owner)} title="Delete User"
                                                className="p-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg transition-colors">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                            {/* Enterprise billing line */}
                            {ws.owner.subscription?.billing?.amount && (
                                <div className="mt-2 flex items-center gap-2 flex-wrap pl-14">
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded px-1.5 py-0.5">
                                        <CreditCard className="w-3 h-3" />
                                        {({ USD: '$', EUR: '€', INR: '₹', GBP: '£' }[ws.owner.subscription.billing.currency] || '$')}{ws.owner.subscription.billing.amount}/{ws.owner.subscription.billing.cycle === 'annual' ? 'yr' : 'mo'}
                                    </span>
                                    {ws.owner.subscription.renewsAt && (
                                        <span className="text-[10px] text-slate-500">renews {new Date(ws.owner.subscription.renewsAt).toLocaleDateString()}</span>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Team members */}
                        {ws.members.length === 0 ? (
                            <div className="px-5 py-3 text-[11px] text-slate-600">No team members in this workspace.</div>
                        ) : (
                            <div className="divide-y divide-white/5">
                                <div className="px-5 pt-3 pb-1 text-[10px] font-black uppercase tracking-widest text-slate-600">Team Members ({ws.members.length})</div>
                                {ws.members.map(m => (
                                    <div key={m.id} className="px-5 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.02]">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-300 font-bold text-xs shrink-0">
                                                {m.username?.charAt(0).toUpperCase()}
                                            </div>
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-bold text-white text-sm">{m.username}</span>
                                                    <RoleBadge role={m.role} />
                                                    {m.isSuspended && <StatusBadge suspended />}
                                                </div>
                                                <div className="text-[11px] text-slate-500">{m.email || 'No email'}</div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => handleStatusToggle(m)} title={m.isSuspended ? 'Activate' : 'Suspend'}
                                                className={`p-2 border rounded-lg transition-colors ${m.isSuspended ? 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 hover:bg-red-500/20 border-red-500/20 text-red-400'}`}>
                                                {m.isSuspended ? <CheckCircle2 className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                                            </button>
                                            <button onClick={() => handleDelete(m)} title="Delete User"
                                                className="p-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg transition-colors">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {/* Edit Limits Modal */}
            {editingTenant && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
                    <div className="glass rounded-3xl w-full max-w-md border border-white/10 overflow-hidden shadow-2xl">
                        <div className="flex items-center justify-between p-6 border-b border-white/5">
                            <h3 className="text-lg font-black text-white">Edit Limits for {editingTenant.username}</h3>
                            <button onClick={() => setEditingTenant(null)} className="text-slate-400 hover:text-white transition-colors">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-6 space-y-6">
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Subscription Plan</label>
                                <select
                                    value={editForm.plan}
                                    onChange={(e) => handlePlanChange(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-blue-500"
                                >
                                    <option value="FREE">FREE</option>
                                    <option value="PRO">PRO</option>
                                    <option value="ENTERPRISE">ENTERPRISE (Custom)</option>
                                </select>
                                <p className="text-[10px] text-slate-500 mt-1.5">Selecting a plan fills its standard quotas — adjust below for custom Enterprise deals.</p>
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Clusters</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={editForm.maxClusters}
                                        onChange={(e) => setEditForm({...editForm, maxClusters: parseInt(e.target.value) || 0})}
                                        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-white outline-none focus:border-blue-500 font-mono"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Nodes</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={editForm.maxNodes}
                                        onChange={(e) => setEditForm({...editForm, maxNodes: parseInt(e.target.value) || 0})}
                                        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-white outline-none focus:border-blue-500 font-mono"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Members</label>
                                    <input
                                        type="number"
                                        min="1"
                                        value={editForm.maxMembers}
                                        onChange={(e) => setEditForm({...editForm, maxMembers: parseInt(e.target.value) || 0})}
                                        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-white outline-none focus:border-blue-500 font-mono"
                                    />
                                </div>
                            </div>
                            <p className="text-[10px] text-slate-500">Use <span className="text-slate-300 font-mono">9999</span> for "Unlimited" (Enterprise). Do not use 0 — it blocks the resource.</p>

                            {/* Enterprise Billing — negotiated deal record */}
                            {editForm.plan === 'ENTERPRISE' && (
                                <div className="rounded-2xl border border-purple-500/20 bg-purple-500/[0.03] p-4 space-y-4">
                                    <div className="flex items-center gap-2">
                                        <Building2 className="w-4 h-4 text-purple-400" />
                                        <span className="text-xs font-black uppercase tracking-wider text-purple-300">Enterprise Billing</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Amount</label>
                                            <div className="flex items-center gap-2">
                                                <select
                                                    value={editForm.billing.currency}
                                                    onChange={(e) => setEditForm(f => ({ ...f, billing: { ...f.billing, currency: e.target.value } }))}
                                                    className="bg-black/40 border border-white/10 rounded-xl px-2 py-3 text-white outline-none focus:border-purple-500 text-xs"
                                                >
                                                    <option value="USD">$</option>
                                                    <option value="EUR">€</option>
                                                    <option value="INR">₹</option>
                                                    <option value="GBP">£</option>
                                                </select>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    placeholder="499"
                                                    value={editForm.billing.amount}
                                                    onChange={(e) => setEditForm(f => ({ ...f, billing: { ...f.billing, amount: e.target.value } }))}
                                                    className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-white outline-none focus:border-purple-500 font-mono"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Billing Cycle</label>
                                            <select
                                                value={editForm.billing.cycle}
                                                onChange={(e) => setEditForm(f => ({ ...f, billing: { ...f.billing, cycle: e.target.value } }))}
                                                className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-white outline-none focus:border-purple-500"
                                            >
                                                <option value="monthly">Monthly</option>
                                                <option value="annual">Annual</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Stripe Payment / Invoice Link</label>
                                        <input
                                            type="url"
                                            placeholder="https://invoice.stripe.com/..."
                                            value={editForm.billing.paymentLink}
                                            onChange={(e) => setEditForm(f => ({ ...f, billing: { ...f.billing, paymentLink: e.target.value } }))}
                                            className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-white outline-none focus:border-purple-500 text-xs font-mono"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Contract Notes</label>
                                        <textarea
                                            rows="2"
                                            placeholder="SLA tier, PO number, contact person, contract term..."
                                            value={editForm.billing.notes}
                                            onChange={(e) => setEditForm(f => ({ ...f, billing: { ...f.billing, notes: e.target.value } }))}
                                            className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-3 text-white outline-none focus:border-purple-500 text-xs resize-none"
                                        />
                                    </div>
                                    <p className="text-[10px] text-slate-500 leading-relaxed">
                                        Negotiate the deal → create a Stripe Payment Link / Invoice in the Stripe Dashboard → paste it here → Save.
                                        Renewal auto-sets to <span className="text-slate-300 font-mono">{editForm.billing.cycle === 'annual' ? '+365 days' : '+30 days'}</span> from now.
                                    </p>
                                </div>
                            )}
                        </div>
                        <div className="p-6 border-t border-white/5 flex gap-3">
                            <button 
                                onClick={() => setEditingTenant(null)}
                                className="flex-1 py-3 px-4 rounded-xl border border-white/10 text-white font-bold uppercase text-xs tracking-wider hover:bg-white/5 transition-colors"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={handleSaveLimits}
                                disabled={saving}
                                className="flex-1 py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold uppercase text-xs tracking-wider transition-colors flex items-center justify-center gap-2"
                            >
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Changes'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
