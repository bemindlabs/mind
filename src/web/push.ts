/**
 * S14.3, engine side — telling a paired phone "something is waiting for you" (D-130).
 *
 * Off until a phone asks: the app registers itself with the platform's relay, gets a handle, and hands the
 * handle to this page (`POST /api/push/subscribe`, behind the page's key). From then on the page — only while
 * it runs — sends the relay that handle and nothing else when a new proposal is waiting. No kind of event, no
 * agent name, no text: the relay learns *when*, never *what*. Changing the page's key ("Unpair every phone")
 * drops every subscription and asks each relay to forget its handle.
 *
 * Holding a handle is the right to make that phone buzz with a content-free message, so it is kept like the
 * page's key: 0600, in the state root (never in the agent's git), one directory per subject so `erase` takes it
 * whole.
 *
 * Each subscription records which page key it was made under (`key`, a {@link keyPrint}). A page tells only the
 * phones paired with its own key, so a phone whose pairing ended because the key changed — by "Unpair every
 * phone", by a deleted key file, by a page that makes a new key at every start — is told nothing more, and a
 * second page run for the same subject (a throwaway one, say) neither tells nor drops the first page's phones.
 * Changing the key from the page drops its old key's subscriptions and asks each relay to forget them; the ones
 * left behind by a key nobody holds any more are inert here and expire at the relay (D-130, S16.6 retention).
 * Reads and writes of the file take turns within this process.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export { PUSH_DIR, pushDirFor } from "./push-dir.ts";
/** 256 random bits, base64url without padding (D-130). */
export const HANDLE = /^[A-Za-z0-9_-]{43}$/;
/** More phones than one person carries is a mistake or an attack; either way, no. Counted per page key. */
export const MAX_SUBSCRIPTIONS = 10;
/** The whole file, keys nobody holds any more included: past this the oldest of those go first. */
export const MAX_FILE_ENTRIES = 100;
/** How long a relay gets to answer before the page gives up on it for this round. */
export const RELAY_TIMEOUT_MS = 5_000;
/** A burst of proposals is one buzz, not ten: the relay limits too, this spares it the asking. */
export const MIN_GAP_MS = 5 * 60_000;

export interface PushSubscription {
  readonly relay: string;
  readonly handle: string;
  readonly added: string;
  /** The {@link keyPrint} of the page key it was made under. */
  readonly key: string;
}

const PRINT = /^[0-9a-f]{16}$/;

/** One writer at a time per directory, in this process: a read-modify-write that overlaps another loses it. */
const turns = new Map<string, Promise<unknown>>();
async function inTurn<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const before = turns.get(dir) ?? Promise.resolve();
  const mine = before.then(work, work);
  turns.set(dir, mine.catch(() => undefined));
  return mine;
}

const file = (dir: string): string => join(dir, "subscriptions.json");

/**
 * Why a relay address is not one to send to, or `undefined`. https only — the handle travels in the body — with
 * a loopback literal allowed over http for a relay run on this machine (tests, a self-hosted relay). No
 * credentials, query or fragment; a path is a base the protocol's paths go under.
 */
export function relayProblem(relay: string): string | undefined {
  let url: URL;
  try {
    url = new URL(relay);
  } catch {
    return "the relay is not a URL";
  }
  if (url.username !== "" || url.password !== "") return "the relay address carries a user name or password";
  if (url.search !== "" || url.hash !== "" || relay.includes("?") || relay.includes("#")) return "the relay address has a query or fragment";
  const loopback = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname) || url.hostname === "[::1]";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && loopback) return undefined;
  return "the relay must be https (http only to a loopback address)";
}

/** The relay's base with no trailing slash, so `${base}/v1/…` is one slash. */
const base = (relay: string): string => relay.replace(/\/+$/, "");

export async function readSubscriptions(dir: string): Promise<readonly PushSubscription[]> {
  try {
    const raw = JSON.parse(await readFile(file(dir), "utf8")) as { subscriptions?: unknown };
    if (!Array.isArray(raw.subscriptions)) return [];
    return raw.subscriptions.filter(
      (s): s is PushSubscription =>
        typeof s?.relay === "string" && relayProblem(s.relay) === undefined &&
        typeof s?.handle === "string" && HANDLE.test(s.handle) && typeof s?.added === "string" &&
        typeof s?.key === "string" && PRINT.test(s.key),
    );
  } catch {
    return [];
  }
}

async function write(dir: string, subscriptions: readonly PushSubscription[]): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = file(dir);
  const temp = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
  await writeFile(temp, `${JSON.stringify({ subscriptions }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}

export async function addSubscription(
  dir: string,
  relay: string,
  handle: string,
  key: string,
  now: Date,
): Promise<{ readonly ok: true; readonly count: number } | { readonly ok: false; readonly reason: string }> {
  const problem = relayProblem(relay);
  if (problem !== undefined) return { ok: false, reason: problem };
  if (!HANDLE.test(handle)) return { ok: false, reason: "that is not a relay handle (43 base64url characters)" };
  if (!PRINT.test(key)) return { ok: false, reason: "not a key print" };
  return inTurn(dir, async () => {
    const others = (await readSubscriptions(dir)).filter((s) => s.handle !== handle);
    const mine = others.filter((s) => s.key === key);
    if (mine.length >= MAX_SUBSCRIPTIONS) return { ok: false as const, reason: `${MAX_SUBSCRIPTIONS} phones already get notifications — unpair one first` };
    let kept = others;
    // Past the file's cap, drop the oldest subscriptions of keys this page does not hold — inert here already.
    while (kept.length >= MAX_FILE_ENTRIES) {
      const orphans = kept.filter((s) => s.key !== key).sort((a, b) => a.added.localeCompare(b.added));
      if (orphans.length === 0) break;
      kept = kept.filter((s) => s !== orphans[0]);
    }
    await write(dir, [...kept, { relay: base(relay), handle, added: now.toISOString(), key }]);
    return { ok: true as const, count: mine.length + 1 };
  });
}

/** The subscription with this handle, gone; `undefined` when there was none. */
export async function removeSubscription(dir: string, handle: string): Promise<PushSubscription | undefined> {
  return inTurn(dir, async () => {
    const current = await readSubscriptions(dir);
    const gone = current.find((s) => s.handle === handle);
    if (gone === undefined) return undefined;
    await write(dir, current.filter((s) => s.handle !== handle));
    return gone;
  });
}

/** The subscriptions made under one page key, gone — what changing that key does (S14.2 AC3). */
export async function clearSubscriptions(dir: string, key: string): Promise<readonly PushSubscription[]> {
  return inTurn(dir, async () => {
    const current = await readSubscriptions(dir);
    const gone = current.filter((s) => s.key === key);
    if (gone.length > 0) await write(dir, current.filter((s) => s.key !== key));
    return gone;
  });
}

/** The subscriptions a page holding this key tells. */
export async function subscriptionsFor(dir: string, key: string): Promise<readonly PushSubscription[]> {
  return (await readSubscriptions(dir)).filter((s) => s.key === key);
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function call(fetcher: Fetcher, url: string, init: RequestInit): Promise<boolean> {
  try {
    const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/** One content-free notice per subscription: the handle and nothing else (D-130). */
export async function notifyAll(subscriptions: readonly PushSubscription[], fetcher: Fetcher): Promise<{ readonly sent: number; readonly failed: number }> {
  const results = await Promise.all(
    subscriptions.map((s) =>
      call(fetcher, `${base(s.relay)}/v1/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: s.handle }) }),
    ),
  );
  const sent = results.filter(Boolean).length;
  return { sent, failed: results.length - sent };
}

/** Ask each relay to forget a handle. Best effort: the handle is dropped here whatever the relay says. */
export async function forgetAll(subscriptions: readonly PushSubscription[], fetcher: Fetcher): Promise<void> {
  await Promise.all(subscriptions.map((s) => call(fetcher, `${base(s.relay)}/v1/devices/${s.handle}`, { method: "DELETE" })));
}

/**
 * The subscriptions made under one page key dropped and each relay asked to forget its handle; how many there
 * were. What changing the key from the page does to the key it replaced.
 */
export async function forgetEverything(dir: string, key: string, fetcher: Fetcher): Promise<number> {
  const gone = await clearSubscriptions(dir, key);
  await forgetAll(gone, fetcher);
  return gone.length;
}

/**
 * Decides when a notice goes out: a proposal is waiting that was not at an earlier look, and the last notice
 * was long enough ago. One that arrives inside the gap is owed, and goes out when the gap is over — unless
 * nothing is waiting by then. The first look only learns what is already there: starting the page does not
 * buzz anybody's phone.
 */
export class WaitingWatch {
  private seen: ReadonlySet<string> | undefined;
  private lastSent = -Infinity;
  private owed = false;

  constructor(private readonly minGapMs: number = MIN_GAP_MS) {}

  /** True when a notice should go out now. Call `sent` once one did. */
  due(waitingIds: readonly string[], nowMs: number): boolean {
    const before = this.seen;
    this.seen = new Set(waitingIds);
    if (before === undefined) return false;
    if (waitingIds.some((id) => !before.has(id))) this.owed = true;
    if (waitingIds.length === 0) this.owed = false;
    return this.owed && nowMs - this.lastSent >= this.minGapMs;
  }

  sent(nowMs: number): void {
    this.lastSent = nowMs;
    this.owed = false;
  }
}
