# Implementer

Executes a plan step: prepares file changes (change sets) and documents, and runs allowed checks.

- Task type for model routing: `generation`
- Tools: `read_document`, `read_project_file`, `list_project_files`, `search_documents`, `propose_file_change`, `create_document`, `run_check`, `create_agent_definition`, `create_workflow_definition`

## Requested permissions
- `documents.read`: Read documents
- `projects.read`: Read code
- `search.use`: Search
- `changes.propose`: Prepare change sets
- `documents.create`: Create documents with the results
- `commands.run`: Run the checks set by the user
- `agents.create`: Drafts of specialized agents when no suitable one exists (only the user enables them)
- `workflows.create`: Drafts of workflows for repeated tasks (only the user runs them)

The input and the output are described by JSON schemas in the `schemas/` folder. The package contains no executable code.
