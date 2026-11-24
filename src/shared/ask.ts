/**
 * Asking for files (files-direct-28). A room can begin as an ask: the device that opens it says so with one fixed start word, and the other
 * device is told before it draws its first screen. The note the asker may add ("the signed lease") is not part of that: it goes over the
 * connection between the two devices and never to our side, so what this file holds for it is only how the receiving side cleans it.
 */
import { ASK_NOTE_MAX_CHARS } from './config.ts';

/** How a room began: someone sent files, or someone asked for them. The one word the room record and the analytics carry. */
export const START_WORDS = ['send', 'ask'] as const;
export type Start = (typeof START_WORDS)[number];

export const cleanStart = (v: unknown): Start | null => (typeof v === 'string' && (START_WORDS as readonly string[]).includes(v) ? (v as Start) : null);

// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/**
 * What the other side wrote, made safe to show: control, hidden and direction-changing characters out, every run of blank space one space, the
 * ends trimmed, cut to ASK_NOTE_MAX_CHARS (whole characters, never half of one). Plain text only: a screen puts it in as text, never as HTML.
 * An empty result means there is no note.
 */
export function cleanNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/[\t\n\r\u2028\u2029]+/g, ' ').replace(HIDDEN, '').replace(/ {2,}/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > ASK_NOTE_MAX_CHARS ? chars.slice(0, ASK_NOTE_MAX_CHARS).join('').trim() : text;
}
