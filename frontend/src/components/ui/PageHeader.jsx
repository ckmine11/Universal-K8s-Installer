// One page header for every page: eyebrow, title, description, actions.
export default function PageHeader({ eyebrow, title, description, icon: Icon, actions, children }) {
    return (
        <div className="relative mb-8 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div className="flex items-start gap-4 min-w-0">
                {Icon && (
                    <div className="relative shrink-0 hidden sm:flex w-12 h-12 items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-blue-500/20 via-indigo-500/10 to-violet-500/20 shadow-glow">
                        <Icon className="w-6 h-6 text-blue-200" />
                    </div>
                )}
                <div className="min-w-0">
                    {eyebrow && <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.22em] text-blue-300/80">{eyebrow}</div>}
                    <h1 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">{title}</h1>
                    {description && <p className="mt-1.5 max-w-2xl text-sm text-slate-400 leading-relaxed">{description}</p>}
                    {children}
                </div>
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
        </div>
    )
}
