// "Continue with Google / GitHub" — plain links to the server, which runs the
// provider sign-in and comes back to the console. Shown only for the
// providers this server has keys for.
const GoogleMark = () => (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" aria-hidden="true">
        <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.56-5.17 3.56-8.81Z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z" />
        <path fill="#FBBC05" d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.8.14-1.57.38-2.29V6.6H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.4l4.01-3.11Z" />
        <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.94 11.94 0 0 0 12 0 12 12 0 0 0 1.28 6.6l4.01 3.11C6.23 6.86 8.88 4.75 12 4.75Z" />
    </svg>
)
const GitHubMark = () => (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="currentColor" aria-hidden="true">
        <path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 20.95c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.62-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3Z" />
    </svg>
)
const KeyMark = () => (
    <svg viewBox="0 0 24 24" className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2" />
    </svg>
)
const PROVIDERS = { google: { name: 'Google', Mark: GoogleMark }, github: { name: 'GitHub', Mark: GitHubMark }, oidc: { name: 'SSO', Mark: KeyMark } }

// ssoName: what the server calls its single sign-on (OIDC_NAME), e.g. "Acme SSO"
export default function OAuthButtons({ providers, verb = 'Continue', ssoName = 'SSO' }) {
    const list = providers.filter(p => PROVIDERS[p]).sort((a, b) => (a === 'oidc' ? -1 : b === 'oidc' ? 1 : 0))
    if (!list.length) return null
    return (
        <div className="relative z-10 mb-6">
            <div className="grid gap-2.5">
                {list.map(p => {
                    const { Mark } = PROVIDERS[p]
                    const name = p === 'oidc' ? ssoName : PROVIDERS[p].name
                    return (
                        <a key={p} href={`/api/auth/oauth/${p}/start`}
                            className="flex items-center justify-center gap-2.5 whitespace-nowrap rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.08] hover:border-white/20">
                            <Mark /> {verb} with {name}
                        </a>
                    )
                })}
            </div>
            <div className="mt-6 flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-slate-500" aria-hidden="true">
                <span className="h-px flex-1 bg-white/10" />or with email<span className="h-px flex-1 bg-white/10" />
            </div>
        </div>
    )
}
