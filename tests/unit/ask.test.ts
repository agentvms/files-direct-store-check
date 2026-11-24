import { describe, expect, it } from 'vitest';
import { cleanNote, cleanStart } from '../../src/shared/ask.ts';
import { ASK_NOTE_MAX_CHARS } from '../../src/shared/config.ts';
import { cleanRecord } from '../../src/shared/record-clean.ts';
import { recordText } from '../../src/shared/record.ts';
import { deviceFrom } from '../../src/shared/device.ts';

describe('the note an asker may add', () => {
  it('is shown as plain text: control, hidden and direction-changing characters are gone', () => {
    expect(cleanNote('the signed lease')).toBe('the signed lease');
    expect(cleanNote('a\u0000b\u0007c\u001bd\u007fe')).toBe('abcde');
    expect(cleanNote('a\u202eb\u2066c\u200bd\ufeffe\u00adf')).toBe('abcdef');
    expect(cleanNote('line one\nline two\r\n\tline three')).toBe('line one line two line three');
    expect(cleanNote('  too   many    spaces  ')).toBe('too many spaces');
  });
  it('is kept as text: markup stays markup characters, never HTML for a screen to read', () => {
    expect(cleanNote('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>'); // a screen sets it as textContent
  });
  it('is cut to the limit, in whole characters', () => {
    const long = 'a'.repeat(ASK_NOTE_MAX_CHARS + 50);
    expect(Array.from(cleanNote(long))).toHaveLength(ASK_NOTE_MAX_CHARS);
    const emoji = '😀'.repeat(ASK_NOTE_MAX_CHARS + 5);
    expect(Array.from(cleanNote(emoji))).toHaveLength(ASK_NOTE_MAX_CHARS);
    expect(cleanNote(emoji)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no half of a pair
  });
  it('is no note at all when nothing is left', () => {
    for (const v of ['', '   ', '\u0000\u202e', '\n\t', undefined, null, 5, {}, ['x']]) expect(cleanNote(v)).toBe('');
  });
});

describe('the start word', () => {
  it('is one of two fixed words, or null', () => {
    expect(cleanStart('ask')).toBe('ask');
    expect(cleanStart('send')).toBe('send');
    for (const v of ['ASK', 'ask ', 'the signed lease', '', 5, null, undefined, {}]) expect(cleanStart(v)).toBeNull();
  });
  it('goes on the room record as the room says it, whatever the page said', () => {
    const page = { self: deviceFrom('', 0), other: null, joined: null, sameAddress: null, route: null, reason: null, attempts: [], retries: 0, start: 'ask' };
    expect(cleanRecord(page, null)!.start).toBe('ask');
    expect(cleanRecord(page, null, 'send')!.start).toBe('send');
    expect(cleanRecord({ ...page, start: 'the signed lease' }, null)!.start).toBeNull();
    expect(recordText(cleanRecord(page, null)!)).toContain('How the room began: someone asked for files');
    expect(recordText(cleanRecord(page, null, 'send')!)).toContain('How the room began: someone sent files');
    expect(recordText(cleanRecord({ ...page, start: undefined }, null)!)).not.toContain('How the room began');
  });
});
