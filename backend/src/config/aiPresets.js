// The AI engines a workspace can connect, as the "Connect AI" wizard offers them.
// Every one maps to an engine type KubeEZ already speaks (providers.js):
//   offline  a model on your own machine or server — any runtime with an
//            OpenAI-compatible API (most of them), Ollama, or the KubeEZ AI
//            add-on in your cluster. No key needed, data stays with you.
//   cloud    a provider's API with your own key (billed to your account).
// Any other server that speaks the OpenAI API works with "Other".
export const PRESETS = [
    // ── offline: your own machine / server ──
    { id: 'kubeez-addon', group: 'offline', kind: 'cluster', label: 'KubeEZ AI add-on', note: 'Ollama inside one of your clusters, reached through the KubeEZ tunnel — free, private, nothing to expose.' },
    { id: 'ollama', group: 'offline', kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', note: 'Runs any model from ollama.com (Qwen, Llama, Mistral, Gemma, Phi, DeepSeek…). Can download models from here.' },
    { id: 'lmstudio', group: 'offline', kind: 'openai', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', note: 'Desktop app: Developer → Start server. Any GGUF / MLX model you load.' },
    { id: 'vllm', group: 'offline', kind: 'openai', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', note: 'Fast serving on GPU servers: `vllm serve <model>`.' },
    { id: 'llamacpp', group: 'offline', kind: 'openai', label: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1', note: '`llama-server -m model.gguf` — CPU or GPU, very light.' },
    { id: 'localai', group: 'offline', kind: 'openai', label: 'LocalAI', baseUrl: 'http://localhost:8080/v1', note: 'OpenAI-compatible server for many model formats.' },
    { id: 'tgi', group: 'offline', kind: 'openai', label: 'Hugging Face TGI', baseUrl: 'http://localhost:8080/v1', note: 'text-generation-inference with its Messages API.' },
    { id: 'jan', group: 'offline', kind: 'openai', label: 'Jan', baseUrl: 'http://localhost:1337/v1', note: 'Desktop app: Settings → Local API Server.' },
    { id: 'koboldcpp', group: 'offline', kind: 'openai', label: 'KoboldCpp', baseUrl: 'http://localhost:5001/v1', note: 'Single-file GGUF runner with an OpenAI-compatible API.' },
    { id: 'textgen-webui', group: 'offline', kind: 'openai', label: 'text-generation-webui', baseUrl: 'http://localhost:5000/v1', note: 'Start with --api (the OpenAI-compatible extension).' },
    { id: 'other-local', group: 'offline', kind: 'openai', label: 'Other (OpenAI-compatible)', baseUrl: '', note: 'Any server with /v1/chat/completions and /v1/models — an API key only if it asks for one.' },
    // ── cloud: your own API key ──
    { id: 'anthropic', group: 'cloud', kind: 'anthropic', label: 'Anthropic Claude', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', note: 'Claude — the best quality for diagnosis; Haiku is very fast.' },
    { id: 'gemini', group: 'cloud', kind: 'gemini', label: 'Google Gemini', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', note: 'Gemini Flash is fast and low-cost; Pro for harder questions.' },
    { id: 'openai', group: 'cloud', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', note: 'GPT models.' },
    { id: 'openrouter', group: 'cloud', kind: 'openai', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/keys', note: 'One key for hundreds of models from every provider — new ones appear on their own.' },
    { id: 'groq', group: 'cloud', kind: 'openai', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, keyUrl: 'https://console.groq.com/keys', note: 'Extremely fast open models (Llama, Qwen…).' },
    { id: 'mistral', group: 'cloud', kind: 'openai', label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys', note: 'Mistral models, EU hosted.' },
    { id: 'deepseek', group: 'cloud', kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', note: 'Low-cost strong models.' },
    { id: 'together', group: 'cloud', kind: 'openai', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', needsKey: true, keyUrl: 'https://api.together.ai/settings/api-keys', note: 'Many open models, hosted.' },
    { id: 'fireworks', group: 'cloud', kind: 'openai', label: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', needsKey: true, keyUrl: 'https://fireworks.ai/account/api-keys', note: 'Fast hosted open models.' },
    { id: 'xai', group: 'cloud', kind: 'openai', label: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', needsKey: true, keyUrl: 'https://console.x.ai', note: 'Grok models.' },
    { id: 'other-cloud', group: 'cloud', kind: 'openai', label: 'Other cloud (OpenAI-compatible)', baseUrl: '', needsKey: true, note: 'Any hosted API that speaks the OpenAI format — its base address ends in /v1.' }
]
export const presetOf = (id) => PRESETS.find(p => p.id === id) || null
// engines added before presets existed
export const legacyPreset = (kind) => ({ ollama: 'ollama', cluster: 'kubeez-addon', anthropic: 'anthropic', gemini: 'gemini', openai: 'other-cloud' })[kind] || null
