// Add-on management: health rules, and the bookkeeping of add-on jobs
// (merge the saved add-on list, never mark a cluster failed for an add-on).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
process.env.APP_SECRET = 'test-secret'
const { summarizePod, addonHealth } = await import('../src/services/addonManager.js')
const { installationManager } = await import('../src/services/installationManager.js')
const { clusterStore } = await import('../src/services/clusterStore.js')

const pod = (name, phase, containers, extra = {}) => ({
    metadata: { name, creationTimestamp: '2026-10-01T00:00:00Z' },
    spec: { nodeName: 'n1', containers: containers.map((_, i) => ({ name: 'c' + i })) },
    status: { phase, containerStatuses: containers, ...extra }
})

test('pod summary: readiness, restarts and the reason a container is stuck', () => {
    const p = summarizePod(pod('sw-1', 'Running', [
        { ready: true, restartCount: 0, state: { running: {} } },
        { ready: false, restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } }
    ]))
    assert.deepEqual([p.ready, p.restarts, p.reason, p.allReady], ['1/2', 4, 'CrashLoopBackOff', false])
    const pending = summarizePod(pod('sw-2', 'Pending', [], { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] }))
    assert.equal(pending.reason, 'Unschedulable')
})

test('add-on health', () => {
    const ok = summarizePod(pod('a', 'Running', [{ ready: true, restartCount: 0, state: {} }]))
    const crash = summarizePod(pod('b', 'Running', [{ ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } } }]))
    const pulling = summarizePod(pod('c', 'Pending', [{ ready: false, restartCount: 0, state: { waiting: { reason: 'ContainerCreating' } } }]))
    const job = summarizePod(pod('d', 'Succeeded', [{ ready: false, restartCount: 0, state: { terminated: { reason: 'Completed' } } }]))
    assert.equal(addonHealth({ installed: false, nsPhase: '', pods: [] }), 'not-installed')
    assert.equal(addonHealth({ installed: true, nsPhase: 'Terminating', pods: [ok] }), 'removing')
    assert.equal(addonHealth({ installed: true, nsPhase: 'Active', pods: [ok, job] }), 'healthy')   // finished jobs don't count
    assert.equal(addonHealth({ installed: true, nsPhase: 'Active', pods: [ok, crash] }), 'failed')
    assert.equal(addonHealth({ installed: true, nsPhase: 'Active', pods: [ok, pulling] }), 'starting')
})

const seed = (c) => clusterStore.saveCluster({ clusterName: 'c', masterNodes: [{ ip: '10.0.0.1' }], workerNodes: [], ...c })
const stored = async (id) => (await clusterStore.getClusters()).find(c => c.id === id)
const job = (id, extra) => installationManager.installations.set(id, {
    id, clusterName: 'c', masterNodes: [{ ip: '10.0.0.1' }], workerNodes: [], status: 'running', logs: [], ...extra
})

test('installing an add-on ADDS it to the saved list (and heals an add-on-only failure)', async () => {
    await seed({ id: 'c1', addons: { seaweedfs: true, 'cert-manager': true }, status: 'failed', mode: 'addon-only', k8sVersion: '1.36.0' })
    job('j1', { mode: 'addon-only', originalClusterId: 'c1', addons: { argocd: true }, k8sVersion: '1.35.0' })
    await installationManager.completeInstallation('j1', { simulationMode: true })
    const c = await stored('c1')
    assert.deepEqual(Object.keys(c.addons).sort(), ['argocd', 'cert-manager', 'seaweedfs'])
    assert.equal(c.status, 'healthy')
    assert.equal(c.k8sVersion, '1.36.0')    // never rolled back to the job's copy
})

test('uninstalling removes only that add-on (any key alias)', async () => {
    await seed({ id: 'c2', addons: { seaweedfs: true, certManager: true }, status: 'healthy' })
    job('j2', { mode: 'addon-uninstall', originalClusterId: 'c2', uninstallAddon: 'cert-manager' })
    await installationManager.completeInstallation('j2', { simulationMode: true })
    assert.deepEqual((await stored('c2')).addons, { seaweedfs: true })
})

test('reinstall keeps the add-on in the saved list', async () => {
    await seed({ id: 'c6', addons: { seaweedfs: true }, status: 'healthy' })
    job('j6', { mode: 'addon-reinstall', originalClusterId: 'c6', uninstallAddon: 'seaweedfs' })
    await installationManager.completeInstallation('j6', { simulationMode: true })
    assert.deepEqual((await stored('c6')).addons, { seaweedfs: true })
})

test('a cluster whose UPGRADE failed stays failed after an add-on job', async () => {
    await seed({ id: 'c3', addons: {}, status: 'failed', mode: 'upgrade', error: 'boom' })
    job('j3', { mode: 'addon-only', originalClusterId: 'c3', addons: { dashboard: true } })
    await installationManager.completeInstallation('j3', { simulationMode: true })
    const c = await stored('c3')
    assert.equal(c.status, 'failed')
    assert.equal(c.mode, 'upgrade')
})

test('a failed add-on job does not mark the cluster failed', async () => {
    await seed({ id: 'c4', addons: { seaweedfs: true }, status: 'healthy' })
    job('j4', { mode: 'addon-only', originalClusterId: 'c4', addons: { longhorn: true } })
    installationManager.failInstallation('j4', new Error('longhorn failed'))
    await new Promise(r => setTimeout(r, 100))
    const c = await stored('c4')
    assert.equal(c.status, 'healthy')
    assert.deepEqual(c.addons, { seaweedfs: true })
    assert.equal(installationManager.installations.get('j4').status, 'failed')
})

test('only one job at a time per cluster', () => {
    job('j5', { mode: 'addon-uninstall', originalClusterId: 'c5' })
    assert.equal(installationManager.runningJobFor('c5')?.id, 'j5')
    installationManager.installations.get('j5').status = 'completed'
    assert.equal(installationManager.runningJobFor('c5'), null)
})
