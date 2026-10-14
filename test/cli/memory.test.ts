/**
 * `mind memory index` and `memory search`, spawned the way a person runs
 * them — S4.1 (D-037, D-038).
 *
 * Two stand-in servers on loopback play Ollama and Qdrant, so the whole path
 * runs without this machine's own: the embed model answers with a vector that
 * is a function of the text, and the store keeps collections in a map and
 * records every request. That record is what S1.6 AC4 is checked against — a
 * recall for B makes no request that names A's collection.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const DEAD = "http://127.0.0.1:9";

const scratch: string[] = [];
const servers: { stop: (force: boolean) => void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-memory-"));
  scratch.push(dir);
  return dir;
}

async function run(home: string, args: readonly string[], env: Record<string, string>) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: home,
    env: {
      HOME: home,
      PATH: `${dirname(BUN)}:${process.env["PATH"] ?? ""}`,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** An agent repository with only what `memory` reads. */
async function agentWith(home: string, files: Record<string, string>): Promise<string> {
  const agent = join(home, "agent");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(agent, rel)), { recursive: true });
    await Bun.write(join(agent, rel), text);
  }
  return agent;
}

/** A 1024-vector that depends on which of a few words the text contains. */
function vectorFor(text: string): number[] {
  const v = new Array<number>(1024).fill(0.001);
  ["port", "deploy", "ทอง", "สวัสดี"].forEach((word, i) => {
    if (text.includes(word)) v[i] = 1;
  });
  return v;
}

function standIns() {
  const collections = new Map<string, Map<string, { vector: number[]; payload: unknown }>>();
  const asked: string[] = [];
  const embed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; input: string[] };
      asked.push(`embed ${body.model} ${body.input.length}`);
      return Response.json({ model: body.model, embeddings: body.input.map(vectorFor) });
    },
  });
  const qdrant = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      asked.push(`${req.method} ${url.pathname}`);
      const [, , name, rest] = url.pathname.split("/");
      const col = collections.get(name ?? "");
      if (rest === undefined) {
        if (req.method === "GET") {
          return col === undefined
            ? new Response("{}", { status: 404 })
            : Response.json({ result: { points_count: col.size } });
        }
        if (req.method === "DELETE") {
          collections.delete(name ?? "");
          return Response.json({ result: true });
        }
        if (req.method === "PUT") {
          collections.set(name ?? "", new Map());
          return Response.json({ result: true });
        }
      }
      if (col === undefined) return new Response("{}", { status: 404 });
      if (req.method === "PUT") {
        const body = (await req.json()) as { points: { id: string; vector: number[]; payload: unknown }[] };
        for (const p of body.points) col.set(p.id, { vector: p.vector, payload: p.payload });
        return Response.json({ result: { status: "completed" } });
      }
      if (req.method === "POST") {
        const body = (await req.json()) as { vector: number[]; limit: number };
        const scored = [...col.entries()]
          .map(([id, p]) => ({ id, payload: p.payload, score: p.vector.reduce((t, x, i) => t + x * (body.vector[i] ?? 0), 0) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, body.limit);
        return Response.json({ result: scored });
      }
      return new Response("", { status: 405 });
    },
  });
  servers.push(embed, qdrant);
  return {
    env: { MIND_EMBED_URL: `http://127.0.0.1:${embed.port}`, MIND_QDRANT_URL: `http://127.0.0.1:${qdrant.port}` },
    collections,
    asked,
  };
}

const MEMORY = {
  "memory/ops.md": "# Ports\n\nThe dashboard listens on port 30600.\n\n## Deploy\n\nRun deploy.sh from the Mac.\n",
  "memory/th.md": "# ราคา\n\nราคาทองวันนี้ขึ้น AIT-52\n",
};

describe("memory index", () => {
  test("with no servers: the full-text half is built, the vector half says why not, exit 0", async () => {
    const home = await sandbox();
    const agent = await agentWith(home, MEMORY);

    const result = await run(home, ["memory", "index", agent, "--subject", "alpha"], {
      MIND_EMBED_URL: DEAD,
      MIND_QDRANT_URL: DEAD,
    });

    expect(result.code, result.stderr).toBe(0);
    // The list comes before anything is embedded.
    expect(result.stdout.indexOf("cannot reach")).toBeLessThan(result.stdout.indexOf("full-text"));
    expect(result.stdout).toContain("2 file(s) · 3 piece(s)");
    expect(result.stdout).toContain("full-text  3 piece(s)");
    expect(result.stdout).toContain("vectors    not built");
    expect(await Bun.file(join(agent, ".mind", "index", "fts.sqlite")).exists()).toBe(true);
  }, 60_000);

  test("a name is not a loopback literal, so the vector half is refused before any request", async () => {
    const home = await sandbox();
    const agent = await agentWith(home, MEMORY);
    const result = await run(home, ["memory", "index", agent, "--subject", "alpha"], {
      MIND_EMBED_URL: "http://localhost:11435",
    });
    expect(result.stdout).toContain("MIND_EMBED_URL");
    expect(result.stdout).toContain("not a loopback literal");
  }, 60_000);

  test("with both servers: one collection per subject, and the marker is written", async () => {
    const home = await sandbox();
    const agent = await agentWith(home, MEMORY);
    const s = standIns();

    const result = await run(home, ["memory", "index", agent, "--subject", "alpha"], s.env);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("vectors    3 point(s) → mind__alpha");
    expect([...s.collections.keys()]).toEqual(["mind__alpha"]);
    expect(await Bun.file(join(home, "state", "mind", "rag", "alpha", "collection.json")).exists()).toBe(true);
    expect(s.asked).toContain("embed bge-m3 3");
  }, 60_000);
});

describe("memory search", () => {
  test("Thai, a ticket number and a meaning all come back, each saying which index found it", async () => {
    const home = await sandbox();
    const agent = await agentWith(home, MEMORY);
    const s = standIns();
    await run(home, ["memory", "index", agent, "--subject", "alpha"], s.env);

    const thai = await run(home, ["memory", "search", agent, "--subject", "alpha", "ราคาทอง"], s.env);
    expect(thai.code, thai.stderr).toBe(0);
    expect(thai.stdout).toContain("memory/th.md");
    expect(thai.stdout).toContain("fts");

    const ticket = await run(home, ["memory", "search", agent, "--subject", "alpha", "AIT-52"], s.env);
    expect(ticket.stdout.split("\n")[0]).toContain("memory/th.md");

    const meaning = await run(home, ["memory", "search", agent, "--subject", "alpha", "deploy"], s.env);
    expect(meaning.stdout).toContain("Deploy");
    expect(meaning.stdout).toContain("vector");
  }, 60_000);

  test("S1.6 AC4 — B's recall makes no request that names A's collection", async () => {
    const home = await sandbox();
    const a = await agentWith(home, MEMORY);
    const s = standIns();
    await run(home, ["memory", "index", a, "--subject", "alpha"], s.env);

    const bHome = await sandbox();
    const b = await agentWith(bHome, { "memory/b.md": "# B\n\nnothing about ports here\n" });
    await run(bHome, ["memory", "index", b, "--subject", "beta"], s.env);

    s.asked.length = 0;
    const result = await run(bHome, ["memory", "search", b, "--subject", "beta", "port"], s.env);
    expect(result.stdout).not.toContain("30600");
    expect(s.asked.some((line) => line.includes("mind__alpha"))).toBe(false);
    expect(s.asked.some((line) => line.includes("mind__beta"))).toBe(true);
  }, 60_000);

  test("before any index, with no vector store either: nothing searched, exit 3, and it says what to run", async () => {
    const home = await sandbox();
    const agent = await agentWith(home, MEMORY);
    const result = await run(home, ["memory", "search", agent, "--subject", "alpha", "port"], {
      MIND_EMBED_URL: DEAD,
      MIND_QDRANT_URL: DEAD,
    });
    expect(result.code).toBe(3);
    expect(result.stdout.trim()).toBe("nothing searched");
    expect(result.stderr).toContain("mind memory index");
    expect(result.stderr).toContain("vector half skipped");
  }, 60_000);

  test("usage errors are usage errors", async () => {
    const home = await sandbox();
    for (const args of [
      ["memory", "index"],
      ["memory", "index", "x", "y", "--subject", "a"],
      ["memory", "index", "x", "--subject", "Not Valid"],
      ["memory", "search", "x", "--subject", "a"],
      ["memory", "search", "x", "--subject", "a", "--limit", "0", "q"],
      ["memory", "wat"],
    ]) {
      const result = await run(home, args, { MIND_EMBED_URL: DEAD, MIND_QDRANT_URL: DEAD });
      expect(result.code, args.join(" ")).toBe(2);
    }
  }, 60_000);
});

describe("memory ingest", () => {
  /** An agent with a soul (subject `example`) and, unless told otherwise, a basis for memory (S7.3). */
  async function ingestAgent(home: string, uses: readonly string[] | null = ["memory"], extra: Record<string, unknown> = {}): Promise<string> {
    const agent = join(home, "agent");
    await cp(join(import.meta.dir, "..", "fixtures", "soul-valid"), join(agent, "soul"), { recursive: true });
    if (uses !== null) {
      await mkdir(join(home, "state", "mind", "basis", "example"), { recursive: true });
      await Bun.write(
        join(home, "state", "mind", "basis", "example", "records.json"),
        JSON.stringify([{ id: "b1", subject: "example", basis: "owner", approvedBy: "test", at: "2026-09-25T00:00:00Z", uses, expires: null, note: "", revokedAt: null, ...extra }]),
      );
    }
    return agent;
  }

  async function notes(home: string): Promise<string> {
    const src = join(home, "notes");
    await mkdir(src, { recursive: true });
    await Bun.write(join(src, "infra.md"), "# Ports\n\ndashboard on 30600\n");
    await Bun.write(join(src, "creds.md"), "# DB\n\npostgres://app:hunter22-x@db.invalid/main\n");
    return src;
  }

  test("without --yes: the plan, the blocked file named without its secret, nothing written, exit 1", async () => {
    const home = await sandbox();
    const agent = await ingestAgent(home);
    const src = await notes(home);

    const result = await run(home, ["memory", "ingest", agent, "--from", src], { MIND_QDRANT_URL: DEAD });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("memory/imported/notes");
    expect(result.stdout).toContain("+ memory/imported/notes/infra.md");
    expect(result.stdout).toContain("! memory/imported/notes/creds.md:3  url-credentials");
    expect(result.stdout).not.toContain("hunter22");
    expect(result.stdout).toContain("Nothing was written.");
    expect(await Bun.file(join(agent, "memory", "imported", "notes", "infra.md")).exists()).toBe(false);
  }, 60_000);

  test("--yes writes the clean files only, says what git keeps first, and index reads them", async () => {
    const home = await sandbox();
    const agent = await ingestAgent(home);
    const src = await notes(home);

    const result = await run(home, ["memory", "ingest", agent, "--from", src, "--name", "owner", "--yes"], {
      MIND_QDRANT_URL: DEAD,
    });

    expect(result.stdout.indexOf("what a commit puts beyond")).toBeLessThan(result.stdout.indexOf("wrote 1 file(s)"));
    expect(await Bun.file(join(agent, "memory", "imported", "owner", "infra.md")).exists()).toBe(true);
    expect(await Bun.file(join(agent, "memory", "imported", "owner", "creds.md")).exists()).toBe(false);

    const indexed = await run(home, ["memory", "index", agent, "--subject", "alpha"], {
      MIND_EMBED_URL: DEAD,
      MIND_QDRANT_URL: DEAD,
    });
    expect(indexed.stdout).toContain("1 file(s) · 1 piece(s)");
  }, 60_000);

  test("usage: no --from, a bad --name, and a source that is not there", async () => {
    const home = await sandbox();
    const agent = await ingestAgent(home);
    for (const args of [
      ["memory", "ingest", agent],
      ["memory", "ingest", agent, "--from", home, "--name", "Bad Name"],
    ]) {
      expect((await run(home, args, {})).code, args.join(" ")).toBe(2);
    }
    const missing = await run(home, ["memory", "ingest", agent, "--from", join(home, "nope")], {});
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("mind:");
  }, 60_000);

  test("S7.3: no basis, a basis for another use, an expired or revoked one — nothing is read", async () => {
    for (const [uses, extra, says] of [
      [null, {}, "there is no basis on record"],
      [["persona"], {}, "allows persona — not memory"],
      [["memory"], { expires: "2020-01-01" }, "expired or been revoked"],
      [["memory"], { revokedAt: "2026-09-25T01:00:00Z" }, "expired or been revoked"],
    ] as const) {
      const home = await sandbox();
      const agent = await ingestAgent(home, uses as readonly string[] | null, extra);
      const src = await notes(home);
      const result = await run(home, ["memory", "ingest", agent, "--from", src, "--yes"], { MIND_QDRANT_URL: DEAD });
      expect(result.code, says).toBe(1);
      expect(result.stderr).toContain(says);
      expect(result.stderr).toContain("Nothing was read (S7.3)");
      expect(result.stdout).not.toContain("infra.md");
      expect(await Bun.file(join(agent, "memory", "imported", "notes", "infra.md")).exists()).toBe(false);
    }
    const bare = await sandbox();
    const noSoul = await agentWith(bare, {});
    expect((await run(bare, ["memory", "ingest", noSoul, "--from", await notes(bare)], {})).stderr).toContain("no soul that names its subject");
  }, 120_000);
});

describe("memory forget", () => {
  test("plan without --yes; with --yes the file goes, both indexes are rebuilt, and the look again is clean", async () => {
    const home = await sandbox();
    const agent = await agentWith(home, MEMORY);
    const s = standIns();
    await run(home, ["memory", "index", agent, "--subject", "alpha"], s.env);
    expect([...(s.collections.get("mind__alpha")?.keys() ?? [])].length).toBe(3);

    const dry = await run(home, ["memory", "forget", agent, "--subject", "alpha", "--match", "ทอง"], s.env);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("- memory/th.md  (line 3)");
    expect(dry.stdout).not.toContain("ราคาทองวันนี้");
    expect(dry.stdout).toContain("Nothing was removed.");
    expect(await Bun.file(join(agent, "memory", "th.md")).exists()).toBe(true);

    const done = await run(home, ["memory", "forget", agent, "--subject", "alpha", "--match", "ทอง", "--yes"], s.env);
    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toContain("collection dropped whole and rebuilt with 2 point(s)");
    expect(done.stdout).toContain("0 file(s) still matching · 0 full-text hit(s) · 2 point(s) for 2 piece(s)");
    expect(await Bun.file(join(agent, "memory", "th.md")).exists()).toBe(false);
    expect([...(s.collections.get("mind__alpha")?.values() ?? [])].some((p) => JSON.stringify(p.payload).includes("ทอง"))).toBe(false);
  }, 60_000);

  test("nothing matching, both selectors, and neither, are refusals", async () => {
    const home = await sandbox();
    const agent = await agentWith(home, MEMORY);
    const env = { MIND_EMBED_URL: DEAD, MIND_QDRANT_URL: DEAD };
    const none = await run(home, ["memory", "forget", agent, "--subject", "alpha", "--match", "zzzzzz"], env);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("nothing under memory/ matched");
    for (const args of [
      ["memory", "forget", agent, "--subject", "alpha"],
      ["memory", "forget", agent, "--subject", "alpha", "--match", "x", "--file", "memory/th.md"],
    ]) {
      expect((await run(home, args, env)).code, args.join(" ")).toBe(2);
    }
    const outside = await run(home, ["memory", "forget", agent, "--subject", "alpha", "--file", "soul/role.md"], env);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain("only a file under memory/");
  }, 60_000);
});

describe("memory write (D-081)", () => {
  test("plan, then --yes writes and rebuilds full-text; a basis is required; a bad path or a credential is refused", async () => {
    const home = await sandbox();
    const agent = join(home, "agent");
    await cp(join(import.meta.dir, "..", "fixtures", "soul-valid"), join(agent, "soul"), { recursive: true });
    const src = join(home, "note.md");
    await Bun.write(src, "# Queue\n\nThe queue restarts at noon.\n");
    const args = ["memory", "write", agent, "--subject", "example", "--file", "memory/notes/queue.md", "--from", src];
    const noBasis = await run(home, [...args, "--yes"], { MIND_QDRANT_URL: DEAD });
    expect(noBasis.code).toBe(1);
    expect(noBasis.stderr).toContain("no basis");
    await mkdir(join(home, "state", "mind", "basis", "example"), { recursive: true });
    await Bun.write(join(home, "state", "mind", "basis", "example", "records.json"), JSON.stringify([{ id: "b1", subject: "example", basis: "owner", approvedBy: "t", at: "2026-09-26T00:00:00Z", uses: ["memory"], expires: null, note: "", revokedAt: null }]));
    const dry = await run(home, args, { MIND_QDRANT_URL: DEAD });
    expect(dry.stdout).toContain("new memory/notes/queue.md");
    expect(await Bun.file(join(agent, "memory", "notes", "queue.md")).exists()).toBe(false);
    const wet = await run(home, [...args, "--yes"], { MIND_QDRANT_URL: DEAD });
    expect(wet.code, wet.stderr).toBe(0);
    expect(wet.stdout).toContain("full-text");
    const found = await run(home, ["memory", "search", agent, "--subject", "example", "noon"], { MIND_QDRANT_URL: DEAD });
    expect(found.stdout).toContain("memory/notes/queue.md");
    expect((await run(home, ["memory", "write", agent, "--subject", "example", "--file", "soul/role.md", "--from", src, "--yes"], { MIND_QDRANT_URL: DEAD })).code).toBe(1);
    await Bun.write(src, `token: ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\n`);
    const secret = await run(home, [...args, "--yes"], { MIND_QDRANT_URL: DEAD });
    expect(secret.code).toBe(1);
    expect(secret.stderr).toContain("credential");
    expect((await run(home, ["memory", "write", agent, "--subject", "example"], {})).code).toBe(2);
  }, 60_000);
});


describe("memory import (D-084)", () => {
  test("plan, then --yes writes under memory/knowledge/ (D-090) and indexes it; a basis is required; bad sources are refused", async () => {
    const home = await sandbox();
    const agent = join(home, "agent");
    await cp(join(import.meta.dir, "..", "fixtures", "soul-valid"), join(agent, "soul"), { recursive: true });
    const src = join(home, "upload.html");
    await Bun.write(src, "<title>Backup plan</title><main><h1>Backup plan</h1><p>The backup runs at 02:00 nightly.</p></main>");
    const args = ["memory", "import", agent, "--subject", "example", "--from", src, "--name", "backup.html"];
    const noBasis = await run(home, args, { MIND_QDRANT_URL: DEAD });
    expect(noBasis.code).toBe(1);
    expect(noBasis.stderr).toContain("no basis");
    await mkdir(join(home, "state", "mind", "basis", "example"), { recursive: true });
    await Bun.write(join(home, "state", "mind", "basis", "example", "records.json"), JSON.stringify([{ id: "b1", subject: "example", basis: "owner", approvedBy: "t", at: "2026-09-26T00:00:00Z", uses: ["memory"], expires: null, note: "", revokedAt: null }]));
    const dry = await run(home, args, { MIND_QDRANT_URL: DEAD });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("read html → markdown · 1 memory file(s)");
    expect(dry.stdout).toContain("new memory/knowledge/backup-plan.md");
    expect(await Bun.file(join(agent, "memory", "knowledge", "backup-plan.md")).exists()).toBe(false);
    const wet = await run(home, [...args, "--yes"], { MIND_QDRANT_URL: DEAD });
    expect(wet.code, wet.stderr).toBe(0);
    const written = await Bun.file(join(agent, "memory", "knowledge", "backup-plan.md")).text();
    expect(written).toContain('source: "backup.html"');
    expect(written).toContain("The backup runs at 02:00 nightly.");
    const found = await run(home, ["memory", "search", agent, "--subject", "example", "nightly"], { MIND_QDRANT_URL: DEAD });
    expect(found.stdout).toContain("memory/knowledge/backup-plan.md");
    expect((await run(home, args, { MIND_QDRANT_URL: DEAD })).stdout).toContain("memory/knowledge/backup-plan-2.md");
    const url = await run(home, ["memory", "import", agent, "--subject", "example", "--url", "file:///etc/passwd"], {});
    expect(url.code).toBe(1);
    expect(url.stderr).toContain("only http and https");
    await Bun.write(src, `key ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\n`);
    const secret = await run(home, ["memory", "import", agent, "--subject", "example", "--from", src, "--name", "leak.txt", "--yes"], { MIND_QDRANT_URL: DEAD });
    expect(secret.code).toBe(1);
    expect(secret.stdout).toContain("REFUSED");
    expect(await Bun.file(join(agent, "memory", "knowledge", "leak.md")).exists()).toBe(false);
    expect((await run(home, ["memory", "import", agent, "--subject", "example"], {})).code).toBe(2);
  }, 60_000);
});

describe("memory move and search --scope (D-090)", () => {
  test("a note moved into knowledge is found by --scope knowledge and not by --scope memory; bad asks refused", async () => {
    const home = await sandbox();
    const agent = join(home, "agent");
    await cp(join(import.meta.dir, "..", "fixtures", "soul-valid"), join(agent, "soul"), { recursive: true });
    await mkdir(join(agent, "memory", "notes"), { recursive: true });
    await Bun.write(join(agent, "memory", "notes", "manual.md"), "# Manual\n\nThe kiln heats to 1200 degrees.\n");
    await Bun.write(join(agent, "memory", "notes", "diary.md"), "# Diary\n\nI fired the kiln on Monday.\n");
    const args = ["memory", "move", agent, "--subject", "example", "--file", "memory/notes/manual.md", "--to", "knowledge"];
    expect((await run(home, args, { MIND_QDRANT_URL: DEAD })).stderr).toContain("no basis");
    await mkdir(join(home, "state", "mind", "basis", "example"), { recursive: true });
    await Bun.write(join(home, "state", "mind", "basis", "example", "records.json"), JSON.stringify([{ id: "b1", subject: "example", basis: "owner", approvedBy: "t", at: "2026-09-26T00:00:00Z", uses: ["memory"], expires: null, note: "", revokedAt: null }]));
    const dry = await run(home, args, { MIND_QDRANT_URL: DEAD });
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("move memory/notes/manual.md → memory/knowledge/manual.md (memory → knowledge)");
    const wet = await run(home, [...args, "--yes"], { MIND_QDRANT_URL: DEAD });
    expect(wet.code, wet.stderr).toBe(0);
    expect(await Bun.file(join(agent, "memory", "knowledge", "manual.md")).exists()).toBe(true);
    const search = (scope: string) => run(home, ["memory", "search", agent, "--subject", "example", "--scope", scope, "kiln"], { MIND_QDRANT_URL: DEAD });
    const k = await search("knowledge");
    expect(k.stdout).toContain("memory/knowledge/manual.md");
    expect(k.stdout).not.toContain("diary.md");
    const m = await search("memory");
    expect(m.stdout).toContain("memory/notes/diary.md");
    expect(m.stdout).not.toContain("manual.md");
    expect((await search("all")).stdout).toContain("manual.md");
    expect((await search("elsewhere")).code).toBe(2);
    expect((await run(home, ["memory", "move", agent, "--subject", "example", "--file", "memory/notes/diary.md", "--to", "memory/knowledge/manual.md"], {})).stderr).toContain("already a memory");
    expect((await run(home, ["memory", "move", agent, "--subject", "example"], {})).code).toBe(2);
  }, 60_000);
});

describe("memory who (D-092)", () => {
  test("names each memory and line that mentions a port; exit 1 when nothing does", async () => {
    const home = await sandbox();
    const agent = join(home, "agent");
    await mkdir(join(agent, "memory", "notes"), { recursive: true });
    await Bun.write(join(agent, "memory", "notes", "vllm.md"), "# vLLM\n\nbind 127.0.0.1:10410\n");
    const hit = await run(home, ["memory", "who", agent, "port", "10410"], {});
    expect(hit.code, hit.stderr).toBe(0);
    expect(hit.stdout).toContain("port 10410 — 1 memory");
    expect(hit.stdout).toContain("memory/notes/vllm.md:3");
    expect((await run(home, ["memory", "who", agent, "9999"], {})).code).toBe(1);
    expect((await run(home, ["memory", "who", agent], {})).code).toBe(2);
  }, 30_000);
});
