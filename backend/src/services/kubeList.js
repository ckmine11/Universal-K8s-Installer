// Reading lists of custom resources (Argo CD, Flux, Trivy…) in one round trip.
// Each list is one marked section; a CRD that is not installed or may not be
// read answers with its error instead, so the caller can say "not installed"
// or "KubeEZ may not read it" rather than "empty".
export const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
export const MAX_BYTES = 8_000_000

/**
 * One section of a script: `==<tag>:<key>==` + the output of
 * `kubectl get <resource> -A <args>`, or `==<tag>:<key>_ERR==` + the error.
 */
export const crdSection = (tag, key, resource, args = '-o json', maxBytes = MAX_BYTES) =>
    `if E=$(${KUBECTL} get ${resource} -A -o name --request-timeout=20s 2>&1 >/dev/null); then echo '==${tag}:${key}=='; ${KUBECTL} get ${resource} -A ${args} --request-timeout=50s 2>/dev/null | head -c ${maxBytes}; echo; else echo '==${tag}:${key}_ERR=='; printf '%s\\n' "$E" | head -c 400; echo; fi`

/** The sections of a script's output → { key: text } */
export function splitSections(out, tag) {
    const s = {}
    const re = new RegExp(`==${tag}:([A-Z_]+)==\\n?([\\s\\S]*?)(?===${tag}:[A-Z_]+==|$)`, 'g')
    let m
    while ((m = re.exec(out || ''))) s[m[1]] = m[2].trim()
    return s
}

/** A kubectl error → { state: 'missing' | 'forbidden' | 'error', message? } */
export function listError(text, resource) {
    const t = String(text || '').trim()
    if (/doesn't have a resource type|could not find the requested resource|no matches for kind|the server could not find/i.test(t)) return { state: 'missing' }
    if (/forbidden/i.test(t)) return { state: 'forbidden', message: `KubeEZ may not read ${resource} on this cluster — give its access read rights on it (Connected clusters → Reconnect updates the access).` }
    return { state: 'error', message: String(t.split('\n').filter(l => !/^Warning:/i.test(l)).join(' ') || 'kubectl failed').slice(0, 300) }
}
