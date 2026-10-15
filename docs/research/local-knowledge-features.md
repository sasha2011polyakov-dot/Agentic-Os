# Capabilities for working with local information

Date: 2026-10-12. Sources: see `product-landscape.md`. For every hypothesis below: what works with **plain code**, where a **model is really needed**, and the final decision.

## A. Intelligent search

| Hypothesis | How it is implemented | Code / model | Resources | Decision |
|---|---|---|---|---|
| Full-text search over large collections | SQLite FTS5, BM25 ranking, the `unicode61 remove_diacritics 2` tokenizer (any alphabet) | Code | The index is ≈ 30–60% of the text size (an estimate; it depends on the corpus) | **v1** |
| Search for substrings, identifiers, parts of words | A second FTS5 table with the `trigram` tokenizer over titles and paths (checked: available in SQLite 3.50.4 from `node:sqlite`) | Code | Small: only titles and paths are indexed | **v1** |
| Semantic search | Fragment embeddings (Ollama `/api/embed` or OpenAI-compatible `/v1/embeddings`), cosine similarity | An embedding model | ~1–3 KB per fragment at 384–768 dimensions × 4 bytes | **v1, optional** |
| Hybrid search | RRF (k=60) over FTS5 and vectors | Code | Minimal | **v1** when embeddings exist |
| A question in natural language | Search selects fragments, the model answers with quotes (RAG) | Model | Depends on the model | **v1** through the "Researcher" agent |
| Search by metadata and links | The operators `tag:`, `type:`, `project:`, `[prop:value]`, `linksto:`, `linkedfrom:` | Code | — | **v1** |
| Finding contradictions | Candidates: documents of the same project and type with a high term overlap; the verdict comes from a model | Code + model | Limited to the selected scope | **v1** inside the specification pipeline |
| Outdated and duplicate material | Duplicates: an identical hash (exact) + high trigram/embedding similarity (candidates). Outdated: `updated` older than a threshold + incoming links from active tasks | Code (+ a model for confirmation) | — | **v1**: exact duplicates and staleness; similarity candidates are an extended feature |
| Search across several projects | One index over all sources, the `project:` filter | Code | — | **v1** |
| Respecting permissions and confidentiality | A source is marked `sensitivity: confidential` → its content is never sent to cloud models | Code | — | **v1** |

## B. Intelligent document processing

| Operation | By code | Needs a model |
|---|---|---|
| Document type | The frontmatter `type`, the extension, the path (`docs/`, `adr/`, `test/`) | Classifying free-form notes without metadata |
| Headings, structure, outline | The Markdown parser | — |
| Entities and terminology | Headings, bold text, glossaries, frontmatter keys | Named entities in free text |
| Requirements | "must/shall/should" patterns, IDs like `REQ-…` | Splitting into atomic requirements, normalization, acceptance criteria |
| Key decisions | Documents with `type: decision`/ADR | Extracting decisions from meeting notes |
| Open questions | Lines with `?` in "Questions"/"Open questions" sections, unchecked `- [ ]` | Implicit questions |
| Comparing versions | A line diff (LCS) | A semantic diff |
| Outdated information | Dates, the source review date, links to replaced documents (`supersedes`) | A semantic contradiction with a newer version |
| Summary | — | Yes |

**Principle:** everything that code can do reliably is done by code: it is free, reproducible and works offline.

## C. Automatic linking of knowledge

1. **Explicit links** (from links, the frontmatter `project`, `depends_on`, `implements`, `supersedes`, `conflicts_with`) → `origin = explicit`.
2. **Deterministically extracted links** (a file in a project folder → `belongs_to`; a task created from a requirement → `derived_from`) → `origin = extracted`.
3. **Links suggested by AI or by similarity** (embeddings, term matches) → `origin = ai_suggested`, `status = suggested`; `confidence` and `evidence` (what it is based on) are mandatory. The graph shows them dashed and hides them with a default filter. The user accepts them (→ `confirmed`) or rejects them (→ `rejected`; they are not suggested again).

## D. Analyzing projects and repositories

- **The project map (v1, by code):** a tree that respects `.gitignore` and the exclusion rules; languages by extension; manifests (`package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`); entry points (`main`/`bin` from manifests, `src/main.*`, `index.*`, `app.*`); tests (`test/`, `tests/`, `*_test.*`, `*.test.*`, `*.spec.*`); documentation (`README*`, `docs/`, `*.md`, ADRs).
- **A symbol outline (v1, regex):** TS/JS (`export function|class|const`), Python (`def`, `class`), Go (`func`, `type`), Rust (`fn`, `struct`, `enum`, `trait`), Java/Kotlin/C# (`class`, methods with access modifiers). **Limitation:** regexes do not understand nesting and macros; claiming that "the code was fully analyzed" is forbidden.
- **Git (read only):** the branch and HEAD are read directly from the `.git` files (without starting a process); `git log`/`status` are optional and run with protective flags (see `docs/architecture/security.md`, the Git section).
- **Linking requirements to code:** mentions of requirement IDs (`REQ-001`) in code and tests → `implements`/`verifies` edges (`origin = extracted`).

## E. Managing knowledge over time

- Every document: `created`/`updated` from the frontmatter (if present) and from the file system; the version history in the database.
- Every web fact: `published_at` (if known) separately from `retrieved_at`; `verified_at` and `review_after` (the date for the next check).
- **Staleness without deletion:** a document gets the computed status `stale` if its `review_after` has passed or there is a `superseded_by` edge. A stale document stays in the knowledge base, gets a mark in the UI and appears in the "Needs review" report.
- Tasks that depend on requirements with the `superseded`/`stale` status are highlighted.

## F. Automating everyday work: assessment

| Scenario | Benefit | Cost | Risk of wrong automation | Decision |
|---|---|---|---|---|
| Checking links and the integrity of the knowledge base | High | Zero (code) | None | **v1**: the integrity report |
| A summary of changes for a day/week | High | Code (a list of changes) + optionally a model (a summary) | Low: read only | **v1**: a deterministic list on the home screen; an AI summary is an extended feature |
| Unfinished tasks | High | Code | None | **v1** |
| A note from research results | High | Model | Medium → a reviewer + the user's confirmation before saving | **v1** |
| Preparing a specification from materials | Very high | Model, many calls | High → a multi-agent pipeline with validation and confirmations | **v1** |
| Finding lost agreements | Medium | A model over meeting notes | Medium | Extended feature: an agent over selected documents |
| Updating documentation after code changes | Medium | Model | **High**: writes to files | Only a proposed diff, applied manually; later |
| A project status report | Medium | Code (tasks, statuses) + model | Low | Extended feature |
