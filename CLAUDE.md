# Arbiter: working notes

Blind A/B evaluation harness for AI coding models. Two modes share one engine:
- **Personal**: a desktop app (Electron) or `arbiter serve`. One user runs models on their own tasks and reviews blind.
- **Managed**: `arbiter server`. An evaluation team's server with an admin dashboard (`/`) and an annotator client
  (`/annotate`). The desktop app opens annotator work in a protected window ("Managed workspaces").

User docs live in `docs/` (personal-mode, managed-mode, reference, development). Keep them in sync with behavior
changes. `CLAUDE.local.md` (if present) holds machine-specific notes.

## Layout
- `src/` engine (TypeScript, run with tsx; no build step for the CLI)
  - `runner.ts` evaluations → runs → blind pairs ("assignments" table = comparisons); `views.ts` read models + scrubbed side views
  - `providers/` anthropic (official SDK, manual agent loop, deliberately NO model fallbacks), openai-compatible (fetch), mock
  - `sandbox/` docker + local backends, workspace prep/diff via git; `agent/` shared tools + limits + system prompt
  - `server.ts` HTTP API + static UI; personal = per-session token header, managed = cookie sessions and roles
  - `managed/` db schema, auth (scrypt, invites, sessions), projects/queue/leases/gold/qualification, qa/results/export, vault (AES-GCM), api routes
  - `desktop/` Electron main (safeStorage keys, protected managed window) + sandboxed preload
- `public/` plain ES-module UI, no build: `lib.js` helpers, `review.js` shared review components, `app.js` personal app + router
  (also boots the managed admin UI), `manage.js` tasks/contestants/settings/workspaces, `rubrics.js` rubric editor, `admin.js` managed dashboard, `annotate.*` annotator client
- `scripts/build.mjs` esbuild bundles → `dist/` (`arbiter.mjs` CLI/server, `main.mjs` + `preload.cjs` Electron; `--server` = server only); `scripts/e2e/` end-to-end test helpers
- `Dockerfile` server image; `deploy/` docker-compose + Caddyfile (HTTPS). Sandboxes are sibling containers: data dir must be mounted at the same path inside and out
- `examples/` sample contestants + fix-sum task (copied into a new data dir on first run)
- `.github/workflows/ci.yml` typecheck, UI syntax, builds, managed e2e (Docker sandbox on Linux)

## Commands
- `npm run typecheck` (tsc 7). UI files: `node --check public/<file>.js`
- `npm run arbiter -- <cmd>` CLI (run, list, ratings, serve, server). `--home <dir>` for a throwaway data dir.
- `npm run desktop` build + launch the Electron app; `npm run dist` → `release/` installer + portable exe (unsigned)
- `npm run server -- …` Managed server from source; `npm run build:server` → `dist/arbiter.mjs` (run with `node --no-warnings dist/arbiter.mjs server`)
- `npm run test-workspace` seeded local Managed workspace on :8095 (data ~/.arbiter-test-workspace, accounts in its CREDENTIALS.txt; delete the dir to reset)
- Managed e2e (54 checks, exits non-zero on failure): start `npm run server -- --port 8094 --allow-local-sandbox --home <empty short temp dir>`, then `node scripts/e2e/managed-api.mjs <setup code>` ONCE per fresh server (the setup code is single-use; generated test passwords go to `<os tmp>/arbiter-e2e-creds.json`)
- Electron UI checks: launch with `--remote-debugging-port=9333` and drive it via `scripts/e2e/cdp.mjs` (CDP screenshots bypass content protection)

## Conventions and gotchas
- Every piece of model output is untrusted: UI only uses `h()` (text nodes), never innerHTML. Scrub via `makeScrubber` before showing.
- Annotator payloads must never contain run IDs, contestant names, model IDs or keys (e2e test checks this).
- Windows: keep data dirs on short paths (MAX_PATH). Use `forceRemove` (not bare `fs.rmSync`) for workspaces: git's
  read-only objects make Node 24's rmSync fail with EPERM.
- Personal data dir `~/.arbiter`; managed server data dir `~/.arbiter-server`.
- A Managed server refuses the local sandbox unless `--allow-local-sandbox` / `ARBITER_ALLOW_LOCAL_SANDBOX=1` (enforced in `sandbox/index.ts`).
- Rubrics come from `rubrics.ts` (`getRubric`/`requireRubric`; built-ins + `rubrics.json` in the data dir). Never index a rubric map directly.
- "Desktop app required" (`projects.require_desktop`, default on): the protected window adds `X-Arbiter-Client: desktop/<ver>`; `assertClient` in projects.ts refuses annotator work without it. e2e clients send it by default (`client(true)` = browser).
- Qualification reviews (`reviews.is_qual = 1`) never count in QA agreement, results or export; qualification gold rows have `gold.qual = 1`.
- Managed schema changes: add columns through `addColumn` in `managed/db.ts` (existing servers have old tables).

## Likely next steps
Build and run the Docker image on a Linux host (HTTPS deployment); SSO/OIDC and annotator pay tracking for Managed;
CLI-agent adapters (Claude Code, Codex, Gemini CLI); code signing for the exe.
