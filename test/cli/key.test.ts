/**
 * `mind key`, `mind key prove|verify-proof`, `mind usage report|verify`, and the card that carries
 * the key — through the real CLI (S15.8, S15.4 step one, D-106, D-108, D-138, D-141).
 *
 * The claims worth spawning for are about bytes on a disk and on a terminal: the private key is written once,
 * 600, outside the agent's repository, and appears on no stream and in no report; a report holds nothing
 * that was said; a card is printed without a key being made; erase takes the key.
 *
 * Every run has its own HOME and XDG roots, a PATH of `bun` and `git` only, and a Qdrant URL nothing
 * listens on. Nothing here reaches this machine's state, keys or vector store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { KEY_PROOF_KIND } from "../../src/identity/proof.ts";
import { usagePayload, USAGE_REPORT_KIND } from "../../src/identity/report.ts";
import { DEFAULT_PRICES, shippedTable } from "../../src/pricing/table.ts";
import { signEnvelope, verifyEnvelope } from "../../src/identity/sign.ts";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";
import { GIT_ENV, REAL_GIT } from "../support/trap-git.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SUBJECT = "example";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Box {
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
  readonly keyDir: string;
  readonly keyFile: string;
}

async function box(): Promise<Box> {
  const home = await mkdtemp(join(tmpdir(), "mind-key-cli-"));
  scratch.push(home);
  const path = await barePath(home);
  await symlink(REAL_GIT, join(path, "git")).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  expectNoVendorOn(path);
  const keyDir = join(home, "data", "mind", SUBJECT, "identity");
  return {
    home,
    keyDir,
    keyFile: join(keyDir, "ed25519.pem"),
    env: {
      HOME: home,
      PATH: path,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      MIND_QDRANT_URL: "http://127.0.0.1:9",
      USER: "the-test",
      ...GIT_ENV,
    },
  };
}

async function run(b: Box, args: readonly string[], stdin?: string) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: b.home,
    env: b.env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** The base64 lines of the private key — what must appear nowhere but the key file. */
async function pemBody(b: Box): Promise<string[]> {
  return (await readFile(b.keyFile, "utf8")).split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
}

/** Regular files under `root` whose bytes hold `needle`. */
async function grepTree(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (await Bun.file(path).text()).includes(needle)) hits.push(path);
    }
  };
  await walk(root);
  return hits;
}

const cardKey = (stdout: string) =>
  (JSON.parse(stdout) as { capabilities: { extensions: { params: { publicKey: string | null } }[] } }).capabilities.extensions[0]!.params.publicKey;

/** Ledger lines as a turn and an A2A message leave them, with a canary in every text field. */
async function seedLedger(b: Box): Promise<void> {
  const dir = join(b.home, "state", "mind", "ledger", SUBJECT);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const base = { v: 1, kind: "turn", subject: SUBJECT, confidence: "confirmed", exit: 0, cost: null, identity: "system", soul_sha: "CANARY-SHA" };
  const lines = [
    { ...base, id: "a1", turn: "t1", at: "2026-09-20T10:00:00.000Z", backend: "claude", model: "opus", content: "full", prompt: "CANARY-PROMPT", prompt_bytes: 13, text: "CANARY-ANSWER", text_bytes: 13, duration_ms: 1200, usage: { status: "reported", input: 108921, output: 2624, total: null } },
    { ...base, id: "a2", turn: "t2", at: "2026-09-21T10:00:00.000Z", backend: "ollama", model: null, content: "full", prompt: "CANARY-OLD", prompt_bytes: 10, text: "x", text_bytes: 1, duration_ms: 300 },
    { ...base, id: "a3", turn: "t3", at: "2026-09-22T10:00:00.000Z", backend: "a2a:in:CANARY-PEER", model: null, content: "full", prompt: "CANARY-MESSAGE", prompt_bytes: 14, text: null, text_bytes: 0, duration_ms: null },
  ];
  await writeFile(join(dir, "2026-09.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
}

describe("mind key", () => {
  test("made once, 600 in 700, the same public key every time after — and the private key on no stream", async () => {
    const b = await box();
    const first = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("made just now");
    expect((await stat(b.keyDir)).mode & 0o777).toBe(0o700);
    expect((await stat(b.keyFile)).mode & 0o777).toBe(0o600);
    const publicKey = /public key\s+(\S+)/.exec(first.stdout)![1]!;
    const bytes = await readFile(b.keyFile);

    const second = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain("already made; nothing was changed");
    expect(/public key\s+(\S+)/.exec(second.stdout)![1]).toBe(publicKey);
    expect(await readFile(b.keyFile)).toEqual(bytes);

    for (const line of await pemBody(b)) {
      for (const stream of [first.stdout, first.stderr, second.stdout, second.stderr]) expect(stream).not.toContain(line);
    }
  }, 30_000);

  test("a soul that does not load, a missing subject, and a key others can read are all refused", async () => {
    const b = await box();
    expect((await run(b, ["key", SOUL])).code).toBe(2);
    expect((await run(b, ["key", join(b.home, "nowhere"), "--subject", SUBJECT])).code).toBe(1);
    expect(await Bun.file(b.keyFile).exists()).toBe(false);

    expect((await run(b, ["key", SOUL, "--subject", SUBJECT])).code).toBe(0);
    await chmod(b.keyFile, 0o644);
    const loose = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    expect(loose.code).toBe(1);
    expect(loose.stderr).toContain(`chmod 600 ${b.keyFile}`);
    const report = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    expect(report.code).toBe(1);
    expect(report.stdout).toBe("");
    // The card is still printed, and says there is no usable key; the reason goes to stderr.
    const card = await run(b, ["soul", "card", SOUL, "--subject", SUBJECT]);
    expect(card.code).toBe(0);
    expect(cardKey(card.stdout)).toBeNull();
    expect(card.stderr).toContain("chmod 600");
  }, 30_000);

  test("the key is not in the agent's repository, and erase takes it", async () => {
    const b = await box();
    const parent = await mkdtemp(join(tmpdir(), "mind-key-cli-agents-"));
    scratch.push(parent);
    expect((await run(b, ["new", SUBJECT, "--subject", SUBJECT, "--dir", parent])).code).toBe(0);
    const agent = join(parent, SUBJECT);
    const made = await run(b, ["key", agent, "--subject", SUBJECT]);
    expect(made.code, made.stderr).toBe(0);
    for (const line of await pemBody(b)) expect(await grepTree(agent, line)).toEqual([]);

    const erased = await run(b, ["erase", SUBJECT, "--agent", agent, "--by", "the key test", "--yes", "--json"]);
    expect(erased.code, erased.stderr).toBe(0);
    expect(JSON.parse(erased.stdout).verdict).toBe("erased-and-verified");
    expect(await Bun.file(b.keyFile).exists()).toBe(false);
    expect(await readdir(join(b.home, "data", "mind")).catch(() => [])).toEqual([]);
  }, 60_000);
});

describe("a relative XDG_DATA_HOME is ignored (L9)", () => {
  test("the key goes under ~/.local/share, not under the directory the command ran in — where erase would never look", async () => {
    const b = await box();
    const made = await run({ ...b, env: { ...b.env, XDG_DATA_HOME: "data" } }, ["key", SOUL, "--subject", SUBJECT]);
    expect(made.code, made.stderr).toBe(0);
    expect(await Bun.file(join(b.home, "data", "mind", SUBJECT, "identity", "ed25519.pem")).exists()).toBe(false);
    expect(await Bun.file(join(b.home, ".local", "share", "mind", SUBJECT, "identity", "ed25519.pem")).exists()).toBe(true);
  }, 30_000);
});

describe("the card carries the key, and printing it makes none", () => {
  test("before `key`: nulls and no directory; after: the same public key `key` printed", async () => {
    const b = await box();
    const before = await run(b, ["soul", "card", SOUL, "--subject", SUBJECT]);
    expect(before.code, before.stderr).toBe(0);
    expect(cardKey(before.stdout)).toBeNull();
    expect(await readdir(b.home)).not.toContain("data");

    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;
    const after = await run(b, ["soul", "card", SOUL, "--subject", SUBJECT]);
    expect(cardKey(after.stdout)).toBe(publicKey);
  }, 30_000);
});

describe("mind usage", () => {
  test("report needs a key and makes none", async () => {
    const b = await box();
    const report = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    expect(report.code).toBe(1);
    expect(report.stdout).toBe("");
    expect(report.stderr).toContain("mind key");
    expect(await Bun.file(b.keyFile).exists()).toBe(false);
  }, 30_000);

  test("report --json is the signed envelope alone: model turns only, nothing said, unknown as null", async () => {
    const b = await box();
    await seedLedger(b);
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;

    const report = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    expect(report.code, report.stderr).toBe(0);
    const envelope = JSON.parse(report.stdout);
    expect(verifyEnvelope(envelope, publicKey).ok).toBe(true);
    expect(envelope.payload.rows.map((r: { backend: string; input_tokens: number | null }) => [r.backend, r.input_tokens])).toEqual([
      ["claude", 108921],
      ["ollama", null],
    ]);
    for (const needle of ["CANARY", SUBJECT, "prompt", b.home]) expect(report.stdout, needle).not.toContain(needle);
    for (const line of await pemBody(b)) expect(report.stdout + report.stderr).not.toContain(line);
    // The human half is on stderr, and says what was left out and what is unknown.
    expect(report.stderr).toContain("not 0");
    expect(report.stderr).toContain("1 ledger line(s) are messages");

    const table = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--since", "2026-09-21"]);
    expect(table.code, table.stderr).toBe(0);
    expect(table.stdout).toContain("ollama");
    expect(table.stdout).not.toContain("108921");
    expect((await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--until", "not a date"])).code).toBe(2);
  }, 30_000);

  test("verify: valid against the card's key, from a file or stdin; tampered, a stranger's key, and junk are not", async () => {
    const b = await box();
    await seedLedger(b);
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;
    const report = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    const file = join(b.home, "report.json");
    await writeFile(file, report.stdout);

    const valid = await run(b, ["usage", "verify", file, `--key=${publicKey}`]);
    expect(valid.code, valid.stderr).toBe(0);
    expect(valid.stdout).toContain("valid — a usage report signed by ed25519 key");
    expect(valid.stdout).toContain("It is signed by the key you named.");
    const piped = await run(b, ["usage", "verify", "-", `--key=${publicKey}`], report.stdout);
    expect(piped.code, piped.stderr).toBe(0);
    // L4: without --key it is not a yes — exit 3, and it says why.
    const unpinned = await run(b, ["usage", "verify", file]);
    expect(unpinned.code).toBe(3);
    expect(unpinned.stdout).toContain("consistent");
    expect(unpinned.stderr).toContain("NOT verified");

    const tampered = join(b.home, "tampered.json");
    await writeFile(tampered, report.stdout.replace("108921", "108922"));
    const changed = await run(b, ["usage", "verify", tampered]);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("NOT valid");

    const stranger = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const wrong = await run(b, ["usage", "verify", file, "--key", stranger]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("different key");

    await writeFile(join(b.home, "junk.json"), "not json");
    expect((await run(b, ["usage", "verify", join(b.home, "junk.json")])).code).toBe(1);
    const other = join(b.home, "other.json");
    await writeFile(other, JSON.stringify({ ...JSON.parse(report.stdout), algorithm: "rsa" }));
    expect((await run(b, ["usage", "verify", other])).stderr).toContain("unknown algorithm");

    expect((await run(b, ["usage", "verify", file, "--key", "not-a-key"])).code).toBe(2);
    // A stray --json is refused, not ignored: the verdict is the exit code, and there is no document to print.
    const stray = await run(b, ["usage", "verify", file, `--key=${publicKey}`, "--json"]);
    expect(stray.code).toBe(2);
    expect(stray.stdout).toBe("");
    expect(stray.stderr).toContain("usage verify takes --key, --market, --listing and nothing else, not --json");
    expect((await run(b, ["usage", "verify"])).code).toBe(2);
    expect((await run(b, ["usage"])).code).toBe(2);
  }, 30_000);
});

describe("mind usage — what the turns cost (S15.9, D-110, D-139)", () => {
  /** The table the seeded claude line was priced by — the default when it was written, still carried (D-143). */
  const TABLE_0928 = shippedTable("2026-09-28")!;

  /** A priced claude line and an unpriced local one, as `turn` writes them since S15.9. */
  async function seedPriced(b: Box): Promise<void> {
    const dir = join(b.home, "state", "mind", "ledger", SUBJECT);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const base = { v: 1, kind: "turn", subject: SUBJECT, confidence: "confirmed", exit: 0, identity: "system", soul_sha: "CANARY-SHA", content: "full", prompt: "CANARY-PROMPT", prompt_bytes: 13, text: "CANARY-ANSWER", text_bytes: 13, duration_ms: 900 };
    const lines = [
      {
        ...base,
        id: "p1",
        turn: "t1",
        at: "2026-09-20T10:00:00.000Z",
        backend: "claude",
        model: "claude-sonnet-4-6",
        usage: { status: "reported", input: 80953, output: 4, total: null, cache_read: 0, cache_write: 80951, not_printed: [] },
        cost: { usd_micros: 303632, table: "2026-09-28", table_digest: TABLE_0928.digest, source: "default", usd_micros_per_mtok: { input: 3000000, output: 15000000, cache_read: 300000, cache_write: 3750000 } },
        not_charged: null,
      },
      {
        ...base,
        id: "p2",
        turn: "t2",
        at: "2026-09-21T10:00:00.000Z",
        backend: "ollama",
        model: "qwen3:8b",
        usage: { status: "reported", input: 15, output: 24, total: null, cache_read: null, cache_write: null, not_printed: ["cache_read", "cache_write"] },
        cost: null,
        not_charged: "price-unknown",
      },
    ];
    await writeFile(join(dir, "2026-09.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
  }

  test("report carries each row's cost and the table behind it, signed; totals count what was not charged", async () => {
    const b = await box();
    await seedPriced(b);
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;

    const report = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    expect(report.code, report.stderr).toBe(0);
    const envelope = JSON.parse(report.stdout);
    expect(envelope.payload.v).toBe(2);
    expect(envelope.payload.rows.map((r: { cost: { usd_micros: number } | null; not_charged: string | null }) => [r.cost?.usd_micros ?? null, r.not_charged])).toEqual([
      [303632, null],
      [null, "price-unknown"],
    ]);
    expect(envelope.payload.rows[0].cost.usd_micros_per_mtok.cache_write).toBe(3750000);
    for (const needle of ["CANARY", SUBJECT, "prompt"]) expect(report.stdout, needle).not.toContain(needle);
    // R4: the headline says how much of the money a reader can check.
    expect(report.stderr).toContain(
      "cost $0.303632 (303632 usd_micros) over 1 charged row(s), of which $0.303632 checked against a shipped table and $0.000000 NOT checked",
    );
    // R6: one compact line — a v2 row is about half the size indented would make it.
    expect(report.stdout.trim().split("\n").length).toBe(1);
    expect(report.stderr).toContain("1 row(s) not charged — price-unknown 1");

    const table = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT]);
    expect(table.stdout).toContain("$0.303632");
    expect(table.stdout).toContain("not charged: price-unknown");

    const file = join(b.home, "report.json");
    await writeFile(file, report.stdout);
    const valid = await run(b, ["usage", "verify", file, `--key=${publicKey}`]);
    expect(valid.code, valid.stderr).toBe(0);
    expect(valid.stdout).toContain("cost $0.303632");
    // M2: the claim is shown with its rates, and said to be checked against the table this build ships.
    expect(valid.stdout).toContain("$0.303632 over 1 row(s) · claude · claude-sonnet-4-6 · default table 2026-09-28");
    expect(valid.stdout).toContain("input $3.00, output $15.00, cache_read $0.30, cache_write $3.75");
    expect(valid.stdout).toContain("checked — the rates Mind ships as table 2026-09-28 for this model");
    expect(table.stdout + report.stderr).toContain("checked — the rates Mind ships");

    // A cost changed after signing breaks the signature; a cost that is wrong from the start is refused
    // even when it is signed, because the row's own counts and rates say what it should be.
    const tampered = join(b.home, "tampered.json");
    await writeFile(tampered, report.stdout.replace('"usd_micros":303632', '"usd_micros":303633'));
    expect((await run(b, ["usage", "verify", tampered, `--key=${publicKey}`])).code).toBe(1);
    const key = generateKeyPairSync("ed25519").privateKey;
    const wrongSum = signEnvelope({ ...envelope.payload, rows: [{ ...envelope.payload.rows[0], cost: { ...envelope.payload.rows[0].cost, usd_micros: 1 } }] }, key);
    const forged = join(b.home, "forged.json");
    await writeFile(forged, JSON.stringify(wrongSum));
    const refused = await run(b, ["usage", "verify", forged, "--key", wrongSum.publicKey]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("come to 303632");
  }, 30_000);

  test("R5: a line whose cost does not check is left out and said so, with why — not counted as a bad id", async () => {
    const b = await box();
    await seedPriced(b);
    const dir = join(b.home, "state", "mind", "ledger", SUBJECT);
    const lines = (await readFile(join(dir, "2026-09.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    // The claude line at ten times the shipped rates, arithmetic right, still labelled as the shipped table.
    const ten = { ...lines[0], id: "p3", cost: { ...lines[0].cost, usd_micros: 3036323, usd_micros_per_mtok: { input: 30000000, output: 150000000, cache_read: 3000000, cache_write: 37500000 } } };
    await writeFile(join(dir, "2026-09.jsonl"), [...lines, ten].map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
    await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const report = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    expect(report.code, report.stderr).toBe(0);
    expect(JSON.parse(report.stdout).payload.rows.map((r: { id: string }) => r.id)).toEqual(["p1", "p2"]);
    expect(report.stderr).toContain("1 ledger line(s) claim a cost that does not check and are not in it");
    expect(report.stderr).toContain("line p3.cost names the shipped table 2026-09-28, which prices claude-sonnet-4-6 input at 3000000");
    expect(report.stderr).not.toContain("ids of no row's shape");
  }, 30_000);

  test("M2: a row that says `default` is held to the shipped table; one it cannot check says so", async () => {
    const b = await box();
    await seedPriced(b);
    await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const payload = JSON.parse((await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"])).stdout).payload;
    const priced = payload.rows[0];
    const key = generateKeyPairSync("ed25519").privateKey;
    const verifyRows = async (rows: unknown[]) => {
      const envelope = signEnvelope({ ...payload, rows }, key);
      const file = join(b.home, `r-${Math.random().toString(36).slice(2)}.json`);
      await writeFile(file, JSON.stringify(envelope));
      return run(b, ["usage", "verify", file, "--key", envelope.publicKey]);
    };
    const SONNET = priced.cost.usd_micros_per_mtok as Record<string, number | null>;
    const tenfold = (r: typeof SONNET) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : v * 10]));

    // Ten times the shipped rates, labelled `default` 2026-09-28, arithmetic right (3,036,322.5 µ$ rounds up):
    // refused, exit 1 — before the review this verified with exit 0.
    const inflated = { ...priced, cost: { ...priced.cost, usd_micros: 3036323, usd_micros_per_mtok: tenfold(SONNET) } };
    const ten = await verifyRows([inflated]);
    expect(ten.code).toBe(1);
    expect(ten.stderr).toContain("names the shipped table 2026-09-28, which prices claude-sonnet-4-6 input at 3000000");

    // A model the shipped table does not price, labelled as if it did.
    const unlisted = await verifyRows([{ ...priced, model: "claude-sonnet-9" }]);
    expect(unlisted.code).toBe(1);
    expect(unlisted.stderr).toContain("has no price for claude · claude-sonnet-9");

    // A shipped version this build does not carry, and the owner's own rates: valid, and plainly not checked.
    const unknownVersion = await verifyRows([{ ...priced, cost: { ...priced.cost, table: "2031-01-01", table_digest: "0123456789abcdef" } }]);
    expect(unknownVersion.code, unknownVersion.stderr).toBe(0);
    expect(unknownVersion.stdout).toContain("NOT checked — says the shipped table 2031-01-01, which this Mind does not carry");
    const owned = await verifyRows([{ ...priced, cost: { ...priced.cost, source: "owner", table: "home-1", table_digest: "00112233aabbccdd" } }]);
    expect(owned.code, owned.stderr).toBe(0);
    expect(owned.stdout).toContain("owner table home-1 (digest 00112233aabbccdd)");
    expect(owned.stdout).toContain("NOT checked — rates the agent's owner set");
    expect(owned.stdout).toContain("the digest is the agent's own claim");
    expect(owned.stdout).toContain("of which $0.000000 checked against a shipped table and $0.303632 NOT checked");

    // R2: the shipped digest under an invented version, or under the owner's label, at ten times the rates.
    const invented = await verifyRows([{ ...inflated, cost: { ...inflated.cost, table: "2026-09-30" } }]);
    expect(invented.code).toBe(1);
    expect(invented.stderr).toContain("carries the digest of the shipped table 2026-09-28 and names table 2026-09-30");
    // The next shipped version under the old one's digest: held to its own digest (D-143 made 2026-09-29 real).
    const renamed = await verifyRows([{ ...priced, cost: { ...priced.cost, table: "2026-09-29" } }]);
    expect(renamed.code).toBe(1);
    expect(renamed.stderr).toContain(`names the shipped table 2026-09-29, whose digest is ${DEFAULT_PRICES.digest}, not ${TABLE_0928.digest}`);
    const ownerLabel = await verifyRows([{ ...inflated, cost: { ...inflated.cost, source: "owner" } }]);
    expect(ownerLabel.code).toBe(1);
    expect(ownerLabel.stderr).toContain("says the owner set its rates");

    // R3: one owner digest, one model, two prices.
    const two = await verifyRows([
      { ...priced, id: "o1", cost: { ...priced.cost, source: "owner", table: "home-1", table_digest: "00112233aabbccdd" } },
      { ...inflated, id: "o2", cost: { ...inflated.cost, source: "owner", table: "home-1", table_digest: "00112233aabbccdd" } },
    ]);
    expect(two.code).toBe(1);
    expect(two.stderr).toContain("at two different sets of rates");
  }, 30_000);

  test("D-143: a turn that wrote to the 1-hour cache is reported with the split, priced at its own rate, and verifies", async () => {
    const b = await box();
    const dir = join(b.home, "state", "mind", "ledger", SUBJECT);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const base = { v: 1, kind: "turn", subject: SUBJECT, confidence: "confirmed", exit: 0, identity: "system", soul_sha: null, content: "withheld", prompt: null, prompt_bytes: 5, text: null, text_bytes: 2, duration_ms: 900, backend: "claude", model: "claude-haiku-4-5" };
    const haiku = { input: 1000000, output: 5000000, cache_read: 100000, cache_write: 1250000 };
    const table = { table: DEFAULT_PRICES.version, table_digest: DEFAULT_PRICES.digest, source: "default" };
    const usage = (write: number, oneHour: number) => ({ status: "reported", input: 10 + write, output: 65, total: null, cache_read: 0, cache_write: write, cache_write_5m: write - oneHour, cache_write_1h: oneHour, not_printed: [] });
    const lines = [
      // D-142's measured turn: every write to the 1-hour cache. 10 + 23,712 + 325 = 24,047 µ$.
      { ...base, id: "h1", turn: "t1", at: "2026-09-28T10:00:00.000Z", usage: usage(11856, 11856), cost: { ...table, usd_micros: 24047, usd_micros_per_mtok: { ...haiku, cache_write_1h: 2000000 } }, not_charged: null },
      // All 5-minute: 10 + 14,820 + 325 = 15,155 µ$, and nothing new on the row.
      { ...base, id: "m5", turn: "t2", at: "2026-09-28T11:00:00.000Z", usage: usage(11856, 0), cost: { ...table, usd_micros: 15155, usd_micros_per_mtok: haiku }, not_charged: null },
    ];
    await writeFile(join(dir, "2026-09.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;
    const report = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    expect(report.code, report.stderr).toBe(0);
    const rows = JSON.parse(report.stdout).payload.rows;
    expect(rows.map((r: { id: string; cache_write_1h_tokens?: number }) => [r.id, r.cache_write_1h_tokens ?? null])).toEqual([
      ["h1", 11856],
      ["m5", null],
    ]);
    expect("cache_write_1h_tokens" in rows[1]).toBe(false);
    expect(Object.keys(rows[1].cost.usd_micros_per_mtok)).toEqual(["input", "output", "cache_read", "cache_write"]);
    expect(report.stderr).toContain("cache write 23712, of it 11856 to the 1-hour cache");
    const file = join(b.home, "split.json");
    await writeFile(file, report.stdout);
    const valid = await run(b, ["usage", "verify", file, `--key=${publicKey}`]);
    expect(valid.code, valid.stderr).toBe(0);
    expect(valid.stdout).toContain("cost $0.039202 (39202 usd_micros) over 2 charged row(s), of which $0.039202 checked against a shipped table");
    expect(valid.stdout).toContain("cache_write $1.25, cache_write_1h $2.00");
    const table2 = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT]);
    expect(table2.stdout).toContain("11856 (1h 11856)");
  }, 30_000);

  test("prices: the shipped table, the owner's in front of it, and a broken one refused with exit 1", async () => {
    const b = await box();
    const shipped = await run(b, ["usage", "prices"]);
    expect(shipped.code, shipped.stderr).toBe(0);
    expect(shipped.stdout).toContain("shipped (default): version 2026-09-29");
    expect(shipped.stdout).toContain("claude-sonnet-4-6");
    // D-143: the 1-hour write rate is a column of its own; grok has none.
    expect(shipped.stdout).toMatch(/cache_write\s+cache_write_1h\s+from/);
    expect(shipped.stdout).toMatch(/claude-sonnet-4-6\s+\$3\.00\s+\$15\.00\s+\$0\.30\s+\$3\.75\s+\$6\.00\s+default 2026-09-29/);
    expect(shipped.stdout).toMatch(/grok-4\.7\s+\$2\.00\s+\$6\.00\s+\$0\.50\s+-\s+-\s+default/);
    expect(shipped.stdout).toContain("yours: none at");
    const json = JSON.parse((await run(b, ["usage", "prices", "--json"])).stdout);
    expect(json.owner.state).toBe("absent");
    expect(json.unit).toBe("usd_micros per million tokens");
    expect(json.prices.every((p: { source: string }) => p.source === "default")).toBe(true);
    expect(json.prices.find((p: { model: string }) => p.model === "claude-sonnet-4-6")).toMatchObject({ cache_write: 3750000, cache_write_1h: 6000000 });

    const path = join(b.home, "state", "mind", "prices.json");
    await mkdir(join(b.home, "state", "mind"), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      JSON.stringify({
        kind: "mind.price-table",
        v: 1,
        version: "home-1",
        currency: "usd",
        unit: "micros-per-million-tokens",
        sources: [{ note: "power at 5 THB/kWh\u001b[8m", read: "2026-09-28" }],
        prices: [{ backend: "claude-local", model: "local-coder", input: 50000, output: 150000, cache_read: 0, cache_write: 0 }],
      }),
      { mode: 0o600 },
    );
    const owned = await run(b, ["usage", "prices"]);
    expect(owned.code, owned.stderr).toBe(0);
    expect(owned.stdout).toContain("yours (");
    expect(owned.stdout).toMatch(/claude-local\s+local-coder\s+\$0\.05\s+\$0\.15/);
    // A note from a file reaches the terminal escaped.
    expect(owned.stdout).not.toContain("\u001b");
    expect(owned.stdout).toContain("\\u{1b}");
    const ownedJson = JSON.parse((await run(b, ["usage", "prices", "--json"])).stdout);
    expect(ownedJson.prices[0]).toMatchObject({ backend: "claude-local", source: "owner", table: "home-1" });
    // An owner's price written without a 1-hour rate has none: null, and `-` on the screen (D-143).
    expect(ownedJson.prices[0].cache_write_1h).toBeNull();
    expect(owned.stdout).toMatch(/local-coder\s+\$0\.05\s+\$0\.15\s+\$0\.00\s+\$0\.00\s+-\s+owner home-1/);

    await writeFile(path, JSON.stringify({ kind: "mind.price-table", v: 1, version: "x", currency: "usd", unit: "micros-per-million-tokens", prices: [{ backend: "ollama", model: "m", input: 1, output: 1, cache_read: null, cache_writes: 1 }] }));
    const broken = await run(b, ["usage", "prices"]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("cache_writes");
    expect(broken.stderr).toContain("not charged (table-unusable)");
    const brokenJson = await run(b, ["usage", "prices", "--json"]);
    expect(brokenJson.code).toBe(1);
    expect(JSON.parse(brokenJson.stdout).prices).toEqual([]);
    expect((await run(b, ["usage", "prices", "extra"])).code).toBe(2);
  }, 30_000);
});

describe("usage verify on hostile reports (security review M2, L4, L5)", () => {
  const key = generateKeyPairSync("ed25519").privateKey;
  const { payload } = usagePayload([], {}, new Date("2026-09-28T00:00:00.000Z"));
  const row = { id: "a1", turn: "t1", at: "2026-09-20T10:00:00.000Z", duration_ms: 1, backend: "claude", model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null, usage: "reported", cost: null, not_charged: "not-recorded" };

  test("escape sequences in a self-signed report reach no terminal, with --key or without", async () => {
    const b = await box();
    const hostile = [
      { ...payload, generated_at: "2026-09-28T00:00:00.000Z\nIt is signed by the key you named.\u001b[8m" },
      { ...payload, since: "\u001b[1A\u001b[2Kvalid — signed by ed25519 key 0000000000000000" },
      { ...payload, rows: [{ ...row, backend: "\u001b]0;pwned\u0007" }] },
      { ...payload, rows: [{ ...row, model: "m\u202eodel" }] },
    ];
    for (const value of hostile) {
      const envelope = signEnvelope(value, key);
      const file = join(b.home, "hostile.json");
      await writeFile(file, JSON.stringify(envelope));
      for (const args of [["usage", "verify", file], ["usage", "verify", file, "--key", envelope.publicKey]]) {
        const ran = await run(b, args);
        expect(ran.code).toBe(1);
        expect(ran.stdout + ran.stderr).not.toMatch(/[\u001b\u0007\u202e]/);
        expect(ran.stdout).not.toContain("signed by the key you named");
        expect(ran.stderr).toContain("NOT valid");
      }
    }
  }, 30_000);

  test("a duplicate `rows` is refused, though JSON.parse would have verified it", async () => {
    const b = await box();
    const envelope = signEnvelope({ ...payload, rows: [row] }, key);
    const text = JSON.stringify(envelope).replace('"rows":', `"rows":${JSON.stringify([{ ...row, input_tokens: 999999 }])},"rows":`);
    expect(verifyEnvelope(JSON.parse(text), envelope.publicKey).ok).toBe(true);
    const file = join(b.home, "doubled.json");
    await writeFile(file, text);
    const ran = await run(b, ["usage", "verify", file, "--key", envelope.publicKey]);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("duplicate member name");
  }, 30_000);

  test("a weak key cannot be pinned, and a signature under the identity point is not valid", async () => {
    const b = await box();
    const identity = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const pinned = await run(b, ["usage", "verify", "-", "--key", identity], "{}");
    expect(pinned.code).toBe(2);
    expect(pinned.stderr).toContain("small order");
    const forged = {
      v: 1,
      algorithm: "ed25519",
      publicKey: identity,
      fingerprint: new Bun.CryptoHasher("sha256").update(Buffer.from(identity, "base64url")).digest("hex").slice(0, 16),
      payload: { ...payload, rows: [row] },
      signature: Buffer.concat([Buffer.from(identity, "base64url"), Buffer.alloc(32)]).toString("base64url"),
    };
    const ran = await run(b, ["usage", "verify", "-"], JSON.stringify(forged));
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("small order");
  }, 30_000);
});


describe("mind key prove and verify-proof (D-141 §1)", () => {
  const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const target = ["--market", "https://market.example", "--listing", "ts-reviewer", "--nonce", NONCE];

  test("prove signs the challenge with the agent's key; verify-proof holds it to key, market, listing and nonce", async () => {
    const b = await box();
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;
    const before = Date.now();

    const proved = await run(b, ["key", "prove", SOUL, "--subject", SUBJECT, ...target, "--json"]);
    expect(proved.code, proved.stderr).toBe(0);
    // Under --json the proof is stdout alone, on one line; the person's half is on stderr.
    expect(proved.stdout.trim().split("\n")).toHaveLength(1);
    const envelope = JSON.parse(proved.stdout);
    expect(envelope.publicKey).toBe(publicKey);
    expect(Object.keys(envelope.payload)).toEqual(["kind", "v", "market", "listing", "nonce", "at"]);
    expect(envelope.payload).toMatchObject({ kind: KEY_PROOF_KIND, v: 1, market: "https://market.example", listing: "ts-reviewer", nonce: NONCE });
    expect(Date.parse(envelope.payload.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(proved.stderr).toContain("market      https://market.example");
    expect(proved.stderr).toContain("It is good once");
    // No subject id (the key's order above says so) and no path: the subject here is `example`, which the
    // market's name holds by chance, so the check is on the payload's fields rather than a text search.
    expect(proved.stdout).not.toContain(b.home);
    for (const line of await pemBody(b)) expect(proved.stdout + proved.stderr).not.toContain(line);

    // Without --json the same proof is the last line of stdout, after what it says.
    const plain = await run(b, ["key", "prove", SOUL, "--subject", SUBJECT, ...target]);
    expect(plain.code, plain.stderr).toBe(0);
    const lines = plain.stdout.trim().split("\n");
    expect(JSON.parse(lines.at(-1)!).payload.nonce).toBe(NONCE);
    expect(plain.stdout).toContain("`--json` prints that line alone");

    const file = join(b.home, "proof.json");
    await writeFile(file, proved.stdout);
    const verify = (args: readonly string[], stdin?: string) => run(b, ["key", "verify-proof", ...args], stdin);
    const valid = await verify([file, `--key=${publicKey}`, ...target]);
    expect(valid.code, valid.stderr).toBe(0);
    expect(valid.stdout).toContain("valid — a key proof signed by ed25519 key");
    expect(valid.stdout).toContain("only the market that issued it can say");
    expect((await verify(["-", `--key=${publicKey}`, ...target], proved.stdout)).code).toBe(0);

    for (const [flag, other, because] of [
      ["--market", "https://other.example", "another market"],
      ["--listing", "other-listing", "another listing"],
      ["--nonce", "A".repeat(43), "another nonce"],
    ] as const) {
      const args = [...target];
      args[args.indexOf(flag) + 1] = other;
      const wrong = await verify([file, `--key=${publicKey}`, ...args]);
      expect(wrong.code, flag).toBe(1);
      expect(wrong.stderr).toContain(`NOT valid — it proves the key for ${because}`);
    }
    const stranger = await verify([file, "--key", "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", ...target]);
    expect(stranger.code).toBe(1);
    expect(stranger.stderr).toContain("different key");
    const respelled = join(b.home, "respelled.json");
    await writeFile(respelled, proved.stdout.replace('"v":1,"market"', '"v":1e0,"market"'));
    const spelled = await verify([respelled, `--key=${publicKey}`, ...target]);
    expect(spelled.code).toBe(1);
    expect(spelled.stderr).toContain("fraction or an exponent");
    expect((await verify([join(b.home, "nowhere.json"), `--key=${publicKey}`, ...target])).code).toBe(1);

    // A command line it will not run: every flag is required, a weak key cannot be pinned, nothing stray.
    expect((await verify([file, ...target])).code).toBe(2);
    expect((await verify([file, `--key=${publicKey}`, "--market", "https://market.example", "--listing", "ts-reviewer"])).code).toBe(2);
    expect((await verify([file, "--key", "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ...target])).stderr).toContain("small order");
    const extra = await verify([file, `--key=${publicKey}`, ...target, "--json"]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("not --json");
    expect((await verify([`--key=${publicKey}`, ...target])).code).toBe(2);
  }, 60_000);

  test("prove makes no key, and refuses a market, listing or nonce out of shape with exit 2 before reading one", async () => {
    const b = await box();
    const none = await run(b, ["key", "prove", SOUL, "--subject", SUBJECT, ...target]);
    expect(none.code).toBe(1);
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain(`\`mind key ${SOUL} --subject ${SUBJECT}\` makes one`);
    expect(await Bun.file(b.keyFile).exists()).toBe(false);

    const refused = async (args: readonly string[], because: string) => {
      const ran = await run(b, ["key", "prove", SOUL, "--subject", SUBJECT, ...args]);
      expect(ran.code, args.join(" ")).toBe(2);
      expect(ran.stdout).toBe("");
      expect(ran.stderr, args.join(" ")).toContain(because);
      expect(ran.stderr).not.toMatch(/[\u001b\u202e]/);
    };
    const withValue = (flag: string, value: string) => {
      const args = [...target];
      args[args.indexOf(flag) + 1] = value;
      return args;
    };
    await refused(withValue("--market", "https://market.example/"), "--market ends in /, which an origin does not — write https://market.example");
    await refused(withValue("--market", "http://market.example"), "--market is not https");
    await refused(withValue("--market", "https://Market.Example"), "write https://market.example");
    await refused(withValue("--market", "https://bücher.example"), "write https://xn--bcher-kva.example");
    await refused(withValue("--market", "https://market.example/path?q#f"), "--market has a query or a fragment");
    await refused(withValue("--market", "https://u@market.example"), "user name or password");
    await refused(withValue("--listing", "TS_Reviewer"), "--listing is not a slug");
    await refused(withValue("--nonce", NONCE.slice(1)), "--nonce is not 32 bytes of base64url");
    await refused(withValue("--nonce", `${NONCE.slice(0, 42)}B`), "one spelling");
    await refused(withValue("--listing", "x\u001b[8m\u202e"), "--listing is not a slug");
    await refused(target.slice(0, 4), "--nonce is required");
    await refused(["--market", "https://market.example", "--listing", "ts-reviewer", "--nonce", "--AECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"], "written --nonce=<nonce>");
    await refused([...target, "--jobb", "x"], "not --jobb");
    expect((await run(b, ["key", "prove", SOUL, ...target])).code).toBe(2);
    expect((await run(b, ["key", "prove", "--subject", SUBJECT, ...target])).code).toBe(2);
    expect((await run(b, ["key", "prove", SOUL, "--subject", "Not A Subject", ...target])).code).toBe(2);
    expect((await run(b, ["key", "prove", join(b.home, "nowhere"), "--subject", SUBJECT, ...target])).code).toBe(1);

    // A nonce that begins with -- goes through in the --nonce= form, and a local market over http is a market.
    await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const dashed = `--${NONCE.slice(2)}`;
    const local = await run(b, ["key", "prove", SOUL, "--subject", SUBJECT, "--market", "http://127.0.0.1:30710", "--listing", "ts-reviewer", `--nonce=${dashed}`, "--json"]);
    expect(local.code, local.stderr).toBe(0);
    expect(JSON.parse(local.stdout).payload).toMatchObject({ market: "http://127.0.0.1:30710", nonce: dashed });

    // A key others can read is refused, not used.
    await chmod(b.keyFile, 0o644);
    const loose = await run(b, ["key", "prove", SOUL, "--subject", SUBJECT, ...target, "--json"]);
    expect(loose.code).toBe(1);
    expect(loose.stdout).toBe("");
    expect(loose.stderr).toContain("chmod 600");
  }, 60_000);
});

describe("usage report bound to a market, a listing and a job; verify holds it there (D-141 §2)", () => {
  const where = ["--market", "https://market.example", "--listing", "ts-reviewer"];

  test("report signs the binding; verify with --market and --listing checks it, and without says it did not", async () => {
    const b = await box();
    await seedLedger(b);
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;

    const bound = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, ...where, "--job", "job_01", "--json"]);
    expect(bound.code, bound.stderr).toBe(0);
    const envelope = JSON.parse(bound.stdout);
    expect(envelope.payload.binding).toEqual({ market: "https://market.example", listing: "ts-reviewer", job: "job_01" });
    expect(bound.stderr).toContain("bound to listing ts-reviewer on market https://market.example, job job_01");
    const file = join(b.home, "bound.json");
    await writeFile(file, bound.stdout);

    const unbound = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"]);
    expect(JSON.parse(unbound.stdout).payload.binding).toBeNull();
    expect(unbound.stderr).toContain("bound to no market");
    const local = join(b.home, "local.json");
    await writeFile(local, unbound.stdout);
    const noJob = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, ...where]);
    expect(noJob.stdout).toContain("bound to listing ts-reviewer on market https://market.example, no job");

    const held = await run(b, ["usage", "verify", file, `--key=${publicKey}`, ...where]);
    expect(held.code, held.stderr).toBe(0);
    expect(held.stdout).toContain("checked — it is bound to the market and listing you named");
    expect(held.stdout).toContain("It is signed by the key you named.");
    const loose = await run(b, ["usage", "verify", file, `--key=${publicKey}`]);
    expect(loose.code, loose.stderr).toBe(0);
    expect(loose.stdout).toContain("bound to listing ts-reviewer on market https://market.example, job job_01");
    expect(loose.stdout).toContain("NOT checked — pass --market and --listing");
    expect((await run(b, ["usage", "verify", local, `--key=${publicKey}`])).stdout).toContain("NOT checked against a market — none was named");

    // M3: the same signed report is not valid for another listing, another market, or when it is bound to none.
    const elsewhere = await run(b, ["usage", "verify", file, `--key=${publicKey}`, "--market", "https://market.example", "--listing", "other-listing"]);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.stderr).toContain("NOT valid — it is bound to another listing: ts-reviewer, not other-listing");
    const otherMarket = await run(b, ["usage", "verify", file, `--key=${publicKey}`, "--market", "http://localhost:30710", "--listing", "ts-reviewer"]);
    expect(otherMarket.code).toBe(1);
    expect(otherMarket.stderr).toContain("another market");
    const nowhere = await run(b, ["usage", "verify", local, `--key=${publicKey}`, ...where]);
    expect(nowhere.code).toBe(1);
    expect(nowhere.stderr).toContain("bound to no market");
    // Pins without --key: still exit 3 when they match, 1 when they do not.
    expect((await run(b, ["usage", "verify", file, ...where])).code).toBe(3);
    expect((await run(b, ["usage", "verify", local, ...where])).code).toBe(1);
    // A binding moved after signing breaks the signature.
    const moved = join(b.home, "moved.json");
    await writeFile(moved, bound.stdout.replace('"listing":"ts-reviewer"', '"listing":"other-listing"'));
    expect((await run(b, ["usage", "verify", moved, `--key=${publicKey}`, "--market", "https://market.example", "--listing", "other-listing"])).code).toBe(1);
  }, 60_000);

  test("half a binding, a job with nowhere to be, or any of them out of shape is a command line it will not run", async () => {
    const b = await box();
    await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const report = async (args: readonly string[], because: string) => {
      const ran = await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, ...args, "--json"]);
      expect(ran.code, args.join(" ")).toBe(2);
      expect(ran.stdout).toBe("");
      expect(ran.stderr, args.join(" ")).toContain(because);
    };
    await report(["--market", "https://market.example"], "--market and --listing go together");
    await report(["--listing", "ts-reviewer"], "--market and --listing go together");
    await report(["--job", "job_01"], "--job needs --market and --listing");
    await report([...where, "--job", "job 01"], "--job is not a job's id");
    await report([...where, "--job", ""], "--job is not a job's id");
    await report(["--market", "https://market.example/", "--listing", "ts-reviewer"], "--market ends in /");
    await report(["--market", "https://market.example", "--listing", "TS"], "--listing is not a slug");
    await report([...where, "--jobs", "x"], "usage report takes --subject, --since, --until, --market, --listing, --job, --json and nothing else, not --jobs");

    const file = join(b.home, "any.json");
    await writeFile(file, "{}");
    const verify = async (args: readonly string[], because: string) => {
      const ran = await run(b, ["usage", "verify", file, ...args]);
      expect(ran.code, args.join(" ")).toBe(2);
      expect(ran.stderr, args.join(" ")).toContain(because);
    };
    await verify(["--market", "https://market.example"], "--market and --listing go together");
    await verify(["--listing", "ts-reviewer"], "--market and --listing go together");
    await verify(["--market", "https://market.example:443", "--listing", "ts-reviewer"], "write https://market.example");
    await verify([...where, "--job", "job_01"], "not --job");
  }, 60_000);
});

describe("the kinds the engine signs and reads", () => {
  const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
  const target = ["--market", "https://market.example", "--listing", "ts-reviewer", "--nonce", NONCE];

  test("verify-proof accepts a key proof of the mind kind, and refuses a kind that is not", async () => {
    const b = await box();
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;
    const proved = JSON.parse((await run(b, ["key", "prove", SOUL, "--subject", SUBJECT, ...target, "--json"])).stdout);
    expect(proved.payload.kind).toBe("mind.key-proof");
    const signer = createPrivateKey(await readFile(b.keyFile, "utf8"));

    const read = async (kind: string) => {
      const file = join(b.home, `proof-${kind.replace(/\W/g, "-")}.json`);
      await writeFile(file, JSON.stringify(signEnvelope({ ...proved.payload, kind }, signer)));
      return run(b, ["key", "verify-proof", file, `--key=${publicKey}`, ...target]);
    };
    const ran = await read(KEY_PROOF_KIND);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("valid — a key proof signed by ed25519 key");
    const neither = await read("someone-else.key-proof");
    expect(neither.code).toBe(1);
    expect(neither.stderr).toContain("NOT valid");
  }, 60_000);

  test("usage verify accepts a report of the mind kind, and refuses another", async () => {
    const b = await box();
    await seedLedger(b);
    const made = await run(b, ["key", SOUL, "--subject", SUBJECT]);
    const publicKey = /public key\s+(\S+)/.exec(made.stdout)![1]!;
    const report = JSON.parse((await run(b, ["usage", "report", SOUL, "--subject", SUBJECT, "--json"])).stdout);
    expect(report.payload.kind).toBe("mind.usage-report");
    const signer = createPrivateKey(await readFile(b.keyFile, "utf8"));

    const verify = async (kind: string) => {
      const file = join(b.home, `report-${kind.replace(/\W/g, "-")}.json`);
      await writeFile(file, JSON.stringify(signEnvelope({ ...report.payload, kind }, signer)));
      return run(b, ["usage", "verify", file, `--key=${publicKey}`]);
    };
    const ran = await verify(USAGE_REPORT_KIND);
    expect(ran.code, ran.stderr).toBe(0);
    expect((await verify("someone-else.usage-report")).code).not.toBe(0);
  }, 60_000);
});
