import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import AuroraBackground from '../components/shell/AuroraBackground';
import { LogoMark, LogoWord } from '../components/shell/Logo';
import Constellation from '../components/auth/Constellation';
import FeatureTicker from '../components/auth/FeatureTicker';
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
        <div className="min-h-screen min-h-[100dvh] text-white relative overflow-x-clip font-sans flex items-start lg:items-center justify-center py-8 lg:py-0 selection:bg-blue-500/30">
            <AuroraBackground />

            <div className={`max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-12 relative z-10 px-4 sm:px-6 xl:px-10 transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
                
                {/* Left: a living cluster + what KubeEZ does */}
                <div className="hidden lg:flex flex-col justify-center lg:col-span-7 pr-6 py-10 min-h-screen">
                    <div className="flex items-center gap-3">
                        <LogoMark className="w-10 h-10 drop-shadow-[0_0_18px_rgba(44,203,238,.5)]" />
                        <LogoWord className="text-2xl" />
                        <span className="ml-2 kz-chip text-slate-300"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> all systems normal</span>
                    </div>

                    <h1 className="mt-10 font-display text-[44px] xl:text-[54px] font-bold tracking-tight text-white leading-[1.04]">
                        Kubernetes on your servers,{" "}<br className="hidden 2xl:block" />
                        <span className="aurora-text">calm as a cloud.</span>
                    </h1>
                    <p className="mt-5 text-lg text-slate-400 max-w-xl leading-relaxed">
                        Install, upgrade, back up and heal production clusters from one console — with a clear reason and a fix whenever something goes wrong.
                    </p>

                    <div className="relative mt-6 -ml-4 max-w-[640px]"><Constellation /></div>

                    <div className="mt-2 max-w-[720px]"><FeatureTicker groups={FEATURE_GROUPS} /></div>

                    <div className="mt-8 flex gap-8">
                        {STATS.map(st => (
                            <div key={st.label}>
                                <div className="font-display text-xl font-bold text-white">{st.value}</div>
                                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{st.label}</div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Right Side: Ultra Premium Login Box */}
                <div className="flex flex-col justify-center items-center lg:items-end w-full lg:col-span-5 relative lg:sticky lg:top-0 lg:h-screen lg:self-start">
                    {/* Glowing effect behind the card */}
                    <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[120%] h-[120%] bg-gradient-to-br from-blue-600/10 to-purple-600/10 blur-[100px] rounded-full z-0 pointer-events-none"></div>
                    
                    {/* Phones/tablets: brand + headline above the card */}
                    <div className="lg:hidden w-full max-w-[460px] mb-6 text-center relative z-10">
                        <div className="flex items-center justify-center gap-2.5">
                            <LogoMark className="w-10 h-10 drop-shadow-[0_0_18px_rgba(44,203,238,.5)]" />
                            <LogoWord className="text-2xl" />
                        </div>
                        <h1 className="mt-5 font-display text-3xl font-bold tracking-tight leading-tight">
                            Kubernetes on your servers, <span className="aurora-text">calm as a cloud.</span>
                        </h1>
                        <p className="text-sm text-slate-400 mt-3 leading-relaxed">
                            Install, upgrade, back up and heal clusters — from one console.
                        </p>
                    </div>

                    <div className="w-full max-w-[460px] relative z-10 rounded-[30px] p-px bg-gradient-to-br from-blue-400/60 via-white/10 to-violet-500/60 shadow-[0_40px_100px_-30px_rgba(44,203,238,.35)]">
                    <div className="relative rounded-[29px] bg-[#0a0f1c]/90 backdrop-blur-2xl p-6 sm:p-9 overflow-hidden">
                        
                        
                        <div className="relative z-10 mb-7">
                            {!isSetupRequired && (authMode === 'login' || authMode === 'register') && (
                                <div className="mb-7 grid grid-cols-2 rounded-2xl border border-white/10 bg-black/30 p-1" role="tablist">
                                    {[['login', 'Sign in'], ['register', 'Create account']].map(([m, label]) => (
                                        <button key={m} type="button" role="tab" aria-selected={authMode === m} onClick={() => go(m)}
                                            className={`rounded-xl py-2.5 text-sm font-bold transition ${authMode === m ? 'bg-gradient-to-r from-blue-500/25 to-violet-500/25 text-white shadow-[inset_0_0_0_1px_rgba(44,203,238,.3)]' : 'text-slate-400 hover:text-white'}`}>{label}</button>
                                    ))}
                                </div>
                            )}
                            {['forgot', 'verify', 'reset'].includes(authMode) && !isSetupRequired && (
                                <div className="mb-6 flex items-center gap-2" aria-label="Progress">
                                    {['forgot', 'verify', 'reset'].map((m, k) => {
                                        const at = ['forgot', 'verify', 'reset'].indexOf(authMode)
                                        return <span key={m} className={`h-1.5 flex-1 rounded-full transition-all ${k <= at ? 'bg-gradient-to-r from-blue-400 to-violet-400' : 'bg-white/10'}`} />
                                    })}
                                </div>
                            )}
                            <h2 className="font-display text-[28px] font-bold tracking-tight text-white">
                                {isSetupRequired ? 'Set up KubeEZ' : authMode === 'register' ? 'Create your workspace' : authMode === 'forgot' ? 'Forgot your password?' : authMode === 'verify' ? 'Check your email' : authMode === 'reset' ? 'Choose a new password' : 'Welcome back'}
                            </h2>
                            <p className="mt-1.5 text-sm text-slate-400">
                                {isSetupRequired ? 'Create the first administrator account.' : authMode === 'register' ? 'Free to start — your own isolated workspace.' : authMode === 'forgot' ? 'Step 1 of 3 — we email you a 6-digit code.' : authMode === 'verify' ? 'Step 2 of 3 — enter the code from the email.' : authMode === 'reset' ? 'Step 3 of 3 — at least 8 characters.' : 'Sign in to your clusters.'}
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
                                    <input type="text" required autoComplete="username" autoCapitalize="none" className="w-full pl-14 pr-6 py-4 sm:py-5 bg-[#05080f]/70 border border-white/[0.09] rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-[#05080f]/70 border border-white/[0.09] rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-[#05080f]/70 border border-white/[0.09] rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner tracking-widest uppercase font-mono"
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
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-[#05080f]/70 border border-white/[0.09] rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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
                                            className="w-full pl-14 pr-14 py-4 sm:py-5 bg-[#05080f]/70 border border-white/[0.09] rounded-2xl focus:border-purple-500/50 focus:bg-purple-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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
                                        className="w-full pl-14 pr-6 py-4 sm:py-5 bg-[#05080f]/70 border border-white/[0.09] rounded-2xl focus:border-purple-500/50 focus:bg-purple-500/5 outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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
                                        className="text-xs font-semibold text-blue-300 hover:text-white transition-colors"
                                    >
                                        Forgot password?
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
                                    <div className="relative flex items-center justify-center space-x-3 w-full py-5 bg-gradient-to-r from-[#0784ad] via-[#5b63f0] to-[#9333ea] hover:brightness-110 !text-white font-bold tracking-wide text-[15px] [text-shadow:0_1px_2px_rgba(0,0,0,.35)] rounded-2xl shadow-xl shadow-blue-900/40 border border-white/10 group-hover:border-white/30">
                                        {loading ? (
                                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        ) : (
                                            <>
                                                <span>
                                                    {isSetupRequired ? 'Create admin account' : 
                                                     authMode === 'register' ? 'Create account' : 
                                                     authMode === 'forgot' ? 'Send code' : authMode === 'verify' ? 'Verify code' : 
                                                     authMode === 'reset' ? 'Save new password' : 'Sign in'}
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

                            </form>
                    </div>
                    </div>
                    <p className="relative z-10 mt-6 text-center text-[11px] text-slate-500">Protected by per-account lockout · sessions end on password change</p>

                    {/* Phones/tablets: what KubeEZ does, under the card */}
                    <div className="lg:hidden w-full max-w-[460px] mt-10 relative z-10">
                        <FeatureTicker groups={FEATURE_GROUPS} compact />
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
