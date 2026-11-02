# KubeEZ Testing Guide

*Version 2.3.0 · November 2026.* What is tested, how to run it, how to write a new test, and how to check a release by hand.

---

## 1. The test layers

| Layer | Where | What it proves | Time |
|---|---|---|---|
| **Backend tests** | `backend/tests/*.test.js` (71 files, ~750 tests) | API gates for every role, services, safety rules — with fake clusters | ~45 s |
| **Frontend build** | `frontend` (`npm run build`) | The console compiles (there are no frontend unit tests yet) | ~30 s |
| **Script syntax** | every `*.sh` under `backend/src/automation` and `tests` | `bash -n` parses each script | seconds |
| **Upgrade-script scenarios** | `tests/upgrade-script/` | `upgrade-cluster.sh` on failure and happy paths (stubbed commands) | ~3 min |
| **End-to-end** | `tests/e2e/e2e.sh` | Real kubeadm clusters in privileged systemd containers on 7 distros | 5–30 min each |

---

## 2. Backend tests

```bash
cd backend
npm install
npm test                                  # everything (node --test)
node --test tests/delivery-guard.test.js  # one file
```

Node's built-in runner; no extra dependencies. Tests never touch `backend/data`: each sets `KUBEEZ_DATA_DIR` to a throw-away directory before importing services.

### Two styles

**In-process (most tests).** Import the services and routes, mount them on a small Express app with a fake signed-in user, and replace the cluster connection with a fake:

```js
import { tempDataDir, paidOrgs } from './helpers/server.js'
const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
paidOrgs(DATA, ['org-a'])                 // a Pro / Enterprise workspace (Pro features answer 402 otherwise)

const helm = await import('../src/services/helmApps.js')
helm._test.useConnect(async () => ({      // every command "runs" on a fake control-plane
    execCommand: async (cmd) => /HELM list/.test(cmd) ? { code: 0, stdout: '[]' } : { code: 0, stdout: '{}' },
    dispose() { }
}))

app.use((req, res, next) => { req.user = USERS[req.get('x-test-user')]; next() })   // admin / operator / viewer / scoped
```

Services that run commands expose `_test.useConnect(fn)` (helmApps, gitops, previews, certManager, security, hibernate, externalSecrets…). Services that call outside APIs take a `fetchImpl` (Git providers, registries, chart repositories).

**Real server.** `helpers/server.js → startServer()` boots `src/server.js` in a child process on a random port with its own data directory; `client(server)` makes JSON calls. Used for sign-in, sessions, CORS and other end-to-end API behaviour.

### What every new feature's tests cover

1. **Input checks** — bad names, paths, versions and `__proto__` keys answer `400`.
2. **Every role** — admin, operator, viewer and a member limited to some namespaces: who gets `200`, `403` or `404` (a cluster or namespace you may not see is "not found").
3. **Gates** — feature off (`403 FEATURE_OFF`), plan (`402`), approval (`428`), change freeze (`423`), read-only connected cluster (`409`).
4. **The commands sent to the cluster** — quoted, and nothing runs when a check fails.
5. **The audit trail** — the action is recorded with a useful detail.

Example files to copy from: `delivery-next.test.js` (Git providers, Flux, previews, chat deploy), `delivery-guard.test.js` (cosign with a fake registry, risk, drift, cert-manager), `phase3.test.js` (deploy tokens, CVE gate), `helm-apps.test.js`.

---

## 3. End-to-end tests

Need Docker on a Linux host with cgroups v2 (GitHub's Ubuntu runners or Docker Desktop work). Each "node" is a privileged systemd container, so kubeadm, containerd and kubelet really run.

```bash
bash tests/e2e/e2e.sh install ubuntu2204            # single-node cluster (default Kubernetes 1.35)
bash tests/e2e/e2e.sh upgrade ubuntu2204 rocky9 debian12   # 1.35 → 1.36 → 1.37 on every node
bash tests/e2e/e2e.sh ha-vip ubuntu2204             # 3 control-planes + kube-vip failover
bash tests/e2e/e2e.sh clean                         # remove every e2e container
```

| Scenario | Checks |
|---|---|
| `install`, `cluster` | A fresh cluster; or one left running for manual testing |
| `upgrade`, `restore-upgrade` | Real upgrades; restoring a pre-upgrade snapshot then upgrading again |
| `restore`, `restore-ha`, `recover`, `offsite`, `velero` | etcd restore (multi-node, HA), disaster recovery, offsite backups, volume backups |
| `ha-vip` | Failover of the virtual IP when its holder dies |
| `addons`, `helm-addons`, `platform-addons`, `takeover` | Add-on lifecycle; Helm-managed add-ons; old add-ons taken over by Helm (`ONLY=metallb,…` for a subset) |
| `explorer`, `access`, `ai-ops`, `compliance` | Explorer behind the proxy, namespace access, AI fixes with undo, compliance evidence |
| `agent`, `agent-health` | Gateway Agent as a service, crash / reboot recovery, topology through the agent |

Distros: `ubuntu2204 ubuntu2404 debian12 rocky9 alma9 fedora amzn2023`. Scenarios that drive the KubeEZ API need `npm install` in `backend/` first.

---

## 4. Continuous integration

`.github/workflows/ci.yml` runs on every push to `master`, on pull requests, on demand and **nightly** (03:00 IST, to catch upstream Kubernetes / containerd / distro changes):

- **Checks** (every run, ~2 min): script syntax, backend tests, frontend build.
- **Upgrade script scenarios**.
- **Install matrix** across distros and Kubernetes versions.
- Real-node jobs: S3 + offsite backup, etcd restore (Ubuntu + Rocky), add-on management, Gateway Agent, topology through the agent, multi-node upgrade.

---

## 5. Manual release check

Automated tests use simulated clusters, registries and Git providers. Before a release, check the newer features on a real cluster (a 1-node `e2e.sh cluster` works for most):

| Area | Check |
|---|---|
| Install / upgrade | Deploy a cluster from the wizard; upgrade it one version; resume a stopped install |
| Add-ons | Install Argo CD, Flux, cert-manager, Trivy Operator, Argo Rollouts, KEDA |
| Helm apps | Add a chart repository; install with a preview; **Assess risk** (with and without an AI connected); upgrade; roll back |
| Drift | `kubectl scale` a release's Deployment by hand → **Check drift** shows it → **Restore** |
| Guards | An environment with CVE gate = block and signature policy = block: an unsigned image is blocked; sign it with `cosign sign --key` and add `cosign.pub` → it passes; admin override with a reason |
| CI | A deploy token: `POST /api/hooks/deploy` with a commit; DORA lead time appears; a token with previews: `POST` then `DELETE /api/hooks/preview` |
| Previews | A preview's namespace is created, deployed, listed, and removed when it expires |
| Chat | ChatOps on for a Slack / Telegram channel, an allowed app: `deploy … to …` → `confirm ####` → result posted |
| GitOps | Sync now on Argo CD and Flux apps; a new Argo CD app and a new Flux app; promotion PRs on GitHub, GitLab and Bitbucket |
| Certificates | A Let's Encrypt staging certificate; Renew now; an expiring / failing one shows and alerts |
| Roles | Repeat a few of the above as operator, viewer and a namespace-limited member |

Record what was run and the result in the pull request or release notes.
