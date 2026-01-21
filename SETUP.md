# 🚀 KubeEZ - Complete Setup Guide

## 📋 Prerequisites

### System Requirements
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Operating System**: Windows, macOS, or Linux

### Target VM Requirements (for Kubernetes installation)
- **OS**: Ubuntu 20.04/22.04, RHEL 8/9, Rocky Linux 8/9, or CentOS Stream
- **CPU**: Minimum 2 cores (4+ recommended for production)
- **RAM**: Minimum 2GB (4GB+ recommended)
- **Disk**: Minimum 20GB free space
- **Network**: Internet connectivity required
- **SSH**: SSH access with sudo privileges

---

## 🏗️ Installation

### Step 1: Clone or Download the Project

```bash
cd C:\Users\Joy\.gemini\antigravity\scratch\kubeez
```

### Step 2: Install Dependencies

```bash
# Install root dependencies
npm install

# Install frontend dependencies
cd frontend
npm install

# Install backend dependencies
cd ../backend
npm install

# Return to root
cd ..
```

### Step 3: Start the Application

```bash
# Start both frontend and backend (from root directory)
npm run dev
```

**OR** start them separately:

```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

### Step 4: Access the Application

- **Frontend UI**: http://localhost:5173
- **Backend API**: http://localhost:3000
- **API Health Check**: http://localhost:3000/api/health

---

## 🎯 Usage Guide

### Creating Your First Kubernetes Cluster

#### Step 1: Cluster Basics
1. Open http://localhost:5173 in your browser
2. Enter a **Cluster Name** (e.g., `my-production-cluster`)
3. Select **Kubernetes Version** (default: v1.28.0)
4. Choose **Network Plugin**:
   - **Calico**: Recommended for production (supports network policies)
   - **Flannel**: Lightweight, simple overlay network
5. Click **Next Step**

#### Step 2: Configure Nodes

**Master Nodes (Control Plane):**
1. Click **Add Master** to add master nodes
2. For each master node, provide:
   - **IP Address**: e.g., `192.168.1.10`
   - **SSH Username**: e.g., `ubuntu` or `root`
   - **SSH Password**: (optional if using SSH key)
   - **SSH Key Path**: (optional, e.g., `~/.ssh/id_rsa`)
3. For HA clusters, add 3 or 5 master nodes

**Worker Nodes:**
1. Click **Add Worker** to add worker nodes
2. Provide the same SSH details as master nodes
3. Add as many workers as needed

**Important Notes:**
- At least 1 master node is required
- Worker nodes are optional (can run workloads on master in dev)
- For production HA, use 3 or 5 master nodes (odd number)
- Ensure all nodes can communicate with each other

#### Step 3: Select Features

Choose the add-ons you want to install:

- **🌐 Ingress Controller** (Nginx)
  - HTTP/HTTPS routing for your applications
  - Recommended for production

- **📊 Monitoring Stack** (Prometheus + Grafana)
  - Metrics collection and visualization
  - Essential for production monitoring

- **📝 Logging Stack** (EFK - Elasticsearch, Fluentd, Kibana)
  - Centralized log aggregation
  - Useful for debugging and auditing

- **🎛️ Kubernetes Dashboard**
  - Web UI for cluster management
  - Great for beginners

#### Step 4: Review & Install

1. Review your configuration
2. Ensure all details are correct
3. Click **Install Cluster**
4. Watch the real-time installation progress!

### Monitoring Installation

The installation dashboard shows:
- **Progress Bar**: Overall installation progress (0-100%)
- **Current Step**: What's happening right now
- **Real-time Logs**: Live output from all installation steps
- **Status Cards**: Installation state, timing, and cluster info

### After Installation

When installation completes:
1. Click **Download Kubeconfig** to get your cluster credentials
2. Save the file as `kubeconfig.yaml`
3. Use it to connect to your cluster:

```bash
export KUBECONFIG=./kubeconfig.yaml
kubectl get nodes
kubectl get pods --all-namespaces
```

---

## 🔧 Configuration

### Backend Configuration

Edit `backend/src/server.js` to change:
- **Port**: Default is 3000
- **WebSocket path**: Default is `/ws`

### Frontend Configuration

Edit `frontend/vite.config.js` to change:
- **Port**: Default is 5173
- **API proxy**: Points to backend at localhost:3000

---

## 📡 API Reference

### POST /api/clusters/install

Start a new cluster installation.

**Request Body:**
```json
{
  "clusterName": "my-cluster",
  "k8sVersion": "1.28.0",
  "networkPlugin": "calico",
  "masterNodes": [
    {
      "ip": "192.168.1.10",
      "username": "ubuntu",
      "password": "secret",
      "sshKey": ""
    }
  ],
  "workerNodes": [
    {
      "ip": "192.168.1.11",
      "username": "ubuntu",
      "password": "secret",
      "sshKey": ""
    }
  ],
  "addons": {
    "ingress": true,
    "monitoring": false,
    "logging": false,
    "dashboard": true
  }
}
```

**Response:**
```json
{
  "installationId": "uuid-here",
  "message": "Installation started successfully",
  "status": "pending"
}
```

### GET /api/clusters/:id/status

Get installation status.

**Response:**
```json
{
  "id": "uuid-here",
  "status": "running",
  "progress": 65,
  "currentStep": "Installing network plugin...",
  "logs": [...]
}
```

### WebSocket: ws://localhost:3000/ws/installation/:id

Real-time installation updates.

**Message Types:**
```json
// Log message
{
  "type": "log",
  "level": "info",
  "message": "Installing containerd..."
}

// Progress update
{
  "type": "progress",
  "progress": 50,
  "step": "Initializing control plane..."
}

// Status change
{
  "type": "status",
  "status": "completed",
  "clusterInfo": {
    "name": "my-cluster",
    "version": "1.28.0",
    "nodes": 3,
    "endpoint": "https://192.168.1.10:6443"
  }
}
```

---

## 🛠️ Troubleshooting

### Frontend Issues

**Problem**: Frontend won't start
```bash
# Solution: Clear node_modules and reinstall
cd frontend
rm -rf node_modules package-lock.json
npm install
npm run dev
```

**Problem**: Can't connect to backend
- Check if backend is running on port 3000
- Check `frontend/vite.config.js` proxy settings

### Backend Issues

**Problem**: Backend won't start
```bash
# Solution: Check Node.js version
node --version  # Should be v18+

# Reinstall dependencies
cd backend
rm -rf node_modules package-lock.json
npm install
npm run dev
```

**Problem**: WebSocket connection fails
- Ensure backend is running
- Check firewall settings
- Verify WebSocket path in frontend code

### Installation Issues

**Problem**: SSH connection fails
- Verify IP address is correct and reachable
- Check SSH credentials (username/password or key)
- Ensure SSH service is running on target nodes
- Check firewall rules (port 22 should be open)

**Problem**: Pre-flight checks fail
- Ensure nodes meet minimum requirements (2 CPU, 2GB RAM, 20GB disk)
- Disable swap: `sudo swapoff -a`
- Check internet connectivity

**Problem**: Installation hangs
- Check logs for specific errors
- Verify all nodes can communicate
- Ensure required ports are open (6443, 2379-2380, 10250-10252)

---

## 🔒 Security Best Practices

### SSH Security
- Use SSH keys instead of passwords when possible
- Restrict SSH access to specific IPs
- Use strong passwords if keys aren't available

### Cluster Security
- Change default credentials after installation
- Enable RBAC (enabled by default in modern K8s)
- Use network policies to restrict pod communication
- Regularly update Kubernetes and add-ons

### KubeEZ Application
- Don't expose backend API to the internet
- Use HTTPS in production (add reverse proxy)
- Store SSH credentials securely (consider using a secrets manager)

---

## 📚 Additional Resources

### Kubernetes Documentation
- Official Docs: https://kubernetes.io/docs/
- kubeadm Guide: https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/

### Network Plugins
- Calico: https://docs.tigera.io/calico/latest/about/
- Flannel: https://github.com/flannel-io/flannel

### Add-ons
- Nginx Ingress: https://kubernetes.github.io/ingress-nginx/
- Prometheus: https://prometheus.io/docs/
- Kubernetes Dashboard: https://kubernetes.io/docs/tasks/access-application-cluster/web-ui-dashboard/

---

## 🤝 Support

- **Issues**: Report bugs on GitHub Issues
- **Discussions**: Join our Discord community
- **Email**: support@kubeez.io
- **Documentation**: https://docs.kubeez.io

---

## 📄 License

MIT License - see LICENSE file for details

---

**Made with ❤️ by the KubeEZ Team**
