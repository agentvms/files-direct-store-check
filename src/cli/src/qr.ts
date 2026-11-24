import qrcode from 'qrcode-generator';

/** A QR code for the terminal: black on white, two rows of modules to a line, four modules of quiet space around it. */
export function terminalQr(text: string): string {
  const q = qrcode(0, 'L');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const quiet = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const lines: string[] = [];
  for (let r = -quiet; r < n + quiet; r += 2) {
    let line = '\x1b[30;47m';
    for (let c = -quiet; c < n + quiet; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n');
}

/** The same code as one small picture for the window: black modules on white with a quiet border, as one path. Nothing in it but digits and path letters. */
export function qrSvg(text: string): string {
  const q = qrcode(0, 'L');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const quiet = 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!q.isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && q.isDark(r, c)) c++;
      d += `M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`;
    }
  }
  const side = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" aria-label="QR code for the link"><rect width="${side}" height="${side}" fill="#FFFFFF"/><path d="${d}" fill="#000000"/></svg>`;
}
