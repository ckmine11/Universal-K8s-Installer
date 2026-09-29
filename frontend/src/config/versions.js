// Supported Kubernetes versions for install & upgrade.
// The install/upgrade scripts derive the repo path from the minor version
// (pkgs.k8s.io/core:/stable:/v<major>.<minor>/) and the control-plane version
// is pinned to the ACTUALLY INSTALLED kubeadm patch, so every listed version
// works on every OS as long as that minor has been published upstream.
//
// `status`: 'supported' = actively maintained upstream (gets security patches);
//           'eol'       = End-of-Life (installable, but no more upstream fixes).
// Reflects the upstream support window as of 2026 (1.35/1.36/1.37 supported).
//
// NOTE: keep this NEWEST → OLDEST. The upgrade UI offers "current minor + 1"
// and caps at the highest minor listed here (see ClusterDetails).

export const K8S_VERSIONS = [
    { value: '1.37.0', label: 'v1.37', badge: 'Latest',  status: 'supported' },
    { value: '1.36.0', label: 'v1.36', badge: '',        status: 'supported' },
    { value: '1.35.0', label: 'v1.35', badge: 'Stable',  status: 'supported' },
    { value: '1.34.0', label: 'v1.34', badge: '',        status: 'eol' },
    { value: '1.33.0', label: 'v1.33', badge: '',        status: 'eol' },
    { value: '1.32.0', label: 'v1.32', badge: '',        status: 'eol' },
    { value: '1.31.0', label: 'v1.31', badge: '',        status: 'eol' },
    { value: '1.30.0', label: 'v1.30', badge: '',        status: 'eol' },
    { value: '1.29.0', label: 'v1.29', badge: '',        status: 'eol' },
    { value: '1.28.0', label: 'v1.28', badge: '',        status: 'eol' },
    { value: '1.27.0', label: 'v1.27', badge: '',        status: 'eol' }
];

// Highest supported minor version — derived, not hardcoded. Used to cap the
// upgrade path so we never offer an upgrade beyond what we support.
export const MAX_K8S_MINOR = Math.max(
    ...K8S_VERSIONS.map(v => parseInt(v.value.split('.')[1], 10))
);
