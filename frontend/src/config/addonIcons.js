import {
    Network, LayoutDashboard, BarChart3, Shield, Database, GitBranch, Compass, Sparkles,
    HardDrive, Camera, Search, ScrollText, Feather, Container, GitMerge, Hammer, KeyRound,
    ShieldCheck, Radar, ScanSearch, Bot, Package, Zap
} from 'lucide-react'

// iconName (config/addons.js) → icon, for every page that lists add-ons
export const ADDON_ICONS = {
    Network, LayoutDashboard, BarChart3, Shield, Database, GitBranch, Compass, Sparkles,
    HardDrive, Camera, Search, ScrollText, Feather, Container, GitMerge, Hammer, KeyRound,
    ShieldCheck, Radar, ScanSearch, Bot, Zap
}
export const addonIcon = (name) => ADDON_ICONS[name] || Package
