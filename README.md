# Agentic OS

**A local-first knowledge OS where AI agents work on your notes and projects — and have to prove their results.**

[![CI](https://github.com/sasha2011polyakov-dot/Agentic-Os/actions/workflows/ci.yml/badge.svg)](https://github.com/sasha2011polyakov-dot/Agentic-Os/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933)

> **Status: alpha.** The core engine, the local HTTP API and a first version of the web interface are implemented.
> The desktop app is **not built yet**: run the local server and open the interface in your browser.
> The English interface and a usability redesign are in progress; screenshots will be added when they are done.

## Why

AI assistants are good at producing text that *looks* like finished work. Agentic OS is built around the opposite idea:

- **Your data stays on your machine.** Notes are plain Markdown files in folders you own. Local models (Ollama, LM Studio) work without any API key; cloud models are optional and never used automatically in local mode.
- **Agents cannot quietly change your projects.** Connected repositories are read-only by default. Agents only *propose* changes; checks run in an isolated work copy; nothing reaches the original files without your review, confirmed risks and a verified backup.
- **"Done" must be earned.** A task is marked completed only when its acceptance criteria are met with evidence: quotes are verified against the source in code, checks must actually run and pass, and a verifier's "looks good" without evidence is downgraded.

## What works today

| Area | What is implemented |
|---|---|
| Knowledge systems | Several independent systems, each in its own folder with its own database; adding or switching one never touches another. |
| Notes | Markdown vault, `[[wikilinks]]`, properties (frontmatter), templates, history and restore, rename with link updates, attachments, daily notes. |
| Connected folders | Read-only indexing of projects and repositories (respects `.gitignore`, skips secrets), full-text search with operators, knowledge graph. |
| AI core | Providers: Ollama, OpenAI-compatible servers, Anthropic. Router with local / hybrid / cloud modes, offline mode, confidential sources kept local, budgets, key storage by reference. |
| Agents | Declarative agent packages (instructions + JSON Schema input/output + tools), permissions granted per system by the user, 22 built-in agents. |
| Workflows | Durable workflow engine (agents, functions, approvals, loops) with crash recovery; built-in pipelines for technical specifications and web research; task tracker. |
| Web research | SSRF-safe fetching and citation grounding: claims count only when the quote is found in the downloaded page. |
| Missions | A task in natural language → analysis, research, strategy, plan, execution, verification, bounded fix rounds, independent review, honest summary. Pause, resume, add requirements, deny tools, retry steps. |
| Project protection | Access modes (read-only → prepare → work copy → apply), isolated work copies, verified backups, review bound to content hashes, sandboxed checks (bubblewrap when available), script vetting, an append-only hash-chained security journal. |
| Extensions | Agent roles, templates, workflows, themes (sanitized CSS) and tool plugins. Plugins run in a restricted Node process and reach data only through an API checked against the permissions you granted. |
| Local API | Listens on `127.0.0.1` only; a login link with a per-launch token → session cookie; Host/Origin/CSRF checks; strict CSP. |
| Web interface | Notes with a Markdown editor and `[[link]]` suggestions, properties, backlinks and unlinked mentions, folder tree, full-text search with operators, interactive knowledge graph, missions with every approval step, command palette (`Ctrl/Cmd+K`), light and dark themes, phone-sized layout. |

## Quick start

Requirements: **Node.js 22.13 or newer** (uses the built-in `node:sqlite`), npm, Git.

```bash
git clone https://github.com/sasha2011polyakov-dot/Agentic-Os.git
cd Agentic-Os
npm ci
npm test            # runs the full test suite (no network or model needed)
npm run build       # builds the web interface and the server
npm start           # prints a login link — open it in your browser
```

The link contains an access token that is valid until the server stops; do not share it.

Useful options: `npm start -- --port 4321 --data-dir ./my-data`. The data directory can also be set with `AOS_DATA_DIR`.

### Local models

Install [Ollama](https://ollama.com), pull a model that handles structured (JSON) output well, and select it in the AI settings of the system. Small models (under ~7B parameters) often fail structured output; when a model fails a step, the engine tries another **local** model and asks you instead of switching to the cloud.

## Repository layout

```
packages/core            engine: systems, vaults, indexing, search, graph, AI core, agents,
                         workflows, missions, project protection, extensions
packages/core/agents-builtin    built-in agent packages (data only, no code)
packages/core/plugin-runtime    guard + runner for extension plugins (restricted Node process)
apps/server              local HTTP API and CLI
apps/ui                  web interface (React); talks to the server only through the HTTP API
apps/desktop             planned: desktop shell
docs/architecture        design documents (start with overview.md)
docs/spec                original requirements for the larger subsystems
docs/research            background research
```

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Security model and its limits](docs/architecture/security.md)
- [Missions: natural-language tasks](docs/architecture/missions.md)
- [Workflow engine](docs/architecture/workflow-engine.md)
- [AI core and web research](docs/architecture/ai-and-web-research.md)
- [Multiple knowledge systems](docs/architecture/multi-system.md)

## Contributing

Contributions are welcome — code, docs, translations, agent roles, themes, templates and workflows. Agent roles and themes are plain JSON/Markdown/CSS, so you can contribute without writing TypeScript. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and issues labelled `good first issue`.

## Security

Please do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md). No software is perfectly secure; the documented limits of the sandbox and extension isolation are in [docs/architecture/security.md](docs/architecture/security.md).

## License

[Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).
