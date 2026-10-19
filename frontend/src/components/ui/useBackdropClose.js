import { useEffect, useRef } from 'react'

// Closing a dialog by clicking its backdrop — without the accidents:
// - a double-click (or a touchpad's double tap) on the button that opened the
//   dialog lands its second click on the new backdrop; clicks in the first
//   moments after opening are ignored
// - a drag that starts inside the dialog (selecting text) and ends on the
//   backdrop does not close it: the press must start on the backdrop
// Escape closes it too. Spread the result on the backdrop element.
// keepOpen: () => true while the dialog holds typed input — then only its own
// Cancel closes it (an Escape meant for a browser's password / autofill popup,
// or a stray click, must not throw away what was typed)
export default function useBackdropClose(onClose, { guardMs = 450, escape = true, keepOpen = null } = {}) {
    const openedAt = useRef(Date.now())
    const pressedOnBackdrop = useRef(false)
    const close = useRef(onClose)
    close.current = onClose
    const keep = useRef(keepOpen)
    keep.current = keepOpen

    useEffect(() => {
        if (!escape) return
        const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !keep.current?.()) close.current?.() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [escape])

    return {
        onMouseDown: (e) => { pressedOnBackdrop.current = e.target === e.currentTarget },
        onClick: (e) => {
            if (e.target !== e.currentTarget) return
            if (!pressedOnBackdrop.current) return
            if (Date.now() - openedAt.current < guardMs) return
            if (keep.current?.()) return
            close.current?.()
        }
    }
}
