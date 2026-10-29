// Enterprise single sign-on (OIDC) against the real server and a fake identity
// provider: discovery, PKCE, the ID token's audience / issuer, groups → role,
// joining the server's workspace, role follow-up, and who is turned away.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import { startServer, client } from './helpers/server.js'

const { ssoRole } = await import('../src/routes/oauth.js')

const ISS = 'https://idp.test/realms/acme'
const people = {
    alice: { sub: 'u-alice', email: 'alice@acme.io', preferred_username: 'alice', groups: ['kubeez-ops'] },
    bob: { sub: 'u-bob', email: 'bob@acme.io', preferred_username: 'bob', groups: ['sales'] },
    owner: { sub: 'u-owner', email: 'owner@acme.io', preferred_username: 'owner', groups: ['sales'] },
    wrongAud: { sub: 'u-x', email: 'x@acme.io', groups: ['kubeez-ops'], aud: 'another-app' }
}
const challenges = new Map()
let idp, srv, api, current = null
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

before(async () => {
    idp = http.createServer((req, res) => {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
            const url = req.url.replace(/^\/idp\.test/, '')
            const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
            if (url === '/realms/acme/.well-known/openid-configuration') return send(200, { issuer: ISS, authorization_endpoint: `${ISS}/auth`, token_endpoint: `${ISS}/token`, userinfo_endpoint: `${ISS}/userinfo` })
            if (url === '/realms/acme/token') {
                const q = new URLSearchParams(body)
                const p = people[q.get('code')]
                const want = challenges.get(q.get('code'))
                const got = crypto.createHash('sha256').update(q.get('code_verifier') || '').digest('base64url')
                if (!p || q.get('client_secret') !== 'shh' || want !== got) return send(400, { error: 'invalid_grant' })
                current = p
                return send(200, { access_token: `at-${q.get('code')}`, id_token: `${b64({ alg: 'none' })}.${b64({ iss: ISS, aud: p.aud || 'kubeez', sub: p.sub, email: p.email, groups: p.groups })}.sig` })
            }
            if (url === '/realms/acme/userinfo') {
                const who = String(req.headers.authorization || '').replace('Bearer at-', '')
                const p = people[who]
                return p ? send(200, { sub: p.sub, email: p.email, email_verified: true, preferred_username: p.preferred_username }) : send(401, {})
            }
            send(404, {})
        })
    })
    await new Promise(r => idp.listen(0, '127.0.0.1', r))
    srv = await startServer({
        KUBEEZ_MODE: 'selfhosted', KUBEEZ_OAUTH_TEST_BASE: `http://127.0.0.1:${idp.address().port}`, KUBEEZ_PUBLIC_URL: 'http://kubeez.local',
        OIDC_ISSUER: ISS, OIDC_CLIENT_ID: 'kubeez', OIDC_CLIENT_SECRET: 'shh', OIDC_NAME: 'Acme SSO',
        OIDC_ROLE_MAP: 'kubeez-admins=admin, kubeez-ops=operator', OIDC_DEFAULT_ROLE: 'none'
    })
    api = client(srv)
    const s = await api('POST', '/api/auth/setup', null, { username: 'owner', password: 'Owner-pass-123!', email: 'owner@acme.io' })
    assert.equal(s.status, 200, JSON.stringify(s.data))
})
after(async () => { await srv?.stop(); idp?.close() })

// the browser's part: start → the provider (we play it) → callback with the code
async function signIn(who) {
    const start = await fetch(`${srv.url}/api/auth/oauth/oidc/start`, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const to = new URL(start.headers.get('location'))
    assert.equal(`${to.origin}${to.pathname}`, `${ISS}/auth`)
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(to.searchParams.get('client_id'), 'kubeez')
    challenges.set(who, to.searchParams.get('code_challenge'))
    const cookie = start.headers.get('set-cookie').split(';')[0]
    const cb = await fetch(`${srv.url}/api/auth/oauth/oidc/callback?code=${who}&state=${to.searchParams.get('state')}`, { headers: { cookie }, redirect: 'manual' })
    const loc = cb.headers.get('location') || ''
    const token = /token=([^;]+)/.exec(cb.headers.get('set-cookie') || '')?.[1]
    return { loc, token }
}
const me = async (token) => (await fetch(`${srv.url}/api/auth/me`, { headers: { cookie: `token=${token}` } })).json()

test('groups → role: the highest match; nothing matched → the default (none unless set)', () => {
    const env = { OIDC_ROLE_MAP: 'admins=admin,ops=operator,*=viewer' }
    assert.equal(ssoRole(['ops', 'admins'], env), 'admin')
    assert.equal(ssoRole(['ops'], env), 'operator')
    assert.equal(ssoRole([], env), 'viewer', '* matches everyone')
    assert.equal(ssoRole(['x'], { OIDC_ROLE_MAP: 'ops=operator' }), 'none')
    assert.equal(ssoRole(['x'], { OIDC_ROLE_MAP: 'ops=operator', OIDC_DEFAULT_ROLE: 'viewer' }), 'viewer')
    assert.equal(ssoRole(['x'], { OIDC_DEFAULT_ROLE: 'admin' }), 'none', 'admin is never a default')
    assert.equal(ssoRole(['ops'], { OIDC_ROLE_MAP: 'ops=superadmin' }), 'none', 'no unknown roles')
})

test('the login page offers the SSO button by its name', async () => {
    const o = await api('GET', '/api/auth/options')
    assert.ok(o.data.oauth.includes('oidc')); assert.equal(o.data.ssoName, 'Acme SSO')
})

test('a full workspace says so (seat limit), then a member of kubeez-ops joins it as operator', async () => {
    const full = await signIn('alice')
    assert.match(full.loc, /oauth_error=SEATS/); assert.match(decodeURIComponent(full.loc), /seat limit reached \(1\)/i)
    const owner0 = await api('POST', '/api/auth/login', null, { username: 'owner', password: 'Owner-pass-123!' })
    assert.equal((await api('PUT', `/api/superadmin/users/${owner0.data.user.id}/limits`, owner0.data.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 10 })).status, 200)
    const { loc, token } = await signIn('alice')
    assert.match(loc, /\/\?signed_in=1$/, loc)
    const m = await me(token)
    assert.equal(m.username, 'alice'); assert.equal(m.role, 'operator')
    const owner = await api('POST', '/api/auth/login', null, { username: 'owner', password: 'Owner-pass-123!' })
    assert.equal(m.orgId, owner.data.user.orgId, 'the same workspace as the owner')
})

test('the role follows the groups at the next sign-in', async () => {
    people.alice.groups = ['kubeez-admins']
    const { token } = await signIn('alice')
    assert.equal((await me(token)).role, 'admin')
    people.alice.groups = ['kubeez-ops']
    assert.equal((await me((await signIn('alice')).token)).role, 'operator')
})

test('no matching group → no access; a token for another app → refused', async () => {
    const bob = await signIn('bob')
    assert.match(bob.loc, /oauth_error=NO_ROLE/); assert.equal(bob.token, undefined)
    const x = await signIn('wrongAud')
    assert.match(x.loc, /oauth_error=TOKEN/)
})

test('the workspace owner is never demoted by groups', async () => {
    const { loc, token } = await signIn('owner')
    // owner@acme.io is only in "sales" → no role — the owner's account is not taken away silently either
    if (token) assert.equal((await me(token)).role, 'admin')
    else assert.match(loc, /oauth_error=NO_ROLE/)
})
