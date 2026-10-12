import { findSecretKinds } from '../fs/secrets.ts';
import { redact } from '../util/redact.ts';

/**
 * Last check before content leaves the computer (29.12, 29.17): secret-like values (key patterns and every secret
 * value the application itself holds) are never sent to cloud models, search engines or web servers.
 */
export function secretKindsIn(text: string): string[] {
  const kinds = findSecretKinds(text);
  if (!kinds.length && redact(text) !== text) kinds.push('секретное значение (ключ или токен)');
  return kinds;
}
