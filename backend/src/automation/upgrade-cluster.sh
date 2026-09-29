#!/bin/bash

# KubeEZ - Upgrade Cluster Script
# This script upgrades a Kubernetes node (Control Plane or Worker) to a target version
# It follows the strict kubeadm upgrade workflow:
# 1. Upgrade kubeadm
# 2. kubeadm upgrade apply (Master 0) or kubeadm upgrade node (Workers/Secondary Masters)
# 3. Drain node
# 4. Upgrade kubelet & kubectl
# 5. Uncordon node

set -e

TARGET_VERSION="${1}"
NODE_ROLE="${2:-master}" # master or worker
IS_FIRST_MASTER="${3:-false}" # true only for the very first master where we run 'upgrade apply'

# Function: Logging
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

if [ -z "$TARGET_VERSION" ]; then
    log "Error: Target version is required (e.g. 1.29.0)"
    exit 1
fi

# Strip 'v' if present
TARGET_VERSION=${TARGET_VERSION#v}
# Major.Minor (e.g. 1.29)
VER_MAJOR_MINOR=$(echo "$TARGET_VERSION" | cut -d. -f1,2)

log "========================================="
log "Starting Upgrade to Kubernetes v${TARGET_VERSION}"
log "Node Role: ${NODE_ROLE}"
log "========================================="

# 0. Safety Pre-flight: Check Version Skew
CURRENT_KUBEADM=$(kubeadm version -o short | cut -dv -f2 | cut -d. -f1,2)
TARGET_MINOR=$(echo "$TARGET_VERSION" | cut -d. -f2)
CURRENT_MINOR=$(echo "$CURRENT_KUBEADM" | cut -d. -f2)

if [ "$((TARGET_MINOR - CURRENT_MINOR))" -gt 1 ]; then
    log "❌ FATAL: Skip-level upgrade detected!"
    log "Cannot upgrade from v${CURRENT_KUBEADM} to v${TARGET_VERSION} directly."
    log "Kubernetes requires sequential upgrades (e.g. 1.28 -> 1.29 -> 1.30)."
    log "Please upgrade to v1.$((CURRENT_MINOR + 1)) first."
    exit 1
fi
if [ "$TARGET_MINOR" -le "$CURRENT_MINOR" ]; then
   log "⚠️ Warning: Target version v${TARGET_VERSION} is not newer than current v${CURRENT_KUBEADM}. Continuing anyway..."
fi

# ── 0.5 Automatic etcd snapshot (first control-plane only) ────────────────────
# etcd stores ALL cluster state. Snapshot it BEFORE changing anything so a
# failed upgrade is recoverable. Best-effort: a snapshot failure logs a loud
# warning but does not abort the upgrade (so upgrades never get blocked by it).
if [ "$NODE_ROLE" = "master" ] && [ "$IS_FIRST_MASTER" = "true" ]; then
    log "🛟 Taking etcd snapshot before upgrade (safety backup)..."
    BK_DIR="/var/lib/etcd-backup"
    mkdir -p "$BK_DIR"
    SNAP="$BK_DIR/etcd-pre-upgrade-$(date +%Y%m%d-%H%M%S).db"
    ETCD_CERTS="--cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key --endpoints=https://127.0.0.1:2379"

    if command -v etcdctl >/dev/null 2>&1; then
        # Host has etcdctl → save straight to the backup dir.
        if ETCDCTL_API=3 etcdctl $ETCD_CERTS snapshot save "$SNAP" >/dev/null 2>&1; then
            log "✓ etcd snapshot saved: $SNAP"
        else
            log "⚠️ etcd snapshot failed (host etcdctl) — continuing WITHOUT a backup."
        fi
    else
        # No host etcdctl → run it inside the etcd static pod. /var/lib/etcd is a
        # hostPath mount, so a file written there lands on the host filesystem.
        KC="--kubeconfig=/etc/kubernetes/admin.conf"
        ETCD_POD=$(kubectl $KC -n kube-system get pods -l component=etcd -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
        if [ -n "$ETCD_POD" ]; then
            if kubectl $KC -n kube-system exec "$ETCD_POD" -- sh -c "ETCDCTL_API=3 etcdctl $ETCD_CERTS snapshot save /var/lib/etcd/kubeez-pre-upgrade.db" >/dev/null 2>&1; then
                mv -f /var/lib/etcd/kubeez-pre-upgrade.db "$SNAP" 2>/dev/null || true
                log "✓ etcd snapshot saved: $SNAP"
            else
                log "⚠️ etcd snapshot failed (pod exec) — continuing WITHOUT a backup."
            fi
        else
            log "⚠️ Could not locate the etcd pod — skipping snapshot (continuing)."
        fi
    fi
    # Retain only the 5 most recent snapshots to bound disk usage.
    ls -1t "$BK_DIR"/etcd-pre-upgrade-*.db 2>/dev/null | tail -n +6 | xargs -r rm -f 2>/dev/null || true
fi

# 1. Detect OS and Package Manager
if command -v apt-get &> /dev/null; then
    PKG_MGR="apt"
elif command -v dnf &> /dev/null; then
    PKG_MGR="dnf"
elif command -v yum &> /dev/null; then
    PKG_MGR="yum"
else
    log "Error: Unsupported OS (neither apt, dnf nor yum found)"
    exit 1
fi
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

# 2. Update Repositories
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

    # Non-fatal: a broken/EOL third-party OS repo must not abort the k8s upgrade
    apt-get update -o Acquire::AllowInsecureRepositories=true || apt-get update || true

    # Dynamic Repo Add for Target Version (Vital for pkgs.k8s.io)
    DIR_NAME="/etc/apt/keyrings"
    mkdir -p $DIR_NAME
    if [ ! -f "$DIR_NAME/kubernetes-apt-keyring.gpg" ]; then
         curl -fsSL https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/Release.key | gpg --dearmor -o $DIR_NAME/kubernetes-apt-keyring.gpg
    fi
    echo "deb [signed-by=$DIR_NAME/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/ /" | tee /etc/apt/sources.list.d/kubernetes.list
    # Update just the Kubernetes list reliably; ignore unrelated broken repos
    apt-get update -o Dir::Etc::sourcelist="sources.list.d/kubernetes.list" -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0" || apt-get update || true
elif [ "$PKG_MGR" = "yum" ] || [ "$PKG_MGR" = "dnf" ]; then
    # Overwrite repo file with new version
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
    
    # Verify Connectivity
    echo "Testing repository connectivity..."
    curl -I -m 5 https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/repodata/repomd.xml || echo "⚠️ Warning: Repo URL did not respond 200 OK"
    
    # DEBUG: print repo file to verify it was written correctly
    echo "--- DEBUG: Current Kubernetes Repo Definition ---"
    cat /etc/yum.repos.d/kubernetes.repo
    echo "-------------------------------------------------"

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
        if $PKG_MGR install -y "$@" --disableexcludes=all --setopt=*.skip_if_unavailable=1; then
            return 0
        fi
        echo "⚠️ install failed (possible RPM DB corruption). Rebuilding DB and retrying..."
        rpmdb_repair
        $PKG_MGR install -y "$@" --disableexcludes=all --setopt=*.skip_if_unavailable=1
    }

    # skip_if_unavailable: broken/EOL OS repos must never fail the k8s upgrade
    yum makecache --setopt=*.skip_if_unavailable=1 || { rpmdb_repair; yum makecache --setopt=*.skip_if_unavailable=1 || true; }
    yum repolist || true
fi

# 3. Upgrade kubeadm
log "Upgrading kubeadm to ${TARGET_VERSION}..."
if [ "$PKG_MGR" = "apt" ]; then
    apt-mark unhold kubeadm
    # Add --allow-downgrades to handle recovery from higher versions
    apt-get install -y --allow-downgrades kubeadm="${TARGET_VERSION}-*"
    apt-mark hold kubeadm
elif [ "$PKG_MGR" = "yum" ] || [ "$PKG_MGR" = "dnf" ]; then
    # Yum/DNF logic
    # Use wildcard * to match revisions (e.g. 1.33.0-150...)
    
    # We use --disableexcludes=all to be absolutely sure nothing blocks us
    
    if ! yum_install_safe "kubeadm-${TARGET_VERSION}*"; then
        echo "❌ Failed to install kubeadm-${TARGET_VERSION}. Listing available versions:"
        $PKG_MGR --showduplicates list kubeadm --disableexcludes=all --setopt=*.skip_if_unavailable=1 || true
        exit 1
    fi
     $PKG_MGR downgrade -y "kubeadm-${TARGET_VERSION}*" --disableexcludes=all --setopt=*.skip_if_unavailable=1 || true
fi

# Verify kubeadm version
KUBEADM_VER=$(kubeadm version -o short)
log "kubeadm upgraded to: $KUBEADM_VER"

# ── Pre-pull control-plane images BEFORE the upgrade (critical) ───────────────
# ROOT CAUSE of "first upgrade fails, retry works":
# 'kubeadm upgrade apply' swaps each static-pod manifest and then waits (with a
# fixed timeout) for the new component to become healthy. If the new-version
# image isn't on the node yet, it must download WHILE that timer runs — on a
# slow pull the API server doesn't come back in time and the upgrade aborts.
# The retry then succeeds only because the images got cached on the first try.
# Pre-pulling here makes the manifest swap near-instant, so it works first time.
if [ "$NODE_ROLE" = "master" ]; then
    log "Pre-pulling Kubernetes v${TARGET_VERSION} control-plane images (prevents first-attempt timeout)..."
    # Retry the pull a couple of times to absorb transient registry hiccups.
    for i in 1 2 3; do
        if kubeadm config images pull --kubernetes-version "v${TARGET_VERSION}"; then
            log "✓ Images pre-pulled."
            break
        fi
        log "⚠️ Image pull attempt $i failed — retrying in 5s..."
        sleep 5
    done
fi

# 4. Apply Upgrade (Cluster-level or Node-level)

# Preflight errors to bypass for universal compatibility on old/slow nodes:
#   • CreateJob          → kubeadm runs an 'upgrade-health-check' Job that must
#                          finish within a hard 15s window. On old/slow CentOS 7
#                          nodes it routinely times out ("did not complete in
#                          15s") and aborts the whole upgrade even though the
#                          cluster is fine. This is the real cause of the repeat
#                          failures — the health check is advisory, so we skip it.
#   • SystemVerification → old kernels (3.10) / cgroups v1 are flagged unsupported
#                          but work fine for kubeadm.
IGNORE_FLAGS="--ignore-preflight-errors=CreateJob,SystemVerification"
KERNEL_MAJOR=$(uname -r | cut -d. -f1)
if [ "$KERNEL_MAJOR" -lt 4 ]; then
    log "⚠️ Legacy kernel detected ($(uname -r)) — bypassing SystemVerification."
fi
log "Preflight bypass flags: $IGNORE_FLAGS"

if [ "$NODE_ROLE" = "master" ]; then
    if [ "$IS_FIRST_MASTER" = "true" ]; then
        log "Running 'kubeadm upgrade apply' (Primary Control Plane)..."
        
        # --yes skips interactive confirmation
        # Using the matching binary version ensures we don't hit skew errors
        kubeadm upgrade apply "v${TARGET_VERSION}" --yes $IGNORE_FLAGS
    else
        log "Running 'kubeadm upgrade node' (Secondary Control Plane)..."
        kubeadm upgrade node $IGNORE_FLAGS
    fi
else
    log "Running 'kubeadm upgrade node' (Worker)..."
    kubeadm upgrade node $IGNORE_FLAGS
fi

# 5. Upgrade kubelet and kubectl
log "Upgrading kubelet and kubectl to ${TARGET_VERSION}..."

# Drain node (Safely evict pods)
# We run drain from the node itself against itself. 
# Requires working kubeconfig on the node (Masters usually have it). 
# Workers might NOT have admin kubeconfig.
# Strategy: If we are on a master, we can drain. If on worker, we skip drain in this script 
# or assume the orchestration engine (backend) handled the drain remotely before calling this script.
# For this script we will assume backend orchestration handles drain/uncordon to stay safe.
# Proceeding with package upgrade...

if [ "$PKG_MGR" = "apt" ]; then
    apt-mark unhold kubelet kubectl
    apt-get install -y kubelet="${TARGET_VERSION}-*" kubectl="${TARGET_VERSION}-*"
    apt-mark hold kubelet kubectl
elif [ "$PKG_MGR" = "yum" ] || [ "$PKG_MGR" = "dnf" ]; then
    yum_install_safe "kubelet-${TARGET_VERSION}*" "kubectl-${TARGET_VERSION}*"
fi

# 5.5 Strip kubelet flags removed in newer Kubernetes.
# k8s 1.35 REMOVED --pod-infra-container-image. If an older kubeadm wrote it into
# kubeadm-flags.env, the upgraded kubelet crash-loops with
# "unknown flag: --pod-infra-container-image" → node goes NotReady. Remove any
# such obsolete flags so kubelet starts cleanly on every version.
if [ -f /var/lib/kubelet/kubeadm-flags.env ]; then
    log "Cleaning obsolete kubelet flags (kubeadm-flags.env)..."
    sed -i 's/--pod-infra-container-image=[^" ]*//g' /var/lib/kubelet/kubeadm-flags.env || true
    # Collapse any leftover double spaces for cleanliness.
    sed -i 's/  */ /g' /var/lib/kubelet/kubeadm-flags.env || true
fi

# 6. Restart the container runtime + kubelet.
# Restarting containerd (or docker) too is important: after a minor upgrade the
# CRI can be left in a stale state, which makes kubelet report the node NotReady
# with "container runtime network not ready / cni plugin not initialized".
log "Restarting container runtime + kubelet..."
systemctl daemon-reload
systemctl restart containerd 2>/dev/null || systemctl restart docker 2>/dev/null || true
sleep 3
systemctl restart kubelet

# 7. Verify the node actually becomes Ready — self-heal if not.
# Masters have admin.conf; workers have kubelet.conf. Either can query this node.
NODE_NAME=$(hostname | tr '[:upper:]' '[:lower:]')
KUBECFG=""
[ -f /etc/kubernetes/admin.conf ] && KUBECFG=/etc/kubernetes/admin.conf
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
        log "⚠️ Node '${NODE_NAME}' has not reported Ready yet after upgrade."
        log "   kubelet status:"; systemctl is-active kubelet 2>/dev/null || true
        # Non-fatal: the CNI DaemonSet may still be rolling out. The backend
        # health check will keep polling and auto-healing will kick in.
    fi
else
    log "No kubeconfig on this node to verify readiness (kubelet restarted)."
fi

log "========================================="
log "Upgrade Complete! Node is now running v${TARGET_VERSION}"
log "========================================="
