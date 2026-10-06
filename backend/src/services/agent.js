// KubeEZ Gateway Agent — runs on a machine inside the customer's network and
// relays SSH commands from KubeEZ through an OUTBOUND WebSocket (no inbound ports).
//
// Built into public/agent-bundle.js (one file, no node_modules needed) and
// installed as a service by /agent-install.sh (systemd / launchd) or
// /agent-install.ps1 (Scheduled Task), so it survives reboots and crashes.
//
//   node agent-bundle.js                          ← reads ./config.json (written by the installer)
//   node agent-bundle.js --config <file>
//   node agent-bundle.js --token T --agent-id A --server wss://…
//
// Besides commands, the agent relays TCP streams (tcp-open/-data/-close) to
// addresses its SSH sessions can reach — used for in-cluster web tools like the
// KubeEZ Explorer, so they need no open ports either.
//
// Exit codes: 78 = this agent was removed / its token revoked in KubeEZ (a
// service manager must NOT restart it); 0 = replaced by another copy of itself.
const WebSocket = require('ws');
const { NodeSSH } = require('node-ssh');
const fs = require('fs');
const path = require('path');

const EXIT_REVOKED = 78;
const PING_EVERY_MS = Number(process.env.KUBEEZ_AGENT_PING_MS) || 20000;   // heartbeat (server drops after 60 s of silence)
const DEAD_AFTER_MS = 60000;   // no answer for this long → the link is dead, reconnect
const MAX_BACKOFF_MS = 60000;

// ── Configuration: command line > config file ──────────────────────────────
const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i += 2) argMap[String(args[i]).replace(/^--/, '')] = args[i + 1];

let fileCfg = {};
const cfgPath = argMap.config || path.join(__dirname, 'config.json');
try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { /* no config file */ }

const token = argMap.token || fileCfg.token;
const agentId = argMap['agent-id'] || fileCfg.agentId;
const server = argMap.server || fileCfg.server;

if (!token || !agentId || !server) {
    console.error('Usage: node agent-bundle.js [--config <file>] | --token <TOKEN> --agent-id <AGENT_ID> --server <WSS_URL>');
    console.error(`(no usable config at ${cfgPath})`);
    process.exit(1);
}

const log = (...m) => console.log(new Date().toISOString(), '[Gateway Agent]', ...m);

// A bug or an unexpected library error must never take the tunnel down for good.
process.on('uncaughtException', (e) => log('Unexpected error (continuing):', e && e.stack || e));
process.on('unhandledRejection', (e) => log('Unhandled rejection (continuing):', e && e.message || e));

// Sessions are cached per user + host + credential: a command for one account
// must never run in a session another account opened (and a wrong password must
// not "work" because some other session to the host is still open).
const sshSessions = new Map();
const connecting = new Map();   // key → login in progress (shared by concurrent commands)
const crypto = require('crypto');
const sessionKey = (ip, username, password, privateKey) =>
    crypto.createHash('sha256').update([ip, username, password || '', privateKey || ''].join('\0')).digest('hex');
let attempt = 0;
// Capabilities this agent build offers (KubeEZ checks before using them)
const CAPS = ['tcp'];
const tcpStreams = new Map();   // streamId → ssh forwarding channel

// One SSH login per account+host, shared by commands and TCP streams
async function getSession(ip, username, password, privateKey) {
    const key = sessionKey(ip, username, password, privateKey);
    let ssh = sshSessions.get(key);
    if (ssh && ssh.isConnected()) return { ssh, key };
    // Several requests arrive at once (live metrics sends 5): share ONE login
    // instead of opening 5 connections and leaking 4 of them
    let pending = connecting.get(key);
    if (!pending) {
        pending = (async () => {
            const s = new NodeSSH();
            await s.connect({ host: ip, username, password, privateKey, tryKeyboard: true, readyTimeout: 60000 });
            sshSessions.set(key, s);
            log(`SSH connected to ${ip}`);
            return s;
        })().finally(() => connecting.delete(key));
        connecting.set(key, pending);
    }
    return { ssh: await pending, key };
}

function closeStreams() {
    for (const st of tcpStreams.values()) { try { st.destroy(); } catch (_) {} }
    tcpStreams.clear();
}

function closeSessions() {
    closeStreams();
    for (const ssh of sshSessions.values()) { try { ssh.dispose(); } catch (_) {} }
    sshSessions.clear();
}

function connect() {
    const ws = new WebSocket(`${server}/ws/agent/${agentId}?token=${encodeURIComponent(token)}`, {
        handshakeTimeout: 20000
    });
    let pingTimer = null;
    let lastHeard = Date.now();
    const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

    ws.on('open', () => {
        attempt = 0;
        lastHeard = Date.now();
        log(`Connected to ${server} — bridging the local network`);
        send({ type: 'register-ips', ips: ['gateway'], caps: CAPS });
        pingTimer = setInterval(() => {
            // A connection that died silently (NAT/proxy/Wi-Fi change) never fires
            // 'close' — notice the missing answers and reconnect.
            if (Date.now() - lastHeard > DEAD_AFTER_MS) {
                log(`No answer from KubeEZ for ${Math.round(DEAD_AFTER_MS / 1000)}s — reconnecting`);
                return ws.terminate();
            }
            send({ type: 'ping' });
        }, PING_EVERY_MS);
    });

    ws.on('message', async (data) => {
        lastHeard = Date.now();
        let msg;
        try { msg = JSON.parse(data); } catch (e) { return log('Ignoring malformed message:', e.message); }
        // ── TCP streams: KubeEZ ⇄ (this agent) ⇄ SSH session ⇄ host:port ──
        if (msg.type === 'tcp-open') {
            const { streamId, ip, username, password, privateKey, host, port } = msg;
            try {
                const { ssh } = await getSession(ip, username, password, privateKey);
                const ch = await ssh.forwardOut('127.0.0.1', 0, String(host), Number(port));
                tcpStreams.set(streamId, ch);
                ch.on('data', (d) => send({ type: 'tcp-data', streamId, data: d.toString('base64') }));
                ch.on('close', () => { if (tcpStreams.delete(streamId)) send({ type: 'tcp-close', streamId }); });
                ch.on('error', () => {});
                send({ type: 'tcp-opened', streamId });
            } catch (error) {
                send({ type: 'tcp-close', streamId, error: error.message });
            }
            return;
        }
        if (msg.type === 'tcp-data') {
            const ch = tcpStreams.get(msg.streamId);
            if (ch) ch.write(Buffer.from(msg.data || '', 'base64'));
            return;
        }
        if (msg.type === 'tcp-close') {
            const ch = tcpStreams.get(msg.streamId);
            if (ch) { tcpStreams.delete(msg.streamId); try { ch.end(); } catch (_) {} }
            return;
        }
        if (msg.type !== 'execute-ssh') return;

        const { commandId, ip, username, password, command, privateKey } = msg;
        const key = sessionKey(ip, username, password, privateKey);
        try {
            const { ssh } = await getSession(ip, username, password, privateKey);
            log(`Running on ${ip}: ${String(command).substring(0, 50)}...`);
            const result = await ssh.execCommand(command, { options: { pty: true } });
            // code is null when the process was killed by a signal — that's a failure, not success
            const exitCode = typeof result.code === 'number' ? result.code : (result.signal ? 1 : 0);
            send({ type: 'command-result', commandId, stdout: result.stdout, stderr: result.stderr, exitCode });
        } catch (error) {
            log(`SSH error on ${ip}:`, error.message);
            send({ type: 'command-result', commandId, stdout: '', stderr: error.message, exitCode: 1 });
            sshSessions.delete(key); // reconnect next time
        }
    });

    ws.on('close', (code, reason) => {
        if (pingTimer) clearInterval(pingTimer);
        closeSessions();
        const why = String(reason || '');
        if (code === 4001) {
            log(`KubeEZ rejected this agent (${why || 'invalid token'}) — it was removed or its token was changed.`);
            log('Install a new agent from the KubeEZ "Tunnels" page. Stopping.');
            process.exit(EXIT_REVOKED);
        }
        if (code === 4000) {
            log('Another copy of this agent connected — this older copy stops.');
            process.exit(0);
        }
        // Exponential backoff with jitter: 2s, 4s, 8s … max 60s
        attempt += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 6)) * (0.8 + Math.random() * 0.4);
        log(`Disconnected (${code}${why ? ' ' + why : ''}). Reconnecting in ${Math.round(delay / 1000)}s...`);
        setTimeout(connect, delay);
    });

    ws.on('error', (e) => log('Connection error:', e.message));
}

log(`Starting (agent ${agentId.slice(0, 8)}…, server ${server})`);
connect();
