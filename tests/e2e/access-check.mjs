// Namespace-level access on a REAL cluster: the RoleBindings KubeEZ keeps,
// what Kubernetes then allows the Explorer identity (impersonation, exactly
// the user + group the Explorer sends) and a downloaded scoped kubeconfig
// (its own service-account token), changes and clean-up, temporary elevation.
// Run via: bash tests/e2e/e2e.sh access [distro]
process.env.APP_SECRET = 'e2e-only-secret-0123456789abcdef0123456789abcdef'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-access-'))
process.env.KUBEEZ_DATA_DIR = DATA

const NODE = process.env.NODE_CONTAINER
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd, input) => { const r = spawnSync('docker', ['exec', '-i', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, input, maxBuffer: 64 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const nodeIp = dx('hostname -I').stdout.split(' ')[0]
const ORG = 'org-acc'
const C = { id: 'c-acc', clusterName: 'acc', orgId: ORG, ownerId: 'u-boss', k8sVersion: '1.35.0', masterNodes: [{ ip: nodeIp, username: 'root', password: 'x' }], workerNodes: [] }
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([C]))
const users = [
    { id: 'u-boss', username: 'boss', role: 'admin', orgId: ORG },
    { id: 'u-dev', username: 'dev', role: 'viewer', orgId: ORG, clusterAccess: [{ type: 'cluster', clusterId: 'c-acc', role: 'operator', namespaces: ['payments-*'] }] },
    { id: 'u-ops', username: 'ops', role: 'viewer', orgId: ORG },
    { id: 'u-gone', username: 'gone', role: 'viewer', orgId: ORG, clusterAccess: [{ type: 'cluster', clusterId: 'c-acc', role: 'none' }] }
]
fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify(users))

const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { authService } = await import('../../backend/src/services/authService.js')
const { syncCluster, scopedKubeconfig, saName, ACCESS_NS } = await import('../../backend/src/services/namespaceAccess.js')
const { approvalStore } = await import('../../backend/src/services/approvalStore.js')
const { identityFor } = await import('../../backend/src/services/explorerProxy.js')
automationEngine.connectSSH = async () => ({ execCommand: async (cmd) => dx(cmd), dispose() {} })

let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const member = (id) => { const u = authService.getUserById(id); return { ...u, clusterAccess: u.clusterAccess || [] } }
// what the Explorer's identity may do (the same user + group the proxy sends)
const asExplorer = (u, verb, res, ns, scoped = true) => {
    const id = identityFor(u, 'edit', scoped)
    return K(`auth can-i ${verb} ${res} ${ns ? `-n ${ns}` : '-A'} --as '${id.user}' ${id.groups.map(g => `--as-group '${g}'`).join(' ')}`).stdout === 'yes'
}
const adminConf = dx('cat /etc/kubernetes/admin.conf').stdout
const withKubeconfig = (kc, cmd) => { dx('cat > /tmp/kz.kubeconfig', kc); return dx(`kubectl --kubeconfig /tmp/kz.kubeconfig ${cmd}`) }

console.log('== namespaces')
for (const ns of ['payments-api', 'payments-db', 'web']) K(`create namespace ${ns}`)
ok(K('get ns payments-api').code === 0, 'namespaces created')

console.log('== first sync')
const s1 = await syncCluster('c-acc', { force: true })
ok(s1.objects > 0, `objects created (${s1.objects})`)
const rbs = K(`get rolebinding -A -l kubeez.io/managed=access -o jsonpath='{range .items[*]}{.metadata.namespace}:{.roleRef.name} {end}'`).stdout
ok(/payments-api:edit/.test(rbs) && /payments-db:edit/.test(rbs) && !/web:/.test(rbs) && !/default:/.test(rbs), `RoleBindings only in payments-* (${rbs.trim()})`)
ok(K(`-n ${ACCESS_NS} get sa ${saName('u-dev')}`).code === 0 && K(`-n ${ACCESS_NS} get sa ${saName('u-ops')}`).code === 0, 'service accounts for dev and ops')
ok(K(`-n ${ACCESS_NS} get sa ${saName('u-gone')}`).code !== 0 && K(`-n ${ACCESS_NS} get sa ${saName('u-boss')}`).code !== 0, 'nothing for "no access" or admins')

console.log('== the Explorer identity (impersonation)')
const dev = member('u-dev')
ok(asExplorer(dev, 'create', 'deployments', 'payments-api'), 'dev may create deployments in payments-api')
ok(!asExplorer(dev, 'create', 'deployments', 'web'), 'dev may not in web')
ok(!asExplorer(dev, 'get', 'pods', 'kube-system'), 'dev sees nothing in kube-system')
ok(!asExplorer(dev, 'list', 'pods', null), 'dev cannot list pods cluster-wide')
ok(!asExplorer(dev, 'create', 'rolebindings', 'payments-api'), 'edit: no RBAC changes even in its namespace')

console.log('== scoped kubeconfig (service-account token)')
const kcDev = await scopedKubeconfig(C, dev, adminConf)
ok(/token: /.test(kcDev) && !/client-key-data/.test(kcDev), 'a token, not the admin certificate')
ok(/namespace: /.test(kcDev) === false, 'no default namespace for a prefix-only rule')
ok(withKubeconfig(kcDev, 'auth can-i create deployments -n payments-api').stdout === 'yes', 'kubeconfig: create in payments-api')
ok(withKubeconfig(kcDev, 'auth can-i create deployments -n web').stdout === 'no', 'kubeconfig: not in web')
ok(withKubeconfig(kcDev, 'create deployment hello --image=busybox -n payments-api -- sleep 3600').code === 0, 'kubeconfig: really creates a deployment in payments-api')
ok(withKubeconfig(kcDev, 'get secrets -n kube-system').code !== 0, 'kubeconfig: no secrets in kube-system')
const kcOps = await scopedKubeconfig(C, member('u-ops'), adminConf)
ok(withKubeconfig(kcOps, 'auth can-i list pods -A').stdout === 'yes', 'viewer kubeconfig: read cluster-wide')
ok(withKubeconfig(kcOps, 'auth can-i create deployments -n web').stdout === 'no', 'viewer kubeconfig: no changes')

console.log('== a new namespace matching payments-*')
K('create namespace payments-new')
await syncCluster('c-acc', { force: true })
ok(asExplorer(dev, 'create', 'deployments', 'payments-new'), 'covered after the next sync')

console.log('== temporary elevation lifts the namespace limit')
const r = approvalStore.add({ orgId: ORG, kind: 'elevation', clusterId: 'c-acc', role: 'operator', minutes: 30, requestedBy: { id: 'u-dev', username: 'dev' } })
approvalStore.update(r.id, { status: 'active', until: new Date(Date.now() + 30 * 60e3).toISOString() })
await syncCluster('c-acc', { force: true })
ok(K(`get rolebinding -A -l kubeez.io/managed=access -o name`).stdout === '', 'namespace RoleBindings removed while elevated')
ok(K(`get clusterrolebinding kubeez-sa-${saName('u-dev').slice(7)}`).code === 0, 'cluster-wide edit for the kubeconfig while elevated')
approvalStore.update(r.id, { status: 'ended', endedAt: new Date().toISOString() })
await syncCluster('c-acc', { force: true })
ok(K(`get rolebinding -n payments-api -l kubeez.io/managed=access -o name`).stdout !== '' && K(`get clusterrolebinding kubeez-sa-${saName('u-dev').slice(7)}`).code !== 0, 'back to payments-* after it ends (and no cluster-wide edit)')

console.log('== access removed → objects removed')
const u = authService.users.find(x => x.id === 'u-dev'); delete u.clusterAccess; u.role = 'admin'
const ops = authService.users.find(x => x.id === 'u-ops'); ops.role = 'admin'
authService.saveUsers?.()
await syncCluster('c-acc', { force: true })
ok(K(`get rolebinding -A -l kubeez.io/managed=access -o name`).stdout === '', 'no RoleBindings left')
ok(K(`get clusterrolebinding -l kubeez.io/managed=access -o name`).stdout === '', 'no ClusterRoleBindings left')
ok(K(`-n ${ACCESS_NS} get sa -l kubeez.io/managed=access -o name`).stdout === '', 'no service accounts left')
ok(K('-n payments-api get deploy hello').code === 0, 'workloads are never touched')

fs.rmSync(DATA, { recursive: true, force: true })
console.log(fails ? `\n${fails} check(s) FAILED` : '\nALL ACCESS CHECKS PASSED')
process.exit(fails ? 1 : 0)
