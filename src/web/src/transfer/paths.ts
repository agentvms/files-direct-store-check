/** Cleans a path that came from the other side before it names anything on this device. */

const MAX_SEGMENT = 200;

export function cleanPath(raw: string): string {
  const segments: string[] = [];
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    // eslint-disable-next-line no-control-regex
    const seg = part.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (seg === '' || seg === '.' || seg === '..') continue;
    segments.push(seg.length > MAX_SEGMENT ? seg.slice(0, MAX_SEGMENT) : seg);
  }
  // a drive letter ("C:") is not a folder either
  if (segments.length > 1 && /^[A-Za-z]:$/.test(segments[0]!)) segments.shift();
  return segments.join('/') || 'file';
}

/** Cleans every path and keeps them unique: a second "a.txt" becomes "a (2).txt". */
export function cleanPaths(raw: string[]): string[] {
  const used = new Set<string>();
  return raw.map((r) => {
    const base = cleanPath(r);
    let path = base;
    for (let n = 2; used.has(path.toLowerCase()); n++) {
      const slash = base.lastIndexOf('/') + 1;
      const dot = base.lastIndexOf('.');
      const at = dot > slash ? dot : base.length;
      path = `${base.slice(0, at)} (${n})${base.slice(at)}`;
    }
    used.add(path.toLowerCase());
    return path;
  });
}
