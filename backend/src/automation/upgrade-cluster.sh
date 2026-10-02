#!/bin/bash

# KubeEZ - Upgrade Cluster Script
# Upgrades ONE Kubernetes node (Control Plane or Worker) to a target version,
# following the kubeadm workflow:
#   1. Preflight gate (no changes)   4. kubeadm upgrade apply / node
#   2. etcd snapshot (first master)  5. Upgrade kubelet & kubectl
#   3. Upgrade kubeadm               6. Restart + verify node Ready
#
# Usage: upgrade-cluster.sh <version> <master|worker> <is_first_master> [upgrade|check]
#   check → run ONLY the preflight gate and exit (nothing is modified).
#
# On ANY failure the script prints a human-readable banner AND one machine line:
#   KUBEEZ_FAIL|<CODE>|<what went wrong>|<how to fix it>
# The backend parses that line and shows it on the failure screen.

set -o pipefail

TARGET_VERSION="${1}"
NODE_ROLE="${2:-master}"          # master or worker
IS_FIRST_MASTER="${3:-false}"     # true only for the master that runs 'upgrade apply'
RUN_MODE="${4:-upgrade}"          # upgrade | check

STEP="initialization"
KUBEEZ_FAILED=""
ADMIN_KUBECONFIG=/etc/kubernetes/admin.conf

# Stage progress for the UI (0-100 within THIS node). The backend maps it
# onto the overall bar; the line itself is hidden from the log.
progress() {
    [ "$RUN_MODE" = "check" ] && return 0
    echo "KUBEEZ_PROGRESS|$1|$2"
}

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# apt-get without the harmless "GDBus.Error ... packagekit.service is masked"
# noise: apt's post-invoke hook pings PackageKit, which older KubeEZ installs
# masked. Real apt errors still pass through; the exit code is apt-get's own.
apt_get() {
    apt-get "$@" 2> >(grep -vE 'UnitMasked|packagekit\.service is masked|org\.freedesktop\.PackageKit' >&2)
}

# fail <CODE> <reason> <fix> — print a clear explanation and stop.
fail() {
    KUBEEZ_FAILED=1
    local code="$1" reason fix
    reason=$(printf '%s' "$2" | tr '|\n' '/ ' | sed 's/ *$//')
    fix=$(printf '%s' "$3" | tr '|\n' '/ ' | sed 's/ *$//')
    log "=================================================================="
    log "❌ UPGRADE STOPPED during: ${STEP}"
    log "   Reason : ${reason}"
    log "   Fix    : ${fix}"
    log "=================================================================="
    echo "KUBEEZ_FAIL|${code}|${reason}|${fix}"
    exit 1
}

# Any unexpected non-zero exit still produces a structured reason.
on_exit() {
    local rc=$?
    if [ "$rc" -ne 0 ] && [ -z "$KUBEEZ_FAILED" ]; then
        echo "KUBEEZ_FAIL|STEP_FAILED|Unexpected failure during step: ${STEP} (exit code ${rc}).|Check the log lines just above this message, fix the cause, then click Retry. The cluster keeps running on its current version."
    fi
}
trap on_exit EXIT

# ver_ge A B → true if version A >= B
ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]; }

if [ -z "$TARGET_VERSION" ]; then
    fail "INVALID_ARGS" "Target version is required (e.g. 1.35.0)." "Select a target version in the Upgrade dialog."
fi

TARGET_VERSION=${TARGET_VERSION#v}
VER_MAJOR_MINOR=$(echo "$TARGET_VERSION" | cut -d. -f1,2)
TARGET_MINOR=$(echo "$TARGET_VERSION" | cut -d. -f2)

if ! echo "$TARGET_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    fail "INVALID_VERSION" "'${TARGET_VERSION}' is not a valid Kubernetes version." "Use a version like 1.35.0."
fi

log "========================================="
log "Kubernetes v${TARGET_VERSION} — node role: ${NODE_ROLE} — mode: ${RUN_MODE}"
log "========================================="

# Package manager (needed by the preflight)
if command -v apt-get &> /dev/null; then
    PKG_MGR="apt"
elif command -v dnf &> /dev/null; then
    PKG_MGR="dnf"
elif command -v yum &> /dev/null; then
    PKG_MGR="yum"
else
    STEP="OS detection"
    fail "UNSUPPORTED_OS" "No supported package manager (apt, dnf or yum) found on this node." "Use Ubuntu/Debian, Rocky/AlmaLinux/RHEL or CentOS."
fi
# "Ignore excludes" flag: yum/dnf4 take --disableexcludes, dnf5 (Fedora 41+) only --setopt
NOEXCL="--disableexcludes=all"
dnf --version 2>/dev/null | grep -q dnf5 && NOEXCL="--setopt=disable_excludes=*"

# ══════════════════════════════════════════════════════════════════════════════
# 1. PREFLIGHT GATE — read-only. Every known blocker for the target version is
#    detected HERE, before the cluster is touched, with an exact reason + fix.
# ══════════════════════════════════════════════════════════════════════════════
STEP="preflight checks"
log "🔎 Preflight: checking this node can run Kubernetes v${VER_MAJOR_MINOR}..."
CONTAINERD_NEEDS_UPGRADE=""

# 1a. Kernel — v1.35+ needs a modern kernel (cgroups v2). 3.x = CentOS/RHEL 7.
KERNEL_FULL=$(uname -r)
KERNEL_MAJOR=$(echo "$KERNEL_FULL" | cut -d. -f1)
if [ "$KERNEL_MAJOR" -lt 4 ] && [ "$TARGET_MINOR" -ge 35 ]; then
    fail "KERNEL_UNSUPPORTED" \
        "Kubernetes v${VER_MAJOR_MINOR} needs a 5.x kernel with cgroups v2, but this node runs kernel ${KERNEL_FULL} (CentOS/RHEL 7 family). The highest version this OS supports is v1.34." \
        "Stay on v1.34, or move the node to Ubuntu 22.04+/Rocky or AlmaLinux 9."
fi
log "  ✓ Kernel ${KERNEL_FULL}"

# 1b. cgroups v2 — from v1.35 the kubelet refuses to start on cgroups v1.
CGROUP_FS=$(stat -fc %T /sys/fs/cgroup 2>/dev/null)
if [ "$TARGET_MINOR" -ge 35 ] && [ "$CGROUP_FS" != "cgroup2fs" ]; then
    fail "CGROUP_V1" \
        "This node uses cgroups v1 (/sys/fs/cgroup is '${CGROUP_FS:-unknown}'). From v1.35 the kubelet will not start on cgroups v1." \
        "Enable cgroups v2: add 'systemd.unified_cgroup_hierarchy=1' to GRUB_CMDLINE_LINUX in /etc/default/grub, run update-grub (or grub2-mkconfig), reboot, then retry."
fi
log "  ✓ cgroups: ${CGROUP_FS:-unknown}"

# 1c. containerd — v1.36+ requires containerd 2.x (v1.35 was the last to support 1.7).
CONTAINERD_VER=$(containerd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -z "$CONTAINERD_VER" ]; then
    fail "NO_CONTAINERD" "containerd is not installed or not on PATH on this node." "Reinstall the container runtime (containerd) on this node, then retry."
fi
if [ "$TARGET_MINOR" -ge 36 ] && ! ver_ge "$CONTAINERD_VER" "2.0.0"; then
    CONTAINERD_NEEDS_UPGRADE=1
    log "  ⚠ containerd ${CONTAINERD_VER} is too old for v${VER_MAJOR_MINOR} (needs 2.x) — it will be upgraded automatically."
else
    log "  ✓ containerd ${CONTAINERD_VER}"
fi
if ! systemctl is-active --quiet containerd; then
    fail "CONTAINERD_DOWN" "containerd is not running on this node." "Run: systemctl restart containerd — then check 'journalctl -u containerd -n 50' and retry."
fi

# 1d. Disk space — images + packages need room.
VAR_FREE_MB=$(df -Pm /var 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "$VAR_FREE_MB" ] && [ "$VAR_FREE_MB" -lt 2048 ]; then
    fail "DISK_FULL" "Only ${VAR_FREE_MB} MB free on /var. The upgrade needs at least 2 GB for new images and packages." "Free disk space (e.g. 'crictl rmi --prune', 'journalctl --vacuum-size=200M', 'apt-get clean'), then retry."
fi
log "  ✓ Disk: ${VAR_FREE_MB:-?} MB free on /var"

# 1e. Target version published + package repo reachable.
if [ "$PKG_MGR" = "apt" ]; then
    REPO_PROBE="https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/Release"
else
    REPO_PROBE="https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/repodata/repomd.xml"
fi
REPO_CODE=$(curl -4 -sL -o /dev/null -m 20 -w '%{http_code}' "$REPO_PROBE" 2>/dev/null)
if [ "$REPO_CODE" = "000" ] || [ -z "$REPO_CODE" ]; then
    fail "NO_INTERNET" "This node cannot reach pkgs.k8s.io (the Kubernetes package repository)." "Check the node's internet/DNS/firewall (outbound HTTPS 443 to pkgs.k8s.io and registry.k8s.io), then retry."
elif [ "$REPO_CODE" != "200" ]; then
    fail "VERSION_NOT_PUBLISHED" "Kubernetes v${VER_MAJOR_MINOR} is not published on pkgs.k8s.io yet (HTTP ${REPO_CODE})." "Choose an already released version, or wait until v${VER_MAJOR_MINOR} is released upstream."
fi
if [ "$PKG_MGR" = "apt" ]; then
    # Best effort: only conclusive when the index was actually downloaded
    # (the authoritative check is 'apt-cache madison' after the repo switch).
    PKG_INDEX=$(curl -4 -sL -m 30 "https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/Packages" 2>/dev/null)
    if echo "$PKG_INDEX" | grep -q '^Package: kubeadm' && ! echo "$PKG_INDEX" | grep -q "^Version: ${TARGET_VERSION}-"; then
        fail "VERSION_NOT_AVAILABLE" "Package version ${TARGET_VERSION} is not available in the v${VER_MAJOR_MINOR} repository." "Pick a released patch version of v${VER_MAJOR_MINOR} and retry."
    fi
fi
log "  ✓ Kubernetes v${TARGET_VERSION} packages are published"

REG_CODE=$(curl -4 -s -o /dev/null -m 20 -w '%{http_code}' https://registry.k8s.io/v2/ 2>/dev/null)
if [ "$REG_CODE" = "000" ] || [ -z "$REG_CODE" ]; then
    fail "REGISTRY_UNREACHABLE" "This node cannot reach registry.k8s.io, so the new control-plane images cannot be downloaded." "Allow outbound HTTPS (443) to registry.k8s.io and its CDN, then retry."
fi
log "  ✓ registry.k8s.io reachable"

# 1f. Version skew — upgrades must go one minor at a time.
if [ "$NODE_ROLE" = "master" ] && [ -f "$ADMIN_KUBECONFIG" ]; then
    SERVER_MINOR=$(kubectl --kubeconfig="$ADMIN_KUBECONFIG" version -o json 2>/dev/null | grep -A10 '"serverVersion"' | grep '"minor"' | grep -oE '[0-9]+' | head -1)
    if [ -n "$SERVER_MINOR" ]; then
        if [ $((TARGET_MINOR - SERVER_MINOR)) -gt 1 ]; then
            fail "SKIP_LEVEL" "The control plane is on v1.${SERVER_MINOR}; jumping to v${VER_MAJOR_MINOR} skips a version." "Upgrade one minor at a time: first to v1.$((SERVER_MINOR + 1))."
        fi
        if [ "$TARGET_MINOR" -lt "$SERVER_MINOR" ]; then
            fail "DOWNGRADE" "The control plane is already on v1.${SERVER_MINOR}; downgrading to v${VER_MAJOR_MINOR} is not supported." "Choose v1.${SERVER_MINOR} or newer."
        fi
        log "  ✓ Version path v1.${SERVER_MINOR} → v${VER_MAJOR_MINOR}"
    fi
    # The API server must be healthy before kubeadm can upgrade it.
    if [ "$IS_FIRST_MASTER" = "true" ]; then
        if [ "$(kubectl --kubeconfig="$ADMIN_KUBECONFIG" get --raw='/readyz' 2>/dev/null)" != "ok" ]; then
            fail "CLUSTER_UNHEALTHY" "The Kubernetes API server is not healthy right now, so it is not safe to upgrade." "Fix the control plane first (check 'kubectl get pods -n kube-system' and 'journalctl -u kubelet -n 50'), then retry."
        fi
        log "  ✓ API server healthy"
    fi
else
    KUBELET_MINOR=$(kubelet --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | cut -d. -f2)
    if [ -n "$KUBELET_MINOR" ] && [ $((TARGET_MINOR - KUBELET_MINOR)) -gt 1 ]; then
        fail "SKIP_LEVEL" "This node's kubelet is v1.${KUBELET_MINOR}; jumping to v${VER_MAJOR_MINOR} skips a version." "Upgrade one minor at a time: first to v1.$((KUBELET_MINOR + 1))."
    fi
fi

log "✅ Preflight passed — node is compatible with Kubernetes v${TARGET_VERSION}."
progress 5 "Preflight passed"
if [ "$RUN_MODE" = "check" ]; then
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# 2. Automatic etcd snapshot (first control-plane only) — best effort
# ══════════════════════════════════════════════════════════════════════════════
if [ "$NODE_ROLE" = "master" ] && [ "$IS_FIRST_MASTER" = "true" ]; then
    STEP="etcd safety snapshot"
    progress 8 "Taking etcd safety snapshot"
    log "🛟 Taking etcd snapshot before upgrade (safety backup)..."
    BK_DIR="/var/lib/etcd-backup"
    mkdir -p "$BK_DIR"
    SNAP="$BK_DIR/etcd-pre-upgrade-$(date +%Y%m%d-%H%M%S).db"
    ETCD_CERTS="--cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key --endpoints=https://127.0.0.1:2379"

    # Host etcdctl (download the matching version if missing). We avoid exec-ing
    # inside the etcd pod because distroless etcd images have no shell.
    if ! command -v etcdctl >/dev/null 2>&1; then
        EV=$(grep -oE 'etcd:[0-9]+\.[0-9]+\.[0-9]+' /etc/kubernetes/manifests/etcd.yaml 2>/dev/null | head -1 | cut -d: -f2)
        [ -z "$EV" ] && EV=3.5.16
        A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64
        curl -fsSL --retry 3 -m 120 "https://github.com/etcd-io/etcd/releases/download/v${EV}/etcd-v${EV}-linux-${A}.tar.gz" -o /tmp/etcd.tgz 2>/dev/null \
            && tar xzf /tmp/etcd.tgz -C /tmp 2>/dev/null \
            && install -m0755 "/tmp/etcd-v${EV}-linux-${A}/etcdctl" /usr/local/bin/etcdctl 2>/dev/null
    fi
    if command -v etcdctl >/dev/null 2>&1; then
        if ETCDCTL_API=3 etcdctl $ETCD_CERTS snapshot save "$SNAP" >/dev/null 2>&1; then
            log "✓ etcd snapshot saved: $SNAP"
        else
            log "⚠️ etcd snapshot failed — continuing WITHOUT a backup."
        fi
    else
        log "⚠️ etcdctl unavailable (and download failed) — skipping snapshot (continuing)."
    fi
    # Retention (same rule as KubeEZ's daily snapshots): delete snapshots older
    # than 45 days, but always keep the newest one.
    NEWEST_SNAP=$(ls -1t "$BK_DIR"/*.db 2>/dev/null | head -1)
    find "$BK_DIR" -maxdepth 1 -type f -name '*.db' -mmin +$((45 * 1440)) 2>/dev/null \
        | while IFS= read -r f; do [ "$f" != "$NEWEST_SNAP" ] && rm -f "$f"; done
    true
fi

# Swap breaks the kubelet — disable it (same as a fresh install does).
if [ -n "$(swapon --show 2>/dev/null)" ]; then
    log "Disabling swap (the kubelet does not run with swap on)..."
    swapoff -a 2>/dev/null || true
    sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab 2>/dev/null || true
fi

# ══════════════════════════════════════════════════════════════════════════════
# 3. OS repositories + Kubernetes repo for the target minor
# ══════════════════════════════════════════════════════════════════════════════
STEP="preparing package repositories"
progress 15 "Preparing package repositories"
log "Detected Package Manager: $PKG_MGR"

# ── Proactive OS repo repair (runs BEFORE any yum operation) ─────────────────
# CentOS 7 is EOL: its mirrorlist is dead and vault.centos.org returns 403 on
# some files. Because yum refreshes ALL repos on every operation, one broken
# base/extras repo fails the entire upgrade. We repoint CentOS 7 to the vault
# archive, force IPv4 + reliable DNS, and (critically) make broken OS repos
# non-fatal so the Kubernetes repo can still install packages on ANY node.
if [ "$PKG_MGR" = "yum" ] || [ "$PKG_MGR" = "dnf" ]; then
    log "Preparing OS repositories (DNS, IPv4, EOL mirrors)..."

    # ── Release the yum lock: PackageKit (GNOME's background updater) grabs
    # /var/run/yum.pid on boot and makes every yum call wait ~minutes. Stop &
    # mask it, then clear any stale lock so our operations run immediately.
    log "Disabling PackageKit (frees the yum lock)..."
    systemctl stop packagekit 2>/dev/null || true
    systemctl mask packagekit 2>/dev/null || true
    pkill -9 -f PackageKit 2>/dev/null || true
    rm -f /var/run/yum.pid 2>/dev/null || true

    # ── FIRST: heal the RPM database BEFORE any rpm/yum command runs ──────────
    # A prior crash (SIGBUS) can leave Berkeley DB in DB_RUNRECOVERY state, which
    # makes every subsequent rpm/yum call fail with 'rpmdb open failed'. Recover
    # it up front so nothing downstream trips over a corrupt DB.
    heal_rpmdb() {
        if rpm -q rpm >/dev/null 2>&1; then
            return 0   # DB opens fine — nothing to do
        fi
        log "🔧 RPM database is corrupt — running recovery..."
        rm -f /var/lib/rpm/__db.* 2>/dev/null || true
        # Berkeley DB recovery (package name differs across versions)
        (command -v db_recover >/dev/null 2>&1 && db_recover -h /var/lib/rpm) 2>/dev/null || \
        (command -v /usr/lib/rpm/rpmdb_recover >/dev/null 2>&1 && /usr/lib/rpm/rpmdb_recover -h /var/lib/rpm) 2>/dev/null || true
        rpm --rebuilddb 2>/dev/null || true
        yum clean all 2>/dev/null || true
        rm -rf /var/cache/yum/* 2>/dev/null || true
        log "✓ RPM database recovery attempted"
    }
    heal_rpmdb

    # Force IPv4 (fixes curl#7 on nodes without IPv6)
    grep -q '^ip_resolve' /etc/yum.conf 2>/dev/null || echo 'ip_resolve=4' >> /etc/yum.conf 2>/dev/null || true
    [ -f /etc/dnf/dnf.conf ] && { grep -q '^ip_resolve' /etc/dnf/dnf.conf 2>/dev/null || echo 'ip_resolve=4' >> /etc/dnf/dnf.conf 2>/dev/null || true; }

    # Reliable public DNS if the node can't resolve
    if ! grep -q '8.8.8.8' /etc/resolv.conf 2>/dev/null; then
        cp /etc/resolv.conf /etc/resolv.conf.kubeez-bak 2>/dev/null || true
        printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\noptions timeout:2 attempts:3\n' > /etc/resolv.conf 2>/dev/null || true
    fi

    # CentOS 7 EOL → repoint to vault archive
    . /etc/os-release 2>/dev/null || true
    if [ "${ID:-}" = "centos" ] && [ "$(echo "${VERSION_ID:-0}" | cut -d. -f1)" = "7" ]; then
        log "CentOS 7 (EOL) detected — repointing base repos to vault.centos.org"
        rm -f /etc/yum.repos.d/CentOS-*.repo 2>/dev/null || true
        cat > /etc/yum.repos.d/CentOS-Vault.repo <<'REPOEOF'
[base]
name=CentOS-7 - Base (Vault)
baseurl=http://vault.centos.org/centos/7/os/$basearch/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4

[updates]
name=CentOS-7 - Updates (Vault)
baseurl=http://vault.centos.org/centos/7/updates/$basearch/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4

[extras]
name=CentOS-7 - Extras (Vault)
baseurl=http://vault.centos.org/centos/7/extras/$basearch/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4
REPOEOF
    fi

    # CentOS 8 (non-Stream) is also EOL → repoint to vault. CentOS Stream 8 is
    # still supported, so skip it (NAME contains "Stream").
    if [ "${ID:-}" = "centos" ] && [ "$(echo "${VERSION_ID:-0}" | cut -d. -f1)" = "8" ] && ! echo "${NAME:-}" | grep -qi stream; then
        log "CentOS 8 (EOL) detected — repointing base repos to vault.centos.org"
        rm -f /etc/yum.repos.d/CentOS-*.repo 2>/dev/null || true
        cat > /etc/yum.repos.d/CentOS-Vault.repo <<'REPOEOF8'
[baseos]
name=CentOS-8 - BaseOS (Vault)
baseurl=http://vault.centos.org/8.5.2111/BaseOS/$basearch/os/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4

[appstream]
name=CentOS-8 - AppStream (Vault)
baseurl=http://vault.centos.org/8.5.2111/AppStream/$basearch/os/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4

[extras]
name=CentOS-8 - Extras (Vault)
baseurl=http://vault.centos.org/8.5.2111/extras/$basearch/os/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4
REPOEOF8
    fi

    yum clean all 2>/dev/null || true
    rm -rf /var/cache/yum/* 2>/dev/null || true
fi

log "Updating package repositories for v${VER_MAJOR_MINOR}..."
if [ "$PKG_MGR" = "apt" ]; then
    # Force IPv4 + retries for APT (avoids IPv6 stalls on many nodes)
    mkdir -p /etc/apt/apt.conf.d
    cat > /etc/apt/apt.conf.d/99kubeez-ipv4 <<'APTEOF'
Acquire::ForceIPv4 "true";
Acquire::Retries "3";
APTEOF
    # Reliable DNS if the node can't resolve
    if ! grep -q '8.8.8.8' /etc/resolv.conf 2>/dev/null; then
        cp /etc/resolv.conf /etc/resolv.conf.kubeez-bak 2>/dev/null || true
        printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\noptions timeout:2 attempts:3\n' > /etc/resolv.conf 2>/dev/null || true
    fi

    # Heal dpkg if a previous run was interrupted (locks / half-configured state)
    rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock /var/cache/apt/archives/lock 2>/dev/null || true
    dpkg --configure -a 2>/dev/null || true

    # Always (re)fetch the signing key for the TARGET minor — a stale or expired
    # key from an older minor makes apt silently ignore the new repo.
    DIR_NAME="/etc/apt/keyrings"
    mkdir -p $DIR_NAME
    if ! curl -4 -fsSL "https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/Release.key" | gpg --dearmor --yes -o $DIR_NAME/kubernetes-apt-keyring.gpg; then
        fail "REPO_KEY_FAILED" "Could not download the signing key for the Kubernetes v${VER_MAJOR_MINOR} repository." "Check the node's internet access to pkgs.k8s.io, then retry."
    fi
    echo "deb [signed-by=$DIR_NAME/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/ /" > /etc/apt/sources.list.d/kubernetes.list

    # Update ONLY the Kubernetes list — a broken unrelated repo must not block us
    if ! apt_get update -o Dir::Etc::sourcelist="sources.list.d/kubernetes.list" -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0"; then
        fail "REPO_UPDATE_FAILED" "apt could not read the Kubernetes v${VER_MAJOR_MINOR} repository." "Check internet/DNS on the node and that /etc/apt/sources.list.d/kubernetes.list is valid, then retry."
    fi
    if ! apt-cache madison kubeadm 2>/dev/null | grep -q " ${TARGET_VERSION}-"; then
        AVAILABLE=$(apt-cache madison kubeadm 2>/dev/null | awk '{print $3}' | head -5 | tr '\n' ' ')
        fail "VERSION_NOT_AVAILABLE" "kubeadm ${TARGET_VERSION} is not available from the repository (available: ${AVAILABLE:-none})." "Choose one of the available versions and retry."
    fi
elif [ "$PKG_MGR" = "yum" ] || [ "$PKG_MGR" = "dnf" ]; then
    # Standardize on 'kubernetes.repo' and '[kubernetes]' ID to play nice with existing yum history
    rm -f /etc/yum.repos.d/kubernete*.repo /etc/yum.repos.d/k8s*.repo

    cat <<EOF > /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes v${VER_MAJOR_MINOR}
baseurl=https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/repodata/repomd.xml.key
EOF

    # Hard Clean of Yum Cache to fix 'No package' errors
    rm -rf /var/cache/yum
    yum clean all

    # Clear Version Locks if plugin exists (Common cause of 'No package available')
    if rpm -q yum-plugin-versionlock &> /dev/null; then
        echo "Clearing yum version locks..."
        yum versionlock clear || true
    fi

    # Repair a corrupted RPM DB up front (a common CentOS 7 cause of
    # 'Bus error (core dumped)' during yum install)
    rpmdb_repair() {
        echo "🔧 Repairing RPM database..."
        rm -f /var/lib/rpm/__db.* 2>/dev/null || true
        (command -v db_recover >/dev/null 2>&1 && db_recover -h /var/lib/rpm) 2>/dev/null || \
        (command -v /usr/lib/rpm/rpmdb_recover >/dev/null 2>&1 && /usr/lib/rpm/rpmdb_recover -h /var/lib/rpm) 2>/dev/null || true
        rpm --rebuilddb 2>/dev/null || true
        yum clean all 2>/dev/null || true
        rm -rf /var/cache/yum/* 2>/dev/null || true
    }

    # Resilient install: on ANY failure (incl. SIGBUS/segfault crash from a
    # corrupted RPM DB), rebuild the DB once and retry.
    yum_install_safe() {
        if $PKG_MGR install -y "$@" $NOEXCL --setopt=*.skip_if_unavailable=1; then
            return 0
        fi
        echo "⚠️ install failed (possible RPM DB corruption). Rebuilding DB and retrying..."
        rpmdb_repair
        $PKG_MGR install -y "$@" $NOEXCL --setopt=*.skip_if_unavailable=1
    }

    # skip_if_unavailable: broken/EOL OS repos must never fail the k8s upgrade
    yum makecache --setopt=*.skip_if_unavailable=1 || { rpmdb_repair; yum makecache --setopt=*.skip_if_unavailable=1 || true; }
    yum repolist || true
fi

# ══════════════════════════════════════════════════════════════════════════════
# 3b. containerd 2.x (required from v1.36) — upgrade in place when needed
# ══════════════════════════════════════════════════════════════════════════════
if [ -n "$CONTAINERD_NEEDS_UPGRADE" ]; then
    STEP="upgrading containerd to 2.x"
    progress 25 "Upgrading containerd to 2.x"
    log "Upgrading containerd ${CONTAINERD_VER} → 2.x (required by Kubernetes v${VER_MAJOR_MINOR})..."
    if [ "$PKG_MGR" = "apt" ]; then
        apt-get update -o Acquire::AllowInsecureRepositories=true >/dev/null 2>&1 || true
        DEBIAN_FRONTEND=noninteractive apt_get install -y -o Dpkg::Options::="--force-confold" containerd.io \
            || fail "CONTAINERD_UPGRADE_FAILED" "Could not upgrade containerd to 2.x (package containerd.io)." "Upgrade containerd manually to 2.x (Docker's containerd.io package), confirm 'containerd --version' shows 2.x, then retry."
    else
        $PKG_MGR install -y containerd.io --setopt=*.skip_if_unavailable=1 \
            || fail "CONTAINERD_UPGRADE_FAILED" "Could not upgrade containerd to 2.x (package containerd.io)." "Upgrade containerd manually to 2.x, confirm 'containerd --version' shows 2.x, then retry."
    fi
    systemctl daemon-reload
    systemctl restart containerd
    sleep 5
    NEW_CTR=$(containerd --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    if ! ver_ge "${NEW_CTR:-0.0.0}" "2.0.0"; then
        fail "CONTAINERD_TOO_OLD" "containerd is still ${NEW_CTR:-unknown} after the upgrade attempt; Kubernetes v${VER_MAJOR_MINOR} needs 2.x." "Install containerd 2.x manually (the repository on this node only offers ${NEW_CTR:-an old version}), then retry."
    fi
    if ! systemctl is-active --quiet containerd; then
        fail "CONTAINERD_DOWN" "containerd ${NEW_CTR} did not start after the upgrade." "Check 'journalctl -u containerd -n 50' (usually /etc/containerd/config.toml), fix it, then retry."
    fi
    log "✓ containerd upgraded to ${NEW_CTR}"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 4. Upgrade kubeadm
# ══════════════════════════════════════════════════════════════════════════════
STEP="installing kubeadm ${TARGET_VERSION}"
progress 30 "Installing kubeadm"
log "Upgrading kubeadm to ${TARGET_VERSION}..."
if [ "$PKG_MGR" = "apt" ]; then
    apt-mark unhold kubeadm >/dev/null 2>&1 || true
    # --allow-downgrades handles recovery from a previously half-finished upgrade
    if ! DEBIAN_FRONTEND=noninteractive apt_get install -y --allow-downgrades --allow-change-held-packages kubeadm="${TARGET_VERSION}-*"; then
        fail "PKG_INSTALL_FAILED" "apt could not install kubeadm ${TARGET_VERSION}." "Look at the apt error above (often a dpkg lock or broken package). Run 'dpkg --configure -a' on the node, then retry."
    fi
    apt-mark hold kubeadm >/dev/null 2>&1 || true
else
    if ! yum_install_safe "kubeadm-${TARGET_VERSION}*"; then
        echo "Available kubeadm versions:"
        $PKG_MGR --showduplicates list kubeadm $NOEXCL --setopt=*.skip_if_unavailable=1 || true
        fail "PKG_INSTALL_FAILED" "yum/dnf could not install kubeadm ${TARGET_VERSION}." "Look at the package error above, then retry."
    fi
    $PKG_MGR downgrade -y "kubeadm-${TARGET_VERSION}*" $NOEXCL --setopt=*.skip_if_unavailable=1 >/dev/null 2>&1 || true
fi

KUBEADM_VER=$(kubeadm version -o short 2>/dev/null)
if [ "${KUBEADM_VER#v}" != "$TARGET_VERSION" ]; then
    fail "PKG_VERSION_MISMATCH" "kubeadm reports ${KUBEADM_VER:-nothing} after installing ${TARGET_VERSION}." "Check for a version lock/hold on kubeadm, then retry."
fi
log "kubeadm upgraded to: $KUBEADM_VER"

# ══════════════════════════════════════════════════════════════════════════════
# 5. Control-plane prep: pre-pull images + sync the sandbox (pause) image
# ══════════════════════════════════════════════════════════════════════════════
if [ "$NODE_ROLE" = "master" ]; then
    STEP="downloading control-plane images"
    progress 40 "Downloading control-plane images"
    # 'kubeadm upgrade apply' waits a fixed time for each new static pod. If the
    # image must be downloaded during that window the upgrade times out — so
    # pull everything first.
    log "Pre-pulling Kubernetes v${TARGET_VERSION} control-plane images..."
    PULLED=""
    for i in 1 2 3; do
        if kubeadm config images pull --kubernetes-version "v${TARGET_VERSION}"; then
            PULLED=1; log "✓ Images pre-pulled."; break
        fi
        log "⚠️ Image pull attempt $i failed — retrying in 10s..."
        sleep 10
    done
    if [ -z "$PULLED" ]; then
        fail "IMAGE_PULL_FAILED" "Could not download the Kubernetes v${TARGET_VERSION} control-plane images from registry.k8s.io." "Check the node's internet/DNS and free disk space, then retry. The cluster was not changed."
    fi

    # An inconsistent sandbox image stalls pod-sandbox creation during the static
    # pod swap ("context deadline exceeded"). Works for containerd 1.7 (config
    # version 2: sandbox_image) and containerd 2.x (config version 3: sandbox).
    STEP="syncing the sandbox (pause) image"
    PAUSE_IMG=$(kubeadm config images list --kubernetes-version "v${TARGET_VERSION}" 2>/dev/null | grep -m1 '/pause:')
    CTR_CFG=/etc/containerd/config.toml
    if [ -n "$PAUSE_IMG" ] && [ -f "$CTR_CFG" ] && ! grep -qF "\"$PAUSE_IMG\"" "$CTR_CFG"; then
        if grep -qE '^\s*sandbox_image\s*=' "$CTR_CFG"; then
            sed -i -E "s#^(\s*)sandbox_image\s*=.*#\1sandbox_image = \"$PAUSE_IMG\"#" "$CTR_CFG"
        elif grep -qE '^\s*sandbox\s*=' "$CTR_CFG"; then
            sed -i -E "s#^(\s*)sandbox\s*=.*#\1sandbox = \"$PAUSE_IMG\"#" "$CTR_CFG"
        fi
        log "Syncing containerd sandbox image → $PAUSE_IMG"
        crictl pull "$PAUSE_IMG" >/dev/null 2>&1 || ctr -n k8s.io images pull "$PAUSE_IMG" >/dev/null 2>&1 || true
        systemctl restart containerd 2>/dev/null || true
        sleep 5
        systemctl is-active --quiet containerd || fail "CONTAINERD_DOWN" "containerd did not come back after updating its sandbox image." "Check 'journalctl -u containerd -n 50' on the node, fix /etc/containerd/config.toml, then retry."
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# 6. kubeadm upgrade apply / node — with failure diagnosis and one auto-retry
# ══════════════════════════════════════════════════════════════════════════════

# Preflight errors bypassed for compatibility on old/slow nodes:
#   • CreateJob          → kubeadm's 15s 'upgrade-health-check' Job routinely
#                          times out on slow nodes although the cluster is fine.
#   • SystemVerification → old kernels / cgroups v1 flagged (we gate those above).
IGNORE_FLAGS="--ignore-preflight-errors=CreateJob,SystemVerification"
KUBEADM_LOG=/tmp/kubeez-kubeadm-upgrade.log

# Print the last log lines of a failing control-plane container (if any).
component_logs() {
    for comp in etcd kube-apiserver kube-controller-manager kube-scheduler; do
        local cid
        cid=$(crictl ps -a --name "$comp" -q 2>/dev/null | head -1)
        [ -z "$cid" ] && continue
        local state
        state=$(crictl inspect -o go-template --template '{{.status.state}}' "$cid" 2>/dev/null)
        if [ "$state" != "CONTAINER_RUNNING" ]; then
            log "--- last log lines of ${comp} (${state:-unknown}) ---"
            crictl logs --tail 15 "$cid" 2>&1 | sed 's/^/    /'
        fi
    done
}

# Map a kubeadm failure to a clear reason + fix. Patterns are matched ONLY
# against the error lines — normal output (e.g. "[certs] ... certificate")
# must never be mistaken for the cause.
diagnose_kubeadm() {
    local out err last_err state
    out=$(cat "$KUBEADM_LOG" 2>/dev/null)
    err=$(echo "$out" | grep -iE '\[ERROR|error|fatal|failed|timed out|deadline|refused' | grep -viE '^\s*\[(certs|kubeconfig)\]')
    last_err=$(echo "$out" | grep -iE 'error execution phase|\[ERROR|fatal|error:' | tail -1 | cut -c1-300)
    [ -z "$last_err" ] && last_err=$(echo "$err" | tail -1 | cut -c1-300)

    # Where did it stop? Before the static-pod swap kubeadm rolls back; in the
    # post-upgrade phase the control plane is ALREADY on the new version.
    if echo "$err" | grep -qi 'phase post-upgrade'; then
        state="The control plane was already upgraded; only kubeadm's final post-upgrade step failed, so a retry finishes the job."
    else
        state="kubeadm rolled the control plane back, so the cluster is still running on its previous version."
    fi

    if echo "$err" | grep -qiE 'kubelet env file|kubeadm-flags\.env|no flags found'; then
        echo "KUBELET_ENV_FILE|kubeadm could not read /var/lib/kubelet/kubeadm-flags.env (it has no kubelet flags left — newer Kubernetes removed the only flag it had). ${state}|Retry the upgrade — KubeEZ repairs this file automatically before running kubeadm."
    elif echo "$err" | grep -qiE 'ErrImagePull|ImagePullBackOff|failed to pull image|pull access denied'; then
        echo "IMAGE_PULL_FAILED|A new control-plane image could not be downloaded. ${state}|Check internet/DNS access to registry.k8s.io and free disk space, then retry."
    elif echo "$err" | grep -qiE 'etcd.*(deadline|timed out|not healthy)|(deadline|timed out).*etcd'; then
        echo "ETCD_UPGRADE_TIMEOUT|The new etcd did not become healthy in time. ${state}|Usually a slow disk or a stale sandbox image. Check the etcd container on the master ('crictl ps -a --name etcd', then 'crictl logs <id>'), then retry."
    elif echo "$err" | grep -qiE 'context deadline exceeded|timed out waiting for the condition|static Pod hash|did not change after'; then
        echo "CONTROL_PLANE_TIMEOUT|A control-plane component did not become healthy in time after the upgrade. ${state}|Check the component logs shown above (crictl ps -a / crictl logs). Slow nodes usually succeed on retry because images are now cached."
    elif echo "$err" | grep -qiE 'connection refused.*6443|6443.*connection refused|unable to connect to the server'; then
        echo "API_SERVER_DOWN|kubeadm could not reach the API server on port 6443.|Make sure the kube-apiserver container is running ('crictl ps --name kube-apiserver') and port 6443 is free, then retry."
    elif echo "$err" | grep -qiE '\[ERROR '; then
        echo "KUBEADM_PREFLIGHT|kubeadm preflight check failed: ${last_err}|Fix the reported item on the node, then retry."
    elif echo "$err" | grep -qiE 'version skew|is not supported|Specified version to upgrade to'; then
        echo "VERSION_SKEW|kubeadm refused this version jump: ${last_err}|Upgrade one minor version at a time, and make sure all nodes are on the same version first."
    elif echo "$err" | grep -qiE 'x509|certificate (has )?expired|certificate is not valid|certificate signed by unknown'; then
        echo "CERTIFICATE_ERROR|A certificate problem stopped the upgrade: ${last_err}|Check certificate expiry with 'kubeadm certs check-expiration' and renew if needed ('kubeadm certs renew all'), then retry."
    else
        echo "KUBEADM_UPGRADE_FAILED|kubeadm upgrade failed: ${last_err:-see the log above}. ${state}|Read the kubeadm output above for the exact cause, fix it, then retry."
    fi
}

# kubeadm (1.35+) refuses to continue when kubeadm-flags.env contains no
# flags ("no flags found in file"). That happens when the only flag in it was
# --pod-infra-container-image, which newer Kubernetes removed. Drop removed
# flags and, if nothing is left, pin --node-ip to the IP the node ALREADY uses
# (read from the API), so kubelet behaviour does not change.
KUBELET_ENV_FILE=/var/lib/kubelet/kubeadm-flags.env
ensure_kubelet_env_flags() {
    [ -f "$KUBELET_ENV_FILE" ] || return 0
    sed -i 's/--pod-infra-container-image=[^" ]*//g' "$KUBELET_ENV_FILE" 2>/dev/null || true
    local args
    args=$(grep -E '^KUBELET_KUBEADM_ARGS=' "$KUBELET_ENV_FILE" 2>/dev/null | head -1 \
        | sed -E 's/^KUBELET_KUBEADM_ARGS=//; s/^"//; s/"[[:space:]]*$//' | xargs 2>/dev/null)
    [ -n "$args" ] && return 0

    local cfg="" node_ip="" ip local_ips
    [ -f "$ADMIN_KUBECONFIG" ] && cfg="$ADMIN_KUBECONFIG"
    [ -z "$cfg" ] && [ -f /etc/kubernetes/kubelet.conf ] && cfg=/etc/kubernetes/kubelet.conf
    if [ -n "$cfg" ]; then
        # The node's registered InternalIP that is also a local address
        local_ips=" $(hostname -I 2>/dev/null) "
        for ip in $(kubectl --kubeconfig="$cfg" get nodes -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{" "}{end}' 2>/dev/null); do
            case "$local_ips" in *" $ip "*) node_ip="$ip"; break;; esac
        done
    fi
    # Fallback: the source IP of the default route (kubelet's own default)
    [ -z "$node_ip" ] && node_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')

    if [ -n "$node_ip" ]; then
        cp "$KUBELET_ENV_FILE" "${KUBELET_ENV_FILE}.kubeez-bak" 2>/dev/null || true
        echo "KUBELET_KUBEADM_ARGS=\"--node-ip=${node_ip}\"" > "$KUBELET_ENV_FILE"
        log "Repaired ${KUBELET_ENV_FILE}: it had no flags left — set --node-ip=${node_ip} (the IP this node already uses)."
    else
        fail "KUBELET_ENV_FILE" "${KUBELET_ENV_FILE} has no kubelet flags and this node's IP could not be detected." "Write it manually as KUBELET_KUBEADM_ARGS=\"--node-ip=<this-node-ip>\" and retry."
    fi
}

run_kubeadm_upgrade() {
    local rc
    if [ "$NODE_ROLE" = "master" ] && [ "$IS_FIRST_MASTER" = "true" ]; then
        log "Running 'kubeadm upgrade apply v${TARGET_VERSION}' (primary control plane)..."
        kubeadm upgrade apply "v${TARGET_VERSION}" --yes $IGNORE_FLAGS 2>&1 | tee "$KUBEADM_LOG"
        rc=${PIPESTATUS[0]}
    else
        log "Running 'kubeadm upgrade node' (${NODE_ROLE})..."
        kubeadm upgrade node $IGNORE_FLAGS 2>&1 | tee "$KUBEADM_LOG"
        rc=${PIPESTATUS[0]}
    fi
    return "$rc"
}

STEP="kubeadm upgrade (control plane / node config)"
progress 55 "Running kubeadm upgrade (this is the longest step)"
ensure_kubelet_env_flags
if ! run_kubeadm_upgrade; then
    DIAG=$(diagnose_kubeadm)
    CODE=$(echo "$DIAG" | cut -d'|' -f1)
    [ "$NODE_ROLE" = "master" ] && component_logs
    # Timeouts are usually transient (slow disk/first image use) — retry once.
    if [ "$CODE" = "KUBELET_ENV_FILE" ]; then
        log "⚠️ kubelet env file problem — repairing it and retrying once..."
        ensure_kubelet_env_flags
        if run_kubeadm_upgrade; then DIAG=""; else DIAG=$(diagnose_kubeadm); fi
    elif [ "$CODE" = "CONTROL_PLANE_TIMEOUT" ] || [ "$CODE" = "ETCD_UPGRADE_TIMEOUT" ] || [ "$CODE" = "API_SERVER_DOWN" ]; then
        log "⚠️ ${CODE} — waiting 30s for the control plane to settle, then retrying once..."
        systemctl restart kubelet 2>/dev/null || true
        sleep 30
        if run_kubeadm_upgrade; then
            DIAG=""
        else
            DIAG=$(diagnose_kubeadm)
            [ "$NODE_ROLE" = "master" ] && component_logs
        fi
    fi
    if [ -n "$DIAG" ]; then
        fail "$(echo "$DIAG" | cut -d'|' -f1)" "$(echo "$DIAG" | cut -d'|' -f2)" "$(echo "$DIAG" | cut -d'|' -f3)"
    fi
fi
log "✓ kubeadm upgrade finished."

# ══════════════════════════════════════════════════════════════════════════════
# 7. Upgrade kubelet + kubectl
# ══════════════════════════════════════════════════════════════════════════════
STEP="installing kubelet/kubectl ${TARGET_VERSION}"
progress 78 "Installing kubelet and kubectl"
log "Upgrading kubelet and kubectl to ${TARGET_VERSION}..."
if [ "$PKG_MGR" = "apt" ]; then
    apt-mark unhold kubelet kubectl >/dev/null 2>&1 || true
    if ! DEBIAN_FRONTEND=noninteractive apt_get install -y --allow-downgrades --allow-change-held-packages kubelet="${TARGET_VERSION}-*" kubectl="${TARGET_VERSION}-*"; then
        fail "PKG_INSTALL_FAILED" "apt could not install kubelet/kubectl ${TARGET_VERSION}. The control plane is already upgraded; only this node's kubelet is behind." "Run 'dpkg --configure -a' on the node, then retry — the retry will finish this node."
    fi
    apt-mark hold kubelet kubectl >/dev/null 2>&1 || true
else
    if ! yum_install_safe "kubelet-${TARGET_VERSION}*" "kubectl-${TARGET_VERSION}*"; then
        fail "PKG_INSTALL_FAILED" "yum/dnf could not install kubelet/kubectl ${TARGET_VERSION}. The control plane is already upgraded; only this node's kubelet is behind." "Look at the package error above, then retry — the retry will finish this node."
    fi
fi

# Strip kubelet flags removed in newer Kubernetes (v1.35 removed
# --pod-infra-container-image; an old value makes kubelet crash-loop).
if [ -f "$KUBELET_ENV_FILE" ]; then
    log "Cleaning obsolete kubelet flags (kubeadm-flags.env)..."
    ensure_kubelet_env_flags
    sed -i 's/  */ /g' "$KUBELET_ENV_FILE" || true
fi

# ══════════════════════════════════════════════════════════════════════════════
# 8. Restart runtime + kubelet, and make sure kubelet actually stays up
# ══════════════════════════════════════════════════════════════════════════════
STEP="restarting kubelet"
progress 85 "Restarting kubelet"
log "Restarting container runtime + kubelet..."
systemctl daemon-reload
systemctl restart containerd 2>/dev/null || systemctl restart docker 2>/dev/null || true
sleep 3
systemctl restart kubelet

KUBELET_UP=""
for i in $(seq 1 12); do   # up to ~60s
    sleep 5
    if systemctl is-active --quiet kubelet; then
        # Still active a few seconds later = not crash-looping
        sleep 5
        systemctl is-active --quiet kubelet && { KUBELET_UP=1; break; }
    fi
done
if [ -z "$KUBELET_UP" ]; then
    KERR=$(journalctl -u kubelet -n 80 --no-pager 2>/dev/null | grep -iE 'error|fail|unknown flag|invalid' | tail -3 | sed 's/^.*kubelet\[[0-9]*\]: //' | tr '\n' ' ' | cut -c1-400)
    if echo "$KERR" | grep -qi 'cgroup'; then
        fail "KUBELET_CGROUP" "kubelet ${TARGET_VERSION} will not start because of the cgroup setup: ${KERR}" "Make sure the node uses cgroups v2 and containerd uses 'SystemdCgroup = true', then retry."
    elif echo "$KERR" | grep -qi 'unknown flag'; then
        fail "KUBELET_FLAG" "kubelet ${TARGET_VERSION} rejected an old command-line flag: ${KERR}" "Remove the flag from /var/lib/kubelet/kubeadm-flags.env (and /etc/default/kubelet), run 'systemctl restart kubelet', then retry."
    elif echo "$KERR" | grep -qi 'swap'; then
        fail "KUBELET_SWAP" "kubelet will not start because swap is enabled: ${KERR}" "Run 'swapoff -a' and remove swap from /etc/fstab, then retry."
    else
        fail "KUBELET_NOT_STARTING" "kubelet ${TARGET_VERSION} does not stay running after the upgrade: ${KERR:-no error found in the journal}" "Check 'journalctl -u kubelet -n 100' on the node, fix the cause, then retry."
    fi
fi
log "✓ kubelet is running."

# Clusters created by older KubeEZ versions run the kubelet with
# serverTLSBootstrap=true; its serving-cert CSRs stay Pending (breaking
# 'kubectl logs/exec') unless approved. Approve ONLY kubelet-serving CSRs
# requested by nodes. Masters have admin.conf; workers are covered when the
# master is upgraded/re-run.
if [ -f "$ADMIN_KUBECONFIG" ]; then
    sleep 5
    PENDING=$(kubectl --kubeconfig="$ADMIN_KUBECONFIG" get csr -o go-template='{{range .items}}{{if and (not .status.certificate) (eq .spec.signerName "kubernetes.io/kubelet-serving")}}{{.metadata.name}} {{.spec.username}}{{"\n"}}{{end}}{{end}}' 2>/dev/null | awk '$2 ~ /^system:node:/ {print $1}')
    if [ -n "$PENDING" ]; then
        echo "$PENDING" | xargs -r kubectl --kubeconfig="$ADMIN_KUBECONFIG" certificate approve >/dev/null 2>&1 \
            && log "✓ Approved pending kubelet serving certificates (fixes 'kubectl logs/exec')."
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# 9. Verify the node reports Ready (self-heal once if not)
# ══════════════════════════════════════════════════════════════════════════════
STEP="waiting for the node to become Ready"
progress 92 "Waiting for the node to become Ready"
NODE_NAME=$(hostname | tr '[:upper:]' '[:lower:]')
KUBECFG=""
[ -f "$ADMIN_KUBECONFIG" ] && KUBECFG="$ADMIN_KUBECONFIG"
[ -z "$KUBECFG" ] && [ -f /etc/kubernetes/kubelet.conf ] && KUBECFG=/etc/kubernetes/kubelet.conf

if [ -n "$KUBECFG" ]; then
    log "Waiting for node '${NODE_NAME}' to report Ready..."
    READY=""
    for i in $(seq 1 24); do   # up to ~4 minutes
        ST=$(KUBECONFIG=$KUBECFG kubectl get node "$NODE_NAME" --no-headers 2>/dev/null | awk '{print $2}')
        case "$ST" in
            Ready|Ready,SchedulingDisabled) READY=1; log "✓ Node is Ready."; break;;
        esac
        # Half-way through, actively remediate a stuck runtime/CNI.
        if [ "$i" = "6" ]; then
            log "Node still not Ready — remediating (restart runtime + kubelet)..."
            systemctl restart containerd 2>/dev/null || systemctl restart docker 2>/dev/null || true
            sleep 3
            systemctl restart kubelet 2>/dev/null || true
        fi
        sleep 10
    done
    if [ -z "$READY" ]; then
        # Non-fatal: kubelet runs and the CNI DaemonSet may still be rolling out;
        # the backend health check and auto-healing keep watching it.
        log "⚠️ Node '${NODE_NAME}' has not reported Ready yet (kubelet is running). It usually becomes Ready once the network plugin pods restart."
    fi
else
    log "No kubeconfig on this node to verify readiness (kubelet is running)."
fi

STEP="done"
log "========================================="
log "Upgrade Complete! Node is now running v${TARGET_VERSION}"
progress 100 "Node upgraded"
log "========================================="
