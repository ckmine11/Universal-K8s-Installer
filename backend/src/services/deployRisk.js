// Deploy risk: before an install / upgrade, how risky is it? KubeEZ scores it
// from facts it is sure of — the dry run's changes (what is removed, storage,
// networking, RBAC, CRDs, scaling to 0), the chart's version jump, the target
// environment, the release's recent failures, open problems in the namespace,
// and the CVE / signature gates. The connected AI then explains the risk and
// what to check, from those same facts. The score never depends on the AI:
// without one (or without the right to ask it) the score and its reasons stay.
const W = {
    protectedEnv: 15, prodName: 10, remove: 20, removeData: 30, storage: 15, network: 10, rbac: 10, crd: 20,
    scaleToZero: 15, majorBump: 15, minorBump: 5, manyChanges: 10, incidents: 10, failedBefore: 10,
    cveBlocked: 25, cveFailing: 15, unsigned: 15, image: 5, firstInstall: 5
}
const DATA_KINDS = new Set(['PersistentVolumeClaim', 'PersistentVolume', 'StatefulSet'])
const NETWORK_KINDS = new Set(['Service', 'Ingress', 'NetworkPolicy', 'Gateway', 'HTTPRoute', 'VirtualService'])
const RBAC_KINDS = new Set(['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ServiceAccount'])

const semver = (v) => { const m = /^v?(\d+)\.(\d+)/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2])] : null }
const changed = (c, re) => (c.diff || []).some(l => /^[+-]/.test(l) && re.test(l))

/**
 * The facts → { score 0–100, level: low | medium | high, factors: [{ key, points, label }] }
 * preview: previewDeploy's answer; current: the running release ({ version, revision }) or null;
 * env: the target environment or null; history: [{ status, updated }]; incidents: open ones in the namespace.
 */
export function scoreRisk({ preview, current = null, toVersion = null, env = null, history = [], incidents = [], now = Date.now() }) {
    const f = []
    const add = (key, points, label) => f.push({ key, points, label })
    const changes = preview?.changes || []
    if (env?.protected) add('protectedEnv', W.protectedEnv, `${env.name} is a protected environment`)
    else if (env && /prod|live|prd/i.test(env.name)) add('prodName', W.prodName, `${env.name} looks like production`)
    if (preview?.install) add('firstInstall', W.firstInstall, 'A first install — nothing runs there yet to compare with')
    const removed = changes.filter(c => c.action === 'remove')
    const removedData = removed.filter(c => DATA_KINDS.has(c.kind))
    if (removedData.length) add('removeData', W.removeData, `Removes ${removedData.map(c => `${c.kind} ${c.name}`).join(', ')} — data may be lost`)
    else if (removed.length) add('remove', W.remove, `Removes ${removed.length} resource${removed.length === 1 ? '' : 's'}: ${removed.slice(0, 4).map(c => `${c.kind} ${c.name}`).join(', ')}`)
    const storage = changes.filter(c => c.action === 'change' && (DATA_KINDS.has(c.kind) && (c.kind !== 'StatefulSet' || changed(c, /volumeClaimTemplates|storage:|storageClassName/))))
    if (storage.length) add('storage', W.storage, `Changes storage: ${storage.map(c => `${c.kind} ${c.name}`).join(', ')}`)
    const net = changes.filter(c => c.action !== 'add' && NETWORK_KINDS.has(c.kind))
    if (net.length) add('network', W.network, `Changes how traffic reaches the app: ${net.slice(0, 4).map(c => `${c.kind} ${c.name}`).join(', ')}`)
    const rbac = changes.filter(c => RBAC_KINDS.has(c.kind) && c.action !== 'add' || ['ClusterRole', 'ClusterRoleBinding'].includes(c.kind))
    if (rbac.length) add('rbac', W.rbac, `Changes permissions: ${rbac.slice(0, 4).map(c => `${c.kind} ${c.name}`).join(', ')}`)
    const crd = changes.filter(c => c.kind === 'CustomResourceDefinition')
    if (crd.length) add('crd', W.crd, `Changes CustomResourceDefinitions (cluster-wide): ${crd.slice(0, 3).map(c => c.name).join(', ')}`)
    if (changes.some(c => changed(c, /^\+\s*replicas:\s*0\s*$/))) add('scaleToZero', W.scaleToZero, 'Scales a workload to 0 replicas')
    if (changes.some(c => changed(c, /^\+\s*image:/))) add('image', W.image, 'Runs new container images')
    const from = semver(current?.version), to = semver(toVersion)
    if (from && to && to[0] > from[0]) add('majorBump', W.majorBump, `Chart major version ${from[0]} → ${to[0]} — read its upgrade notes`)
    else if (from && to && to[0] === from[0] && to[1] > from[1] + 2) add('minorBump', W.minorBump, `Chart jumps ${to[1] - from[1]} minor versions`)
    if (changes.length > 20) add('manyChanges', W.manyChanges, `${changes.length} resources change at once`)
    const recentFail = history.filter(h => /failed/i.test(h.status || '') && now - Date.parse(h.updated || 0) < 14 * 86400e3)
    if (recentFail.length) add('failedBefore', W.failedBefore, `${recentFail.length} failed deploy${recentFail.length === 1 ? '' : 's'} of this app in the last 14 days`)
    if (incidents.length) add('incidents', Math.min(20, W.incidents * incidents.length), `${incidents.length} open problem${incidents.length === 1 ? '' : 's'} in this namespace now: ${incidents.slice(0, 3).map(i => i.reason).join(', ')}`)
    if (preview?.cve?.blocked) add('cveBlocked', W.cveBlocked, `The CVE policy blocks it: ${preview.cve.failing.map(x => x.image).join(', ')}`)
    else if (preview?.cve?.failing?.length) add('cveFailing', W.cveFailing, `Vulnerable images: ${preview.cve.failing.map(x => x.image).join(', ')}`)
    if (preview?.signatures?.failing?.length) add('unsigned', W.unsigned, `Images without a trusted signature: ${preview.signatures.failing.map(x => x.image).join(', ')}`)
    const score = Math.min(100, f.reduce((n, x) => n + x.points, 0))
    return { score, level: score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low', factors: f.sort((a, b) => b.points - a.points) }
}

/** The facts as plain text for the AI. */
export function riskFacts({ release, namespace, cluster, preview, current, toVersion, env, history, incidents, risk }) {
    const diff = (preview?.changes || []).slice(0, 25).map(c => `${c.action} ${c.kind} ${c.namespace ? `${c.namespace}/` : ''}${c.name}${c.diff ? `\n${c.diff.filter(l => /^[+-]/.test(l)).slice(0, 25).join('\n')}` : ''}`).join('\n')
    return [
        { label: 'the deploy', text: `${preview?.install ? 'Install' : 'Upgrade'} of Helm release ${namespace}/${release} on cluster ${cluster.clusterName}: chart ${current ? `${current.chart} ${current.version || ''} → ` : ''}${preview?.chart || ''}${toVersion ? ` (${toVersion})` : ''}. Environment: ${env ? `${env.name}${env.protected ? ' (protected)' : ''}` : 'none'}. ${preview?.changes?.length || 0} resources change, ${preview?.unchanged || 0} unchanged.` },
        { label: 'KubeEZ risk score', text: `${risk.score}/100 (${risk.level})\n${risk.factors.map(x => `+${x.points} ${x.label}`).join('\n') || 'no risk factors found'}` },
        { label: 'what changes (dry run diff, secrets hashed)', text: diff || 'nothing changes' },
        { label: 'release history', text: (history || []).slice(0, 8).map(h => `#${h.revision} ${h.status} ${h.chart || ''} ${String(h.updated || '').slice(0, 16)} ${h.description || ''}`).join('\n') || 'none (first install)' },
        { label: 'open problems in the namespace', text: (incidents || []).slice(0, 8).map(i => `${i.severity} ${i.reason} ${i.target}: ${String(i.message || '').slice(0, 200)}`).join('\n') || 'none' },
        preview?.notes ? { label: 'chart notes', text: String(preview.notes).slice(0, 1500) } : null
    ].filter(Boolean)
}

const shape = (j) => !['low', 'medium', 'high'].includes(j?.level) ? 'level must be low, medium or high'
    : typeof j.summary !== 'string' || !j.summary.trim() ? 'summary is missing'
        : !Array.isArray(j.risks) || !Array.isArray(j.checks) ? 'risks and checks must be lists' : null

/** The AI's view of the risk → { level, summary, risks[], checks[], rollback, engine } (throws AiUnavailable when none). */
export async function explainRisk(user, facts, { ask } = {}) {
    const run = ask || (await import('./ai/engine.js')).ask
    const r = await run(user, {
        task: 'explain', purpose: 'deploy risk', json: true, validate: shape, maxTokens: 1200, data: facts,
        system: 'You review a Helm deploy before it runs. Reply with ONLY a JSON object: {"level":"low|medium|high","summary":"one or two sentences","risks":["what could go wrong, specific to this diff"],"checks":["what to verify before or right after deploying"],"rollback":"how to undo it if it goes wrong"}. Base it on the facts given; KubeEZ\'s score is a starting point — you may rate higher or lower when the diff shows why. At most 5 risks and 5 checks; name the real resources.',
        question: 'How risky is this deploy, and what should be checked?'
    })
    const j = r.json
    return { level: j.level, summary: String(j.summary).slice(0, 600), risks: j.risks.map(String).slice(0, 5), checks: j.checks.map(String).slice(0, 5), rollback: j.rollback ? String(j.rollback).slice(0, 400) : null, engine: { provider: r.provider, model: r.model } }
}
