// KubeEZ AI Doctor — explains what went wrong, with proof:
//   explainInstall   a failed install / upgrade / add-on job, from its log
//   explainIncident  an incident, from its evidence, fresh cluster data and
//                    what changed just before it; may suggest one safe fix
//   summarizeChanges the "What changed?" timeline in a few lines
// "Never invents": every quoted evidence line must really be in the data —
// quotes that are not are dropped and the answer is marked as less certain.
// When no AI engine answers, the caller still has KubeEZ's own diagnosis.
import { ask } from './engine.js'
import { ACTION_TYPES } from './actions.js'
import { changesText } from './changes.js'

const CONFIDENCE = ['high', 'medium', 'low']
// a good answer needs ~250–350 tokens; a tight budget stops a rambling small model sooner
export const TOKENS = { install: 600, incident: 700 }

// "Never makes it worse": steps that destroy a cluster or its data are never shown
// as advice (a model can be tricked by text in a log, or simply be wrong)
const DANGEROUS = [
    /kubectl\s+delete\s+(ns|namespaces?)\s+(kube-system|kube-public|kube-node-lease|default)\b/i,
    /kubectl\s+delete\s+\S+.*\s(--all\b|-A\b|--all-namespaces\b)/i,
    /kubectl\s+delete\s+(crds?|customresourcedefinitions?|pv|persistentvolumes?)\b.*--all/i,
    /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/\s|\/$|\/\*|\/(etc|root|home|usr|boot)\b)/i,
    /\betcdctl\b.*\b(del|delete)\b/i,
    /\b(mkfs(\.\w+)?|wipefs)\b|\bdd\s+if=.*\bof=\/dev\//i,
    /\biptables\s+(-F|--flush)\b/i,
    /\bdrop\s+(database|schema)\b/i,
    /\bhelm\s+uninstall\b.*\s(-n|--namespace)\s+kube-system\b/i
]
// sometimes right (clearing a half-finished install) but destroys a working node — shown with a warning
const CAUTION = [/\bkubeadm\s+reset\b/i, /\brm\s+-[a-z]*r[a-z]*\s+\/var\/lib\/(etcd|kubelet|containerd)\b/i, /kubectl\s+delete\s+(node|pvc|pv|statefulset|namespace|ns)\b/i, /\bhelm\s+uninstall\b/i]
export function screenSteps(steps) {
    const kept = [], removed = [], caution = []
    for (const s of steps) {
        if (DANGEROUS.some(re => re.test(s))) removed.push(s)
        else { kept.push(s); if (CAUTION.some(re => re.test(s))) caution.push(s) }
    }
    return { kept, removed, caution }
}
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Keep only quotes that appear in the source (whitespace/case-insensitive). */
export function checkEvidence(quotes, source) {
    const src = norm(source)
    const kept = [], dropped = []
    for (const q of (Array.isArray(quotes) ? quotes : []).slice(0, 8)) {
        const n = norm(q).replace(/^["'`]+|["'`]+$/g, '').replace(/\.\.\.$|…$/, '').trim()
        if (n.length >= 6 && src.includes(n)) kept.push(String(q).trim().slice(0, 400)); else if (n) dropped.push(String(q).slice(0, 200))
    }
    return { kept, dropped }
}

// small models bend the format: a list may come as text ("1. … 2. …"), a step as
// an object — take what is usable instead of throwing a good answer away
export function asList(v) {
    if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : x && typeof x === 'object' ? Object.values(x).filter(y => typeof y === 'string').join(' — ') : String(x ?? '')).map(s => s.trim()).filter(Boolean)
    if (typeof v !== 'string' || !v.trim()) return []
    const parts = v.split(/\n+|(?:^|\s)\d+[.)]\s+|;\s+/).map(s => s.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
    return parts.length ? parts : [v.trim()]
}
// small models sometimes copy the format's own descriptions back as the answer
const PLACEHOLDERS = [/what happened, in one or two plain sentences/i, /^the most likely root cause\.?$/i, /short concrete steps,? in order/i, /commands in backticks/i, /lines copied exactly from the data/i, /what information would make you certain/i]
const parroted = (v) => asList(Array.isArray(v) ? v : [v]).some(s => PLACEHOLDERS.some(re => re.test(String(s).trim())))
export const shape = (j) => {
    if (typeof j.summary !== 'string' || j.summary.length < 5) return 'missing summary'
    if (!asList(j.fix).length && !(typeof j.cause === 'string' && j.cause.length > 5)) return 'no cause and no steps'
    if (parroted(j.summary) || parroted(j.cause) || parroted(j.fix)) return 'it copied the format description instead of answering'
    return null
}

// the answer as the UI gets it — checked and trimmed
export function finish(j, source, extra = {}) {
    j = { ...j, fix: asList(j.fix), evidence: asList(j.evidence) }
    const steps = screenSteps(j.fix)
    j.fix = steps.kept
    const ev = checkEvidence(j.evidence, source)
    let confidence = CONFIDENCE.includes(j.confidence) ? j.confidence : 'medium'
    if (ev.dropped.length && !ev.kept.length && confidence === 'high') confidence = 'medium'
    if (!ev.kept.length && confidence !== 'low' && ev.dropped.length > 1) confidence = 'low'
    return {
        summary: String(j.summary).slice(0, 600), cause: String(j.cause || '').slice(0, 600),
        evidence: ev.kept, unverified: ev.dropped.length,
        fix: j.fix.map(x => String(x).slice(0, 400)).filter(Boolean).slice(0, 8),
        missing: String(j.missing || '').slice(0, 300) || null, confidence,
        claimedConfidence: CONFIDENCE.includes(j.confidence) ? j.confidence : null,   // before KubeEZ lowered it
        blockedSteps: steps.removed.map(x => String(x).slice(0, 200)),
        cautionSteps: steps.caution.map(x => String(x).slice(0, 400)),
        ...extra
    }
}

export const JSON_RULES = `Reply with ONLY a JSON object:
{
  "summary": "what happened, in one or two plain sentences",
  "cause": "the most likely root cause",
  "evidence": ["1 to 4 lines copied EXACTLY from the data that prove the cause"],
  "fix": ["short concrete steps, in order; commands in backticks"],
  "confidence": "high | medium | low",
  "missing": "what information would make you certain (empty if nothing)"
}
Copy evidence lines exactly — they are checked against the data, and invented lines are removed.`

// ── install / upgrade / add-on job ──
// the prompts are exported: the quality test (quality.js) uses exactly what users get
export const INSTALL_SYSTEM = `You are the KubeEZ Install Doctor. A job on the customer's own Linux servers failed (kubeadm, containerd, Helm, SSH). Find the real root cause from the log — usually the first real error, not the last line. Fixes must be safe and specific to what the log shows; say "Resume" (KubeEZ retries from the failed step) when the fix is outside the cluster (network, disk, packages).\n\n${JSON_RULES}`
export const incidentSystem = (actionRules = 'Do not suggest an action ("action": null).') => `You are the KubeEZ incident explainer for a Kubernetes cluster. Explain the incident to an on-call engineer: the real cause, the proof, and the fix. If a change listed under "what changed" plausibly caused it, name it in "change" (copy that line exactly), else "change": "".\n\n${JSON_RULES.replace('"missing":', '"change": "the change line that caused it, or empty",\n  "action": null,\n  "missing":')}\n${actionRules}`

const MODE = { install: 'cluster installation', upgrade: 'Kubernetes upgrade', scale: 'adding worker nodes', resume: 'resumed installation' }

/** The log of a failed job, focused: errors and warnings plus the last lines. */
export function installFacts(inst) {
    const logs = inst.logs || []
    const tail = logs.slice(-120)
    const flagged = logs.slice(0, -120).filter(l => ['error', 'warning'].includes(l.level)).slice(-40)
    const line = (l) => `${l.level === 'error' ? 'ERROR ' : l.level === 'warning' ? 'WARN ' : ''}${String(l.message || '').slice(0, 600)}`
    const log = [...flagged.map(line), ...(flagged.length ? ['…'] : []), ...tail.map(line)].join('\n').slice(-16000)
    const d = inst.diagnosis || {}
    const facts = [
        `Job: ${MODE[inst.mode] || `add-on job (${inst.mode})`} of cluster "${inst.clusterName}"`,
        inst.k8sVersion && `Kubernetes version: ${inst.k8sVersion}${inst.targetVersion ? ` → ${inst.targetVersion}` : ''}`,
        inst.currentStep && `Failed during step: ${inst.currentStep} (progress ${inst.progress || 0}%)`,
        inst.error && `Error: ${String(inst.error).slice(0, 800)}`,
        d.reason && `KubeEZ's own diagnosis: ${d.reason} — ${d.message || ''}${d.suggestedFix ? ` Suggested fix: ${d.suggestedFix}` : ''}`,
        `Nodes: ${(inst.masterNodes || []).length} control-plane, ${(inst.workerNodes || []).length} worker`
    ].filter(Boolean).join('\n')
    return { facts, log }
}

export async function explainInstall(user, inst) {
    const { facts, log } = installFacts(inst)
    const r = await ask(user, {
        task: 'explain', purpose: 'install doctor', json: true, validate: shape, maxTokens: TOKENS.install,
        clusterId: inst.originalClusterId || inst.id, clusterName: inst.clusterName,
        system: INSTALL_SYSTEM,
        data: [{ label: 'job facts', text: facts }, { label: 'job log', text: log }],
        question: 'Why did this job fail, and how do I fix it?'
    })
    return { answer: finish(r.json, `${facts}\n${log}`), engine: { provider: r.provider, model: r.model, ms: r.ms, masked: r.masked, suspicious: r.suspicious, traceId: r.traceId } }
}

// ── incidents ──
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/

/** The workload an incident is about (Deployment for a pod of a ReplicaSet, …) — resolved on the cluster. */
async function resolveWorkload(ssh, inc) {
    const ns = inc.namespace
    if (!ns || !K8S_NAME.test(ns)) return null
    const m = /^(deployment|statefulset|daemonset)\/([a-z0-9.-]+)$/.exec(String(inc.target || ''))
    if (m) return { kind: m[1], name: m[2], namespace: ns }
    const [okind, oname] = String(inc.owner || '').split('/')
    if (!oname || !K8S_NAME.test(oname)) return null
    if (okind === 'ReplicaSet') {
        const r = await ssh.execCommand(`sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get rs ${oname} -n ${ns} -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}' 2>/dev/null`)
        const [k, n] = (r.stdout || '').trim().split('/')
        return k === 'Deployment' && K8S_NAME.test(n || '') ? { kind: 'deployment', name: n, namespace: ns } : null
    }
    if (['StatefulSet', 'DaemonSet'].includes(okind)) return { kind: okind.toLowerCase(), name: oname, namespace: ns }
    return null
}

const isPodIncident = (inc) => inc.namespace && inc.target && !inc.target.includes('/') && K8S_NAME.test(inc.target)

/** Fresh data for an incident (best effort): pod events + logs, workload status, node conditions. */
export async function collectIncidentData(ssh, inc) {
    const K = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 20 kubectl'
    const out = []
    const run = async (label, cmd) => { try { const r = await ssh.execCommand(cmd); const t = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim(); if (t) out.push({ label, text: t.slice(-6000) }) } catch { } }
    const workload = await resolveWorkload(ssh, inc).catch(() => null)
    if (isPodIncident(inc) && K8S_NAME.test(inc.namespace)) {
        const p = `${inc.target} -n ${inc.namespace}`
        await run('pod events', `${K} describe pod ${p} 2>&1 | sed -n '/Containers:/,/Volumes:/p;/Events:/,$p' | tail -60`)
        await run('previous container log', `${K} logs ${p} --all-containers --previous --tail=60 2>&1 | tail -60`)
        await run('container log', `${K} logs ${p} --all-containers --tail=40 2>&1 | tail -40`)
    }
    if (workload) await run(`${workload.kind} status`, `${K} describe ${workload.kind} ${workload.name} -n ${workload.namespace} 2>&1 | sed -n '/Replicas:/p;/Pod Template:/,/Volumes:/p;/Conditions:/,$p' | tail -50`)
    if (inc.nodeName && K8S_NAME.test(inc.nodeName)) await run('node conditions', `${K} describe node ${inc.nodeName} 2>&1 | sed -n '/Conditions:/,/Addresses:/p;/Allocated resources:/,/Events:/p' | head -45`)
    return { data: out, workload }
}

/** The fixes the AI may suggest for this incident (and only these targets). */
export function allowedActions(inc, workload) {
    const out = []
    if (workload) {
        out.push({ type: 'restart', kind: workload.kind, name: workload.name, namespace: workload.namespace })
        if (workload.kind === 'deployment') out.push({ type: 'rollback', kind: 'deployment', name: workload.name, namespace: workload.namespace })
        if (workload.kind !== 'daemonset') out.push({ type: 'scale', kind: workload.kind, name: workload.name, namespace: workload.namespace })
    }
    if (isPodIncident(inc)) out.push({ type: 'delete-pod', kind: 'pod', name: inc.target, namespace: inc.namespace })
    return out
}

/** A suggested action is used only if it is one of the allowed ones. */
export function pickAction(raw, allowed) {
    if (!raw || typeof raw !== 'object') return null
    const type = String(raw.type || '')
    const target = String(raw.target || '').toLowerCase()
    const a = allowed.find(x => x.type === type && (`${x.kind}/${x.name}` === target || x.name === target))
    if (!a) return null
    if (type === 'scale') {
        const n = Number(raw.replicas)
        if (!Number.isInteger(n) || n < 1 || n > 50) return null   // never suggests scaling to 0
        return { ...a, replicas: n }
    }
    return { ...a }
}

export async function explainIncident(user, { incident: inc, catalog, cluster, fresh, changes, related }) {
    const facts = [
        `Incident: ${catalog?.label || inc.reason} (${inc.reason}), severity ${inc.severity}, status ${inc.status}`,
        `Target: ${inc.namespace ? `${inc.namespace}/` : ''}${inc.target}${inc.owner ? ` (owner ${inc.owner})` : ''}${inc.nodeName ? ` on node ${inc.nodeName}` : ''}`,
        `First seen ${inc.timestamp}, last seen ${inc.lastSeen}, seen ${inc.count || 1} time(s)`,
        `Message: ${inc.message}`,
        inc.details && `KubeEZ's diagnosis / status: ${inc.details}`,
        catalog?.suggestion && `KubeEZ's general advice for this type: ${catalog.suggestion}`,
        related && `Caused by another incident: ${related.reason} on ${related.target} — ${related.message}`,
        (inc.timeline || []).length && `Timeline:\n${inc.timeline.slice(-8).map(t => `${t.at} ${t.kind}${t.by ? ` (${t.by})` : ''}: ${t.text}`).join('\n')}`
    ].filter(Boolean).join('\n')
    const allowed = allowedActions(inc, fresh.workload)
    const data = [
        { label: 'incident', text: facts },
        ...(inc.evidence || []).map(e => ({ label: `evidence: ${e.title}`, text: e.text })),
        ...fresh.data,
        { label: 'what changed in the 3 hours before', text: changes?.length ? changesText(changes, 40) : 'No changes recorded in that time.' }
    ]
    const actionRules = allowed.length
        ? `You may suggest ONE fix KubeEZ can run (a person previews and approves it), only if the evidence supports it, as "action": {"type": "${[...new Set(allowed.map(a => a.type))].join(' | ')}", "target": "${[...new Set(allowed.map(a => `${a.kind}/${a.name}`))].join(' | ')}", "replicas": number for scale}. Prefer rollback when a recent rollout caused it, restart for a stuck or leaking process. Use "action": null when the fix is a config change a person must make (memory limit, image name, missing secret…).`
        : 'Do not suggest an action ("action": null).'
    const r = await ask(user, {
        task: 'explain', purpose: 'incident explainer', json: true, validate: shape, maxTokens: TOKENS.incident, clusterId: cluster.id, clusterName: cluster.clusterName,
        system: incidentSystem(actionRules),
        data, question: 'Why is this happening, and what should I do?'
    })
    const source = data.map(d => d.text).join('\n')
    const change = r.json.change && norm(source).includes(norm(r.json.change)) ? String(r.json.change).slice(0, 300) : null
    return {
        answer: finish(r.json, source, { change, action: pickAction(r.json.action, allowed) }),
        allowedActions: allowed,
        engine: { provider: r.provider, model: r.model, ms: r.ms, masked: r.masked, suspicious: r.suspicious, traceId: r.traceId }
    }
}

// ── what changed ──
export async function summarizeChanges(user, cluster, { items, from, to }) {
    const r = await ask(user, {
        task: 'summarize', purpose: 'what changed', maxTokens: 600, clusterId: cluster.id, clusterName: cluster.clusterName,
        system: 'Summarise the changes to a Kubernetes cluster for its operator: group them (deployments, add-ons / Helm, config, nodes, KubeEZ actions), name the riskiest ones first, and point out anything unusual (many restarts of one app, changes at night, a Secret changed right before a rollout). 3 to 8 short bullet points. Only use the listed changes.',
        data: [{ label: `changes ${from} → ${to}`, text: items.length ? changesText(items, 150) : 'No changes.' }],
        question: 'What changed, in short?'
    })
    return { summary: r.text, engine: { provider: r.provider, model: r.model, ms: r.ms, traceId: r.traceId } }
}

export { ACTION_TYPES }
