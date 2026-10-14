import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import {
  APPROVAL_SCHEMA,
  canonicalAction,
  DECISION_SCHEMA,
  decideApproval,
  describeHeld,
  fileHeld,
  heldDigest,
  HELD_SCHEMA,
  FIELDS,
  carriesValue,
  isCredential,
  NOT_ALLOWED_YET,
  STRONG_WORDS,
  readApprovals,
  readHeld,
  RELEASE_PREFIX,
  releaseSignature,
  watchApprovals,
  writeReleases,
  type HeldDescriptor,
} from "../../src/task/approvals.ts";
import { approvalsOf, pendingApprovals } from "../../src/task/screen.ts";
import { createTask, taskDirIn } from "../../src/task/store.ts";
import { aTask, cleanup, SUBJECT, tempHome } from "./fixture.ts";

// The container's half, run in Bun: the same module the image holds.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require("../../docker/browser/release.cjs") as {
  descriptorOf: (action: Record<string, unknown>) => HeldDescriptor;
  FIELDS: readonly string[];
  STRONG_WORDS: string;
  neverReleased: (descriptor: HeldDescriptor, rules: readonly string[]) => boolean;
  canonical: (d: HeldDescriptor) => string;
  digestOf: (d: HeldDescriptor) => string;
  SCHEMA: string;
  verifyRelease: (publicKey: string, id: string, digest: string, verdict: string, sig: string) => boolean;
  waitForRelease: (action: Record<string, unknown>, classification: Record<string, unknown>, settings: Record<string, unknown>, io: Record<string, unknown>) => Promise<{ verdict: string; id?: string; digest?: string }>;
};

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

/** The runner's pair: the private half signs on the host; only the public half would enter the container. */
const PAIR = generateKeyPairSync("ed25519");
const KEY: KeyObject = PAIR.privateKey;
const PUBLIC = PAIR.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const OTHER: KeyObject = generateKeyPairSync("ed25519").privateKey;
const sig = (key: KeyObject, id: string, digest: string, verdict: string) => releaseSignature(key, id, digest, verdict as "approve" | "deny");
const ACTION = { kind: "click", origin: "http://host.docker.internal:1", role: "button", text: "Delete", submitsForm: true, formHasPassword: false };
const ID = "a-11111111-2222-4333-8444-555555555555";

function heldFile(overrides: Record<string, unknown> = {}, at = Date.now()) {
  const action = release.descriptorOf(ACTION);
  return {
    schema: release.SCHEMA,
    id: ID,
    action,
    digest: release.digestOf(action),
    rules: ["delete.words"],
    categories: ["delete"],
    reasons: ["deleting something"],
    filedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 60_000).toISOString(),
    ...overrides,
  };
}

async function setup() {
  const box = await tempHome(scratch);
  await createTask(box.tasks, aTask({ operate: 2, allow: ["http://host.docker.internal:1"] }));
  const taskDir = taskDirIn(box.tasks, "t-0000abcd");
  const outDir = join(box.home, "data", "mind", SUBJECT, "personal", "browser", "t-0000abcd");
  await mkdir(join(outDir, "pending"), { recursive: true });
  const plant = (file: Record<string, unknown>, name = `${String(file["id"])}.json`) => writeFile(join(outDir, "pending", name), JSON.stringify(file));
  return { box, taskDir, outDir, plant };
}

describe("the two halves agree (D-156)", () => {
  test("the same fields name an action on both sides — its target among them (review finding 2)", () => {
    expect([...FIELDS] as string[]).toEqual([...release.FIELDS]);
    for (const field of ["path", "formAction", "formMethod", "href", "context"]) expect(release.FIELDS).toContain(field);
    const one = release.descriptorOf({ ...ACTION, formAction: "/delete?id=A", context: "Note A" });
    const swapped = release.descriptorOf({ ...ACTION, formAction: "/delete?id=B", context: "Note A" });
    expect(release.digestOf(one)).not.toBe(release.digestOf(swapped));
  });

  test("the host hashes and signs exactly as the container does", () => {
    const d = release.descriptorOf({ ...ACTION, value: "never", text: "x".repeat(400) });
    expect(Object.keys(d)).not.toContain("value");
    expect(String(d.text).length).toBe(300);
    expect(canonicalAction(d)).toBe(release.canonical(d));
    expect(heldDigest(d)).toBe(release.digestOf(d));
    // Review of PR #24, round 3: Ed25519 — the container verifies with the public key alone.
    expect(release.verifyRelease(PUBLIC, ID, "sha256:x", "approve", sig(KEY, ID, "sha256:x", "approve"))).toBe(true);
    expect(release.verifyRelease(PUBLIC, ID, "sha256:x", "deny", sig(KEY, ID, "sha256:x", "approve"))).toBe(false);
    expect(release.verifyRelease(PUBLIC, ID, "sha256:x", "approve", sig(OTHER, ID, "sha256:x", "approve"))).toBe(false);
    expect(release.verifyRelease("", ID, "sha256:x", "approve", sig(KEY, ID, "sha256:x", "approve"))).toBe(false);
    expect(release.verifyRelease(PUBLIC, ID, "sha256:x", "approve", "short")).toBe(false);
  });
});

describe("the container's wait (docker/browser/release.cjs)", () => {
  function io(answer?: (id: string, digest: string) => unknown) {
    let clock = 1_000_000;
    const files = new Map<string, string>();
    const log: unknown[] = [];
    let pendingId = "";
    let pendingDigest = "";
    return {
      files,
      log,
      io: {
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
          if (answer !== undefined && clock > 1_000_500 && !files.has(`/out/release/${pendingId}.used`)) {
            const body = answer(pendingId, pendingDigest);
            if (body !== undefined) files.set(`/out/release/${pendingId}.json`, typeof body === "string" ? body : JSON.stringify(body));
          }
        },
        write: (path: string, text: string) => {
          files.set(path, text);
          const parsed = JSON.parse(text);
          pendingId = parsed.id;
          pendingDigest = parsed.digest;
        },
        exists: (path: string) => files.has(path),
        read: (path: string) => files.get(path)!,
        rename: (from: string, to: string) => {
          files.set(to, files.get(from)!);
          files.delete(from);
        },
        log: (line: unknown) => log.push(line),
        id: () => "11111111-2222-4333-8444-555555555555",
      },
    };
  }
  const classification = { sensitive: true, rules: ["delete.words"], categories: ["delete"], reasons: ["deleting"] };
  const settings = { waitSeconds: 10, publicKey: PUBLIC };

  test("no wait or no public key: there is nobody to ask, and nothing is written", async () => {
    const box = io();
    expect((await release.waitForRelease(ACTION, classification, { waitSeconds: 0, publicKey: PUBLIC }, box.io)).verdict).toBe("no-channel");
    expect((await release.waitForRelease(ACTION, classification, { waitSeconds: 10, publicKey: "short" }, box.io)).verdict).toBe("no-channel");
    expect(box.files.size).toBe(0);
  });

  test("it writes the pending action with no value in it, and goes ahead once on a signed yes for exactly that action", async () => {
    const box = io((id, digest) => ({ id, digest, verdict: "approve", sig: sig(KEY, id, digest, "approve") }));
    const out = await release.waitForRelease({ ...ACTION, value: "secret" }, classification, settings, box.io);
    expect(out.verdict).toBe("approve");
    const pending = [...box.files.entries()].find(([p]) => p.startsWith("/out/pending/"))!;
    expect(pending[0]).toBe(`/out/pending/${ID}.json`);
    expect(pending[1]).not.toContain("secret");
    expect(box.files.has(`/out/release/${ID}.used`)).toBe(true);
    expect(box.files.has(`/out/release/${ID}.json`)).toBe(false);
    expect(box.log).toContainEqual({ id: ID, answered: "approve" });
  });

  test("a no, a yes signed with any other key, another action's digest, another id or a broken file are not a yes", async () => {
    const cases: [string, (id: string, digest: string) => unknown][] = [
      ["deny", (id, digest) => ({ id, digest, verdict: "deny", sig: sig(KEY, id, digest, "deny") })],
      ["invalid", (id, digest) => ({ id, digest, verdict: "approve", sig: sig(OTHER, id, digest, "approve") })],
      ["invalid", (id) => ({ id, digest: "sha256:other", verdict: "approve", sig: sig(KEY, id, "sha256:other", "approve") })],
      ["invalid", (id, digest) => ({ id: "a-other", digest, verdict: "approve", sig: sig(KEY, id, digest, "approve") })],
      // Round 4: a validly signed yes for another action with the same digest, replayed under this one's name.
      ["invalid", (_id, digest) => ({ id: "a-other", digest, verdict: "approve", sig: sig(KEY, "a-other", digest, "approve") })],
      ["invalid", (id, digest) => ({ id, digest, verdict: "approve", sig: "short" })],
      ["invalid", (id, digest) => ({ id, digest, verdict: "maybe", sig: sig(KEY, id, digest, "approve") })],
      ["invalid", () => "{broken"],
    ];
    for (const [verdict, answer] of cases) expect((await release.waitForRelease(ACTION, classification, settings, io(answer).io)).verdict).toBe(verdict);
  });

  test("D-160: a credential is written for every channel to show, refused at once, and never waited on", async () => {
    const box = io((id, digest) => ({ id, digest, verdict: "approve", sig: sig(KEY, id, digest, "approve") }));
    const credential = { sensitive: true, rules: ["credentials.field"], categories: ["credentials"], reasons: ["a password"] };
    const out = await release.waitForRelease({ kind: "type", origin: "http://a", role: "textbox", text: "Password", valueClass: "password" }, credential, settings, box.io);
    expect(out.verdict).toBe("not-allowed");
    const pending = JSON.parse([...box.files.entries()].find(([p]) => p.startsWith("/out/pending/"))![1]);
    expect(pending.approvable).toBe(false);
    expect(box.log).toContainEqual({ id: ID, answered: "not-allowed", rules: ["credentials.field"] });
    expect(box.files.has(`/out/release/${ID}.used`)).toBe(false);
  });

  test("no answer by the deadline (and its grace) is a no", async () => {
    const box = io();
    expect((await release.waitForRelease(ACTION, classification, settings, box.io)).verdict).toBe("expired");
    expect(box.log).toContainEqual({ id: ID, answered: "expired" });
  });
});

describe("the task's side of the channel", () => {
  const decide = (taskDir: string, outDir: string | null, over: Partial<Parameters<typeof decideApproval>[0]> = {}) =>
    decideApproval({ taskDir, task: "t-0000abcd", id: ID, verdict: "approve", by: "t", now: new Date(), outDir, openStep: null, ...over });

  test("D-160: a credential is refused, shown so, and cannot be approved — even if its file says it can", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile({ rules: ["credentials.login-submit"], categories: ["credentials"], approvable: false }));
    // A file that does not say `approvable: false`, for a password being typed: refused all the same.
    const lying = "a-77777777-2222-4333-8444-555555555555";
    const typing = release.descriptorOf({ kind: "fill", origin: "http://host.docker.internal:1", role: "textbox", text: "Login", valueClass: "password" });
    await plant({ ...heldFile({ id: lying, rules: ["credentials.value"], categories: ["credentials"] }), action: typing, digest: release.digestOf(typing) });
    const all = await readApprovals(taskDir, outDir, "t-0000abcd", new Date());
    expect(all.map((a) => [a.status, a.approvable])).toEqual([["refused", false], ["refused", false]]);
    for (const id of [ID, lying]) {
      for (const verdict of ["approve", "deny"] as const) {
        const out = await decide(taskDir, outDir, { id, verdict });
        expect(out).toMatchObject({ ok: false, kind: "not-allowed" });
        if (!out.ok) expect(out.reason).toContain(NOT_ALLOWED_YET);
      }
    }
    // D-160's strong signals only; the same rule on both sides.
    const cases: [string[], Record<string, unknown>, boolean][] = [
      [["credentials.login-submit"], { kind: "click", text: "Go" }, true],
      [["credentials.filled-password"], { kind: "click", text: "Continue" }, true],
      [["credentials.value"], { kind: "fill", text: "x", valueClass: "otp" }, true],
      [["credentials.field"], { kind: "fill", text: "Mot de passe", valueClass: "text" }, true],
      [["credentials.field"], { kind: "fill", text: "Wachtwoord" }, true],
      [["credentials.field"], { kind: "fill", text: "Shipping PIN code", valueClass: "text" }, false],
      [["credentials.grant"], { kind: "click", text: "Sign in" }, false],
      [["code.maybe"], { kind: "fill", text: "Code", valueClass: "text" }, false],
      [["delete.words"], { kind: "click", text: "Delete" }, false],
    ];
    for (const [rules, action, never] of cases) {
      expect(isCredential({ rules, action: action as HeldDescriptor }), JSON.stringify(action)).toBe(never);
      expect(release.neverReleased(action as HeldDescriptor, rules), JSON.stringify(action)).toBe(never);
    }
    expect(STRONG_WORDS).toBe(release.STRONG_WORDS);
    const seen = await watchApprovals({ taskDir, outDir, task: "t-0000abcd", step: 1, now: new Date(), told: new Set(), key: KEY, tainted: async () => undefined });
    expect(seen.waiting).toBe(false);
    expect(seen.notes[0]).toContain("D-160");
    expect(await Bun.file(join(outDir, "release", `${ID}.json`)).exists()).toBe(false);
  });

  test("only well-formed held actions whose digest is their action's are offered", async () => {
    const { outDir, plant } = await setup();
    await plant(heldFile());
    await plant(heldFile({ id: "a-22222222-2222-4333-8444-555555555555", digest: "sha256:forged" }));
    await plant(heldFile({ id: "a-33333333-2222-4333-8444-555555555555", action: { ...release.descriptorOf(ACTION), value: "x" } }));
    await plant(heldFile({ id: "../../x" }), "x.json");
    await plant(heldFile({ id: "a-44444444-2222-4333-8444-555555555555" }), "misnamed.json");
    await plant(heldFile({ id: "a-55555555-2222-4333-8444-555555555555", expiresAt: "never" }));
    await writeFile(join(outDir, "pending", "broken.json"), "{");
    expect((await readHeld(outDir)).map((h) => h.id)).toEqual([ID]);
    expect(await readHeld(join(outDir, "nowhere"))).toEqual([]);
  });

  test("filed once into the task's store, with its step; pending until answered or past its deadline", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    expect((await fileHeld(taskDir, outDir, "t-0000abcd", 2)).map((h) => h.id)).toEqual([ID]);
    expect(await fileHeld(taskDir, outDir, "t-0000abcd", 2)).toEqual([]);
    const [approval] = await readApprovals(taskDir, outDir, "t-0000abcd", new Date());
    expect([approval!.status, approval!.step]).toEqual(["pending", 2]);
    expect((await readApprovals(taskDir, null, "t-0000abcd", new Date(Date.now() + 120_000)))[0]!.status).toBe("expired");
    expect(describeHeld(approval!)).toBe('click "Delete" on http://host.docker.internal:1');
    expect(describeHeld({ action: { kind: "dialog-submit" } })).toBe("accept a dialog");
    expect(describeHeld({ action: { kind: "dialog-type", text: "" } })).toBe("answer a dialog");
    expect(describeHeld({ action: { kind: "click", text: "Go", origin: "http://a", path: "/p?q=1#h", frameOrigin: "http://f", framePath: "/in" } })).toBe('click "Go" on http://a/p?q=1#h (in a frame from http://f/in)');
  });

  test("an answer is only a claim — once; the runner, holding the key, writes the signed release", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    const [first, second] = await Promise.all([decide(taskDir, outDir, { verdict: "approve" }), decide(taskDir, outDir, { verdict: "deny" })]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const winner = first.ok ? "approve" : "deny";
    // Nothing is released by the answer itself.
    expect(await Bun.file(join(outDir, "release", `${ID}.json`)).exists()).toBe(false);
    await fileHeld(taskDir, outDir, "t-0000abcd", 1);
    expect(await writeReleases({ taskDir, outDir, task: "t-0000abcd", key: KEY, now: new Date(), openStep: 1, tainted: async () => undefined })).toEqual([ID]);
    const written = JSON.parse(await readFile(join(outDir, "release", `${ID}.json`), "utf8"));
    expect(written).toEqual({ id: ID, digest: heldFile().digest, verdict: winner, sig: sig(KEY, ID, heldFile().digest, winner) });
    // Written once: not again, and not after the container took it (`.used`).
    expect(await writeReleases({ taskDir, outDir, task: "t-0000abcd", key: KEY, now: new Date(), openStep: 1, tainted: async () => undefined })).toEqual([]);
    await rename(join(outDir, "release", `${ID}.json`), join(outDir, "release", `${ID}.used`));
    expect(await writeReleases({ taskDir, outDir, task: "t-0000abcd", key: KEY, now: new Date(), openStep: 1, tainted: async () => undefined })).toEqual([]);
    expect(await decide(taskDir, outDir, { verdict: "approve" })).toMatchObject({ ok: false, kind: "decided" });
    expect((await readApprovals(taskDir, outDir, "t-0000abcd", new Date()))[0]!.status).toBe(winner === "approve" ? "approved" : "denied");
  });

  test("refused: a bad id, an unknown one, one past its deadline, one whose step has ended", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    expect(await decide(taskDir, outDir, { id: "../x" })).toMatchObject({ ok: false, kind: "missing" });
    expect(await decide(taskDir, outDir, { id: "a-99999999-2222-4333-8444-555555555555" })).toMatchObject({ ok: false, kind: "missing" });
    expect(await decide(taskDir, outDir, { now: new Date(Date.now() + 120_000) })).toMatchObject({ ok: false, kind: "expired" });
    expect(await decide(taskDir, null)).toMatchObject({ ok: false, kind: "missing" });
    await fileHeld(taskDir, outDir, "t-0000abcd", 1);
    const ended = await decide(taskDir, outDir, { openStep: 2 });
    expect(ended).toMatchObject({ ok: false, kind: "expired" });
    if (!ended.ok) expect(ended.reason).toContain("step 1, which has ended");
    expect(await decide(taskDir, outDir, { openStep: null })).toMatchObject({ ok: false, kind: "expired" });
    expect((await decide(taskDir, outDir, { openStep: 1 })).ok).toBe(true);
  });

  test("the runner's watch: waiting while pending, the wait off the clock, each no said once, released by the runner, expiry and a step's end released as no", async () => {
    const { taskDir, outDir, plant } = await setup();
    const at = Date.now();
    await plant(heldFile({}, at));
    const told = new Set<string>();
    const watch = (now: number, step = 3, ended = false) => watchApprovals({ taskDir, outDir, task: "t-0000abcd", step, now: new Date(now), told, key: KEY, ended, tainted: async () => undefined });
    expect(await watch(at + 10_000)).toEqual({ waiting: true, waitedMs: 10_000, notes: [], stop: false });
    await decide(taskDir, outDir, { verdict: "deny", now: new Date(at + 20_000), stop: true, openStep: 3 });
    const denied = await watch(at + 30_000);
    expect(denied.waiting).toBe(false);
    expect(denied.waitedMs).toBe(20_000);
    expect(denied.notes[0]).toContain("The owner said no to: click");
    expect(denied.stop).toBe(true);
    expect(JSON.parse(await readFile(join(outDir, "release", `${ID}.json`), "utf8")).verdict).toBe("deny");
    expect((await watch(at + 31_000)).notes).toEqual([]);
    expect((await watch(at + 31_000, 4)).waitedMs).toBe(0);

    const late = "a-66666666-2222-4333-8444-555555555555";
    await plant(heldFile({ id: late }, at));
    const expired = await watch(at + 90_000, 3);
    expect(expired.notes.join(" ")).toContain("Nobody answered in time");
    expect(JSON.parse(await readFile(join(outDir, "release", `${late}.json`), "utf8")).verdict).toBe("deny");

    // A step that ends with an action still waiting: expired at once, released as no.
    const left = "a-99999999-2222-4333-8444-555555555555";
    await plant(heldFile({ id: left }, at + 100_000));
    const over = await watch(at + 101_000, 5, true);
    expect(over.waiting).toBe(false);
    const after = await readApprovals(taskDir, outDir, "t-0000abcd", new Date(at + 101_000));
    expect(after.find((a) => a.id === left)!.status).toBe("expired");
    expect(after.find((a) => a.id === left)!.by).toBe("its step ended first");
    const leftRelease = JSON.parse(await readFile(join(outDir, "release", `${left}.json`), "utf8"));
    expect(leftRelease.verdict).toBe("deny");
    expect(release.verifyRelease(PUBLIC, left, heldFile().digest, "deny", leftRelease.sig)).toBe(true);
  });

  test("D-159: a confirm is paired with the action the container recorded it followed — not by the clock", async () => {
    const { taskDir, outDir, plant } = await setup();
    const at = Date.now();
    await plant(heldFile({}, at));
    const dialogId = "a-88888888-2222-4333-8444-555555555555";
    const dialog = release.descriptorOf({ kind: "dialog-submit", origin: "http://host.docker.internal:1", path: "/note", role: "button", text: "Delete this note?" });
    await plant({ ...heldFile({ id: dialogId }, at + 2000), action: dialog, digest: release.digestOf(dialog), follows: ID });
    const unpaired = "a-77777777-2222-4333-8444-555555555555";
    await plant({ ...heldFile({ id: unpaired }, at + 3000), action: dialog, digest: release.digestOf(dialog) });
    // Filed into the task's store (as the runner does), the pair is kept.
    await fileHeld(taskDir, outDir, "t-0000abcd", 1);
    const all = await readApprovals(taskDir, outDir, "t-0000abcd", new Date(at + 3000));
    expect(all.find((a) => a.id === dialogId)!.follows).toEqual({ id: ID, action: heldFile().action });
    expect(all.find((a) => a.id === unpaired)!.follows).toBeNull();
    expect(all.find((a) => a.id === ID)!.follows).toBeNull();
    expect(describeHeld({ action: { kind: "click", text: "Delete", formAction: "/delete?id=B", formMethod: "post", context: "Note B", href: "/x" } })).toBe('click "Delete" → POST /delete?id=B → /x (in: "Note B")');
    expect([carriesValue({ kind: "fill" }), carriesValue({ kind: "press", valueClass: "text" }), carriesValue({ kind: "press" }), carriesValue({ kind: "click" })]).toEqual([true, true, false, false]);
  });

  test("the views: a task's approvals, and what waits across tasks", async () => {
    const { box, plant } = await setup();
    await plant(heldFile());
    const env = { home: box.home, env: box.env };
    expect((await pendingApprovals(env, SUBJECT, new Date())).map((a) => [a.id, a.goal])).toEqual([[ID, "find the answer"]]);
    expect(await approvalsOf(env, box.tasks, aTask({ operate: 1 }), new Date())).toEqual([]);
    expect(await pendingApprovals({ home: box.home, env: { XDG_DATA_HOME: join(box.home, "none") } }, SUBJECT, new Date())).toEqual([]);
  });
});

describe("an erased task stays erased", () => {
  test("filing what the container holds never makes the task's directory again", async () => {
    const { rm } = await import("node:fs/promises");
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    await rm(taskDir, { recursive: true });
    await expect(fileHeld(taskDir, outDir, "t-0000abcd", 1)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Bun.file(join(taskDir, "approvals")).exists()).toBe(false);
  });
});

describe("the owner's answer, from a terminal or the page (answerHeld)", () => {
  async function answering(record: Partial<import("../../src/task/store.ts").TaskRecord> = {}) {
    const { answerHeld, answerCode } = await import("../../src/task/answer.ts");
    const { BROWSER_SCHEMA } = await import("../../src/browser/store.ts");
    const { recordPath } = await import("../../src/browser/paths.ts");
    const { writeTask } = await import("../../src/task/store.ts");
    const ctx = await setup();
    await writeTask(ctx.box.tasks, aTask({ operate: 2, allow: ["http://host.docker.internal:1"], status: "waiting", ...record }));
    await ctx.plant(heldFile());
    await fileHeld(ctx.taskDir, ctx.outDir, "t-0000abcd", 1);
    const env = { home: ctx.box.home, env: ctx.box.env };
    await mkdir(join(ctx.box.home, "state", "mind", "browser", SUBJECT), { recursive: true });
    await writeFile(recordPath(env, SUBJECT, "t-0000abcd"), JSON.stringify({ schema: BROWSER_SCHEMA, task: "t-0000abcd", subject: SUBJECT, container: "c", image: "i", port: 30_745, token: "ab".repeat(32), allowed: [], operate: 2, outDir: ctx.outDir, owner: null, startedAt: new Date().toISOString(), ttlSeconds: 600, approvalWaitSeconds: 600 }));
    const base = { env, tasks: ctx.box.tasks, subject: SUBJECT, by: "t", now: new Date(), from: "web" as const, parent: () => null };
    return { ...ctx, env, base, answerHeld, answerCode };
  }
  const OPEN = { steps: [{ n: 1, kind: "step" as const, startedAt: "a", finishedAt: null, turnId: null, backend: null, exit: null, outcome: null, summary: "", done: false, tokens: null, ms: null, waitedMs: 0 }] };

  test("found through the task; a no with stop asks the task to stop; codes per outcome", async () => {
    const { base, answerHeld, answerCode, taskDir } = await answering(OPEN);
    const missingTask = await answerHeld({ ...base, task: "t-11111111", approval: ID, verdict: "approve", stop: false });
    expect([missingTask.ok, answerCode(missingTask)]).toEqual([false, { exit: 2, status: 404 }]);
    const no = await answerHeld({ ...base, task: "t-0000abcd", approval: ID, verdict: "deny", stop: true });
    expect([no.ok, answerCode(no)]).toEqual([true, { exit: 0, status: 200 }]);
    expect(await Bun.file(join(taskDir, "stop")).exists()).toBe(true);
    const again = await answerHeld({ ...base, task: "t-0000abcd", approval: ID, verdict: "approve", stop: false });
    expect(answerCode(again)).toEqual({ exit: 5, status: 409 });
  });

  test("refused: an ended task, a step that has moved on, a browser that is gone", async () => {
    const ended = await answering({ ...OPEN, status: "done" });
    expect(await ended.answerHeld({ ...ended.base, task: "t-0000abcd", approval: ID, verdict: "approve", stop: false })).toMatchObject({ ok: false, kind: "ended" });
    const moved = await answering({ steps: [{ ...OPEN.steps[0]!, n: 2 }] });
    expect(await moved.answerHeld({ ...moved.base, task: "t-0000abcd", approval: ID, verdict: "approve", stop: false })).toMatchObject({ ok: false, kind: "expired" });
    const gone = await answering(OPEN);
    const { rm } = await import("node:fs/promises");
    await rm(join(gone.box.home, "state", "mind", "browser"), { recursive: true });
    expect(await gone.answerHeld({ ...gone.base, task: "t-0000abcd", approval: ID, verdict: "approve", stop: false })).toMatchObject({ ok: false, kind: "no-browser" });
  });

  test("review of PR #24, finding 2: nothing is answered while a loosened turn of the agent runs, nor from below a turn or a runner", async () => {
    const { describeRun, writeRunRecord } = await import("../../src/decide/runs.ts");
    const { agentAncestor, ancestors, parentOf, loosenedTurn } = await import("../../src/task/answer.ts");
    const ctx = await answering(OPEN);
    const stat = (pid: number) => ({ startTicks: pid });
    // A loosened turn of this subject is running: no answer, from the page or the terminal.
    await writeRunRecord(ctx.env, { ...describeRun({ turnId: "chat-1", subject: SUBJECT, backends: ["claude"], at: new Date(), loosened: true }), pid: 4242, pidStart: 4242 });
    const busy = await ctx.answerHeld({ ...ctx.base, stat, task: "t-0000abcd", approval: ID, verdict: "approve", stop: false });
    expect(busy).toMatchObject({ ok: false, kind: "agent" });
    expect(ctx.answerCode(busy)).toEqual({ exit: 4, status: 403 });
    expect(await loosenedTurn(ctx.env, () => null)).toBeUndefined();
    // A restrained turn (a task's step) does not block it — but a terminal answer from below it is refused.
    const quiet = await answering(OPEN);
    await writeRunRecord(quiet.env, { ...describeRun({ turnId: "step-1", subject: SUBJECT, backends: ["claude-local"], at: new Date(), loosened: false }), pid: 5151, pidStart: 5151 });
    const parents: Record<number, number> = { 9000: 8000, 8000: 5151, 5151: 1 };
    const below = await quiet.answerHeld({ ...quiet.base, from: "terminal", stat, parent: (pid) => parents[pid === process.pid ? 9000 : pid] ?? null, task: "t-0000abcd", approval: ID, verdict: "approve", stop: false });
    expect(below).toMatchObject({ ok: false, kind: "agent" });
    if (!below.ok) expect(below.reason).toContain("turn step-1");
    // A task's runner above is refused too.
    const { writeTask } = await import("../../src/task/store.ts");
    await writeTask(quiet.box.tasks, aTask({ operate: 2, allow: ["http://host.docker.internal:1"], status: "waiting", runner: { pid: 7070, start: 7070, since: "x" }, ...OPEN }));
    expect(await agentAncestor(quiet.env, quiet.box.tasks, SUBJECT, { pid: 9000, parent: (pid) => ({ 9000: 7070, 7070: 1 })[pid] ?? null, stat })).toBe("task t-0000abcd's runner");
    // The same answer from a terminal with no turn above goes through.
    expect((await quiet.answerHeld({ ...quiet.base, from: "terminal", stat, task: "t-0000abcd", approval: ID, verdict: "approve", stop: false })).ok).toBe(true);
    expect(ancestors(10, (pid) => (pid > 2 ? pid - 1 : null))).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    expect(parentOf(process.pid)).toBe(process.ppid);
    expect(parentOf(1, () => "1 (init) S 0 1")).toBeNull();
    expect(parentOf(5, () => { throw new Error("gone"); })).toBeNull();
  });
});

describe("the runner checks a yes again before it signs it (review of PR #24, round 2)", () => {
  test("round 3: a yes claimed while a loosened turn ran is released as a signed no — and never signed after the turn ends", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    await fileHeld(taskDir, outDir, "t-0000abcd", 1);
    // A claim written straight into the store — as a turn with a shell could — while that turn runs.
    await mkdir(join(taskDir, "approvals", "decided"), { recursive: true });
    await writeFile(join(taskDir, "approvals", "decided", `${ID}.json`), JSON.stringify({ id: ID, verdict: "approve", at: new Date().toISOString(), by: "a turn", stop: "0" }));
    let busy: string | undefined = "chat-1 (agent other-one)";
    const asked: number[] = [];
    const release = () => writeReleases({ taskDir, outDir, task: "t-0000abcd", key: KEY, now: new Date(), openStep: 1, tainted: async (at) => (asked.push(at), busy) });
    expect(await release()).toEqual([ID]);
    const first = JSON.parse(await readFile(join(outDir, "release", `${ID}.json`), "utf8"));
    expect(first.verdict).toBe("deny");
    expect(asked[0]).toBeGreaterThan(Date.now() - 60_000);
    // Every channel says why.
    const shown = (await readApprovals(taskDir, outDir, "t-0000abcd", new Date())).find((a) => a.id === ID)!;
    expect(shown.by).toContain("claimed while a turn that can run commands was running");
    // The turn ends; the container used the no; the claim is still there — and is never signed.
    busy = undefined;
    await rename(join(outDir, "release", `${ID}.json`), join(outDir, "release", `${ID}.used`));
    expect(await release()).toEqual([]);
    expect(await Bun.file(join(outDir, "release", `${ID}.json`)).exists()).toBe(false);
  });

  test("a yes for a step that is not running is released as no", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    await fileHeld(taskDir, outDir, "t-0000abcd", 1);
    await decideApproval({ taskDir, task: "t-0000abcd", id: ID, verdict: "approve", by: "t", now: new Date(), outDir, openStep: 1 });
    expect(await writeReleases({ taskDir, outDir, task: "t-0000abcd", key: KEY, now: new Date(), openStep: 2, tainted: async () => undefined })).toEqual([ID]);
    expect(JSON.parse(await readFile(join(outDir, "release", `${ID}.json`), "utf8")).verdict).toBe("deny");
  });

  test("taintedAt: a loosened turn running, killed without a note, or noted as ended after the claim", async () => {
    const { describeRun, writeRunRecord, noteEnded } = await import("../../src/decide/runs.ts");
    const { taintedAt, TAINT_GRACE_MS } = await import("../../src/task/answer.ts");
    const { subjectId } = await import("../../src/types.ts");
    const { box } = await setup();
    const env = { home: box.home, env: box.env };
    const started = new Date(Date.now() - 60_000);
    const live = (pid: number) => ({ startTicks: pid });
    const dead = () => null;
    expect(await taintedAt(env, Date.now(), live)).toBeUndefined();
    const record = { ...describeRun({ turnId: "chat-7", subject: subjectId("other-one"), backends: ["claude"], at: started, loosened: true }), pid: 4242, pidStart: 4242 };
    const path = await writeRunRecord(env, record);
    expect(await taintedAt(env, Date.now(), live)).toBe("chat-7 (agent other-one)");
    // Gone without a note (killed): from its start on, whenever that was.
    expect(await taintedAt(env, Date.now(), dead)).toContain("stopped without a note");
    expect(await taintedAt(env, started.getTime() - 1, dead)).toBeUndefined();
    // Ended and noted: a claim made during it (or within the grace after) is tainted, one made later is not.
    const { rm } = await import("node:fs/promises");
    await rm(path);
    const ended = new Date(started.getTime() + 30_000);
    await noteEnded(env, record, ended);
    expect(await taintedAt(env, started.getTime() + 10_000, dead)).toContain("chat-7 (agent other-one, ended");
    expect(await taintedAt(env, ended.getTime() + TAINT_GRACE_MS, dead)).toContain("chat-7");
    expect(await taintedAt(env, ended.getTime() + TAINT_GRACE_MS + 1, dead)).toBeUndefined();
    expect(await taintedAt(env, started.getTime() - 1, dead)).toBeUndefined();
  });

  test("with no loosened turn and the step running, the yes is signed", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    await fileHeld(taskDir, outDir, "t-0000abcd", 3);
    await decideApproval({ taskDir, task: "t-0000abcd", id: ID, verdict: "approve", by: "t", now: new Date(), outDir, openStep: 3 });
    expect(await writeReleases({ taskDir, outDir, task: "t-0000abcd", key: KEY, now: new Date(), openStep: 3, tainted: async () => undefined })).toEqual([ID]);
    expect(JSON.parse(await readFile(join(outDir, "release", `${ID}.json`), "utf8")).verdict).toBe("approve");
  });

  test("a loosened turn of any agent counts; what waits is seen across every agent", async () => {
    const { describeRun, writeRunRecord } = await import("../../src/decide/runs.ts");
    const { loosenedTurn } = await import("../../src/task/answer.ts");
    const { pendingAnywhere } = await import("../../src/task/screen.ts");
    const { subjectId } = await import("../../src/types.ts");
    const { box, plant } = await setup();
    const env = { home: box.home, env: box.env };
    await plant(heldFile());
    expect((await pendingAnywhere(env, new Date())).map((a) => [a.subject, a.id])).toEqual([[SUBJECT, ID]]);
    expect(await pendingAnywhere({ home: box.home, env: { XDG_DATA_HOME: join(box.home, "none") } }, new Date())).toEqual([]);
    await writeRunRecord(env, { ...describeRun({ turnId: "chat-9", subject: subjectId("other-one"), backends: ["claude"], at: new Date(), loosened: true }), pid: 4242, pidStart: 4242 });
    expect(await loosenedTurn(env, (pid) => ({ startTicks: pid }))).toBe("chat-9 (agent other-one)");
  });
});

describe("the release is signed over the mind-release prefix", () => {
  const DIGEST = "sha256:x";
  const over = (prefix: string, id: string, digest: string, verdict: string) => Buffer.from(`${prefix}\n${id}\n${digest}\n${verdict}`);
  const verifiesOver = (prefix: string, id: string, digest: string, verdict: string, signature: string) =>
    verify(null, over(prefix, id, digest, verdict), PAIR.publicKey, Buffer.from(signature, "base64"));

  test("releaseSignature signs the mind-release prefix, and no other", () => {
    expect(RELEASE_PREFIX).toBe("mind-release");
    const signature = releaseSignature(KEY, ID, DIGEST, "approve");
    expect(verifiesOver(RELEASE_PREFIX, ID, DIGEST, "approve", signature)).toBe(true);
    expect(verifiesOver("other-release", ID, DIGEST, "approve", signature)).toBe(false);
  });

  test("the container of this tree verifies the prefix the host signs, and only that one", () => {
    expect(release.SCHEMA).toBe(HELD_SCHEMA);
    const accepted = [RELEASE_PREFIX, "other-release"].filter((prefix) =>
      release.verifyRelease(PUBLIC, ID, DIGEST, "approve", sign(null, over(prefix, ID, DIGEST, "approve"), KEY).toString("base64")),
    );
    expect(accepted).toEqual([RELEASE_PREFIX]);
  });

  test("a pending file is released with the signature its image verifies", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile({ schema: HELD_SCHEMA }));
    await fileHeld(taskDir, outDir, "t-0000abcd", 1);
    const answered = await decideApproval({ taskDir, task: "t-0000abcd", id: ID, verdict: "approve", by: "t", now: new Date(), outDir, openStep: 1 });
    expect(answered.ok).toBe(true);
    expect(await writeReleases({ taskDir, outDir, task: "t-0000abcd", key: KEY, now: new Date(), openStep: 1, tainted: async () => undefined })).toEqual([ID]);
    const written = JSON.parse(await readFile(join(outDir, "release", `${ID}.json`), "utf8")) as { verdict: string; digest: string; sig: string };
    expect(written.verdict).toBe("approve");
    expect(verifiesOver(RELEASE_PREFIX, ID, written.digest, "approve", written.sig)).toBe(true);
  });
});

describe("the ids written now", () => {
  test("a filed approval is written under the current id", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    await fileHeld(taskDir, outDir, "t-0000abcd", 2);
    const written = JSON.parse(await readFile(join(taskDir, "approvals", `${ID}.json`), "utf8")) as Record<string, unknown>;
    expect(written["schema"]).toBe(APPROVAL_SCHEMA);
    expect(await readApprovals(taskDir, null, "t-0000abcd", new Date())).toHaveLength(1);
  });

  test("a claim is written under the current id and reads as the answer", async () => {
    const { taskDir, outDir, plant } = await setup();
    await plant(heldFile());
    await fileHeld(taskDir, outDir, "t-0000abcd", 1);
    const answered = await decideApproval({ taskDir, task: "t-0000abcd", id: ID, verdict: "approve", by: "t", now: new Date(), outDir, openStep: 1 });
    expect(answered.ok).toBe(true);
    const written = JSON.parse(await readFile(join(taskDir, "approvals", "decided", `${ID}.json`), "utf8")) as Record<string, unknown>;
    expect(written["schema"]).toBe(DECISION_SCHEMA);
    const status = (await readApprovals(taskDir, outDir, "t-0000abcd", new Date())).map((a) => [a.id, a.status, a.by]);
    expect(status).toEqual([[ID, "approved", "t"]]);
  });

  test("a pending file is offered, and its digest is still the check", async () => {
    const { outDir, plant } = await setup();
    await plant(heldFile({ schema: HELD_SCHEMA }));
    await plant(heldFile({ schema: HELD_SCHEMA, id: "a-22222222-2222-4333-8444-555555555555" }));
    await plant(heldFile({ schema: HELD_SCHEMA, id: "a-33333333-2222-4333-8444-555555555555", digest: "sha256:forged" }));
    expect((await readHeld(outDir)).map((h) => h.id).sort()).toEqual([ID, "a-22222222-2222-4333-8444-555555555555"]);
  });
});
