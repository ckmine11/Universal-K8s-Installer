import { useState, lazy, Suspense } from 'react'
import { InstallationTrackerProvider } from './context/InstallationTrackerContext'
import ActiveInstallationIndicator from './components/ActiveInstallationIndicator'
import IncidentNotifier from './components/IncidentNotifier'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import AppShell from './components/shell/AppShell'
import AuroraBackground from './components/shell/AuroraBackground'
import { LogoMark } from './components/shell/Logo'
import Home from './pages/Home'
import WizardFlow from './pages/WizardFlow'
import InstallationDashboard from './pages/InstallationDashboard'
import ClusterDetails from './pages/ClusterDetails'
import Docs from './pages/Docs'
import Settings from './pages/Settings'
import AgentNodes from './pages/AgentNodes'
import AdminUsers from './pages/AdminUsers'
import AdminConsole from './pages/AdminConsole'
import Pricing from './pages/Pricing'
import VendorPortal from './pages/VendorPortal'
import Incidents from './pages/Incidents'
import Fleet from './pages/Fleet'
import AiHub from './pages/AiHub'
import Alerts from './pages/Alerts'
import Compliance from './pages/Compliance'
import Explorer from './pages/Explorer'
import Approvals from './pages/Approvals'
// the public landing page (heavier: globe, motion) — only for visitors who are not signed in
const LandingPage = lazy(() => import('./pages/LandingPage'))

function AuthenticatedApp() {
    const navigate = useNavigate()
    const [flowMode, setFlowMode] = useState('install')
    const [initialData, setInitialData] = useState(null)
    const { isAuthenticated, isLoading } = useAuth()
    const location = useLocation()

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center text-white">
                <AuroraBackground />
                <div className="flex flex-col items-center gap-5">
                    <LogoMark className="w-14 h-14 animate-spin-slow drop-shadow-[0_0_24px_rgba(128,105,251,.5)]" />
                    <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Loading KubeEZ…</p>
                </div>
            </div>
        )
    }

    if (!isAuthenticated) {
        // "/" is the public landing page; every other address (deep links) asks to sign in
        if (location.pathname === '/') return <Suspense fallback={<div className="min-h-screen bg-[#060608]" />}><LandingPage /></Suspense>
        return <Login />
    }

    const startInstallation = (id) => {
        navigate(`/dashboard/${id}`)
    }

    const startNewInstall = () => {
        setFlowMode('install')
        setInitialData(null)
        navigate('/install')
    }

    const startScaling = (clusterData = null) => {
        setFlowMode('scale')
        if (clusterData) {
            // never keep SSH credentials in browser storage (survives logout)
            const strip = (nodes) => (nodes || []).map(({ password, sshKey, ...n }) => n)
            localStorage.setItem('scaleClusterData', JSON.stringify({
                ...clusterData, masterNodes: strip(clusterData.masterNodes), workerNodes: strip(clusterData.workerNodes)
            }))
        }
        navigate('/scale', { state: { clusterData } })
    }

    const navigateToHome = () => {
        navigate('/')
    }

    return (
        <AppShell>
            <ActiveInstallationIndicator />
            <IncidentNotifier />

                <Routes>
                    <Route
                        path="/"
                        element={
                            <Home
                                onStartNew={startNewInstall}
                                onScaleExisting={startScaling}
                            />
                        }
                    />
                    <Route
                        path="/install"
                        element={
                            <WizardFlow
                                onStartInstallation={startInstallation}
                                onCancel={navigateToHome}
                                mode="install"
                                initialData={null}
                            />
                        }
                    />
                    <Route
                        path="/scale"
                        element={<ScaleWrapper onStartInstallation={startInstallation} onCancel={navigateToHome} />}
                    />
                    <Route
                        path="/dashboard/:id"
                        element={<DashboardWrapper onGoHome={navigateToHome} onScaleCluster={startScaling} />}
                    />
                    <Route
                        path="/installation/:id"
                        element={<DashboardWrapper onGoHome={navigateToHome} onScaleCluster={startScaling} />}
                    />
                    <Route
                        path="/cluster/:id"
                        element={<ClusterDetails onScaleCluster={startScaling} />}
                    />
                    <Route
                        path="/docs"
                        element={<Docs />}
                    />
                    <Route
                        path="/settings"
                        element={<Settings />}
                    />
                    <Route path="/alerts" element={<Alerts />} />
                    <Route path="/compliance" element={<Compliance />} />
                    <Route path="/explorer" element={<Explorer />} />
                    <Route path="/approvals" element={<Approvals />} />
                    <Route path="/login" element={<Navigate to="/" replace />} />
                    <Route
                        path="/agents"
                        element={<AgentNodes />}
                    />
                    <Route
                        path="/incidents"
                        element={<Incidents />}
                    />
                    <Route path="/fleet" element={<Fleet />} />
                    <Route path="/ai" element={<AiHub />} />
                    <Route path="/ai/:tool" element={<AiHub />} />
                    <Route
                        path="/pricing"
                        element={<Pricing />}
                    />

                    <Route
                        path="/vendor-portal"
                        element={<VendorPortal />}
                    />
                    <Route
                        path="/users"
                        element={<AdminUsers />}
                    />
                    <Route
                        path="/admin"
                        element={<AdminConsole />}
                    />
                    <Route path="*" element={
                        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                            <h1 className="font-display text-8xl font-extrabold aurora-text mb-3">404</h1>
                            <p className="text-lg text-slate-400 mb-8">This page drifted out of orbit.</p>
                            <button onClick={() => navigate('/')} className="kz-btn-primary">Back to clusters</button>
                        </div>
                    } />
                </Routes>
        </AppShell>
    )
}

function ScaleWrapper({ onStartInstallation, onCancel }) {
    const location = useLocation()
    const [clusterData, setClusterData] = useState(() => {
        const stateData = location.state?.clusterData
        if (stateData) return stateData

        // Fallback to localStorage on refresh
        const saved = localStorage.getItem('scaleClusterData')
        return saved ? JSON.parse(saved) : null
    })

    return (
        <WizardFlow
            onStartInstallation={onStartInstallation}
            onCancel={onCancel}
            mode="scale"
            initialData={clusterData}
        />
    )
}

function DashboardWrapper({ onGoHome, onScaleCluster }) {
    const { id } = useParams()
    return <InstallationDashboard installationId={id} onGoHome={onGoHome} onScaleCluster={onScaleCluster} />
}



import { ToastProvider } from './components/ToastProvider'

function App() {

    return (
        <BrowserRouter>
            <ToastProvider>
                <AuthProvider>
                    <InstallationTrackerProvider>
                        <AuthenticatedApp />
                    </InstallationTrackerProvider>
                </AuthProvider>
            </ToastProvider>
        </BrowserRouter>
    )
}

export default App
