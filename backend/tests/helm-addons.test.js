// Helm add-ons with settings (Metrics Server, MetalLB, Loki, Sealed Secrets,
// Kyverno): settings are checked, the values are built (form → advanced YAML →
// locked), the node gets exactly the plan, the history records the result,
// and the API gates advanced values by plan. Real charts: rendered with
// `helm template` during development; a real cluster: tests/e2e.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import YAML from 'yaml'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    { id: 'c-h', clusterName: 'prod', orgId: 'org-pro', ownerId: 'u-a', k8sVersion: '1.35.0', status: 'healthy', controlPlaneVip: '10.0.0.100', addons: { ingress: true },
        masterNodes: [{ ip: '10.0.0.4', username: 'root', password: 'x' }], workerNodes: [{ ip: '10.0.0.5', username: 'root', password: 'x' }] },
    { id: 'c-f', clusterName: 'free', orgId: 'org-free', ownerId: 'u-f', k8sVersion: '1.35.0', status: 'healthy', addons: {},
        masterNodes: [{ ip: '10.1.0.4', username: 'root', password: 'x' }], workerNodes: [] }
]))

const { HELM_ADDONS, addonSchema, parseAddressPool, KYVERNO_POLICIES } = await import('../src/config/helmAddons.js')
const { buildPlan, planFiles, writePlanCommand, parseAdvanced, lineDiff, valuesYaml, addonSettingsStore } = await import('../src/services/addonSettings.js')
const { ADDON_REGISTRY } = await import('../src/services/addonManager.js')
const { checkAddonPlan } = await import('../src/config/addonTiers.js')

const cluster = { masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [{ ip: '10.0.0.5' }], controlPlaneVip: '10.0.0.100', addons: {} }
const rel = (plan, name) => plan.releases.find(r => r.name === name)

test('every Helm add-on: defaults build, versions offered, registered for status / uninstall', () => {
    for (const key of Object.keys(HELM_ADDONS)) {
        const s = addonSchema(key)
        assert.ok(s.fields.length && s.versions[0].recommended, key)
        assert.ok(ADDON_REGISTRY[key]?.helm && ADDON_REGISTRY[key].ns === HELM_ADDONS[key].ns, `${key} registered`)
        const plan = buildPlan(key, { ...cluster, addons: { longhorn: true } }, key === 'metallb' ? { settings: { addresses: '10.0.0.240-10.0.0.250' } } : {})
        assert.equal(plan.version, s.versions[0].id)
        for (const r of plan.releases) assert.match(r.version, /^\d+\.\d+\.\d+$/)
    }
    assert.throws(() => buildPlan('metallb', cluster, {}), /enter at least one range/, 'MetalLB needs its addresses')
    assert.throws(() => buildPlan('kyverno', cluster, { version: '0.0.1' }), /not offered/)
    assert.throws(() => buildPlan('nginx', cluster, {}), /Unknown/)
})

test('plans: Metrics Server is Free, the rest Pro', () => {
    assert.equal(checkAddonPlan({ 'metrics-server': true }, 'FREE').allowed, true)
    for (const k of ['metallb', 'loki', 'sealed-secrets', 'kyverno']) assert.equal(checkAddonPlan({ [k]: true }, 'FREE').allowed, false, k)
})

test('MetalLB addresses: ranges, CIDRs, never a node or the VIP', () => {
    const taken = [{ ip: '10.0.0.4', what: 'a node' }, { ip: '10.0.0.100', what: 'the control-plane virtual IP' }]
    assert.equal(parseAddressPool('10.0.0.240-10.0.0.250, 10.0.1.0/28, 10.0.2.9', { taken }).length, 3)
    assert.throws(() => parseAddressPool('10.0.0.1-10.0.0.10', { taken }), /contains 10.0.0.4 \(a node\)/)
    assert.throws(() => parseAddressPool('10.0.0.96/28', { taken }), /virtual IP/)
    assert.throws(() => parseAddressPool('10.0.0.250-10.0.0.240'), /must come before/)
    assert.throws(() => parseAddressPool('10.0.0.0/16'), /\/20 to \/32/)
    assert.throws(() => parseAddressPool('10.0.0.1-10.0.0.200, 10.0.0.150-10.0.0.160'), /overlaps/)
    assert.throws(() => parseAddressPool('my-range'), /not an IPv4/)
    assert.throws(() => parseAddressPool('10.0.0.1; rm -rf /'), /not an IPv4/, 'nothing but addresses reaches the node')
    assert.throws(() => parseAddressPool('127.0.0.1'), /not a usable/)
})

test('MetalLB plan: pool + L2 / BGP objects, the ping check, Ingress gets an IP', () => {
    let p = buildPlan('metallb', cluster, { settings: { addresses: '10.0.0.240-10.0.0.242' } })
    assert.equal(rel(p, 'metallb').values.frrk8s.enabled, false, 'Layer 2 needs no FRR')
    assert.deepEqual(p.post.manifests.map(m => m.kind), ['IPAddressPool', 'L2Advertisement'])
    assert.deepEqual(p.post.manifests[0].spec.addresses, ['10.0.0.240-10.0.0.242'])
    assert.match(p.pre, /for ip in 10\.0\.0\.240 10\.0\.0\.241 10\.0\.0\.242; do/)
    assert.match(p.pre, /IP_IN_USE/)
    assert.match(p.post.script, /"type":"LoadBalancer"/)
    assert.match(p.post.script, /delete l2advertisements|delete bgpadvertisements/)

    p = buildPlan('metallb', cluster, { settings: { addresses: '10.0.0.240/30', mode: 'bgp', peerAddress: '10.0.0.1', myASN: 64500, peerASN: 64501, ingressLoadBalancer: false } })
    assert.equal(rel(p, 'metallb').values.frrk8s.enabled, true)
    assert.deepEqual(p.post.manifests.map(m => m.kind), ['IPAddressPool', 'BGPPeer', 'BGPAdvertisement'])
    assert.equal(p.post.manifests[1].apiVersion, 'metallb.io/v1beta2')
    assert.match(p.post.script, /delete l2advertisements.metallb.io kubeez-l2/, 'switching mode removes the other mode\'s objects')
    assert.match(p.post.script, /"type":"NodePort"/)
    assert.throws(() => buildPlan('metallb', cluster, { settings: { addresses: '10.0.0.240/30', mode: 'bgp', peerAddress: 'router' } }), /Router IP/)
    // a cluster without workers: the control-plane announces the IPs
    assert.equal(rel(buildPlan('metallb', { ...cluster, workerNodes: [] }, { settings: { addresses: '10.0.0.240' } }), 'metallb').values.speaker.ignoreExcludeLB, true)
})

test('Loki: retention, storage choice, Fluent Bit sends to Loki', () => {
    let p = buildPlan('loki', { ...cluster, addons: { longhorn: true } }, { settings: { retentionDays: 3, sizeGi: 20 } })
    const loki = rel(p, 'loki').values
    assert.equal(p.settings.storage, 'longhorn', '"auto" picks Longhorn when installed')
    assert.equal(loki.loki.limits_config.retention_period, '72h')
    assert.deepEqual(loki.singleBinary.persistence, { enabled: true, size: '20Gi', storageClass: 'longhorn' })
    assert.match(rel(p, 'fluent-bit').values.config.outputs, /Host loki\.logging\.svc\n\s+Port 3100/)
    assert.match(p.post.script, /name: Loki/, 'Grafana gets the data source')

    p = buildPlan('loki', cluster, {})
    assert.equal(p.settings.storage, 'node')
    assert.equal(rel(p, 'loki').values.singleBinary.persistence.enabled, false)
    assert.deepEqual(rel(p, 'loki').values.singleBinary.extraVolumes, [{ name: 'storage', emptyDir: { sizeLimit: '10Gi' } }])
    assert.throws(() => buildPlan('loki', cluster, { settings: { storage: 'longhorn' } }), /Longhorn is not installed/)
    assert.throws(() => buildPlan('loki', cluster, { settings: { retentionDays: 0 } }), /1 to 90/)
})

test('Kyverno: never blocks the cluster when down; chosen rules, Audit or Deny', () => {
    let p = buildPlan('kyverno', cluster, { settings: { mode: 'Enforce', policy_privileged: false } })
    const v = rel(p, 'kyverno').values
    assert.equal(v.features.forceFailurePolicyIgnore.enabled, true)
    assert.ok(v.config.webhooks.namespaceSelector.matchExpressions[0].values.includes('kube-system'))
    assert.equal(p.post.manifests.length, Object.keys(KYVERNO_POLICIES).length - 1)
    assert.ok(p.post.manifests.every(m => m.kind === 'ValidatingPolicy' && m.spec.validationActions[0] === 'Deny'))
    assert.match(p.post.script, /delete validatingpolicies.policies.kyverno.io kubeez-disallow-privileged/)
    p = buildPlan('kyverno', cluster, {})
    assert.ok(p.post.manifests.every(m => m.spec.validationActions[0] === 'Audit'), 'Audit by default')
    assert.equal(p.post.script, '')
})

test('Sealed Secrets: key renewal; kubeseal comes with it', () => {
    const p = buildPlan('sealed-secrets', cluster, { settings: { keyRenewDays: 0 } })
    assert.equal(rel(p, 'sealed-secrets').values.keyrenewperiod, '0')
    assert.equal(rel(p, 'sealed-secrets').values.fullnameOverride, 'sealed-secrets-controller')
    assert.match(p.post.script, /kubeseal-0\.40\.0-linux-\$A\.tar\.gz/)
    assert.equal(rel(buildPlan('sealed-secrets', cluster, {}), 'sealed-secrets').values.keyrenewperiod, '720h')
})

test('advanced YAML: merged over the form, KubeEZ\'s locked keys win, errors explained', () => {
    let p = buildPlan('metrics-server', cluster, { advanced: 'replicas: 2\nfullnameOverride: other\npodLabels:\n  team: ops\n' })
    const v = rel(p, 'metrics-server').values
    assert.equal(v.replicas, 2)
    assert.deepEqual(v.podLabels, { team: 'ops' })
    assert.equal(v.fullnameOverride, 'metrics-server', 'locked')
    assert.deepEqual(p.ignored, ['metrics-server: fullnameOverride'])
    assert.deepEqual(v.args, ['--kubelet-insecure-tls'], 'form values stay unless overridden')

    p = buildPlan('kyverno', cluster, { advanced: 'features:\n  forceFailurePolicyIgnore:\n    enabled: false\n' })
    assert.equal(rel(p, 'kyverno').values.features.forceFailurePolicyIgnore.enabled, true, 'the safety switch cannot be turned off')

    // several releases: one block per release
    p = buildPlan('loki', cluster, { advanced: 'fluent-bit:\n  logLevel: debug\nloki:\n  singleBinary:\n    replicas: 1\n' })
    assert.equal(rel(p, 'fluent-bit').values.logLevel, 'debug')
    assert.throws(() => parseAdvanced('loki', 'grafana:\n  x: 1', ['loki', 'fluent-bit']), /loki or fluent-bit/)
    assert.throws(() => parseAdvanced('x', 'a: [1, 2', ['x']), /not valid YAML/)
    assert.throws(() => parseAdvanced('x', '- 1\n- 2', ['x']), /must be a YAML map/)
    assert.throws(() => parseAdvanced('x', 'a: ' + 'x'.repeat(70000), ['x']), /64 KB/)
})

test('the node gets the plan as files (base64 — no quoting tricks possible)', () => {
    const p = buildPlan('metallb', cluster, { settings: { addresses: '10.0.0.240-10.0.0.250' }, advanced: "controller:\n  podLabels:\n    note: \"it's $(whoami) `id`\"\n" })
    const files = planFiles(p)
    assert.deepEqual(Object.keys(files).sort(), ['metallb.values.yaml', 'namespace', 'post.sh', 'post.yaml', 'pre.sh', 'releases'])
    assert.equal(files.releases, 'metallb|kubeez-metallb|https://metallb.github.io/metallb|metallb|0.16.1\n')
    assert.equal(JSON.parse(files['metallb.values.yaml']).controller.podLabels.note, "it's $(whoami) `id`")
    const cmd = writePlanCommand('metallb', files)
    assert.ok(!cmd.includes('whoami'), 'user text only travels base64-encoded')
    for (const m of cmd.matchAll(/echo (\S+) \| base64 -d \| sudo tee \/etc\/kubeez\/addons\/metallb\/([a-z.-]+) /g)) {
        assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), files[m[2]])
    }
    assert.throws(() => writePlanCommand('../etc', files))
})

test('preview diff and the values shown', () => {
    const d = lineDiff('a: 1\nb: 2\nc: 3', 'a: 1\nb: 5\nc: 3\nd: 4')
    assert.deepEqual(d.filter(x => x.t !== ' ').map(x => x.t + x.l), ['-b: 2', '+b: 5', '+d: 4'])
    const y = valuesYaml(buildPlan('metrics-server', cluster, {}))
    assert.match(y, /^# metrics-server — chart metrics-server 3\.14\.0/)
    assert.equal(YAML.parse(y.split('\n').slice(1).join('\n')).replicas, 1)
})

test('settings history: applied only after success; a failure keeps what runs', () => {
    addonSettingsStore.setPending('c-x', 'metrics-server', { settings: { replicas: 1 }, version: '3.14.0' }, { by: 'ann', jobId: 'j1' })
    addonSettingsStore.finish('c-x', 'metrics-server', 'j1', { ok: true })
    addonSettingsStore.setPending('c-x', 'metrics-server', { settings: { replicas: 3 }, version: '3.14.0' }, { by: 'bob', jobId: 'j2' })
    addonSettingsStore.finish('c-x', 'metrics-server', 'j-other', { ok: true })   // another job: ignored
    addonSettingsStore.finish('c-x', 'metrics-server', 'j2', { ok: false, error: 'pods not ready' })
    let r = addonSettingsStore.get('c-x', 'metrics-server')
    assert.equal(r.applied.settings.replicas, 1, 'the failed change did not replace what runs')
    assert.equal(r.pending, null)
    assert.deepEqual(r.history.map(h => [h.by, h.ok]), [['bob', false], ['ann', true]])
    assert.equal(r.history[0].error, 'pods not ready')
    addonSettingsStore.removed('c-x', 'metrics-server')
    r = addonSettingsStore.get('c-x', 'metrics-server')
    assert.equal(r.applied, null)
    assert.equal(r.lastSettings.settings.replicas, 1, 'a reinstall offers the last settings')
})

test('install job: plan written to the node, helm-addon.sh run, result recorded', async () => {
    const { automationEngine } = await import('../src/services/automationEngine.js')
    const cmds = []
    const ssh = { execCommand: async (c) => { cmds.push(c); return { code: 0, stdout: '', stderr: '' } }, dispose() {} }
    const ran = []
    const orig = automationEngine.executeScript
    automationEngine.executeScript = async (s, p, args) => { ran.push([path.basename(p), args]) }
    try {
        const inst = { id: 'job-1', originalClusterId: 'c-j', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [], addons: { kyverno: true }, requestedBy: 'ann',
            addonSettings: { kyverno: { settings: { mode: 'Enforce' }, version: '3.8.2' } } }
        await automationEngine.installHelmAddon(ssh, inst, 'kyverno', () => {}, {})
        assert.match(cmds[0], /^sudo rm -rf \/etc\/kubeez\/addons\/kyverno && sudo mkdir -p/)
        assert.deepEqual(ran, [['helm-addon.sh', ['kyverno']]])
        const r = addonSettingsStore.get('c-j', 'kyverno')
        assert.equal(r.applied.version, '3.8.2')
        assert.equal(r.applied.settings.mode, 'Enforce')
        assert.equal(r.history[0].by, 'ann')

        automationEngine.executeScript = async () => { throw new Error('KUBEEZ_FAIL INSTALL_FAILED') }
        await assert.rejects(automationEngine.installHelmAddon(ssh, { ...inst, id: 'job-2', addonSettings: { kyverno: { settings: { mode: 'Audit' } } } }, 'kyverno', () => {}, {}))
        const r2 = addonSettingsStore.get('c-j', 'kyverno')
        assert.equal(r2.applied.settings.mode, 'Enforce', 'still what runs')
        assert.equal(r2.history[0].ok, false)
        // Repair (no new settings) uses what runs
        automationEngine.executeScript = async () => {}
        await automationEngine.installHelmAddon(ssh, { ...inst, id: 'job-3', addonSettings: undefined }, 'kyverno', () => {}, {})
        assert.equal(addonSettingsStore.get('c-j', 'kyverno').history[0].settings.mode, 'Enforce')
    } finally { automationEngine.executeScript = orig }
})

// ── API ──────────────────────────────────────────────────────────────────────
let srv, url, started = []
before(async () => {
    const { authService } = await import('../src/services/authService.js')
    const { requireAuth } = await import('../src/middleware/authMiddleware.js')
    const { installationManager } = await import('../src/services/installationManager.js')
    const { automationEngine } = await import('../src/services/automationEngine.js')
    const USERS = {
        'tok-pro': { id: 'u-a', username: 'ann', role: 'admin', orgId: 'org-pro' },
        'tok-free': { id: 'u-f', username: 'fay', role: 'admin', orgId: 'org-free' },
        'tok-view': { id: 'u-v', username: 'vic', role: 'viewer', orgId: 'org-pro' }
    }
    authService.verifyToken = (t) => USERS[t] || null
    authService.getOrgPlan = (orgId) => orgId === 'org-pro' ? 'PRO' : 'FREE'
    installationManager.startInstallation = (i) => { started.push(i) }
    automationEngine.connectSSH = async () => ({
        execCommand: async (c) => /kubeseal/.test(c)
            ? { code: 0, stdout: 'apiVersion: bitnami.com/v1alpha1\nkind: SealedSecret\nmetadata:\n  name: db\n', stderr: '' }
            : { code: 0, stdout: '', stderr: '' },
        dispose() {}
    })
    const { default: routes } = await import('../src/routes/installation.js')
    const app = express(); app.use(express.json()); app.use('/api/clusters', requireAuth, routes)
    srv = http.createServer(app)
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${srv.address().port}/api/clusters`
})
after(() => { srv?.close(); fs.rmSync(DATA, { recursive: true, force: true }) })
const api = async (method, p, tok, body) => {
    const r = await fetch(url + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, data: await r.json().catch(() => ({})) }
}

test('API: settings form, preview, apply as a job; viewers and other workspaces kept out', async () => {
    let r = await api('GET', '/c-h/addons/metallb/settings', 'tok-pro')
    assert.equal(r.status, 200)
    assert.equal(r.data.schema.needsSettings, true)
    assert.equal(r.data.advancedAllowed, true)
    assert.equal((await api('GET', '/c-h/addons/metallb/settings', 'tok-view')).status, 403)
    assert.equal((await api('GET', '/c-f/addons/metallb/settings', 'tok-pro')).status, 403)
    assert.equal((await api('GET', '/c-h/addons/ingress/settings', 'tok-pro')).status, 404)

    r = await api('POST', '/c-h/addons/metallb/preview', 'tok-pro', { settings: { addresses: '10.0.0.4-10.0.0.9' } })
    assert.equal(r.status, 400)
    assert.match(r.data.error, /contains 10\.0\.0\.4 \(a node\)/)
    r = await api('POST', '/c-h/addons/metallb/preview', 'tok-pro', { settings: { addresses: '10.0.0.240-10.0.0.250' }, advanced: 'speaker:\n  logLevel: debug\n' })
    assert.equal(r.status, 200)
    assert.ok(r.data.changed && r.data.diff.some(d => d.t === '+' && /logLevel: debug/.test(d.l)))

    r = await api('POST', '/c-h/addons/metallb/settings', 'tok-pro', { settings: { addresses: '10.0.0.240-10.0.0.250' }, version: '0.15.3' })
    assert.equal(r.status, 200)
    const job = started.at(-1)
    assert.deepEqual([job.mode, job.originalClusterId, job.requestedBy, job.addonSettings.metallb.version], ['addon-only', 'c-h', 'ann', '0.15.3'])
    assert.deepEqual(job.addons, { metallb: true })
    assert.deepEqual(job.clusterAddons, { ingress: true })
})

test('API: Free plan — Metrics Server yes (form only), advanced YAML and Pro add-ons no', async () => {
    let r = await api('POST', '/c-f/addons/metrics-server/settings', 'tok-free', { settings: { replicas: 2 } })
    assert.equal(r.status, 200)
    r = await api('POST', '/c-f/addons/metrics-server/settings', 'tok-free', { settings: {}, advanced: 'replicas: 3' })
    assert.equal(r.status, 402)
    assert.match(r.data.error, /part of Pro/)
    r = await api('POST', '/c-f/addons/kyverno/settings', 'tok-free', { settings: {} })
    assert.equal(r.status, 402)
    assert.equal((await api('GET', '/c-f/addons/metrics-server/settings', 'tok-free')).data.advancedAllowed, false)
})

test('API: installing MetalLB without addresses asks for its settings first', async () => {
    const r = await api('POST', '/c-h/addons', 'tok-pro', { addons: { metallb: true } })
    assert.equal(r.status, 400)
    assert.equal(r.data.needsSettings, 'metallb')
    assert.equal((await api('POST', '/c-h/addons', 'tok-pro', { addons: { 'metrics-server': true } })).status, 200, 'defaults are enough for the others')
})

test('API: seal a secret with the cluster\'s key', async () => {
    let r = await api('POST', '/c-h/addons/sealed-secrets/seal', 'tok-pro', { name: 'db', namespace: 'shop', data: { password: 's3cret' } })
    assert.equal(r.status, 200)
    assert.match(r.data.yaml, /kind: SealedSecret/)
    r = await api('POST', '/c-h/addons/sealed-secrets/seal', 'tok-pro', { name: 'DB!', data: { a: 'b' } })
    assert.equal(r.status, 400)
    r = await api('POST', '/c-h/addons/sealed-secrets/seal', 'tok-pro', { name: 'db', scope: 'anything', data: { a: 'b' } })
    assert.equal(r.status, 400)
    r = await api('POST', '/c-h/addons/sealed-secrets/seal', 'tok-pro', { name: 'db', data: { 'bad key;': 'b' } })
    assert.equal(r.status, 400)
    assert.equal((await api('POST', '/c-h/addons/sealed-secrets/seal', 'tok-view', { name: 'db', data: { a: 'b' } })).status, 403)
})
