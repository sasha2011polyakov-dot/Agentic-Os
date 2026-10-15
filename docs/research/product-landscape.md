# Analysis of existing solutions

Research date: **2026-10-12**. Every claim below relies on the listed sources; where a conclusion is our interpretation, it is marked explicitly ("conclusion").

> A limitation of the research: the network policy of the development environment blocked direct access to `help.obsidian.md`, `docs.ollama.com`, `lmstudio.ai` and some other domains. The Obsidian documentation was studied from its official source repository `github.com/obsidianmd/obsidian-help` (commit `08ef563`, 2026-10-11), which is the same content that is published on help.obsidian.md. The Ollama documentation was studied from `docs/api.md` in `github.com/ollama/ollama` (the `main` branch). The other pages were retrieved through a web scraping service (Firecrawl), with the original URL given.

## 1. Summary table

| Product | Type | Storage | AI | What we learn | What we avoid |
|---|---|---|---|---|---|
| Obsidian | PKM, desktop | Markdown files in a vault folder, metadata in a cache | Only through plugins | The vault as a plain folder; wikilinks; backlinks; properties; search with operators; the local graph; JSON Canvas | Plugins get the full rights of the application |
| Khoj | AI "second brain", self-hosted | An index in its own database | Local (Ollama, OpenAI-compatible) and cloud models | Routing between local and cloud models; clients for Obsidian/Emacs | Needs a separate server (Python/FastAPI); AGPL-3.0 |
| Reor | AI notes, desktop | Markdown + LanceDB | Ollama, Transformers.js | Automatic "related notes" from embeddings | Embedding-based links are not marked as hypotheses |
| Smart Connections | An Obsidian plugin | Embeddings in the vault | Local embeddings by default | Local embeddings out of the box | — |
| AnythingLLM | A RAG platform, desktop/self-hosted | Workspaces | Local and cloud models, agents, MCP | Context isolation per workspace; MCP support | A chat-centric interaction model |
| Aider | An AI coding assistant, CLI | A Git repository | Any models | The "repo map": a symbol map through tree-sitter, ranked by the reference graph | — |
| Microsoft GraphRAG | An indexing method | An entity graph + community summaries | LLM entity extraction | Community summaries for "global" questions | ≈75% of the indexing cost is LLM graph extraction |
| Letta (MemGPT) | An agent memory framework | Core/archival/recall memory | Any models | Separating "working" and "archival" memory | — |
| SearXNG | A metasearch engine, self-hosted | — | — | A JSON search API without keys on one's own instance | Public instances often disable JSON |
| Model Context Protocol | A tool protocol | — | — | Standardized tools/resources/prompts, JSON-RPC over stdio | Arbitrary MCP servers = arbitrary code |

## 2. Obsidian: the functional reference

Source: `github.com/obsidianmd/obsidian-help`, the `en/` folder (commit of 2026-10-11).

### 2.1. Data storage
- A vault is a plain folder with Markdown files; other editors can change the files, and Obsidian "automatically refreshes the vault on external changes" (`Files and folders/How Obsidian stores data.md`).
- Vault settings are stored in `.obsidian/`; global settings in a system folder (`~/.config/obsidian` on Linux).
- Metadata (links, headings, properties) is stored in a **metadata cache** (IndexedDB); the cache can be rebuilt from the files if it gets out of sync.

**Conclusion:** the file is the source of truth, and the index is derived and rebuildable. We accept this principle: the SQLite index can always be recreated from the files, and user data (notes) always stays in Markdown.

### 2.2. Links (`Linking notes and files/Internal links.md`)
- Formats: `[[Note]]`, `[[Note.md]]`, Markdown `[text](Note%20name.md)`; links to folders use the path from the vault root with `/`.
- Headings: `[[Note#Heading]]`, nested `[[Note#H1#H2]]`; blocks: `[[Note#^block-id]]`, where `^id` uses Latin letters, digits and hyphens.
- Display text: `[[Note|Text]]`; embedding: `![[Note]]`.
- Characters not allowed in link targets: `# | ^ : %% [[ ]]`.
- Links to notes that do not exist are allowed (the note is created when the link is followed).
- The "Automatically update internal links" option on rename; when it is off, a confirmation is requested.
- Formats of new links: "shortest path", "relative path", "absolute path in the vault" (`User interface/Settings.md`).

### 2.3. Properties (`Editing and formatting/Properties.md`)
- YAML frontmatter; types: Text, List, Number, Checkbox, Date (`2020-08-21`), Date & time (`2020-08-21T10:30:00`), Tags.
- The type is fixed per **property name for the whole vault**.
- Default properties: `tags`, `aliases`, `cssclasses`; the deprecated `tag`, `alias`, `cssclass` are not supported since 1.9.
- Internal links in properties are written in quotes: `link: "[[Episode IV]]"`.
- Nested properties and Markdown in properties are not supported.

### 2.4. Tags (`Editing and formatting/Tags.md`)
- `#tag` in the text or `tags:` in the frontmatter; nested `#a/b`; case-insensitive; a tag must contain at least one non-digit character (`#1984` is not a tag).

### 2.5. Search (`Plugins/Search.md`)
- Words are combined with AND; `OR`, `-exclusion`, parentheses, `"exact phrase"`, `/regex/`.
- Operators: `file:`, `path:`, `content:`, `tag:`, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`, `match-case:`, `ignore-case:`, `[property]`, `[property:value]`, `[property:null]`, comparisons such as `[duration:<5]`.
- Search results can be embedded in a note with a ` ```query ` block.

### 2.6. The graph (`Plugins/Graph view.md`)
- Nodes are notes, edges are internal links; a node grows with the number of incoming links.
- Filters: search, tags, attachments, "existing files only", orphans; colored groups by a search query; layout force settings.
- A local graph with an adjustable depth.
- **Limitation:** all edges have one type, "link". There are no typed links.

### 2.7. Backlinks (`Plugins/Backlinks.md`)
- Linked mentions (explicit links) and **unlinked mentions** (the title mentioned without a link), with filtering and sorting.

### 2.8. Other features
- **Templates**: the variables `{{title}}`, `{{date}}`, `{{time}}` with Moment.js formats; template properties are merged with the note properties.
- **Daily notes**: a note per date `YYYY-MM-DD`; the folder and the template are configurable.
- **File recovery**: snapshots at most every 5 minutes, kept for 7 days, outside the vault; a diff between versions.
- **Bases**: views of notes as tables/cards/lists/kanban by properties; filters with "all/any/none" conjunctions; sorting; grouping; formulas. Stored in `.base` files.
- **Canvas**: `.canvas` files in the open JSON Canvas 1.0 format (`text`/`file`/`link`/`group` nodes, edges with `fromNode/toNode`, sides, arrows, labels).
- **Plugin security** (`Extending Obsidian/Plugin security.md`): "Obsidian cannot reliably restrict plugins to specific permissions… plugins will inherit Obsidian's access levels". Plugins have access to files and the network and can install programs. The protection is Restricted Mode and plugin reviews.

**The main conclusion for us:** the "plugin = code with full rights" model is unacceptable for AI agents that process untrusted content. So in our system **an agent package is declarative** (instructions, schemas, the list of requested tools and permissions) and **contains no executable code**. Every action is carried out by built-in tools through a controlled executor that checks permissions.

## 3. Local AI applications

### 3.1. Khoj
Sources: `github.com/khoj-ai/khoj`, the review `promptquorum.com/power-local-llm/khoj-ai-second-brain-review` (2026).
- Open source (AGPL-3.0), self-hosted; indexes Markdown/Obsidian, PDF, Notion; chat with documents; agents; local models through Ollama, llama-cpp-server or any OpenAI-compatible server; cloud models from OpenAI, Anthropic, Google.
- **What we learn:** one provider layer with an OpenAI-compatible adapter covers most local servers.
- **The difference:** Khoj is a separate server (Python), while we embed the AI Core into a local application and focus on verifiable pipelines instead of chat.

### 3.2. Reor
Source: `github.com/reorproject/reor`.
- A desktop note-taking application; it "automatically links similar notes", offers semantic search and questions to notes; Ollama + Transformers.js + LanceDB locally.
- **Conclusion:** the "related notes" feature is in demand. We build it, but similarity links from embeddings are stored as **suggestions** (`origin = ai_suggested`, with a confidence and a reason) and never enter the graph as facts without a confirmation.

### 3.3. Smart Connections
Sources: `github.com/brianpetro/obsidian-smart-connections`, `smartconnections.app`.
- Embeddings are created locally by default; related notes are shown in a side panel or at the end of a note.
- **Conclusion:** local embeddings are a sensible default; cloud ones only with explicit consent.

### 3.4. AnythingLLM
Sources: `github.com/mintplex-labs/anything-llm`, `anythingllm.com`.
- Desktop and self-hosted; chat with documents (RAG), agents in a workspace (including web browsing), MCP support.
- **Conclusion:** context isolation per workspace is useful; our counterpart is **the run scope**: an agent sees only the explicitly selected sources.

## 4. Working with code and repositories

### 4.1. The Aider repo map
Sources: `aider.chat/docs/repomap.html`, `aider.chat/2023/10/22/repomap.html`.
- The repository map: files and the signatures of key symbols (classes, functions), selected through the graph of references between symbols (PageRank-like ranking); built on tree-sitter.
- **Conclusion for v1:** full tree-sitter (native or WASM grammars) complicates the build considerably. In v1 we build a **light project map**: the tree, manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`…), entry points, READMEs, tests and a symbol outline extracted with regular expressions for common languages. The limitation is documented explicitly. Tree-sitter is a candidate for later versions.

## 5. Knowledge graphs and RAG

### 5.1. GraphRAG (Microsoft)
Sources: `microsoft.github.io/graphrag/index/methods/`, arXiv 2404.16130.
- An LLM extracts entities and relations from every fragment and builds summaries of graph "communities". This helps a lot with global questions about a corpus.
- The authors themselves estimate graph extraction at about **75% of the indexing cost**.
- **Conclusion:** for local models on an ordinary laptop, full LLM indexing of the whole vault is too expensive. In v1 the graph is built **deterministically** (links, frontmatter, tags, the project structure, requirement traceability), and LLM entity extraction is applied **in a targeted way**: to the documents selected for a specific workflow.

### 5.2. Hybrid search and RRF
Sources: Cormack, Clarke, Buettcher, *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods* (SIGIR 2009), through the overviews `blog.serghei.pl/posts/reciprocal-rank-fusion-explained/` and `digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026`.
- RRF combines rankings by position, not by score: `score = Σ 1/(k + rank)`, usually `k = 60`. It needs no calibration of incomparable scales (BM25 and cosine similarity).
- It helps only when the rankers are really different (lexical and vector).
- **Conclusion:** FTS5 (BM25) + vector search → RRF. The vector part is optional.

### 5.3. sqlite-vec
Sources: `github.com/asg017/sqlite-vec`, `alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/`.
- An SQLite extension in pure C without dependencies, MIT/Apache-2.0; `vec0` virtual tables; only brute-force KNN so far.
- There is a community fork `vlasky/sqlite-vec` because maintenance of the original slowed down (Reddit, r/vectordatabase): a **maintenance risk**.
- **Conclusion:** a loadable native extension complicates the build for three OSes. For the size of a personal knowledge base (up to tens of thousands of fragments), a brute-force cosine similarity in JS over `Float32Array` from a BLOB column has the same asymptotics without a native dependency. sqlite-vec stays a future optimization behind the `VectorIndex` interface.

## 6. Agent memory

### 6.1. Letta (MemGPT)
Sources: `letta.com/blog/agent-memory/`, `letta.com/blog/benchmarking-ai-agent-memory/`.
- The memory model: core memory in the context (like RAM) and archival/recall memory in external storage (like a disk), which the agent loads when needed.
- Letta also explores whether "a file system is enough as memory".
- **Conclusion:** our "long-term memory" is the knowledge base itself (Markdown + graph + index) plus a structured table of **confirmed facts** with links to sources and a freshness date. The model gets only selected context (search + graph), not the whole vault. See `ai-memory-and-retrieval.md`.

## 7. Protocols and formats

### 7.1. Model Context Protocol (MCP)
Sources: `modelcontextprotocol.io/specification/2025-06-18`, `modelcontextprotocol.io/specification/2025-03-26/basic/transports`.
- Servers provide Tools (functions for the model), Resources (data) and Prompts; the transports are stdio and HTTP; the messages are JSON-RPC 2.0 (`tools/list`, `tools/call`).
- **Conclusion:** MCP is the natural way to extend the tools. However, an MCP server is an executable process, so it carries the same risk as Obsidian plugins. v1 **does not include** MCP. The tool architecture (input and output schemas, permission checks in the executor) is compatible with the MCP tool model, so an adapter can be added later. Mandatory conditions: an explicit consent of the user and running in a separate process with limited rights.

### 7.2. JSON Canvas 1.0
Source: `github.com/obsidianmd/jsoncanvas/spec/1.0.md` (version of 2024-03-11).
- Top level: `nodes[]`, `edges[]`; node types `text`/`file`/`link`/`group`; mandatory `id, type, x, y, width, height`; edges `fromNode/toNode`, `fromSide/toSide`, `fromEnd/toEnd` (`none|arrow`), `label`, `color` (hex or the presets `"1"…"6"`).
- **Conclusion:** if we implement Canvas, then only in this open format: compatibility with Obsidian comes for free and can be verified.

## 8. Final conclusions that shaped the architecture

1. **Files are the source of truth, the index is derived** (Obsidian) → an SQLite index that can be fully rebuilt from the files.
2. **Typed links with an origin** (what Obsidian lacks) → `edges.relation` + `edges.origin` + `confidence` + `evidence`.
3. **Declarative agents without code** (the lesson of Obsidian plugins) → manifest + instructions + schemas; the tools are built in.
4. **An OpenAI-compatible adapter covers most local servers** (Khoj, LM Studio) → adapters: native Ollama, OpenAI-compatible, Anthropic.
5. **Embedding links are suggestions, not facts** (Reor and Smart Connections do not mark them) → the `suggested` status until confirmed.
6. **A deterministic graph + targeted LLM extraction** (the cost of GraphRAG).
7. **Hybrid search: FTS5 + vectors through RRF** when an embedding model exists; without one, FTS5 only.
8. **MCP later and only in isolation.**
