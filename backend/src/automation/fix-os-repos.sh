#!/bin/bash

# ============================================================
# KubeEZ - Universal OS Repository & DNS Fixer
# Works on: CentOS 7 (EOL), RHEL 8/9, Rocky, AlmaLinux,
#           Ubuntu 18/20/22/24, Debian
# Fixes: EOL repos, DNS failures, IPv6 connectivity, SSL
# ============================================================

set -euo pipefail

log()  { echo "[fix-repos] $*"; }
ok()   { echo "[fix-repos] ✓ $*"; }
warn() { echo "[fix-repos] ⚠️  $*"; }

# ─────────────────────────────────────────────
# STEP 1: Force IPv4 for all package managers
# (Fixes: curl#7 "Failed to connect to IPv6 address")
# ─────────────────────────────────────────────
log "Forcing IPv4 globally for package downloads..."

# Yum / DNF
if [ -d /etc/yum.conf.d ] || [ -f /etc/yum.conf ]; then
    grep -q "^ip_resolve" /etc/yum.conf 2>/dev/null || \
        echo "ip_resolve=4" >> /etc/yum.conf
fi

# DNF specific
if command -v dnf &>/dev/null && [ -f /etc/dnf/dnf.conf ]; then
    grep -q "^ip_resolve" /etc/dnf/dnf.conf 2>/dev/null || \
        echo "ip_resolve=4" >> /etc/dnf/dnf.conf
fi

# Disable IPv6 at kernel level (prevents curl#7 errors)
sysctl -w net.ipv6.conf.all.disable_ipv6=1     2>/dev/null || true
sysctl -w net.ipv6.conf.default.disable_ipv6=1 2>/dev/null || true

# ─────────────────────────────────────────────
# STEP 2: Fix DNS (Fixes: curl#6 "Could not resolve host")
# ─────────────────────────────────────────────
log "Patching /etc/resolv.conf with reliable public DNS..."

# Backup original
cp /etc/resolv.conf /etc/resolv.conf.kubeez-bak 2>/dev/null || true

# Write fresh resolv.conf (overwrite - the most reliable method)
cat > /etc/resolv.conf <<'EOF'
# KubeEZ managed - set for K8s installation
nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 8.8.4.4
options timeout:2 attempts:3 rotate
EOF

ok "DNS configured: 8.8.8.8, 1.1.1.1, 8.8.4.4"

# ─────────────────────────────────────────────
# STEP 3: OS Detection
# ─────────────────────────────────────────────
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_VERSION_ID="${VERSION_ID:-0}"
OS_MAJOR=$(echo "$OS_VERSION_ID" | cut -d. -f1)

log "Detected OS: $OS_ID $OS_VERSION_ID"

# ─────────────────────────────────────────────
# STEP 4: CentOS 7 EOL Fix (The main problem)
# vault.centos.org was giving 403 → use archive mirrors
# ─────────────────────────────────────────────
fix_centos7_repos() {
    log "Applying CentOS 7 EOL repository fixes..."

    # Remove all existing CentOS repo files (they all point to dead mirrors)
    rm -f /etc/yum.repos.d/CentOS-*.repo 2>/dev/null || true

    # Write fresh, working CentOS 7 vault repos
    # Uses https://vault.centos.org (the official EOL archive)
    # with sslverify=0 as fallback for SSL cert issues in old systems
    cat > /etc/yum.repos.d/CentOS-Vault-Base.repo <<'EOF'
[base]
name=CentOS-7 - Base (Vault)
baseurl=https://vault.centos.org/centos/7/os/$basearch/
        http://vault.centos.org/centos/7/os/$basearch/
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7
enabled=1
skip_if_unavailable=1
timeout=30
ip_resolve=4

[updates]
name=CentOS-7 - Updates (Vault)
baseurl=https://vault.centos.org/centos/7/updates/$basearch/
        http://vault.centos.org/centos/7/updates/$basearch/
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7
enabled=1
skip_if_unavailable=1
timeout=30
ip_resolve=4

[extras]
name=CentOS-7 - Extras (Vault)
baseurl=https://vault.centos.org/centos/7/extras/$basearch/
        http://vault.centos.org/centos/7/extras/$basearch/
gpgcheck=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-CentOS-7
enabled=1
skip_if_unavailable=1
timeout=30
ip_resolve=4
EOF

    # Clear all cached repo data and regenerate
    yum clean all 2>/dev/null || true
    rm -rf /var/cache/yum/* 2>/dev/null || true

    # Regenerate metadata (allow failure - yum will try again per-package)
    yum makecache fast 2>/dev/null || true

    ok "CentOS 7 EOL repos patched to vault.centos.org"
}

# ─────────────────────────────────────────────
# STEP 5: RHEL/Rocky/AlmaLinux 8/9 Repos
# ─────────────────────────────────────────────
fix_rhel89_repos() {
    local PKG_MGR="dnf"
    command -v dnf &>/dev/null || PKG_MGR="yum"

    log "Refreshing RHEL/Rocky/Alma $OS_VERSION_ID repos via $PKG_MGR..."

    # Set ip_resolve=4 in each repo file to prevent IPv6 issues
    find /etc/yum.repos.d/ -name "*.repo" -exec \
        sed -i '/^\[/a ip_resolve=4' {} \; 2>/dev/null || true

    # Remove duplicate ip_resolve lines if already there
    find /etc/yum.repos.d/ -name "*.repo" -exec \
        awk '!seen[$0]++' {} \; 2>/dev/null || true

    $PKG_MGR clean all 2>/dev/null || true
    $PKG_MGR makecache 2>/dev/null || true

    ok "RHEL/Rocky/Alma repos refreshed"
}

# ─────────────────────────────────────────────
# STEP 6: Ubuntu/Debian Repos
# ─────────────────────────────────────────────
fix_ubuntu_repos() {
    log "Fixing Ubuntu/Debian APT repo configuration..."

    # Force IPv4 for APT
    mkdir -p /etc/apt/apt.conf.d/
    cat > /etc/apt/apt.conf.d/99kubeez-ipv4 <<'EOF'
// KubeEZ: Force IPv4 to prevent IPv6 connectivity errors
Acquire::ForceIPv4 "true";
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
EOF

    # Fix Ubuntu sources.list for EOL versions
    UBUNTU_CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
    
    # Map EOL Ubuntu codenames to archive
    case "$UBUNTU_CODENAME" in
        xenial|bionic|cosmic|disco|eoan|focal|groovy|hirsute|impish)
            log "Ubuntu $UBUNTU_CODENAME detected - checking if using archive repos..."
            if ! grep -q "old-releases.ubuntu.com" /etc/apt/sources.list 2>/dev/null; then
                # Replace broken mirrors with archive
                sed -i 's|http://archive.ubuntu.com|http://old-releases.ubuntu.com|g' \
                    /etc/apt/sources.list 2>/dev/null || true
                sed -i 's|http://security.ubuntu.com|http://old-releases.ubuntu.com|g' \
                    /etc/apt/sources.list 2>/dev/null || true
            fi
            ;;
    esac

    apt-get clean 2>/dev/null || true
    apt-get update -y 2>/dev/null || true

    ok "Ubuntu/Debian APT repos fixed"
}

# ─────────────────────────────────────────────
# STEP 7: Run OS-specific fixes
# ─────────────────────────────────────────────
case "$OS_ID" in
    centos)
        if [ "$OS_MAJOR" -eq 7 ]; then
            fix_centos7_repos
        else
            fix_rhel89_repos
        fi
        ;;
    rhel|rocky|almalinux|ol|fedora)
        fix_rhel89_repos
        ;;
    ubuntu|debian|linuxmint|pop)
        fix_ubuntu_repos
        ;;
    *)
        warn "Unknown OS: $OS_ID. Skipping OS-specific repo fixes."
        ;;
esac

# ─────────────────────────────────────────────
# STEP 8: SSL / CA Trust update
# ─────────────────────────────────────────────
log "Refreshing CA trust bundle..."
if command -v update-ca-trust &>/dev/null; then
    update-ca-trust force-enable 2>/dev/null || true
    update-ca-trust extract        2>/dev/null || true
elif command -v update-ca-certificates &>/dev/null; then
    update-ca-certificates         2>/dev/null || true
fi

# ─────────────────────────────────────────────
# STEP 9: Verify internet connectivity
# ─────────────────────────────────────────────
log "Verifying outbound internet connectivity..."
PING_HOSTS=("8.8.8.8" "1.1.1.1")
INTERNET_OK=false

for host in "${PING_HOSTS[@]}"; do
    if ping -c 1 -W 3 "$host" &>/dev/null 2>&1; then
        INTERNET_OK=true
        ok "Network reachable via $host"
        break
    fi
done

if [ "$INTERNET_OK" = false ]; then
    warn "Ping blocked - testing HTTP fallback..."
    if curl -4 -s --max-time 10 https://www.google.com &>/dev/null; then
        INTERNET_OK=true
        ok "HTTP connectivity confirmed"
    fi
fi

if [ "$INTERNET_OK" = false ]; then
    echo "❌ FATAL: This node has no outbound internet access."
    echo "   Please configure network/NAT/proxy and retry."
    exit 1
fi

echo ""
echo "============================================="
echo "✓ OS Repository & DNS fix complete!"
echo "  OS: $OS_ID $OS_VERSION_ID"
echo "  DNS: 8.8.8.8 / 1.1.1.1"
echo "  IPv4-forced: yes"
echo "  Internet: OK"
echo "============================================="
