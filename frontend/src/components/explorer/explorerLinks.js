// Deep links into the Cluster Explorer (Radar served under the cluster's path)

export const explorerBase = (clusterId) => `/api/clusters/${clusterId}/explorer`

// Radar's resource routes use the lowercase plural (/resources/deployments)
const PLURAL = {
    Ingress: 'ingresses', NetworkPolicy: 'networkpolicies', StorageClass: 'storageclasses',
    PersistentVolumeClaim: 'persistentvolumeclaims', PersistentVolume: 'persistentvolumes',
    IngressClass: 'ingressclasses', CustomResourceDefinition: 'customresourcedefinitions',
    PodDisruptionBudget: 'poddisruptionbudgets', HorizontalPodAutoscaler: 'horizontalpodautoscalers',
    Node: 'nodes', Endpoints: 'endpoints'
}
export const kindPath = (kind) => PLURAL[kind] || `${String(kind).toLowerCase()}s`

/** Link to one resource in the Explorer (namespace may be empty for cluster-scoped kinds). */
export function explorerResourceLink(clusterId, kind, namespace, name) {
    if (!kind || !name || /\./.test(kind)) return null   // custom resources: no stable route
    const ref = namespace ? `${namespace}/${name}` : name
    return `${explorerBase(clusterId)}/resources/${kindPath(kind)}?resource=${encodeURIComponent(ref)}`
}

export const explorerPages = (clusterId) => ({
    home: `${explorerBase(clusterId)}/`,
    timeline: `${explorerBase(clusterId)}/timeline`,
    upgrade: `${explorerBase(clusterId)}/checks/upgrade`,
    checks: `${explorerBase(clusterId)}/checks`
})
