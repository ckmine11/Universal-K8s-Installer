import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();
const API_URL = import.meta.env.VITE_API_URL || '';

// ─── JWT client-side decode (no signature check - just for expiry/payload) ───
function decodeJwt(token) {
    try {
        const payload = token.split('.')[1];
        return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
        return null;
    }
}

function isTokenExpired(token) {
    const decoded = decodeJwt(token);
    if (!decoded || !decoded.exp) return true;
    // Treat as expired 60 seconds before actual expiry (safety buffer)
    return Date.now() >= (decoded.exp - 60) * 1000;
}

// ─── Global apiFetch: auto-logout on 401/403 ─────────────────────────────────
// Import and use this instead of raw fetch() for all protected API calls
export async function apiFetch(url, options = {}) {
    const token = localStorage.getItem('token');
    const headers = {
        ...(options.headers || {}),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };

    const res = await fetch(url, { ...options, headers });

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

    const logout = (redirectToLogin = true) => {
        localStorage.removeItem('token');
        setUser(null);
        setIsAuthenticated(false);
        if (redirectToLogin && window.location.pathname !== '/login') {
            window.location.href = '/login';
        }
    };

    // Register logout globally so apiFetch can call it
    window.__kubeezLogout = logout;

    const checkAuthStatus = async () => {
        const token = localStorage.getItem('token');

        try {
            const statusRes = await fetch(`${API_URL}/api/auth/status`);
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                setIsSetupRequired(statusData.setupRequired);
            }

            if (token) {
                // ① Check expiry client-side first (instant, no network)
                if (isTokenExpired(token)) {
                    console.warn('[Auth] Stored JWT is expired - clearing session');
                    logout(false); // don't redirect yet, let router handle it
                    return;
                }

                // ② Decode claims from token
                const decoded = decodeJwt(token);
                setUser({
                    token,
                    id: decoded?.id,
                    username: decoded?.username || 'User',
                    role: decoded?.role || 'admin',
                    orgId: decoded?.orgId
                });
                setIsAuthenticated(true);
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        localStorage.setItem('token', data.token);
        const decoded = decodeJwt(data.token);
        setUser({
            token: data.token,
            id: decoded?.id,
            username: decoded?.username || data.user?.username || username,
            role: decoded?.role || data.user?.role || 'admin',
            orgId: decoded?.orgId
        });
        setIsAuthenticated(true);
    };

    const register = async (username, password, email) => {
        const res = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Registration failed');

        localStorage.setItem('token', data.token);
        const decoded = decodeJwt(data.token);
        setUser({
            token: data.token,
            id: decoded?.id,
            username: decoded?.username || data.user?.username || username,
            role: decoded?.role || data.user?.role || 'user',
            orgId: decoded?.orgId
        });
        setIsAuthenticated(true);
        setIsSetupRequired(false);
    };

    const setup = async (username, password) => {
        const res = await fetch(`${API_URL}/api/auth/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Setup failed');

        localStorage.setItem('token', data.token);
        const decoded = decodeJwt(data.token);
        setUser({
            token: data.token,
            id: decoded?.id,
            username: decoded?.username || data.user?.username || username,
            role: decoded?.role || 'admin',
            orgId: decoded?.orgId
        });
        setIsAuthenticated(true);
        setIsSetupRequired(false);
    };

    return (
        <AuthContext.Provider value={{ user, isAuthenticated, isLoading, isSetupRequired, login, register, setup, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
