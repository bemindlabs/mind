/**
 * The shapes a string may have in anything Mind signs or prices (S15.8 review M2, S15.9, D-141), and how
 * any string is made safe to print.
 *
 * One file, because two readers need the same rule: the usage report (`report.ts`), which refuses a report
 * with any string outside these shapes, and the price table (`src/pricing/table.ts`), whose backend, model
 * and version end up in a signed row. Written twice, the two would drift, and the drift would show up as a
 * report its own producer cannot sign. {@link printable} is here too, so a command that prints a price
 * file's complaint (`turn`) escapes it without importing the report.
 */

/** A backend a model sits behind: a plain id. Messages carry `:` and a peer or a person after it. */
const MODEL_BACKEND = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A ledger line's id or turn id, and a price table's version. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A model's name: `name` or `org/name`. Not a path. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})?$/;
/** An instant as `toISOString` writes it (fraction optional). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * A listing's slug, exactly as the platform checks it (`mind-platform/src/market/validate.ts`, `SLUG`):
 * 3–40 lower-case letters, digits and hyphens, starting and ending with a letter or digit.
 */
const LISTING_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** A job's id on a market: the platform's are UUIDs; letters, digits and `_.:-`, up to 128, allow others. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Longer than `https://` + a 253-character host + `:65535`: not an origin. */
const MAX_ORIGIN = 300;
/** The two hosts a market may be reached on over plain http — a test on this machine, and nothing else. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function isModelBackend(backend: string): boolean {
  return MODEL_BACKEND.test(backend);
}

export function isModelName(model: string): boolean {
  return MODEL_NAME.test(model);
}

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

export function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

export function isListingSlug(value: unknown): value is string {
  return typeof value === "string" && LISTING_SLUG.test(value);
}

export function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}

/**
 * Why this is not a market's origin as a signed proof or report names it (D-141), or undefined.
 *
 * An origin is `scheme://host[:port]` written the one way a browser writes `location.origin`, because the
 * platform compares it with its own origin as a string: https only (http only to `127.0.0.1` or `localhost`,
 * for a local test), no user name or password, no path — not even `/` — no query and no fragment, the host in
 * lower case and an international name in its punycode (`xn--…`) form, no default port, and no trailing dot.
 * Anything else is refused rather than tidied: what is signed is what was typed, so a proof must never name a
 * market the owner did not write. Where the URL parser can say what the one spelling would be, the reason
 * says it.
 */
export function marketOriginProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return "is empty — a market is named by its origin, such as https://market.example";
  if (value.length > MAX_ORIGIN) return `is longer than ${MAX_ORIGIN} characters, which no origin is`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL — a market is named by its origin, such as https://market.example";
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !local) return "is not https — only https://, or http://127.0.0.1 and http://localhost for a test on this machine";
  if (url.username !== "" || url.password !== "" || value.includes("@")) return "carries a user name or password, which an origin does not";
  if (url.search !== "" || url.hash !== "" || value.includes("?") || value.includes("#")) return "has a query or a fragment, which an origin does not";
  if (url.pathname !== "/") return "has a path, which an origin does not";
  if (value.endsWith("/")) return `ends in /, which an origin does not — write ${url.origin}`;
  if (url.hostname.endsWith(".")) return "ends its host in a dot, which is a different origin from the one without";
  if (value !== url.origin) return `is not written the one way an origin is written — write ${url.origin}`;
  return undefined;
}

/**
 * Text as it may be shown on a terminal: C0 and C1 controls, DEL, the bidi embeddings, overrides and isolates,
 * and the line and paragraph separators become `\u{…}`. Everything that came from a report or a price file
 * goes through this before it is printed, whether or not it passed — the check is the first line, this is the
 * second.
 */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}
