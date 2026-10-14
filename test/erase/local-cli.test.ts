/**
 * S7.1 / S7.2 and I-4 for the local backends: a turn on `claude-local` or `grok-local` leaves the vendor CLI's
 * transcripts of the subject's text in a home of Mind's own, and `erase` has to plan them, remove them and say which
 * it did — or name the ones that are still there.
 *
 * The hole these tests close: the home sits under the state root but not under any directory the data map names for
 * a subject, so `erase` neither planned nor removed it. The only thing that noticed was its last search, which found
 * the subject id in a transcript and turned the verdict into `erased-with-remainder` — a true report of a mess it
 * could have cleaned, and no report at all when the transcript did not carry the id.
 *
 * ## How the tests keep the map honest
 *
 * They do not write session files where the test believes the vendor writes. A real `LocalCliExec` runs the turn,
 * with a stand-in for the vendor binary, and the stand-in writes its transcripts wherever the exec told the vendor
 * to keep them (`HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `TMPDIR`). If `local-cli.ts` moves the home, or erase's
 * copy of the rule drifts, the transcripts land outside the map and these tests go red — which is the test S7.1
 * asked for: *a local-CLI turn cannot leave a subject's text outside the map.*
 *
 * Everything runs in a temporary HOME. No file of the owner's is read, and the key file is a fixture.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecBackend, TurnResult } from "../../src/exec/backend.ts";
import { LITELLM_KEY_FILE_ENV, LOCAL_BACKENDS, LocalCliExec, type LocalCliId } from "../../src/exec/local-cli.ts";
import type { VendorSpec } from "../../src/exec/registry.ts";
import { certificate, formatCertificate } from "../../src/erase/certificate.ts";
import { LOCAL_CLI_HOMES, localCliHomeDir } from "../../src/erase/local-cli-homes.ts";
import { ledgerBackends } from "../../src/erase/local-cli-plan.ts";
import { dataMap, subjectTrees } from "../../src/erase/map.ts";
import { commitErase, planErase, verifyErase, type EraseEnv } from "../../src/erase/plan.ts";
import { UNREPORTED_USAGE, subjectId, type SubjectId } from "../../src/types.ts";
import { append } from "../../src/ledger/store.ts";
import type { LedgerEntry } from "../../src/ledger/entry.ts";
import { RESTRAINED } from "../support/restraint.ts";

const SUBJECT = subjectId("example");
const NEIGHBOUR = subjectId("somebody-else");
/** Text that exists nowhere else, and that no needle of the run names: only the ledger can tie a home by it. */
const CANARY = "canary-7d3a91-local-cli-erase";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

interface Box {
  readonly home: string;
  readonly state: string;
  readonly env: EraseEnv;
  readonly work: string;
}

/** A temporary HOME with a fixture key file, and the environment both the exec and erase read. */
async function box(): Promise<Box> {
  const home = await mkdtemp(join(tmpdir(), "mind-erase-local-cli-"));
  scratch.push(home);
  const work = join(home, "work");
  await mkdir(work, { recursive: true });
  const keyFile = join(home, "fixture-litellm.env");
  await writeFile(keyFile, "LITELLM_API_KEY='synthetic-key-value'\n");
  const state = join(home, "state");
  const env: EraseEnv = {
    home,
    env: {
      XDG_STATE_HOME: state,
      XDG_DATA_HOME: join(home, "data"),
      [LITELLM_KEY_FILE_ENV]: keyFile,
      PATH: "/fixture/bin",
      USER: "fixture-user",
      // Nothing listens on port 9: the vector store is unreachable and is a note, not a refusal.
      MIND_QDRANT_URL: "http://127.0.0.1:9",
    },
    now: () => new Date("2026-10-13T10:00:00.000Z"),
  };
  return { home, state, env, work };
}

/** What a vendor stand-in was told: the child environment the exec built for it. */
interface Told {
  readonly spec: VendorSpec;
  readonly written: string[];
}

/**
 * The stand-in for the vendor binary. It writes what a vendor CLI writes on a turn — the session transcript, its
 * prompt history, a file of tool output in its temp directory — at the places the exec's child environment names, and
 * nowhere else. The text of the turn is in all of them.
 */
function vendorStandIn(told: Told[], files: "all" | "transcript"): (spec: VendorSpec) => ExecBackend {
  return (spec) => ({
    id: spec.id,
    display: spec.display,
    kind: "cli",
    identityStrength: spec.identity.strength,
    available: async () => ({ ok: true, detail: "/fixture/bin/vendor" }),
    run: async (request): Promise<TurnResult> => {
      const childEnv = spec.hardening?.env ?? {};
      const line = JSON.stringify({ type: "user", cwd: request.cwd ?? "", message: { content: request.prompt } }) + "\n";
      const written: string[] = [];
      const put = async (path: string, text: string): Promise<void> => {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, text);
        written.push(path);
      };
      if (spec.id === "claude-local") {
        await put(join(childEnv["CLAUDE_CONFIG_DIR"]!, "projects", "-fixture-work", "0a1b2c3d-fixture.jsonl"), line);
        if (files === "all") {
          await put(join(childEnv["CLAUDE_CONFIG_DIR"]!, "history.jsonl"), line);
          await put(join(childEnv["TMPDIR"]!, "tasks", "b1.output"), `ran: ${request.prompt}\n`);
        }
      } else {
        await put(join(childEnv["GROK_HOME"]!, "sessions", "fixture-session", "events.jsonl"), line);
        if (files === "all") await put(join(childEnv["TMPDIR"]!, "turn.log"), `${request.prompt}\n`);
      }
      told.push({ spec, written });
      return {
        backend: spec.id,
        text: "answered",
        confidence: "confirmed",
        identityStrength: spec.identity.strength,
        evidence: { source: spec.id, prompt: request.prompt, raw: "fixture" },
      };
    },
  });
}

/** A local turn for `subject`, run through the real `LocalCliExec`. Returns what the vendor stand-in wrote. */
async function localTurn(
  where: Box,
  id: LocalCliId,
  subject: SubjectId,
  prompt: string,
  files: "all" | "transcript" = "all",
): Promise<readonly string[]> {
  const told: Told[] = [];
  const backend = new LocalCliExec(id, {
    home: where.home,
    env: where.env.env,
    cwd: () => where.work,
    makeCli: vendorStandIn(told, files),
  });
  const result = await backend.run({ subject, prompt, restraint: RESTRAINED });
  expect(result.confidence).toBe("confirmed");
  expect(told).toHaveLength(1);
  return told[0]!.written;
}

/** The ledger line a recorded turn leaves: what `RecordingExec` writes, with the backend that ran it. */
function turnLine(subject: SubjectId, backend: string, n = 1): LedgerEntry {
  return {
    v: 1,
    kind: "turn",
    id: `${subject}-${n}`,
    turn: `${subject}-turn-${n}`,
    at: "2026-10-13T09:00:00.000Z",
    subject,
    backend,
    model: "local-coder",
    content: "withheld",
    prompt: null,
    prompt_bytes: 0,
    text: null,
    text_bytes: 0,
    confidence: "confirmed",
    exit: 0,
    duration_ms: 12,
    cost: null,
    usage: UNREPORTED_USAGE,
    identity: "system",
    soul_sha: null,
  };
}

function request(subject: SubjectId, over: Partial<Parameters<typeof planErase>[1]> = {}): Parameters<typeof planErase>[1] {
  return {
    subject,
    agentDir: null,
    scope: "all",
    by: "the local-cli erase test",
    needles: [],
    instructionFiles: [],
    soulName: null,
    personalValues: [],
    ...over,
  };
}

/** Every regular file under `root`, relative path to its bytes — to compare a tree before and after. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
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
      else if (entry.isFile()) out[path.slice(root.length)] = await readFile(path, "utf8");
    }
  };
  await walk(root);
  return out;
}

/** Plan, commit, re-read: the three functions the command runs, in its order. */
async function eraseIt(where: Box, req: Parameters<typeof planErase>[1]) {
  const plan = await planErase(where.env, req);
  expect(plan.refusals).toEqual([]);
  const result = await commitErase(plan);
  const verification = await verifyErase(plan, result);
  const cert = certificate({
    plan,
    result,
    verification,
    observedAccount: "fixture-user",
    engine: "test",
    issuedAt: "2026-10-13T10:00:01.000Z",
  });
  return { plan, result, verification, cert };
}

// ---------------------------------------------------------------------------
// S7.1 — the map names the homes, and names them where the exec writes
// ---------------------------------------------------------------------------

describe("S7.1 — the data map lists the local backends' homes, where the real exec keeps them", () => {
  test("the ids are the exec's own, and nothing else", () => {
    expect([...LOCAL_CLI_HOMES]).toEqual([...LOCAL_BACKENDS]);
  });

  for (const id of LOCAL_BACKENDS) {
    test(`${id}: the home the exec gives the vendor is the home the map names`, async () => {
      const where = await box();
      const written = await localTurn(where, id, SUBJECT, `a question about ${CANARY}`);
      const mapped = dataMap(where.env, SUBJECT, null).shared.find((tree) => tree.backend === id)!;

      expect(mapped.dir).toBe(localCliHomeDir(where.env, id));
      // The exec's own answer, not the test's belief: its fence says where the vendor may write.
      const prepared = new LocalCliExec(id, { home: where.home, env: where.env.env, cwd: () => where.work }).prepare({
        subject: SUBJECT,
        prompt: "x",
        restraint: RESTRAINED,
      });
      expect(prepared.fence?.writable[0]).toBe(mapped.dir);
      // Everything the vendor stand-in wrote, at the paths the exec's child environment named, is inside the entry.
      expect(written.length).toBeGreaterThan(1);
      for (const path of written) expect(path.startsWith(mapped.dir + "/"), path).toBe(true);
    });
  }

  test("each entry says how it travels, and is not a subject's own tree", () => {
    const map = dataMap({ home: "/h", env: {} }, SUBJECT, "/a");
    expect(map.shared.map((tree) => [tree.key, tree.backend, tree.dir, tree.travel.kind])).toEqual([
      ["local-claude", "claude-local", join("/h", ".local", "state", "mind", "vendors", "claude-local"), "stays"],
      ["local-grok", "grok-local", join("/h", ".local", "state", "mind", "vendors", "grok-local"), "stays"],
    ]);
    for (const tree of map.shared) {
      expect(tree.travel.kind === "stays" && tree.travel.why.length > 40).toBe(true);
      expect(tree.place).toBe("ledger");
      // Not in what erase removes for any subject without asking, and not in what deploy moves.
      expect(map.trees.map((entry) => entry.key)).not.toContain(tree.key);
      expect(subjectTrees({ home: "/h", env: {} }, SUBJECT, "/a", true).map((entry) => entry.dir)).not.toContain(tree.dir);
    }
  });
});

// ---------------------------------------------------------------------------
// S7.2 — planned, removed whole, said, and read back
// ---------------------------------------------------------------------------

describe("S7.2 — a local turn's transcripts are planned, removed and said to be", () => {
  for (const id of LOCAL_BACKENDS) {
    test(`${id}: tied by the subject's ledger alone — no needle in the text — it goes whole, and the verdict says which`, async () => {
      const where = await box();
      const written = await localTurn(where, id, SUBJECT, `${CANARY} and nothing that names the subject`);
      await append(where.env, turnLine(SUBJECT, id));
      const home = localCliHomeDir(where.env, id);
      const before = await snapshot(home);
      expect(Object.keys(before).length).toBeGreaterThan(1);

      // The dry run lists it, as a tree with its count, and says why, in the plan's notes.
      const plan = await planErase(where.env, request(SUBJECT));
      expect(plan.refusals).toEqual([]);
      const tree = plan.trees.find((entry) => entry.plan.dir === home);
      expect(tree).toBeDefined();
      // What the stand-in wrote, and the config file the exec writes into the home before every turn.
      expect(tree!.plan.before.files).toBe(written.length + 1);
      expect(tree!.label).toContain("shared by every subject");
      expect(plan.localCli.map((entry) => [entry.backend, entry.handling])).toEqual([[id, "removed-whole"]]);
      const note = plan.notes.find((entry) => entry.includes(home))!;
      expect(note).toContain("removed WHOLE, not per subject");
      expect(note).toContain("other subjects' transcripts in it go with it");
      expect(note).toContain("the subject's ledger names turns on " + id);
      // A dry run changes no byte.
      expect(await snapshot(home)).toEqual(before);

      const result = await commitErase(plan);
      const verification = await verifyErase(plan, result);
      expect(verification.leftover).toEqual([]);
      expect(verification.remainingFiles).toBe(0);
      expect(verification.verdict).toBe("erased-and-verified");
      expect(await snapshot(home)).toEqual({});
      expect((await lstat(home).catch(() => null))).toBeNull();
      // I-4's own words: search the state afterwards and the text is not there.
      expect(JSON.stringify(await snapshot(where.state))).not.toContain(CANARY);

      const cert = certificate({ plan, result, verification, observedAccount: "u", engine: "t", issuedAt: "2026-10-13T10:00:01.000Z" });
      expect(cert.statement.join("\n")).toContain(`${id}'s home was removed whole, not per subject`);
      expect(cert.statement.join("\n")).toContain("none is left");
      expect(cert.places.find((place) => place.place === "ledger")!.detail.join("\n")).toContain("removed whole");
      expect(formatCertificate(cert).join("\n")).toContain(`${id}'s own home, shared by every subject`);
    });
  }

  test("tied by the subject id in a transcript, with no ledger line at all", async () => {
    const where = await box();
    await localTurn(where, "claude-local", SUBJECT, `tell ${SUBJECT} ${CANARY}`);
    const { plan, verification } = await eraseIt(where, request(SUBJECT));
    const [home] = plan.localCli;
    expect(home!.handling).toBe("removed-whole");
    expect(home!.because.join(" ")).toContain("subject id");
    expect(verification.verdict).toBe("erased-and-verified");
    expect(JSON.stringify(await snapshot(where.state))).not.toContain(CANARY);
  });

  test("tied by a --needle that is in a transcript, when the ledger is gone and the id never appeared", async () => {
    const where = await box();
    await localTurn(where, "grok-local", SUBJECT, `${CANARY} only`);

    // Without the needle nothing ties the subject to the home: it is left, and said to be.
    const untied = await planErase(where.env, request(SUBJECT));
    expect(untied.localCli.map((entry) => entry.handling)).toEqual(["left-alone"]);

    const { plan, verification } = await eraseIt(where, request(SUBJECT, { needles: [CANARY] }));
    expect(plan.localCli.map((entry) => entry.handling)).toEqual(["removed-whole"]);
    expect(plan.localCli[0]!.because.join(" ")).toContain("--needle #1");
    // The needle's text is counted and never printed.
    expect(plan.notes.join("\n")).not.toContain(CANARY);
    expect(verification.verdict).toBe("erased-and-verified");
    expect(JSON.stringify(await snapshot(where.state))).not.toContain(CANARY);
  });

  test("the home is shared: a neighbour's transcripts in it go too, and the plan says so before it does it", async () => {
    const where = await box();
    await localTurn(where, "claude-local", NEIGHBOUR, `the neighbour wrote ${CANARY}-neighbour`);
    await localTurn(where, "claude-local", SUBJECT, `${SUBJECT} asked`);
    const plan = await planErase(where.env, request(SUBJECT));
    expect(plan.localCli[0]!.handling).toBe("removed-whole");
    expect(plan.notes.join("\n")).toContain("other subjects' transcripts in it go with it");
    const result = await commitErase(plan);
    const verification = await verifyErase(plan, result);
    expect(verification.verdict).toBe("erased-and-verified");
    expect(JSON.stringify(await snapshot(where.state))).not.toContain(`${CANARY}-neighbour`);
  });

  test("--personal removes it whole as well: a transcript cannot be split into personal and not", async () => {
    const where = await box();
    await localTurn(where, "claude-local", SUBJECT, `${SUBJECT} ${CANARY}`);
    const { plan, verification } = await eraseIt(where, request(SUBJECT, { scope: "personal" }));
    expect(plan.localCli[0]!.handling).toBe("removed-whole");
    expect(plan.notes.join("\n")).toContain("--personal removes claude-local's home whole as well");
    expect(verification.verdict).toBe("erased-and-verified");
    expect(JSON.stringify(await snapshot(where.state))).not.toContain(CANARY);
  });
});

// ---------------------------------------------------------------------------
// A home nothing ties to the subject: left alone, and said to be
// ---------------------------------------------------------------------------

describe("a home nothing ties to the subject is left alone, byte for byte, and the certificate says so", () => {
  test("a mistyped id touches nothing and comes back nothing-found, naming the transcripts it did not look into", async () => {
    const where = await box();
    await localTurn(where, "claude-local", NEIGHBOUR, `${NEIGHBOUR} wrote ${CANARY}`);
    await append(where.env, turnLine(NEIGHBOUR, "claude-local"));
    const home = localCliHomeDir(where.env, "claude-local");
    const before = await snapshot(where.state);

    const { plan, verification, cert } = await eraseIt(where, request(SUBJECT));
    expect(plan.localCli.map((entry) => entry.handling)).toEqual(["left-alone"]);
    expect(plan.trees.map((tree) => tree.plan.dir)).not.toContain(home);
    expect(verification.verdict).toBe("nothing-found");
    // Every byte, the neighbour's ledger included.
    expect(await snapshot(where.state)).toEqual(before);
    const said = cert.statement.join("\n");
    expect(said).toContain("NOT TOUCHED, AND NOT CERTIFIED");
    expect(said).toContain("--needle");
    expect(cert.notes.join("\n")).toContain(home);
  });

  test("a subject with data elsewhere is erased, the untied home stays, and the verdict does not pretend to cover it", async () => {
    const where = await box();
    await localTurn(where, "grok-local", NEIGHBOUR, `${CANARY}-neighbour`);
    await append(where.env, turnLine(SUBJECT, "ollama"));
    const home = localCliHomeDir(where.env, "grok-local");
    const before = await snapshot(home);

    const { verification, cert } = await eraseIt(where, request(SUBJECT));
    expect(verification.verdict).toBe("erased-and-verified");
    expect(await snapshot(home)).toEqual(before);
    expect(cert.statement.join("\n")).toContain("NOT TOUCHED, AND NOT CERTIFIED");
    expect(cert.statement.join("\n")).toContain("certifies nothing about those files");
  });

  test("the not-searched list says the cloud CLIs' transcripts are not covered, and what is covered of the local ones", async () => {
    const where = await box();
    const plan = await planErase(where.env, request(SUBJECT));
    const cert = certificate({ plan, result: null, verification: null, observedAccount: "u", engine: "t", issuedAt: "2026-10-13T10:00:00.000Z" });
    const text = cert.verification.notSearched.join("\n");
    expect(text).toContain("vendor transcripts of the cloud CLIs");
    expect(text).toContain("local backends' homes");
    expect(cert.verification.searched.join("\n")).toContain("vendors/claude-local");
  });
});

// ---------------------------------------------------------------------------
// The honest remainder
// ---------------------------------------------------------------------------

describe("a transcript that remains is named, and the verdict is never erased", () => {
  test("a file the filesystem will not unlink: counted, named by path, in the certificate's words", async () => {
    const where = await box();
    const written = await localTurn(where, "claude-local", SUBJECT, `${SUBJECT} ${CANARY}`);
    const transcript = written.find((path) => path.includes("projects"))!;
    const locked = join(transcript, "..");

    const plan = await planErase(where.env, request(SUBJECT));
    await chmod(locked, 0o500);
    try {
      const result = await commitErase(plan);
      const verification = await verifyErase(plan, result);
      expect(verification.verdict).toBe("erased-with-remainder");
      expect(verification.leftover.map((entry) => entry.path)).toContain(transcript);
      expect(verification.leftover.find((entry) => entry.path === transcript)!.tree).toContain("claude-local");
      expect(verification.failures).toBeGreaterThan(0);

      const cert = certificate({ plan, result, verification, observedAccount: "u", engine: "t", issuedAt: "2026-10-13T10:00:01.000Z" });
      expect(cert.verdict).toBe("erased-with-remainder");
      expect(cert.statement.join("\n")).toContain("TRANSCRIPTS REMAIN");
      expect(cert.statement.join("\n")).toContain("This subject is NOT erased from them");
      expect(cert.verification.where.some((line) => line.startsWith(transcript))).toBe(true);
      expect(formatCertificate(cert).join("\n")).toContain(transcript);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  test("the control: a transcript the map does not name is found by the search and turns the verdict, with its path", async () => {
    // What a moved home would look like: the vendor writes the subject's text somewhere under the state root that
    // no entry of the map resolves. The map cannot name it; the search must, and the verdict must not be erased.
    const where = await box();
    await append(where.env, turnLine(SUBJECT, "ollama"));
    const stray = join(where.state, "mind", "vendors", "moved-elsewhere", ".claude", "projects", "p", "s.jsonl");
    await mkdir(join(stray, ".."), { recursive: true });
    await writeFile(stray, `{"type":"user","message":{"content":"${SUBJECT} ${CANARY}"}}\n`);

    const { verification, cert } = await eraseIt(where, request(SUBJECT));
    expect(verification.verdict).toBe("erased-with-remainder");
    expect(verification.search.deletableHits).toBeGreaterThan(0);
    expect(cert.verification.where.some((line) => line.startsWith(stray))).toBe(true);
    expect(await Bun.file(stray).exists()).toBe(true);
  });

  test("a home that is a symlink is refused before anything is deleted — erase will not remove through a link", async () => {
    const where = await box();
    const target = join(where.home, "elsewhere");
    await mkdir(join(target, "projects"), { recursive: true });
    await writeFile(join(target, "projects", "s.jsonl"), `${SUBJECT}\n`);
    const home = localCliHomeDir(where.env, "claude-local");
    await mkdir(join(home, ".."), { recursive: true });
    await symlink(target, home);

    const plan = await planErase(where.env, request(SUBJECT));
    expect(plan.refusals.join("\n")).toContain("is a symlink");
    expect(await Bun.file(join(target, "projects", "s.jsonl")).exists()).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)("a home that cannot be read refuses the run: it is neither tied nor cleared", async () => {
    const where = await box();
    await localTurn(where, "claude-local", SUBJECT, `${SUBJECT}`);
    const home = localCliHomeDir(where.env, "claude-local");
    await chmod(home, 0o000);
    try {
      const plan = await planErase(where.env, request(SUBJECT));
      expect(plan.localCli.map((entry) => entry.handling)).toEqual(["unreadable"]);
      expect(plan.refusals.join("\n")).toContain("could not be read");
      expect(plan.refusals.join("\n")).toContain("Nothing was certified");
    } finally {
      await chmod(home, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// The ledger reader that ties a home
// ---------------------------------------------------------------------------

describe("ledgerBackends reads only this subject's lines, and tolerates what it cannot read", () => {
  test("backends of the subject's lines; other subjects, garbage, other files and a missing directory add nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-erase-ledger-backends-"));
    scratch.push(dir);
    await writeFile(
      join(dir, "2026-10.jsonl"),
      [
        JSON.stringify({ subject: SUBJECT, backend: "claude-local" }),
        JSON.stringify({ subject: NEIGHBOUR, backend: "grok-local" }),
        "not json at all",
        JSON.stringify(["an", "array"]),
        "null",
        JSON.stringify({ subject: SUBJECT, backend: 7 }),
        "",
        JSON.stringify({ subject: SUBJECT, backend: "ollama" }),
      ].join("\n"),
    );
    await writeFile(join(dir, "notes.txt"), JSON.stringify({ subject: SUBJECT, backend: "grok-local" }));
    expect([...(await ledgerBackends(dir, SUBJECT))].sort()).toEqual(["claude-local", "ollama"]);
    expect([...(await ledgerBackends(join(dir, "nowhere"), SUBJECT))]).toEqual([]);
  });
});
