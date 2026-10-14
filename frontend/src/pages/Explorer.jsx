import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../context/AuthContext'
import PageHeader from '../components/ui/PageHeader'
import { Compass, Loader2, Server, ChevronRight, Rocket } from 'lucide-react'

// KubeEZ Explorer from the sidebar: it lives on each cluster (Explorer tab), so
// one cluster with the Explorer opens it straight away; otherwise pick a cluster.
const explorerLink = (id) => `/cluster/${id}?tab=explorer`

export default function Explorer() {
    const navigate = useNavigate()
    const [clusters, setClusters] = useState(null)

    useEffect(() => {
        apiFetch('/api/clusters/list')
            .then(r => r.ok ? r.json() : [])
            .then(data => {
                const list = Array.isArray(data) ? data : []
                const withExplorer = list.filter(c => c.addons?.explorer)
                if (withExplorer.length === 1 && list.length === 1) return navigate(explorerLink(withExplorer[0].id), { replace: true })
                setClusters(list)
            })
            .catch(() => setClusters([]))
    }, [navigate])

    if (!clusters) return <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-slate-500" /></div>

    // clusters with the Explorer first
    const sorted = [...clusters].sort((a, b) => (b.addons?.explorer ? 1 : 0) - (a.addons?.explorer ? 1 : 0))

    return (
        <div className="max-w-5xl mx-auto">
            <PageHeader icon={Compass} eyebrow="Overview" title="KubeEZ Explorer"
                description="Resources, logs, topology, timeline, Helm and audit for a cluster — choose the cluster to explore." />
            {sorted.length === 0 ? (
                <div className="glass rounded-3xl border border-white/5 p-10 text-center">
                    <p className="text-slate-400 mb-5">No clusters yet. Every new cluster gets the Explorer by default.</p>
                    <Link to="/install" className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-xl text-xs font-black uppercase tracking-wider text-white">
                        <Rocket className="w-3.5 h-3.5" /> Deploy a cluster
                    </Link>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {sorted.map(c => {
                        const on = !!c.addons?.explorer
                        return (
                            <Link key={c.id} to={explorerLink(c.id)}
                                className="glass rounded-2xl border border-white/5 hover:border-blue-500/30 p-5 flex items-center gap-4 transition-all group">
                                <div className={`p-3 rounded-2xl border ${on ? 'bg-blue-500/10 border-blue-500/20 text-blue-300' : 'bg-white/5 border-white/10 text-slate-500'}`}>
                                    <Server className="w-5 h-5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="font-black text-white truncate">{c.clusterName || c.id}</div>
                                    <div className="text-[11px] text-slate-500 mt-0.5">
                                        {c.k8sVersion ? `Kubernetes ${c.k8sVersion} · ` : ''}
                                        {on ? <span className="text-emerald-400">Explorer installed</span> : <span>Explorer not installed — open to install it</span>}
                                    </div>
                                </div>
                                <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 group-hover:text-white flex items-center gap-1">
                                    {on ? 'Open' : 'Set up'} <ChevronRight className="w-3.5 h-3.5" />
                                </span>
                            </Link>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
