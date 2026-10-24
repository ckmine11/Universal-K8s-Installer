import { useEffect, useRef } from 'react'

// Cloudflare Turnstile — the "I am human" check on public forms, shown only
// when the server has it on (/api/auth/options → captchaSiteKey). A token is
// good for one try: remount (change `key`) after each submit for a fresh one.
const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading = null
function loadScript() {
    if (window.turnstile) return Promise.resolve(window.turnstile)
    loading ||= new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = SRC; s.async = true
        s.onload = () => resolve(window.turnstile)
        s.onerror = () => { loading = null; reject(new Error('Could not load the human check')) }
        document.head.appendChild(s)
    })
    return loading
}

export default function Turnstile({ siteKey, onToken }) {
    const box = useRef(null)
    const cb = useRef(onToken)
    cb.current = onToken
    useEffect(() => {
        let id = null, gone = false
        loadScript().then(t => {
            if (gone || !box.current) return
            id = t.render(box.current, {
                sitekey: siteKey, theme: 'dark',
                callback: (token) => cb.current(token),
                'expired-callback': () => cb.current(''),
                'error-callback': () => cb.current('')
            })
        }).catch(() => cb.current(''))
        return () => { gone = true; if (id != null) try { window.turnstile.remove(id) } catch { } }
    }, [siteKey])
    return <div ref={box} className="flex justify-center min-h-[65px]" />
}
