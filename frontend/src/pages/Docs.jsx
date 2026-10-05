import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
    BookOpen, Server, Terminal, CheckCircle2, Cloud, Cpu, Shield, Users, Activity,
    Copy, Check, ArrowUpCircle, RotateCcw, Puzzle, DatabaseBackup, HeartPulse,
    LifeBuoy, LayoutGrid, Info, AlertTriangle, Plus, HardDrive
} from 'lucide-react'

// ── Small building blocks ────────────────────────────────────────────────────

function Code({ children }) {
    const [copied, setCopied] = useState(false)
    return (
        <div className="relative group">
            <pre className="bg-black/50 border border-white/5 rounded-xl p-4 pr-12 text-xs font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">{children}</pre>
            <button
                onClick={() => { navigator.clipboard.writeText(children); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                className="absolute top-2.5 right-2.5 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400"
                title="Copy"
            >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
        </div>
    )
}

function Note({ kind = 'info', children }) {
    const style = kind === 'warn'
        ? 'border-amber-500/20 bg-amber-500/5 text-amber-200'
        : 'border-blue-500/20 bg-blue-500/5 text-blue-200'
    const Icon = kind === 'warn' ? AlertTriangle : Info
    return (
        <div className={`flex items-start gap-3 rounded-2xl border p-4 text-sm leading-relaxed ${style}`}>
            <Icon className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{children}</div>
        </div>
    )
}

function Steps({ items }) {
    return (
        <ol className="space-y-3">
            {items.map((t, i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-slate-300 leading-relaxed">
                    <span className="w-6 h-6 rounded-full bg-blue-500/15 text-blue-300 flex items-center justify-center text-xs font-black shrink-0">{i + 1}</span>
                    <span>{t}</span>
                </li>
            ))}
        </ol>
    )
}

function Table({ head, rows }) {
    return (
        <div className="overflow-x-auto rounded-2xl border border-white/5">
            <table className="w-full text-sm">
                <thead className="bg-white/[0.03] text-left">
                    <tr>{head.map(h => <th key={h} className="px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-slate-400">{h}</th>)}</tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i} className="border-t border-white/5 align-top">
                            {r.map((c, j) => <td key={j} className={`px-4 py-2.5 ${j === 0 ? 'font-bold text-white' : 'text-slate-400'}`}>{c}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function Section({ id, Icon, color, title, intro, children }) {
    return (
        <section id={id} className="space-y-5 pt-14 border-t border-white/5 first:border-0 first:pt-0 scroll-mt-24">
            <h2 className="text-2xl font-black tracking-tight text-white flex items-center">
                <Icon className={`w-6 h-6 mr-3 ${color}`} /> {title}
            </h2>
            {intro && <p className="text-slate-400 text-sm max-w-3xl leading-relaxed">{intro}</p>}
            {children}
        </section>
    )
}

const H4 = ({ children }) => <h3 className="text-base font-black text-white pt-2">{children}</h3>
const P = ({ children }) => <p className="text-sm text-slate-400 leading-relaxed max-w-3xl">{children}</p>
const C = ({ children }) => <code className="text-blue-300 bg-blue-500/10 px-1.5 py-0.5 rounded text-[12px]">{children}</code>

// ── Navigation ──────────────────────────────────────────────────────────────

const NAV = [
    { title: 'Getting Started', items: [
        { id: 'intro', label: 'What is KubeEZ' },
        { id: 'modes', label: 'SaaS vs Self-Hosted' },
        { id: 'requirements', label: 'Node Requirements' },
        { id: 'agents', label: 'Gateway Agent' }
    ] },
    { title: 'Clusters', items: [
        { id: 'deploy', label: 'Deploy a Cluster' },
        { id: 'cluster-page', label: 'The Cluster Page' },
        { id: 'resume', label: 'Resume a Failed Install' },
        { id: 'upgrade', label: 'Upgrade Kubernetes' },
        { id: 'scale', label: 'Scale & Terminal' }
    ] },
    { title: 'Add-ons', items: [
        { id: 'addons', label: 'Add-on Catalogue' },
        { id: 'addon-manage', label: 'Manage, Logs & Uninstall' },
        { id: 's3', label: 'S3 Object Storage' }
    ] },
    { title: 'Backups', items: [
        { id: 'etcd', label: 'etcd Snapshots & Restore' },
        { id: 'volume-backups', label: 'Volume Backups' },
        { id: 'offsite', label: 'Offsite Backups' },
        { id: 'recovery', label: 'Disaster Recovery' },
        { id: 'config-backups', label: 'Config Backups' }
    ] },
    { title: 'Operations', items: [
        { id: 'healing', label: 'Auto-Healing & Incidents' },
        { id: 'roles', label: 'Teams & Roles' },
        { id: 'plans', label: 'Plans' },
        { id: 'troubleshooting', label: 'Troubleshooting' }
    ] }
]

export default function Docs() {
    const [active, setActive] = useState('intro')

    // Highlight the section being read
    useEffect(() => {
        const obs = new IntersectionObserver(entries => {
            const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
            if (top) setActive(top.target.id)
        }, { rootMargin: '-20% 0px -70% 0px' })
        document.querySelectorAll('section[id]').forEach(s => obs.observe(s))
        return () => obs.disconnect()
    }, [])

    const go = (id) => {
        setActive(id)
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
    }

    return (
        <div className="min-h-screen py-8 px-4 sm:px-6">
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-8">

                {/* Sidebar (desktop) */}
                <nav className="hidden lg:block lg:col-span-1">
                    <div className="sticky top-24 space-y-7 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
                        {NAV.map(group => (
                            <div key={group.title}>
                                <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">{group.title}</h3>
                                <ul className="space-y-2.5">
                                    {group.items.map(item => (
                                        <li key={item.id}>
                                            <button onClick={() => go(item.id)}
                                                className={`text-xs font-bold tracking-wide transition-all text-left ${active === item.id
                                                    ? 'text-blue-400 pl-2 border-l-2 border-blue-400'
                                                    : 'text-slate-400 hover:text-white border-l-2 border-transparent'}`}>
                                                {item.label}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </nav>

                {/* Topics (phones/tablets) */}
                <div className="lg:hidden -mx-4 px-4 flex gap-2 overflow-x-auto pb-2">
                    {NAV.flatMap(g => g.items).map(item => (
                        <button key={item.id} onClick={() => go(item.id)}
                            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border ${active === item.id ? 'bg-blue-600 border-blue-500 text-white' : 'border-white/10 text-slate-400'}`}>
                            {item.label}
                        </button>
                    ))}
                </div>

                <div className="lg:col-span-3 space-y-14 pb-16">

                    {/* ── Getting started ─────────────────────────────── */}
                    <section id="intro" className="space-y-6 scroll-mt-24">
                        <div className="flex items-center gap-4">
                            <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-2xl"><BookOpen className="w-6 h-6 text-blue-400" /></div>
                            <div>
                                <h1 className="text-2xl font-black text-white tracking-tight">KubeEZ Documentation</h1>
                                <p className="text-sm text-slate-400 mt-1">Production Kubernetes on your own servers — without the ops work</p>
                            </div>
                        </div>
                        <P>
                            KubeEZ installs, upgrades, backs up and operates Kubernetes clusters on servers you own (bare metal, VMs, any cloud).
                            Everything runs from one console, every step streams a live log, and when something fails you get the exact reason and the fix.
                        </P>
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                            {[
                                [Server, 'Deploy', 'Guided install with pre-flight checks on 8 Linux distros.'],
                                [ArrowUpCircle, 'Upgrade', '1.27 → 1.37, one version at a time, snapshot first.'],
                                [Puzzle, 'Add-ons', '8 add-ons — install, repair, uninstall, logs from the UI.'],
                                [DatabaseBackup, 'Back up', 'Verified snapshots, previewed restores with undo, volume data, offsite copies, disaster recovery.'],
                                [HeartPulse, 'Heal', 'Detects node and pod problems and fixes what it safely can.'],
                                [Users, 'Teams', 'Admin / Operator / Viewer roles in isolated workspaces.']
                            ].map(([Icon, t, d]) => (
                                <div key={t} className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
                                    <div className="flex items-center gap-2 mb-1"><Icon className="w-4 h-4 text-blue-400" /><span className="text-sm font-black text-white">{t}</span></div>
                                    <p className="text-xs text-slate-400 leading-relaxed">{d}</p>
                                </div>
                            ))}
                        </div>
                    </section>

                    <Section id="modes" Icon={Cloud} color="text-purple-400" title="SaaS vs Self-Hosted"
                        intro={<>KubeEZ runs in one of two modes, set with the <C>KUBEEZ_MODE</C> environment variable.</>}>
                        <Table head={['', 'Self-Hosted', 'SaaS']} rows={[
                            ['How KubeEZ reaches nodes', 'Direct SSH over your network / VPN', 'Through the Gateway Agent (outbound tunnel)'],
                            ['Inbound ports on your network', 'SSH (22) from the KubeEZ server', 'None'],
                            ['Activation', 'License key', 'Subscription plan'],
                            ['Best for', 'Air-gapped or fully private setups', 'Managing many sites from one hosted console']
                        ]} />
                    </Section>

                    <Section id="requirements" Icon={Cpu} color="text-orange-400" title="Node Requirements">
                        <Table head={['', 'Requirement']} rows={[
                            ['Operating system', 'Ubuntu 22.04 / 24.04, Debian 12, Rocky Linux 9, AlmaLinux 9, Fedora, Amazon Linux 2023 (all tested end-to-end), RHEL 8 / 9. Kubernetes 1.35+ needs cgroups v2 and a 5.x kernel — CentOS 7 / RHEL 7 are supported up to Kubernetes 1.34.'],
                            ['CPU / memory', 'Control plane: 2 vCPU, 4 GB RAM recommended. Workers: 2 vCPU, 2 GB RAM minimum.'],
                            ['Disk', '20 GB+ recommended; upgrades need at least 2 GB free on /var.'],
                            ['Network', 'Outbound HTTPS to pkgs.k8s.io, registry.k8s.io and Docker Hub. Nodes must reach each other (6443, 10250, 30000–32767).'],
                            ['Access', 'root or a sudo user. In Self-Hosted mode SSH (port 22) must be open.']
                        ]} />
                        <Note>If SSH is refused, run this one line on the node (Ubuntu/Debian):</Note>
                        <Code>{"sudo apt-get update && sudo apt-get install -y openssh-server && sudo systemctl enable --now ssh && { command -v ufw >/dev/null && sudo ufw allow ssh || true; }"}</Code>
                    </Section>

                    <Section id="agents" Icon={Activity} color="text-emerald-400" title="Gateway Agent"
                        intro="In SaaS mode KubeEZ cannot SSH into private servers. A lightweight agent on your network opens an outbound, encrypted WebSocket tunnel instead — no inbound firewall rules.">
                        <Steps items={[
                            <>Open <b>Tunnels</b> in the header (Gateway Agents) and click <b>Generate Token</b>.</>,
                            'Paste the generated one-line installer into a terminal on a machine in your network (Linux, macOS or Windows). It downloads a portable runtime if needed.',
                            <>The agent appears as <b>Online</b>. Clusters in that workspace are now installed and managed through it.</>
                        ]} />
                        <H4>Stays connected — no new token needed</H4>
                        <Table head={['Situation', 'What happens']} rows={[
                            ['Network drop / KubeEZ restart', 'The agent reconnects by itself (2 s, 4 s … up to 60 s between tries). A link that dies silently is detected within 60 s.'],
                            ['Agent crashes or the machine reboots', 'The installer sets it up as a service: systemd (Linux, root or sudo), launchd (macOS) or a Scheduled Task (Windows, starts at boot when run as Administrator). Without sudo on Linux it falls back to a user service or cron.'],
                            ['Agent was removed from the machine', <>Tunnels → the agent → <b>Install / Reconnect</b> shows the same command again (same token). Running it twice is safe — it replaces the old copy.</>],
                            ['Agent deleted in KubeEZ', 'Its token stops working and the agent stops itself instead of retrying forever.']
                        ]} />
                        <Code>{"sudo systemctl status kubeez-agent      # Linux service\njournalctl -u kubeez-agent -f            # live log"}</Code>
                        <Note>Long operations (add-ons up to 30 min, upgrades up to 45 min) are given matching relay time-outs, so they are not cut off midway.</Note>
                    </Section>

                    {/* ── Clusters ────────────────────────────────────── */}
                    <Section id="deploy" Icon={Terminal} color="text-rose-400" title="Deploy a Cluster">
                        <Steps items={[
                            <>Click <b>Deploy New Cluster</b> on the dashboard.</>,
                            'Add the control-plane and worker nodes (IP + SSH user/password or key; in SaaS mode the Gateway Agent must be online).',
                            'Pick the Kubernetes version (1.27 – 1.37; 1.35 / 1.36 / 1.37 receive upstream security fixes), the network plugin (Flannel or Calico) and any add-ons.',
                            'Pre-flight checks verify connectivity, OS, CPU, memory and ports before anything is installed.',
                            'Start. Every step streams a live log with a progress bar. On a failure you see the reason and the fix, with Auto-Fix & Resume where possible.'
                        ]} />
                    </Section>

                    <Section id="cluster-page" Icon={LayoutGrid} color="text-sky-400" title="The Cluster Page"
                        intro="Open a cluster from the dashboard. Actions (Kubeconfig, Terminal, Scale, Upgrade) are in the header; the rest is grouped in three tabs.">
                        <Table head={['Tab', 'What you find there']} rows={[
                            ['Overview', 'Version, network plugin, nodes, API endpoint · 3D / list topology · live CPU, memory and disk.'],
                            ['Add-ons', <><b>Access & logins</b>: URLs, usernames, passwords, web UIs. <b>Manage & logs</b>: health, pods, logs, Install / Repair / Reinstall / Uninstall.</>],
                            ['Backups', 'etcd snapshots (Backup Now, verify, preview + restore, undo), disaster recovery, Offsite Backup settings and Volume Backups.']
                        ]} />
                        <P>The open tab is part of the address (e.g. <C>?tab=backups</C>), so refresh, the back button and shared links keep you in place. If a cluster failed, a banner at the top says what to do next with one-click buttons.</P>
                    </Section>

                    <Section id="resume" Icon={RotateCcw} color="text-sky-400" title="Resume a Failed Install"
                        intro="If an installation stops (network drop, a node down, a cancelled run), you do not start over.">
                        <Steps items={[
                            <>On the cluster page click <b>Resume Installation</b>.</>,
                            'KubeEZ inspects the real cluster: container runtime, Kubernetes packages, control plane, network plugin (in any namespace), joined workers and each add-on.',
                            'It resumes at the first unfinished step and skips everything already done — joined workers are never joined again, healthy add-ons are not reinstalled.'
                        ]} />
                        <Note>A failed add-on no longer marks the whole cluster as failed — repair it from <b>Add-ons → Manage & logs</b> instead.</Note>
                    </Section>

                    <Section id="upgrade" Icon={ArrowUpCircle} color="text-emerald-400" title="Upgrade Kubernetes"
                        intro="Click Upgrade in the cluster header. Kubernetes only supports one minor version per step (e.g. 1.36 → 1.37), so that is what KubeEZ offers.">
                        <Steps items={[
                            'Pre-flight checks: version path, package availability, registry access, free disk, API health.',
                            'An automatic etcd snapshot is taken first (kept 45 days) — your way back if anything goes wrong.',
                            'The control plane is upgraded, then kubelet and kubectl on every node. Known issues are repaired automatically (old kubelet flags, sandbox image, containerd 2.x for 1.36+, stale kubeadm-config after a restore).',
                            'Transient problems (time-outs, API not answering yet) are retried once automatically.'
                        ]} />
                        <Note kind="warn">If an upgrade fails, the screen shows the exact reason and whether the cluster was changed. Usually it still runs the old version — click <b>Retry upgrade</b>. If the cluster is broken, restore the <b>Before upgrade (automatic)</b> snapshot from the Backups tab.</Note>
                    </Section>

                    <Section id="scale" Icon={Plus} color="text-blue-400" title="Scale & Terminal">
                        <P><b className="text-white">Scale</b> adds worker nodes to a running cluster with a fresh join token. <b className="text-white">Terminal</b> opens a browser shell on the cluster nodes (Operator / Admin). <b className="text-white">Kubeconfig</b> downloads admin access for kubectl.</P>
                    </Section>

                    {/* ── Add-ons ─────────────────────────────────────── */}
                    <Section id="addons" Icon={Puzzle} color="text-fuchsia-400" title="Add-on Catalogue"
                        intro="Install add-ons during deployment or later from Add-ons → Manage & logs → Install. Web UIs are exposed on these ports of any node IP.">
                        <Table head={['Add-on', 'What it does', 'Access']} rows={[
                            ['Nginx Ingress', 'HTTP/HTTPS routing for Ingress resources', 'NodePorts shown in Access & logins'],
                            ['Prometheus + Grafana', 'Metrics and dashboards (KubeEZ overview dashboard included)', 'Grafana :30000 · Prometheus :30090'],
                            ['Kubernetes Dashboard', 'Official web UI (24-hour login token shown in KubeEZ)', 'https :30643'],
                            ['cert-manager', 'Automatic TLS certificates; a self-signed ClusterIssuer is ready', 'in-cluster'],
                            ['Longhorn', 'Replicated block storage; becomes the default StorageClass', 'UI :30080'],
                            ['ArgoCD', 'GitOps delivery', 'https :30443'],
                            ['S3 Object Storage (SeaweedFS)', 'S3-compatible storage with a ready "backups" bucket + web admin UI', 'S3 :30833 · Web UI :30834']
                        ]} />
                        <P>Logins and tokens are shown under <b className="text-white">Access & logins</b> — no server login needed. Viewers see the URLs but never the credentials.</P>
                    </Section>

                    <Section id="addon-manage" Icon={Puzzle} color="text-fuchsia-400" title="Manage, Logs & Uninstall"
                        intro="Add-ons → Manage & logs lists every add-on with its live health (Healthy, Starting, Failing, Not installed). Click the line under a name to see its pods, readiness, restarts and why a container is stuck.">
                        <Table head={['Action', 'What happens']} rows={[
                            ['Logs', 'Pod logs (all containers), the log of the run that crashed, and recent events. Auto-refresh available.'],
                            ['Repair', 'Runs the installer again. Fixes missing or broken parts — keeps data, settings and credentials.'],
                            ['Reinstall', 'Removes the add-on completely, then installs it fresh (new settings and credentials).'],
                            ['Uninstall', 'Removes the namespace and everything the add-on created in the cluster (CRDs, roles, webhooks).'],
                            ['Install', 'Shown for add-ons that are not installed.']
                        ]} />
                        <Note kind="warn">Uninstalling SeaweedFS or Longhorn deletes data, so you type the add-on name to confirm. Longhorn is refused while any volume still uses it, and runs Longhorn&apos;s official uninstaller.</Note>
                        <P>Every action runs as a job with a live log, and only one job runs per cluster at a time.</P>
                    </Section>

                    <Section id="s3" Icon={Cloud} color="text-cyan-400" title="S3 Object Storage (SeaweedFS)">
                        <Table head={['Port', 'Use it for']} rows={[
                            [':30833 — S3 endpoint', 'Apps, aws CLI, rclone, S3 Browser — and as the Offsite Backup target of OTHER clusters. Needs the access key and secret key.'],
                            [':30834 — Web UI', 'Browse files and buckets in a browser. Login: user admin + the Web UI password from Access & logins.']
                        ]} />
                        <Note>Opening the S3 endpoint (:30833) in a browser shows <b>AccessDenied</b> — that is correct: browsers send no keys. Use the Web UI (:30834) to browse.</Note>
                        <Code>{"AWS_ACCESS_KEY_ID='<access key>' AWS_SECRET_ACCESS_KEY='<secret key>' aws --endpoint-url http://<node-ip>:30833 --region us-east-1 s3 ls s3://backups/"}</Code>
                        <P>Installs that predate the web UI get it with <b className="text-white">Repair</b> — S3 keys and data stay the same.</P>
                    </Section>

                    {/* ── Backups ─────────────────────────────────────── */}
                    <Section id="etcd" Icon={DatabaseBackup} color="text-cyan-400" title="etcd Snapshots & Restore"
                        intro="etcd holds the whole cluster state (deployments, services, secrets…). Snapshots live on the control-plane node in /var/lib/etcd-backup.">
                        <Table head={['', '']} rows={[
                            ['When', <><b>Backup Now</b> (manual), automatically <b>before every upgrade</b> and <b>before every restore</b> (your undo point).</>],
                            ['Verified', 'Every snapshot is checked with etcd’s own integrity check and gets a SHA-256 checksum. “Verify” re-checks a snapshot any time.'],
                            ['Retention', '45 days; the newest snapshot is always kept. Old restore leftovers on the node are cleaned up (newest 2 kept).'],
                            ['HA clusters', 'Supported: the other control-planes are stopped first and re-join the restored etcd one by one.']
                        ]} />
                        <P>A restore runs in the background with a live log — you can close the page and come back.</P>
                        <Steps items={[
                            <><b>Preview</b> — KubeEZ reads the snapshot (with a throw-away etcd, nothing is touched) and lists what will be <b>removed</b> (created after the snapshot), what <b>comes back</b> (deleted after it) and what is <b>reverted</b> (edited after it). Volumes created or deleted since are flagged.</>,
                            <><b>Confirm</b> by typing the cluster name.</>,
                            'Checks first: checksum + integrity and free disk space. A damaged snapshot is refused before anything stops.',
                            <>A <b>safety snapshot</b> of the current state is taken, then the control plane is stopped, the snapshot restored (with etcd’s revision moved forward so every controller re-reads the restored state) and the control plane started again.</>,
                            <>If the control plane does not come back, KubeEZ <b>rolls back automatically</b> to the data from before the restore.</>,
                            <>Done: kubelets on every node are refreshed (<b>Refresh workers</b> retries ones that were offline) and <b>Undo this restore</b> brings back the state from right before it.</>
                        ]} />
                        <Note kind="warn">A restore rolls the cluster <b>state</b> back — not the Kubernetes version (binaries stay) and not the files inside volumes (see Volume Backups). Everything created after the snapshot is gone; the preview shows what.</Note>
                    </Section>

                    <Section id="volume-backups" Icon={HardDrive} color="text-violet-400" title="Volume Backups (Velero)"
                        intro="etcd snapshots never contain the data inside persistent volumes. Volume Backups copy those files — databases, uploads — together with the namespace’s objects to S3-compatible storage, using Velero.">
                        <Steps items={[
                            <>Backups tab → <b>Volume Backups</b>: use the workspace’s offsite storage or enter separate storage (recommended: a key that can only reach one bucket — Velero runs inside the cluster, so the key is stored there).</>,
                            <><b>Save &amp; install Velero</b> — installs Velero and a small agent on every node, then checks it can reach the storage.</>,
                            <><b>Back up</b> chosen namespaces (or everything) any time, and turn on <b>automatic backups</b> (daily at 02:00 by default, kept 30 days).</>
                        ]} />
                        <Table head={['Restore mode', 'What happens']} rows={[
                            ['Bring back what is missing', 'Deleted apps come back with their volume data; existing objects are not touched.'],
                            ['Restore as a copy', 'Into new namespaces <name>-restored-<time> next to the original — compare or recover single files.'],
                            ['Replace', 'Deletes the chosen namespaces, then restores them from the backup (typed confirmation). Data written since the backup is lost.']
                        ]} />
                        <Note>Volume data is copied at file level from running pods, so it works with any storage (Longhorn, local, NFS…). Uninstalling Velero keeps the backups in the bucket.</Note>
                    </Section>

                    <Section id="offsite" Icon={Cloud} color="text-indigo-400" title="Offsite Backups"
                        intro="A copy of every snapshot outside the cluster survives losing the control-plane disk. Connect it in Backups → Offsite Backup.">
                        <Table head={['Storage', 'Endpoint', 'Region']} rows={[
                            ['AWS S3', 'filled in automatically', 'your bucket region, e.g. ap-south-1'],
                            ['MinIO / SeaweedFS (on-prem)', 'http(s)://<server>:<port> — address only, no bucket', 'us-east-1'],
                            ['Cloudflare R2', 'https://<account-id>.r2.cloudflarestorage.com', 'auto'],
                            ['Backblaze B2 / Wasabi', 'https://s3.<region>.backblazeb2.com / s3.<region>.wasabisys.com', 'the provider region']
                        ]} />
                        <Steps items={[
                            'Create a bucket and an access key allowed to Put, Get, List and Delete in it.',
                            'Enter endpoint, bucket and keys → Test connection → Test & Connect.',
                            <><b>Download the recovery key</b> shown once. Bundles are encrypted with it (AES-256) — without it a backup cannot be opened if KubeEZ itself is lost.</>,
                            'New snapshots are copied automatically (after Backup Now, each upgrade and each restore); use Sync now any time.'
                        ]} />
                        <Note>The upload runs from the cluster&apos;s control-plane, so it must reach the storage. Your keys stay encrypted in KubeEZ — the node only receives short-lived signed links.</Note>
                        <Note kind="warn">Storage on a node of the same cluster is not offsite — KubeEZ warns about it. Use another cluster, another server or a cloud bucket.</Note>
                        <P>Decrypt a bundle by hand:</P>
                        <Code>{"openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:<RECOVERY-KEY> -in <file>.tar.gz.enc | tar xz"}</Code>
                    </Section>

                    <Section id="recovery" Icon={LifeBuoy} color="text-sky-400" title="Disaster Recovery"
                        intro="When the control-plane MACHINE is lost (disk failure, deleted VM), KubeEZ rebuilds it from an encrypted offsite backup — the cluster keeps its identity, so workers, kubeconfigs and service-account tokens stay valid.">
                        <Steps items={[
                            <>Bring up a fresh Linux machine with the <b>same IP</b> and the same SSH login as the lost control-plane.</>,
                            <>Backups tab → <b>Control-plane machine lost? → Recover</b>, pick an offsite backup, type the cluster name.</>,
                            'KubeEZ prepares the machine, downloads and decrypts the bundle on it, installs the Kubernetes version the backup was taken on, puts the certificate authorities back, restores etcd and lets kubeadm rebuild the control plane around it.',
                            'Workers reconnect by themselves; still-running control-planes of an HA cluster are re-joined.'
                        ]} />
                        <Note>A snapshot whose local copy is gone (pruned, disk replaced) shows as <b>offsite only</b> — <b>Download from offsite</b> brings it back to the control-plane, then preview and restore it like any other.</Note>
                    </Section>

                    <Section id="config-backups" Icon={Shield} color="text-amber-400" title="Config Backups"
                        intro="Workspace Settings → Config Backups saves KubeEZ's own records (clusters, node connections, settings) daily, encrypted, with one-click restore of your workspace's data.">
                    </Section>

                    {/* ── Operations ──────────────────────────────────── */}
                    <Section id="healing" Icon={HeartPulse} color="text-rose-400" title="Auto-Healing & Incidents"
                        intro="Healthy clusters are watched continuously. Incidents are listed on the Incidents & Auto-Healing page with what was detected and what was done.">
                        <Table head={['Detected', 'What KubeEZ does']} rows={[
                            ['Node down (NotReady)', 'Restarts containerd + kubelet on that node, then verifies it is Ready again.'],
                            ['Disk / memory / process pressure', 'Frees space (old images, exited containers, journals, oversized logs are emptied — never deleted), drops caches, clears zombie processes.'],
                            ['Pod crash loop', 'Saves the last log lines, then deletes the pod so its controller recreates it.'],
                            ['Out of memory, image pull failure, pod stuck Pending', 'Explains the cause (limits, image name / pull secret, resources or taints) — these need your decision.']
                        ]} />
                        <P>A problem that keeps happening stays <b className="text-white">one</b> incident (&quot;seen 12×&quot;); a fix is retried at most 3 times. When the problem goes away it is marked <b className="text-white">Cleared</b>. Incidents are kept 24 hours and survive a KubeEZ restart. If a cluster can&apos;t be reached, the page says so instead of showing &quot;all healthy&quot;.</P>
                    </Section>

                    <Section id="roles" Icon={Users} color="text-blue-400" title="Teams & Roles"
                        intro="Each workspace is isolated: members only see their workspace's clusters. Invite members from the user menu → Team & Roles.">
                        <Table head={['Role', 'Can do']} rows={[
                            ['Org Admin', 'Everything in the workspace: clusters, add-ons, backups, team, billing.'],
                            ['Operator', 'Create, scale, upgrade and manage clusters, add-ons and backups — not team or billing.'],
                            ['Viewer', 'Read-only: clusters, health, incidents, which add-ons run and their URLs — never credentials or tokens, no changes.']
                        ]} />
                    </Section>

                    <Section id="plans" Icon={CheckCircle2} color="text-emerald-400" title="Plans">
                        <Table head={['', 'Free', 'Pro / Enterprise']} rows={[
                            ['Deploy, upgrade, scale, resume', '✓', '✓'],
                            ['Add-ons', 'Kubernetes Dashboard', 'All add-ons'],
                            ['etcd snapshots & restore', '—', '✓'],
                            ['Restore preview, undo, automatic rollback', '—', '✓'],
                            ['Offsite backups & disaster recovery', '—', '✓'],
                            ['Volume backups (Velero)', '—', '✓'],
                            ['Daily config backups', '—', '✓']
                        ]} />
                        <P>Cluster and node limits depend on the plan — see <Link to="/pricing" className="text-blue-400 hover:underline">Pricing</Link>.</P>
                    </Section>

                    <Section id="troubleshooting" Icon={LifeBuoy} color="text-amber-400" title="Troubleshooting"
                        intro="Failures show a reason and a fix on screen. The most common ones:">
                        <Table head={['You see', 'What it means / what to do']} rows={[
                            ['SSH Connection Refused', 'No SSH server on the node — run the one-line fix from Node Requirements.'],
                            ['AccessDenied at :30833 in a browser', 'Normal — it is the S3 API. Use the Web UI at :30834.'],
                            ['Offsite test: "not an S3 API"', 'The address is a web page or the wrong port — for KubeEZ S3 use :30833.'],
                            ['Offsite test: bucket does not exist', 'Create the bucket first (KubeEZ S3 creates "backups").'],
                            ['Upgrade: API server did not answer', 'Retried automatically; if it persists check kube-apiserver with crictl on the master.'],
                            ['Upgrade: kubeadm-config is older than the control plane', 'Happens after restoring a pre-upgrade snapshot — KubeEZ corrects it automatically; just retry.'],
                            ['Restore: “The snapshot is damaged”', 'Its checksum or etcd’s integrity check failed — nothing was changed. Pick another snapshot (or download its offsite copy).'],
                            ['Restore: “rolled the cluster back automatically”', 'The control plane did not start on the restored data; the cluster runs on its previous data. The failed attempt is kept in /var/lib/etcd-failed-restore-<time> for diagnosis.'],
                            ['Recovery: “does not have the IP …”', 'The replacement machine must use the lost control-plane’s IP so the workers can find it.'],
                            ['Volume Backups: storage unavailable', 'Velero cannot reach the bucket — check endpoint, bucket and keys, save, then Repair Velero in Add-ons.'],
                            ['Add-on Failing / Starting for long', 'Add-ons → Manage & logs → Logs shows why (image pull, storage pending, crash). Fix, then Repair.'],
                            ['Install stopped midway', 'Resume Installation — finished steps are skipped.']
                        ]} />
                    </Section>
                </div>
            </div>
        </div>
    )
}
