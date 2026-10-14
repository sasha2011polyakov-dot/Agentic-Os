import { formatDate, isoDate, isoTime } from '../util/time.ts';
import { composeDocument, splitFrontmatter, parseFrontmatter } from '../markdown/frontmatter.ts';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  docType: string | null;
  builtin: boolean;
  folderHint: string | null;
  content: string;
}

export const BUILTIN_TEMPLATES: TemplateInfo[] = [
  {
    id: 'builtin:note',
    name: 'Note',
    description: 'A free-form note with tags.',
    docType: 'note',
    builtin: true,
    folderHint: null,
    content: `---
type: note
tags: []
created: {{date}}
---

# {{title}}

`,
  },
  {
    id: 'builtin:technical-decision',
    name: 'Technical decision',
    description: 'A short rationale for a technical decision.',
    docType: 'decision',
    builtin: true,
    folderHint: 'Decisions',
    content: `---
type: decision
status: proposed
created: {{date}}
tags:
  - decision
---

# {{title}}

## Context
What problem is being solved and which constraints apply.

## Decision
What was chosen.

## Alternatives considered
- Option A: pros / cons
- Option B: pros / cons

## Consequences
What changes and which risks appear.
`,
  },
  {
    id: 'builtin:requirement',
    name: 'Requirement',
    description: 'An atomic, verifiable requirement with acceptance criteria.',
    docType: 'requirement',
    builtin: true,
    folderHint: 'Requirements',
    content: `---
id: {{nextId:REQ}}
type: requirement
kind: functional
status: draft
priority: medium
source: ""
created: {{date}}
tags:
  - requirement
---

# {{title}}

## Statement
The system must …

## Rationale
Why this is needed and which source it is based on.

## Acceptance criteria
- [ ] Criterion 1 (verifiable)
- [ ] Criterion 2

## Dependencies
-

## Open questions
-
`,
  },
  {
    id: 'builtin:technical-spec',
    name: 'Specification',
    description: 'Specification structure: goal, scope, requirements, scenarios, acceptance, risks.',
    docType: 'spec',
    builtin: true,
    folderHint: 'Specs',
    content: `---
type: spec
status: draft
version: 1
created: {{date}}
tags:
  - spec
---

# {{title}}

## 1. Goal

## 2. Project context

## 3. Problem

## 4. Scope
**In scope:**
**Out of scope:**

## 5. Terms and definitions

## 6. Current state of the system

## 7. Functional requirements

## 8. Non-functional requirements

## 9. User scenarios

## 10. Architectural constraints

## 11. Inputs and outputs

## 12. Dependencies

## 13. Acceptance criteria

## 14. Test plan

## 15. Risks and limitations

## 16. Open questions

## 17. Assumptions

## 18. Sources

## 19. Decomposition plan
`,
  },
  {
    id: 'builtin:research',
    name: 'Research',
    description: 'Question, sources, findings with quotes, limitations.',
    docType: 'research',
    builtin: true,
    folderHint: 'Research',
    content: `---
type: research
status: in-progress
created: {{date}}
review_after: ""
tags:
  - research
---

# {{title}}

## Question

## Findings

## Sources
| Claim | Source | Published | Retrieved | Quote |
|---|---|---|---|---|

## Contradictions and limitations

## Open questions
`,
  },
  {
    id: 'builtin:adr',
    name: 'Architecture decision (ADR)',
    description: 'Architecture Decision Record: status, context, decision, consequences.',
    docType: 'decision',
    builtin: true,
    folderHint: 'Decisions',
    content: `---
type: decision
adr: true
status: proposed
date: {{date}}
supersedes: ""
tags:
  - adr
---

# {{title}}

## Status
Proposed

## Context

## Decision

## Consequences
### Positive
### Negative

## Related decisions
`,
  },
  {
    id: 'builtin:task',
    name: 'Task',
    description: 'A task as a note (to sync with the Tasks board, use the board itself).',
    docType: 'task',
    builtin: true,
    folderHint: 'Tasks',
    content: `---
type: task
status: todo
priority: medium
implements: ""
created: {{date}}
---

# {{title}}

## Goal

## Description

## Done when
- [ ]

## Dependencies
`,
  },
  {
    id: 'builtin:meeting',
    name: 'Meeting notes',
    description: 'Participants, agenda, decisions, agreements and action items.',
    docType: 'meeting',
    builtin: true,
    folderHint: 'Meetings',
    content: `---
type: meeting
date: {{date}}
participants: []
tags:
  - meeting
---

# {{title}}

## Agenda

## Discussion

## Decisions
-

## Agreements and action items
- [ ] Who — what — when

## Open questions
`,
  },
  {
    id: 'builtin:project-plan',
    name: 'Project plan',
    description: 'Goals, stages, milestones, risks, resources.',
    docType: 'plan',
    builtin: true,
    folderHint: 'Plans',
    content: `---
type: plan
status: draft
created: {{date}}
---

# {{title}}

## Goals and outcome

## Stages
| Stage | Outcome | Due | Owner |
|---|---|---|---|

## Milestones

## Risks
| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|

## Resources and dependencies
`,
  },
  {
    id: 'builtin:agent-report',
    name: 'Agent report',
    description: 'The result of an agent run: what was done, which sources were used, what failed.',
    docType: 'agent-report',
    builtin: true,
    folderHint: 'Reports',
    content: `---
type: agent-report
agent: ""
run: ""
created: {{date}}
---

# {{title}}

## Task

## Result

## Sources used

## Limitations and unverified claims

## Decisions needed from the user
`,
  },
  {
    id: 'builtin:daily',
    name: 'Daily note',
    description: 'Used by the "Daily note" command.',
    docType: 'daily',
    builtin: true,
    folderHint: 'Daily',
    content: `---
type: daily
date: {{date}}
---

# {{date}}

## Tasks
- [ ]

## Notes

`,
  },
];

export interface TemplateVars {
  title: string;
  now?: Date;
  systemName?: string;
  nextId?: (prefix: string) => string;
}

/** Renders Obsidian-compatible variables {{title}} {{date}} {{time}} {{date:FMT}} {{time:FMT}} + {{system}} {{nextId:PREFIX}}. */
export function renderTemplate(content: string, vars: TemplateVars): string {
  const now = vars.now ?? new Date();
  return content.replace(/\{\{\s*([a-zA-Z]+)(?::([^}]*))?\s*\}\}/g, (match, name: string, arg: string | undefined) => {
    switch (name) {
      case 'title':
        return vars.title;
      case 'date':
        return arg ? formatDate(now, arg) : isoDate(now);
      case 'time':
        return arg ? formatDate(now, arg) : isoTime(now);
      case 'system':
        return vars.systemName ?? '';
      case 'nextId':
        return vars.nextId ? vars.nextId((arg ?? 'ID').trim()) : match;
      default:
        return match;
    }
  });
}

/** Merges extra properties into a rendered template's frontmatter (extra wins), keeping the body. */
export function mergeProperties(rendered: string, extra: Record<string, unknown>): string {
  if (!Object.keys(extra).length) return rendered;
  const split = splitFrontmatter(rendered);
  const data = { ...parseFrontmatter(split.raw).data, ...extra };
  return composeDocument(data, split.body);
}
