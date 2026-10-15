# Extensions: a protected core and safe extensibility (specification section 30)

Status: implemented · Updated: 2026-10-14
Code: `packages/core/src/extensions/*`, `packages/core/plugin-runtime/*`
Tests: `packages/core/test/extensions.test.ts` (the 12 acceptance scenarios of 30.10), `packages/core/test/examples.test.ts`
Example packages: [`examples/extensions/`](../../examples/extensions/)

## 1. Principle

The user can add agent roles, templates, workflows, themes and tools. But an extension **cannot**:

- change the core;
- turn off protections;
- grant itself permissions;
- access data bypassing the checks.

Every external package is considered untrusted, even if it has a good description or a signature. Powers are defined by the security mechanism of the application, not by the text of an extension or an agent role.

There is no corporate role model ("owner — administrator — operator"): this is a direct requirement of 30.1. One model applies to every user:

- an extension gets only what the user explicitly allowed;
- permissions are checked at the moment of every action.

## 2. The core and the extensible part

| Protected core (extensions do not change it) | Extension points |
|---|---|
| Agent permissions and run scope, file operations, project protection, running commands, models and keys, logs, extension installation, backups, knowledge systems, security settings | Agent roles (`content`), templates and workflows (`content`), themes (`theme`), tool plugins (`tools`) |

Extension files live in `<data folder>/extensions/<id>/<version>/`, separately from the application files. They are written with protection against overwriting and only inside this folder.

## 3. Kinds of extensions

The kinds are separated on purpose, so that installing a theme never gives the privileges of a plugin (30.6).

| Kind | Content | Code | Extension permissions |
|---|---|---|---|
| `theme` | design tokens and CSS | not allowed (JS, HTML, SVG are rejected) | not allowed |
| `content` | agent roles, templates, workflows | not allowed | not allowed. The user grants agent rights when installing the agent into a system |
| `tools` | tools in `tools/**/*.mjs` | allowed, only in a restricted process | only from the supported list, with a scope |

## 4. Installation (30.5)

1. **Structure.** Checked:
   - paths: no `..`, absolute or hidden paths, no symbolic links;
   - limits: up to 300 files, up to 5 MB in total, up to 2 MB per file;
   - the files allowed for the kind of extension;
   - binary files (ELF, PE, Mach-O, `#!` scripts).
2. **Manifest.**
   - The identifier cannot be reserved: `aos.`, `core.`, `builtin.`, `system.`, `app.` — an extension cannot pose as the core.
   - The version uses semver. Compatibility with the application version is checked.
   - An agent role with the identifier of a built-in agent is rejected: a built-in agent cannot be replaced.
3. **Permissions.**
   - Supported: `documents.read`, `search.use`, `network.fetch` (only with a list of domains) and `documents.create` (only with a list of folders).
   - Dangerous privileges are rejected together with the whole package, with the reason explained. These are files, commands, secrets, settings, permission management, agent management, unrestricted network access and changing the core.
4. **Code.**
   - Static analysis finds dangerous operations: processes, direct network access, file writes, `eval`, internal modules.
   - This is information for the user. The runtime blocks such operations (section 6).
5. **A description for the user.** The capabilities of the extension in plain language, the requested permissions with their risk level, the dangerous operations found and warnings. The package signature is not verified: there is no infrastructure for that, and a signature is not considered a guarantee.
6. **The user's decision.** After installation the extension is **disabled**. It can be enabled right away or later. Only the permissions the user confirmed are granted, within the requested scope.
7. **Accounting.**
   - The registry records the version, the previous version, the granted permissions and the hashes of all files.
   - An event is written to the application security log (with a hash chain).

**Updates.**
- Only a newer version is accepted.
- Newly requested permissions are **not inherited**: the card shows that they are not granted.
- Old permissions are kept only if the new version still requests them, and only within the new scope.

## 5. Integrity

- **Check.** Before enabling, before every tool run and when the CSS of a theme is served, the files are compared with the hashes recorded at installation.
- **Blocking.** If a file was changed, deleted or added, the extension gets the `broken` status and no longer runs, and a record is written to the security log.
- **What is not covered.** A person with full rights on the computer can change the application itself too. The goal is to rule out unauthorized changes through the normal interface, agents, extensions and connected content (30.9).

## 6. Plugin isolation

A plugin runs in a **separate Node.js process**. Together, the restrictions are:

| Mechanism | What it restricts |
|---|---|
| The Node permission model (`--permission`) | Reading files only in the extension folder and the runtime files. Forbidden: writing files, child processes, workers, native modules, WASI, `process.binding` |
| `guard.mjs` (loaded with `--import` before the plugin code) | Removes `fetch` and `WebSocket`. Blocks the modules `net`, `http(s)`, `http2`, `tls`, `dgram`, `dns`, `child_process`, `worker_threads`, `vm`, `module`, `sqlite`, `v8`, including `import('data:…')` and `process.getBuiltinModule`. Blocking `module` keeps a plugin from replacing the loader with its own hooks |
| `--disallow-code-generation-from-strings` | Blocks `eval` and `new Function` |
| Environment | Only `LANG`: variables with keys and tokens never reach the process |
| Limits | Timeout (30 s by default, at most 120), 128 MB of memory, up to 4 MB of output, at most 200 API calls |
| bubblewrap (Linux, if available) | In addition: an empty network namespace, a read-only file system |

**The plugin API** is the only way to data:
- `readDocument`, `search`, `fetch`, `createDocument`, `log`;
- permissions are checked **on every call** against the current state of the registry, so a revocation or disabling takes effect from the very next call;
- any other method is rejected: the API has no functions for permissions, settings, agents, files or secrets;
- every denial goes to the security log of the application and of the system.

Three rules apply to `fetch`:
- only allowed domains are accepted, including the final address after redirects;
- downloads go through the protected fetcher: local and internal addresses are blocked, and offline mode is respected;
- web access must be allowed for the run.

**Agents** call plugin tools through the `run_extension_tool` tool:
- the agent needs the separate `extensions.use` permission;
- the plugin is limited by its own permissions **and** the run scope of the agent;
- the plugin result is treated as untrusted data and checked for injected instructions.

**An honest limitation.** Without bubblewrap, direct network access of a plugin is closed by the Node.js runtime (the permission model and module interception), not by the operating system. Every run reports this in its result (`isolation.level = restricted`), and so does [SECURITY.md](../../SECURITY.md).

## 7. Themes

- **Tokens.** Only names such as `--aos-color-*`, `--aos-font-*` and others from the supported set are allowed. Values consist of a safe set of characters. `url()`, expressions, `var()`, `attr()`, `@` and escapes are not allowed.
- **CSS** goes through an allowlist filter:
  - **removed:** `@import`, `@font-face` and other rules that load resources; attribute selectors (protection against reading page data through CSS); `!important`;
  - **removed properties that can hide or replace the interface:** `display`, `position`, `z-index`, `content`, `transform`, `width` and the like;
  - **also removed:** a transparent text color, opacity below 0.6, a font that is too small.
- **Scope.** Every rule is limited to the `.aos-themable` containers of the selected theme. Confirmation and warning dialogs are outside this scope and are never restyled.
- **Animations** may refer only to the keyframes of their own theme.
- **Reset.** Returning to the standard theme is `resetTheme()`. Resetting all application settings is `resetAppSettings()`.

## 8. Roles, templates, workflows

- The agent roles of an enabled extension go into the catalog (`extension_agent_packages`). When the extension is disabled or removed, they leave the catalog.
- Installing a role into a system and granting it rights is a separate user action (30.4). Role text such as "you have full access to the disk" grants no rights (test 4).
- Templates and workflows are copied into a system only by the user's command. After that they are the user's data: removing the extension does not touch them. A workflow runs on the normal engine with all its checks.

## 9. Disabling and removal (30.9)

| Action | What happens |
|---|---|
| Disable | The roles leave the catalog. If the theme was active, the standard one is enabled. The plugin no longer runs |
| Remove | Only the extension folder (after a check that the path is inside the extensions directory) and its registry record are removed |
| Revoke permissions | Takes effect from the next operation |

What is kept:
- agents installed from a removed role stay, with a clear error status, and do not break the application;
- documents and workflows the user imported stay;
- other extensions, projects and knowledge systems are not touched (test 12 compares the files and databases before and after).

Application updates are separate from extension updates. The application has no self-update mechanism yet.

## 10. Connected repositories

Project files are data, not application configuration (30.7):

- `aos.config.json`, `.aos/settings.json`, "extension" folders inside the project and instructions in a README are **never loaded or applied** (test 8);
- only the user changes the project access mode;
- a new project is connected in "Read only" mode by default.

## 11. Mapping to the 30.10 criteria

Each of the 12 criteria is checked by the test with the same name in `packages/core/test/extensions.test.ts`:

1. A new agent role is installed and configured without changing the core.
2. A theme is added without access to files.
3. A plugin cannot raise its own permissions.
4. Changing an agent instruction does not bypass the file system restrictions.
5. An untrusted plugin does not get secrets.
6. Disabling or removing an extension does not damage the application.
7. An extension cannot change a project silently.
8. A connected repository does not override the security rules.
9. The network and file operations of plugins are limited by the granted permissions.
10. Revoking a permission blocks the next operations.
11. An update does not replace the core or widen permissions; replaced files are detected.
12. Documents, projects and other systems keep their integrity.
