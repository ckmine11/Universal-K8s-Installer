// A command plus its stdin, as plain shell commands — for connections that can
// only send a command line (the Gateway Agent's SSH relay has no stdin).
// The data travels base64-encoded (only [A-Za-z0-9+/=], safe in single quotes)
// and is decoded on the node into the command's stdin. One shell argument is
// limited to ~128 KB on Linux nodes, so data above 24 KB of base64 is first
// written in chunks to a private temp file (umask 077, removed afterwards).
// Kubernetes manifests usually fit inline.
const CHUNK = 24 * 1024     // base64 characters per command

/**
 * → { steps: [command…], run: command } — run each step in order (they print
 * nothing that matters), then `run`, whose exit code and output are the command's.
 * chunk: base64 characters per command (tests on Windows, whose bash takes ~8 KB, pass less).
 */
export function stdinCommands(command, stdin, { chunk = CHUNK } = {}) {
    const b64 = Buffer.from(stdin == null ? '' : String(stdin)).toString('base64')
    if (b64.length <= chunk) return { steps: [], run: `printf '%s' '${b64}' | base64 -d | (\n${command}\n)` }
    const file = `/tmp/kubeez-stdin-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const steps = [`umask 077; : > '${file}'`]
    for (let i = 0; i < b64.length; i += chunk) steps.push(`printf '%s' '${b64.slice(i, i + chunk)}' >> '${file}'`)
    return { steps, run: `base64 -d '${file}' | (\n${command}\n); rc=$?; rm -f '${file}'; exit $rc` }
}
