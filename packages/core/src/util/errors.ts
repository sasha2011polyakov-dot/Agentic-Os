/**
 * Stable error codes with user-facing Russian messages, actionable hints and the guide page
 * the UI links to ("Открыть инструкцию"). Stack traces never reach the user — only the log.
 */
export const ERROR_CATALOG = {
  VALIDATION_FAILED: { status: 400, message: 'Данные не прошли проверку.', hint: 'Исправьте отмеченные поля и повторите.', guide: undefined, retryable: false },
  NOT_FOUND: { status: 404, message: 'Объект не найден.', hint: 'Возможно, он был удалён или переименован. Обновите список.', guide: undefined, retryable: false },
  PATH_INVALID: { status: 400, message: 'Недопустимый путь или имя файла.', hint: 'Не используйте символы \\ : * ? " < > | и зарезервированные имена (CON, NUL…).', guide: 'notes-editing', retryable: false },
  PATH_OUTSIDE_SCOPE: { status: 403, message: 'Путь находится вне разрешённых папок.', hint: 'Операции разрешены только внутри подключённых хранилищ и папок, на которые выданы разрешения.', guide: 'permissions', retryable: false },
  SOURCE_NOT_ACCESSIBLE: { status: 409, message: 'Папка недоступна для чтения.', hint: 'Проверьте, что папка существует, диск подключён и у приложения есть права на чтение.', guide: 'connect-folder', retryable: true },
  SOURCE_ALREADY_CONNECTED: { status: 409, message: 'Эта папка уже подключена.', hint: 'Откройте её в разделе «Проекты и репозитории».', guide: 'connect-folder', retryable: false },
  SOURCE_OVERLAP: { status: 409, message: 'Папка пересекается с уже подключённым источником.', hint: 'Вложенные и родительские папки не подключаются повторно, чтобы файлы не индексировались дважды. Измените правила исключений существующего источника или отключите его.', guide: 'connect-folder', retryable: false },
  READ_ONLY_SOURCE: { status: 403, message: 'Источник подключён только для чтения.', hint: 'Файлы подключённых проектов не изменяются приложением. Создавайте документы в хранилище (vault).', guide: 'connect-folder', retryable: false },
  WRITE_CONFLICT: { status: 409, message: 'Файл изменён вне приложения после открытия.', hint: 'Сравните версии и выберите, какую сохранить. Ваши изменения не потеряны.', guide: 'notes-editing', retryable: false },
  FILE_TOO_LARGE: { status: 413, message: 'Файл слишком большой для обработки.', hint: 'Увеличьте лимит размера в настройках источника или исключите файл.', guide: 'indexing', retryable: false },
  PERMISSION_DENIED: { status: 403, message: 'У агента нет разрешения на это действие.', hint: 'Выдайте разрешение в карточке агента (раздел «Агенты» → «Разрешения») или сузьте задачу.', guide: 'permissions', retryable: false },
  AGENT_NOT_ENABLED: { status: 409, message: 'Агент не включён.', hint: 'Включите агента в разделе «Агенты» после проверки разрешений и тестового запуска.', guide: 'install-agent', retryable: false },
  AGENT_PACKAGE_INVALID: { status: 400, message: 'Пакет агента повреждён или не соответствует формату.', hint: 'Проверьте manifest.json и схемы по описанию формата пакета.', guide: 'create-agent', retryable: false },
  AGENT_INCOMPATIBLE: { status: 409, message: 'Пакет агента несовместим с этой версией приложения.', hint: 'Обновите приложение или установите версию агента, совместимую с текущей платформой.', guide: 'install-agent', retryable: false },
  NO_MODEL_CONFIGURED: { status: 409, message: 'Не настроена ни одна AI-модель.', hint: 'Подключите локальную модель (Ollama или LM Studio) или облачного провайдера в разделе «AI и модели».', guide: 'local-model', retryable: false },
  MODEL_UNAVAILABLE: { status: 503, message: 'Выбранная модель недоступна.', hint: 'Убедитесь, что локальный движок запущен и модель установлена, либо выберите другую модель для агента.', guide: 'local-model', retryable: true },
  PROVIDER_UNREACHABLE: { status: 503, message: 'AI-провайдер не отвечает.', hint: 'Проверьте адрес провайдера и что сервис запущен (Ollama: `ollama serve`, LM Studio: вкладка Developer → Start server).', guide: 'local-model', retryable: true },
  PROVIDER_AUTH_FAILED: { status: 401, message: 'Провайдер отклонил API-ключ.', hint: 'Проверьте ключ и права доступа в личном кабинете провайдера, затем замените ключ в настройках.', guide: 'ai-providers', retryable: false },
  PROVIDER_RATE_LIMITED: { status: 429, message: 'Превышен лимит запросов провайдера.', hint: 'Подождите и повторите, уменьшите параллелизм или выберите другую модель.', guide: 'ai-providers', retryable: true },
  PROVIDER_ERROR: { status: 502, message: 'Провайдер вернул ошибку.', hint: 'Подробности — в журнале. Попробуйте повторить или выбрать другую модель.', guide: 'troubleshooting', retryable: true },
  CONTEXT_TOO_LARGE: { status: 413, message: 'Контекст не помещается в окно модели.', hint: 'Сузьте область анализа (меньше файлов) или выберите модель с большим контекстом.', guide: 'spec-generation', retryable: false },
  STRUCTURED_OUTPUT_FAILED: { status: 422, message: 'Модель не смогла вернуть ответ в требуемом формате.', hint: 'Модели меньше ~7B параметров часто не справляются со структурированным выводом. Выберите более сильную модель для этого агента.', guide: 'local-model', retryable: true },
  OFFLINE_MODE: { status: 409, message: 'Включён офлайн-режим: сетевой запрос заблокирован.', hint: 'Отключите офлайн-режим в настройках или используйте локальные модели и данные.', guide: 'offline-mode', retryable: false },
  NETWORK_POLICY_DENIED: { status: 403, message: 'Сетевой запрос запрещён политикой.', hint: 'Режим «Локальный AI» запрещает облачные запросы. Измените режим в разделе «AI и модели» → «Маршрутизация».', guide: 'offline-mode', retryable: false },
  POLICY_CONFIDENTIAL_SOURCE: { status: 403, message: 'Данные конфиденциального источника нельзя отправлять облачной модели.', hint: 'Используйте локальную модель для этого процесса или снимите отметку «Конфиденциально» у источника.', guide: 'permissions', retryable: false },
  BUDGET_EXCEEDED: { status: 402, message: 'Достигнут установленный лимит расходов или запросов.', hint: 'Полученные результаты сохранены. Увеличьте лимит в настройках или продолжите на локальной модели.', guide: 'ai-providers', retryable: false },
  SECRET_STORE_UNAVAILABLE: { status: 409, message: 'Защищённое хранилище ключей недоступно.', hint: 'Задайте ключ через переменную окружения AOS_SECRET_<ID> или используйте ключ только на текущую сессию.', guide: 'ai-providers', retryable: false },
  WEB_SEARCH_NOT_CONFIGURED: { status: 409, message: 'Поисковый провайдер не настроен.', hint: 'Укажите адрес своего SearXNG или ключ Brave Search в разделе «Настройки» → «Веб-исследования». Прямые URL и GitHub работают без настройки.', guide: 'web-research', retryable: false },
  FETCH_BLOCKED: { status: 403, message: 'Адрес заблокирован политикой безопасности.', hint: 'Загрузка локальных и внутренних адресов запрещена для защиты от SSRF.', guide: 'web-research', retryable: false },
  FETCH_FAILED: { status: 502, message: 'Не удалось загрузить страницу.', hint: 'Проверьте адрес и доступность сайта.', guide: 'web-research', retryable: true },
  EXTRACTION_EMPTY: { status: 422, message: 'На странице не найден текст.', hint: 'Возможно, сайт формирует содержимое через JavaScript. Попробуйте другой источник.', guide: 'web-research', retryable: false },
  WORKFLOW_INVALID: { status: 400, message: 'Схема процесса содержит ошибки.', hint: 'Исправьте отмеченные узлы и связи в редакторе процесса.', guide: 'create-workflow', retryable: false },
  INVALID_STATE_TRANSITION: { status: 409, message: 'Недопустимое изменение статуса.', hint: 'Обновите страницу: состояние могло измениться.', guide: undefined, retryable: false },
  DEPENDENCY_CYCLE: { status: 409, message: 'Обнаружена циклическая зависимость.', hint: 'Удалите одну из зависимостей, чтобы разорвать цикл.', guide: 'tasks', retryable: false },
  CANCELLED: { status: 409, message: 'Операция отменена.', hint: 'Промежуточные результаты сохранены.', guide: undefined, retryable: true },
  TIMEOUT: { status: 504, message: 'Превышено время ожидания.', hint: 'Увеличьте тайм-аут этапа или выберите более быструю модель.', guide: 'troubleshooting', retryable: true },
  BACKUP_FAILED: { status: 500, message: 'Не удалось создать резервную копию.', hint: 'Проверьте свободное место на диске и права на запись в папку данных.', guide: 'backup', retryable: true },
  INTEGRITY_CHECK_FAILED: { status: 500, message: 'Проверка целостности обнаружила проблемы.', hint: 'Запустите «Перестроить индекс» в настройках. Файлы пользователя не затронуты.', guide: 'recovery', retryable: false },
  SYSTEM_UNAVAILABLE: { status: 409, message: 'Хранилище системы недоступно.', hint: 'Проверьте, что папка системы существует и диск подключён. Если папку переместили — укажите новое расположение («Найти папку»). Данные системы не удалялись.', guide: 'systems', retryable: true },
  SYSTEM_DISCONNECTED: { status: 409, message: 'Система отключена.', hint: 'Подключите её снова в разделе «Системы» — данные сохранены.', guide: 'systems', retryable: false },
  SYSTEM_ID_CONFLICT: { status: 409, message: 'Система с таким идентификатором уже зарегистрирована.', hint: 'Откройте существующую систему или подключите эту папку как копию под новым идентификатором.', guide: 'systems', retryable: false },
  SYSTEM_PATH_CONFLICT: { status: 409, message: 'Папка пересекается с хранилищем другой системы.', hint: 'Выберите отдельную папку: системы не могут быть вложены друг в друга.', guide: 'systems', retryable: false },
  SYSTEM_NOT_FOUND_AT_PATH: { status: 404, message: 'В папке не найдена система Agentic OS.', hint: 'Выберите папку, в которой есть подпапка .aos с файлом system.json, или создайте новую систему.', guide: 'systems', retryable: false },
  SYSTEM_HAS_ACTIVE_RUNS: { status: 409, message: 'В системе выполняются процессы.', hint: 'Дождитесь завершения, приостановите или отмените процессы перед этой операцией.', guide: 'systems', retryable: true },
  CONFIRMATION_REQUIRED: { status: 409, message: 'Операция требует явного подтверждения.', hint: 'Подтвердите действие в диалоге (для удаления — введите точное название системы).', guide: 'systems', retryable: false },
  ARCHIVE_INVALID: { status: 400, message: 'Архив системы повреждён или имеет неподдерживаемый формат.', hint: 'Проверьте, что файл создан экспортом Agentic OS и не изменялся. Существующие системы не затронуты.', guide: 'backup', retryable: false },
  CROSS_SYSTEM_DENIED: { status: 403, message: 'Доступ к другой системе не разрешён для этого запуска.', hint: 'Выберите дополнительные системы явно при запуске процесса и выдайте агенту разрешение «Чтение других систем».', guide: 'permissions', retryable: false },
  EXTENSION_INVALID: { status: 400, message: 'Расширение не прошло проверку и не установлено.', hint: 'Посмотрите список причин. Расширения не получают опасных привилегий (запись на диск, запуск команд, секреты, изменение настроек безопасности) и не могут содержать исполняемый код, кроме плагинов-инструментов.', guide: 'extensions', retryable: false },
  EXTENSION_DISABLED: { status: 409, message: 'Расширение выключено.', hint: 'Включите его в разделе «Расширения», если доверяете ему.', guide: 'extensions', retryable: false },
  EXTENSION_BROKEN: { status: 409, message: 'Файлы расширения изменены после установки.', hint: 'Расширение заблокировано: его файлы не совпадают с проверенными при установке. Переустановите его из надёжного источника или удалите.', guide: 'extensions', retryable: false },
  APPLY_NOT_ALLOWED: { status: 403, message: 'Применение изменений к этому проекту не разрешено.', hint: 'Включите «Разрешить применение наборов изменений» в карточке проекта или скачайте набор как patch и примените его вручную.', guide: 'missions', retryable: false },
  CHECK_NOT_DEFINED: { status: 404, message: 'Проверка с таким именем не задана в настройках проекта.', hint: 'Добавьте команду проверки (например, запуск тестов) в карточке проекта → «Проверки».', guide: 'missions', retryable: false },
  CHECK_NOT_APPROVED: { status: 403, message: 'Запуск этой проверки не подтверждён для поручения.', hint: 'Подтвердите план поручения: в нём перечислены проверки, которые будут запущены.', guide: 'missions', retryable: false },
  MODE_FORBIDS: { status: 403, message: 'Текущий режим проекта не разрешает это действие.', hint: 'Режим меняет только пользователь в карточке проекта («Только изучение» → «Подготовить изменения» → «Работать в копии» → «Применить к исходному проекту»).', guide: 'project-safety', retryable: false },
  REVIEW_REQUIRED: { status: 409, message: 'Изменения нужно просмотреть перед применением.', hint: 'Откройте «Проверить изменения», просмотрите diff и отметьте набор как проверенный.', guide: 'project-safety', retryable: false },
  REVIEW_STALE: { status: 409, message: 'Набор изменений изменился после вашей проверки.', hint: 'Просмотрите изменения ещё раз: предыдущее согласование больше не действует.', guide: 'project-safety', retryable: false },
  CHECKS_REQUIRED: { status: 409, message: 'Изменения должны пройти проверки проекта в рабочей копии.', hint: 'Нажмите «Повторно проверить»: изменения будут применены к рабочей копии и проверены. Исходный проект при этом не меняется.', guide: 'project-safety', retryable: false },
  WORKCOPY_FAILED: { status: 409, message: 'Не удалось создать рабочую копию проекта.', hint: 'Исходный проект не изменялся. Проверьте свободное место и размер проекта или работайте в режиме «Подготовить изменения» (патч).', guide: 'project-safety', retryable: true },
  COMMAND_BLOCKED: { status: 403, message: 'Команда заблокирована политикой безопасности.', hint: 'Приложение не запускает неизвестные скрипты, команды удаления, команды с повышенными правами и изменяющие Git команды.', guide: 'project-safety', retryable: false },
  SECRET_EGRESS_BLOCKED: { status: 403, message: 'Отправка заблокирована: в данных обнаружен секрет.', hint: 'Похожие на ключи и пароли значения не передаются во внешние сервисы. Уберите секрет из документа или используйте локальную модель.', guide: 'project-safety', retryable: false },
  UNAUTHORIZED: { status: 401, message: 'Сессия недействительна.', hint: 'Перезапустите приложение или откройте ссылку, которую вывел сервер при запуске.', guide: 'first-run', retryable: false },
  INTERNAL: { status: 500, message: 'Внутренняя ошибка приложения.', hint: 'Подробности сохранены в журнале (раздел «История и журнал»).', guide: 'troubleshooting', retryable: false },
} as const satisfies Record<string, { status: number; message: string; hint: string; guide: string | undefined; retryable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface AppErrorJson {
  code: ErrorCode;
  message: string;
  hint: string;
  guide?: string;
  details?: unknown;
  retryable: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly guide: string | undefined;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, opts: { hint?: string; details?: unknown; cause?: unknown; guide?: string } = {}) {
    const entry = ERROR_CATALOG[code];
    super(message ?? entry.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.hint = opts.hint ?? entry.hint;
    this.guide = opts.guide ?? entry.guide;
    this.details = opts.details;
    this.retryable = entry.retryable;
    this.status = entry.status;
  }

  toJSON(): AppErrorJson {
    const out: AppErrorJson = { code: this.code, message: this.message, hint: this.hint, retryable: this.retryable };
    if (this.guide) out.guide = this.guide;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && e.name === 'AbortError') return new AppError('CANCELLED', undefined, { cause: e });
  return new AppError('INTERNAL', undefined, { cause: e });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AppError('CANCELLED');
}
