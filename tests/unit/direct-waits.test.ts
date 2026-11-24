import { describe, expect, it } from 'vitest';
import { ICE_URLS } from '../../src/shared/config.ts';
import { CONNECT_SLOW_MS, DIRECT_RETRY_MS, DIRECT_TRY_MS, DIRECT_WAIT_LOCAL_MS, DIRECT_WAIT_MS } from '../../src/shared/route.ts';

describe('how long a direct connection is given, and where it looks (fd-1za)', () => {
  it('asks for the route through our servers before the page says it is taking longer than usual, even on the longer wait', () => {
    expect(DIRECT_WAIT_MS).toBeLessThan(DIRECT_WAIT_LOCAL_MS);
    expect(DIRECT_WAIT_LOCAL_MS).toBeLessThan(CONNECT_SLOW_MS);
    expect(DIRECT_WAIT_MS).toBe(4000);
    expect(DIRECT_WAIT_LOCAL_MS).toBe(7000);
  });

  it('keeps a direct try that is racing the route through our servers alive longer than either wait', () => {
    expect(DIRECT_TRY_MS).toBeGreaterThan(DIRECT_WAIT_LOCAL_MS);
    expect(Math.min(...DIRECT_RETRY_MS)).toBeGreaterThan(DIRECT_WAIT_LOCAL_MS);
  });

  it('lists Cloudflare\'s address on 3478 and on 443, each once', () => {
    expect(ICE_URLS).toContain('stun:stun.cloudflare.com:3478');
    expect(ICE_URLS).toContain('stun:stun.cloudflare.com:443');
    expect(new Set(ICE_URLS).size).toBe(ICE_URLS.length);
    expect(ICE_URLS.every((u) => /^stun:[a-z.]+:\d+$/.test(u))).toBe(true);
  });
});
