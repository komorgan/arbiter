# Managed mode: setup and use

Managed mode is for evaluation teams: a company (or a vendor working for one) runs **Arbiter Server**, admins set up
projects, and annotators review model outputs blind. Annotators never hold the data: everything stays on the server,
and in the desktop app reviews open in a protected window.

> **Licensing:** Arbiter is licensed for noncommercial use only ([PolyForm Noncommercial 1.0.0](../LICENSE)). Running
> Managed mode in a company, or as a paid evaluation service, needs a commercial license: contact
> kamdenmorgan108@gmail.com.

- [How it fits together](#how-it-fits-together)
- [Part 1: Deploy the server](#part-1-deploy-the-server)
  - [Option A: Docker Compose with automatic HTTPS (recommended)](#option-a-docker-compose-with-automatic-https-recommended)
  - [Option B: Node.js directly](#option-b-nodejs-directly)
  - [Try it locally first](#try-it-locally-first)
- [Part 2: Admin setup](#part-2-admin-setup)
- [Part 3: Running a project](#part-3-running-a-project)
- [Part 4: Annotator guide](#part-4-annotator-guide)
- [Security model](#security-model)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)

## How it fits together

```
Admins (browser) ─────────┐
                           │  HTTPS
Annotators (desktop app) ──┼──────────► Arbiter Server ──► Docker (one sandbox container per model run)
Annotators (browser, only  │             │                      │
if a project allows it) ───┘             │                      └─ model API calls go out from the server
                                         └─ data dir: database, runs, encrypted keys, audit log
```

- **Admins** use the dashboard at `https://your-server/`.
- **Annotators** use the Arbiter desktop app (Managed workspaces), or `https://your-server/annotate` for projects
  that allow browsers.
- Model API keys live on the server only. Annotators never see them, or which model produced which result.

## Part 1: Deploy the server

**Server requirements**
- Linux with **Docker** (any VPS or VM; 2+ CPUs and 4 GB RAM is a comfortable start; more CPUs means more parallel
  runs).
- A **domain name** pointing at the server, for HTTPS.
- Outbound internet access to the model providers you'll use.

> **Why Docker is required:** agents run code the models write. A server only runs agents inside Docker containers,
> and refuses otherwise. Running them directly on the server would put untrusted code next to the key vault and the
> database. (`--allow-local-sandbox` overrides this for local testing with mock contestants only.)

### Option A: Docker Compose with automatic HTTPS (recommended)

The repository includes a `Dockerfile` and `deploy/docker-compose.yml`, which runs Arbiter behind
[Caddy](https://caddyserver.com/) with automatic HTTPS certificates.

1. **Get the code onto the server.**
   ```bash
   git clone <your repository URL> arbiter && cd arbiter/deploy
   ```
2. **Create the data folder.** It must be at the same path inside and outside the container. Sandboxes are sibling
   containers, and the host's Docker resolves their workspace paths.
   ```bash
   sudo mkdir -p /srv/arbiter && sudo chown 1000:1000 /srv/arbiter
   ```
3. **Create `deploy/.env`** with your settings:
   ```bash
   ARBITER_DOMAIN=arbiter.example.com
   ARBITER_MASTER_KEY=<output of: openssl rand -base64 32>
   DOCKER_GID=<output of: stat -c %g /var/run/docker.sock>
   ```
   **Back up `ARBITER_MASTER_KEY` somewhere safe.** It encrypts the stored API keys; without it they can't be read.
4. **Start it.**
   ```bash
   docker compose up -d --build
   ```
5. **Get the one-time setup code** from the logs:
   ```bash
   docker compose logs arbiter | grep -A2 "one-time code"
   ```
6. Open `https://arbiter.example.com/` and continue with [Part 2](#part-2-admin-setup).

Give the server its own VM: access to the Docker socket is equivalent to root on that machine.

### Option B: Node.js directly

On a machine with Node.js 22.13+, git and Docker:

```bash
npm ci
npm run build:server
ARBITER_MASTER_KEY=<base64 key> node --no-warnings dist/arbiter.mjs server \
  --port 8080 --public-url https://arbiter.example.com --trust-proxy
```

Put a TLS reverse proxy (Caddy, nginx) in front that forwards to `localhost:8080`. Without `--public-url https://…`,
cookies aren't marked Secure and HSTS is off: only acceptable for local testing. Data goes to `~/.arbiter-server`
(change it with `--home` or `ARBITER_HOME`). All options are listed in
[reference.md](reference.md#server-options).

### Try it locally first

From a source checkout, one command starts a ready-made test workspace on `http://localhost:8095`. It has an admin,
two annotators, a project with a qualification test, and comparisons from mock contestants:

```bash
npm run test-workspace
```

The account details are written to `~/.arbiter-test-workspace/CREDENTIALS.txt`. Run the command again to restart
with the same data, or delete that folder to start over. Then follow the annotator steps below with the desktop app,
adding `http://localhost:8095` as the workspace. Plain `http://` is allowed only for localhost.

## Part 2: Admin setup

1. **Create the first admin.** Open the dashboard, enter the one-time setup code, your name, email and a password
   (10+ characters). The code works once.
2. **Add model API keys:** **Keys & settings → API keys**. Keys are encrypted on the server with AES-256-GCM
   (master key from `ARBITER_MASTER_KEY`, or else a key file in the data dir) and are never shown again.
3. **Add contestants:** **Contestants → Add contestant**. Same options as in Personal mode
   ([personal-mode.md](personal-mode.md#4-set-up-contestants)).
4. **Add tasks:** **Tasks → New task**. The project folder is a path **on the server**: clone the repositories you
   want to evaluate onto the server first (under the data dir is a good place). Docker-mode tips: set a **Docker
   image** with the right toolchain and a **Setup command** such as `npm ci`.
5. **Optional: create rubrics:** **Rubrics** (see [personal-mode.md](personal-mode.md#9-custom-rubrics)).
6. **Invite people:** **People → Invite someone**. Enter an email, a role (annotator or admin) and the projects they
   should join, then click **Create invite**. Send the code that appears to that person. It's shown once and expires
   in 7 days. Arbiter doesn't send email.

## Part 3: Running a project

### Create the project

**Projects → New project**:

| Setting | Meaning |
| --- | --- |
| **Instructions** | Shown at the top of every review: what to look for, how to weigh correctness against style, when to pick Tie |
| **Rubric** | The questions annotators answer. Locked once reviews exist |
| **Status** | *Draft* (setting up), *Active* (handing out work), *Paused* (annotators keep their place), *Closed* |
| **Reviews per comparison** | How many different annotators judge each pair (e.g. 3) |
| **Gold share** | Share of work drawn from gold comparisons (known answers) to measure accuracy, e.g. 10% |
| **Qualification items / pass mark** | Known-answer comparisons each annotator must answer before real work, e.g. 5 items at 80%. 0 = no test |
| **Require the desktop app** | On by default. Reviews only in the desktop app's protected window; browser access is refused and logged |
| **Show metrics / transcripts** | Whether annotators see test results, cost and time, and the agent's step-by-step transcript |
| **Ask annotators to guess the models** | Measures how blind the review is. Note: it reveals the list of contestants |

### Run batches

On the project's **Batches** tab, tick tasks and contestants, choose runs per contestant, and click **Run batch**. The
server runs every task against the chosen contestants in Docker, then pairs the results into **comparisons** (each pair
in a random A/B order). The tab refreshes while batches run; click a batch to see each run's status.

### Gold and qualification

On **Comparisons & gold**, each row shows (to admins only) which contestant is A and B and how their checks went:
- Set **Known answer** to A, B or Tie when one result is clearly right, for example when only one side passes the
  tests. That makes it **gold**: it's mixed into everyone's work at the gold share and measures accuracy.
- Also tick **Qualification** to reserve it for the **entry test** instead. Its **Note** is shown to the annotator
  as feedback after they answer, so explain *why*. Qualification items never appear in regular work or in results.

A banner tells you whether enough qualification items exist; annotators can't start until there are.

### Annotators, quality and results

- **Annotators** tab: choose who can work on the project.
- **Quality** tab: per annotator, you see:
  - qualification status, with *Let retake* (discards their test answers), *Pass* and *Fail* overrides;
  - reviews and skips;
  - **gold accuracy**, and **agreement** with the other annotators;
  - **left-pick rate** (a strong side bias is suspicious);
  - **median time**, average justification length, and repeated justifications;
  - **flags** when something looks off.

  **Exclude** removes a person's reviews from Results and marks them as excluded in the export.
- **Results** tab:
  - Bradley–Terry ratings with 95% intervals;
  - win rates for each rubric question;
  - how often each contestant was flagged (e.g. "broke existing behavior").
- **Export reviews (JSONL)**: one line per review, with identities resolved. It includes the contestant, model, run,
  metrics, the answers in the comparison's own A/B frame, whether the annotator saw it flipped, gold correctness,
  time spent and the annotator's email.

## Part 4: Annotator guide

Send this section to your annotators.

**What you need:** the Arbiter desktop app (installer or portable exe from your admin), the server address (e.g.
`https://arbiter.example.com`), and your invite code.

1. **Add the workspace.** Open Arbiter, go to **Managed workspaces**, enter a name and the server address, and click
   **Add**.
2. **Open it.** Click **Open**. Reviews happen in this separate window:
   - it can't be captured in screenshots, recordings or screen shares;
   - nothing is saved on your computer;
   - closing it signs you out.
3. **Create your account.** Choose **I have an invite**, then enter the code, your name and a password (10+
   characters). Next time, just **Sign in**.
4. **Qualification** (if the project has one). Answer the practice comparisons. Each has a known answer, and after
   each one you'll see whether you were right and why. Reach the pass mark to start real work. Test items can't be
   skipped.
5. **Review.** You get one comparison at a time:
   - read the task and the project instructions;
   - compare **A** and **B**: their diffs, checks and, if shown, metrics and transcripts;
   - answer every question and click **Submit and continue**.

   Model names are hidden, and which model is A changes each time.
   - Each comparison is held for you for **30 minutes** (the timer is top-right). After **15 minutes** without
     activity it goes back to the queue, and **Resume** picks up again.
   - If you can't judge one fairly, pick a reason and **Skip** it.
   - Your email is watermarked faintly across the window.

If a project shows **Desktop app only** in a browser, open it from the desktop app as above.

## Security model

| Area | How it's handled |
| --- | --- |
| Passwords | scrypt with a per-user salt; minimum 10 characters; login rate-limited per IP and per email |
| Sessions | Random tokens stored only as SHA-256 hashes; HttpOnly, SameSite=Strict cookies (Secure + HSTS behind HTTPS); 12-hour lifetime, 60-minute idle timeout; *Sign out everywhere* per user |
| Invites and setup | One-time codes stored only as hashes; invites expire in 7 days |
| Requests | Writes require a custom header (CSRF protection); requests for unknown host names are refused (DNS rebinding); strict Content-Security-Policy |
| API keys | Server-side only, AES-256-GCM at rest, bound to their names; never sent to annotators, never passed into sandboxes |
| Agent code | Docker-only on servers: no network by default, all capabilities dropped, CPU/memory/process limits, runs as the server's unprivileged user |
| Blinding | Annotators get scrubbed content under an unguessable lease ID: no model names, model IDs, run IDs or keys. Left/right is randomized per annotator |
| Data on annotator machines | Desktop: protected window with capture blocking, in-memory session wiped on close, no downloads, printing or devtools, navigation pinned to the server. Browser (if allowed): no review data is stored, but no capture blocking |
| Audit | Sign-ins (and failures), admin changes, invites, exports, reviews, qualification results, and blocked browser attempts |

**Limits, stated plainly:** the watermark, copy limits, capture blocking and the "desktop app required" setting deter
and discourage leaks. They can't stop someone photographing their screen or imitating the app. Your contract with
annotators is the real control. Arbiter's job is to make sure nothing is left behind by accident.

## Operations

- **Backups:** back up the whole data dir (`/srv/arbiter` or `~/.arbiter-server`) and, separately, the master key.
  For a consistent copy of `arbiter.db`, stop the server first, or use `sqlite3 arbiter.db ".backup backup.db"`.
- **Updates:** pull the new code and run `docker compose up -d --build`. The database upgrades itself on start.
  Interrupted runs are marked as failed, and unfinished evaluations are completed.
- **Logs:** `docker compose logs -f arbiter`.
- **Audit log:** **Audit log** in the dashboard shows the latest 500 events.
- **Lost admin access:** another admin can manage accounts on **People**. If no admin can sign in, stop the server and
  disable the admin accounts:
  `sqlite3 arbiter.db "UPDATE users SET status = 'disabled' WHERE role = 'admin';"`. On restart a new one-time setup
  code is printed; create a new admin with a **different** email. The old accounts and their history stay in the
  audit log.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "This server only runs agents in Docker containers" | Docker isn't reachable from the server. Check `docker info` on the host and that the container has the socket and the right `DOCKER_GID` |
| Batch runs fail at "preparing workspace" or with mount errors | The data dir isn't mounted at the same path inside and outside the container (`/srv/arbiter:/srv/arbiter`) |
| "forbidden host" | You're reaching the server under a name it doesn't know. Set `--public-url`, or add the name with `--allow-host` |
| Annotators see "Desktop app only" | Intended: the project requires the desktop app. Turn it off in the project settings if browsers should be allowed |
| "This project's qualification test isn't ready yet" | Mark enough comparisons as qualification items on **Comparisons & gold** |
| Stored API keys stopped working after a move | The master key changed. Restore the original `ARBITER_MASTER_KEY` (or `master.key` file) |
