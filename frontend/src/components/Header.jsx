import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Server, Github, BookOpen, LogOut } from 'lucide-react'

export default function Header() {
    const { logout, user } = useAuth()

    return (
        <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-black/20 backdrop-blur-xl">
            <div className="container mx-auto px-6 py-4">
                <div className="flex items-center justify-between">
                    <Link to="/" className="flex items-center space-x-4 group cursor-pointer hover:opacity-90 transition-opacity">
                        <div className="relative">
                            <div className="absolute inset-0 bg-blue-500 blur-xl opacity-20 group-hover:opacity-40 transition-opacity"></div>
                            <div className="relative w-11 h-11 bg-gradient-to-br from-blue-500 to-blue-700 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/20 group-hover:rotate-6 transition-transform duration-500">
                                <Server className="w-6 h-6 text-white" />
                            </div>
                        </div>
                        <div>
                            <h1 className="text-xl font-black tracking-tighter text-white">
                                Universal <span className="text-blue-500">K8s</span> Installer
                            </h1>
                            <div className="flex items-center space-x-1.5">
                                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                                <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-500">Control OS v2.0</p>
                            </div>
                        </div>
                    </Link>

                    <div className="flex items-center space-x-4">
                        <a
                            href="#"
                            className="p-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <Github className="w-5 h-5" />
                        </a>
                        <Link to="/docs" className="flex items-center space-x-2 px-5 py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-bold transition-all active:scale-95">
                            <BookOpen className="w-4 h-4 text-blue-400" />
                            <span>Docs</span>
                        </Link>

                        {user && (
                            <button
                                onClick={logout}
                                className="flex items-center space-x-2 px-5 py-2.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl text-sm font-bold text-red-400 transition-all active:scale-95"
                            >
                                <LogOut className="w-4 h-4" />
                                <span>Logout</span>
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </header>
    )
}
