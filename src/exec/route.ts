/**
 * Decides whether a turn goes to a local backend or a cloud backend, and why.
 * Recalled memory is split (D-095): a cloud backend only sees the pieces that
 * pass the privacy filter; the rest are "held" back. A turn that needs a held
 * piece and has to act (level >= 2) can only be done well by a local backend
 * with tools, since the held pieces never leave this machine — and only when it
 * runs inside the kernel fence (D-118). The owner can steer it with "local" or
 * "cloud" (S12.3 AC3); "auto" applies the rule above, and a local request falls
 * back to cloud when no local backend is installed and fenced. Each route
 * carries a one-sentence reason, printed where the turn prints its notes.
 */

export type RoutePreference = "auto" | "local" | "cloud";

export interface RouteInput {
  readonly held: number; // recalled pieces held back from a cloud backend
  readonly acting: boolean; // the turn may act (effective level >= 2)
  readonly preference: RoutePreference;
  readonly localAvailable: boolean; // a local backend with tools is installed and fenced
}

export interface Route {
  readonly prefer: "local" | "cloud";
  readonly reason: string;
}

/** What the cloud route is made of: it ends in ollama, so it is not "cloud" on a machine that has no vendor CLI. */
const USUAL_CHAIN = "the usual chain (claude, codex, then ollama)";

export const ROUTE_PREFERENCES: readonly RoutePreference[] = ["auto", "local", "cloud"];

export function parseRoutePreference(raw: string | undefined): RoutePreference | undefined {
  if (raw === undefined) return "auto";
  return (ROUTE_PREFERENCES as readonly string[]).includes(raw) ? (raw as RoutePreference) : undefined;
}

export function chooseRoute(input: RouteInput): Route {
  const { held, acting, preference, localAvailable } = input;

  if (preference === "cloud") {
    return { prefer: "cloud", reason: "You asked for cloud, so the turn goes to a cloud backend." };
  }

  if (preference === "local") {
    if (localAvailable) {
      return { prefer: "local", reason: "You asked for local, and a fenced local backend is ready." };
    }
    return {
      prefer: "cloud",
      reason: `You asked for local, but no fenced local CLI can take this turn, so ${USUAL_CHAIN} is used.`,
    };
  }

  if (held > 0 && acting) {
    if (localAvailable) {
      return {
        prefer: "local",
        reason: `${held} recalled ${held === 1 ? "piece is" : "pieces are"} held from cloud and the turn acts, so a local backend handles it.`,
      };
    }
    return {
      prefer: "cloud",
      reason:
        "The turn acts with pieces held from cloud, but no local backend may see them yet, so they stay out.",
    };
  }

  return {
    prefer: "cloud",
    reason: acting
      ? `Nothing is held back and no local CLI is needed, so ${USUAL_CHAIN} takes the turn.`
      : `Nothing is held back and the turn does not act, so ${USUAL_CHAIN} takes the turn.`,
  };
}
