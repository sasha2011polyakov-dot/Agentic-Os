/** Shapes of the API responses the interface uses (a client-side contract; the UI never imports the core). */

export interface SystemInfo {
  systemId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  storagePath: string;
  status: string;
  statusDetail: string | null;
  isActive: boolean;
  isOpen: boolean;
  stats: { documents: number | null; projects: number | null; agents: number | null; activeRuns: number | null; indexing: boolean };
  lastOpenedAt: string | null;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  platform: string;
  activeSystemId: string | null;
  offline: boolean;
}

export interface DocListItem {
  id: string;
  sourceId: string;
  relPath: string;
  title: string;
  docType: string | null;
  status: string | null;
  tags: string[];
  updatedAt: string;
  wordCount: number;
}

export interface LinkRef {
  docId: string;
  title: string;
  relPath: string;
  line: number;
  kind: string;
  relation: string;
  context: string | null;
  targetRaw?: string;
  resolved?: boolean;
}

export interface Doc extends DocListItem {
  content: string;
  hash: string;
  editable: boolean;
  sourceKind: string;
  sourceName: string;
  frontmatter: Record<string, unknown>;
  headings: { level: number; text: string; line: number }[];
  aliases: string[];
  properties: { key: string; type: string; values: unknown[] }[];
  outgoing: LinkRef[];
  backlinks: LinkRef[];
  frontmatterError: string | null;
  stale: boolean;
}

export interface SearchHit {
  docId: string;
  title: string;
  relPath: string;
  snippet: string | null;
  sourceId: string;
  sourceName: string;
  tags: string[];
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  query: string;
  explain: string;
  tookMs: number;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  refId: string | null;
  props: { path?: string; tags?: string[] } & Record<string, unknown>;
  degree?: number;
  inDegree?: number;
}

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  relation: string;
  origin: string;
  status: string;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: number;
  truncated: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; isGit: boolean; isSystem: boolean }[];
  roots: string[];
}

export type MissionStatus =
  | 'draft'
  | 'analyzing'
  | 'researching'
  | 'planning'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'needs_input'
  | 'verifying'
  | 'needs_fix'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

export interface MissionListItem {
  id: string;
  key: string;
  title: string;
  mode: 'plan' | 'execute';
  status: MissionStatus;
  statusLabel: string;
  phase: string;
  phaseLabel: string;
  priority: string;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Criterion {
  id: string;
  text: string;
  verification: string;
  status: string;
  evidence: string;
  notes: string;
  decidedBy: string | null;
  source: string;
}

export interface PlanStep {
  id: string;
  title: string;
  goal: string;
  role: string;
  depends_on: string[];
  risk: string;
}

export interface Pending {
  id: string;
  kind: 'setup_agents' | 'model' | 'questions' | 'strategy' | 'plan' | 'apply_changes' | 'error' | 'budget' | 'conflict';
  title: string;
  message: string;
  data: Record<string, unknown>;
  resumePhase: string;
  createdAt: string;
}

export interface MissionStep {
  id: string;
  seq: number;
  phase: string;
  planStep: string | null;
  role: string;
  agentId: string | null;
  title: string;
  status: string;
  error: { code: string; message: string; hint?: string } | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface MissionView extends MissionListItem {
  originalRequest: string;
  revision: number;
  scope: { kind: string; sourceIds: string[]; docIds: string[]; systemIds: string[]; allowWeb: boolean };
  assumptions: string[];
  constraints: string[];
  extraRequirements: { id: string; text: string; kind: string; addedAt: string }[];
  criteria: Criterion[];
  options: { id: string; name: string; kind: string; description: string; pros: string[]; cons: string[] }[];
  strategy: { selected: string; rationale: string; selectedBy: string } | null;
  plan: PlanStep[];
  planStale: boolean;
  steps: MissionStep[];
  pending: Pending | null;
  checks: { id: string; kind: string; name: string; status: string; exitCode: number | null; round: number }[];
  artifacts: { type: string; ref: string; title: string; status: string; path?: string }[];
  limitations: string[];
  notExecuted: string[];
  fixRounds: number;
  summary: {
    required: string;
    studied: string[];
    approach: string;
    done: string[];
    checksNotRun: { name: string; reason: string }[];
    limitations: string[];
    resultsLocation: string[];
    nextSteps: string[];
    finalStatus: MissionStatus;
    statusReason: string;
  } | null;
  reportDocId: string | null;
  totals: Record<string, number>;
  error: { code: string; message: string; hint?: string } | null;
  progress: { phases: { phase: string; label: string; state: 'done' | 'current' | 'pending' | 'skipped' }[]; steps: { done: number; total: number } };
  startedAt: string | null;
}

export interface MissionEvent {
  id: number;
  stepId: string | null;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  type: string;
  message: string;
}

export interface Preflight {
  ok: boolean;
  aiMode: string;
  offline: boolean;
  agents: { id: string; role: string; installed: boolean; enabled: boolean; route: { providerId: string; model: string; locality: string } | null; routeError: string | null }[];
  problems: string[];
  warnings: string[];
}
