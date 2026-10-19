import { useState, useEffect, useCallback } from 'react'
import { Loader2, RefreshCw, Pencil, Check, X, AlertTriangle, Send } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'

async function call(url, opts) {
    const res = await apiFetch(url, opts)
    const d = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(d.error || 'Request failed'), { data: d })
    return d
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const SOURCE = { openrouter: 'list price (OpenRouter)', estimate: 'estimate — the same model elsewhere', manual: 'typed by an admin', offline: 'your own machine — free', unknown: 'price not known' }

// AI in the alert channels: the likely cause & fix under each new incident
// alert, and the daily / weekly AI digest.
export function AlertsAiPanel({ data, save }) {
    const { toast } = useToast()
    const [sending, setSending] = useState(false)
    const hasAi = data.engines.some(e => e.enabled !== false)
    const sendNow = async () => {
        setSending(true)
        try {
            const r = await call('/api/ai/digest/send', json('POST', { mode: data.digest === 'weekly' ? 'weekly' : 'daily' }))
            toast({ title: r.sent ? `Digest sent to ${r.sent} channel${r.sent > 1 ? 's' : ''}` : 'Not sent — add an alert channel first (Alerts)', message: r.aiError ? `The AI could not write it: ${r.aiError}` : r.engine ? `Written by ${r.engine}` : 'Facts only — no AI connected', type: r.sent ? 'success' : 'error' })
        } catch (e) { toast({ title: 'Not sent', message: e.message, type: 'error' }) } finally { setSending(false) }
    }
    return (
        <div className="space-y-4">
            <label className="flex items-start gap-3 text-sm text-slate-200">
                <input type="checkbox" className="mt-1" checked={data.alertExplain} onChange={e => save({ alertExplain: e.target.checked }, 'Saved')} />
                <span>
                    <span className="font-medium">Likely cause & fix under each new alert</span>
                    <span className="block text-xs text-slate-400 mt-0.5">After a warning or critical incident alert goes out, the connected AI reads the logs, events and recent changes and posts its cause and fix to the same channels — in Telegram as a reply under the alert. Once per incident, at most 6 an hour.{!hasAi && ' Connect an AI first.'}</span>
                </span>
            </label>
            <div className="flex flex-wrap items-end gap-3">
                <div>
                    <label className="kz-label" htmlFor="ai-digest">AI digest</label>
                    <select id="ai-digest" className="kz-input !w-44" value={data.digest} onChange={e => save({ digest: e.target.value }, 'Saved')}>
                        <option value="off">Off</option>
                        <option value="daily">Every day</option>
                        <option value="weekly">Every Monday</option>
                    </select>
                </div>
                <div>
                    <label className="kz-label" htmlFor="ai-digest-hour">At</label>
                    <select id="ai-digest-hour" className="kz-input !w-28" value={data.digestHour} disabled={data.digest === 'off'} onChange={e => save({ digestHour: Number(e.target.value) }, 'Saved')}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                    </select>
                </div>
                <button type="button" onClick={sendNow} disabled={sending} className="kz-btn-ghost !text-xs">{sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send one now</button>
            </div>
            <p className="text-xs text-slate-500">The digest goes to every alert channel: new and still-open incidents, changes made through KubeEZ, the riskiest clusters and what to do next — written by the connected AI (without one, the facts alone). The time is in the time zone of your quiet hours (Alerts → Rules).</p>
        </div>
    )
}

function PriceEditor({ p, onSaved }) {
    const { toast } = useToast()
    const [edit, setEdit] = useState(null)
    const [busy, setBusy] = useState(false)
    const save = async (body) => {
        setBusy(true)
        try { await call(`/api/ai/providers/${p.id}/price`, json('PUT', body)); setEdit(null); onSaved() }
        catch (e) { toast({ title: 'Price not saved', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }
    if (edit) return (
        <span className="inline-flex items-center gap-1">
            <input aria-label="US$ per million tokens in" className="kz-input !w-20 !py-0.5 !text-xs" value={edit.in} onChange={e => setEdit({ ...edit, in: e.target.value })} />
            <input aria-label="US$ per million tokens out" className="kz-input !w-20 !py-0.5 !text-xs" value={edit.out} onChange={e => setEdit({ ...edit, out: e.target.value })} />
            <button type="button" aria-label="Save price" disabled={busy} onClick={() => save({ priceIn: edit.in, priceOut: edit.out })} className="text-emerald-300"><Check className="w-3.5 h-3.5" /></button>
            <button type="button" aria-label="Cancel" onClick={() => setEdit(null)} className="text-slate-400"><X className="w-3.5 h-3.5" /></button>
        </span>
    )
    return (
        <span className="inline-flex items-center gap-1.5">
            <span className={p.priceSource === 'unknown' || p.priceIn == null ? 'text-amber-300' : ''} title={SOURCE[p.priceSource] || 'not looked up yet'}>
                {p.priceSource === 'offline' ? 'free' : p.priceIn != null ? `$${p.priceIn} / $${p.priceOut}` : 'unknown'}
            </span>
            {p.priceSource !== 'offline' && <>
                <button type="button" aria-label="Type the price" title="Type the price (US$ per million tokens in / out)" onClick={() => setEdit({ in: p.priceIn ?? '', out: p.priceOut ?? '' })} className="text-slate-400 hover:text-white"><Pencil className="w-3 h-3" /></button>
                <button type="button" aria-label="Look the price up again" title="Look it up again in OpenRouter's price list" disabled={busy} onClick={() => save({ auto: true })} className="text-slate-400 hover:text-white">{busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}</button>
            </>}
        </span>
    )
}

// Usage & cost per engine, with the monthly budget
export default function UsagePanel({ data, save }) {
    const [u, setU] = useState(null)
    const [error, setError] = useState(null)
    const load = useCallback(() => call('/api/ai/usage').then(setU).catch(e => setError(e.message)), [])
    useEffect(() => { load() }, [load, data.engines.length])
    const cost = data.aiCost || { budget: 0, currency: '$', perUsd: 1 }
    const setCost = (patch) => save({ aiCost: { ...cost, ...patch } }, 'Saved').then(load)
    if (error) return <p className="text-xs text-red-300">{error}</p>
    if (!u) return <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
    const max = Math.max(...u.days.map(d => d.cost), 0)
    const maxCalls = Math.max(...u.days.map(d => d.calls), 1)
    const prices = Object.fromEntries(u.prices.map(p => [p.id, p]))
    const money = (v) => `${u.currency}${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`
    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-end gap-6">
                <div>
                    <p className="text-xs text-slate-400">This month</p>
                    <p className="text-2xl font-semibold text-white">{u.month.costText}</p>
                    <p className="text-xs text-slate-500">{u.month.calls} answers · {tokens(u.month.tokensIn)} tokens in · {tokens(u.month.tokensOut)} out</p>
                </div>
                {u.budget > 0 && (
                    <div className="min-w-[220px] flex-1 max-w-sm">
                        <p className="text-xs text-slate-400 mb-1">Budget {u.budgetText} — {u.month.pct}% used</p>
                        <div className="h-2 rounded-full bg-white/10 overflow-hidden"><div className={`h-full ${u.month.over ? 'bg-red-400' : u.month.pct >= 80 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${Math.min(100, u.month.pct)}%` }} /></div>
                        {u.month.over && <p className="mt-1 flex items-center gap-1 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5" /> Reached — cloud engines are paused until next month; models on your own machines still answer.</p>}
                    </div>
                )}
            </div>

            <div>
                <p className="text-xs text-slate-400 mb-2">Last 30 days ({max > 0 ? 'cost' : 'answers'} per day)</p>
                <div className="flex items-end gap-[3px] h-20" role="img" aria-label="Cost per day, last 30 days">
                    {u.days.map(d => {
                        const v = max > 0 ? d.cost / max : d.calls / maxCalls
                        return <div key={d.date} title={`${d.date}: ${money(d.cost)} · ${d.calls} answers · ${tokens(d.tokensIn + d.tokensOut)} tokens`} className="flex-1 rounded-sm bg-violet-400/60 hover:bg-violet-300" style={{ height: `${Math.max(d.calls ? 4 : 1, v * 100)}%`, opacity: d.calls ? 1 : 0.25 }} />
                    })}
                </div>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead><tr className="text-left text-slate-500"><th className="py-1.5 pr-3 font-medium">Engine</th><th className="pr-3 font-medium">Answers</th><th className="pr-3 font-medium">Tokens in / out</th><th className="pr-3 font-medium">This month</th><th className="font-medium" title="US$ per million tokens, in / out">Price $/M in / out</th></tr></thead>
                    <tbody className="text-slate-300">
                        {[...u.engines, ...u.prices.filter(p => !u.engines.some(e => e.id === p.id)).map(p => ({ id: p.id, name: p.name, model: p.model, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 }))].map(e => (
                            <tr key={e.id} className="border-t border-white/5">
                                <td className="py-1.5 pr-3"><span className="text-white">{e.name}</span>{e.model && <span className="text-slate-500 font-mono"> · {e.model}</span>}{e.removed && <span className="text-slate-500"> (removed)</span>}</td>
                                <td className="pr-3">{e.calls}{e.estimated > 0 && <span className="text-slate-500" title="Tokens of these answers were estimated from the text — the engine did not report them"> ({e.estimated} est.)</span>}</td>
                                <td className="pr-3">{tokens(e.tokensIn)} / {tokens(e.tokensOut)}</td>
                                <td className="pr-3">{money(e.cost)}{e.unpriced > 0 && <span className="text-amber-300" title="Answered before its price was known — counted as free"> *</span>}</td>
                                <td>{prices[e.id] ? <PriceEditor p={prices[e.id]} onSaved={load} /> : <span className="text-slate-500">—</span>}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {!u.engines.length && !u.prices.length && <p className="text-xs text-slate-500 py-2">No AI engine yet.</p>}
            </div>

            <div className="flex flex-wrap items-end gap-3">
                <div><label className="kz-label" htmlFor="ai-cur">Currency</label>
                    <select id="ai-cur" className="kz-input !w-24" value={cost.currency} onChange={e => setCost({ currency: e.target.value, perUsd: e.target.value === '$' ? 1 : (cost.currency === '$' ? (e.target.value === '₹' ? 88 : 1) : cost.perUsd) })}>{['$', '₹', '€', '£'].map(c => <option key={c}>{c}</option>)}</select></div>
                {cost.currency !== '$' && <div><label className="kz-label" htmlFor="ai-rate">1 US$ =</label>
                    <input id="ai-rate" type="number" min={0} step="0.01" className="kz-input !w-28" defaultValue={cost.perUsd} key={`r${cost.perUsd}`} onBlur={e => Number(e.target.value) !== cost.perUsd && setCost({ perUsd: Number(e.target.value) })} /></div>}
                <div><label className="kz-label" htmlFor="ai-budget">Monthly budget ({cost.currency}, 0 = none)</label>
                    <input id="ai-budget" type="number" min={0} className="kz-input !w-40" defaultValue={cost.budget} key={`b${cost.budget}`} onBlur={e => Number(e.target.value) !== cost.budget && setCost({ budget: Number(e.target.value) })} /></div>
            </div>
            <p className="text-xs text-slate-500">Prices are filled in by themselves from OpenRouter's public list (it follows the providers' list prices) and checked daily; type your own if you pay a different rate. Tokens come from the engine; when it does not report them they are estimated (~4 characters a token). Alerts go out at 80 % and 100 % of the budget.</p>
        </div>
    )
}
