import { useState } from 'react'
import { MessageCircle, Copy, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'

// AI settings → ChatOps: ask KubeEZ from the Telegram / Slack alert channels.
function Toggle({ on, onChange, label, disabled }) {
    return (
        <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-blue-500' : 'bg-white/15'} disabled:opacity-40`}>
            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-5' : 'left-1'}`} />
        </button>
    )
}

function SlackSetup({ ch, onSaved }) {
    const { toast } = useToast()
    const [secret, setSecret] = useState('')
    const [busy, setBusy] = useState(false)
    const save = async () => {
        setBusy(true)
        try {
            const res = await apiFetch(`/api/ai/chatops/${ch.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slackSigningSecret: secret }) })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(d.error)
            setSecret(''); toast({ title: 'Signing secret saved', type: 'success' }); onSaved()
        } catch (e) { toast({ title: 'Not saved', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }
    return (
        <div className="basis-full mt-2 space-y-2 rounded-xl border border-white/[0.07] p-3 text-[11px] text-slate-400">
            {ch.slashUrl ? (
                <>
                    <p>In your Slack app: <b>Slash Commands</b> → create <code className="text-blue-200">/kubeez</code> with this Request URL, then copy <b>Basic Information → Signing Secret</b> here.</p>
                    <div className="flex items-center gap-2"><code className="flex-1 truncate rounded bg-black/40 px-2 py-1 text-blue-200">{ch.slashUrl}</code><button onClick={() => navigator.clipboard?.writeText(ch.slashUrl)} className="kz-btn-ghost !py-1 !text-[11px]"><Copy className="w-3 h-3" /> Copy</button></div>
                    <div className="flex items-center gap-2">
                        <input type="password" className="kz-input !py-1.5 !text-xs font-mono" value={secret} onChange={e => setSecret(e.target.value.trim())} placeholder={ch.hasSecret ? 'Saved — paste to replace' : 'Signing secret (32 characters)'} autoComplete="new-password" aria-label="Slack signing secret" />
                        <button onClick={save} disabled={busy || secret.length !== 32} className="kz-btn-primary !py-1.5 !text-xs">{busy && <Loader2 className="w-3 h-3 animate-spin" />}Save</button>
                    </div>
                </>
            ) : <p>Slack needs KubeEZ on a public https address (KUBEEZ_PUBLIC_URL) — Slack has to reach it. Telegram works everywhere.</p>}
        </div>
    )
}

export default function ChatOpsPanel({ channels, onChanged }) {
    const { toast } = useToast()
    const set = async (ch, enabled) => {
        const res = await apiFetch(`/api/ai/chatops/${ch.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) return toast({ title: 'Not changed', message: d.error, type: 'error' })
        toast({ title: enabled ? `People can ask KubeEZ in ${ch.name}` : `ChatOps off for ${ch.name}`, type: 'success' }); onChanged()
    }
    if (!channels.length) return <p className="text-sm text-slate-400">Add a Telegram or Slack channel under <Link to="/alerts" className="text-blue-400 hover:underline">Alerts</Link> first — ChatOps answers in that same chat.</p>
    return (
        <div className="space-y-3">
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-xs text-slate-400 leading-relaxed">
                <p className="text-slate-200 font-semibold mb-1">Try in the chat (English, हिन्दी or Hinglish):</p>
                <p><code className="text-blue-200">sab theek hai?</code> · <code className="text-blue-200">kya problem hai</code> · <code className="text-blue-200">2 kyu hua</code> · <code className="text-blue-200">fix 2</code> · <code className="text-blue-200">prod pe kya badla 6h</code> · <code className="text-blue-200">what is a DaemonSet?</code></p>
                <p className="mt-1">Read-only: chat never changes a cluster — fixes are previewed there and applied in KubeEZ. Only the channel's own chat; in Telegram groups start with <code className="text-blue-200">/ask</code> or reply to the bot. 20 questions an hour per chat; every question is in the audit trail.</p>
            </div>
            <ul className="space-y-2">
                {channels.map(ch => (
                    <li key={ch.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
                        <MessageCircle className={`w-4 h-4 ${ch.type === 'telegram' ? 'text-sky-300' : 'text-fuchsia-300'}`} />
                        <div className="flex-1 min-w-[180px]">
                            <p className="text-sm font-semibold text-white">{ch.name}</p>
                            <p className="text-[11px] text-slate-500"><span className="capitalize">{ch.type}</span>{ch.type === 'slack' && !ch.hasSecret ? ' · needs the signing secret' : ''}</p>
                        </div>
                        <span className="text-[11px] text-slate-400">People may ask</span>
                        <Toggle on={ch.enabled} label={`ChatOps in ${ch.name}`} disabled={ch.type === 'slack' && !ch.hasSecret && !ch.enabled} onChange={v => set(ch, v)} />
                        {ch.type === 'slack' && <SlackSetup ch={ch} onSaved={onChanged} />}
                    </li>
                ))}
            </ul>
        </div>
    )
}
