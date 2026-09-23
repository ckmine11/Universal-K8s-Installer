import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Lock, User, ArrowRight, Shield, Activity, Cloud, Zap, Mail, Key } from 'lucide-react';

export default function Login() {
    const { login, setup, register, forgotPassword, resetPassword, isSetupRequired } = useAuth();
    const [authMode, setAuthMode] = useState('login'); // 'login', 'register', 'forgot', 'reset'
    const [formData, setFormData] = useState({ username: '', email: '', password: '', resetCode: '' });
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

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
                await forgotPassword(formData.email);
                setSuccessMessage('Reset code has been sent to your email.');
                setAuthMode('reset');
            } else if (authMode === 'reset') {
                await resetPassword(formData.resetCode, formData.password);
                setSuccessMessage('Password reset successfully. You can now login.');
                setAuthMode('login');
                setFormData({ ...formData, password: '', resetCode: '' });
            } else {
                await login(formData.username, formData.password);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const features = [
        {
            icon: <Zap className="w-6 h-6 text-amber-400" />,
            title: "Lightning Fast Provisioning",
            desc: "Spin up production-ready Kubernetes clusters in seconds, fully configured and secured.",
            color: "amber"
        },
        {
            icon: <Activity className="w-6 h-6 text-emerald-400" />,
            title: "Auto-Healing Engine",
            desc: "Real-time AI diagnostics to auto-fix DNS, Swap memory, and node issues on the fly.",
            color: "emerald"
        },
        {
            icon: <Cloud className="w-6 h-6 text-blue-400" />,
            title: "Secure SaaS Tunnels",
            desc: "Connect local private nodes using lightweight WebSocket agents without opening firewall ports.",
            color: "blue"
        }
    ];

    return (
        <div className="min-h-screen bg-[#030712] text-white relative overflow-hidden font-sans flex items-center justify-center selection:bg-blue-500/30">
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

            <div className={`max-w-[1400px] w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12 relative z-10 p-6 xl:p-0 transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
                
                {/* Left Side: Stunning Typography & Brand */}
                <div className="hidden lg:flex flex-col justify-center col-span-7 pr-8">
                    <div className="mb-14">
                        <div className="inline-flex items-center space-x-3 px-5 py-2 bg-white/5 border border-white/10 rounded-full mb-8 backdrop-blur-md shadow-2xl">
                            <span className="flex h-2.5 w-2.5 relative">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
                            </span>
                            <span className="text-[11px] font-black tracking-[0.25em] text-blue-400 uppercase">KubeEZ Master Console</span>
                        </div>
                        
                        <h1 className="text-6xl xl:text-[80px] font-black tracking-tighter text-white mb-6 leading-[1.05]">
                            Deploy Clusters <br />
                            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-500">
                                With Zero Friction
                            </span>
                        </h1>
                        <p className="text-xl text-slate-400 max-w-xl leading-relaxed font-medium">
                            The ultimate "No-Ops" platform. Manage your entire Kubernetes infrastructure seamlessly from a single pane of glass.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {features.map((feature, idx) => (
                            <div key={idx} className="group relative glass p-6 rounded-[28px] border border-white/5 bg-white/[0.01] hover:bg-white/[0.03] hover:border-white/10 transition-all duration-500 overflow-hidden">
                                <div className={`absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-10 transition-opacity duration-500 ${feature.color === 'emerald' ? 'from-emerald-500 to-transparent' : feature.color === 'blue' ? 'from-blue-500 to-transparent' : 'from-amber-500 to-transparent'}`}></div>
                                <div className="p-4 bg-black/40 rounded-2xl inline-block mb-6 border border-white/5 shadow-inner relative z-10 group-hover:scale-110 transition-transform duration-500">
                                    {feature.icon}
                                </div>
                                <h3 className="text-base font-black tracking-wide text-white mb-3 relative z-10">{feature.title}</h3>
                                <p className="text-sm text-slate-500 leading-relaxed relative z-10 group-hover:text-slate-400 transition-colors font-medium">{feature.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Right Side: Ultra Premium Login Box */}
                <div className="flex flex-col justify-center items-center lg:items-end w-full col-span-5 relative">
                    {/* Glowing effect behind the card */}
                    <div className="absolute top-1/2 right-0 -translate-y-1/2 w-[120%] h-[120%] bg-gradient-to-br from-blue-600/10 to-purple-600/10 blur-[100px] rounded-full z-0 pointer-events-none"></div>
                    
                    <div className="w-full max-w-[460px] p-10 lg:p-12 rounded-[40px] border border-white/[0.08] shadow-[0_0_80px_rgba(0,0,0,0.8)] backdrop-blur-2xl relative z-10 bg-[#0B101A]/90 overflow-hidden">
                        
                        {/* Shimmer Effect */}
                        <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/[0.03] to-transparent shimmer-animation z-0 pointer-events-none"></div>

                        <div className="text-center mb-10 relative z-10">
                            <h2 className="text-3xl font-black tracking-tight text-white mb-4 drop-shadow-xl">
                                {isSetupRequired ? 'Initialize System' : authMode === 'register' ? 'Sign Up' : authMode === 'forgot' ? 'Recover Access' : authMode === 'reset' ? 'New Password' : 'Welcome Back'}
                            </h2>
                            <div className="w-12 h-1.5 bg-gradient-to-r from-blue-500 to-purple-500 mx-auto rounded-full mb-4 opacity-80"></div>
                            <p className="text-slate-500 font-bold tracking-[0.2em] text-[10px] uppercase">
                                {isSetupRequired ? 'Create Master Admin Profile' : authMode === 'register' ? 'Create Your Account' : authMode === 'forgot' ? 'Enter Email to recover' : authMode === 'reset' ? 'Enter Code and New Password' : 'Authenticate to Continue'}
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

                            {(isSetupRequired || authMode === 'register' || authMode === 'forgot') && (
                                <div className="space-y-1">
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                            <Mail className="h-5 w-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                        </div>
                                        <input
                                            type="email"
                                            required
                                            className="w-full pl-14 pr-6 py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                            placeholder="Email Address"
                                            value={formData.email}
                                            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                        />
                                    </div>
                                </div>
                            )}

                            {authMode === 'reset' && (
                                <div className="space-y-1">
                                    <div className="relative group">
                                        <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                            <Key className="h-5 w-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                        </div>
                                        <input
                                            type="text"
                                            required
                                            className="w-full pl-14 pr-6 py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-sm font-medium placeholder:text-slate-600 text-white shadow-inner tracking-widest uppercase font-mono"
                                            placeholder="6-Digit Reset Code"
                                            value={formData.resetCode}
                                            onChange={(e) => setFormData({ ...formData, resetCode: e.target.value })}
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
                                            className="w-full pl-14 pr-6 py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 outline-none transition-all text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                            placeholder="Username"
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
                                            type="password"
                                            required
                                            className="w-full pl-14 pr-6 py-5 bg-black/40 border border-white/10 rounded-2xl focus:border-purple-500/50 focus:bg-purple-500/5 outline-none transition-all text-sm font-medium placeholder:text-slate-600 text-white shadow-inner"
                                            placeholder={authMode === 'reset' ? "New Password" : "Password"}
                                            value={formData.password}
                                            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                        />
                                    </div>
                                </div>
                            )}

                            {authMode === 'login' && !isSetupRequired && (
                                <div className="text-right">
                                    <button 
                                        type="button" 
                                        onClick={() => { setAuthMode('forgot'); setError(''); setSuccessMessage(''); }}
                                        className="text-[11px] font-bold text-slate-500 hover:text-blue-400 transition-colors uppercase tracking-widest"
                                    >
                                        Forgot Password?
                                    </button>
                                </div>
                            )}

                            <div className="pt-6">
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
                                                     authMode === 'forgot' ? 'SEND RESET CODE' : 
                                                     authMode === 'reset' ? 'RESET PASSWORD' : 'LOGIN TO CONSOLE'}
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
