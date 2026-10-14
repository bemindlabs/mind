/**
 * `mind soul verify` as a person runs it, against CLIs that are not real.
 *
 * The stubs here are the point. A test that called a real `claude` would cost
 * quota, need credentials, and answer differently on Tuesdays; a test that
 * called nothing at all would never exercise the part most likely to be wrong —
 * the argv, the JSON shape each vendor prints, and whether a probe actually
 * reads the home the report claims it read. So two executable stubs go on a
 * temporary `PATH` and one `Bun.serve` stands in for the ollama daemon, and the
 * real `CliExec` / `OllamaExec` do their real work against them.
 *
 * `HOME` is a temporary directory in every case. Nothing here can reach the
 * operator's own instruction files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const FIXTURES = join(ROOT, "test", "fixtures");
const SOUL = join(FIXTURES, "soul-valid");
const SOUL_B = join(FIXTURES, "soul-valid-b");
const HUMAN = join(FIXTURES, "instructions", "human-200.md");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * A stub vendor CLI: reads the prompt off argv, answers like a session that is
 * (or is not) wearing the fixture soul.
 *
 * Written as a bun script rather than a shell script so the prompt — which is
 * multi-line and full of punctuation — survives being passed as one argument.
 */
function stubSource(shape: "json" | "text"): string {
  const reply = shape === "json" ? `JSON.stringify({ result: answer })` : `answer`;
  return `#!/usr/bin/env bun
const argv = process.argv.slice(2);
const flag = argv.indexOf("-p");
const prompt = flag === -1 ? (argv[argv.length - 1] ?? "") : (argv[flag + 1] ?? "");
const mode = process.env["MIND_STUB_MODE"] ?? "correct";
if (mode === "silent") process.exit(0);

const nonce = (prompt.match(/nothing else: (\\S+) followed/) ?? [])[1] ?? "";
const said = {
  correct: ["friend", "the keeper", "never deletes data without an explicit confirmation"],
  wrong: ["colleague", "the understudy", "never speaks for the first keeper"],
}[mode === "wrong" ? "wrong" : "correct"];

const which = prompt.includes("call the person") ? 0 : prompt.includes("refer to yourself") ? 1 : 2;
const answer = mode === "no-nonce" ? said[which] : nonce + " " + said[which];
console.log(${reply});
`;
}

/** A home with a human's CLAUDE.md, and stub `claude` / `codex` on a private PATH. */
async function makeHome(): Promise<{ home: string; stubs: string; bare: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), "mind-verify-cli-"));
  scratch.push(home);
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "CLAUDE.md"), await readFile(HUMAN, "utf8"));

  const stubs = join(home, "bin");
  await mkdir(stubs, { recursive: true });
  for (const [name, shape] of [["claude", "json"], ["codex", "text"]] as const) {
    const path = join(stubs, name);
    await writeFile(path, stubSource(shape));
    await chmod(path, 0o755);
  }

  // Not `dirname(bun)`, which is what this used to be: `bun add -g` installs
  // into that directory, so a globally installed vendor CLI would have been on
  // every PATH here — including the one the I-1 case calls empty.
  const bare = await barePath(home);
  return { home, stubs, bare, path: `${stubs}:${bare}` };
}

/** The ollama daemon, as far as `OllamaExec` can tell. */
function serveOllama(mode: () => "correct" | "wrong" | "silent") {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") {
        return Response.json({ models: [{ name: "stub" }] });
      }
      if (url.pathname !== "/api/chat") return new Response("no", { status: 404 });

      const body = (await request.json()) as {
        messages: { role: string; content: string }[];
      };
      const prompt = body.messages.at(-1)?.content ?? "";
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const now = mode();
      if (now === "silent") return Response.json({ message: { content: "" } });

      const nonce = (prompt.match(/nothing else: (\S+) followed/) ?? [])[1] ?? "";
      const said =
        now === "wrong"
          ? ["colleague", "the understudy", "never speaks for the first keeper"]
          : ["friend", "the keeper", "never deletes data without an explicit confirmation"];
      const which = prompt.includes("call the person") ? 0 : prompt.includes("refer to yourself") ? 1 : 2;

      // A local model only knows the identity because it arrived in the system
      // field — so an empty system field must not be answerable.
      const answer = system.includes("Example Keeper") || now === "wrong" ? said[which] : "unknown";
      return Response.json({ message: { content: `${nonce} ${answer}` } });
    },
  });
}

interface RunOptions {
  readonly path?: string;
  readonly stubMode?: string;
  readonly ollama?: string;
}

async function run(home: string, args: readonly string[], options: RunOptions = {}) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: options.path ?? `${join(home, "bin")}:${await barePath(home)}`,
      XDG_STATE_HOME: join(home, "state"),
      CODEX_HOME: join(home, ".codex"),
      ...(options.stubMode === undefined ? {} : { MIND_STUB_MODE: options.stubMode }),
      ...(options.ollama === undefined ? {} : { OLLAMA_HOST: options.ollama }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** Rows of the table, as `backend → level`. */
function levels(stdout: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(claude|codex|ollama)\s+(confirmed|partial|failed|silent)\s/);
    if (match !== null && found[match[1]!] === undefined) found[match[1]!] = match[2]!;
  }
  return found;
}

describe("mind soul verify", () => {
  test("AC2/AC3 — a table of three backends, four levels, and the raw answers", async () => {
    const { home } = await makeHome();
    const ollama = serveOllama(() => "correct");
    try {
      const applied = await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);
      expect(applied.code).toBe(0);

      const result = await run(
        home,
        ["soul", "verify", SOUL, "--subject", "example", "--model", "stub", "--runs", "1"],
        { ollama: `http://127.0.0.1:${ollama.port}` },
      );

      expect(levels(result.stdout)).toEqual({
        claude: "confirmed",
        codex: "confirmed",
        ollama: "confirmed",
      });
      expect(result.code).toBe(0);

      // AC2: the answers themselves, not just a verdict.
      expect(result.stdout).toContain("friend");
      expect(result.stdout).toContain("the keeper");
      expect(result.stdout).toContain("never deletes data without an explicit confirmation");
      expect(result.stdout).toContain("expected any of:");
      // AC3: all four levels are named where a reader meets them.
      for (const level of ["confirmed", "partial", "failed", "silent"]) {
        expect(result.stdout).toContain(level);
      }
      // AC4: the two file backends are not sold as equal to the field one.
      expect(result.stdout).toContain("user · file");
      expect(result.stdout).toContain("system · field");
    } finally {
      await ollama.stop(true);
    }
  });

  test("a backend answering from another identity fails, and the exit code says so", async () => {
    const { home } = await makeHome();
    const ollama = serveOllama(() => "wrong");
    try {
      await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);
      const result = await run(
        home,
        ["soul", "verify", SOUL, "--subject", "example", "--model", "stub", "--runs", "1"],
        { ollama: `http://127.0.0.1:${ollama.port}`, stubMode: "wrong" },
      );

      expect(levels(result.stdout)).toEqual({ claude: "failed", codex: "failed", ollama: "failed" });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("colleague");
    } finally {
      await ollama.stop(true);
    }
  });

  test("a CLI that prints nothing is silent, not failed", async () => {
    const { home } = await makeHome();
    const ollama = serveOllama(() => "correct");
    try {
      await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);
      const result = await run(
        home,
        ["soul", "verify", SOUL, "--subject", "example", "--backend", "claude", "--runs", "1"],
        { ollama: `http://127.0.0.1:${ollama.port}`, stubMode: "silent" },
      );

      expect(levels(result.stdout)).toEqual({ claude: "silent" });
      expect(result.stdout).toContain("failure to run");
      expect(result.code).toBe(1);
    } finally {
      await ollama.stop(true);
    }
  });

  test("I-1 — with the commercial CLIs off PATH, the local backend still verifies", async () => {
    const { home, bare } = await makeHome();
    const ollama = serveOllama(() => "correct");
    try {
      await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);

      // The precondition, asserted rather than assumed, and for every vendor
      // in the registry rather than the two this case happens to name below.
      // Without it, the day a vendor CLI appeared on this PATH the test would
      // have gone on passing while proving nothing — which is the exact shape
      // of silent success Mind exists to catch.
      expectNoVendorOn(bare);

      const result = await run(
        home,
        ["soul", "verify", SOUL, "--subject", "example", "--model", "stub", "--runs", "1"],
        { path: bare, ollama: `http://127.0.0.1:${ollama.port}` },
      );

      expect(levels(result.stdout)).toEqual({
        claude: "silent",
        codex: "silent",
        ollama: "confirmed",
      });
      expect(result.stdout).toContain("not on PATH");

      // And on its own, the local path is a clean pass — the whole point of I-1.
      const alone = await run(
        home,
        ["soul", "verify", SOUL, "--subject", "example", "--backend", "ollama", "--model", "stub", "--runs", "1"],
        { path: bare, ollama: `http://127.0.0.1:${ollama.port}` },
      );
      expect(alone.code).toBe(0);
      expect(levels(alone.stdout)).toEqual({ ollama: "confirmed" });
    } finally {
      await ollama.stop(true);
    }
  });

  test("the check would notice — a vendor back in the bare directory fails it", async () => {
    // Without this, a bug in `expectNoVendorOn` would make the case above pass
    // by finding nothing at all, which is the same failure by another route.
    const { bare } = await makeHome();
    expectNoVendorOn(bare);

    const planted = join(bare, "claude");
    await writeFile(planted, stubSource("json"));
    await chmod(planted, 0o755);

    expect(() => expectNoVendorOn(bare)).toThrow("claude");
    expect(() => expectNoVendorOn(bare)).toThrow(planted);
  });

  test("AC6 — wearing another subject's soul is reported, not passed", async () => {
    const { home } = await makeHome();
    try {
      await run(home, ["soul", "apply", SOUL_B, "--subject", "other-example", "--apply"]);
      const result = await run(
        home,
        ["soul", "verify", SOUL, "--subject", "example", "--backend", "claude", "--runs", "1"],
        { stubMode: "wrong" },
      );

      expect(levels(result.stdout)).toEqual({ claude: "failed" });
      expect(result.stdout).toContain("other-example");
      expect(result.stdout).toContain("I-3");
      expect(result.code).toBe(1);
    } finally {
      /* no server started */
    }
  });

  test("AC5 — the report says how many questions moved between runs", async () => {
    const { home } = await makeHome();
    await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);
    const result = await run(
      home,
      ["soul", "verify", SOUL, "--subject", "example", "--backend", "claude", "--runs", "2"],
    );
    expect(result.stdout).toMatch(/stability over 2 run\(s\): 0 of 3 question\(s\) changed verdict/);
    expect(result.code).toBe(0);
  });

  test("--json carries the levels and every piece of evidence", async () => {
    const { home } = await makeHome();
    await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);
    const result = await run(home, [
      "soul", "verify", SOUL, "--subject", "example", "--backend", "claude", "--runs", "1", "--json",
    ]);

    const report = JSON.parse(result.stdout) as {
      subject: string;
      runs: number;
      stable: boolean;
      backends: {
        backend: string;
        level: string;
        file: { state: string };
        channel: { strength: string };
        runs: { verdict: string; answer: string; evidence: { prompt: string; raw: string } }[];
      }[];
    };

    expect(report.subject).toBe("example");
    expect(report.runs).toBe(1);
    expect(report.stable).toBe(true);
    const [claude] = report.backends;
    expect(claude!.level).toBe("confirmed");
    expect(claude!.file.state).toBe("present");
    expect(claude!.channel.strength).toBe("user");
    expect(claude!.runs.length).toBe(3);
    expect(claude!.runs[0]!.evidence.prompt).toContain("standing instructions");
    expect(claude!.runs[0]!.evidence.raw).toContain("result");
  });

  test("--home measures a home other than the one the command is running in", async () => {
    const applied = await makeHome();
    const bare = await makeHome();
    await run(applied.home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);

    // Running out of the bare home, the same soul is nowhere on disk …
    const here = await run(bare.home, [
      "soul", "verify", SOUL, "--subject", "example", "--backend", "claude", "--runs", "1", "--json",
    ]);
    expect(JSON.parse(here.stdout).backends[0].file.state).toBe("absent");

    // … until the command is told which home to look at.
    const there = await run(
      bare.home,
      [
        "soul", "verify", SOUL, "--subject", "example", "--backend", "claude",
        "--home", applied.home, "--runs", "1", "--json",
      ],
      { path: bare.path },
    );
    const row = JSON.parse(there.stdout).backends[0];
    expect(row.file.state).toBe("present");
    expect(row.file.path).toBe(join(applied.home, ".claude", "CLAUDE.md"));
  });

  test("verify writes nothing — the file it measured is byte-identical afterwards", async () => {
    const { home } = await makeHome();
    await run(home, ["soul", "apply", SOUL, "--subject", "example", "--apply"]);
    const path = join(home, ".claude", "CLAUDE.md");
    const before = await readFile(path, "utf8");

    // A dead loopback port, not the default daemon: what this machine's ollama
    // does with a model named `stub` is not this test's question, and a daemon
    // that sits on it for fifteen seconds made the case time out.
    await run(home, ["soul", "verify", SOUL, "--subject", "example", "--runs", "1", "--model", "stub"], { ollama: "http://127.0.0.1:9" });

    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("typing it wrong is exit 2, and is never confused with a failed identity", async () => {
    const { home } = await makeHome();
    expect((await run(home, ["soul", "verify", SOUL])).code).toBe(2);

    const unknown = await run(home, [
      "soul", "verify", SOUL, "--subject", "example", "--backend", "nonesuch",
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("nonesuch");

    const runs = await run(home, ["soul", "verify", SOUL, "--subject", "example", "--runs", "zero"]);
    expect(runs.code).toBe(2);
    expect(runs.stderr).toContain("--runs");
  });

  test("a soul that does not belong to the subject is reported, and nothing is asked", async () => {
    const { home } = await makeHome();
    const result = await run(home, ["soul", "verify", SOUL, "--subject", "someone-else"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("example");
  });

  test("the help text no longer lists verify as unbuilt", async () => {
    const { home } = await makeHome();
    const result = await run(home, ["help"]);
    expect(result.stdout).toContain("mind soul verify");
    expect(result.stdout).not.toMatch(/soul verify.*\[S1\.3\]/);
  });
});
