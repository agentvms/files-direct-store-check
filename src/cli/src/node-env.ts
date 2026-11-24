import { RTCPeerConnection as Polyfill } from 'node-datachannel/polyfill';

/** The names the native library uses for the kind of an address, as the words the page's code reads. */
const KINDS: Record<string, string> = { Host: 'host', ServerReflexive: 'srflx', PeerReflexive: 'prflx', Relayed: 'relay', host: 'host', srflx: 'srflx', prflx: 'prflx', relay: 'relay' };

type Server = { urls: string | string[]; username?: string; credential?: string };

/** The native library takes a user name and password inside the address, so characters such as ":" and "@" have to be encoded. */
function encoded(config: RTCConfiguration | undefined): RTCConfiguration | undefined {
  if (!config?.iceServers) return config;
  return { ...config, iceServers: config.iceServers.map((s: Server) => (s.username && s.credential ? { ...s, username: encodeURIComponent(s.username), credential: encodeURIComponent(s.credential) } : s)) };
}

/** The browser's own connection shape, from the native library, with the statistics worded the way the page's code expects. */
export class NodePeerConnection extends Polyfill {
  constructor(config?: RTCConfiguration) {
    super(encoded(config));
  }

  override async getStats(): Promise<RTCStatsReport> {
    const report = await super.getStats();
    report.forEach((v: unknown) => {
      const s = v as { candidateType?: string };
      if (typeof s.candidateType === 'string') s.candidateType = KINDS[s.candidateType] ?? s.candidateType;
    });
    return report;
  }
}

/** Makes the shared connection code (web/src/connection.ts) run here: it reaches for the browser's `RTCPeerConnection`. */
export function installBrowserParts(): void {
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = NodePeerConnection;
}
