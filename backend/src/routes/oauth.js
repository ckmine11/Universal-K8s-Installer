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

// Enterprise single sign-on with any OpenID Connect provider (Keycloak, Azure AD /
// Entra ID, Okta, Google Workspace, Dex…). People join one workspace with the role
// their groups give:
//   OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET   (required)
//   OIDC_NAME            button label (default "SSO")
//   OIDC_SCOPES          default "openid email profile"
//   OIDC_GROUPS_CLAIM    default "groups"
//   OIDC_ROLE_MAP        "kubeez-admins=admin,platform=operator,dev=viewer" (* = everyone)
//   OIDC_DEFAULT_ROLE    when no group matches: none (default — no access) | viewer | operator
//   OIDC_WORKSPACE       the workspace (orgId); self-hosted: the server's workspace by default
PROVIDERS.oidc = {
    get name() { return process.env.OIDC_NAME || 'SSO' },
    keys: () => [process.env.OIDC_CLIENT_ID, process.env.OIDC_CLIENT_SECRET, process.env.OIDC_ISSUER],
    discovery: true,
    get scope() { return process.env.OIDC_SCOPES || 'openid email profile' },
    pkce: true,
    async profile(tokens, ep) {
        const claims = { ...idTokenClaims(tokens.id_token), ...(ep.userinfo ? await getJson(ep.userinfo, tokens.access_token) : {}) }
        const raw = claims[process.env.OIDC_GROUPS_CLAIM || 'groups']
        const groups = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : []).map(String).filter(Boolean)
        return { subject: claims.sub, email: claims.email_verified === false ? null : claims.email || null, name: claims.preferred_username || claims.name, groups }
    }
}

// the ID token comes straight from the provider's token endpoint over TLS
// (OIDC Core 3.1.3.7) — its audience and issuer are still checked
function idTokenClaims(jwt) {
    if (!jwt) return {}
    let c
    try { c = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')) } catch { return {} }
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud]
    if (!aud.includes(process.env.OIDC_CLIENT_ID) || String(c.iss || '').replace(/\/+$/, '') !== issuer()) throw Object.assign(new Error('The identity provider sent a token for another application.'), { code: 'TOKEN' })
    return c
}
const issuer = () => String(process.env.OIDC_ISSUER || '').replace(/\/+$/, '')

const RANK = { none: 0, viewer: 1, operator: 2, admin: 3 }
/** The KubeEZ role for these identity-provider groups (the highest one that matches). */
export function ssoRole(groups = [], env = process.env) {
    let best = null
    for (const part of String(env.OIDC_ROLE_MAP || '').split(',').map(s => s.trim()).filter(Boolean)) {
        const i = part.lastIndexOf('=')
        const [g, r] = [part.slice(0, i).trim(), part.slice(i + 1).trim().toLowerCase()]
        if (i > 0 && RANK[r] && (g === '*' || groups.includes(g)) && (!best || RANK[r] > RANK[best])) best = r
    }
    if (best) return best
    const d = String(env.OIDC_DEFAULT_ROLE || 'none').toLowerCase()
    return ['viewer', 'operator'].includes(d) ? d : 'none'
}
/** The workspace single sign-on signs into. */
export function ssoWorkspace() {
    if (process.env.OIDC_WORKSPACE) return process.env.OIDC_WORKSPACE
    if (process.env.KUBEEZ_MODE === 'saas') return null   // a SaaS server has many workspaces: it must be named
    // self-hosted: the workspace of the account made on the first screen (superadmin), else the first admin's
    const users = authService.users || []
    return (users.find(u => u.role === 'superadmin' && u.orgId) || users.find(u => u.role === 'admin' && u.orgId))?.orgId || null
}

const discovered = { at: 0, value: null }
async function endpoints(cfg) {
    if (!cfg.discovery) return { authorize: cfg.authorize, token: cfg.token }
    if (discovered.value && discovered.iss === issuer() && Date.now() - discovered.at < 3600e3) return discovered.value
    const r = await fetch(at(`${issuer()}/.well-known/openid-configuration`), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.authorization_endpoint || !d.token_endpoint) throw Object.assign(new Error('The identity provider could not be reached (OIDC discovery).'), { code: 'PROVIDER' })
    if (String(d.issuer || '').replace(/\/+$/, '') !== issuer()) throw Object.assign(new Error('The identity provider names another issuer than OIDC_ISSUER.'), { code: 'PROVIDER' })
    const value = { authorize: d.authorization_endpoint, token: d.token_endpoint, userinfo: d.userinfo_endpoint || null }
    Object.assign(discovered, { at: Date.now(), iss: issuer(), value })
    return value
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

router.get('/:provider/start', async (req, res) => {
    const p = req.params.provider
    const cfg = PROVIDERS[p]
    if (!cfg || !oauthProviders().includes(p)) return res.status(404).json({ error: 'This sign-in option is not set up on this server.' })
    let ep
    try { ep = await endpoints(cfg) } catch (e) { return fail(req, res, e.code || 'PROVIDER', e.message) }
    const state = b64url(crypto.randomBytes(24))
    const verifier = cfg.pkce ? b64url(crypto.randomBytes(32)) : ''
    // lax: the provider's redirect back is a top-level GET, so the cookie comes along
    res.cookie(COOKIE, `${p}.${state}.${verifier}`, { ...cookieOpts, maxAge: 10 * 60 * 1000 })
    const q = new URLSearchParams({ client_id: cfg.keys()[0], redirect_uri: callbackUrl(req, p), response_type: 'code', scope: cfg.scope, state })
    if (cfg.pkce) { q.set('code_challenge', b64url(crypto.createHash('sha256').update(verifier).digest())); q.set('code_challenge_method', 'S256'); if (p === 'google') q.set('prompt', 'select_account') }
    else q.set('allow_signup', 'true')
    res.redirect(`${ep.authorize}${ep.authorize.includes('?') ? '&' : '?'}${q}`)
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
        const ep = await endpoints(cfg)
        const body = new URLSearchParams({ client_id: id, client_secret: secret, code: String(req.query.code || ''), redirect_uri: callbackUrl(req, p), grant_type: 'authorization_code', ...(cfg.pkce ? { code_verifier: verifier } : {}) })
        const tr = await fetch(at(ep.token), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(15000) })
        const tokens = await tr.json().catch(() => ({}))
        if (!tr.ok || !tokens.access_token) return fail(req, res, 'TOKEN', `${cfg.name} did not accept the sign-in — please try again.`)
        const prof = await cfg.profile(tokens, ep)
        if (!prof.subject) return fail(req, res, 'PROFILE', `${cfg.name} did not send your account.`)
        if (!prof.email) return fail(req, res, 'NO_EMAIL', `Your ${cfg.name} account has no verified email address — verify one with ${cfg.name}, or sign up with email.`)
        let token, detail = `with ${cfg.name}`
        if (p === 'oidc') {
            const role = ssoRole(prof.groups)
            token = await authService.signInWithSso({ provider: p, subject: prof.subject, email: prof.email, name: prof.name, orgId: ssoWorkspace(), role })
            detail = `with ${cfg.name} (single sign-on) as ${role}${prof.groups.length ? `, groups ${prof.groups.slice(0, 10).join(', ')}` : ''}`
        } else {
            const { signupOpen } = await import('../utils/signup.js')
            token = await authService.signInWithProvider({ provider: p, subject: prof.subject, email: prof.email, name: prof.name }, { allowSignup: signupOpen() })
        }
        const who = authService.verifyToken(token)
        auditLog.record({ orgId: who?.orgId || null, actor: who, ip: req.ip, action: 'auth.login', detail })
        res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 24 * 60 * 60 * 1000 })
        res.redirect(`${baseUrl(req)}/?signed_in=1`)
    } catch (e) {
        fail(req, res, e.code || 'FAILED', e.code ? e.message : `${cfg.name} sign-in failed — please try again.`)
    }
})

export default router
