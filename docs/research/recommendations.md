# Prioritized recommendations: features beyond the original specification

Date: 2026-10-12. Every feature is assessed by the criteria of specification item 24.12. The scale for benefit and complexity is 1 (low) … 5 (high).

## Summary

| # | Feature | Benefit | Complexity | Local | Internet | Paid | Recommendation |
|---|---|---|---|---|---|---|---|
| R1 | Quote verification in code (citation grounding) | 5 | 2 | Yes | No | No | **Now** |
| R2 | One network gateway (egress guard) + a log of outgoing requests | 5 | 2 | Yes | — | No | **Now** |
| R3 | "Requirement → task → code/test" traceability through IDs | 5 | 2 | Yes | No | No | **Now** |
| R4 | A knowledge base integrity report | 4 | 2 | Yes | No | No | **Now** |
| R5 | Link suggestions with confirmation (suggested edges) | 4 | 3 | Yes (embeddings: a local model) | No | No | **Now** (without a model: by term matches) |
| R6 | A source sensitivity profile (confidential → local models only) | 5 | 1 | Yes | No | No | **Now** |
| R7 | Freshness dates of facts (`review_after`) and the `stale` status | 4 | 2 | Yes | For re-checks, yes | No | **Now** |
| R8 | A workflow "dry run" with an estimate of the number of calls | 3 | 2 | Yes | No | No | **Now** (the number of calls; the cost only if the price is known) |
| R9 | A "what changed" delta summary on the home screen | 4 | 1 | Yes | No | No | **Now** (deterministic) |
| R10 | A test run of an agent on the `tests/test-cases.json` of its package | 4 | 2 | Yes | No | No | **Now** |
| R11 | An MCP tool adapter in an isolated process | 4 | 4 | Yes | Depends on the server | No | **Postpone** |
| R12 | A tree-sitter code map | 4 | 4 | Yes | No | No | **Postpone** |
| R13 | PDF/DOCX through Docling as an external process | 4 | 3 | Yes (Python) | No | No | **Postpone** |
| R14 | Canvas (JSON Canvas 1.0) | 3 | 3 | Yes | No | No | **Postpone** |
| R15 | Full GraphRAG over the whole vault | 2 | 4 | Expensive locally | No | Through the cloud, yes | **Reject** in v1 (targeted extraction instead of a full one) |
| R16 | Automatic documentation updates after code changes | 3 | 4 | Yes | No | No | **Postpone**; only a proposed diff |

## Details of the "Now" features

### R1. Quote verification in code
1. **Problem:** models invent quotes, URLs and dates.
2. **Scenario:** the research agent writes "Brave gives $5 of credits" and attaches a quote; the system checks that the quote is present in the downloaded page.
3. **How it works:** normalization (case, spaces, typographic quotes and dashes) → a substring search; for long quotes, a tolerance of a match of ≥ 90% of the tokens in a sliding window.
4. **Modules:** `core/research/grounding`, the `compare_sources` tool, a workflow validator.
5. **Executor:** plain code.
6–9. No internet needed (the already downloaded text is checked), no paid services, minimal resources.
10. **Risks:** paraphrased quotes will not pass; this strictness is **intentional**. The model is told to quote verbatim.
11. **Complexity:** 2. 12. **Benefit:** 5.
13. **Acceptance criterion:** a claim with a quote that is not in the source gets `not_found_in_source` and cannot become `verified` (a unit test).
14. **Recommendation:** implement now.

### R2. One network gateway
1. **Problem:** "silent network requests" in offline and local mode (22.8).
2. **Scenario:** the user turns on "Offline": every attempt at an outgoing request is blocked and logged.
3. **How it works:** all outgoing HTTP of the core goes through `HttpClient`, which asks `NetworkPolicy.check({host, purpose})` before DNS resolution. Targets: `ai-local`, `ai-cloud`, `web-research`, `model-download`. A test goes through every provider and tool and checks that there are no calls to non-loopback hosts in local mode.
4. **Modules:** `core/net`. 5. **Executor:** code. 6–9. No internet, no payment.
10. **Risks:** a third-party library could make a request bypassing the gateway → the core has no HTTP dependencies except our client. The rule is fixed in the architecture.
11. Complexity 2. 12. Benefit 5.
13. **Criterion:** the test "local mode: not a single non-loopback request" passes.
14. **Now.**

### R3. Requirement traceability
1. **Problem:** the specification drifts away from the tasks and the code.
2. **Scenario:** from a task, go to its requirement; from a requirement, go to its source documents and to the tests where its ID is mentioned.
3. **How it works:** stable IDs (`REQ-<project>-001`), `derived_from`, `implements` and `verifies` edges; a scanner of ID mentions in the project code.
4. **Modules:** `core/graph`, `core/tasks`, `core/pipeline/spec`. 5. Code. 6–9. Offline, free.
10. **Risks:** false ID matches → a strict format and word boundaries.
11. 2. 12. 5. 13. **Criterion:** a task created by the pipeline opens its original requirement, and the requirement opens its source documents.
14. **Now.**

### R4. A knowledge base integrity report
Broken links, orphans, exact duplicates (the same hash), documents without the required properties of their type, stale documents (`review_after`), cycles of task dependencies, a mismatch between the index and the files. Fully by code; criterion: each class of problems is covered by a test on a fixture. **Now.**

### R5. Link suggestions
Candidates: (a) a mention of the title or alias of a document without a link (unlinked mentions), by code; (b) a cosine similarity of embeddings above a threshold, if a model is available. They are stored as `edges.status = suggested` with `confidence` and `evidence`. The user accepts or rejects them. The risk is noise; so only the top-N are shown, and they are hidden in the graph by default. **Now** (a); (b) when embeddings exist.

### R6. A source sensitivity profile
A source has a `confidential` flag. The ModelRouter **forbids** cloud models for steps whose context contains fragments from such a source. The error is `POLICY_CONFIDENTIAL_SOURCE` with an explanation. Code, complexity 1, benefit 5. **Now.**

### R7. Freshness dates
`review_after` on facts and documents (the frontmatter property `review_after: 2027-01-01`); the `stale` status is computed; a "Needs review" report. **Now.**

### R8. A workflow dry run
Before the run, the user sees: the number of agent nodes, the maximum number of model calls (including retries and loop iterations), which models and providers will be used, and whether data will go to the cloud. The cost is shown only if a price is set for the model; otherwise "unknown" (22.9). **Now.**

### R9. A delta summary
A list of changed documents, new tasks, finished runs and errors since the last visit. By code. **Now.**

### R10. A test run of an agent
From the package's `tests/test-cases.json`: input → run the agent on the selected model → validate the output against `output.schema.json` + the expected checks (`expect.required_paths`, `expect.min_items`). The result goes to the agent card ("Results of the latest checks"). **Now.**

## Postponed and rejected

- **R11 MCP:** opening access to the tool ecosystem is useful, but an MCP server is executable code. It needs process isolation, explicit consent, and network and file system restrictions. The `Tool` interface of the core already has a compatible shape (`name`, `description`, `inputSchema`).
- **R12 Tree-sitter:** would improve the code map a lot, but needs WASM grammars for every language. We start with a regex outline (honestly documented).
- **R13 Docling:** the best candidate for PDF/DOCX (according to open sources), but it is a Python stack. An option is an external local process if the user has Python installed.
- **R14 Canvas:** the format is known (JSON Canvas 1.0); in the first version the priorities are the graph and workflows.
- **R15 GraphRAG:** ≈75% of the indexing cost goes to LLM extraction (according to its authors). For local models and a personal knowledge base the price is disproportionate. We use a deterministic graph and targeted extraction inside workflows.
- **R16 Automatic documentation updates:** a high risk of wrong writes. Only proposals with a diff and manual application, in future versions.
