# Extension examples

Extensions add capabilities to Agentic OS **without changing its core**. Every package here is validated by the test suite with the same code the app uses when a user installs an extension, so CI tells you immediately if a package breaks a rule.

| Example | Kind | Shows |
|---|---|---|
| [`ocean-theme`](ocean-theme) | `theme` | design tokens + CSS |
| [`meeting-notes-kit`](meeting-notes-kit) | `content` | an agent role and a document template |
| [`word-count-tool`](word-count-tool) | `tools` | a tool plugin that reads data through the plugin API |

To contribute a new role, theme or template: copy the closest example into a new folder here, change it, run `npx vitest run packages/core/test/examples.test.ts`, and open a pull request.

## Package layout

Every package has a `manifest.json` in its root:

```json
{
  "formatVersion": 1,
  "id": "yourname.short-name",
  "name": "Human-readable name",
  "version": "1.0.0",
  "description": "What it does, in one or two sentences.",
  "author": "You",
  "kind": "theme | content | tools",
  "platform": ">=0.1.0 <1.0.0",
  "contributes": { },
  "permissions": [ ]
}
```

- `id`: lowercase letters, digits and `-`, parts separated by dots. Ids starting with `aos.`, `core.`, `builtin.`, `system.` or `app.` are reserved.
- `version`: semver. An update must have a higher version.
- Allowed files depend on the kind (below). Anything else is rejected: hidden files, paths with `..`, binaries, and scripts in themes or content packs.

## Kinds

### `theme` — appearance only

```json
"contributes": { "themes": [{ "id": "ocean", "name": "Ocean", "mode": "dark", "tokens": { "--aos-color-accent": "#22d3ee" }, "css": "themes/ocean.css" }] }
```

- Allowed files: `themes/*.css`.
- Tokens: `--aos-color-*`, `--aos-font-*`, `--aos-radius-*`, `--aos-space-*`, `--aos-shadow-*`, `--aos-motion-*`, `--aos-size-*`, `--aos-border-*`.
- CSS is sanitized. Removed: `url()`, `@import`, `@font-face`, attribute selectors, `!important`, and properties that can hide or overlay interface elements (`display`, `position`, `z-index`, `content`, `transform`, …). Every rule is scoped to themable areas; confirmation and security dialogs cannot be restyled.
- A theme cannot request permissions.

### `content` — agent roles, templates, workflows

```json
"contributes": {
  "agents": ["agents/my-role"],
  "templates": [{ "id": "meeting", "name": "Meeting", "file": "templates/meeting.md", "folder": "Meetings" }],
  "workflows": ["workflows/my-flow.json"]
}
```

- An **agent role** is a folder with `manifest.json`, `instructions.md`, `tools.json`, `schemas/input.schema.json`, `schemas/output.schema.json`, `tests/test-cases.json` and `README.md`. The built-in agents in [`packages/core/agents-builtin`](../../packages/core/agents-builtin) use the same format.
- A role **requests** permissions in its manifest, but gets only what the user grants when installing it into a knowledge system. Instructions like "you have full disk access" give no access at all.
- Templates and workflows are copied into a knowledge system only when the user imports them. Workflows run in the regular workflow engine, with all its limits.
- A content pack cannot request permissions of its own and cannot contain code.

### `tools` — plugins with code

```json
"contributes": { "tools": [{ "name": "count_words", "title": "Count words", "description": "…", "entry": "tools/count.mjs", "inputSchema": { "type": "object" }, "timeoutSec": 10 }] },
"permissions": [{ "permission": "documents.read", "reason": "Read the document to count." }]
```

- Allowed files: `tools/**/*.mjs` and `tools/**/*.json`. The entry exports a default async function `(input, api) => result`.
- The plugin runs in a separate Node process:
  - it can read only its own files and cannot write any;
  - it cannot start programs, workers or native addons;
  - it has no direct network access and an empty environment.
- The plugin API is the only way to data:

| Method | Needs permission | Scope |
|---|---|---|
| `api.readDocument(docId)` | `documents.read` | documents inside the run's scope |
| `api.search(query, limit)` | `search.use` | the run's scope |
| `api.fetch(url)` | `network.fetch` | listed `domains` only; local and internal addresses are always refused |
| `api.createDocument({ title, folder, content })` | `documents.create` | listed `folders` only |
| `api.log(message)` | — | — |

- Permissions are checked on **every** call, so revoking one takes effect immediately.
- Never requested, always refused: file access, running commands, secrets, settings, permission management, unrestricted network.

More details: [docs/architecture/extensions.md](../../docs/architecture/extensions.md).
