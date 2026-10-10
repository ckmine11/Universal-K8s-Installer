// Warnings before something breaks: kubelet stats → samples → disk-fill
// forecast and sustained high CPU / memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseQuantity, parseResources, diskForecast, analyzeResources, resourceView } from '../src/services/resourceForecast.js'
import { CATALOG } from '../src/config/incidentCatalog.js'
import { PLAYBOOKS } from '../src/services/remediationEngine.js'

const GB = 1024 ** 3
const MIN = 60e3
const T0 = Date.parse('2026-10-10T10:00:00Z')

const summary = ({ cpu = 1, memUsed = 4 * GB, memAvail = 12 * GB, used = 40 * GB, cap = 100 * GB } = {}) => JSON.stringify({
    node: { cpu: { usageNanoCores: cpu * 1e9 }, memory: { workingSetBytes: memUsed, availableBytes: memAvail }, fs: { usedBytes: used, capacityBytes: cap, availableBytes: cap - used } },
    pods: [
        { podRef: { namespace: 'shop', name: 'api-1' }, cpu: { usageNanoCores: 2.5e9 }, memory: { workingSetBytes: 6 * GB } },
        { podRef: { namespace: 'kube-system', name: 'etcd-cp1' }, cpu: { usageNanoCores: 0.2e9 }, memory: { workingSetBytes: 0.5 * GB } }
    ]
})

// samples every 2 minutes from `from` minutes ago
function history(n, fn, { every = 2, ip = '10.0.0.5' } = {}) {
    const samples = []
    for (let i = 0; i < n; i++) samples.push({ t: T0 - (n - 1 - i) * every * MIN, ...fn(i) })
    return { w1: { ip, samples } }
}

test('quantities from the Kubernetes API', () => {
    assert.equal(parseQuantity('4'), 4)
    assert.equal(parseQuantity('3500m'), 3.5)
    assert.equal(parseQuantity('16Gi'), 16 * GB)
    assert.equal(parseQuantity('16384Ki'), 16 * 1024 * 1024)
    assert.equal(parseQuantity('weird'), null)
})

test('the poll output becomes one sample per node', () => {
    const out = `==CAP\ncp1 4 16Gi 10.0.0.4\nw1 2 8Gi 10.0.0.5\n==NODE cp1\n${summary()}\n==NODE w1\nnot json\n==END\n`
    const r = parseResources(out, T0)
    assert.deepEqual(Object.keys(r), ['cp1'], 'a node whose stats cannot be read is skipped')
    const s = r.cp1.sample
    assert.equal(r.cp1.ip, '10.0.0.4')
    assert.equal(s.cpuPct, 25)          // 1 of 4 cores
    assert.equal(s.memPct, 25)          // 4 of 16 GiB
    assert.equal(s.diskPct, 40)
    assert.equal(s.topMem[0].pod, 'shop/api-1')
    assert.equal(s.topCpu[0].pod, 'shop/api-1')
})

test('disk forecast: steady growth → hours until full; flat or noisy → nothing', () => {
    // 60 GB used of 100, +1 GB every 2 minutes = 30 GB/h → 40 GB free = ~1.3 h
    let h = history(30, i => ({ diskUsed: (60 - 29 + i) * GB, diskCap: 100 * GB, diskAvail: (100 - 60 + 29 - i) * GB }))
    const fc = diskForecast(h.w1.samples, T0)
    assert.ok(Math.abs(fc.perHour / GB - 30) < 0.5)
    assert.ok(fc.hoursToFull > 1.2 && fc.hoursToFull < 1.5)

    h = history(30, () => ({ diskUsed: 60 * GB, diskCap: 100 * GB, diskAvail: 40 * GB }))
    assert.equal(diskForecast(h.w1.samples, T0).hoursToFull, null, 'not growing')
    h = history(4, i => ({ diskUsed: (60 + i) * GB, diskCap: 100 * GB }))
    assert.equal(diskForecast(h.w1.samples, T0), null, 'too little data to say')
})

test('disk forecast: a cleanup starts a new trend', () => {
    // grew fast, then a cleanup dropped usage; since then flat
    const h = history(40, i => i < 20
        ? { diskUsed: (50 + i) * GB, diskCap: 100 * GB }
        : { diskUsed: 40 * GB, diskCap: 100 * GB })
    assert.equal(diskForecast(h.w1.samples, T0).hoursToFull, null)
})

test('NodeDiskFilling: warning within 24 h, critical within 3 h, no flapping', () => {
    const grow = (gbPerSample, freeNow) => history(30, i => {
        const used = 100 * GB - freeNow * GB - (29 - i) * gbPerSample * GB
        return { diskUsed: used, diskCap: 100 * GB, diskAvail: 100 * GB - used, diskPct: Math.round(used / GB) }
    })
    // 0.1 GB per 2 min = 3 GB/h, 30 GB free → 10 h
    let f = analyzeResources(grow(0.1, 30), { now: T0 })
    assert.equal(f.length, 1)
    assert.equal(f[0].reason, 'NodeDiskFilling')
    assert.equal(f[0].severity, 'warning')
    assert.equal(f[0].nodeIp, '10.0.0.5')
    assert.match(f[0].message, /full in about 10 h/)
    // 1 GB per 2 min = 30 GB/h, 30 GB free → 1 h
    f = analyzeResources(grow(1, 30), { now: T0 })
    assert.equal(f[0].severity, 'critical')
    // 3 GB/h with 100 h of room → nothing… unless it is already open (until > 48 h)
    assert.equal(analyzeResources(grow(0.1, 100), { now: T0 }).length, 0)
    assert.equal(analyzeResources(grow(0.1, 120), { now: T0, isOpen: () => true }).length, 1, '40 h — still open')
    assert.equal(analyzeResources(grow(0.1, 200), { now: T0, isOpen: () => true }).length, 0, '66 h — clears')
})

test('memory / CPU: only when high for 15 minutes, with the pods using it', () => {
    const top = { topMem: [{ pod: 'shop/api-1', mem: 6 * GB }], topCpu: [{ pod: 'shop/api-1', cpu: 3.5 }] }
    // 10 minutes high → nothing yet
    let f = analyzeResources(history(6, () => ({ memPct: 96, cpuPct: 50, ...top })), { now: T0 })
    assert.equal(f.length, 0)
    // 18 minutes ≥ 90 → warning, ≥ 95 → critical
    f = analyzeResources(history(10, () => ({ memPct: 92, cpuPct: 50, ...top })), { now: T0 })
    assert.deepEqual(f.map(x => [x.reason, x.severity]), [['NodeMemoryHigh', 'warning']])
    assert.match(f[0].message, /Memory on w1 at 92% for 15\+ minutes — top pods: shop\/api-1 \(6\.0 GB\)/)
    f = analyzeResources(history(10, () => ({ memPct: 50, cpuPct: 97, ...top })), { now: T0 })
    assert.deepEqual(f.map(x => [x.reason, x.severity]), [['NodeCPUHigh', 'critical']])
    assert.match(f[0].message, /shop\/api-1 \(3\.50 cores\)/)
    // one dip below 90 → not sustained
    f = analyzeResources(history(10, i => ({ memPct: i === 6 ? 80 : 93, ...top })), { now: T0 })
    assert.equal(f.length, 0)
    // open incident stays until below 85 %
    assert.equal(analyzeResources(history(10, () => ({ memPct: 87, ...top })), { now: T0, isOpen: (r) => r === 'NodeMemoryHigh' }).length, 1)
    assert.equal(analyzeResources(history(10, () => ({ memPct: 80, ...top })), { now: T0, isOpen: (r) => r === 'NodeMemoryHigh' }).length, 0)
    // stale numbers (no sample for > 10 min) say nothing
    assert.equal(analyzeResources(history(10, () => ({ memPct: 99, ...top })), { now: T0 + 30 * MIN }).length, 0)
})

test('catalog + playbooks: disk cleanup fixes, memory / CPU are diagnosed', () => {
    for (const r of ['NodeDiskFilling', 'NodeMemoryHigh', 'NodeCPUHigh']) assert.ok(CATALOG[r]?.label && CATALOG[r].suggestion, r)
    assert.equal(CATALOG.NodeDiskFilling.fixable, true)
    assert.equal(typeof PLAYBOOKS.NodeDiskFilling.fix, 'function')
    assert.equal(typeof PLAYBOOKS.NodeMemoryHigh.diagnose, 'function')
    assert.equal(typeof PLAYBOOKS.NodeCPUHigh.diagnose, 'function')
})

test('the Incidents page gets the latest numbers per node', () => {
    const h = history(30, i => ({ cpuPct: 20 + i, memPct: 50, diskPct: 60, diskUsed: (60 + i * 0.01) * GB, diskCap: 100 * GB, cores: 4, memTotal: 16 * GB, topCpu: [], topMem: [] }))
    const [v] = resourceView(h, T0)
    assert.equal(v.node, 'w1')
    assert.equal(v.cpuPct, 49)
    assert.ok(v.diskFullInHours > 100)
    assert.equal(v.trend.length, 30)
    assert.equal(v.stale, false)
})
