export function nowIso(): string {
  return new Date().toISOString();
}

export function isoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isoTime(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Formats a date with a subset of Moment.js tokens (the ones Obsidian templates use most):
 * YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm ss. Text in [brackets] is kept literally.
 */
export function formatDate(d: Date, format: string): string {
  const monthsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const daysLong = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => monthsLong[d.getMonth()]!,
    MMM: () => monthsLong[d.getMonth()]!.slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => daysLong[d.getDay()]!,
    ddd: () => daysLong[d.getDay()]!.slice(0, 3),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
  };
  const re = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g;
  return format.replace(re, (match, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    return tokens[match]?.() ?? match;
  });
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
