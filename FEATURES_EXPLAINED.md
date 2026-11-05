# KubeEZ Features Explained

*Version 2.3.0 · November 2026.* For each feature: **what it is**, **how it works**, and **when it helps**. For step-by-step use see [USER_GUIDE.md](USER_GUIDE.md); the full guide is built into the console under **Help → Docs**.

> Plans: **(Free)** = every workspace. **(Pro)** = included in Pro and Enterprise; on Free it shows an upgrade card. New hosted workspaces get 14 days of Pro. Free: 1 cluster, 5 nodes, 1 member — Pro: 10, 50, 5.

| | Free | Pro / Enterprise |
|---|---|---|
| Clusters · nodes · team members | 1 · 5 · 1 | Pro 10 · 50 · 5; Enterprise as agreed |
| Deploy, upgrade, scale, connect existing clusters, auto-healing, Ask AI | ✓ | ✓ |
| Apps (Helm) with drift check; GitOps view, sync and new apps | ✓ | ✓ |
| Security scans, certificates, DORA, app metrics, costs, hibernate | ✓ | ✓ |
| Registry pull secrets, debug containers | ✓ | ✓ |
| Add-ons | Dashboard, Metrics Server, KubeEZ AI, Explorer, Ingress, cert-manager, Trivy, Argo CD, Flux | All 30, plus advanced settings |
| Alerts | 1 channel (Telegram, email or webhook), critical only | Every channel, rules; CVE, certificate and GitOps alerts |
| Deploy guards (CVE gate, signatures, deploy risk, auto-rollback) | — (the preview says what the CVE gate would stop) | ✓ |
| Pipelines (deploy tokens, previews, promote by PR, promotion, deploy from chat) | — | ✓ |
| Rollouts, KEDA, scheduled hibernate, External Secrets | — | ✓ |
| Custom roles, two-person approval, compliance reports, backups | — | ✓ |

---

## 1. Building and running clusters

### Deploy (Free)
**What:** a production Kubernetes cluster on your own servers, from a wizard.
**How:** KubeEZ first checks each server (SSH, OS, CPU, memory, ports), then runs idempotent scripts over SSH and streams a live log of every step. A failure shows its reason and the fix.
**High availability:** 3 control-planes behind a **virtual IP** (kube-vip). If one server dies, another takes the IP within seconds.
*Example:* 3 Ubuntu control-planes + 2 workers → an HA cluster in about 20 minutes.

### Upgrade (Free)
One minor version at a time (1.35 → 1.36). First a **safety check** (removed APIs, version skew, blocking disruption budgets), then an automatic **etcd snapshot**, then the upgrade. If it fails: retry, or restore the "Before upgrade" snapshot.

### Resume (Free)
An install stopped midway? **Resume** — finished steps are skipped.

### Connect an existing cluster (Free)
**What:** bring a cluster you already run (EKS, AKS, GKE, k3s, OpenShift…) into KubeEZ without reinstalling it.
**How:** a small **KubeEZ agent** inside the cluster connects out over HTTPS (no ports to open), or a connect command creates KubeEZ's own ServiceAccount. Your cloud login never reaches KubeEZ.
**Read-only** = watch and alert. **Full manage** = add-ons, fixes, backups and the terminal too. With a cloud account, node pools and Kubernetes upgrades as well.

### Gateway Agent (Free)
A small program for servers in a private network. It connects **out** to KubeEZ, so you open nothing in the firewall.

---

## 2. Add-ons (Free / Pro)
Free: Dashboard, Metrics Server, KubeEZ AI, Explorer, Ingress, cert-manager, Trivy, Argo CD and Flux — everything the Free features need. Pro: all 30 and advanced settings.

30 ready add-ons — monitoring (Prometheus + Grafana, Loki), storage (Longhorn, NFS, S3), security (Trivy, Falco, Kyverno, Vault, Gatekeeper), GitOps (Argo CD, Flux), delivery (Argo Rollouts, KEDA), logging (Elasticsearch, Fluentd, Fluent Bit) and the KubeEZ Explorer.
**Every add-on has settings** in a form, a preview before a change and an automatic rollback if it goes wrong. New versions are found every 12 hours, but an add-on is updated only when **you** choose.

---

## 3. Backups (Pro)
| Feature | What it means |
|---|---|
| Cluster snapshot | A verified etcd backup. A restore first shows what it changes, rolls itself back if it fails, and can be undone. |
| Volume backup | Your apps' data (PVCs) with Velero. |
| Offsite backup | An encrypted copy on any S3 — you hold the key. |
| Disaster recovery | The control-plane server is gone? Rebuild it from the offsite backup on a new server with the same IP. |

---

## 4. Auto-healing and alerts

### Auto-healing (Free)
Every 1–2 minutes: nodes, control plane, certificates, disks, pods, workloads, volume claims, jobs. Known problems are **fixed automatically** (and verified); the rest come with a **reason and evidence**. It also warns early: "disk full in ~9 hours", "CPU above 90 % for 15 minutes".

### Alerts (Free: 1 channel · Pro: all)
Telegram, Slack, Teams, WhatsApp, email, webhooks. Quiet hours, routing, escalation. **Acknowledge / Mute / Fix now** buttons right in Telegram.

---

## 5. KubeEZ AI (Free)
**What:** ask about your clusters directly — in English, Hindi or Hinglish ("is everything ok?", "how many namespaces?", "check the logs of web-2"). Answers are always in clear English.
**How:** KubeEZ reads the cluster live (pods, logs, events, exact counts) and hands that data to the AI your workspace connects. You bring the AI: **Sign in with OpenRouter**, an OpenAI / Claude / Gemini key, or an offline model (Ollama, vLLM) — even inside your own cluster.
**Safety:** secrets are masked; a fix the AI suggests runs as a **dry run** first, then with your permissions and approvals.
Also: "Explain" on incidents, Install Doctor, What changed, Create YAML, Fleet, Advisor, ChatOps in Slack / Telegram.

---

## 6. Shipping apps

### Helm apps (Free)
Cluster → **Apps**: install, upgrade and roll back your own Helm releases. **Preview** first — a server-side dry run lists every resource that is added, changed or removed, line by line. Secrets show as ••••••.

### Environments, freezes, promotion (Free / Pro)
- **Environment** = a name for a namespace on a cluster (dev, staging, prod). A **protected** environment needs a second person to approve every deploy.
- **Change freeze**: no deploys during, say, a big sale; an admin may override with a written reason.
- **Compare & promote** (Pro): the values that differ between staging and prod; promote staging's version to prod in one click.
- **Auto-rollback** (Pro): an app breaks within an hour of a deploy → a rollback is suggested or done automatically.

### Deploy risk (Pro)
**Assess risk** before a deploy: a 0–100 score and its reasons — data removed, storage or networking changed, a chart major version jump, a production environment, earlier failures, open incidents in the namespace, vulnerable or unsigned images. On top, the AI explains what could break, what to check and how to undo it. The score does not depend on the AI.

### Helm drift (Free)
**What:** someone changed an app by hand with `kubectl edit` or `kubectl scale`? Drift shows **what** changed — what Helm deployed vs. what runs now.
**Restore** brings back the state Helm deployed. Checked every hour, with an alert for new drift. Replicas set by an HPA / KEDA are not counted as drift.

### CI webhook (Pro)
Deploy from GitHub Actions / GitLab CI / Jenkins with a **deploy token** that can change only **one** app and only the values it lists (such as `image.tag`). Send the commit and the DORA **lead time** is measured too.

### Preview environments (Pro)
A copy of the app for each pull request, in its own namespace (`web-pr-42`). When it expires (default 72 hours) or the PR closes, the whole namespace is deleted. KubeEZ only ever deletes preview namespaces it created.

### Deploy from chat (Pro)
In Slack / Telegram: `deploy web 1.4.2 to staging` → KubeEZ gives a code → the same person replies `confirm 4821` within 5 minutes → the deploy runs and the result is posted in the chat. Only the apps an admin allowed for that channel; protected environments and freezes always refuse.

### Deploy guards (Pro)
- **CVE gate:** an image with critical (or high) vulnerabilities → warn or block.
- **Signature gate (cosign):** an image not signed with your team's key → warn or block. KubeEZ reads the signature from the registry and verifies it itself.
Both apply on every path: the UI, CI, previews, promotions and chat. Only an admin with a written reason can push past a block.

### Day-2 operations
**Hibernate / Wake** (Free): scale a dev namespace to 0 at night and back in the morning — save money. **Schedule** (Pro): "every weekday 21:00 → 09:00". **Debug containers** (Free). **Canary rollouts** (Argo Rollouts), **KEDA autoscaling** (Pro).

---

## 7. GitOps
- **View & sync** (Free): Argo CD and Flux apps on one list — synced? healthy? **Sync now**.
- **Alerts** (Pro): a failed sync or an unhealthy app → an alert and an AI explanation.
- **New app** (Free): an Argo CD or Flux app from a Git repository — locked to **one namespace**, nothing cluster-wide.
- **Promote by pull request** (Pro): change a value in a YAML file on GitHub, GitLab or Bitbucket (such as `image.tag`) → KubeEZ opens a PR / MR → on merge, Argo CD / Flux deploy it.

---

## 8. Security and insight
- **Security tab** (Free): Trivy vulnerabilities per workload with the fixed version. Alerts for new fixable critical CVEs (Pro).
- **Certificates tab** (Free): cert-manager certificates — days left, which fail and why; **Renew now**. Alerts 14 / 7 / 3 / 1 days before expiry (Pro).
- **DORA** (Free): how often you deploy, how many fail, time to recover, time from commit to production.
- **Cost per app** (Free): the monthly cost of each namespace and app, and how much money sits idle.

---

## 9. Team and compliance
- **Roles** (Free): Admin / Operator / Viewer. Viewers never see passwords.
- **Pro:** custom roles, a different role per cluster, namespace-only access, **two-person approval**, temporary access, an access-review CSV.
- **Sign-in:** username or email, Google / GitHub, or your company **SSO** (OpenID Connect).
- **Compliance** (Free scan · Pro reports): CERT-In, DPDP, ISO 27001, CIS — evidence, scores, a sealed PDF, a CERT-In incident report. A **tamper-evident audit trail** (400 days).

---

## 10. Features on / off
An admin can turn any newer feature off for the workspace on the **Features** page; whoever runs the server uses `KUBEEZ_FEATURES`. A feature that is off disappears from the UI and its background checks stop.

---

## Good to know
- Features added on or after 30 October 2026 (from Helm apps to certificates) are covered by automated tests with simulated clusters; they have not yet been run against real clusters.
- KubeEZ keeps its data in JSON files — one installation runs one backend server.
