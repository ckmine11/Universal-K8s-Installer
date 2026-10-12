// Add-ons installed the OLD way (scripts, before KubeEZ managed them with
// Helm) are taken over in place on a REAL cluster — and nothing is lost:
//   Nginx Ingress   same node ports, an Ingress keeps routing
//   Dashboard       same port, login token works
//   cert-manager    an issued Certificate survives; then one-step upgrades only
//   SeaweedFS       a bucket and its keys survive (same volume)
//   ArgoCD          an Application, the admin password and the UI port survive
//   Monitoring      replaced by kube-prometheus-stack on the same ports
// then customizing (form + advanced YAML), a broken change rolled back, uninstall.
// Run via: bash tests/e2e/e2e.sh takeover [distro]     (ONLY=ingress,argocd … for a subset)
process.env.APP_SECRET = 'e2e-only-secret-0123456789abcdef0123456789abcdef'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { fileURLToPath } from 'node:url'
process.env.KUBEEZ_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-takeover-'))
const { installAddon, appliedSettings, dxOn } = await import('./install-addon.mjs')
const { automationEngine } = await import('../../backend/src/services/automationEngine.js')
const { addonAccessService } = await import('../../backend/src/services/addonAccessService.js')

const NODE = process.env.NODE_CONTAINER
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean)
const want = (k) => !ONLY.length || ONLY.includes(k)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEGACY = path.join(HERE, 'legacy')
const AUTOMATION = path.join(HERE, '../../backend/src/automation')
const dx = dxOn(NODE)
const K = (cmd) => dx(`KUBECONFIG=/etc/kubernetes/admin.conf kubectl ${cmd}`)
const IP = dx('hostname -I').stdout.split(' ')[0]
const ssh = { execCommand: async (cmd, o) => { const r = dx(cmd); if (r.stdout) o?.onStdout?.(Buffer.from(r.stdout + '\n')); return r }, dispose() {} }
const cluster = { id: 'c-e2e', clusterName: 'takeover', masterNodes: [{ ip: IP }], workerNodes: [], addons: {} }
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function until(fn, ms, every = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every) } return null }

// the old installers, exactly as KubeEZ ran them before
async function legacy(file, args = []) {
    automationEngine.connectSSH = async () => ssh
    const lines = []
    try { await automationEngine.executeScript(ssh, path.join(LEGACY, file), args, (l, m) => lines.push(m), { timeoutMs: 30 * 60e3 }); return null }
    catch (e) { console.log(lines.slice(-12).join('\n')); return e.message.slice(-300) }
}
const uninstall = async (key, ns) => {
    const lines = []
    try { await automationEngine.executeScript(ssh, path.join(AUTOMATION, 'addon-uninstall.sh'), [key, '/etc/kubernetes/admin.conf', ns], (l, m) => lines.push(m), { timeoutMs: 20 * 60e3 }); return null }
    catch (e) { console.log(lines.slice(-10).join('\n')); return e.message.slice(-300) }
}
const takeover = async (key, desired) => {
    const r = await installAddon(NODE, key, desired)
    ok(r.ok, `${key}: taken over by Helm (${r.seconds}s) ${r.error || ''}`)
    if (!r.ok) console.log(r.lines.slice(-20).join('\n'))
    ok(r.lines.some(l => /Taking over|taking it over/.test(l)), `${key}: KubeEZ recognised the older install`)
    return r
}
const released = (ns, rel) => dx(`helm -n ${ns} status ${rel} -o json 2>/dev/null | grep -o '"status":"deployed"'`).stdout.includes('deployed')

// ── Nginx Ingress ───────────────────────────────────────────────────────────
if (want('ingress')) {
    console.log('== Nginx Ingress')
    ok(!(await legacy('install-addons.sh', ['ingress'])), 'old-style install')
    const ports = K(`-n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.ports[*].nodePort}'`).stdout
    K('create deployment hello --image=nginx:1.27-alpine'); K('expose deployment hello --port=80')
    dx(`cat <<'EOF' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: hello }
spec:
  ingressClassName: nginx
  rules: [{ host: hello.test, http: { paths: [{ path: /, pathType: Prefix, backend: { service: { name: hello, port: { number: 80 } } } }] } }]
EOF`)
    const httpPort = ports.split(' ')[0]
    const routes = () => /Welcome to nginx/.test(dx(`curl -s -m 5 -H 'Host: hello.test' http://${IP}:${httpPort}/`).stdout)
    ok(!!(await until(routes, 180e3)), `before: the Ingress routes on node port ${httpPort}`)
    await takeover('ingress')
    ok(released('ingress-nginx', 'ingress-nginx'), 'Helm release deployed')
    ok(K(`-n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.ports[*].nodePort}'`).stdout === ports, `same node ports (${ports})`)
    ok(appliedSettings('ingress').applied?.version === '4.11.8', `kept the release line that ran (${appliedSettings('ingress').applied?.version})`)
    ok(!!(await until(routes, 120e3)), 'after: the Ingress still routes')

    // customize: form + advanced YAML
    let r = await installAddon(NODE, 'ingress', { settings: { replicas: 2, defaultClass: true }, advanced: 'controller:\n  podLabels:\n    team: web\n', version: '4.11.8' })
    ok(r.ok, `customized (2 replicas, default class, pod label) ${r.error || ''}`)
    ok(K(`-n ingress-nginx get deploy ingress-nginx-controller -o jsonpath='{.spec.replicas}'`).stdout === '2', '2 controller replicas')
    ok(K(`get ingressclass nginx -o jsonpath='{.metadata.annotations.ingressclass\\.kubernetes\\.io/is-default-class}'`).stdout === 'true', 'nginx is the default IngressClass')
    ok(K(`-n ingress-nginx get pods -l app.kubernetes.io/component=controller -o jsonpath='{.items[0].metadata.labels.team}'`).stdout === 'web', 'advanced value applied (pod label)')
    // upgrade to the newest line (ingress-nginx may skip lines)
    r = await installAddon(NODE, 'ingress', { settings: { replicas: 1 }, version: '4.15.1' })
    ok(r.ok, `upgraded to 4.15.1 ${r.error || ''}`)
    ok(/1\.15\./.test(K(`-n ingress-nginx get deploy ingress-nginx-controller -o jsonpath='{.spec.template.spec.containers[0].image}'`).stdout), 'controller runs 1.15')
    ok(!!(await until(routes, 120e3)), 'after the upgrade: still routes')
    K('delete ingress hello'); K('delete svc hello'); K('delete deploy hello')
}

// ── Kubernetes Dashboard (KubeEZ chart) ─────────────────────────────────────
if (want('dashboard')) {
    console.log('== Kubernetes Dashboard')
    ok(!(await legacy('install-addons.sh', ['dashboard'])), 'old-style install')
    await until(() => K('-n kubernetes-dashboard rollout status deploy/kubernetes-dashboard --timeout=5s').code === 0, 240e3)
    const podBefore = K(`-n kubernetes-dashboard get pods -l k8s-app=kubernetes-dashboard -o jsonpath='{.items[0].metadata.name}'`).stdout
    await takeover('dashboard')
    ok(released('kubernetes-dashboard', 'kubernetes-dashboard'), 'Helm release deployed')
    ok(K(`-n kubernetes-dashboard get svc kubernetes-dashboard -o jsonpath='{.spec.ports[0].nodePort}'`).stdout === '30643', 'same port 30643')
    const podAfter = K(`-n kubernetes-dashboard get pods -l k8s-app=kubernetes-dashboard -o jsonpath='{.items[0].metadata.name}'`).stdout
    ok(podAfter === podBefore, `same pod — nothing restarted (${podAfter})`)
    automationEngine.connectSSH = async () => ssh
    const dash = (await addonAccessService.getAccessInfo(cluster)).addons.find(a => a.key === 'dashboard')
    ok((dash?.auth?.token || '').length > 100, 'login token issued')
    ok(/200|30\d/.test(dx(`curl -sk -o /dev/null -w '%{http_code}' https://${IP}:30643/`).stdout), 'dashboard answers on https :30643')
    const r = await installAddon(NODE, 'dashboard', { settings: { sessionMinutes: 120, adminAccount: false } })
    ok(r.ok && K('-n kubernetes-dashboard get sa dashboard-admin').code !== 0, 'customized: admin login removed')
    ok(/--token-ttl=7200/.test(K(`-n kubernetes-dashboard get deploy kubernetes-dashboard -o jsonpath='{.spec.template.spec.containers[0].args}'`).stdout), 'customized: session length')
}

// ── cert-manager: takeover + one release line at a time ─────────────────────
if (want('cert-manager')) {
    console.log('== cert-manager')
    ok(!(await legacy('cert-manager.sh')), 'old-style install (v1.16)')
    dx(`cat <<'EOF' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata: { name: demo }
spec: { secretName: demo-tls, dnsNames: [demo.test], issuerRef: { name: selfsigned-issuer, kind: ClusterIssuer } }
EOF`)
    ok(!!(await until(() => K(`get certificate demo -o jsonpath='{.status.conditions[0].status}'`).stdout === 'True', 120e3)), 'before: a certificate is issued')
    const certUid = K(`get secret demo-tls -o jsonpath='{.metadata.uid}'`).stdout
    await takeover('cert-manager')
    ok(released('cert-manager', 'cert-manager'), 'Helm release deployed')
    ok(appliedSettings('cert-manager').applied?.version === 'v1.16.5', 'kept the v1.16 line')
    ok(K('get certificate demo -o name').code === 0 && K(`get secret demo-tls -o jsonpath='{.metadata.uid}'`).stdout === certUid, 'certificate and its secret untouched')
    // a jump is refused before anything changes
    let r = await installAddon(NODE, 'cert-manager', { version: 'v1.21.2' })
    ok(!r.ok && /VERSION_STEP|one release line at a time/.test(r.error + r.lines.join('\n')), 'jump 1.16 → 1.21 refused with the reason')
    ok(/v1\.16\./.test(K(`-n cert-manager get deploy cert-manager -o jsonpath='{.spec.template.spec.containers[0].image}'`).stdout), 'still 1.16 after the refusal')
    r = await installAddon(NODE, 'cert-manager', { version: 'v1.17.4', settings: { letsEncryptEmail: 'ops@example.com' } })
    ok(r.ok, `next step 1.17 applied ${r.error || ''}`)
    ok(K('get clusterissuer letsencrypt-prod -o name').code === 0, 'Let\'s Encrypt issuers created from the form')
    K('delete certificate demo'); K('delete secret demo-tls')
}

// ── SeaweedFS (KubeEZ chart): bucket + keys kept ─────────────────────────────
if (want('seaweedfs')) {
    console.log('== S3 Object Storage (SeaweedFS)')
    ok(!(await legacy('seaweedfs.sh')), 'old-style install')
    K(`-n seaweedfs exec deploy/seaweedfs -c seaweedfs -- sh -c 'echo "s3.bucket.create -name takeover-proof" | weed shell'`)
    const key = K(`-n seaweedfs get secret seaweedfs-s3 -o jsonpath='{.data.secretKey}'`).stdout
    const vol = K(`-n seaweedfs get deploy seaweedfs -o jsonpath='{.spec.template.spec.volumes[0]}'`).stdout
    await takeover('seaweedfs')
    ok(released('seaweedfs', 'seaweedfs'), 'Helm release deployed')
    ok(K(`-n seaweedfs get deploy seaweedfs -o jsonpath='{.spec.template.spec.volumes[0]}'`).stdout === vol, `same data volume (${vol.slice(0, 80)})`)
    ok(K(`-n seaweedfs get secret seaweedfs-s3 -o jsonpath='{.data.secretKey}'`).stdout === key, 'same S3 keys')
    await until(() => K('-n seaweedfs rollout status deploy/seaweedfs --timeout=5s').code === 0, 240e3)
    ok(/takeover-proof/.test(K(`-n seaweedfs exec deploy/seaweedfs -c seaweedfs -- sh -c 'echo "s3.bucket.list" | weed shell'`).stdout), 'the bucket is still there')
}

// ── ArgoCD: Application, admin password, port ────────────────────────────────
if (want('argocd')) {
    console.log('== ArgoCD')
    ok(!(await legacy('argocd.sh')), 'old-style install (v2.13)')
    dx(`cat <<'EOF' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: guestbook, namespace: argocd }
spec:
  project: default
  source: { repoURL: 'https://github.com/argoproj/argocd-example-apps.git', targetRevision: HEAD, path: guestbook }
  destination: { server: 'https://kubernetes.default.svc', namespace: guestbook }
EOF`)
    const adminHash = K(`-n argocd get secret argocd-secret -o jsonpath='{.data.admin\\.password}'`).stdout
    await takeover('argocd')
    ok(released('argocd', 'argocd'), 'Helm release deployed')
    ok(appliedSettings('argocd').applied?.version === '7.7.23', 'kept the v2.13 line')
    ok(K('-n argocd get application guestbook -o name').code === 0, 'the Application is still there')
    ok(K(`-n argocd get secret argocd-secret -o jsonpath='{.data.admin\\.password}'`).stdout === adminHash, 'same admin password')
    ok(K(`-n argocd get svc argocd-server -o jsonpath='{.spec.ports[?(@.name=="https")].nodePort}'`).stdout === '30443', 'UI still on :30443')
    ok(/200|30\d/.test(dx(`curl -sk -o /dev/null -w '%{http_code}' https://${IP}:30443/`).stdout), 'UI answers')
}

// ── Monitoring: replaced by kube-prometheus-stack on the same ports ──────────
if (want('monitoring')) {
    console.log('== Prometheus + Grafana')
    ok(!(await legacy('install-addons.sh', ['monitoring'])), 'old-style install')
    dx(`cat <<'EOF' | KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -
apiVersion: v1
kind: Namespace
metadata: { name: shop }
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata: { name: shop-api, namespace: shop }
spec: { selector: { matchLabels: { app: api } }, endpoints: [{ port: http }] }
EOF`)
    await takeover('monitoring')
    ok(released('monitoring', 'monitoring'), 'Helm release deployed')
    ok(K('-n monitoring get deploy prometheus-operator').code !== 0, 'the previous operator is gone')
    ok(K('-n shop get servicemonitor shop-api -o name').code === 0, 'your ServiceMonitor survived')
    const pw = Buffer.from(K(`-n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}'`).stdout, 'base64').toString()
    ok(pw.length >= 12, 'Grafana got its own password')
    ok(!!(await until(() => dx(`curl -s -m 5 -u admin:'${pw}' http://${IP}:30000/api/health`).stdout.includes('ok'), 180e3)), 'Grafana answers on :30000 with that password')
    ok(!!(await until(() => /"status":"success"/.test(dx(`curl -s -m 5 'http://${IP}:30090/api/v1/query?query=up'`).stdout), 180e3)), 'Prometheus answers queries on :30090')
    const ds = dx(`curl -s -m 5 -u admin:'${pw}' http://${IP}:30000/api/search?query=KubeEZ`).stdout
    ok(/kubeez-overview/.test(ds), 'the KubeEZ dashboard is in Grafana')
    K('delete ns shop --wait=false')
}

// ── A broken change is rolled back; the running settings stay ────────────────
if (want('ingress')) {
    console.log('== rollback')
    const r = await installAddon(NODE, 'ingress', { settings: { replicas: 1 }, version: '4.15.1', advanced: 'controller:\n  image:\n    digest: ""\n    tag: v0.0.0-missing\n' })
    ok(!r.ok && /put back|rolled back|INSTALL_FAILED/i.test(r.error + r.lines.join('\n')), `broken image refused and rolled back (${r.seconds}s)`)
    ok(/1\.15\./.test(K(`-n ingress-nginx get deploy ingress-nginx-controller -o jsonpath='{.spec.template.spec.containers[0].image}'`).stdout), 'the working image runs again')
    ok(appliedSettings('ingress').history[0]?.ok === false && appliedSettings('ingress').applied?.version === '4.15.1', 'history records the failure; the working settings stay')
}

// ── Uninstall all: nothing blocks the API afterwards ─────────────────────────
console.log('== uninstall')
for (const [key, ns] of [['ingress', 'ingress-nginx'], ['dashboard', 'kubernetes-dashboard'], ['cert-manager', 'cert-manager'], ['seaweedfs', 'seaweedfs'], ['argocd', 'argocd'], ['monitoring', 'monitoring']]) {
    if (!want(key)) continue
    const err = await uninstall(key, ns)
    ok(!err && K(`get ns ${ns}`).code !== 0, `${key} uninstalled ${err || ''}`)
}
const hooks = K('get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name').stdout
ok(!/ingress-nginx|cert-manager|kubeez-admission|kyverno|metallb/.test(hooks), `no webhook left behind ${hooks.replace(/\n/g, ' ')}`)
K('delete cm kz-probe --ignore-not-found')
ok(K('create configmap kz-probe --from-literal=a=b').code === 0, 'the API accepts writes')

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll takeover checks passed')
process.exit(fails ? 1 : 0)
