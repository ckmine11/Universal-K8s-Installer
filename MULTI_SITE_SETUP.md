# 🏗️ Multi-Site VPS Setup Guide
# Run this on your VPS to install host-level Nginx as shared reverse proxy

## This is needed because Cloudflare Free plan only proxies to port 80/443
## Multiple domains on one VPS need a shared Nginx that routes by domain name

---

## Architecture After Setup

```
Cloudflare (k8scluster.space) ──┐
                                 ├──▶ Host Nginx (:80)
Cloudflare (yourother.com) ─────┘        │
                                         ├─▶ k8scluster.space → KubeEZ Docker (:8090)
                                         └─▶ yourother.com → Existing Docker (:EXISTING_PORT)
```

---

## Step 1: Install Host Nginx

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

## Step 2: Create Nginx Config for KubeEZ

```bash
sudo nano /etc/nginx/sites-available/k8scluster.space
```

Paste this config (copy exactly):

```nginx
# KubeEZ - k8scluster.space
server {
    listen 80;
    server_name k8scluster.space www.k8scluster.space;

    client_max_body_size 10M;

    # Restore real IP from Cloudflare
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 131.0.72.0/22;
    real_ip_header CF-Connecting-IP;

    # API + WebSocket → Backend
    location /api {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Everything else → Frontend
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Step 3: Enable the Site

```bash
sudo ln -s /etc/nginx/sites-available/k8scluster.space /etc/nginx/sites-enabled/
sudo nginx -t        # Test config
sudo systemctl reload nginx
```

## Step 4: Create Config for Your Existing Site (if not done already)

```bash
sudo nano /etc/nginx/sites-available/yourother.com
```

```nginx
# Your existing site
server {
    listen 80;
    server_name yourother.com www.yourother.com;

    location / {
        proxy_pass http://127.0.0.1:YOUR_EXISTING_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/yourother.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

> Replace `YOUR_EXISTING_PORT` with the actual port your existing Docker app runs on.

## Step 5: Remove Default Nginx Site (optional, recommended)

```bash
sudo rm /etc/nginx/sites-enabled/default
sudo systemctl reload nginx
```

---

## Now your existing site should continue working on its domain,
## and KubeEZ will be available on k8scluster.space!
