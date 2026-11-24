/** Every link, QR text and share text the page hands out is built here, from the address the Worker gave the page. */

/** The link a receiver opens: `<origin>/r/#<secret>`. `origin` is SITE_ORIGIN as the Worker put it in `fd-config`. */
export function buildLink(origin: string, secret: string): string {
  return `${origin.replace(/\/+$/, '')}/r/#${secret}`;
}

export interface ShareLink {
  id: 'email' | 'text' | 'whatsapp';
  label: string;
  href: string;
}

/**
 * Where the link can go when the browser has no share sheet. We send nothing ourselves:
 * each is a plain address that opens the person's own mail, messages or WhatsApp.
 * The share text is the link and nothing else, never the code.
 */
export function shareLinks(link: string, labels: { email: string; text: string; whatsapp: string; subject: string }): ShareLink[] {
  const enc = encodeURIComponent(link);
  return [
    { id: 'email', label: labels.email, href: `mailto:?subject=${encodeURIComponent(labels.subject)}&body=${enc}` },
    { id: 'text', label: labels.text, href: `sms:?&body=${enc}` },
    { id: 'whatsapp', label: labels.whatsapp, href: `https://wa.me/?text=${enc}` },
  ];
}

/** True when the browser's own share sheet can take this link. */
export function canShareLink(link: string, nav: Navigator = navigator): boolean {
  if (typeof nav.share !== 'function') return false;
  return typeof nav.canShare === 'function' ? nav.canShare({ url: link }) : true;
}

/** "30 seconds", "2 minutes", "1 hour": how long a person has to wait, in words. */
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return s === 1 ? '1 second' : `${s} seconds`;
  if (s < 3600) {
    const m = Math.ceil(s / 60);
    return m === 1 ? '1 minute' : `${m} minutes`;
  }
  const h = Math.ceil(s / 3600);
  return h === 1 ? '1 hour' : `${h} hours`;
}
