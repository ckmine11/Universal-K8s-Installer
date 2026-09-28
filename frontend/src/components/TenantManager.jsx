import { useState, useEffect } from 'react'
import { useToast } from './ToastProvider'
import { apiFetch } from '../context/AuthContext'
import { Loader2, Users, Shield, AlertTriangle, CheckCircle2, ShieldOff, Edit3, X, CreditCard, ExternalLink, Building2 } from 'lucide-react'

const EMPTY_BILLING = { amount: '', cycle: 'monthly', currency: 'USD', paymentLink: '', notes: '' }

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
                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">Active Workspaces</span>
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    </div>
                    <h2 className="text-3xl font-black text-white">{tenants.filter(t => !t.isSuspended).length}</h2>
                </div>
                <div className="glass rounded-3xl p-6 border border-white/5">
                    <div className="flex items-center justify-between mb-4">
                        <span className="text-xs font-black uppercase text-slate-500 tracking-wider">Super Admins</span>
                        <Shield className="w-4 h-4 text-purple-500" />
                    </div>
                    <h2 className="text-3xl font-black text-white">{tenants.filter(t => t.role === 'superadmin').length}</h2>
                </div>
            </div>

            {/* Tenants Table */}
            <div className="glass rounded-3xl border border-white/5 overflow-hidden">
                <div className="p-6 border-b border-white/5 flex items-center justify-between">
                    <h3 className="text-lg font-black uppercase tracking-wider text-slate-200">Registered Users</h3>
                </div>
                
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-300">
                        <thead className="bg-black/20 text-slate-500 border-b border-white/5 text-[10px] font-black uppercase tracking-widest">
                            <tr>
                                <th className="px-6 py-4">User</th>
                                <th className="px-6 py-4">Workspace ID</th>
                                <th className="px-6 py-4">Plan & Quotas</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4">Role</th>
                                <th className="px-6 py-4 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {tenants.map(tenant => (
                                <tr key={tenant.id} className="hover:bg-white/[0.02] transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="font-bold text-white">{tenant.username}</div>
                                        <div className="text-xs text-slate-500">{tenant.email || 'No email'}</div>
                                    </td>
                                    <td className="px-6 py-4 font-mono text-[10px] text-slate-400 select-all">
                                        {tenant.orgId}
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className={`font-black text-xs mb-1 ${tenant.subscription?.plan === 'ENTERPRISE' ? 'text-purple-400' : 'text-blue-400'}`}>{tenant.subscription?.plan || 'FREE'}</div>
                                        <div className="text-[10px] text-slate-400">
                                            {tenant.subscription?.maxClusters} Clusters • {tenant.subscription?.maxNodes} Nodes • {tenant.subscription?.maxMembers ?? 1} Members
                                        </div>
                                        {tenant.subscription?.billing?.amount && (
                                            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded px-1.5 py-0.5">
                                                    <CreditCard className="w-3 h-3" />
                                                    {({ USD: '$', EUR: '€', INR: '₹', GBP: '£' }[tenant.subscription.billing.currency] || '$')}{tenant.subscription.billing.amount}/{tenant.subscription.billing.cycle === 'annual' ? 'yr' : 'mo'}
                                                </span>
                                                {tenant.subscription.billing.paymentLink && (
                                                    <a href={tenant.subscription.billing.paymentLink} target="_blank" rel="noopener noreferrer"
                                                        className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-400 hover:text-blue-300">
                                                        <ExternalLink className="w-3 h-3" /> Invoice
                                                    </a>
                                                )}
                                                {tenant.subscription.renewsAt && (
                                                    <span className="text-[10px] text-slate-500">renews {new Date(tenant.subscription.renewsAt).toLocaleDateString()}</span>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-6 py-4">
                                        {tenant.isSuspended ? (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/20">
                                                <ShieldOff className="w-3 h-3" /> Suspended
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                                <CheckCircle2 className="w-3 h-3" /> Active
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4">
                                        <button 
                                            onClick={() => handleRoleToggle(tenant)}
                                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border transition-all ${
                                                tenant.role === 'superadmin' 
                                                ? 'bg-purple-500/10 text-purple-400 border-purple-500/30 hover:border-purple-500/60' 
                                                : 'bg-white/5 text-slate-400 border-white/10 hover:border-white/20 hover:text-white'
                                            }`}
                                        >
                                            {tenant.role === 'superadmin' ? 'Super Admin' : 'Admin'}
                                        </button>
                                    </td>
                                    <td className="px-6 py-4 text-right space-x-2 flex justify-end">
                                        <button 
                                            onClick={() => openEditModal(tenant)}
                                            className="p-2 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 text-blue-400 rounded-lg transition-colors"
                                            title="Edit Quotas"
                                        >
                                            <Edit3 className="w-4 h-4" />
                                        </button>
                                        <button 
                                            onClick={() => handleStatusToggle(tenant)}
                                            className={`p-2 border rounded-lg transition-colors ${
                                                tenant.isSuspended 
                                                ? 'bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/20 text-emerald-400'
                                                : 'bg-red-500/10 hover:bg-red-500/20 border-red-500/20 text-red-400'
                                            }`}
                                            title={tenant.isSuspended ? "Activate User" : "Suspend User"}
                                        >
                                            {tenant.isSuspended ? <CheckCircle2 className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
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
