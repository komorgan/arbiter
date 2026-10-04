# Arbiter

**Blind A/B evaluation for AI coding models.** Run two or more models on the same coding task, each in its own
sandboxed copy of the project with the same prompt, tools and limits. Then judge the results **blind**: A/B, with
model names scrubbed and left/right randomized. Arbiter turns your judgments into a rating of which model works best
on *your* code.

Arbiter has two modes that share one engine:

| | **Personal mode** | **Managed mode** |
| --- | --- | --- |
| For | One developer comparing models on their own projects | Evaluation teams and vendors running human evaluations at scale |
| Runs on | Your computer: Windows desktop app, or a browser via the CLI | A server you host (Docker image + HTTPS), with a web admin dashboard |
| Who reviews | You | Invited annotators, in the desktop app's protected window |
| Data | Stays in your data folder | Stays on the server; annotators never hold it |

## Features

- **Fair comparisons:** every model gets an identical sandbox, prompt, tool set and limits (time, tokens, cost, tool
  calls). It works with Claude (official Anthropic SDK), any OpenAI-compatible API (OpenAI, OpenRouter, Ollama,
  vLLM…), and free scripted mocks for trying things out.
- **Isolation:** each run executes in its own Docker container, with no network by default, all capabilities dropped
  and resource limits. API keys stay outside the sandbox.
- **Real blinding:** model and vendor names are scrubbed from diffs, transcripts and logs, vendor files are left out,
  and A/B is randomized. An optional "guess the model" question measures how blind it really was.
- **Objective metrics alongside judgment:** tests passed, cost, time, tokens, lines and files changed, and
  out-of-scope edits.
- **Ratings:** Bradley–Terry with 95% confidence intervals, filterable by task tag.
- **Custom rubrics:** pairwise scales, per-side scores, flags and written answers. A rubric locks once reviews use it.
- **Managed mode adds:**
  - projects, batches, gold (known-answer) comparisons and qualification tests with feedback;
  - per-annotator quality signals: gold accuracy, agreement, side bias, speed, repeated justifications;
  - exclusion of unreliable annotators, results per criterion, and JSONL export;
  - invites, roles and an audit log;
  - an encrypted key vault, and a "desktop app required" policy.

## Get started

- **Personal mode:** install the Windows app and follow **[docs/personal-mode.md](docs/personal-mode.md)**. Without
  any setup, the bundled mock contestants let you run and review a first comparison within a minute.
- **Managed mode:** deploy the server with Docker Compose (automatic HTTPS) and follow
  **[docs/managed-mode.md](docs/managed-mode.md)**. It includes a guide you can send to your annotators. To look
  around locally first, run `npm run test-workspace`.

From source (Node.js 22.13+ and git required, Docker recommended):

```bash
npm install
npm run desktop                 # Personal mode desktop app
npm run serve                   # ...or the same UI in your browser at http://localhost:4173
npm run test-workspace          # a ready-made Managed workspace at http://localhost:8095
```

## Documentation

| Guide | Contents |
| --- | --- |
| [Personal mode](docs/personal-mode.md) | Install, API keys, contestants, tasks, running evaluations, blind review, ratings, rubrics, troubleshooting |
| [Managed mode](docs/managed-mode.md) | Deploying the server, admin setup, projects, gold and qualification, QA and results, the annotator guide, security model, operations |
| [Reference](docs/reference.md) | CLI commands, server options, task/contestant/rubric file formats, environment variables, data layout |
| [Development](docs/development.md) | Building from source, project layout, tests, packaging, conventions |

## Status

Working and tested end to end with real model APIs (Personal mode) and through an automated 54-check API test
(Managed mode). The Windows executables aren't code-signed yet. Not built yet: adapters for CLI agents (Claude Code,
Codex CLI, Gemini CLI), SSO for Managed mode, and annotator pay tracking.

## License

Arbiter is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify and
share it for noncommercial purposes: personal projects, research, education, hobby use, and use by charities,
educational institutions and government bodies.

**Commercial use requires a separate license.** That includes using Arbiter inside a company, or offering evaluations
as a paid service (for example running Managed mode for clients). For commercial licensing, contact
**kamdenmorgan108@gmail.com**.

Copyright 2026 Kamden Morgan.
