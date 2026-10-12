import {
    bad, REPOS, SYSTEM_NAMESPACES, int, oneOf, bool, boolOr, nodePort, safePath, dnsLabel, hostAddress,
    storageField, resolveStorage, storageClassOf, storageCheck, ensureSecret, RANDOM, applyObject,
    nodeSetupDaemonSet, NFS_STORAGE_CLASS
} from './common.js'

// Storage (NFS, volume snapshots), logs (Elasticsearch, Fluentd, Fluent Bit),
// delivery (Harbor, Flux CD, Jenkins) and security (Vault, OPA Gatekeeper,
// Falco, Trivy Operator). Format: config/addons/common.js.

const RANDOM16 = '$(tr -dc A-Za-z0-9 </dev/urandom | head -c 16)'
const managed = { 'app.kubernetes.io/managed-by': 'kubeez' }
// the address people (and nodes) use: the control-plane VIP, else the first control-plane
const clusterAddress = (ctx) => ctx.vip || ctx.nodeIps?.[0] || null

// "a, b c" → ['a', 'b', 'c']
const list = (v) => String(v || '').split(/[\s,]+/).map(x => x.trim()).filter(Boolean)
const gitUrl = (v) => {
    const s = String(v || '').trim()
    if (!s) return ''
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/.test(s) || s.includes('..')) throw bad('Git repository: an https:// address, e.g. https://github.com/org/fleet.git')
    return s
}
const gitRef = (v, label) => {
    const s = String(v || '').trim()
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(s) || s.includes('..')) throw bad(`${label}: letters, numbers and . _ / -`)
    return s
}
const optionalName = (v, label) => String(v || '').trim() ? dnsLabel(String(v).trim(), label) : ''

// ── Elasticsearch (shared by Fluentd and Fluent Bit) ─────────────────────────
const ES = { ns: 'elastic-system', name: 'kubeez', host: 'kubeez-es-http.elastic-system.svc', port: 9200, userSecret: 'kubeez-es-elastic-user' }
/** pre.sh: the Elasticsearch add-on's password, copied into the log shipper's namespace */
const esCredentials = (ns) => [
    `ESP=$(kubectl -n ${ES.ns} get secret ${ES.userSecret} -o jsonpath='{.data.elastic}' 2>/dev/null | base64 -d)`,
    '[ -n "$ESP" ] || fail ES_NOT_READY "The Elasticsearch add-on has no password yet." "Install the Elasticsearch add-on and wait until it is healthy, then apply again."',
    `kubectl get ns ${ns} >/dev/null 2>&1 || kubectl create ns ${ns} >/dev/null`,
    `kubectl -n ${ns} create secret generic kubeez-es-credentials --from-literal=username=elastic --from-literal=password="$ESP" --dry-run=client -o yaml | kubectl apply -f - >/dev/null \\`,
    `    || fail SECRET_FAILED "Could not hand the Elasticsearch password to ${ns}." "Apply again."`,
    'unset ESP'
].join('\n')
const LOG_OUTPUTS = {
    elasticsearch: 'Elasticsearch add-on',
    fluentd: 'Fluentd add-on (forward)',
    external: 'Another Elasticsearch / OpenSearch',
    stdout: 'Only the collector\'s own log (to try it out)'
}
const externalFields = (showIf) => [
    { key: 'host', type: 'text', label: 'Elasticsearch address', default: '', placeholder: 'es.example.com', showIf },
    { key: 'port', type: 'number', label: 'Port', default: 9200, min: 1, max: 65535, showIf },
    { key: 'tls', type: 'bool', label: 'HTTPS', default: true, showIf },
    { key: 'secret', type: 'text', label: 'Secret with username and password', default: '', placeholder: 'es-login', showIf, help: 'Optional: a Secret in this add-on\'s namespace with the keys username and password.' }
]
function validateExternal(s, out) {
    out.host = hostAddress(s.host, 'Elasticsearch address')
    out.port = int(s.port ?? 9200, { min: 1, max: 65535, label: 'Port' })
    out.tls = boolOr(s.tls, true)
    out.secret = optionalName(s.secret, 'Secret')
    return out
}
const indexPrefix = (v) => {
    const s = String(v ?? 'kubeez-logs').trim()
    if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(s)) throw bad('Index prefix: lowercase letters, numbers, - and _')
    return s
}
// env for the shipper: ES_USER / ES_PASSWORD from the right Secret
function esEnv(s) {
    const from = s.output === 'elasticsearch' ? 'kubeez-es-credentials' : s.output === 'external' && s.secret ? s.secret : null
    if (!from) return []
    return ['username', 'password'].map(k => ({ name: k === 'username' ? 'ES_USER' : 'ES_PASSWORD', valueFrom: { secretKeyRef: { name: from, key: k } } }))
}

// Gatekeeper's "rego" field is Rego v0 and allows no imports
const CONTAINERS_REGO = [
    'containers[c] {',
    '\tc := input.review.object.spec.containers[_]',
    '}',
    'containers[c] {',
    '\tc := input.review.object.spec.initContainers[_]',
    '}'
].join('\n')
export const GATEKEEPER_POLICIES = {
    latestTag: {
        kind: 'KubeezDisallowLatest', name: 'kubeez-disallow-latest-tag', label: 'No "latest" or missing image tags',
        rego: [
            CONTAINERS_REGO,
            'fixed(img) {',
            '\tcontains(img, "@")',
            '}',
            'fixed(img) {',
            '\tnot contains(img, "@")',
            '\tregex.match(`:[^/]+$`, img)',
            '\tnot endswith(img, ":latest")',
            '}',
            'violation[{"msg": msg}] {',
            '\tc := containers[_]',
            '\tnot fixed(c.image)',
            '\tmsg := sprintf("container %v uses image %v - use a fixed tag (not latest, not empty)", [c.name, c.image])',
            '}'
        ]
    },
    requestsLimits: {
        kind: 'KubeezRequireResources', name: 'kubeez-require-requests-limits', label: 'CPU / memory requests and a memory limit',
        rego: [
            'violation[{"msg": msg}] {',
            '\tc := input.review.object.spec.containers[_]',
            '\tneed := ["requests.cpu", "requests.memory", "limits.memory"][_]',
            '\tparts := split(need, ".")',
            '\tnot c.resources[parts[0]][parts[1]]',
            '\tmsg := sprintf("container %v has no resources.%v", [c.name, need])',
            '}'
        ]
    },
    privileged: {
        kind: 'KubeezDisallowPrivileged', name: 'kubeez-disallow-privileged', label: 'No privileged containers',
        rego: [
            CONTAINERS_REGO,
            'violation[{"msg": msg}] {',
            '\tc := containers[_]',
            '\tc.securityContext.privileged == true',
            '\tmsg := sprintf("container %v is privileged - full access to the node is not allowed", [c.name])',
            '}'
        ]
    },
    hostNamespaces: {
        kind: 'KubeezDisallowHostNamespaces', name: 'kubeez-disallow-host-namespaces', label: 'No host network / PID / IPC',
        rego: [
            'violation[{"msg": msg}] {',
            '\tf := ["hostNetwork", "hostPID", "hostIPC"][_]',
            '\tinput.review.object.spec[f] == true',
            '\tmsg := sprintf("the pod uses the node\'s %v - not allowed", [f])',
            '}'
        ]
    }
}
const templateName = (p) => p.kind.toLowerCase()
function gatekeeperTemplate(p) {
    return {
        apiVersion: 'templates.gatekeeper.sh/v1', kind: 'ConstraintTemplate',
        metadata: { name: templateName(p), labels: managed, annotations: { 'kubeez.io/title': p.label } },
        spec: {
            crd: { spec: { names: { kind: p.kind } } },
            targets: [{ target: 'admission.k8s.gatekeeper.sh', rego: [`package ${templateName(p)}`, '', ...p.rego].join('\n') }]
        }
    }
}
function gatekeeperConstraint(p, mode) {
    return {
        apiVersion: 'constraints.gatekeeper.sh/v1beta1', kind: p.kind,
        metadata: { name: p.name, labels: managed, annotations: { 'kubeez.io/title': p.label } },
        spec: {
            enforcementAction: mode,
            match: { kinds: [{ apiGroups: [''], kinds: ['Pod'] }], excludedNamespaces: SYSTEM_NAMESPACES }
        }
    }
}

// ── Vault ────────────────────────────────────────────────────────────────────
const VAULT_SH = 'kubectl -n vault exec vault-0 -c vault -- env VAULT_ADDR=http://127.0.0.1:8200'
function vaultPost(s, app) {
    const lines = [
        '# the StatefulSet updates only when the pod is recreated (OnDelete)',
        "REV=$(kubectl -n vault get sts vault -o jsonpath='{.status.updateRevision}' 2>/dev/null)",
        "CUR=$(kubectl -n vault get pod vault-0 -o jsonpath='{.metadata.labels.controller-revision-hash}' 2>/dev/null)",
        'if [ -n "$REV" ] && [ -n "$CUR" ] && [ "$REV" != "$CUR" ]; then',
        '    log "Restarting Vault with the new version / settings..."',
        '    kubectl -n vault delete pod vault-0 --wait=true >/dev/null 2>&1',
        'fi',
        'kubectl -n vault wait pod/vault-0 --for=condition=Ready --timeout=600s >/dev/null 2>&1 \\',
        '    || fail VAULT_NOT_READY "Vault did not start." "Check the add-on\'s Logs and \'kubectl -n vault describe pod vault-0\', then apply again."',
        'vjson() { sed -n "s/.*\\"$1\\": *\\"\\{0,1\\}\\([^\\",]*\\).*/\\1/p" | head -1; }'
    ]
    if (s.mode === 'dev') {
        lines.push(
            "kubectl -n vault get secret kubeez-vault-keys >/dev/null 2>&1 || kubectl -n vault create secret generic kubeez-vault-keys --from-literal=root-token=root >/dev/null",
            'TOKEN=root'
        )
    } else {
        lines.push(
            `ST=$(${VAULT_SH} vault status -format=json 2>/dev/null)`,
            'if [ "$(echo "$ST" | vjson initialized)" = false ]; then',
            '    log "Initializing Vault (1 unseal key)..."',
            `    OUT=$(${VAULT_SH} vault operator init -key-shares=1 -key-threshold=1 -format=json 2>&1) \\`,
            '        || fail VAULT_INIT_FAILED "Vault could not be initialized: $(echo "$OUT" | tail -1)" "Check the add-on\'s Logs, then apply again."',
            '    KEY=$(echo "$OUT" | grep -A1 \'"unseal_keys_b64"\' | tail -1 | tr -d \' ",\')',
            '    TOKEN=$(echo "$OUT" | vjson root_token)',
            '    [ -n "$KEY" ] && [ -n "$TOKEN" ] || fail VAULT_INIT_FAILED "Vault was initialized, but its keys could not be read." "Run \'kubectl -n vault logs vault-0\'; if needed delete the vault namespace and install again."',
            '    kubectl -n vault create secret generic kubeez-vault-keys --from-literal=unseal-key="$KEY" --from-literal=root-token="$TOKEN" >/dev/null \\',
            '        || fail VAULT_INIT_FAILED "Vault was initialized, but the keys could not be saved." "Save this unseal key and root token NOW: $KEY / $TOKEN"',
            '    log "✓ Vault initialized — unseal key and root token are in the Secret vault/kubeez-vault-keys (shown under Access for admins)"',
            '    unset OUT',
            'fi',
            "KEY=$(kubectl -n vault get secret kubeez-vault-keys -o jsonpath='{.data.unseal-key}' 2>/dev/null | base64 -d)",
            "TOKEN=$(kubectl -n vault get secret kubeez-vault-keys -o jsonpath='{.data.root-token}' 2>/dev/null | base64 -d)",
            `if [ "$(${VAULT_SH} vault status -format=json 2>/dev/null | vjson sealed)" = true ]; then`,
            '    [ -n "$KEY" ] || fail VAULT_SEALED "Vault is sealed and KubeEZ does not have its unseal key (it was initialized outside KubeEZ)." "Unseal it with your key: kubectl -n vault exec -ti vault-0 -- vault operator unseal"',
            `    ${VAULT_SH} vault operator unseal "$KEY" >/dev/null 2>&1 || fail VAULT_SEALED "Vault could not be unsealed with the key in vault/kubeez-vault-keys." "Unseal it by hand: kubectl -n vault exec -ti vault-0 -- vault operator unseal"`,
            '    log "✓ Vault unsealed"',
            'fi',
            s.autoUnseal ? 'log "Vault is unsealed again automatically within a minute after a restart"'
                : 'kubectl -n vault delete cronjob kubeez-vault-unseal --ignore-not-found >/dev/null 2>&1; log "Unseal Vault by hand after every restart (the key is under Access)"'
        )
    }
    lines.push(
        '# Kubernetes login for pods, and a key/value store at secret/',
        'if [ -n "$TOKEN" ]; then',
        `    VT() { kubectl -n vault exec vault-0 -c vault -- env VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN="$TOKEN" "$@"; }`,
        '    VT vault auth list 2>/dev/null | grep -q "^kubernetes/" || VT vault auth enable kubernetes >/dev/null 2>&1',
        '    VT vault write auth/kubernetes/config kubernetes_host=https://kubernetes.default.svc:443 >/dev/null 2>&1 && log "✓ Kubernetes login enabled (auth/kubernetes)" || log "⚠ Could not set up the Kubernetes login — do it by hand: vault auth enable kubernetes"',
        '    VT vault secrets list 2>/dev/null | grep -q "^secret/" || VT vault secrets enable -path=secret kv-v2 >/dev/null 2>&1',
        '    VT vault secrets list 2>/dev/null | grep -q "^secret/" && log "✓ Key/value store ready at secret/"',
        'fi',
        `log "Vault ${app}: open the UI under Access (sign in with the root token)"`,
        'unset KEY TOKEN'
    )
    return lines.join('\n')
}
const vaultUnsealJob = (app) => ({
    apiVersion: 'batch/v1', kind: 'CronJob',
    metadata: { name: 'kubeez-vault-unseal', namespace: 'vault', labels: managed },
    spec: {
        schedule: '* * * * *', concurrencyPolicy: 'Forbid', successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 1,
        jobTemplate: {
            spec: {
                backoffLimit: 0, ttlSecondsAfterFinished: 120, activeDeadlineSeconds: 50,
                template: {
                    spec: {
                        restartPolicy: 'Never',
                        containers: [{
                            name: 'unseal', image: `hashicorp/vault:${app}`,
                            env: [
                                { name: 'VAULT_ADDR', value: 'http://vault-0.vault-internal.vault.svc:8200' },
                                { name: 'UNSEAL_KEY', valueFrom: { secretKeyRef: { name: 'kubeez-vault-keys', key: 'unseal-key', optional: true } } }
                            ],
                            command: ['sh', '-c', 'vault status >/dev/null 2>&1; [ $? -eq 2 ] && [ -n "$UNSEAL_KEY" ] && vault operator unseal "$UNSEAL_KEY" >/dev/null && echo "Vault unsealed"; exit 0'],
                            resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '128Mi' } }
                        }]
                    }
                }
            }
        }
    }
})

// ── Harbor ───────────────────────────────────────────────────────────────────
const HARBOR_TLS = 'kubeez-harbor-tls'
function harborPre(s, ctx) {
    const ips = [...new Set([s.address, ctx.vip, ...(ctx.nodeIps || [])].filter(Boolean))]
    const san = ips.map(a => /^\d+\.\d+\.\d+\.\d+$/.test(a) ? `IP:${a}` : `DNS:${a}`).join(',')
    // the exact name in the certificate's list ("IP Address:10.0.0.4" must not match 10.0.0.40)
    const want = `${/^\d+\.\d+\.\d+\.\d+$/.test(s.address) ? 'IP Address:' : 'DNS:'}${s.address.replace(/\./g, '\\.')}(,|$)`
    return [
        storageCheck(s.storage),
        ensureSecret('harbor', 'kubeez-harbor-admin', [['HARBOR_ADMIN_PASSWORD', RANDOM]]),
        ensureSecret('harbor', 'kubeez-harbor-secretkey', [['secretKey', RANDOM16]]),
        '# Harbor\'s certificate: made once by KubeEZ (10 years), so nodes and clients keep trusting it',
        "HAVE=$(kubectl -n harbor get secret " + HARBOR_TLS + " -o jsonpath='{.data.tls\\.crt}' 2>/dev/null | base64 -d 2>/dev/null | openssl x509 -noout -text 2>/dev/null)",
        `if ! echo "$HAVE" | grep -qE "${want}"; then`,
        '    command -v openssl >/dev/null 2>&1 || fail NO_OPENSSL "openssl is not installed on this control-plane — it makes Harbor\'s certificate." "Install openssl (apt/dnf install openssl), then apply again."',
        '    T=$(mktemp -d)',
        '    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=KubeEZ Harbor CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout "$T/ca.key" -out "$T/ca.crt" >/dev/null 2>&1 \\',
        `        && openssl req -newkey rsa:2048 -nodes -subj "/CN=${s.address}" -keyout "$T/tls.key" -out "$T/tls.csr" >/dev/null 2>&1 \\`,
        `        && printf 'subjectAltName=%s\\nextendedKeyUsage=serverAuth\\nbasicConstraints=CA:FALSE\\n' "${san}" > "$T/ext" \\`,
        '        && openssl x509 -req -in "$T/tls.csr" -CA "$T/ca.crt" -CAkey "$T/ca.key" -CAcreateserial -days 3650 -extfile "$T/ext" -out "$T/tls.crt" >/dev/null 2>&1 \\',
        '        || fail TLS_FAILED "Could not create Harbor\'s certificate with openssl." "Check that openssl works on this control-plane, then apply again."',
        `    kubectl -n harbor create secret generic ${HARBOR_TLS} --from-file=tls.crt="$T/tls.crt" --from-file=tls.key="$T/tls.key" --from-file=ca.crt="$T/ca.crt" --dry-run=client -o yaml | kubectl apply -f - >/dev/null \\`,
        '        || fail TLS_FAILED "Could not save Harbor\'s certificate." "Apply again."',
        '    rm -rf "$T"',
        '    HARBOR_TLS_NEW=1',
        `    log "✓ Certificate for ${s.address} created (valid 10 years)"`,
        'fi'
    ].join('\n')
}
// every node: containerd trusts Harbor's certificate (and reads /etc/containerd/certs.d)
const HARBOR_TRUST_SCRIPT = [
    'set -e',
    'D="/host-containerd/certs.d/$REGISTRY"',
    'mkdir -p "$D"',
    'cp /harbor-tls/ca.crt "$D/ca.crt"',
    'printf \'server = "https://%s"\\n\\n[host."https://%s"]\\n  capabilities = ["pull", "resolve", "push"]\\n  ca = "/etc/containerd/certs.d/%s/ca.crt"\\n\' "$REGISTRY" "$REGISTRY" "$REGISTRY" > "$D/hosts.toml"',
    'C=/host-containerd/config.toml',
    'if [ -f "$C" ] && grep -qE "config_path = (\\"\\"|\'\')" "$C"; then',
    '  sed -i -E "s#config_path = (\\"\\"|\'\')#config_path = \\"/etc/containerd/certs.d\\"#" "$C"',
    '  echo "containerd now reads /etc/containerd/certs.d - restarting containerd"',
    '  nsenter -t 1 -m -u -i -n -p -- systemctl restart containerd',
    'elif [ -f "$C" ] && ! grep -q "certs.d" "$C"; then',
    '  echo "WARNING: containerd does not read /etc/containerd/certs.d (config_path) - set it to pull from Harbor"',
    'fi',
    'echo "This node trusts Harbor at $REGISTRY"'
].join('\n')
const harborTrust = (registry) => nodeSetupDaemonSet({
    name: 'kubeez-harbor-trust', ns: 'harbor', script: HARBOR_TRUST_SCRIPT,
    env: [{ name: 'REGISTRY', value: registry }],
    volumes: [
        { name: 'containerd', hostPath: { path: '/etc/containerd', type: 'DirectoryOrCreate' } },
        { name: 'tls', secret: { secretName: HARBOR_TLS, items: [{ key: 'ca.crt', path: 'ca.crt' }] } }
    ],
    mounts: [{ name: 'containerd', mountPath: '/host-containerd' }, { name: 'tls', mountPath: '/harbor-tls', readOnly: true }]
})

// ── NFS client on every node ─────────────────────────────────────────────────
const NFS_CLIENT_SCRIPT = [
    'has() { command -v mount.nfs >/dev/null 2>&1 || [ -x /sbin/mount.nfs ] || [ -x /usr/sbin/mount.nfs ]; }',
    'if has; then echo "NFS client already installed"; exit 0; fi',
    'if command -v apt-get >/dev/null 2>&1; then',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get -o DPkg::Lock::Timeout=300 update -qq && apt-get -o DPkg::Lock::Timeout=300 install -y -qq nfs-common',
    'elif command -v dnf >/dev/null 2>&1; then dnf install -y -q nfs-utils',
    'elif command -v yum >/dev/null 2>&1; then yum install -y -q nfs-utils',
    'elif command -v zypper >/dev/null 2>&1; then zypper -n -q install nfs-client',
    'else echo "No supported package manager - install the NFS client by hand"; exit 1; fi',
    'has && echo "NFS client installed"'
].join('\n')
const nfsClient = () => nodeSetupDaemonSet({
    name: 'kubeez-nfs-client', ns: 'nfs-provisioner',
    script: 'exec nsenter -t 1 -m -u -i -n -p -- sh -c "$HOST_SCRIPT"',
    env: [{ name: 'HOST_SCRIPT', value: NFS_CLIENT_SCRIPT }]
})

const NODE_PORT = (key, label, dflt, extra = {}) => ({ key, type: 'number', label, default: dflt, min: 30000, max: 32767, ...extra })
const port = (v, label) => int(v, { min: 30000, max: 32767, label })

// ── The add-ons ──────────────────────────────────────────────────────────────
export const PLATFORM_ADDONS = {
    'nfs-provisioner': {
        label: 'NFS storage', ns: 'nfs-provisioner', detect: 'deploy/nfs-provisioner', tier: 'pro', needsSettings: true,
        summary: 'Volumes on your NFS server through the StorageClass "nfs-client", including shared (ReadWriteMany) volumes.',
        example: { server: '192.0.2.50', path: '/exports/k8s' },
        versions: [
            { id: '4.0.18', app: 'v4.0.2', charts: { 'nfs-subdir-external-provisioner': '4.0.18' } }
        ],
        fields: [
            { key: 'server', type: 'text', label: 'NFS server', default: '', placeholder: '192.168.1.50', help: 'IP or DNS name. Every node must reach it on port 2049.' },
            { key: 'path', type: 'text', label: 'Exported folder', default: '', placeholder: '/exports/k8s', help: 'Exported read-write (rw, no_root_squash) to the nodes. Each volume becomes a sub-folder.' },
            { key: 'nfsVersion', type: 'select', label: 'NFS version', default: 'auto', options: [['auto', 'Let the server choose'], ['4.2', 'NFS 4.2'], ['4.1', 'NFS 4.1'], ['3', 'NFS 3']] },
            { key: 'defaultClass', type: 'bool', label: 'Default StorageClass', default: false, help: 'Volumes that name no StorageClass are created on NFS.' },
            { key: 'reclaimPolicy', type: 'select', label: 'When a volume is deleted', default: 'Delete', options: [['Delete', 'Remove it'], ['Retain', 'Keep its folder']] },
            { key: 'archiveOnDelete', type: 'bool', label: 'Keep a copy of deleted volumes (archived-… folder)', default: true, showIf: { reclaimPolicy: 'Delete' } },
            { key: 'installClient', type: 'bool', label: 'Install the NFS client on every node', default: true, help: 'nfs-common / nfs-utils, needed to mount NFS. Off: install it yourself.' }
        ],
        validate: (s) => ({
            server: hostAddress(s.server, 'NFS server'),
            path: String(s.path || '').trim() === '/' ? '/' : safePath(s.path, 'Exported folder'),   // "/" = the NFSv4 root export
            nfsVersion: oneOf(String(s.nfsVersion || 'auto'), ['auto', '4.2', '4.1', '3'], 'NFS version'),
            defaultClass: boolOr(s.defaultClass, false),
            reclaimPolicy: oneOf(s.reclaimPolicy || 'Delete', ['Delete', 'Retain'], 'When a volume is deleted'),
            archiveOnDelete: boolOr(s.archiveOnDelete, true),
            installClient: boolOr(s.installClient, true)
        }),
        releases: (s, ctx, v) => [{
            name: 'nfs-provisioner', repo: REPOS['nfs-subdir'], chart: 'nfs-subdir-external-provisioner', version: v.charts['nfs-subdir-external-provisioner'],
            values: {
                fullnameOverride: 'nfs-provisioner',
                nfs: { server: s.server, path: s.path, mountOptions: s.nfsVersion === 'auto' ? null : [`nfsvers=${s.nfsVersion}`] },
                storageClass: {
                    create: true, name: NFS_STORAGE_CLASS, defaultClass: s.defaultClass, reclaimPolicy: s.reclaimPolicy,
                    archiveOnDelete: s.archiveOnDelete, allowVolumeExpansion: true, accessModes: 'ReadWriteMany'
                },
                resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '128Mi' } }
            }
        }],
        pre: (s) => {
            const opts = s.nfsVersion === 'auto' ? '' : `-o nfsvers=${s.nfsVersion} `
            const sc = `${s.reclaimPolicy}|${s.archiveOnDelete}`
            return [
                `timeout 5 bash -c "</dev/tcp/${s.server}/2049" 2>/dev/null \\`,
                `    || fail NFS_UNREACHABLE "The NFS server ${s.server} does not answer on port 2049 from this control-plane." "Check the address, that the NFS service runs and that the firewall allows port 2049 from every node."`,
                'kubectl get ns nfs-provisioner >/dev/null 2>&1 || kubectl create ns nfs-provisioner >/dev/null',
                ...(s.installClient ? [
                    'log "Installing the NFS client on every node (if missing)..."',
                    applyObject(nfsClient(), 'NFS client installer'),
                    'if ! kubectl -n nfs-provisioner rollout status ds/kubeez-nfs-client --timeout=600s >/dev/null 2>&1; then',
                    '    kubectl -n nfs-provisioner logs -l app=kubeez-nfs-client -c setup --tail=5 --prefix 2>/dev/null | sed "s/^/  /"',
                    '    fail NFS_CLIENT_MISSING "The NFS client could not be installed on every node (log above)." "Install nfs-common (Ubuntu/Debian) or nfs-utils (RHEL family) on the nodes, then apply again."',
                    'fi',
                    'log "✓ NFS client on every node"'
                ] : ['kubectl -n nfs-provisioner delete ds kubeez-nfs-client --ignore-not-found >/dev/null 2>&1']),
                '# a test mount from this control-plane: the folder exists and is writable',
                'command -v mount.nfs >/dev/null 2>&1 || [ -x /sbin/mount.nfs ] || [ -x /usr/sbin/mount.nfs ] \\',
                '    || fail NFS_CLIENT_MISSING "This control-plane has no NFS client." "Turn on \\"Install the NFS client on every node\\", or install nfs-common / nfs-utils, then apply again."',
                'T=$(mktemp -d)',
                `if timeout 60 mount -t nfs ${opts}"${s.server}:${s.path}" "$T" 2>/tmp/kubeez-nfs.err; then`,
                '    W=""; touch "$T/.kubeez-write-test" 2>/dev/null && rm -f "$T/.kubeez-write-test" && W=1',
                '    umount "$T" 2>/dev/null; rmdir "$T"',
                `    [ -n "$W" ] || fail NFS_READ_ONLY "${s.server}:${s.path} mounts, but is not writable." "Export it read-write with no_root_squash on the NFS server, then apply again."`,
                'else',
                '    rmdir "$T" 2>/dev/null',
                `    fail NFS_MOUNT_FAILED "Could not mount ${s.server}:${s.path}: $(tail -1 /tmp/kubeez-nfs.err)" "Check the export on the server (exportfs -v): it must exist and allow the nodes' addresses. Then apply again."`,
                'fi',
                `log "✓ ${s.server}:${s.path} mounts and is writable"`,
                '# StorageClass settings cannot change in place — it is recreated (volumes keep working)',
                `CUR=$(kubectl get sc ${NFS_STORAGE_CLASS} -o jsonpath='{.reclaimPolicy}|{.parameters.archiveOnDelete}' 2>/dev/null)`,
                `if [ -n "$CUR" ] && [ "$CUR" != "${sc}" ]; then`,
                `    kubectl delete sc ${NFS_STORAGE_CLASS} >/dev/null 2>&1 && log "StorageClass ${NFS_STORAGE_CLASS} is recreated with the new settings (existing volumes keep working)"`,
                'fi',
                ...(s.defaultClass ? [
                    `OTHER=$(kubectl get sc -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class=="true")]}{.metadata.name} {end}' 2>/dev/null | tr ' ' '\\n' | grep -vx '${NFS_STORAGE_CLASS}' | grep .)`,
                    '[ -z "$OTHER" ] || log "⚠ $OTHER is also a default StorageClass — Kubernetes then picks the newest; unset one of them"'
                ] : [])
            ].join('\n')
        },
        post: (s) => ({
            manifests: [],
            script: [
                // a volume really gets created on the share
                'cat <<\'KUBEEZ_PVC\' | kubectl apply -f - >/dev/null',
                JSON.stringify({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'kubeez-nfs-test', namespace: 'nfs-provisioner' }, spec: { storageClassName: NFS_STORAGE_CLASS, accessModes: ['ReadWriteMany'], resources: { requests: { storage: '1Mi' } } } }),
                'KUBEEZ_PVC',
                'B=""',
                'for _ in $(seq 1 24); do',
                '    [ "$(kubectl -n nfs-provisioner get pvc kubeez-nfs-test -o jsonpath={.status.phase} 2>/dev/null)" = Bound ] && { B=1; break; }',
                '    sleep 5',
                'done',
                'kubectl -n nfs-provisioner delete pvc kubeez-nfs-test --ignore-not-found --timeout=60s >/dev/null 2>&1',
                `[ -n "$B" ] || fail NFS_PROVISION_FAILED "The test volume was not created on the NFS share." "Check the add-on's Logs (permission on the exported folder?), then apply again."`,
                '# leave nothing behind on the share (the test folder, or its archived copy)',
                'sleep 5',
                'T=$(mktemp -d)',
                `if timeout 60 mount -t nfs ${s.nfsVersion === 'auto' ? '' : `-o nfsvers=${s.nfsVersion} `}"${s.server}:${s.path}" "$T" 2>/dev/null; then`,
                '    rm -rf "$T"/nfs-provisioner-kubeez-nfs-test-* "$T"/archived-nfs-provisioner-kubeez-nfs-test-* 2>/dev/null',
                '    umount "$T" 2>/dev/null',
                'fi',
                'rmdir "$T" 2>/dev/null',
                `log "✓ StorageClass ${NFS_STORAGE_CLASS} creates volumes on ${s.server}:${s.path}"`
            ].join('\n')
        }),
        locked: { 'nfs-provisioner': ['fullnameOverride', 'storageClass.name'] },
        uninstallNote: 'The StorageClass nfs-client is removed. Refused while volumes on NFS exist; the data on the NFS server is never deleted.'
    },

    'snapshot-controller': {
        label: 'Volume snapshots', ns: 'snapshot-controller', detect: 'deploy/snapshot-controller', probe: 'deploy/snapshot-controller', tier: 'pro',
        summary: 'Point-in-time copies of volumes (VolumeSnapshot): Longhorn snapshots, and CSI backups with Velero.',
        versions: [
            { id: '5.3.0', app: 'v8.6.0', charts: { 'snapshot-controller': '5.3.0' }, kube: [25, 99] },
            { id: '5.0.4', app: 'v8.5.0', charts: { 'snapshot-controller': '5.0.4' }, kube: [25, 99] }
        ],
        fields: [
            { key: 'replicas', type: 'select', label: 'Controller', default: '1', options: [['1', '1 replica'], ['2', '2 replicas (high availability)']] },
            { key: 'longhornClass', type: 'bool', label: 'Snapshot class for Longhorn (when Longhorn is installed)', default: true },
            { key: 'defaultClass', type: 'bool', label: 'Make it the default snapshot class', default: true, showIf: { longhornClass: true } }
        ],
        validate: (s) => ({
            replicas: Number(oneOf(String(s.replicas ?? '1'), ['1', '2'], 'Controller')),
            longhornClass: boolOr(s.longhornClass, true),
            defaultClass: boolOr(s.defaultClass, true)
        }),
        releases: (s, ctx, v) => [{
            name: 'snapshot-controller', repo: REPOS.piraeus, chart: 'snapshot-controller', version: v.charts['snapshot-controller'],
            values: {
                // snapshots survive an uninstall of the controller
                keepCRDs: true,
                controller: { replicaCount: s.replicas, fullnameOverride: 'snapshot-controller', resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '256Mi' } } },
                webhook: { enabled: false }
            }
        }],
        pre: () => [
            "OTHER=$(kubectl get deploy -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{\"\\n\"}{end}' 2>/dev/null | grep -E '/(csi-)?snapshot-controller$' | grep -v '^snapshot-controller/')",
            '[ -z "$OTHER" ] || fail SNAPSHOT_CONTROLLER_EXISTS "A snapshot controller already runs: $OTHER." "Snapshots work already. Two controllers would fight over the same snapshots — keep yours, or remove it first."',
            '# CRDs installed earlier by someone else: Helm takes them over (snapshots stay)',
            'for crd in volumesnapshotclasses.snapshot.storage.k8s.io volumesnapshotcontents.snapshot.storage.k8s.io volumesnapshots.snapshot.storage.k8s.io \\',
            '           volumegroupsnapshotclasses.groupsnapshot.storage.k8s.io volumegroupsnapshotcontents.groupsnapshot.storage.k8s.io volumegroupsnapshots.groupsnapshot.storage.k8s.io; do',
            '    kubectl get crd "$crd" >/dev/null 2>&1 || continue',
            "    [ \"$(kubectl get crd \"$crd\" -o jsonpath='{.metadata.annotations.meta\\.helm\\.sh/release-name}')\" = snapshot-controller ] && continue",
            '    kubectl label crd "$crd" app.kubernetes.io/managed-by=Helm --overwrite >/dev/null',
            '    kubectl annotate crd "$crd" meta.helm.sh/release-name=snapshot-controller meta.helm.sh/release-namespace=snapshot-controller --overwrite >/dev/null',
            '    log "The existing $crd is taken over (snapshots kept)"',
            'done'
        ].join('\n'),
        post: (s) => {
            const vsc = {
                apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotClass',
                metadata: { name: 'longhorn-snapshot', labels: { ...managed, 'velero.io/csi-volumesnapshot-class': 'true' }, annotations: { 'snapshot.storage.kubernetes.io/is-default-class': String(s.defaultClass) } },
                driver: 'driver.longhorn.io', deletionPolicy: 'Delete', parameters: { type: 'snap' }
            }
            return {
                manifests: [],
                script: s.longhornClass ? [
                    'if kubectl get csidriver driver.longhorn.io >/dev/null 2>&1; then',
                    applyObject(vsc, 'Longhorn snapshot class'),
                    '    log "✓ Snapshot class longhorn-snapshot (Longhorn)"',
                    'else',
                    '    log "Longhorn is not installed — apply again after installing it to get a Longhorn snapshot class"',
                    'fi'
                ].join('\n') : 'kubectl delete volumesnapshotclass longhorn-snapshot --ignore-not-found >/dev/null 2>&1 || true'
            }
        },
        locked: { 'snapshot-controller': ['keepCRDs', 'controller.fullnameOverride'] },
        uninstallNote: 'The controller stops; existing snapshots and their classes stay (the snapshot CRDs are kept while snapshots exist).'
    },

    elasticsearch: {
        label: 'Elasticsearch', ns: ES.ns, detect: 'sts/elastic-operator', probe: 'sts/kubeez-es-default', tier: 'pro', keepsData: true,
        summary: 'Search and log storage (Elastic Stack through the official ECK operator), with Kibana to explore it.',
        // the Elastic Stack version is the add-on's version; the operator chart follows its newest release
        appSource: {
            url: 'https://artifacts-api.elastic.co/v1/versions',
            releases: (text) => (JSON.parse(text).versions || []).map(v => ({ version: v, appVersion: v }))
        },
        versions: [
            { id: '9.5.5', app: '9.5.5', charts: { 'eck-operator': '3.5.0' } },
            { id: '8.19.23', app: '8.19.23', charts: { 'eck-operator': '3.5.0' } }
        ],
        fields: [
            { key: 'nodes', type: 'select', label: 'Elasticsearch nodes', default: '1', options: [['1', '1 (single node)'], ['3', '3 (high availability)']] },
            { key: 'memory', type: 'select', label: 'Memory per node', default: '2', options: [['2', '2 GiB'], ['4', '4 GiB'], ['8', '8 GiB'], ['16', '16 GiB']], help: 'Half of it becomes the Java heap.' },
            storageField('Where data is stored'),
            { key: 'sizeGi', type: 'number', label: 'Disk per node', unit: 'GiB', default: 20, min: 1, max: 4000, help: 'Can grow later (if the StorageClass allows), never shrink.' },
            { key: 'kibana', type: 'bool', label: 'Kibana (web UI)', default: true },
            NODE_PORT('kibanaPort', 'Kibana node port', 30561, { showIf: { kibana: true } }),
            { key: 'apiPort', type: 'number', label: 'API node port', default: 0, min: 0, max: 32767, help: '0 = only inside the cluster: http://kubeez-es-http.elastic-system:9200' }
        ],
        validate: (s, ctx) => ({
            nodes: Number(oneOf(String(s.nodes ?? '1'), ['1', '3'], 'Elasticsearch nodes')),
            memory: Number(oneOf(String(s.memory ?? '2'), ['2', '4', '8', '16'], 'Memory per node')),
            storage: resolveStorage(s.storage, ctx),
            sizeGi: int(s.sizeGi ?? 20, { min: 1, max: 4000, label: 'Disk per node (GiB)' }),
            kibana: boolOr(s.kibana, true),
            kibanaPort: port(s.kibanaPort ?? 30561, 'Kibana node port'),
            apiPort: nodePort(s.apiPort, 'API node port')
        }),
        releases: (s, ctx, v) => [{
            name: 'elastic-operator', repo: REPOS.elastic, chart: 'eck-operator', version: v.charts['eck-operator'], clientSide: true,
            values: {
                installCRDs: true,
                telemetry: { disabled: true },
                resources: { requests: { cpu: '50m', memory: '150Mi' }, limits: { memory: '512Mi' } }
            }
        }],
        pre: (s) => storageCheck(s.storage),
        post: (s, ctx, v) => {
            const sc = storageClassOf(s.storage)
            const persist = s.storage !== 'node'
            const mem = `${s.memory}Gi`
            const es = {
                apiVersion: 'elasticsearch.k8s.elastic.co/v1', kind: 'Elasticsearch',
                metadata: { name: ES.name, namespace: ES.ns, labels: managed },
                spec: {
                    version: v.app,
                    http: {
                        tls: { selfSignedCertificate: { disabled: true } },
                        ...(s.apiPort ? { service: { spec: { type: 'NodePort', ports: [{ name: 'http', port: 9200, targetPort: 9200, nodePort: s.apiPort }] } } } : {})
                    },
                    nodeSets: [{
                        name: 'default', count: s.nodes,
                        // no vm.max_map_count change needed on the nodes
                        config: { 'node.store.allow_mmap': false },
                        podTemplate: {
                            spec: {
                                containers: [{ name: 'elasticsearch', resources: { requests: { cpu: '250m', memory: mem }, limits: { memory: mem } } }],
                                ...(persist ? {} : { volumes: [{ name: 'elasticsearch-data', emptyDir: {} }] })
                            }
                        },
                        ...(persist ? {
                            volumeClaimTemplates: [{
                                metadata: { name: 'elasticsearch-data' },
                                spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: `${s.sizeGi}Gi` } }, ...(sc ? { storageClassName: sc } : {}) }
                            }]
                        } : {})
                    }]
                }
            }
            const kb = {
                apiVersion: 'kibana.k8s.elastic.co/v1', kind: 'Kibana',
                metadata: { name: ES.name, namespace: ES.ns, labels: managed },
                spec: {
                    version: v.app, count: 1, elasticsearchRef: { name: ES.name },
                    http: { tls: { selfSignedCertificate: { disabled: true } }, service: { spec: { type: 'NodePort', ports: [{ name: 'http', port: 5601, targetPort: 5601, nodePort: s.kibanaPort }] } } },
                    podTemplate: { spec: { containers: [{ name: 'kibana', resources: { requests: { cpu: '100m', memory: '1Gi' }, limits: { memory: '1Gi' } } }] } }
                }
            }
            const script = [
                ...(s.kibana ? [] : [`kubectl -n ${ES.ns} delete kibana.kibana.k8s.elastic.co ${ES.name} --ignore-not-found >/dev/null 2>&1 || true`]),
                `log "Waiting for Elasticsearch ${v.app} (the first start downloads about 700 MB)..."`,
                'H=""',
                'for i in $(seq 1 90); do',
                `    H=$(kubectl -n ${ES.ns} get elasticsearch ${ES.name} -o jsonpath='{.status.health}|{.status.version}' 2>/dev/null)`,
                `    case "$H" in green\\|${v.app}|yellow\\|${v.app}) break ;; esac`,
                '    [ $((i % 6)) -eq 0 ] && log "…still starting ($((i * 10))s, health: ${H%%|*})"',
                '    sleep 10',
                'done',
                `case "$H" in green\\|*|yellow\\|*) log "✓ Elasticsearch ${v.app} ready (health ${'$'}{H%%|*})" ;; *)`,
                `    kubectl -n ${ES.ns} get pods 2>/dev/null | sed 's/^/  /'`,
                `    kubectl -n ${ES.ns} get events --sort-by=.lastTimestamp 2>/dev/null | tail -5 | sed 's/^/  /'`,
                '    fail ES_NOT_READY "Elasticsearch did not become ready within 15 minutes (pods and events above)." "Usually memory or storage: check the pods above, change Memory or Storage, then apply again." ;;',
                'esac'
            ]
            if (s.kibana) script.push(
                'for i in $(seq 1 60); do',
                `    [ "$(kubectl -n ${ES.ns} get kibana ${ES.name} -o jsonpath='{.status.health}' 2>/dev/null)" = green ] && { log "✓ Kibana ready on port ${s.kibanaPort} (user elastic — password under Access)"; break; }`,
                `    [ "$i" = 60 ] && log "⚠ Kibana is not ready yet — it may need a few more minutes (kubectl -n ${ES.ns} get kibana)"`,
                '    sleep 10',
                'done'
            )
            return { manifests: s.kibana ? [es, kb] : [es], script: script.join('\n') }
        },
        locked: { 'elastic-operator': ['installCRDs'] },
        uninstallNote: 'Elasticsearch, Kibana and all indexed data are deleted.'
    },

    fluentd: {
        label: 'Fluentd', ns: 'fluentd', detect: 'svc/fluentd', tier: 'pro',
        summary: 'Log router: receives logs from Fluent Bit (or reads them on every node) and sends them to Elasticsearch.',
        versions: [
            { id: '0.6.0', app: '1.19.3', charts: { fluentd: '0.6.0' } }
        ],
        fields: [
            { key: 'role', type: 'select', label: 'Role', default: 'aggregator', options: [['aggregator', 'Aggregator — receives logs from Fluent Bit (port 24224)'], ['collector', 'Collector — reads the logs on every node itself']] },
            { key: 'replicas', type: 'number', label: 'Replicas', default: 1, min: 1, max: 5, showIf: { role: 'aggregator' } },
            { key: 'output', type: 'select', label: 'Send logs to', default: 'auto', options: [['auto', 'Elasticsearch add-on if installed, else Fluentd\'s own log'], ['elasticsearch', LOG_OUTPUTS.elasticsearch], ['external', LOG_OUTPUTS.external], ['stdout', LOG_OUTPUTS.stdout]] },
            ...externalFields({ output: 'external' }),
            { key: 'index', type: 'text', label: 'Index prefix', default: 'kubeez-logs', showIf: { output: ['auto', 'elasticsearch', 'external'] }, help: 'One index per day, e.g. kubeez-logs-2026.10.12' }
        ],
        validate: (s, ctx) => {
            const role = oneOf(s.role || 'aggregator', ['aggregator', 'collector'], 'Role')
            let output = oneOf(s.output || 'auto', ['auto', 'elasticsearch', 'external', 'stdout'], 'Send logs to')
            if (output === 'auto') output = ctx.addons?.elasticsearch ? 'elasticsearch' : 'stdout'
            if (output === 'elasticsearch' && !ctx.addons?.elasticsearch) throw bad('Send logs to: the Elasticsearch add-on is not installed — install it first or choose another target')
            const out = { role, replicas: int(s.replicas ?? 1, { min: 1, max: 5, label: 'Replicas' }), output, index: indexPrefix(s.index) }
            return output === 'external' ? validateExternal(s, out) : out
        },
        releases: (s, ctx, v) => {
            const es = s.output === 'elasticsearch' || s.output === 'external'
            const target = s.output === 'elasticsearch' ? { host: ES.host, port: ES.port, scheme: 'http', auth: true }
                : { host: s.host, port: s.port, scheme: s.tls ? 'https' : 'http', auth: !!s.secret }
            const output = es ? [
                '<label @OUTPUT>',
                '  <match **>',
                '    @type elasticsearch',
                `    host ${target.host}`,
                `    port ${target.port}`,
                `    scheme ${target.scheme}`,
                ...(target.auth ? ['    user "#{ENV[\'ES_USER\']}"', '    password "#{ENV[\'ES_PASSWORD\']}"'] : []),
                '    logstash_format true',
                `    logstash_prefix ${s.index}`,
                '    suppress_type_name true',
                '    verify_es_version_at_startup false',
                '    default_elasticsearch_version 8',
                '    reconnect_on_error true',
                '    reload_on_failure false',
                '    reload_connections false',
                '    request_timeout 30s',
                '    <buffer>',
                '      @type memory',
                '      flush_interval 5s',
                '      chunk_limit_size 8M',
                '      total_limit_size 256M',
                '      overflow_action drop_oldest_chunk',
                '      retry_max_interval 30',
                '    </buffer>',
                '  </match>',
                '</label>'
            ].join('\n') : ['<label @OUTPUT>', '  <match **>', '    @type stdout', '  </match>', '</label>'].join('\n')
            const aggregator = s.role === 'aggregator'
            return [{
                name: 'fluentd', repo: REPOS.fluent, chart: 'fluentd', version: v.charts.fluentd,
                values: {
                    kind: aggregator ? 'Deployment' : 'DaemonSet',
                    replicaCount: s.replicas,
                    variant: 'elasticsearch8',
                    podSecurityPolicy: { enabled: false },
                    mountVarLogDirectory: !aggregator,
                    mountDockerContainersDirectory: !aggregator,
                    ...(aggregator ? {} : { tolerations: [{ operator: 'Exists' }] }),
                    resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '512Mi' } },
                    env: esEnv(s),
                    service: { type: 'ClusterIP', ports: aggregator ? [{ name: 'forward', protocol: 'TCP', containerPort: 24224 }] : [] },
                    dashboards: { enabled: false },
                    fileConfigs: {
                        ...(aggregator ? {
                            '01_sources.conf': [
                                '<source>',
                                '  @type forward',
                                '  @label @DISPATCH',
                                '  port 24224',
                                '  bind 0.0.0.0',
                                '</source>',
                                '<source>',
                                '  @type prometheus',
                                '  bind 0.0.0.0',
                                '  port 24231',
                                '  metrics_path /metrics',
                                '</source>'
                            ].join('\n')
                        } : {}),
                        '04_outputs.conf': output
                    }
                }
            }]
        },
        pre: (s) => s.output === 'elasticsearch' ? esCredentials('fluentd') : '',
        post: (s) => ({
            manifests: [],
            script: s.role === 'aggregator'
                ? 'log "✓ Fluentd receives logs on fluentd.fluentd.svc:24224 (choose \\"Fluentd add-on\\" in Fluent Bit to send them here)"'
                : 'log "✓ Fluentd reads the logs of every pod on every node"'
        }),
        uninstallNote: 'Logs stop flowing through Fluentd; what was already sent stays where it is.'
    },

    'fluent-bit': {
        label: 'Fluent Bit', ns: 'fluent-bit', detect: 'ds/kubeez-fluent-bit', probe: 'ds/kubeez-fluent-bit', tier: 'pro',
        summary: 'Lightweight log collector on every node: sends pod logs to Elasticsearch, Fluentd or another Elasticsearch.',
        versions: [
            { id: '0.58.3', app: '5.1.3', charts: { 'fluent-bit': '0.58.3' } },
            { id: '0.57.9', app: '5.0.9', charts: { 'fluent-bit': '0.57.9' } }
        ],
        fields: [
            { key: 'output', type: 'select', label: 'Send logs to', default: 'auto', options: [['auto', 'Elasticsearch, else Fluentd if installed, else its own log'], ['elasticsearch', LOG_OUTPUTS.elasticsearch], ['fluentd', LOG_OUTPUTS.fluentd], ['external', LOG_OUTPUTS.external], ['stdout', LOG_OUTPUTS.stdout]], help: 'For logs in Grafana, install "Loki logs" instead — it brings its own Fluent Bit.' },
            ...externalFields({ output: 'external' }),
            { key: 'index', type: 'text', label: 'Index prefix', default: 'kubeez-logs', showIf: { output: ['auto', 'elasticsearch', 'external'] } },
            { key: 'systemd', type: 'bool', label: 'Also collect kubelet and containerd logs (journal)', default: false }
        ],
        validate: (s, ctx) => {
            let output = oneOf(s.output || 'auto', ['auto', 'elasticsearch', 'fluentd', 'external', 'stdout'], 'Send logs to')
            if (output === 'auto') output = ctx.addons?.elasticsearch ? 'elasticsearch' : ctx.addons?.fluentd ? 'fluentd' : 'stdout'
            if (output === 'elasticsearch' && !ctx.addons?.elasticsearch) throw bad('Send logs to: the Elasticsearch add-on is not installed — install it first or choose another target')
            if (output === 'fluentd' && !ctx.addons?.fluentd) throw bad('Send logs to: the Fluentd add-on is not installed — install it first (role Aggregator) or choose another target')
            const out = { output, index: indexPrefix(s.index), systemd: boolOr(s.systemd, false) }
            return output === 'external' ? validateExternal(s, out) : out
        },
        releases: (s, ctx, v) => {
            const esOut = (host, port, tls, auth) => [
                '[OUTPUT]',
                '    Name es',
                '    Match *',
                `    Host ${host}`,
                `    Port ${port}`,
                ...(tls ? ['    tls On', '    tls.verify On'] : []),
                ...(auth ? ['    HTTP_User ${ES_USER}', '    HTTP_Passwd ${ES_PASSWORD}'] : []),
                '    Logstash_Format On',
                `    Logstash_Prefix ${s.index}`,
                '    Suppress_Type_Name On',
                '    Replace_Dots On',
                '    Trace_Error On',
                '    Retry_Limit 5',
                ''
            ]
            const outputs = s.output === 'elasticsearch' ? esOut(ES.host, ES.port, false, true)
                : s.output === 'external' ? esOut(s.host, s.port, s.tls, !!s.secret)
                    : s.output === 'fluentd' ? ['[OUTPUT]', '    Name forward', '    Match *', '    Host fluentd.fluentd.svc', '    Port 24224', '    Retry_Limit 5', '']
                        : ['[OUTPUT]', '    Name stdout', '    Match *', '    Format json_lines', '']
            return [{
                name: 'kubeez-fluent-bit', repo: REPOS.fluent, chart: 'fluent-bit', version: v.charts['fluent-bit'],
                values: {
                    fullnameOverride: 'kubeez-fluent-bit',
                    tolerations: [{ operator: 'Exists' }],
                    resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
                    env: esEnv(s),
                    config: {
                        inputs: [
                            '[INPUT]',
                            '    Name tail',
                            '    Path /var/log/containers/*.log',
                            '    Exclude_Path /var/log/containers/kubeez-fluent-bit-*.log,/var/log/containers/fluent-bit-*.log',
                            '    multiline.parser docker, cri',
                            '    Tag kube.*',
                            '    DB /var/log/kubeez-fluent-bit-ship.db',
                            '    Mem_Buf_Limit 5MB',
                            '    Skip_Long_Lines On',
                            '',
                            ...(s.systemd ? ['[INPUT]', '    Name systemd', '    Tag host.*', '    Systemd_Filter _SYSTEMD_UNIT=kubelet.service', '    Systemd_Filter _SYSTEMD_UNIT=containerd.service', '    Read_From_Tail On', ''] : [])
                        ].join('\n'),
                        filters: [
                            '[FILTER]',
                            '    Name kubernetes',
                            '    Match kube.*',
                            '    Merge_Log On',
                            '    Keep_Log Off',
                            '    K8S-Logging.Parser On',
                            '    K8S-Logging.Exclude On',
                            ''
                        ].join('\n'),
                        outputs: outputs.join('\n')
                    }
                }
            }]
        },
        pre: (s) => s.output === 'elasticsearch' ? esCredentials('fluent-bit') : '',
        locked: { 'kubeez-fluent-bit': ['fullnameOverride'] },
        uninstallNote: 'Logs stop being collected; what was already sent stays where it is.'
    },

    harbor: {
        label: 'Harbor registry', ns: 'harbor', detect: 'deploy/harbor-core', probe: 'deploy/harbor-core', tier: 'pro', keepsData: true,
        summary: 'Your own container registry: projects, users, vulnerability scans (Trivy). Nodes of this cluster pull from it directly.',
        versions: [
            { id: '1.19.2', app: 'v2.15.2', charts: { harbor: '1.19.2' } },
            { id: '1.18.4', app: 'v2.14.4', charts: { harbor: '1.18.4' } }
        ],
        fields: [
            { key: 'address', type: 'text', label: 'Address', default: '', placeholder: 'empty = the control-plane IP', help: 'IP or DNS name people and nodes use to reach Harbor. Empty: the control-plane virtual IP, else the first control-plane.' },
            NODE_PORT('httpsPort', 'HTTPS node port', 30003),
            storageField('Where images are stored'),
            { key: 'registryGi', type: 'number', label: 'Disk for images', unit: 'GiB', default: 20, min: 1, max: 4000 },
            { key: 'trivy', type: 'bool', label: 'Scan images for vulnerabilities (Trivy)', default: true },
            { key: 'trustNodes', type: 'bool', label: 'Nodes of this cluster can pull from Harbor', default: true, help: 'Installs Harbor\'s certificate for containerd on every node (containerd restarts once; running pods are not affected).' }
        ],
        validate: (s, ctx) => {
            const address = String(s.address || '').trim() ? hostAddress(s.address, 'Address') : clusterAddress(ctx)
            if (!address) throw bad('Address: enter the IP or DNS name of the cluster')
            return {
                address,
                httpsPort: port(s.httpsPort ?? 30003, 'HTTPS node port'),
                storage: resolveStorage(s.storage, ctx),
                registryGi: int(s.registryGi ?? 20, { min: 1, max: 4000, label: 'Disk for images (GiB)' }),
                trivy: boolOr(s.trivy, true),
                trustNodes: boolOr(s.trustNodes, true)
            }
        },
        releases: (s, ctx, v) => {
            const persist = s.storage !== 'node'
            const sc = storageClassOf(s.storage) || ''
            return [{
                name: 'harbor', repo: REPOS.harbor, chart: 'harbor', version: v.charts.harbor, slow: true,
                values: {
                    expose: {
                        type: 'nodePort',
                        tls: { enabled: true, certSource: 'secret', secret: { secretName: HARBOR_TLS } },
                        nodePort: { name: 'harbor', ports: { http: { port: 80, nodePort: null }, https: { port: 443, nodePort: s.httpsPort } } }
                    },
                    externalURL: `https://${s.address}:${s.httpsPort}`,
                    caSecretName: HARBOR_TLS,
                    existingSecretAdminPassword: 'kubeez-harbor-admin',
                    existingSecretAdminPasswordKey: 'HARBOR_ADMIN_PASSWORD',
                    existingSecretSecretKey: 'kubeez-harbor-secretkey',
                    persistence: {
                        enabled: persist,
                        resourcePolicy: 'keep',
                        persistentVolumeClaim: {
                            registry: { storageClass: sc, size: `${s.registryGi}Gi` },
                            jobservice: { jobLog: { storageClass: sc } },
                            database: { storageClass: sc },
                            redis: { storageClass: sc },
                            trivy: { storageClass: sc }
                        }
                    },
                    trivy: { enabled: s.trivy }
                }
            }]
        },
        pre: (s, ctx) => harborPre(s, ctx),
        post: (s, ctx) => {
            const registry = `${s.address}:${s.httpsPort}`
            const ip = ctx.nodeIps?.[0] || s.address
            return {
                manifests: s.trustNodes ? [harborTrust(registry)] : [],
                script: [
                    '[ -n "$HARBOR_TLS_NEW" ] && kubectl -n harbor rollout restart deploy/harbor-nginx >/dev/null 2>&1',
                    ...(s.trustNodes ? [
                        '[ -n "$HARBOR_TLS_NEW" ] && kubectl -n harbor rollout restart ds/kubeez-harbor-trust >/dev/null 2>&1',
                        'if kubectl -n harbor rollout status ds/kubeez-harbor-trust --timeout=300s >/dev/null 2>&1; then',
                        `    log "✓ Every node trusts Harbor — images like ${registry}/library/nginx:1.27 can be used in pods"`,
                        'else',
                        '    kubectl -n harbor logs -l app=kubeez-harbor-trust -c setup --tail=3 --prefix 2>/dev/null | sed "s/^/  /"',
                        '    log "⚠ Not every node trusts Harbor yet (log above) — pulls from Harbor may fail on those nodes"',
                        'fi'
                    ] : ['kubectl -n harbor delete ds kubeez-harbor-trust --ignore-not-found >/dev/null 2>&1']),
                    'P=""',
                    'for _ in $(seq 1 36); do',
                    `    curl -sk -m 5 https://${ip}:${s.httpsPort}/api/v2.0/ping 2>/dev/null | grep -qi pong && { P=1; break; }`,
                    '    sleep 5',
                    'done',
                    `[ -n "$P" ] && log "✓ Harbor answers on https://${registry} — user admin, password under Access" \\`,
                    `    || fail HARBOR_NOT_ANSWERING "Harbor runs, but https://${ip}:${s.httpsPort} does not answer." "Check that port ${s.httpsPort} is free and reachable, and the add-on's Logs (harbor-nginx), then apply again."`,
                    `log "Push from your computer: trust the CA (Access → download), then docker login ${registry}"`
                ].join('\n')
            }
        },
        locked: { harbor: ['expose.type', 'expose.tls.certSource', 'expose.tls.secret.secretName', 'externalURL', 'existingSecretAdminPassword', 'existingSecretSecretKey', 'caSecretName'] },
        uninstallNote: 'Harbor and every image, chart and project in it are deleted.'
    },

    flux: {
        label: 'Flux CD', ns: 'flux-system', detect: 'deploy/source-controller', probe: 'deploy/source-controller', tier: 'pro',
        summary: 'GitOps: keeps the cluster in sync with a Git repository (Kustomize and Helm releases).',
        versions: [
            { id: '2.19.1', app: 'v2.9.5', charts: { flux2: '2.19.1' } },
            { id: '2.18.4', app: 'v2.8.8', charts: { flux2: '2.18.4' } }
        ],
        fields: [
            { key: 'imageAutomation', type: 'bool', label: 'Image automation (new image tags written back to Git)', default: false },
            { key: 'gitUrl', type: 'text', label: 'Git repository', default: '', placeholder: 'https://github.com/org/fleet.git', group: 'Sync a repository (optional)', help: 'Empty: Flux only — add your own GitRepository and Kustomization objects.' },
            { key: 'branch', type: 'text', label: 'Branch', default: 'main', group: 'Sync a repository (optional)' },
            { key: 'path', type: 'text', label: 'Folder in the repository', default: './', group: 'Sync a repository (optional)' },
            { key: 'interval', type: 'number', label: 'Check every', unit: 'minutes', default: 5, min: 1, max: 1440, group: 'Sync a repository (optional)' },
            { key: 'prune', type: 'bool', label: 'Delete what is removed from Git', default: false, group: 'Sync a repository (optional)' },
            { key: 'targetNamespace', type: 'text', label: 'Namespace for objects without one', default: '', placeholder: 'apps', group: 'Sync a repository (optional)', help: 'Optional. Objects in Git that name no namespace are created here (the namespace must exist).' },
            { key: 'secret', type: 'text', label: 'Secret with username and password (private repository)', default: '', placeholder: 'git-login', group: 'Sync a repository (optional)', help: 'A Secret in flux-system with the keys username and password (a token).' }
        ],
        validate: (s) => {
            const url = gitUrl(s.gitUrl)
            return {
                imageAutomation: boolOr(s.imageAutomation, false),
                gitUrl: url,
                branch: gitRef(s.branch || 'main', 'Branch'),
                path: (() => { const p = String(s.path ?? './').trim() || './'; if (!/^\.?\/?[A-Za-z0-9._/-]{0,200}$/.test(p) || p.includes('..')) throw bad('Folder: a path in the repository like ./clusters/prod'); return p })(),
                interval: int(s.interval ?? 5, { min: 1, max: 1440, label: 'Check every (minutes)' }),
                prune: boolOr(s.prune, false),
                secret: optionalName(s.secret, 'Secret'),
                targetNamespace: optionalName(s.targetNamespace, 'Namespace')
            }
        },
        releases: (s, ctx, v) => [{
            name: 'flux', repo: REPOS.fluxcd, chart: 'flux2', version: v.charts.flux2,
            values: {
                imageAutomationController: { create: s.imageAutomation },
                imageReflectionController: { create: s.imageAutomation }
            }
        }],
        post: (s) => {
            if (!s.gitUrl) return {
                manifests: [],
                script: [
                    'if kubectl -n flux-system get kustomizations.kustomize.toolkit.fluxcd.io kubeez-sync >/dev/null 2>&1; then',
                    '    # never delete what was deployed from Git: no pruning, then remove the sync',
                    "    kubectl -n flux-system patch kustomizations.kustomize.toolkit.fluxcd.io kubeez-sync --type merge -p '{\"spec\":{\"prune\":false}}' >/dev/null 2>&1",
                    '    kubectl -n flux-system delete kustomizations.kustomize.toolkit.fluxcd.io kubeez-sync --ignore-not-found >/dev/null 2>&1',
                    '    kubectl -n flux-system delete gitrepositories.source.toolkit.fluxcd.io kubeez-sync --ignore-not-found >/dev/null 2>&1',
                    '    log "Stopped syncing the repository (what was deployed from it stays)"',
                    'fi',
                    'log "✓ Flux is ready — add GitRepository / Kustomization objects, or set a repository in the settings"'
                ].join('\n')
            }
            const meta = { name: 'kubeez-sync', namespace: 'flux-system', labels: managed }
            return {
                manifests: [
                    { apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'GitRepository', metadata: meta, spec: { interval: `${s.interval}m`, url: s.gitUrl, ref: { branch: s.branch }, ...(s.secret ? { secretRef: { name: s.secret } } : {}) } },
                    { apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', metadata: meta, spec: { interval: `${s.interval}m`, path: s.path, prune: s.prune, timeout: '5m', sourceRef: { kind: 'GitRepository', name: 'kubeez-sync' }, ...(s.targetNamespace ? { targetNamespace: s.targetNamespace } : {}) } }
                ],
                script: [
                    // the Ready condition's message, e.g. why applying failed
                    `fluxwhy() { kubectl -n flux-system get "$1" kubeez-sync -o jsonpath='{range .status.conditions[*]}{.type}={.message}{"\\n"}{end}' 2>/dev/null | sed -n 's/^Ready=//p' | head -c 300; }`,
                    'if kubectl -n flux-system wait gitrepositories.source.toolkit.fluxcd.io/kubeez-sync --for=condition=Ready --timeout=180s >/dev/null 2>&1; then',
                    `    log "✓ Flux reads ${s.gitUrl} (${s.branch})"`,
                    '    if kubectl -n flux-system wait kustomizations.kustomize.toolkit.fluxcd.io/kubeez-sync --for=condition=Ready --timeout=300s >/dev/null 2>&1; then',
                    `        log "✓ ${s.path} is applied to the cluster — Flux checks again every ${s.interval} min"`,
                    '    else',
                    '        log "⚠ Applying from Git did not succeed yet: $(fluxwhy kustomizations.kustomize.toolkit.fluxcd.io)"',
                    '    fi',
                    'else',
                    '    log "⚠ Flux cannot read the repository yet: $(fluxwhy gitrepositories.source.toolkit.fluxcd.io)"',
                    'fi'
                ].join('\n')
            }
        },
        uninstallNote: 'Flux stops syncing. What it deployed from Git stays in the cluster.'
    },

    jenkins: {
        label: 'Jenkins', ns: 'jenkins', detect: 'sts/jenkins', probe: 'sts/jenkins', tier: 'pro', keepsData: true,
        summary: 'CI/CD server: builds run as pods in the cluster (Kubernetes agents), configured as code.',
        versions: [
            { id: '5.9.68', app: '2.580.1', charts: { jenkins: '5.9.68' } },
            { id: '5.9.65', app: '2.568.3', charts: { jenkins: '5.9.65' } }
        ],
        fields: [
            NODE_PORT('nodePort', 'Web UI node port', 30808),
            storageField('Where Jenkins data is stored'),
            { key: 'sizeGi', type: 'number', label: 'Disk', unit: 'GiB', default: 10, min: 1, max: 2000 },
            { key: 'memory', type: 'select', label: 'Memory', default: '2', options: [['1', '1 GiB'], ['2', '2 GiB'], ['4', '4 GiB'], ['8', '8 GiB']] },
            { key: 'plugins', type: 'text', label: 'Extra plugins', default: '', placeholder: 'blueocean, docker-workflow', help: 'Comma separated, name or name:version. Downloaded from updates.jenkins.io when Jenkins starts.' }
        ],
        validate: (s, ctx) => {
            const plugins = list(s.plugins)
            if (plugins.length > 50) throw bad('Extra plugins: at most 50')
            for (const p of plugins) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(:[A-Za-z0-9._-]{1,60})?$/.test(p)) throw bad(`Extra plugins: "${p}" — use name or name:version`)
            return {
                nodePort: port(s.nodePort ?? 30808, 'Web UI node port'),
                storage: resolveStorage(s.storage, ctx),
                sizeGi: int(s.sizeGi ?? 10, { min: 1, max: 2000, label: 'Disk (GiB)' }),
                memory: Number(oneOf(String(s.memory ?? '2'), ['1', '2', '4', '8'], 'Memory')),
                plugins: plugins.join(', ')
            }
        },
        releases: (s, ctx, v) => [{
            name: 'jenkins', repo: REPOS.jenkins, chart: 'jenkins', version: v.charts.jenkins, slow: true,
            values: {
                controller: {
                    serviceType: 'NodePort', nodePort: s.nodePort,
                    jenkinsUrl: clusterAddress(ctx) ? `http://${clusterAddress(ctx)}:${s.nodePort}/` : null,
                    admin: { createSecret: true },
                    additionalPlugins: list(s.plugins),
                    resources: { requests: { cpu: '100m', memory: `${Math.max(512, s.memory * 512)}Mi` }, limits: { memory: `${s.memory}Gi` } },
                    javaOpts: '-XX:MaxRAMPercentage=70'
                },
                persistence: s.storage === 'node' ? { enabled: false } : { enabled: true, storageClass: storageClassOf(s.storage), size: `${s.sizeGi}Gi` }
            }
        }],
        pre: (s) => storageCheck(s.storage),
        post: (s, ctx) => ({
            manifests: [],
            script: `log "✓ Jenkins: http://${clusterAddress(ctx) || '<node IP>'}:${s.nodePort} — user admin, password under Access"`
        }),
        locked: { jenkins: ['controller.admin.createSecret'] },
        uninstallNote: 'Jenkins with all jobs, build history and credentials is deleted.'
    },

    vault: {
        label: 'HashiCorp Vault', ns: 'vault', detect: 'sts/vault', probe: 'sts/vault', tier: 'pro', keepsData: true,
        summary: 'Secrets management with its UI; pods get secrets injected by the Vault Agent (annotations), Kubernetes login ready.',
        versions: [
            { id: '0.34.1', app: '2.0.4', charts: { vault: '0.34.1' } },
            { id: '0.32.0', app: '1.21.2', charts: { vault: '0.32.0' } }
        ],
        fields: [
            { key: 'mode', type: 'select', label: 'Mode', default: 'standalone', options: [['standalone', 'Standalone — data on a volume, unsealed by KubeEZ'], ['dev', 'Dev — in memory, for trying out (everything lost on restart)']] },
            storageField('Where Vault data is stored', { showIf: { mode: 'standalone' } }),
            { key: 'sizeGi', type: 'number', label: 'Disk', unit: 'GiB', default: 5, min: 1, max: 200, showIf: { mode: 'standalone' } },
            { key: 'autoUnseal', type: 'bool', label: 'Unseal automatically after a restart', default: true, showIf: { mode: 'standalone' }, help: 'The unseal key is kept in the Secret vault/kubeez-vault-keys. For production, use a cloud KMS seal (advanced YAML) instead.' },
            { key: 'injector', type: 'bool', label: 'Vault Agent injector (secrets into pods)', default: true },
            NODE_PORT('nodePort', 'UI node port', 30820)
        ],
        validate: (s, ctx) => {
            const mode = oneOf(s.mode || 'standalone', ['standalone', 'dev'], 'Mode')
            return {
                mode,
                storage: mode === 'standalone' ? resolveStorage(s.storage, ctx, { needsVolume: true, what: 'Vault' }) : 'node',
                sizeGi: int(s.sizeGi ?? 5, { min: 1, max: 200, label: 'Disk (GiB)' }),
                autoUnseal: boolOr(s.autoUnseal, true),
                injector: boolOr(s.injector, true),
                nodePort: port(s.nodePort ?? 30820, 'UI node port')
            }
        },
        releases: (s, ctx, v) => [{
            name: 'vault', repo: REPOS.hashicorp, chart: 'vault', version: v.charts.vault, clientSide: true,
            values: {
                injector: {
                    enabled: s.injector, resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '256Mi' } },
                    // "preferred", not "required": an update starts the new injector next to the old
                    // one — with "required" it can never be placed on a one-node cluster
                    affinity: {
                        podAntiAffinity: {
                            preferredDuringSchedulingIgnoredDuringExecution: [{
                                weight: 100,
                                podAffinityTerm: { labelSelector: { matchLabels: { 'app.kubernetes.io/name': 'vault-agent-injector', 'app.kubernetes.io/instance': 'vault', component: 'webhook' } }, topologyKey: 'kubernetes.io/hostname' }
                            }]
                        }
                    }
                },
                server: {
                    dev: { enabled: s.mode === 'dev', devRootToken: 'root' },
                    standalone: { enabled: s.mode === 'standalone' },
                    ha: { enabled: false },
                    dataStorage: s.mode === 'standalone' ? { enabled: true, size: `${s.sizeGi}Gi`, storageClass: storageClassOf(s.storage) } : { enabled: false },
                    auditStorage: { enabled: false },
                    // sealed or not initialized yet still counts as started (KubeEZ initializes and unseals it)
                    readinessProbe: { enabled: true, path: '/v1/sys/health?standbyok=true&sealedcode=204&uninitcode=204' },
                    resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '512Mi' } }
                },
                ui: { enabled: true, serviceType: 'NodePort', serviceNodePort: s.nodePort, externalPort: 8200 }
            }
        }],
        pre: (s) => s.mode === 'standalone' ? storageCheck(s.storage) : 'log "⚠ Dev mode: Vault keeps everything in memory — all secrets are lost when its pod restarts"',
        post: (s, ctx, v) => ({
            manifests: s.mode === 'standalone' && s.autoUnseal ? [vaultUnsealJob(v.app)] : [],
            script: vaultPost(s, v.app)
        }),
        locked: { vault: ['server.readinessProbe.path', 'server.ha.enabled'] },
        uninstallNote: 'Vault and every secret stored in it are deleted, including the unseal key.'
    },

    gatekeeper: {
        label: 'OPA Gatekeeper', ns: 'gatekeeper-system', detect: 'deploy/gatekeeper-controller-manager', probe: 'deploy/gatekeeper-controller-manager', tier: 'pro',
        summary: 'Policies written in Rego (Open Policy Agent): KubeEZ\'s rules to start with, plus your own ConstraintTemplates.',
        versions: [
            { id: '3.23.1', app: 'v3.23.1', charts: { gatekeeper: '3.23.1' } },
            { id: '3.22.2', app: 'v3.22.2', charts: { gatekeeper: '3.22.2' } }
        ],
        fields: [
            { key: 'mode', type: 'select', label: 'When a rule is broken', default: 'dryrun', options: [['dryrun', 'Report only (recommended to start)'], ['warn', 'Allow, but warn the user'], ['deny', 'Block the pod']] },
            ...Object.entries(GATEKEEPER_POLICIES).map(([k, p]) => ({ key: `policy_${k}`, type: 'bool', label: p.label, default: true, group: 'Rules' })),
            { key: 'replicas', type: 'select', label: 'Admission controller', default: '1', options: [['1', '1 replica'], ['3', '3 replicas (high availability)']] }
        ],
        validate: (s) => {
            const out = { mode: oneOf(s.mode || 'dryrun', ['dryrun', 'warn', 'deny'], 'Mode'), replicas: Number(oneOf(String(s.replicas ?? '1'), ['1', '3'], 'Replicas')) }
            for (const k of Object.keys(GATEKEEPER_POLICIES)) out[`policy_${k}`] = boolOr(s[`policy_${k}`], true)
            return out
        },
        releases: (s, ctx, v) => [{
            name: 'gatekeeper', repo: REPOS.gatekeeper, chart: 'gatekeeper', version: v.charts.gatekeeper, clientSide: true,
            values: {
                replicas: s.replicas,
                // if Gatekeeper is down, requests are let through instead of blocking the cluster
                validatingWebhookFailurePolicy: 'Ignore',
                auditInterval: 60,
                constraintViolationsLimit: 20,
                controllerManager: { resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } } },
                audit: { resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } } }
            }
        }],
        post: (s) => {
            const on = Object.entries(GATEKEEPER_POLICIES).filter(([k]) => s[`policy_${k}`]).map(([, p]) => p)
            const off = Object.entries(GATEKEEPER_POLICIES).filter(([k]) => !s[`policy_${k}`]).map(([, p]) => templateName(p))
            return {
                // the constraints need their template's CRD: post.yaml is retried until it exists
                manifests: [...on.map(gatekeeperTemplate), ...on.map(p => gatekeeperConstraint(p, s.mode))],
                script: [
                    off.length ? `kubectl delete constrainttemplates.templates.gatekeeper.sh ${off.join(' ')} --ignore-not-found >/dev/null 2>&1 || true` : '',
                    `log "✓ ${on.length} rule${on.length === 1 ? '' : 's'} active (${s.mode === 'deny' ? 'blocking' : s.mode === 'warn' ? 'warning' : 'report only'}) — violations show under Access within a minute"`
                ].filter(Boolean).join('\n')
            }
        },
        locked: { gatekeeper: ['validatingWebhookFailurePolicy'] },
        uninstallNote: 'All Gatekeeper policies are removed; nothing is checked or blocked any more.'
    },

    falco: {
        label: 'Falco', ns: 'falco', detect: 'ds/falco', probe: 'ds/falco', tier: 'pro',
        summary: 'Runtime security: watches every node and alerts on shells in containers, sensitive files read, unexpected network tools…',
        versions: [
            { id: '9.2.0', app: '0.45.0', charts: { falco: '9.2.0' } },
            { id: '9.1.0', app: '0.44.1', charts: { falco: '9.1.0' } }
        ],
        fields: [
            { key: 'driver', type: 'select', label: 'Driver', default: 'modern_ebpf', options: [['modern_ebpf', 'Modern eBPF (kernel 5.8+, recommended)'], ['kmod', 'Kernel module (older kernels)'], ['auto', 'Let Falco choose']] },
            { key: 'priority', type: 'select', label: 'Report from', default: 'notice', options: [['debug', 'Debug (everything)'], ['informational', 'Informational'], ['notice', 'Notice'], ['warning', 'Warning'], ['error', 'Error'], ['critical', 'Critical only']] },
            { key: 'ui', type: 'bool', label: 'Web UI (Falcosidekick UI)', default: true },
            NODE_PORT('uiPort', 'UI node port', 30282, { showIf: { ui: true } })
        ],
        validate: (s) => ({
            driver: oneOf(s.driver || 'modern_ebpf', ['modern_ebpf', 'kmod', 'auto'], 'Driver'),
            priority: oneOf(s.priority || 'notice', ['debug', 'informational', 'notice', 'warning', 'error', 'critical'], 'Report from'),
            ui: boolOr(s.ui, true),
            uiPort: port(s.uiPort ?? 30282, 'UI node port')
        }),
        releases: (s, ctx, v) => [{
            name: 'falco', repo: REPOS.falcosecurity, chart: 'falco', version: v.charts.falco,
            values: {
                driver: { kind: s.driver },
                tty: true,
                falco: { priority: s.priority, json_output: true },
                falcosidekick: s.ui ? {
                    enabled: true,
                    webui: {
                        enabled: true, existingSecret: 'kubeez-falco-ui',
                        service: { type: 'NodePort', nodePort: s.uiPort },
                        redis: { storageEnabled: false }
                    }
                } : { enabled: false }
            }
        }],
        pre: (s) => [
            s.driver === 'modern_ebpf' ? '[ -f /sys/kernel/btf/vmlinux ] || fail FALCO_KERNEL "This kernel has no BTF information, which Modern eBPF needs." "Choose the driver \\"Kernel module\\" (or \\"Let Falco choose\\"), then apply again."' : '',
            s.ui ? ensureSecret('falco', 'kubeez-falco-ui', [['FALCOSIDEKICK_UI_USER', `admin:${RANDOM}`]]) : ''
        ].filter(Boolean).join('\n'),
        post: (s) => ({
            manifests: [],
            script: s.ui ? `log "✓ Falco watches every node — alerts in the web UI on port ${s.uiPort} (user admin, password under Access) and in the falco pods' logs"` : 'log "✓ Falco watches every node — alerts in the falco pods\' logs"'
        }),
        uninstallNote: 'Runtime alerts stop; the collected events in the UI are deleted.'
    },

    'trivy-operator': {
        label: 'Trivy Operator', ns: 'trivy-system', detect: 'deploy/trivy-operator', probe: 'deploy/trivy-operator', tier: 'pro',
        summary: 'Scans running images for vulnerabilities and workloads for misconfigurations and RBAC risks — continuous reports in the cluster.',
        versions: [
            { id: '0.37.0', app: '0.35.0', charts: { 'trivy-operator': '0.37.0' } },
            { id: '0.36.0', app: '0.34.0', charts: { 'trivy-operator': '0.36.0' } }
        ],
        fields: [
            { key: 'vulnerabilities', type: 'bool', label: 'Image vulnerabilities', default: true, group: 'Scans' },
            { key: 'configAudit', type: 'bool', label: 'Misconfigurations', default: true, group: 'Scans' },
            { key: 'rbac', type: 'bool', label: 'RBAC risks', default: true, group: 'Scans' },
            { key: 'secrets', type: 'bool', label: 'Secrets left in images', default: true, group: 'Scans' },
            { key: 'severity', type: 'select', label: 'Report vulnerabilities from', default: 'HIGH', options: [['CRITICAL', 'Critical only'], ['HIGH', 'High and critical'], ['MEDIUM', 'Medium and up'], ['ALL', 'All']] },
            { key: 'ignoreUnfixed', type: 'bool', label: 'Only vulnerabilities that have a fix', default: false },
            { key: 'concurrent', type: 'number', label: 'Scans at the same time', default: 3, min: 1, max: 10, help: 'Each scan is a short-lived pod; fewer = less load on small clusters.' }
        ],
        validate: (s) => ({
            vulnerabilities: boolOr(s.vulnerabilities, true),
            configAudit: boolOr(s.configAudit, true),
            rbac: boolOr(s.rbac, true),
            secrets: boolOr(s.secrets, true),
            severity: oneOf(s.severity || 'HIGH', ['CRITICAL', 'HIGH', 'MEDIUM', 'ALL'], 'Severity'),
            ignoreUnfixed: boolOr(s.ignoreUnfixed, false),
            concurrent: int(s.concurrent ?? 3, { min: 1, max: 10, label: 'Scans at the same time' })
        }),
        releases: (s, ctx, v) => [{
            name: 'trivy-operator', repo: REPOS.aqua, chart: 'trivy-operator', version: v.charts['trivy-operator'],
            values: {
                operator: {
                    scanJobsConcurrentLimit: s.concurrent,
                    vulnerabilityScannerEnabled: s.vulnerabilities,
                    exposedSecretScannerEnabled: s.secrets,
                    configAuditScannerEnabled: s.configAudit,
                    rbacAssessmentScannerEnabled: s.rbac,
                    sbomGenerationEnabled: false
                },
                trivy: {
                    severity: { CRITICAL: 'CRITICAL', HIGH: 'HIGH,CRITICAL', MEDIUM: 'MEDIUM,HIGH,CRITICAL', ALL: 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL' }[s.severity],
                    ignoreUnfixed: s.ignoreUnfixed
                }
            }
        }],
        post: () => ({ manifests: [], script: 'log "✓ Scans start within minutes; results under Access (kubectl get vulnerabilityreports,configauditreports -A)"' }),
        uninstallNote: 'Scanning stops and all reports are deleted.'
    }
}
