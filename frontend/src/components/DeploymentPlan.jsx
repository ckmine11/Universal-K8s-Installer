import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Shield, Package, Server, Zap, Network, Cpu, Puzzle, ChevronDown, Rocket, X, Clock, Info, Loader2 } from 'lucide-react'
import { ADDONS_LIST } from '../config/addons'
import useBackdropClose from './ui/useBackdropClose'

// The last look before an install: what KubeEZ will do, in order, on which
// servers — in plain words, in the page's theme (Zen or dark).
export default function DeploymentPlan({ config, verificationResults, onConfirm, onCancel, isInstalling }) {
    const [open, setOpen] = useState({ 1: true })
    const backdrop = useBackdropClose(isInstalling ? () => { } : onCancel)

    const masters = config.masterNodes || []
    const workers = config.workerNodes || []
    const osId = (verificationResults?.[masters[0]?.ip]?.osInfo?.id || '').toLowerCase()
    const redHat = ['centos', 'rhel', 'rocky', 'almalinux', 'ol', 'fedora'].includes(osId)
    const net = config.networkPlugin === 'calico' ? 'Calico' : 'Flannel'
    const addons = ADDONS_LIST.filter(a => config.addons?.[a.key])

    const steps = [
        { icon: Shield, name: 'Check the servers', time: '~2 min', on: 'all', tasks: ['Log in over SSH', `Check the operating system (${redHat ? 'RHEL family' : osId ? 'Debian / Ubuntu family' : 'Linux'})`, 'Check CPU, memory and disk', 'Check ports and kernel modules'] },
        { icon: Package, name: 'Prepare the servers', time: '~5 min', on: 'all', tasks: ['Turn off swap', 'Load overlay and br_netfilter, set network settings', `Install containerd (from the ${redHat ? 'YUM' : 'APT'} repository)`] },
        { icon: Server, name: 'Install Kubernetes', time: '~4 min', on: 'all', tasks: [`Install kubeadm, kubelet and kubectl ${config.k8sVersion}`, redHat ? 'Set SELinux to permissive' : 'Hold the package versions (no surprise upgrades)', 'Start kubelet'] },
        { icon: Zap, name: 'Start the control plane', time: '~4 min', on: 'first', tasks: ['kubeadm init on the first control-plane', 'Create the admin kubeconfig', masters.length > 1 ? `Join ${masters.length - 1} more control-plane node${masters.length > 2 ? 's' : ''}` : 'Create the join command for the other nodes'] },
        { icon: Network, name: `Pod network (${net})`, time: '~2 min', on: 'first', tasks: [`Apply ${net}`, 'Wait until every node is Ready'] },
        ...(workers.length ? [{ icon: Cpu, name: 'Join the workers', time: '~3 min', on: 'workers', tasks: [`Join ${workers.length} worker${workers.length > 1 ? 's' : ''} to the cluster`, 'Wait until they are Ready'] }] : []),
        ...(addons.length ? [{ icon: Puzzle, name: 'Install the add-ons', time: '~5 min', on: 'first', tasks: addons.map(a => a.name) }] : []),
    ]
    const nodesFor = (on) => on === 'workers' ? workers.map(n => ({ ...n, role: 'Worker' })) : on === 'first' ? masters.slice(0, 1).map(n => ({ ...n, role: 'Control plane' })) : [...masters.map(n => ({ ...n, role: 'Control plane' })), ...workers.map(n => ({ ...n, role: 'Worker' }))]
    const total = 13 + (workers.length ? 3 : 0) + (addons.length ? 5 : 0) + (masters.length > 1 ? 3 : 0)

    return createPortal(
        <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6" {...backdrop}>
            <div className="glass w-full max-w-3xl max-h-[92vh] flex flex-col rounded-3xl border border-white/10 overflow-hidden" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Install plan">
                {/* header */}
                <div className="flex items-start gap-4 p-5 sm:p-6 border-b border-white/10">
                    <div className="w-11 h-11 shrink-0 rounded-xl bg-blue-500/15 border border-blue-500/25 flex items-center justify-center"><Rocket className="w-5 h-5 text-blue-400" /></div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-xl sm:text-2xl font-black tracking-tight text-white">Install plan</h2>
                        <p className="text-sm text-slate-400 mt-0.5">Check it, then start. You can follow every step live.</p>
                    </div>
                    <button type="button" onClick={onCancel} disabled={isInstalling} className="p-1.5 rounded-lg text-slate-500 hover:text-white disabled:opacity-40" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>

                {/* summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/10 border-b border-white/10">
                    {[['Cluster', config.clusterName], ['Kubernetes', config.k8sVersion], ['Servers', `${masters.length} control · ${workers.length} worker${workers.length === 1 ? "" : "s"}`], ['Takes about', `${total} min`]].map(([k, v]) => (
                        <div key={k} className="px-5 py-3.5 min-w-0" style={{ background: 'var(--kz-surface)' }}>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{k}</p>
                            <p className="mt-1 text-sm font-semibold text-white truncate" title={String(v)}>{v}</p>
                        </div>
                    ))}
                </div>

                {/* steps */}
                <ol className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-2.5">
                    {steps.map((s, i) => {
                        const id = i + 1, isOpen = !!open[id], Icon = s.icon
                        return (
                            <li key={id} className={`rounded-2xl border transition-colors ${isOpen ? 'border-blue-500/30 bg-white/[0.03]' : 'border-white/10'}`}>
                                <button type="button" onClick={() => setOpen(o => ({ ...o, [id]: !o[id] }))} aria-expanded={isOpen} className="w-full flex items-center gap-3.5 p-4 text-left">
                                    <span className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm font-black border ${isOpen ? 'bg-blue-500 text-white border-blue-500' : 'bg-white/5 text-slate-400 border-white/10'}`}>{id}</span>
                                    <Icon className="w-4 h-4 shrink-0 text-slate-400" />
                                    <span className="flex-1 min-w-0 font-bold text-white truncate">{s.name}</span>
                                    <span className="hidden sm:inline-flex items-center gap-1 text-xs text-slate-500"><Clock className="w-3.5 h-3.5" />{s.time}</span>
                                    <ChevronDown className={`w-4 h-4 shrink-0 text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                                </button>
                                {isOpen && (
                                    <div className="px-4 pb-4 sm:pl-[3.25rem] space-y-3">
                                        <ul className="space-y-1.5">
                                            {s.tasks.map(t => <li key={t} className="flex items-start gap-2 text-sm text-slate-300"><span className="mt-2 w-1 h-1 rounded-full bg-slate-500 shrink-0" />{t}</li>)}
                                        </ul>
                                        <div className="flex flex-wrap items-center gap-1.5"><span className="text-[11px] text-slate-500 mr-1">On</span>
                                            {nodesFor(s.on).map(n => (
                                                <span key={n.ip + n.role} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px]">
                                                    <span className="font-mono text-slate-200">{n.ip}</span><span className="text-slate-500">{n.role}</span>
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </li>
                        )
                    })}
                </ol>

                {/* footer */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 sm:p-6 border-t border-white/10">
                    <p className="flex-1 flex items-start gap-2 text-xs text-slate-400"><Info className="w-4 h-4 shrink-0 mt-px" />Nothing on the servers is deleted, but their network settings change and kubelet restarts — use servers meant for this cluster.</p>
                    <div className="flex items-center gap-2 justify-end">
                        <button type="button" onClick={onCancel} disabled={isInstalling} className="kz-btn kz-btn-ghost">Back</button>
                        <button type="button" onClick={onConfirm} disabled={isInstalling} className="kz-btn kz-btn-primary">
                            {isInstalling ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</> : <><Rocket className="w-4 h-4" /> Start install</>}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    )
}
