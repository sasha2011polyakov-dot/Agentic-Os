/**
 * Heuristic detection of instructions aimed at AI agents inside untrusted content (29.10). Detection never grants
 * or removes anything: content is always treated as data and every action is still checked by the permission
 * engine. Detected attempts are recorded in the security journal so the user can see them.
 */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'просьба игнорировать правила', re: /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|system)\b.{0,40}\b(instructions?|rules?|prompts?|polic(y|ies))/i },
  { label: 'просьба игнорировать правила', re: /(игнорируй|проигнорируй|забудь|отмени)\w*.{0,60}(инструкц|правил|ограничен|политик)/i },
  { label: 'подмена роли системы', re: /\b(you are now|act as (the )?system|new system prompt|developer mode|jailbreak)\b/i },
  { label: 'подмена роли системы', re: /(ты теперь|теперь ты|новая системная инструкция|режим разработчика)/i },
  { label: 'обращение к секретам', re: /(read|open|print|show|send|cat)\b.{0,40}(\.env\b|id_rsa|\.ssh|api[_ -]?key|credentials|secrets?\.json)/i },
  { label: 'обращение к секретам', re: /(прочитай|выведи|покажи|отправь).{0,40}(\.env|ключ|парол|секрет|токен)/i },
  { label: 'передача данных наружу', re: /\b(send|upload|post|exfiltrat\w*|transmit)\b.{0,60}\b(https?:\/\/|server|webhook|endpoint)/i },
  { label: 'передача данных наружу', re: /(отправь|передай|загрузи).{0,60}(https?:\/\/|сервер|вебхук)/i },
  { label: 'разрушительная команда', re: /\brm\s+-rf\b|\bdel\s+\/s\b|\bformat\s+c:|\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[a-z]*f)/i },
  { label: 'изменение разрешений', re: /\b(grant|give|enable)\b.{0,40}\b(permissions?|access|privileges?)\b|(выдай|включи|предоставь).{0,40}(разрешени|права|доступ)/i },
  { label: 'скрытие действий', re: /\b(do not|don't|never)\b.{0,30}\b(tell|inform|show)\b.{0,30}\buser\b|(не (сообщай|говори|показывай)).{0,30}пользовател|скрой.{0,40}от пользовател/i },
];

export function detectInjection(text: string): string[] {
  if (!text || text.length < 12) return [];
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text;
  return [...new Set(PATTERNS.filter((p) => p.re.test(sample)).map((p) => p.label))];
}
