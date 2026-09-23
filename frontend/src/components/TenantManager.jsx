import { useState, useEffect } from 'react'
import { useToast } from './ToastProvider'
import { Loader2, Users, Shield, AlertTriangle, CheckCircle2, ShieldOff, Edit3, X } from 'lucide-react'

export default function TenantManager() {
    const { toast } = useToast()
    const [tenants, setTenants] = useState([])
    const [loading, setLoading] = useState(true)

    // Edit modal state
    const [editingTenant, setEditingTenant] = useState(null)
    const [editForm, setEditForm] = useState({ plan: '', maxClusters: 1, maxNodes: 3 })
    const [saving, setSaving] = useState(false)

    const fetchTenants = async () => {
        setLoading(true)
        try {
            const token = localStorage.getItem('token')
            const res = await fetch('/api/superadmin/users', {
                headers: { 'Authorization': `Bearer ${token}` }
            })
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
            const token = localStorage.getItem('token')
            const res = await fetch(`/api/superadmin/users/${tenant.id}/status`, {
                method: 'PUT',
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
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
            maxClusters: tenant.subscription?.maxClusters || 0,
            maxNodes: tenant.subscription?.maxNodes || 0
        })
    }

    const handleSaveLimits = async () => {
        setSaving(true)
        try {
            const token = localStorage.getItem('token')
            const res = await fetch(`/api/superadmin/users/${editingTenant.id}/limits`, {
                method: 'PUT',
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
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
            const token = localStorage.getItem('token')
            const res = await fetch(`/api/superadmin/users/${tenant.id}/role`, {
                method: 'PUT',
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
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
                                        <div className="font-black text-blue-400 text-xs mb-1">{tenant.subscription?.plan || 'FREE'}</div>
                                        <div className="text-[10px] text-slate-400">
                                            {tenant.subscription?.maxClusters} Clusters • {tenant.subscription?.maxNodes} Nodes
                                        </div>
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
                                    onChange={(e) => setEditForm({...editForm, plan: e.target.value})}
                                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-blue-500"
                                >
                                    <option value="FREE">FREE</option>
                                    <option value="PRO">PRO</option>
                                    <option value="ENTERPRISE">ENTERPRISE</option>
                                </select>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Max Clusters</label>
                                    <input 
                                        type="number"
                                        min="0"
                                        value={editForm.maxClusters}
                                        onChange={(e) => setEditForm({...editForm, maxClusters: parseInt(e.target.value) || 0})}
                                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-blue-500 font-mono"
                                    />
                                    <p className="text-[10px] text-slate-500 mt-1">0 = Unlimited</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Max Nodes</label>
                                    <input 
                                        type="number"
                                        min="0"
                                        value={editForm.maxNodes}
                                        onChange={(e) => setEditForm({...editForm, maxNodes: parseInt(e.target.value) || 0})}
                                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-blue-500 font-mono"
                                    />
                                    <p className="text-[10px] text-slate-500 mt-1">0 = Unlimited</p>
                                </div>
                            </div>
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
