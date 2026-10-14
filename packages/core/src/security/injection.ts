/**
 * Heuristic detection of instructions aimed at AI agents inside untrusted content (29.10). Detection never grants
 * or removes anything: content is always treated as data and every action is still checked by the permission
 * engine. Detected attempts are recorded in the security journal so the user can see them.
 */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'asks to ignore the rules', re: /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|system|your)\b.{0,40}\b(instructions?|rules?|prompts?|polic(y|ies)|restrictions?)/i },
  { label: 'asks to disable protections', re: /\b(disable|turn off|switch off|bypass|skip)\b.{0,40}\b(security|safety|checks?|protections?|guardrails?|sandbox|review)\b/i },
  { label: 'impersonates the system role', re: /\b(you are now|act as (the )?system|new system prompt|developer mode|jailbreak)\b/i },
  { label: 'targets secrets', re: /(read|open|print|show|send|cat)\b.{0,40}(\.env\b|id_rsa|\.ssh|api[_ -]?key|credentials|secrets?\.json|passwords?|tokens?)/i },
  { label: 'sends data out', re: /\b(send|upload|post|exfiltrat\w*|transmit)\b.{0,60}\b(https?:\/\/|server|webhook|endpoint)/i },
  { label: 'destructive command', re: /\brm\s+-rf\b|\bdel\s+\/s\b|\bformat\s+c:|\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[a-z]*f)/i },
  { label: 'changes permissions', re: /\b(grant|give|enable)\b.{0,40}\b(permissions?|access|privileges?|rights)\b/i },
  { label: 'hides actions', re: /\b(do not|don't|never)\b.{0,30}\b(tell|inform|show|notify)\b.{0,30}\buser\b|\bhide\b.{0,40}\bfrom the user\b/i },
];

export function detectInjection(text: string): string[] {
  if (!text || text.length < 12) return [];
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text;
  return [...new Set(PATTERNS.filter((p) => p.re.test(sample)).map((p) => p.label))];
}
