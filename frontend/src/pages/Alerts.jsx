import { Bell, Lock } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import AlertsPanel from '../components/AlertsPanel'
import PageHeader from '../components/ui/PageHeader'

// Alerts: where KubeEZ tells your team about problems (its own page — it used
// to be a tab inside Settings, which made both sidebar entries look the same).
export default function Alerts() {
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
    return (
        <div className="max-w-7xl mx-auto">
            <PageHeader icon={Bell} eyebrow="Workspace" title="Alerts"
                description="Get told when something needs you — Telegram, Slack, Microsoft Teams, WhatsApp, email or your own webhook." />
            {isAdmin ? <AlertsPanel /> : (
                <div className="kz-card p-8 text-center">
                    <Lock className="w-8 h-8 text-slate-400 mx-auto" />
                    <p className="mt-3 font-semibold text-white">Only workspace admins can manage alerts</p>
                    <p className="mt-1 text-sm text-slate-400">Alert channels hold bot tokens and webhook addresses — ask an admin to add you to a channel.</p>
                </div>
            )}
        </div>
    )
}
