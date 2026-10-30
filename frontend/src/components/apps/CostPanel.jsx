import { useState } from 'react'
import { IndianRupee, Loader2 } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// What each namespace and app costs per month (requests × the workspace's
// prices, Delivery page), and — with metrics-server — the money left idle.
export default function CostPanel({ clusterId }) {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const load = async () => {
        setLoading(true)
        try { const r = await apiFetch(`/api/clusters/${clusterId}/costs`); const d = await r.json().catch(() => ({})); setData(r.ok ? d : { error: d.error }) } catch (e) { setData({ error: e.message }) } finally { setLoading(false) }
    }
    const money = (n) => n == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: data?.rates?.currency || 'INR', maximumFractionDigits: 0 }).format(n)
    return (
        <div className="kz-card p-5 space-y-3">
            <div className="flex items-center gap-2">
                <IndianRupee className="w-4 h-4 text-blue-300" /><h3 className="flex-1 text-sm font-semibold text-white">Cost per app (per month)</h3>
                <button onClick={load} disabled={loading} className="kz-btn-primary !py-1 !px-2 !text-[11px]">{loading ? <Loader2 className="w-3 h-3 animate-spin" /> : data ? 'Refresh' : 'Show costs'}</button>
            </div>
            {data?.error && <p className="text-xs text-amber-200">{data.error}</p>}
            {data?.namespaces && (
                <>
                    <p className="text-xs text-slate-300">Total <span className="font-semibold text-white">{money(data.total)}</span>{data.hasUsage && <> · idle (asked for, not used) <span className="font-semibold text-amber-200">{money(data.idle)}</span></>}
                        <span className="text-slate-500"> · {money(data.rates.cpuHour)}/vCPU-h, {money(data.rates.memGiBHour)}/GiB-h (Delivery page)</span></p>
                    <table className="w-full text-[11px]">
                        <thead><tr className="text-left text-slate-500 border-b border-white/10"><th className="py-1 font-semibold">App</th><th className="py-1 font-semibold text-right">Pods</th><th className="py-1 font-semibold text-right">CPU / memory asked</th>{data.hasUsage && <th className="py-1 font-semibold text-right">used</th>}<th className="py-1 font-semibold text-right">Per month</th>{data.hasUsage && <th className="py-1 font-semibold text-right">Idle</th>}</tr></thead>
                        <tbody>{data.apps.slice(0, 25).map(a => (
                            <tr key={`${a.namespace}/${a.kind}/${a.name}`} className="border-b border-white/[0.05]">
                                <td className="py-1 text-slate-200 break-all">{a.name} <span className="text-slate-500">{a.namespace}</span></td>
                                <td className="py-1 text-right text-slate-300">{a.pods}</td>
                                <td className="py-1 text-right text-slate-300">{a.cpu} vCPU · {a.memGiB} GiB</td>
                                {data.hasUsage && <td className="py-1 text-right text-slate-400">{a.usedCpu} · {a.usedMemGiB}</td>}
                                <td className="py-1 text-right text-white font-semibold">{money(a.monthly)}</td>
                                {data.hasUsage && <td className="py-1 text-right text-amber-200">{money(a.idleMonthly)}</td>}
                            </tr>
                        ))}</tbody>
                    </table>
                    {data.noRequests.length > 0 && <p className="text-[11px] text-slate-500">No CPU / memory requests (cost unknown, and the scheduler cannot plan them): {data.noRequests.join(', ')}</p>}
                    {!data.hasUsage && <p className="text-[11px] text-slate-500">Install metrics-server (Add-ons) to see real usage and the money left idle.</p>}
                </>
            )}
        </div>
    )
}
