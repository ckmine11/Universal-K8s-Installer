import { useState } from 'react'
import { useToast } from '../components/ToastProvider'
import { useAuth, apiFetch } from '../context/AuthContext'
import { Lock, Key, Loader2, ShieldAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function VendorPortal() {
    const { toast } = useToast()
    const { user } = useAuth()
    const navigate = useNavigate()

    const [vendorForm, setVendorForm] = useState({ plan: 'ENTERPRISE', clusters: 50, nodes: 500, validityDays: 365, systemId: '' })
    const [vendorToken, setVendorToken] = useState('')
    const [vendorGenerating, setVendorGenerating] = useState(false)

    // Security check
    if (user?.role !== 'admin') {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                <ShieldAlert className="w-16 h-16 text-rose-500 mb-6" />
                <h1 className="text-3xl font-black text-white mb-2 uppercase">Access Denied</h1>
                <p className="text-slate-400 mb-8 max-w-md">This area is highly restricted. Only authorized vendor administrators can access the licensing portal.</p>
                <button
                    onClick={() => navigate('/')}
                    className="px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 text-white rounded-xl font-bold transition-all"
                >
                    Return Home
                </button>
            </div>
        )
    }

    const handleGenerateLicense = async () => {
        if (!vendorForm.systemId) {
            toast({ title: 'Error', message: 'System ID is required to bind the license.', type: 'error' })
            return
        }
        setVendorGenerating(true)
        try {
            const res = await apiFetch('/api/license/generate', {
                method: 'POST',
                body: JSON.stringify({
                    plan: vendorForm.plan,
                    maxClusters: vendorForm.clusters,
                    maxNodes: vendorForm.nodes,
                    validityDays: vendorForm.validityDays,
                    systemId: vendorForm.systemId.trim()
                })
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to generate license')
            
            setVendorToken(data.token)
            toast({ title: 'Success', message: 'License generated successfully!', type: 'success' })
        } catch (err) {
            toast({ title: 'Generation Failed', message: err.message, type: 'error' })
        } finally {
            setVendorGenerating(false)
        }
    }

    return (
        <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <Lock className="w-6 h-6 text-purple-400" />
                        <h1 className="text-2xl font-black text-white tracking-tight">Vendor Portal</h1>
                    </div>
                    <p className="text-slate-400 text-sm mt-1">Generate secure cryptographic JWT licenses bound to target System IDs</p>
                </div>
                <span className="px-3 py-1.5 bg-purple-500/10 border border-purple-500/20 rounded-full text-[10px] font-black text-purple-400 uppercase tracking-widest">
                    Classified Secure Area
                </span>
            </div>

            <div className="glass rounded-2xl border border-white/8 p-8 relative">
                <h3 className="text-lg font-black text-white tracking-tight mb-6">License Parameters</h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                    <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Target System ID</label>
                        <input
                            type="text"
                            placeholder="SYS-XXXX-XXXXXXXX"
                            value={vendorForm.systemId}
                            onChange={e => setVendorForm(p => ({ ...p, systemId: e.target.value.toUpperCase() }))}
                            className="w-full bg-black/35 border border-white/5 focus:border-purple-500/50 rounded-xl px-4 py-3 text-sm text-white font-mono placeholder-slate-600 outline-none transition-colors"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Subscription Plan</label>
                        <select
                            value={vendorForm.plan}
                            onChange={e => setVendorForm(p => ({ ...p, plan: e.target.value }))}
                            className="w-full bg-black/35 border border-white/5 focus:border-purple-500/50 rounded-xl px-4 py-3 text-sm text-white font-bold outline-none transition-colors appearance-none"
                        >
                            <option value="PRO">PRO</option>
                            <option value="ENTERPRISE">ENTERPRISE</option>
                            <option value="EVALUATION">EVALUATION</option>
                        </select>
                    </div>
                    <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Max Clusters</label>
                        <input
                            type="number"
                            value={vendorForm.clusters}
                            onChange={e => setVendorForm(p => ({ ...p, clusters: parseInt(e.target.value) || 0 }))}
                            className="w-full bg-black/35 border border-white/5 focus:border-purple-500/50 rounded-xl px-4 py-3 text-sm text-white outline-none transition-colors"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Max Nodes</label>
                        <input
                            type="number"
                            value={vendorForm.nodes}
                            onChange={e => setVendorForm(p => ({ ...p, nodes: parseInt(e.target.value) || 0 }))}
                            className="w-full bg-black/35 border border-white/5 focus:border-purple-500/50 rounded-xl px-4 py-3 text-sm text-white outline-none transition-colors"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Validity (Days)</label>
                        <input
                            type="number"
                            value={vendorForm.validityDays}
                            onChange={e => setVendorForm(p => ({ ...p, validityDays: parseInt(e.target.value) || 0 }))}
                            className="w-full bg-black/35 border border-white/5 focus:border-purple-500/50 rounded-xl px-4 py-3 text-sm text-white outline-none transition-colors"
                        />
                    </div>
                </div>

                <button
                    onClick={handleGenerateLicense}
                    disabled={vendorGenerating || !vendorForm.systemId}
                    className="w-full py-4 rounded-2xl bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-500 hover:to-purple-600 disabled:opacity-50 text-white font-black text-xs uppercase tracking-wider shadow-lg shadow-purple-600/20 active:scale-[0.98] transition-all duration-300 flex items-center justify-center gap-2 mb-6"
                >
                    {vendorGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                    <span>{vendorGenerating ? 'Generating...' : 'Generate License Token'}</span>
                </button>

                {vendorToken && (
                    <div className="bg-black/40 border border-purple-500/20 rounded-2xl p-6 relative mt-6">
                        <div className="flex items-center justify-between mb-3">
                            <label className="text-[10px] font-black text-purple-400 uppercase tracking-widest">Generated JWT Token</label>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(vendorToken)
                                    toast({ title: 'Copied', message: 'Token copied to clipboard', type: 'success' })
                                }}
                                className="bg-purple-500/20 hover:bg-purple-500/40 text-purple-300 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-colors"
                            >
                                Copy Token
                            </button>
                        </div>
                        <textarea
                            readOnly
                            value={vendorToken}
                            className="w-full h-32 bg-transparent text-[11px] font-mono text-slate-300 outline-none resize-none"
                        />
                    </div>
                )}
            </div>
        </div>
    )
}
