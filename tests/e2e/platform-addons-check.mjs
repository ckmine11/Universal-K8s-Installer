// The 12 platform add-ons on a REAL cluster, through KubeEZ's own path (plan
// files → helm-addon.sh → settings history), each one proven to do its job,
// updated from an older version where it matters, then uninstalled cleanly.
//   NFS storage      a shared volume on a real NFS server (another container)
//   Volume snapshots snapshot types taken over from an earlier install
//   Vault            init + unseal, a pod gets a secret injected, survives a restart
//                    (unsealed again by itself), updated 1.21 → 2.0
//   Elasticsearch    + Fluentd + Fluent Bit: a pod's log line found in Elasticsearch
//                    through both paths; Kibana answers; updated 8.19 → 9.5
//   Harbor           an image pushed to it, then a pod runs that image (nodes trust it)
//   Flux CD          a public repository synced; removing the sync keeps the apps
//   Jenkins          a pipeline runs as a pod in the cluster
//   OPA Gatekeeper   report → block "latest" images; system namespaces untouched
//   Falco            reading /etc/shadow in a container raises an alert
//   Trivy Operator   a vulnerability report for a running image
// Run via: bash tests/e2e/e2e.sh platform-addons [distro]   (ONLY=vault,harbor for a subset)
process.env.APP_SECRET = 'e2e-only-secret-0123456789abcdef0123456789abcdef'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-platform-'))
process.env.KUBEEZ_DATA_DIR = DATA

const NODE = process.env.NODE_CONTAINER
const NFS = process.env.NFS_SERVER           // IP of the NFS server container
const NFS_CONTAINER = process.env.NFS_CONTAINER
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean)
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd) => { const r = spawnSync('docker', ['exec', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 256 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nodeIp = dx('hostname -I').stdout.split(' ')[0]

const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { addonSettingsStore } = await import('../../backend/src/services/addonSettings.js')
const { HELM_ADDONS } = await import('../../backend/src/config/helmAddons.js')
automationEngine.connectSSH = async () => ({ execCommand: async (cmd, o) => { const r = dx(cmd); if (r.stdout) o?.onStdout?.(Buffer.from(r.stdout + '\n')); return r }, dispose() {} })
const ssh = await automationEngine.connectSSH()
const AUTOMATION = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src/automation')

let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const quietLog = (lines) => (level, msg) => { lines.push(msg); if (level === 'error' || /KUBEEZ_FAIL|✓|⚠|Installing|Changing/.test(msg)) console.log(`   ${String(msg).slice(0, 240)}`) }
let jobN = 0
const installed = {}
async function install(key, settings, { advanced = '', version, addons = {} } = {}) {
    const lines = []
    const inst = { id: `job-${++jobN}`, originalClusterId: 'c-e2e', masterNodes: [{ ip: nodeIp }], workerNodes: [], addons: { [key]: true }, clusterAddons: { ...installed, ...addons },
        addonSettings: { [key]: { settings, advanced, version } }, requestedBy: 'e2e' }
    const t = Date.now()
    try {
        await automationEngine.installHelmAddon(ssh, inst, key, quietLog(lines), { timeoutMs: 45 * 60e3 })
        installed[key] = true
        return { ok: true, lines, s: Math.round((Date.now() - t) / 1000) }
    } catch (e) { return { ok: false, error: e.message, lines, s: Math.round((Date.now() - t) / 1000) } }
}
async function uninstall(key) {
    const lines = []
    try {
        await automationEngine.executeScript(ssh, path.join(AUTOMATION, 'addon-uninstall.sh'), [key, '/etc/kubernetes/admin.conf', HELM_ADDONS[key].ns], quietLog(lines), { timeoutMs: 20 * 60e3 })
        delete installed[key]
        return { ok: true, lines }
    } catch (e) { return { ok: false, error: e.message, lines } }
}
const want = (k) => !ONLY.length || ONLY.includes(k)
async function until(fn, ms, every = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every) } return null }
const secret = (ns, name, key) => K(`-n ${ns} get secret ${name} -o jsonpath='{.data.${key.replace(/\./g, '\\.')}}'`).stdout ? Buffer.from(K(`-n ${ns} get secret ${name} -o jsonpath='{.data.${key.replace(/\./g, '\\.')}}'`).stdout, 'base64').toString() : ''
const applyYaml = (obj) => dx(`cat <<'EOF' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -\n${JSON.stringify(obj)}\nEOF`)
const gone = (ns) => until(() => K(`get ns ${ns}`).code !== 0, 300e3)
const older = (key) => HELM_ADDONS[key].versions[1].id
const newest = (key) => HELM_ADDONS[key].versions[0].id

// ── NFS storage (stays for the add-ons below that keep data) ──
const useNfs = want('nfs-provisioner') || want('vault') || want('jenkins')
if (useNfs) {
    console.log('== NFS storage')
    let r = await install('nfs-provisioner', { server: '192.0.2.250', path: '/' })
    ok(!r.ok && /NFS_UNREACHABLE|does not answer on port 2049/.test(r.error + r.lines.join('\n')), `an unreachable server is refused before anything changes (${r.s}s) — ${r.error}`)
    r = await install('nfs-provisioner', { server: NFS, path: '/', installClient: true })
    ok(r.ok, `installed against ${NFS}:/ (${r.s}s) ${r.error || ''}`)
    ok(dx('command -v mount.nfs || ls /sbin/mount.nfs').code === 0, 'the NFS client was installed on the node')
    applyYaml({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'shared', namespace: 'default' }, spec: { storageClassName: 'nfs-client', accessModes: ['ReadWriteMany'], resources: { requests: { storage: '100Mi' } } } })
    applyYaml({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'writer', namespace: 'default' }, spec: { containers: [{ name: 'w', image: 'busybox:1.37', command: ['sh', '-c', 'echo kubeez-nfs-e2e > /data/hello.txt && sleep 3600'], volumeMounts: [{ name: 'd', mountPath: '/data' }] }], volumes: [{ name: 'd', persistentVolumeClaim: { claimName: 'shared' } }] } })
    ok(!!await until(() => K('get pod writer -o jsonpath={.status.phase}').stdout === 'Running', 240e3), 'a pod runs with the NFS volume')
    const onServer = await until(() => { const c = spawnSync('docker', ['exec', NFS_CONTAINER, 'sh', '-c', 'cat /data/default-shared-*/hello.txt'], { encoding: 'utf8', env }); return /kubeez-nfs-e2e/.test(c.stdout) ? c.stdout.trim() : null }, 60e3)
    ok(!!onServer, `the file is on the NFS server: ${onServer}`)
    const left = spawnSync('docker', ['exec', NFS_CONTAINER, 'sh', '-c', 'ls /data'], { encoding: 'utf8', env }).stdout
    ok(!/kubeez-nfs-test/.test(left), 'the install check left nothing on the share')
    const u = await uninstall('nfs-provisioner')
    ok(!u.ok && /NFS_IN_USE|still in use/.test(u.error + u.lines.join('\n')), `uninstall is refused while a volume is in use — ${u.error}`)
    installed['nfs-provisioner'] = true
    K('delete pod writer --now'); K('delete pvc shared')
}

// ── Volume snapshots ──
if (want('snapshot-controller')) {
    console.log('== Volume snapshots')
    // snapshot types installed earlier by hand (as many guides do): taken over, not refused
    const base = 'https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd'
    for (const c of ['snapshot.storage.k8s.io_volumesnapshotclasses.yaml', 'snapshot.storage.k8s.io_volumesnapshots.yaml', 'snapshot.storage.k8s.io_volumesnapshotcontents.yaml']) K(`apply -f ${base}/${c}`)
    ok(K('get crd volumesnapshots.snapshot.storage.k8s.io').code === 0, 'snapshot CRDs installed by hand first')
    let r = await install('snapshot-controller', {}, { version: older('snapshot-controller') })
    ok(r.ok, `installed ${older('snapshot-controller')}, taking the existing CRDs over (${r.s}s) ${r.error || ''}`)
    r = await install('snapshot-controller', {}, { version: newest('snapshot-controller') })
    ok(r.ok, `updated to ${newest('snapshot-controller')} (${r.s}s) ${r.error || ''}`)
    ok(/v8\.6/.test(K("-n snapshot-controller get deploy snapshot-controller -o jsonpath='{.spec.template.spec.containers[0].image}'").stdout), 'the controller runs v8.6')
    applyYaml({ apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotClass', metadata: { name: 'e2e' }, driver: 'example.csi.k8s.io', deletionPolicy: 'Delete' })
    applyYaml({ apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshot', metadata: { name: 'e2e', namespace: 'default' }, spec: { volumeSnapshotClassName: 'e2e', source: { persistentVolumeClaimName: 'none' } } })
    ok(K('get volumesnapshot e2e').code === 0, 'a VolumeSnapshot is accepted')
    let u = await uninstall('snapshot-controller')
    ok(u.ok && K('get crd volumesnapshots.snapshot.storage.k8s.io').code === 0, 'uninstalled; the snapshot types stay while a snapshot exists')
    K('patch volumesnapshot e2e --type merge -p \'{"metadata":{"finalizers":null}}\''); K('delete volumesnapshot e2e --now'); K('delete volumesnapshotclass e2e')
    u = await uninstall('snapshot-controller')
    ok(u.ok && K('get crd volumesnapshots.snapshot.storage.k8s.io').code !== 0, 'without snapshots, the types are removed too')
}

// ── Vault ──
if (want('vault')) {
    console.log('== Vault')
    let r = await install('vault', { mode: 'standalone', storage: 'nfs', sizeGi: 1 }, { version: older('vault') })
    ok(r.ok, `installed ${older('vault')} on NFS (${r.s}s) ${r.error || ''}`)
    const token = secret('vault', 'kubeez-vault-keys', 'root-token')
    ok(!!token && !!secret('vault', 'kubeez-vault-keys', 'unseal-key'), 'initialized; unseal key and root token kept')
    const VT = (c) => K(`-n vault exec vault-0 -c vault -- env VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${token} ${c}`)
    ok(/false/.test(K('-n vault exec vault-0 -c vault -- vault status -address=http://127.0.0.1:8200 -format=json').stdout.match(/"sealed": *\w+/)?.[0] || ''), 'unsealed')
    ok(VT('vault kv put secret/shop/db password=e2e-pass').code === 0, 'a secret is written')
    dx(`echo 'path "secret/data/shop/*" { capabilities = ["read"] }' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n vault exec -i vault-0 -c vault -- env VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=${token} vault policy write shop -`)
    ok(VT('vault write auth/kubernetes/role/shop bound_service_account_names=shop bound_service_account_namespaces=default policies=shop ttl=1h').code === 0, 'a Kubernetes login role is created')
    // the update the user picks: 1.21 → 2.0 (StatefulSet OnDelete → the pod is recreated and unsealed)
    r = await install('vault', { mode: 'standalone', storage: 'nfs', sizeGi: 1 }, { version: newest('vault') })
    ok(r.ok, `updated to ${newest('vault')} (${r.s}s) ${r.error || ''}`)
    ok(/vault:2\./.test(K("-n vault get pod vault-0 -o jsonpath='{.spec.containers[0].image}'").stdout), 'vault-0 runs 2.x')
    ok(/e2e-pass/.test(VT('vault kv get -field=password secret/shop/db').stdout), 'the secret is still there after the update')
    // integration: the agent injector puts the secret into a pod
    K('create sa shop')
    applyYaml({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'shop', namespace: 'default', annotations: { 'vault.hashicorp.com/agent-inject': 'true', 'vault.hashicorp.com/role': 'shop', 'vault.hashicorp.com/agent-inject-secret-db': 'secret/data/shop/db' } }, spec: { serviceAccountName: 'shop', containers: [{ name: 'app', image: 'busybox:1.37', command: ['sleep', '3600'] }] } })
    const injected = await until(() => { const o = K('exec shop -c app -- cat /vault/secrets/db').stdout; return /e2e-pass/.test(o) ? o : null }, 240e3)
    ok(!!injected, 'a pod gets the secret injected by the Vault Agent (/vault/secrets/db)')
    // a restart seals Vault — KubeEZ's job unseals it within a minute or two
    K('-n vault delete pod vault-0')
    const unsealed = await until(() => /"sealed": *false/.test(K('-n vault exec vault-0 -c vault -- vault status -address=http://127.0.0.1:8200 -format=json').stdout), 240e3, 10000)
    ok(!!unsealed, 'after a pod restart Vault is unsealed again automatically')
    ok(/e2e-pass/.test(VT('vault kv get -field=password secret/shop/db').stdout), 'the data survived the restart (volume on NFS)')
    K('delete pod shop --now'); K('delete sa shop')
    const u = await uninstall('vault')
    ok(u.ok && await gone('vault') && K('get mutatingwebhookconfiguration vault-agent-injector-cfg').code !== 0, `uninstalled, injector webhook removed ${u.error || ''}`)
}

// ── Elasticsearch + Fluentd + Fluent Bit ──
if (want('elasticsearch')) {
    console.log('== Elasticsearch + Kibana')
    let r = await install('elasticsearch', { nodes: '1', memory: '2', storage: 'node', kibana: true }, { version: older('elasticsearch') })
    ok(r.ok, `installed ${older('elasticsearch')} (${r.s}s) ${r.error || ''}`)
    const pw = secret('elastic-system', 'kubeez-es-elastic-user', 'elastic')
    const es = (q) => dx(`curl -s -m 20 -u elastic:${pw} "http://$(KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n elastic-system get svc kubeez-es-http -o jsonpath='{.spec.clusterIP}'):9200${q}"`).stdout
    ok(/"number" *: *"8\.19/.test(es('/')), 'Elasticsearch 8.19 answers with the elastic password')
    const kb = await until(() => /available/.test(dx(`curl -s -m 10 http://${nodeIp}:30561/api/status`).stdout), 300e3, 10000)
    ok(!!kb, 'Kibana answers on node port 30561')

    if (want('fluentd') || !ONLY.length) {
        console.log('== Fluentd (aggregator) ← Fluent Bit')
        r = await install('fluentd', { role: 'aggregator', output: 'elasticsearch' })
        ok(r.ok, `Fluentd installed, sending to Elasticsearch (${r.s}s) ${r.error || ''}`)
        r = await install('fluent-bit', { output: 'fluentd' })
        ok(r.ok, `Fluent Bit installed, forwarding to Fluentd (${r.s}s) ${r.error || ''}`)
        const m1 = `kubeez-e2e-via-fluentd-${Date.now()}`
        K(`run logger1 --image=busybox:1.37 --restart=Never -- sh -c 'for i in $(seq 1 120); do echo ${m1}; sleep 2; done'`)
        const f1 = await until(() => { const o = es(`/kubeez-logs-*/_search?q=${m1}&size=1`); return /"total" *: *\{ *"value" *: *[1-9]/.test(o) ? o : null }, 300e3, 10000)
        ok(!!f1, 'a pod\'s log line reaches Elasticsearch: Fluent Bit → Fluentd → Elasticsearch')
        r = await install('fluent-bit', { output: 'elasticsearch' })
        ok(r.ok, `Fluent Bit switched to Elasticsearch directly ${r.error || ''}`)
        const m2 = `kubeez-e2e-direct-${Date.now()}`
        K(`run logger2 --image=busybox:1.37 --restart=Never -- sh -c 'for i in $(seq 1 120); do echo ${m2}; sleep 2; done'`)
        const f2 = await until(() => { const o = es(`/kubeez-logs-*/_search?q=${m2}&size=1`); return /"total" *: *\{ *"value" *: *[1-9]/.test(o) ? o : null }, 300e3, 10000)
        ok(!!f2, 'and directly: Fluent Bit → Elasticsearch')
        K('delete pod logger1 logger2 --now')
        for (const k of ['fluent-bit', 'fluentd']) { const u = await uninstall(k); ok(u.ok && await gone(k), `${k} uninstalled ${u.error || ''}`) }
    }
    // the update the user picks: 8.19 → 9.5 (rolling, data kept)
    dx(`curl -s -m 20 -u elastic:${pw} -XPUT -H 'content-type: application/json' "http://$(KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n elastic-system get svc kubeez-es-http -o jsonpath='{.spec.clusterIP}'):9200/kubeez-e2e/_doc/1?refresh=true" -d '{"kept":true}'`)
    r = await install('elasticsearch', { nodes: '1', memory: '2', storage: 'node', kibana: true }, { version: newest('elasticsearch') })
    ok(r.ok, `updated to ${newest('elasticsearch')} (${r.s}s) ${r.error || ''}`)
    ok(/"number" *: *"9\.5/.test(es('/')), 'Elasticsearch 9.5 answers')
    ok(/"kept" *: *true/.test(es('/kubeez-e2e/_doc/1')), 'the indexed document survived the update')
    const u = await uninstall('elasticsearch')
    ok(u.ok && await gone('elastic-system') && !/elastic/.test(K('get crd -o name').stdout), `uninstalled, CRDs removed ${u.error || ''}`)
}

// ── Harbor ──
if (want('harbor')) {
    console.log('== Harbor')
    let r = await install('harbor', { storage: 'node', trivy: false, trustNodes: true })
    ok(r.ok, `installed (${r.s}s) ${r.error || ''}`)
    const pw = secret('harbor', 'kubeez-harbor-admin', 'HARBOR_ADMIN_PASSWORD')
    const reg = `${nodeIp}:30003`
    ok(/"username" *: *"admin"/.test(dx(`curl -sk -m 10 -u admin:${pw} https://${reg}/api/v2.0/users/current`).stdout), 'admin signs in with the generated password')
    ok(/certs\.d/.test(dx("grep config_path /etc/containerd/config.toml").stdout) && dx(`test -f /etc/containerd/certs.d/${reg}/ca.crt`).code === 0, 'containerd on the node trusts Harbor')
    // push an image with containerd's own client, then run it as a pod
    const pushed = dx([
        'ctr -n k8s.io images pull docker.io/library/busybox:1.37 >/dev/null',
        `ctr -n k8s.io images tag --force docker.io/library/busybox:1.37 ${reg}/library/busybox:e2e >/dev/null`,
        `ctr -n k8s.io images push --hosts-dir /etc/containerd/certs.d --user admin:${pw} ${reg}/library/busybox:e2e`
    ].join(' && '))
    ok(pushed.code === 0, `an image is pushed to Harbor ${pushed.code ? pushed.stderr.slice(-200) : ''}`)
    dx(`ctr -n k8s.io images rm ${reg}/library/busybox:e2e >/dev/null`)
    applyYaml({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'from-harbor', namespace: 'default' }, spec: { containers: [{ name: 'c', image: `${reg}/library/busybox:e2e`, imagePullPolicy: 'Always', command: ['sleep', '600'] }] } })
    ok(!!await until(() => K('get pod from-harbor -o jsonpath={.status.phase}').stdout === 'Running', 180e3), 'a pod runs an image pulled from Harbor (TLS verified by the node)')
    K('delete pod from-harbor --now')
    // a second Apply keeps the certificate (nodes and clients keep trusting it)
    const crt1 = K("-n harbor get secret kubeez-harbor-tls -o jsonpath='{.data.tls\\.crt}'").stdout
    r = await install('harbor', { storage: 'node', trivy: false, trustNodes: true })
    ok(r.ok && K("-n harbor get secret kubeez-harbor-tls -o jsonpath='{.data.tls\\.crt}'").stdout === crt1, 'a second Apply keeps the same certificate')
    const u = await uninstall('harbor')
    ok(u.ok && await gone('harbor'), `uninstalled ${u.error || ''}`)
}

// ── Flux CD ──
if (want('flux')) {
    console.log('== Flux CD')
    let r = await install('flux', { gitUrl: 'https://github.com/stefanprodan/podinfo', branch: 'master', path: './kustomize', interval: 1, targetNamespace: 'default' }, { version: older('flux') })
    ok(r.ok, `installed ${older('flux')} syncing podinfo (${r.s}s) ${r.error || ''}`)
    ok(!!await until(() => K('get deploy podinfo').code === 0, 300e3), 'Flux deployed podinfo from Git')
    r = await install('flux', { gitUrl: 'https://github.com/stefanprodan/podinfo', branch: 'master', path: './kustomize', interval: 1, targetNamespace: 'default' }, { version: newest('flux') })
    ok(r.ok, `updated to ${newest('flux')} (${r.s}s) ${r.error || ''}`)
    r = await install('flux', { gitUrl: '' })
    ok(r.ok && K('-n flux-system get kustomizations.kustomize.toolkit.fluxcd.io kubeez-sync').code !== 0, 'the sync is removed when the repository is cleared')
    await sleep(15e3)
    ok(K('get deploy podinfo').code === 0, 'what was deployed from Git stays')
    const u = await uninstall('flux')
    ok(u.ok && await gone('flux-system') && !/fluxcd/.test(K('get crd -o name').stdout), `uninstalled, CRDs removed ${u.error || ''}`)
    ok(K('get deploy podinfo').code === 0, 'podinfo still runs after Flux is gone')
    K('delete deploy podinfo'); K('delete svc podinfo'); K('delete hpa podinfo')
}

// ── Jenkins ──
if (want('jenkins')) {
    console.log('== Jenkins')
    const r = await install('jenkins', { storage: 'nfs', sizeGi: 2, memory: '2' })
    ok(r.ok, `installed on NFS (${r.s}s) ${r.error || ''}`)
    const pw = secret('jenkins', 'jenkins', 'jenkins-admin-password')
    const J = `http://${nodeIp}:30808`
    ok(/"_class"/.test(dx(`curl -s -m 10 -u admin:${pw} ${J}/api/json`).stdout), 'admin signs in on node port 30808')
    // a pipeline that runs in a pod of the cluster (Kubernetes agent)
    const job = `<?xml version='1.1' encoding='UTF-8'?><flow-definition plugin="workflow-job"><definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps"><script>podTemplate { node(POD_LABEL) { sh 'echo kubeez-e2e-build-ok' } }</script><sandbox>true</sandbox></definition></flow-definition>`
    fs.writeFileSync(path.join(DATA, 'job.xml'), job)
    spawnSync('docker', ['cp', path.join(DATA, 'job.xml'), `${NODE}:/tmp/job.xml`], { env })
    const C = `-s -m 30 -u admin:${pw} -c /tmp/jcj -b /tmp/jcj`
    const crumb = dx(`curl ${C} '${J}/crumbIssuer/api/xml?xpath=concat(//crumbRequestField,":",//crumb)'`).stdout
    dx(`curl ${C} -H '${crumb}' -H 'Content-Type: application/xml' --data-binary @/tmp/job.xml '${J}/createItem?name=e2e'`)
    dx(`curl ${C} -H '${crumb}' -X POST '${J}/job/e2e/build'`)
    const built = await until(() => { const o = dx(`curl ${C} '${J}/job/e2e/lastBuild/consoleText'`).stdout; return /Finished: (SUCCESS|FAILURE)/.test(o) ? o : null }, 600e3, 10000)
    ok(/kubeez-e2e-build-ok[\s\S]*Finished: SUCCESS/.test(built || ''), 'a pipeline ran as a pod in the cluster')
    if (!/SUCCESS/.test(built || '')) console.log((built || '').slice(-800))
    const u = await uninstall('jenkins')
    ok(u.ok && await gone('jenkins'), `uninstalled ${u.error || ''}`)
}

// ── NFS: uninstall once nothing uses it ──
if (useNfs) {
    await until(() => !K('get pv -o name').stdout, 180e3)
    const u = await uninstall('nfs-provisioner')
    ok(u.ok && K('get sc nfs-client').code !== 0 && await gone('nfs-provisioner'), `NFS storage uninstalled ${u.error || ''}`)
}

// ── OPA Gatekeeper ──
if (want('gatekeeper')) {
    console.log('== OPA Gatekeeper')
    let r = await install('gatekeeper', { mode: 'dryrun' }, { version: older('gatekeeper') })
    ok(r.ok, `installed ${older('gatekeeper')} in report mode (${r.s}s) ${r.error || ''}`)
    ok(K('run latest-ok --image=nginx:latest --restart=Never').code === 0, 'report mode: a "latest" image is let through')
    const v = await until(() => Number(K("get kubeezdisallowlatest kubeez-disallow-latest-tag -o jsonpath='{.status.totalViolations}'").stdout) > 0, 240e3, 10000)
    ok(!!v, 'the audit reports the violation')
    r = await install('gatekeeper', { mode: 'deny' }, { version: newest('gatekeeper') })
    ok(r.ok, `updated to ${newest('gatekeeper')}, now blocking (${r.s}s) ${r.error || ''}`)
    const denied = await until(() => { const o = K('run latest-no --image=nginx:latest --restart=Never'); return o.code !== 0 && /fixed tag/.test(o.stderr) ? o.stderr : null }, 120e3)
    ok(!!denied, `block mode refuses it: ${(denied || '').split('\n')[0].slice(0, 160)}`)
    const fine = K('run fixed-ok --image=nginx:1.27-alpine --restart=Never --overrides=\'{"spec":{"containers":[{"name":"fixed-ok","image":"nginx:1.27-alpine","resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"memory":"64Mi"}}}]}}\'')
    ok(fine.code === 0, 'a pod that follows the rules is created')
    ok(K('-n kube-system run sys-latest --image=busybox:latest --restart=Never -- sleep 5').code === 0, 'system namespaces are untouched')
    K('delete pod latest-ok fixed-ok --now'); K('-n kube-system delete pod sys-latest --now')
    const u = await uninstall('gatekeeper')
    ok(u.ok && !/gatekeeper/.test(K('get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name').stdout), `uninstalled, no webhook left ${u.error || ''}`)
    ok(K('run after --image=nginx:latest --restart=Never').code === 0, 'after uninstall nothing blocks'); K('delete pod after --now')
}

// ── Falco ──
if (want('falco')) {
    console.log('== Falco')
    let r = await install('falco', { driver: 'modern_ebpf', ui: true })
    ok(r.ok, `installed with Modern eBPF and the UI (${r.s}s) ${r.error || ''}`)
    K('run victim --image=busybox:1.37 --restart=Never -- sleep 600')
    await until(() => K('get pod victim -o jsonpath={.status.phase}').stdout === 'Running', 120e3)
    await sleep(10e3)
    K('exec victim -- cat /etc/shadow')
    const alert = await until(() => { const o = K('-n falco logs ds/falco -c falco --since=5m'); return /shadow/.test(o.stdout) ? o.stdout.split('\n').find(l => /shadow/.test(l)) : null }, 120e3)
    ok(!!alert, `Falco alerts on a sensitive file read: ${(alert || '').slice(0, 160)}`)
    const ui = secret('falco', 'kubeez-falco-ui', 'FALCOSIDEKICK_UI_USER')
    ok(/^admin:.{12,}/.test(ui), 'the UI has its own password (not admin:admin)')
    ok(await until(() => dx(`curl -s -o /dev/null -w '%{http_code}' -m 5 http://${nodeIp}:30282/`).stdout === '200', 180e3), 'the UI answers on node port 30282')
    K('delete pod victim --now')
    const u = await uninstall('falco')
    ok(u.ok && await gone('falco'), `uninstalled ${u.error || ''}`)
}

// ── Trivy Operator ──
if (want('trivy-operator')) {
    console.log('== Trivy Operator')
    let r = await install('trivy-operator', { concurrent: 2, severity: 'HIGH' }, { version: older('trivy-operator') })
    ok(r.ok, `installed ${older('trivy-operator')} (${r.s}s) ${r.error || ''}`)
    r = await install('trivy-operator', { concurrent: 2, severity: 'HIGH' }, { version: newest('trivy-operator') })
    ok(r.ok, `updated to ${newest('trivy-operator')} (${r.s}s) ${r.error || ''}`)
    K('create deployment old-nginx --image=nginx:1.20.0')
    const rep = await until(() => { const o = K("get vulnerabilityreports -n default -o jsonpath='{.items[*].report.summary.highCount}'").stdout; return o && /\d/.test(o) ? o : null }, 900e3, 15000)
    ok(!!rep, `a vulnerability report for nginx:1.20.0 (high: ${rep})`)
    ok(!!await until(() => K('get configauditreports -A -o name').stdout, 300e3, 15000), 'configuration audit reports exist')
    K('delete deploy old-nginx')
    const u = await uninstall('trivy-operator')
    ok(u.ok && await gone('trivy-system') && !/aquasecurity/.test(K('get crd -o name').stdout), `uninstalled, CRDs removed ${u.error || ''}`)
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed')
fs.rmSync(DATA, { recursive: true, force: true })
process.exit(fails ? 1 : 0)
