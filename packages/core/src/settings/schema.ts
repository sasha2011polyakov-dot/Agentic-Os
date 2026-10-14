/**
 * Catalogue of known settings. `level` says where a value may be stored:
 *  - app:    only in registry.db (application-wide)
 *  - system: only in the system's own database
 *  - both:   app value is inherited by every system unless the system overrides it
 */
export type SettingLevel = 'app' | 'system' | 'both';

export interface SettingDef<T = unknown> {
  key: string;
  level: SettingLevel;
  default: T;
  label: string;
  description: string;
  validate?: (v: unknown) => boolean;
}

const isBool = (v: unknown) => typeof v === 'boolean';
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === 'string';
const oneOf = (...vals: string[]) => (v: unknown) => typeof v === 'string' && vals.includes(v);
const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export const SETTINGS: SettingDef[] = [
  // Application level
  { key: 'ui.theme', level: 'app', default: 'system', label: 'Тема', description: 'Светлая, тёмная или как в системе.', validate: oneOf('system', 'light', 'dark') },
  { key: 'ui.activeSystemId', level: 'app', default: null, label: 'Активная система', description: 'Система, открытая в интерфейсе.', validate: (v) => v === null || isStr(v) },
  { key: 'ui.layout', level: 'app', default: { sidebarWidth: 232, contextWidth: 320, contextOpen: true }, label: 'Расположение панелей', description: 'Ширина и видимость боковых панелей.', validate: isObj },
  { key: 'ui.density', level: 'app', default: 'comfortable', label: 'Плотность интерфейса', description: 'Компактная или обычная.', validate: oneOf('comfortable', 'compact') },
  { key: 'net.offline', level: 'app', default: false, label: 'Офлайн-режим', description: 'Блокирует любые сетевые запросы, кроме локальных (127.0.0.1). Системы не могут переопределить.', validate: isBool },
  { key: 'log.level', level: 'app', default: 'info', label: 'Уровень журнала', description: 'Подробность журнала приложения.', validate: oneOf('debug', 'info', 'warn', 'error') },
  { key: 'ai.budget', level: 'app', default: { monthlyCostUsd: null, maxCloudRequestsPerDay: null, maxConcurrentRequests: 2 }, label: 'Лимиты облачных AI', description: 'Месячный лимит стоимости, запросов в день и параллельных запросов.', validate: isObj },
  { key: 'web.search', level: 'app', default: { provider: 'none', searxngUrl: '', braveSecretRef: null, githubSecretRef: null, allowHttp: false }, label: 'Веб-поиск', description: 'Поисковый провайдер для агентов-исследователей.', validate: isObj },
  { key: 'security.gitDetails', level: 'app', default: true, label: 'Подробные сведения Git', description: 'Запускать git status/log (только чтение, с защитными флагами).', validate: isBool },
  { key: 'security.workCopyMaxBytes', level: 'app', default: 2 * 1024 * 1024 * 1024, label: 'Максимальный размер рабочей копии', description: 'Проекты больше этого размера не копируются целиком: зависимости исключаются, а если и без них слишком много — копия не создаётся.', validate: isNum },
  { key: 'security.backupsKeep', level: 'app', default: 50, label: 'Хранить точек восстановления на проект', description: 'Старые резервные копии изменений удаляются после создания новой.', validate: isNum },
  { key: 'security.sandbox', level: 'app', default: 'auto', label: 'Изоляция проверок', description: 'auto — использовать песочницу (bubblewrap в Linux), если она доступна; limited — только ограниченный режим.', validate: oneOf('auto', 'limited') },

  // Both levels: app default, system may override
  { key: 'ui.extensionTheme', level: 'app', default: 'default', label: 'Оформление из расширения', description: 'default — стандартное оформление; иначе тема включённого расширения («расширение:тема»).', validate: (v) => typeof v === 'string' && /^(default|[a-z0-9.-]{1,170}:[a-z0-9-]{1,40})$/.test(v) },
  { key: 'ai.mode', level: 'both', default: 'local', label: 'Режим AI', description: 'local — только локальные модели; hybrid — облако по политике; cloud — облако разрешено.', validate: oneOf('local', 'hybrid', 'cloud') },
  { key: 'ai.defaultModel', level: 'both', default: null, label: 'Модель по умолчанию', description: 'Провайдер и модель, используемые, если агент не задаёт свою.', validate: (v) => v === null || isObj(v) },
  { key: 'ai.routing', level: 'both', default: {}, label: 'Маршрутизация по типам задач', description: 'Модель для типов задач: classification, extraction, generation, review, embedding.', validate: isObj },
  { key: 'ai.cloudPolicy', level: 'both', default: { allowedTaskTypes: [], escalateToCloudOnFailure: false }, label: 'Политика облака', description: 'Какие типы задач в гибридном режиме можно отправлять в облако.', validate: isObj },
  { key: 'ai.embeddingModel', level: 'both', default: null, label: 'Модель эмбеддингов', description: 'Для семантического поиска (необязательно).', validate: (v) => v === null || isObj(v) },
  { key: 'workflow.defaultLimits', level: 'both', default: { maxModelCalls: 60, maxTokens: 400000, maxCostUsd: null, maxReviewIterations: 2, stepTimeoutMs: 300000, maxParallel: 2 }, label: 'Лимиты процессов', description: 'Ограничения по умолчанию для запусков процессов.', validate: isObj },

  // System level
  { key: 'docs.newNoteFolder', level: 'system', default: '', label: 'Папка новых заметок', description: 'Относительно корня системы; пусто — корень.', validate: isStr },
  { key: 'docs.templatesFolder', level: 'system', default: 'Templates', label: 'Папка шаблонов', description: 'Пользовательские шаблоны системы.', validate: isStr },
  { key: 'docs.dailyFolder', level: 'system', default: 'Daily', label: 'Папка ежедневных заметок', description: 'Где создаются ежедневные заметки.', validate: isStr },
  { key: 'docs.dailyFormat', level: 'system', default: 'YYYY-MM-DD', label: 'Формат имени ежедневной заметки', description: 'Токены Moment.js: YYYY, MM, DD…', validate: isStr },
  { key: 'docs.dailyTemplate', level: 'system', default: 'builtin:daily', label: 'Шаблон ежедневной заметки', description: 'builtin:<id> или путь к шаблону.', validate: isStr },
  { key: 'docs.linkFormat', level: 'system', default: 'shortest', label: 'Формат новых ссылок', description: 'shortest — по имени, если уникально; absolute — полный путь.', validate: oneOf('shortest', 'absolute') },
  { key: 'docs.researchFolder', level: 'system', default: 'Research', label: 'Папка исследований', description: 'Куда агенты сохраняют отчёты веб-исследований.', validate: isStr },
  { key: 'docs.specsFolder', level: 'system', default: 'Specs', label: 'Папка ТЗ', description: 'Куда сохраняются технические задания и требования.', validate: isStr },
  { key: 'docs.requiredProperties', level: 'system', default: { requirement: ['id', 'status'], spec: ['status'], decision: ['status'] }, label: 'Обязательные свойства по типам', description: 'Проверяются отчётом целостности.', validate: isObj },
  { key: 'history.maxVersions', level: 'system', default: 100, label: 'Версий на документ', description: 'Сколько версий хранить для каждого документа.', validate: isNum },
  { key: 'index.defaultExcludes', level: 'system', default: [], label: 'Исключения по умолчанию', description: 'Glob-шаблоны (как в .gitignore) для всех источников системы.', validate: isStrArray },
  { key: 'index.chunkEmbeddings', level: 'system', default: false, label: 'Строить эмбеддинги', description: 'Семантический поиск: требует модели эмбеддингов.', validate: isBool },
  { key: 'graph.defaults', level: 'system', default: { showSuggested: false, showTags: false, maxNodes: 1500 }, label: 'Граф по умолчанию', description: 'Фильтры графа по умолчанию.', validate: isObj },
  { key: 'backup.keep', level: 'system', default: 10, label: 'Хранить резервных копий', description: 'Старые копии удаляются после создания новой.', validate: isNum },
  { key: 'ui.state', level: 'system', default: {}, label: 'Состояние интерфейса системы', description: 'Последний документ, вид графа, фильтры.', validate: isObj },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
