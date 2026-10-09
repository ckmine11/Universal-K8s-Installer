// Auto-healing: which clusters are watched, why others are not, and that the
// list follows changes without a restart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'

const { incidentDetector, watchReason } = await import('../src/services/incidentDetector.js')
const { automationEngine } = await import('../src/services/automationEngine.js')
const { clusterStore } = await import('../src/services/clusterStore.js')

// no real SSH in tests: every connect fails (the cluster stays "watched, unreachable")
automationEngine.connectSSH = async () => { throw new Error('connect ETIMEDOUT') }
incidentDetector.automationEngine = automationEngine

const node = (ip) => [{ ip, username: 'root' }]
const mk = (id, extra) => ({ id, clusterName: id, orgId: 'o1', ownerId: 'u1', k8sVersion: '1.36.0', masterNodes: node('10.9.0.1'), workerNodes: [], ...extra })

test('which clusters are watched', () => {
    assert.equal(watchReason(mk('a', { status: 'healthy' })), null)
    assert.equal(watchReason(mk('b', {})), null, 'older records without a status are running clusters')
    assert.equal(watchReason(mk('c', { status: 'failed', mode: 'upgrade' })), null, 'a failed upgrade leaves a running cluster')
    assert.equal(watchReason(mk('d', { status: 'cancelled', mode: 'scale' })), null)
    assert.match(watchReason(mk('e', { status: 'failed', mode: 'install' })), /did not finish/)
    assert.match(watchReason(mk('f', { status: 'cancelled', mode: 'install' })), /cancelled/)
    assert.match(watchReason(mk('g', { status: 'healthy', masterNodes: [] })), /no control-plane/)
})

test('resync follows the saved clusters without a restart', async () => {
    await clusterStore.saveCluster(mk('ok', { status: 'healthy' }))
    await clusterStore.saveCluster(mk('upg', { status: 'failed', mode: 'upgrade', masterNodes: node('10.9.0.2') }))
    await clusterStore.saveCluster(mk('half', { status: 'failed', mode: 'install', masterNodes: node('10.9.0.3') }))
    await incidentDetector.resync()
    let watched = incidentDetector.getMonitoring().map(c => c.clusterId).sort()
    assert.deepEqual(watched, ['ok', 'upg'])
    assert.deepEqual(incidentDetector.getSkipped().map(s => [s.clusterId, /resume/.test(s.reason)]), [['half', true]])

    // the half-installed one is finished later → watched on the next resync
    await clusterStore.saveCluster({ ...mk('half', { masterNodes: node('10.9.0.3') }), status: 'healthy' })
    // a cluster is removed → no longer watched
    const file = path.join(DATA, 'clusters.json')
    fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).filter(c => c.id !== 'ok')))
    await incidentDetector.resync()
    watched = incidentDetector.getMonitoring().map(c => c.clusterId).sort()
    assert.deepEqual(watched, ['half', 'upg'])
    assert.equal(incidentDetector.getSkipped().length, 0)
    for (const id of watched) incidentDetector.stopWatching(id)
})
