// Every add-on is a Helm add-on now: versions per Kubernetes release, one
// release line at a time where the project requires it, installs made before
// Helm managed them taken over in place, KubeEZ charts for Dashboard / SeaweedFS,
// and the wizard catalogue. Real charts: rendered with `helm template` during
// development; a real cluster: tests/e2e (e2e.sh helm-addons, takeover).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'

const { HELM_ADDONS, addonSchema, versionsFor, versionForRunning } = await import('../src/config/helmAddons.js')
const { buildPlan, planFiles, writePlanCommand, addonSettingsStore } = await import('../src/services/addonSettings.js')
const { ADDON_REGISTRY } = await import('../src/services/addonManager.js')
const { volumeBackupStore } = await import('../src/services/volumeBackupStore.js')

const cluster = (over = {}) => ({ id: 'c-t', k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [{ ip: '10.0.0.5' }, { ip: '10.0.0.6' }], addons: {}, ...over })
const rel = (plan, name) => plan.releases.find(r => r.name === name)

test('all 26 add-ons are Helm add-ons with a form, versions and an uninstall note', () => {
    const keys = ['ingress', 'monitoring', 'dashboard', 'cert-manager', 'longhorn', 'argocd', 'seaweedfs', 'velero', 'explorer', 'metrics-server', 'metallb', 'loki', 'sealed-secrets', 'kyverno',
        'nfs-provisioner', 'snapshot-controller', 'elasticsearch', 'fluentd', 'fluent-bit', 'harbor', 'flux', 'jenkins', 'vault', 'gatekeeper', 'falco', 'trivy-operator']
    assert.deepEqual(Object.keys(HELM_ADDONS), keys)
    for (const k of keys) {
        const a = HELM_ADDONS[k]
        assert.ok(a.fields.length && a.versions.length && a.uninstallNote && a.summary, k)
        assert.ok(ADDON_REGISTRY[k]?.helm, `${k} in the status registry`)
        for (const f of a.fields) assert.ok(['bool', 'number', 'select', 'text'].includes(f.type), `${k}.${f.key}`)
    }
    // installs from before Helm can be taken over
    for (const k of ['ingress', 'monitoring', 'dashboard', 'cert-manager', 'longhorn', 'argocd', 'seaweedfs', 'velero']) assert.ok(HELM_ADDONS[k].takeover?.detect, `${k} takeover`)
})

test('versions: newest that fits the cluster; the line that runs now is kept', () => {
    // Longhorn 1.13 needs Kubernetes 1.34
    assert.equal(versionsFor('longhorn', 30).find(v => v.recommended).id, '1.12.1')
    assert.equal(versionsFor('longhorn', 35).find(v => v.recommended).id, '1.13.0')
    assert.equal(buildPlan('longhorn', cluster({ k8sVersion: '1.30.2' })).version, '1.12.1')
    assert.throws(() => buildPlan('longhorn', cluster({ k8sVersion: '1.30.2' }), { version: '1.13.0' }), /needs Kubernetes 1.34/)
    // running versions → same release line
    assert.equal(versionForRunning('longhorn', 'longhornio/longhorn-manager:v1.7.2').id, '1.7.3')
    assert.equal(versionForRunning('argocd', 'v2.13.2').id, '7.7.23')
    assert.equal(versionForRunning('cert-manager', 'v1.16.2').id, 'v1.16.5')
    assert.equal(versionForRunning('ingress', 'v1.11.3@sha256:abc').id, '4.11.8')
    assert.equal(buildPlan('cert-manager', cluster(), {}, { runningApp: '1.13.3' }).version, 'v1.13.6')
    assert.equal(buildPlan('cert-manager', cluster(), {}, { runningApp: '0.1.0' }).version, 'v1.21.2', 'unknown line → newest')
})

test('one release line at a time: the node refuses a jump', () => {
    const p = buildPlan('longhorn', cluster(), { version: '1.8.2' })
    assert.match(p.pre, /kubectl -n longhorn-system get ds\/longhorn-manager/)
    assert.match(p.pre, /case "\$CURMM" in 1\.8\|1\.7\) ;;/)
    assert.match(p.pre, /fail VERSION_STEP/)
    assert.match(buildPlan('argocd', cluster(), { version: '8.2.7' }).pre, /in 3\.0\|2\.14\)/, 'Argo CD 2.14 → 3.0 is one step')
    assert.ok(!/VERSION_STEP/.test(buildPlan('ingress', cluster(), {}).pre), 'ingress-nginx may skip lines')
})

test('takeover: what is handed to the node', () => {
    let f = planFiles(buildPlan('argocd', cluster(), {}))
    assert.equal(f.takeover, 'deploy/argocd-server\n')
    assert.match(f['migrate.sh'], /delete deploy,statefulset --all/)
    assert.match(f['pre.sh'], /createSecret: false/, 'keeps the admin password of an older install')
    f = planFiles(buildPlan('monitoring', cluster(), {}))
    assert.equal(f.takeover, 'deploy/prometheus-operator\n')
    assert.match(f['migrate.sh'], /delete prometheus.monitoring.coreos.com main/)
    assert.match(f.releases, /\|crds$/m, 'kube-prometheus-stack CRDs are applied first')
    f = planFiles(buildPlan('longhorn', cluster(), {}))
    assert.match(f.releases, /\|norollback$/m, 'Longhorn is never rolled back automatically')
    assert.ok(!f['migrate.sh'], 'Longhorn: same objects, nothing to delete')
})

test('KubeEZ charts (Dashboard, SeaweedFS) travel with the plan', () => {
    const f = planFiles(buildPlan('dashboard', cluster(), { settings: { sessionMinutes: 60, adminAccount: false } }))
    assert.equal(f.releases, 'kubernetes-dashboard|local|-|kubeez-dashboard|2.7.0|local\n')
    assert.ok(f['charts/kubeez-dashboard/Chart.yaml'] && f['charts/kubeez-dashboard/templates/dashboard.yaml'])
    const v = JSON.parse(f['kubernetes-dashboard.values.yaml'])
    assert.deepEqual([v.extraArgs, v.adminAccount, v.service.nodePort], [['--token-ttl=3600'], false, 30643])
    const cmd = writePlanCommand('dashboard', f)
    assert.match(cmd, /sudo mkdir -p \/etc\/kubeez\/addons\/dashboard\/charts\/kubeez-dashboard \/etc\/kubeez\/addons\/dashboard\/charts\/kubeez-dashboard\/templates/)
    assert.throws(() => writePlanCommand('dashboard', { 'charts/../../x': 'y' }))

    const s = planFiles(buildPlan('seaweedfs', cluster(), { settings: { sizeGi: 50 } }))
    assert.match(s.releases, /^seaweedfs\|local\|-\|kubeez-seaweedfs\|1\.0\.0\|local,norollback$/m)
    assert.match(s['pre.sh'], /CANNOT_SHRINK/, 'volumes can grow, never shrink')
    assert.match(s['pre.sh'], /seaweedfs\.auto\.yaml/, 'storage of an existing install is kept (never moved)')
    assert.throws(() => buildPlan('seaweedfs', cluster(), { settings: { imageTag: 'latest; rm -rf /' } }), /tag like 4.48/)
})

test('Nginx Ingress: keeps the Service type and ports that run now unless changed', () => {
    let p = buildPlan('ingress', cluster(), {})
    assert.deepEqual(rel(p, 'ingress-nginx').values.controller.service, {})
    assert.match(p.pre, /ingress-nginx\.auto\.yaml/)
    p = buildPlan('ingress', cluster(), { settings: { serviceType: 'NodePort', httpNodePort: 31080, httpsNodePort: 31443, defaultClass: true } })
    assert.deepEqual(rel(p, 'ingress-nginx').values.controller.service, { type: 'NodePort', nodePorts: { http: 31080, https: 31443 } })
    assert.equal(rel(p, 'ingress-nginx').values.controller.ingressClassResource.default, true)
    assert.throws(() => buildPlan('ingress', cluster(), { settings: { httpNodePort: 80 } }), /30000 to 32767/)
    assert.throws(() => buildPlan('ingress', cluster(), { settings: { httpNodePort: 31000, httpsNodePort: 31000 } }), /different node ports/)
})

test('cert-manager: issuers from the form, CRDs kept, old charts use installCRDs', () => {
    let p = buildPlan('cert-manager', cluster(), { settings: { letsEncryptEmail: 'ops@example.com' } })
    assert.deepEqual(rel(p, 'cert-manager').values.crds, { enabled: true, keep: true })
    assert.deepEqual(p.post.manifests.map(m => m.metadata.name), ['selfsigned-issuer', 'letsencrypt-staging', 'letsencrypt-prod'])
    assert.equal(p.post.manifests[2].spec.acme.solvers[0].http01.ingress.ingressClassName, 'nginx')
    assert.equal(rel(buildPlan('cert-manager', cluster(), { version: 'v1.13.6' }), 'cert-manager').values.installCRDs, true)
    assert.throws(() => buildPlan('cert-manager', cluster(), { settings: { letsEncryptEmail: 'nope' } }), /valid email/)
    assert.throws(() => buildPlan('cert-manager', cluster(), { settings: { prometheus: true } }), /Prometheus \+ Grafana first/)
})

test('Longhorn: copies per volume follow the node count, UI port, default class', () => {
    let p = buildPlan('longhorn', cluster(), {})
    assert.equal(rel(p, 'longhorn').values.persistence.defaultClassReplicaCount, 3)
    p = buildPlan('longhorn', cluster({ workerNodes: [] }), {})
    assert.equal(p.settings.replicaCount, 1, 'one node → one copy')
    assert.throws(() => buildPlan('longhorn', cluster({ workerNodes: [] }), { settings: { replicaCount: 2 } }), /has 1 node/)
    assert.equal(p.post.manifests[0].spec.ports[0].nodePort, 30080)
    assert.match(p.pre, /longhorn-iscsi-installation\.yaml/)
    assert.throws(() => buildPlan('longhorn', cluster(), { settings: { dataPath: '../etc' } }), /absolute path/)
})

test('Velero: storage from Backups (locked), keys only through the node', () => {
    assert.throws(() => buildPlan('velero', cluster(), {}), /Backups → Volume Backups/)
    const orig = volumeBackupStore.effective
    volumeBackupStore.effective = () => ({ provider: 'minio', endpoint: 'http://10.0.0.9:30833', region: 'us-east-1', bucket: 'backups', prefix: 'kubeez-velero/c-t', insecureTls: true, accessKey: 'AK', secretKey: 'SK' })
    try {
        const p = buildPlan('velero', cluster(), { advanced: 'configuration:\n  backupStorageLocation:\n  - bucket: stolen\n' })
        const v = rel(p, 'velero').values
        assert.equal(v.configuration.backupStorageLocation[0].bucket, 'backups', 'the bucket comes from Backups, not the YAML')
        assert.deepEqual(v.configuration.backupStorageLocation[0].config, { region: 'us-east-1', s3ForcePathStyle: 'true', s3Url: 'http://10.0.0.9:30833', insecureSkipTLSVerify: 'true' })
        assert.ok(p.ignored.includes('velero: configuration.backupStorageLocation'))
        assert.ok(!JSON.stringify(planFiles(p)).includes('SK'), 'the secret key never goes into the plan files')
        assert.match(p.pre, /cloud-credentials/)
        assert.equal(HELM_ADDONS.velero.prepare, 'velero')
    } finally { volumeBackupStore.effective = orig }
})

test('Prometheus + Grafana: same ports, own Grafana password, storage choice', () => {
    let p = buildPlan('monitoring', cluster({ addons: { longhorn: true } }), {})
    const v = rel(p, 'monitoring').values
    assert.deepEqual([v.grafana.service.nodePort, v.prometheus.service.nodePort], [30000, 30090])
    assert.equal(v.grafana.admin.existingSecret, 'grafana-admin')
    assert.equal(v.prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName, 'longhorn')
    assert.equal(v.prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues, false, 'every ServiceMonitor, like before')
    assert.match(p.pre, /grafana-admin/)
    assert.match(p.post.script, /kubeez-loki-datasource/)
    p = buildPlan('monitoring', cluster(), { advanced: 'grafana:\n  admin:\n    existingSecret: other\n' })
    assert.equal(rel(p, 'monitoring').values.grafana.admin.existingSecret, 'grafana-admin', 'locked')
    assert.equal(rel(p, 'monitoring').values.prometheus.prometheusSpec.storageSpec, undefined, 'no Longhorn → pod storage')
})

test('Explorer: address and auth locked; needs a saved cluster', () => {
    const p = buildPlan('explorer', cluster(), { advanced: 'auth:\n  mode: none\nbasePath: /\n' })
    const v = rel(p, 'kubeez-explorer').values
    assert.deepEqual([v.auth.mode, v.basePath], ['proxy', '/api/clusters/c-t/explorer'])
    assert.throws(() => buildPlan('explorer', { masterNodes: [{ ip: '1.2.3.4' }] }, {}), /saved cluster/)
    assert.match(String(p.post.manifests[0]), /kubeez-explorer-helm-gate/)
})

test('install job: no version chosen → keeps the line that runs now', async () => {
    const { automationEngine } = await import('../src/services/automationEngine.js')
    const cmds = []
    const ssh = { execCommand: async (c) => { cmds.push(c); return /get ds\/longhorn-manager -o jsonpath/.test(c) ? { code: 0, stdout: 'longhornio/longhorn-manager:v1.7.2', stderr: '' } : { code: 0, stdout: '', stderr: '' } }, dispose() {} }
    const orig = automationEngine.executeScript
    automationEngine.executeScript = async () => {}
    const logs = []
    try {
        await automationEngine.installHelmAddon(ssh, { id: 'job-lh', originalClusterId: 'c-lh', k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [], addons: { longhorn: true } }, 'longhorn', (l, m) => logs.push(m), {})
        assert.equal(addonSettingsStore.get('c-lh', 'longhorn').applied.version, '1.7.3')
        assert.ok(logs.some(m => /1\.7\.2 runs now/.test(m)))
    } finally { automationEngine.executeScript = orig }
})

// ── wizard catalogue API ─────────────────────────────────────────────────────
let srv, url
before(async () => {
    const { authService } = await import('../src/services/authService.js')
    const { requireAuth } = await import('../src/middleware/authMiddleware.js')
    authService.verifyToken = (t) => ({ 'tok-pro': { id: 'u1', username: 'ann', role: 'admin', orgId: 'o-pro' }, 'tok-free': { id: 'u2', username: 'fay', role: 'admin', orgId: 'o-free' }, 'tok-view': { id: 'u3', username: 'vic', role: 'viewer', orgId: 'o-pro' } })[t] || null
    authService.getOrgPlan = (o) => o === 'o-pro' ? 'PRO' : 'FREE'
    const { default: catalog } = await import('../src/routes/addonCatalog.js')
    const app = express(); app.use(express.json()); app.use('/api/addon-catalog', requireAuth, catalog)
    srv = http.createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${srv.address().port}/api/addon-catalog`
})
after(() => { srv?.close(); fs.rmSync(DATA, { recursive: true, force: true }) })
const api = async (method, p, tok, body) => {
    const r = await fetch(url + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, data: await r.json().catch(() => ({})) }
}

test('wizard: forms for every add-on, versions for the chosen Kubernetes, preview before the cluster exists', async () => {
    let r = await api('GET', '?k8sVersion=1.30.4', 'tok-pro')
    assert.equal(r.status, 200)
    assert.equal(r.data.addons.length, 26)
    assert.equal(r.data.addons.find(a => a.key === 'longhorn').versions.find(v => v.recommended).id, '1.12.1')
    assert.equal(r.data.advancedAllowed, true)
    r = await api('POST', '/metallb/preview', 'tok-pro', { settings: { addresses: '10.0.0.5' }, cluster: { k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [{ ip: '10.0.0.5' }] } })
    assert.equal(r.status, 400)
    assert.match(r.data.error, /contains 10\.0\.0\.5 \(a node\)/)
    r = await api('POST', '/ingress/preview', 'tok-pro', { settings: { replicas: 2 }, advanced: 'controller:\n  podLabels:\n    team: web\n', cluster: { k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }] } })
    assert.equal(r.status, 200)
    assert.match(r.data.values, /replicaCount: 2/)
    assert.match(r.data.values, /team: web/)
    assert.equal((await api('POST', '/ingress/preview', 'tok-free', { advanced: 'a: 1', cluster: {} })).status, 402)
    assert.equal((await api('GET', '', 'tok-view')).status, 403)
})
