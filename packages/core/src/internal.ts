// Service-level API for the server and desktop shell (not a stable public API).
export { services, type SystemServices } from './wiring.ts';
export { integrityReport, type IntegrityReport, type IntegrityIssue } from './vault/integrity.ts';
export { NativeDialog, listDirectories } from './sources/dialog.ts';
export { RELATIONS, type GraphQuery, type GraphResult, type GraphNode, type GraphEdge } from './graph/graph.ts';
export { MARK_START, MARK_END, reciprocalRankFusion } from './search/search.ts';
export { BUILTIN_TEMPLATES } from './vault/templates.ts';
