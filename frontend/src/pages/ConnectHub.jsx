import { useState, useEffect } from 'react'
import { NavLink, Routes, Route, Link } from 'react-router-dom'
import { PlugZap, Plus, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { PageTitle } from '../components/ui/PageHeader'
import { call } from '../components/connect/shared'
import AddCluster from '../components/connect/AddCluster'
import { ClusterList, ClusterConnection, Agents, Guides } from '../components/connect/Manage'

// Connected clusters: existing clusters (cloud or on-prem) added to KubeEZ
// without installing them — the wizard, the list, the agents, the guides.
export default function ConnectHub() {
    const { user } = useAuth()
    const [data, setData] = useState(null)
    const [error, setError] = useState(null)
    useEffect(() => { call('/api/connect/providers').then(setData).catch(e => setError(e.message)) }, [])
    const tab = ({ isActive }) => `rounded-xl px-3 py-1.5 text-xs font-medium transition ${isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`
    return (
        <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1"><PageTitle icon={PlugZap} eyebrow="Connected clusters" title="Existing clusters" description="Bring the Kubernetes you already run — EKS, AKS, GKE, OKE, k3s, OpenShift, Rancher, kubeadm or any other — into KubeEZ: monitoring, incidents, AI and advice, without reinstalling anything." /></div>
                {can(user?.role, 'cluster:create') && <Link to="/connect/new" className="kz-btn-primary !text-xs"><Plus className="w-3.5 h-3.5" /> Add existing cluster</Link>}
            </div>
            <nav className="flex flex-wrap gap-1 rounded-2xl border border-white/10 bg-white/[0.02] p-1 w-fit" aria-label="Connected clusters">
                <NavLink end to="/connect" className={tab}>Connected clusters</NavLink>
                {can(user?.role, 'cluster:create') && <NavLink to="/connect/new" className={tab}>Add existing cluster</NavLink>}
                <NavLink to="/connect/agents" className={tab}>Connection agents</NavLink>
                <NavLink to="/connect/guides" className={tab}>Setup guides</NavLink>
            </nav>
            {error && <p className="kz-card p-4 text-sm text-red-200">{error}</p>}
            {!data ? !error && <Loader2 className="w-5 h-5 animate-spin text-slate-400" /> : (
                <Routes>
                    <Route index element={<ClusterList providers={data.providers} />} />
                    <Route path="new" element={can(user?.role, 'cluster:create') ? <AddCluster providers={data.providers} saas={data.saas} /> : <p className="kz-card p-4 text-sm text-slate-400">Your role may not add clusters.</p>} />
                    <Route path="agents" element={<Agents />} />
                    <Route path="guides" element={<Guides providers={data.providers} />} />
                    <Route path="guides/:provider" element={<Guides providers={data.providers} />} />
                    <Route path="cluster/:id" element={<ClusterConnection providers={data.providers} />} />
                </Routes>
            )}
        </div>
    )
}
