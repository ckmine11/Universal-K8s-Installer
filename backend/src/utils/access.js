// Tenant isolation helpers — single source of truth for "does this user's
// workspace own this resource?" (clusters, installations, ...).
//
// A resource belongs to a workspace (orgId). Legacy records without an orgId
// fall back to the owning user. Role is deliberately NOT considered: every
// SaaS signup is an org "admin", so a role check here would let any tenant
// reach every other tenant's clusters. Superadmin has dedicated endpoints.

export function canAccessResource(user, resource) {
    if (!user || !resource) return false
    if (resource.orgId) return !!user.orgId && resource.orgId === user.orgId
    return !!resource.ownerId && resource.ownerId === user.id
}

// Do two resources belong to the same tenant?
export function sameTenant(a, b) {
    if (!a || !b) return false
    if (a.orgId && b.orgId) return a.orgId === b.orgId
    return !!a.ownerId && a.ownerId === b.ownerId
}
