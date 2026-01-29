import { useState, createContext, useContext, useCallback } from 'react';
import { X, CheckCircle, AlertCircle, Info, Loader2 } from 'lucide-react';

const ToastContext = createContext(null);

export const ToastProvider = ({ children }) => {
    const [toasts, setToasts] = useState([]);

    const removeToast = useCallback((id) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, []);

    const toast = useCallback(({ title, message, type = 'info', duration = 5000 }) => {
        const id = Math.random().toString(36).substr(2, 9);
        setToasts((prev) => [...prev, { id, title, message, type, duration }]);

        if (duration !== Infinity) {
            setTimeout(() => removeToast(id), duration);
        }
    }, [removeToast]);

    return (
        <ToastContext.Provider value={{ toast }}>
            {children}
            {/* Toast Container */}
            <div className="fixed bottom-8 right-8 z-[9999] flex flex-col gap-4 pointer-events-none">
                {toasts.map((t) => (
                    <ToastItem key={t.id} {...t} onClose={() => removeToast(t.id)} />
                ))}
            </div>
        </ToastContext.Provider>
    );
};

export const useToast = () => useContext(ToastContext);

const ToastItem = ({ title, message, type, onClose }) => {
    const icons = {
        success: <CheckCircle className="w-5 h-5 text-emerald-400" />,
        error: <AlertCircle className="w-5 h-5 text-red-400" />,
        info: <Info className="w-5 h-5 text-blue-400" />,
        loading: <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
    };

    const colors = {
        success: 'border-emerald-500/20 bg-emerald-500/10',
        error: 'border-red-500/20 bg-red-500/10',
        info: 'border-blue-500/20 bg-blue-500/10',
        loading: 'border-blue-500/20 bg-blue-500/10'
    };

    return (
        <div className={`pointer-events-auto min-w-[320px] max-w-md p-4 rounded-2xl border backdrop-blur-xl shadow-2xl animate-toast-in ${colors[type]}`}>
            <div className="flex items-start gap-4">
                <div className="mt-0.5">{icons[type]}</div>
                <div className="flex-1">
                    {title && <h4 className="font-bold text-white text-sm mb-1">{title}</h4>}
                    <p className="text-slate-300 text-xs leading-relaxed">{message}</p>
                </div>
                <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-lg transition-colors">
                    <X className="w-4 h-4 text-slate-500" />
                </button>
            </div>
            {/* Progress Bar Animation */}
            <div className="absolute bottom-0 left-0 h-1 bg-white/10 rounded-full overflow-hidden w-full">
                <div
                    className={`h-full animate-progress ${type === 'success' ? 'bg-emerald-500' : type === 'error' ? 'bg-red-500' : 'bg-blue-500'}`}
                    style={{ animationDuration: '5s' }}
                ></div>
            </div>
        </div>
    );
};
