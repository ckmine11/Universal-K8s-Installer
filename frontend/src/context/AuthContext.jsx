import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();
const API_URL = import.meta.env.VITE_API_URL || '';

// ─── Global apiFetch: credentials:include (HttpOnly cookie), auto-logout on 401/403 ──
// Import and use this instead of raw fetch() for all protected API calls
export async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...options.headers }
    });

    if (res.status === 401 || res.status === 403) {
        if (typeof window.__kubeezLogout === 'function') {
            console.warn('[apiFetch] Received', res.status, '- logging out');
            window.__kubeezLogout(true);
        }
    }

    return res;
}

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isSetupRequired, setIsSetupRequired] = useState(false);

    useEffect(() => {
        checkAuthStatus();
    }, []);

    const logout = async (redirectToLogin = true) => {
        try {
            await apiFetch(`${API_URL}/api/auth/logout`, { method: 'POST' });
        } catch (_) { /* ignore network errors on logout */ }
        localStorage.removeItem('user');
        setUser(null);
        setIsAuthenticated(false);
        if (redirectToLogin && window.location.pathname !== '/login') {
            window.location.href = '/login';
        }
    };

    // Register logout globally so apiFetch can call it
    window.__kubeezLogout = logout;

    const checkAuthStatus = async () => {
        try {
            const statusRes = await fetch(`${API_URL}/api/auth/status`);
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                setIsSetupRequired(statusData.setupRequired);
            }

            // Try to restore user from localStorage, then verify with /api/auth/me
            const storedUser = localStorage.getItem('user');
            if (storedUser) {
                try {
                    const parsed = JSON.parse(storedUser);
                    // Verify the cookie is still valid via /api/auth/me
                    const meRes = await apiFetch(`${API_URL}/api/auth/me`);
                    if (meRes.ok) {
                        const meData = await meRes.json();
                        setUser({ ...parsed, ...meData });
                        setIsAuthenticated(true);
                    } else {
                        // Cookie expired or invalid — clear local state
                        localStorage.removeItem('user');
                    }
                } catch (_) {
                    localStorage.removeItem('user');
                }
            }
        } catch (e) {
            console.error('Auth check failed', e);
        } finally {
            setIsLoading(false);
        }
    };

    const login = async (username, password) => {
        const res = await fetch(`${API_URL}/api/auth/login`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        const userInfo = {
            id: data.user?.id,
            username: data.user?.username || username,
            role: data.user?.role || 'admin',
            orgId: data.user?.orgId
        };
        localStorage.setItem('user', JSON.stringify(userInfo));
        setUser(userInfo);
        setIsAuthenticated(true);
    };

    const register = async (username, password, email) => {
        const res = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Registration failed');

        const userInfo = {
            id: data.user?.id,
            username: data.user?.username || username,
            role: data.user?.role || 'user',
            orgId: data.user?.orgId
        };
        localStorage.setItem('user', JSON.stringify(userInfo));
        setUser(userInfo);
        setIsAuthenticated(true);
        setIsSetupRequired(false);
    };

    const setup = async (username, password, email) => {
        const res = await fetch(`${API_URL}/api/auth/setup`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Setup failed');

        const userInfo = {
            id: data.user?.id,
            username: data.user?.username || username,
            role: data.user?.role || 'admin',
            orgId: data.user?.orgId
        };
        localStorage.setItem('user', JSON.stringify(userInfo));
        setUser(userInfo);
        setIsAuthenticated(true);
        setIsSetupRequired(false);
    };

    const forgotPassword = async (email) => {
        const res = await fetch(`${API_URL}/api/auth/forgot-password`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to send reset email');
    };

    const resetPassword = async (token, newPassword) => {
        const res = await fetch(`${API_URL}/api/auth/reset-password`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Password reset failed');
    };

    return (
        <AuthContext.Provider value={{ user, isAuthenticated, isLoading, isSetupRequired, login, register, setup, logout, forgotPassword, resetPassword }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
