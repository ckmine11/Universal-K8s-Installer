import { Bot, Lock } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { can } from '../config/permissions'
import { PageTitle } from '../components/ui/PageHeader'
import AiSettings from '../components/ai/AiSettings'

// AI → AI settings: engines, routing, safety, quality, runbooks, ChatOps,
// learning, MCP, AI-BOM — its own page in the AI section (admins).
export default function AiSettingsPage() {
    const { user } = useAuth()
    if (!can(user?.role, 'ai:manage')) return (
        <div className="max-w-3xl mx-auto kz-card p-6 flex items-center gap-3 text-sm text-slate-300">
            <Lock className="w-5 h-5 text-slate-400" /> Only admins (or a role with <code>ai:manage</code>) change the AI settings.
        </div>
    )
    return (
        <div className="max-w-7xl mx-auto space-y-6">
            <PageTitle icon={Bot} eyebrow="AI" title="AI settings" description="The models KubeEZ AI uses, which one does what, safety, quality tests, runbooks, ChatOps, MCP and the AI-BOM." />
            <AiSettings />
        </div>
    )
}
