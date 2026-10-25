import { createContext, useContext, useState, useEffect } from 'react';
import { setAccess } from '../config/permissions';

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

    // 428 = this action needs a second person's approval (two-person rule):
    // the approval dialog asks for it, waits, and runs the request again once
    // approved — the caller just gets the final answer.
    if (res.status === 428 && !options.skipApprovalGate && typeof window.__kubeezApprovalGate === 'function') {
        const info = await res.clone().json().catch(() => null);
        if (info?.approvalRequired) return window.__kubeezApprovalGate({ url, options, info, response: res });
    }

    // Only auto-logout on 401 (auth failure). 402 = limit/upgrade, 403 = permission —
    // those are real API responses the caller must handle, not session expiry.
    if (res.status === 401) {
        if (typeof window.__kubeezLogout === 'function') {
            console.warn('[apiFetch] 401 Unauthorized — logging out');
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
    // the member's real access (custom roles, cluster rules) — used by can()
    const [access, setAccessState] = useState(null);
    const refreshAccess = async () => {
        try {
            const r = await apiFetch(`${API_URL}/api/rbac/me`);
            const a = r.ok ? await r.json() : null;
            setAccess(a); setAccessState(a);
        } catch (_) { /* keep the last known access */ }
    };
    useEffect(() => { if (isAuthenticated) refreshAccess(); else { setAccess(null); setAccessState(null); } }, [isAuthenticated, user?.role]);

    useEffect(() => {
        checkAuthStatus();
    }, []);

    const logout = async (redirectToLogin = true) => {
        try {
            await apiFetch(`${API_URL}/api/auth/logout`, { method: 'POST' });
        } catch (_) { /* ignore network errors on logout */ }
        localStorage.removeItem('user');
        localStorage.removeItem('scaleClusterData');
        setUser(null);
        setIsAuthenticated(false);
        // Login screen renders at '/' when unauthenticated — there is no
        // dedicated '/login' route, so redirect home to avoid a 404.
        if (redirectToLogin && window.location.pathname !== '/') {
            window.location.href = '/';
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
            // back from "Continue with Google / GitHub": a session cookie, no stored user yet
            if (!storedUser && new URLSearchParams(window.location.search).get('signed_in') === '1') {
                const meRes = await apiFetch(`${API_URL}/api/auth/me`).catch(() => null);
                if (meRes?.ok) {
                    const me = await meRes.json();
                    const info = { id: me.id, username: me.username, role: me.role, orgId: me.orgId };
                    localStorage.setItem('user', JSON.stringify(info));
                    setUser({ ...info, ...me });
                    setIsAuthenticated(true);
                }
                window.history.replaceState(null, '', window.location.pathname);
            }
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

        const data = await res.json().catch(() => ({}));
        // the email of this sign-up is not confirmed yet: the page asks for the code
        if (!res.ok) throw Object.assign(new Error(data.error || 'Login failed'), { code: data.code, identifier: data.identifier });

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

    const register = async (username, password, email, captchaToken) => {
        const res = await fetch(`${API_URL}/api/auth/register`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email, captchaToken })
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Registration failed');
        // a code went to the email; the workspace opens once it is entered
        if (data.verificationRequired) return { verificationRequired: true, identifier: data.identifier, email: data.email };

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

    // the emailed 6-digit code of a new sign-up → signed in
    const verifyEmail = async (identifier, code) => {
        const res = await fetch(`${API_URL}/api/auth/verify-email`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, code })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || 'Could not confirm the email'), { code: data.code });
        const userInfo = { id: data.user?.id, username: data.user?.username || identifier, role: data.user?.role || 'admin', orgId: data.user?.orgId };
        localStorage.setItem('user', JSON.stringify(userInfo));
        setUser(userInfo);
        setIsAuthenticated(true);
        setIsSetupRequired(false);
    };

    const resendVerification = async (identifier, captchaToken) => {
        const res = await fetch(`${API_URL}/api/auth/resend-verification`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, captchaToken })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not send a new code');
    };

    const setup = async (username, password, email) => {
        const res = await fetch(`${API_URL}/api/auth/setup`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });

        const data = await res.json().catch(() => ({}));
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

    const forgotPassword = async (identifier, captchaToken) => {
        const res = await fetch(`${API_URL}/api/auth/forgot-password`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, captchaToken })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to send reset email');
    };

    // Step 2: the emailed code → a one-time ticket for step 3
    const verifyResetCode = async (identifier, code) => {
        const res = await fetch(`${API_URL}/api/auth/verify-reset-code`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, code })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || 'Could not check the code'), { code: data.code });
        return data.ticket;
    };

    const resetPassword = async (identifier, ticket, newPassword) => {
        const res = await fetch(`${API_URL}/api/auth/reset-password`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, ticket, newPassword })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || 'Password reset failed'), { code: data.code });
    };

    return (
        <AuthContext.Provider value={{ user, isAuthenticated, isLoading, isSetupRequired, login, register, setup, logout, forgotPassword, verifyResetCode, resetPassword, access, refreshAccess, verifyEmail, resendVerification }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
