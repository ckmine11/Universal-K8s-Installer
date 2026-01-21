# 🚀 KubeEZ - Enterprise Kubernetes Automation Suite

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-2.0.0-green.svg)
![Status](https://img.shields.io/badge/status-Production%20Ready-success.svg)

**The ultimate "No-Ops" platform to provision, scale, and manage production-grade Kubernetes clusters on bare-metal servers, VMs, or cloud instances with a single click.**

---

## 📖 Table of Contents
- [Overview](#-overview)
- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [Technology Stack](#-technology-stack)
- [Getting Started](#-getting-started)
- [Security & Authentication](#-security--authentication)
- [Detailed Workflow](#-detailed-workflow)
- [Project Structure](#-project-structure)
- [Deployment Guide](#-deployment-guide)

---

## 🌟 Overview
Setting up Kubernetes "the hard way" involves dozens of complex steps: disabling swap, configuring iptables, installing CNI plugins, generating certificates, and rigorous firewall management. **KubeEZ** automates 100% of this process. It connects to your fresh Linux servers via SSH and transforms them into a High-Availability Kubernetes Cluster in minutes.

---

## 🔥 Key Features

### 🛡️ Production-Grade Engineering
- **Multi-OS Support**: Seamlessly works on **Ubuntu (20.04/22.04/24.04)**, **CentOS 7/8/Stream**, **RHEL**, and **Rocky Linux**.
- **System Hardening**: Automatically handles:
    - Persistent Swap Disabling.
    - Kernel Module Loading (`overlay`, `br_netfilter`).
    - Sysctl Parameter Tuning (`net.bridge.bridge-nf-call-iptables`).
    - Firewall Configuration (`ufw`/`firewalld`).
- **HA Ready**: Supports Multi-Master setups with automatic Certificate Key generation and Control Plane Endpoint configuration.

### 🎨 Futuristic Dashboard
- **Real-Time Logs**: Watch the installation process live via WebSockets.
- **Glassmorphism UI**: Beautiful, dark-mode interface built with React & Tailwind CSS.
- **Wizard Flow**: Step-by-step guidance for cluster configuration.

### 🔒 Enterprise Security
- **Secure Authentication**: Built-in Admin system with **Initial Setup Mode**.
- **JWT Sessions**: Stateless, secure API access.
- **SSH Key Handling**: Supports direct key content pasting (no file path dependency for Docker environments).
- **Role-Based Access**: Secured API endpoints (`/api/clusters/*` protected).

---

## 🏗️ System Architecture

```mermaid
graph TD
    User[Admin User] -->|HTTPS| FE[React Frontend]
    FE -->|REST/WS| BE[Node.js Backend]
    
    subgraph "KubeEZ Docker Container"
        BE
        Data[(JSON Store)]
        Scripts[Bash Automation Scripts]
    end
    
    BE -->|SSH (Port 22)| Master[Master Node 1]
    BE -->|SSH (Port 22)| Worker1[Worker Node 1]
    BE -->|SSH (Port 22)| Worker2[Worker Node 2]
    
    Master -->|Kubeadm Join| HA_Master[HA Master 2]
```

The Backend acts as an **Orchestrator**. It pushes verified Bash scripts (`backend/src/automation/*.sh`) to the target nodes and executes them with `sudo`, streaming stdout/stderr back to the Frontend in real-time.

---

## 💻 Technology Stack

### **Frontend**
- **Framework**: React 18 + Vite
- **Styling**: Tailwind CSS + Custom Animations
- **Icons**: Lucide React
- **State**: Context API (Auth/Wizard)

### **Backend**
- **Runtime**: Node.js (Alpine Linux)
- **API**: Express.js
- **Communication**: WebSockets (`ws`) for live logs
- **SSH Client**: `node-ssh`
- **Security**: `bcryptjs` (Hashing), `jsonwebtoken` (Auth)

### **DevOps**
- **Containerization**: Docker & Docker Compose
- **Scripting**: Advanced Bash (Idempotent, POSIX compliant)

---

## 🚀 Getting Started

### Prerequisites
- **Docker** and **Docker Compose** installed on your machine.
- Access to **1 or more Linux Servers** (VMs, VPS, or Bare Metal) with SSH access (Root or Sudo user).

### Local Installation
1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/your-username/kubeez.git
    cd kubeez
    ```

2.  **Start the Application**:
    ```bash
    docker-compose up -d --build
    ```

3.  **Access the Dashboard**:
    Open [http://localhost](http://localhost) in your browser.

4.  **Initialize System**:
    - You will see the **INITIALIZE SYSTEM ACCESS** screen.
    - Set your **Admin Username** and **Strong Password**.
    - You are now logged in!

---

## 🔐 Security & Authentication

### The "God Mode" Protocol
KubeEZ uses a "Claim on First Run" security model:
1.  **Unclaimed State**: When deployed fresh, the system has no users.
2.  **Initialization**: The first user to access the UI gets to set the Admin credentials.
3.  **Locked State**: Once set, the `/api/auth/setup` endpoint is permanently disabled.

### Password Recovery
If you lose your admin password:
1.  SSH into the host machine running KubeEZ.
2.  Delete the user data file: `rm backend/data/users.json`.
3.  Restart the container. The system resets to "Unclaimed State".

---

## 📜 Detailed Workflow

### 1. Pre-Flight Checks
Before installing anything, KubeEZ verifies:
- OS Compatibility.
- CPU/RAM Resources (Minimum 2 CPU, 2GB RAM for Master).
- Port Availability (6443, 10250, etc.).
- Network Connectivity.

### 2. Base Installation (`install-kubernetes.sh`)
- Validates Package Managers (`apt` vs `yum`).
- Installs `socat`, `conntrack`, `ipset`.
- Configures `overlay` and networking modules.
- Sets up Kubernetes Repositories (handling CentOS 7 EOL/Mirrors).
- Installs `kubelet`, `kubeadm`, `kubectl`.

### 3. Container Runtime (`install-containerd.sh`)
- Installs `containerd`.
- Generates default config and enables `SystemdCgroup = true` (Critical for K8s stability).

### 4. Cluster Initialization (`init-control-plane.sh`)
- Runs `kubeadm init`.
- Configures `admin.conf` for the user.
- Installs CNI Plugin (Calico/Flannel/Weave).

---

## 📂 Project Structure

```
kubeez/
├── backend/
│   ├── src/
│   │   ├── automation/       # The "Brain" - Shell Scripts
│   │   │   ├── install-kubernetes.sh
│   │   │   ├── install-containerd.sh
│   │   │   ├── init-control-plane.sh
│   │   │   └── ...
│   │   ├── services/
│   │   │   ├── automationEngine.js  # SSH Orchestrator
│   │   │   └── authService.js       # Security Logic
│   │   └── server.js                # API Entry Point
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/       # Header, Cards, UI Elements
│   │   ├── context/          # Auth Context
│   │   ├── pages/            # Login, Wizard, Dashboard
│   │   └── App.jsx
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 🌍 Deployment Guide

### Recommended: VPS (Oracle/AWS/DigitalOcean)
Since KubeEZ manages long-running processes, **hosting on a VPS is recommended** over Serverless (Vercel/Render).

1.  **SSH into your VPS**.
2.  **Install Docker**: `curl -fsSL https://get.docker.com | sh`.
3.  **Clone & Run**:
    ```bash
    git clone https://github.com/your-username/kubeez.git
    cd kubeez
    sudo docker compose up -d --build
    ```
4.  **Access**: Go to `http://YOUR_VPS_IP`.

---

## 🤝 Contributing
Contributions are welcome!
1.  Fork the Project.
2.  Create your Feature Branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your Changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the Branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

---

## 📄 License
This project is licensed under the MIT License - see the LICENSE file for details.

---

**Built with ❤️ for the Kubernetes Community.**
