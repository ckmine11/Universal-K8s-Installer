import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
    Bell, BookOpen, Server, Terminal, CheckCircle2, Cloud, Cpu, Shield, Users, Activity,
    Copy, Check, ArrowUpCircle, RotateCcw, Puzzle, DatabaseBackup, HeartPulse, Search,
    LifeBuoy, LayoutGrid, Info, AlertTriangle, Plus, HardDrive, Compass, ShieldCheck, Rocket,
    HelpCircle, Lock, Settings as SettingsIcon, X, Bot
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'

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
        : kind === 'tip'
            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-200'
            : 'border-blue-500/20 bg-blue-500/5 text-blue-200'
    const Icon = kind === 'warn' ? AlertTriangle : kind === 'tip' ? CheckCircle2 : Info
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
                    <tr>{head.map((h, k) => <th key={k} className="px-4 py-2.5 text-[11px] font-black uppercase tracking-wider text-slate-400">{h}</th>)}</tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i} className="border-t border-white/5 align-top">
                            {r.map((c, j) => <td key={j} className={`px-4 py-2.5 ${j === 0 ? 'font-bold text-white whitespace-nowrap' : 'text-slate-400'}`}>{c}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function Section({ id, Icon, color, title, intro, children }) {
    return (
        <section id={id} className="space-y-5 pt-14 border-t border-white/5 scroll-mt-24">
            <h2 className="text-2xl font-black tracking-tight text-white flex items-center">
                <Icon className={`w-6 h-6 mr-3 ${color}`} /> {title}
            </h2>
            {intro && <p className="text-slate-300 text-sm max-w-3xl leading-relaxed">{intro}</p>}
            {children}
        </section>
    )
}

function Faq({ items }) {
    return (
        <div className="space-y-2">
            {items.map(([q, a]) => (
                <details key={q} className="group rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-3 text-sm font-bold text-white">
                        {q}<Plus className="w-4 h-4 text-slate-500 shrink-0 transition-transform group-open:rotate-45" />
                    </summary>
                    <p className="text-sm text-slate-400 leading-relaxed mt-2">{a}</p>
                </details>
            ))}
        </div>
    )
}

const H4 = ({ children }) => <h3 className="text-base font-black text-white pt-2">{children}</h3>
const P = ({ children }) => <p className="text-sm text-slate-400 leading-relaxed max-w-3xl">{children}</p>
const C = ({ children }) => <code className="text-blue-300 bg-blue-500/10 px-1.5 py-0.5 rounded text-[12px]">{children}</code>
const B = ({ children }) => <b className="text-white">{children}</b>

// ── Navigation (keywords make the search find a topic by what people type) ──

const NAV = [
    { title: 'Getting Started', items: [
        { id: 'intro', label: 'What is KubeEZ', k: 'overview about' },
        { id: 'quickstart', label: 'Quick Start', k: 'first cluster begin start' },
        { id: 'console', label: 'Finding Your Way', k: 'sidebar menu search ctrl k navigation' },
        { id: 'account', label: 'Sign-in & Password', k: 'login forgot reset change password email' },
        { id: 'requirements', label: 'Server Requirements', k: 'os ubuntu debian rocky cpu ram disk ports ssh' },
        { id: 'agents', label: 'Gateway Agent', k: 'private network tunnel saas firewall offline' }
    ] },
    { title: 'Clusters', items: [
        { id: 'deploy', label: 'Deploy a Cluster', k: 'install create new ha virtual ip control plane' },
        { id: 'cluster-page', label: 'The Cluster Page', k: 'overview tabs' },
        { id: 'access', label: 'kubectl & Terminal', k: 'kubeconfig shell ssh node command' },
        { id: 'scale', label: 'Add Worker Nodes', k: 'scale join worker' },
        { id: 'upgrade', label: 'Upgrade Kubernetes', k: 'version update' },
        { id: 'resume', label: 'Resume a Failed Install', k: 'retry failed stopped' },
        { id: 'remove', label: 'Remove a Cluster', k: 'delete' }
    ] },
    { title: 'Add-ons', items: [
        { id: 'addons', label: 'Add-on Catalogue', k: 'ingress grafana prometheus longhorn argocd vault harbor jenkins ports' },
        { id: 'addon-settings', label: 'Settings & Updates', k: 'customize version helm yaml update new version' },
        { id: 'addon-manage', label: 'Health, Logs & Uninstall', k: 'repair reinstall logs failing' },
        { id: 'explorer', label: 'KubeEZ Explorer', k: 'ui resources topology timeline helm' },
        { id: 's3', label: 'S3 Object Storage', k: 'seaweedfs bucket' }
    ] },
    { title: 'Backups', items: [
        { id: 'etcd', label: 'Cluster Snapshots', k: 'etcd backup restore undo' },
        { id: 'volume-backups', label: 'Volume Backups', k: 'velero data pvc' },
        { id: 'offsite', label: 'Offsite Backups', k: 's3 r2 b2 wasabi minio encryption key' },
        { id: 'recovery', label: 'Disaster Recovery', k: 'control plane lost rebuild' },
        { id: 'config-backups', label: 'KubeEZ Config Backups', k: 'settings' }
    ] },
    { title: 'Operations', items: [
        { id: 'healing', label: 'Auto-Healing & Incidents', k: 'node down crash fix maintenance' },
        { id: 'ai', label: 'KubeEZ AI', k: 'ai model ollama llm openai gemini claude groq engine fallback mask kill switch explain doctor incident what changed rollback undo dry-run' },
        { id: 'alerts', label: 'Alerts', k: 'telegram slack teams whatsapp email webhook quiet hours' },
        { id: 'compliance', label: 'Compliance & Audit', k: 'cert-in dpdp iso cis report audit trail' },
        { id: 'roles', label: 'Team & Roles', k: 'admin operator viewer invite permissions custom role cluster access label access review namespace approval two-person temporary elevation kubeconfig' },
        { id: 'security', label: 'Security & Privacy', k: 'encryption data credentials' },
        { id: 'plans', label: 'Plans', k: 'free pro enterprise pricing' }
    ] },
    { title: 'Help', items: [
        { id: 'troubleshooting', label: 'Troubleshooting', k: 'error problem not working' },
        { id: 'faq', label: 'FAQ', k: 'questions' },
        { id: 'server-setup', label: 'Server Setup', k: 'self-hosted smtp public url', selfHostedAdmin: true }
    ] }
]

export default function Docs() {
    const { user } = useAuth()
    const [active, setActive] = useState('intro')
    const [query, setQuery] = useState('')
    const [mode, setMode] = useState(null)
    const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
    // server-setup notes are for whoever runs the KubeEZ server (self-hosted), not for SaaS users
    const showServerSetup = isAdmin && mode && mode !== 'saas'

    useEffect(() => {
        fetch('/api/config').then(r => r.ok ? r.json() : {}).then(c => setMode(c.mode || 'self-hosted')).catch(() => setMode(null))
    }, [])

    const nav = useMemo(() => {
        const q = query.trim().toLowerCase()
        return NAV.map(g => ({
            ...g,
            items: g.items.filter(i => (!i.selfHostedAdmin || showServerSetup) && (!q || `${i.label} ${i.k}`.toLowerCase().includes(q)))
        })).filter(g => g.items.length)
    }, [query, showServerSetup])

    // Highlight the section being read
    useEffect(() => {
        const obs = new IntersectionObserver(entries => {
            const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
            if (top) setActive(top.target.id)
        }, { rootMargin: '-20% 0px -70% 0px' })
        document.querySelectorAll('section[id]').forEach(s => obs.observe(s))
        return () => obs.disconnect()
    }, [showServerSetup])

    const go = (id) => {
        setActive(id)
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
    }

    const searchBox = (
        <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type="search" name="docs-search" autoComplete="off" spellCheck={false} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search the docs…" aria-label="Search the docs"
                className="w-full bg-black/35 border border-white/10 focus:border-blue-500/40 rounded-xl pl-9 pr-8 py-2 text-xs text-white placeholder-slate-500 outline-none" />
            {query && <button onClick={() => setQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white" aria-label="Clear"><X className="w-3.5 h-3.5" /></button>}
        </div>
    )

    return (
        <div className="min-h-screen py-8 px-4 sm:px-6">
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-4 gap-8">

                {/* Sidebar (desktop) */}
                <nav className="hidden lg:block lg:col-span-1">
                    <div className="sticky top-24 space-y-6 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
                        {searchBox}
                        {nav.length === 0 && <p className="text-xs text-slate-500">No topic matches “{query}”.</p>}
                        {nav.map(group => (
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
                <div className="lg:hidden space-y-3">
                    {searchBox}
                    <div className="-mx-4 px-4 flex gap-2 overflow-x-auto pb-2">
                        {nav.flatMap(g => g.items).map(item => (
                            <button key={item.id} onClick={() => go(item.id)}
                                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold border ${active === item.id ? 'bg-blue-600 border-blue-500 text-white' : 'border-white/10 text-slate-400'}`}>
                                {item.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="lg:col-span-3 pb-16 min-w-0">

                    {/* ── Getting started ─────────────────────────────── */}
                    <section id="intro" className="space-y-6 scroll-mt-24">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 flex items-center justify-center rounded-2xl border border-white/10 bg-gradient-to-br from-blue-500/20 via-indigo-500/10 to-violet-500/20 shadow-glow"><BookOpen className="w-6 h-6 text-blue-200" /></div>
                            <div>
                                <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-blue-300/80">Help</div>
                                <h1 className="font-display text-[28px] font-bold text-white tracking-tight">KubeEZ Documentation</h1>
                                <p className="text-sm text-slate-400 mt-1">Production Kubernetes on your own servers, without the ops work</p>
                            </div>
                        </div>
                        <P>
                            KubeEZ installs Kubernetes on servers you own (bare metal, VMs, any cloud) and then keeps it running for you:
                            upgrades, add-ons, backups, auto-healing, alerts and compliance reports, all from one console.
                            Every job shows a live log, and when something fails you see the reason and how to fix it.
                        </P>
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                            {[
                                [Server, 'Deploy', 'A guided install with checks before anything changes. Single node or highly available.'],
                                [ArrowUpCircle, 'Upgrade', 'One click per Kubernetes version, with a safety check and a snapshot first.'],
                                [Puzzle, 'Add-ons', '25+ ready add-ons (monitoring, storage, GitOps, security, logging) with settings and updates.'],
                                [DatabaseBackup, 'Back up', 'Cluster snapshots with preview and undo, volume data, encrypted offsite copies, disaster recovery.'],
                                [HeartPulse, 'Heal', 'Watches every cluster around the clock, fixes common problems and explains the rest.'],
                                [ShieldCheck, 'Comply', 'CERT-In, DPDP, ISO 27001 and CIS checks, audit trail and auditor-ready reports.']
                            ].map(([Icon, t, d]) => (
                                <div key={t} className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
                                    <div className="flex items-center gap-2 mb-1"><Icon className="w-4 h-4 text-blue-400" /><span className="text-sm font-black text-white">{t}</span></div>
                                    <p className="text-xs text-slate-400 leading-relaxed">{d}</p>
                                </div>
                            ))}
                        </div>
                    </section>

                    <Section id="quickstart" Icon={Rocket} color="text-blue-400" title="Quick Start"
                        intro="Your first cluster takes about 15–30 minutes, depending on the servers and the add-ons you pick.">
                        <Steps items={[
                            <><B>Prepare the servers.</B> One server is enough to start; three control-planes give real high availability. Check the <button onClick={() => go('requirements')} className="text-blue-400 hover:underline">server requirements</button>.</>,
                            <><B>Connect your network</B> (hosted KubeEZ only): open <B>Gateway Agents</B> and install the agent on any machine in the same network as the servers. It needs no open ports.</>,
                            <><B>Deploy.</B> Click <B>Deploy cluster</B>, enter the servers&apos; IPs and SSH login, pick the Kubernetes version and add-ons, then start.</>,
                            <><B>Use it.</B> Open the cluster: download the <B>Kubeconfig</B> for kubectl, browse everything in the <B>Explorer</B>, and find the add-on logins under <B>Add-ons → Access & logins</B>.</>,
                            <><B>Stay safe.</B> Add an alert channel (<B>Alerts</B>), connect <B>Offsite Backup</B> in the cluster&apos;s Backups tab, and invite your team (<B>Team & Roles</B>).</>
                        ]} />
                    </Section>

                    <Section id="console" Icon={LayoutGrid} color="text-sky-400" title="Finding Your Way"
                        intro="Everything is in the sidebar, grouped by what you want to do. On a phone, open it with the ☰ button.">
                        <Table head={['Sidebar', 'What you find there']} rows={[
                            ['Clusters', 'All your clusters with health, nodes, version and add-ons. Open one to manage it.'],
                            ['Explorer', 'Opens the KubeEZ Explorer of a cluster: every resource, logs, topology and changes.'],
                            ['Incidents', 'Problems auto-healing found, what it did, and what still needs you.'],
                            ['Compliance', 'Compliance scores, findings, reports, audit trail and terminal access.'],
                            ['Deploy cluster · Gateway Agents', 'The install wizard, and the agents that reach servers in private networks.'],
                            ['Team & Roles · Alerts · Settings', 'Members and roles, alert channels and rules, plan and security settings (admins).'],
                            ['Docs · Plans', 'This guide, and what each plan includes.']
                        ]} />
                        <P>Press <C>Ctrl</C> + <C>K</C> (<C>⌘K</C> on a Mac) anywhere to jump to a cluster or page. The <B>✦</B> button in the top bar lists new add-on versions, and the bell shows open incidents.</P>
                    </Section>

                    <Section id="account" Icon={Shield} color="text-emerald-400" title="Sign-in & Password"
                        intro="Sign in with your username or your email address.">
                        <H4>Forgot your password</H4>
                        <Steps items={[
                            <>On the sign-in page click <B>Forgot password?</B> and enter your email or username.</>,
                            'Enter the 6-digit code from the email (it is valid for 15 minutes).',
                            'Choose a new password of at least 8 characters. You are signed out everywhere else, and you get an email confirming the change.'
                        ]} />
                        <Note>No email? Ask a workspace admin: <B>Team & Roles</B> → the 🔑 button on your card sets a new password for you.</Note>
                        <H4>Change your password</H4>
                        <P>Click your name at the bottom of the sidebar → <B>Change password</B>. You stay signed in here; your other sessions are signed out.</P>
                        <P>After several wrong passwords in a row an account is locked for a short while, to stop password guessing.</P>
                    </Section>

                    <Section id="requirements" Icon={Cpu} color="text-orange-400" title="Server Requirements">
                        <Table head={['', 'What you need']} rows={[
                            ['Operating system', 'Ubuntu 22.04 / 24.04, Debian 12, Rocky Linux 9, AlmaLinux 9, Fedora, Amazon Linux 2023, RHEL 8 / 9. CentOS 7 / RHEL 7 work up to Kubernetes 1.34.'],
                            ['Control plane', '2 vCPU and 4 GB RAM recommended.'],
                            ['Workers', '2 vCPU and 2 GB RAM minimum. More for your apps and add-ons.'],
                            ['Disk', '20 GB or more; upgrades need 2 GB free on /var.'],
                            ['Internet', 'Outbound HTTPS to download Kubernetes and container images.'],
                            ['Between servers', 'The servers must reach each other (ports 6443, 10250 and 30000–32767).'],
                            ['Login', 'root, or a user with sudo, over SSH (port 22).']
                        ]} />
                        <Note>If KubeEZ says <B>SSH connection refused</B>, the server has no SSH service. On Ubuntu / Debian run:</Note>
                        <Code>{"sudo apt-get update && sudo apt-get install -y openssh-server && sudo systemctl enable --now ssh && { command -v ufw >/dev/null && sudo ufw allow ssh || true; }"}</Code>
                    </Section>

                    <Section id="agents" Icon={Activity} color="text-emerald-400" title="Gateway Agent"
                        intro="With hosted KubeEZ, your servers are usually in a private network that KubeEZ cannot reach. The Gateway Agent is a small program you run inside that network. It connects out to KubeEZ over an encrypted connection, so you open no firewall ports.">
                        <Steps items={[
                            <>Open <B>Gateway Agents</B> and click <B>Generate Token</B>.</>,
                            'Copy the one-line installer and run it on any machine in the network (Linux, macOS or Windows).',
                            <>The agent shows as <B>Online</B>. Every cluster in the workspace is now managed through it.</>
                        ]} />
                        <Table head={['Situation', 'What happens']} rows={[
                            ['Network drop or restart', 'The agent reconnects by itself and runs as a service, so it comes back after a reboot.'],
                            ['Agent offline', 'You get an alert, and another one when it is back. Its clusters show as unreachable meanwhile.'],
                            ['Agent removed from the machine', <>Gateway Agents → the agent → <B>Install / Reconnect</B> shows the same command again. Running it twice is safe.</>],
                            ['Agent deleted in KubeEZ', 'Its token stops working and the agent stops.']
                        ]} />
                        <P>Check the agent on Linux:</P>
                        <Code>{"sudo systemctl status kubeez-agent\njournalctl -u kubeez-agent -f"}</Code>
                        <Note kind="tip">Self-hosted KubeEZ on the same network as your servers connects to them directly. You only need the agent for servers it cannot reach.</Note>
                    </Section>

                    {/* ── Clusters ────────────────────────────────────── */}
                    <Section id="deploy" Icon={Terminal} color="text-rose-400" title="Deploy a Cluster">
                        <Steps items={[
                            <>Click <B>Deploy cluster</B> in the sidebar (or <B>New cluster</B> in the top bar).</>,
                            'Add the control-plane and worker servers: IP, SSH user and password or key. KubeEZ checks each one: connection, OS, CPU, memory and ports.',
                            'Pick the Kubernetes version (1.27 – 1.37) and the network plugin (Flannel or Calico).',
                            <>Choose add-ons. <B>Nginx Ingress</B> and the <B>KubeEZ Explorer</B> are selected for you; press <B>Customize</B> on an add-on to change its settings first.</>,
                            'Review and start. Each step streams a live log. If something fails, you see why, with Auto-Fix & Resume where possible.'
                        ]} />
                        <H4>High availability</H4>
                        <P>With 2 or more control-planes, enter a <B>virtual IP</B>: a free address in their network. One control-plane holds it, and another takes it over within seconds if that server dies. kubectl, workers and KubeEZ all use the virtual IP.</P>
                        <Note>Use <B>3 control-planes</B> for real high availability: the cluster keeps running while 2 of 3 are up. With 2, losing either one stops the cluster API. The virtual IP must be unused, outside your DHCP range, and in the same network as the control-planes.</Note>
                    </Section>

                    <Section id="cluster-page" Icon={LayoutGrid} color="text-sky-400" title="The Cluster Page"
                        intro="Open a cluster from Clusters. The buttons at the top (Kubeconfig, Terminal, Scale, Upgrade) act on the whole cluster; the tabs below hold the details.">
                        <Table head={['Tab', 'What you find there']} rows={[
                            ['Overview', 'Version, network plugin, nodes and API address, a health score, and live CPU, memory and disk.'],
                            ['Explorer', 'Every resource in the cluster: YAML, logs, events, topology, timeline and Helm releases.'],
                            ['Add-ons', <><B>Access & logins</B>: addresses, usernames and passwords of the add-ons. <B>Manage & logs</B>: health, logs, settings, updates, install and uninstall.</>],
                            ['Backups', 'Cluster snapshots, restore, offsite backup, volume backups and disaster recovery.']
                        ]} />
                        <P>If an install or upgrade failed, a banner at the top says what to do next, with a button for it.</P>
                    </Section>

                    <Section id="access" Icon={Terminal} color="text-blue-400" title="kubectl & Terminal">
                        <H4>kubectl from your computer</H4>
                        <P>Click <B>Kubeconfig</B> on the cluster page and use the file with kubectl:</P>
                        <Code>{"kubectl --kubeconfig ./kubeconfig get nodes"}</Code>
                        <Note kind="warn">The kubeconfig gives full admin access to the cluster. Keep it like a password.</Note>
                        <H4>A shell on a node, in the browser</H4>
                        <Steps items={[
                            <>Click <B>Terminal</B> on the cluster page. You see the cluster&apos;s nodes.</>,
                            <>Click <B>Connect</B> next to a node: its own shell opens in a tab. Open several nodes side by side, or use <B>Run on several nodes</B> to send one command to the nodes you tick.</>,
                            <>Access is given for a limited time. <B>Admins</B> get in at once (60 minutes). <B>Operators</B> give a reason and a duration (15 minutes – 2 hours), and an admin approves it under <B>Compliance → Access</B>.</>
                        ]} />
                        <Note>Every terminal session is recorded (what was typed and shown), and admins can replay it. Viewers cannot open the terminal.</Note>
                    </Section>

                    <Section id="scale" Icon={Plus} color="text-blue-400" title="Add Worker Nodes"
                        intro="Click Scale on the cluster page, add the new servers (IP and SSH login) and start. KubeEZ prepares them and joins them to the running cluster; nothing that already runs is touched.">
                    </Section>

                    <Section id="upgrade" Icon={ArrowUpCircle} color="text-emerald-400" title="Upgrade Kubernetes"
                        intro="Click Upgrade on the cluster page. Kubernetes moves one version at a time (for example 1.36 → 1.37), so KubeEZ offers the next version.">
                        <Steps items={[
                            <><B>Safety check</B> (with the KubeEZ Explorer): finds what would break in the new version, such as removed APIs or settings that block draining. Blockers stop the upgrade; only an admin can continue anyway.</>,
                            'Checks: version path, packages, free disk and API health.',
                            <>An automatic <B>snapshot</B> is taken first, so you can go back.</>,
                            'The control plane is upgraded first, then every node. Known problems are fixed on the way, and short hiccups are retried.'
                        ]} />
                        <Note kind="warn">If an upgrade fails, the screen says why and whether the cluster changed. Usually it still runs the old version: click <B>Retry upgrade</B>. If the cluster is broken, restore the <B>Before upgrade (automatic)</B> snapshot in the Backups tab.</Note>
                    </Section>

                    <Section id="resume" Icon={RotateCcw} color="text-sky-400" title="Resume a Failed Install"
                        intro="If an install stops (network drop, a server down, cancelled), you do not start over.">
                        <Steps items={[
                            <>On the cluster page click <B>Resume Installation</B>.</>,
                            'KubeEZ checks what is already done on the servers.',
                            'It continues from the first unfinished step. Joined workers and healthy add-ons are left as they are.'
                        ]} />
                        <Note>A failed add-on does not fail the cluster. Fix it from <B>Add-ons → Manage & logs</B> with <B>Repair</B>.</Note>
                    </Section>

                    <Section id="remove" Icon={X} color="text-rose-400" title="Remove a Cluster"
                        intro="On Clusters, open the ⋯ menu on the cluster's card and click Remove. This removes the cluster from KubeEZ only. The cluster keeps running on your servers, and you can still use it with kubectl.">
                    </Section>

                    {/* ── Add-ons ─────────────────────────────────────── */}
                    <Section id="addons" Icon={Puzzle} color="text-fuchsia-400" title="Add-on Catalogue"
                        intro="Install add-ons while deploying a cluster, or later from Add-ons → Manage & logs → Install. Web UIs open on the listed port of any node's IP. Logins are under Add-ons → Access & logins.">
                        <Table head={['Add-on', 'What it does', 'Where to open it']} rows={[
                            ['KubeEZ Explorer', 'Full Kubernetes UI inside KubeEZ, upgrade safety check, health score', 'Explorer tab / sidebar'],
                            ['Nginx Ingress', 'Routes HTTP / HTTPS traffic to your apps', 'Access & logins'],
                            ['Prometheus + Grafana', 'Metrics and ready dashboards, optional Alertmanager', 'Grafana :30000 · Prometheus :30090'],
                            ['Metrics Server', 'CPU and memory per pod and node (kubectl top, autoscaling)', 'Access & logins'],
                            ['Kubernetes Dashboard', 'The official Kubernetes web UI (the Explorer is the modern option)', 'https :30643'],
                            ['cert-manager', 'Automatic TLS certificates', 'In the cluster'],
                            ['Longhorn', 'Replicated storage for volumes; becomes the default storage', 'UI :30080'],
                            ['NFS storage', 'Volumes on your NFS server, also shared between pods', 'Access & logins'],
                            ['Volume snapshots', 'Snapshots of volumes (VolumeSnapshot)', 'kubectl'],
                            ['S3 Object Storage', 'S3-compatible storage with a "backups" bucket and a web UI', 'S3 :30833 · UI :30834'],
                            ['Velero', 'Backups of volume data', 'Backups tab'],
                            ['MetalLB', 'Real IPs from your network for LoadBalancer services', 'Access & logins'],
                            ['ArgoCD', 'GitOps deployments', 'https :30443'],
                            ['Flux CD', 'GitOps; can sync one repository for you', 'Access & logins'],
                            ['Jenkins', 'CI/CD; pipelines run as pods in the cluster', ':30808'],
                            ['Harbor', 'Your own image registry with vulnerability scans; every node trusts it', 'https :30003'],
                            ['Loki logs', 'Logs of every pod, searchable in Grafana', 'Grafana → Explore'],
                            ['Elasticsearch + Kibana', 'Elastic Stack for logs and search', 'Kibana :30561'],
                            ['Fluent Bit · Fluentd', 'Collect and route logs to Elasticsearch or another target', 'Access & logins'],
                            ['HashiCorp Vault', 'Secrets management with injection into pods; KubeEZ unseals it for you', 'UI :30820/ui'],
                            ['Sealed Secrets', 'Encrypted secrets you can keep in Git', 'Manage & logs'],
                            ['Kyverno · OPA Gatekeeper', 'Policies: no "latest" images, limits required, no privileged pods; report or block', 'Access & logins'],
                            ['Falco', 'Runtime threat detection on every node', 'UI :30282'],
                            ['Trivy Operator', 'Continuous scans for vulnerabilities and misconfigurations', 'Access & logins']
                        ]} />
                        <Note>Viewers see the add-on addresses but never passwords or tokens.</Note>
                        <Note kind="tip">Add-ons that keep data (Elasticsearch, Harbor, Jenkins, Vault) need real storage in production. Install <B>Longhorn</B> or <B>NFS storage</B> first.</Note>
                    </Section>

                    <Section id="addon-settings" Icon={Puzzle} color="text-fuchsia-400" title="Settings & Updates"
                        intro="Every add-on can be customized: in the wizard (Customize), when you install it, or at any time later.">
                        <Table head={['', 'How it works']} rows={[
                            ['Settings', 'A short form with safe defaults (ports, replicas, storage size, retention…). Wrong values are refused with the reason.'],
                            ['Change', <><B>Settings</B> in Manage & logs → change → <B>Preview</B> (shows exactly what changes) → <B>Apply</B>. If the add-on does not come up healthy, the previous working version is put back.</>],
                            ['New versions', <>KubeEZ looks for new add-on versions twice a day. You see an <B>Update</B> badge, the <B>✦</B> menu, and an alert. Nothing updates by itself: open <B>Settings</B>, pick the version and <B>Apply</B>.</>],
                            ['History', 'Every change: who, when, which version, and whether it worked.'],
                            ['Advanced (Pro)', 'Any Helm value as YAML, on top of the form.']
                        ]} />
                        <Note kind="tip">For Kyverno and Gatekeeper, start with <B>Report only</B>, fix what the results show, then switch to <B>Block</B>.</Note>
                    </Section>

                    <Section id="addon-manage" Icon={Puzzle} color="text-fuchsia-400" title="Health, Logs & Uninstall"
                        intro="Add-ons → Manage & logs shows every add-on's live health (Healthy, Starting, Failing, Not installed). Click an add-on to see its pods and why a pod is stuck.">
                        <Table head={['Button', 'What it does']} rows={[
                            ['Logs', 'Pod logs, the log of a crashed container, and recent events.'],
                            ['Repair', 'Installs again over the existing add-on: fixes broken parts and keeps data, settings and logins.'],
                            ['Reinstall', 'Removes the add-on completely and installs it fresh, with new logins.'],
                            ['Uninstall', 'Removes the add-on and everything it created in the cluster.']
                        ]} />
                        <Note kind="warn">Uninstalling storage add-ons (Longhorn, S3 Object Storage) deletes their data, so you type the name to confirm. Longhorn cannot be removed while a volume still uses it.</Note>
                    </Section>

                    <Section id="explorer" Icon={Compass} color="text-cyan-400" title="KubeEZ Explorer"
                        intro="A complete Kubernetes UI inside KubeEZ. It is installed on new clusters by default; open it from Explorer in the sidebar or the Explorer tab of a cluster.">
                        <Table head={['View', 'What you get']} rows={[
                            ['Resources', 'Every object, with YAML, events and logs, and filters for problems (crash loops, image pull errors…)'],
                            ['Topology & Timeline', 'How apps, services and ingresses connect, and what changed when'],
                            ['Helm & GitOps', 'Releases, values and rollback; Argo CD / Flux sync status'],
                            ['Checks', 'Best-practice audit and the impact report for the next Kubernetes version']
                        ]} />
                        <P><B>No extra login and no open port:</B> you use it with your KubeEZ account, and your role decides what you can do (Viewer: read-only, Operator: edit, Admin: everything).</P>
                        <P>Not installed on an older cluster? Open its Explorer tab and click <B>Install</B>. It uses about 200 MB of memory.</P>
                    </Section>

                    <Section id="s3" Icon={Cloud} color="text-cyan-400" title="S3 Object Storage">
                        <Table head={['Port', 'Use it for']} rows={[
                            [':30833 (S3)', 'Apps, aws CLI, rclone, and as the offsite backup target of another cluster. Needs the access key and secret key.'],
                            [':30834 (Web UI)', 'Browse buckets and files in the browser. Login is in Access & logins.']
                        ]} />
                        <Note>Opening :30833 in a browser shows <B>AccessDenied</B>. That is normal: it is the S3 API. Use the Web UI on :30834.</Note>
                        <Code>{"aws --endpoint-url http://<node-ip>:30833 --region us-east-1 s3 ls s3://backups/"}</Code>
                    </Section>

                    {/* ── Backups ─────────────────────────────────────── */}
                    <Section id="etcd" Icon={DatabaseBackup} color="text-cyan-400" title="Cluster Snapshots"
                        intro="A snapshot saves the whole cluster state (apps, services, settings, secrets) so you can go back to it. Find them in the cluster's Backups tab.">
                        <Table head={['', '']} rows={[
                            ['When', <><B>Backup Now</B>, plus automatically before every upgrade and every restore.</>],
                            ['Checked', 'Every snapshot is verified when it is taken; Verify checks it again any time.'],
                            ['Kept', '45 days. The newest one is always kept.']
                        ]} />
                        <H4>Restore</H4>
                        <Steps items={[
                            <><B>Preview</B>: see what will be removed, what comes back, and what is changed back. Nothing is touched yet.</>,
                            <><B>Confirm</B> by typing the cluster name.</>,
                            'KubeEZ takes a safety snapshot of the current state, then restores. You can close the page; the log keeps running.',
                            <>If the cluster does not come back, it is rolled back automatically. When it is done, <B>Undo this restore</B> returns to the state from just before.</>
                        ]} />
                        <Note kind="warn">A restore brings back the cluster <B>state</B>, not the files inside volumes (use Volume Backups for those) and not the Kubernetes version.</Note>
                    </Section>

                    <Section id="volume-backups" Icon={HardDrive} color="text-violet-400" title="Volume Backups"
                        intro="Snapshots do not include the data inside volumes, such as databases and uploads. Volume Backups copy that data, together with the namespace's objects, to S3-compatible storage (with Velero).">
                        <Steps items={[
                            <>Backups tab → <B>Volume Backups</B>: use the offsite storage or enter separate storage.</>,
                            <><B>Save &amp; install Velero</B>. KubeEZ installs it and checks it can reach the storage.</>,
                            <><B>Back up</B> chosen namespaces any time, and turn on <B>automatic backups</B> (daily by default, kept 30 days).</>
                        ]} />
                        <Table head={['Restore option', 'What happens']} rows={[
                            ['Bring back what is missing', 'Deleted apps come back with their data; nothing existing is touched.'],
                            ['Restore as a copy', 'Into new namespaces next to the original, to compare or pick single files.'],
                            ['Replace', 'Deletes the chosen namespaces and restores them from the backup (typed confirmation).']
                        ]} />
                    </Section>

                    <Section id="offsite" Icon={Cloud} color="text-indigo-400" title="Offsite Backups"
                        intro="A copy of every snapshot outside the cluster, so it survives losing the server. Connect it in Backups → Offsite Backup.">
                        <Table head={['Storage', 'Endpoint', 'Region']} rows={[
                            ['AWS S3', 'filled in for you', 'your bucket region, e.g. ap-south-1'],
                            ['MinIO / S3 Object Storage', 'http(s)://<server>:<port>', 'us-east-1'],
                            ['Cloudflare R2', 'https://<account-id>.r2.cloudflarestorage.com', 'auto'],
                            ['Backblaze B2 / Wasabi', 'the provider S3 address', 'the provider region']
                        ]} />
                        <Steps items={[
                            'Create a bucket and an access key that can read, write, list and delete in it.',
                            <>Enter endpoint, bucket and keys → <B>Test & Connect</B>.</>,
                            <><B>Download the recovery key</B>. Backups are encrypted with it (AES-256). Without it, a backup cannot be opened if KubeEZ itself is lost, so keep it somewhere safe.</>,
                            <>New snapshots are copied automatically; <B>Sync now</B> copies any time.</>
                        ]} />
                        <Note>You can use your own encryption key, or switch to a new one, under <B>Offsite → Encryption key</B>. Older backups still open.</Note>
                        <Note kind="warn">Storage on a server of the same cluster is not offsite. Use another cluster, another server or a cloud bucket.</Note>
                        <P>Open a backup by hand with the recovery key:</P>
                        <Code>{"openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:<RECOVERY-KEY> -in <file>.tar.gz.enc | tar xz"}</Code>
                    </Section>

                    <Section id="recovery" Icon={LifeBuoy} color="text-sky-400" title="Disaster Recovery"
                        intro="If the control-plane server itself is lost (dead disk, deleted VM), KubeEZ rebuilds it from an offsite backup. The cluster keeps its identity, so workers and kubeconfigs keep working.">
                        <Steps items={[
                            <>Start a fresh Linux server with the <B>same IP</B> and SSH login as the lost one.</>,
                            <>Backups tab → <B>Control-plane machine lost? → Recover</B>, pick a backup and type the cluster name.</>,
                            'KubeEZ installs Kubernetes on it and restores the cluster from the backup. Workers reconnect by themselves.'
                        ]} />
                    </Section>

                    <Section id="config-backups" Icon={Shield} color="text-amber-400" title="KubeEZ Config Backups"
                        intro="Settings → Config Backups saves your workspace's KubeEZ records (clusters, connections, settings) every day, encrypted, with one-click restore (Pro).">
                    </Section>

                    {/* ── Operations ──────────────────────────────────── */}
                    <Section id="healing" Icon={HeartPulse} color="text-rose-400" title="Auto-Healing & Incidents"
                        intro="KubeEZ checks every running cluster every 1–2 minutes. Common problems are fixed automatically; for the rest you get the evidence and what to check. Everything is listed under Incidents.">
                        <Table head={['Problem', 'What KubeEZ does']} rows={[
                            ['Node down', 'Restarts the container runtime and kubelet, then checks the node is back.'],
                            ['Disk or memory full', 'Frees space safely (old images, stopped containers, old logs) and alerts before a disk is full.'],
                            ['Control plane down', 'Restarts it and checks the cluster API answers again.'],
                            ['Certificates expiring', 'Alerts 30 days ahead; Run fix now renews them.'],
                            ['Pod crash loop', 'Saves the last logs, then lets its controller start a fresh pod.'],
                            ['Out of memory, image pull error, pending pods', 'Explains the cause: memory limit, registry error, or why it cannot be scheduled.'],
                            ['Cluster unreachable', 'Raises a critical incident, which clears itself when the connection is back.']
                        ]} />
                        <P>Each incident shows a timeline (found, each fix attempt, result), the evidence and a suggestion. A fix is tried up to 3 times, then it needs a person.</P>
                        <P><B>You decide:</B> admins choose per problem type <i>Fix automatically</i>, <i>Alert only</i> or <i>Off</i>. Operators can acknowledge, run a fix, mute an incident for 24 h, or put a cluster in <B>maintenance</B> (no checks or alerts for 1–24 h).</P>
                    </Section>

                    <Section id="alerts" Icon={Bell} color="text-amber-400" title="Alerts"
                        intro="Be told when something needs you: on Telegram, Slack, Microsoft Teams, WhatsApp, email or your own webhook. Set them up under Alerts (admins).">
                        <Table head={['Channel', 'What you need']} rows={[
                            ['Telegram', <>A bot from <B>@BotFather</B> (its token) and the chat ID. Add the bot to the group first.</>],
                            ['Slack', <>An <B>Incoming Webhook</B> URL.</>],
                            ['Microsoft Teams', <>A <B>Workflows</B> webhook: in the channel, ⋯ → Workflows → &quot;Post to a channel when a webhook request is received&quot;.</>],
                            ['WhatsApp', 'A Twilio account: Account SID, Auth Token, sender and the number to alert.'],
                            ['Email', 'One or more email addresses.'],
                            ['Webhook', 'Any https URL; KubeEZ sends a JSON event.']
                        ]} />
                        <Table head={['You are told when', '']} rows={[
                            ['Incidents', 'A problem is found, and when it is fixed.'],
                            ['Backups', 'A snapshot, offsite copy or config backup failed; a restore finished.'],
                            ['Jobs', 'A cluster is ready, nodes were added, an add-on was installed, an upgrade finished, or a job failed (with the reason).'],
                            ['Gateway Agent', 'An agent went offline, and when it is back.'],
                            ['Add-ons & compliance', 'A new add-on version is out; a compliance control got worse; someone asks for terminal access.']
                        ]} />
                        <P>Each channel has a <B>Test</B> button. On Pro you can also set quiet hours (critical alerts still go out), turn single alert types off, send only some clusters or severities to a channel, and <B>escalate</B> critical incidents nobody acknowledged. Telegram alerts have buttons (Acknowledge, Mute, Fix now); other channels get the same as links.</P>
                    </Section>

                    <Section id="compliance" Icon={ShieldCheck} color="text-emerald-400" title="Compliance & Audit"
                        intro="A live check of a cluster against CERT-In Directions 2022, the DPDP Act 2023 & Rules 2025, ISO/IEC 27001:2022 and the CIS Kubernetes Benchmark. A scan only reads, and takes 1–5 minutes.">
                        <Table head={['', 'What it gives you']} rows={[
                            ['Controls', '30 checks: time sync, audit logs and retention, backups and restore tests, encryption, certificates, accounts and admins, SSH hardening, image vulnerabilities, OS updates, CIS benchmark, policies and more.'],
                            ['Score', 'A score overall and per framework, with each finding marked Pass, Partial, Fail, To confirm or N/A, and the history of every scan.'],
                            ['Fix', 'Every finding says how to fix it; some have a one-click fix (Pro).'],
                            ['Attestations', 'What a scan cannot see (incident response plan, contacts, data location…) is confirmed by an admin, valid one year.'],
                            ['Report (Pro)', 'A sealed PDF for auditors and client questionnaires, with evidence and fixes. Verify seal shows whether it was changed.'],
                            ['Monthly (Pro)', 'Each cluster is scanned every month and the report is emailed to admins.'],
                            ['CERT-In report (Pro)', 'A pre-filled CERT-In incident report from any incident, with the 6-hour deadline shown.'],
                            ['Audit trail', 'Every change made in KubeEZ, sign-ins and terminal commands: who, when, from where. Kept 400 days and protected against changes. Export as CSV (admins).'],
                            ['Access', 'Approve terminal access, see who has it now, and replay recorded sessions (admins).']
                        ]} />
                        <Note>The mapping to CERT-In, DPDP and ISO 27001 helps with audits. It is not legal advice or a certification.</Note>
                    </Section>

                    <Section id="roles" Icon={Users} color="text-blue-400" title="Team & Roles"
                        intro="Each workspace is separate: members only see its clusters. Admins invite members, change roles and reset passwords under Team & Roles.">
                        <Table head={['Role', 'Can do']} rows={[
                            ['Admin', 'Everything in the workspace: clusters, add-ons, backups, team, alerts, compliance, billing.'],
                            ['Operator', 'Deploy, scale, upgrade and manage clusters and add-ons; act on incidents; use the terminal with an admin’s approval. Not team, billing, alerts or backups settings.'],
                            ['Viewer', 'Read-only: clusters, health, incidents, compliance scores and add-on addresses. Never passwords or tokens, no changes.']
                        ]} />
                        <P>The full list is under <B>Team & Roles → Who can do what?</B></P>

                        <H4>Custom roles (Pro)</H4>
                        <P>Make your own role when the three built-in ones don't fit, for example "On-call", "Developer", "Backup manager" or "Auditor".</P>
                        <Steps items={[
                            <><B>Team & Roles → Roles → New role.</B> Start from a template (On-call, Developer, Backup manager, Auditor, Add-on manager) or a copy of Operator / Viewer.</>,
                            'Tick what the role may do. Items marked "per cluster" can differ from cluster to cluster (step 3).',
                            <>Choose <B>Inside the cluster</B>: None, View, Edit or Full. That is what the KubeEZ Explorer lets the role do in the cluster itself.</>,
                            <><B>Members</B> → the role menu on a member's card → pick the new role. It applies right away.</>
                        ]} />
                        <Note>Team and billing always stay with Admins, so a custom role can never take over the workspace. Changing a role updates everyone who has it. A role still in use cannot be deleted; move its members first.</Note>

                        <H4>A different role on some clusters (Pro)</H4>
                        <P>Example: Rahul is <B>Operator on staging</B>, <B>Viewer on production</B> and has <B>no access</B> to the finance cluster.</P>
                        <Steps items={[
                            <>Optional: give clusters <B>labels</B> on their page, e.g. <C>env=prod</C> or <C>team=payments</C> (admins). One label rule then covers every prod cluster, including new ones.</>,
                            <><B>Members</B> → the <B>Cluster access</B> button (layers icon) on the member's card.</>,
                            <>Add a rule <B>for one cluster</B> or <B>for a label</B>, and pick the role there, or <B>No access</B> to hide the cluster completely.</>,
                            <>Check <B>Result on each cluster</B> at the bottom, then <B>Save access</B>.</>
                        ]} />
                        <Table head={['Rule', 'How it works']} rows={[
                            ['Main role', 'Applies to every cluster that has no rule.'],
                            ['Rule for one cluster', 'Wins over everything else for that cluster.'],
                            ['Label rules', 'Apply to every cluster with that label. If several match, their permissions add up.'],
                            ['No access', 'The cluster is hidden: not in the list, its incidents not shown, nothing can be done on it.'],
                            ['Workspace items', 'Agents, alerts, audit trail and creating clusters always follow the main role.'],
                            ['Admins', 'Always have full access to every cluster; rules do not apply to them.']
                        ]} />
                        <H4>Only some namespaces (Pro)</H4>
                        <P>In a cluster rule, choose <B>Only these namespaces…</B> and list them, e.g. <C>payments-*, web</C> (<C>payments-*</C> = every namespace starting with payments-). Kubernetes itself enforces it: in the Explorer the member sees and changes only those namespaces, and a downloaded kubeconfig works only there. New namespaces that match are picked up within minutes.</P>
                        <Note><B>Kubeconfig downloads follow the role:</B> cluster-admins get the admin kubeconfig; everyone else gets a kubeconfig of their own (a 24-hour token) that can do exactly what their role allows on that cluster.</Note>

                        <H4>Two-person approval (Pro)</H4>
                        <P>Protect dangerous actions so that one person cannot do them alone, for admins too. On <B>Approvals</B>, tick the actions: remove a cluster, upgrade Kubernetes, restore an etcd snapshot, rebuild a control-plane, uninstall or reinstall an add-on, restore volume backups. It needs at least two people who can approve.</P>
                        <Steps items={[
                            'Someone starts a protected action as usual. A dialog asks why; they send the request.',
                            <>The approvers get an alert. On <B>Approvals</B>, another person approves or denies it, optionally with a comment. Nobody can approve their own request.</>,
                            'Once approved, the action runs by itself (or within the next hour when it is started again). The approval fits exactly that request and works once.'
                        ]} />

                        <H4>Temporary access (Pro)</H4>
                        <P>A member who needs more rights for a while (e.g. during an incident) asks on the cluster's page: <B>Request temporary access</B> → role, 15 minutes to 8 hours, and why. After an approver says yes, the role applies on that cluster until the time runs out. The cluster page shows it with a countdown, and <B>End now</B> stops it early. Temporary Admin is not possible.</P>
                        <Note>Every request, approval, denial, use and end goes into the audit trail. The access review shows temporary access too.</Note>

                        <P><B>Access review:</B> Team & Roles → <B>Access review</B> downloads a CSV of every member, on every cluster, with what they may do and why. Keep it as audit evidence (ISO 27001 access reviews). Every role and access change is also in the audit trail.</P>
                    </Section>

                    <Section id="ai" Icon={Bot} color="text-violet-400" title="KubeEZ AI"
                        intro="An AI assistant for your clusters — free on every plan. It runs on open-source models (on the KubeEZ server or inside your own cluster), or on your own API keys.">
                        <H4>Set it up (Settings → AI)</H4>
                        <Steps items={[
                            <>Pick where the model runs. <B>Free and private:</B> the built-in server model, or the <B>KubeEZ AI</B> add-on on one of your clusters (cluster page → Add-ons; nothing leaves your network). <B>Your own:</B> an Ollama machine on your network, or a cloud API (OpenAI-compatible such as Groq or DeepSeek, Google Gemini, Anthropic Claude) with your key.</>,
                            <>Settings → AI → <B>Add engine</B>, then <B>Test</B>. For Ollama engines, <B>Download model</B> fetches a model (e.g. <C>qwen2.5:3b</C>).</>,
                            <>Optional: <B>Routing</B> — which engines do each job and in what order. Without it, every engine is tried in list order.</>,
                            <>Use <B>Try it</B> to ask a question and see which engine answered.</>
                        ]} />
                        <H4>Why it does not let you down</H4>
                        <Table head={['', '']} rows={[
                            ['Fallbacks', 'If an engine is slow, down or gives a broken answer, the next engine answers. One that fails 3 times in a row is paused for 2 minutes.'],
                            ['Time limits', 'Every engine has a time limit and one retry. Local engines answer one question at a time, so a busy model is never overloaded.'],
                            ['Never invents', 'Answers must be based on the cluster data it is given; when that is not enough, it says what is missing.'],
                            ['No answer at all', 'You still get the facts and KubeEZ’s own rule-based checks — never a blank screen.']
                        ]} />
                        <H4>Safety</H4>
                        <Table head={['', '']} rows={[
                            ['Secrets are masked', 'Passwords, tokens, keys, certificates and kubeconfigs are replaced before any model sees the data. E-mail and IP masking can be switched on.'],
                            ['Trick text', 'Text inside logs or resources that tries to give the AI orders is marked as data and ignored, and flagged in the activity log.'],
                            ['Kill switch', <><B>AI actions allowed</B> off = AI can only explain. It is in the audit trail.</>],
                            ['Who decides', <><B>Suggest only</B>, <B>Ask first</B> (default — a person approves) or <B>Auto for low-risk</B>.</>],
                            ['Who may use it', <>Permission <C>ai:use</C> (all built-in roles) and <C>ai:manage</C> for the settings (admins; can be given in a custom role).</>],
                            ['Records', 'Every question is in Settings → AI → Activity (masked) and in the audit trail. API keys are stored encrypted and never shown again.']
                        ]} />
                        <H4>Explain a failure (Install Doctor)</H4>
                        <P>When an install, upgrade or add-on job fails, click <B>Explain this failure with AI</B> on its page. KubeEZ AI reads the whole log, finds the first real error, and shows the exact log lines that prove it, then the steps to fix it. Lines the model quotes that are not really in the log are removed, and the answer says how sure it is.</P>
                        <H4>Explain an incident</H4>
                        <P>Open an incident → <B>Explain with AI</B>. It looks at the incident’s evidence, fresh data from the cluster (pod events and logs, workload status, node conditions) and <B>what changed</B> in the 3 hours before, then says why it happens, with proof. If a recent change caused it, it names that change.</P>
                        <H4>What changed?</H4>
                        <P>Cluster page → <B>Changes</B>: one timeline of KubeEZ’s own actions (upgrades, add-ons, restores) and the changes inside Kubernetes: new rollouts with the old → new image, Helm releases, ConfigMaps and Secrets that were edited (names only; KubeEZ never reads Secret values), new nodes and namespaces. Choose 1 hour to 7 days; <B>Summarize with AI</B> gives the short version. It works without AI too.</P>
                        <H4>Fixes with preview and undo</H4>
                        <P>For an incident, KubeEZ AI may suggest one fix from a short, fixed list: <B>restart</B>, <B>roll back</B> to the previous version, <B>scale</B>, or <B>delete a pod</B> that its controller recreates. It never runs free-form commands.</P>
                        <Steps items={[
                            <><B>Preview (dry-run)</B> shows the current state, exactly what changes (e.g. image 2.0 → 1.9), the result of a server-side dry-run on the cluster, and how to undo it. Nothing changes yet.</>,
                            <><B>Apply</B> runs it, after checking the state and the dry-run again. If two-person approval protects <B>Run a fix suggested by KubeEZ AI</B> (Approvals), a second admin approves first.</>,
                            <><B>Undo</B> (on the incident, or Cluster → Changes, for 24 hours) scales back or rolls forward again. A restart or a deleted pod needs no undo.</>
                        ]} />
                        <Note>Who can apply fixes: members with <C>incident:act</C> on that cluster, only in their namespaces. The kill switch or <B>Suggest only</B> (Settings → AI) stops all of them. Every fix and undo is in the audit trail.</Note>
                        <Note>The server model has a daily allowance per workspace (Settings → AI). Your own engines — the add-on, Ollama or your API keys — have no KubeEZ limit.</Note>
                    </Section>

                    <Section id="security" Icon={Lock} color="text-emerald-400" title="Security & Privacy"
                        intro="How KubeEZ protects your clusters and your data.">
                        <Table head={['', '']} rows={[
                            ['Your credentials', 'Server passwords and keys, alert tokens and storage keys are stored encrypted and never shown again after saving.'],
                            ['Network', 'The Gateway Agent connects out over an encrypted connection; you open no ports. The Explorer is reached only through KubeEZ.'],
                            ['Access', 'Roles per workspace; viewers never see secrets; terminal access is time-limited and recorded.'],
                            ['Accountability', 'An audit trail of every change and sign-in, protected against edits, kept 400 days.'],
                            ['Backups', 'Offsite backups are encrypted with a key you hold.']
                        ]} />
                    </Section>

                    <Section id="plans" Icon={CheckCircle2} color="text-emerald-400" title="Plans">
                        <Table head={['', 'Free', 'Pro / Enterprise']} rows={[
                            ['Deploy, upgrade, scale, resume', '✓', '✓'],
                            ['Auto-healing & incidents', '✓', '✓'],
                            ['Compliance scan & audit trail', '✓', '✓'],
                            ['Add-ons', 'Kubernetes Dashboard, Metrics Server, KubeEZ AI', 'All add-ons, incl. the KubeEZ Explorer'],
                            ['KubeEZ AI (own engines, fallbacks, safety)', '✓', '✓'],
                            ['Cluster snapshots, restore, offsite backup, disaster recovery', '—', '✓'],
                            ['Volume backups', '—', '✓'],
                            ['Compliance PDF, monthly reports, fixes, CERT-In report', '—', '✓'],
                            ['Alerts', '1 channel, critical alerts', 'All channels and alert types, rules'],
                            ['Advanced add-on settings (YAML)', '—', '✓'],
                            ['Custom roles, per-cluster and namespace access, access review', 'Admin / Operator / Viewer', '✓'],
                            ['Two-person approval, temporary access', '—', '✓']
                        ]} />
                        <P>Cluster, node and member limits depend on the plan. See <Link to="/pricing" className="text-blue-400 hover:underline">Plans</Link>.</P>
                    </Section>

                    {/* ── Help ────────────────────────────────────────── */}
                    <Section id="troubleshooting" Icon={LifeBuoy} color="text-amber-400" title="Troubleshooting"
                        intro="When something fails, KubeEZ shows the reason and a fix on screen. The most common cases:">
                        <Table head={['You see', 'What to do']} rows={[
                            ['SSH connection refused', <>The server has no SSH service. Run the one-line fix under <button onClick={() => go('requirements')} className="text-blue-400 hover:underline">Server Requirements</button>.</>],
                            ['Gateway Agent offline', 'Check the machine is on and online, then run the install command again from Gateway Agents.'],
                            ['Install stopped midway', 'Click Resume Installation. Finished steps are skipped.'],
                            ['Add-on Failing or Starting for long', 'Add-ons → Manage & logs → Logs shows why (image pull, storage pending, crash). Fix it, then Repair.'],
                            ['Upgrade: "safety check found blockers"', 'Open the report, fix the listed resources, and retry.'],
                            ['Upgrade failed', 'The cluster usually still runs the old version: Retry upgrade. Otherwise restore the Before upgrade snapshot.'],
                            ['Restore: "The snapshot is damaged"', 'Nothing was changed. Pick another snapshot, or download its offsite copy.'],
                            ['Recovery: "does not have the IP …"', 'The new server must use the lost control-plane’s IP.'],
                            ['Offsite test fails', 'Check the endpoint (address only, no bucket), that the bucket exists, and the keys.'],
                            ['AccessDenied on :30833', 'Normal: that is the S3 API. Use the Web UI on :30834.'],
                            ['Explorer does not open', 'Install it from the cluster’s Explorer tab. Behind a Gateway Agent, reinstall the agent with the same command.'],
                            ['No password reset email', 'Ask a workspace admin to reset it under Team & Roles.']
                        ]} />
                        <Note>Still stuck? Send the error message and the last lines of the job log to your KubeEZ support contact.</Note>
                    </Section>

                    <Section id="faq" Icon={HelpCircle} color="text-sky-400" title="FAQ">
                        <Faq items={[
                            ['If KubeEZ is down, do my clusters stop?', 'No. Your clusters run on your servers and keep running. Only management from KubeEZ (and its alerts) waits until it is back.'],
                            ['Can I keep using kubectl, Helm and my own tools?', 'Yes. Download the Kubeconfig on the cluster page. KubeEZ uses standard Kubernetes (kubeadm), so the clusters are not locked to KubeEZ.'],
                            ['Does removing a cluster from KubeEZ delete it?', 'No. It only removes it from KubeEZ; the cluster keeps running.'],
                            ['Do I need to open firewall ports?', 'Not with the Gateway Agent: it connects out. The servers of a cluster must still reach each other.'],
                            ['Are add-ons updated automatically?', 'No. KubeEZ tells you about new versions; you choose when to update, with a preview first.'],
                            ['Which Kubernetes versions are supported?', '1.27 to 1.37. Upgrades go one version at a time.'],
                            ['Can I uninstall the Explorer?', 'Yes, from Add-ons → Manage & logs. The rest of KubeEZ keeps working; the upgrade safety check and health score need it.'],
                            ['Who can see passwords of add-ons?', 'Admins and operators. Viewers see addresses only.']
                        ]} />
                    </Section>

                    {showServerSetup && (
                        <Section id="server-setup" Icon={SettingsIcon} color="text-slate-300" title="Server Setup (self-hosted)"
                            intro="For whoever runs the KubeEZ server. Set these in the server's environment and restart KubeEZ.">
                            <Table head={['Setting', 'What it is for']} rows={[
                                [<C key="s">SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM</C>, 'Emails: password reset, welcome, alert and report emails. For Gmail use an App Password.'],
                                [<C key="u">KUBEEZ_PUBLIC_URL</C>, 'The address people open KubeEZ at, so links in alerts and emails go to the right place.'],
                                ['HTTPS', 'Put KubeEZ behind HTTPS before using Gateway Agents for real servers.']
                            ]} />
                            <P>Reset a password from the server when nobody can sign in (in the backend container):</P>
                            <Code>{"node scripts/reset-password.js <username> <new-password>"}</Code>
                        </Section>
                    )}
                </div>
            </div>
        </div>
    )
}
