# 📂 KubeEZ User Guide

Welcome to the KubeEZ User Guide. This document provides a comprehensive walkthrough for using the platform to deploy and manage Kubernetes clusters.

---

## 📋 Table of Contents
1. [Introduction](#-introduction)
2. [Prerequisites](#-prerequisites)
3. [Deployment Options](#-deployment-options)
4. [Using the Installation Wizard](#-using-the-installation-wizard)
5. [Cluster Management](#-cluster-management)
6. [Installing Add-ons](#-installing-add-ons)
7. [Troubleshooting](#-troubleshooting)

---

## 🚀 Introduction
KubeEZ is designed to simplify the complex process of setting up Kubernetes clusters. It handles the heavy lifting of SSH configuration, dependency installation, and cluster initialization, providing you with a production-ready environment in minutes.

---

## 🛠️ Prerequisites
Before you begin, ensure you have:
- **For the KubeEZ Platform**: Docker and Docker Compose installed on your management machine.
- **For Target Nodes**:
  - Clean Linux installation (Ubuntu, CentOS, RHEL, etc.).
  - At least 2 CPU cores and 2GB RAM per node.
  - SSH access with `sudo` privileges.
  - Network connectivity between all nodes.

---

## 🏗️ Deployment Options

### Local Simulation
If you just want to explore the UI without real servers, select **Simulation Mode** in the dashboard. This will generate mock data and allow you to test the interface features.

### Real Infrastructure
For production or staging:
1. Ensure your target nodes are reachable via SSH.
2. If using cloud providers (AWS, Azure, GCP), ensure Security Groups allow port 6443 (API Server) and SSH.

---

## 🧙 Using the Installation Wizard

### Step 1: Cluster Identity
- **Cluster Name**: Give your cluster a unique name.
- **K8s Version**: Select your preferred Kubernetes version.
- **Network Plugin**:
  - **Calico**: Best for production (supports Network Policies).
  - **Flannel**: Best for simple, lightweight setups.

### Step 2: Node Configuration
Add your Master and Worker nodes. For each node, you need to provide:
- **Static IP**: The private or public IP of the node.
- **SSH Credentials**: Username and Password (or use an SSH Key).
- **Verification**: Use the "Verify" button to ensure KubeEZ can connect and that the node meets hardware requirements.

### Step 3: Add-on Selection
Select the core components you want installed automatically:
- **Ingress Controller**: For routing external traffic.
- **ArgoCD**: For GitOps-driven application deployment.
- **Longhorn**: For enterprise-grade persistent storage.

---

## 📊 Cluster Management

Once installed, you can manage your cluster from the **Management Console**:

### Orbital Terminal
Need to run a command on all nodes? Opening the Terminal widget allows you to broadcast commands to all masters or workers simultaneously.

### 3D Topology
The 3D view shows your cluster as a "Digital Twin". You can see traffic flowing between nodes and monitor their health status visually.

### Health Telemetry
The dashboard provides live updates on:
- **CPU & Memory**: Real-time utilization of each node.
- **Pods Ready**: The count of running pods versus requested.

---

## 🔌 Installing Add-ons
Existing clusters can be expanded by installing additional Add-ons from the "Actions" menu. KubeEZ handles the complex helm charts and manifest applications for you.

---

## 🩺 Troubleshooting

### Connection Issues
- **Error**: `SSH connection failed`.
- **Fix**: Check if port 22 is open on the node and your credentials are correct.

### Installation Failures
- **Error**: `dpkg lock` or `apt lock`.
- **AI Rescue**: KubeEZ will prompt you to run an "Auto-Fix". Click it to let the AI kill the hung process and repair the package manager before retrying automatically.

---

**Need more help?** Check our [Troubleshooting Guide](TROUBLESHOOTING.md) or open an issue on GitHub.
