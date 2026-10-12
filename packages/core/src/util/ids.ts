import { randomBytes } from 'node:crypto';

// Crockford base32 ULID: 48-bit time + 80-bit randomness, lexicographically sortable by creation time.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRandom: Uint8Array | null = null;

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 chars
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 16);
}

/** Monotonic ULID; ids generated within the same millisecond keep increasing. */
export function ulid(now: number = Date.now()): string {
  let random: Uint8Array;
  if (now === lastTime && lastRandom) {
    random = new Uint8Array(lastRandom);
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i]! < 255) {
        random[i] = random[i]! + 1;
        break;
      }
      random[i] = 0;
    }
  } else {
    random = new Uint8Array(randomBytes(10));
  }
  lastTime = now;
  lastRandom = random;
  return encodeTime(now) + encodeRandom(random);
}

export function newId(prefix?: string): string {
  return prefix ? `${prefix}_${ulid()}` : ulid();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
