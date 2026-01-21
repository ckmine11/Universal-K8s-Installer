import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Shield, Lock, User, ArrowRight, Server, Activity } from 'lucide-react';

export default function Login() {
    const { login, setup, isSetupRequired } = useAuth();
    const [formData, setFormData] = useState({ username: '', password: '' });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            if (isSetupRequired) {
                await setup(formData.username, formData.password);
            } else {
                await login(formData.username, formData.password);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#0A0A0B] text-white flex items-center justify-center relative overflow-hidden font-sans">
            {/* Ambient Background Effects */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-blue-600/10 rounded-full blur-[120px] animate-pulse"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/10 rounded-full blur-[100px] animate-pulse delay-1000"></div>
                <div className="absolute w-full h-full bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20"></div>
            </div>

            <div className="w-full max-w-md relative z-10 p-6">
                <div className="text-center mb-10 space-y-2 animate-in slide-in-from-bottom-5 fade-in duration-500">
                    <div className="flex justify-center mb-6">
                        <div className="relative">
                            <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-2xl shadow-blue-500/20 z-10 relative">
                                <Server className="w-10 h-10 text-white" />
                            </div>
                            <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl blur opacity-40 animate-pulse"></div>
                        </div>
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-white mb-2">
                        Universal <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400">K8s</span> Installer
                    </h1>
                    <p className="text-slate-400 font-medium tracking-wide text-[10px] uppercase">
                        {isSetupRequired ? 'INITIALIZE SYSTEM ACCESS' : 'SECURE COMMAND CENTER'}
                    </p>
                </div>

                <div className="bg-white/5 backdrop-blur-xl border border-white/10 p-8 rounded-[32px] shadow-2xl animate-in slide-in-from-bottom-10 fade-in duration-700 delay-150">
                    <form onSubmit={handleSubmit} className="space-y-6">
                        {error && (
                            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center space-x-3 text-red-400 text-xs font-bold animate-in fade-in slide-in-from-top-2">
                                <Activity className="w-4 h-4" />
                                <span>{error}</span>
                            </div>
                        )}

                        <div className="space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-black tracking-widest text-slate-500 ml-1">Identity</label>
                                <div className="relative group">
                                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                                        <User className="h-5 w-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                    </div>
                                    <input
                                        type="text"
                                        required
                                        className="w-full pl-12 pr-4 py-4 bg-black/40 border border-white/10 rounded-2xl focus:border-blue-500/50 focus:bg-blue-500/5 focus:ring-0 outline-none transition-all text-sm font-medium placeholder:text-slate-600 text-white"
                                        placeholder={isSetupRequired ? "Set Admin Username" : "Enter Username"}
                                        value={formData.username}
                                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <label className="text-[10px] uppercase font-black tracking-widest text-slate-500 ml-1">Access Key</label>
                                <div className="relative group">
                                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                                        <Lock className="h-5 w-5 text-slate-500 group-focus-within:text-purple-400 transition-colors" />
                                    </div>
                                    <input
                                        type="password"
                                        required
                                        className="w-full pl-12 pr-4 py-4 bg-black/40 border border-white/10 rounded-2xl focus:border-purple-500/50 focus:bg-purple-500/5 focus:ring-0 outline-none transition-all text-sm font-medium placeholder:text-slate-600 text-white"
                                        placeholder={isSetupRequired ? "Set Strong Password" : "Enter Password"}
                                        value={formData.password}
                                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                    />
                                </div>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-black uppercase tracking-wider rounded-2xl shadow-lg shadow-blue-600/20 active:scale-[0.98] transition-all flex items-center justify-center space-x-2 group disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? (
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : (
                                <>
                                    <span>{isSetupRequired ? 'Initialize System' : 'Authenticate'}</span>
                                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                </>
                            )}
                        </button>
                    </form>
                </div>

                <div className="mt-8 text-center animate-in fade-in duration-1000 delay-300">
                    <p className="text-[10px] text-slate-600 font-medium uppercase tracking-widest">
                        secured by {isSetupRequired ? 'initialization protocol' : 'KubeEZ Auth Guard'}
                    </p>
                    <div className="flex justify-center gap-2 mt-2 opacity-30">
                        <Shield className="w-3 h-3 text-slate-500" />
                        <Activity className="w-3 h-3 text-slate-500" />
                        <Lock className="w-3 h-3 text-slate-500" />
                    </div>
                </div>
            </div>
        </div>
    );
}
