import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_PREFIX, readApprovals, watchApprovals } from "../../src/task/approvals.ts";
import {
  GRANTABLE,
  MAX_LIFETIME_MS,
  appendGrantEvent,
  covering,
  giveGrant,
  grantReport,
  makeGrant,
  parseLifetime,
  readGrants,
  revokeGrant,
  type Grant,
} from "../../src/task/grants.ts";
import { createTask, taskDirIn } from "../../src/task/store.ts";
import { aTask, cleanup, SUBJECT, tempHome } from "./fixture.ts";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const release = require("../../docker/browser/release.cjs") as {
  SCHEMA: string;
  descriptorOf: (action: Record<string, unknown>) => Record<string, unknown>;
  digestOf: (action: Record<string, unknown>) => string;
};

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

const NOW = new Date("2026-10-27T10:00:00Z");
/** How a browser writes the origin of a held action (no default port) ... */
const ORIGIN = "https://shop.example.com";
/** ... and how a grant keeps it, as `--allow` does. The two must still meet. */
const GRANTED = "https://shop.example.com:443";
const PAIR = generateKeyPairSync("ed25519");
const ID = "a-11111111-2222-4333-8444-555555555555";

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    schema: "mind/grant@1",
    id: "g-00000001",
    subject: SUBJECT,
    category: "send",
    origin: GRANTED,
    task: null,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approvable: true,
    rules: ["send.words"],
    categories: ["send"],
    action: { kind: "click", origin: ORIGIN, text: "Send" },
    task: "t-0000abcd",
    ...overrides,
  } as Parameters<typeof covering>[0];
}

describe("making a grant (S22.11)", () => {
  const base = { subject: "example", category: "send", origin: ORIGIN, lifetime: "24h", now: NOW, id: "g-00000001" };

  test("a grant is made from a category, one origin and a lifetime, and expires", () => {
    const made = makeGrant(base);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.grant).toMatchObject({ category: "send", origin: GRANTED, task: null, revokedAt: null, expiresAt: "2026-10-28T10:00:00.000Z" });
  });

  test("credentials can never be granted, by name, with the reason", () => {
    const made = makeGrant({ ...base, category: "credentials" });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.reason).toContain("D-160");
    expect(GRANTABLE as readonly string[]).not.toContain("credentials");
  });

  test("how long depends on what it covers, and payment names its one task", () => {
    expect(makeGrant({ ...base, category: "send", lifetime: "7d" }).ok).toBe(true);
    expect(makeGrant({ ...base, category: "send", lifetime: "8d" }).ok).toBe(false);
    expect(makeGrant({ ...base, category: "delete", lifetime: "24h" }).ok).toBe(true);
    expect(makeGrant({ ...base, category: "delete", lifetime: "25h" }).ok).toBe(false);
    const noTask = makeGrant({ ...base, category: "payment", lifetime: "1h" });
    expect(noTask.ok).toBe(false);
    if (!noTask.ok) expect(noTask.reason).toContain("one job");
    expect(makeGrant({ ...base, category: "payment", lifetime: "1h", task: "t-0000abcd" }).ok).toBe(true);
    expect(MAX_LIFETIME_MS.payment).toBeLessThanOrEqual(MAX_LIFETIME_MS.send);
  });

  test("a bad category, origin, lifetime or task is refused with a reason", () => {
    for (const bad of [{ category: "everything" }, { origin: "not a url" }, { origin: "" }, { lifetime: "forever" }, { lifetime: "0h" }, { lifetime: "5" }, { task: "task-1" }]) {
      expect(makeGrant({ ...base, ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseLifetime("90m")).toBe(5_400_000);
    expect(parseLifetime("2d")).toBe(172_800_000);
    expect(parseLifetime("1.5h")).toBeUndefined();
  });
});

describe("which grants answer a held action", () => {
  const now = NOW.getTime();

  test("one that names its category, on its exact origin, for this bot, answers it", () => {
    const hit = covering(approval(), [grant()], SUBJECT, now);
    expect(hit.covered).toBe(true);
  });

  test("another origin, another bot, another category, an expired or a revoked grant does not", () => {
    for (const other of [
      grant({ origin: "https://shop.example.com.evil.test:443" }),
      grant({ origin: "http://shop.example.com:80" }),
      grant({ subject: "someone-else" }),
      grant({ category: "delete" }),
      grant({ expiresAt: new Date(now - 1).toISOString() }),
      grant({ revokedAt: new Date(now - 1000).toISOString() }),
    ]) {
      expect(covering(approval(), [other], SUBJECT, now).covered, JSON.stringify(other)).toBe(false);
    }
  });

  test("a grant for one task answers that task only; one for none answers any of this bot's", () => {
    expect(covering(approval(), [grant({ task: "t-0000abcd" })], SUBJECT, now).covered).toBe(true);
    expect(covering(approval(), [grant({ task: "t-99999999" })], SUBJECT, now).covered).toBe(false);
  });

  test("every category the action holds needs its own grant, or none answers it", () => {
    const both = approval({ categories: ["send", "terms"], rules: ["send.words", "terms.words"] });
    expect(covering(both, [grant()], SUBJECT, now).covered).toBe(false);
    const hit = covering(both, [grant(), grant({ id: "g-00000002", category: "terms" })], SUBJECT, now);
    expect(hit.covered).toBe(true);
    if (hit.covered) expect(hit.grants.map((g) => g.id)).toEqual(["g-00000001", "g-00000002"]);
  });

  test("a credential is never answered, however many grants exist, even one forged to name it (twin of D-160)", () => {
    const everything = GRANTABLE.map((category, i) => grant({ id: `g-0000000${i}`, category }));
    const forged = { ...grant({ id: "g-000000ff" }), category: "credentials" } as unknown as Grant;
    for (const credential of [
      approval({ approvable: false, categories: ["credentials"], rules: ["credentials.field"] }),
      approval({ categories: ["send"], rules: ["credentials.login-submit"] }),
      approval({ categories: ["send"], action: { kind: "fill", origin: ORIGIN, text: "Password", valueClass: "password" } }),
      approval({ categories: ["credentials"] }),
      approval({ categories: [] }),
    ]) {
      expect(covering(credential, [...everything, forged], SUBJECT, now).covered, JSON.stringify(credential)).toBe(false);
    }
  });
});

describe("the grant files and their record", () => {
  test("given, listed, revoked at once, and every step is in the record with no value in it", async () => {
    const box = await tempHome(scratch);
    const dir = join(box.home, "grants");
    const made = makeGrant({ subject: "example", category: "send", origin: ORIGIN, lifetime: "1h", now: NOW, id: "g-0000a001" });
    if (!made.ok) throw new Error(made.reason);
    await giveGrant(dir, made.grant, NOW);
    expect((await stat(join(dir, "g-0000a001.json"))).mode & 0o777).toBe(0o600);
    await expect(giveGrant(dir, made.grant, NOW)).rejects.toThrow("exists");
    expect((await readGrants(dir)).map((entry) => entry.grant.id)).toEqual(["g-0000a001"]);
    const revoked = await revokeGrant(dir, "g-0000a001", new Date(NOW.getTime() + 1000));
    expect(revoked.ok).toBe(true);
    expect((await readGrants(dir))[0]!.grant.revokedAt).not.toBeNull();
    expect((await revokeGrant(dir, "g-0000a001", NOW)).ok).toBe(false);
    expect((await revokeGrant(dir, "g-0000ffff", NOW)).ok).toBe(false);
    expect((await revokeGrant(dir, "../x", NOW)).ok).toBe(false);
    const record = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(record.map((e) => e["event"])).toEqual(["give", "revoke"]);
  });

  test("a file that is not a grant is left out, and the report counts uses from the record, one per held action", async () => {
    const box = await tempHome(scratch);
    const dir = join(box.home, "grants");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "g-0000b001.json"), "{not json");
    await writeFile(join(dir, "g-0000b002.json"), JSON.stringify({ schema: "other" }));
    await writeFile(join(dir, "notes.txt"), "x");
    expect(await readGrants(dir)).toEqual([]);
    await appendGrantEvent(dir, { event: "use", grant: "g-1", task: "t-0000abcd", approval: "a-1", category: "send" }, NOW);
    await appendGrantEvent(dir, { event: "use", grant: "g-2", task: "t-0000abcd", approval: "a-1", category: "terms" }, NOW);
    await appendGrantEvent(dir, { event: "use", grant: "g-1", task: "t-0000abcd", approval: "a-2", category: "send" }, NOW);
    expect(await grantReport(dir)).toMatchObject({ answered: 2, byGrant: { "g-1": 2, "g-2": 1 } });
    expect(await grantReport(join(dir, "none"))).toEqual({ answered: 0, byGrant: {}, given: 0, revoked: 0 });
    expect(await readdir(dir)).toContain("events.jsonl");
  });
});

describe("a grant answers a held action through the owner's own door (S22.11)", () => {
  async function held(at = Date.now()) {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask({ operate: 2, allow: [ORIGIN] }));
    const taskDir = taskDirIn(box.tasks, "t-0000abcd");
    const outDir = join(box.home, "data", "mind", SUBJECT, "personal", "browser", "t-0000abcd");
    await mkdir(join(outDir, "pending"), { recursive: true });
    const action = release.descriptorOf({ kind: "click", origin: ORIGIN, role: "button", text: "Send", submitsForm: true, formHasPassword: false });
    await writeFile(
      join(outDir, "pending", `${ID}.json`),
      JSON.stringify({ schema: release.SCHEMA, id: ID, action, digest: release.digestOf(action), rules: ["send.words"], categories: ["send"], reasons: ["sending"], filedAt: new Date(at).toISOString(), expiresAt: new Date(at + 60_000).toISOString() }),
    );
    return { taskDir, outDir };
  }
  const watch = (h: { taskDir: string; outDir: string }, standing: Parameters<typeof watchApprovals>[0]["standing"], more: Partial<Parameters<typeof watchApprovals>[0]> = {}) =>
    watchApprovals({ taskDir: h.taskDir, outDir: h.outDir, task: "t-0000abcd", step: 1, now: new Date(), told: new Set(), key: PAIR.privateKey, tainted: async () => undefined, ...(standing === undefined ? {} : { standing }), ...more });

  test("approved by `grant:<id>`, signed by the runner, recorded once — and with no grant it still waits for a person", async () => {
    const h = await held();
    const without = await watch(h, undefined);
    expect(without.waiting).toBe(true);
    expect(await Bun.file(join(h.outDir, "release", `${ID}.json`)).exists()).toBe(false);

    let recorded = 0;
    const seen = await watch(h, async () => ({ by: "grant:g-0000a001", record: async () => void (recorded += 1) }));
    expect(seen.waiting).toBe(false);
    expect(recorded).toBe(1);
    const [done] = await readApprovals(h.taskDir, h.outDir, "t-0000abcd", new Date());
    expect([done!.status, done!.by]).toEqual(["approved", "grant:g-0000a001"]);
    const released = JSON.parse(await readFile(join(h.outDir, "release", `${ID}.json`), "utf8")) as { verdict: string; digest: string; sig: string };
    expect(released.verdict).toBe("approve");
    expect(verify(null, Buffer.from(`${RELEASE_PREFIX}\n${ID}\n${released.digest}\napprove`), PAIR.publicKey, Buffer.from(released.sig, "base64"))).toBe(true);
    // Asked again, it is already answered: nothing more is recorded.
    await watch(h, async () => ({ by: "grant:g-0000a001", record: async () => void (recorded += 1) }));
    expect(recorded).toBe(1);
  });

  test("the owner's taint rule still applies: a grant's yes claimed while a loosened turn ran is released as no", async () => {
    const h = await held();
    await watch(h, async () => ({ by: "grant:g-0000a001", record: async () => undefined }), { tainted: async () => "turn-x (agent example, running)" });
    const released = JSON.parse(await readFile(join(h.outDir, "release", `${ID}.json`), "utf8")) as { verdict: string };
    expect(released.verdict).toBe("deny");
  });

  test("a step that has ended is never answered by a grant, and a credential is never offered to one", async () => {
    const h = await held();
    let asked = 0;
    await watch(h, async () => (asked++, undefined), { ended: true });
    expect(asked).toBe(0);
    const credential = await held();
    const action = release.descriptorOf({ kind: "fill", origin: ORIGIN, role: "textbox", text: "Password", valueClass: "password" });
    await writeFile(
      join(credential.outDir, "pending", `${ID}.json`),
      JSON.stringify({ schema: release.SCHEMA, id: ID, action, digest: release.digestOf(action), rules: ["credentials.filled-password"], categories: ["credentials"], reasons: ["password"], filedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    await watch(credential, async () => (asked++, { by: "grant:g-x", record: async () => undefined }));
    expect(asked).toBe(0);
  });
});

describe("what a grant is never read by (I-6, twin)", () => {
  test("nothing that screens or sends personal data, or files a proposal, mentions a grant", async () => {
    const root = join(import.meta.dir, "..", "..", "src");
    const offenders: string[] = [];
    for (const dir of ["exec", "egress", "consent", "decide", "ledger", "identity"]) {
      for (const name of await readdir(join(root, dir), { recursive: true })) {
        if (!String(name).endsWith(".ts")) continue;
        const text = await readFile(join(root, dir, String(name)), "utf8");
        if (/task\/grants|standing grant|grantsDir|covering\(/.test(text)) offenders.push(`${dir}/${String(name)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
