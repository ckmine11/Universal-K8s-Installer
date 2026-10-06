// Control-plane virtual IP (kube-vip): input checks and how the scripts get it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const { vipProblem } = await import('../src/routes/installation.js')
const AUTO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/automation')
const read = (f) => fs.readFileSync(path.join(AUTO, f), 'utf8')

test('VIP input is checked', () => {
    const masters = [{ ip: '10.0.0.11' }, { ip: '10.0.0.12' }]
    assert.equal(vipProblem(undefined, masters, []), null, 'optional')
    assert.equal(vipProblem('10.0.0.50', masters, []), null)
    assert.match(vipProblem('10.0.0.12', masters, []), /node's own address/)
    assert.match(vipProblem('10.0.0.60', masters, [{ ip: '10.0.0.60' }]), /node's own address/)
    assert.match(vipProblem('10.0.0', masters, []), /IPv4/)
    assert.match(vipProblem('fd00::5', masters, []), /IPv4/)
    assert.match(vipProblem('127.0.0.5', masters, []), /normal LAN/)
    assert.match(vipProblem("10.0.0.5'; rm -rf /", masters, []), /IPv4/)
})

test('scripts: VIP is the kubeadm endpoint and kube-vip runs on every control-plane', () => {
    const init = read('init-control-plane.sh')
    assert.match(init, /controlPlaneEndpoint: "\$ENDPOINT:6443"/)
    assert.match(init, /ghcr\.io\/kube-vip\/kube-vip:v\d+\.\d+\.\d+/)
    assert.match(init, /super-admin\.conf/, 'k8s >= 1.29 needs super-admin.conf during init')
    assert.match(init, /DirAvailable--etc-kubernetes-manifests/)
    assert.match(init, /VIP_IN_USE/)
    assert.match(read('join-master.sh'), /write_kube_vip "\$VIP" "\$NODE_IP" \/etc\/kubernetes\/admin\.conf/)
    assert.match(read('recover-control-plane.sh'), /write_kube_vip "\$VIP" "\$IP"/, 'recovery takes the VIP again')
    for (const f of ['etcd-restore.sh', 'etcd-member.sh']) {
        assert.match(read(f), /KC=\/root\/\.kubeez-local\.conf/, `${f} checks the local API, not the VIP`)
        assert.match(read(f), /tls-server-name: kubernetes/)
    }
})
