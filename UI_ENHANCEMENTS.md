# The KubeEZ Console — UI Guide

*Version 2.3.0 · November 2026.* How the console is laid out, the patterns every screen follows, and where the UI code lives. For what each feature does, see [USER_GUIDE.md](USER_GUIDE.md).

---

## 1. Layout

```
┌──────────────┬──────────────────────────────────────────────────────┐
│  Sidebar     │  Top bar: ☰ (phone) · search (Ctrl+K) · ✦ updates ·  │
│  (grouped)   │           🔔 incidents · theme · account               │
│              ├──────────────────────────────────────────────────────┤
│              │  Page header: eyebrow · title · one-line description │
│              │  Cards (kz-card) with the page's content              │
└──────────────┴──────────────────────────────────────────────────────┘
```

| Sidebar group | Pages |
|---|---|
| (top) | Clusters, Explorer, Incidents, Compliance |
| Cluster · *name* | The open (or last opened) cluster's sections — Overview, Apps, GitOps, Security, Certificates, Delivery metrics, Add-ons, Backups — each opens that tab; "Choose a cluster" until one was opened |
| AI | Ask AI, Fleet, Create YAML, Advisor, What changed, AI settings |
| Connected clusters | Add existing cluster, Connected clusters, Connection agents, Setup guides |
| Build | Deploy cluster, Gateway Agents, Delivery |
| Workspace | Team & Roles, Approvals (with a badge of waiting requests), Alerts, Settings, Features |
| Help | Docs, Plans |
| Platform | Admin Console (platform owner only) |

Items a member may not use are not shown. On phones the sidebar opens from the ☰ button.

### The cluster page

Buttons at the top act on the whole cluster (Kubeconfig, Terminal, Scale, Upgrade); tabs hold the details: **Overview, Explorer, Apps, GitOps, Security, Certificates, Delivery, Add-ons, Backups**. A tab appears only when the member has its permission and its feature is on. The open tab is in the URL (`?tab=apps`), so links from alerts land on the right place.

---

## 2. Themes

| Theme | Look |
|---|---|
| **Zen** (default) | Warm off-white, acid-lime accent, monospace headings |
| **Dark** | Near-black, neutral ("Midnight") |

The sun / moon button in the top bar switches them. The choice is kept per browser (`localStorage` key `kz-theme`) and applied before the first paint, so a page never flashes the other theme. Code: `frontend/src/utils/theme.js`.

---

## 3. Patterns every screen follows

| Pattern | What the user sees |
|---|---|
| **Preview before change** | Install / upgrade dialogs show a dry-run diff (added / changed / removed, line by line); add-on settings show what changes; restores show what they will restore. |
| **Jobs, not spinners** | Long work (installs, upgrades, Helm deploys) runs as a job with a live log or a status bar that polls; leaving the page does not stop it. |
| **Reason + fix** | Every error says what happened and what to do; HTTP errors from the API are shown as their message, never as raw JSON. |
| **Guards are visible** | A change freeze shows a blue banner (admins get a field for the override reason); a protected environment is marked with a lock; CVE and signature results appear inside the preview, with ✓ / ✗ per image. |
| **Approvals** | A protected action opens a dialog asking why, then waits on **Approvals** (`428`). |
| **Plans and features** | A Pro feature on a Free workspace shows an upgrade notice instead of the action; a feature turned off is simply not shown. |
| **Secrets** | Passwords and tokens are masked (`••••••`), shown once when created (deploy tokens), and never sent back by the server. |
| **Confirm the irreversible** | Uninstall, remove, revoke and restore ask for confirmation in words that say what happens. |
| **Search and filters** | Long lists (releases, apps, certificates, findings) have a search box and filter chips; problems sort first. |

---

## 4. Accessibility

- Buttons that are icons only carry an `aria-label`; tabs use `role="tab"` with `aria-selected`; dialogs use `role="dialog"` and `aria-modal`.
- State is never shown by colour alone: levels are words (Elite / High / Medium / Low, Valid / Expiring / Failing) with colour as a hint.
- Everything works with the keyboard; **Ctrl + K** (⌘K) opens the command palette.

---

## 5. Where the code lives

```
frontend/src/
  App.jsx                       routes
  components/shell/             AppShell (sidebar, top bar), CommandPalette, UpgradeNotice, ApprovalGate
  pages/                        one file per page (Clusters, ClusterDetails, DeliverySettings, Docs, …)
  components/apps/              Apps tab: releases, deploy dialog (preview, risk), drift, operations panels
  components/gitops/            GitOps tab
  components/security/          Security and Certificates tabs
  components/delivery/          DORA tab
  components/ai/                Ask AI, AI settings, ChatOps
  config/permissions.js         the role → permission map (display only; the API enforces it)
  config/features.js            useFeatures(): which features are on for the workspace
  context/AuthContext.jsx       apiFetch (session cookie) and the signed-in user
  utils/theme.js                themes
```

Shared CSS classes: `kz-card`, `kz-input`, `kz-btn-primary`, `kz-btn-ghost` (Tailwind on top). Icons: `lucide-react`.

---

## 6. Adding a screen

1. Add the page under `pages/` (or a tab component under `components/<area>/`) and its route in `App.jsx`.
2. Add it to the sidebar in `AppShell.jsx` or to the `TABS` list in `ClusterDetails.jsx`, with its `permission` and `feature`.
3. Call the API with `apiFetch`; show the server's error message; follow the patterns above.
4. Document it in the in-app guide (`pages/Docs.jsx`) and in [USER_GUIDE.md](USER_GUIDE.md).
5. `npm run build` must pass (there are no frontend unit tests yet).
