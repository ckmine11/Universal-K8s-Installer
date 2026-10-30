import { useState, useEffect, lazy, Suspense } from 'react'
import { InstallationTrackerProvider } from './context/InstallationTrackerContext'
import ActiveInstallationIndicator from './components/ActiveInstallationIndicator'
import IncidentNotifier from './components/IncidentNotifier'
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import AppShell from './components/shell/AppShell'
import PageErrorBoundary from './components/PageErrorBoundary'
import AuroraBackground from './components/shell/AuroraBackground'
import { LogoMark } from './components/shell/Logo'
// Every page is its own chunk: a visitor downloads the landing page, a member
// the page they open. While signed in, the everyday pages are fetched when the
// browser is idle, so moving around stays instant.
const LandingPage = lazy(() => import('./pages/LandingPage'))
const Login = lazy(() => import('./pages/Login'))
const PAGES = {
    Home: () => import('./pages/Home'),
    WizardFlow: () => import('./pages/WizardFlow'),
    InstallationDashboard: () => import('./pages/InstallationDashboard'),
    ClusterDetails: () => import('./pages/ClusterDetails'),
    Docs: () => import('./pages/Docs'),
    Settings: () => import('./pages/Settings'),
    AgentNodes: () => import('./pages/AgentNodes'),
    AdminUsers: () => import('./pages/AdminUsers'),
    AdminConsole: () => import('./pages/AdminConsole'),
    Pricing: () => import('./pages/Pricing'),
    VendorPortal: () => import('./pages/VendorPortal'),
    Incidents: () => import('./pages/Incidents'),
    Fleet: () => import('./pages/Fleet'),
    DeliverySettings: () => import('./pages/DeliverySettings'),
    Features: () => import('./pages/Features'),
    AiHub: () => import('./pages/AiHub'),
    AiSettingsPage: () => import('./pages/AiSettingsPage'),
    Alerts: () => import('./pages/Alerts'),
    Compliance: () => import('./pages/Compliance'),
    Explorer: () => import('./pages/Explorer'),
    Approvals: () => import('./pages/Approvals'),
    ConnectHub: () => import('./pages/ConnectHub'),
}
const page = (name) => lazy(PAGES[name])
const Home = page('Home')
const WizardFlow = page('WizardFlow')
const InstallationDashboard = page('InstallationDashboard')
const ClusterDetails = page('ClusterDetails')
const Docs = page('Docs')
const Settings = page('Settings')
const AgentNodes = page('AgentNodes')
const AdminUsers = page('AdminUsers')
const AdminConsole = page('AdminConsole')
const Pricing = page('Pricing')
const VendorPortal = page('VendorPortal')
const Incidents = page('Incidents')
const Fleet = page('Fleet')
const DeliverySettings = page('DeliverySettings')
const Features = page('Features')
const AiHub = page('AiHub')
const AiSettingsPage = page('AiSettingsPage')
const Alerts = page('Alerts')
const Compliance = page('Compliance')
const Explorer = page('Explorer')
const Approvals = page('Approvals')
const ConnectHub = page('ConnectHub')

function prefetchPages() {
    const run = () => ['Home', 'ClusterDetails', 'ConnectHub', 'Incidents', 'Fleet', 'AiHub', 'Explorer'].forEach(n => PAGES[n]().catch(() => { }))
    if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 })
    else setTimeout(run, 2500)
}

// shown in the content area for the moment a page chunk takes to arrive
const PageFallback = () => (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading">
        <div className="h-28 rounded-3xl bg-white/[0.03] border border-white/[0.05]" />
        <div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-36 rounded-3xl bg-white/[0.03] border border-white/[0.05]" />)}</div>
    </div>
)

function AuthenticatedApp() {
    const navigate = useNavigate()
    const [flowMode, setFlowMode] = useState('install')
    const [initialData, setInitialData] = useState(null)
    const { isAuthenticated, isLoading } = useAuth()
    const location = useLocation()
    useEffect(() => { if (isAuthenticated) prefetchPages() }, [isAuthenticated])

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
        if (location.pathname === '/') return <PageErrorBoundary><Suspense fallback={<div className="min-h-screen bg-[#060608]" />}><LandingPage /></Suspense></PageErrorBoundary>
        return <PageErrorBoundary><Suspense fallback={<div className="min-h-screen bg-[#060608]" />}><Login /></Suspense></PageErrorBoundary>
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

            <PageErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<PageFallback />}>
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
                    <Route path="/delivery" element={<DeliverySettings />} />
                    <Route path="/features" element={<Features />} />
                    <Route path="/connect/*" element={<ConnectHub />} />
                    <Route path="/ai" element={<AiHub />} />
                    <Route path="/ai/settings" element={<AiSettingsPage />} />
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
            </Suspense>
            </PageErrorBoundary>
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
