# Contributing to Agentic OS

Thank you for helping! This guide explains how to set up the project, what we expect from a pull request, and the easiest ways to contribute without writing TypeScript.

## Ways to contribute

| Contribution | Skills needed | Where |
|---|---|---|
| Agent roles (instructions + JSON schemas) | Writing, JSON | [`examples/extensions/`](examples/extensions/) — see the README there |
| Themes (design tokens + CSS) | CSS | [`examples/extensions/`](examples/extensions/) |
| Templates and workflows | Markdown, JSON | [`examples/extensions/`](examples/extensions/) |
| Documentation and translations | Writing | `docs/`, `README*.md` |
| Bug reports with a reproduction | — | [Issues](https://github.com/sasha2011polyakov-dot/Agentic-Os/issues/new/choose) |
| Code: engine, API, tests | TypeScript, Node.js | `packages/core`, `apps/server` |

Issues labelled `good first issue` are small and well described — a good place to start. If you want to work on something bigger, open an issue first so we can agree on the approach.

## Development setup

Requirements: **Node.js 22.13+**, npm, Git. No model, API key or network is needed to run the tests.

```bash
git clone https://github.com/sasha2011polyakov-dot/Agentic-Os.git
cd Agentic-Os
npm ci
npm run typecheck
npm test
```

Run a single test file: `npx vitest run packages/core/test/missions.test.ts`.

Working on the web interface (`apps/ui`):

```bash
npm run build          # once: builds the interface and the server
npm run dev:ui         # rebuilds apps/ui/dist on every change (keep it running)
npm start              # in a second terminal; open the printed link, refresh the page after changes
```

Tests use a deterministic **test model provider** (enabled only with `AOS_ENABLE_TEST_PROVIDER=1`, which the test helpers set). Scripted agents answer by agent name, so agent behaviour is tested without any real model.

## Pull request checklist

- [ ] The change is focused: one problem per pull request.
- [ ] `npm run typecheck` and `npm test` pass locally.
- [ ] New behaviour has tests; a bug fix has a test that fails without the fix.
- [ ] User-visible text is clear and honest (we never claim that something was done, checked or isolated when it was not).
- [ ] Documentation in `docs/` is updated when you change how a subsystem works.
- [ ] No secrets, personal data or real API keys anywhere — including tests and fixtures.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(missions): …`, `fix(security): …`, `docs: …`, `test: …`.

## Code guidelines

- **TypeScript, strict mode, ES modules** with explicit `.ts` import extensions. Match the style of the surrounding code; Prettier-like formatting, 2 spaces.
- **No new runtime dependencies** without discussing it in an issue first: every dependency becomes part of the attack surface of a security-sensitive app.
- **Every system is isolated.** Services are constructed per system runtime (`SystemRuntime`); never reach for "the active system" from domain code.
- **Agents never gain power from text.** Permissions come from grants confirmed by the user and from the run scope — never from an agent's instructions, a document, a web page or an extension manifest.
- **Changes to user projects go through change sets.** Code must not write to a connected project directly; see [docs/architecture/security.md](docs/architecture/security.md).
- **Errors** are `AppError` with a stable code from `util/errors.ts` and an actionable hint.
- **Interface** (`apps/ui`): talks to the server only through the HTTP API, never imports the core. Never render user content with `innerHTML` or `dangerouslySetInnerHTML`: notes and connected repositories are untrusted. Colors, fonts and radii come from `--aos-*` design tokens, so theme extensions keep working.

## Contributing agent roles, themes and templates

These are **extension packages**: declarative files validated by the same code that the app uses at install time. The format, the rules and ready examples are in [`examples/extensions/README.md`](examples/extensions/README.md). Every package in that folder is validated by the test suite, so CI tells you if something is wrong.

A role's text never grants permissions: the user decides which permissions an agent gets when installing it into a knowledge system.

## Reporting security issues

Please do **not** open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Licensing of contributions

The project is licensed under the [Apache License 2.0](LICENSE). Unless you explicitly state otherwise, any contribution you submit for inclusion is licensed under the same license, as described in section 5 of the Apache License. There is no separate CLA.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
