# Feature map: Obsidian → Agentic OS

The source of Obsidian behaviour is the official documentation (`obsidianmd/obsidian-help`, commit of 2026-10-11); see `docs/research/product-landscape.md`.

**Important:** Agentic OS **does not claim full compatibility with Obsidian**. Compatibility exists only at the format level: Markdown files, wikilinks, YAML frontmatter, tags. It is checked by `packages/core/test/markdown.test.ts` and `packages/core/test/knowledge.test.ts`. An Obsidian vault can be opened as an Agentic OS vault, and its files will be read. But v1 does not interpret the `.obsidian/` folder, Obsidian plugins, `.base` files or `.canvas` files.

Statuses: **✅ implemented and covered by tests** · **🟡 partial** · **⏳ planned**. The statuses follow the actual implementation; see the "Status" part of the README.

## 1. Mapping table

| Capability | What it solves / scenario | Required behaviour in Agentic OS | Implementation module | Done when |
|---|---|---|---|---|
| Vault | Keep knowledge as plain files, not tied to the application | The user creates or opens a vault folder; every note is a `.md` file in that folder; external changes are picked up | `core/vault`, `core/index` | Creating a vault → the file appears on disk; an external change of a file shows in the index without a restart |
| Markdown | Portability | CommonMark + GFM (tables, tasks, strikethrough) + wikilinks, `==highlight==`, `%%comment%%` in the link parser | `core/markdown`, `ui/markdown` | A document created in the application opens in any editor without losses |
| Internal links | Link notes | `[[Note]]`, `[[Note\|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `![[embed]]`, `[text](Note.md)`; resolution: exact path → shortest path (file name) → `aliases`; case-insensitive | `core/markdown/links`, `core/index/resolver` | Link resolution tests; clicking a link opens the document |
| Unresolved links | See the "gaps" of the knowledge base | A link to a document that does not exist = an `unresolved` node; clicking it offers to create the document | `core/graph` | An unresolved link is visible in the graph and in the links panel |
| Updating links on rename | Do not break links | Before a rename, a **change plan** (which files and lines will change) → confirmation → application with a backup | `core/vault/rename` | Test: a rename updates `[[Old]]` → `[[New]]` in every linking file; the plan is shown before it is applied |
| Backlinks | Who links to a document | A "Backlinks" panel (linked) + "Unlinked mentions" (by title and aliases) | `core/index`, `ui/knowledge` | Test: B links to A → A shows B among its backlinks |
| Graph View | An overview of links | An interactive graph: zoom, pan, node search, filters, click → open | `core/graph`, `ui/graph` | The graph is built from real links and updates when a file changes |
| Local Graph | The context of a document | Neighbours at depth 1–3 around the selected document | `core/graph.local()` | A BFS test by depth |
| Properties | Structured metadata | YAML frontmatter; types text/list/number/checkbox/date/datetime/tags; the type is inferred and fixed per property name; a property editor in the UI | `core/markdown/frontmatter`, `core/index/properties` | Properties are available in search filters and in the table view |
| Templates | Consistent documents | Built-in templates + user templates (`Templates/` in the vault); variables `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}` | `core/vault/templates` | Creating a document from a template fills in the variables |
| Search | Find things fast | FTS5 (BM25) + operators: `"phrase"`, `OR`, `-word`, `tag:`, `path:`, `file:`, `type:`, `project:`, `[prop]`, `[prop:value]`; snippets with highlights; jumping to the match | `core/search` | Query parser and result tests |
| Tags | Topic classification | `#tag` in the text and `tags:` in the frontmatter; nested `a/b`; case-insensitive; `#1984` is not a tag | `core/markdown/tags` | Tag extraction tests |
| Canvas | Spatial thinking | The JSON Canvas 1.0 format | — | ⏳ Later (see section 2) |
| Bases | Tables over properties | A table view of documents with property columns, filters and sorting (no formulas, no `.base` files) | `ui/knowledge/table` | A property filter narrows the table |
| Daily Notes | A journal, daily context | The "Daily note" command opens or creates `Daily/YYYY-MM-DD.md` from a template | `core/vault/daily` | Calling it again opens the same note |
| Command Palette | Everything from the keyboard | `Ctrl/Cmd+K`: commands and navigation to documents, sections, actions | `ui/command-palette` | Every main action is available from the palette |
| Workspaces / panels / navigation | Everyday convenience | A route for every section; resizable panels; the last document and the graph settings are restored | `ui/shell` | Panel widths and the theme are kept between launches |
| Change history (File recovery) | Protection against loss | A snapshot of the content before every overwrite (deduplicated by hash); viewing, diff, restore | `core/history` | Test: an edit → restoring the previous version |
| Import / export / backup | Data ownership | A database backup (`VACUUM INTO`) + optionally a vault archive; restore; integrity checks; export of tasks (MD/JSON/CSV) and agent packages (zip) | `core/backup`, `core/tasks/export`, `core/agents/package` | Test: backup → restore → the data is in place |

## 2. Grouping by version

### Required in the first version
Vault; Markdown; wikilinks and Markdown links; backlinks and unlinked mentions; unresolved links; updating links on rename (with a plan); properties and tags; templates (10 built-in + user ones); daily notes; full-text search with operators; a global and a local graph with typed links; version history and restore; the command palette; connecting folders and Git repositories (read only); incremental indexing and file system watching; AI Core (Ollama, OpenAI-compatible, Anthropic); agent packages and permissions; the workflow engine; the specification pipeline; tasks; web research; the audit log; backups; the built-in guide.

### Extended features for professional use
Semantic search and hybrid RRF (when an embedding model is available); a table view over properties (Bases-lite); AI link suggestions with confirmation; source freshness checks; a knowledge base integrity report (broken links, orphans, duplicates); the visual workflow editor; a task kanban and a dependency graph.

### Possible future features
Canvas (JSON Canvas 1.0); PDF/DOCX/OCR parsers (candidate: Docling as an external local process); a tree-sitter code map; an MCP tool adapter in an isolated process; `.base` files and formulas; sync between devices; publishing; multiple windows; a mobile client.
