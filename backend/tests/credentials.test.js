// Scaling / re-verifying an existing cluster without sending SSH passwords to
// the browser: the server fills in the stored ones — only for its own workspace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
process.env.APP_SECRET = 'test-secret'
const { clusterStore } = await import('../src/services/clusterStore.js')
const { fillStoredCredentials, stripCredentials } = await import('../src/services/clusterCredentials.js')

await clusterStore.saveCluster({
    id: 'c1', ownerId: 'u1', orgId: 'org1', clusterName: 'prod',
    masterNodes: [{ ip: '203.0.113.10', username: 'root', password: 'StoredPw' }],
    workerNodes: [{ ip: '203.0.113.11', username: 'ubuntu', sshKey: 'KEYDATA' }]
})
const member = { id: 'u2', orgId: 'org1', role: 'operator' }
const stranger = { id: 'x', orgId: 'other', role: 'admin' }

test('same workspace: stored credentials are filled in for existing nodes', async () => {
    const [m, w] = await fillStoredCredentials(member, 'c1', [
        { ip: '203.0.113.10', username: 'root' }, { ip: '203.0.113.11', username: 'ubuntu' }
    ])
    assert.equal(m.password, 'StoredPw')
    assert.equal(w.sshKey, 'KEYDATA')
})

test('another workspace gets nothing', async () => {
    const [m] = await fillStoredCredentials(stranger, 'c1', [{ ip: '203.0.113.10', username: 'root' }])
    assert.equal(m.password, undefined)
})

test('a password typed by the user wins; unknown nodes stay as they are', async () => {
    const [typed, fresh] = await fillStoredCredentials(member, 'c1', [
        { ip: '203.0.113.10', username: 'root', password: 'NewPw' }, { ip: '203.0.113.99', username: 'root' }
    ])
    assert.equal(typed.password, 'NewPw')
    assert.equal(fresh.password, undefined)
})

test('records for the UI carry only "has a password", never the password', async () => {
    const c = (await clusterStore.getClusters()).find(x => x.id === 'c1')
    const ui = stripCredentials(c)
    assert.deepEqual([ui.masterNodes[0].password, ui.masterNodes[0].hasPassword], [undefined, true])
    assert.deepEqual([ui.workerNodes[0].sshKey, ui.workerNodes[0].hasSshKey], [undefined, true])
})
