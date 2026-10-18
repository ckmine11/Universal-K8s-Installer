// Secret masking — runs on EVERYTHING before it goes to any AI model.
// Secrets are never collected in the first place (no Secret data, no
// kubeconfigs); this is the second line: anything that looks like a
// credential in logs, events or errors is replaced by a placeholder.
const RULES = [
    // private keys and certificates (whole PEM blocks)
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
    ['certificate', /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '[certificate]'],
    // kubeconfig / k8s fields
    ['kubeconfig', /\b(client-key-data|client-certificate-data|certificate-authority-data|token|id-token|refresh-token)\s*:\s*\S+/gi, '$1: [hidden]'],
    // well-known token formats
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token]'],
    ['aws-key', /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[aws key]'],
    ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[token]'],
    ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[token]'],
    ['api-key', /\b(sk|pk|rk)-(live|test|proj|ant|or)?-?[A-Za-z0-9_-]{16,}\b/g, '[api key]'],
    ['google-key', /\bAIza[0-9A-Za-z_-]{30,}\b/g, '[api key]'],
    ['bearer', /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [hidden]'],
    // user:password@ in connection strings (postgres://u:p@host)
    ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:[hidden]@'],
    // key = value / key: value for secret-ish names — the value on the same line (a YAML key
    // with nothing after it is not one), and a key that only NAMES a secret (secretKeyRef,
    // secretName…) is not one either
    ['secret-field', /\b(?![A-Za-z0-9_.-]*(?:Ref|Name|Names)\b)([A-Za-z0-9_.-]*(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|credentials?)[A-Za-z0-9_.-]*)([ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1$3[hidden]'],
    // long base64 blobs (encoded secrets, certs)
    ['base64-blob', /\b[A-Za-z0-9+/]{120,}={0,2}/g, '[encoded data]']
]
const OPTIONAL = {
    email: ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
    ip: ['ip', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, '[ip]']
}

/**
 * Mask secrets (and optionally emails / IPs).
 * → { text, masked: number, kinds: { name: count } }
 */
export function redact(input, { maskEmails = false, maskIps = false } = {}) {
    let text = String(input ?? '')
    let masked = 0
    const kinds = {}
    const rules = [...RULES, ...(maskEmails ? [OPTIONAL.email] : []), ...(maskIps ? [OPTIONAL.ip] : [])]
    for (const [name, re, rep] of rules) {
        text = text.replace(re, (...m) => {
            masked++; kinds[name] = (kinds[name] || 0) + 1
            return rep.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '')
        })
    }
    return { text, masked, kinds }
}
