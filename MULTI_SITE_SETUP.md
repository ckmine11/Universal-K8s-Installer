# Running KubeEZ next to other sites on one server

*Version 2.3.0 · November 2026.* How to host KubeEZ on a server that already serves other websites, with one shared nginx on port 80 that routes by domain name (for example behind Cloudflare, which proxies only to ports 80 / 443 on the free plan).

---

## 1. The layout

```
Cloudflare (kubeez.example.com) ──┐
                                   ├──▶ host nginx :80 ──┬─▶ kubeez.example.com → KubeEZ proxy container (127.0.0.1:8090)
Cloudflare (other-site.com) ───────┘                     └─▶ other-site.com     → your other app (127.0.0.1:<port>)
```

KubeEZ's own proxy container (`kubeez-proxy`, nginx) keeps routing inside KubeEZ: `/api`, `/ws`, the Explorer streams and the agent downloads to the backend, everything else to the frontend. The host nginx only picks the site by domain.

---

## 2. Free port 80 for the host nginx

`docker-compose.prod.yml` publishes the KubeEZ proxy on **both** 80 and 8090. On a shared server, port 80 belongs to the host nginx, so change the proxy's `ports:` to:

```yaml
    ports:
      - "127.0.0.1:8090:80"     # only the host nginx reaches it
```

Then restart KubeEZ:

```bash
docker compose -f docker-compose.prod.yml up -d proxy
```

---

## 3. Install nginx on the host

```bash
sudo apt update && sudo apt install -y nginx
sudo systemctl enable --now nginx
```

---

## 4. The KubeEZ site

`/etc/nginx/sites-available/kubeez.example.com`:

```nginx
# WebSockets only when the client asks for one (Explorer, terminals, live logs)
map $http_upgrade $kz_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name kubeez.example.com;

    # Cloudflare → the visitor's real IP (ranges: https://www.cloudflare.com/ips/)
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

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $kz_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        # Explorer streams (server-sent events) and long jobs: no buffering, long timeouts
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/kubeez.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

KubeEZ's inner proxy answers any domain name, so you only change `server_name` here. Set `KUBEEZ_PUBLIC_URL=https://kubeez.example.com` (and add it to `ALLOWED_ORIGINS` if you use another address too) in `.env`, then `docker compose -f docker-compose.prod.yml up -d backend`.

---

## 5. Your other site

`/etc/nginx/sites-available/other-site.com`:

```nginx
server {
    listen 80;
    server_name other-site.com www.other-site.com;

    location / {
        proxy_pass http://127.0.0.1:<its port>;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/other-site.com /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default      # the "Welcome to nginx" page
sudo nginx -t && sudo systemctl reload nginx
```

---

## 6. Cloudflare

For each domain: an **A record** to the server's IP, **proxied** (orange cloud), SSL/TLS mode **Full** (or **Full (strict)** with an origin certificate on the host nginx), and **WebSockets** on (Network settings). Long Helm and install jobs run in the background, so Cloudflare's 100-second request limit does not cut them off. More: [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md).

---

## 7. Check

```bash
curl -sI -H 'Host: kubeez.example.com' http://127.0.0.1/ | head -1          # 200
curl -s  -H 'Host: kubeez.example.com' http://127.0.0.1/api/health           # {"status":…}
curl -sI -H 'Host: other-site.com'     http://127.0.0.1/ | head -1          # your other site
```

In the console, open a cluster's **Explorer** and a **terminal** — both use WebSockets; if they fail, the `Upgrade` / `Connection` headers are not passed.
