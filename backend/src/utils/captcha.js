// Bot protection for the public forms (sign-up, forgot password): Cloudflare
// Turnstile, on when both keys are set —
//   TURNSTILE_SITE_KEY    shown to the login page
//   TURNSTILE_SECRET_KEY  checks the answer with Cloudflare
// Off (no keys): the forms work as before, behind the per-IP rate limits.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export const captchaSiteKey = () => (process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY) ? process.env.TURNSTILE_SITE_KEY : null

/** true when the form may go ahead (CAPTCHA off, or solved). */
export async function captchaOk(token, ip) {
    if (!captchaSiteKey()) return true
    if (typeof token !== 'string' || !token || token.length > 2048) return false
    try {
        const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) })
        const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(10000) })
        const d = await r.json()
        return d?.success === true
    } catch (e) {
        console.error('CAPTCHA check failed:', e.message)
        return false   // closed: an unreachable check never waves a bot through
    }
}

/** Express middleware for a public form. */
export const requireCaptcha = async (req, res, next) => {
    if (await captchaOk(req.body?.captchaToken, req.ip)) return next()
    res.status(400).json({ error: 'Please complete the "I am human" check and try again.', code: 'CAPTCHA' })
}
