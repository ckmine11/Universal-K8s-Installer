# 🔧 KubeEZ Troubleshooting Guide

This guide helps you resolve common issues with KubeEZ installation and operation.

---

## 📋 Table of Contents

- [Installation Issues](#installation-issues)
- [Cluster Creation Problems](#cluster-creation-problems)
- [Network Issues](#network-issues)
- [Add-on Installation Failures](#add-on-installation-failures)
- [SSH Connection Problems](#ssh-connection-problems)
- [Docker/Container Issues](#dockercontainer-issues)
- [Performance Issues](#performance-issues)
- [Debugging Tips](#debugging-tips)

---

## 🚀 Installation Issues

### KubeEZ Won't Start

**Symptoms:**
- `docker-compose up` fails
- Containers exit immediately
- Port conflicts

**Solutions:**

1. **Check if ports are already in use:**
```bash
# Windows
netstat -ano | findstr :3000
netstat -ano | findstr :5173

# Linux/Mac
lsof -i :3000
lsof -i :5173
```

2. **Stop conflicting services:**
```bash
# Kill process using the port
# Windows: taskkill /PID <PID> /F
# Linux/Mac: kill -9 <PID>
```

3. **Clean Docker environment:**
```bash
docker-compose down -v
docker system prune -a
docker-compose up -d --build
```

4. **Check Docker logs:**
```bash
docker-compose logs backend
docker-compose logs frontend
```

---

### Backend Health Check Fails

**Symptoms:**
- Backend shows as unhealthy
- API requests timeout

**Solutions:**

1. **Check backend logs:**
```bash
docker-compose logs -f backend
```

2. **Verify environment variables:**
```bash
docker-compose exec backend env
```

3. **Test health endpoint manually:**
```bash
curl http://localhost:3000/api/health
```

4. **Restart backend:**
```bash
docker-compose restart backend
```

---

## 🎯 Cluster Creation Problems

### Installation Stuck at Specific Step

**Symptoms:**
- Progress bar stops moving
- Same step repeats
- No error messages

**Solutions:**

1. **Check node connectivity:**
```bash
# From your machine
ssh user@node-ip
ping node-ip
```

2. **Check backend logs for errors:**
```bash
docker-compose logs backend | grep -i error
```

3. **Verify node requirements:**
```bash
# On target node
free -h          # Check memory (min 2GB)
df -h            # Check disk space (min 20GB)
cat /proc/cpuinfo | grep processor | wc -l  # Check CPUs (min 2)
```

4. **Check if swap is disabled:**
```bash
# On target node
swapon --show    # Should be empty
```

---

### "Self-Healing Failed" Error

**Symptoms:**
- Installation fails after multiple retry attempts
- Error shows "All recovery attempts exhausted"

**Solutions:**

1. **Check specific error in logs:**
```bash
docker-compose logs backend | tail -100
```

2. **Common fixes to try manually on the node:**

**DNS Issues:**
```bash
# On target node
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
echo "nameserver 8.8.4.4" | sudo tee -a /etc/resolv.conf
```

**Package Lock Issues:**
```bash
# On target node
sudo killall apt apt-get
sudo rm /var/lib/apt/lists/lock
sudo rm /var/cache/apt/archives/lock
sudo rm /var/lib/dpkg/lock*
sudo dpkg --configure -a
sudo apt update
```

**Swap Not Disabled:**
```bash
# On target node
sudo swapoff -a
sudo sed -i '/ swap / s/^/#/' /etc/fstab
```

3. **Reset and retry:**
```bash
# On target node
sudo kubeadm reset -f
sudo rm -rf /etc/cni/net.d
sudo rm -rf ~/.kube
```

---

### Nodes Not Joining Cluster

**Symptoms:**
- Master node installs successfully
- Worker nodes fail to join
- `kubectl get nodes` shows only master

**Solutions:**

1. **Verify join token is valid:**
```bash
# On master node
sudo kubeadm token list
```

2. **Regenerate join command:**
```bash
# On master node
sudo kubeadm token create --print-join-command
```

3. **Check firewall rules:**
```bash
# On all nodes
sudo ufw status
# Ensure ports 6443, 10250, 10251, 10252 are open
```

4. **Check network connectivity between nodes:**
```bash
# From worker to master
telnet master-ip 6443
```

---

## 🌐 Network Issues

### Cannot Access Cluster After Installation

**Symptoms:**
- `kubectl` commands timeout
- Cannot connect to API server

**Solutions:**

1. **Verify kubeconfig:**
```bash
cat ~/.kube/config
# Check if server IP is correct
```

2. **Test API server connectivity:**
```bash
curl -k https://master-ip:6443
```

3. **Check API server status:**
```bash
# On master node
sudo systemctl status kubelet
sudo crictl ps | grep kube-apiserver
```

4. **Verify certificates:**
```bash
# On master node
sudo kubeadm certs check-expiration
```

---

### Pod Network Not Working

**Symptoms:**
- Pods can't communicate
- DNS resolution fails
- CoreDNS pods in CrashLoopBackOff

**Solutions:**

1. **Check CNI plugin status:**
```bash
kubectl get pods -n kube-system | grep -E 'calico|flannel|weave'
```

2. **Verify pod network CIDR:**
```bash
kubectl cluster-info dump | grep -i cidr
```

3. **Restart CNI pods:**
```bash
kubectl delete pods -n kube-system -l k8s-app=calico-node
```

4. **Check iptables rules:**
```bash
# On nodes
sudo iptables -L -n -v | grep FORWARD
```

---

## 🔌 Add-on Installation Failures

### Monitoring Stack Installation Fails

**Symptoms:**
- Prometheus operator not starting
- Grafana pod in CrashLoopBackOff
- ServiceMonitors not being discovered

**Solutions:**

1. **Check operator logs:**
```bash
kubectl logs -n monitoring deployment/prometheus-operator
```

2. **Verify CRDs are installed:**
```bash
kubectl get crd | grep monitoring.coreos.com
```

3. **Check resource availability:**
```bash
kubectl top nodes
kubectl describe nodes | grep -A 5 "Allocated resources"
```

4. **Reinstall monitoring stack:**
```bash
kubectl delete namespace monitoring
# Then reinstall via KubeEZ UI
```

---

### Ingress Controller Not Working

**Symptoms:**
- Ingress resources created but not accessible
- No external IP assigned

**Solutions:**

1. **Check ingress controller pods:**
```bash
kubectl get pods -n ingress-nginx
```

2. **Verify service type:**
```bash
kubectl get svc -n ingress-nginx
```

3. **Check NodePort assignment:**
```bash
kubectl get svc -n ingress-nginx -o wide
```

4. **Test ingress controller:**
```bash
curl http://node-ip:ingress-nodeport
```

---

## 🔐 SSH Connection Problems

### "Permission Denied" Errors

**Symptoms:**
- Cannot SSH to nodes
- Authentication fails

**Solutions:**

1. **Verify SSH credentials:**
```bash
# Test manually
ssh user@node-ip
```

2. **Check SSH key format:**
- Ensure private key includes header/footer
- Key should start with `-----BEGIN RSA PRIVATE KEY-----`

3. **Verify user permissions:**
```bash
# On target node
sudo cat /etc/sudoers | grep user
```

4. **Check SSH service:**
```bash
# On target node
sudo systemctl status sshd
```

---

### "Connection Timeout" Errors

**Symptoms:**
- SSH connection hangs
- No response from node

**Solutions:**

1. **Check network connectivity:**
```bash
ping node-ip
traceroute node-ip
```

2. **Verify firewall rules:**
```bash
# On target node
sudo ufw status
sudo firewall-cmd --list-all
```

3. **Check SSH port:**
```bash
# On target node
sudo netstat -tlnp | grep :22
```

4. **Verify SSH is running:**
```bash
# On target node
sudo systemctl restart sshd
```

---

## 🐳 Docker/Container Issues

### Backend Container Keeps Restarting

**Symptoms:**
- Backend container exits repeatedly
- Health checks fail

**Solutions:**

1. **Check container logs:**
```bash
docker logs kubeez-backend --tail 100
```

2. **Inspect container:**
```bash
docker inspect kubeez-backend
```

3. **Check resource limits:**
```bash
docker stats kubeez-backend
```

4. **Rebuild container:**
```bash
docker-compose down
docker-compose build --no-cache backend
docker-compose up -d
```

---

### Volume Permission Issues

**Symptoms:**
- Cannot write to mounted volumes
- Permission denied errors in logs

**Solutions:**

1. **Check volume permissions:**
```bash
ls -la backend/data
ls -la backend/logs
```

2. **Fix permissions:**
```bash
# Windows (run as Administrator)
icacls backend\data /grant Everyone:F /T
icacls backend\logs /grant Everyone:F /T

# Linux/Mac
chmod -R 777 backend/data
chmod -R 777 backend/logs
```

3. **Recreate volumes:**
```bash
docker-compose down -v
docker-compose up -d
```

---

## ⚡ Performance Issues

### Slow Installation

**Symptoms:**
- Installation takes very long
- Steps timeout

**Solutions:**

1. **Check node resources:**
```bash
# On target nodes
top
free -h
iostat
```

2. **Verify network speed:**
```bash
# Test download speed
curl -o /dev/null http://speedtest.tele2.net/10MB.zip
```

3. **Check Docker performance:**
```bash
docker stats
```

4. **Increase timeouts:**
- Edit installation scripts to increase wait times
- Check `install-addons.sh` timeout values

---

### High Memory Usage

**Symptoms:**
- Backend using too much memory
- System becomes slow

**Solutions:**

1. **Check memory usage:**
```bash
docker stats kubeez-backend
```

2. **Restart backend:**
```bash
docker-compose restart backend
```

3. **Limit container resources:**
```yaml
# Add to docker-compose.yml
services:
  backend:
    deploy:
      resources:
        limits:
          memory: 512M
```

---

## 🐛 Debugging Tips

### Enable Debug Logging

**Backend:**
```bash
# Add to docker-compose.yml
environment:
  - DEBUG=true
  - LOG_LEVEL=debug
```

**Check all logs:**
```bash
docker-compose logs -f --tail=100
```

---

### Common Log Locations

```bash
# Backend logs
docker-compose logs backend

# Frontend logs
docker-compose logs frontend

# Cluster data
cat backend/data/clusters.json

# Application logs (if volume mounted)
cat backend/logs/app.log
```

---

### Useful Commands

```bash
# Check all running containers
docker ps

# Check container resource usage
docker stats

# Inspect network
docker network inspect kubeez_kubeez-network

# Clean everything and start fresh
docker-compose down -v
docker system prune -a -f
docker-compose up -d --build

# Export cluster data (backup)
docker cp kubeez-backend:/app/data/clusters.json ./backup-clusters.json

# Check WebSocket connection
wscat -c ws://localhost:3000/ws
```

---

### Get Help

If you're still stuck:

1. **Check GitHub Issues:** [Universal-K8s-Installer Issues](https://github.com/ckmine11/Universal-K8s-Installer/issues)
2. **Create a new issue** with:
   - KubeEZ version
   - OS and Docker version
   - Complete error logs
   - Steps to reproduce
3. **Join Community:** (Add Discord/Slack link when available)

---

## 📊 Health Check Checklist

Before reporting an issue, verify:

- [ ] Docker and Docker Compose are running
- [ ] Ports 3000 and 5173 are available
- [ ] Target nodes meet minimum requirements (2 CPU, 2GB RAM, 20GB disk)
- [ ] SSH access to all nodes works
- [ ] Firewall rules allow required ports
- [ ] Swap is disabled on all nodes
- [ ] Internet connectivity is available
- [ ] Backend health endpoint responds: `curl http://localhost:3000/api/health`

---

**Last Updated:** 2026-01-22  
**Version:** 2.1.0
