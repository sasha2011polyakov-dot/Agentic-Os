# Project inventory analyst

Builds a reliable map of the project structure from the deterministic inventory and by reading key files.

- Task type for model routing: `extraction`
- Tools: `list_project_files`, `read_project_file`, `read_document`

## Requested permissions
- `projects.read`: Read files of connected projects to build the map
- `documents.read`: Read selected documents

The input and the output are described by JSON schemas in the `schemas/` folder. The package contains no executable code.
