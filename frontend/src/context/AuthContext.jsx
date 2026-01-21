import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isSetupRequired, setIsSetupRequired] = useState(false);

    useEffect(() => {
        checkAuthStatus();
    }, []);

    const checkAuthStatus = async () => {
        const token = localStorage.getItem('token');

        try {
            // Check if setup is needed
            const statusRes = await fetch(`${API_URL}/api/auth/status`);
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                setIsSetupRequired(statusData.setupRequired);
            }

            if (token) {
                // Here we decode manually just to get basic info, real verify is via 401 on API calls
                // Simple check for now
                setUser({ token, role: 'admin' });
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
        setUser({ username, role: 'admin' });
        setIsAuthenticated(true);
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
        setUser({ username, role: 'admin' });
        setIsAuthenticated(true);
        setIsSetupRequired(false);
    };

    const logout = () => {
        localStorage.removeItem('token');
        setUser(null);
        setIsAuthenticated(false);
    };

    return (
        <AuthContext.Provider value={{ user, isAuthenticated, isLoading, isSetupRequired, login, setup, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
