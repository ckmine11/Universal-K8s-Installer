// How KubeEZ reaches a cluster — the one place that decides it.
//
//   Installed by KubeEZ (or given SSH): SSH to the first control-plane, as always.
//   Imported (EKS, AKS, GKE, OKE, k3s, OpenShift… added from "Connected clusters"):
//   the Kubernetes API with the cluster's `kubeez` ServiceAccount token, reached
//     direct    at the API address as given (a public cloud endpoint, or the same network)
//     gateway   through the workspace's Gateway Agent (on-prem clusters behind KubeEZ Cloud)
//     agent     through the KubeEZ agent running inside the cluster (private clusters, NAT)
//
// Every feature gets the same `execCommand(script)`. For an imported cluster the
// script runs on the KubeEZ server in a sandbox: its own unprivileged user, an
// empty environment, `kubectl` / `helm` pointed at that cluster only, `sudo`
// reduced to a no-op, and the node tools (df, kubeadm, systemctl, crictl…)
// answering "not available" — so a script never reads the KubeEZ server itself.
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { decrypt } from '../utils/cryptoUtils.js'

export const ACCESS_MODES = ['direct', 'gateway', 'agent']
export const ACCESS_LEVELS = ['read', 'full']

/** Reached through the Kubernetes API (imported, no SSH given)? */
export const usesApi = (c) => !!c?.access?.mode && !(c.masterNodes?.length)
/** Added from "Connected clusters" (whether or not SSH was given later)? */
export const isImported = (c) => !!c?.imported || !!c?.access?.mode

// ── what works where ────────────────────────────────────────────────────────
// Features that need a control-plane node (files, kubeadm, etcd) — on an
// imported cluster the provider runs those, unless SSH was given (on-prem).
const NODE_FEATURES = {
    etcdBackup: 'etcd backups need SSH to a control-plane node — the cloud provider backs up its own control plane. On-prem: add SSH in the cluster\'s connection settings.',
    upgrade: 'Kubernetes upgrades of an imported cluster are done by its provider (cloud console / CLI). On-prem kubeadm, k3s or RKE2: add SSH in the connection settings.',
    scale: 'Nodes of an imported cluster are added and removed where it is run (node pools in the cloud console, or your own tooling).',
    nodeTerminal: 'A shell on the nodes needs SSH. Use the cluster terminal (kubectl) instead, or add SSH for on-prem clusters.',
    resume: 'Only clusters KubeEZ installed can resume an install.',
    certRotation: 'Control-plane certificates of an imported cluster are managed by its provider.'
}
// Features that change things inside the cluster — need "Full manage" access
const WRITE_FEATURES = ['addons', 'healing', 'actions', 'yamlApply', 'backup', 'namespaceAccess', 'terminal', 'kubeconfig']

/**
 * What KubeEZ can do on this cluster → { feature: { ok, why? } }. Clusters
 * KubeEZ installed can do everything.
 */
export function capabilities(c) {
    const out = {}
    const api = usesApi(c)
    const read = c?.access?.level !== 'full'
    for (const [k, why] of Object.entries(NODE_FEATURES)) out[k] = api ? { ok: false, why } : { ok: true }
    for (const k of WRITE_FEATURES) out[k] = api && read ? { ok: false, why: 'This cluster is connected read-only — switch it to "Full manage" in its connection settings.' } : { ok: true }
    return out
}
export const can = (c, feature) => capabilities(c)[feature]?.ok !== false
export function requireCapability(c, feature) {
    const cap = capabilities(c)[feature]
    if (cap && !cap.ok) throw Object.assign(new Error(cap.why), { status: 409, code: 'NOT_ON_IMPORTED' })
}

// ── the sandbox ─────────────────────────────────────────────────────────────
const BIN = {
    bash: process.env.KUBEEZ_SANDBOX_BASH || ['/usr/local/bin/bash', '/bin/bash'].find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false } }) || '/bin/sh',
    kubectl: process.env.KUBEEZ_KUBECTL || '/usr/local/bin/kubectl',
    helm: process.env.KUBEEZ_HELM || '/usr/local/bin/helm'
}
// The unprivileged user a script runs as — one per cluster (a run for one
// cluster can never read another cluster's temporary kubeconfig). Only when
// KubeEZ itself runs as root on Linux (the Docker image).
const SANDBOX_BASE_UID = Number(process.env.KUBEEZ_SANDBOX_UID ?? 200000)
const dropPrivileges = () => process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0 && SANDBOX_BASE_UID > 0
export function sandboxUid(key) {
    let h = 2166136261
    for (const ch of String(key || 'kubeez')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
    return SANDBOX_BASE_UID + (h % 100000)
}

/**
 * KubeEZ's own files must stay out of a sandboxed script's reach: the data
 * folder (users, agent tokens, encrypted credentials) and .env become
 * owner-only. Called once at startup.
 */
export function lockDownServerFiles(dataDir) {
    if (!dropPrivileges()) return
    for (const [p, mode] of [[dataDir, 0o700], [path.join(process.cwd(), '.env'), 0o600], [path.join(process.cwd(), 'logs'), 0o700]]) {
        try { if (fs.existsSync(p)) fs.chmodSync(p, mode) } catch (e) { console.warn(`[Sandbox] Could not restrict ${p}: ${e.message}`) }
    }
}
const NODE_TOOLS = ['df', 'du', 'kubeadm', 'kubelet', 'systemctl', 'service', 'journalctl', 'crictl', 'ctr', 'containerd', 'docker', 'etcdctl', 'etcdutl', 'curl', 'wget', 'hostname', 'ip', 'ss', 'netstat', 'mount', 'findmnt', 'lsblk', 'free', 'uptime', 'nproc', 'top', 'vmstat', 'iostat', 'lscpu', 'dmidecode', 'swapon', 'swapoff', 'modprobe', 'sysctl', 'iptables', 'apt-get', 'yum', 'dnf', 'k3s', 'rke2', 'microk8s']
const SHIMS = {
    kubectl: '#!/bin/sh\nexec "$KZ_KUBECTL" --kubeconfig "$KZ_KUBECONFIG" "$@"\n',
    helm: '#!/bin/sh\nexec "$KZ_HELM" --kubeconfig "$KZ_KUBECONFIG" "$@"\n',
    // `sudo [-n -E …] [VAR=value …] cmd …` → the same command, without sudo
    sudo: '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -u|-g|-C|-h|-p|-U) shift 2;; --) shift; break;; -*) shift;; *) break;; esac; done\n[ $# -eq 0 ] && exit 0\nexec env "$@"\n',
    ...Object.fromEntries(NODE_TOOLS.map(t => [t, `#!/bin/sh\necho "${t}: not available on an imported cluster (no node access)" >&2\nexit 127\n`]))
}
let shimDir = null
function shims() {
    if (shimDir && fs.existsSync(shimDir)) return shimDir
    const dir = path.join(os.tmpdir(), `kubeez-shims-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    for (const [name, body] of Object.entries(SHIMS)) fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 })
    shimDir = dir
    return dir
}

/** A kubeconfig (JSON is valid kubeconfig) for this target. */
// clientCert / clientKey: only while a pasted admin kubeconfig sets up the `kubeez` account
export function kubeconfigFor({ server, ca, token, clientCert = null, clientKey = null, tlsServerName, insecure = false }) {
    return {
        apiVersion: 'v1', kind: 'Config', 'current-context': 'kubeez',
        clusters: [{ name: 'kubeez', cluster: { server, ...(ca ? { 'certificate-authority-data': ca } : {}), ...(tlsServerName ? { 'tls-server-name': tlsServerName } : {}), ...(insecure ? { 'insecure-skip-tls-verify': true } : {}) } }],
        users: [{ name: 'kubeez', user: token ? { token } : { 'client-certificate-data': clientCert, 'client-key-data': clientKey } }],
        contexts: [{ name: 'kubeez', context: { cluster: 'kubeez', user: 'kubeez' } }]
    }
}

/**
 * Run a script against a target in the sandbox → { stdout, stderr, code }.
 * target: { server, ca, token, tlsServerName }
 */
export async function runSandboxed(target, script, { stdin = null, timeoutMs = 10 * 60e3, maxBytes = 48 << 20, keepAlive = null } = {}) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kz-run-'))
    const kc = path.join(dir, 'kubeconfig')
    await fs.promises.writeFile(kc, JSON.stringify(kubeconfigFor(target)), { mode: 0o600 })
    const drop = dropPrivileges()
    const uid = sandboxUid(target.uidKey || target.server)
    if (drop) { await fs.promises.chown(dir, uid, uid); await fs.promises.chown(kc, uid, uid) }
    const env = {
        PATH: `${shims()}:/usr/local/bin:/usr/bin:/bin`, HOME: dir, TMPDIR: dir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        KZ_KUBECONFIG: kc, KUBECONFIG: kc, KZ_KUBECTL: BIN.kubectl, KZ_HELM: BIN.helm,
        HELM_CACHE_HOME: path.join(dir, '.helm-cache'), HELM_CONFIG_HOME: path.join(dir, '.helm-config'), HELM_DATA_HOME: path.join(dir, '.helm-data'),
        KUBEEZ_IMPORTED: '1'
    }
    return new Promise((resolve) => {
        let out = [], err = [], size = 0, done = false
        const child = spawn(BIN.bash, ['-c', script], { cwd: dir, env, detached: process.platform !== 'win32', ...(drop ? { uid, gid: uid } : {}), windowsHide: true })
        const finish = (code) => {
            if (done) return; done = true
            clearTimeout(timer)
            fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { })
            resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code })
        }
        const kill = () => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { } } }
        const timer = setTimeout(() => { err.push(Buffer.from(`\n(timed out after ${Math.round(timeoutMs / 1000)} s)`)); kill(); finish(124) }, timeoutMs)
        timer.unref?.()
        const take = (arr) => (d) => { size += d.length; if (size <= maxBytes) arr.push(d); else if (!done) { err.push(Buffer.from('\n(output too large — stopped)')); kill(); finish(1) } }
        child.stdout.on('data', take(out)); child.stderr.on('data', take(err))
        child.on('error', (e) => { err.push(Buffer.from(String(e.message))); finish(127) })
        child.on('close', (code) => finish(code ?? 1))
        if (stdin != null) child.stdin.end(stdin); else child.stdin.end()
        keepAlive?.(child, kill)
    })
}

// ── reaching the API server ─────────────────────────────────────────────────
// gateway / agent: a local port on the KubeEZ server whose connections are
// carried through the agent's TCP stream to the API server (kubectl talks to
// 127.0.0.1:<port>, the certificate is checked against the real name).
const forwarders = new Map()   // clusterId → { server, port, timer, key }
const FORWARD_IDLE_MS = 5 * 60e3

async function openThroughAgent(cluster, host, port) {
    const { agentService } = await import('./agentService.js')
    const a = cluster.access
    if (a.mode === 'agent') {
        const agentId = a.agentId
        if (!agentId || !agentService.isAgentOnline(agentId)) throw Object.assign(new Error('The KubeEZ agent in this cluster is not connected — check its pod: kubectl -n kubeez-system get pods'), { code: 'AGENT_OFFLINE', status: 503 })
        return agentService.openTcp(agentId, null, host, port)
    }
    const gw = a.gatewayAgentId && agentService.isAgentOnline(a.gatewayAgentId) ? { agentId: a.gatewayAgentId } : await agentService.getGatewayAgentForOwner(cluster.ownerId, 'admin', cluster.orgId)
    if (!gw) throw Object.assign(new Error('No Gateway Agent of this workspace is online — this cluster is reached through one (Gateway Agents page).'), { code: 'GATEWAY_OFFLINE', status: 503 })
    return agentService.openTcp(gw.agentId, null, host, port)
}

async function forwarderFor(cluster, host, port) {
    const key = `${cluster.id}|${host}|${port}|${cluster.access.mode}|${cluster.access.agentId || cluster.access.gatewayAgentId || ''}`
    let f = forwarders.get(key)
    if (f?.ready) { touch(key); return f.ready }
    const server = net.createServer((sock) => {
        touch(key)
        sock.on('error', () => { })
        openThroughAgent(cluster, host, port).then((remote) => {
            remote.on('error', () => sock.destroy())
            sock.pipe(remote); remote.pipe(sock)
            sock.on('close', () => remote.destroy?.())
            remote.on('close', () => sock.destroy())
        }).catch(() => sock.destroy())
    })
    const ready = new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    f = { server, ready }
    forwarders.set(key, f)
    touch(key)
    try { return await ready } catch (e) { forwarders.delete(key); throw e }
}
function touch(key) {
    const f = forwarders.get(key); if (!f) return
    clearTimeout(f.timer)
    f.timer = setTimeout(() => { try { f.server.close() } catch { } forwarders.delete(key) }, FORWARD_IDLE_MS)
    f.timer.unref?.()
}
/** Close every local port of a cluster (it was removed or reconnected). */
export function closeForwarders(clusterId) {
    for (const [k, f] of forwarders) if (k.startsWith(`${clusterId}|`)) { clearTimeout(f.timer); try { f.server.close() } catch { } forwarders.delete(k) }
}

/** The API server as KubeEZ reaches it now → { server, ca, token, tlsServerName } */
export async function apiTarget(cluster) {
    const a = cluster.access
    if (!a?.mode) throw Object.assign(new Error('This cluster is not connected through the Kubernetes API'), { status: 400 })
    const token = (() => { try { return decrypt(a.token) } catch { return null } })()
    if (!token) throw Object.assign(new Error('The access token of this cluster cannot be read — reconnect it (Connected clusters → Reconnect).'), { code: 'TOKEN_UNREADABLE', status: 409 })
    if (a.mode === 'direct') return { server: a.server, ca: a.ca, token, uidKey: cluster.id }
    // in the cluster, the API is the `kubernetes` Service; outside, the address in the kubeconfig
    const u = new URL(a.mode === 'agent' ? 'https://kubernetes.default.svc:443' : a.server)
    const host = u.hostname.replace(/^\[|\]$/g, ''), port = Number(u.port || 443)
    const local = await forwarderFor(cluster, host, port)
    return { server: `https://127.0.0.1:${local}`, ca: a.ca, token, tlsServerName: a.mode === 'agent' ? 'kubernetes.default.svc' : host, uidKey: cluster.id }
}

/** An SSH-like connection running scripts against the cluster's API. */
export function apiShell(cluster) {
    return {
        api: true,
        isConnected: () => true,
        async execCommand(cmd, opts = {}) {
            // looked up on every call: a local port that was closed (reconnect, new token) is opened again
            let t
            try { t = await apiTarget(cluster) } catch (e) { return { stdout: '', stderr: e.message, code: 255 } }
            return runSandboxed(t, String(cmd), { stdin: opts.stdin ?? null, timeoutMs: opts.timeoutMs })
        },
        dispose() { }
    }
}

/**
 * The connection every feature uses: SSH to the first control-plane, or the
 * API shell for an imported cluster. opts are passed to SSH.
 */
export async function connectCluster(cluster, opts) {
    if (usesApi(cluster)) return apiShell(cluster)
    const master = cluster?.masterNodes?.[0]
    if (!master) throw Object.assign(new Error('No control-plane node saved for this cluster'), { status: 400 })
    const { automationEngine } = await import('./automationEngine.js')
    return automationEngine.connectSSH({ ...master, ownerId: cluster.ownerId, orgId: cluster.orgId }, opts)
}

// ── TCP to a Service inside the cluster (Explorer, the AI add-on…) ──────────
// agent: the agent inside the cluster connects to it. direct / gateway: a
// `kubectl port-forward` (through the API server) kept open for a while.
const portForwards = new Map()   // key → { ready, child, kill, timer }
async function serviceOf(cluster, host) {
    // a ClusterIP → its Service (port-forward needs the name)
    if (!/^[\d.:a-f]+$/i.test(host)) { const m = /^([a-z0-9-]+)\.([a-z0-9-]+)(\.svc(\.cluster\.local)?)?$/.exec(host); return m ? { ns: m[2], name: m[1] } : null }
    const r = await runSandboxed(await apiTarget(cluster), `kubectl get svc -A -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.name} {.spec.clusterIP}{"\\n"}{end}' --request-timeout=20s`, { timeoutMs: 30000 })
    const row = r.stdout.split('\n').map(l => l.trim().split(' ')).find(p => p[2] === host)
    return row ? { ns: row[0], name: row[1] } : null
}
async function portForward(cluster, ns, name, port) {
    const key = `${cluster.id}|${ns}|${name}|${port}`
    const f = portForwards.get(key)
    if (f?.ready) { pfTouch(key); return f.ready }
    const target = await apiTarget(cluster)
    const entry = {}
    entry.ready = new Promise((resolve, reject) => {
        let seen = ''
        runSandboxed(target, `exec kubectl -n ${ns} port-forward svc/${name} :${Number(port)} --address 127.0.0.1`, {
            timeoutMs: 6 * 3600e3,
            keepAlive: (child, kill) => {
                entry.kill = kill
                const onOut = (d) => {
                    seen += d.toString()
                    const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(seen)
                    if (m) { child.stdout.off('data', onOut); resolve(Number(m[1])) }
                }
                child.stdout.on('data', onOut)
            }
        }).then((r) => { portForwards.delete(key); reject(new Error((r.stderr || 'port-forward ended').trim().split('\n').pop())) })
        setTimeout(() => reject(new Error('port-forward did not start in time')), 30000).unref?.()
    })
    portForwards.set(key, entry)
    pfTouch(key)
    try { return await entry.ready } catch (e) { portForwards.delete(key); entry.kill?.(); throw e }
}
function pfTouch(key) {
    const f = portForwards.get(key); if (!f) return
    clearTimeout(f.timer)
    f.timer = setTimeout(() => { f.kill?.(); portForwards.delete(key) }, FORWARD_IDLE_MS)
    f.timer.unref?.()
}

/** A Duplex to host:port inside an imported cluster. */
export async function openInCluster(cluster, host, port) {
    if (cluster.access?.mode === 'agent') {
        // the agent reaches Services by name or ClusterIP
        return openThroughAgent(cluster, host, port)
    }
    const svc = await serviceOf(cluster, host)
    if (!svc) throw Object.assign(new Error(`Nothing in the cluster answers at ${host}:${port}`), { status: 404 })
    const local = await portForward(cluster, svc.ns, svc.name, port)
    pfTouch(`${cluster.id}|${svc.ns}|${svc.name}|${port}`)
    return net.connect(local, '127.0.0.1')
}

export const _test = { SHIMS, NODE_TOOLS, BIN, randomBytes }
