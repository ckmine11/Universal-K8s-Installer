// Every alert type, raised through its real code path, must arrive at the
// workspace's channel. (A local webhook stands in for Telegram/Slack/…)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
process.env.KUBEEZ_AGENT_OFFLINE_ALERT_MS = '150'
process.env.KUBEEZ_UNREACHABLE_ALERT_MS = '1'
delete process.env.KUBEEZ_MODE

const got = []
let hook, hookUrl
before(async () => {
    hook = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push(JSON.parse(b || '{}')); res.end('ok') }) })
    await new Promise(r => hook.listen(0, '127.0.0.1', r))
    hookUrl = `http://127.0.0.1:${hook.address().port}/hook`
})
after(() => { hook.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

const { notificationStore, EVENTS } = await import('../src/services/notificationStore.js')
const { authService } = await import('../src/services/authService.js')
const { incidentDetector } = await import('../src/services/incidentDetector.js')
const { remediationEngine } = await import('../src/services/remediationEngine.js')
const { installationManager, jobDoneAlert } = await import('../src/services/installationManager.js')
const { agentService } = await import('../src/services/agentService.js')
const { alertEtcdJob } = await import('../src/routes/installation.js')
const { BackupService } = await import('../src/services/backupService.js')
const { automationEngine } = await import('../src/services/automationEngine.js')

const ORG = 'org-audit'
authService.users.push({ id: 'u-audit', username: 'audit', orgId: ORG, role: 'admin', subscription: { plan: 'PRO' } })
notificationStore.saveRules(ORG, { cooldownMinutes: 0 })
remediationEngine.handleAnomaly = async () => { }                 // no SSH in tests
incidentDetector.watchCluster = () => { }
automationEngine.connectSSH = async () => { throw Object.assign(new Error('connect ETIMEDOUT 10.9.9.9:22'), { code: 'ETIMEDOUT' }) }
const cluster = { id: 'c-audit', clusterName: 'prod', orgId: ORG, ownerId: 'u-audit', k8sVersion: '1.36.0', masterNodes: [{ ip: '10.9.9.9' }], workerNodes: [] }

const wait = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (got.some(pred)) return true; await new Promise(r => setTimeout(r, 25)) } return false }
const arrived = (type, re) => wait(m => m.type === type && (!re || re.test(`${m.title} ${m.text}`)))

test('setup: one webhook channel', () => {
    notificationStore.saveChannel(ORG, { type: 'webhook', name: 'audit', config: { url: hookUrl } })
})

test('incident + incident cleared (auto-healing)', async () => {
    incidentDetector._createIncident(cluster, { reason: 'NodeNotReady', target: 'w1', nodeName: 'w1', message: 'w1 down' })
    assert.ok(await arrived('incident', /Node down — w1/), 'incident alert')
    incidentDetector._clearGone(cluster, new Set(['NodeNotReady']), new Set())
    assert.ok(await arrived('incident_resolved', /Cleared: Node down — w1/), 'cleared alert')
})

test('cluster unreachable (SSH / Gateway Agent down) is an incident with an alert', async () => {
    incidentDetector.watched.set(cluster.id, cluster)
    await incidentDetector.startWatching(cluster)   // connect fails
    await new Promise(r => setTimeout(r, 5))
    await incidentDetector.startWatching(cluster)   // still failing after the (test) delay
    assert.ok(await arrived('incident', /Cluster unreachable — 10\.9\.9\.9/), 'unreachable alert')
    incidentDetector.stopWatching(cluster.id)
})

test('etcd backup failed, offsite upload failed, restore / recovery finished or failed', async () => {
    alertEtcdJob(cluster, 'backup', false, 'etcdctl: context deadline exceeded')
    assert.ok(await arrived('backup_failed', /etcd backup failed/))
    alertEtcdJob(cluster, 'backup', true, 'S3: access denied')
    assert.ok(await arrived('backup_failed', /Offsite upload failed/))
    alertEtcdJob(cluster, 'restore', true)
    assert.ok(await arrived('restore_done', /etcd restore finished/))
    alertEtcdJob(cluster, 'recover', false, 'kubeadm init failed')
    assert.ok(await arrived('restore_done', /Control-plane recovery failed/))
})

test('daily configuration backup failed', async () => {
    fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([{ id: 'x', ownerId: 'u-audit' }]))
    BackupService.DATA_PATH = path.join(DATA, 'clusters.json')
    const orig = BackupService.createBackup
    BackupService.createBackup = () => ({ success: false, error: 'disk full' })
    try {
        await BackupService.runDailyBackups()
        assert.ok(await arrived('backup_failed', /Daily configuration backup failed/))
    } finally { BackupService.createBackup = orig }
})

// installation jobs: put a job in the manager, finish or fail it
const job = (id, extra) => { const inst = { id, orgId: ORG, ownerId: 'u-audit', clusterName: 'prod', k8sVersion: '1.36.0', masterNodes: [{ ip: '10.9.9.9' }], workerNodes: [{ ip: '10.9.9.10' }], status: 'running', logs: [], ...extra }; installationManager.installations.set(id, inst); return inst }

test('upgrade finished / failed', async () => {
    job('j-up', { mode: 'upgrade', targetVersion: '1.37.0', originalClusterId: 'c-audit' })
    await installationManager.completeInstallation('j-up', {})
    assert.ok(await arrived('upgrade_done', /Upgrade to v1\.37\.0 finished/))
    job('j-up2', { mode: 'upgrade', targetVersion: '1.37.0', originalClusterId: 'c-audit' })
    await installationManager.failInstallation('j-up2', new Error('kubeadm upgrade apply failed'))
    assert.ok(await arrived('upgrade_done', /Upgrade to v1\.37\.0 failed/))
})

test('job finished: cluster ready, nodes added, add-on installed / removed', async () => {
    job('j-in', { mode: 'install' })
    await installationManager.completeInstallation('j-in', {})
    assert.ok(await arrived('job_done', /Cluster prod is ready/), 'install')
    job('j-add', { mode: 'addon-only', originalClusterId: 'c-audit', addons: { monitoring: true, longhorn: true, argocd: false } })
    await installationManager.completeInstallation('j-add', {})
    assert.ok(await arrived('job_done', /Add-ons installed on prod Prometheus \+ Grafana, Longhorn Storage/), 'add-on install')
    const ev = await jobDoneAlert({ id: 'x', mode: 'addon-uninstall', uninstallAddon: 'velero', clusterName: 'prod', originalClusterId: 'c-audit' })
    assert.equal(ev.title, 'Velero (Volume Backups) removed on prod')
    assert.match((await jobDoneAlert({ id: 'y', mode: 'scale', clusterName: 'prod', masterNodes: [{}], workerNodes: [{}, {}] })).title, /Nodes added to prod/)
})

test('install / add-on job failed', async () => {
    job('j-f', { mode: 'install' })
    await installationManager.failInstallation('j-f', new Error('preflight: port 6443 in use'))
    assert.ok(await arrived('install_failed', /Cluster installation failed/))
    job('j-f2', { mode: 'addon-only', originalClusterId: 'c-audit', addons: { monitoring: true } })
    await installationManager.failInstallation('j-f2', new Error('helm timed out'))
    assert.ok(await arrived('install_failed', /Add-on job failed/))
})

class FakeWs extends EventEmitter { send() { } close() { this.emit('close') } terminate() { this.emit('close') } }

test('Gateway Agent offline (after the delay) and back online', async () => {
    const a = await agentService.generateToken('u-audit', 'audit', ORG, 'office-gw')
    const ws = new FakeWs()
    await agentService.onAgentConnect(ws, a.agentId, a.token)
    ws.emit('close')
    assert.ok(await arrived('agent_offline', /Gateway Agent "office-gw" is offline/), 'offline alert')
    await agentService.onAgentConnect(new FakeWs(), a.agentId, a.token)
    assert.ok(await arrived('agent_offline', /"office-gw" is back online/), 'back online alert')
})

test('an agent from before workspaces (no orgId) still alerts its owner\'s workspace', async () => {
    const a = await agentService.generateToken('u-audit', 'audit', null, 'legacy-gw')
    const ws = new FakeWs()
    await agentService.onAgentConnect(ws, a.agentId, a.token)
    ws.emit('close')
    assert.ok(await arrived('agent_offline', /"legacy-gw" is offline/))
})

test('an agent that does not reconnect after a KubeEZ restart is reported', async () => {
    const a = await agentService.generateToken('u-audit', 'audit', ORG, 'after-restart')
    const agents = JSON.parse(fs.readFileSync(path.join(DATA, 'agents.json'), 'utf8'))
    agents.find(x => x.agentId === a.agentId).lastSeen = new Date().toISOString()
    fs.writeFileSync(path.join(DATA, 'agents.json'), JSON.stringify(agents))
    await agentService.watchAfterBoot()
    assert.ok(await arrived('agent_offline', /"after-restart" is offline/))
})

test('every alert type in the list was delivered at least once', () => {
    const seen = new Set(got.map(m => m.type))
    for (const type of Object.keys(EVENTS)) assert.ok(seen.has(type), `${type} (${EVENTS[type].label}) never arrived`)
})
