/**
 * One turn for "Details" (D-194), read from what `mind ledger show --json --content` printed.
 *
 * The web server never opens the ledger: the ledger is read by its own command, the one declared reader (D-022),
 * and this file only shapes that command's output. Field by field, so nothing passes but the shapes below, and
 * defensively — a line from before usage or price was recorded lacks them and the answer then lacks them too.
 *
 * Nothing is invented: a token count the backend did not print is left out (never 0 — the ledger's
 * UNREPORTED_USAGE conventions, src/types.ts), usage with no count at all is left out whole, and money is the
 * ledger's own `cost.usd_micros` (Mind's arithmetic over a price table, D-110) or nothing. No estimate.
 */

import type { TurnDetail } from "./server.ts";
import { routeSentence } from "./turninfo.ts";

/** A count, or undefined when the value is not one — narrow, as the ledger's own reader is. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The turn with this ledger line id out of `ledger show --json --content`'s stdout, or undefined. */
export function turnDetailFrom(stdout: string, entryId: string, when: (iso: string) => string): TurnDetail | undefined {
  let shown: unknown;
  try {
    shown = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const entries = typeof shown === "object" && shown !== null ? (shown as Record<string, unknown>)["entries"] : undefined;
  if (!Array.isArray(entries)) return undefined;
  const e = entries.find((x): x is Record<string, unknown> => typeof x === "object" && x !== null && (x as Record<string, unknown>)["id"] === entryId);
  if (e === undefined || typeof e["backend"] !== "string" || typeof e["at"] !== "string") return undefined;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

  const durationMs = count(e["duration_ms"]);
  const raw = typeof e["usage"] === "object" && e["usage"] !== null ? (e["usage"] as Record<string, unknown>) : {};
  const tokens = { input: count(raw["input"]), output: count(raw["output"]), cached: count(raw["cache_read"]), total: count(raw["total"]) };
  const usage = Object.fromEntries(Object.entries(tokens).filter(([, v]) => v !== undefined)) as NonNullable<TurnDetail["usage"]>;
  const cost = typeof e["cost"] === "object" && e["cost"] !== null ? count((e["cost"] as Record<string, unknown>)["usd_micros"]) : undefined;
  const answered = e["confidence"] === "confirmed" || e["confidence"] === "partial";
  const identity = typeof e["identity"] === "string" ? e["identity"] : "none";

  return {
    asked: text(e["prompt"]),
    answer: text(e["text"]),
    backend: e["backend"],
    model: text(e["model"]),
    modelRequested: text(e["model_requested"]),
    when: when(e["at"]),
    content: typeof e["content"] === "string" ? e["content"] : "withheld",
    route: routeSentence({ answeredBy: answered ? e["backend"] : null, identity, durationMs: durationMs ?? null, trail: null }),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(cost === undefined ? {} : { costUsdMicros: cost }),
  };
}
