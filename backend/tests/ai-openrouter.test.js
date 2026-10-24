// "Sign in with OpenRouter": connect cloud AI without an API key. A fake
// OpenRouter checks the PKCE flow exactly (S256: the code is traded only with
// the secret whose SHA-256 was sent at the start), then the real /api/ai
// routes: start → back with code → engine connected with the user's key, a
// model preselected from the live list; only the same admin, once, in time;
// signing in again refreshes the same engine.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { startServer, client } from './helpers/server.js'

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
// ── a fake OpenRouter ──
const issued = new Map()   // code → challenge
let exchanges = []
const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c)
    req.on('end', () => {
        const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
        if (req.method === 'POST' && req.url === '/api/v1/auth/keys') {
            const body = JSON.parse(b || '{}'); exchanges.push(body)
            const challenge = issued.get(body.code)
            if (!challenge || body.code_challenge_method !== 'S256') return send(400, { error: { message: 'Invalid code', code: 400 } })
            if (b64url(createHash('sha256').update(body.code_verifier).digest()) !== challenge) return send(403, { error: { message: 'Invalid code or code_verifier' } })
            issued.delete(body.code)
            return send(200, { key: `sk-or-v1-user-${exchanges.length}-abcdef` })
        }
        if (req.url === '/api/v1/models') return send(200, { data: ['anthropic/claude-haiku-4.5', 'openai/gpt-4.1-mini', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/text-embedding-3-small'].map(id => ({ id })) })
        send(404, { error: 'not found' })
    })
})
// what OpenRouter does when the user signs in and approves: back to callback_url with code + state
const approve = (authUrl) => {
    const u = new URL(authUrl)
    const code = `code-${Math.random().toString(36).slice(2)}`
    issued.set(code, u.searchParams.get('code_challenge'))
    return { code, state: u.searchParams.get('state'), callback: u.searchParams.get('callback_url'), method: u.searchParams.get('code_challenge_method') }
}

let srv, api, boss, other
before(async () => {
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    srv = await startServer({ KUBEEZ_MODE: 'selfhosted', KUBEEZ_OPEN_SIGNUP: 'true', NO_SUPERADMIN: '1', KUBEEZ_OPENROUTER_URL: `http://127.0.0.1:${fake.address().port}` })
    api = client(srv)
    boss = (await api('POST', '/api/auth/setup', null, { username: 'orboss', password: 'bosspass123', email: 'orboss@example.com' })).data
    other = (await api('POST', '/api/auth/register', null, { username: 'orother', password: 'otherpass123', email: 'orother@example.com' })).data
})
after(async () => { await srv?.stop(); fake.closeAllConnections?.(); fake.close() })

describe('Sign in with OpenRouter', () => {
    test('start: to OpenRouter with an S256 code challenge, back to /ai/settings', async () => {
        const r = await api('POST', '/api/ai/openrouter/start', boss.token, { origin: 'https://kubeez.example.com' })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        const u = new URL(r.data.url)
        assert.equal(u.pathname, '/auth')
        assert.equal(u.searchParams.get('callback_url'), 'https://kubeez.example.com/ai/settings')
        assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
        assert.match(u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/, 'base64url SHA-256')
        assert.ok(u.searchParams.get('state').length >= 20)
        assert.equal(r.data.url.includes('verifier'), false, 'the secret never leaves KubeEZ')
    })

    test('back with the code: connected — the user\'s key stored, every model, one preselected', async () => {
        const s = await api('POST', '/api/ai/openrouter/start', boss.token, { origin: 'https://kubeez.example.com' })
        const back = approve(s.data.url)
        const f = await api('POST', '/api/ai/openrouter/finish', boss.token, { code: back.code, state: back.state })
        assert.equal(f.status, 200, JSON.stringify(f.data))
        assert.equal(f.data.preset, 'openrouter'); assert.equal(f.data.signedIn, true); assert.equal(f.data.hasKey, true)
        assert.equal(f.data.key, undefined, 'the key is never sent to the browser')
        assert.equal(f.data.model, 'anthropic/claude-haiku-4.5', 'a recommended, fast model preselected')
        assert.equal(f.data.models, 3, 'chat models only (no embeddings)')
        assert.equal(f.data.again, false)
        const g = (await api('GET', '/api/ai', boss.token)).data
        assert.equal(g.engines.filter(e => e.preset === 'openrouter').length, 1)
        const m = (await api('GET', `/api/ai/providers/${f.data.id}/models`, boss.token)).data
        assert.ok(m.models.find(x => x.id === 'meta-llama/llama-3.3-70b-instruct:free').free, 'free models are marked')
    })

    test('only once, only the same admin, only with the right secret', async () => {
        const s = await api('POST', '/api/ai/openrouter/start', boss.token, { origin: 'https://kubeez.example.com' })
        const back = approve(s.data.url)
        const stolen = await api('POST', '/api/ai/openrouter/finish', other.token, { code: back.code, state: back.state })
        assert.equal(stolen.status, 403, 'another workspace cannot finish it')
        const again = await api('POST', '/api/ai/openrouter/finish', boss.token, { code: back.code, state: back.state })
        assert.equal(again.status, 400); assert.match(again.data.error, /unknown or was already used/)
        assert.equal((await api('POST', '/api/ai/openrouter/finish', boss.token, { code: 'abcdef', state: 'made-up-state' })).status, 400)
        // a code OpenRouter does not know (expired / cancelled)
        const s2 = await api('POST', '/api/ai/openrouter/start', boss.token, { origin: 'https://kubeez.example.com' })
        const r = await api('POST', '/api/ai/openrouter/finish', boss.token, { code: 'code-not-issued', state: new URL(s2.data.url).searchParams.get('state') })
        assert.equal(r.status, 400); assert.match(r.data.error, /did not accept the sign-in/)
    })

    test('signing in again refreshes the same engine (new key), never a second one', async () => {
        const before = (await api('GET', '/api/ai', boss.token)).data.engines.find(e => e.preset === 'openrouter')
        const s = await api('POST', '/api/ai/openrouter/start', boss.token, { origin: 'https://kubeez.example.com' })
        const back = approve(s.data.url)
        const f = await api('POST', '/api/ai/openrouter/finish', boss.token, { code: back.code, state: back.state })
        assert.equal(f.status, 200); assert.equal(f.data.again, true); assert.equal(f.data.id, before.id)
        assert.equal((await api('GET', '/api/ai', boss.token)).data.engines.filter(e => e.preset === 'openrouter').length, 1)
        const audit = await api('GET', '/api/compliance/audit?limit=200', boss.token)
        assert.ok(JSON.stringify(audit.data).includes('Signed in again with OpenRouter'))
    })

    test('members who may not manage AI cannot sign in', async () => {
        assert.equal((await api('PUT', `/api/superadmin/users/${boss.user.id}/limits`, boss.token, { plan: 'FREE', maxClusters: 2, maxNodes: 10, maxMembers: 4 })).status, 200)
        const r = await api('POST', '/api/admin/users', boss.token, { username: 'orview', password: 'viewpass123', email: 'orview@example.com', role: 'viewer' })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        const viewer = (await api('POST', '/api/auth/login', null, { username: 'orview', password: 'viewpass123' })).data
        assert.equal((await api('POST', '/api/ai/openrouter/start', viewer.token, { origin: 'https://kubeez.example.com' })).status, 403)
    })
})
