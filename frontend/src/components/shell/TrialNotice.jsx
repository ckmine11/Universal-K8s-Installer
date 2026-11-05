import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, X, Hourglass } from 'lucide-react'
import { apiFetch } from '../../context/AuthContext'

/** The workspace's plan (GET /api/billing/plan) for the signed-in person; null until known. */
export function usePlan(userId) {
    const [p, setP] = useState(null)
    useEffect(() => {
        setP(null)
        if (!userId) return
        let stop = false
        const load = () => apiFetch('/api/billing/plan').then(r => r.ok ? r.json() : null).then(d => { if (!stop) setP(d) }).catch(() => { })
        load()
        const t = setInterval(load, 60 * 60e3)   // a trial can end while the page is open
        return () => { stop = true; clearInterval(t) }
    }, [userId])
    return p
}

const fmt = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const read = (k) => { try { return localStorage.getItem(k) === '1' } catch { return false } }
const save = (k) => { try { localStorage.setItem(k, '1') } catch { } }

// The Pro trial, made hard to miss: its last 3 days (once a day) and its end
// (once) — when, what gets locked, whether the workspace is over a Free limit,
// and that nothing is deleted. The top bar keeps a short reminder after closing.
export default function TrialNotice({ plan: p, userId }) {
    const [, rerender] = useState(0)
    if (!p || p.superadmin || !userId) return null
    const days = p.trial?.daysLeft
    const ended = p.plan === 'FREE' && p.trial?.endedAt
    if (!(days && days <= 3) && !ended) return null

    // closed: the end once per user, the countdown once per day
    const key = ended ? `kz.trialNotice:${userId}:ended:${p.trial.endedAt}` : `kz.trialNotice:${userId}:ending:${new Date().toDateString()}`
    if (read(key)) return null
    const close = () => { save(key); rerender(n => n + 1) }

    const free = p.limitsByPlan?.FREE || { maxClusters: 1, maxNodes: 5, maxMembers: 1 }
    const pro = [...(p.features || []).filter(f => f.plan === 'pro' && f.on), ...(p.capabilities || [])]
    const locking = pro.slice(0, 4).map(f => f.label).join(', ')
    // over a Free limit: what stays and what is blocked
    const over = [['clusters', free.maxClusters, 'cluster'], ['nodes', free.maxNodes, 'node'], ['members', free.maxMembers, 'team member']]
        .filter(([k, max]) => (p.usage?.[k] ?? 0) > max)
        .map(([k, max, one]) => `${p.usage[k]} ${one}s (Free allows ${max})`)

    return (
        <div role="status" className={`mb-6 kz-card p-4 flex flex-wrap items-start gap-3 ${ended ? 'border-amber-400/40 bg-amber-500/[0.07]' : 'border-amber-400/25 bg-amber-500/[0.04]'}`}>
            {ended ? <Sparkles className="w-5 h-5 text-amber-200 mt-0.5 shrink-0" /> : <Hourglass className="w-5 h-5 text-amber-200 mt-0.5 shrink-0" />}
            <div className="flex-1 min-w-[16rem] space-y-1">
                <p className="text-sm font-semibold text-white">
                    {ended ? `Your Pro trial ended on ${fmt(p.trial.endedAt)} — this workspace is on Free now`
                        : `Your Pro trial ends in ${days} day${days === 1 ? '' : 's'} (${fmt(p.trial.endsAt)})`}
                </p>
                <p className="text-xs text-slate-300">
                    {ended ? 'Nothing was deleted: clusters, apps and settings stay and keep running. ' : 'After that the workspace is on Free; nothing is deleted. '}
                    {pro.length > 0 && <>{ended ? 'Locked now' : 'What gets locked'}: {locking}{pro.length > 4 ? ` and ${pro.length - 4} more` : ''}. </>}
                    Free: {free.maxClusters} cluster, {free.maxNodes} nodes, {free.maxMembers} member.
                </p>
                {over.length > 0 && (
                    <p className="text-xs text-amber-100">
                        You {ended ? 'have' : 'will have'} {over.join(', ')} — they keep running, but nothing more can be added until you upgrade.
                    </p>
                )}
            </div>
            <div className="flex items-center gap-2">
                <Link to="/pricing" className="kz-btn-primary !py-1.5 !text-xs"><Sparkles className="w-3.5 h-3.5" /> {ended ? 'Upgrade to Pro' : 'Keep Pro'}</Link>
                <Link to="/pricing" className="kz-btn-ghost !py-1.5 !text-xs">What's in Free</Link>
                <button onClick={close} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5" aria-label="Close"><X className="w-4 h-4" /></button>
            </div>
        </div>
    )
}
