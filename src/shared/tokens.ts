// The look of the app, in one place: the owner's design system (docs/DESIGN_SYSTEM.md), light theme only. Nothing that draws on screen may use a
// colour, a corner radius or a font that is not listed here: tests/unit/tokens.test.ts reads every stylesheet and every piece of markup in web/,
// worker/, shared/ and content/ and fails on one that is. The contrast check (scripts/contrast.mjs) reads the pairs below.
// Where this differs from the owner's file (the contrast fixes, files-direct-18): ink-muted, border-strong and border-hover. See "Applied in Files Direct".

/** Light theme. Custom properties are made from these as --fd-<name> (see `rootVars`). */
export const COLOURS = {
  // archival surfaces
  canvas: '#F6F4EE',
  parcel: '#FFFFFF',
  inset: '#EFECE4',
  chip: '#FAF9F6',
  lightbox: '#161614',
  stone: '#E8E5DC', // the plain wash above a phone's bottom sheet (the file's fallback; no preview colour is taken from the files)
  // ink
  'ink-primary': '#1C1B19',
  'ink-secondary': '#5A5750',
  'ink-muted': '#6B6861', // the file's #858178 is 3.3 to 3.9 : 1 on every surface; this one passes 4.5 : 1
  'on-pine': '#FFFFFF',
  // hairlines
  'border-subtle': '#E6E2D8', // card perimeter, dividers: never the edge of a control
  'border-strong': '#8A867D', // every button and input edge (the file's #C9C4B8 is 1.7 : 1 on white; the owner's #8C887F is 2.99 : 1 on the inset tray, this is 3.07)
  'border-hover': '#6B6861', // hover on a control edge (the file's #9C978B is 2.9 : 1)
  // botanical pine
  'pine-600': '#265C47',
  'pine-700': '#1D4938',
  'pine-100': '#E5F0EB',
  'pine-live': '#2E8B63', // the live dot only, never the fill of a badge with text
  // status
  'amber-bg': '#F6EDD8',
  'amber-ink': '#855814',
  'danger-ink': '#A63A2B',
  'danger-bg': '#FBEEEC',
} as const;

/** The pen colours of the feedback box's picture editor. They are drawn on the person's own screenshot, so they are not the page's colours. */
export const ANNOTATION = { red: '#FF2323', yellow: '#FFD400', black: '#111111', white: '#FFFFFF' } as const;

/** Warm-tinted shadows (the ink is the design's rgba(28,27,25,a)). */
export const SHADOWS = {
  parcel: '0 1px 2px rgba(28,27,25,.04),0 12px 32px rgba(28,27,25,.08)',
  print: '0 2px 6px rgba(28,27,25,.10),0 8px 20px rgba(28,27,25,.10)',
  sheet: '0 -8px 32px rgba(28,27,25,.14)',
} as const;

/** See-through colours that are not a shadow: the red pen on the screenshot, with `${...}` for a number worked out at run time. */
export const TRANSLUCENT_EXTRA = ['rgba(255,35,35,${n})'] as const;
/** rgba of the shadow ink, any opacity. */
export const SHADOW_INK = 'rgba(28,27,25,';

/** Colour words CSS and SVG allow without being a colour of ours. */
export const COLOUR_KEYWORDS = ['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none'] as const;

export const RADII_TOKENS = {
  parcel: '20px', // the floating parcel
  sheet: '24px', // the top corners of a phone's bottom sheet
  media: '12px', // posters, tiles of a picture
  control: '10px', // every button, input and chip
  pill: '999px', // status pills and badges
  tray: '14px', // the send-back tray
} as const;
/** Corner radii in use: the tokens above, no corner (0) and a circle (50%, for dots). */
export const RADII: readonly string[] = ['0', '50%', ...Object.values(RADII_TOKENS)];

export const FONT_FAMILY_NAME = 'Inter';
export const DISPLAY_FAMILY_NAME = 'Newsreader';
/** Our own files, never another address (web/public/fonts): Inter is one variable file, Newsreader one weight (600) for titles. Latin only. */
export const FONT_FILE = '/fonts/inter-latin-wght-normal.woff2';
export const DISPLAY_FILE = '/fonts/newsreader-latin-600-normal.woff2';
export const FONT_SANS = `${FONT_FAMILY_NAME},system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;
export const FONT_DISPLAY = `${DISPLAY_FAMILY_NAME},Georgia,"Times New Roman",serif`;
/** The design's mono is not shipped (no third font file): the code is the sans with tabular numerals. */
export const FONT_MONO = FONT_SANS;
export const FONT_STACKS = [FONT_SANS, FONT_DISPLAY] as const;
/** Family names a stylesheet may declare with @font-face. */
export const FONT_FACES = [FONT_FAMILY_NAME, DISPLAY_FAMILY_NAME] as const;
/** Kept for the font-face of the body font. */
export const FONT_BODY = FONT_SANS;

/**
 * Motion (design system section 6): one easing and three durations, nothing else. A stylesheet uses them as var(--fd-ease), var(--fd-dur-fade),
 * var(--fd-dur-state), var(--fd-dur-pulse); a script reads the numbers. tests/unit/tokens.test.ts fails on a duration or an easing written anywhere else.
 * Every use sits behind prefers-reduced-motion: no-preference, and nothing at all runs when the person asks for less (files-direct-24, D1).
 */
export const MOTION = {
  /** Smooth, physical slowing down: never a bounce. */
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** A symmetric ease-in-out, for the slow breath of the live dot (a deceleration curve applied to each half of a loop makes it snap). */
  easeBreath: 'cubic-bezier(0.45, 0, 0.55, 1)',
  /** A button's colour change. */
  fadeMs: 120,
  /** The parcel's height when it moves from one state to the next. */
  stateMs: 240,
  /** One slow breath of the live dot. */
  pulseMs: 2800,
  fade: '120ms',
  state: '240ms',
  pulse: '2800ms',
} as const;

/** The keyboard focus ring: 3px, 2px gap, pine-600. Its colour is the one token a screen is checked against (e2e/focus.spec.ts). */
export const FOCUS = { colour: COLOURS['pine-600'], widthPx: 3, offsetPx: 2 } as const;

export const ALL_COLOURS: Record<string, string> = { ...COLOURS, ...Object.fromEntries(Object.entries(ANNOTATION).map(([k, v]) => ['pen-' + k, v])) };

/** :root{--fd-canvas:#F6F4EE;...} */
export function rootVars(): string {
  const parts = [
    ...Object.entries(COLOURS).map(([k, v]) => `--fd-${k}:${v}`),
    ...Object.entries(SHADOWS).map(([k, v]) => `--fd-shadow-${k}:${v}`),
    ...Object.entries(RADII_TOKENS).map(([k, v]) => `--fd-radius-${k}:${v}`),
    `--fd-ease:${MOTION.ease}`,
    `--fd-ease-breath:${MOTION.easeBreath}`,
    `--fd-dur-fade:${MOTION.fade}`,
    `--fd-dur-state:${MOTION.state}`,
    `--fd-dur-pulse:${MOTION.pulse}`,
    `--fd-font-sans:${FONT_SANS}`,
    `--fd-font-display:${FONT_DISPLAY}`,
    `--fd-font-mono:var(--fd-font-sans)`,
  ];
  return ':root{' + parts.join(';') + '}';
}

export interface Pair {
  /** What is drawn on what, in words. */
  name: string;
  fg: string;
  bg: string;
  /** 4.5 for text, 3 for large text and for the edge or ring of a control. */
  min: 3 | 4.5;
  /** A pair that does not meet its minimum, with the reason it is allowed for now. The check fails when a waived pair starts to pass (the waiver is stale). */
  waived?: string;
}

const C: Record<string, string> = COLOURS;
const c = (k: keyof typeof COLOURS): string => C[k]!;
const text = (name: string, fg: keyof typeof COLOURS, bg: keyof typeof COLOURS): Pair => ({ name, fg: c(fg), bg: c(bg), min: 4.5 });
const part = (name: string, fg: keyof typeof COLOURS, bg: keyof typeof COLOURS): Pair => ({ name, fg: c(fg), bg: c(bg), min: 3 });

/** Every pair of colours the app draws one on the other (the owner's contrast.py rows that apply to the light theme, plus the focus ring). */
export const PAIRS: readonly Pair[] = [
  text('headline, filename on parcel', 'ink-primary', 'parcel'),
  text('headline on canvas (home)', 'ink-primary', 'canvas'),
  text('text in inset tray', 'ink-primary', 'inset'),
  text('helper text on parcel', 'ink-secondary', 'parcel'),
  text('helper text on canvas', 'ink-secondary', 'canvas'),
  text('helper text in inset tray and pill', 'ink-secondary', 'inset'),
  text('helper text on paper chip', 'ink-secondary', 'chip'),
  text('footnote on parcel', 'ink-muted', 'parcel'),
  text('footnote on canvas', 'ink-muted', 'canvas'),
  text('footnote in inset tray', 'ink-muted', 'inset'),
  text('caption on paper chip', 'ink-muted', 'chip'),
  text('white on primary button', 'on-pine', 'pine-600'),
  text('white on primary button, hover', 'on-pine', 'pine-700'),
  text('filename on paper chip', 'ink-primary', 'chip'),
  text('pill text on the inset pill', 'ink-primary', 'inset'),
  part('file-type icon on paper chip', 'ink-secondary', 'chip'),
  part('check seal on parcel', 'pine-600', 'parcel'),
  text('check on the seal', 'on-pine', 'pine-600'),
  text('pine "Sent" and "Save" on parcel', 'pine-700', 'parcel'),
  text('pine text on parcel (links, Saved)', 'pine-600', 'parcel'),
  text('pine text on canvas (links)', 'pine-600', 'canvas'),
  text('pine text on pine pill', 'pine-700', 'pine-100'),
  text('pine text on inset', 'pine-700', 'inset'),
  text('amber status pill text', 'amber-ink', 'amber-bg'),
  text('danger text on parcel', 'danger-ink', 'parcel'),
  text('danger text on canvas', 'danger-ink', 'canvas'),
  text('danger text on its wash', 'danger-ink', 'danger-bg'),
  text('caption, name and count in the lightbox', 'parcel', 'lightbox'),
  part('close button icon, selected filmstrip border and focus halo in the lightbox', 'parcel', 'lightbox'),
  part('edge of the close button and of Accept in the lightbox', 'border-strong', 'lightbox'),
  text('headline and name on the stone wash (phone sheet header)', 'ink-primary', 'stone'),
  text('helper text on the stone wash', 'ink-secondary', 'stone'),
  text('danger text on the stone wash', 'danger-ink', 'stone'),
  part('edge of a header button on the stone wash', 'border-hover', 'stone'),
  part('focus ring on the stone wash', 'pine-600', 'stone'),
  part('edge of an outlined button or input on parcel', 'border-strong', 'parcel'),
  part('edge of an outlined button on canvas', 'border-strong', 'canvas'),
  part('edge of an outlined button on inset', 'border-strong', 'inset'),
  part('edge of an outlined button, hover', 'border-hover', 'parcel'),
  part('progress fill on its track', 'pine-600', 'inset'),
  part('live dot in the inset pill', 'pine-live', 'inset'),
  part('focus ring on parcel', 'pine-600', 'parcel'),
  part('focus ring on canvas', 'pine-600', 'canvas'),
  part('focus ring on inset', 'pine-600', 'inset'),
];

/** Colours that carry no text and no control edge, so no pair is needed. Every other colour above must appear in a pair (tests/unit/tokens.test.ts). */
export const NO_PAIR = ['border-subtle', 'pen-red', 'pen-yellow', 'pen-black', 'pen-white'] as const;
