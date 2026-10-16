// KubeEZ AI — a free, private AI model inside the customer's own cluster
// (Ollama, open-source models). KubeEZ reaches it through the cluster tunnel
// like the Explorer: no port is opened, and nothing leaves the network.
import { REPOS, bad, int, oneOf, storageField, resolveStorage, storageClassOf, storageCheck } from './common.js'

export const AI_MODELS = [
    ['qwen2.5:1.5b', 'Small — Qwen 2.5 1.5B (fast, ~1.5 GB RAM)'],
    ['qwen2.5:3b', 'Medium — Qwen 2.5 3B (recommended, ~3 GB RAM)'],
    ['qwen2.5:7b', 'Large — Qwen 2.5 7B (smarter, ~6 GB RAM)'],
    ['llama3.2:3b', 'Llama 3.2 3B (~3 GB RAM)'],
    ['gemma2:2b', 'Gemma 2 2B (~2.5 GB RAM)']
]

const kubeezAi = {
    label: 'KubeEZ AI', ns: 'kubeez-ai', detect: 'deploy/kubeez-ai', tier: 'free',
    summary: 'A free, private AI model in your cluster (Ollama, open-source models). KubeEZ AI explains failures and incidents with it — nothing leaves your network.',
    versions: [{ id: '0.40.5', app: '0.40.5', charts: { 'kubeez-ai': '1.89.0' } }],
    fields: [
        { key: 'model', type: 'select', label: 'Model', default: 'qwen2.5:3b', options: AI_MODELS, help: 'Bigger is smarter but needs more memory and is slower on CPU.' },
        { key: 'memoryMi', type: 'number', label: 'Memory limit', unit: 'MiB', default: 4096, min: 1536, max: 65536, help: 'At least the model size plus ~1 GB.' },
        { key: 'cpu', type: 'select', label: 'CPU limit', default: '2', options: [['1', '1 core'], ['2', '2 cores'], ['4', '4 cores'], ['8', '8 cores']] },
        { key: 'gpu', type: 'bool', label: 'Use an NVIDIA GPU', default: false, help: 'Needs a node with an NVIDIA GPU and its device plugin. Much faster.' },
        storageField('Where the model files are kept', { help: 'Models can always be downloaded again; Longhorn or NFS keep them when the pod moves.' }),
        { key: 'sizeGi', type: 'number', label: 'Volume size', unit: 'GiB', default: 10, min: 5, max: 500 }
    ],
    validate: (s, ctx) => {
        if (!/^[A-Za-z0-9-]+$/.test(String(ctx.clusterId || ''))) throw bad('KubeEZ AI is installed on a saved cluster')
        return {
            model: oneOf(String(s.model || 'qwen2.5:3b'), AI_MODELS.map(m => m[0]), 'Model'),
            memoryMi: int(s.memoryMi ?? 4096, { min: 1536, max: 65536, label: 'Memory limit (MiB)' }),
            cpu: oneOf(String(s.cpu || '2'), ['1', '2', '4', '8'], 'CPU limit'),
            gpu: s.gpu === true || s.gpu === 'true',
            storage: resolveStorage(s.storage, ctx),
            sizeGi: int(s.sizeGi ?? 10, { min: 5, max: 500, label: 'Volume size (GiB)' })
        }
    },
    releases: (s, ctx, v) => [{
        name: 'kubeez-ai', repo: REPOS.ollama, chart: 'ollama', version: v.charts['kubeez-ai'], slow: true,   // the first start downloads the model
        values: {
            fullnameOverride: 'kubeez-ai',
            ollama: {
                gpu: s.gpu ? { enabled: true, type: 'nvidia', number: 1 } : { enabled: false },
                models: { pull: [s.model] }
            },
            service: { type: 'ClusterIP', port: 11434 },
            extraEnv: [{ name: 'OLLAMA_NUM_PARALLEL', value: '1' }, { name: 'OLLAMA_KEEP_ALIVE', value: '10m' }, { name: 'OLLAMA_MAX_LOADED_MODELS', value: '1' }],
            resources: { requests: { cpu: '250m', memory: '1Gi' }, limits: { cpu: s.cpu, memory: `${s.memoryMi}Mi` } },
            persistentVolume: s.storage === 'node' ? { enabled: false }
                : { enabled: true, size: `${s.sizeGi}Gi`, ...(storageClassOf(s.storage) ? { storageClass: storageClassOf(s.storage) } : {}) }
        }
    }],
    pre: (s) => storageCheck(s.storage),
    post: (s) => ({
        manifests: [],
        script: [
            `MODEL='${s.model}'`,
            'IP=$(kubectl -n kubeez-ai get svc kubeez-ai -o jsonpath=\'{.spec.clusterIP}\' 2>/dev/null); OK=""',
            'for _ in $(seq 1 120); do curl -s -m 5 "http://$IP:11434/api/tags" 2>/dev/null | grep -q "\\"$MODEL" && { OK=1; break; }; sleep 5; done',
            '[ -n "$OK" ] || fail MODEL_NOT_READY "KubeEZ AI runs, but the model $MODEL is not downloaded yet." "The first download can take a while on a slow link — check \'kubectl -n kubeez-ai logs deploy/kubeez-ai\', then Repair."',
            'log "✓ KubeEZ AI is ready with $MODEL — choose it in Settings → AI"'
        ].join('\n')
    }),
    locked: { 'kubeez-ai': ['fullnameOverride', 'service'] },
    uninstallNote: 'KubeEZ AI and its downloaded models are removed. KubeEZ falls back to its other AI engines.'
}

export const AI_ADDONS = { 'kubeez-ai': kubeezAi }
