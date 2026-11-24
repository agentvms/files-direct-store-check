/** Runs a function after a delay; returns how to cancel it. Kept apart so the transfer loop itself stays free of timers. */
export function later(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}
