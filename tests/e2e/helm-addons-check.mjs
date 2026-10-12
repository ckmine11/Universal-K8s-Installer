// Helm add-ons on a REAL cluster, through KubeEZ's own path (plan files →
// helm-addon.sh → settings history), then uninstall leaves nothing behind.
//   Metrics Server  kubectl top answers
//   MetalLB         a LoadBalancer Service gets an IP that answers from ANOTHER
//                   machine on the network (ARP); a change of range applies; a
//                   broken change is rolled back by Helm and KubeEZ keeps the old settings
//   Loki            a pod's log line can be found in Loki
//   Sealed Secrets  kubeseal seals, the controller opens it into a real Secret
//   Kyverno         Audit lets a "latest" image through, Enforce blocks it,
//                   system namespaces untouched; after uninstall nothing blocks
// Run via: bash tests/e2e/e2e.sh helm-addons [distro]
process.env.APP_SECRET = 'e2e-only-secret-0123456789abcdef0123456789abcdef'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-helm-'))
process.env.KUBEEZ_DATA_DIR = DATA

const NODE = process.env.NODE_CONTAINER
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean)
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const dx = (cmd) => { const r = spawnSync('docker', ['exec', NODE, 'bash', '-c', cmd], { encoding: 'utf8', env, maxBuffer: 256 << 20 }); return { code: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' } }
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nodeIp = dx('hostname -I').stdout.split(' ')[0]

const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { addonSettingsStore } = await import('../../backend/src/services/addonSettings.js')
const { HELM_ADDONS } = await import('../../backend/src/config/helmAddons.js')
// like real SSH: the script's output lines also reach the job log
automationEngine.connectSSH = async () => ({ execCommand: async (cmd, o) => { const r = dx(cmd); if (r.stdout) o?.onStdout?.(Buffer.from(r.stdout + '\n')); return r }, dispose() {} })
const ssh = await automationEngine.connectSSH()
const AUTOMATION = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src/automation')

let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const quietLog = (lines) => (level, msg) => { lines.push(msg); if (level === 'error' || /KUBEEZ_FAIL|✓ .* ready|Installing|Changing|⚠/.test(msg)) console.log(`   ${String(msg).slice(0, 220)}`) }
let jobN = 0
async function install(key, settings, { advanced = '', version, addons = {} } = {}) {
    const lines = []
    const inst = { id: `job-${++jobN}`, originalClusterId: 'c-e2e', masterNodes: [{ ip: nodeIp }], workerNodes: [], addons: { [key]: true }, clusterAddons: addons,
        addonSettings: { [key]: { settings, advanced, version } }, requestedBy: 'e2e' }
    const t = Date.now()
    try { await automationEngine.installHelmAddon(ssh, inst, key, quietLog(lines), { timeoutMs: 30 * 60e3 }); return { ok: true, lines, s: Math.round((Date.now() - t) / 1000) } }
    catch (e) { return { ok: false, error: e.message, lines, s: Math.round((Date.now() - t) / 1000) } }
}
async function uninstall(key) {
    const lines = []
    try { await automationEngine.executeScript(ssh, path.join(AUTOMATION, 'addon-uninstall.sh'), [key, '/etc/kubernetes/admin.conf', HELM_ADDONS[key].ns], quietLog(lines), { timeoutMs: 15 * 60e3 }); return { ok: true, lines } }
    catch (e) { return { ok: false, error: e.message, lines } }
}
const want = (k) => !ONLY.length || ONLY.includes(k)
async function until(fn, ms, every = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every) } return null }

// ── Metrics Server ──
if (want('metrics-server')) {
    console.log('== Metrics Server')
    const r = await install('metrics-server', { replicas: 1 })
    ok(r.ok, `installed (${r.s}s) ${r.error || ''}`)
    const top = await until(() => { const t = K('top nodes --no-headers'); return t.code === 0 && /\d+m/.test(t.stdout) ? t.stdout : null }, 180e3)
    ok(!!top, `kubectl top nodes answers: ${(top || '').split('\n')[0]}`)
    ok(addonSettingsStore.get('c-e2e', 'metrics-server').applied?.version === HELM_ADDONS['metrics-server'].versions[0].id, 'KubeEZ records the applied version')
    const u = await uninstall('metrics-server')
    ok(u.ok, `uninstalled ${u.error || ''}`)
    ok(K('get apiservice v1beta1.metrics.k8s.io').code !== 0, 'metrics API registration removed (API discovery stays healthy)')
    ok(K('api-resources').code === 0, 'kubectl api-resources works after uninstall')
}

// ── MetalLB ──
if (want('metallb')) {
    console.log('== MetalLB')
    const base = nodeIp.split('.').slice(0, 3).join('.')
    const range1 = `${base}.200-${base}.203`, range2 = `${base}.210-${base}.213`
    let r = await install('metallb', { addresses: range1, mode: 'l2', ingressLoadBalancer: true })
    ok(r.ok, `installed in L2 mode with ${range1} (${r.s}s) ${r.error || ''}`)
    K('create deployment web --image=nginx:1.27-alpine')
    K('expose deployment web --type=LoadBalancer --port=80')
    const ip = await until(() => K(`get svc web -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`).stdout || null, 120e3)
    ok(ip && ip.startsWith(`${base}.20`), `LoadBalancer Service got ${ip}`)
    await until(() => K('rollout status deploy/web --timeout=5s').code === 0, 180e3)
    // another machine on the same network: proves the ARP announcement, not just kube-proxy
    const peer = await until(() => {
        const c = spawnSync('docker', ['run', '--rm', 'curlimages/curl:8.10.1', '-s', '-m', '5', `http://${ip}/`], { encoding: 'utf8', env })
        return /Welcome to nginx/.test(c.stdout || '') ? true : null
    }, 90e3, 5000)
    ok(!!peer, `http://${ip} answers from another container on the network (L2 announcement)`)

    // change of range
    K('delete svc web')
    r = await install('metallb', { addresses: range2, mode: 'l2' })
    ok(r.ok, `changed the range to ${range2} ${r.error || ''}`)
    ok(/210-.*213/.test(K(`-n metallb-system get ipaddresspools.metallb.io kubeez-pool -o jsonpath='{.spec.addresses}'`).stdout), 'pool updated')
    K('expose deployment web --type=LoadBalancer --port=80')
    const ip2 = await until(() => K(`get svc web -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`).stdout || null, 120e3)
    ok(ip2 && ip2.startsWith(`${base}.21`), `new Services get IPs from the new range (${ip2})`)

    // a broken change: Helm rolls back, KubeEZ keeps the settings that work
    r = await install('metallb', { addresses: range2, mode: 'l2' }, { advanced: 'controller:\n  image:\n    tag: v0.0.0-does-not-exist\n' })
    ok(!r.ok && /rolled|put back|INSTALL_FAILED/i.test(r.error + r.lines.join('\n')), `a broken change fails and is rolled back (${r.s}s)`)
    const img = K(`-n metallb-system get deploy metallb-controller -o jsonpath='{.spec.template.spec.containers[0].image}'`).stdout
    ok(!/does-not-exist/.test(img), `the controller runs the working image again (${img})`)
    const rec = addonSettingsStore.get('c-e2e', 'metallb')
    ok(rec.applied?.settings?.addresses === range2 && rec.history[0].ok === false, 'KubeEZ keeps the working settings and records the failure')
    // an address that answers on the network is refused before anything changes
    r = await install('metallb', { addresses: `${nodeIp.replace(/\.\d+$/, '.1')}` })
    ok(!r.ok && /IP_IN_USE|already answer/.test(r.error + r.lines.join('\n')), 'an address in use (the gateway) is refused by the check')

    K('delete svc web'); K('delete deploy web')
    const u = await uninstall('metallb')
    ok(u.ok, `uninstalled ${u.error || ''}`)
    ok(K('get crd ipaddresspools.metallb.io').code !== 0 && K('get validatingwebhookconfiguration metallb-webhook-configuration').code !== 0, 'CRDs and webhook removed')
}

// ── Loki ──
if (want('loki')) {
    console.log('== Loki + Fluent Bit')
    const r = await install('loki', { retentionDays: 2, sizeGi: 2, storage: 'node' })
    ok(r.ok, `installed (${r.s}s) ${r.error || ''}`)
    const marker = `kubeez-e2e-marker-${Date.now()}`
    K(`run logger --image=busybox:1.36 --restart=Never -- sh -c 'for i in $(seq 1 60); do echo ${marker}; sleep 2; done'`)
    const lokiIp = K(`-n logging get svc loki -o jsonpath='{.spec.clusterIP}'`).stdout
    const labels = await until(() => { const l = dx(`curl -s -m 5 http://${lokiIp}:3100/loki/api/v1/labels`).stdout; return /namespace/.test(l) ? l : null }, 240e3)
    ok(!!labels, `Loki has labels from Fluent Bit: ${labels}`)
    const nsLabel = (JSON.parse(labels || '{"data":[]}').data || []).find(l => /namespace/.test(l)) || 'namespace_name'
    const q = encodeURIComponent(`{${nsLabel}="default"} |= "${marker}"`)
    const found = await until(() => { const o = dx(`curl -s -m 10 'http://${lokiIp}:3100/loki/api/v1/query_range?query=${q}&limit=5'`).stdout; return o.includes(marker) ? o : null }, 240e3)
    ok(!!found, `the pod's log line is found in Loki (query by ${nsLabel})`)
    console.log(`   label used for namespaces: ${nsLabel}`)
    K('delete pod logger --now')
    const u = await uninstall('loki')
    ok(u.ok && K('get ns logging').code !== 0, `uninstalled ${u.error || ''}`)
}

// ── Sealed Secrets ──
if (want('sealed-secrets')) {
    console.log('== Sealed Secrets')
    const r = await install('sealed-secrets', { keyRenewDays: 30 })
    ok(r.ok, `installed (${r.s}s) ${r.error || ''}`)
    ok(dx('/usr/local/bin/kubeseal --version').code === 0, 'kubeseal installed on the control-plane')
    const secret = Buffer.from(JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db', namespace: 'default' }, type: 'Opaque', data: { password: Buffer.from('s3cret-e2e').toString('base64') } })).toString('base64')
    // the same command as POST /addons/sealed-secrets/seal
    const sealed = await until(() => { const o = dx(`echo ${secret} | base64 -d | /usr/local/bin/kubeseal --kubeconfig /etc/kubernetes/admin.conf --controller-namespace sealed-secrets --controller-name sealed-secrets-controller --scope strict --format yaml`); return /kind: SealedSecret/.test(o.stdout) ? o.stdout : null }, 120e3)
    ok(!!sealed && !sealed.includes('s3cret-e2e'), 'sealed (the value is not readable in the result)')
    fs.writeFileSync(path.join(DATA, 'sealed.yaml'), sealed || '')
    spawnSync('docker', ['cp', path.join(DATA, 'sealed.yaml'), `${NODE}:/tmp/sealed.yaml`], { env })
    K('apply -f /tmp/sealed.yaml')
    const val = await until(() => { const v = K(`get secret db -o jsonpath='{.data.password}'`).stdout; return v ? Buffer.from(v, 'base64').toString() : null }, 90e3)
    ok(val === 's3cret-e2e', 'the controller opened it into a real Secret with the right value')
    K('delete sealedsecret db'); K('delete secret db')
    const u = await uninstall('sealed-secrets')
    ok(u.ok && K('get crd sealedsecrets.bitnami.com').code !== 0, `uninstalled, CRD removed ${u.error || ''}`)
}

// ── Kyverno ──
if (want('kyverno')) {
    console.log('== Kyverno')
    let r = await install('kyverno', { mode: 'Audit' })
    ok(r.ok, `installed in Audit mode (${r.s}s) ${r.error || ''}`)
    const pols = K('get validatingpolicies.policies.kyverno.io -o name').stdout.split('\n').filter(Boolean)
    ok(pols.length === 4, `4 KubeEZ policies created: ${pols.join(', ')}`)
    const ready = await until(() => { const o = K('get validatingpolicies.policies.kyverno.io --no-headers -o custom-columns=R:.status.conditionStatus.ready').stdout.split('\n').filter(Boolean); return o.length === 4 && o.every(x => x.trim() === 'true') ? o.join(' ') : null }, 180e3)
    ok(!!ready, `policies compiled and ready (${ready})`)
    let p = K('run audit-latest --image=nginx:latest --restart=Never')
    ok(p.code === 0, 'Audit: a "latest" image is allowed (only reported)')
    K('delete pod audit-latest --now')

    r = await install('kyverno', { mode: 'Enforce' })
    ok(r.ok, `switched to Enforce ${r.error || ''}`)
    const blocked = await until(() => { const o = K('run enforce-latest --image=nginx:latest --restart=Never'); if (o.code === 0) { K('delete pod enforce-latest --now'); return null } return o.stderr || o.stdout }, 90e3)
    ok(!!blocked && /latest|tag/i.test(blocked), `Enforce: a "latest" image is blocked — ${(blocked || '').split('\n')[0].slice(0, 160)}`)
    // a pod with requests/limits but a "latest" image: only the tag rule applies
    const res = '"resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"memory":"64Mi"}}'
    p = K(`run tag-only --image=nginx:latest --restart=Never --overrides='{"spec":{"containers":[{"name":"tag-only","image":"nginx:latest",${res}}]}}'`)
    ok(p.code !== 0 && /kubeez-disallow-latest-tag/.test(p.stderr + p.stdout), `Enforce: the "latest" rule blocks on its own — ${(p.stderr || p.stdout).split('\n')[0].slice(0, 140)}`)
    if (p.code === 0) K('delete pod tag-only --now')
    p = K('run fine --image=nginx:1.27-alpine --restart=Never --overrides=\'{"spec":{"containers":[{"name":"fine","image":"nginx:1.27-alpine","resources":{"requests":{"cpu":"10m","memory":"16Mi"},"limits":{"memory":"64Mi"}}}]}}\'')
    ok(p.code === 0, `Enforce: a pod that follows the rules is allowed ${p.code ? p.stderr.slice(0, 160) : ''}`)
    p = K('-n kube-system run sys-latest --image=nginx:latest --restart=Never')
    ok(p.code === 0, 'system namespaces are never blocked')
    K('-n kube-system delete pod sys-latest --now'); K('delete pod fine --now')

    const u = await uninstall('kyverno')
    ok(u.ok, `uninstalled ${u.error || ''}`)
    const hooks = K('get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name').stdout
    ok(!/kyverno/.test(hooks), 'no Kyverno webhook left behind')
    p = K('run after-latest --image=nginx:latest --restart=Never')
    ok(p.code === 0, 'after uninstall nothing blocks pods')
    K('delete pod after-latest --now')
}

// ── Fresh installs of the original add-ons (Helm, defaults = one click) ─────
const { addonAccessService } = await import('../../backend/src/services/addonAccessService.js')
const accessOf = async (key) => (await addonAccessService.getAccessInfo({ id: 'c-e2e', masterNodes: [{ ip: nodeIp }] })).addons.find(a => a.key === key)

if (want('argocd')) {
    console.log('== ArgoCD (fresh, defaults)')
    const r = await install('argocd', {})
    ok(r.ok, `installed (${r.s}s) ${r.error || ''}`)
    ok(K(`-n argocd get svc argocd-server -o jsonpath='{.spec.ports[?(@.name=="https")].nodePort}'`).stdout === '30443', 'UI on :30443')
    ok(!!(await until(() => /200|30\d/.test(dx(`curl -sk -o /dev/null -w '%{http_code}' https://${nodeIp}:30443/`).stdout), 120e3)), 'UI answers')
    const a = await accessOf('argocd')
    ok((a?.auth?.password || '').length >= 8 && !/not found/i.test(a.auth.password), 'admin password shown in Access & logins')
    const u = await uninstall('argocd')
    const gone = await until(() => K('get ns argocd').code !== 0 && !K('get crd -o name').stdout.includes('argoproj.io'), 90e3)
    ok(u.ok && !!gone, `uninstalled, CRDs removed ${u.error || ''} ${gone ? '' : K('get crd -o name').stdout.split('\n').filter(l => /argoproj/.test(l)).join(' ')}`)
}

if (want('monitoring')) {
    console.log('== Prometheus + Grafana (fresh, defaults)')
    const r = await install('monitoring', {})
    ok(r.ok, `installed (${r.s}s) ${r.error || ''}`)
    const a = await accessOf('grafana')
    const pw = a?.auth?.password
    ok(pw && pw !== 'admin', 'Grafana has a generated password, shown in Access & logins')
    ok(!!(await until(() => dx(`curl -s -m 5 -u admin:'${pw}' http://${nodeIp}:30000/api/health`).stdout.includes('ok'), 180e3)), 'Grafana answers on :30000 with it')
    ok(!!(await until(() => /"status":"success"/.test(dx(`curl -s -m 5 'http://${nodeIp}:30090/api/v1/query?query=up'`).stdout), 180e3)), 'Prometheus answers on :30090')
    ok(!!(await until(() => /kubeez-overview/.test(dx(`curl -s -m 5 -u admin:'${pw}' 'http://${nodeIp}:30000/api/search?query=KubeEZ'`).stdout), 120e3)), 'KubeEZ dashboard in Grafana')
    const u = await uninstall('monitoring')
    ok(u.ok && K('get ns monitoring').code !== 0, `uninstalled ${u.error || ''}`)
}

if (want('longhorn')) {
    console.log('== Longhorn (fresh, defaults)')
    const r = await install('longhorn', {})
    ok(r.ok, `installed (${r.s}s) ${r.error || ''}`)
    ok(K(`get storageclass longhorn -o jsonpath='{.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class}'`).stdout === 'true', 'longhorn is the default StorageClass')
    dx(`cat <<'EOF' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: lh-test }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }
---
apiVersion: v1
kind: Pod
metadata: { name: lh-writer }
spec:
  containers: [{ name: w, image: busybox:1.36, command: [sh, -c, 'echo kubeez > /data/f && sleep 3600'], volumeMounts: [{ name: d, mountPath: /data }] }]
  volumes: [{ name: d, persistentVolumeClaim: { claimName: lh-test } }]
EOF`)
    const wrote = await until(() => K('exec lh-writer -- cat /data/f').stdout === 'kubeez', 300e3, 10000)
    ok(!!wrote, 'a pod writes to a Longhorn volume')
    if (!wrote) console.log(K('describe pod lh-writer').stdout.split('\n').slice(-8).join('\n'))
    K('delete pod lh-writer --now'); K('delete pvc lh-test --wait=true')
    await until(() => !K(`get pv -o jsonpath='{.items[*].spec.csi.driver}'`).stdout.includes('longhorn'), 120e3)
    const u = await uninstall('longhorn')
    ok(u.ok && K('get ns longhorn-system').code !== 0, `uninstalled ${u.error || ''}`)
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll Helm add-on checks passed')
fs.rmSync(DATA, { recursive: true, force: true })
process.exit(fails ? 1 : 0)
