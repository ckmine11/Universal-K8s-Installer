import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, X } from 'lucide-react'

// "Upgrade your plan" — shown when the server answers 402 UPGRADE_REQUIRED
// for a feature outside the workspace's plan (apiFetch sends the event).
export default function UpgradeNotice() {
    const [notice, setNotice] = useState(null)
    useEffect(() => {
        const on = (e) => setNotice(e.detail)
        window.addEventListener('kubeez:upgrade', on)
        return () => window.removeEventListener('kubeez:upgrade', on)
    }, [])
    if (!notice) return null
    return (
        <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-2xl border border-amber-400/30 bg-[#16161b] p-4 shadow-2xl space-y-2">
            <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-amber-200 mt-0.5 shrink-0" />
                <p className="flex-1 text-sm text-slate-100">{notice.error}</p>
                <button onClick={() => setNotice(null)} aria-label="Close"><X className="w-4 h-4 text-slate-400" /></button>
            </div>
            <Link to="/pricing" onClick={() => setNotice(null)} className="kz-btn-primary !py-1.5 !text-xs inline-flex">See {notice.plan === 'ENTERPRISE' ? 'Enterprise' : 'Pro'} plans</Link>
        </div>
    )
}
