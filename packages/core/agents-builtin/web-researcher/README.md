# Web researcher

Finds and reads sources on the internet, extracts claims with verbatim quotes and verifies them in code.

- Task type for model routing: `research`
- Tools: `web_search`, `open_url`, `fetch_documentation`, `search_github`, `inspect_repository`, `compare_sources`, `search_documents`, `read_document`

## Requested permissions
- `web.search`: Find sources
- `network.fetch`: Download public pages
- `external.api`: GitHub API to find repositories
- `search.use`: Check what is already known locally
- `documents.read`: Read local notes on the topic

The input and the output are described by JSON schemas in the `schemas/` folder. The package contains no executable code.
