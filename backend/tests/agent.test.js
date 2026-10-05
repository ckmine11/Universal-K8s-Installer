// Gateway Agent lifecycle against the real server and the real agent bundle:
// online, reconnect after a server restart, one copy only, start from the saved
// config, revoked agent stops, silent connections dropped, install command reuse.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { tempDataDir } from './helpers/server.js'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Like a user's machine: the bundle alone in its own folder, pinned to CommonJS
// (the installer writes the same package.json)
const AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-agent-home-'))
const BUNDLE = path.join(AGENT_HOME, 'agent-bundle.js')
const PORT = 32000 + Math.floor(Math.random() * 8000)
const URL = `http://127.0.0.1:${PORT}`
const DATA = tempDataDir()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// Agents ping every second here; the server drops a connection after 3 s of silence
const AGENT_ENV = { ...process.env, KUBEEZ_AGENT_PING_MS: '1000' }

let server, admin, outsider
const kids = []

async function boot() {
    const child = spawn(process.execPath, ['src/server.js'], {
        cwd: BACKEND, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), KUBEEZ_MODE: 'saas', APP_SECRET: 'agent-test', NODE_ENV: 'test',
            KUBEEZ_DATA_DIR: DATA, KUBEEZ_AGENT_DEAD_AFTER_MS: '3000' }
    })
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${URL}/api/health`)).ok) return child } catch { /* starting */ }
        await sleep(100)
    }
    throw new Error('server did not start')
}
const stop = async (child) => { child.kill(); await new Promise(r => child.once('exit', r)) }
const api = async (method, p, token, body) => {
    const r = await fetch(URL + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, data: await r.json().catch(() => null) }
}
const register = async (u) => (await api('POST', '/api/auth/register', null, { username: u, password: 'secret123', email: `${u}@example.com` })).data
const statusOf = async (agentId) => (await api('GET', '/api/agent/list', admin.token)).data.find(a => a.agentId === agentId)?.status
async function waitStatus(agentId, want, ms = 15000) {
    for (let t = 0; t < ms; t += 250) { if (await statusOf(agentId) === want) return true; await sleep(250) }
    return false
}
function runAgent(args, cwd) {
    const p = spawn(process.execPath, [BUNDLE, ...args], { cwd, env: AGENT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    p.out = ''; p.stdout.on('data', d => { p.out += d }); p.stderr.on('data', d => { p.out += d })
    p.exited = new Promise(r => p.once('exit', code => r(code)))
    kids.push(p)
    return p
}
const exitWithin = (p, ms) => Promise.race([p.exited, sleep(ms).then(() => 'still-running')])

before(async () => {
    execFileSync(process.execPath, ['build-agent.js'], { cwd: BACKEND, stdio: 'ignore' })   // the file users download
    fs.copyFileSync(path.join(BACKEND, 'public', 'agent-bundle.js'), BUNDLE)
    fs.writeFileSync(path.join(AGENT_HOME, 'package.json'), '{"type":"commonjs"}')
    server = await boot()
    admin = await register('agentadmin')
    outsider = await register('agentoutsider')
})
after(async () => {
    for (const k of kids) if (k.exitCode === null) k.kill()
    if (server && server.exitCode === null) await stop(server)
    fs.rmSync(DATA, { recursive: true, force: true })
})

test('agent comes online and survives a KubeEZ server restart (same token)', async () => {
    const { agentId, token } = (await api('POST', '/api/agent/token', admin.token, { label: 'lab' })).data
    const a = runAgent(['--token', token, '--agent-id', agentId, '--server', URL.replace('http', 'ws')])
    assert.ok(await waitStatus(agentId, 'online'), 'online:\n' + a.out)

    await stop(server)
    server = await boot()
    // backoff 2s → 4s …: back within a few seconds, without a new token
    assert.ok(await waitStatus(agentId, 'online', 20000), 'online again after restart:\n' + a.out)
    assert.equal(a.exitCode, null)
    a.kill()
})

test('the install command for an existing agent reuses its token; other workspaces cannot read it', async () => {
    const { agentId, token } = (await api('POST', '/api/agent/token', admin.token, { label: 'cmd' })).data
    const r = await api('GET', `/api/agent/${agentId}/install-command`, admin.token)
    assert.equal(r.status, 200)
    assert.match(r.data.installCommandLinux, new RegExp(`--token ${token} --agent-id ${agentId}`))
    const ps = Buffer.from(r.data.installCommandWindows.split(' ').pop(), 'base64').toString('utf16le')
    assert.match(ps, new RegExp(`-Token ${token} -AgentId ${agentId}`))
    assert.match(ps, /\$env:TEMP\\kbagent\.ps1/)
    assert.equal((await api('GET', `/api/agent/${agentId}/install-command`, outsider.token)).status, 404)
})

test('starts from the saved config alone; a second copy makes the older one stop (no flapping)', async () => {
    const { agentId, token } = (await api('POST', '/api/agent/token', admin.token, { label: 'dup' })).data
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-agent-'))
    fs.copyFileSync(BUNDLE, path.join(dir, 'agent-bundle.js'))
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ token, agentId, server: URL.replace('http', 'ws') }))
    const first = spawn(process.execPath, ['agent-bundle.js'], { cwd: dir, env: AGENT_ENV, stdio: 'ignore' })   // no arguments
    first.exited = new Promise(r => first.once('exit', c => r(c))); kids.push(first)
    assert.ok(await waitStatus(agentId, 'online'), 'online from config.json')

    const second = runAgent(['--config', path.join(dir, 'config.json')])
    assert.equal(await exitWithin(first, 8000), 0, 'older copy exits cleanly')
    await sleep(3000)
    assert.equal(second.exitCode, null, 'newer copy keeps running')
    assert.equal(await statusOf(agentId), 'online')
    second.kill()
})

test('a removed agent stops for good (exit 78), instead of retrying forever', async () => {
    const { agentId, token } = (await api('POST', '/api/agent/token', admin.token, { label: 'gone' })).data
    const a = runAgent(['--token', token, '--agent-id', agentId, '--server', URL.replace('http', 'ws')])
    assert.ok(await waitStatus(agentId, 'online'))
    assert.equal((await api('DELETE', `/api/agent/${agentId}`, admin.token)).status, 200)
    assert.equal(await exitWithin(a, 15000), 78, a.out)
    assert.match(a.out, /removed|token/i)
})

test('a connection that goes silent is dropped by the server and shown offline', async () => {
    const { agentId, token } = (await api('POST', '/api/agent/token', admin.token, { label: 'silent' })).data
    const ws = new WebSocket(`${URL.replace('http', 'ws')}/ws/agent/${agentId}?token=${token}`)
    const closed = new Promise(r => ws.once('close', () => r(true)))
    assert.ok(await waitStatus(agentId, 'online'))
    // never sends a ping → dropped after KUBEEZ_AGENT_DEAD_AFTER_MS (3 s here)
    assert.equal(await Promise.race([closed, sleep(8000).then(() => false)]), true)
    assert.ok(await waitStatus(agentId, 'offline', 3000))
})
