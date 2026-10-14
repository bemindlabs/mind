// S14.3, engine side (D-130): the subscriptions a phone asks for, and the one thing ever sent for them.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSubscription,
  clearSubscriptions,
  forgetAll,
  forgetEverything,
  HANDLE,
  MAX_FILE_ENTRIES,
  MAX_SUBSCRIPTIONS,
  MIN_GAP_MS,
  notifyAll,
  PUSH_DIR,
  pushDirFor,
  readSubscriptions,
  relayProblem,
  removeSubscription,
  subscriptionsFor,
  WaitingWatch,
  type Fetcher,
} from "../../src/web/push.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mind-push-"));
  scratch.push(d);
  return join(d, "push", "someone");
}
const H1 = "a".repeat(43);
const H2 = "B-_".repeat(14) + "c";
const NOW = new Date("2026-09-27T12:00:00Z");
const K1 = "1111111111111111";
const K2 = "2222222222222222";

describe("where and what", () => {
  test("one directory per subject under the state root", () => {
    expect(pushDirFor({ home: "/home/x", env: {} }, subjectId("someone"))).toBe(`/home/x/.local/state/mind/${PUSH_DIR}/someone`);
    expect(HANDLE.test(H1) && HANDLE.test(H2)).toBe(true);
    expect(HANDLE.test("a".repeat(42)) || HANDLE.test("a".repeat(44)) || HANDLE.test("a".repeat(42) + "=")).toBe(false);
  });

  test("a relay is https, or http to a loopback literal; nothing that hides a second address", () => {
    expect(relayProblem("https://push.example")).toBeUndefined();
    expect(relayProblem("https://push.example/base/")).toBeUndefined();
    expect(relayProblem("http://127.0.0.1:30750")).toBeUndefined();
    expect(relayProblem("http://[::1]:30750")).toBeUndefined();
    expect(relayProblem("http://push.example")).toBe("the relay must be https (http only to a loopback address)");
    expect(relayProblem("http://localhost:1")).toBe("the relay must be https (http only to a loopback address)");
    expect(relayProblem("ftp://push.example")).toBe("the relay must be https (http only to a loopback address)");
    expect(relayProblem("https://u:p@push.example")).toBe("the relay address carries a user name or password");
    expect(relayProblem("https://push.example/?x=1")).toBe("the relay address has a query or fragment");
    expect(relayProblem("https://push.example/#x")).toBe("the relay address has a query or fragment");
    expect(relayProblem("https://push.example/?")).toBe("the relay address has a query or fragment");
    expect(relayProblem("nope")).toBe("the relay is not a URL");
  });
});

describe("the subscriptions file", () => {
  test("added at 0600 in a 0700 directory, one per handle, the relay kept without a trailing slash", async () => {
    const d = await dir();
    expect(await addSubscription(d, "https://push.example/", H1, K1, NOW)).toEqual({ ok: true, count: 1 });
    expect(await addSubscription(d, "https://push.example", H1, K1, NOW)).toEqual({ ok: true, count: 1 });
    expect(await addSubscription(d, "https://other.example", H2, K1, NOW)).toEqual({ ok: true, count: 2 });
    expect(await readSubscriptions(d)).toEqual([
      { relay: "https://push.example", handle: H1, added: NOW.toISOString(), key: K1 },
      { relay: "https://other.example", handle: H2, added: NOW.toISOString(), key: K1 },
    ]);
    expect((await stat(join(d, "subscriptions.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(d)).mode & 0o777).toBe(0o700);
    expect(await readdir(d)).toEqual(["subscriptions.json"]);
  });

  test("refused: a bad relay, a bad handle, one phone too many", async () => {
    const d = await dir();
    expect(await addSubscription(d, "http://push.example", H1, K1, NOW)).toEqual({ ok: false, reason: "the relay must be https (http only to a loopback address)" });
    expect(await addSubscription(d, "https://push.example", "short", K1, NOW)).toEqual({ ok: false, reason: "that is not a relay handle (43 base64url characters)" });
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await addSubscription(d, "https://push.example", String(i).padStart(43, "x"), K1, NOW);
    expect(await addSubscription(d, "https://push.example", H1, K1, NOW)).toEqual({ ok: false, reason: `${MAX_SUBSCRIPTIONS} phones already get notifications — unpair one first` });
  });

  test("removed one at a time, or all at once; a missing or broken file reads as none", async () => {
    const d = await dir();
    expect(await readSubscriptions(d)).toEqual([]);
    expect(await clearSubscriptions(d, K1)).toEqual([]);
    await addSubscription(d, "https://push.example", H1, K1, NOW);
    await addSubscription(d, "https://push.example", H2, K1, NOW);
    expect((await removeSubscription(d, H1))?.handle).toBe(H1);
    expect(await removeSubscription(d, H1)).toBeUndefined();
    expect((await clearSubscriptions(d, K1)).map((s) => s.handle)).toEqual([H2]);
    expect(await readSubscriptions(d)).toEqual([]);
    await writeFile(join(d, "subscriptions.json"), "not json");
    expect(await readSubscriptions(d)).toEqual([]);
    await writeFile(join(d, "subscriptions.json"), JSON.stringify({ subscriptions: [{ relay: "http://evil.example", handle: H1, added: "x", key: K1 }, { relay: "https://ok.example", handle: "bad", added: "x", key: K1 }, { relay: "https://ok.example", handle: H1, added: "x" }, "junk"] }));
    expect(await readSubscriptions(d)).toEqual([]);
    await writeFile(join(d, "subscriptions.json"), JSON.stringify({ subscriptions: "no" }));
    expect(await readSubscriptions(d)).toEqual([]);
  });
});

describe("what is sent", () => {
  function recorder(answer: (url: string) => Response | Error) {
    const seen: { url: string; method: string; body: string | null; redirect: string | undefined }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      seen.push({ url, method: String(init.method), body: typeof init.body === "string" ? init.body : null, redirect: init.redirect });
      const out = answer(url);
      if (out instanceof Error) throw out;
      return out;
    };
    return { seen, fetcher };
  }

  test("a notice is the handle and nothing else, to /v1/notify, never following a redirect", async () => {
    const { seen, fetcher } = recorder((url) => (url.includes("down") ? new Error("refused") : new Response(null, { status: url.includes("busy") ? 429 : 202 })));
    const result = await notifyAll(
      [
        { relay: "https://push.example/base", handle: H1, added: "x", key: K1 },
        { relay: "https://down.example", handle: H2, added: "x", key: K1 },
        { relay: "https://busy.example", handle: H1, added: "x", key: K1 },
      ],
      fetcher,
    );
    expect(result).toEqual({ sent: 1, failed: 2 });
    expect(seen[0]).toEqual({ url: "https://push.example/base/v1/notify", method: "POST", body: JSON.stringify({ handle: H1 }), redirect: "error" });
    expect(seen.every((s) => s.body === null || Object.keys(JSON.parse(s.body)).join() === "handle")).toBe(true);
  });

  test("forgetting asks each relay to delete the handle, and a relay that fails does not stop the rest", async () => {
    const { seen, fetcher } = recorder((url) => (url.includes("down") ? new Error("refused") : new Response(null, { status: 204 })));
    await forgetAll([{ relay: "https://down.example", handle: H1, added: "x", key: K1 }, { relay: "https://push.example", handle: H2, added: "x", key: K1 }], fetcher);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`DELETE https://down.example/v1/devices/${H1}`, `DELETE https://push.example/v1/devices/${H2}`]);
  });
});

describe("subscriptions belong to the page key they were made under", () => {
  test("a page tells, counts and drops only its own key's phones; another key's are untouched", async () => {
    const d = await dir();
    await addSubscription(d, "https://push.example", H1, K1, NOW);
    await addSubscription(d, "https://push.example", H2, K2, NOW);
    expect((await subscriptionsFor(d, K1)).map((s) => s.handle)).toEqual([H1]);
    expect((await subscriptionsFor(d, K2)).map((s) => s.handle)).toEqual([H2]);
    const asked: string[] = [];
    const fetcher: Fetcher = async (url, init) => { asked.push(`${init.method} ${url}`); return new Response(null, { status: 204 }); };
    expect(await forgetEverything(d, K1, fetcher)).toBe(1);
    expect(asked).toEqual([`DELETE https://push.example/v1/devices/${H1}`]);
    expect((await readSubscriptions(d)).map((s) => s.handle)).toEqual([H2]);
  });

  test("the cap is per key; past the file's cap the oldest other-key entries go first", async () => {
    const d = await dir();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) await addSubscription(d, "https://push.example", String(i).padStart(43, "y"), K2, NOW);
    expect((await addSubscription(d, "https://push.example", H1, K1, NOW)).ok).toBe(true);
    const filler = MAX_FILE_ENTRIES - MAX_SUBSCRIPTIONS - 1;
    for (let i = 0; i < filler; i++) await addSubscription(d, "https://push.example", String(i).padStart(43, "o"), `${String(i % 10).repeat(15)}f`, new Date(NOW.getTime() + i));
    expect((await readSubscriptions(d)).length).toBe(MAX_FILE_ENTRIES);
    expect((await addSubscription(d, "https://push.example", H2, K1, new Date(NOW.getTime() + 999_999))).ok).toBe(true);
    const after = await readSubscriptions(d);
    expect(after.length).toBe(MAX_FILE_ENTRIES);
    expect(after.some((s) => s.handle === String(0).padStart(43, "y"))).toBe(false); // an oldest K2 entry made room
    expect(after.filter((s) => s.key === K1).map((s) => s.handle)).toEqual([H1, H2]);
  });

  test("a key print that is not one is refused", async () => {
    expect(await addSubscription(await dir(), "https://push.example", H1, "nope", NOW)).toEqual({ ok: false, reason: "not a key print" });
  });

  test("writes take turns: four at once all land", async () => {
    const d = await dir();
    const handles = ["a", "b", "c", "d"].map((c) => c.repeat(43));
    await Promise.all(handles.map((h) => addSubscription(d, "https://push.example", h, K1, NOW)));
    expect((await readSubscriptions(d)).map((s) => s.handle).sort()).toEqual(handles);
    await Promise.all([removeSubscription(d, handles[0]!), clearSubscriptions(d, K2), addSubscription(d, "https://push.example", H2, K1, NOW)]);
    expect((await readSubscriptions(d)).length).toBe(4);
  });
});

describe("forgetting everything", () => {
  test("drops every subscription, asks each relay to forget, and says how many", async () => {
    const d = await dir();
    await addSubscription(d, "https://push.example", H1, K1, NOW);
    await addSubscription(d, "https://other.example", H2, K1, NOW);
    const asked: string[] = [];
    const fetcher: Fetcher = async (url, init) => { asked.push(`${init.method} ${url}`); return new Response(null, { status: 204 }); };
    expect(await forgetEverything(d, K1, fetcher)).toBe(2);
    expect(await readSubscriptions(d)).toEqual([]);
    expect(asked.sort()).toEqual([`DELETE https://other.example/v1/devices/${H2}`, `DELETE https://push.example/v1/devices/${H1}`]);
    expect(await forgetEverything(d, K1, fetcher)).toBe(0);
  });
});

describe("when a notice is due", () => {
  test("not for what was already waiting when the page started; yes for something new", () => {
    const w = new WaitingWatch(1000);
    expect(w.due(["a", "b"], 0)).toBe(false);
    expect(w.due(["a", "b"], 10)).toBe(false);
    expect(w.due(["a", "b", "c"], 20)).toBe(true);
    w.sent(20);
    expect(w.due(["a", "b", "c"], 30)).toBe(false);
  });

  test("something new inside the gap is owed, and goes out once the gap is over — unless nothing waits by then", () => {
    const w = new WaitingWatch(1000);
    w.due([], 0);
    expect(w.due(["a"], 10)).toBe(true);
    w.sent(10);
    expect(w.due(["a", "b"], 500)).toBe(false);
    expect(w.due(["a", "b"], 1010)).toBe(true);
    w.sent(1010);
    expect(w.due(["a", "b", "c"], 1500)).toBe(false);
    expect(w.due([], 2100)).toBe(false);
    expect(w.due(["a"], 2200)).toBe(true);
  });

  test("the default gap is five minutes", () => {
    expect(MIN_GAP_MS).toBe(300_000);
  });
});
