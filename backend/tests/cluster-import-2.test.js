// Connected clusters, part 2: the agents (Helm chart, reconnect, never a Gateway
// Agent), Full-manage features on an imported cluster (add-ons, the kubectl
// terminal, compliance), and SSH for on-prem clusters (each node checked).
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const { capabilities, addonProblem, NODE_ADDONS, parseTerminalCommand, _test: sandbox } = await import('../src/services/clusterAccess.js')
const clusterImport = await import('../src/services/clusterImport.js')
const { evaluateControls, HOST_CONTROLS } = await import('../src/config/compliance.js')
const { encrypt, decrypt } = await import('../src/utils/cryptoUtils.js')
const { clusterStore } = await import('../src/services/clusterStore.js')
const { agentService } = await import('../src/services/agentService.js')
const { automationEngine } = await import('../src/services/automationEngine.js')

const user = { id: 'u1', username: 'boss', orgId: 'org1' }
const imported = (over = {}) => ({ id: 'imp-x', clusterName: 'lab', orgId: 'org1', ownerId: 'u1', imported: true, provider: 'k3s', distro: 'k3s', status: 'healthy', masterNodes: [], workerNodes: [], importedNodes: [{ name: 'cp1', role: 'control-plane', ip: '10.0.0.10', ready: true }, { name: 'w1', role: 'worker', ip: '10.0.0.11', ready: true }], access: { mode: 'agent', level: 'full', token: encrypt('eyA.eyB.c'), agentId: 'a-old' }, ...over })

describe('the KubeEZ agent', () => {
    test('as a Helm chart: Chart.yaml + the manifest, no Namespace (Helm creates it)', async () => {
        const s = clusterImport.startSession(user, { name: 'helm-lab', provider: 'k3s', method: 'agent', level: 'read' })
        const tgz = await clusterImport.agentChart(s, 'https://kubeez.example')
        const tar = zlib.gunzipSync(tgz)
        const entries = []
        for (let off = 0; off + 512 <= tar.length;) {
            const name = tar.subarray(off, off + 100).toString().replace(/\0.*$/s, '')
            if (!name) break
            const size = parseInt(tar.subarray(off + 124, off + 136).toString().replace(/\0.*$/s, '').trim(), 8)
            // the header checksum is right (helm refuses a broken tar)
            const h = Buffer.from(tar.subarray(off, off + 512)); const stored = parseInt(h.subarray(148, 156).toString().replace(/\0.*$/s, '').trim(), 8)
            h.fill(' ', 148, 156); let sum = 0; for (const b of h) sum += b
            assert.equal(sum, stored, `checksum of ${name}`)
            entries.push([name, tar.subarray(off + 512, off + 512 + size).toString()])
            off += 512 + Math.ceil(size / 512) * 512
        }
        assert.deepEqual(entries.map(e => e[0]), ['kubeez-agent/Chart.yaml', 'kubeez-agent/templates/kubeez.yaml'])
        assert.match(entries[0][1], /name: kubeez-agent/)
        assert.doesNotMatch(entries[1][1], /^kind: Namespace$/m)
        assert.match(entries[1][1], /kind: Deployment[\s\S]*kubeez-agent/)
        assert.doesNotMatch(entries[1][1], /\{\{/, 'nothing Helm would template')
    })
    test('never a Gateway Agent; a reconnect (new agent, same token) takes over', async () => {
        const rec = await agentService.generateToken('u1', 'boss', 'org1', 'in-cluster', { kind: 'cluster', clusterId: 'imp-x' })
        assert.equal(rec.kind, 'cluster')
        agentService.agentSockets.set(rec.agentId, { readyState: 1, send() { } })   // "online"
        assert.equal(await agentService.getGatewayAgentForOwner('u1', 'admin', 'org1'), null, 'not used for SSH')
        agentService.agentSockets.delete(rec.agentId)
        await clusterStore.saveCluster(imported())
        await clusterImport.onClusterHello(rec, { token: 'eyA.eyB.c', ca: 'Q0E=' })
        const c = (await clusterStore.getClusters()).find(x => x.id === 'imp-x')
        assert.equal(c.access.agentId, rec.agentId, 'the new agent is the connection now')
        assert.equal(decrypt(c.access.token), 'eyA.eyB.c')
        // another workspace's agent cannot take a cluster over
        const evil = await agentService.generateToken('u9', 'x', 'org9', 'evil', { kind: 'cluster', clusterId: 'imp-x' })
        await clusterImport.onClusterHello(evil, { token: 'eyX.eyY.z' })
        assert.equal((await clusterStore.getClusters()).find(x => x.id === 'imp-x').access.agentId, rec.agentId)
    })
})

describe('Full manage on an imported cluster', () => {
    test('add-ons: allowed, except the ones that prepare the nodes; read-only: none', () => {
        assert.equal(addonProblem(imported(), 'cert-manager'), null)
        assert.match(addonProblem(imported(), 'longhorn'), /node access/)
        assert.match(addonProblem(imported(), 'harbor'), /node access/)
        assert.match(addonProblem(imported({ access: { mode: 'agent', level: 'read' } }), 'cert-manager'), /read-only/)
        assert.equal(addonProblem({ id: 'k', masterNodes: [{ ip: '1' }] }, 'longhorn'), null, 'installed clusters: all')
        assert.deepEqual(Object.keys(NODE_ADDONS).sort(), ['harbor', 'longhorn'])
    })
    test('the terminal: kubectl / helm only, quoted, no pipes, no identity flags', () => {
        assert.deepEqual(parseTerminalCommand('k get pods -A'), ['kubectl', 'get', 'pods', '-A'])
        assert.deepEqual(parseTerminalCommand(`kubectl get pods -o jsonpath='{.items[*].metadata.name}'`), ['kubectl', 'get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}'])
        assert.deepEqual(parseTerminalCommand('kubectl logs "my pod"'), ['kubectl', 'logs', 'my pod'])
        for (const bad of ['kubectl get pods | grep x', 'kubectl get pods; rm -rf /', 'kubectl get pods > /tmp/x', 'kubectl $(id)', 'cat /etc/passwd', 'bash', 'kubectl --token=x get ns', 'kubectl --as system:admin get ns', 'kubectl --kubeconfig /etc/kubernetes/admin.conf get ns', 'helm --kube-token x list', 'kubectl get pods -s https://evil:6443', 'kubectl get "x']) {
            assert.throws(() => parseTerminalCommand(bad), bad)
        }
        assert.equal(sandbox.quote(`it's`), `'it'\\''s'`)
    })
    test('compliance: host-only controls do not count; Kubernetes checks do', () => {
        const ev = { imported: { provider: 'Amazon EKS', cloud: true }, nodes: [], apiserver: null, certs: null, kubeBench: { ran: false }, k8s: { pvCount: 0, minor: 33, cra: ['cluster-admin\tGroup:/system:masters,'] }, kubeez: { channels: [], incidents: [], backups: {}, audit: { chainOk: true }, members: [] }, attestations: {}, now: Date.now(), latestMinor: 36 }
        const r = evaluateControls(ev)
        for (const id of HOST_CONTROLS) {
            const x = r.results.find(y => y.id === id)
            assert.equal(x.status, 'na', id); assert.match(x.evidence, /Amazon EKS/)
        }
        assert.ok(r.results.filter(x => !HOST_CONTROLS.has(x.id)).length > 10)
    })
})

describe('SSH for an on-prem imported cluster', () => {
    const fake = (answers) => {
        automationEngine.connectSSH = async (n) => {
            const a = answers[n.ip]
            if (!a) throw new Error('Connection refused')
            return { execCommand: async () => a, dispose() { } }
        }
    }
    test('every node is checked: SSH works, and it is a node of this cluster', async () => {
        await clusterStore.saveCluster(imported({ id: 'imp-ssh' }))
        const c = (await clusterStore.getClusters()).find(x => x.id === 'imp-ssh')
        fake({ '10.0.0.10': { code: 0, stdout: 'cp1\n' }, '10.9.9.9': { code: 0, stdout: 'laptop\n' }, '10.0.0.12': { code: 255, stdout: '', stderr: 'All configured authentication methods failed' } })
        await assert.rejects(clusterImport.addSsh(c, [{ ip: '10.9.9.9', username: 'root', password: 'x' }], user), /is not a node of lab/)
        await assert.rejects(clusterImport.addSsh(c, [{ ip: '10.0.0.12', username: 'root', password: 'x' }], user), /SSH login failed/)
        await assert.rejects(clusterImport.addSsh(c, [{ ip: '10.0.0.77', username: 'root', password: 'x' }], user), /SSH failed/)
        await assert.rejects(clusterImport.addSsh(c, [{ ip: 'bad host!', username: 'root', password: 'x' }], user), /not an IP address/)
        await assert.rejects(clusterImport.addSsh(c, [{ ip: '10.0.0.10', username: 'root' }], user), /password or an SSH key/)
    })
    test('k3s: node shells and checks over SSH, everything else stays on the API', async () => {
        const c = (await clusterStore.getClusters()).find(x => x.id === 'imp-ssh')
        fake({ '10.0.0.10': { code: 0, stdout: 'cp1\n' } })
        const r = await clusterImport.addSsh(c, [{ ip: '10.0.0.10', username: 'root', password: 's3cret' }], user)
        assert.equal(r.mode, 'nodes-only')
        const saved = (await clusterStore.getClusters()).find(x => x.id === 'imp-ssh')
        assert.deepEqual([saved.masterNodes.length, saved.sshNodes.length, saved.sshNodes[0].password, saved.sshNodes[0].hostname], [0, 1, 's3cret', 'cp1'])
        const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'clusters.json'), 'utf8')).find(x => x.id === 'imp-ssh')
        assert.notEqual(raw.sshNodes[0].password, 's3cret', 'stored encrypted')
        const cap = capabilities(saved)
        assert.equal(cap.nodeTerminal.ok, true)
        assert.match(cap.etcdBackup.why, /kubeadm/); assert.match(cap.upgrade.why, /kubeadm/)
    })
    test('kubeadm (admin.conf on its control-plane): like a cluster KubeEZ installed', async () => {
        await clusterStore.saveCluster(imported({ id: 'imp-kadm', distro: 'kubeadm', provider: 'kubeadm' }))
        const c = (await clusterStore.getClusters()).find(x => x.id === 'imp-kadm')
        fake({ '10.0.0.10': { code: 0, stdout: 'cp1\nKUBEADM\n' }, '10.0.0.11': { code: 0, stdout: 'w1\n' } })
        assert.equal((await clusterImport.addSsh(c, [{ ip: '10.0.0.10', username: 'root', password: 'x' }], user)).mode, 'kubeadm')
        let saved = (await clusterStore.getClusters()).find(x => x.id === 'imp-kadm')
        assert.equal(saved.masterNodes.length, 1)
        let cap = capabilities(saved)
        assert.equal(cap.etcdBackup.ok, true); assert.equal(cap.scale.ok, true)
        assert.match(cap.upgrade.why, /every node[\s\S]*w1/)
        await clusterImport.addSsh(saved, [{ ip: '10.0.0.10', username: 'root', password: 'x' }, { ip: '10.0.0.11', username: 'root', password: 'x' }], user)
        saved = (await clusterStore.getClusters()).find(x => x.id === 'imp-kadm')
        cap = capabilities(saved)
        assert.equal(cap.upgrade.ok, true, 'every node has SSH now')
        assert.equal(cap.resume.ok, false, 'never resumed: KubeEZ did not install it')
        await clusterImport.removeSsh(saved, user)
        saved = (await clusterStore.getClusters()).find(x => x.id === 'imp-kadm')
        assert.deepEqual([saved.masterNodes.length, saved.workerNodes.length, capabilities(saved).etcdBackup.ok], [0, 0, false])
    })
})
