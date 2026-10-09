import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Eye, EyeOff,
    Lock, User, ArrowRight, Shield, Activity, Cloud, Zap, Mail, Key, CheckCircle2,
    ArrowUpCircle, RotateCcw, Puzzle, HeartPulse, TerminalSquare, DatabaseBackup, Users, HardDrive, Compass
} from 'lucide-react';

// What KubeEZ does — shown to everyone arriving at the login page.
const FEATURE_GROUPS = [
    {
        group: 'Deploy', features: [
            { Icon: Zap, color: 'text-amber-400', title: 'One-click clusters', desc: 'Guided wizard with pre-flight checks and live logs. Ubuntu, Debian, RHEL, Rocky, Alma, Fedora, Amazon Linux (CentOS 7 up to 1.34) · Flannel or Calico.' },
            { Icon: ArrowUpCircle, color: 'text-emerald-400', title: 'Safe upgrades', desc: 'Kubernetes 1.27 → 1.37, one version at a time. Upgrade safety check finds blockers first, automatic etcd snapshot, clear failure reasons, auto-retry.' },
            { Icon: RotateCcw, color: 'text-sky-400', title: 'Resume, not restart', desc: 'If an install stops, resume it — finished steps are skipped. Scale out any time; HA control-planes share a floating virtual IP (kube-vip).' }
        ]
    },
    {
        group: 'Operate', features: [
            { Icon: Puzzle, color: 'text-fuchsia-400', title: 'Add-ons, managed', desc: 'Ingress, Prometheus + Grafana, Dashboard, cert-manager, Longhorn, ArgoCD, S3 storage, Velero, KubeEZ Explorer — install, repair, reinstall, uninstall and read logs from the UI.' },
            { Icon: HeartPulse, color: 'text-rose-400', title: 'Auto-healing', desc: 'Detects NotReady nodes, disk/memory pressure and crash-looping pods, fixes what it safely can — and alerts you on Telegram, Slack, Teams, WhatsApp or email.' },
            { Icon: TerminalSquare, color: 'text-blue-400', title: 'Terminal & live health', desc: 'Browser terminal, live CPU / memory / disk and a 3D topology of every node.' },
            { Icon: Compass, color: 'text-cyan-400', title: 'KubeEZ Explorer', desc: 'Every resource, logs, timeline, Helm, GitOps and a 31-check audit inside KubeEZ — your login, your RBAC, no open ports.' }
        ]
    },
    {
        group: 'Protect', features: [
            { Icon: DatabaseBackup, color: 'text-cyan-400', title: 'Safe etcd restore', desc: 'Verified snapshots (on demand, before every upgrade and restore). See exactly what a restore changes, automatic rollback, one-click undo — HA clusters too.' },
            { Icon: HardDrive, color: 'text-violet-400', title: 'Volume data backups', desc: 'Velero backs up the files inside volumes — databases, uploads — and restores a deleted app or a side-by-side copy. Daily schedule.' },
            { Icon: Cloud, color: 'text-indigo-400', title: 'Offsite & disaster recovery', desc: 'AES-256 encrypted copies to AWS S3, MinIO or any S3 storage. Lost the control-plane machine? Rebuild it from the offsite backup.' }
        ]
    },
    {
        group: 'Connect & Team', features: [
            { Icon: Shield, color: 'text-emerald-400', title: 'Gateway Agent', desc: 'Manage private servers through an outbound tunnel — no inbound firewall ports.' },
            { Icon: Users, color: 'text-amber-300', title: 'Teams & roles', desc: 'Admin, Operator and Viewer roles in isolated workspaces. Viewers never see credentials.' }
        ]
    }
];

const STATS = [
    { value: '8', label: 'Linux distros' },
    { value: '1.27 → 1.37', label: 'Kubernetes' },
    { value: '9', label: 'add-ons' },
    { value: 'AES-256', label: 'offsite backups' }
];

// A cluster "deploying" line by line — what KubeEZ does, in ten seconds.
const DEPLOY_LINES = [
    { t: '$ kubeez deploy prod-cluster --nodes 3 --k8s 1.37', c: 'text-slate-300' },
    { t: '✓ Pre-flight: 3 nodes reachable · OS, CPU, RAM, ports OK', c: 'text-emerald-400' },
    { t: '✓ containerd 2.x installed on all nodes', c: 'text-emerald-400' },
    { t: '✓ Control plane initialised (kubeadm v1.37)', c: 'text-emerald-400' },
    { t: '✓ Network: flannel ready', c: 'text-emerald-400' },
    { t: '✓ 2 workers joined', c: 'text-emerald-400' },
    { t: '✓ Add-ons: ingress · monitoring · cert-manager', c: 'text-emerald-400' },
    { t: '✓ etcd snapshot saved · offsite copy encrypted', c: 'text-cyan-400' },
    { t: '🚀 Cluster ready — 3/3 nodes Ready', c: 'text-blue-300 font-bold' }
];

function DeployTerminal() {
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const [shown, setShown] = useState(reduced ? DEPLOY_LINES.length : 1);
    useEffect(() => {
        if (reduced) return;
        // type a line every 0.9 s, hold the finished log for a moment, then replay
        const t = setTimeout(() => setShown(n => (n >= DEPLOY_LINES.length + 3 ? 1 : n + 1)), shown >= DEPLOY_LINES.length ? 1400 : 900);
        return () => clearTimeout(t);
    }, [shown, reduced]);
    return (
        <div className="rounded-2xl border border-white/10 bg-black/60 shadow-2xl overflow-hidden" aria-label="Example deployment">
            <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5 bg-white/[0.02]">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
                <span className="ml-3 text-[10px] font-bold tracking-widest text-slate-500 uppercase">live install log</span>
            </div>
            <div className="p-4 font-mono text-[12px] leading-6 min-h-[15.5rem]">
                {DEPLOY_LINES.slice(0, Math.min(shown, DEPLOY_LINES.length)).map((l, i) => (
                    <div key={i} className={`${l.c} animate-in`}>{l.t}</div>
                ))}
                {shown < DEPLOY_LINES.length && <span className="inline-block w-2 h-4 bg-slate-400 animate-pulse align-middle" />}
            </div>
        </div>
    );
}

export default function Login() {
    const { login, setup, register, forgotPassword, verifyResetCode, resetPassword, isSetupRequired } = useAuth();
    const [authMode, setAuthMode] = useState('login'); // 'login', 'register', 'forgot' → 'verify' → 'reset'
    const [ticket, setTicket] = useState('');   // from a verified code, for the new password
    const [formData, setFormData] = useState({ username: '', email: '', password: '', resetCode: '', identifier: '', confirm: '' });
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [showPw, setShowPw] = useState(false);
    const [emailReset, setEmailReset] = useState(true);
    const [selfHosted, setSelfHosted] = useState(false);   // can this server email a reset code?
    const [resendIn, setResendIn] = useState(0);

    useEffect(() => {
        setMounted(true);
        fetch('/api/auth/options').then(r => r.ok ? r.json() : null).then(o => { if (o) { setEmailReset(!!o.emailReset); setSelfHosted(!!o.selfHosted) } }).catch(() => { });
    }, []);
    useEffect(() => {
        if (resendIn <= 0) return;
        const t = setTimeout(() => setResendIn(n => n - 1), 1000);
        return () => clearTimeout(t);
    }, [resendIn]);
    const go = (mode) => { setAuthMode(mode); setError(''); setSuccessMessage(''); setShowPw(false); };

    const sendCode = async () => {
        await forgotPassword(formData.identifier.trim());
        setSuccessMessage('If this account exists, a 6-digit code was sent to its email address. Check your inbox (and spam).');
        setResendIn(60);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        setLoading(true);

        try {
            if (isSetupRequired) {
                await setup(formData.username, formData.password, formData.email);
            } else if (authMode === 'register') {
                await register(formData.username, formData.password, formData.email);
            } else if (authMode === 'forgot') {
                await sendCode();
                setAuthMode('verify');
            } else if (authMode === 'verify') {
                const t = await verifyResetCode(formData.identifier.trim(), formData.resetCode.trim());
                setTicket(t);
                go('reset');
                setSuccessMessage('Code verified ✓ — now choose your new password.');
            } else if (authMode === 'reset') {
                if (formData.password !== formData.confirm) throw new Error('The two passwords are not the same.');
                await resetPassword(formData.identifier.trim(), ticket, formData.password);
                setTicket('');
                go('login');
                setSuccessMessage('Password changed — sign in with the new one. Other sessions were signed out.');
                setFormData({ ...formData, username: formData.identifier.trim(), password: '', confirm: '', resetCode: '' });
            } else {
                await login(formData.username, formData.password);
            }
        } catch (err) {
            // fetch() itself failed (offline, blocked): say so instead of "Failed to fetch"
            if (err.code === 'BAD_TICKET' || err.code === 'CODE_BURNED') { setTicket(''); setFormData(d => ({ ...d, resetCode: '' })); setAuthMode(err.code === 'BAD_TICKET' ? 'forgot' : 'verify'); }
            setError(err instanceof TypeError ? 'Could not reach the KubeEZ server — check your connection and try again.' : err.message);
        } finally {
            setLoading(false);
        }
    };


    return (
        <div className="min-h-screen min-h-[100dvh] bg-[#030712] text-white relative overflow-x-clip font-sans flex items-start lg:items-center justify-center py-8 lg:py-0 selection:bg-blue-500/30">
            {/* Ultra Premium Animated Background */}
            <div className="absolute inset-0 w-full h-full overflow-hidden z-0 pointer-events-none">
                {/* Massive glowing orbs */}
                <div className="absolute -top-[30%] -left-[10%] w-[70vw] h-[70vw] rounded-full bg-blue-900/10 blur-[120px] mix-blend-screen animate-pulse-slow"></div>
                <div className="absolute -bottom-[20%] -right-[10%] w-[60vw] h-[60vw] rounded-full bg-purple-900/10 blur-[120px] mix-blend-screen animate-pulse-slow" style={{ animationDelay: '2s' }}></div>
                
                {/* Grid Pattern */}
                <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgc3Ryb2tlPSJyZ2JhKDI1NSwgMjU1LCAyNTUsIDAuMDIpIiBmaWxsPSJub25lIj48cGF0aCBkPSJNMCA0MGw0MCAwTTAgMGwwIDQwIiBzdHJva2Utd2lkdGg9IjEiLz48L2c+PC9zdmc+')] opacity-50"></div>
                
                {/* Radial Gradient overlay to blend edges */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#030712] via-transparent to-[#030712]"></div>
            </div>

            <div className={`max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-12 relative z-10 px-4 sm:px-6 xl:px-10 transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
                
                {/* Left Side: what KubeEZ is and everything it does */}
                <div className="hidden lg:flex flex-col justify-center lg:col-span-7 pr-8 py-10">
                    <div className="inline-flex self-start items-center space-x-3 px-5 py-2 bg-white/5 border border-white/10 rounded-full mb-6 backdrop-blur-md">
                        <span className="flex h-2.5 w-2.5 relative">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
                        </span>
                        <span className="text-[11px] font-black tracking-[0.25em] text-blue-400 uppercase">KubeEZ · Kubernetes made easy</span>
                    </div>

                    <h1 className="text-5xl xl:text-6xl font-black tracking-tighter text-white mb-4 leading-[1.05]">
                        Production Kubernetes, <br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-500">
                            without the ops work.
                        </span>
                    </h1>
                    <p className="text-lg text-slate-400 max-w-2xl leading-relaxed font-medium mb-8">
                        Install, upgrade, back up and run clusters on your own servers — from one console, with a clear reason and a fix whenever something goes wrong.
                    </p>

                    <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 mb-8">
                        <div className="xl:col-span-3"><DeployTerminal /></div>
                        <div className="xl:col-span-2 grid grid-cols-2 gap-3 content-start">
                            {STATS.map(st => (
                                <div key={st.label} className="rounded-2xl border border-white/5 bg-white/[0.02] p-4">
                                    <div className="text-lg xl:text-xl font-black text-white tracking-tight whitespace-nowrap">{st.value}</div>
                                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mt-1">{st.label}</div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-5">
                        {FEATURE_GROUPS.map(g => (
                            <div key={g.group}>
                                <div className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500 mb-2">{g.group}</div>
                                <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                                    {g.features.map(f => (
                                        <div key={f.title} className="group rounded-2xl border border-white/5 bg-white/[0.015] hover:bg-white/[0.04] hover:border-white/10 p-4 transition-all duration-300">
                                            <div className="flex items-center gap-2 mb-1.5">
                                                <f.Icon className={`w-4 h-4 ${f.color} group-hover:scale-110 transition-transform`} />
                                                <h3 className="text-sm font-black text-white">{f.title}</h3>
                                            </div>
                                            <p className="text-xs text-slate-500 group-hover:text-slate-400 leading-relaxed transition-colors">{f.desc}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Right Side: Ultra Premium Login Box */}
                <div className="flex flex-col justify-center items-center lg:items-end w-full lg:col-span-5 relative lg:sticky lg:top-0 lg:h-screen lg:self-start">
                    {/* Glowing effect behind the card */}
                    <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[120%] h-[120%] bg-gradient-to-br from-blue-600/10 to-purple-600/10 blur-[100px] rounded-full z-0 pointer-events-none"></div>
                    
                    {/* Phones/tablets: the side panel is hidden — say what KubeEZ is first */}
                    <div className="lg:hidden w-full max-w-[460px] mb-6 text-center relative z-10">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-white/5 border border-white/10 rounded-full mb-4">
                            <span className="h-2 w-2 rounded-full bg-blue-500" />
                            <span className="text-[10px] font-black tracking-[0.2em] text-blue-400 uppercase">KubeEZ · Kubernetes made easy</span>
                        </div>
                        <h1 className="text-3xl font-black tracking-tight leading-tight">
                            Production Kubernetes,{' '}
                            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-500">without the ops work.</span>
                        </h1>
                        <p className="text-sm text-slate-400 mt-3 leading-relaxed">
                            Install, upgrade, back up and run clusters on your own servers — from one console.
                        </p>
                    </div>

                    <div className="w-full max-w-[460px] p-6 sm:p-10 lg:p-12 rounded-[28px] sm:rounded-[40px] border border-white/[0.08] shadow-[0_0_80px_rgba(0,0,0,0.8)] backdrop-blur-2xl relative z-10 bg-[#0B101A]/90 overflow-hidden">
                        
                        {/* Shimmer Effect */}
                        <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/[0.03] to-transparent shimmer-animation z-0 pointer-events-none"></div>

                        <div className="text-center mb-10 relative z-10">
                            <h2 className="text-3xl font-black tracking-tight text-white mb-4 drop-shadow-xl">
                                {isSetupRequired ? 'Initialize System' : authMode === 'register' ? 'Sign Up' : authMode === 'forgot' ? 'Recover Access' : authMode === 'verify' ? 'Check Your Email' : authMode === 'reset' ? 'New Password' : 'Welcome Back'}
                            </h2>
                            <div className="w-12 h-1.5 bg-gradient-to-r from-blue-500 to-purple-500 mx-auto rounded-full mb-4 opacity-80"></div>
                            <p className="text-slate-500 font-bold tracking-[0.2em] text-[10px] uppercase">
                                {isSetupRequired ? 'Create Master Admin Profile' : authMode === 'register' ? 'Create Your Account' : authMode === 'forgot' ? 'Step 1 of 3 · Email or username' : authMode === 'verify' ? 'Step 2 of 3 · Enter the 6-digit code' : authMode === 'reset' ? 'Step 3 of 3 · Choose a new password' : 'Authenticate to Continue'}
                            </p>
                        </div>

                        <form onSubmit={handleSubmit} className="space-y-6 relative z-10">
                            {error && (
                                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center space-x-3 text-red-400 text-xs font-bold animate-in fade-in">
                                    <Activity className="w-4 h-4 shrink-0" />
                                    <span>{error}</span>
                                </div>
                            )}

                            {successMessage && (
                                <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl flex items-center space-x-3 text-emerald-400 text-xs font-bold animate-in fade-in">
                                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                                    <span>{successMessage}</span>
                                </div>
                            )}

                            {authMode === 'forgot' && !isSetupRequired && !emailReset && (
                                <div className="p-4 rounded-2xl border border-amber-500/25 bg-amber-500/5 text-xs text-slate-300 leading-relaxed space-y-2">
                                    <p className="font-bold text-amber-300">Password reset by email is not set up on this server.</p>
                                    <p>Ask your <b className="text-white">workspace admin</b> to set a new password for you (user menu → Team &amp; Roles → Reset password).</p>
                                    {selfHosted && <p className="text-slate-500">Server owner: set SMTP_USER / SMTP_PASS to enable email reset, or run <span className="font-mono text-slate-300">node scripts/reset-password.js &lt;username&gt; &lt;new-password&gt;</span> in the backend container.</p>}
                                </div>
                            )}

                            {authMode === 'forgot' && !isSetupRequired && emailReset && (
                                <div className="relative group">
                                    <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                        <Mail className="h-5 w-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                    </div>
                                    <input type="text" required autoComplete="username" autoCapitalize="none" className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                        placeholder="Email address or username" value={formData.identifier}
                                        onChange={(e) => setFormData({ ...formData, identifier: e.target.value })} />
                                </div>
                            )}

                            {authMode === 'verify' && (
                                <p className="text-[11px] text-slate-400 leading-relaxed">
                                    We emailed a 6-digit code for <b className="text-white">{formData.identifier}</b> (valid 15 minutes — check spam too).{' '}
                                    <button type="button" disabled={resendIn > 0 || loading} className="font-bold text-blue-400 hover:text-blue-300 disabled:text-slate-600"
                                        onClick={async () => { setError(''); setLoading(true); try { await sendCode() } catch (err) { setError(err.message) } finally { setLoading(false) } }}>
                                        {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                                    </button>
                                    {' · '}<button type="button" className="font-bold text-slate-400 hover:text-white" onClick={() => go('forgot')}>Change</button>
                                </p>
                            )}

                            {(isSetupRequired || authMode === 'register') && (
                                <div className="space-y-1">
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                            <Mail className="h-5 w-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                        </div>
                                        <input
                                            type="email"
                                            required
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                            placeholder="Email Address"
                                            value={formData.email}
                                            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                        />
                                    </div>
                                </div>
                            )}

                            {authMode === 'verify' && (
                                <div className="space-y-1">
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                            <Key className="h-5 w-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                        </div>
                                        <input
                                            type="text"
                                            required
                                            inputMode="numeric"
                                            autoComplete="one-time-code"
                                            pattern="[0-9]{6}"
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner tracking-widest uppercase font-mono"
                                            placeholder="6-digit code"
                                            value={formData.resetCode}
                                            onChange={(e) => setFormData({ ...formData, resetCode: e.target.value.replace(/\D/g, '').slice(0, 6) })}
                                            maxLength={6}
                                        />
                                    </div>
                                </div>
                            )}

                            {(isSetupRequired || authMode === 'login' || authMode === 'register') && (
                                <div className="space-y-1">
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                            <User className="h-5 w-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                        </div>
                                        <input
                                            type="text"
                                            required
                                            autoComplete="username"
                                            autoCapitalize="none"
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                            placeholder={authMode === 'login' && !isSetupRequired ? 'Username or email' : 'Username'}
                                            value={formData.username}
                                            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                        />
                                    </div>
                                </div>
                            )}

                            {(isSetupRequired || authMode === 'login' || authMode === 'register' || authMode === 'reset') && (
                                <div className="space-y-1">
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                            <Lock className="h-5 w-5 text-slate-500 group-focus-within:text-purple-400 transition-colors" />
                                        </div>
                                        <input
                                            type={showPw ? 'text' : 'password'}
                                            required
                                            autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                                            className="w-full pl-14 pr-14 py-4 sm:py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-purple-500/50 focus:bg-purple-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                            placeholder={authMode === 'reset' ? 'New password (min. 8 characters)' : 'Password'}
                                            value={formData.password}
                                            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                        />
                                        <button type="button" onClick={() => setShowPw(v => !v)} aria-label={showPw ? 'Hide password' : 'Show password'}
                                            className="absolute inset-y-0 right-0 pr-5 flex items-center text-slate-500 hover:text-white z-20">
                                            {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                                        </button>
                                    </div>
                                </div>
                            )}

                            {authMode === 'reset' && (
                                <div className="relative group">
                                    <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                        <Lock className="h-5 w-5 text-slate-500 group-focus-within:text-purple-400 transition-colors" />
                                    </div>
                                    <input type={showPw ? 'text' : 'password'} required autoComplete="new-password"
                                        className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-purple-500/50 focus:bg-purple-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                        placeholder="Repeat the new password" value={formData.confirm}
                                        onChange={(e) => setFormData({ ...formData, confirm: e.target.value })} />
                                    {formData.confirm && formData.confirm !== formData.password && <p className="mt-1.5 ml-2 text-[11px] text-red-400">The passwords are not the same yet</p>}
                                </div>
                            )}

                            {authMode === 'login' && !isSetupRequired && (
                                <div className="text-right">
                                    <button 
                                        type="button" 
                                        onClick={() => { go('forgot'); setFormData(d => ({ ...d, identifier: d.identifier || d.username })); }}
                                        className="text-[11px] font-bold text-slate-500 hover:text-blue-400 transition-colors uppercase tracking-widest"
                                    >
                                        Forgot Password?
                                    </button>
                                </div>
                            )}

                            <div className={`pt-6 ${authMode === 'forgot' && !emailReset && !isSetupRequired ? 'hidden' : ''}`}>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="w-full relative group active:scale-[0.98] transition-all duration-300"
                                >
                                    <div className="absolute inset-0 bg-blue-600 blur-xl opacity-30 group-hover:opacity-50 transition-opacity rounded-2xl"></div>
                                    <div className="relative flex items-center justify-center space-x-3 w-full py-5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-black uppercase tracking-[0.15em] text-xs rounded-2xl shadow-xl shadow-blue-900/40 border border-white/10 group-hover:border-white/30">
                                        {loading ? (
                                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        ) : (
                                            <>
                                                <span>
                                                    {isSetupRequired ? 'INITIALIZE SYSTEM' : 
                                                     authMode === 'register' ? 'CREATE ACCOUNT' : 
                                                     authMode === 'forgot' ? 'SEND CODE' : authMode === 'verify' ? 'VERIFY CODE' : 
                                                     authMode === 'reset' ? 'SAVE NEW PASSWORD' : 'LOGIN TO CONSOLE'}
                                                </span>
                                                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                            </>
                                        )}
                                    </div>
                                </button>
                            </div>

                            {!isSetupRequired && authMode !== 'login' && (
                                <div className="text-center pt-4">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAuthMode('login');
                                            setError('');
                                            setSuccessMessage('');
                                        }}
                                        className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-colors pb-1"
                                    >
                                        Back to Login
                                    </button>
                                </div>
                            )}

                            {/* HIDDEN IN PRODUCTION - If you don't want any additional accounts to be created since this is single user.
                            But we keep the hidden logic in case they want to sign up as the first user. */}
                            {!isSetupRequired && authMode === 'login' && (
                                <div className="text-center pt-4">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAuthMode('register');
                                            setError('');
                                            setSuccessMessage('');
                                        }}
                                        className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 hover:text-white transition-colors pb-1"
                                    >
                                        Create a new account
                                    </button>
                                </div>
                            )}
                        </form>
                    </div>

                    {/* Phones/tablets: the feature panel is hidden — show the essentials */}
                    <div className="lg:hidden w-full max-w-[460px] mt-8 space-y-5 relative z-10">
                        <div className="grid grid-cols-2 gap-2">
                            {STATS.map(st => (
                                <div key={st.label} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
                                    <div className="text-base font-black text-white">{st.value}</div>
                                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{st.label}</div>
                                </div>
                            ))}
                        </div>
                        {FEATURE_GROUPS.map(g => (
                            <div key={g.group}>
                                <div className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-500 mb-2">{g.group}</div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {g.features.map(f => (
                                        <div key={f.title} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                                            <div className="flex items-center gap-2 mb-1">
                                                <f.Icon className={`w-4 h-4 shrink-0 ${f.color}`} />
                                                <span className="text-sm font-black text-white">{f.title}</span>
                                            </div>
                                            <p className="text-xs text-slate-400 leading-relaxed">{f.desc}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

            </div>

            <style dangerouslySetInnerHTML={{
                __html: `
                @keyframes shimmer {
                    100% { transform: translateX(100%); }
                }
                .shimmer-animation {
                    animation: shimmer 4s infinite linear;
                }
                .animate-pulse-slow {
                    animation: pulse 8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-in {
                    animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                }
            `}} />
        </div>
    );
}
