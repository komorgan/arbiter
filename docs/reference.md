# Reference

- [Command line](#command-line)
- [Server options](#server-options)
- [Task file](#task-file)
- [Contestants file](#contestants-file)
- [Rubrics](#rubrics)
- [Environment variables](#environment-variables)
- [Data layout](#data-layout)
- [The agent scaffold](#the-agent-scaffold)
- [Ratings](#ratings)

## Command line

From a source checkout, run `npm run arbiter -- <command>`, or after `npm run build:server`,
`node --no-warnings dist/arbiter.mjs <command>`. Every command accepts `--home <dir>` to use a different data dir.

| Command | What it does |
| --- | --- |
| `init` | Create the data dir with sample contestants and a task |
| `contestants` | List configured contestants |
| `tasks` | List tasks in the data dir |
| `run <task> --contestants a,b[,c] [--repeats N] [--sandbox auto\|docker\|local]` | Run contestants on a task (a folder, or a task name in the data dir), then queue blind comparisons |
| `list` | List evaluations and review progress |
| `ratings [--tag T]` | Ratings from submitted reviews, optionally for one tag |
| `serve [--port 4173]` | Personal-mode UI in a browser (localhost only) |
| `server [options]` | Managed-mode server (see below) |

Shortcuts in `package.json`: `npm run serve`, `npm run server -- <options>`, `npm run test-workspace`.

## Server options

Every option can also be given as an environment variable; flags win.

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `--port` | `ARBITER_PORT` | `8080` | Port to listen on |
| `--host` | `ARBITER_HOST` | `127.0.0.1` (`0.0.0.0` in the Docker image) | Address to bind |
| `--public-url` | `ARBITER_PUBLIC_URL` | none | The URL people use, e.g. `https://arbiter.example.com`. Its host is allowed, and `https://` turns on Secure cookies and HSTS |
| `--allow-host` | `ARBITER_ALLOW_HOSTS` | none | Extra host names to accept, comma-separated |
| `--trust-proxy` | `ARBITER_TRUST_PROXY=1` | off | Take the client IP from `X-Forwarded-For` (only behind a proxy you control) |
| `--allow-local-sandbox` | `ARBITER_ALLOW_LOCAL_SANDBOX=1` | off | Allow running agents without Docker. **Testing with mock contestants only** |
| `--home` | `ARBITER_HOME` | `~/.arbiter-server` | Data dir |
| | `ARBITER_MASTER_KEY` | key file in data dir | 32 bytes, base64. Encrypts stored API keys |

## Task file

A task is a folder containing `arbiter.task.yaml`. The UI writes these for you; you can also write them by hand.

```yaml
id: fix-sum                        # defaults to the folder name
title: Fix sum() and add mean()
tags: [bugfix, javascript]         # ratings can be filtered by tag
prompt: |                          # required; given word for word to every contestant
  The `sum` function in sum.js returns wrong results. Fix it. ...
rubric: code-review                # a built-in or custom rubric id (default: quick-pairwise)

workspace:                         # where the code comes from (pick one)
  path: ./workspace                #   a folder, copied for every run (default: ./workspace next to this file)
  # repo: /path/to/repo            #   or a git repo...
  # commit: 3f2a9c1                #   ...pinned to a commit (default: HEAD at run time)

env:
  image: node:22-bookworm-slim     # Docker image for the sandbox
  setup: npm ci                    # optional; runs before the agent, its changes don't count in the diff
  network: none                    # none (default) | open

limits:                            # per contestant run
  wallClockSec: 600                # default 600
  maxCostUsd: 0.50                 # optional
  maxTokens: 400000                # optional (input + output)
  maxToolCalls: 60                 # default 60
  maxTurns: 40                     # default 40

checks:                            # run after the agent finishes; exit code 0 = pass
  - { id: tests, kind: test, cmd: npm test, weight: 1 }       # kind: test | lint | typecheck | build | custom
  - { id: lint, kind: lint, cmd: npm run lint, weight: 0.5 }

scopeGlobs: ["src/**", "test/**"]  # optional; edits outside count as out of scope
```

## Contestants file

`contestants.yaml` in the data dir. The UI edits it; hand edits are fine. Each run stores a copy of the contestant,
so editing this file never changes past results.

```yaml
contestants:
  - id: claude-opus-5               # letters, digits, . _ -
    displayName: Claude Opus 5      # shown only after a blind review
    provider: anthropic
    model: claude-opus-5
    params:
      effort: high                  # low | medium | high | xhigh | max
      # thinking: { type: adaptive } # default on current models
      # maxOutputTokens: 16000
      # apiKeyEnv: ANTHROPIC_API_KEY # which saved key to use

  - id: gpt-something
    displayName: An OpenAI model
    provider: openai-compatible
    model: <model id>
    params:
      baseUrl: https://api.openai.com/v1   # or https://openrouter.ai/api/v1, http://localhost:11434/v1 (Ollama)
      apiKeyEnv: OPENAI_API_KEY            # not needed for local servers
      price: { input: 0, output: 0 }       # USD per 1M tokens, for cost metrics
      # maxOutputTokens: 16000
      # extraBody: { temperature: 0 }      # merged into every request

  - id: mock-alpha                  # scripted, free; see examples/contestants.yaml for a full script
    displayName: Mock Alpha
    provider: mock
    params:
      script:
        - { say: "Looking around", tool: list_files }
        - { tool: finish, input: { summary: "Done" } }
```

## Rubrics

Built in: `quick-pairwise` (one question + notes), `code-review` (overall + four 1–5 scores, two flags, required
justification), `detailed-pairwise` (five pairwise questions, two flags, required justification). Custom rubrics are
stored in `rubrics.json` in the data dir:

```json
{
  "security-review": {
    "id": "security-review",
    "name": "Security review",
    "criteria": [
      { "id": "overall", "type": "pairwise", "label": "Which is safer overall?", "scale": 5 },
      { "id": "secrets", "type": "flag", "label": "Leaks a secret" },
      { "id": "risk", "type": "likert", "label": "Risk level", "min": 1, "max": 5 },
      { "id": "why", "type": "text", "label": "Why?", "minChars": 10, "required": true }
    ]
  }
}
```

Rules: one `pairwise` question must have the id `overall` (it decides the winner); `pairwise` scales are 3, 5 or 7;
`likert` goes up to 5 or 7; at most 30 questions. Once reviews use a rubric, only labels, name and description can
change.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ARBITER_HOME` | all | Data dir (default `~/.arbiter`, or `~/.arbiter-server` for `server`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, … | all | API keys. The desktop app and server prefer their encrypted stores and fall back to these |
| `ARBITER_MASTER_KEY` | server | Encrypts stored API keys |
| `ARBITER_PORT`, `ARBITER_HOST`, `ARBITER_PUBLIC_URL`, `ARBITER_ALLOW_HOSTS`, `ARBITER_TRUST_PROXY`, `ARBITER_ALLOW_LOCAL_SANDBOX` | server | See [server options](#server-options) |
| `ARBITER_TEST_PORT` | `test-workspace` | Port for the local test workspace (default 8095) |

## Data layout

| Path (in the data dir) | Contents |
| --- | --- |
| `arbiter.db` | SQLite: evaluations, runs, comparisons ("assignments"), personal reviews; on a server also users, sessions, invites, projects, reviews, gold, audit |
| `runs/<run id>/` | `diff.patch`, `transcript.jsonl`, `checks.json`, `run.json` (contestant spec, task hash, sandbox, price table) |
| `tasks/<id>/arbiter.task.yaml` | Tasks |
| `contestants.yaml` | Contestants |
| `rubrics.json` | Custom rubrics |
| `secrets.json` | API keys (desktop: OS-encrypted; server: AES-256-GCM) |
| `master.key` | Server only, when `ARBITER_MASTER_KEY` isn't set |
| `setup-code.txt` | Server only, until the first admin exists |
| `workspaces.json` | Desktop only: Managed workspaces you've added |
| `logs/app.log` | Desktop only |

## The agent scaffold

Every API contestant runs in the same loop with the same system prompt and six tools: `list_files`, `read_file`,
`write_file`, `edit_file`, `run_command` (in the sandbox, no network) and `finish`. Limits are enforced identically.
So a comparison measures the **model**, not a vendor's agent product.

The Anthropic adapter deliberately does **not** enable server-side model fallbacks: an eval must measure the model it
names, so a refusal is recorded as that run's outcome.

## Ratings

Pairwise outcomes (ties count half) are fitted with a Bradley–Terry model and shown on an Elo-like scale where 1000
is average. 95% intervals come from 300 bootstrap resamples. Unlike online Elo, the result doesn't depend on the
order reviews were submitted. Ratings with fewer than 10 comparisons are marked provisional.
