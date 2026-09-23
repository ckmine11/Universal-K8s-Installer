# KubeEZ Enterprise Licensing Guide

This document explains how to generate secure, cryptographically signed JSON Web Tokens (JWT) for your KubeEZ enterprise clients.

## 1. Prerequisites

The KubeEZ licensing system uses a secure 2048-bit RSA Asymmetric cryptography system.
- **Private Key**: Used *only* by you (the Vendor) to generate licenses. Keep this secure!
- **Public Key**: Bundled with the KubeEZ application to verify the license.

Your keys are located at:
- `backend/scripts/vendor-keys/private.pem` (Keep Secret)
- `backend/data/public.pem` (Given to Application)

## 2. Generating a License Key

Whenever a customer purchases a plan, you will generate a license token for them using the `license-generator.js` script.

### Using Docker (Recommended)
You can run the script via Docker from the root of your project:

```bash
docker run --rm -v "$(pwd)/backend:/app" -w /app node:18-alpine sh -c "node scripts/license-generator.js create-license [PLAN] [CLUSTERS] [NODES] [DAYS]"
```
*(Note for Windows users: Replace `$(pwd)` with `%cd%` in CMD or `${PWD}` in PowerShell)*

### Using Node.js Locally
If you have Node.js installed on your machine, run:

```bash
cd backend
npm install
node scripts/license-generator.js create-license [PLAN] [CLUSTERS] [NODES] [DAYS]
```

## 3. Command Arguments

| Argument | Description | Example |
| :--- | :--- | :--- |
| `[PLAN]` | The name of the plan (e.g. PRO, ENTERPRISE, EVALUATION) | `ENTERPRISE` |
| `[CLUSTERS]` | Maximum number of Kubernetes clusters the client can manage | `50` |
| `[NODES]` | Maximum number of total worker/master nodes across all clusters | `500` |
| `[DAYS]` | Number of days until the license expires | `365` |

## 4. Examples

### Generate a 1-Year Enterprise License (50 Clusters, 500 Nodes)
```bash
node scripts/license-generator.js create-license ENTERPRISE 50 500 365
```

### Generate a 30-Day Evaluation License (2 Clusters, 10 Nodes)
```bash
node scripts/license-generator.js create-license EVALUATION 2 10 30
```

## 5. Activating the License

1. Running the command above will output a very long string starting with `eyJhbGciOiJSUzI1Ni...`.
2. Copy this entire string.
3. Send this string to your customer.
4. The customer logs into their KubeEZ Instance as an **Admin**.
5. They go to **Settings > Licensing & Plans**.
6. Paste the token into the **Activate License Key** input field and click **Activate**.

Their local KubeEZ instance will instantly verify the RSA signature and upgrade their server quotas offline.
