// Resume analysis: the commands run for real (bash + awk) against stub
// kubectl/systemctl/... binaries, so the parsing is tested end to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
process.env.APP_SECRET = 'test-secret'
const { automationEngine } = await import('../src/services/automationEngine.js')
const { resumeAnalyzer } = await import('../src/services/resumeAnalyzer.js')

// Build a fake node: canned `kubectl get pods -A`, `get nodes`, per-namespace pods
function fakeNode({ podsAll, nodes, nsPods = {} }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-resume-'))
    const w = (name, body) => fs.writeFileSync(path.join(dir, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'pods-all'), podsAll)
    fs.writeFileSync(path.join(dir, 'nodes'), nodes)
    for (const [ns, out] of Object.entries(nsPods)) fs.writeFileSync(path.join(dir, `ns-${ns}`), out)
    w('sudo', '[ "$1" = ls ] && exit 0; exec env "$@"')
    w('systemctl', 'exit 0')
    w('containerd', 'echo "containerd github.com/containerd/containerd/v2 v2.3.6 x"')
    w('kubeadm', 'echo v1.36.0')
    w('kubelet', 'echo Kubernetes v1.36.0')
    w('etcdctl', 'echo "https://127.0.0.1:2379 is healthy"')
    w('kubectl', `D=${JSON.stringify(dir.replace(/\\/g, '/'))}
case "$*" in
  *"pods -A"*) cat "$D/pods-all" ;;
  *"get nodes"*) cat "$D/nodes" ;;
  *"get pods -n "*) ns=$(echo "$*" | sed -E 's/.*-n ([^ ]+).*/\\1/'); cat "$D/ns-$ns" 2>/dev/null ;;
esac`)
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
    return {
        execCommand: async (cmd) => {
            const r = spawnSync('bash', ['-c', `export PATH="${dir.replace(/\\/g, '/')}:$PATH"; ${cmd}`], { encoding: 'utf8', env })
            return { code: r.status, stdout: r.stdout, stderr: r.stderr }
        },
        dispose() {}
    }
}

const cluster = {
    masterNodes: [{ ip: '10.0.0.1' }],
    workerNodes: [{ ip: '10.0.0.2', hostname: 'worker1' }],
    addons: { seaweedfs: true, 'cert-manager': true }
}
const NODES = 'master1   Ready   control-plane   1d   v1.36.0\nworker1   Ready   <none>   1d   v1.36.0\n'

test('Flannel in kube-flannel counts as installed; resume goes to the failed add-on only', async () => {
    automationEngine.connectSSH = async () => fakeNode({
        podsAll: 'kube-flannel   kube-flannel-ds-abcde   1/1   Running   0   1d\nkube-system   coredns-x   1/1   Running   0   1d\n',
        nodes: NODES,
        nsPods: {
            seaweedfs: 'seaweedfs-0   0/1   Pending   0   5m\n',
            'cert-manager': 'cert-manager-a   1/1   Running   0   1d\ncert-manager-b   1/1   Running   0   1d\n'
        }
    })
    const a = await resumeAnalyzer.analyze(cluster)
    const cni = a.checks.find(c => c.key === 'installNetworkPlugin')
    assert.equal(cni.done, true, cni.detail)
    assert.match(cni.detail, /kube-flannel-ds-abcde/)
    assert.equal(a.checks.find(c => c.key === 'joinNodes').done, true)
    assert.equal(a.resumeFromStep, 'installAddons')
    assert.deepEqual(a.pendingAddons, ['seaweedfs'])
    assert.deepEqual(a.missingWorkers, [])
})

test('unknown CNI: all nodes Ready means networking works', async () => {
    automationEngine.connectSSH = async () => fakeNode({ podsAll: '', nodes: NODES })
    const a = await resumeAnalyzer.analyze({ ...cluster, addons: {} })
    assert.equal(a.checks.find(c => c.key === 'installNetworkPlugin').done, true)
    assert.equal(a.allDone, true)
})

test('no CNI and NotReady nodes → resume from the network plugin', async () => {
    automationEngine.connectSSH = async () => fakeNode({
        podsAll: '', nodes: 'master1   NotReady   control-plane   1m   v1.36.0\n'
    })
    const a = await resumeAnalyzer.analyze(cluster)
    assert.equal(a.resumeFromStep, 'installNetworkPlugin')
})

test('one healthy pod next to a crashing one is not a finished add-on', async () => {
    automationEngine.connectSSH = async () => fakeNode({
        podsAll: 'kube-flannel   kube-flannel-ds-a   1/1   Running   0   1d\n', nodes: NODES,
        nsPods: { seaweedfs: 'a   1/1   Running   0   1m\nb   0/1   CrashLoopBackOff   4   1m\n' }
    })
    const a = await resumeAnalyzer.analyze({ ...cluster, addons: { seaweedfs: true } })
    assert.deepEqual(a.pendingAddons, ['seaweedfs'])
})

test('resume skips finished steps, never re-joins nodes, installs only pending add-ons', async () => {
    const ran = []
    const engine = Object.create(automationEngine)
    for (const m of ['installNetworkPlugin', 'joinNodes', 'postInstallationValidation'])
        engine[m] = async () => { ran.push(m) }
    engine.installAddons = async (c) => { ran.push('installAddons:' + Object.keys(c.addons).join(',')) }
    engine._regenerateJoinCommand = async () => 'kubeadm join x'
    let error = null
    await engine.resume(cluster, {
        resumeFromStep: 'installNetworkPlugin',
        missingWorkers: [],
        pendingAddons: ['seaweedfs', 'not-configured'],
        checks: [
            { key: 'installNetworkPlugin', done: false },
            { key: 'joinNodes', done: true },
            { key: 'installAddons', done: false }
        ]
    }, { onProgress() {}, onLog() {}, onComplete() {}, onError(e) { error = e } })
    assert.equal(error, null)
    assert.deepEqual(ran, ['installNetworkPlugin', 'installAddons:seaweedfs', 'postInstallationValidation'])
})
