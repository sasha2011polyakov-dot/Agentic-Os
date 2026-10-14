# Project explorer

Explores connected projects and the knowledge base: architecture, existing solutions, relevant files.

- Task type for model routing: `extraction`
- Tools: `project_inventory`, `list_project_files`, `read_project_file`, `search_documents`, `read_document`, `graph_neighbors`

## Requested permissions
- `projects.read`: Read the project
- `search.use`: Search
- `documents.read`: Read documents
- `graph.read`: Document links
- `systems.read`: Read other systems explicitly selected for the mission (results show which system they come from)

The input and the output are described by JSON schemas in the `schemas/` folder. The package contains no executable code.
