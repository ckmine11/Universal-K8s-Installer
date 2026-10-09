import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * A small menu that opens next to its button and is drawn above the whole
 * page (portal), so cards, scroll areas or the page edge can never cut it
 * off. Opens downward, flips up when there is no room; closes on an outside
 * click, Esc, scroll or resize.
 *
 *   <Popover button={(p) => <button {...p}>…</button>} width={224}>
 *     {(close) => <button onClick={() => { close(); … }}>Item</button>}
 *   </Popover>
 */
export default function Popover({ button, children, width = 224, align = 'right' }) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState(null)
    const anchor = useRef(null)
    const panel = useRef(null)
    const close = () => setOpen(false)

    const place = () => {
        const r = anchor.current?.getBoundingClientRect()
        if (!r) return
        const h = panel.current?.offsetHeight || 180
        const below = window.innerHeight - r.bottom
        const top = below < h + 12 && r.top > h + 12 ? r.top - h - 6 : r.bottom + 6
        let left = align === 'right' ? r.right - width : r.left
        left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
        setPos({ top, left })
    }
    useLayoutEffect(() => { if (open) place() }, [open])
    useEffect(() => {
        if (!open) return
        const onDown = (e) => { if (!panel.current?.contains(e.target) && !anchor.current?.contains(e.target)) close() }
        const onKey = (e) => { if (e.key === 'Escape') close() }
        const onMove = () => close()
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('resize', onMove)
            window.removeEventListener('scroll', onMove, true)
        }
    }, [open])

    return (
        <>
            <span ref={anchor} className="inline-flex">
                {button({ onClick: (e) => { e.stopPropagation(); setOpen(o => !o) }, 'aria-expanded': open, 'aria-haspopup': 'menu' })}
            </span>
            {open && createPortal(
                <div ref={panel} role="menu" onClick={(e) => e.stopPropagation()}
                    style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, zIndex: 120 }}
                    className="kz-card !rounded-xl p-1.5 kz-rise shadow-2xl">
                    {children(close)}
                </div>,
                document.body)}
        </>
    )
}
