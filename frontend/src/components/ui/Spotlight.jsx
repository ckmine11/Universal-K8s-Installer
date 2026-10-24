import { useRef } from 'react'

// A solid card with a soft light that follows the pointer, and a matching
// glow on its border. CSS only (two custom properties), so it is cheap enough
// to use for every card in the console.
export default function SpotlightCard({ as: Tag = 'div', className = '', color = '128,105,251', children, ...rest }) {
    const ref = useRef(null)
    const move = (e) => {
        const el = ref.current
        if (!el) return
        const r = el.getBoundingClientRect()
        el.style.setProperty('--sx', `${e.clientX - r.left}px`)
        el.style.setProperty('--sy', `${e.clientY - r.top}px`)
    }
    return (
        <Tag ref={ref} onPointerMove={move}
            className={`group/spot relative overflow-hidden rounded-2xl border border-white/[0.075] bg-[#0f1012] shadow-[inset_0_1px_0_rgba(255,255,255,.05)] transition-colors duration-300 hover:border-white/[0.12] ${className}`}
            {...rest}>
            {/* light inside the card */}
            <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover/spot:opacity-100"
                style={{ background: `radial-gradient(420px circle at var(--sx, 50%) var(--sy, 0%), rgba(${color},.08), transparent 60%)` }} />
            {/* light on the border */}
            <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-500 group-hover/spot:opacity-100"
                style={{
                    padding: 1,
                    background: `radial-gradient(260px circle at var(--sx, 50%) var(--sy, 0%), rgba(${color},.5), transparent 60%)`,
                    WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                    WebkitMaskComposite: 'xor', maskComposite: 'exclude'
                }} />
            <div className="relative">{children}</div>
        </Tag>
    )
}
