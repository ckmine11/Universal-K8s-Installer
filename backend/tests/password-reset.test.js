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

        r = await api('POST', '/api/auth/reset-password', null, { identifier: 'root@example.com', token: code === '000000' ? '111111' : '000000', newPassword: 'NewSecret#2026' })
        assert.equal(r.status, 400)
        r = await api('POST', '/api/auth/reset-password', null, { identifier: 'root@example.com', token: code, newPassword: 'NewSecret#2026' })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        r = await api('POST', '/api/auth/reset-password', null, { identifier: 'root', token: code, newPassword: 'Another#2026x' })
        assert.equal(r.status, 400, 'a code works once')

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
