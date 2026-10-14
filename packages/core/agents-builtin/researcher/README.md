# Researcher

Collects confirmed facts from documents and the project, with quotes and a confidence level.

- Task type for model routing: `extraction`
- Tools: `search_documents`, `read_document`, `list_documents`, `read_project_file`, `graph_neighbors`

## Requested permissions
- `search.use`: Search the knowledge base
- `documents.read`: Read documents
- `projects.read`: Read project files
- `graph.read`: Explore links
- `systems.read`: Read other systems explicitly selected for the mission (results show which system they come from)

The input and the output are described by JSON schemas in the `schemas/` folder. The package contains no executable code.
