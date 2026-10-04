# Personal mode: setup and use

Personal mode is for one person comparing AI models on their own code. You run two or more models on the same
task, review the results blind, and Arbiter builds a private rating of which model works best for you.

Everything runs on your computer. Results, keys and settings stay in your data folder (`~/.arbiter`).

- [1. Install](#1-install)
- [2. First launch](#2-first-launch)
- [3. Add API keys](#3-add-api-keys)
- [4. Set up contestants](#4-set-up-contestants)
- [5. Create a task](#5-create-a-task)
- [6. Run an evaluation](#6-run-an-evaluation)
- [7. Review blind](#7-review-blind)
- [8. Read the ratings](#8-read-the-ratings)
- [9. Custom rubrics](#9-custom-rubrics)
- [Using the command line instead](#using-the-command-line-instead)
- [Where things are stored](#where-things-are-stored)
- [Troubleshooting](#troubleshooting)

## 1. Install

**Requirements**

| | Needed? | Why |
| --- | --- | --- |
| Windows 10/11 (x64) | Yes, for the packaged app | Other platforms can run from source (see [development.md](development.md)) |
| [Git](https://git-scm.com/downloads) | **Required** | Arbiter snapshots your project and captures each model's changes with git |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | Strongly recommended | Runs each model's commands in an isolated container. Without it, model commands run directly on your computer |
| An API key | For real models | Anthropic, OpenAI, OpenRouter, or none for local models via Ollama |

**Get the app** in one of two ways:
- **Installer:** run `Arbiter-Setup-<version>.exe` and choose where to install.
- **Portable:** run `Arbiter-<version>-portable.exe`. Nothing is installed; it unpacks itself each time it starts.

The executables aren't code-signed yet, so Windows SmartScreen may warn the first time. Choose **More info → Run
anyway**. To build the executables yourself, see [development.md](development.md#packaging).

## 2. First launch

On first start, Arbiter creates its data folder `~/.arbiter` (for example `C:\Users\you\.arbiter`) with:
- two **mock contestants** ("Mock Alpha" and "Mock Beta"): scripted, free, and good for trying things out;
- a sample task, **Fix sum() and add mean()**.

The badge in the top-right corner shows the sandbox:
- **Docker sandbox** (green): model commands run in containers. Good.
- **Local sandbox** (amber): Docker isn't running, so model commands run directly on your computer. Fine for the
  mocks; start Docker Desktop before running real models on code you care about.
- **Git missing** (red): install Git, then restart Arbiter.

**Try it with no setup:** go to **New evaluation**, pick the sample task, tick Mock Alpha and Mock Beta, and run it.
You'll have a blind comparison to review within a few seconds.

## 3. Add API keys

Open **Settings → API keys**, paste a key next to its name, and click **Save**.

- Keys are encrypted by Windows (DPAPI via Electron `safeStorage`) and stored in `~/.arbiter/secrets.json`.
- Once saved, a key is never shown again. It's sent only to its provider, and never passed to commands the models
  run.
- Built-in names: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. Use **Add key name** for others
  (for example a second Anthropic account), then point a contestant at it.
- Keys set as environment variables also work; the Settings page shows "from environment".

## 4. Set up contestants

A **contestant** is a model plus its settings. Open **Contestants**, then **Add contestant**.

| Provider | Use for | Settings |
| --- | --- | --- |
| **Anthropic (Claude)** | Claude models | Model ID (suggestions offered, e.g. `claude-opus-5`, `claude-sonnet-5`), **Effort** (`low` to `max`), key name |
| **OpenAI-compatible** | OpenAI, OpenRouter, Ollama, LM Studio, vLLM… | Model ID, **Base URL** (e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1` for Ollama), key name, **price per 1M tokens** (for cost metrics) |
| **Mock** | Testing | A scripted sequence of tool calls (see the example in `examples/contestants.yaml`) |

Notes:
- **Display name** is what you see after the reveal. Pick something that identifies the setup, such as
  "Claude Opus 5 (high effort)".
- Every contestant gets **the same system prompt, the same six tools and the same limits**. A comparison measures
  the model, not a vendor's agent product.
- Cost is computed from built-in Anthropic prices. For other providers, fill in the price fields, or cost shows "?".
- Local servers (Ollama, LM Studio) on `localhost` don't need a key.
- **Advanced params (JSON)** accepts extra options: `maxOutputTokens`, `thinking`, `extraBody` (merged into
  OpenAI-compatible requests), `price`, `apiKeyEnv`.

## 5. Create a task

A **task** is a prompt plus a project folder. Open **Tasks**, then **New task**.

| Field | What to enter |
| --- | --- |
| **Title** | A short name, e.g. "Add pagination to /users" |
| **Project folder** | Your project. **Browse…** opens a folder picker. A git repo is pinned to its current commit, so every run (now and later) starts from identical code. Uncommitted changes are **not** included; Arbiter warns you. A non-git folder is copied as-is for every run |
| **Prompt** | Exactly what you'd ask a colleague. Given word for word to every contestant |
| **Tags** | Comma-separated, e.g. `bugfix, typescript`. Ratings can be filtered by tag |
| **Rubric** | The questions you answer when reviewing (see [9. Custom rubrics](#9-custom-rubrics)) |
| **Checks** | One command per line, run in the workspace after each contestant finishes, e.g. `npm test`. Exit code 0 = pass |
| **Time limit / Cost cap / Max tool calls** | Per contestant run. Hitting a limit ends the run; its partial work is still reviewable |
| **Advanced → Setup command** | Runs before the model starts, e.g. `npm ci`. Its changes don't count in the diff |
| **Advanced → Docker image** | The container image for the Docker sandbox (default `node:22-bookworm-slim`). Use one that has your project's toolchain, e.g. `python:3.12-slim` |
| **Advanced → Network** | No network (default, recommended) or allowed |
| **Advanced → Expected files** | Globs like `src/**`; edits elsewhere are flagged as out of scope |

Tasks are saved as `~/.arbiter/tasks/<id>/arbiter.task.yaml`. The full format is in [reference.md](reference.md#task-file).

## 6. Run an evaluation

Open **New evaluation**:
1. Pick a task.
2. Tick two or more contestants. A warning appears if one is missing its API key.
3. **Runs per contestant**: more runs smooth out randomness (models give different answers each time).
4. **Sandbox**: Automatic uses Docker when it's running.
5. **Run evaluation**.

Each run gets a fresh copy of the project. The evaluation page shows progress; runs are labelled "Run 1", "Run 2"…
without names, so you can't tell who's who before reviewing.

## 7. Review blind

When runs finish, click **Start blind review**. For each comparison you see:
- **A** and **B** side by side (which model is A is random each time);
- each side's **diff**, **check results** and **transcript** (what the model did, step by step);
- **objective metrics**: checks passed, cost, time, tokens, files touched, out-of-scope edits. Untick **Show
  objective metrics** to judge on the code alone.

Model and vendor names are replaced with `[MODEL]` everywhere, and vendor files such as `CLAUDE.md` or `AGENTS.md` are
left out of the diff. Answer the rubric, optionally guess which model is which (this measures how blind the review
really was), and **Submit**. The identities are revealed after you submit.

## 8. Read the ratings

**Ratings** ranks contestants with a Bradley–Terry model on an Elo-like scale (1000 = average), with 95% confidence
intervals. It also shows wins/losses/ties, check pass rate, average cost and time. Filter by tag to see, for
example, who's best at *bugfix* tasks. Ratings marked *provisional* have fewer than 10 comparisons.

## 9. Custom rubrics

**Rubrics** lists the built-in rubrics (Quick pairwise, Code review, Detailed pairwise) and your own. To make one,
click **New rubric** or **Duplicate** an existing one. Question types:
- **Pairwise**: A much better … Tie … B much better (3, 5 or 7 points);
- **Score each side**: 1–5 or 1–7 for A and for B;
- **Checkbox per side**: e.g. "Broke existing behavior";
- **Written answer**: optionally required, with a minimum length.

Every rubric needs a pairwise question with the ID `overall`: it decides who wins. Once you've submitted reviews with
a rubric, its questions are locked so old answers keep their meaning. You can still reword labels, or duplicate it.

## Using the command line instead

Everything above also works from the command line, from a source checkout (see [development.md](development.md)):

```bash
npm run arbiter -- init
npm run arbiter -- run fix-sum --contestants mock-alpha,mock-beta --repeats 2
npm run serve        # the same UI in your browser at http://localhost:4173
npm run arbiter -- ratings
```

All commands are listed in [reference.md](reference.md#command-line). On the command line, API keys come from
environment variables (`ANTHROPIC_API_KEY`, …) rather than the encrypted store.

## Where things are stored

| Path | Contents |
| --- | --- |
| `~/.arbiter/arbiter.db` | Evaluations, runs, comparisons, reviews (SQLite) |
| `~/.arbiter/runs/<run id>/` | Each run's `diff.patch`, `transcript.jsonl`, `checks.json`, `run.json`. The working copy is deleted after the run; the diff is kept |
| `~/.arbiter/contestants.yaml` | Your contestants (editable by hand) |
| `~/.arbiter/tasks/` | Your tasks |
| `~/.arbiter/rubrics.json` | Your custom rubrics |
| `~/.arbiter/secrets.json` | API keys, encrypted |
| `~/.arbiter/logs/app.log` | Desktop app log |
| `~/.arbiter/workspaces.json` | Managed workspaces you've added |

**File → Open data folder** opens it. To start over, close Arbiter and delete the folder. To use another location,
set the `ARBITER_HOME` environment variable.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Git missing" | Install Git for Windows and restart Arbiter |
| Runs fail with "Could not resolve authentication method" | The contestant's API key isn't set: **Settings → API keys** |
| Runs fail with "Filename too long" | Keep the data folder on a short path (the default is fine). Very deep Windows paths exceed git's 260-character limit |
| Every run hits the time limit | Raise the task's time limit, or use a lighter **Effort** setting |
| A Docker run fails on its first use | The first Docker run downloads the task's image, which can take a minute. Check that Docker Desktop is running |
| Checks fail in Docker but pass locally | The Docker image lacks your toolchain. Set **Advanced → Docker image**, and/or a **Setup command** |
| Something else | **File → Open log file** |
