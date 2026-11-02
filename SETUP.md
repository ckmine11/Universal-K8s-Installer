# KubeEZ Setup Guide

*Version 2.3.0 · November 2026.* How to run the KubeEZ server itself — for development, and in production. For using KubeEZ once it runs, see [USER_GUIDE.md](USER_GUIDE.md).

---

## 1. Two editions

| `KUBEEZ_MODE` | What it is | How it reaches your servers |
|---|---|---|
| `selfhosted` | You run KubeEZ for your own team. The first visitor creates the first administrator; a license key raises the plan (without one: Free). | Directly over SSH, or through Gateway Agents. |
| `saas` | The hosted, multi-workspace edition (anyone may sign up). The platform owner is created with a script. | Through each workspace's Gateway Agent; never directly to private addresses. |

---

## 2. Requirements

- A Linux server (a VPS is fine: 2 vCPU, 4 GB RAM, 20 GB disk) with **Docker** and **Docker Compose**.
- Outbound access to your cluster servers (SSH, port 22) — or Gateway Agents for networks it cannot reach.
- For development without Docker: **Node.js 20 or newer** (the images use Node 22 LTS).

Install Docker on Ubuntu / Debian:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

---

## 3. Configure

```bash
git clone https://github.com/ckmine11/Universal-K8s-Installer.git
cd Universal-K8s-Installer
cp .env.example .env
openssl rand -hex 32        # paste the result as APP_SECRET in .env
```

| Setting | Needed | What for |
|---|---|---|
| `APP_SECRET` | **yes** | Encrypts stored credentials and signs sessions. Keep it safe and never change it — stored secrets become unreadable. |
| `KUBEEZ_MODE` | yes | `selfhosted` or `saas`. |
| `KUBEEZ_PUBLIC_URL` | production | The address people open (e.g. `https://kubeez.example.com`); used in alert, email and webhook links. |
| `ALLOWED_ORIGINS` | sometimes | Extra browser origins allowed to call the API. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | recommended | Password reset codes, invites, sign-up confirmation, email alerts. Gmail needs an App Password; for inbox delivery use your own domain with SPF, DKIM and DMARC. |
| `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` | optional | "Continue with Google / GitHub". Callback: `<KUBEEZ_PUBLIC_URL>/api/auth/oauth/<provider>/callback`. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ROLE_MAP`, `OIDC_DEFAULT_ROLE`, `OIDC_WORKSPACE`, `OIDC_NAME`, `OIDC_SCOPES`, `OIDC_GROUPS_CLAIM` | optional | Single sign-on with any OpenID Connect provider. Groups map to roles (`kubeez-admins=admin,dev=viewer`); unmapped people get `OIDC_DEFAULT_ROLE` (`none` by default). Callback: `…/api/auth/oauth/oidc/callback`. |
| `KUBEEZ_OPEN_SIGNUP` | optional | `true` lets anyone create a workspace on a self-hosted server. |
| `KUBEEZ_FEATURES`, `KUBEEZ_FEATURES_DEFAULT` | optional | Which features the server offers: `KUBEEZ_FEATURES="gitops=on,previews=off"`; `KUBEEZ_FEATURES_DEFAULT=off` starts with everything off. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | optional | Cloudflare Turnstile on sign-up and forgot password. |
| `STRIPE_*` | hosted edition | Billing. |
| `ALERT_EMAILS_PER_DAY_FREE`, `ALERT_EMAILS_PER_DAY_PAID` | optional | Daily alert-email allowance per workspace (default 20 / 200). |

The full list with comments is in [.env.example](.env.example).

---

## 4. Run for development

```bash
docker compose up -d --build     # frontend http://localhost:5173, backend http://localhost:3000
```

Or without Docker, in two terminals:

```bash
cd backend && npm install && npm run dev      # API on :3000, restarts on changes
cd frontend && npm install && npm run dev     # console on :5173, API proxied to :3000
```

Open **http://localhost:5173**. On a fresh self-hosted server the first screen creates the **first administrator** — there is no default password.

---

## 5. Run in production

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

This starts nginx (ports **80** and **8090**) in front of the frontend and the backend. KubeEZ's data lives in the Docker volume `kubeez-data` (`/app/data` in the backend), its logs in `kubeez-logs`.

**Put it behind HTTPS** before connecting real servers or Gateway Agents — for example Cloudflare in front of port 80 ([CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md)), or your own reverse proxy with a certificate. Set `KUBEEZ_PUBLIC_URL` to the https address.

### Hosted edition: create the platform owner

```bash
docker exec -it kubeez-backend node scripts/make-superadmin.js <username> <password> <email>
docker compose -f docker-compose.prod.yml restart backend
```

### Self-hosted: license

Without a license KubeEZ runs on the Free plan. An admin pastes a license key under **Settings → License** to unlock Pro / Enterprise (clusters, nodes and features of that plan).

### Update

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build backend frontend
```

Data in the `kubeez-data` volume is kept. Check [CHANGELOG.md](CHANGELOG.md) for what changed.

---

## 6. After the first start

1. Sign in as the first administrator (or the platform owner).
2. **Alerts** — add at least one channel (Telegram, Slack, Teams, WhatsApp, email or webhook).
3. **Gateway Agents** — install one in every network KubeEZ cannot reach directly.
4. **Team & Roles** — invite your team.
5. **AI settings** — connect an AI engine if you want KubeEZ AI (OpenRouter sign-in, a cloud API key, or an offline model).
6. **Delivery** — add environments and chart repositories if you will ship apps with KubeEZ.
7. **Features** — turn off what your team will not use.

---

## 7. Operating the KubeEZ server

| Task | How |
|---|---|
| Back up KubeEZ itself | It keeps daily config backups; also back up the `kubeez-data` volume **and** your `APP_SECRET` together. |
| Reset a password when nobody can sign in | `docker exec -it kubeez-backend node scripts/reset-password.js <username> <new-password>` |
| See logs | `docker compose -f docker-compose.prod.yml logs -f backend` |
| Health | `GET /api/health` |
| Move to a new server | Copy the `kubeez-data` volume and `.env` (same `APP_SECRET`), then start as above. |

**Limits to know:** KubeEZ stores its state in JSON files (written atomically, credentials encrypted), so one installation runs as **one backend instance** — it does not scale horizontally. The browser Content-Security-Policy header is not enabled yet; put KubeEZ on its own domain.

More: [DEPLOY.md](DEPLOY.md) · [TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [SUDO_SETUP.md](SUDO_SETUP.md) · [MULTI_SITE_SETUP.md](MULTI_SITE_SETUP.md)
