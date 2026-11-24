/** "12.3 MB": sizes in plain decimal units, for the terminal and for the window. */
export const size = (n: number): string => {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return (u === 0 ? String(v) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[u];
};

/** ", about 3 min left", or an empty text when it is not known. */
export const etaText = (eta: number | null): string =>
  eta === null ? '' : eta < 10 ? ', a few seconds left' : eta < 60 ? `, ${Math.round(eta)} seconds left` : eta < 3600 ? `, about ${Math.round(eta / 60)} min left` : `, about ${Math.floor(eta / 3600)} h ${Math.round((eta % 3600) / 60)} min left`;
