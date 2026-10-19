// Where an existing cluster can come from — the import wizard, the setup
// guides and the auto-detection all read this list. `detect` is matched
// against what the cluster reports (node providerID, labels, kubelet version).
export const PROVIDERS = [
    // ── cloud ──
    { id: 'eks', group: 'cloud', name: 'Amazon EKS', vendor: 'AWS', getAccess: 'aws eks update-kubeconfig --region <region> --name <cluster>', console: 'https://console.aws.amazon.com/eks', privateHint: 'An EKS cluster with a private endpoint only is reached through the KubeEZ agent.' },
    { id: 'aks', group: 'cloud', name: 'Azure AKS', vendor: 'Microsoft Azure', getAccess: 'az aks get-credentials --resource-group <group> --name <cluster>', console: 'https://portal.azure.com', privateHint: 'An AKS private cluster is reached through the KubeEZ agent.' },
    { id: 'gke', group: 'cloud', name: 'Google GKE', vendor: 'Google Cloud', getAccess: 'gcloud container clusters get-credentials <cluster> --region <region> --project <project>', console: 'https://console.cloud.google.com/kubernetes', privateHint: 'A GKE private cluster (no public endpoint) is reached through the KubeEZ agent.' },
    { id: 'oke', group: 'cloud', name: 'Oracle OKE', vendor: 'Oracle Cloud', getAccess: 'oci ce cluster create-kubeconfig --cluster-id <cluster-ocid> --file $HOME/.kube/config --region <region> --token-version 2.0.0 --kube-endpoint PUBLIC_ENDPOINT', console: 'https://cloud.oracle.com/containers/clusters', privateHint: 'An OKE cluster with a private endpoint only is reached through the KubeEZ agent.' },
    { id: 'doks', group: 'cloud', name: 'DigitalOcean DOKS', vendor: 'DigitalOcean', getAccess: 'doctl kubernetes cluster kubeconfig save <cluster>', console: 'https://cloud.digitalocean.com/kubernetes' },
    { id: 'lke', group: 'cloud', name: 'Linode / Akamai LKE', vendor: 'Akamai', getAccess: 'linode-cli lke kubeconfig-view <cluster-id> --text --no-headers | base64 -d > ~/.kube/lke.yaml && export KUBECONFIG=~/.kube/lke.yaml', console: 'https://cloud.linode.com/kubernetes' },
    { id: 'vke', group: 'cloud', name: 'Vultr VKE', vendor: 'Vultr', getAccess: 'Download the kubeconfig from the Vultr console (Kubernetes → your cluster → Download Configuration), then: export KUBECONFIG=<file>', console: 'https://my.vultr.com/kubernetes/' },
    { id: 'iks', group: 'cloud', name: 'IBM Cloud Kubernetes', vendor: 'IBM Cloud', getAccess: 'ibmcloud ks cluster config --cluster <cluster>', console: 'https://cloud.ibm.com/kubernetes/clusters' },
    { id: 'ack', group: 'cloud', name: 'Alibaba ACK', vendor: 'Alibaba Cloud', getAccess: 'Download the kubeconfig from the ACK console (Cluster → Connection Information), then: export KUBECONFIG=<file>', console: 'https://cs.console.aliyun.com' },
    { id: 'tke', group: 'cloud', name: 'Tencent TKE', vendor: 'Tencent Cloud', getAccess: 'Download the kubeconfig from the TKE console (Cluster → Basic information → Cluster APIServer information), then: export KUBECONFIG=<file>', console: 'https://console.cloud.tencent.com/tke2' },
    { id: 'civo', group: 'cloud', name: 'Civo', vendor: 'Civo', getAccess: 'civo kubernetes config <cluster> --save', console: 'https://dashboard.civo.com/kubernetes' },
    { id: 'scaleway', group: 'cloud', name: 'Scaleway Kapsule', vendor: 'Scaleway', getAccess: 'scw k8s kubeconfig install <cluster-id>', console: 'https://console.scaleway.com/kubernetes' },
    { id: 'ovh', group: 'cloud', name: 'OVHcloud Managed Kubernetes', vendor: 'OVHcloud', getAccess: 'Download the kubeconfig from the OVHcloud Control Panel (Managed Kubernetes → your cluster → kubeconfig), then: export KUBECONFIG=<file>', console: 'https://www.ovh.com/manager/' },
    { id: 'hetzner', group: 'cloud', name: 'Hetzner Cloud', vendor: 'Hetzner', getAccess: 'Use the kubeconfig your installer wrote (hetzner-k3s, kube-hetzner…): export KUBECONFIG=<file>', console: 'https://console.hetzner.cloud' },
    { id: 'cloud-other', group: 'cloud', name: 'Other cloud', vendor: '', getAccess: 'Make sure `kubectl get nodes` works for the cluster (your provider\'s kubeconfig).' },
    // ── on-prem ──
    { id: 'kubeadm', group: 'onprem', name: 'kubeadm', vendor: '', getAccess: 'On a control-plane node: mkdir -p ~/.kube && sudo cp /etc/kubernetes/admin.conf ~/.kube/config && sudo chown $(id -u):$(id -g) ~/.kube/config', ssh: true },
    { id: 'k3s', group: 'onprem', name: 'k3s', vendor: 'SUSE', getAccess: 'On a server node: sudo k3s kubectl get nodes  (or copy /etc/rancher/k3s/k3s.yaml and set its server address)', ssh: true },
    { id: 'rke2', group: 'onprem', name: 'RKE2', vendor: 'SUSE', getAccess: 'On a server node: export KUBECONFIG=/etc/rancher/rke2/rke2.yaml PATH=$PATH:/var/lib/rancher/rke2/bin', ssh: true },
    { id: 'rancher', group: 'onprem', name: 'Rancher-managed', vendor: 'SUSE', getAccess: 'Rancher → your cluster → Download KubeConfig. A Rancher kubeconfig goes through the Rancher server — use the KubeEZ agent method for it.', agentOnly: true },
    { id: 'openshift', group: 'onprem', name: 'OpenShift / OKD', vendor: 'Red Hat', getAccess: 'oc login https://api.<cluster>:6443 -u <admin>  (oc works like kubectl here)' },
    { id: 'microk8s', group: 'onprem', name: 'MicroK8s', vendor: 'Canonical', getAccess: 'On the node: microk8s config > ~/.kube/config', ssh: true },
    { id: 'k0s', group: 'onprem', name: 'k0s', vendor: 'Mirantis', getAccess: 'On a controller: sudo k0s kubeconfig admin > ~/.kube/config' },
    { id: 'tanzu', group: 'onprem', name: 'VMware Tanzu', vendor: 'Broadcom', getAccess: 'kubectl vsphere login --server <supervisor> --tanzu-kubernetes-cluster-name <cluster>' },
    { id: 'talos', group: 'onprem', name: 'Talos Linux', vendor: 'Sidero', getAccess: 'talosctl kubeconfig --nodes <control-plane-ip>' },
    { id: 'eks-anywhere', group: 'onprem', name: 'EKS Anywhere', vendor: 'AWS', getAccess: 'export KUBECONFIG=${PWD}/<cluster>/<cluster>-eks-a-cluster.kubeconfig' },
    { id: 'aks-arc', group: 'onprem', name: 'AKS on Azure Local (Arc)', vendor: 'Microsoft', getAccess: 'az aksarc get-credentials --resource-group <group> --name <cluster>' },
    { id: 'onprem-other', group: 'onprem', name: 'Other on-prem', vendor: '', getAccess: 'Make sure `kubectl get nodes` works for the cluster.' },
    { id: 'kind', group: 'other', name: 'kind / Docker Desktop / minikube', vendor: '', getAccess: 'kubectl config use-context <context>' }
]
export const providerById = (id) => PROVIDERS.find(p => p.id === id) || null

/**
 * What the cluster is, from what it reports.
 * nodes: kubectl get nodes -o json; extra: { apiGroups: [names], cpPods: [names] }
 * → { provider, distro, version, nodeCount, controlPlanes, nodes: [{ name, role, ready, ip, os, version }] }
 */
export function detectCluster(nodesJson, { version = null, apiGroups = [], cpPods = [] } = {}) {
    const items = nodesJson?.items || []
    const nodes = items.map(n => {
        const l = n.metadata?.labels || {}
        const role = Object.keys(l).some(k => /^node-role\.kubernetes\.io\/(control-plane|master)$/.test(k)) ? 'control-plane' : 'worker'
        const ready = (n.status?.conditions || []).find(c => c.type === 'Ready')?.status === 'True'
        const ip = (n.status?.addresses || []).find(a => a.type === 'InternalIP')?.address || null
        return { name: n.metadata?.name, role, ready, ip, os: n.status?.nodeInfo?.osImage || '', version: n.status?.nodeInfo?.kubeletVersion || '', providerID: n.spec?.providerID || '', labels: l }
    })
    const any = (fn) => nodes.some(fn)
    const pid = (re) => any(n => re.test(n.providerID))
    const label = (re) => any(n => Object.keys(n.labels).some(k => re.test(k)))
    const kv = String(version || nodes[0]?.version || '')
    const has = (g) => apiGroups.includes(g)
    let provider = null
    if (pid(/^aws:\/\//) && (label(/^eks\.amazonaws\.com\//) || /-eks-/.test(kv))) provider = 'eks'
    else if (label(/^anywhere\.eks\.amazonaws\.com\//)) provider = 'eks-anywhere'
    else if (pid(/^azure:\/\//) && label(/^kubernetes\.azure\.com\//)) provider = 'aks'
    else if (label(/^msft\.microsoft\/|^kubernetes\.azure\.com\/(managedby|cluster)/) && !pid(/^azure:\/\//)) provider = 'aks-arc'
    else if (pid(/^gce:\/\//) && (label(/^cloud\.google\.com\/gke-/) || /-gke\./.test(kv))) provider = 'gke'
    else if (pid(/^oci:\/\/|^ocid1\./) || label(/^oci\.oraclecloud\.com\/|oke\.oraclecloud\.com/)) provider = 'oke'
    else if (pid(/^digitalocean:\/\//) || label(/^doks\.digitalocean\.com\//)) provider = 'doks'
    else if (pid(/^linode:\/\//) || label(/^lke\.linode\.com\//)) provider = 'lke'
    else if (pid(/^vultr:\/\//) || label(/^vke\.vultr\.com\//)) provider = 'vke'
    else if (pid(/^ibm:\/\//) || label(/^ibm-cloud\.kubernetes\.io\//)) provider = 'iks'
    else if (pid(/^alicloud:\/\//) || label(/^alibabacloud\.com\//)) provider = 'ack'
    else if (pid(/^qcloud:\/\/|^tencentcloud:\/\//) || label(/^cloud\.tencent\.com\//)) provider = 'tke'
    else if (pid(/^civo:\/\//) || label(/^kubernetes\.civo\.com\//)) provider = 'civo'
    else if (pid(/^scaleway:\/\//) || label(/^k8s\.scaleway\.com\//)) provider = 'scaleway'
    else if (label(/^k8s\.ovh\.net\//)) provider = 'ovh'
    else if (pid(/^hcloud:\/\//)) provider = 'hetzner'
    else if (pid(/^kind:\/\//)) provider = 'kind'
    let distro = null
    if (has('config.openshift.io') || label(/^node\.openshift\.io\//)) distro = 'openshift'
    else if (/\+k3s/.test(kv)) distro = 'k3s'
    else if (/\+rke2/.test(kv)) distro = 'rke2'
    else if (/\+k0s/.test(kv)) distro = 'k0s'
    else if (label(/^microk8s\.io\//) || any(n => /microk8s/i.test(n.labels['node.kubernetes.io/microk8s-controlplane'] || ''))) distro = 'microk8s'
    else if (any(n => /talos/i.test(n.os))) distro = 'talos'
    else if (label(/^run\.tanzu\.vmware\.com\//)) distro = 'tanzu'
    else if (provider && !['kind', 'eks-anywhere'].includes(provider)) distro = provider
    else if (cpPods.some(p => /^kube-apiserver-/.test(p))) distro = 'kubeadm'
    if (!provider) provider = distro && providerById(distro) ? distro : (label(/cattle\.io\//) ? 'rancher' : null)
    const clean = nodes.map(({ labels, providerID, ...n }) => n)
    return {
        provider: provider || 'unknown', distro: distro || 'kubernetes', version: kv.replace(/^v/, '') || null,
        nodeCount: nodes.length, controlPlanes: nodes.filter(n => n.role === 'control-plane').length, nodes: clean.slice(0, 500)
    }
}
