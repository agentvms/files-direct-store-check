/** The route a transfer takes, and what the server tells the page about it. Nothing here is secret. */

/** One gigabyte as the relay's own numbers count it. */
export const GB = 1e9;

/** What the room server tells both pages about the route: `{ t: 'route', state, used?, free? }`. */
export type RouteState = 'relay' | 'limit' | 'month-stop';

export interface RouteMessage {
  t: 'route';
  state: RouteState;
  /** Bytes used on this route and the free amount, from the server's count (never the page's). */
  used?: number;
  free?: number;
}

/** How long the page waits for a direct connection before it asks for the route through our servers. */
export const DIRECT_WAIT_MS = 4000;

/**
 * When the other side has sent addresses on its own network, a direct connection may still be coming (a phone waking its Wi-Fi,
 * a local name still being looked up), so the page waits this long in all before it asks for the route through our servers.
 * Kept well under CONNECT_SLOW_MS so the fallback has time to open before the page says it is taking longer.
 */
export const DIRECT_WAIT_LOCAL_MS = 7000;

/** While relayed, how long before each new try at a direct connection (the last value repeats). */
export const DIRECT_RETRY_MS = [20_000, 30_000, 60_000];

/** How long the page may sit on "Connecting…" before it says it is taking longer than usual. The connection keeps trying behind the message. */
export const CONNECT_SLOW_MS = 15_000;

/** A direct try that has not opened after this long is dropped. */
export const DIRECT_TRY_MS = 15_000;

/** Lifetime of a relay credential, and how often an open page renews it. */
export const CREDENTIAL_TTL_S = 3600;
export const CREDENTIAL_RENEW_MS = 40 * 60 * 1000;

/** What the Worker puts in the page's JSON block about routes. */
export interface RouteConfig {
  /** Move a relayed transfer to a direct connection when one opens. */
  switch: boolean;
  /** Test builds only: force the relay and shorten the waits. */
  test?: { relayOnly: boolean; directWaitMs: number; retryMs: number };
}
