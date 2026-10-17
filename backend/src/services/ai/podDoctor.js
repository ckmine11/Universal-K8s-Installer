// "web-2 ka log check karo", "why is api crashing", "crash wala pod dekho",
// "fix the payments deployment": KubeEZ finds the pod (or the app's worst pod)
// in the live cluster, reads its logs (also the crashed container's), describe
// and events, and says what is wrong and how to fix it:
//   • KubeEZ's own checks first — exact, instant, no AI needed
//     (out of memory, wrong image, missing secret, not schedulable, probes…)
//   • then the AI explanation with the proof and a safe fix (the same
//     explainer as for incidents — dangerous steps are removed)
// Read-only: a suggested fix is only previewed (dry-run) from chat.
import { collectIncidentData } from './doctor.js'

const NAME = (n) => new RegExp(`(^|[^a-z0-9.-])${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9-])`)
const healthy = (p) => (p.phase === 'Running' && p.ready === p.containers) || p.phase === 'Succeeded'
const worst = (pods) => [...pods].sort((a, b) => (healthy(a) ? 1 : 0) - (healthy(b) ? 1 : 0) || b.restarts - a.restarts)
const podsOf = (snap, kind, w) => snap.pods.filter(p => p.ns === w.ns && (
    kind === 'deployment' ? p.owner === 'ReplicaSet' && p.name.startsWith(`${w.name}-`) && (!p.ownerName || p.ownerName.startsWith(`${w.name}-`))
        : p.ownerName ? p.ownerName === w.name : p.name.startsWith(`${w.name}-`)))

// asked to look into it ("check", "logs", "why", "fix", "kya hua")
export const DIAG = /\b(logs?|check|dekh\w*|diagnos\w*|debug|troubleshoot|fix|solutions?|solve|resolve|why|kyu|kyun|kyon|investigate|analy[sz]e|samjhao|theek|thik|sahi|kya hua|what happened|what'?s wrong|issues?|problems?|errors?|crash\w*|fail\w*|kharab|stuck|not working|nahi chal|down)\b|क्यों|लॉग|ठीक/
// asked to look (not just "which pods fail" — that is a list)
const LOOK = /\b(logs?|check|dekh\w*|diagnos\w*|debug|troubleshoot|fix|solutions?|solve|resolve|why|kyu|kyun|kyon|investigate|analy[sz]e|samjhao|theek|thik|sahi)\b|क्यों|लॉग|ठीक/
const HINT = { service: /\b(services?|svc)\b/, pvc: /\b(pvcs?|volumes?|storage)\b/, ingress: /\b(ingress(es)?)\b/, cronjob: /\b(cron ?jobs?)\b/, deployment: /\b(deployments?|deploy)\b/, statefulset: /\b(statefulsets?|sts)\b/, daemonset: /\b(daemonsets?|ds)\b/ }
const UNHEALTHY =/\b(crash\w*|fail\w*|kharab|broken|error\w*|not (running|ready|working)|pending|stuck|restart\w*|problem|issue|down|band)\b/

/**
 * The object a question names, from the live snapshot.
 * → { kind: 'pod'|'deployment'|'statefulset'|'daemonset'|'service'|'pvc'|'ingress'|'cronjob', ns, name, pod?, pods? } | null
 */
export function targetOf(text, snap) {
    const t = ` ${String(text || '').toLowerCase()} `
    const nsNamed = snap.namespaces.map(n => n.name).find(n => NAME(n).test(t))
    const inNs = (x) => !nsNamed || x.ns === nsNamed
    const pick = (arr, key = 'name') => arr.filter(x => inNs(x) && x[key].length >= 3 && NAME(x[key]).test(t)).sort((a, b) => b[key].length - a[key].length)[0]
    const other = { service: snap.services.filter(s => !(s.ns === 'default' && s.name === 'kubernetes')), pvc: snap.pvcs, ingress: snap.ingresses, cronjob: snap.cronjobs }
    // "web service ka port" — the kind named decides when an app and its service share a name
    const hinted = Object.entries(HINT).find(([, re]) => re.test(t))?.[0]
    if (hinted && other[hinted]) { const x = pick(other[hinted]); if (x) return { kind: hinted, ns: x.ns, name: x.name } }
    const workload = (kind) => { const w = pick(snap[`${kind}s`]); if (!w) return null; const pods = podsOf(snap, kind, w); return { kind, ns: w.ns, name: w.name, workload: w, pods, pod: worst(pods)[0] || null } }
    if (hinted && !other[hinted]) { const w = workload(hinted); if (w) return w }
    // an exact pod name wins ("web-7d9f-x2k")
    const pod = pick(snap.pods)
    if (pod) return { kind: 'pod', ns: pod.ns, name: pod.name, pod }
    for (const kind of ['deployment', 'statefulset', 'daemonset']) { const w = workload(kind); if (w) return w }
    for (const [kind, arr] of Object.entries(other)) { const x = pick(arr); if (x) return { kind, ns: x.ns, name: x.name } }
    // no name: "crash wala pod check karo", "failing pod ka log dekho" → the worst unhealthy pod
    if (/\b(pods?|containers?|apps?)\b/.test(t) && UNHEALTHY.test(t) && LOOK.test(t)) {
        const bad = worst(snap.pods.filter(p => !healthy(p) && inNs(p)))
        if (bad[0]) return { kind: 'pod', ns: bad[0].ns, name: bad[0].name, pod: bad[0], others: bad.slice(1, 6), guessed: true }
    }
    return null
}

/** The pod as an incident, so the incident explainer (evidence, changes, specialists, safe fixes) can be used. */
export function podIncident(cluster, pod) {
    const r = pod.reason || ''
    const reason = /OOMKilled/i.test(r) ? 'OOMKilled'
        : /ImagePull|ErrImage|InvalidImage/i.test(r) ? 'ImagePullBackOff'
            : pod.phase === 'Pending' ? 'PodPendingTooLong'
                : /CrashLoop|Error/i.test(r) ? 'CrashLoopBackOff'
                    : pod.restarts >= 3 ? 'RestartsRising'
                        : healthy(pod) ? 'PodCheck' : 'CrashLoopBackOff'
    const slot = new Date(Math.floor(Date.now() / 120e3) * 120e3).toISOString()   // one answer per 2 minutes
    return {
        id: `ask:${cluster.id}:${pod.ns}/${pod.name}`, orgId: cluster.orgId, clusterId: cluster.id, clusterName: cluster.clusterName,
        reason, severity: healthy(pod) ? 'info' : 'warning', status: 'unresolved', target: pod.name, namespace: pod.ns,
        owner: pod.owner && pod.ownerName ? `${pod.owner}/${pod.ownerName}` : null, nodeName: pod.node || null,
        message: `asked in chat — ${pod.reason || pod.phase}, ${pod.ready}/${pod.containers} containers ready, ${pod.restarts} restarts`,
        details: healthy(pod) ? 'The pod looks healthy right now; the user asked to check it (look at the logs for errors).' : null,
        timestamp: slot, lastSeen: slot, count: 1, timeline: [], evidence: []
    }
}

// ── KubeEZ's own checks: the common causes, read straight from describe / logs / events ──
const RULES = [
    { re: /OOMKilled|out of memory/i, summary: 'The container ran out of memory and was killed (OOMKilled).', cause: 'It used more memory than its limit allows.', fix: ['Raise the memory limit: `kubectl set resources deploy/<name> -n <ns> --limits=memory=512Mi` (or edit resources.limits.memory)', 'If memory keeps growing, look for a leak in the app'] },
    { re: /manifest unknown|not found: manifest|repository does not exist|pull access denied|failed to resolve reference.*not found/i, summary: 'The image cannot be pulled: that image or tag does not exist.', cause: 'Wrong image name or tag.', fix: ['Check the image name and tag (a typo, or the tag was never pushed)', 'Set the right one: `kubectl set image deploy/<name> -n <ns> <container>=<image:tag>`'] },
    { re: /unauthorized|authentication required|denied: requested access|no basic auth credentials|401 Unauthorized|403 Forbidden/i, summary: 'The image cannot be pulled: the registry refused (a private image).', cause: 'No or wrong registry credentials.', fix: ['Create a pull secret: `kubectl create secret docker-registry regcred -n <ns> --docker-server=… --docker-username=… --docker-password=…`', 'Add it to the pod spec: `imagePullSecrets: [{name: regcred}]`'] },
    { re: /(dial tcp|lookup) [^\n]*(registry|docker\.io|ghcr|quay|gcr)[^\n]*(i\/o timeout|no such host)/i, summary: 'The node cannot reach the image registry.', cause: 'Network / DNS from the node to the registry.', fix: ['From the node: `curl -sI https://registry-1.docker.io/v2/` and `nslookup registry-1.docker.io`', 'Check the node\'s DNS, proxy and firewall'] },
    { re: /(secret|configmap)s? "([^"]+)" not found/i, summary: (m) => `The pod needs ${m[1].toLowerCase()} "${m[2]}", which does not exist.`, cause: (m) => `Missing ${m[1].toLowerCase()} "${m[2]}" in this namespace.`, fix: (m) => [`Create it: \`kubectl create ${m[1].toLowerCase() === 'secret' ? 'secret generic' : 'configmap'} ${m[2]} -n <ns> --from-literal=key=value\``, 'Or fix the name in the pod spec (env / envFrom / volumes)'] },
    { re: /couldn't find key (\S+) in (Secret|ConfigMap) [\w-]+\/([\w.-]+)/i, summary: (m) => `${m[2]} "${m[3]}" has no key ${m[1]}.`, cause: 'A key the pod reads is missing.', fix: (m) => [`Add the key ${m[1]} to ${m[2].toLowerCase()} ${m[3]}, or fix the key name in the pod spec`] },
    { re: /Insufficient (cpu|memory)/i, summary: (m) => `The pod cannot be placed: no node has enough free ${m[1]}.`, cause: (m) => `Its ${m[1]} request is larger than what is free on every node.`, fix: (m) => [`Lower the ${m[1]} request in resources.requests, or free up / add a node`, 'See who uses what: AI → Advisor'] },
    { re: /untolerated taint|had taint/i, summary: 'The pod cannot be placed: the nodes have taints it does not tolerate.', cause: 'Node taints (for example the control-plane taint, or a NoSchedule taint).', fix: ['Add a matching toleration to the pod, or remove the taint: `kubectl taint nodes <node> <key>-`'] },
    { re: /didn't match Pod's node affinity|node\(s\) didn't match node selector/i, summary: 'The pod cannot be placed: no node matches its nodeSelector / affinity.', cause: 'A node label the pod asks for is not on any node.', fix: ['Fix the nodeSelector / affinity, or label a node: `kubectl label node <node> key=value`'] },
    { re: /unbound immediate PersistentVolumeClaims|pod has unbound/i, summary: 'The pod waits for its volume (PVC is not bound).', cause: 'No storage class / provisioner gives the PVC a volume.', fix: ['Check the PVC: `kubectl describe pvc -n <ns>`', 'Install a storage add-on (KubeEZ → Add-ons → NFS or Longhorn) or set a default StorageClass'] },
    { re: /(Liveness|Readiness|Startup) probe failed:?([^\n]*)/i, summary: (m) => `The ${m[1].toLowerCase()} probe fails${m[2] ? `:${m[2].slice(0, 120)}` : ''}.`, cause: 'The app does not answer the health check in time (wrong port/path, or it starts slowly).', fix: ['Check the probe port and path match the app', 'Give it more time: raise initialDelaySeconds / failureThreshold, or add a startupProbe'] },
    { re: /exec format error/i, summary: 'The image is built for another CPU type (exec format error).', cause: 'For example an arm64 image on amd64 nodes.', fix: ['Use an image built for the nodes\' architecture (multi-arch tag)'] },
    { re: /executable file not found|no such file or directory[^\n]*(exec|command|entrypoint)|OCI runtime create failed/i, summary: 'The container\'s command cannot be started.', cause: 'The command / entrypoint does not exist in the image.', fix: ['Check `command` / `args` in the pod spec against the image'] },
    { re: /permission denied/i, summary: 'The app hits "permission denied".', cause: 'A file / port the app needs is not allowed for its user (securityContext, volume ownership).', fix: ['Check runAsUser / fsGroup in securityContext, and the owner of mounted volumes', 'Ports below 1024 need root or NET_BIND_SERVICE'] },
    { re: /(connection refused|ECONNREFUSED|(?:cannot|could not|couldn.t|unable to|failed to) connect(?: to)?|connection timed out|no such host|could not translate host name|getaddrinfo|Name or service not known|i\/o timeout)[^\n]*/i, summary: (m) => `The app cannot reach something it depends on: "${m[0].trim().slice(0, 100)}".`, cause: 'A database / service it calls is down, has another name, or is blocked (NetworkPolicy).', fix: ['Check the address in the app\'s config (env / ConfigMap) and that the service exists: `kubectl get svc -A`', 'Check NetworkPolicies in the namespace'] },
    { re: /address already in use|EADDRINUSE/i, summary: 'The app\'s port is already in use.', cause: 'Two processes / containers use the same port (or hostNetwork).', fix: ['Use different ports per container, or remove hostNetwork'] }
]
const errLine = /\b(error|exception|fatal|panic|failed|traceback|cannot|refused|denied)\b/i

// describe's "Command:" / "Args:" blocks (the lines indented below them)
export function withoutCommand(text) {
    const out = []; let skip = -1
    for (const l of String(text).split('\n')) {
        const ind = l.match(/^ */)[0].length
        if (skip >= 0 && (ind > skip || !l.trim())) continue
        skip = -1
        if (/^\s*(Command|Args):\s*$/.test(l)) { skip = ind; continue }
        if (/^\s*(Command|Args):\s+\S/.test(l)) continue
        out.push(l)
    }
    return out.join('\n')
}

/** What KubeEZ itself can tell from the evidence. → { summary, cause, fix[], evidence[] } | null */
export function quickDiagnosis(data, pod) {
    // the logs first (the proof is best from there), then describe and events —
    // without the pod's own command and args, which are not something that happened
    const ordered = [...data.filter(d => /log/.test(d.label)), ...data.filter(d => !/log/.test(d.label)).map(d => ({ ...d, text: withoutCommand(d.text) }))]
    const lines = ordered.flatMap(d => d.text.split('\n'))
    for (const r of RULES) {
        const line = lines.find(l => r.re.test(l))
        if (!line) continue
        const m = r.re.exec(line)
        const v = (x) => typeof x === 'function' ? x(m) : x
        return { summary: v(r.summary), cause: v(r.cause), fix: v(r.fix), evidence: line ? [line.trim().slice(0, 300)] : [] }
    }
    const logs = data.filter(d => /log/.test(d.label)).map(d => d.text).join('\n').split('\n')
    const errs = logs.filter(l => errLine.test(l)).slice(-3)
    if (errs.length) return { summary: `The app logs errors${pod && !healthy(pod) ? ' and the container stops' : ''}.`, cause: 'See the last error lines below — the app itself fails.', fix: ['Fix what the error says (config, a dependency, a bug in the app)', 'Rollback if a new version started it: `kubectl rollout undo deploy/<name> -n <ns>`'], evidence: errs.map(l => l.trim().slice(0, 300)) }
    if (pod && healthy(pod)) return { summary: 'The pod is running and ready; the logs show no errors.', cause: '', fix: [], evidence: [] }
    return null
}

/** Fresh evidence for a pod (the same as the incident explainer collects). */
export async function podEvidence(ssh, inc) { return collectIncidentData(ssh, inc) }

/** A few lines to show of the newest log. */
export function logTail(data, n = 12) {
    const d = data.find(x => x.label === 'container log') || data.find(x => /log/.test(x.label))
    return d ? d.text.split('\n').filter(Boolean).slice(-n) : []
}

/** describe of a non-pod object, for questions about it ("web service ka port", "api deployment ka image"). */
export function describeCmd(kind, ns, name) {
    const ok = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
    if (!ok.test(ns) || !ok.test(name)) return null
    const k = { pod: 'pod', deployment: 'deployment', statefulset: 'statefulset', daemonset: 'daemonset', service: 'service', pvc: 'pvc', ingress: 'ingress', cronjob: 'cronjob' }[kind]
    return k ? `sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 20 kubectl describe ${k} ${name} -n ${ns} 2>&1 | head -120` : null
}
