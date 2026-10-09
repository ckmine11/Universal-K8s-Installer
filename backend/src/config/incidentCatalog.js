// Every problem auto-healing can detect: how bad it is, what it is about, what
// KubeEZ can do itself and what the user should check. The Incidents page
// reads this through GET /api/incidents/catalog (one source of truth).
//
// policy: what happens by default when it is detected
//   auto   → run the fix playbook (with retries + verification)
//   notify → alert + diagnose only, a person decides ("Run fix now")
//   off    → not detected at all

export const CATALOG = {
    // ── Cluster ────────────────────────────────────────────────────────────
    ClusterUnreachable: {
        label: 'Cluster unreachable', category: 'cluster', severity: 'critical', fixable: false, policy: 'notify',
        suggestion: 'KubeEZ cannot reach the control-plane over SSH for 5 minutes: is the machine on and on the network? In SaaS / private networks, is its Gateway Agent online (Gateway Agents page)? While unreachable, nothing on it is watched or healed.'
    },

    // ── Nodes ──────────────────────────────────────────────────────────────
    NodeNotReady: {
        label: 'Node down', category: 'node', severity: 'critical', fixable: true, policy: 'auto',
        fix: 'Restart kubelet + containerd on the node, then check it reports Ready.',
        suggestion: 'If it stays down: is the machine on, reachable on the network, and is there free disk? `journalctl -u kubelet -n 50` on the node shows why.'
    },
    DiskPressure: {
        label: 'Disk pressure', category: 'node', severity: 'warning', fixable: true, policy: 'auto',
        fix: 'Remove unused images and exited containers, trim journals, empty oversized logs, clear old /tmp files.',
        suggestion: 'If it comes back: grow the disk, or move /var/lib/containerd to a bigger volume.'
    },
    MemoryPressure: {
        label: 'Memory pressure', category: 'node', severity: 'warning', fixable: true, policy: 'auto',
        fix: 'Drop the page cache and restart the container runtime + kubelet.',
        suggestion: 'Set memory requests/limits on workloads, or add memory / another node.'
    },
    PIDPressure: {
        label: 'Process pressure', category: 'node', severity: 'warning', fixable: true, policy: 'auto',
        fix: 'Clear zombie processes and restart kubelet.',
        suggestion: 'A workload is forking too many processes — set a PID limit or fix the app.'
    },

    // ── Control plane ──────────────────────────────────────────────────────
    ControlPlaneDown: {
        label: 'Control plane down', category: 'control-plane', severity: 'critical', fixable: true, policy: 'auto',
        fix: 'Restart kubelet on that control-plane (it restarts the control-plane static pods), then check the API answers.',
        suggestion: 'If it keeps failing: `crictl ps -a` and `crictl logs <id>` on the control-plane show the component\'s error (often expired certificates, a full disk or etcd).'
    },
    EtcdUnhealthy: {
        label: 'etcd unhealthy', category: 'control-plane', severity: 'critical', fixable: false, policy: 'notify',
        suggestion: 'Check disk space and latency on the control-plane, and the etcd logs (`crictl logs` of the etcd container). Take a snapshot as soon as it is healthy again; restore one from Backups if data is damaged.'
    },
    CertExpiring: {
        label: 'Certificates expiring', category: 'control-plane', severity: 'warning', fixable: true, policy: 'notify',
        fix: 'Renew all control-plane certificates (`kubeadm certs renew all`) on every control-plane and restart the control-plane components.',
        suggestion: 'Expired certificates stop the API. Renew before the date — "Run fix now" does it — then download a fresh kubeconfig.'
    },
    ControlPlaneDiskFull: {
        label: 'Control-plane disk filling up', category: 'control-plane', severity: 'warning', fixable: true, policy: 'auto',
        fix: 'Same cleanup as disk pressure, on the control-plane.',
        suggestion: 'etcd stops at a full disk. Grow the disk or move old backups (/var/lib/etcd-backup) offsite.'
    },

    // ── Pods ───────────────────────────────────────────────────────────────
    CrashLoopBackOff: {
        label: 'Pod crash loop', category: 'pod', severity: 'warning', fixable: true, policy: 'auto',
        fix: 'Save the last log lines, then delete the pod so its controller starts a fresh one.',
        suggestion: 'The saved logs show why it crashes — usually a config error, a missing secret or a dependency that is down.'
    },
    OOMKilled: {
        label: 'Out of memory', category: 'pod', severity: 'warning', fixable: false, policy: 'notify',
        suggestion: 'The container used more memory than its limit. Raise `resources.limits.memory` or reduce its usage.'
    },
    ImagePullBackOff: {
        label: 'Image pull failed', category: 'pod', severity: 'warning', fixable: false, policy: 'notify',
        suggestion: 'Check the image name and tag, that the registry is reachable from the nodes, and the imagePullSecrets for private registries.'
    },
    PodPendingTooLong: {
        label: 'Pod stuck pending', category: 'pod', severity: 'warning', fixable: false, policy: 'notify',
        suggestion: 'Usually not enough CPU/memory on any node, a taint without toleration, or a volume that cannot be bound. The diagnosis shows the scheduler\'s reason.'
    },

    // ── Workloads & storage ────────────────────────────────────────────────
    WorkloadUnavailable: {
        label: 'Workload unavailable', category: 'workload', severity: 'warning', fixable: false, policy: 'notify',
        suggestion: 'Fewer replicas are ready than wanted for over 5 minutes. Look at its pods (crash loop, pending, image) — the related incidents usually show the cause.'
    },
    PVCPending: {
        label: 'Volume claim pending', category: 'storage', severity: 'warning', fixable: false, policy: 'notify',
        suggestion: 'No volume could be provisioned: is there a default StorageClass (e.g. Longhorn add-on), and does the requested size/access mode exist?'
    },
    JobFailed: {
        label: 'Job failed', category: 'workload', severity: 'info', fixable: false, policy: 'notify',
        suggestion: 'Check the job\'s pod logs. A CronJob runs again at its next schedule.'
    }
}

export const REASONS = Object.keys(CATALOG)
export const SEVERITIES = ['critical', 'warning', 'info']
export const POLICIES = ['auto', 'notify', 'off']
export const defaultPolicies = () => Object.fromEntries(REASONS.map(r => [r, CATALOG[r].policy]))
export const label = (reason) => CATALOG[reason]?.label || reason
