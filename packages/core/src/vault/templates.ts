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
    name: 'Обычная заметка',
    description: 'Свободная заметка с тегами.',
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
    name: 'Техническое решение',
    description: 'Короткое обоснование принятого технического решения.',
    docType: 'decision',
    builtin: true,
    folderHint: 'Decisions',
    content: `---
type: decision
status: proposed
created: {{date}}
tags:
  - решение
---

# {{title}}

## Контекст
Какая проблема решается и какие ограничения действуют.

## Решение
Что выбрано.

## Рассмотренные альтернативы
- Вариант A — плюсы / минусы
- Вариант B — плюсы / минусы

## Последствия
Что меняется, какие риски появляются.
`,
  },
  {
    id: 'builtin:requirement',
    name: 'Требование',
    description: 'Атомарное проверяемое требование с критериями приёмки.',
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
  - требование
---

# {{title}}

## Формулировка
Система должна …

## Обоснование
Почему это нужно и на каком источнике основано.

## Критерии приёмки
- [ ] Критерий 1 (проверяемый)
- [ ] Критерий 2

## Зависимости
-

## Открытые вопросы
-
`,
  },
  {
    id: 'builtin:technical-spec',
    name: 'Техническое задание',
    description: 'Структура ТЗ: цель, границы, требования, сценарии, приёмка, риски.',
    docType: 'spec',
    builtin: true,
    folderHint: 'Specs',
    content: `---
type: spec
status: draft
version: 1
created: {{date}}
tags:
  - тз
---

# {{title}}

## 1. Цель

## 2. Контекст проекта

## 3. Проблема

## 4. Границы задачи
**Входит:**
**Не входит:**

## 5. Термины и определения

## 6. Текущее состояние системы

## 7. Функциональные требования

## 8. Нефункциональные требования

## 9. Пользовательские сценарии

## 10. Архитектурные ограничения

## 11. Входные и выходные данные

## 12. Зависимости

## 13. Критерии приёмки

## 14. План тестирования

## 15. Риски и ограничения

## 16. Открытые вопросы

## 17. Допущения

## 18. Источники

## 19. План декомпозиции
`,
  },
  {
    id: 'builtin:research',
    name: 'Исследование',
    description: 'Вопрос, источники, выводы с цитатами, ограничения.',
    docType: 'research',
    builtin: true,
    folderHint: 'Research',
    content: `---
type: research
status: in-progress
created: {{date}}
review_after: ""
tags:
  - исследование
---

# {{title}}

## Вопрос

## Выводы

## Источники
| Утверждение | Источник | Дата публикации | Дата получения | Цитата |
|---|---|---|---|---|

## Противоречия и ограничения

## Открытые вопросы
`,
  },
  {
    id: 'builtin:adr',
    name: 'Архитектурное решение (ADR)',
    description: 'Architecture Decision Record: статус, контекст, решение, последствия.',
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

## Статус
Предложено

## Контекст

## Решение

## Последствия
### Положительные
### Отрицательные

## Связанные решения
`,
  },
  {
    id: 'builtin:task',
    name: 'Задача',
    description: 'Задача в виде заметки (для синхронизации с разделом «Задачи» используйте сам раздел).',
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

## Цель

## Описание

## Критерии завершения
- [ ]

## Зависимости
`,
  },
  {
    id: 'builtin:meeting',
    name: 'Протокол встречи',
    description: 'Участники, повестка, решения, договорённости и действия.',
    docType: 'meeting',
    builtin: true,
    folderHint: 'Meetings',
    content: `---
type: meeting
date: {{date}}
participants: []
tags:
  - встреча
---

# {{title}}

## Повестка

## Обсуждение

## Решения
-

## Договорённости и действия
- [ ] Кто — что — когда

## Открытые вопросы
`,
  },
  {
    id: 'builtin:project-plan',
    name: 'План проекта',
    description: 'Цели, этапы, вехи, риски, ресурсы.',
    docType: 'plan',
    builtin: true,
    folderHint: 'Plans',
    content: `---
type: plan
status: draft
created: {{date}}
---

# {{title}}

## Цели и результат

## Этапы
| Этап | Результат | Срок | Ответственный |
|---|---|---|---|

## Вехи

## Риски
| Риск | Влияние | Вероятность | Митигирующие действия |
|---|---|---|---|

## Ресурсы и зависимости
`,
  },
  {
    id: 'builtin:agent-report',
    name: 'Отчёт агента',
    description: 'Результат работы агента: что сделано, на каких источниках, что не удалось.',
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

## Задача

## Результат

## Использованные источники

## Ограничения и непроверенные утверждения

## Что требует решения пользователя
`,
  },
  {
    id: 'builtin:daily',
    name: 'Ежедневная заметка',
    description: 'Используется командой «Ежедневная заметка».',
    docType: 'daily',
    builtin: true,
    folderHint: 'Daily',
    content: `---
type: daily
date: {{date}}
---

# {{date}}

## Задачи
- [ ]

## Заметки

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
