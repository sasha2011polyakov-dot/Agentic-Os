# Multiple knowledge systems (specification section 27)

Status: accepted · Date: 2026-10-12

A **system** is an independent data space: documents, connected projects, the graph, tasks, agents and their settings, workflows and their results, indexes, history, the log and settings. The main invariant: **an operation on system X does not change the data of any other system**, except for explicitly approved cross-system operations.

## 1. Physical model

```
<application data folder>/              (~/.local/share/agentic-os, ~/Library/Application Support/Agentic OS, %APPDATA%\Agentic OS; overridden by AOS_DATA_DIR)
  registry.db          system registry, application settings, shared AI providers, AI call accounting, registry operations log
  agents/              shared agent packages (application level)
  backups/<system_id>/ system backups (*.aosys)
  logs/app.log         application log (JSONL, with secrets masked; every record that concerns a system contains its system_id)

<storage_path of the system>/           (any place the user chooses)
  *.md, folders        documents of the system (the root is the main knowledge vault, like an Obsidian vault)
  Templates/           user templates of the system
  .trash/              trash of the system
  .aos/
    system.json        manifest: { format, formatVersion, systemId, name, createdAt }
    system.db          ALL data of the system: sources, index, FTS, graph, tasks, agents (configs and grants), workflows and runs, version history, audit log, system settings
    agents/            system-level agent packages
    migration-backups/ copies of system.db made before schema migrations
```

**Why a separate SQLite database per system instead of one shared database with `system_id`:**
- isolation by construction: an SQL query of one system physically cannot read or change the rows of another (a mistake in a `WHERE` clause does not leak data);
- a backup, an export or a move is a copy of one folder and one database;
- damage to one database does not affect the others;
- deleting a system means deleting its folder, not cascading deletes of rows in a shared database.

The only shared database is the **registry** (`registry.db`). Every record in it that concerns a system contains `system_id`.

## 2. Identifiers
- `system_id` = `sys_<ULID>`: generated at creation, written to `system.json` and to the `meta` table of `system.db`, and **never changes** (renaming changes only `name`).
- Object identifiers (documents, tasks, graph nodes) are unique within a system. A global reference to an object is the pair `(system_id, object_id)` (`systemId` + `id` in the API and the UI). Cross-system links store both pairs.
- Equal titles, paths or contents of documents in different systems **never** merge them: global search results are told apart by `(system_id, doc_id)`.

## 3. Components

| Component | Responsibility |
|---|---|
| `SystemRegistry` (`core/systems/registry.ts`) | CRUD of registry records, availability checks of the storage folders, registry integrity checks |
| `SystemManager` (`core/systems/manager.ts`) | Create, connect an existing one, disconnect, reconnect, rename, change the path (relocate), remove from the list, delete data; keeps the open `SystemRuntime` objects |
| `SystemRuntime` (`core/systems/runtime.ts`) | All services of **one** system, bound to its `Db` and paths: sources, indexer, watcher, search, graph, documents, tasks, agents, workflows, history, audit. Background jobs get a runtime, never "the current system" |
| `SystemSearch` (`core/systems/global-search.ts`) | Search in one system or in several selected ones; results are merged with RRF; every result is labeled with its system |
| `SystemGraph` | The graph of a system (`core/graph`); an overview of several systems merges the graphs with a `system_id` prefix in the node IDs |
| `SystemBackup` / `SystemImportExport` (`core/systems/archive.ts`) | The `.aosys` archive: a snapshot of `system.db` (`VACUUM INTO`), the document files, the agent packages, a manifest with checksums |
| `CrossSystemAccessPolicy` (`core/systems/cross-access.ts`) | Permission for cross-system reading during a workflow run |
| `SettingsService` (`core/settings`) | Two-level settings with inheritance: default → application → system; the API returns the value **and where it comes from** |

## 4. Lifecycle and statuses

Registry statuses: `connected` (connected and available), `disconnected` (disconnected by the user; the data and the registration are kept), `unavailable` (the folder was not found or cannot be read; set automatically by a check, **the system is not deleted**), `error` (the database does not open or the manifest does not match).

| Operation | What it does | What it never does |
|---|---|---|
| Create | A new folder (or a chosen empty one) → `.aos/system.json` + `system.db` → a registry record | Does not touch other systems or their records |
| Connect existing | Reads `.aos/system.json`; on an ID conflict the user chooses: open the existing one / register a copy under a new ID / cancel | Does not overwrite a registered system |
| Switch | Changes the active UI context (`app_settings.ui.activeSystemId`), updates `last_opened_at` | Does not close or clear other systems |
| Disconnect | Stops the watchers and indexing; for active workflows it warns and lets the user choose (wait / pause / cancel) → status `disconnected` | Does not delete files or the registration |
| Reconnect | `disconnected` → `connected`, reopens the database, catches up with indexing | Does not create a duplicate |
| Rename | Changes `name` in the registry and in `system.json` | Does not change `system_id` |
| Change the path (relocate) | The user chooses a new folder → `system.json.systemId` is checked → confirmation → `storage_path` is updated | Does not accept a folder with another ID |
| Remove from the list | Removes the registry record | Does not delete files |
| Delete data | A separate procedure: name, path, what will be deleted, an offer to make a backup, typing the name to confirm; options: "service data only (.aos)" or "the whole system folder"; the steps are recorded in `operations` | Does not report success before it actually finishes; does not delete if the manifest in the folder does not match the `system_id` |

## 5. Cross-system operations
- **A system agent** is a package in the `.aos/agents/` folder of the system; it is visible only there.
- **A shared application agent** is a package in `<data>/agents/`; it is visible in every system, but enabling it, its model configuration and its permissions are stored **separately in each system** (`agent_configs`, `agent_grants` in `system.db`). An agent that is not enabled in a system does not run there.
- **A cross-system workflow** runs in its "home" system with an explicit list of additional systems, `scope.extraSystems`. Every additional system needs (1) an explicit choice by the user when the run starts and (2) the `systems.read` grant for the agent in the home system. v1 does not support writing to other systems: the result is saved in the home system, and the origin of the data is `(system_id, doc_id)` in facts and edges.
- **A cross-system link** is stored in the `cross_links` table of the source system: `(src_node, target_system_id, target_object_id, target_label, relation)`. If the target system is deleted or unavailable, the link is shown as unavailable, and the graph of the source is not damaged.

## 6. Settings

| Level | Where it is stored | Examples |
|---|---|---|
| Application | `registry.db: app_settings` | Theme, keyboard shortcuts, offline mode, shared AI providers, the default AI mode, logging, the monthly budget |
| System | `system.db: settings` | Indexing exclusions and parameters, the graph, templates, document rules, search, backups, agent permissions, **overrides**: the AI mode, the default model, the cloud policy |

Inheritance: `default → app → system`. Next to each value the UI shows where it comes from ("default", "from the application settings", "overridden in the system") and a "Reset to inherited" button. Offline mode is an application setting: a system cannot allow the network when the application is offline. An override cannot weaken a global restriction.

## 7. Protection against data loss
- Every API call that changes data names the system explicitly (`/api/systems/:systemId/...`). The server checks that the object belongs to that system: the lookup runs **in the database of that system**, so a foreign ID returns `NOT_FOUND`.
- Background jobs (indexing, workflows, the watcher) are created inside a `SystemRuntime` and keep a reference to it; event and audit records contain `system_id`.
- `system.db` schema migrations: before a migration, `VACUUM INTO .aos/migration-backups/system-v<from>-<ts>.db`; the migration runs in a transaction; on an error the database stays at the previous version and the system gets the `error` status with a hint. Other systems open as usual.
- Crashes: SQLite WAL makes transactions atomic; file writes are atomic (tmp + rename); unfinished workflow runs are recovered at startup (`running` → the stage runs again with an increased attempt counter); unfinished registry operations (`operations.status = running`) are shown to the user.
- No operation of the normal scenarios "clears all data", "recreates the database" or "replaces the storage".

## 8. The `.aosys` archive format (export, backup)

A zip archive:
```
manifest.json      { format: "agentic-os-system-archive", formatVersion: 1, systemId, name, description, createdAt, exportedAt, appVersion, schemaVersion, includesHistory, files: { "<path>": "<sha256>" } }
system.db          a database snapshot (VACUUM INTO); if history is not included, the version tables are cleared in the copy
files/**           documents of the system (without .aos and .trash)
agents/**          system-level agent packages
```
The archive contains no secrets by construction: `system.db` stores only references to keys, and the keys themselves live in the OS secret store. Connected external projects are exported as configuration (paths), not as files: on import the paths are checked, and unavailable sources get the `unavailable` status.

Import: the manifest, the format version and the checksums are checked → unpacking into a temporary folder next to the target → a check that the database opens → an atomic rename into the target folder → registration. On an ID conflict the user chooses (open the existing one / import as a copy with a new ID / cancel). On any error the temporary folder is deleted and existing systems are not touched.
