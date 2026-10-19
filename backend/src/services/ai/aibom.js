// AI-BOM — the bill of materials of KubeEZ AI in a workspace: every model
// (with its exact digest where the engine tells it), every prompt (by hash —
// a changed prompt is a changed AI), where data goes, the safety controls,
// the quality results and what is kept. CycloneDX 1.6 (machine-learning-model
// components) for auditors and tools; a readable summary for people.
import crypto from 'crypto'
import { aiStore, TASKS } from './aiStore.js'
import { KINDS, serverModel } from './providers.js'
import { requestJson } from './http.js'
import { routeFor, serverAvailable } from './engine.js'
import { UNTRUSTED_RULES } from './guard.js'
import { INSTALL_SYSTEM, incidentSystem, JSON_RULES } from './doctor.js'
import { SPECIALISTS } from './specialists.js'
import { GENERATE_SYSTEM } from './manifests.js'
import { CHAT_SYSTEM } from './chatops.js'
import { latestByEngine, feedbackStats } from './quality.js'
import { EXAM_VERSION, EXAM } from '../../config/aiExam.js'
import { approvalStore } from '../approvalStore.js'
import { AUDIT_RETENTION_DAYS } from '../auditLog.js'

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const LOCAL = new Set(['ollama', 'server', 'cluster'])
const host = (u) => { try { return new URL(u).host } catch { return null } }

/** Every prompt KubeEZ AI uses, with a version hash. */
export function promptInventory() {
    const list = [
        ['safety rules (untrusted data)', UNTRUSTED_RULES, 'every call'],
        ['answer format (JSON, proof)', JSON_RULES, 'explanations'],
        ['Install Doctor', INSTALL_SYSTEM, 'failed installs, upgrades, add-on jobs'],
        ['incident explainer', incidentSystem(), 'incidents'],
        ...Object.entries(SPECIALISTS).map(([k, v]) => [`specialist: ${v.label}`, v.prompt, `incidents (${k})`]),
        ['text to YAML', GENERATE_SYSTEM, 'Create YAML — the AI writes it from KubeEZ\'s draft and rules'],
        ['ChatOps', CHAT_SYSTEM, 'Telegram / Slack questions']
    ]
    return list.map(([name, text, usedFor]) => ({ name, usedFor, sha256: sha(text), chars: text.length }))
}

// what an Ollama engine says about its model (digest, size, quantisation) — best effort, 5 s
async function ollamaDetails(p) {
    const base = p.kind === 'server' ? serverModel().url : p.kind === 'ollama' ? p.baseUrl : null
    if (!base) return null
    try {
        const r = await requestJson('GET', `${String(base).replace(/\/+$/, '')}/api/tags`, undefined, { timeoutMs: 5000, trusted: p.kind === 'server' })
        const want = p.model || serverModel().model
        const m = (r.models || []).find(x => x.name === want || x.name === `${want}:latest`)
        return m ? { digest: m.digest, size: m.size, family: m.details?.family, parameters: m.details?.parameter_size, quantization: m.details?.quantization_level, format: m.details?.format } : null
    } catch { return null }
}

export async function buildAiBom(orgId, { now = new Date() } = {}) {
    const s = aiStore.get(orgId)
    const engines = [...s.providers.map(p => ({ ...p })), ...(serverAvailable() ? [{ id: 'server', name: 'KubeEZ server model', kind: 'server', model: serverModel().model, enabled: true }] : [])]
    const latest = latestByEngine(orgId), fb = feedbackStats(orgId)
    const usedFor = Object.fromEntries(engines.map(e => [e.id, Object.keys(TASKS).filter(t => routeFor(orgId, t).some(x => x.id === e.id))]))
    const details = await Promise.all(engines.map(e => ollamaDetails(e)))
    const approvals = approvalStore.settings(orgId).actions || {}
    const prompts = promptInventory()

    const models = engines.map((e, i) => {
        const d = details[i]
        const q = latest[e.id]
        return {
            id: e.id, name: e.name, kind: e.kind, kindLabel: KINDS[e.kind]?.label || e.kind, model: e.model || serverModel().model,
            enabled: e.enabled !== false, local: LOCAL.has(e.kind), endpoint: e.kind === 'cluster' ? `cluster ${e.clusterId} (through the KubeEZ tunnel)` : e.kind === 'server' ? 'KubeEZ server (docker network)' : e.kind === 'gemini' ? 'generativelanguage.googleapis.com' : e.kind === 'anthropic' ? 'api.anthropic.com' : host(e.baseUrl),
            dataLeaves: !LOCAL.has(e.kind), usedFor: usedFor[e.id], details: d,
            quality: q ? { score: q.summary.score, cause: q.summary.cause, proof: q.summary.proof, traps: q.summary.traps, at: q.finishedAt, examVersion: q.examVersion, stale: (q.engineModel || null) !== (e.model || null) } : null,
            feedback: fb[e.id] || null
        }
    })
    const controls = [
        ['Secret masking', 'always on — passwords, tokens, keys, certificates, kubeconfigs are replaced before any model sees data'],
        ['E-mail masking', s.maskEmails ? 'on' : 'off'], ['IP masking', s.maskIps ? 'on' : 'off'],
        ['Untrusted-data fencing and trick-text detection', 'always on'],
        ['Proof checking', 'always on — quoted evidence must be in the real data; invented lines are removed'],
        ['Destructive-step guard', 'always on — steps that would damage a cluster are removed from every answer'],
        ['AI on for the workspace', s.enabled ? 'yes' : 'no'],
        ['Kill switch (AI actions allowed)', s.actionsEnabled ? 'actions allowed' : 'all AI actions stopped'],
        ['Autonomy', { suggest: 'suggest only', approve: 'a person approves every fix', auto: 'proven low-risk runbooks may run by themselves' }[s.autonomy]],
        ['Two-person approval for AI fixes', approvals['ai:action'] ? 'required' : 'not required'],
        ['Two-person approval for AI-written YAML', approvals['ai:apply'] ? 'required' : 'not required'],
        ...(serverAvailable() ? [['Server model daily allowance', `${s.dailyLimit} questions`]] : []),
        ['ChatOps', Object.values(s.chatops || {}).some(c => c.enabled) ? 'on for some channels (read-only)' : 'off']
    ]
    const retention = [
        ['Activity log', 'last 300 AI calls per workspace — masked prompts and answers, never API keys'],
        ['API keys', 'encrypted at rest (AES-256-GCM), never shown again or sent to the browser'],
        ['Audit trail', `every AI question, fix, undo and setting change — hash-chained, kept ${AUDIT_RETENTION_DAYS} days`],
        ['Learned runbooks / examples', 'masked, per workspace, can be deleted in AI settings']
    ]

    const cyclonedx = {
        bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${crypto.randomUUID()}`, version: 1,
        metadata: { timestamp: now.toISOString(), tools: { components: [{ type: 'application', name: 'KubeEZ', version: process.env.npm_package_version || '2.x' }] }, component: { type: 'application', name: 'KubeEZ AI', 'bom-ref': 'kubeez-ai' } },
        components: [
            ...models.map(m => ({
                type: 'machine-learning-model', 'bom-ref': `model-${m.id}`, name: m.model, version: m.details?.digest ? m.details.digest.slice(0, 12) : 'unknown', supplier: { name: m.kindLabel },
                hashes: m.details?.digest ? [{ alg: 'SHA-256', content: m.details.digest }] : undefined,
                modelCard: { modelParameters: { task: 'text-generation', architectureFamily: m.details?.family, modelArchitecture: m.details?.parameters }, quantitativeAnalysis: m.quality ? { performanceMetrics: [{ type: 'kubeez-exam-score', value: String(m.quality.score) }, { type: 'right-cause-%', value: String(m.quality.cause) }, { type: 'real-proof-%', value: String(m.quality.proof) }] } : undefined },
                properties: [{ name: 'kubeez:engine', value: m.name }, { name: 'kubeez:kind', value: m.kind }, { name: 'kubeez:endpoint', value: m.endpoint || '' }, { name: 'kubeez:data-leaves-network', value: String(m.dataLeaves) }, { name: 'kubeez:enabled', value: String(m.enabled) }, { name: 'kubeez:used-for', value: m.usedFor.join(',') }, ...(m.details?.quantization ? [{ name: 'kubeez:quantization', value: m.details.quantization }] : [])]
            })),
            ...prompts.map(p => ({ type: 'data', 'bom-ref': `prompt-${sha(p.name).slice(0, 8)}`, name: `prompt: ${p.name}`, version: p.sha256.slice(0, 12), hashes: [{ alg: 'SHA-256', content: p.sha256 }], data: [{ type: 'configuration', name: p.name, description: `used for ${p.usedFor}` }] })),
            { type: 'data', 'bom-ref': 'exam', name: 'KubeEZ AI quality test', version: String(EXAM_VERSION), description: `${EXAM.length} cases incl. ${EXAM.filter(c => c.trap).length} traps` }
        ],
        services: models.filter(m => m.dataLeaves).map(m => ({ 'bom-ref': `svc-${m.id}`, name: m.name, endpoints: [m.endpoint].filter(Boolean), authenticated: true, 'x-trust-boundary': true, data: [{ flow: 'outbound', classification: 'masked cluster logs, events and questions' }] })),
        properties: controls.map(([name, value]) => ({ name: `kubeez:control:${name}`, value }))
    }
    return { generatedAt: now.toISOString(), models, prompts, controls, retention, exam: { version: EXAM_VERSION, cases: EXAM.length }, cyclonedx }
}
