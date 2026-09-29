// Supported Kubernetes versions for install & upgrade.
// The install/upgrade scripts derive the repo path from the minor version
// (pkgs.k8s.io/core:/stable:/v<major>.<minor>/) so any listed version works
// on every OS as long as that minor has been published upstream.
//
// NOTE: keep this NEWEST → OLDEST. The upgrade UI offers "current minor + 1"
// and caps at the highest minor listed here (see ClusterDetails).

export const K8S_VERSIONS = [
    { value: '1.37.0', label: 'v1.37.0 (Latest)', badge: 'Latest' },
    { value: '1.36.0', label: 'v1.36.0', badge: '' },
    { value: '1.35.0', label: 'v1.35.0', badge: '' },
    { value: '1.34.0', label: 'v1.34.0 (Stable)', badge: 'Stable' },
    { value: '1.33.0', label: 'v1.33.0', badge: '' },
    { value: '1.32.0', label: 'v1.32.0', badge: '' },
    { value: '1.31.0', label: 'v1.31.0', badge: '' },
    { value: '1.30.0', label: 'v1.30.0', badge: '' },
    { value: '1.29.0', label: 'v1.29.0', badge: '' },
    { value: '1.28.0', label: 'v1.28.0 (Legacy Recommended)', badge: 'Legacy' },
    { value: '1.27.0', label: 'v1.27.0', badge: '' }
];

// Highest supported minor version — derived, not hardcoded. Used to cap the
// upgrade path so we never offer an upgrade beyond what we support.
export const MAX_K8S_MINOR = Math.max(
    ...K8S_VERSIONS.map(v => parseInt(v.value.split('.')[1], 10))
);
