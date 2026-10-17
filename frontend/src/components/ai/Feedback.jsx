import { useState } from 'react'
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

// 👍 / 👎 on an AI answer. A 👎 asks why — that is what shows which engine
// to trust (AI settings → Quality) and what to improve.
const REASONS = [['wrong', 'Wrong cause'], ['invented', 'Made something up'], ['unclear', 'Not clear'], ['unsafe', 'Unsafe advice'], ['slow', 'Too slow'], ['other', 'Other']]

export default function Feedback({ traceId }) {
    const [state, setState] = useState('idle')   // idle | why | sent
    const [comment, setComment] = useState('')
    const [error, setError] = useState(null)
    if (!traceId) return null
    const send = async (rating, reason = null) => {
        setError(null)
        try {
            const res = await apiFetch('/api/ai/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ traceId, rating, reason, comment: comment.trim() || null }) })
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Not saved')
            setState('sent')
        } catch (e) { setError(e.message) }
    }
    if (state === 'sent') return <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300"><Check className="w-3.5 h-3.5" /> Thanks — noted</span>
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <span>Was this right?</span>
                <button onClick={() => send('up')} className="p-1.5 rounded-lg hover:bg-emerald-500/10 hover:text-emerald-300" aria-label="Helpful" title="Helpful"><ThumbsUp className="w-3.5 h-3.5" /></button>
                <button onClick={() => setState(state === 'why' ? 'idle' : 'why')} className={`p-1.5 rounded-lg hover:bg-red-500/10 hover:text-red-300 ${state === 'why' ? 'text-red-300 bg-red-500/10' : ''}`} aria-label="Not helpful" title="Not helpful"><ThumbsDown className="w-3.5 h-3.5" /></button>
                {error && <span className="text-red-300">{error}</span>}
            </div>
            {state === 'why' && (
                <div className="space-y-2">
                    <input className="kz-input !py-1.5 !text-xs" value={comment} onChange={e => setComment(e.target.value)} maxLength={300} placeholder="What was wrong? (optional)" aria-label="What was wrong" />
                    <div className="flex flex-wrap gap-1.5">
                        {REASONS.map(([k, l]) => <button key={k} onClick={() => send('down', k)} className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:border-red-400/40 hover:text-red-200">{l}</button>)}
                    </div>
                </div>
            )}
        </div>
    )
}
