# KubeEZ User Guide

*Version 2.3.0 · November 2026.* This guide walks through KubeEZ task by task. The same guide, with search, is built into the console under **Help → Docs**.

---

## Contents

1. [What KubeEZ is](#1-what-kubeez-is)
2. [Finding your way](#2-finding-your-way)
3. [Your first cluster](#3-your-first-cluster)
4. [Connecting a cluster you already run](#4-connecting-a-cluster-you-already-run)
5. [Day-to-day cluster work](#5-day-to-day-cluster-work)
6. [Add-ons](#6-add-ons)
7. [Backups and recovery](#7-backups-and-recovery)
8. [Auto-healing, incidents and alerts](#8-auto-healing-incidents-and-alerts)
9. [KubeEZ AI](#9-kubeez-ai)
10. [Shipping apps](#10-shipping-apps)
11. [GitOps](#11-gitops)
12. [Security, certificates and metrics](#12-security-certificates-and-metrics)
13. [Team, roles and approvals](#13-team-roles-and-approvals)
14. [Compliance](#14-compliance)
15. [Features and plans](#15-features-and-plans)
16. [When something goes wrong](#16-when-something-goes-wrong)

---

## 1. What KubeEZ is

KubeEZ installs, upgrades, backs up and heals Kubernetes clusters on your own servers, and helps your team ship apps to them — from one web console. It can also take in clusters you already run (EKS, AKS, GKE, k3s, OpenShift and others) without reinstalling them.

Every job shows a live log. When something fails you see the reason and the fix, not a stack trace.

---

## 2. Finding your way

Every page is in the sidebar once, grouped by what you want to do:

| Group | What is there |
|---|---|
| **Home** — Clusters · Incidents · Compliance | Every cluster with health, nodes, version and add-ons; problems auto-healing found; scores, findings, reports and the audit trail. |
| **Cluster · *name*** — Overview · Explorer · Apps · GitOps · Security · Certificates · Delivery metrics · Add-ons · Backups | The sections of the cluster you opened last, one click each. Click the heading to switch to another cluster on the same section. A number on **Security** counts critical vulnerabilities you have not seen yet; on **Certificates**, certificate problems you have not seen (red: expired or failing, amber: expiring within 14 days). Opening the tab clears it; a new problem — or a certificate getting worse — brings it back. Hover for the total. Seen is per person; the numbers come from the last check, refreshed every 15 minutes. |
| **Add & connect** — Deploy new cluster · Existing clusters · Gateway agents | The install wizard; clusters you already run (with tabs for adding one, its connection agents and setup guides); agents that reach servers in a private network. |
| **AI** | Ask AI, Fleet, Create YAML, Advisor, What changed, AI settings. |
| **Workspace** — Delivery settings · Team & Roles · Approvals · Alerts · Settings · Features | How your team ships apps, and workspace administration. |
| **Help** — Docs · Plans | The built-in guide and what each plan includes. |

The arrow next to a group heading folds it (remembered in this browser); a folded group still shows the page you are on. On a phone the cluster's sections are also tabs at the top of the cluster page.

Press **Ctrl + K** (**⌘K** on a Mac) anywhere to jump to a cluster or a page. The bell in the top bar shows open incidents. The sun / moon button switches between the light **Zen** theme and the **Dark** theme.

---

## 3. Your first cluster

### What the servers need

| | |
|---|---|
| OS | Ubuntu 22.04 / 24.04, Debian 12, Rocky Linux 9, AlmaLinux 9, Fedora, Amazon Linux 2023, RHEL 8 / 9 (CentOS 7 / RHEL 7 up to Kubernetes 1.34) |
| Control plane | 2 vCPU, 4 GB RAM recommended |
| Workers | 2 vCPU, 2 GB RAM minimum |
| Disk | 20 GB or more (2 GB free on `/var` for upgrades) |
| Network | Outbound HTTPS; servers reach each other on 6443, 10250 and 30000–32767 |
| Login | root or a sudo user over SSH (port 22) |

On the hosted edition, servers in a private network are reached through a **Gateway Agent**: Add & connect → Gateway agents → **Generate Token** → run the one-line installer on any machine in that network. It connects out, so you open no firewall ports.

### Deploy

1. **Deploy new cluster** in the sidebar.
2. Add control-plane and worker servers (IP, SSH user, password or key — you can import a key file). KubeEZ checks each one: connection, OS, CPU, memory, ports.
3. Pick the Kubernetes version (1.27 – 1.37) and the network plugin (Flannel or Calico).
4. Choose add-ons. Nginx Ingress and the KubeEZ Explorer are selected for you; **Customize** changes an add-on's settings before install.
5. Review and start. If a step fails, the screen says why, with **Auto-Fix & Resume** where possible.

**High availability:** with 2 or more control-planes, enter a free **virtual IP** in their network. kube-vip moves it to another control-plane within seconds if one dies. Use **3 control-planes** for real HA.

---

## 4. Connecting a cluster you already run

Sidebar → **Existing clusters → Add existing cluster**. Pick where it runs and the provider, choose the access, then run the command shown wherever `kubectl` already works for that cluster.

| Way in | When to use it |
|---|---|
| **KubeEZ agent** (recommended) | A small agent in `kubeez-system` connects out over HTTPS. Works for private endpoints, firewalls and on-prem behind NAT. |
| **Connect command** | A script creates KubeEZ's own ServiceAccount and sends only the API address, CA and its token. Your cloud CLI login never leaves your machine. |
| **Paste a kubeconfig** | Used once to create KubeEZ's own login, then forgotten. |

**Read-only** (default) watches, alerts and advises and never reads Secrets. **Full manage** also installs add-ons, runs fixes and backups, applies YAML and opens the terminal. With a cloud account (EKS, AKS, GKE, OKE, DOKS, LKE) KubeEZ also resizes node pools and upgrades Kubernetes. On-prem clusters can get **SSH** for etcd snapshots, upgrades and node shells (kubeadm).

---

## 5. Day-to-day cluster work

Open a cluster. The buttons at the top act on the whole cluster; the tabs hold the details.

| Tab | |
|---|---|
| Overview | Version, nodes, health score, live CPU / memory / disk |
| Explorer | Every resource, YAML, logs, events, topology, timeline |
| Apps | Helm releases and day-2 operations (see [Shipping apps](#10-shipping-apps)) |
| GitOps | Argo CD and Flux apps |
| Security · Certificates | Trivy findings; cert-manager certificates |
| Delivery | DORA metrics |
| Add-ons | Logins, health, logs, settings, updates |
| Backups | Snapshots, offsite, volumes, recovery |

- **Kubeconfig:** admins get the admin kubeconfig; everyone else gets their own 24-hour kubeconfig that can do exactly what their role allows.
- **Terminal:** a cluster terminal (kubectl, helm) and a shell per node. Access can be time-limited and is recorded.
- **Scale:** add workers. **Upgrade:** one minor version at a time, after a safety check (removed APIs, version skew, disruption budgets) and an automatic etcd snapshot.
- **Resume:** a stopped install continues; finished steps are skipped.
- **Remove:** removes the cluster from KubeEZ only — the cluster keeps running.

---

## 6. Add-ons

30 add-ons: Nginx Ingress, Prometheus + Grafana, Kubernetes Dashboard, cert-manager, Longhorn, Argo CD, S3 (SeaweedFS), Velero, KubeEZ Explorer, Metrics Server, MetalLB, Loki, Sealed Secrets, External Secrets, Argo Rollouts, KEDA, Kyverno, NFS storage, volume snapshots, Elasticsearch + Kibana, Fluentd, Fluent Bit, Harbor, Flux CD, Jenkins, Vault, OPA Gatekeeper, Falco, Trivy Operator and KubeEZ AI.

- **Access & logins** shows addresses, users and passwords (admins and operators only).
- **Manage & logs**: health, logs, repair, reinstall, uninstall.
- **Settings**: a form for each add-on (and advanced Helm values on Pro), with a preview, history and automatic rollback.
- **Updates**: new versions are found every 12 hours and announced; nothing updates until you choose.

---

## 7. Backups and recovery

| | |
|---|---|
| **Cluster snapshots** | etcd snapshots, verified; a restore first shows what it changes, rolls back by itself if it fails, and can be undone (HA clusters too). |
| **Volume backups** | Velero backups of your app data. |
| **Offsite backups** | Encrypted copies to any S3 (AWS, R2, B2, Wasabi, MinIO) with a key you hold. |
| **Disaster recovery** | Rebuild a lost control-plane from the offsite backup on a new server with the same IP. |
| **Config backups** | KubeEZ's own data, daily. |

---

## 8. Auto-healing, incidents and alerts

KubeEZ checks nodes, the control plane, certificates, disks, pods, workloads, volume claims and jobs every 1–2 minutes. Known problems are fixed automatically and verified; the rest are explained with evidence. It warns before things break: disk-full forecasts, CPU / memory above 90 % for 15 minutes.

Per problem type you choose **fix**, **alert only** or **off**; **maintenance mode** pauses a cluster.

**Alerts** go to Telegram, Slack, Microsoft Teams, WhatsApp (Twilio), email or webhooks, with routing per channel, quiet hours, cooldown and escalation. Act from the alert: Acknowledge / Mute / Fix now in Telegram, signed links elsewhere. Other alerts: GitOps sync failures, new fixable critical CVEs, Helm drift, failing or expiring certificates, scheduled hibernate problems, agents going offline.

---

## 9. KubeEZ AI

Connect an AI under **AI settings → Connect AI**: **Sign in with OpenRouter** (no key to copy), a cloud API key (OpenAI, Anthropic, Gemini, Groq…), or an offline model (Ollama, LM Studio, vLLM… — also inside your own cluster). KubeEZ adds no cost of its own.

- **Ask AI** — ask in English, Hindi or Hinglish ("sab theek hai?", "web-2 ka log check karo"). KubeEZ reads the cluster live and the AI answers from that. Fixes are previewed (dry-run) before they run.
- **Explain** on incidents and GitOps apps, **Install Doctor** for failed installs, **What changed**, **Create YAML**, **Fleet**, **Advisor** (security and cost).
- **ChatOps**: the same in a Slack or Telegram channel, after an admin turns it on.
- Secrets are masked before anything goes to the AI. AI access is given per member by an admin.

---

## 10. Shipping apps

### Delivery settings (sidebar → Workspace → Delivery settings)

| | |
|---|---|
| **Environments** | A name for a namespace on a cluster. Per environment: protected, CVE gate, signature policy, auto-rollback. |
| **Chart repositories** | Where apps may be deployed from (https or oci://). |
| **Change freezes** | No changes on the covered clusters until the end time; admins may override with a reason. |
| **Compare & promote** | Values that differ between two environments; promote the chart version and chosen values. |
| **Registries · Signing keys · Cost prices** | Pull secrets, cosign keys, prices for Cost per app. |

### Install or upgrade (cluster → Apps)

1. **Install an app** (or **Upgrade** on a release). Pick the repository, chart, version and values.
2. **Preview changes** — a server-side dry run listing every resource added, changed or removed, plus the CVE and signature checks.
3. **Assess risk** (Pro) — a 0–100 score with its reasons, and the AI's view of what could go wrong and what to check.
4. **Install / Upgrade.** Helm waits for the pods and rolls a failed upgrade back by itself.

**Check drift** (Free) shows what was changed by hand since Helm deployed a release; **Restore** applies the deployed revision again.

### From CI

Delivery → **Deploy tokens** creates a token for one release. Your pipeline calls:

```bash
curl -fsS -X POST https://<your-kubeez>/api/hooks/deploy \
  -H "Authorization: Bearer $KUBEEZ_TOKEN" -H "Content-Type: application/json" \
  -d '{"set": {"image.tag": "'"$GIT_SHA"'"}, "commit": {"sha": "'"$GIT_SHA"'", "time": "'"$(git log -1 --format=%cI)"'"}}'
```

A token made with **Previews too** can also start a **preview environment** per pull request (`POST /api/hooks/preview {"pr": 42, …}`) and remove it when the PR closes (`DELETE`). Previews also expire by themselves (default 72 hours).

### From chat

An admin allows an app for a Slack / Telegram channel (Delivery → **Deploy from chat**). In the chat: `deploy web 1.4.2 to staging`, then the same person replies `confirm 4821` within 5 minutes.

### Guards that always apply

Protected environments need a second person; freezes stop changes; the **CVE gate** and the **image signature gate** (cosign) check every image — on the Apps tab, CI, previews, promotions and chat alike.

### Day-2 operations (cluster → Apps, below the releases)

Hibernate / Wake a namespace (also on a schedule), debug containers, canary rollouts (Argo Rollouts), KEDA autoscaling, app metrics and cost per app.

---

## 11. GitOps

Cluster → **GitOps** lists Argo CD Applications and Flux Kustomizations / HelmReleases with sync, health, revision and drift. **Sync now** and **Refresh** ask the tool to do its own job; KubeEZ never prunes.

- **New app** (Free): from a public https repository, into one namespace — with Argo CD (own AppProject) or Flux (own namespace-only ServiceAccount).
- **Remove** (admins): deletes the app **and everything it deployed** from the cluster — Argo CD / Flux clean up first, the namespace stays. Decline the first question to remove only the app and keep its workloads running.
- **Promote by pull request** (Pro, Delivery page): add a GitHub, GitLab or Bitbucket account, then change values in a YAML file; KubeEZ opens the pull / merge request.

---

## 12. Security, certificates and metrics

- **Security** — Trivy Operator findings per workload, with the fixed versions; alerts for new fixable critical CVEs; External Secrets sync status.
- **Certificates** — cert-manager certificates (expired, failing, expiring within 14 days first), issuers, stuck ACME challenges; **Renew now**; alerts at 14 / 7 / 3 / 1 days.
- **Delivery** — DORA: deployment frequency, change failure rate, recovery time, lead time for changes.

---

## 13. Team, roles and approvals

| Role | Can do |
|---|---|
| Admin | Everything in the workspace |
| Operator | Deploy, scale, upgrade, manage add-ons and apps, act on incidents |
| Viewer | Read-only; never passwords or tokens |

Pro adds **custom roles**, a different role **per cluster or cluster label**, **namespace-only** access, **two-person approvals** for dangerous actions, **temporary access** with a countdown, and an **access review** CSV. People can sign in with a username or email, Google / GitHub, or your company **SSO** (OpenID Connect).

---

## 14. Compliance

A live scan of each cluster mapped to **CERT-In 2022**, the **DPDP Act 2023 & Rules 2025**, **ISO/IEC 27001:2022** and **CIS** (kube-bench): 29 controls with evidence and fixes, scores and history, a sealed PDF report, monthly reports, and a pre-filled CERT-In incident report. A tamper-evident audit trail keeps every change and sign-in for 400 days.

---

## 15. Features and plans

**Plan & usage** (sidebar → Help) shows your plan, the Pro trial's days left, how much of each limit you use, and every feature with ✓ (you can use it) or 🔒 Pro. The top bar shows "Pro trial · N days left" or "Free · Upgrade".

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

- **Pro trial:** every new hosted workspace gets 14 days of Pro — every feature and Pro limits, no card. Afterwards it is Free; nothing is deleted, but you cannot add beyond the Free limits and Pro sections show an upgrade card.
- **When the trial ends** you cannot miss it: in its last 3 days a banner says when it ends and what gets locked (once a day); on the day after, a banner says it ended, what is locked now and whether the workspace is over a Free limit (those clusters keep running; nothing more can be added) — with **Upgrade to Pro**. The top bar then shows **Trial ended · Upgrade**.
- **On Free**, a Pro section shows a **Pro** card with what it does and **Upgrade to Pro**, instead of its content; a Pro button (Assess risk, a deploy token…) explains the upgrade when clicked. The server checks every one of them too.
- **Pro and Enterprise include every feature** — Enterprise differs only in quantities and support.

Admins can turn newer features off for the workspace under **Features**.

---

## 16. When something goes wrong

| You see | What to do |
|---|---|
| SSH connection refused | Install and start `openssh-server` on that server. |
| Gateway Agent offline | Check the machine is up; run the install command again. |
| Install stopped midway | **Resume installation**. |
| Add-on failing | Add-ons → Manage & logs → Logs, fix, then **Repair**. |
| Upgrade blockers | Open the report, fix the listed resources, retry. |
| 423 change freeze | Wait, or an admin overrides with a reason. |
| 428 needs approval | A second person approves on **Approvals**. |
| Deploy blocked by CVE / signature policy | Fix or sign the image, add the signing key, or an admin overrides. |
| "turned off" / "part of the Pro plan" | Features page, or upgrade the plan. |

More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and **Help → Docs → Troubleshooting**.
