# Root and sudo on cluster servers

*Version 2.3.0 · November 2026.* KubeEZ installs and runs Kubernetes on your servers as root. This page explains how it gets root, and what to do when it cannot.

---

## 1. What KubeEZ needs

Every automation script (install, join, upgrade, backups, add-ons) runs with root rights on the node. You can give KubeEZ either:

| Login | What happens |
|---|---|
| **root** (password or SSH key) | Nothing else to set up. |
| **A normal user with a password** | KubeEZ sets up **passwordless sudo** for that user by itself on the first connection (see below). |
| **A normal user with an SSH key** (no password) | KubeEZ cannot set it up — do it once by hand (section 3), or connect as root. |

The same applies to every server of a cluster, and to SSH added later to an imported on-prem cluster.

---

## 2. What KubeEZ does automatically

When it connects as a user other than `root`, KubeEZ:

1. checks `sudo -n true` — if it works, nothing changes;
2. otherwise uses the password you entered once to write `/etc/sudoers.d/kubeez-<user>` with `<user> ALL=(ALL) NOPASSWD:ALL` and mode `0440`;
3. checks `sudo -n true` again.

The password is piped to `sudo -S` for that one command and not stored on the node. User names are checked (letters, digits, `.`, `_`, `-`) before they go into the sudoers file.

---

## 3. Doing it by hand

On each server, as the user KubeEZ will use (you type the sudo password once):

```bash
echo "$(whoami) ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/kubeez-$(whoami)
sudo chmod 0440 /etc/sudoers.d/kubeez-$(whoami)
sudo visudo -c        # must say the files are parsed OK
```

Or copy and run the helper from this repository, which does the same with checks:

```bash
scp backend/src/automation/setup-passwordless-sudo.sh <user>@<server>:/tmp/
ssh <user>@<server> 'bash /tmp/setup-passwordless-sudo.sh'
```

### Check it

```bash
ssh <user>@<server> 'sudo -n true && sudo -n whoami'    # prints: root — with no password prompt
```

---

## 4. Problems

| You see | Fix |
|---|---|
| `sudo: a terminal is required to read the password` or `a password is required` | Passwordless sudo is not set up: section 3, or connect as root. |
| "needs sudo without a password, and KubeEZ has no password to set that up (SSH key login)" | You used an SSH key for a normal user — run the command from the message once on that server. |
| "Cannot configure passwordless sudo for user …" | The password is wrong, or the user is not allowed to use sudo at all. Add the user to the `sudo` group (Ubuntu / Debian) or `wheel` (RHEL family) as root, then retry. |
| `/etc/sudoers.d/kubeez-… is world writable` | `sudo chmod 0440 /etc/sudoers.d/kubeez-<user>` |
| Still asks for a password | A later rule in `/etc/sudoers` overrides it — check with `sudo -l`; files in `/etc/sudoers.d` with a `.` or `~` in the name are ignored. |

---

## 5. Security note

Passwordless sudo means anyone who can sign in as that user is root on the server. That is the same power KubeEZ needs to run Kubernetes. Keep it to the one user KubeEZ uses, protect that login (SSH keys, no shared passwords), and remove the file when the server leaves KubeEZ:

```bash
sudo rm /etc/sudoers.d/kubeez-<user>
```
