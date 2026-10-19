import { CheckCircle2, Info, Wrench, KeyRound, PlugZap, ListChecks, AlertTriangle } from 'lucide-react'
import { CopyBlock } from './shared'

// The setup guide of one provider: before you start → get access → connect →
// check → troubleshooting. With a connect session the commands are the real
// ones (copy and run); without one they show where they come from.
const EXTRA = {
    eks: {
        before: ['The AWS CLI, logged in (aws sts get-caller-identity works)', 'Your IAM user/role is a cluster admin (EKS → Access → access entry with AmazonEKSClusterAdminPolicy)'],
        trouble: [
            ['"Unauthorized" when running the command', 'Your IAM identity has no access entry on the cluster. EKS console → Access → Create access entry → policy AmazonEKSClusterAdminPolicy.'],
            ['KubeEZ cannot reach the API server', 'The endpoint is private, or "Public access source allowlist" does not include KubeEZ. Use the KubeEZ agent method, or add KubeEZ\'s address to the allowlist.']
        ]
    },
    aks: {
        before: ['The Azure CLI, logged in (az account show works)', 'With Microsoft Entra ID login: kubelogin installed (az aks install-cli), then kubelogin convert-kubeconfig -l azurecli'],
        trouble: [
            ['"kubelogin" or "devicecode" prompts', 'Run kubelogin convert-kubeconfig -l azurecli once, then the KubeEZ command again.'],
            ['KubeEZ cannot reach the API server', 'A private cluster, or "Authorized IP ranges" set. Use the KubeEZ agent method, or add KubeEZ\'s address.']
        ]
    },
    gke: {
        before: ['The gcloud CLI, logged in (gcloud auth list)', 'gke-gcloud-auth-plugin installed (gcloud components install gke-gcloud-auth-plugin)', 'Kubernetes Engine Admin on the project'],
        trouble: [
            ['"gke-gcloud-auth-plugin not found"', 'gcloud components install gke-gcloud-auth-plugin, then run get-credentials again.'],
            ['KubeEZ cannot reach the API server', 'A private cluster, or "Authorized networks" set. Use the KubeEZ agent method, or add KubeEZ\'s address.']
        ]
    },
    oke: {
        before: ['The OCI CLI, configured (oci iam region list works)', 'A user in a group with "manage cluster-family" in the compartment'],
        trouble: [['KubeEZ cannot reach the API server', 'The cluster has only a private endpoint, or the endpoint\'s security list blocks 6443. Use the KubeEZ agent method.']]
    },
    rancher: {
        before: ['Use the KubeEZ agent method: a Rancher kubeconfig goes through the Rancher server, which a KubeEZ token cannot pass'],
        trouble: [['The agent pod does not start', 'Check the project\'s Pod Security settings allow a non-root pod with no extra privileges (it needs none).']]
    },
    openshift: {
        before: ['oc (or kubectl) logged in as a cluster-admin (oc whoami)'],
        trouble: [['The agent pod is refused (SCC)', 'KubeEZ makes the manifest for OpenShift (no fixed user ID) when OpenShift is picked as the provider. Pick it, then apply the agent again.']]
    },
    kubeadm: {
        before: ['kubectl with admin.conf (on a control-plane node, or a copy)'],
        trouble: [['etcd backups and upgrades', 'Connect it, then add SSH in its connection settings — KubeEZ then backs up etcd and upgrades like its own clusters.']]
    },
    k3s: { before: ['kubectl, or sudo k3s kubectl on a server node'], trouble: [['The kubeconfig says https://127.0.0.1:6443', 'Run the command on the server node, or change the server address to the node\'s IP before running it elsewhere.']] },
    rke2: { before: ['kubectl from /var/lib/rancher/rke2/bin with KUBECONFIG=/etc/rancher/rke2/rke2.yaml'], trouble: [] },
    microk8s: { before: ['microk8s kubectl works on the node (or microk8s config exported)'], trouble: [] },
    talos: { before: ['talosctl and a kubeconfig from it'], trouble: [['No SSH on Talos', 'Talos has no shell — KubeEZ works through the Kubernetes API (etcd backups: talosctl etcd snapshot).']] }
}
const COMMON_TROUBLE = [
    ['"This connect command has expired"', 'A command is valid for 24 hours — open Add existing cluster again for a new one.'],
    ['x509: certificate signed by unknown authority', 'The kubeconfig\'s CA does not match the API server. Use the kubeconfig the provider gave you, or the KubeEZ agent method.'],
    ['Connected read-only although you chose Full manage', 'The kubectl context used could not grant cluster-admin. Run the command again as a cluster admin.'],
    ['The agent pod stays in ImagePullBackOff', 'The cluster cannot pull node:22-alpine from Docker Hub. Mirror it to your registry and change the image in the manifest.'],
    ['The agent is running but KubeEZ shows it offline', 'The pod must reach KubeEZ over HTTPS (outbound 443). Check egress rules / the proxy: kubectl -n kubeez-system logs deploy/kubeez-agent']
]

function Step({ n, icon: Icon, title, children }) {
    return (
        <div className="relative pl-10">
            <span className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full border border-blue-400/30 bg-blue-500/10 text-xs font-bold text-blue-200">{n}</span>
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-white"><Icon className="w-4 h-4 text-blue-300" />{title}</h4>
            <div className="mt-2 space-y-2 text-xs text-slate-300 leading-relaxed">{children}</div>
        </div>
    )
}

export default function Guide({ provider, commands = null, method = 'agent', compact = false }) {
    if (!provider) return null
    const x = EXTRA[provider.id] || { before: [], trouble: [] }
    const agentCmd = commands?.agent || 'kubectl apply -f "<the agent link from Add existing cluster>"'
    const helmCmd = commands?.helm || 'helm upgrade --install kubeez-agent "<the chart link from Add existing cluster>" --namespace kubeez-system --create-namespace'
    const connectCmd = commands?.connect?.sh || 'curl -fsSL "<the connect link from Add existing cluster>" | sh'
    const ps1 = commands?.connect?.ps1 || 'irm "<the connect link from Add existing cluster>" | iex'
    return (
        <div className="space-y-6">
            <Step n={1} icon={ListChecks} title="Before you start">
                <ul className="space-y-1">
                    {['kubectl on a machine that reaches the cluster (your laptop, a bastion, a node)', ...x.before].map(b => <li key={b} className="flex items-start gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />{b}</li>)}
                    {method === 'agent' && <li className="flex items-start gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />The cluster can reach KubeEZ over HTTPS (outbound only — nothing is opened towards the cluster)</li>}
                </ul>
            </Step>
            <Step n={2} icon={KeyRound} title={`Get access to the cluster${provider.vendor ? ` (${provider.vendor})` : ''}`}>
                <CopyBlock text={provider.getAccess} multiline />
                <p>Then check: <code className="text-sky-200">kubectl get nodes</code> lists your nodes.</p>
            </Step>
            <Step n={3} icon={PlugZap} title="Connect it to KubeEZ">
                {method === 'agent' ? <>
                    <CopyBlock text={agentCmd} label="Run where kubectl works" />
                    {!compact && <CopyBlock text={helmCmd} label="Or with Helm" />}
                    <p>This creates the namespace <code>kubeez-system</code> with the <code>kubeez</code> login (its permissions as you chose) and the KubeEZ agent, which connects out to KubeEZ.</p>
                </> : <>
                    <CopyBlock text={connectCmd} label="Linux / macOS (sh)" />
                    {!compact && <CopyBlock text={ps1} label="Windows (PowerShell)" />}
                    <p>It creates the <code>kubeez</code> login in the cluster and sends KubeEZ only the API address, its CA and that login's token. Your own cloud login never leaves your machine.</p>
                </>}
            </Step>
            <Step n={4} icon={CheckCircle2} title="Check">
                <p>KubeEZ checks the cluster within seconds: the page shows what it found (provider, Kubernetes version, nodes) and what works. {method === 'agent' && <>In the cluster: <code className="text-sky-200">kubectl -n kubeez-system get pods</code> shows <code>kubeez-agent</code> Running.</>}</p>
            </Step>
            {!compact && (
                <Step n={5} icon={Wrench} title="Troubleshooting">
                    <div className="space-y-2">
                        {[...x.trouble, ...COMMON_TROUBLE].map(([q, a]) => (
                            <div key={q} className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                                <p className="flex items-center gap-1.5 font-medium text-slate-200"><AlertTriangle className="w-3.5 h-3.5 text-amber-300" />{q}</p>
                                <p className="mt-1 text-slate-400">{a}</p>
                            </div>
                        ))}
                    </div>
                </Step>
            )}
            {provider.privateHint && <p className="flex items-start gap-1.5 text-[11px] text-slate-400"><Info className="w-3.5 h-3.5 mt-0.5 text-sky-300 shrink-0" />{provider.privateHint}</p>}
        </div>
    )
}
