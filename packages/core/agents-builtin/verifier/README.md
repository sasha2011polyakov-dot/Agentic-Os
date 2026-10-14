# Result verifier

Compares the actual result with the acceptance criteria and the check results.

- Task type for model routing: `review`
- Tools: `read_document`, `read_project_file`, `search_documents`, `run_check`

## Requested permissions
- `documents.read`: Read artifacts
- `projects.read`: Read changed files
- `search.use`: Search
- `commands.run`: Re-run the checks set by the user

The input and the output are described by JSON schemas in the `schemas/` folder. The package contains no executable code.
