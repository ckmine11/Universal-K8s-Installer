// KubeEZ mark: a hexagon "helm" with an aurora gradient.
export function LogoMark({ className = 'w-9 h-9' }) {
    return (
        <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
            <defs>
                <linearGradient id="kzg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#2ccbee" />
                    <stop offset=".55" stopColor="#6d7cff" />
                    <stop offset="1" stopColor="#a855f7" />
                </linearGradient>
            </defs>
            <path d="M20 2.5 35.2 11.25v17.5L20 37.5 4.8 28.75v-17.5Z" fill="url(#kzg)" />
            <path d="M20 2.5 35.2 11.25v17.5L20 37.5 4.8 28.75v-17.5Z" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="1" />
            <circle cx="20" cy="20" r="5.2" fill="none" stroke="#fff" strokeWidth="2.2" />
            {[0, 60, 120, 180, 240, 300].map(a => (
                <line key={a} x1="20" y1="20" x2={20 + 10.5 * Math.cos((a - 90) * Math.PI / 180)} y2={20 + 10.5 * Math.sin((a - 90) * Math.PI / 180)}
                    stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="0 5.6 6" />
            ))}
        </svg>
    )
}

export function LogoWord({ className = '' }) {
    return (
        <span className={`font-display font-extrabold tracking-tight text-white ${className}`}>
            Kube<span className="aurora-text">EZ</span>
        </span>
    )
}
