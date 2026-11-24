/** The nine-digit code a receiver can type instead of opening the link. See docs/PROTOCOL.md. */

export const CODE_DIGITS = 9;
export const CODE_PATTERN = /^\d{9}$/;

/** `123456789` becomes `123 456 789`. */
export function formatCode(code: string): string {
  return code.replace(/(\d{3})(?=\d)/g, '$1 ');
}

/**
 * What a person typed, as the nine digits, or null. Accepts `123456789`, `123 456 789`
 * and `123-456-789` (spaces or dashes only between the groups), nothing else.
 */
export function parseCode(text: string): string | null {
  const t = text.trim();
  if (CODE_PATTERN.test(t)) return t;
  const m = /^(\d{3})([ -])(\d{3})\2(\d{3})$/.exec(t);
  return m ? m[1]! + m[3]! + m[4]! : null;
}

const SPAN = 1_000_000_000;
/** The largest multiple of the code range that fits in 32 bits: draws at or above it are thrown away, so every code is equally likely. */
const LIMIT = Math.floor(0x1_0000_0000 / SPAN) * SPAN;

/** A uniform nine-digit code (leading zeros allowed) by rejection sampling. `random32` gives one unsigned 32-bit number. */
export function drawCode(random32: () => number): string {
  for (;;) {
    const n = random32();
    if (n < LIMIT) return String(n % SPAN).padStart(CODE_DIGITS, '0');
  }
}

export function randomCode(): string {
  const buf = new Uint32Array(1);
  return drawCode(() => {
    crypto.getRandomValues(buf);
    return buf[0]!;
  });
}
