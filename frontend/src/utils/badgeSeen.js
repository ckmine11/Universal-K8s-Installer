import { apiFetch } from '../context/AuthContext'

// The person looked at Security / Certificates: what is there now no longer
// counts on the sidebar badge (the server keeps it per person). The sidebar
// reloads its badges right away.
export function markSeen(clusterId, kind) {
    apiFetch(`/api/clusters/${encodeURIComponent(clusterId)}/badges/seen`, { method: 'POST', body: JSON.stringify({ kind }) })
        .then(r => { if (r.ok) window.dispatchEvent(new CustomEvent('kz-badges-refresh', { detail: { clusterId } })) })
        .catch(() => { })
}
