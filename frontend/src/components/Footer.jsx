import { UserCheck } from 'lucide-react';

export default function Footer() {
    return (
        <footer className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex justify-center pointer-events-none w-full max-w-fit">
            <div className="relative group">
                {/* Glow */}
                <div className="absolute -inset-3 bg-blue-500/20 rounded-full blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700"></div>

                {/* Card */}
                <div className="relative bg-[#050505]/90 backdrop-blur-2xl border border-white/10 rounded-full pl-2 pr-6 py-2 flex items-center gap-4 shadow-2xl pointer-events-auto transition-all duration-300 hover:border-blue-500/30 group-hover:bg-black group-hover:scale-105">

                    {/* Avatar / Icon Chip */}
                    <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-full flex items-center justify-center shadow-lg shadow-blue-500/20 group-hover:rotate-12 transition-transform">
                        <UserCheck className="w-4 h-4 text-white" />
                    </div>

                    {/* Text Block */}
                    <div className="flex flex-col">
                        <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest leading-none mb-0.5 group-hover:text-blue-400 transition-colors">
                            Engineered By
                        </span>
                        <span className="text-xs font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-blue-200 to-slate-400 tracking-wider font-mono">
                            CHANDAN KUMAR
                        </span>
                    </div>

                    {/* Verified Tick (Animated) */}
                    <div className="ml-2 w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_10px_#10b981]"></div>
                </div>
            </div>
        </footer>
    );
}
