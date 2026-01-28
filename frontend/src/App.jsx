import { useState } from 'react'
import { BrowserRouter, Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import Header from './components/Header'
import Home from './pages/Home'
import WizardFlow from './pages/WizardFlow'
import InstallationDashboard from './pages/InstallationDashboard'
import ClusterDetails from './pages/ClusterDetails'
import Docs from './pages/Docs'

function AuthenticatedApp() {
    const navigate = useNavigate()
    const [flowMode, setFlowMode] = useState('install')
    const [initialData, setInitialData] = useState(null)
    const { isAuthenticated, isLoading } = useAuth()

    if (isLoading) {
        return (
            <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center text-white">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                    <p className="text-xs uppercase tracking-widest text-slate-500">Loading Secure Enclave...</p>
                </div>
            </div>
        )
    }

    if (!isAuthenticated) {
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
            localStorage.setItem('scaleClusterData', JSON.stringify(clusterData))
        }
        navigate('/scale', { state: { clusterData } })
    }

    const navigateToHome = () => {
        navigate('/')
    }

    return (
        <div className="min-h-screen">
            <Header />

            <main className="container mx-auto px-4 py-8">
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
                    <Route path="*" element={
                        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
                            <h1 className="text-6xl font-black text-white mb-4">404</h1>
                            <p className="text-xl text-slate-400 mb-8">Page not found</p>
                            <button
                                onClick={() => window.location.href = '/'}
                                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold"
                            >
                                Go Home
                            </button>
                        </div>
                    } />
                </Routes>
            </main>

            {/* Background decoration */}
            <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
                <div className="absolute top-1/4 -left-48 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl"></div>
                <div className="absolute bottom-1/4 -right-48 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
            </div>
        </div>
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



function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AuthenticatedApp />
            </AuthProvider>
        </BrowserRouter>
    )
}

export default App
