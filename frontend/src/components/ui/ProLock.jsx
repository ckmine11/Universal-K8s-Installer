import { Link } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { featureLabel } from '../../config/features'

// A Pro feature on a Free workspace: shown, with what it does and the way to
// get it — instead of loading it (the server would answer 402).
export default function ProLock({ feature, title, children, compact = false }) {
    return (
        <div className={`kz-card ${compact ? 'p-3' : 'p-5'} flex flex-wrap items-center gap-3 border-amber-400/20`}>
            <Sparkles className="w-4 h-4 text-amber-200 shrink-0" />
            <div className="flex-1 min-w-[12rem]">
                <p className="text-sm font-semibold text-white">{title || featureLabel(feature)} <span className="ml-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-200">Pro</span></p>
                {children && <p className="mt-0.5 text-xs text-slate-400">{children}</p>}
            </div>
            <Link to="/pricing" className="kz-btn-primary !py-1.5 !text-xs">Upgrade to Pro</Link>
        </div>
    )
}
