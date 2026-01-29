import { useState, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { Lock, User, ArrowRight, Shield, Activity } from 'lucide-react';

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

    // Generate ticks for the circular UI
    const ticks = useMemo(() => {
        return Array.from({ length: 72 }, (_, i) => ({
            id: i,
            rotation: i * (360 / 72),
            delay: i * (3 / 72) // 3s total cycle
        }));
    }, []);

    return (
        <div className="min-h-screen bg-[#050507] text-white flex items-center justify-center relative overflow-hidden font-sans">
            {/* Ambient Background Effects */}
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
                <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-blue-600/5 rounded-full blur-[140px] animate-pulse"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-600/5 rounded-full blur-[120px] animate-pulse delay-700"></div>
            </div>

            {/* Circular Animated Tick Ring - HIGH VISIBILITY RADAR */}
            <div className="absolute inset-0 flex items-center justify-center z-0 pointer-events-none overflow-hidden scale-[1.1] md:scale-100">
                <div className="relative w-[750px] h-[750px] flex items-center justify-center">
                    {/* Glowing Core for better contrast */}
                    <div className="absolute w-[450px] h-[450px] bg-blue-500/10 rounded-full blur-[100px]"></div>

                    {/* Animated Ticks */}
                    {ticks.map((tick) => (
                        <div
                            key={tick.id}
                            className="absolute w-[6px] h-[40px] rounded-full origin-bottom"
                            style={{
                                transform: `rotate(${tick.rotation}deg) translateY(-280px)`,
                                animation: 'tickGlowAnimation 3s infinite linear',
                                animationDelay: `${tick.delay}s`,
                                backgroundColor: 'rgba(255, 255, 255, 0.03)'
                            }}
                        />
                    ))}

                    {/* Rotating Rings for technical feel */}
                    <div className="absolute w-[584px] h-[584px] border border-white/[0.04] rounded-full animate-[spin_120s_linear_infinite]"></div>
                    <div className="absolute w-[540px] h-[540px] border border-white/[0.02] rounded-full animate-[spin_80s_linear_infinite_reverse]"></div>
                </div>
            </div>

            <div className="w-full max-w-sm relative z-10 p-4">
                <div className="text-center mb-10 animate-in slide-in-from-bottom-5 fade-in duration-700">
                    <h1 className="text-[40px] font-black tracking-tighter text-white mb-1 drop-shadow-2xl">
                        Login
                    </h1>
                    <div className="w-10 h-1bg-gradient-to-r from-blue-500 to-purple-600 mx-auto rounded-full mb-3 shadow-[0_0_10px_rgba(59,130,246,0.5)]"></div>
                    <p className="text-slate-500 font-black tracking-[0.4em] text-[9px] uppercase italic">
                        {isSetupRequired ? 'System Provisioning' : 'Encrypted Access Control'}
                    </p>
                </div>

                <div className="relative">
                    <form onSubmit={handleSubmit} className="space-y-4 relative">
                        {error && (
                            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center space-x-3 text-red-400 text-[10px] font-bold animate-in fade-in slide-in-from-top-2">
                                <Activity className="w-3 h-3" />
                                <span>{error}</span>
                            </div>
                        )}

                        <div className="space-y-1">
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                    <User className="h-4 w-4 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                                </div>
                                <input
                                    type="text"
                                    required
                                    className="w-full pl-14 pr-14 py-6 bg-[#0B1019]/90 backdrop-blur-3xl border border-white/10 rounded-[30px] focus:border-blue-500/40 focus:bg-blue-500/5 outline-none transition-all text-sm font-medium placeholder:text-slate-700 text-white shadow-2xl relative z-10"
                                    placeholder="Username"
                                    value={formData.username}
                                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                />
                                <div className="absolute inset-y-0 right-0 pr-6 flex items-center pointer-events-none z-20">
                                    <div className="w-2 h-2 bg-blue-500/40 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.6)] animate-pulse"></div>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-1">
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-0 pl-6 flex items-center pointer-events-none z-20">
                                    <Lock className="h-4 w-4 text-slate-500 group-focus-within:text-purple-400 transition-colors" />
                                </div>
                                <input
                                    type="password"
                                    required
                                    className="w-full pl-14 pr-14 py-6 bg-[#0B1019]/90 backdrop-blur-3xl border border-white/10 rounded-[30px] focus:border-purple-500/40 focus:bg-purple-500/5 outline-none transition-all text-sm font-medium placeholder:text-slate-700 text-white shadow-2xl relative z-10"
                                    placeholder="Password"
                                    value={formData.password}
                                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                />
                                <div className="absolute inset-y-0 right-0 pr-6 flex items-center pointer-events-none z-20">
                                    <Lock className="w-4 h-4 text-white/5" />
                                </div>
                            </div>
                        </div>

                        <div className="pt-4">
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full relative group active:scale-[0.97] transition-all duration-200"
                            >
                                <div className="absolute inset-0 bg-blue-600 blur-2xl opacity-20 group-hover:opacity-40 transition-opacity rounded-full"></div>
                                <div className="relative flex items-center justify-center space-x-3 w-full py-5 bg-gradient-to-br from-blue-600 to-purple-700 hover:from-blue-500 hover:to-purple-600 text-white font-black uppercase tracking-[0.25em] text-[12px] rounded-[30px] shadow-2xl shadow-blue-900/50 border border-white/10 group-hover:border-white/20">
                                    {loading ? (
                                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <>
                                            <span className="ml-2">AUTHENTICATE</span>
                                            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                        </>
                                    )}
                                </div>
                            </button>
                        </div>
                    </form>
                </div>

                <div className="mt-14 text-center">
                    <div className="flex flex-col items-center space-y-4">
                        <div className="px-5 py-2.5 bg-white/5 rounded-full border border-white/[0.05] flex items-center space-x-3 shadow-inner">
                            <Shield className="w-3 h-3 text-blue-500" />
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">
                                Secure Initialization: v1.1.0
                            </span>
                        </div>
                    </div>
                </div>


            </div>

            <style dangerouslySetInnerHTML={{
                __html: `
                @keyframes tickGlowAnimation {
                    0% {
                        background-color: rgba(255, 255, 255, 0.03);
                        box-shadow: none;
                        opacity: 0.1;
                    }
                    5% {
                        background-color: #3b82f6; /* Blue-500 */
                        box-shadow: 0 0 35px rgba(59, 130, 246, 1), 0 0 15px rgba(139, 92, 246, 0.5);
                        opacity: 1;
                        height: 60px;
                    }
                    15% {
                        background-color: #8b5cf6; /* Purple-500 */
                        box-shadow: 0 0 15px rgba(139, 92, 246, 0.6);
                        opacity: 0.8;
                        height: 44px;
                    }
                    40% {
                        background-color: rgba(255, 255, 255, 0.03);
                        box-shadow: none;
                        opacity: 0.1;
                        height: 40px;
                    }
                    100% {
                        background-color: rgba(255, 255, 255, 0.03);
                        box-shadow: none;
                        opacity: 0.1;
                        height: 40px;
                    }
                }

                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(20px); }
                    to { opacity: 1; transform: translateY(0); }
                }

                .animate-in {
                    animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                }
            `}} />
            {/* Animated Footer - Repositioned to Absolute Bottom */}
            <div className="absolute bottom-10 left-0 w-full text-center z-20 animate-in fade-in duration-1000 delay-700">
                <p className="text-[10px] font-bold tracking-[0.3em] text-blue-500/40 uppercase">
                    System developed by <span className="text-blue-400 animate-pulse">Chandan Kumar</span>
                </p>
                <div className="mt-3 flex justify-center space-x-1.5 opacity-50">
                    <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-duration:1s]"></div>
                    <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-duration:1s] [animation-delay:0.2s]"></div>
                    <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-duration:1s] [animation-delay:0.4s]"></div>
                </div>
            </div>
        </div>
    );
}
