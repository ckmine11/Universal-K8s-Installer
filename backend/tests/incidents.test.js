// Auto-healing detector: admin kubeconfig, one incident per ongoing problem,
// "cleared" when it goes away, incidents saved to disk, monitoring status.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'
const { incidentDetector } = await import('../src/services/incidentDetector.js')
const { remediationEngine } = await import('../src/services/remediationEngine.js')
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const dispatched = []
remediationEngine.handleAnomaly = async (cluster, event, incident) => { dispatched.push(incident.reason) }

let nodesJson = ''
const commands = []
const ssh = { execCommand: async (cmd) => { commands.push(cmd); return { code: 0, stdout: cmd.includes('get nodes') ? nodesJson : '{"items":[]}' } }, dispose() {} }
const cluster = { id: 'c1', clusterName: 'prod', orgId: 'org1', ownerId: 'u1', masterNodes: [{ ip: '10.0.0.1' }] }
const node = (ready) => JSON.stringify({ items: [{ metadata: { name: 'worker1' }, status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False', message: 'kubelet stopped posting' }] } }] })

// The watcher's stream without real timers
incidentDetector.streams.set(cluster.id, { ssh, timers: [], failCount: 0, cluster })
incidentDetector.watched.set(cluster.id, cluster)

test('kubectl runs with sudo and the admin kubeconfig', async () => {
    nodesJson = node(true)
    await incidentDetector._pollNodes(cluster)
    assert.match(commands.at(-1), /^sudo KUBECONFIG=\/etc\/kubernetes\/admin\.conf kubectl get nodes/)
})

test('an ongoing problem is ONE incident with a count, not a new row every poll', async () => {
    nodesJson = node(false)
    await incidentDetector._pollNodes(cluster)
    await incidentDetector._pollNodes(cluster)
    await incidentDetector._pollNodes(cluster)
    const open = incidentDetector.getIncidents().filter(i => i.reason === 'NodeNotReady')
    assert.equal(open.length, 1)
    assert.equal(open[0].count, 3)
    assert.equal(dispatched.filter(r => r === 'NodeNotReady').length, 1, 'playbook not re-run within 5 min')
})

test('when the problem goes away the incident is marked cleared', async () => {
    nodesJson = node(true)
    await incidentDetector._pollNodes(cluster)
    const inc = incidentDetector.getIncidents().find(i => i.reason === 'NodeNotReady')
    assert.equal(inc.status, 'cleared')
})

test('the same problem coming back opens a new incident', async () => {
    nodesJson = node(false)
    await incidentDetector._pollNodes(cluster)
    assert.equal(incidentDetector.getIncidents().filter(i => i.reason === 'NodeNotReady').length, 2)
})

test('incidents are saved to disk (survive a restart)', async () => {
    await new Promise(r => setTimeout(r, 1300))
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'incidents.json'), 'utf8'))
    assert.equal(saved.filter(i => i.reason === 'NodeNotReady').length, 2)
})

test('monitoring status lists watched clusters and whether they are connected', () => {
    assert.deepEqual(incidentDetector.getMonitoring().map(c => [c.clusterId, c.connected]), [['c1', true]])
    incidentDetector.stopWatching('c1')
    assert.equal(incidentDetector.getMonitoring().length, 0)
})
