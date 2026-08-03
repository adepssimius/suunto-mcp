/**
 * Hard limits from the SuuntoPlus Guide specification.
 *
 * These are not defensive guesses — every one is documented, and exceeding them
 * either fails validation server-side (400) or renders badly on the watch. The
 * compiler truncates to them rather than erroring, because a workout that is
 * slightly mislabelled on a 13-character display is far better than one that
 * doesn't reach the watch at all.
 */
export const LIMITS = {
  /** Guide title. */
  name: 60,
  /** Long description, shown in the app listing. */
  description: 256,
  /** Short description shown on the watch itself. */
  shortDescription: 23,
  /** Creator name; must match the OAuth application name for the Cloud API. */
  owner: 64,
  /** Link back to the source plan. */
  url: 256,
  /** Reference to the source entity; also the dedup key. */
  externalId: 64,
  /** Step title — a single line on the watch. Brutally short. */
  stepTitle: 13,
  /** Static text field value. Beyond ~40 chars it crowds out other fields. */
  text: 54,
  /** Per-field label. 9 when sharing the screen, 12 when alone. */
  fieldTitle: 9,
  /** Notification title. */
  notificationTitle: 13,
  /** Total steps in a guide, counting the contents of repeat blocks once. */
  steps: 1000,
  /** Repetition count for a single repeat block. */
  repeatTimes: 100,
} as const;

/**
 * The character set the watch can render. Anything outside it is dropped or
 * shown as an unrelated icon, so we strip rather than pass through.
 *
 * Notably absent, and easy to reach for by accident: `_`, `[`, `]`, `{`, `}`,
 * backtick, `~`, `^`, and every non-ASCII character (so no en-dashes, no
 * degree-minute primes, no accented names).
 *
 * `@` is a deliberate exception. Suunto's published charset lists `?` followed
 * directly by `A`, which excludes `@` (0x40) — but Suunto's own sample guide,
 * the one documented as returning 201, puts `@` in a text field:
 * "Interval #1 5min @ 90%". A working example beats a prose range that reads
 * like it dropped a character, and `@` is too natural in workout notation to
 * mangle on the strength of the weaker source. If the watch turns out to render
 * it as an icon, delete it here and it becomes "at" via the table below.
 */
const SUPPORTED_CHARS = new Set(
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz|°',
);

/** Common substitutions applied before stripping, so meaning survives. */
const TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‐-―]/g, '-'], // hyphens, en/em dashes
  [/[‘’‛]/g, "'"], // curly single quotes
  [/[“”]/g, '"'], // curly double quotes
  [/…/g, '...'], // ellipsis
  [/×/g, 'x'], // multiplication sign
  [/[_~^`]/g, '-'],
  [/[[{]/g, '('],
  [/[\]}]/g, ')'],
];

/**
 * Make a string safe for the watch display: transliterate what we can, drop what
 * we can't, collapse the whitespace that dropping leaves behind.
 *
 * Newlines are preserved for `text` fields, which support up to 6 lines.
 */
export function sanitize(input: string): string {
  let s = input.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // strip diacritics
  for (const [pattern, replacement] of TRANSLITERATIONS) {
    s = s.replace(pattern, replacement);
  }
  let out = '';
  for (const ch of s) {
    if (ch === '\n') out += ch;
    else if (SUPPORTED_CHARS.has(ch)) out += ch;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/**
 * Sanitize and truncate to `max`. Truncation prefers a word boundary when one
 * falls in the last third of the budget, so "10 min threshold" becomes
 * "10 min" rather than "10 min thresh".
 */
export function fit(input: string, max: number): string {
  const s = sanitize(input);
  if (s.length <= max) return s;
  const hard = s.slice(0, max);
  const lastSpace = hard.lastIndexOf(' ');
  if (lastSpace >= Math.floor(max * (2 / 3))) return hard.slice(0, lastSpace).trimEnd();
  return hard.trimEnd();
}
