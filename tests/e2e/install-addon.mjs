// Install / change an add-on on an e2e node exactly the way KubeEZ does it
// (plan files → helm-addon.sh → settings history), through `docker exec`
// instead of SSH.
//
//   library:  const { installAddon } = await import('./install-addon.mjs')
//             await installAddon(container, 'seaweedfs', { settings: {...}, advanced, version })
//   CLI:      node tests/e2e/install-addon.mjs <container> <key> ['{"settings":{...}}']
//
// The importer sets KUBEEZ_DATA_DIR first when it wants its own data folder.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.env.KUBEEZ_DATA_DIR) process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-addon-'))
process.env.APP_SECRET ||= 'e2e-only-secret-0123456789abcdef0123456789abcdef'
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
export const dxOn = (node) => (cmd) => { const r = spawnSync('docker', ['exec', node, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 256 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }

const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { addonSettingsStore } = await import('../../backend/src/services/addonSettings.js')
let jobN = 0

/** One add-on job; resolves { ok, error, lines, seconds } (never throws) */
export async function installAddon(node, key, desired = undefined, { clusterId = 'c-e2e', clusterAddons = {}, k8sVersion = '1.35.0', orgId = 'org-e2e', quiet = false } = {}) {
    const dx = dxOn(node)
    const ip = dx('hostname -I').stdout.split(' ')[0]
    // like real SSH: the script's output lines also reach the job log
    const ssh = { execCommand: async (cmd, o) => { const r = dx(cmd); if (r.stdout) o?.onStdout?.(Buffer.from(r.stdout + '\n')); if (r.stderr) o?.onStderr?.(Buffer.from(r.stderr)); return r }, dispose() {} }
    const prevConnect = automationEngine.connectSSH
    automationEngine.connectSSH = async () => ssh
    const lines = []
    const onLog = (level, msg) => { lines.push(String(msg)); if (!quiet && (level === 'error' || /KUBEEZ_FAIL|✓ .* ready|Installing|Changing|Taking over|⚠|runs now/.test(msg))) console.log(`   ${String(msg).slice(0, 220)}`) }
    const inst = { id: `e2e-${process.pid}-${++jobN}`, originalClusterId: clusterId, orgId, k8sVersion, masterNodes: [{ ip }], workerNodes: [], addons: { [key]: true }, clusterAddons, requestedBy: 'e2e',
        ...(desired ? { addonSettings: { [key]: desired } } : {}) }
    const t = Date.now()
    try {
        await automationEngine.installHelmAddon(ssh, inst, key, onLog, { timeoutMs: 30 * 60e3 })
        return { ok: true, lines, seconds: Math.round((Date.now() - t) / 1000) }
    } catch (e) {
        return { ok: false, error: e.message, lines, seconds: Math.round((Date.now() - t) / 1000) }
    } finally { automationEngine.connectSSH = prevConnect }
}

export const appliedSettings = (key, clusterId = 'c-e2e') => addonSettingsStore.get(clusterId, key)

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const [node, key, json] = process.argv.slice(2)
    const r = await installAddon(node, key, json ? JSON.parse(json) : undefined)
    if (!r.ok) { console.log(r.lines.slice(-30).join('\n')); console.error(`✗ ${key}: ${r.error}`); process.exit(1) }
    console.log(`✓ ${key} installed (${r.seconds}s)`)
}
