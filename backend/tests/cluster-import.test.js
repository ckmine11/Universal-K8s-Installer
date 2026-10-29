// Connected clusters: existing clusters (cloud or on-prem) added to KubeEZ —
// what the cluster is, the kubeconfig KubeEZ accepts (and refuses), the
// access it asks for, what works on an imported cluster, the API (sessions,
// the public connect endpoints, tenant isolation, guards) and the sandbox.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir, startServer, client } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const { detectCluster, PROVIDERS, providerById } = await import('../src/config/clusterProviders.js')
const { readKubeconfig, explainFailure, accessManifest, connectScript, startSession } = await import('../src/services/clusterImport.js')
const { capabilities, usesApi, isImported, kubeconfigFor, sandboxUid, _test: sandbox } = await import('../src/services/clusterAccess.js')
const { stripCredentials } = await import('../src/services/clusterCredentials.js')
const { encrypt } = await import('../src/utils/cryptoUtils.js')

const node = (name, { providerID = '', labels = {}, version = 'v1.33.1', os = 'Ubuntu 24.04', cp = false, ready = true, ip = '10.0.0.1' } = {}) => ({
    metadata: { name, labels: { ...labels, ...(cp ? { 'node-role.kubernetes.io/control-plane': '' } : {}) } },
    spec: { providerID }, status: { nodeInfo: { kubeletVersion: version, osImage: os }, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], addresses: [{ type: 'InternalIP', address: ip }] }
})

describe('what the cluster is', () => {
    test('clouds from the node providerID and labels', () => {
        const d = (items, extra) => detectCluster({ items }, extra)
        assert.equal(d([node('ip-1', { providerID: 'aws:///us-east-1a/i-1', labels: { 'eks.amazonaws.com/nodegroup': 'ng' }, version: 'v1.33.1-eks-abc' })]).provider, 'eks')
        assert.equal(d([node('aks-1', { providerID: 'azure:///subscriptions/x', labels: { 'kubernetes.azure.com/cluster': 'mc' } })]).provider, 'aks')
        assert.equal(d([node('gke-1', { providerID: 'gce://p/z/n', labels: { 'cloud.google.com/gke-nodepool': 'default' } })]).provider, 'gke')
        assert.equal(d([node('10.0.0.5', { providerID: 'ocid1.instance.oc1.ap-mumbai-1.x' })]).provider, 'oke')
        assert.equal(d([node('pool-1', { providerID: 'digitalocean://123' })]).provider, 'doks')
        assert.equal(d([node('lke1', { providerID: 'linode://9' })]).provider, 'lke')
        assert.equal(d([node('h1', { providerID: 'hcloud://42' })]).provider, 'hetzner')
        assert.equal(d([node('kind-cp', { providerID: 'kind://docker/kind/kind-control-plane', cp: true })]).provider, 'kind')
    })
    test('on-prem distributions from the kubelet version, labels and API groups', () => {
        const d = (items, extra) => detectCluster({ items }, extra)
        assert.deepEqual([d([node('s1', { version: 'v1.31.4+k3s1', cp: true })]).distro, d([node('s1', { version: 'v1.31.4+k3s1', cp: true })]).provider], ['k3s', 'k3s'])
        assert.equal(d([node('r1', { version: 'v1.30.2+rke2r1' })]).distro, 'rke2')
        assert.equal(d([node('k1', { version: 'v1.31.0+k0s' })]).distro, 'k0s')
        assert.equal(d([node('t1', { os: 'Talos (v1.8.0)' })]).distro, 'talos')
        assert.equal(d([node('m1')], { apiGroups: ['config.openshift.io', 'apps'] }).distro, 'openshift')
        assert.equal(d([node('cp1', { cp: true })], { cpPods: ['kube-apiserver-cp1', 'etcd-cp1'] }).distro, 'kubeadm')
        assert.equal(d([node('x1')]).provider, 'unknown')
    })
    test('nodes, roles and readiness — without the raw labels', () => {
        const r = detectCluster({ items: [node('cp1', { cp: true, ip: '10.0.0.10' }), node('w1', { ready: false })] }, { version: 'v1.33.1' })
        assert.deepEqual([r.nodeCount, r.controlPlanes, r.version], [2, 1, '1.33.1'])
        assert.deepEqual(r.nodes.map(n => [n.name, n.role, n.ready, n.ip]), [['cp1', 'control-plane', true, '10.0.0.10'], ['w1', 'worker', false, '10.0.0.1']])
        assert.equal(r.nodes[0].labels, undefined)
    })
    test('every provider has a guide line, and the list covers clouds and on-prem', () => {
        assert.ok(PROVIDERS.every(p => p.id && p.name && p.group && p.getAccess))
        for (const id of ['eks', 'aks', 'gke', 'oke', 'doks', 'lke', 'vke', 'iks', 'ack', 'tke', 'civo', 'scaleway', 'ovh', 'hetzner', 'kubeadm', 'k3s', 'rke2', 'rancher', 'openshift', 'microk8s', 'k0s', 'tanzu', 'talos', 'eks-anywhere', 'aks-arc']) assert.ok(providerById(id), id)
        assert.equal(providerById('rancher').agentOnly, true)
    })
})

describe('a pasted kubeconfig', () => {
    const kc = (user, cluster = { server: 'https://10.0.0.10:6443', 'certificate-authority-data': 'Q0E=' }) => `apiVersion: v1
kind: Config
current-context: c
clusters: [{ name: k, cluster: ${JSON.stringify(cluster)} }]
users: [{ name: u, user: ${JSON.stringify(user)} }]
contexts: [{ name: c, context: { cluster: k, user: u } }]
`
    test('a token or a client certificate is used (once)', () => {
        assert.deepEqual(readKubeconfig(kc({ token: 'abc' })).user, { token: 'abc' })
        assert.deepEqual(readKubeconfig(kc({ 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' })).user, { cert: 'Y2VydA==', key: 'a2V5' })
        assert.equal(readKubeconfig(kc({ token: 'abc' })).server, 'https://10.0.0.10:6443')
    })
    test('login plugins, files on the user\'s machine and garbage are refused with what to do', () => {
        const err = (text) => { try { readKubeconfig(text); return null } catch (e) { return e } }
        assert.equal(err(kc({ exec: { command: 'aws', args: ['eks', 'get-token'] } })).code, 'EXEC_PLUGIN')
        assert.match(err(kc({ exec: { command: 'gke-gcloud-auth-plugin' } })).message, /connect command/)
        assert.match(err(kc({ 'auth-provider': { name: 'oidc' } })).message, /oidc/)
        assert.match(err(kc({ token: 'x' }, { server: 'https://a:6443', 'certificate-authority': '/home/me/ca.crt' })).message, /--flatten/)
        assert.match(err(kc({ 'client-certificate': '/x.crt', 'client-key': '/x.key' })).message, /--flatten/)
        assert.match(err('not: [valid').message, /not a kubeconfig/)
        assert.match(err('foo: bar').message, /no clusters/)
    })
})

describe('the access KubeEZ asks for', () => {
    test('read-only: no Secrets, no node or service proxy, no write verbs; full: cluster-admin', () => {
        const read = accessManifest('read'), full = accessManifest('full')
        const rules = read.slice(read.indexOf('kind: ClusterRole\n'), read.indexOf('kind: ClusterRoleBinding'))
        // the External Secrets status objects are named *secrets* — Kubernetes Secrets themselves never
        assert.doesNotMatch(rules.replace(/external-secrets\.io|externalsecrets|clustersecretstores|secretstores|# External Secrets.*\n/g, ''), /secrets|nodes\/proxy|services\/proxy|pods\/exec|create|delete|patch|update/)
        assert.match(rules, /apiGroups: \[external-secrets\.io\]\n\s+resources: \[externalsecrets, secretstores, clustersecretstores\]/)
        assert.match(read, /name: view/)
        assert.doesNotMatch(read, /cluster-admin/)
        assert.match(full, /kubeez-full[\s\S]*cluster-admin/)
        assert.match(read, /type: kubernetes\.io\/service-account-token/)
    })
    test('the connect script sends only the address, the CA and the kubeez token — and says why it failed', () => {
        const s = { code: 'c'.repeat(24), name: 'prod', level: 'read' }
        const sh = connectScript(s, 'https://kubeez.example', 'sh'), ps1 = connectScript(s, 'https://kubeez.example', 'ps1')
        assert.match(sh, /kubectl apply -f "https:\/\/kubeez\.example\/api\/import\/c{24}\/access\.yaml"/)
        assert.match(sh, /credentials\?format=text/)
        assert.match(sh, /"server\\":\\"\$SERVER\\",\\"token\\":\\"\$TOKEN\\",\\"ca\\":\\"\$CA\\"/)
        assert.doesNotMatch(sh, /client-key|users\[0\]/, 'never the user\'s own login')
        assert.match(ps1, /Invoke-RestMethod/)
    })
})

describe('what works on an imported cluster', () => {
    const imported = (level) => ({ id: 'i1', access: { mode: 'agent', level }, masterNodes: [] })
    test('node features never; changes only with Full manage; installed clusters everything', () => {
        const r = capabilities(imported('read')), f = capabilities(imported('full')), mine = capabilities({ id: 'k', masterNodes: [{ ip: '1.2.3.4' }] })
        for (const k of ['etcdBackup', 'upgrade', 'scale', 'nodeTerminal', 'resume']) { assert.equal(r[k].ok, false); assert.equal(f[k].ok, false); assert.equal(mine[k].ok, true) }
        for (const k of ['addons', 'healing', 'actions', 'yamlApply', 'backup']) { assert.equal(r[k].ok, false, k); assert.match(r[k].why, /read-only/); assert.equal(f[k].ok, true, k) }
        assert.equal(usesApi(imported('read')), true)
        assert.equal(usesApi({ access: { mode: 'direct' }, masterNodes: [{ ip: '1' }] }), false, 'SSH given: SSH wins')
        assert.equal(isImported({ imported: true, masterNodes: [{ ip: '1' }] }), true)
    })
    test('the token never leaves the server', () => {
        const out = stripCredentials({ id: 'x', masterNodes: [], workerNodes: [], access: { mode: 'direct', token: encrypt('ey.secret.x'), ca: 'Q0E=', level: 'read' } })
        assert.equal(out.access.token, undefined); assert.equal(out.access.ca, undefined)
        assert.deepEqual([out.access.hasToken, out.access.hasCa, out.access.mode], [true, true, 'direct'])
    })
    test('the sandbox: a separate user per cluster, node tools answer "not available"', () => {
        assert.notEqual(sandboxUid('cluster-a'), sandboxUid('cluster-b'))
        assert.ok(sandboxUid('x') >= 200000)
        for (const t of ['df', 'kubeadm', 'systemctl', 'crictl', 'etcdctl', 'curl', 'wget', 'top', 'free']) assert.match(sandbox.SHIMS[t], /not available on an imported cluster/, t)
        assert.match(sandbox.SHIMS.kubectl, /--kubeconfig "\$KZ_KUBECONFIG"/)
        assert.match(sandbox.SHIMS.sudo, /exec env "\$@"/)
        const kc = kubeconfigFor({ server: 'https://127.0.0.1:1234', ca: 'Q0E=', token: 't', tlsServerName: 'kubernetes.default.svc' })
        assert.equal(kc.clusters[0].cluster['tls-server-name'], 'kubernetes.default.svc')
        assert.equal(kc.users[0].user.token, 't')
    })
    test('explanations a person can act on', () => {
        assert.match(explainFailure('error: You must be logged in to the server (Unauthorized)').error, /refused the kubeez token/)
        assert.match(explainFailure('x509: certificate signed by unknown authority').hint, /agent method/)
        assert.match(explainFailure('dial tcp 10.0.0.1:6443: i/o timeout', { server: 'https://10.0.0.1:6443' }).hint, /agent method/)
        assert.match(explainFailure('dial tcp: lookup api.internal on 8.8.8.8: no such host').error, /cannot be resolved/)
    })
})

describe('the API', () => {
    let srv, api, boss, viewer, other, k3sId
    before(async () => {
        srv = await startServer({ KUBEEZ_MODE: 'saas' })
        api = client(srv)
        const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).data
        const root = await login('root', 'secret123')
        boss = (await api('POST', '/api/auth/register', null, { username: 'conboss', password: 'secret123', email: 'conboss@example.com' })).data
        assert.equal((await api('PUT', `/api/superadmin/users/${boss.user.id}/limits`, root.token, { plan: 'PRO', maxClusters: 5, maxNodes: 20, maxMembers: 4 })).status, 200)
        assert.equal((await api('POST', '/api/admin/users', boss.token, { username: 'conview', password: 'secret123', email: 'conview@example.com', role: 'viewer' })).status, 200)
        viewer = await login('conview', 'secret123')
        other = (await api('POST', '/api/auth/register', null, { username: 'conother', password: 'secret123', email: 'conother@example.com' })).data
        // an imported cluster (as an import saves it) and an installed one
        k3sId = 'imp-abc123'
        fs.writeFileSync(path.join(srv.dataDir, 'clusters.json'), JSON.stringify([
            { id: k3sId, clusterName: 'lab', orgId: boss.user.orgId, ownerId: boss.user.id, status: 'healthy', imported: true, provider: 'k3s', distro: 'k3s', k8sVersion: '1.31.4+k3s1', nodeCount: 1, importedNodes: [{ name: 'n1', role: 'control-plane', ready: true, ip: '10.0.0.5' }], masterNodes: [], workerNodes: [], access: { mode: 'direct', server: 'https://203.0.113.10:6443', ca: 'Q0E=', token: encrypt('eyA.eyB.c'), level: 'read', lastOk: new Date().toISOString() } }
        ]))
    })
    after(() => srv?.stop())

    test('a session: checked input, the commands, only for those who may add clusters', async () => {
        assert.equal((await api('POST', '/api/connect/sessions', boss.token, { name: '', provider: 'eks' })).status, 400)
        assert.equal((await api('POST', '/api/connect/sessions', boss.token, { name: 'x', provider: 'nope' })).status, 400)
        assert.equal((await api('POST', '/api/connect/sessions', boss.token, { name: 'x', provider: 'eks', level: 'root' })).status, 400)
        assert.equal((await api('POST', '/api/connect/sessions', viewer.token, { name: 'x', provider: 'eks' })).status, 403, 'viewers do not add clusters')
        const s = await api('POST', '/api/connect/sessions', boss.token, { name: 'eks prod', provider: 'eks', level: 'read', labels: { env: 'prod', 'bad key!': 'x' } })
        assert.equal(s.status, 200, JSON.stringify(s.data))
        assert.match(s.data.commands.agent, /^kubectl apply -f "http:\/\/127\.0\.0\.1:\d+\/api\/import\/[\w-]{24}\/agent\.yaml"$/)
        assert.match(s.data.commands.connect.sh, /connect\.sh" \| sh$/)
        assert.equal((await api('POST', '/api/connect/sessions', boss.token, { name: 'r', provider: 'rancher', method: 'auto' })).data.method, 'agent', 'Rancher: agent only')
        assert.equal((await api('GET', `/api/connect/sessions/${s.data.code}`, other.token)).status, 404, 'another workspace never sees it')
        // the public endpoints: the code is the key
        const pub = async (p) => { const r = await fetch(`${srv.url}/api/import/${p}`); return { status: r.status, text: await r.text() } }
        assert.equal((await pub('nope-not-a-code/access.yaml')).status, 404)
        const access = await pub(`${s.data.code}/access.yaml`)
        assert.equal(access.status, 200); assert.match(access.text, /kind: ServiceAccount[\s\S]*name: kubeez/)
        const agent = await pub(`${s.data.code}/agent.yaml`)
        assert.match(agent.text, /kind: Deployment[\s\S]*KUBEEZ_AGENT_IN_CLUSTER/)
        assert.match(agent.text, /runAsNonRoot: true, runAsUser: 1000/)
        assert.match(agent.text, /allowPrivilegeEscalation: false, readOnlyRootFilesystem: true/)
        assert.match((await pub(`${s.data.code}/connect.sh`)).text, /^#!\/bin\/sh/)
    })
    test('the agent of a cluster is never used as a Gateway Agent (SSH)', async () => {
        const s = await api('POST', '/api/connect/sessions', boss.token, { name: 'okd', provider: 'openshift', method: 'agent' })
        const yaml = await (await fetch(`${srv.url}/api/import/${s.data.code}/agent.yaml`)).text()
        assert.doesNotMatch(yaml, /runAsUser: \d/, 'OpenShift picks the user itself')
        const agents = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'agents.json'), 'utf8'))
        const a = agents.find(x => x.clusterId === s.data.clusterId)
        assert.equal(a.kind, 'cluster')
        assert.ok(!(a.registeredNodeIps || []).includes('gateway'))
        assert.equal((await api('GET', '/api/connect/agents', boss.token)).data.agents.filter(x => x.agentId === a.agentId).length, 1)
    })
    test('the connect command\'s answer: a wrong token is refused; KubeEZ Cloud never connects to a private address itself', async () => {
        const s = await api('POST', '/api/connect/sessions', boss.token, { name: 'onprem', provider: 'kubeadm', method: 'auto' })
        const post = async (body, q = '') => { const r = await fetch(`${srv.url}/api/import/${s.data.code}/credentials${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() } }
        assert.equal((await post({ server: 'https://10.0.0.10:6443', token: 'not-a-token' })).status, 400)
        const priv = await post({ server: 'https://10.0.0.10:6443', token: Buffer.from('eyJhbGc.eyJzdWI.sig').toString('base64'), ca: 'Q0E=' }, '?format=text')
        assert.equal(priv.status, 400)
        assert.match(priv.text, /^✘ KubeEZ could not connect: 10\.0\.0\.10 is a private address/)
        assert.match(priv.text, /KubeEZ agent/)
        assert.equal((await api('GET', `/api/connect/sessions/${s.data.code}`, boss.token)).data.status, 'failed')
    })
    test('connected clusters: listed with what works, the token never shown; other workspaces see nothing', async () => {
        const l = await api('GET', '/api/connect/clusters', boss.token)
        const c = l.data.clusters.find(x => x.id === k3sId)
        assert.deepEqual([c.name, c.provider, c.method, c.level, c.nodeCount], ['lab', 'k3s', 'direct', 'read', 1])
        assert.equal(c.features.etcdBackup.ok, false); assert.equal(c.features.addons.ok, false)
        assert.equal(JSON.stringify(l.data).includes('eyA'), false)
        const list = await api('GET', '/api/clusters/list', boss.token)
        assert.equal(JSON.stringify(list.data).includes('"token"'), false)
        assert.equal((await api('GET', '/api/connect/clusters', other.token)).data.clusters.length, 0)
        assert.equal((await api('GET', `/api/connect/clusters/${k3sId}`, other.token)).status, 404)
        assert.equal((await api('DELETE', `/api/connect/clusters/${k3sId}`, viewer.token)).status, 403)
    })
    test('features an imported cluster does not have are refused with the reason — others get a plain 404', async () => {
        for (const [m, p, feature] of [['GET', 'etcd/backups', 'etcdBackup'], ['POST', 'upgrade', 'upgrade'], ['POST', 'resume', 'resume'], ['GET', 'kubeconfig', 'kubeconfig'], ['POST', 'addons', 'addons'], ['POST', 'volume-backups/backups', 'backup']]) {
            const r = await api(m, `/api/clusters/${k3sId}/${p}`, boss.token, {})
            assert.equal(r.status, 409, `${p}: ${JSON.stringify(r.data)}`); assert.equal(r.data.feature, feature)
        }
        const scale = await api('POST', '/api/clusters/install', boss.token, { mode: 'scale', clusterId: k3sId, clusterName: 'lab', masterNodes: [{ ip: '10.0.0.5', username: 'root', password: 'x' }], workerNodes: [] })
        assert.equal(scale.status, 409); assert.equal(scale.data.feature, 'scale')
        assert.notEqual((await api('GET', `/api/clusters/${k3sId}/etcd/backups`, other.token)).status, 409, 'nothing told to another workspace')
    })
    test('read-only → full needs the cluster\'s own admin (a command); the token cannot be renewed by a read-only login', async () => {
        const up = await api('PUT', `/api/connect/clusters/${k3sId}/level`, boss.token, { level: 'full' })
        assert.equal(up.data.needsCommand, true); assert.equal(up.data.level, 'read')
        assert.match(up.data.commands.connect.sh, /connect\.sh/)
        const rot = await api('POST', `/api/connect/clusters/${k3sId}/rotate`, boss.token)
        assert.equal(rot.data.needsCommand, true)
    })
    test('two imported clusters never overwrite each other (no node IP to match on)', async () => {
        const { clusterStore } = await import('../src/services/clusterStore.js')
        process.env.KUBEEZ_DATA_DIR = DATA
        await clusterStore.saveCluster({ id: 'imp-1', clusterName: 'a', orgId: 'o', ownerId: 'u', masterNodes: [], workerNodes: [] })
        await clusterStore.saveCluster({ id: 'imp-2', clusterName: 'b', orgId: 'o', ownerId: 'u', masterNodes: [], workerNodes: [] })
        assert.deepEqual((await clusterStore.getClusters()).filter(c => c.orgId === 'o').map(c => c.clusterName).sort(), ['a', 'b'])
    })
})
