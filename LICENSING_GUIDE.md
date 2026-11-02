# KubeEZ Licensing Guide

*Version 2.3.0 · November 2026.* How self-hosted licenses work, how the vendor issues them, and how a customer activates one. The hosted edition (`KUBEEZ_MODE=saas`) does not use license keys — workspaces subscribe through billing.

---

## 1. What a license does — and does not do

| | Controlled by |
|---|---|
| **How many clusters and nodes** the self-hosted server may manage | **The license** (instance-wide) |
| **Which features** a workspace may use (Free vs Pro / Enterprise features) | The workspace owner's **subscription plan**, not the license |

Without a license a self-hosted server allows **1 cluster and 2 nodes**. An expired license blocks deploying and scaling until a valid one is activated (clusters keep running).

> **Known gap:** activating a license does not change the workspace's subscription plan. On a self-hosted server the platform owner (`superadmin`) passes every plan check, but other members — and Pro background checks such as GitOps alerts, CVE alerts, Helm drift and certificate alerts — follow the owner's plan, which is Free by default. Until this is fixed, self-hosted Pro features fully work only for the platform owner.

---

## 2. How it works

- Licenses are **RS256-signed JWTs** (2048-bit RSA).
- The **vendor** keeps the private key and signs licenses with it.
- Each KubeEZ server verifies a license **offline** with the vendor's public key at `backend/data/public.pem` (inside the container: `/app/data/public.pem`).
- A license may be **bound to one server** by its **System ID** (shown under **Settings → License Status**). A bound license is refused on any other server.

A license carries: `plan` (a name such as `PRO`, `ENTERPRISE`, `EVALUATION`), `maxClusters`, `maxNodes`, an expiry, and optionally `systemId`.

---

## 3. For the vendor: create the keys (once)

```bash
cd backend
npm install
node scripts/license-generator.js generate-keys
```

This writes `backend/scripts/vendor-keys/private.pem` (**keep it secret, never commit it, never ship it**) and `backend/scripts/vendor-keys/public.pem` (ship this one).

Give every customer server the public key at `data/public.pem`, e.g. for the production compose:

```bash
docker cp backend/scripts/vendor-keys/public.pem kubeez-backend:/app/data/public.pem
```

Without it, activation answers "Missing Public Key for License Verification".

---

## 4. For the vendor: issue a license

### From the command line

```bash
node scripts/license-generator.js create-license <PLAN> <MAX_CLUSTERS> <MAX_NODES> <VALIDITY_DAYS>

node scripts/license-generator.js create-license ENTERPRISE 50 500 365   # 1 year, 50 clusters, 500 nodes
node scripts/license-generator.js create-license EVALUATION 2 10 30      # 30-day evaluation
```

Defaults: `PRO 5 25 365`. Licenses from the command line are **not bound** to a System ID.

Without Node.js on your machine:

```bash
docker run --rm -v "$(pwd)/backend:/app" -w /app node:22-alpine \
  sh -c "npm install --omit=dev >/dev/null && node scripts/license-generator.js create-license ENTERPRISE 50 500 365"
```

(PowerShell: `${PWD}` instead of `$(pwd)`.)

### From the vendor portal (bound to a server)

On a KubeEZ server that has `backend/scripts/vendor-keys/private.pem`, the platform owner opens **`/vendor-portal`**, enters the plan, limits, validity and the customer's **System ID**, and generates the key. The license works only on that server.

The output is a long string starting with `eyJhbGciOiJSUzI1Ni…` — send it to the customer.

---

## 5. For the customer: activate

1. Make sure `data/public.pem` is in place (from the vendor).
2. Sign in as the **platform owner** — the first user created on the server (role `superadmin`). Admins of a workspace cannot activate.
3. **Settings** → **Activate License Key** → paste the key → **Activate**.
4. **License Status** shows the plan, the limits, the expiry and the System ID.

| Message | Meaning |
|---|---|
| "Super Admin access required" | Sign in as the platform owner. |
| "Missing Public Key for License Verification" | `data/public.pem` is missing. |
| "License Key is bound to a different System ID" | The key was made for another server — send the vendor this server's System ID. |
| "This license key has expired" | Ask the vendor for a new key. |
| "Invalid or corrupted License Key" | The key was cut off when copying, or signed with another private key. |

---

## 6. Moving a server

The System ID lives in `data/system.json`. Moving the whole `data` volume keeps it, so a bound license keeps working. A new, empty data directory gets a new System ID and needs a new bound license.
