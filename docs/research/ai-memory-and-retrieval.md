# Agent memory, indexing and context retrieval

Date: 2026-10-12. Sources: Letta/MemGPT, GraphRAG, RRF, sqlite-vec; see `product-landscape.md`.

## 1. The problem

The whole vault cannot be passed to a model: the context window of local models is usually 4–32 thousand tokens (the `max_context_length` field in the LM Studio REST API, `<arch>.context_length` in `ollama /api/show`). Agents need memory of the project, decisions and confirmed facts, without piling up junk and without mixing facts with guesses.

## 2. Memory levels

| Level | What it holds | Where | Who writes | Lifetime |
|---|---|---|---|---|
| **Step context** | The step input, selected fragments, tool results | Process memory + `run_steps.input/output` | The orchestrator | One step |
| **Run context** | Results of the previous steps (typed), the log | `workflow_runs`, `run_steps` | The orchestrator | One run (kept for audit) |
| **Project context** | The project map, key files, outline | `project_profiles` (an inventory cache, invalidated by file hashes) | The inventory (code) | Until the files change |
| **Long-term knowledge** | Notes, requirements, decisions, research | **Markdown in the vault** + index + graph | The user; agents only after a confirmation | Permanent |
| **Confirmed facts** | An atomic fact + source + quote + dates + status | The `facts` table (+ a link to the source document) | Agents with `status=proposed` → the user/a validator → `verified` | Until `review_after` expires or it is replaced |

**Principle:** long-term memory is the knowledge base itself. There is no "hidden agent memory" the user cannot see: everything an agent "remembers" between runs is a document or a `facts` record, visible in the UI and backed by a source.

## 3. Where things are stored

| Data | Markdown | SQLite | Index / graph |
|---|---|---|---|
| Notes, specifications, requirements, research reports | **Yes** (the source of truth) | Metadata, hash, version history | FTS, edges |
| Document properties | Frontmatter | The normalized `properties` table | Filters |
| Links | Links in the text / frontmatter | `edges` with a type and an origin | Graph |
| AI-suggested links | No (until confirmed) | `edges` with `status=suggested` | The "show suggestions" filter |
| Facts from research | The "Sources" section of a note | `facts` | `source` nodes |
| Runs, stages, tokens, cost | No | `workflow_runs`, `run_steps`, `ai_usage` | — |
| Embeddings | No | `chunks` + `embeddings` (Float32 BLOB) | Vector search |
| Secrets | **Never** | **Never** (only a reference to the key in the OS secret store) | — |

## 4. Selecting context for an agent (retrieval)

1. **The scope** is set by the user: sources, folders, documents. Everything outside the scope is unavailable to tools; PermissionGuard checks this, not the prompt.
2. **Candidates:** FTS5 (BM25) on the wording of the task + (optionally) vector search → **RRF (k=60)**.
3. **Graph expansion:** neighbours of the top-N documents at depth 1 over the `references`, `implements`, `depends_on`, `part_of` edges: what is found through links rather than by words.
4. **Context budget:** fragments are added in order of rank until the token limit of the step is reached (an estimate of ≈ `characters/3.5`; if the provider reports the actual usage, the estimate is corrected).
5. **Labels:** every fragment is passed with its `source_id`, path and line range; the model answer must refer to these IDs. A validator checks that every reference exists.

## 5. Chunking

- Markdown: by headings (sections); long sections in windows of ≈ 1200 characters with a 150-character overlap.
- Code: by the symbols found (outline), otherwise in windows of lines.
- Every fragment has `doc_id`, `heading_path`, `start_line`, `end_line`, `hash`. When a document changes, only the fragments with a changed hash are recomputed.

## 6. Protection against "junk" memory

- Facts from agents are created with the `proposed` status; only `verified` facts (or `proposed` ones, explicitly marked "not verified") get into the context of later runs.
- Every fact has `review_after`; after that date it becomes `stale` and is not used as confirmed.
- A new fact that contradicts an old one (the same `subject` with different values, decided by a reviewer model) → both are marked `conflicted` and shown to the user instead of being overwritten.
- Duplicate facts are dropped by their normalized text and `subject`.

## 7. The vector index: decision

- Storage: `embeddings(chunk_id, model, dim, vector BLOB)`; search is a brute-force cosine in JS over `Float32Array`.
- **Rationale:** a personal knowledge base has up to ~10⁵ fragments. A direct pass over 10⁵ vectors of dimension 768 is about 77 million multiply-adds; on a modern CPU this takes tens to hundreds of milliseconds (an estimate, not a measurement; a benchmark is a task for the next stage). The native sqlite-vec extension has the same asymptotics (brute force) but complicates the cross-platform build.
- **Abstraction:** the `VectorIndex` interface allows replacing the implementation (sqlite-vec, HNSW) without changing search.
- Embeddings of different models are never mixed: when the model changes, the index is rebuilt.
