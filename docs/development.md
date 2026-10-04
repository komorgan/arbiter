# Development

- [Getting started](#getting-started)
- [Project layout](#project-layout)
- [Running things](#running-things)
- [Testing](#testing)
- [Packaging](#packaging)
- [Conventions](#conventions)

## Getting started

Requirements: **Node.js 22.13+** (for the built-in `node:sqlite`), **git**, and ideally **Docker**.

```bash
git clone <repository URL> arbiter
cd arbiter
npm install
npm run typecheck
```

There's no build step for the engine or the UI: TypeScript runs through `tsx`, and the UI is plain ES modules served as
files. The esbuild bundles are only for the desktop app and the deployable server.

## Project layout

```
src/                     engine (TypeScript)
  cli.ts                 command line: init, run, list, ratings, serve, server
  config.ts              data dir, contestants file
  task.ts                task files: load, validate, create, list
  runner.ts              evaluations → runs → blind comparisons; crash recovery; workspace cleanup
  views.ts               read models for the UI; identity scrubbing of everything shown
  ratings.ts             Bradley–Terry fit + bootstrap intervals
  rubrics.ts             built-in + custom rubrics, validation, locking, A/B swapping
  scrub.ts               model/vendor name redaction
  secrets.ts             pluggable API key store (env, OS-encrypted, server vault)
  server.ts              HTTP API + static UI; personal: per-session token, managed: cookie sessions + roles
  agent/                 shared tools, limits, system prompt
  providers/             anthropic (official SDK), openai-compatible (fetch), mock
  sandbox/               docker + local backends, git workspace prep and diff
  managed/               Managed mode: schema, auth, projects/queue/qualification, QA/results/export, vault, routes
  desktop/               Electron main process + sandboxed preload
public/                  UI (no build step)
  lib.js                 DOM helper h(), API client, formatting
  review.js              blind review components (diff, checks, transcript, rubric form)
  app.js                 personal app + router; also boots the managed admin dashboard
  manage.js, rubrics.js  tasks, contestants, settings, workspaces, rubric editor
  admin.js               managed admin dashboard
  annotate.html/.js      managed annotator client
examples/                sample contestants + task (copied into new data dirs)
scripts/                 build.mjs, make-icon.mjs, test-workspace.mjs, e2e/ test helpers
deploy/                  docker-compose.yml + Caddyfile for the server
Dockerfile               server image
docs/                    these guides
```

## Running things

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build and launch the Electron app from source (uses `~/.arbiter`) |
| `npm run serve` | Personal-mode UI in the browser at `http://localhost:4173` |
| `npm run arbiter -- <cmd> --home <dir>` | Any CLI command against a throwaway data dir |
| `npm run server -- --port 8094 --home <dir>` | Managed server from source |
| `npm run test-workspace` | Seeded Managed workspace on `:8095` (accounts in `~/.arbiter-test-workspace/CREDENTIALS.txt`) |

On Windows, keep throwaway data dirs on **short paths**: deep paths can exceed git's 260-character limit.

## Testing

```bash
npm run typecheck                         # TypeScript
for f in public/*.js; do node --check "$f"; done   # UI syntax
```

**Managed end-to-end test** (54 checks over the HTTP API, using mock contestants):

```bash
npm run server -- --port 8094 --allow-local-sandbox --home /tmp/arb-e2e     # prints a one-time setup code
node scripts/e2e/managed-api.mjs <setup code>                               # in another terminal
```

Run it once per **fresh** data dir: the setup code is single-use. It covers setup, auth and invites, roles, the blind
payload (no identities leak), gold, QA, exclusion, results, export, audit, custom rubrics and locking, qualification
(pass/fail/retake, feedback, no skipping), and the desktop-required policy. Generated test passwords are written to
`<os tmp>/arbiter-e2e-creds.json` so you can sign in to the UI afterwards.

**Electron UI checks:** launch with `npx electron . --remote-debugging-port=9333` and drive it with
`scripts/e2e/cdp.mjs`. Note that CDP screenshots bypass the protected window's capture blocking; test that with a real
OS screenshot.

CI (`.github/workflows/ci.yml`) runs the typecheck, the UI syntax check, both builds and the end-to-end test on every
push and pull request.

## Packaging

```bash
npm run dist            # Windows: release/Arbiter-Setup-<version>.exe and release/Arbiter-<version>-portable.exe
npm run build:server    # dist/arbiter.mjs: the whole server/CLI in one file (no node_modules needed)
docker build -t arbiter-server .
```

- The desktop package contains only `dist/main.mjs`, `dist/preload.cjs`, `public/` and `examples/`. Everything is
  bundled by esbuild, so it ships no `node_modules`.
- `npm run icon` regenerates `build/icon.png` from the SVG in `scripts/make-icon.mjs`.
- The executables aren't code-signed. To sign, configure `win.certificateFile`/`certificatePassword` (or Azure
  Trusted Signing) in the `build` section of `package.json`.

## Conventions

- **Model output is untrusted.** The UI only builds DOM with `h()` (text nodes), never `innerHTML`. Everything shown
  from a run goes through `makeScrubber` first.
- **Annotator payloads** must never contain run IDs, contestant names, model IDs or keys. The e2e test checks this.
- **Rubrics** are looked up through `getRubric`/`requireRubric`, never a map directly.
- **Managed schema changes** go through `addColumn` in `src/managed/db.ts`, because existing servers have older tables.
- **Workspace deletion** uses `forceRemove`. Git's read-only object files make Node 24's `rmSync` fail on Windows.
- **Servers refuse the local sandbox** unless explicitly allowed. That's enforced in `src/sandbox/index.ts`; keep
  it there.
- Comments explain *why*. Keep functions small and the UI dependency-free.
