import { useState } from 'react'
import { createPortal } from 'react-dom'
import { KeyRound, Loader2, X } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'
import { useToast } from '../ToastProvider'

// Change your own password — for every role (account menu). The reply sets the
// new session cookie, so this browser stays signed in; other sessions end.
export default function ChangePasswordDialog({ onClose }) {
    const { toast } = useToast()
    const [form, setForm] = useState({ current: '', next: '', confirm: '' })
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const set = (k) => (e) => { setForm(f => ({ ...f, [k]: e.target.value })); setError('') }

    const submit = async (e) => {
        e.preventDefault()
        if (!form.current || !form.next || !form.confirm) return setError('Fill in all three fields.')
        if (form.next.length < 8) return setError('The new password must be at least 8 characters.')
        if (form.next !== form.confirm) return setError('The new password and its confirmation do not match.')
        if (form.next === form.current) return setError('The new password must be different from the current one.')
        setBusy(true)
        try {
            const res = await apiFetch('/api/auth/change-password', {
                method: 'POST',
                body: JSON.stringify({ currentPassword: form.current, newPassword: form.next })
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'The password could not be changed.')
            toast({ title: 'Password changed', message: 'Your other sessions were signed out.', type: 'success' })
            onClose()
        } catch (err) {
            setError(err.message)
        } finally {
            setBusy(false)
        }
    }

    const input = 'w-full bg-black/35 border border-white/5 focus:border-blue-500/50 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors'
    return createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4" onClick={onClose}>
            <form onSubmit={submit} onClick={e => e.stopPropagation()} className="glass rounded-3xl border border-white/10 p-8 w-full max-w-sm" role="dialog" aria-label="Change password">
                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2.5 bg-blue-500/15 rounded-2xl border border-blue-500/20"><KeyRound className="w-5 h-5 text-blue-300" /></div>
                    <div className="flex-1">
                        <h3 className="font-black text-white">Change password</h3>
                        <p className="text-xs text-slate-500">Other sessions will be signed out</p>
                    </div>
                    <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-4 h-4" /></button>
                </div>
                <div className="space-y-3">
                    <input type="password" autoComplete="current-password" placeholder="Current password" value={form.current} onChange={set('current')} className={input} autoFocus />
                    <input type="password" autoComplete="new-password" placeholder="New password (min 8 characters)" value={form.next} onChange={set('next')} className={input} />
                    <input type="password" autoComplete="new-password" placeholder="Confirm new password" value={form.confirm} onChange={set('confirm')} className={input} />
                    {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2" role="alert">{error}</p>}
                    <div className="flex gap-3 pt-2">
                        <button type="button" onClick={onClose} className="flex-1 py-3 bg-white/5 hover:bg-white/10 border border-white/5 rounded-xl text-xs font-black uppercase tracking-wider text-slate-400">Cancel</button>
                        <button type="submit" disabled={busy} className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl text-xs font-black uppercase tracking-wider text-white flex items-center justify-center gap-2">
                            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />} Change
                        </button>
                    </div>
                </div>
            </form>
        </div>
    , document.body)
}
