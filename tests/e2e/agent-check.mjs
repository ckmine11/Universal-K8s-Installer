// Gateway Agent installer on a REAL Linux machine (systemd container): service
// install, crash → restart, reboot → back, re-install → one copy, SSH relayed
// through the bundled agent, non-root fallback. Run via: bash tests/e2e/e2e.sh agent
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE = process.env.NODE_CONTAINER
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend')
const PORT = 33000 + Math.floor(Math.random() * 5000)
const URL = `http://127.0.0.1:${PORT}`
const PUBLIC = process.env.AGENT_PUBLIC_URL || `http://host.docker.internal:${PORT}`
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-agent-e2e-'))
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd, user) => { const r = spawnSync('docker', ['exec', ...(user ? ['-u', user] : []), NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 32 << 20 }); return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

execFileSync(process.execPath, ['build-agent.js'], { cwd: BACKEND, stdio: 'ignore' })
const server = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), KUBEEZ_MODE: 'saas', APP_SECRET: 'agent-e2e', NODE_ENV: 'test', KUBEEZ_DATA_DIR: DATA, KUBEEZ_PUBLIC_URL: PUBLIC }
})
const serverLog = process.env.AGENT_E2E_SERVER_LOG ? fs.createWriteStream(process.env.AGENT_E2E_SERVER_LOG) : null
server.stdout.on('data', d => serverLog?.write(d)); server.stderr.on('data', d => serverLog?.write(d))
server.on('exit', (code) => { if (code !== null) console.log(`FAIL KubeEZ server exited unexpectedly (code ${code})`) })
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${URL}/api/health`)).ok) break } catch { } await sleep(100) }

const api = async (method, p, token, body) => {
    // fresh connection each time: a kept-alive socket the server closed while
    // we waited on docker exec would fail with ECONNRESET
    const go = () => fetch(URL + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, connection: 'close' }, body: body ? JSON.stringify(body) : undefined })
    const r = await go().catch(() => sleep(500).then(go))
    return { status: r.status, data: await r.json().catch(() => null) }
}
const admin = (await api('POST', '/api/auth/register', null, { username: 'e2eadmin', password: 'secret123', email: 'e2e@example.com' })).data
const status = async (id) => (await api('GET', '/api/agent/list', admin.token)).data.find(a => a.agentId === id)?.status
async function waitOnline(id, secs = 60) { for (let i = 0; i < secs * 2; i++) { if (await status(id) === 'online') return true; await sleep(500) } return false }
const agentPids = (dir = '/root/.kubeez-agent') => dx(`pgrep -f '${dir}/[a]gent-bundle.js' | wc -l`).out

try {
    ok(dx(`curl -s -o /dev/null -w '%{http_code}' ${PUBLIC}/api/health`).out === '200', `container reaches KubeEZ at ${PUBLIC}`)

    // ── root: systemd service ────────────────────────────────────────────────
    const t = (await api('POST', '/api/agent/token', admin.token, { label: 'e2e-root' })).data
    let r = dx(t.installCommandLinux)
    ok(r.code === 0 && /running \(systemd\)/.test(r.out), 'installer: systemd service\n' + r.out.split('\n').slice(-8).join('\n'))
    ok(dx('systemctl is-enabled kubeez-agent').out === 'enabled', 'service enabled (starts at boot)')
    ok(dx('stat -c %a /root/.kubeez-agent/config.json').out === '600', 'config.json readable only by its owner')
    ok(await waitOnline(t.agentId), 'agent online')

    dx("pkill -9 -f '/root/.kubeez-agent/[a]gent-bundle.js'")
    await sleep(2000)
    ok(await waitOnline(t.agentId, 40), 'after a crash (kill -9) systemd brings it back')

    r = dx((await api('GET', `/api/agent/${t.agentId}/install-command`, admin.token)).data.installCommandLinux)
    ok(r.code === 0, 're-running the install command (same token) works')
    await sleep(3000)
    ok(agentPids() === '1', `exactly one agent process after re-install (found ${agentPids()})`)
    ok(await waitOnline(t.agentId), 'online after re-install')

    // ── reboot ───────────────────────────────────────────────────────────────
    spawnSync('docker', ['restart', NODE], { env })
    for (let i = 0; i < 30; i++) { if (/running|degraded/.test(dx('systemctl is-system-running').out)) break; await sleep(1000) }
    ok(await waitOnline(t.agentId, 90), 'after a reboot the agent comes back by itself')

    // ── SSH relayed through the bundled agent (ssh2 is inside the bundle) ────
    dx('(apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server) >/dev/null 2>&1; echo "root:kzpass123" | chpasswd; ' +
       "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/; s/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config; systemctl restart ssh")
    const v = await api('POST', '/api/nodes/verify', admin.token, { ip: '127.0.0.1', username: 'root', password: 'kzpass123' })
    ok(v.status === 200 && v.data?.reachable, `SSH through the agent works (${v.data?.status} ${v.data?.error || ''})`)

    // ── non-root, no sudo: still kept running ────────────────────────────────
    dx('id kz >/dev/null 2>&1 || useradd -m kz')
    const t2 = (await api('POST', '/api/agent/token', admin.token, { label: 'e2e-user' })).data
    r = dx(t2.installCommandLinux, 'kz')
    const mode = (r.out.match(/running \(([a-z-]+)\)/) || [])[1]
    ok(r.code === 0 && !!mode, `non-root installer runs (${mode})\n` + r.out.split('\n').slice(-6).join('\n'))
    ok(await waitOnline(t2.agentId), 'non-root agent online')
} finally {
    server.kill()
    fs.rmSync(DATA, { recursive: true, force: true })
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
