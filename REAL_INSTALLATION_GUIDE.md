# Your First Real Cluster — Preparing Servers

*Version 2.3.0 · November 2026.* How to get servers ready (local VMs, cloud VMs or your own hardware) and install a real Kubernetes cluster on them with KubeEZ, end to end.

---

## 1. What you need

| | Minimum | Better |
|---|---|---|
| Servers | 1 (control-plane that also runs apps) | 1 control-plane + 2 workers, or 3 control-planes for high availability |
| Control-plane | 2 vCPU, 4 GB RAM, 20 GB disk | 4 vCPU, 8 GB RAM |
| Worker | 2 vCPU, 2 GB RAM, 20 GB disk | sized for your apps and add-ons |
| OS | Ubuntu 22.04 / 24.04, Debian 12, Rocky 9, Alma 9, Fedora, Amazon Linux 2023, RHEL 8 / 9 | the same OS on every server |
| Login | root, or a sudo user (see [SUDO_SETUP.md](SUDO_SETUP.md)), over SSH | SSH keys |
| Network | servers reach each other; outbound HTTPS for images | a fixed IP per server |

KubeEZ prepares the rest itself: firewall ports, kernel modules and settings, swap off, containerd, kubeadm and the network plugin.

---

## 2. Where to get servers

### A. Local virtual machines (free, for learning)

**VirtualBox, VMware or Hyper-V:** create the VMs with a **bridged** network adapter (so they get addresses on your LAN), install Ubuntu Server 22.04 with **OpenSSH server**, and note each VM's IP (`ip -4 addr`).

**Vagrant** (VirtualBox underneath) creates them in one command. `Vagrantfile`:

```ruby
Vagrant.configure("2") do |config|
  config.vm.box = "ubuntu/jammy64"
  { "cp1" => "192.168.56.10", "worker1" => "192.168.56.11", "worker2" => "192.168.56.12" }.each do |name, ip|
    config.vm.define name do |n|
      n.vm.hostname = name
      n.vm.network "private_network", ip: ip
      n.vm.provider "virtualbox" do |vb|
        vb.cpus = 2
        vb.memory = name == "cp1" ? 4096 : 2048
      end
      # allow password login for KubeEZ (lab only)
      n.vm.provision "shell", inline: "echo 'vagrant:vagrant' | chpasswd && sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; systemctl restart ssh"
    end
  end
end
```

```bash
vagrant up        # user: vagrant / password: vagrant (lab only)
```

KubeEZ must be able to reach those addresses. A host-only network (`192.168.56.x`) is usually reachable from KubeEZ running on the same machine; if not, use a bridged network or install a **Gateway Agent** on the host.

### B. Cloud virtual machines

Any cloud (AWS EC2, Azure, GCP, Oracle, DigitalOcean, Hetzner…): Ubuntu 22.04, 2 vCPU / 4 GB for the control-plane, 20 GB disk, all servers in **one private network / VPC**.

Firewall (security group) rules:

| From | To | Ports |
|---|---|---|
| KubeEZ server (or your IP) | every node | TCP 22 (SSH) |
| the cluster's own nodes | each other | **all traffic** (simplest: a rule allowing the security group itself) |
| you / your apps | control-plane | TCP 6443 (Kubernetes API, kubectl) |
| the internet | workers | TCP 30000–32767 (NodePort apps), or 80 / 443 for an ingress |

With SSH keys: paste or import the private key in the wizard (a `.pem` file works), user `ubuntu` (Ubuntu images), `ec2-user` (Amazon Linux) or `rocky` / `almalinux`.

> **High availability in the cloud:** KubeEZ's virtual IP (kube-vip) moves between control-planes with ARP, which most cloud networks do not allow. In a cloud, use one control-plane, or test HA on your own network / VMs.

### C. Your own servers

Bare metal or VMs on your LAN: same requirements. For high availability, pick a **free IP in the same network** as the control-planes, outside the DHCP range, for the virtual IP.

---

## 3. Check each server

From the machine that runs KubeEZ:

```bash
ssh <user>@<server-ip> 'cat /etc/os-release | head -2; nproc; free -g | head -2; df -h / | tail -1; sudo -n true && echo sudo-ok'
```

If SSH is refused, the server has no SSH service:

```bash
sudo apt-get update && sudo apt-get install -y openssh-server && sudo systemctl enable --now ssh
```

With a hosted KubeEZ and servers in a private network, install a **Gateway Agent** first (KubeEZ → Gateway Agents → Generate Token → run the command on any machine in that network).

---

## 4. Install the cluster

1. **Deploy cluster** in the sidebar.
2. **Servers:** add the control-plane(s) and workers — IP, SSH user, password or key. KubeEZ checks each one (connection, OS, CPU, memory, ports) and shows what to fix.
3. **Cluster:** Kubernetes version (1.27 – 1.37), network plugin (Flannel or Calico) and, with 2+ control-planes, the virtual IP.
4. **Add-ons:** Nginx Ingress and the KubeEZ Explorer are selected; add monitoring, storage, cert-manager… (**Customize** to change settings first).
5. **Review and start.** Every step streams a live log. A failure shows its reason and a fix; **Auto-Fix & Resume** or **Resume installation** continues where it stopped.

A cluster takes about 15–30 minutes, depending on the servers, their download speed and the add-ons.

---

## 5. Use it

```bash
# cluster page → Kubeconfig → save as ~/.kube/kubeez-<cluster>.yaml
export KUBECONFIG=~/.kube/kubeez-<cluster>.yaml
kubectl get nodes -o wide          # every node Ready
kubectl get pods -A                # system pods Running
kubectl create deployment hello --image=nginx --replicas=2
kubectl expose deployment hello --port=80 --type=NodePort
kubectl get svc hello              # open http://<worker-ip>:<node-port>
```

Or skip kubectl: the cluster's **Explorer** shows everything, and **Apps → Install an app** deploys Helm charts with a preview.

---

## 6. Next steps

1. **Alerts** — add a channel so auto-healing can reach you.
2. **Backups** — take a snapshot, and connect **Offsite Backup** in the cluster's Backups tab.
3. **Team** — invite people with the right roles.
4. **Upgrade** later from the cluster page — one version at a time, after a safety check and a snapshot.

When something fails, the job log says why; more in [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and the [USER_GUIDE.md](USER_GUIDE.md).
