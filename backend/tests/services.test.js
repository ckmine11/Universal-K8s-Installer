// In-process service tests (no network, no real nodes). Each test file runs in
// its own process, so the data dir must be set BEFORE the services are imported.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'
process.env.SMTP_HOST = '127.0.0.1'   // never send real mail
process.env.SMTP_PORT = '1'

const { authService } = await import('../src/services/authService.js')
const { agentService } = await import('../src/services/agentService.js')
const { automationEngine } = await import('../src/services/automationEngine.js')
const { BackupService } = await import('../src/services/backupService.js')
const { clusterStore } = await import('../src/services/clusterStore.js')

after(() => fs.rmSync(DATA, { recursive: true, force: true }))

// ── Password reset ───────────────────────────────────────────────────────────
test('password reset: hashed, email-bound, burns after 5 tries', async () => {
    await authService.registerUser('carol', 'oldpass1', 'carol@example.com')
    const u = authService.users.find(x => x.username === 'carol')
    const issue = () => { u.resetToken = crypto.createHash('sha256').update('123456').digest('hex'); u.resetTokenExpiry = Date.now() + 60000; u.resetAttempts = 0 }

    issue()
    assert.ok(!fs.readFileSync(path.join(DATA, 'users.json'), 'utf8').includes('"123456"'), 'code is not stored in plain text')
    await assert.rejects(authService.resetPassword('other@example.com', '123456', 'newpass1'), 'bound to the email')

    for (let i = 0; i < 5; i++) await authService.resetPassword('carol@example.com', '000000', 'newpass1').catch(() => {})
    await assert.rejects(authService.resetPassword('carol@example.com', '123456', 'newpass1'), 'burned after 5 wrong attempts')

    issue()
    await authService.resetPassword('carol@example.com', '123456', 'newpass1')
    assert.ok(await authService.login('carol', 'newpass1'))
})

// ── Gateway agents ───────────────────────────────────────────────────────────
test('agents.json: concurrent creates + status updates lose nothing', async () => {
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => agentService.generateToken('o' + i, 'u', 'org', '')))
    await Promise.all([
        ...created.map(a => agentService._updateAgentStatus(a.agentId, 'online')),
        ...Array.from({ length: 10 }, () => agentService.generateToken('x', 'u', 'org', ''))
    ])
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'agents.json'), 'utf8'))
    assert.equal(onDisk.length, 30)
    assert.equal(onDisk.filter(a => a.status === 'online').length, 20)
})

test('an agent can only answer commands sent to it', () => {
    let resolved = false
    agentService.pendingCommands.set('cmd1', { agentId: 'A', resolve: () => { resolved = true }, reject() {}, timeout: setTimeout(() => {}, 1) })
    agentService._resolveCommand('B', 'cmd1', { exitCode: 0 })
    assert.equal(resolved, false)
    agentService._resolveCommand('A', 'cmd1', { exitCode: 0 })
    assert.equal(resolved, true)
})

// ── Upgrade engine ───────────────────────────────────────────────────────────
const FAIL_OUT = '[x] doing stuff\nKUBEEZ_FAIL|CGROUP_V1|This node uses cgroups v1.|Enable cgroups v2 and reboot.\n'

test('upgrade: preflight failure stops before touching any node, reason reaches the UI', async () => {
    const original = automationEngine.connectSSH
    automationEngine.connectSSH = async (node) => ({
        async execCommand(cmd, cfg = {}) {
            if (cmd.startsWith('sudo bash') && / 'check'$/.test(cmd) && node.ip === '10.0.0.2') {
                cfg.onStdout?.(Buffer.from(FAIL_OUT)); return { code: 1, stdout: FAIL_OUT, stderr: '' }
            }
            if (cmd.startsWith('sudo bash')) { cfg.onStdout?.(Buffer.from('ok\n')); return { code: 0, stdout: 'ok', stderr: '' } }
            return { code: 0, stdout: '', stderr: '' }
        },
        dispose() {}
    })
    try {
        const logs = []; let err = null, done = false
        await automationEngine.upgradeCluster(
            { k8sVersion: '1.34.0', masterNodes: [{ ip: '10.0.0.1' }], workerNodes: [{ ip: '10.0.0.2' }] }, '1.35.0',
            { onLog: (l, m) => logs.push(m), onProgress() {}, onComplete() { done = true }, onError(e) { err = e } })
        assert.equal(done, false)
        assert.equal(err?.diagnosis?.reason, 'CGROUP_V1')
        assert.match(err.diagnosis.message, /\[10\.0\.0\.2\].*Nothing was changed/)
        assert.equal(err.diagnosis.suggestedFix, 'Enable cgroups v2 and reboot.')
        assert.ok(!logs.some(l => l.includes('KUBEEZ_FAIL|')), 'machine line hidden from the log')
        assert.ok(!logs.some(l => /Processing Node/.test(l)), 'no node was upgraded')
    } finally {
        automationEngine.connectSSH = original
    }
})

test('upgrade: progress bar moves forward only, smoothly, across nodes', async () => {
    const STAGES = [5, 8, 15, 30, 40, 55, 78, 85, 92, 100]
    const out = STAGES.map(p => `[log] stage ${p}\nKUBEEZ_PROGRESS|${p}|Stage ${p}\n`).join('')
    const original = automationEngine.connectSSH
    automationEngine.connectSSH = async () => ({
        async execCommand(cmd, cfg = {}) {
            if (!cmd.startsWith('sudo bash')) return { code: 0, stdout: '', stderr: '' }
            const text = / 'check'$/.test(cmd) ? '[log] preflight ok\n' : out
            for (let i = 0; i < text.length; i += 7) cfg.onStdout?.(Buffer.from(text.slice(i, i + 7)))  // split lines across chunks
            return { code: 0, stdout: text, stderr: '' }
        },
        dispose() {}
    })
    try {
        const seq = [], logs = []; let done = false
        await automationEngine.upgradeCluster(
            { k8sVersion: '1.34.0', masterNodes: [{ ip: '10.0.0.1' }], workerNodes: [{ ip: '10.0.0.2' }] }, '1.35.0',
            { onLog: (l, m) => logs.push(m), onProgress: (p, s) => seq.push([p, s]), onComplete() { done = true }, onError(e) { throw e } })
        const p = seq.map(x => x[0])
        assert.ok(done)
        assert.ok(p.every((v, i) => i === 0 || v >= p[i - 1]), 'never backwards: ' + p.join(','))
        assert.equal(p.at(-1), 100)
        assert.ok(p.filter(v => v > 5 && v < 52).length >= 8 && p.filter(v => v >= 52 && v < 100).length >= 8, 'steps on both nodes')
        assert.equal(logs.filter(l => /^\[log\] stage/.test(l)).length, 20, 'chunk-split lines logged whole')
        assert.ok(!logs.some(l => l.includes('KUBEEZ_')))
    } finally {
        automationEngine.connectSSH = original
    }
})

test('upgrade: skip-level path is rejected with an on-screen reason', async () => {
    let err = null
    await automationEngine.upgradeCluster({ k8sVersion: '1.33.0', masterNodes: [{ ip: '1.1.1.1' }] }, '1.35.0',
        { onLog() {}, onProgress() {}, onComplete() {}, onError(e) { err = e } })
    assert.equal(err?.diagnosis?.reason, 'INVALID_UPGRADE_PATH')
})

test('pod CIDR: calico and flannel get matching kubeadm/CNI CIDRs', () => {
    assert.equal(automationEngine.podNetworkCidr({ networkPlugin: 'calico' }), '192.168.0.0/16')
    assert.equal(automationEngine.podNetworkCidr({ networkPlugin: 'flannel' }), '10.244.0.0/16')
    assert.equal(automationEngine.podNetworkCidr({ networkPlugin: 'calico', podNetworkCidr: '10.10.0.0/16' }), '10.10.0.0/16')
})

// ── Config backups ───────────────────────────────────────────────────────────
test('config backups are per user, encrypted, and restore only own files', async () => {
    await clusterStore.saveCluster({ id: 'b1', ownerId: 'u1', orgId: 'o1', clusterName: 'one', masterNodes: [{ ip: '10.1.1.1', username: 'root', password: 'TopSecret' }] })
    await clusterStore.saveCluster({ id: 'b2', ownerId: 'u2', orgId: 'o2', clusterName: 'two', masterNodes: [{ ip: '10.2.2.2', username: 'root', password: 'Other' }] })

    const r = BackupService.createBackup('manual', 'u1')
    assert.ok(r.success)
    const file = fs.readFileSync(path.join(DATA, 'backups', r.filename), 'utf8')
    assert.ok(!file.includes('TopSecret'), 'password encrypted in the backup')
    assert.ok(!file.includes('"b2"'), 'only the owner\'s clusters are included')

    assert.equal((await BackupService.restoreBackup(r.filename, 'u2')).success, false, 'other user cannot restore it')
    assert.equal((await BackupService.restoreBackup('../users.json', 'u1')).success, false, 'path traversal rejected')
    assert.ok((await BackupService.restoreBackup(r.filename, 'u1')).success)
    const after = await clusterStore.getClusters()
    assert.equal(after.find(c => c.id === 'b1').masterNodes[0].password, 'TopSecret', 'restored credentials still decrypt')
})
