// One page header look for every page: icon tile, eyebrow, title, description.

export function PageTitle({ eyebrow, title, description, icon: Icon, children }) {
    return (
        <div className="flex items-start gap-4 min-w-0">
            {Icon && (
                <div className="relative shrink-0 hidden sm:flex w-12 h-12 items-center justify-center rounded-2xl border border-white/10 bg-[#121218] shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_10px_30px_-10px_rgba(128,105,251,.55)]">
                    <span className="absolute inset-0 rounded-2xl bg-gradient-to-br from-blue-500/25 via-transparent to-sky-400/15" />
                    <Icon className="relative w-[22px] h-[22px] text-blue-200" />
                </div>
            )}
            <div className="min-w-0">
                {eyebrow && <div className="mb-1.5 kz-eyebrow">{eyebrow}</div>}
                <h1 className="font-display text-2xl sm:text-[30px] font-semibold tracking-[-0.03em] gradient-text leading-tight">{title}</h1>
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
