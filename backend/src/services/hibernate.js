// Hibernate: a namespace's Deployments and StatefulSets go to 0 replicas (dev
// and test environments at night, a project on pause) and come back as they
// were. Each workload remembers its replicas in the annotation
// kubeez.io/hibernated-replicas, so Wake needs nothing from KubeEZ's own data.
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
export const ANNOTATION = 'kubeez.io/hibernated-replicas'
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
const NS = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const bad = (m, status = 400) => Object.assign(new Error(m), { status })
const T = '{"\\t"}', N = '{"\\n"}'
const LIST = (scope) => `${KUBECTL} get deployments,statefulsets ${scope} -o jsonpath='{range .items[*]}{.metadata.namespace}${T}{.kind}${T}{.metadata.name}${T}{.spec.replicas}${T}{.metadata.annotations.kubeez\\.io/hibernated-replicas}${N}{end}' --request-timeout=40s`

/** kubectl's lines → [{ namespace, kind, name, replicas, saved }] */
export function parseWorkloads(out) {
    return String(out || '').split('\n').filter(Boolean).map(l => l.split('\t')).filter(f => f.length >= 4 && NAME.test(f[2]) && NS.test(f[0]) && ['Deployment', 'StatefulSet'].includes(f[1]))
        .map(([namespace, kind, name, replicas, saved]) => ({ namespace, kind, name, replicas: Number(replicas) || 0, saved: saved !== undefined && saved !== '' && /^\d+$/.test(saved) ? Number(saved) : null }))
}

async function run(connect, cluster, cmd) {
    const ssh = await connect(cluster)
    try { return await ssh.execCommand(cmd, { timeoutMs: 120e3 }) } finally { ssh.dispose?.() }
}
const must = (r, what) => { if (r?.code) throw bad(`${what}: ${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`, 502); return r }

/** Namespaces that are hibernated now → [{ namespace, workloads }] */
export async function hibernated(cluster, { connect = defaultConnect } = {}) {
    const list = parseWorkloads(must(await run(connect, cluster, LIST('-A')), 'Could not read the workloads').stdout).filter(w => w.saved != null)
    const by = new Map()
    for (const w of list) by.set(w.namespace, [...(by.get(w.namespace) || []), w])
    return [...by].map(([namespace, workloads]) => ({ namespace, workloads: workloads.length, replicas: workloads.reduce((n, w) => n + w.saved, 0) }))
}

/** Scale every running Deployment / StatefulSet of the namespace to 0, remembering its replicas. */
export async function hibernate(cluster, namespace, { connect = defaultConnect } = {}) {
    if (!NS.test(String(namespace))) throw bad('Not a valid namespace')
    const list = parseWorkloads(must(await run(connect, cluster, LIST(`-n ${q(namespace)}`)), 'Could not read the workloads').stdout).filter(w => w.namespace === namespace)   // never another namespace
    const todo = list.filter(w => w.replicas > 0)
    if (!todo.length) return { changed: [], message: `Nothing runs in ${namespace} — nothing to hibernate.` }
    // annotate first: if scaling breaks off, Wake still knows the replicas
    const cmd = todo.map(w => `${KUBECTL} -n ${q(namespace)} annotate ${w.kind.toLowerCase()}/${q(w.name)} ${ANNOTATION}=${w.replicas} --overwrite && ${KUBECTL} -n ${q(namespace)} scale ${w.kind.toLowerCase()}/${q(w.name)} --replicas=0`).join(' && ')
    must(await run(connect, cluster, cmd), 'Hibernate stopped')
    return { changed: todo.map(w => `${w.kind}/${w.name} ${w.replicas}→0`), message: `${todo.length} workload${todo.length === 1 ? '' : 's'} in ${namespace} scaled to 0. Wake brings them back.` }
}

/** Bring a hibernated namespace back to the replicas it had. */
export async function wake(cluster, namespace, { connect = defaultConnect } = {}) {
    if (!NS.test(String(namespace))) throw bad('Not a valid namespace')
    const list = parseWorkloads(must(await run(connect, cluster, LIST(`-n ${q(namespace)}`)), 'Could not read the workloads').stdout).filter(w => w.namespace === namespace)   // never another namespace
    const todo = list.filter(w => w.saved != null)
    if (!todo.length) return { changed: [], message: `${namespace} is not hibernated.` }
    const cmd = todo.map(w => `${KUBECTL} -n ${q(namespace)} scale ${w.kind.toLowerCase()}/${q(w.name)} --replicas=${w.saved} && ${KUBECTL} -n ${q(namespace)} annotate ${w.kind.toLowerCase()}/${q(w.name)} ${ANNOTATION}-`).join(' && ')
    must(await run(connect, cluster, cmd), 'Wake stopped')
    return { changed: todo.map(w => `${w.kind}/${w.name} 0→${w.saved}`), message: `${todo.length} workload${todo.length === 1 ? '' : 's'} in ${namespace} back to their replicas.` }
}

// ── debug containers ──
// An ephemeral container in a running pod (kubectl debug): the tools the app
// image lacks (shell, curl, dig, tcpdump), sharing its process namespace.
// It ends by itself after an hour; Kubernetes never restarts it.
export const DEBUG_IMAGES = { busybox: 'busybox:1.37', netshoot: 'nicolaka/netshoot:v0.14' }
export async function addDebugContainer(cluster, { namespace, pod, target, image = 'busybox' }, { connect = defaultConnect } = {}) {
    if (!NS.test(String(namespace)) || !NAME.test(String(pod))) throw bad('Not a valid pod')
    if (target != null && target !== '' && !NAME.test(String(target))) throw bad('Not a valid container')
    const img = DEBUG_IMAGES[image]
    if (!img) throw bad(`Image: ${Object.keys(DEBUG_IMAGES).join(' or ')}`)
    const name = `kubeez-debug-${Math.random().toString(36).slice(2, 7)}`
    const r = await run(connect, cluster, `${KUBECTL} debug -n ${q(namespace)} ${q(pod)} --image=${q(img)} -c ${name}${target ? ` --target=${q(target)}` : ''} --profile=general -- sleep 3600`)
    must(r, 'The debug container was not added')
    return { container: name, image: img, command: `kubectl exec -it -n ${namespace} ${pod} -c ${name} -- sh`, message: `Debug container ${name} (${img}) added to ${namespace}/${pod} — it ends by itself after an hour.` }
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}
export const _test = { useConnect(fn) { testConnect = fn } }
