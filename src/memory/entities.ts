/**
 * The things memories talk about (D-092): ports, services, hosts, environment variables and paths, found
 * by their shape — no model, so the same text always gives the same graph, and nothing leaves the machine
 * to build it. `[[links]]` already join memory to memory; these join memories through what they share,
 * which is how "what uses port 10410" gets an answer.
 */

export const ENTITY_TYPES = ["port", "service", "host", "env", "path"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface Entity {
  readonly type: EntityType;
  readonly value: string;
  /** 1-based line of the first mention in the text. */
  readonly line: number;
}

// Not "sh", "py", "md" and the like: those are file extensions far more often than domains.
const TLDS = "com|net|org|io|ai|app|dev|tech|co|th|cloud|xyz|info";
const PATTERNS: readonly (readonly [EntityType, RegExp])[] = [
  // host:port, a port after a colon at a word edge, or "port 10410" — 2 to 5 digits after "port", 4 or 5 after a bare colon
  ["port", /(?:(?<=[a-z0-9\]\s`'"(=])|^):(\d{4,5})\b(?![:\d])/gi],
  ["port", /\bports?\s*(?:[=:]\s*)?`?(\d{2,5})\b/gi],
  ["service", /\b([a-z0-9][a-z0-9@._-]*\.(?:service|timer|socket))\b/gi],
  // Not inside a path ("vllm/run.sh"); after "//" (a URL) is fine.
  ["host", new RegExp(`(?<![\\w.-])(?<![\\w.~-]/)((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))\\b(?![.-]?[a-z0-9])`, "gi")],
  ["env", /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g],
  ["path", /(?<![\w/])(~\/[\w.@-]+(?:\/[\w.@-]+)*\/?)/g],
];

/** A value as it is compared: ports as numbers, hosts and services lower case, trailing dots and slashes off. */
function tidy(type: EntityType, raw: string): string | undefined {
  const v = raw.replace(/[.,;:]+$/, "");
  if (type === "port") {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? String(n) : undefined;
  }
  if (type === "host") return /^\d+(\.\d+)+$/.test(v) ? undefined : v.toLowerCase();
  if (type === "service") return v.toLowerCase();
  if (type === "path") return v.length > 2 ? v.replace(/\/$/, "") : undefined;
  return v.length >= 5 ? v : undefined;
}

/** Every entity the text mentions, once each, with the line it first appears on. */
export function extractEntities(text: string): Entity[] {
  const seen = new Map<string, Entity>();
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [type, pattern] of PATTERNS) {
      for (const m of line.matchAll(pattern)) {
        const value = tidy(type, m[1]!);
        if (value === undefined) continue;
        const key = `${type}:${value}`;
        if (!seen.has(key)) seen.set(key, { type, value, line: i + 1 });
      }
    }
  });
  // A service name is also a host-shaped word ("vllm.service" is not a host); keep it as the service only.
  const services = new Set([...seen.values()].filter((e) => e.type === "service").map((e) => e.value));
  return [...seen.values()].filter((e) => !(e.type === "host" && services.has(e.value)));
}

/** What someone asking about a thing probably means: "port 10410", ":10410", "10410" all ask for port 10410. */
export function entityQuery(raw: string): { readonly type?: EntityType; readonly value: string } {
  const q = raw.trim().replace(/^[`'"]|[`'"]$/g, "");
  const port = /^(?:port\s*)?:?(\d{2,5})$/i.exec(q);
  if (port) return { type: "port", value: String(Number(port[1])) };
  return { value: q.toLowerCase() };
}
