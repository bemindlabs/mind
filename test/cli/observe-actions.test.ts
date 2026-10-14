/**
 * `mind observe actions` and `observe audit` through the real binary.
 *
 * Three properties are checked here rather than in a unit test, because all
 * three are about what the *command* does and would survive any amount of
 * correct library code:
 *
 * 1. **Nothing enters git by itself.** A run without `--write` leaves no file
 *    anywhere, checked by walking the trees before and after. A run with
 *    `--write` prints `GIT_UNDELETABLE` *before* the file exists, and the order
 *    is asserted — a warning after the write is a warning about a fact.
 * 2. **What is written cannot identify anybody.** The records carry a client
 *    directory, an MCP server's name, a session id and an instant; the bytes on
 *    disk are searched for every one of them, and for the subject id.
 * 3. **`observe audit` refuses without a terminal.** There is no `--yes`, for the
 *    reason `observe enable` has none: a program running as the owner could
 *    answer `y` a hundred times, and AC4 is not a thing a program can answer.
 *
 * Everything runs in a temporary `HOME` with a temporary `XDG_DATA_HOME`, and no
 * vendor CLI is on the child's PATH. Every record and path is invented (D-021).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GIT_UNDELETABLE } from "../../src/guard/history.ts";
import { appendRecord, ensureCaptureDir } from "../../src/observer/capture-store.ts";
import { ensureSessionsDir } from "../../src/observer/origin.ts";
import { CAPTURE_VERSION, NO_EVIDENCE, type CaptureRecord } from "../../src/observer/record.ts";
import { announceCapture, ensureObserverDir } from "../../src/observer/store.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const A = subjectId("subject-a");
const B = subjectId("subject-b");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  readonly home: string;
  readonly data: string;
  readonly path: string;
}

async function harness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "mind-actions-cli-"));
  scratch.push(home);
  const path = await barePath(home);
  expectNoVendorOn(path);
  return { home, data: join(home, "data"), path };
}

async function run(h: Harness, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: ROOT,
    env: {
      HOME: h.home,
      PATH: h.path,
      XDG_DATA_HOME: h.data,
      XDG_STATE_HOME: join(h.home, "state"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** One invented record. */
function record(fields: Partial<CaptureRecord>): CaptureRecord {
  return {
    v: CAPTURE_VERSION,
    key: `claude:tool:${fields.key ?? Math.random().toString(16).slice(2)}`,
    at: "2026-09-21T10:00:00.000Z",
    vendor: "claude",
    session: "9f3c7e10-secret-session",
    project: "/invented/home/someone/work/acme",
    kind: "tool",
    tool: "Read",
    target: "",
    outcome: "ok",
    source: "seed",
    origin: "unknown",
    evidence: NO_EVIDENCE,
    ...fields,
  };
}

/** A capture store for one subject, with the given records in it. */
async function store(
  h: Harness,
  subject: SubjectId,
  records: readonly CaptureRecord[],
): Promise<string> {
  const created = await ensureObserverDir(
    { home: h.home, env: { XDG_DATA_HOME: h.data } },
    subject,
    announceCapture(() => undefined),
  );
  if (!created.ok) throw new Error(created.reason);
  await ensureCaptureDir(created.path);
  await ensureSessionsDir(created.path);
  for (const one of records) {
    const written = await appendRecord(created.path, one, new Date(one.at));
    expect(written.ok).toBe(true);
  }
  return created.path;
}

/** Every file under a tree with its size, so "nothing was written" is checked. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await tree(path)));
    else found.push(`${path} ${(await stat(path)).size}`);
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe("observe actions — reading", () => {
  test("an empty store says so, exits 0, and writes nothing", async () => {
    const h = await harness();
    // The data root, not the whole temporary home: bun keeps its own install
    // cache under HOME, and a check that included it would be a check of bun.
    const before = await tree(h.data);

    const result = await run(h, ["observe", "actions", "--subject", A]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 record(s) readable back");
    expect(result.stdout).toContain("no capture files, so no months and no counts");
    expect(result.stdout).toContain("Nothing was written");
    // Asking where the data would be does not bring it into existence (AC1).
    expect(await tree(h.data)).toEqual(before);
    expect(before).toEqual([]);
  });

  test("it counts what is there, per month, over the closed words", async () => {
    const h = await harness();
    await store(h, A, [
      record({ key: "a1", kind: "file-edit", tool: "Edit", target: "src/a.ts" }),
      record({ key: "a2", kind: "command", tool: "Bash", target: "git commit", outcome: "failed" }),
      record({ key: "a3", kind: "tool", tool: "mcp__acme__lookup" }),
      record({ key: "a4", kind: "prompt", tool: "", at: "2026-08-20T09:00:00.000Z" }),
    ]);

    const result = await run(h, ["observe", "actions", "--subject", A]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("4 record(s) readable back");
    expect(result.stdout).toContain("2026-08 · 1 record(s)");
    expect(result.stdout).toContain("2026-09 · 3 record(s)");
    expect(result.stdout).toContain("git 1");
    expect(result.stdout).toContain("failed 1");
    // An unnamed tool is `other`, and its name never appears.
    expect(result.stdout).toContain("other 1");
    expect(result.stdout).not.toContain("mcp__acme__lookup");
    // The sentence the owner asked for, on the terminal as well as in the file.
    expect(result.stdout).toContain("nobody has turned capture on");
  });

  test("--json prints the file that --write would write", async () => {
    const h = await harness();
    await store(h, A, [record({ key: "a1", kind: "command", tool: "Bash", target: "git status" })]);

    const result = await run(h, ["observe", "actions", "--subject", A, "--json"]);
    const summary = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.code).toBe(0);
    expect(summary["schema"]).toBe("mind/actions-summary/1");
    expect(summary["months"]).toEqual(["2026-09"]);
    expect(Array.isArray(summary["limits"])).toBe(true);
  });

  test("one subject's summary holds nothing of another's (I-3)", async () => {
    const h = await harness();
    await store(h, A, [record({ key: "a1", kind: "command", tool: "Bash", target: "git commit" })]);
    await store(h, B, [
      record({ key: "b1", kind: "command", tool: "Bash", target: "docker restart" }),
      record({ key: "b2", kind: "command", tool: "Bash", target: "docker logs" }),
    ]);

    const first = await run(h, ["observe", "actions", "--subject", A, "--json"]);
    const second = await run(h, ["observe", "actions", "--subject", B, "--json"]);
    const a = JSON.parse(first.stdout) as { counts: Record<string, { program: Record<string, number> }> };
    const b = JSON.parse(second.stdout) as { counts: Record<string, { program: Record<string, number> }> };

    expect(a.counts["2026-09"]?.program["git"]).toBe(1);
    expect(a.counts["2026-09"]?.program["docker"]).toBe(0);
    expect(b.counts["2026-09"]?.program["docker"]).toBe(2);
    expect(b.counts["2026-09"]?.program["git"]).toBe(0);
  });

  test("a subject id that could not be a directory name is a usage error", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "actions", "--subject", "Not/A/Subject"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid subject id");
  });
});

// ---------------------------------------------------------------------------
// Writing — the only path into a git working tree
// ---------------------------------------------------------------------------

describe("observe actions --write", () => {
  test("it says what a commit cannot undo *before* the file exists", async () => {
    const h = await harness();
    await store(h, A, [
      record({
        key: "a1",
        kind: "file-edit",
        tool: "mcp__acme__write",
        target: "clients/acme-corp/quarterly.ts",
      }),
      record({ key: "a2", kind: "command", tool: "Bash", target: "git commit" }),
    ]);
    const agent = join(h.home, "agent");

    const result = await run(h, ["observe", "actions", "--subject", A, "--write", agent]);
    const path = join(agent, "actions", "summary.json");

    expect(result.code).toBe(0);
    // Order, not just presence: a warning printed after the write is a warning
    // about something that has already happened.
    const warned = result.stdout.indexOf(GIT_UNDELETABLE[0]!);
    const wrote = result.stdout.indexOf("wrote ");
    expect(warned).toBeGreaterThan(-1);
    expect(wrote).toBeGreaterThan(warned);
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain("did not stage it and did not commit it");

    // And the file is JSON a person can read, carrying its own limits.
    const written = await Bun.file(path).text();
    const summary = JSON.parse(written) as { counts: Record<string, unknown>; limits: string[] };
    expect(summary.limits.length).toBeGreaterThan(0);
    expect(summary.counts["2026-09"]).toBeDefined();

    // Nothing in git's way: no repository was created and nothing was staged.
    expect(await tree(join(agent, ".git"))).toEqual([]);
  });

  test("the bytes on disk name no path, no project, no session and no subject", async () => {
    const h = await harness();
    await store(h, A, [
      record({
        key: "a1",
        kind: "file-edit",
        tool: "mcp__acme__write",
        target: "clients/acme-corp/quarterly.ts",
      }),
      record({ key: "a2", kind: "command", tool: "Bash", target: "ssh jump-host-of-a-client" }),
    ]);
    const agent = join(h.home, "agent");

    await run(h, ["observe", "actions", "--subject", A, "--write", agent]);
    const written = await Bun.file(join(agent, "actions", "summary.json")).text();

    for (
      const leak of [
        "acme",
        "someone",
        "9f3c7e10",
        "quarterly",
        "clients",
        "jump-host",
        "T10:00:00",
        "/invented",
        // I-3: the repository it sits in says whose it is. The file does not.
        "subject-a",
      ]
    ) {
      expect(written, leak).not.toContain(leak);
    }

    // The behaviour survived the trip.
    const summary = JSON.parse(written) as {
      counts: Record<string, { program: Record<string, number>; kind: Record<string, number> }>;
    };
    expect(summary.counts["2026-09"]?.kind["file-edit"]).toBe(1);
    expect(summary.counts["2026-09"]?.program["ssh"]).toBe(1);
  });

  test("an empty store writes nothing and exits 1, rather than committing zeros", async () => {
    const h = await harness();
    const agent = join(h.home, "agent");

    const result = await run(h, ["observe", "actions", "--subject", A, "--write", agent]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nothing to summarise");
    expect(result.stderr).toContain("observe enable");
    expect(await tree(agent)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The AC4 instrument, at the command line
// ---------------------------------------------------------------------------

describe("observe audit", () => {
  test("it refuses without a terminal, and says why there is no --yes", async () => {
    const h = await harness();
    const transcripts = join(h.home, "transcripts");
    await Bun.write(
      join(transcripts, "sess-a.jsonl"),
      `${JSON.stringify({
        uuid: "u-1",
        sessionId: "a",
        timestamp: "2026-09-20T09:00:00.000Z",
        cwd: "/invented/project",
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "invented" }] },
      })}\n`,
    );
    const before = await tree(transcripts);

    const result = await run(h, ["observe", "audit", "--vendor", "claude", "--root", transcripts]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("needs a terminal");
    expect(result.stderr).toContain("no --yes");
    expect(result.stderr).toContain("nothing was written");
    // It refuses before reading, so the transcripts are untouched either way.
    expect(await tree(transcripts)).toEqual(before);
  });

  test("--root has no default, and --vendor is one of two", async () => {
    const h = await harness();

    const noRoot = await run(h, ["observe", "audit", "--vendor", "claude"]);
    expect(noRoot.code).toBe(2);
    expect(noRoot.stderr).toContain("--root has no default");

    const badVendor = await run(h, ["observe", "audit", "--vendor", "codex", "--root", h.home]);
    expect(badVendor.code).toBe(2);
    expect(badVendor.stderr).toContain("--vendor is one of claude, grok");
  });

  test("both verbs are in the subcommand list an unknown one prints", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "nonsense"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("actions");
    expect(result.stderr).toContain("audit");
  });
});
