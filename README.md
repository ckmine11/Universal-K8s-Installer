# 🚀 KubeEZ - Intelligent Kubernetes Automation Suite

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-2.1.0-green.svg)
![Status](https://img.shields.io/badge/status-Production%20Ready-success.svg)
![Feature](https://img.shields.io/badge/feature-Self--Healing-purple.svg)

**The ultimate "No-Ops" platform to provision, scale, and manage production-grade Kubernetes clusters.** 
KubeEZ doesn't just install Kubernetes; it **diagnoses, fixes, and ensures success** using an integrated AI-driven recovery engine. It works natively on bare-metal servers, VMs (Oracle/AWS/Azure), or even local simulations.

---

## 📖 Table of Contents
- [Overview](#-overview)
- [🔥 New: Intelligent Recovery](#-new-intelligent-recovery)
- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [Getting Started](#-getting-started)
- [Simulation Mode](#-simulation-mode)
- [Security](#-security)
- [Project Structure](#-project-structure)

---

## 🌟 Overview

Setting up Kubernetes "the hard way" is painful. KubeEZ automates 100% of it. Whether you have fresh Ubuntu servers or old CentOS boxes, KubeEZ connects via SSH, prepares the environment, and builds a High-Availability Cluster in minutes.

**What makes KubeEZ unique?**
If an installation fails (e.g., DNS issues, Package locks, Swap memory), KubeEZ **automatically detects the error, fixes it on the node, and retries**, guaranteeing a successful deployment.

---

## 🔥 New: Intelligent Recovery system

KubeEZ v2.1 introduces a groundbreaking **Self-Healing Engine** inside the installer.

### 🧠 Smart Diagnostics
The engine analyzes error logs in real-time to identify root causes:
- **DNS Failures**: Detects `Could not resolve host` or network unreachability.
- **Package Blocks**: Detects `dpkg` or `apt` locks held by background updates.
- **Configuration Drifts**: Detects enabled Swap memory or port conflicts.

### 🛠️ Auto-Fix Actions
Once diagnosed, KubeEZ can automatically execute surgical fixes:
- **`fix_dns_resolv`**: Patches `/etc/resolv.conf` with Google Public DNS (`8.8.8.8`) to restore internet access.
- **`fix_dpkg_lock`**: Safely kills stuck `apt` processes and repairs the package database.
- **`fix_swap_off`**: Disables swap and modifies `/etc/fstab` to persist changes.
- **`fix_kube_reset`**: Cleans up partial installations to ensure a fresh retry.

---

## 💎 Key Features

### 🛡️ Production-Grade Engineering
### 🛡️ Production-Grade Engineering
- **Universal OS Support**: 
    - **Debian Family**: Ubuntu (20.04+), Debian (10/11/12).
    - **RHEL Family**: CentOS 7/8/Stream, RHEL 8/9, Fedora, AlmaLinux, Oracle Linux, Amazon Linux 2/2023.
- **Legacy Kernel Adapter**: Built-in compatibility layer that allows modern Kubernetes to run on legacy kernels (e.g., CentOS 7's 3.10) by intelligently bypassing specific preflight checks using `--ignore-preflight-errors=SystemVerification`.
- **System Hardening**: Auto-configures Firewall (`ufw`/`firewalld`), Kernel Modules (`overlay`, `br_netfilter`), and Sysctl params.
- **HA Ready**: Automatic Certificate Key generation for Multi-Master Control Planes.

### 🔭 Futuristic Observability
- **Orbital Universal Terminal**: "God-mode" SSH multiplexing allowing broadcast commands to all nodes simultaneously via a glass-morphism web UI.
- **3D Digital Twin**: Real-time 3D particle visualization of network traffic and cluster topology.
- **Live Node Monitoring**: Real-time CPU, RAM, and Disk usage via SSH/Kubectl.
- **Glassmorphism UI**: Beautiful, dark-mode accessible interface.
- **Robust Downloads**: Securely download `kubeconfig` even if SSH users are non-root.

### 🧪 Simulation Mode
Don't have servers yet?
- **Mock Engine**: Auto-generates mock Kubeconfig and Health Stats.
- **UI Testing**: Validates the entire dashboard flow without real infrastructure.
- **Safe Fallback**: If real nodes disconnect, the UI degrades gracefully instead of crashing.

---

## 🏗️ System Architecture

```mermaid
graph TD
    User[Admin User] -->|HTTPS| FE[React Frontend]
    FE -->|REST/WS| BE[Node.js Backend]
    
    subgraph "KubeEZ Engine"
        BE
        Auto[Automation Engine]
        Healer[Self-Healing Module]
        Store[Persistent Data]
    end
    
    BE -->|SSH (Port 22)| Master[Master Node]
    BE -->|SSH (Port 22)| Worker[Worker Node]
    
    Healer -->|Fix Commands| Master
    Healer -->|Fix Commands| Worker
```

The Backend acts as an **Orchestrator**. It pushes verified idempotent Bash scripts to target nodes. If a script fails (exit code != 0), the **Self-Healing Module** intercepts the stderr, calculates a fix strategy, executes it, and auto-retries the step.

---

## 🚀 Getting Started

### Prerequisites
- **Docker** and **Docker Compose**.
- Target Linux Servers (or use Simulation Mode).

### Quick Start
1.  **Clone**:
    ```bash
    git clone https://github.com/ckmine11/Universal-K8s-Installer.git
    cd Universal-K8s-Installer
    ```

2.  **Run**:
    ```bash
    docker-compose up -d --build
    ```

3.  **Access**:
    Open `http://localhost:5173`.
    - Create your Admin Account.
    - Start a New Cluster!

---

## 🔐 Security

- **JWT Authentication**: All API endpoints (including Recovery actions and Downloads) are secured.
- **SSH Key Handling**: Supports direct key content (no file dependency).
- **Persistent Sessions**: Cluster state is saved to disk, surviving container restarts.

---

## 📂 Project Structure

```
kubeez/
├── backend/
│   ├── src/
│   │   ├── automation/       # Shell Scripts (Install, Join, Reset)
│   │   ├── services/
│   │   │   ├── automationEngine.js  # The Brain (SSH + Error Analysis)
│   │   │   ├── installationManager.js # State Machine
│   │   └── routes/           # Secure API
│   └── data/                 # Persistent volumes (clusters.json)
├── frontend/
│   ├── src/
│   │   ├── pages/            # InstallationDashboard (Live UI)
│   │   └── components/       # UI Widgets
│   └── Dockerfile
└── docker-compose.yml
```

---

**Built with ❤️ for the Kubernetes Community.**
