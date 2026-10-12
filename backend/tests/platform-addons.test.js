// Harbor, Fluent Bit, Fluentd, Elasticsearch, NFS, volume snapshots, Flux,
// Jenkins, Vault, OPA Gatekeeper, Falco, Trivy Operator: the settings are
// checked before anything reaches a node, the plans carry what makes each one
// work, new versions are found for all of them, and each has a clean uninstall.
// (Real installs: tests/e2e/platform-addons-check.mjs)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
const { HELM_ADDONS, SYSTEM_NAMESPACES } = await import('../src/config/helmAddons.js')
const { buildPlan, planFiles } = await import('../src/services/addonSettings.js')
const { discoverFor, chartSources } = await import('../src/services/addonVersions.js')
const { checkAddonPlan } = await import('../src/config/addonTiers.js')

const NEW = ['nfs-provisioner', 'snapshot-controller', 'elasticsearch', 'fluentd', 'fluent-bit', 'harbor', 'flux', 'jenkins', 'vault', 'gatekeeper', 'falco', 'trivy-operator']
const cluster = (addons = {}, extra = {}) => ({ id: 'c1', k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [{ ip: '10.0.0.5' }], addons, ...extra })
const plan = (key, settings = {}, addons = {}, extra) => buildPlan(key, cluster(addons, extra), { settings: { ...(HELM_ADDONS[key].example || {}), ...settings } })
const values = (p, i = 0) => p.releases[i].values

test('every new add-on: Pro, its own namespace kept out of policies, a chart repository for updates, an uninstall branch', () => {
    const uninstall = fs.readFileSync(new URL('../src/automation/addon-uninstall.sh', import.meta.url), 'utf8')
    for (const k of NEW) {
        const a = HELM_ADDONS[k]
        assert.ok(SYSTEM_NAMESPACES.includes(a.ns), `${k}: ${a.ns} is a system namespace`)
        assert.equal(checkAddonPlan({ [k]: true }, 'FREE').allowed, false, `${k} is Pro`)
        assert.ok(chartSources(a).length, `${k}: new versions can be found`)
        assert.match(uninstall, new RegExp(`^${k}\\)$`, 'm'), `${k}: uninstall branch`)
    }
})

test('NFS: server and folder checked; the node tests a real mount; nothing else reaches the shell', () => {
    assert.throws(() => plan('nfs-provisioner', { server: '' }), /NFS server/)
    assert.throws(() => plan('nfs-provisioner', { server: '10.0.0.9; reboot' }), /NFS server/)
    assert.throws(() => plan('nfs-provisioner', { path: 'exports' }), /absolute path/)
    assert.throws(() => plan('nfs-provisioner', { path: '/a/../etc' }), /absolute path/)
    const p = plan('nfs-provisioner', { server: 'nas.lan', path: '/srv/k8s', nfsVersion: '4.1', reclaimPolicy: 'Retain' })
    assert.deepEqual(values(p).nfs, { server: 'nas.lan', path: '/srv/k8s', mountOptions: ['nfsvers=4.1'] })
    assert.equal(values(p).storageClass.name, 'nfs-client')
    assert.equal(values(p).storageClass.reclaimPolicy, 'Retain')
    assert.match(p.pre, /dev\/tcp\/nas\.lan\/2049/)
    assert.match(p.pre, /mount -t nfs -o nfsvers=4\.1 "nas\.lan:\/srv\/k8s"/)
    assert.match(p.pre, /kubeez-nfs-client/, 'the NFS client is installed on every node')
    assert.doesNotMatch(plan('nfs-provisioner', { installClient: false }).pre, /"kind":"DaemonSet"/)
    assert.match(p.post.script, /kubeez-nfs-test/, 'a real volume is created as the last check')
})

test('storage: auto picks Longhorn, else NFS, else the node; Vault refuses a node-only volume', () => {
    assert.equal(values(plan('jenkins', {}, { longhorn: true })).persistence.storageClass, 'longhorn')
    assert.equal(values(plan('jenkins', {}, { 'nfs-provisioner': true })).persistence.storageClass, 'nfs-client')
    assert.equal(values(plan('jenkins', {})).persistence.enabled, false)
    assert.throws(() => plan('jenkins', { storage: 'longhorn' }), /Longhorn is not installed/)
    assert.match(plan('jenkins', { storage: 'default' }).pre, /NO_DEFAULT_STORAGECLASS/)
    assert.throws(() => plan('vault', {}), /Vault keeps its data on a volume/)
    assert.throws(() => plan('vault', { storage: 'node' }), /cannot keep its data on the node/)
    assert.equal(values(plan('vault', { mode: 'dev' })).server.dev.enabled, true, 'dev mode needs no volume')
})

test('Harbor: its own long-lived certificate, the address of the cluster, nodes trust it', () => {
    let p = plan('harbor', {}, { longhorn: true }, { controlPlaneVip: '10.0.0.100' })
    assert.equal(values(p).externalURL, 'https://10.0.0.100:30003', 'the virtual IP when there is one')
    p = plan('harbor', { address: 'registry.example.com', httpsPort: 31443 }, { longhorn: true })
    const v = values(p)
    assert.equal(v.externalURL, 'https://registry.example.com:31443')
    assert.equal(v.expose.tls.certSource, 'secret')
    assert.equal(v.existingSecretAdminPassword, 'kubeez-harbor-admin', 'no default Harbor12345')
    assert.equal(v.persistence.persistentVolumeClaim.registry.storageClass, 'longhorn')
    assert.match(p.pre, /openssl req -x509 .* -days 3650/)
    assert.match(p.pre, /DNS:registry\.example\.com,IP:10\.0\.0\.4,IP:10\.0\.0\.5/)
    assert.match(p.pre, /grep -qE "DNS:registry\\\.example\\\.com\(,\|\$\)"/, 'an exact name match')
    const ds = p.post.manifests.find(m => m.kind === 'DaemonSet')
    assert.equal(ds.spec.template.spec.initContainers[0].env[0].value, 'registry.example.com:31443')
    assert.match(ds.spec.template.spec.initContainers[0].command[2], /config_path = .*certs\.d/)
    assert.equal(plan('harbor', { trustNodes: false }).post.manifests.length, 0)
    assert.throws(() => plan('harbor', { address: 'bad host!' }), /IPv4 address or a DNS name/)
    assert.equal(p.releases[0].slow, true)
    assert.match(planFiles(p).releases, /\|slow$/m, '20 minutes for the first image pulls')
})

test('Elasticsearch: the stack version is the add-on version; Kibana and storage from the form', () => {
    const p = plan('elasticsearch', { nodes: '3', memory: '4', sizeGi: 50, apiPort: 30920 }, { longhorn: true })
    assert.equal(p.version, '9.5.5')
    const [es, kb] = p.post.manifests
    assert.equal(es.spec.version, '9.5.5')
    assert.equal(es.spec.nodeSets[0].count, 3)
    assert.equal(es.spec.nodeSets[0].volumeClaimTemplates[0].spec.storageClassName, 'longhorn')
    assert.equal(es.spec.nodeSets[0].podTemplate.spec.containers[0].resources.limits.memory, '4Gi')
    assert.equal(es.spec.http.service.spec.ports[0].nodePort, 30920)
    assert.equal(kb.kind, 'Kibana')
    assert.equal(kb.spec.http.service.spec.ports[0].nodePort, 30561)
    const off = plan('elasticsearch', { kibana: false })
    assert.equal(off.post.manifests.length, 1)
    assert.match(off.post.script, /delete kibana/)
    assert.ok(off.post.manifests[0].spec.nodeSets[0].podTemplate.spec.volumes, 'node-only storage: emptyDir')
    assert.equal(plan('elasticsearch', {}, {}, {}).releases[0].values.telemetry.disabled, true)
})

test('Elasticsearch: new stack versions come from Elastic\'s version list, the operator chart follows its newest', () => {
    const def = HELM_ADDONS.elasticsearch
    const idx = {
        [def.appSource.url]: JSON.stringify({ versions: ['8.19.23', '8.19.24', '9.5.5', '9.6.0-SNAPSHOT', '9.6.0', '9.6.1'] }),
        'https://helm.elastic.co': 'apiVersion: v1\nentries:\n  eck-operator:\n  - appVersion: 3.6.0\n    version: 3.6.0\n  - appVersion: 3.5.0\n    version: 3.5.0\n'
    }
    assert.deepEqual(discoverFor(def, idx).map(v => [v.id, v.charts['eck-operator']]), [['9.6.1', '3.6.0'], ['8.19.24', '3.6.0']])
    assert.deepEqual(discoverFor(def, { [def.appSource.url]: idx[def.appSource.url] }), [], 'operator chart unknown → nothing offered')
})

test('Fluentd and Fluent Bit: logs go where chosen; Elasticsearch login from a Secret, never in the values', () => {
    assert.throws(() => plan('fluent-bit', { output: 'elasticsearch' }), /Elasticsearch add-on is not installed/)
    assert.throws(() => plan('fluent-bit', { output: 'fluentd' }), /Fluentd add-on is not installed/)
    let p = plan('fluent-bit', {}, { elasticsearch: true })
    assert.match(values(p).config.outputs, /Name es[\s\S]*Host kubeez-es-http\.elastic-system\.svc[\s\S]*HTTP_Passwd \$\{ES_PASSWORD\}/)
    assert.deepEqual(values(p).env.map(e => e.valueFrom.secretKeyRef.name), ['kubeez-es-credentials', 'kubeez-es-credentials'])
    assert.match(p.pre, /kubeez-es-elastic-user/)
    assert.match(values(plan('fluent-bit', {}, { fluentd: true })).config.outputs, /Name forward[\s\S]*fluentd\.fluentd\.svc/)
    assert.match(values(plan('fluent-bit', {})).config.outputs, /Name stdout/)
    p = plan('fluent-bit', { output: 'external', host: 'es.corp', port: 9243, secret: 'es-login' })
    assert.match(values(p).config.outputs, /Host es\.corp[\s\S]*Port 9243[\s\S]*tls On/)
    assert.equal(values(p).fullnameOverride, 'kubeez-fluent-bit', 'never clashes with Loki\'s Fluent Bit')
    assert.throws(() => plan('fluent-bit', { output: 'external', host: 'es.corp', secret: 'Bad_Name' }), /Secret/)
    assert.throws(() => plan('fluent-bit', { index: 'Logs*' }), /Index prefix/)

    p = plan('fluentd', {}, { elasticsearch: true })
    assert.equal(values(p).kind, 'Deployment')
    assert.match(values(p).fileConfigs['01_sources.conf'], /@type forward[\s\S]*port 24224/)
    assert.match(values(p).fileConfigs['04_outputs.conf'], /@type elasticsearch[\s\S]*password "#\{ENV\['ES_PASSWORD'\]\}"[\s\S]*logstash_prefix kubeez-logs/)
    assert.equal(values(p).dashboards.enabled, false)
    p = plan('fluentd', { role: 'collector' })
    assert.equal(values(p).kind, 'DaemonSet')
    assert.equal(values(p).fileConfigs['01_sources.conf'], undefined, 'the chart\'s own tail source')
    assert.match(values(p).fileConfigs['04_outputs.conf'], /@type stdout/)
})

test('Flux: an optional repository to sync; removing it never deletes what was deployed', () => {
    assert.equal(plan('flux').post.manifests.length, 0)
    assert.throws(() => plan('flux', { gitUrl: 'git@github.com:org/x.git' }), /https:\/\//)
    assert.throws(() => plan('flux', { gitUrl: 'https://github.com/org/x.git', path: '../../etc' }), /Folder/)
    assert.throws(() => plan('flux', { gitUrl: 'https://github.com/org/x.git', branch: 'main; rm' }), /Branch/)
    const p = plan('flux', { gitUrl: 'https://github.com/stefanprodan/podinfo', branch: 'master', path: './kustomize', interval: 2, secret: 'git-login' })
    const [repo, ks] = p.post.manifests
    assert.equal(repo.spec.url, 'https://github.com/stefanprodan/podinfo')
    assert.equal(repo.spec.secretRef.name, 'git-login')
    assert.equal(ks.spec.prune, false, 'no pruning unless chosen')
    assert.equal(ks.spec.interval, '2m')
    assert.match(plan('flux').post.script, /"prune":false[\s\S]*delete kustomizations/)
    assert.equal(values(plan('flux', { imageAutomation: true })).imageAutomationController.create, true)
})

test('Jenkins, Vault, Gatekeeper, Falco, Trivy: the values that make them work', () => {
    let v = values(plan('jenkins', { plugins: 'blueocean, docker-workflow:621.va_73f881d9232', memory: '4' }, {}, { controlPlaneVip: '10.0.0.100' }))
    assert.deepEqual(v.controller.additionalPlugins, ['blueocean', 'docker-workflow:621.va_73f881d9232'])
    assert.equal(v.controller.jenkinsUrl, 'http://10.0.0.100:30808/')
    assert.equal(v.controller.resources.limits.memory, '4Gi')
    assert.throws(() => plan('jenkins', { plugins: 'x; curl evil' }), /Extra plugins/)

    let p = plan('vault', {}, { longhorn: true })
    v = values(p)
    assert.match(v.server.readinessProbe.path, /sealedcode=204&uninitcode=204/, 'a sealed Vault still counts as started')
    assert.equal(v.server.dataStorage.storageClass, 'longhorn')
    assert.equal(v.ui.serviceNodePort, 30820)
    assert.match(p.post.script, /operator init -key-shares=1 -key-threshold=1/)
    assert.match(p.post.script, /operator unseal "\$KEY"/)
    assert.match(p.post.script, /auth enable kubernetes[\s\S]*kv-v2/)
    assert.match(p.post.script, /delete pod vault-0/, 'OnDelete: a new version needs the pod recreated')
    assert.equal(p.post.manifests[0].kind, 'CronJob')
    assert.equal(p.post.manifests[0].spec.jobTemplate.spec.template.spec.containers[0].image, 'hashicorp/vault:2.0.4')
    assert.equal(plan('vault', { autoUnseal: false }, { longhorn: true }).post.manifests.length, 0)
    // the injector / Gatekeeper / ECK patch their own webhook certificates: client-side apply on upgrades
    for (const k of ['vault', 'gatekeeper', 'elasticsearch']) assert.match(planFiles(plan(k, {}, { longhorn: true })).releases, /\|csa$/m, k)

    p = plan('gatekeeper', { mode: 'deny', policy_privileged: false })
    const kinds = p.post.manifests.map(m => m.kind)
    assert.deepEqual(kinds.filter(k => k === 'ConstraintTemplate').length, 3)
    const c = p.post.manifests.find(m => m.kind === 'KubeezDisallowLatest')
    assert.equal(c.spec.enforcementAction, 'deny')
    assert.ok(c.spec.match.excludedNamespaces.includes('kube-system') && c.spec.match.excludedNamespaces.includes('gatekeeper-system'))
    assert.match(p.post.manifests[0].spec.targets[0].rego, /^package kubeezdisallowlatest\n\ncontainers\[c\] \{/)
    assert.doesNotMatch(p.post.manifests.map(m => m.spec.targets?.[0].rego || '').join('\n'), /import|\bcontains \{|\bif \{/, 'Rego v0, no imports (Gatekeeper refuses them)')
    assert.match(p.post.script, /delete constrainttemplates\.templates\.gatekeeper\.sh kubeezdisallowprivileged/)
    assert.equal(values(p).validatingWebhookFailurePolicy, 'Ignore')

    p = plan('falco', { priority: 'warning', uiPort: 31282 })
    assert.equal(values(p).falco.priority, 'warning')
    assert.equal(values(p).falcosidekick.webui.service.nodePort, 31282)
    assert.equal(values(p).falcosidekick.webui.existingSecret, 'kubeez-falco-ui', 'no default admin:admin')
    assert.match(p.pre, /btf\/vmlinux/)
    assert.doesNotMatch(plan('falco', { driver: 'kmod' }).pre, /btf/)

    v = values(plan('trivy-operator', { severity: 'MEDIUM', concurrent: 2, rbac: false }))
    assert.equal(v.trivy.severity, 'MEDIUM,HIGH,CRITICAL')
    assert.equal(v.operator.scanJobsConcurrentLimit, 2)
    assert.equal(v.operator.rbacAssessmentScannerEnabled, false)
})

test('volume snapshots: takes over snapshot types installed before, refuses a second controller, Longhorn class', () => {
    const p = plan('snapshot-controller')
    assert.equal(values(p).keepCRDs, true, 'snapshots survive an uninstall')
    assert.match(p.pre, /meta\.helm\.sh\/release-name=snapshot-controller/)
    assert.match(p.pre, /SNAPSHOT_CONTROLLER_EXISTS/)
    assert.match(p.post.script, /csidriver driver\.longhorn\.io[\s\S]*longhorn-snapshot/)
    assert.match(plan('snapshot-controller', { longhornClass: false }).post.script, /delete volumesnapshotclass longhorn-snapshot/)
})
