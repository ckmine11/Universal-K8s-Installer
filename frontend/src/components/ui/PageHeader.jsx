// One page header look for every page: icon tile, eyebrow, title, description.

export function PageTitle({ eyebrow, title, description, icon: Icon, children }) {
    return (
        <div className="flex items-start gap-4 min-w-0">
            {Icon && (
                <div className="relative shrink-0 hidden sm:flex w-10 h-10 items-center justify-center rounded-xl border border-white/[0.09] bg-[#141518] shadow-[inset_0_1px_0_rgba(255,255,255,.06)]">
                    <Icon className="relative w-[18px] h-[18px] text-slate-200" />
                </div>
            )}
            <div className="min-w-0">
                {eyebrow && <div className="mb-1.5 kz-eyebrow">{eyebrow}</div>}
                <h1 className="font-display text-2xl sm:text-[28px] font-semibold tracking-[-0.025em] text-white leading-tight">{title}</h1>
                {description && <p className="mt-1.5 max-w-2xl text-sm text-slate-400 leading-relaxed">{description}</p>}
                {children}
            </div>
        </div>
    )
}

export default function PageHeader({ actions, ...title }) {
    return (
        <div className="relative mb-8 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <PageTitle {...title} />
            {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
        </div>
    )
}
