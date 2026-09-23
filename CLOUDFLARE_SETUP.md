# ☁️ KubeEZ Deployment Guide — Cloudflare Tunnel

Deploy KubeEZ on `k8scluster.space` using your **existing Cloudflare Tunnel**.

---

## Your Setup

```
VPS (Ubuntu)
├── cloudflared (tunnel already running)
│   └── existing hostname → localhost:8081 (devops app)
│
├── Existing Docker containers (devops app — UNTOUCHED)
│   ├── devops_nginx    → :8081
│   ├── devops_backend  → :5000
│   ├── devops_frontend → :3000
│   ├── devops_redis    → :6379
│   └── devops_mongo    → :27017
│
└── NEW: KubeEZ Docker containers
    ├── kubeez-proxy    → :8090  ← Tunnel will point here
    ├── kubeez-backend  → :3000 (internal)
    └── kubeez-frontend → :80 (internal)
```

---

## Step 1: Deploy KubeEZ on VPS

```bash
ssh root@YOUR_VPS_IP

# Clone the repo
git clone https://github.com/ckmine11/Universal-K8s-Installer.git
cd Universal-K8s-Installer

# Deploy
chmod +x deploy.sh
sudo bash deploy.sh
```

### Verify it's running:
```bash
curl http://localhost:8090/api/health
# {"status":"healthy","timestamp":"..."}
```

---

## Step 2: Add Domain to Cloudflare (if not already)

Since `k8scluster.space` is on **Hostinger** and not yet on Cloudflare:

### 2a. Add site to Cloudflare
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Click **"Add a site"** (top right)
3. Enter: `k8scluster.space`
4. Select **Free plan** → Continue
5. Cloudflare will show you **2 nameservers** — copy them

### 2b. Change nameservers at Hostinger
1. Login to [Hostinger](https://hpanel.hostinger.com)
2. Go to **Domains** → `k8scluster.space` → **DNS / Nameservers**
3. Click **"Change nameservers"** 
4. Replace Hostinger's nameservers with Cloudflare's:
   ```
   ns1: (whatever Cloudflare gave you, e.g., anna.ns.cloudflare.com)
   ns2: (whatever Cloudflare gave you, e.g., bob.ns.cloudflare.com)
   ```
5. Save → Wait 5-30 minutes for propagation

### 2c. Verify in Cloudflare
- Go back to Cloudflare → it should show "Active" for `k8scluster.space`

---

## Step 3: Add Public Hostname to Your Tunnel

This is the key step — add `k8scluster.space` to your **existing tunnel**.

### Via Cloudflare Dashboard (easiest):

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Click on **`k8scluster.space`** (or select it from your sites)
3. In the left sidebar: **Zero Trust** (or go directly to [one.dash.cloudflare.com](https://one.dash.cloudflare.com))
4. Navigate to: **Networks** → **Tunnels**
5. Find your **existing tunnel** → Click on it
6. Go to **Public Hostname** tab
7. Click **"Add a public hostname"**
8. Fill in:

   | Field | Value |
   |-------|-------|
   | **Subdomain** | _(leave empty for root domain)_ |
   | **Domain** | `k8scluster.space` |
   | **Type** | `HTTP` |
   | **URL** | `localhost:8090` |

9. Under **Additional application settings** → **HTTP Settings**:
   - **WebSocket** support: This is handled automatically by Cloudflare Tunnel ✅
   
10. Click **Save hostname**

### Also add www (optional):

Click **"Add a public hostname"** again:

| Field | Value |
|-------|-------|
| **Subdomain** | `www` |
| **Domain** | `k8scluster.space` |
| **Type** | `HTTP` |
| **URL** | `localhost:8090` |

---

## Step 4: Configure SSL (automatic with Tunnel!)

With Cloudflare Tunnel, SSL is **automatic** — no extra config needed! ✅

But verify these settings in Cloudflare → `k8scluster.space` → **SSL/TLS**:

- **Encryption mode**: Should show **Full** (Tunnel handles this automatically)
- **Always Use HTTPS**: ✅ ON (go to Edge Certificates section)

---

## Step 5: Verify Everything

### Check DNS propagation:
```bash
nslookup k8scluster.space
# Should return Cloudflare IPs
```

### Check site is live:
Open **https://k8scluster.space** in your browser:
- ✅ Should show KubeEZ login page with the radar animation
- ✅ Padlock 🔒 icon = valid SSL

### Check API:
```bash
curl https://k8scluster.space/api/health
# {"status":"healthy","timestamp":"..."}
```

### Check existing app still works:
Your devops app is completely untouched — verify it still works on its domain.

---

## Why Tunnel is Better (vs regular DNS + Nginx)

| Feature | Regular Setup | Cloudflare Tunnel |
|---------|--------------|-------------------|
| Host Nginx needed | ✅ Yes | ❌ No |
| Port 80 needed | ✅ Yes | ❌ No |
| VPS IP exposed | ✅ Yes | ❌ No (hidden!) |
| SSL configuration | Manual | Automatic |
| WebSocket support | Needs config | Built-in |
| DDoS protection | Basic | Full Cloudflare |
| Setup complexity | Medium | Simple |

---

## Troubleshooting

### Site shows "DNS resolution error"
- Nameservers haven't propagated yet (wait 5-30 min)
- Check: https://www.whatsmydns.net/#NS/k8scluster.space

### "Tunnel connection failed" / 502 error
```bash
# Check KubeEZ is running
docker compose -f docker-compose.prod.yml ps

# Check port 8090 is listening
curl http://localhost:8090/api/health

# Check tunnel status
systemctl status cloudflared
# OR
cloudflared tunnel list
```

### "Bad Gateway" after tunnel is connected
```bash
# Check backend container specifically
docker compose -f docker-compose.prod.yml logs backend

# Restart KubeEZ
docker compose -f docker-compose.prod.yml restart
```

### WebSocket disconnects
- Cloudflare Tunnel handles WebSocket natively — better than regular proxy
- KubeEZ also has 30s keep-alive pings built in
- If still disconnecting, check: `docker compose -f docker-compose.prod.yml logs backend`

---

## Management Commands

```bash
# View KubeEZ logs
docker compose -f docker-compose.prod.yml logs -f

# Restart KubeEZ only (existing app unaffected)
docker compose -f docker-compose.prod.yml restart

# Rebuild after code changes
docker compose -f docker-compose.prod.yml up -d --build

# Stop KubeEZ
docker compose -f docker-compose.prod.yml down

# Check tunnel status
cloudflared tunnel list
cloudflared tunnel info YOUR_TUNNEL_NAME
```
