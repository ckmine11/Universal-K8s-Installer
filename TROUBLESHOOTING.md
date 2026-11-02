# KubeEZ Troubleshooting

*Version 2.3.0 · November 2026.* When something fails, KubeEZ shows the reason and a fix on screen, and the job log has the details. This page collects the common cases and where to look. The console's own version is under **Help → Docs → Troubleshooting**.

---

## 1. Where to look first

| What | Where |
|---|---|
| A failed install, upgrade, restore or add-on job | The job's live log in the console — the last lines say why, often with a **FIX** line |
| The KubeEZ server | `docker compose logs -f backend` (add `-f docker-compose.prod.yml` in production) |
| Is the server up? | `GET /api/health` → `{"status":"healthy",…}` |
| What happened, by whom | **Compliance → Audit trail** |
| A cluster's own state | The cluster's **Explorer**, or `kubectl` with the downloaded kubeconfig |

---

## 2. The KubeEZ server

| Symptom | Cause | Fix |
|---|---|---|
| Backend restarts in a loop; log says `APP_SECRET is the shipped placeholder or shorter than 32 characters` | Production refuses a weak secret | Set `APP_SECRET=$(openssl rand -hex 32)` in `.env`, then `up -d backend`. |
| `Bind for 0.0.0.0:80 failed` / `port is already allocated` | Another program uses the port | Stop it, or change the left side of `ports:` in the compose file; on a shared server see [MULTI_SITE_SETUP.md](MULTI_SITE_SETUP.md). |
| Console shows "Bad gateway" or a Cloudflare error page | The backend is down or still starting | `docker compose ps` (wait for `healthy`, up to ~40 s) and the backend log. |
| Sign-in works, then you are signed out at once | Browser blocks the cookie, or the site is opened over plain HTTP in production | Use the https address in `KUBEEZ_PUBLIC_URL`; add other addresses to `ALLOWED_ORIGINS`. |
| A setting in `.env` has no effect | The compose file passes only the variables it lists | Check the name in `docker-compose.prod.yml`, then `up -d backend`. |
| Stored passwords "cannot be decrypted" after a move | `APP_SECRET` (or `data/master.key`) changed | Restore the old secret / key file — data encrypted with it cannot be read otherwise. |
| No password-reset emails | Email not set up | Set `SMTP_*` (Gmail needs an App Password); meanwhile an admin resets passwords under Team & Roles, or `node scripts/reset-password.js <user> <password>` in the backend container. |

---

## 3. Reaching servers

| You see | Fix |
|---|---|
| **SSH Connection Refused on `<ip>:22`** | The server has no SSH service (the message shows the exact line). Ubuntu / Debian: `sudo apt-get update && sudo apt-get install -y openssh-server && sudo systemctl enable --now ssh && { command -v ufw >/dev/null && sudo ufw allow ssh \|\| true; }` · Rocky / Alma / RHEL / Fedora: `sudo dnf install -y openssh-server && sudo systemctl enable --now sshd && { command -v firewall-cmd >/dev/null && sudo firewall-cmd --permanent --add-service=ssh && sudo firewall-cmd --reload \|\| true; }` |
| **SSH Handshake Timeout** | Wrong IP, or a firewall drops port 22 — check the IP and the cloud security group / host firewall. |
| Authentication failed | Wrong user, password or key; with a key, paste the **private** key (or import the `.pem` file). |
| `sudo: a password is required` / "Cannot configure passwordless sudo" | See [SUDO_SETUP.md](SUDO_SETUP.md), or connect as root. |
| Hosted KubeEZ refuses a private address (10.x, 192.168.x…) | Expected: private servers are reached through a **Gateway Agent** in their network. |
| Gateway Agent **offline** | The machine is off or offline. On Linux: `sudo systemctl status kubeez-agent` and `journalctl -u kubeez-agent -f`. Run the install command again from Gateway Agents (safe to repeat). |

---

## 4. Installing a cluster

| You see | Meaning | Fix |
|---|---|---|
| Pre-flight check fails (CPU, memory, OS, ports) | The server does not meet the requirements | Fix what the check lists — see [REAL_INSTALLATION_GUIDE.md](REAL_INSTALLATION_GUIDE.md). |
| **Package Manager Locked** | Another apt / dpkg process runs (often unattended upgrades) | KubeEZ clears stale locks and retries; if it repeats, wait for the update to finish. |
| **DNS/Internet Failure** · **IPv6 Network Unreachable** | The server cannot download packages or images | Check DNS (`/etc/resolv.conf`), outbound HTTPS, a proxy; disable broken IPv6 routes. |
| **CentOS 7 EOL Repository Failure** | CentOS 7 mirrors are gone | KubeEZ switches to the vault mirrors; CentOS 7 works only up to Kubernetes 1.34. |
| **Swap Memory Enabled** | Kubernetes needs swap off | KubeEZ turns it off; if it comes back after reboot, remove the swap line from `/etc/fstab`. |
| **VIP_IN_USE** — "The virtual IP … already answers on the network" | The HA virtual IP is taken | Pick an unused IP outside the DHCP range. |
| **VIP_IS_NODE** / **VIP_NO_INTERFACE** | The virtual IP is a node's own IP, or not in the control-planes' network | Use a free IP in the same subnet as the control-planes. |
| HA works on your LAN but not in a cloud | Clouds block the ARP the virtual IP relies on | Use one control-plane in the cloud. |
| Install stopped midway (network drop, reboot, KubeEZ restart) | — | **Resume installation** on the cluster page; finished steps are skipped. |
| Worker does not join | Nodes cannot reach each other | Open all traffic between the cluster's nodes (at least 6443, 10250, 2379–2380, the CNI ports — Flannel UDP 8472, Calico TCP 179), then **Resume**. |

---

## 5. Upgrades, backups and restores

| You see | Fix |
|---|---|
| "Safety check found blockers" | Open the report: removed APIs still in use, version skew, disruption budgets that block draining. Fix the listed resources, then retry. |
| Upgrade failed | Usually the cluster still runs the old version — **Retry upgrade**. Otherwise restore the automatic **Before upgrade** snapshot. |
| **INVALID_UPGRADE_PATH** | Kubernetes upgrades go one minor version at a time — upgrade step by step. |
| Restore: "The snapshot is damaged" | Nothing was changed; pick another snapshot or its offsite copy. |
| Recovery: "does not have the IP …" | The new server must use the lost control-plane's IP. |
| Offsite test fails | Endpoint = the address only (no bucket), the bucket exists, keys are right, the region matches. |
| `AccessDenied` on port 30833 | Normal: that is the S3 API; the SeaweedFS web UI is on 30834. |

---

## 6. Add-ons and Explorer

| You see | Fix |
|---|---|
| Add-on **Failing** or **Starting** for long | Add-ons → **Manage & logs → Logs**: image pull errors, a pending volume (no StorageClass), a crash. Fix, then **Repair**. |
| A settings change was rolled back | The new settings did not become healthy — the history shows why; change them and try again. |
| Explorer does not open | Install it from the cluster's Explorer tab; behind a Gateway Agent, reinstall the agent with the same command; a proxy in front of KubeEZ must pass WebSockets. |
| Terminal disconnects at once | Same as above: WebSocket `Upgrade` headers must reach KubeEZ. |

---

## 7. Apps, delivery and GitOps

| You see | Meaning / fix |
|---|---|
| **423** Change freeze | A freeze covers the cluster. Wait, or an admin overrides with a reason. |
| **428** Needs approval | The action is protected (or the environment is). A second person approves on **Approvals**; then it runs. |
| **402** "part of the Pro plan" | The workspace plan lacks the feature — Plans page (self-hosted: a license, see [LICENSING_GUIDE.md](LICENSING_GUIDE.md)). |
| **403** "… is turned off" | An admin turned the feature off (Features), or the server's `KUBEEZ_FEATURES` did. |
| "Helm is not installed on the control-plane yet" | Install any add-on once (it installs Helm), then retry. |
| Deploy "Blocked by the CVE policy" | Fix the image, or an admin deploys anyway with a reason. |
| Deploy "Blocked by the image signature policy" | Sign the image with `cosign sign --key`, add `cosign.pub` under Delivery → Signing keys; private registries need a login under Registries. With no keys at all, every image fails. |
| CI webhook **401** / **403** | 401: the token is unknown, expired or revoked. 403: it may not set that value, the environment is protected, or it was not made for previews. |
| Chat: "This chat may not deploy anything" | An admin allows apps under Delivery → **Deploy from chat**, and ChatOps is on for the channel (AI settings). |
| Promotion PR: "GitHub / GitLab / Bitbucket said 401 / 403" | The token lacks access to the repository (scopes: GitHub Contents + Pull requests; GitLab `api`; Bitbucket repository + pull requests write). |
| "already has these values — nothing to promote" | The file already has the values; nothing to do. |
| Drift: "not checked" | `helm get manifest` failed for that release, or the control-plane has no `diff` program. |
| GitOps "Argo CD / Flux is not installed" | Install the add-on first. |

---

## 8. Still stuck?

Collect the error message, the last 50 lines of the job log and `docker compose logs --tail 200 backend`, and send them to your KubeEZ support contact (or open a GitHub issue without any secrets in it).
