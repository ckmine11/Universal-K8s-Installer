// Commands sent through the Gateway Agent's relay carry their stdin inside the
// command line (the relay has no stdin): small inputs inline, large ones in
// chunks to a private temp file — checked by running them in a real bash.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { stdinCommands } from '../src/utils/stdinRelay.js'

const bash = ['/bin/bash', '/usr/bin/bash'].find(p => fs.existsSync(p)) || (spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null)
const sh = (cmd) => spawnSync(bash, ['-c', cmd], { encoding: 'utf8', maxBuffer: 64 << 20 })
const runAll = ({ steps, run }) => { for (const s of steps) assert.equal(sh(s).status, 0, s.slice(0, 80)); return sh(run) }

test('small input: one command; the command gets exactly the bytes, quotes and newlines included', { skip: !bash }, () => {
    const manifest = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [{ metadata: { name: "it's \"quoted\"\n$(rm -rf /)" } }] })
    const c = stdinCommands('cat', manifest)
    assert.equal(c.steps.length, 0)
    assert.match(c.run, /^printf '%s' '[A-Za-z0-9+/=]*' \| base64 -d \| \(/)
    const r = runAll(c)
    assert.equal(r.status, 0); assert.equal(r.stdout, manifest)
})

test('the command\'s own exit code and output come back; && / || chains keep working', { skip: !bash }, () => {
    assert.equal(runAll(stdinCommands('cat >/dev/null; exit 3', 'x')).status, 3)
    const r = runAll(stdinCommands('wc -c && echo ok || echo no', 'hello'))
    assert.match(r.stdout, /5\s+ok/)
})

test('large input (Helm values, 300 KB): chunks into a temp file, then removed', { skip: !bash }, () => {
    const big = 'key: ' + 'x'.repeat(300 * 1024) + '\n'
    // the default pieces fit a Linux node's 128 KB argument limit with room to spare
    const def = stdinCommands('wc -c', big)
    assert.ok(def.steps.length >= 4, 'created + several chunks'); assert.ok(def.steps.every(s => s.length < 30 * 1024))
    // run for real with pieces this machine's bash accepts (Git Bash on Windows stops near 8 KB)
    const c = stdinCommands('wc -c', big, { chunk: 6000 })
    const file = /'(\/tmp\/kubeez-stdin-[a-z0-9]+)'/.exec(c.run)[1]
    const r = runAll(c)
    assert.equal(r.status, 0); assert.equal(Number(r.stdout.trim()), Buffer.byteLength(big))
    assert.equal(sh(`test -e '${file}'`).status, 1, 'temp file removed')
})

test('a GitOps app path is a folder of manifests, not a file such as a Dockerfile', async () => {
    const { cleanCreateApp } = await import('../src/services/gitops.js')
    const ok = { name: 'ekart', repoURL: 'https://github.com/acme/ekart.git', namespace: 'ekart' }
    for (const path of ['docker/Dockerfile', 'Dockerfile', 'k8s/deployment.yaml', 'deploy/app.yml', 'chart.tgz'])
        assert.throws(() => cleanCreateApp({ ...ok, path }), /must be a folder with Kubernetes manifests/, path)
    for (const path of ['k8s', 'deploy/prod', 'charts/ekart', '']) assert.equal(cleanCreateApp({ ...ok, path }).path, path)
})

test('empty or missing input still runs the command with an empty stdin', { skip: !bash }, () => {
    assert.equal(runAll(stdinCommands('wc -c', '')).stdout.trim(), '0')
    assert.equal(runAll(stdinCommands('wc -c', null)).stdout.trim(), '0')
})
