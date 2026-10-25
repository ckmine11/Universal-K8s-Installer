// Sign in with Google / GitHub — the authorization-code flow, no SDK.
//   GET /api/auth/oauth/:provider/start     → to the provider (state + PKCE)
//   GET /api/auth/oauth/:provider/callback  ← back: check state, swap the code,
//        read the verified email, sign in (or open a workspace) → the console
// A provider appears only when its keys are set:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
// Its callback URL is <KUBEEZ_PUBLIC_URL>/api/auth/oauth/<provider>/callback.
import express from 'express'
import crypto from 'crypto'
import { authService } from '../services/authService.js'
import { auditLog } from '../services/auditLog.js'

const router = express.Router()

const PROVIDERS = {
    google: {
        name: 'Google',
        keys: () => [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET],
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        scope: 'openid email profile',
        pkce: true,
        async profile(tokens) {
            const u = await getJson('https://openidconnect.googleapis.com/v1/userinfo', tokens.access_token)
            return { subject: u.sub, email: u.email_verified ? u.email : null, name: u.name || u.given_name }
        }
    },
    github: {
        name: 'GitHub',
        keys: () => [process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET],
        authorize: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        scope: 'read:user user:email',
        pkce: false,
        async profile(tokens) {
            const u = await getJson('https://api.github.com/user', tokens.access_token)
            // the primary, verified address (the profile email may be hidden or unverified)
            const emails = await getJson('https://api.github.com/user/emails', tokens.access_token)
            const primary = (Array.isArray(emails) ? emails : []).find(e => e.primary && e.verified)
            return { subject: u.id, email: primary?.email || null, name: u.login }
        }
    }
}

export const oauthProviders = () => Object.keys(PROVIDERS).filter(p => PROVIDERS[p].keys().every(Boolean))

// tests only: send the provider calls to a local fake
const at = (url) => (process.env.NODE_ENV === 'test' && process.env.KUBEEZ_OAUTH_TEST_BASE ? url.replace(/^https:\/\//, `${process.env.KUBEEZ_OAUTH_TEST_BASE}/`) : url)

async function getJson(url, accessToken) {
    const r = await fetch(at(url), { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'KubeEZ' }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw Object.assign(new Error(`The provider refused the profile request (HTTP ${r.status}).`), { code: 'PROVIDER' })
    return r.json()
}

const COOKIE = 'kz_oauth'
const b64url = (b) => Buffer.from(b).toString('base64url')
const baseUrl = (req) => (process.env.KUBEEZ_PUBLIC_URL || `${req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`).replace(/\/+$/, '')
const callbackUrl = (req, p) => `${baseUrl(req)}/api/auth/oauth/${p}/callback`
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/auth/oauth' }
// back to the sign-in page with a message
const fail = (req, res, code, message) => {
    res.clearCookie(COOKIE, cookieOpts)
    res.redirect(`${baseUrl(req)}/login?oauth_error=${encodeURIComponent(code)}&message=${encodeURIComponent(message)}`)
}

router.get('/:provider/start', (req, res) => {
    const p = req.params.provider
    const cfg = PROVIDERS[p]
    if (!cfg || !oauthProviders().includes(p)) return res.status(404).json({ error: 'This sign-in option is not set up on this server.' })
    const state = b64url(crypto.randomBytes(24))
    const verifier = cfg.pkce ? b64url(crypto.randomBytes(32)) : ''
    // lax: the provider's redirect back is a top-level GET, so the cookie comes along
    res.cookie(COOKIE, `${p}.${state}.${verifier}`, { ...cookieOpts, maxAge: 10 * 60 * 1000 })
    const q = new URLSearchParams({ client_id: cfg.keys()[0], redirect_uri: callbackUrl(req, p), response_type: 'code', scope: cfg.scope, state })
    if (cfg.pkce) { q.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest())); q.set('code_challenge_method', 'S256'); q.set('prompt', 'select_account') }
    else q.set('allow_signup', 'true')
    res.redirect(`${cfg.authorize}?${q}`)
})

router.get('/:provider/callback', async (req, res) => {
    const p = req.params.provider
    const cfg = PROVIDERS[p]
    if (!cfg || !oauthProviders().includes(p)) return fail(req, res, 'NOT_SET_UP', 'This sign-in option is not set up on this server.')
    if (req.query.error) return fail(req, res, 'CANCELLED', `${cfg.name} sign-in was cancelled.`)
    const [cp, cstate, verifier] = String(req.cookies?.[COOKIE] || '').split('.')
    const given = Buffer.from(String(req.query.state || ''))
    const want = Buffer.from(String(cstate || ''))
    if (cp !== p || !cstate || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return fail(req, res, 'STATE', 'The sign-in link expired or was opened in another browser — please try again.')
    }
    res.clearCookie(COOKIE, cookieOpts)
    try {
        const [id, secret] = cfg.keys()
        const body = new URLSearchParams({ client_id: id, client_secret: secret, code: String(req.query.code || ''), redirect_uri: callbackUrl(req, p), grant_type: 'authorization_code', ...(cfg.pkce ? { code_verifier: verifier } : {}) })
        const tr = await fetch(at(cfg.token), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15000) })
        const tokens = await tr.json().catch(() => ({}))
        if (!tr.ok || !tokens.access_token) return fail(req, res, 'TOKEN', `${cfg.name} did not accept the sign-in — please try again.`)
        const prof = await cfg.profile(tokens)
        if (!prof.subject) return fail(req, res, 'PROFILE', `${cfg.name} did not send your account.`)
        if (!prof.email) return fail(req, res, 'NO_EMAIL', `Your ${cfg.name} account has no verified email address — verify one with ${cfg.name}, or sign up with email.`)
        const { signupOpen } = await import('../utils/signup.js')
        const token = await authService.signInWithProvider({ provider: p, subject: prof.subject, email: prof.email, name: prof.name }, { allowSignup: signupOpen() })
        const who = authService.verifyToken(token)
        auditLog.record({ orgId: who?.orgId || null, actor: who, ip: req.ip, action: 'auth.login', detail: `with ${cfg.name}` })
        res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 })
        res.redirect(`${baseUrl(req)}/?signed_in=1`)
    } catch (e) {
        fail(req, res, e.code || 'FAILED', e.code ? e.message : `${cfg.name} sign-in failed — please try again.`)
    }
})

export default router
