// Cluster topology / health through the Gateway Agent on a REAL cluster (SaaS
// mode): root and non-root SSH users, and again after the agent reconnects.
// Run via: bash tests/e2e/e2e.sh agent-health [distro]
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NODE = process.env.NODE_CONTAINER
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend')
const PORT = 36000 + Math.floor(Math.random() * 3000)
const URL = `http://127.0.0.1:${PORT}`
const PUBLIC = `http://host.docker.internal:${PORT}`
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-health-e2e-'))
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd) => { const r = spawnSync('docker', ['exec', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env }); return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

execFileSync(process.execPath, ['build-agent.js'], { cwd: BACKEND, stdio: 'ignore' })
const server = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), KUBEEZ_MODE: 'saas', APP_SECRET: 'health-e2e-secret-0123456789abcdef', NODE_ENV: 'test', KUBEEZ_DATA_DIR: DATA, KUBEEZ_PUBLIC_URL: PUBLIC }
})
const log = process.env.HEALTH_E2E_SERVER_LOG ? fs.createWriteStream(process.env.HEALTH_E2E_SERVER_LOG) : null
server.stdout.on('data', d => log?.write(d)); server.stderr.on('data', d => log?.write(d))
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${URL}/api/health`)).ok) break } catch { } await sleep(100) }

const api = async (method, p, token, body) => {
    const go = () => fetch(URL + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, connection: 'close' }, body: body ? JSON.stringify(body) : undefined })
    const r = await go().catch(() => sleep(500).then(go))
    return { status: r.status, data: await r.json().catch(() => null) }
}
const admin = (await api('POST', '/api/auth/register', null, { username: 'hcadmin', password: 'secret12345', email: 'hc@example.com' })).data
const status = async (id) => (await api('GET', '/api/agent/list', admin.token)).data.find(a => a.agentId === id)?.status
async function waitOnline(id, secs = 60) { for (let i = 0; i < secs * 2; i++) { if (await status(id) === 'online') return true; await sleep(500) } return false }

try {
    const t = (await api('POST', '/api/agent/token', admin.token, { label: 'hc' })).data
    ok(dx(t.installCommandLinux).code === 0, 'agent installed in the cluster node')
    ok(await waitOnline(t.agentId), 'agent online')

    // A non-root user with sudo (common on Ubuntu clouds)
    dx('id kzuser >/dev/null 2>&1 || useradd -m -s /bin/bash kzuser; echo "kzuser:kzpass12345" | chpasswd; usermod -aG sudo kzuser 2>/dev/null || usermod -aG wheel kzuser')
    dx('(command -v sshd || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server)) >/dev/null 2>&1; echo "root:kzroot12345" | chpasswd; ' +
       "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/; s/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config; systemctl restart ssh || systemctl restart sshd")

    const clusters = []
    for (const [id, username, password] of [['c-root', 'root', 'kzroot12345'], ['c-user', 'kzuser', 'kzpass12345'], ['c-wrong', 'root', 'wrong-password-1']]) {
        clusters.push({ id, ownerId: admin.user.id, orgId: admin.user.orgId, clusterName: id, k8sVersion: '1.35.0', networkPlugin: 'flannel', status: 'healthy',
            masterNodes: [{ ip: '127.0.0.1', hostname: NODE, username, password }], workerNodes: [] })
    }
    fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify(clusters))

    const check = async (id, label) => {
        const t0 = Date.now()
        const h = (await api('GET', `/api/clusters/${id}/health`, admin.token)).data
        const secs = Math.round((Date.now() - t0) / 1000)
        const ready = (h?.nodes || []).filter(n => n.status === 'Ready').length
        ok(!h?.error && ready >= 1, `${label}: ${ready} node(s) Ready in ${secs}s ${h?.error ? '— ' + h.error + ': ' + (h.details || '') : ''}`)
        return h
    }
    // non-root FIRST: no root session to the node exists yet
    await check('c-user', 'health as non-root sudo user (fresh session)')
    await check('c-root', 'health as root')
    const wrong = (await api('GET', '/api/clusters/c-wrong/health', admin.token)).data
    ok(!!wrong?.error, `a wrong password is NOT accepted via another open session (${(wrong?.details || 'no error').slice(0, 80)})`)

    // Agent reconnect: restart the service, then topology must sync again
    dx('systemctl restart kubeez-agent')
    await sleep(1500)
    ok(await waitOnline(t.agentId, 60), 'agent back online after restart')
    await check('c-user', 'health after reconnect (non-root, first)')
    await check('c-root', 'health after reconnect (root)')

    // The KubeEZ Explorer through the agent's TCP relay (tcp-open/data/close):
    // the page, its API and a live WebSocket, with no SSH port forwarding
    if (dx('test -f /k/explorer.sh').code === 0) {
        dx("mkdir -p /etc/kubeez && echo 'KZ_BASE_PATH=/api/clusters/c-root/explorer' > /etc/kubeez/explorer.env")
        console.log('== installing the KubeEZ Explorer')
        const inst = dx('bash /k/explorer.sh 2>&1')
        ok(inst.code === 0, 'Explorer installed' + (inst.code ? ': ' + inst.out.split('\n').slice(-5).join(' | ') : ''))
        const base = `${URL}/api/clusters/c-root/explorer`
        const cookie = { cookie: `token=${admin.token}` }
        let r = await fetch(base + '/', { headers: { ...cookie, accept: 'text/html' } })
        const html = await r.text()
        ok(r.status === 200 && /<title>KubeEZ Explorer<\/title>/.test(html), `Explorer page through the agent relay (HTTP ${r.status})`)
        r = await fetch(base + '/api/rbac/whoami', { headers: cookie })
        const who = await r.json().catch(() => null)
        ok(r.status === 200 && Array.isArray(who?.resourceRules), `Explorer API through the agent relay (HTTP ${r.status})`)
        const many = await Promise.all(Array.from({ length: 8 }, () => fetch(base + '/api/rbac/whoami', { headers: cookie }).then(x => x.status).catch(() => 0)))
        ok(many.every(c => c === 200), `8 parallel requests through the relay: ${many.join(',')}`)
        // Live updates (SSE) stay open through the relay
        const ac = new AbortController()
        const sse = await fetch(base + '/api/events/stream', { headers: { ...cookie, accept: 'text/event-stream' }, signal: ac.signal }).catch(e => ({ status: 0, e }))
        let first = ''
        if (sse.body) { const rd = sse.body.getReader(); const t = setTimeout(() => ac.abort(), 15000); try { const { value } = await rd.read(); first = new TextDecoder().decode(value || new Uint8Array()) } catch { } clearTimeout(t); ac.abort() }
        ok(sse.status === 200 && first.length > 0, `live updates (SSE) through the relay (HTTP ${sse.status}, ${first.length} bytes)`)
        // Pod terminal: a WebSocket through KubeEZ → agent → Explorer → kubelet
        const pod = dx("KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath='{.items[0].metadata.name}'").out
        const ws = await new Promise((resolve) => {
            const sock = new WebSocket(`${base.replace('http', 'ws')}/api/pods/kube-system/${pod}/exec?container=coredns&command=/coredns&command=-version`, { headers: cookie })
            let got = ''
            const done = (v) => { try { sock.close() } catch { } resolve(v) }
            sock.onopen = () => { got = 'open' }
            sock.onmessage = (m) => { got = 'data'; done('data') }
            sock.onerror = () => done(got || 'error')
            sock.onclose = () => done(got || 'closed')
            setTimeout(() => done(got || 'timeout'), 20000)
        })
        ok(ws === 'open' || ws === 'data', `pod terminal WebSocket through the relay (${ws})`)
    }

    // Agent offline: health must answer quickly with a reason, not hang
    dx('systemctl stop kubeez-agent')
    for (let i = 0; i < 40 && await status(t.agentId) === 'online'; i++) await sleep(500)
    await sleep(6000) // status results are reused for 5 s
    const t0 = Date.now()
    const off = (await api('GET', '/api/clusters/c-root/health', admin.token)).data
    const secs = Math.round((Date.now() - t0) / 1000)
    ok(!!off?.error && secs < 30, `agent offline: clear error in ${secs}s (${off?.details?.slice(0, 120)})`)
} finally {
    server.kill()
    fs.rmSync(DATA, { recursive: true, force: true })
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
process.exit(fails ? 1 : 0)
