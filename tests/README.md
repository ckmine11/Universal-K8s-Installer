# KubeEZ tests

Three layers, all run by GitHub Actions (`.github/workflows/ci.yml`) on every
push to `master`, every pull request, and nightly (to catch upstream
Kubernetes / containerd / distro changes).

| Layer | What it proves | Run locally | Time |
|---|---|---|---|
| **Backend** — `backend/tests/*.test.js` | Tenant isolation, RBAC, auth, agents, upgrade failure reasons, progress bar, config backups | `cd backend && npm install && npm test` | ~10 s |
| **Upgrade scenarios** — `tests/upgrade-script/` | `upgrade-cluster.sh` stops with the right reason for every known failure (stubbed kubeadm/apt/…) | `bash tests/upgrade-script/scenarios.sh` | ~3 min |
| **End-to-end** — `tests/e2e/` | The real install scripts build a working cluster on each distro; real upgrades 1.35 → 1.36 → 1.37 on a mixed-OS cluster; encrypted offsite backups to a real MinIO | see below | 6–25 min |

Requirements: Node 18+ for the backend tests; Docker for the other two
(Linux host with cgroups v2, or Docker Desktop on Windows/macOS — in Git Bash
on Windows the scripts handle path conversion themselves).

## End-to-end

```bash
# fresh single-node cluster (default Kubernetes 1.35.0)
bash tests/e2e/e2e.sh install ubuntu2204
bash tests/e2e/e2e.sh install rocky9 1.37.0

# Ubuntu control-plane + Rocky and Debian workers, then 1.35 → 1.36 → 1.37
bash tests/e2e/e2e.sh upgrade ubuntu2204 rocky9 debian12

# offsite etcd backups: real MinIO + real node (needs `npm install` in backend/)
bash tests/e2e/e2e.sh offsite ubuntu2204

KEEP=1 bash tests/e2e/e2e.sh install debian12   # keep the container to debug
bash tests/e2e/e2e.sh clean                     # remove all e2e containers
```

Distros: `ubuntu2204 ubuntu2404 debian12 rocky9 alma9 fedora amzn2023`.

Each node is a privileged systemd container (the technique `kind` uses), so
kubeadm, containerd, kubelet and flannel really run. Differences from a real
VM, all deliberate and confined to the test harness:

- kube-proxy's conntrack sizing is disabled (`maxPerCore: 0`), as in `kind` —
  a container may not write `nf_conntrack_max`.
- The kernel is the host's, so kernel-version and module checks see the host.
- Not covered: active firewalld/ufw, HA control planes, add-ons, ARM.

The scripts run `swapoff -a` like on a real node; on Docker Desktop that turns
off the Docker VM's swap until Docker restarts.
