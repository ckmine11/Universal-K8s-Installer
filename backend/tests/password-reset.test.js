// Forgot password end to end against a small SMTP server: the code arrives by
// email, resets the password, old sessions end; login by username or email;
// no SMTP → the page is told, instead of a failing "Send code".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer, client, tempDataDir } from './helpers/server.js'

// Minimal SMTP: accepts any login, keeps every message
const mails = []
let smtp
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
                if (data) {
                    if (line === '.') { data = false; mails.push(msg); msg = ''; say('250 queued') } else msg += line + '\n'
                    continue
                }
                const cmd = line.slice(0, 4).toUpperCase()
                if (cmd === 'EHLO') { sock.write('250-test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n') }
                else if (cmd === 'AUTH') say('235 ok')
                else if (cmd === 'DATA') { data = true; say('354 go') }
                else if (cmd === 'QUIT') { say('221 bye'); sock.end() }
                else say('250 ok')
            }
        })
        sock.on('error', () => { })
    })
    await new Promise(r => smtp.listen(0, '127.0.0.1', r))
})
after(() => smtp.close())

const codeIn = (m) => (m.replace(/=\r?\n/g, '').match(/code is: (\d{6})/) || [])[1]

test('forgot → email code → reset → sign in; old sessions end', async () => {
    const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_USER: 'kubeez@example.com', SMTP_PASS: 'x', EMAIL_FROM: 'KubeEZ <kubeez@example.com>' })
    const api = client(srv)
    try {
        assert.equal((await api('GET', '/api/auth/options')).data.emailReset, true)
        const old = (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data.token
        assert.ok(old)
        await new Promise(res => setTimeout(res, 1100))   // session times are whole seconds

        // unknown account: same answer, no email
        let r = await api('POST', '/api/auth/forgot-password', null, { identifier: 'nobody@example.com' })
        assert.equal(r.status, 200)
        assert.equal(mails.length, 0)

        // by username, any case
        r = await api('POST', '/api/auth/forgot-password', null, { identifier: 'ROOT' })
        assert.equal(r.status, 200)
        assert.equal(mails.length, 1)
        assert.match(mails[0], /To: root@example\.com/i)
        const code = codeIn(mails[0])
        assert.match(code, /^\d{6}$/)

        // a second request within a minute sends nothing new
        await api('POST', '/api/auth/forgot-password', null, { identifier: 'root@example.com' })
        assert.equal(mails.length, 1)

        // Step 2: verify the code — a wrong one counts down, the right one gives a ticket
        const wrong = code === '000000' ? '111111' : '000000'
        r = await api('POST', '/api/auth/verify-reset-code', null, { identifier: 'root@example.com', code: wrong })
        assert.equal(r.status, 400)
        assert.equal(r.data.attemptsLeft, 4)
        r = await api('POST', '/api/auth/verify-reset-code', null, { identifier: 'root@example.com', code })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        const ticket = r.data.ticket
        assert.match(ticket, /^[0-9a-f]{64}$/)
        r = await api('POST', '/api/auth/verify-reset-code', null, { identifier: 'root', code })
        assert.equal(r.status, 400, 'a code is used up once verified')

        // Step 3: the new password with the ticket
        r = await api('POST', '/api/auth/reset-password', null, { identifier: 'root', ticket: 'f'.repeat(64), newPassword: 'NewSecret#2026' })
        assert.equal(r.status, 400)
        assert.equal(r.data.code, 'BAD_TICKET')
        r = await api('POST', '/api/auth/reset-password', null, { identifier: 'root@example.com', ticket, newPassword: 'NewSecret#2026' })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        r = await api('POST', '/api/auth/reset-password', null, { identifier: 'root', ticket, newPassword: 'Another#2026x' })
        assert.equal(r.status, 400, 'a ticket works once')

        const changed = () => mails.some(m => /was just changed/i.test(m.replace(/=\r?\n/g, '')))
        for (let i = 0; i < 30 && !changed(); i++) await new Promise(res => setTimeout(res, 100))
        assert.ok(changed(), 'the owner is told about the change')
        assert.equal((await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).status >= 400, true, 'old password no longer works')
        assert.ok((await api('POST', '/api/auth/login', null, { username: 'root@example.com', password: 'NewSecret#2026' })).data.token, 'sign in with the email')
        assert.ok((await api('POST', '/api/auth/login', null, { username: 'Root', password: 'NewSecret#2026' })).data.token, 'username in any case')
        assert.equal((await api('GET', '/api/notifications', old)).status, 401, 'sessions from before the reset ended')
    } finally { await srv.stop() }
})

test('no SMTP: the page is told, sending a code is refused with what to do', async () => {
    const srv = await startServer({ SMTP_USER: '', SMTP_PASS: '' })
    const api = client(srv)
    try {
        assert.equal((await api('GET', '/api/auth/options')).data.emailReset, false)
        const r = await api('POST', '/api/auth/forgot-password', null, { identifier: 'root' })
        assert.equal(r.status, 503)
        assert.match(r.data.error, /not set up on this server.*admin/i)
    } finally { await srv.stop() }
})

test('server owner: reset-password script', () => {
    const dir = tempDataDir()
    const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const env = { ...process.env, KUBEEZ_DATA_DIR: dir }
    execFileSync(process.execPath, ['scripts/make-superadmin.js', 'owner', 'secret123', 'owner@example.com'], { cwd: BACKEND, env, stdio: 'ignore' })
    const out = execFileSync(process.execPath, ['scripts/reset-password.js', 'OWNER@example.com', 'Fresh#Pass2026'], { cwd: BACKEND, env, encoding: 'utf8' })
    assert.match(out, /New password set for "owner"/)
    const u = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).find(x => x.username === 'owner')
    assert.ok(u.passwordChangedAt > 0)
    assert.throws(() => execFileSync(process.execPath, ['scripts/reset-password.js', 'owner', 'short'], { cwd: BACKEND, env, stdio: 'pipe' }))
    fs.rmSync(dir, { recursive: true, force: true })
})

test('welcome email on sign-up; team invite email without the password', async () => {
    const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_USER: 'kubeez@example.com', SMTP_PASS: 'x', KUBEEZ_PUBLIC_URL: 'https://k8scluster.space' })
    const api = client(srv)
    const seen = (re) => mails.find(m => re.test(m.replace(/=\r?\n/g, '')))
    const waitFor = async (re) => { for (let i = 0; i < 40 && !seen(re); i++) await new Promise(r => setTimeout(r, 100)); return seen(re) }
    try {
        const ann = (await api('POST', '/api/auth/register', null, { username: 'annw', password: 'annpass12345', email: 'ann.w@example.com' })).data
        assert.ok(ann.token)
        const w = await waitFor(/To: ann\.w@example\.com[\s\S]*Welcome/i)
        assert.ok(w, 'welcome email sent')
        assert.match(w.replace(/=\r?\n/g, ''), /k8scluster\.space/)
        assert.ok(!/annpass12345/.test(w), 'never the password')

        await api('PUT', '/api/superadmin/users/' + ann.user.id + '/limits', (await api('POST', '/api/auth/login', null, { username: 'root', password: 'secret123' })).data.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 5 })
        const r = await api('POST', '/api/admin/users', ann.token, { username: 'bobw', password: 'bobpass12345', email: 'bob.w@example.com', role: 'operator' })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        const inv = await waitFor(/To: bob\.w@example\.com/i)
        assert.ok(inv, 'invite email sent')
        assert.match(inv.replace(/=\r?\n/g, ''), /annw/)
        assert.ok(!/bobpass12345/.test(inv), 'the admin hands over the password, not the email')
    } finally { await srv.stop() }
})

test('5 wrong codes burn the code', async () => {
    const srv = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_USER: 'kubeez@example.com', SMTP_PASS: 'x' })
    const api = client(srv)
    try {
        const before = mails.length
        await api('POST', '/api/auth/forgot-password', null, { identifier: 'root' })
        for (let i = 0; i < 40 && mails.length === before; i++) await new Promise(r => setTimeout(r, 100))
        const code = codeIn(mails.at(-1))
        const wrong = code === '000000' ? '111111' : '000000'
        let r
        for (let i = 0; i < 5; i++) r = await api('POST', '/api/auth/verify-reset-code', null, { identifier: 'root', code: wrong })
        assert.equal(r.data.code, 'CODE_BURNED')
        r = await api('POST', '/api/auth/verify-reset-code', null, { identifier: 'root', code })
        assert.equal(r.status, 400, 'even the right code no longer works')
    } finally { await srv.stop() }
})
