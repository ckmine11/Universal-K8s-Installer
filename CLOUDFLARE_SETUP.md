# Putting KubeEZ behind Cloudflare

*Version 2.3.0 · November 2026.* How to serve KubeEZ on your own domain over HTTPS with Cloudflare. Server setup first: [DEPLOY.md](DEPLOY.md).

KubeEZ's production stack (`docker-compose.prod.yml`) answers plain HTTP on **port 80** and **port 8090** (the same proxy on both). Cloudflare adds HTTPS in front. Two ways:

| | Cloudflare Tunnel (recommended) | Proxied DNS |
|---|---|---|
| Inbound ports on the server | **none** | 80 (or 443) open to Cloudflare |
| Server IP | hidden | hidden behind the proxy, but reachable directly unless firewalled |
| Other sites on the same server | each hostname points to its own local port | needs a host nginx ([MULTI_SITE_SETUP.md](MULTI_SITE_SETUP.md)) |

---

## 1. Put the domain on Cloudflare

1. Cloudflare dashboard → **Add a site** → your domain → the Free plan is enough.
2. At your registrar, replace the nameservers with the two Cloudflare shows. Wait until the site is **Active** (minutes to a few hours).

---

## 2a. With a Cloudflare Tunnel

1. KubeEZ runs on the server: `bash deploy.sh` (or `docker compose -f docker-compose.prod.yml up -d --build`). Check: `curl -s http://localhost:8090/api/health`.
2. Cloudflare dashboard → **Zero Trust → Networks → Tunnels** → **Create a tunnel** (type *Cloudflared*), name it, and run the install command it shows on the server (it installs `cloudflared` as a service). An existing tunnel on the server can be reused.
3. **Public hostname** → add one:
   - Subdomain / domain: e.g. `kubeez` . `example.com` (or the bare domain)
   - Service: **HTTP**, URL **`localhost:8090`**
4. Save. Cloudflare creates the DNS record and the certificate by itself.

Because the tunnel connects out, you can close ports 80 / 8090 to the internet entirely (keep SSH for yourself).

**Visitor IPs:** KubeEZ's proxy restores the real visitor IP only for requests that come from Cloudflare's address ranges. Through a tunnel, requests arrive from `cloudflared` on the server, so the audit trail and login lockout see the local address. To restore visitor IPs, add the address requests come from (with `cloudflared` on the host: the Docker bridge, e.g. `set_real_ip_from 172.16.0.0/12;`) to `nginx/production.conf` next to the other `set_real_ip_from` lines, then `docker compose -f docker-compose.prod.yml restart proxy`.

## 2b. With proxied DNS

1. DNS → **Add record**: type **A**, name `kubeez` (or `@`), the server's public IP, **Proxied** (orange cloud).
2. Open port **80** on the server's firewall — ideally only to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/).
3. KubeEZ's proxy already trusts those ranges and restores the visitor IP from `CF-Connecting-IP`.

---

## 3. Cloudflare settings

| Setting | Value |
|---|---|
| SSL/TLS → mode | **Full** — or **Flexible** if the origin speaks only HTTP (port 80, proxied DNS). With a tunnel, HTTPS to Cloudflare is automatic. |
| SSL/TLS → Edge Certificates | **Always Use HTTPS** on |
| Network | **WebSockets** on (the Explorer, terminals and live logs need them) |
| Caching | leave the defaults; do not cache `/api/*` |

Cloudflare ends any single request after **100 seconds**. KubeEZ is built for this: installs, upgrades, Helm deploys and restores run as background jobs that the console follows, and a request that would take longer answers with a clear reason instead of Cloudflare's error page.

---

## 4. Tell KubeEZ its address

In `.env` on the server:

```bash
KUBEEZ_PUBLIC_URL=https://kubeez.example.com      # links in emails and alerts, OAuth callbacks
ALLOWED_ORIGINS=https://kubeez.example.com        # browser origins allowed to call the API / open WebSockets
FRONTEND_URL=https://kubeez.example.com          # billing return links (hosted edition)
```

```bash
docker compose -f docker-compose.prod.yml up -d backend
```

Optional: **Turnstile** (Cloudflare's "I am human" check) on sign-up and forgot password — create a widget under Turnstile and set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`.

---

## 5. Check

```bash
curl -sI https://kubeez.example.com | head -1                 # HTTP/2 200
curl -s  https://kubeez.example.com/api/health                # {"status":"healthy",…}
```

Then sign in, open a cluster's **Explorer** and a **terminal** (WebSockets), and send a test alert (links should point to the https address).

---

## 6. Problems

| You see | Fix |
|---|---|
| DNS resolution error | Nameservers not switched yet, or the record / public hostname is missing. |
| Cloudflare 502 / 1033 (tunnel) | KubeEZ or the tunnel is down: `docker compose -f docker-compose.prod.yml ps`, `curl -s http://localhost:8090/api/health`, `sudo systemctl status cloudflared`. Check the service URL is `localhost:8090`. |
| Cloudflare 521 / 522 (proxied DNS) | Port 80 closed or KubeEZ down. |
| Too many redirects | SSL mode **Flexible** together with an origin that redirects to HTTPS — use **Full**, or Flexible without the redirect. |
| Explorer / terminal never connect | WebSockets are off in Cloudflare, or a proxy between Cloudflare and KubeEZ drops the `Upgrade` header. |
| Emails and alerts link to the wrong address | `KUBEEZ_PUBLIC_URL` not set — section 4. |
| Requests fail with a CORS error in the browser console | The page is opened at an address not in `ALLOWED_ORIGINS` — add it. |
