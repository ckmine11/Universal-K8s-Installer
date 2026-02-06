# Passwordless Sudo Setup for KubeEZ

## Problem

When connecting to Ubuntu/Debian VMs using a **non-root user**, KubeEZ automation scripts fail with:

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

This happens because KubeEZ executes all automation scripts with `sudo`, but your SSH user doesn't have passwordless sudo configured.

## Solution

You have **two options**:

### Option 1: Use Root User (Simplest)

Connect to your VMs using the `root` user directly:
- **Username**: `root`
- **Password**: Your root password or SSH key

This bypasses the sudo requirement entirely.

### Option 2: Configure Passwordless Sudo (Recommended for Security)

If you prefer to use a non-root user (e.g., `ubuntu`, `admin`, etc.), you need to configure passwordless sudo.

#### Automatic Setup (Easiest)

1. **SSH into each VM** as your non-root user:
   ```bash
   ssh your-user@192.168.220.90
   ```

2. **Download and run the setup script**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/your-repo/kubeez/main/backend/src/automation/setup-passwordless-sudo.sh | bash
   ```

   Or if you have the KubeEZ repository cloned:
   ```bash
   bash backend/src/automation/setup-passwordless-sudo.sh
   ```

3. **Enter your sudo password** when prompted (this will be the ONLY time).

4. **Verify** by running:
   ```bash
   sudo whoami
   ```
   It should print `root` without asking for a password.

5. **Repeat** for all VMs (master and worker nodes).

#### Manual Setup

If you prefer to configure it manually:

1. **SSH into the VM** as your user.

2. **Edit the sudoers file**:
   ```bash
   sudo visudo -f /etc/sudoers.d/kubeez-$(whoami)
   ```

3. **Add this line** (replace `your-username` with your actual username):
   ```
   your-username ALL=(ALL) NOPASSWD:ALL
   ```

4. **Save and exit** (Ctrl+X, then Y, then Enter in nano).

5. **Verify**:
   ```bash
   sudo whoami
   ```

6. **Repeat** for all VMs.

## Verification

After setup, test that passwordless sudo works:

```bash
# Should return 'root' without asking for password
sudo whoami

# Should succeed without password prompt
sudo ls /root
```

## Security Note

Passwordless sudo allows the user to execute any command as root without authentication. This is required for automation but should only be configured on:
- Dedicated Kubernetes nodes
- VMs that are not exposed to untrusted users
- Environments where you trust the SSH access controls

For production environments, consider:
- Using SSH key-based authentication (no passwords)
- Restricting sudo to specific commands if possible
- Implementing proper firewall rules and network segmentation

## Troubleshooting

### "sudo: /etc/sudoers.d/kubeez-user is world writable"

The sudoers file has incorrect permissions. Fix with:
```bash
sudo chmod 0440 /etc/sudoers.d/kubeez-$(whoami)
```

### Still asking for password

1. Check if the file exists:
   ```bash
   ls -la /etc/sudoers.d/
   ```

2. Verify the content:
   ```bash
   sudo cat /etc/sudoers.d/kubeez-$(whoami)
   ```

3. Check for syntax errors:
   ```bash
   sudo visudo -c
   ```

### Permission denied

Make sure you're running the setup script with your regular user (not root), and that you have sudo access with a password initially.
