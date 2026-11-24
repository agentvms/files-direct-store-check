import { describe, expect, it } from 'vitest';
import { drawCode, formatCode, parseCode, randomCode } from '../../src/shared/code.ts';

describe('code', () => {
  it('shows nine digits in three groups, keeping leading zeros', () => {
    expect(formatCode('123456789')).toBe('123 456 789');
    expect(formatCode('000000042')).toBe('000 000 042');
  });
  it('accepts the three written forms', () => {
    for (const t of ['123456789', '123 456 789', '123-456-789', ' 123456789 ']) expect(parseCode(t)).toBe('123456789');
    expect(parseCode('000 000 042')).toBe('000000042');
  });
  it('rejects everything else', () => {
    for (const t of ['', '12345678', '1234567890', '123 456-789', '123  456 789', '12a456789', '123456 789', '١٢٣٤٥٦٧٨٩', '123.456.789'])
      expect(parseCode(t), t).toBeNull();
  });
  it('throws away draws that would favour low codes', () => {
    const draws = [4_294_967_295, 4_000_000_000, 3_999_999_999];
    expect(drawCode(() => draws.shift()!)).toBe('999999999');
    expect(draws).toEqual([]);
    expect(drawCode(() => 1_000_000_007)).toBe('000000007');
  });
  it('draws only nine digits', () => {
    for (let i = 0; i < 200; i++) expect(randomCode()).toMatch(/^\d{9}$/);
  });
});
