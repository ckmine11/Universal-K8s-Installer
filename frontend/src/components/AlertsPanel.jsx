import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../context/AuthContext'
import {
    Bell, Send, MessageCircle, Mail, Webhook, Hash, Users, Plus, Trash2, Loader2, CheckCircle2,
    XCircle, X, Moon, Clock, History, Pencil, AlertTriangle, Power, Lock, Sparkles
} from 'lucide-react'

// Alert channels + rules for the workspace (the Alerts page)

const TYPE_META = {
    telegram: { Icon: Send, color: 'text-sky-300', help: '1) Create a bot with @BotFather and paste its token. 2) Send /start to the bot from your Telegram — or add it to your group/channel and post a message there. 3) Click "Find my chat ID" and pick the chat. The chat ID is you or your group, never the bot.' },
    slack: { Icon: Hash, color: 'text-fuchsia-300', help: 'Slack → Apps → Incoming Webhooks → Add to a channel → copy the webhook URL.' },
    teams: { Icon: Users, color: 'text-indigo-300', help: 'Teams channel → Workflows → "Post to a channel when a webhook request is received" → copy the URL.' },
    whatsapp: { Icon: MessageCircle, color: 'text-emerald-300', help: 'Uses Twilio\'s WhatsApp API: Account SID + Auth Token from the Twilio console. Testing: From = the sandbox number +14155238886, and first send "join <your code>" to it from the phone in To. WhatsApp allows free text only within 24 h of that phone\'s last message — for alerts that always arrive, create a Content Template in Twilio (variables {{1}} title, {{2}} details, {{3}} link), get it approved and paste its SID (HX…).' },
    email: { Icon: Mail, color: 'text-amber-300', help: 'Sent through the server\'s SMTP settings. Up to 10 addresses, comma-separated.' },
    webhook: { Icon: Webhook, color: 'text-slate-300', help: 'KubeEZ POSTs a JSON event (type, severity, title, text, cluster, link) to this HTTPS URL — for PagerDuty, Opsgenie, n8n, your own tools.' }
}
const FIELD_LABEL = { botToken: 'Bot token', chatId: 'Chat ID', webhookUrl: 'Webhook URL', accountSid: 'Account SID', authToken: 'Auth token', from: 'From (WhatsApp number)', to: 'To', url: 'URL', contentSid: 'Template SID (optional)' }
const FIELD_HINT = { to: { whatsapp: '+919812345678', email: 'ops@company.com, oncall@company.com' }, from: { whatsapp: '+14155238886' }, chatId: { telegram: '-1001234567890' }, contentSid: { whatsapp: 'HX… — approved template, delivers outside the 24 h window' }, webhookUrl: { slack: 'https://hooks.slack.com/services/…', teams: 'https://…logic.azure.com/… or …powerplatform.com/…' } }
const SEV = { critical: 'text-red-300', warning: 'text-amber-300', success: 'text-emerald-300', info: 'text-sky-300' }
const input = 'w-full bg-black/40 border border-white/10 focus:border-blue-500/50 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 outline-none'
const fmt = (iso) => iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

// Connect a Telegram chat without knowing its ID: open the bot via a t.me
// link, press Start (or add it to a group) — KubeEZ watches the bot for a few
// minutes and fills in the chat ID itself.
function TelegramChatFinder({ form, setForm }) {
    const [state, setState] = useState(null)   // null | { busy, bot, chats, error, watching }
    const timer = useRef(null)
    const stop = () => { clearTimeout(timer.current); timer.current = null }
    useEffect(() => stop, [])
    const isBotChat = (v) => !v || /bot$/i.test(v)
    const ask = async () => {
        const r = await apiFetch('/api/notifications/telegram/chats', { method: 'POST', body: JSON.stringify({ botToken: form.config.botToken || '', channelId: form.id }) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error || 'Could not ask Telegram')
        return j
    }
    const connect = async () => {
        stop()
        setState({ busy: true })
        const started = Date.now()
        const poll = async () => {
            try {
                const j = await ask()
                const chats = j.chats || []
                // exactly one chat and nothing useful typed yet → fill it in
                if (chats.length === 1) setForm(f => isBotChat(f.config.chatId) ? { ...f, config: { ...f.config, chatId: chats[0].id } } : f)
                const watching = !chats.length && Date.now() - started < 180000
                setState({ bot: j.bot, chats, watching })
                if (watching) timer.current = setTimeout(poll, 3000)
            } catch (e) { setState({ error: e.message }) }
        }
        poll()
    }
    const pick = (id) => setForm(f => ({ ...f, config: { ...f.config, chatId: id } }))
    const u = state?.bot?.username
    return (
        <div className="mt-2 space-y-2">
            <button type="button" onClick={connect} disabled={state?.busy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/10 border border-sky-500/25 text-sky-300 text-[11px] font-bold hover:bg-sky-500/20 disabled:opacity-50">
                {state?.busy || state?.watching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                {state?.chats?.length ? 'Search again' : 'Find my chat ID'}
            </button>
            {state?.error && <p className="text-[11px] text-red-300">{state.error}</p>}
            {state?.watching && (
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-[11px] text-slate-300 space-y-2">
                    <p className="font-bold text-white">Waiting for you in Telegram…</p>
                    {u ? (
                        <div className="flex flex-wrap gap-2">
                            <a href={`https://t.me/${u}?start=kubeez`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-black">Open @{u} → press Start</a>
                            <a href={`https://t.me/${u}?startgroup=kubeez`} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 rounded-lg border border-white/15 text-slate-200 font-bold hover:bg-white/5">Add to a group</a>
                        </div>
                    ) : <p>Open your bot in Telegram and send /start (or add it to a group and post a message).</p>}
                    <p className="text-slate-500">The chat ID fills in by itself as soon as the bot hears from you. For a channel: add the bot as an admin and post something in the channel.</p>
                </div>
            )}
            {state?.chats && !state.chats.length && !state.watching && (
                <p className="text-[11px] text-amber-300">Nothing arrived from Telegram yet — open the bot, press Start, then click Find my chat ID again.</p>
            )}
            {state?.chats?.length > 0 && (
                <div className="space-y-1">
                    <p className="text-[11px] text-slate-400">{state.chats.length === 1 ? 'Found — filled in:' : 'Pick the chat for alerts:'}</p>
                    {state.chats.map(c => (
                        <button type="button" key={c.id} onClick={() => pick(c.id)}
                            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-left text-xs ${form.config.chatId === c.id ? 'border-sky-500/50 bg-sky-500/10 text-white' : 'border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]'}`}>
                            <span className="truncate">{form.config.chatId === c.id && '✓ '}{c.name}{c.username ? ` (@${c.username})` : ''} <span className="text-slate-500">· {c.type === 'private' ? 'you' : c.type}</span></span>
                            <span className="font-mono text-[11px] text-slate-400 shrink-0">{c.id}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}


export default function AlertsPanel() {
    const [data, setData] = useState(null)
    const [error, setError] = useState(null)
    const [form, setForm] = useState(null)          // { id?, type, name, config, enabled }
    const [busy, setBusy] = useState(null)
    const [notice, setNotice] = useState(null)
    const [rules, setRules] = useState(null)

    const load = async () => {
        try {
            const r = await apiFetch('/api/notifications')
            const j = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(j.error || 'Could not load alerts')
            setData(j); setRules(j.rules)
        } catch (e) { setError(e.message) }
    }
    useEffect(() => { load() }, [])
    // a dialog shows only its own save errors, not an older message
    useEffect(() => { if (form) setNotice(null) }, [form?.id, form?.type])

    const call = async (key, method, path, body, ok) => {
        setBusy(key); setNotice(null)
        try {
            const r = await apiFetch(path, { method, body: body ? JSON.stringify(body) : undefined })
            const j = await r.json().catch(() => ({}))
            if (!r.ok || j.ok === false) throw Object.assign(new Error(j.error || 'Request failed'), { upgrade: !!j.upgrade })
            if (ok) setNotice({ ok: true, msg: ok })
            await load()
            return true
        } catch (e) { setNotice({ ok: false, msg: e.message, upgrade: e.upgrade }); return false } finally { setBusy(null) }
    }

    const saveForm = async () => {
        const body = { type: form.type, name: form.name, config: form.config, enabled: form.enabled }
        const done = form.id
            ? await call('save', 'PUT', `/api/notifications/channels/${form.id}`, body, 'Channel saved.')
            : await call('save', 'POST', '/api/notifications/channels', body, 'Channel added — send a test to check it.')
        if (done) setForm(null)
    }

    if (error) return <div className="glass rounded-2xl border border-white/8 p-6 text-sm text-red-300">{error}</div>
    if (!data) return <div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>

    const plan = data.plan || { paid: true, channelTypes: Object.keys(data.types), maxChannels: null, rules: true }
    const usable = data.channels.filter(c => !c.locked).length
    const full = plan.maxChannels != null && usable >= plan.maxChannels
    const addChannel = (k, t) => {
        if (!plan.channelTypes.includes(k)) return setNotice({ ok: false, upgrade: true, msg: `${t.label} alerts are part of Pro. On Free you can use one Telegram, email or webhook channel.` })
        if (full) return setNotice({ ok: false, upgrade: true, msg: `The Free plan includes ${plan.maxChannels} alert channel — remove the existing one first, or upgrade to Pro for more.` })
        setForm({ type: k, name: t.label, config: {}, enabled: true })
    }

    return (
        <div className="space-y-6">
            {!plan.paid && (
                <div className="relative overflow-hidden rounded-2xl border border-blue-400/20 bg-gradient-to-r from-blue-500/10 via-indigo-500/5 to-violet-500/10 p-4 flex flex-wrap items-center gap-4">
                    <Sparkles className="w-5 h-5 text-blue-300 shrink-0" />
                    <div className="min-w-0 flex-1 text-sm">
                        <p className="font-semibold text-white">Free plan alerts</p>
                        <p className="text-xs text-slate-300 mt-0.5">
                            {plan.maxChannels} channel (Telegram, email or webhook) · critical alerts only (node or control plane down, failed backups / upgrades, agent offline) · {plan.emailsToday || 0}/{plan.emailPerDay} alert emails today
                        </p>
                    </div>
                    <Link to="/pricing" className="kz-btn-primary !py-2">Upgrade for all alerts</Link>
                </div>
            )}
            <div className="glass rounded-2xl border border-white/8 p-6">
                <div className="flex items-center justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20"><Bell className="w-5 h-5 text-blue-400" /></div>
                        <div>
                            <h3 className="text-lg font-black text-white">Alert channels</h3>
                            <p className="text-xs text-slate-500">Where KubeEZ tells your team about incidents, failed backups, upgrades and offline agents</p>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 justify-end">
                        {Object.entries(data.types).map(([k, t]) => {
                            const M = TYPE_META[k]
                            return (
                                <button key={k} onClick={() => addChannel(k, t)}
                                    title={!plan.channelTypes.includes(k) ? 'Pro' : full ? 'Free includes one channel' : ''}
                                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-[11px] font-bold ${plan.channelTypes.includes(k) && !full ? 'text-slate-200' : 'text-slate-500'}`}>
                                    {plan.channelTypes.includes(k) ? <Plus className="w-3 h-3" /> : <Lock className="w-3 h-3 text-amber-300" />}<M.Icon className={`w-3.5 h-3.5 ${M.color}`} /> {t.label}
                                    {!plan.channelTypes.includes(k) && <span className="ml-0.5 rounded px-1 text-[9px] text-amber-300 bg-amber-500/10">PRO</span>}
                                </button>
                            )
                        })}
                    </div>
                </div>

                {notice && (
                    <div className={`mb-4 flex items-start gap-2 rounded-xl p-3 text-xs ${notice.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-300'}`}>
                        {notice.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}<span className="flex-1">{notice.msg}{notice.upgrade && <> <Link to="/pricing" className="font-bold underline">See Pro</Link></>}</span>
                        <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
                    </div>
                )}
                {!data.linksConfigured && <p className="mb-3 text-[11px] text-slate-500">Tip: set KUBEEZ_PUBLIC_URL on the server so alerts link straight to the cluster in KubeEZ.</p>}

                {!data.channels.length ? (
                    <div className="py-10 text-center rounded-xl border border-dashed border-white/10">
                        <Bell className="w-9 h-9 text-slate-700 mx-auto mb-2" />
                        <p className="text-sm text-slate-400">No alert channels yet.</p>
                        <p className="text-xs text-slate-600 mt-1">Add Telegram, Slack, Teams, WhatsApp, email or a webhook above.</p>
                    </div>
                ) : (
                    <div className="grid md:grid-cols-2 gap-3">
                        {data.channels.map(c => {
                            const M = TYPE_META[c.type] || TYPE_META.webhook
                            return (
                                <div key={c.id} className={`rounded-xl border p-3.5 ${c.locked ? 'border-amber-400/20 bg-amber-500/[0.03]' : c.enabled ? 'border-white/10 bg-white/[0.02]' : 'border-white/5 bg-white/[0.01] opacity-60'}`}>
                                    {c.locked && <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-amber-300"><Lock className="w-3 h-3" /> Not on the Free plan — paused. <Link to="/pricing" className="underline">Upgrade</Link> or delete it.</p>}
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex items-center gap-2.5 min-w-0">
                                            <div className="p-2 rounded-lg bg-black/30 border border-white/5"><M.Icon className={`w-4 h-4 ${M.color}`} /></div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-bold text-white truncate">{c.name}</p>
                                                <p className="text-[11px] text-slate-500 truncate">{data.types[c.type]?.label} · {Object.values(c.config).filter(Boolean).slice(0, 2).join(' · ')}</p>
                                            </div>
                                        </div>
                                        <div className="flex gap-1 shrink-0">
                                            <button onClick={() => call(`test-${c.id}`, 'POST', `/api/notifications/channels/${c.id}/test`, null, `Test sent to ${c.name}.`)} disabled={busy === `test-${c.id}` || c.locked}
                                                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-bold disabled:opacity-50">
                                                {busy === `test-${c.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Test
                                            </button>
                                            <button onClick={() => setForm({ id: c.id, type: c.type, name: c.name, config: Object.fromEntries(Object.entries(c.config).map(([k, v]) => [k, data.types[c.type].secret.includes(k) ? '' : v])), enabled: c.enabled })}
                                                aria-label="Edit" className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"><Pencil className="w-3 h-3" /></button>
                                            <button onClick={() => call(`tog-${c.id}`, 'PUT', `/api/notifications/channels/${c.id}`, { enabled: !c.enabled })}
                                                aria-label={c.enabled ? 'Pause' : 'Resume'} className="p-1.5 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5"><Power className="w-3 h-3" /></button>
                                            <button onClick={() => { if (window.confirm(`Delete ${c.name}?`)) call(`del-${c.id}`, 'DELETE', `/api/notifications/channels/${c.id}`) }}
                                                aria-label="Delete" className="p-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-red-300 hover:bg-red-500/10"><Trash2 className="w-3 h-3" /></button>
                                        </div>
                                    </div>
                                    {c.lastResult && (
                                        <p className={`mt-2 text-[10px] ${c.lastResult.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                                            {c.lastResult.ok ? '✓ Last delivery worked' : `✗ Last delivery failed: ${c.lastResult.error}`} · {fmt(c.lastResult.at)}
                                        </p>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            {/* Rules */}
            {rules && !plan.rules && (
                <div className="glass rounded-2xl border border-white/8 p-6">
                    <div className="flex items-center gap-2"><h3 className="text-lg font-black text-white">What to alert on</h3><span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-amber-300 bg-amber-500/10">PRO</span></div>
                    <p className="text-xs text-slate-400 mt-1">On Free: every <b className="text-slate-200">critical</b> alert, at any hour, the same alert at most every 15 minutes. With Pro you choose the alert types (warnings, recoveries, finished upgrades…), quiet hours and the cooldown.</p>
                    <Link to="/pricing" className="inline-flex mt-3 kz-btn-ghost !py-2 !text-xs"><Lock className="w-3.5 h-3.5" /> Unlock with Pro</Link>
                </div>
            )}
            {rules && plan.rules && (
                <div className="glass rounded-2xl border border-white/8 p-6">
                    <h3 className="text-lg font-black text-white mb-1">What to alert on</h3>
                    <p className="text-xs text-slate-500 mb-4">Applies to every channel of the workspace.</p>
                    <div className="grid md:grid-cols-2 gap-2 mb-5">
                        {Object.entries(data.events).map(([k, label]) => (
                            <label key={k} className="flex items-center gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5 text-xs text-slate-300 cursor-pointer">
                                <input type="checkbox" checked={!!rules.events[k]} onChange={e => setRules(r => ({ ...r, events: { ...r.events, [k]: e.target.checked } }))} /> {label}
                            </label>
                        ))}
                    </div>
                    <div className="grid md:grid-cols-2 gap-4">
                        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5">
                            <label className="flex items-center gap-2 text-sm font-bold text-white mb-2 cursor-pointer">
                                <input type="checkbox" checked={rules.quietHours.enabled} onChange={e => setRules(r => ({ ...r, quietHours: { ...r.quietHours, enabled: e.target.checked } }))} />
                                <Moon className="w-4 h-4 text-indigo-300" /> Quiet hours
                            </label>
                            <p className="text-[11px] text-slate-500 mb-2">Only critical alerts (node down, failures) during these hours.</p>
                            <div className="flex items-center gap-2 text-xs text-slate-300">
                                <input type="time" aria-label="Quiet hours start" value={rules.quietHours.start} onChange={e => setRules(r => ({ ...r, quietHours: { ...r.quietHours, start: e.target.value } }))} className={`${input} !py-1.5 !w-28`} />
                                to
                                <input type="time" aria-label="Quiet hours end" value={rules.quietHours.end} onChange={e => setRules(r => ({ ...r, quietHours: { ...r.quietHours, end: e.target.value } }))} className={`${input} !py-1.5 !w-28`} />
                                <input aria-label="Time zone" value={rules.quietHours.timezone} onChange={e => setRules(r => ({ ...r, quietHours: { ...r.quietHours, timezone: e.target.value } }))} className={`${input} !py-1.5`} />
                            </div>
                        </div>
                        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5">
                            <p className="flex items-center gap-2 text-sm font-bold text-white mb-2"><Clock className="w-4 h-4 text-amber-300" /> Don't repeat the same alert for</p>
                            <div className="flex items-center gap-2 text-xs text-slate-300">
                                <input type="number" min="0" max="1440" aria-label="Cooldown minutes" value={rules.cooldownMinutes} onChange={e => setRules(r => ({ ...r, cooldownMinutes: e.target.value }))} className={`${input} !py-1.5 !w-24`} /> minutes
                            </div>
                        </div>
                    </div>
                    <div className="flex justify-end mt-4">
                        <button onClick={() => call('rules', 'PUT', '/api/notifications/rules', rules, 'Alert rules saved.')} disabled={busy === 'rules'}
                            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-black disabled:opacity-50">
                            {busy === 'rules' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Save rules
                        </button>
                    </div>
                </div>
            )}

            {/* History */}
            <div className="glass rounded-2xl border border-white/8 p-6">
                <h3 className="flex items-center gap-2 text-lg font-black text-white mb-3"><History className="w-5 h-5 text-slate-400" /> Recent alerts</h3>
                {!data.history.length ? <p className="text-xs text-slate-500">Nothing sent yet.</p> : (
                    <div className="space-y-1.5 max-h-80 overflow-y-auto">
                        {data.history.map((h, i) => (
                            <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2 text-[11px]">
                                <span className="min-w-0 truncate"><span className={SEV[h.severity] || 'text-slate-300'}>●</span> <span className="text-white">{h.title}</span>{h.clusterName ? <span className="text-slate-500"> · {h.clusterName}</span> : null}</span>
                                <span className={`shrink-0 ${h.failures?.length ? 'text-red-300' : 'text-slate-500'}`}>{h.outcome} · {fmt(h.at)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Add / edit dialog */}
            {form && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
                    <div className="glass border border-white/10 rounded-3xl max-w-lg w-full p-6 relative max-h-[90vh] overflow-y-auto">
                        <button onClick={() => setForm(null)} aria-label="Close" className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
                        {(() => { const M = TYPE_META[form.type]; return <h2 className="flex items-center gap-2 text-lg font-black text-white mb-1"><M.Icon className={`w-5 h-5 ${M.color}`} /> {form.id ? 'Edit' : 'Add'} {data.types[form.type].label}</h2> })()}
                        <p className="text-[11px] text-slate-400 mb-4 leading-relaxed">{TYPE_META[form.type].help}</p>
                        {form.type === 'email' && !data.emailConfigured && <p className="mb-3 text-[11px] text-amber-300">The server has no SMTP settings yet — email alerts will fail until SMTP_HOST / SMTP_USER / SMTP_PASS are set.</p>}
                        <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1" htmlFor="ch-name">Name</label>
                        <input id="ch-name" className={`${input} mb-3`} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                        {(form.type === 'telegram' ? ['botToken', 'chatId'] : data.types[form.type].fields).map(k => {
                            const secret = data.types[form.type].secret.includes(k)
                            return (
                                <div key={k} className="mb-3">
                                    <label className="block text-[10px] font-black uppercase tracking-wider text-slate-500 mb-1" htmlFor={`ch-${k}`}>{FIELD_LABEL[k] || k}</label>
                                    <input id={`ch-${k}`} type={secret ? 'password' : 'text'} autoComplete="off" className={input}
                                        placeholder={secret && form.id ? 'unchanged' : (FIELD_HINT[k]?.[form.type] || '')}
                                        value={form.config[k] || ''} onChange={e => setForm(f => ({ ...f, config: { ...f.config, [k]: e.target.value } }))} />
                                    {form.type === 'telegram' && k === 'chatId' && <TelegramChatFinder form={form} setForm={setForm} />}
                                </div>
                            )
                        })}
                        {notice && !notice.ok && <p className="mb-3 text-xs text-red-300 flex items-start gap-1.5"><XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{notice.msg}</p>}
                        <div className="flex justify-end gap-2 mt-2">
                            <button onClick={() => setForm(null)} className="px-4 py-2.5 rounded-xl border border-white/10 text-slate-300 text-xs font-bold">Cancel</button>
                            <button onClick={saveForm} disabled={busy === 'save'} className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-black disabled:opacity-50">
                                {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Save
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
