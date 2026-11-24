import { parseCode } from '../../shared/code.ts';
import { SECRET_PATTERN } from '../../shared/secret.ts';

export type Door = { kind: 'link'; secret: string } | { kind: 'code'; code: string };

/** What was typed after "receive" (or given to the MCP tool): a link of this site, or a nine-digit code. Null when it is neither. A link to another site is refused. */
export function doorOf(text: string, origin: string): Door | null {
  const code = parseCode(text);
  if (code) return { kind: 'code', code };
  try {
    const u = new URL(text);
    if (u.origin !== origin) return null;
    const secret = u.hash.slice(1);
    return u.pathname.replace(/\/$/, '') === '/r' && SECRET_PATTERN.test(secret) ? { kind: 'link', secret } : null;
  } catch {
    return null;
  }
}
