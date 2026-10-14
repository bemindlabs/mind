/**
 * S1.5 — `soul revoke` puts every file `soul apply` touched back, byte for
 * byte, and afterwards `soul verify` no longer passes.
 *
 * The vendor is a stub `claude` that behaves like a model reading its
 * instruction file: it answers with the soul's facts only while
 * `~/.claude/CLAUDE.md` carries the soul. So verify passing before, and
 * failing after, is a statement about the file — which is what AC2 is about.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SOUL_B = join(ROOT, "test", "fixtures", "soul-valid-b");
const HUMAN = join(ROOT, "test", "fixtures", "instructions", "human-200.md");

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

const STUB = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
let file = "";
try { file = readFileSync(process.env.HOME + "/.claude/CLAUDE.md", "utf8"); } catch {}
const nonce = (prompt.match(/nothing else: (\\S+) followed/) ?? [])[1] ?? "";
const which = prompt.includes("call the person") ? 0 : prompt.includes("refer to yourself") ? 1 : 2;
const knows = file.includes("Example Keeper");
const said = knows
  ? ["friend", "the keeper", "never deletes data without an explicit confirmation"][which]
  : "I have no standing instructions about that";
console.log(JSON.stringify({ result: nonce + " " + said }));
`;

async function home(withHuman: boolean) {
  const h = await mkdtemp(join(tmpdir(), "mind-revoke-"));
  scratch.push(h);
  await mkdir(join(h, ".claude"), { recursive: true });
  if (withHuman) await writeFile(join(h, ".claude", "CLAUDE.md"), await readFile(HUMAN, "utf8"));
  const bin = join(h, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "claude"), STUB);
  await chmod(join(bin, "claude"), 0o755);
  const env = {
    HOME: h,
    PATH: `${bin}:${await barePath(h)}`,
    XDG_STATE_HOME: join(h, "state"),
    XDG_DATA_HOME: join(h, "data"),
  };
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  return { h, run, file: join(h, ".claude", "CLAUDE.md") };
}

const apply = (soul = SOUL, subject = "example") => ["soul", "apply", soul, "--subject", subject, "--backend", "claude", "--apply"];
const verify = ["soul", "verify", SOUL, "--subject", "example", "--backend", "claude", "--runs", "1"];
const revoke = (...extra: string[]) => ["soul", "revoke", "--subject", "example", "--backend", "claude", ...extra];

describe("soul revoke", () => {
  test("AC1+AC2: a human's file comes back byte-identical, and verify stops passing", async () => {
    const { run, file } = await home(true);
    const original = await Bun.file(file).bytes();

    expect((await run(apply())).code).toBe(0);
    expect(Buffer.compare(Buffer.from(await Bun.file(file).bytes()), Buffer.from(original))).not.toBe(0);
    // The control: with the block in place the stub knows the soul.
    expect((await run(verify)).code, "verify must pass before revoke, or AC2 proves nothing").toBe(0);

    const dry = await run(revoke());
    expect(dry.stdout).toContain("strip");
    expect(dry.stdout).toContain("back to what it was before apply");
    expect(dry.stdout).toContain("Nothing was written");

    const done = await run(revoke("--apply"));
    expect(done.code, done.stderr).toBe(0);
    expect(Buffer.compare(Buffer.from(await Bun.file(file).bytes()), Buffer.from(original))).toBe(0);

    expect((await run(verify)).code).not.toBe(0);
  }, 120_000);

  test("a file apply created, and that holds nothing else, is removed — absent is what it was", async () => {
    const { run, file } = await home(false);
    expect((await run(apply())).code).toBe(0);
    expect(await Bun.file(file).exists()).toBe(true);

    const done = await run(revoke("--apply"));
    expect(done.stdout).toContain("delete");
    expect(await Bun.file(file).exists()).toBe(false);
  }, 120_000);

  test("edits made around the block since apply stay, and it says the file is not what it was", async () => {
    const { run, file } = await home(true);
    await run(apply());
    await writeFile(file, `${await Bun.file(file).text()}\nmy own later note\n`);

    const done = await run(revoke("--apply"));
    expect(done.stdout).toContain("edited since apply; the edits stay");
    const after = await Bun.file(file).text();
    expect(after).toContain("my own later note");
    expect(after).not.toContain("Example Keeper");
  }, 120_000);

  test("another subject's block is left byte-identical (I-3)", async () => {
    const { run, file } = await home(true);
    expect((await run(apply(SOUL_B, "other-example"))).code).toBe(0);
    const before = await Bun.file(file).bytes();

    const done = await run(revoke("--apply"));
    expect(done.stdout).toContain("other-subject");
    expect(Buffer.compare(Buffer.from(await Bun.file(file).bytes()), Buffer.from(before))).toBe(0);
  }, 120_000);

  test("a block edited by hand refuses the whole run and writes nothing", async () => {
    const { run, file } = await home(true);
    await run(apply());
    const text = await Bun.file(file).text();
    await writeFile(file, text.replace("Example Keeper", "Example Keeper (tweaked)"));
    const before = await Bun.file(file).bytes();

    const done = await run(revoke("--apply"));
    expect(done.code).toBe(1);
    expect(done.stderr).toContain("all or nothing");
    expect(Buffer.compare(Buffer.from(await Bun.file(file).bytes()), Buffer.from(before))).toBe(0);
  }, 120_000);

  test("nothing applied: it says so and exits 0", async () => {
    const { run } = await home(true);
    const done = await run(revoke());
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("no block of this subject");
  }, 60_000);

  test("usage", async () => {
    const { run } = await home(true);
    expect((await run(["soul", "revoke"])).code).toBe(2);
    expect((await run(["soul", "revoke", "x", "--subject", "example"])).code).toBe(2);
    expect((await run(["soul", "revoke", "--subject", "example", "--backend", "nope"])).code).toBe(2);
  }, 60_000);
});
