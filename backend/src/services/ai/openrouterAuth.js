// "Sign in with OpenRouter": connect a cloud AI without copying an API key.
// OpenRouter's OAuth PKCE flow (openrouter.ai/docs/use-cases/oauth-pkce):
//   1. KubeEZ sends the admin to openrouter.ai/auth with a code challenge
//      (SHA-256 of a secret only KubeEZ keeps) — they sign in there (Google,
//      GitHub or e-mail) and approve
//   2. OpenRouter sends them back with a one-time code (10 minutes)
//   3. KubeEZ trades code + secret for the user's own key, stores it
//      encrypted, and the engine is ready — every model on OpenRouter
//      (Claude, GPT, Gemini, Llama…), billed to the user's OpenRouter account.
import { createHash, randomBytes } from 'crypto'
import { requestJson, AiHttpError } from './http.js'

const OR = () => (process.env.KUBEEZ_OPENROUTER_URL || 'https://openrouter.ai').replace(/\/+$/, '')
export const openRouterApi = () => `${OR()}/api/v1`
const TTL = 10 * 60e3
const pending = new Map()   // state → { orgId, userId, verifier, at }
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const challengeOf = (verifier) => b64url(createHash('sha256').update(verifier).digest())
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

/** Where to send the admin; they come back to <origin>/ai/settings?code=…&state=… */
export function startSignIn(user, origin, { label = 'KubeEZ' } = {}) {
    let o
    try { o = new URL(origin) } catch { throw bad('Unknown address of KubeEZ') }
    if (!['http:', 'https:'].includes(o.protocol)) throw bad('Unknown address of KubeEZ')
    for (const [k, v] of pending) if (Date.now() - v.at > TTL) pending.delete(k)
    if (pending.size > 5000) throw bad('Too many sign-ins in progress — try again in a few minutes', 429)
    const verifier = b64url(randomBytes(48))
    const state = b64url(randomBytes(18))
    pending.set(state, { orgId: user.orgId, userId: user.id, verifier, at: Date.now() })
    const params = new URLSearchParams({ callback_url: `${o.origin}/ai/settings`, code_challenge: challengeOf(verifier), code_challenge_method: 'S256', state, key_label: String(label).slice(0, 60) })
    return { url: `${OR()}/auth?${params}`, state }
}

/** The admin is back with a code: trade it for their key (only the same admin, once, within 10 minutes). */
export async function finishSignIn(user, { code, state }) {
    if (typeof code !== 'string' || !/^[\w.~-]{6,500}$/.test(code)) throw bad('The sign-in did not return a code — try again')
    const p = typeof state === 'string' ? pending.get(state) : null
    if (!p) throw bad('This sign-in is unknown or was already used — start it again from Connect AI')
    pending.delete(state)
    if (p.orgId !== user.orgId || p.userId !== user.id) throw bad('This sign-in was started by someone else', 403)
    if (Date.now() - p.at > TTL) throw bad('The sign-in took longer than 10 minutes — start it again')
    let r
    try {
        r = await requestJson('POST', `${openRouterApi()}/auth/keys`, { code, code_verifier: p.verifier, code_challenge_method: 'S256' }, { timeoutMs: 20000 })
    } catch (e) {
        throw new AiHttpError([400, 403].includes(e.status) ? 'OpenRouter did not accept the sign-in (it expired or was cancelled) — try again' : `OpenRouter: ${e.message}`, { status: 400 })
    }
    if (typeof r?.key !== 'string' || r.key.length < 10) throw bad('OpenRouter did not return a key — try again')
    return r.key
}
export function _resetSignIns() { pending.clear() }
