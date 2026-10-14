/**
 * `mind erase --remote --yes` through cmdErase with a fake ssh (S13.5 AC2, step 6): the remote half first,
 * the phrase typed by the owner, the local half only after the remote is verified. No real ssh.
 * It runs in this process, so the vendor-file search reads the real home read-only; the subject id is
 * one no instruction file will ever hold, so nothing there can match or be edited.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdErase } from "../../bin/commands/erase.ts";
import { LEDGER_VERSION, append, type LedgerEntry } from "../../src/ledger/index.ts";
import { dataMap } from "../../src/erase/map.ts";
import { remoteTrees, parseRemoteTarget } from "../../src/erase/remote.ts";
import { erasePhrase } from "../../src/erase/remote-erase.ts";
import type { Runner } from "../../src/erase/remote-probe.ts";
import { subjectId } from "../../src/types.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const SUBJECT = subjectId("zz-erase-both-test");
const scratch: string[] = [];
const KEYS = ["HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "MIND_QDRANT_URL", "USER"] as const;
const saved = new Map<string, string | undefined>();

afterEach(async () => {
  for (const key of KEYS) {
    const before = saved.get(key);
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A sandbox home with one local file the subject owns, and the target file. */
async function sandbox(): Promise<{ home: string; target: string; localFile: string }> {
  const home = await mkdtemp(join(tmpdir(), "mind-erase-both-"));
  scratch.push(home);
  for (const key of KEYS) saved.set(key, process.env[key]);
  process.env["HOME"] = home;
  process.env["XDG_STATE_HOME"] = join(home, "state");
  process.env["XDG_DATA_HOME"] = join(home, "data");
  process.env["MIND_QDRANT_URL"] = "http://127.0.0.1:9";
  process.env["USER"] = "the-test";
  const tree = dataMap({ home, env: process.env }, SUBJECT, null).trees.find((entry) => entry.key === "confirmations");
  if (tree === undefined) throw new Error("no confirmations tree");
  await mkdir(tree.dir, { recursive: true });
  const localFile = join(tree.dir, "one.json");
  await writeFile(localFile, "{}");
  // One ledger line, so the ledger directory goes whole and the local half can finish clean.
  await append({ home, env: { XDG_STATE_HOME: join(home, "state") }, now: () => new Date() }, {
    v: LEDGER_VERSION, kind: "turn", id: "one-line", turn: "one-turn", at: new Date().toISOString(),
    subject: SUBJECT, backend: "ollama", model: null, content: "full", prompt: "hello", prompt_bytes: 5,
    text: "hi", text_bytes: 2, confidence: "confirmed", exit: 0, duration_ms: 1, cost: null, identity: "system", soul_sha: null,
  } as LedgerEntry);
  const target = join(home, "target.json");
  await writeFile(target, sshTarget());
  return { home, target, localFile };
}

function remotePlan() {
  const parsed = parseRemoteTarget(sshTarget(), "t.json", SUBJECT);
  if (!parsed.ok) throw new Error("bad target");
  return parsed.plan;
}

/** A fake far side holding every remote directory. */
function fakeSsh(opts: { down?: boolean; keep?: boolean } = {}) {
  const dirs = remoteTrees(remotePlan()).map((tree) => tree.dir);
  const there = new Set(dirs);
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (opts.down === true) return { code: 255, stdout: "", stderr: "ssh: Connection refused\n" };
    const last = argv[argv.length - 1] ?? "";
    if (argv.includes("rm")) {
      if (opts.keep !== true) there.delete(last);
      return { code: 0, stdout: "", stderr: "" };
    }
    const dir = argv[argv.indexOf("find") + 1] ?? "";
    return there.has(dir)
      ? { code: 0, stdout: "f1,", stderr: "" }
      : { code: 1, stdout: "", stderr: "find: 'x': No such file or directory\n" };
  };
  return { run, calls, there };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void out.push(args.join(" "));
  try {
    const code = await fn();
    return { code, text: out.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const args = (target: string, ...extra: string[]) => [SUBJECT, "--no-agent", "--by", "the owner", "--remote", target, "--yes", ...extra];
const phrase = erasePhrase(SUBJECT, "vps-1");

describe("erase --remote --yes with a fake ssh", () => {
  test("remote first, then local: both gone, exit 0, the remote certificate printed", async () => {
    const { home, target, localFile } = await sandbox();
    const ssh = fakeSsh();
    const { code, text } = await capture(() => cmdErase(args(target), { remoteRunner: ssh.run, readPhrase: async () => phrase }));
    expect(text).toContain("remote erase certificate — erased-and-verified");
    expect(text).toContain("provider snapshots");
    expect(text).toContain("remote half (first): erased-and-verified");
    expect(ssh.there.size).toBe(0);
    expect(existsSync(localFile)).toBe(false);
    expect(code).toBe(0);
    // One line for the one remote erase, and the local half's search of the state root did not trip on it.
    const rows = (await Bun.file(join(home, "state", "mind", "remote-erase.jsonl")).text()).trimEnd().split("\n");
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0] ?? "")).toMatchObject({ kind: "remote-erase", machine: "vps-1", verdict: "erased-and-verified", exit: 0 });
    expect(rows[0]).not.toContain(String(SUBJECT));
  }, 60_000);

  test("the remote is down: nothing is deleted here, the exit is 4, and the text says not verified", async () => {
    const { home, target, localFile } = await sandbox();
    const { code, text } = await capture(() => cmdErase(args(target), { remoteRunner: fakeSsh({ down: true }).run, readPhrase: async () => phrase }));
    expect(existsSync(localFile)).toBe(true);
    expect(code).toBe(4);
    const row = (await Bun.file(join(home, "state", "mind", "remote-erase.jsonl")).text()).trimEnd();
    expect(JSON.parse(row)).toMatchObject({ verdict: "not-verified", exit: 4, remaining: null });
    expect(text).toContain("not an erasure certificate");
    expect(text).toContain("local half: not run");
  }, 60_000);

  test("something stays on the remote: nothing is deleted here and the exit is 1", async () => {
    const { target, localFile } = await sandbox();
    const { code, text } = await capture(() => cmdErase(args(target), { remoteRunner: fakeSsh({ keep: true }).run, readPhrase: async () => phrase }));
    expect(existsSync(localFile)).toBe(true);
    expect(code).toBe(1);
    expect(text).toContain("remote half (first): remaining");
  }, 60_000);

  test("a wrong phrase sends nothing at all and deletes nothing here", async () => {
    const { home, target, localFile } = await sandbox();
    const ssh = fakeSsh();
    const { code } = await capture(() => cmdErase(args(target), { remoteRunner: ssh.run, readPhrase: async () => "yes" }));
    expect(ssh.calls).toEqual([]);
    expect(existsSync(localFile)).toBe(true);
    expect(code).toBe(4);
    expect(existsSync(join(home, "state", "mind", "remote-erase.jsonl"))).toBe(false);
  }, 60_000);

  test("--out also writes the remote certificate beside the local one", async () => {
    const { home, target } = await sandbox();
    const out = join(home, "cert", "erase.json");
    await mkdir(join(home, "cert"));
    await capture(() => cmdErase(args(target, "--out", out), { remoteRunner: fakeSsh().run, readPhrase: async () => phrase }));
    const remote = JSON.parse(await Bun.file(`${out}.remote.json`).text());
    expect(remote.schema).toBe("mind/erase-remote-certificate@1");
    expect(remote.verdict).toBe("erased-and-verified");
  }, 60_000);

  test("the log cannot be written after the remote delete: the verdict is still printed, and the exit is non-zero", async () => {
    const { home, target } = await sandbox();
    // A directory where the log file belongs: appending to it fails.
    await mkdir(join(home, "state", "mind", "remote-erase.jsonl"), { recursive: true });
    const ssh = fakeSsh();
    const { code, text } = await capture(() => cmdErase(args(target), { remoteRunner: ssh.run, readPhrase: async () => phrase }));
    expect(ssh.there.size).toBe(0);
    expect(text).toContain("remote erase certificate — erased-and-verified");
    expect(text).toContain("remote half (first): erased-and-verified");
    expect(text).toContain("could not write the remote-erase log line");
    expect(text).toContain("only the record of it was not written");
    expect(code).not.toBe(0);
  }, 60_000);

  test("the --out file cannot be written: same, and a failed remote keeps its own exit code", async () => {
    const { home, target } = await sandbox();
    const out = join(home, "cert.json");
    await mkdir(`${out}.remote.json`);
    const ok = await capture(() => cmdErase(args(target, "--out", out), { remoteRunner: fakeSsh().run, readPhrase: async () => phrase }));
    expect(ok.text).toContain("remote half (first): erased-and-verified");
    expect(ok.text).toContain("could not write the remote certificate");
    expect(ok.code).toBe(1);

    const down = await capture(() => cmdErase(args(target, "--out", out), { remoteRunner: fakeSsh({ down: true }).run, readPhrase: async () => phrase }));
    expect(down.text).toContain("remote half (first): not-verified");
    expect(down.code).toBe(4);
  }, 60_000);

  test("without a runner it still refuses, before anything is deleted", async () => {
    const { target, localFile } = await sandbox();
    const { code, text } = await capture(() => cmdErase(args(target), {}));
    expect(code).toBe(1);
    expect(text).toContain("no ssh runner is connected");
    expect(existsSync(localFile)).toBe(true);
  }, 60_000);
});
