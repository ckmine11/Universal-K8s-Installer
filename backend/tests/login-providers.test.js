// Sign-up email confirmation and "Continue with Google / GitHub", against the
// real server. A fake SMTP server catches the codes; a fake provider speaks
// Google's and GitHub's OAuth endpoints (and checks the PKCE proof).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import { startServer, client } from './helpers/server.js'

// ── fake SMTP ──
const mails = []
let smtp
const smtpEnv = () => ({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_USER: 'kubeez@example.com', SMTP_PASS: 'x', EMAIL_FROM: 'KubeEZ <kubeez@example.com>' })
const codeFor = (to) => { const m = [...mails].reverse().find(x => x.includes(to)); return m && (m.replace(/=\r?\n/g, '').match(/confirmation code is: (\d{6})/) || [])[1] }
const waitCode = async (to) => { for (let i = 0; i < 50; i++) { const c = codeFor(to); if (c) return c; await new Promise(r => setTimeout(r, 100)) } return null }

// ── fake Google + GitHub ──
const people = {
    googleCode: { sub: 'g-111', email: 'gina@example.com', email_verified: true, name: 'Gina Rao' },
    githubCode: { id: 4242, login: 'octo-alice', emails: [{ email: 'alice@example.com', primary: true, verified: true }] },
    githubNoMail: { id: 77, login: 'nomail', emails: [{ email: 'x@example.com', primary: true, verified: false }] }
}
const challenges = new Map()   // state → PKCE challenge, as Google would remember it
let provider
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

before(async () => {
    smtp = net.createServer((sock) => {
        let data = false, buf = '', msg = ''
        const say = (l) => sock.write(l + '\r\n')
        say('220 test ESMTP')
        sock.on('data', (chunk) => {
            buf += chunk
            let i
            while ((i = buf.indexOf('\r\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 2)
                if (data) { if (line === '.') { data = false; mails.push(msg); msg = ''; say('250 queued') } else msg += line + '\n'; continue }
                const cmd = line.slice(0, 4).toUpperCase()
                if (cmd === 'EHLO') sock.write('250-test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n')
                else if (cmd === 'AUTH') say('235 ok')
                else if (cmd === 'DATA') { data = true; say('354 go') }
                else if (cmd === 'QUIT') { say('221 bye'); sock.end() }
                else say('250 ok')
            }
        })
        sock.on('error', () => { })
    })
    await new Promise(r => smtp.listen(0, '127.0.0.1', r))

    provider = http.createServer((req, res) => {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
            const [, host, ...rest] = req.url.split('/')
            const path = '/' + rest.join('/').split('?')[0]
            const auth = String(req.headers.authorization || '').replace(/^Bearer /, '')
            if (host === 'oauth2.googleapis.com' && path === '/token') {
                const q = new URLSearchParams(body)
                const challenge = challenges.get(q.get('code'))
                const proof = crypto.createHash('sha256').update(q.get('code_verifier') || '').digest('base64url')
                if (q.get('client_secret') !== 'g-secret' || !people[q.get('code')] || !challenge || proof !== challenge) return json(res, 400, { error: 'invalid_grant' })
                return json(res, 200, { access_token: `g:${q.get('code')}` })
            }
            if (host === 'openidconnect.googleapis.com') return json(res, 200, people[auth.slice(2)] || {})
            if (host === 'github.com' && path === '/login/oauth/access_token') {
                const q = new URLSearchParams(body)
                if (q.get('client_secret') !== 'gh-secret') return json(res, 401, { error: 'bad_verification_code' })
                return json(res, 200, { access_token: `gh:${q.get('code')}` })
            }
            const who = people[auth.slice(3)]
            if (host === 'api.github.com' && path === '/user') return json(res, 200, { id: who.id, login: who.login })
            if (host === 'api.github.com' && path === '/user/emails') return json(res, 200, who.emails)
            json(res, 404, {})
        })
    })
    await new Promise(r => provider.listen(0, '127.0.0.1', r))
})
after(() => { smtp.close(); provider.close() })

const OAUTH_ENV = () => ({ GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', KUBEEZ_OAUTH_TEST_BASE: `http://127.0.0.1:${provider.address().port}` })

// run one provider sign-in: start → (the provider) → callback with `code`
async function signInWith(srv, p, code, { tamperState = false } = {}) {
    const start = await fetch(`${srv.url}/api/auth/oauth/${p}/start`, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const to = new URL(start.headers.get('location'))
    const cookie = start.headers.getSetCookie().find(c => c.startsWith('kz_oauth=')).split(';')[0]
    const state = to.searchParams.get('state')
    if (p === 'google') { assert.equal(to.searchParams.get('code_challenge_method'), 'S256'); challenges.set(code, to.searchParams.get('code_challenge')) }
    assert.equal(to.searchParams.get('redirect_uri'), `${srv.url}/api/auth/oauth/${p}/callback`)
    const back = await fetch(`${srv.url}/api/auth/oauth/${p}/callback?code=${code}&state=${tamperState ? 'forged' + state.slice(6) : state}`, { headers: { cookie }, redirect: 'manual' })
    assert.equal(back.status, 302)
    const session = back.headers.getSetCookie().find(c => c.startsWith('token='))
    return { location: back.headers.get('location'), token: session ? decodeURIComponent(session.split(';')[0].slice(6)) : null }
}

test('password sign-up confirms its email first: no session until the code; login says so', async () => {
    const srv = await startServer(smtpEnv())
    const api = client(srv)
    try {
        const r = await api('POST', '/api/auth/register', null, { username: 'vera', password: 'verapass12', email: 'vera@example.com' })
        assert.equal(r.status, 200)
        assert.equal(r.data.verificationRequired, true); assert.equal(r.data.token, undefined)
        assert.equal(r.data.email, 'v••••@example.com')
        const code = await waitCode('vera@example.com')
        assert.match(code, /^\d{6}$/)

        const early = await api('POST', '/api/auth/login', null, { username: 'vera', password: 'verapass12' })
        assert.equal(early.status, 403); assert.equal(early.data.code, 'EMAIL_UNVERIFIED')
        assert.equal((await api('POST', '/api/auth/login', null, { username: 'vera', password: 'wrong-pass' })).status, 401, 'a wrong password does not reveal the state')

        const wrong = await api('POST', '/api/auth/verify-email', null, { identifier: 'vera', code: code === '000000' ? '111111' : '000000' })
        assert.equal(wrong.status, 400); assert.equal(wrong.data.attemptsLeft, 4)
        const ok = await api('POST', '/api/auth/verify-email', null, { identifier: 'vera', code: await waitCode('vera@example.com') })
        assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.ok(ok.data.token); assert.equal(ok.data.user.role, 'admin')
        assert.equal((await api('POST', '/api/auth/login', null, { username: 'vera', password: 'verapass12' })).status, 200)
        assert.equal((await api('POST', '/api/auth/verify-email', null, { identifier: 'vera', code })).status, 400, 'a used code is gone')
    } finally { await srv.stop() }
})

test('without email set up, sign-up works as before (no confirmation step)', async () => {
    const srv = await startServer()
    try {
        const r = await client(srv)('POST', '/api/auth/register', null, { username: 'noemail', password: 'noemailpass1', email: 'n@example.com' })
        assert.equal(r.status, 200); assert.ok(r.data.token); assert.equal(r.data.verificationRequired, undefined)
    } finally { await srv.stop() }
})

test('Continue with Google / GitHub: new workspace, same account again, linking, refusals', async () => {
    const srv = await startServer({ ...OAUTH_ENV() })
    const api = client(srv)
    try {
        assert.deepEqual((await api('GET', '/api/auth/options')).data.oauth, ['google', 'github'])

        // Google, first time: a new workspace, signed in
        const g = await signInWith(srv, 'google', 'googleCode')
        assert.equal(g.location, `${srv.url}/?signed_in=1`)
        const me = await api('GET', '/api/auth/me', g.token)
        assert.equal(me.status, 200); assert.equal(me.data.email, 'gina@example.com'); assert.equal(me.data.role, 'admin'); assert.equal(me.data.username, 'gina-rao')
        // and again: the same account
        const g2 = await signInWith(srv, 'google', 'googleCode')
        assert.equal((await api('GET', '/api/auth/me', g2.token)).data.id, me.data.id)

        // GitHub with the email of a password account: linked to it, not a second account
        const alice = (await api('POST', '/api/auth/register', null, { username: 'alice', password: 'alicepass12', email: 'alice@example.com' })).data
        const gh = await signInWith(srv, 'github', 'githubCode')
        assert.equal((await api('GET', '/api/auth/me', gh.token)).data.id, alice.user.id)
        assert.equal((await api('POST', '/api/auth/login', null, { username: 'alice', password: 'alicepass12' })).status, 200, 'the password still works')

        // refusals come back to the sign-in page with a reason
        const forged = await signInWith(srv, 'github', 'githubCode', { tamperState: true })
        assert.match(forged.location, /\/login\?oauth_error=STATE/); assert.equal(forged.token, null)
        const noMail = await signInWith(srv, 'github', 'githubNoMail')
        assert.match(noMail.location, /oauth_error=NO_EMAIL/); assert.equal(noMail.token, null)
        const badCode = await signInWith(srv, 'google', 'unknownCode')
        assert.match(badCode.location, /oauth_error=TOKEN/)
    } finally { await srv.stop() }
})

test('a self-hosted server with closed sign-up: providers sign in members only', async () => {
    const srv = await startServer({ KUBEEZ_MODE: 'self-hosted', ...OAUTH_ENV() })
    const api = client(srv)
    try {
        await api('POST', '/api/auth/setup', null, { username: 'owner', password: 'ownerpass12', email: 'gina@example.com' })
        const stranger = await signInWith(srv, 'github', 'githubCode')   // alice@example.com has no account here
        assert.match(stranger.location, /oauth_error=SIGNUP_CLOSED/); assert.equal(stranger.token, null)
        const member = await signInWith(srv, 'google', 'googleCode')       // the owner's email: signs in
        assert.equal((await api('GET', '/api/auth/me', member.token)).data.username, 'owner')
    } finally { await srv.stop() }
})

test('providers without keys are not offered and cannot be started', async () => {
    const srv = await startServer()
    try {
        assert.deepEqual((await client(srv)('GET', '/api/auth/options')).data.oauth, [])
        assert.equal((await fetch(`${srv.url}/api/auth/oauth/google/start`, { redirect: 'manual' })).status, 404)
    } finally { await srv.stop() }
})
