import { useState, useEffect, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { BorderBeam } from '@/components/lightswind/border-beam';
import { useAuth } from '../context/AuthContext';
import AuroraBackground from '../components/shell/AuroraBackground';
import { LogoMark, LogoWord } from '../components/shell/Logo';
import FeatureTicker from '../components/auth/FeatureTicker';
import Turnstile from '../components/Turnstile';
import OAuthButtons from '../components/auth/OAuthButtons';
import { Eye, EyeOff,
    Lock, User, ArrowRight, Shield, Activity, Cloud, Zap, Mail, Key, CheckCircle2,
    ArrowUpCircle, RotateCcw, Puzzle, HeartPulse, TerminalSquare, DatabaseBackup, Users, HardDrive, Compass
} from 'lucide-react';

// WebGL globe (lazy — the form paints first)
const Globe = lazy(() => import('@/components/lightswind/globe'));
const GLOBE_MARKERS = [[19.07, 72.87], [28.61, 77.2], [12.97, 77.59], [1.35, 103.82], [25.2, 55.27], [50.11, 8.68], [51.5, -0.12], [38.9, -77.03], [35.68, 139.69]]
    .map(location => ({ location, size: 0.03 }));

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


export default function Login() {
    const { login, setup, register, forgotPassword, verifyResetCode, resetPassword, verifyEmail, resendVerification, isSetupRequired } = useAuth();
    // ?mode=register (from the landing page) opens on Create account
    const [authMode, setAuthMode] = useState(() => new URLSearchParams(window.location.search).get('mode') === 'register' ? 'register' : 'login'); // 'login', 'register', 'forgot' → 'verify' → 'reset'
    const [ticket, setTicket] = useState('');   // from a verified code, for the new password
    const [formData, setFormData] = useState({ username: '', email: '', password: '', resetCode: '', identifier: '', confirm: '' });
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [showPw, setShowPw] = useState(false);
    const [emailReset, setEmailReset] = useState(true);
    const [selfHosted, setSelfHosted] = useState(false);   // can this server email a reset code?
    const [signupOpen, setSignupOpen] = useState(true);    // a self-hosted server: members are added by an admin
    const [captchaKey, setCaptchaKey] = useState(null);    // the "I am human" check, when the server has it on
    const [captcha, setCaptcha] = useState({ token: '', n: 0 }); // n: remount for a fresh one-try token
    const freshCaptcha = () => setCaptcha(c => ({ token: '', n: c.n + 1 }));
    const [resendIn, setResendIn] = useState(0);
    const [oauth, setOauth] = useState([]);                 // "Continue with Google / GitHub" (when set up)
    const [confirmFor, setConfirmFor] = useState({ identifier: '', email: '' });   // a sign-up waiting for its email code

    useEffect(() => {
        setMounted(true);
        fetch('/api/auth/options').then(r => r.ok ? r.json() : null).then(o => { if (o) { setEmailReset(!!o.emailReset); setSelfHosted(!!o.selfHosted); setCaptchaKey(o.captchaSiteKey || null); setOauth(Array.isArray(o.oauth) ? o.oauth : []); if (o.signup === false) { setSignupOpen(false); setAuthMode(m => m === 'register' ? 'login' : m) } } }).catch(() => { });
    }, []);
    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        if (q.get('oauth_error')) { setError(q.get('message') || 'Sign-in with that provider failed — please try again.'); window.history.replaceState(null, '', window.location.pathname); }
    }, []);
    useEffect(() => {
        if (resendIn <= 0) return;
        const t = setTimeout(() => setResendIn(n => n - 1), 1000);
        return () => clearTimeout(t);
    }, [resendIn]);
    const go = (mode) => { setAuthMode(mode); setError(''); setSuccessMessage(''); setShowPw(false); };

    const sendCode = async () => {
        try { await forgotPassword(formData.identifier.trim(), captcha.token); } finally { freshCaptcha(); }
        setSuccessMessage('If this account exists, a 6-digit code was sent to its email address. Check your inbox (and spam).');
        setResendIn(60);
    };

    const askForCode = (identifier, email) => {
        setConfirmFor({ identifier, email: email || '' });
        setFormData(d => ({ ...d, resetCode: '' }));
        go('confirm');
        setResendIn(60);
    };
    const resendConfirm = async () => {
        setError(''); setLoading(true);
        try { await resendVerification(confirmFor.identifier, captcha.token); setSuccessMessage('A new code is on its way — check your inbox (and spam).'); setResendIn(60); }
        catch (err) { setError(err.message); }
        finally { freshCaptcha(); setLoading(false); }
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
                let r;
                try { r = await register(formData.username, formData.password, formData.email, captcha.token); } finally { freshCaptcha(); }
                if (r?.verificationRequired) askForCode(r.identifier, r.email);
            } else if (authMode === 'confirm') {
                await verifyEmail(confirmFor.identifier, formData.resetCode.trim());
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
            if (err.code === 'EMAIL_UNVERIFIED') { askForCode(err.identifier || formData.username, ''); setSuccessMessage('Your email is not confirmed yet — we sent a new code.'); return; }
            if (err.code === 'CODE_BURNED' && authMode === 'confirm') { setFormData(d => ({ ...d, resetCode: '' })); }
            // fetch() itself failed (offline, blocked): say so instead of "Failed to fetch"
            if (err.code === 'BAD_TICKET' || err.code === 'CODE_BURNED') { setTicket(''); setFormData(d => ({ ...d, resetCode: '' })); setAuthMode(err.code === 'BAD_TICKET' ? 'forgot' : 'verify'); }
            setError(err instanceof TypeError ? 'Could not reach the KubeEZ server — check your connection and try again.' : err.message);
        } finally {
            setLoading(false);
        }
    };


    return (
        <div className="min-h-screen min-h-[100dvh] text-white relative overflow-x-clip font-sans flex items-start lg:items-center justify-center py-8 lg:py-0 selection:bg-blue-500/30">
            <AuroraBackground vivid />

            <div className={`max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-12 relative z-10 px-4 sm:px-6 xl:px-10 transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
                
                {/* Left: a living cluster + what KubeEZ does */}
                <div className="hidden lg:flex flex-col justify-center lg:col-span-7 pr-6 py-10 min-h-screen relative">
                    <Link to="/" className="flex items-center gap-3 w-fit" aria-label="KubeEZ home">
                        <LogoMark className="w-10 h-10 drop-shadow-[0_0_20px_rgba(128,105,251,.6)]" />
                        <LogoWord className="text-2xl" />
                    </Link>

                    <h1 className="mt-12 text-[44px] xl:text-[54px] font-semibold tracking-[-0.045em] leading-[1.02] gradient-text">
                        Kubernetes on your servers,<br />
                        <span className="kz-serif aurora-text text-[54px] xl:text-[66px] leading-none pr-2">calm as a cloud.</span>
                    </h1>
                    <p className="mt-6 text-lg text-slate-400 max-w-xl leading-relaxed">
                        Install, upgrade, back up and heal production clusters from one console — with a clear reason and a fix whenever something goes wrong.
                    </p>

                    <div aria-hidden="true" className="kz-deco relative mt-4 -ml-10 h-[380px] max-w-[620px] [mask-image:radial-gradient(closest-side,#000_60%,transparent)]">
                        <Suspense fallback={null}>
                            <Globe className="!min-h-0 h-full" dark={1} diffuse={1.1} mapSamples={14000} mapBrightness={5} scale={1}
                                baseColor={[0.22, 0.2, 0.32]} markerColor={[0.62, 0.55, 1]} glowColor={[0.32, 0.27, 0.62]}
                                markers={GLOBE_MARKERS} enableZoom={false} autoRotateSpeed={0.0025} theta={0.3} />
                        </Suspense>
                    </div>

                    <div className="kz-after-deco -mt-6 max-w-[720px]"><FeatureTicker groups={FEATURE_GROUPS} /></div>
                </div>

                {/* Right Side: Ultra Premium Login Box */}
                <div className="flex flex-col justify-center items-center lg:items-end w-full lg:col-span-5 relative lg:sticky lg:top-0 lg:h-screen lg:self-start">
                    {/* Glowing effect behind the card */}
                    <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[110%] h-[90%] bg-[radial-gradient(closest-side,rgba(128,105,251,.22),transparent)] blur-3xl rounded-full z-0 pointer-events-none"></div>
                    
                    {/* Phones/tablets: brand + headline above the card */}
                    <div className="lg:hidden w-full max-w-[460px] mb-6 text-center relative z-10">
                        <div className="flex items-center justify-center gap-2.5">
                            <LogoMark className="w-10 h-10 drop-shadow-[0_0_18px_rgba(128,105,251,.5)]" />
                            <LogoWord className="text-2xl" />
                        </div>
                        <h1 className="mt-6 text-[34px] font-semibold tracking-[-0.04em] leading-[1.05] gradient-text">
                            Kubernetes on your servers, <span className="kz-serif aurora-text text-[40px]">calm as a cloud.</span>
                        </h1>
                        <p className="text-sm text-slate-400 mt-3 leading-relaxed">
                            Install, upgrade, back up and heal clusters — from one console.
                        </p>
                    </div>

                    <div className="kz-login-card-wrap w-full max-w-[460px] relative z-10 rounded-[30px] shadow-[0_50px_120px_-40px_rgba(128,105,251,.5)]">
                    <div className="kz-login-card relative rounded-[30px] border border-white/10 bg-[#0c0c11]/85 backdrop-blur-2xl p-6 sm:p-9 overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,.08)]">
                        <BorderBeam size={220} duration={9} colorFrom="#b6a8ff" colorTo="#38bdf8" />
                        
                        
                        <div className="relative z-10 mb-7">
                            {!isSetupRequired && signupOpen && (authMode === 'login' || authMode === 'register') && (
                                <div className="mb-7 grid grid-cols-2 rounded-2xl border border-white/10 bg-black/30 p-1" role="tablist">
                                    {[['login', 'Sign in'], ['register', 'Create account']].map(([m, label]) => (
                                        <button key={m} type="button" role="tab" aria-selected={authMode === m} onClick={() => go(m)}
                                            className={`rounded-xl py-2.5 text-sm font-semibold transition ${authMode === m ? 'bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,.08),inset_0_0_0_1px_rgba(255,255,255,.06)]' : 'text-slate-400 hover:text-white'}`}>{label}</button>
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
                            <h2 className="text-[30px] font-semibold tracking-[-0.035em] gradient-text">
                                {isSetupRequired ? 'Set up KubeEZ' : authMode === 'register' ? 'Create your workspace' : authMode === 'forgot' ? 'Forgot your password?' : authMode === 'verify' ? 'Check your email' : authMode === 'reset' ? 'Choose a new password' : authMode === 'confirm' ? 'Confirm your email' : 'Welcome back'}
                            </h2>
                            <p className="mt-1.5 text-sm text-slate-400">
                                {isSetupRequired ? 'Create the first administrator account.' : authMode === 'register' ? 'Free to start — your own isolated workspace.' : authMode === 'forgot' ? 'Step 1 of 3 — we email you a 6-digit code.' : authMode === 'verify' ? 'Step 2 of 3 — enter the code from the email.' : authMode === 'reset' ? 'Step 3 of 3 — at least 8 characters.' : authMode === 'confirm' ? 'One last step — enter the code we emailed you.' : 'Sign in to your clusters.'}
                            </p>
                        </div>

                        {!isSetupRequired && (authMode === 'login' || (authMode === 'register' && signupOpen)) && oauth.length > 0 && (
                            <OAuthButtons providers={oauth} verb={authMode === 'register' ? 'Sign up' : 'Continue'} />
                        )}

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
                                    <input type="text" required autoComplete="username" autoCapitalize="none" className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/[0.09] rounded-2xl focus:border-blue-400/60 focus:bg-white/[0.03] outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                        placeholder="Email address or username" value={formData.identifier}
                                        onChange={(e) => setFormData({ ...formData, identifier: e.target.value })} />
                                </div>
                            )}

                            {authMode === 'confirm' && (
                                <p className="text-[11px] text-slate-400 leading-relaxed">
                                    We emailed a 6-digit code{confirmFor.email ? <> to <b className="text-white">{confirmFor.email}</b></> : null} (valid 15 minutes — check spam too). Your workspace opens once it is entered.{' '}
                                    <button type="button" disabled={resendIn > 0 || loading} className="font-bold text-blue-400 hover:text-blue-300 disabled:text-slate-600" onClick={resendConfirm}>
                                        {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                                    </button>
                                </p>
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
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/[0.09] rounded-2xl focus:border-blue-400/60 focus:bg-white/[0.03] outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                            placeholder="Email Address"
                                            value={formData.email}
                                            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                        />
                                    </div>
                                </div>
                            )}

                            {(authMode === 'verify' || authMode === 'confirm') && (
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
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/[0.09] rounded-2xl focus:border-blue-400/60 focus:bg-white/[0.03] outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner tracking-widest uppercase font-mono"
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
                                            className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/[0.09] rounded-2xl focus:border-blue-400/60 focus:bg-white/[0.03] outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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
                                            className="w-full pl-14 pr-14 py-4 sm:py-5 bg-black/40 border border-white/[0.09] rounded-2xl focus:border-blue-400/60 focus:bg-white/[0.03] outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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
                                        className="w-full pl-14 pr-6 py-4 sm:py-5 bg-black/40 border border-white/[0.09] rounded-2xl focus:border-blue-400/60 focus:bg-white/[0.03] outline-none transition-all text-base sm:text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
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

                            {captchaKey && !isSetupRequired && (authMode === 'register' || authMode === 'confirm' || ((authMode === 'forgot' || authMode === 'verify') && emailReset)) && (
                                <div className="pt-5"><Turnstile key={`${authMode}-${captcha.n}`} siteKey={captchaKey} onToken={(token) => setCaptcha(c => ({ ...c, token }))} /></div>
                            )}
                            <div className={`pt-6 ${authMode === 'forgot' && !emailReset && !isSetupRequired ? 'hidden' : ''}`}>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="w-full relative group active:scale-[0.98] transition-all duration-300"
                                >
                                    <div className="kz-deco absolute inset-0 bg-blue-500 blur-2xl opacity-20 group-hover:opacity-40 transition-opacity rounded-2xl"></div>
                                    <div className="kz-submit relative flex items-center justify-center space-x-3 w-full py-4 sm:py-[18px] bg-gradient-to-b from-white to-[#e4e1f3] text-[#0b0b0f] font-semibold text-[15px] rounded-2xl shadow-[0_14px_40px_-14px_rgba(182,168,255,.7),inset_0_-1px_0_rgba(0,0,0,.12)]">
                                        {loading ? (
                                            <div className="w-5 h-5 border-2 border-black/20 border-t-black/70 rounded-full animate-spin" />
                                        ) : (
                                            <>
                                                <span>
                                                    {isSetupRequired ? 'Create admin account' : 
                                                     authMode === 'register' ? 'Create account' : 
                                                     authMode === 'forgot' ? 'Send code' : authMode === 'verify' ? 'Verify code' : authMode === 'confirm' ? 'Confirm and open workspace' : 
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

        </div>
    );
}
