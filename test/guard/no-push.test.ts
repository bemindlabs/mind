/**
 * S0.4 AC2 — and the exact size of what it proves.
 *
 * **What is proven: no code path in Mind pushes.** Not "it did not push this
 * time" — the argv of every subprocess in the engine is checked against a
 * closed allowlist before it runs, there is only one place in `src/` and `bin/`
 * that can start a process at all, and a `git` standing in for the real one
 * watches what actually executed.
 *
 * **What is not proven, and must never be claimed:** that a push cannot happen
 * on a machine running Mind. Three holes stay open on purpose, and they are
 * written into `GUARD_LIMITS`, into ADR 0002 and into the guard's own output
 * rather than only here:
 *
 * 1. `cli-exec` spawns vendor CLIs, and a vendor CLI is an agent with its own
 *    shell tool. It can run `git push` inside its own process and nothing in
 *    this repository can see that happen.
 * 2. `--no-verify` skips the hooks, and so does anything that writes objects
 *    without running them.
 * 3. `.git/hooks` is not cloned, so a fresh clone has no guard until
 *    `mind guard install` is run there.
 *
 * An acceptance criterion that promised more than the layers below check would
 * be ticked and would mislead whoever read the tick. So the criterion is the
 * narrow one, and this file is what it means.
 *
 * ## Three layers, each with a control that proves it bites
 *
 * - **A. static, over the AST** — not a regular expression. The gate this
 *   replaces matched the text `Bun.spawn(["…"` and therefore could not see
 *   `Bun.spawn(argv)` in `cli-exec.ts`, which is the call that spawns vendor
 *   CLIs. The control feeds the checker source it must catch (`const b = Bun`,
 *   `Bun["spawn"]`, `node:child_process`) and source it must not (the same
 *   words in a comment).
 * - **B. policy** — `refusal()` is pure, so the argument about what Mind may
 *   run happens in a unit test rather than through a subprocess.
 * - **C. behaviour** — every CLI command that takes an agent directory runs
 *   with a trap `git` first on PATH and a `file://` bare repository configured
 *   as a remote. Afterwards the trap's log holds no network verb and the bare
 *   repository holds no ref. Two controls: a push through the trap is caught,
 *   and a push without the trap really does land a ref — which is what makes
 *   "the bare repository is empty" a falsifiable claim rather than a tautology.
 *
 * Layer C only means something because layer A pins `dependencies` to empty:
 * with no libgit in the tree, the only way to write a ref into that bare
 * repository is to execute the `git` binary, and the binary on that PATH is
 * the trap.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { GIT_VERBS, refusal, runGuarded, spawnGuarded, SpawnRefused } from "../../src/spawn.ts";
import { processEscapes, reachable, sourceFiles } from "../support/ast.ts";
import { barePath, expectNoVendorOn } from "../support/bare-path.ts";
import {
  bareRemote,
  git,
  GIT_ENV,
  installTrapGit,
  NETWORK_VERBS,
  refsIn,
} from "../support/trap-git.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = "example";
/** A port nothing answers on, so `doctor`'s two probes fail instead of waiting. */
const DEAD = "http://127.0.0.1:1";

// ---------------------------------------------------------------------------
// A. static — the AST, not the text
// ---------------------------------------------------------------------------

/**
 * The one file allowed to start a process, and the reason it exists.
 *
 * The checkers themselves — {@link processEscapes}, {@link reachable} and the
 * allowlists they read — moved to `test/support/ast.ts` when S3.5 needed the
 * same walk for a different question. The controls stayed here, beside the
 * assertion they make meaningful.
 */
const SPAWN_CHOKEPOINT = join("src", "spawn.ts");
/**
 * The Landlock helper is the one native-code seam: it invokes the three
 * Landlock syscalls and `execvp`, which Bun does not expose otherwise.
 */
const FFI_CHOKEPOINT = join("src", "exec", "fence.ts");
/**
 * The two files that may listen: `mind web`'s server (D-060) and the A2A
 * listener (D-063), both on loopback by default. Named here so a second listener is a red test, and kept out of every
 * no-network closure (observer, erase), which still refuse `Bun.serve` outright.
 */
const SERVE_CHOKEPOINTS: readonly string[] = [join("src", "web", "server.ts"), join("src", "a2a", "server.ts")];

describe("A. static — one place in the engine can start a process", () => {
  test("only src/spawn.ts reaches Bun.spawn, anywhere under src/ and bin/", async () => {
    // `bin/` as a directory, not `bin/mind.ts` as a path. The CLI used to be
    // one file, and a gate naming that one file would have gone on passing over
    // an emptier and emptier entry point as commands moved into `bin/commands/`
    // — green, and blind to three thousand lines. Widened while `bin/` still
    // held one file, so the list this produced was checked to be unchanged.
    const files = [...(await sourceFiles(join(ROOT, "src"))), ...(await sourceFiles(join(ROOT, "bin")))];
    // Guards the gate's own scope: a file list that silently went empty would
    // make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
    // And specifically that `bin/` is in it: `src/` alone already clears 20, so
    // the count above cannot notice the CLI disappearing from the scan.
    expect(files.filter((path) => path.startsWith(join(ROOT, "bin")))).toContain(BIN);

    const escapes: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      for (const hit of processEscapes(
        path,
        await readFile(path, "utf8"),
        rel === SPAWN_CHOKEPOINT,
        SERVE_CHOKEPOINTS.includes(rel),
        rel === FFI_CHOKEPOINT,
      )) {
        escapes.push(`${rel}:${hit}`);
      }
    }

    expect(escapes).toEqual([]);
  }, 30_000);

  test("src/spawn.ts is the exemption, and it is really the one using it", async () => {
    const path = join(ROOT, SPAWN_CHOKEPOINT);
    const source = await readFile(path, "utf8");
    // Without the exemption the chokepoint itself is a violation — which is
    // what makes the exemption meaningful rather than decorative.
    expect(processEscapes(path, source, false)).not.toEqual([]);
    expect(processEscapes(path, source, true)).toEqual([]);
    // The listener allowance is its own flag: spawn's does not grant it, nor it spawn's.
    expect(processEscapes("s.ts", "Bun.serve({});", true)).not.toEqual([]);
    expect(processEscapes("s.ts", "Bun.serve({});", false, true)).toEqual([]);
    expect(processEscapes("s.ts", "Bun.spawn([]);", false, true)).not.toEqual([]);
  });

  test("src/exec/fence.ts is the only FFI exemption, and it is really using it", async () => {
    const path = join(ROOT, FFI_CHOKEPOINT);
    const source = await readFile(path, "utf8");
    expect(processEscapes(path, source, false)).not.toEqual([]);
    expect(processEscapes(path, source, false, false, true)).toEqual([]);
    expect(processEscapes("x.ts", 'import { dlopen } from "bun:ffi";', false)).not.toEqual([]);
  });

  test("the checker catches what a regular expression missed, and ignores comments", () => {
    const caught = (source: string) => processEscapes("synthetic.ts", source, false);

    // The shape the previous gate could not see: argv built at run time.
    expect(caught(`const argv = [binary]; Bun.spawn(argv);`)).not.toEqual([]);
    // Aliased, computed, imported, evaluated — four ways round a text search.
    expect(caught(`const b = Bun; b.spawn(["git", "push"]);`)).not.toEqual([]);
    expect(caught(`Bun["spawn"](["git", "push"]);`)).not.toEqual([]);
    expect(caught(`import { spawn } from "node:child_process";`)).not.toEqual([]);
    expect(caught("Bun.$`git push`;")).not.toEqual([]);
    expect(caught(`globalThis["process"];`)).not.toEqual([]);
    expect(caught(`eval("Bun.spawn");`)).not.toEqual([]);
    expect(caught(`new Function("return Bun.spawn")();`)).not.toEqual([]);
    expect(caught(`await import(name);`)).not.toEqual([]);

    // And the false positives that would make people delete the gate.
    expect(caught(`// Bun.spawn(["git", "push"]) is what this file replaced.`)).toEqual([]);
    expect(caught(`const note = "Bun.spawn is refused here";`)).toEqual([]);
    expect(caught(`await Bun.file(path).text();`)).toEqual([]);
  });

  test("I-6 — nothing the guard can reach opens a socket, and only the chokepoint spawns", async () => {
    // The guard reads staged blobs: everything about to enter git passes
    // through it, which makes it the most valuable code in the engine to
    // anything that wanted to send data somewhere.
    const sockets = [
      /\bfetch\s*\(/,
      /\bWebSocket\b/,
      /\bXMLHttpRequest\b/,
      /\bEventSource\b/,
      /"node:https?"/,
      /"node:net"/,
      /"node:tls"/,
      /"node:dgram"/,
      /\bBun\.(connect|listen|serve|udpSocket)\b/,
      /\bnavigator\.sendBeacon\b/,
    ];
    const spawns = /\bBun\.spawn(?:Sync)?\b/;

    const closure = await reachable(await sourceFiles(join(ROOT, "src", "guard")));
    const hits: string[] = [];
    for (const path of closure) {
      const source = await readFile(path, "utf8");
      const rel = relative(ROOT, path);
      for (const pattern of sockets) if (pattern.test(source)) hits.push(`${rel}: ${pattern}`);
      if (spawns.test(source) && rel !== SPAWN_CHOKEPOINT) hits.push(`${rel}: spawns`);
    }
    expect(hits).toEqual([]);

    // Controls: the closure is transitive and really does reach the
    // chokepoint, and the same scanner finds what it is looking for in
    // src/exec/, where a socket and a spawn both live.
    expect([...closure].some((path) => relative(ROOT, path) === SPAWN_CHOKEPOINT)).toBe(true);
    const exec = await reachable([join(ROOT, "src", "exec", "index.ts")]);
    const found: string[] = [];
    for (const path of exec) {
      const source = await readFile(path, "utf8");
      for (const pattern of sockets) if (pattern.test(source)) found.push(relative(ROOT, path));
    }
    expect(found).not.toEqual([]);
  }, 30_000);

  test("the engine has no dependencies, so nothing but the git binary can write a ref", async () => {
    const manifest = await Bun.file(join(ROOT, "package.json")).json();
    expect(manifest.dependencies ?? {}).toEqual({});
    // `typescript` is a devDependency and is used by this test file, not by the
    // engine; `files` ships bin, src and docs only.
    expect(Object.keys(manifest.devDependencies)).toContain("typescript");
    expect(manifest.files).toEqual(["bin", "src", "docs"]);
  });
});

// ---------------------------------------------------------------------------
// B. policy — what refusal() lets through
// ---------------------------------------------------------------------------

describe("B. policy — the argv allowlist", () => {
  test("the git verbs are exactly these, and none of them touches a network", () => {
    expect([...GIT_VERBS]).toEqual([
      "init",
      "rev-parse",
      "ls-files",
      "diff",
      "cat-file",
      "rev-list",
      "config",
    ]);
    for (const verb of NETWORK_VERBS) expect(GIT_VERBS).not.toContain(verb);
  });

  test("the fence helper is not a way around the list (D-118)", () => {
    // `__fence` replaces itself with the command after `--` by execvp, past
    // spawnGuarded — so the chokepoint judges that command before the helper starts.
    const wrapped = (inner: string[]) => ["/usr/local/bin/mind", "__fence", "--rw", "/tmp", "--", ...inner];
    const viaBun = (inner: string[]) => ["/usr/bin/bun", "run", "/repo/bin/mind.ts", "__fence", "--", ...inner];
    for (const inner of [["git", "push"], ["gh", "repo", "delete"], ["ssh", "host"], []]) {
      expect(refusal(wrapped(inner)), inner.join(" ")).toBeDefined();
      expect(refusal(viaBun(inner)), inner.join(" ")).toBeDefined();
    }
    expect(refusal(wrapped(["git", "push"]))).toContain("inside the fence");
    // The shape `bin/mind.ts` asks about before it hands over to the helper.
    expect(refusal(["__fence", "--", "git", "push"])).toContain("inside the fence");
    expect(refusal(["__fence", "--rw", "/tmp", "--", "claude", "-p", "hi"])).toBeUndefined();
    // The control: a vendor CLI inside the fence is allowed, as it is outside it.
    expect(refusal(wrapped(["claude", "-p", "hi"]))).toBeUndefined();
    expect(refusal(viaBun(["grok", "-p", "hi"]))).toBeUndefined();
  });

  test("every shape of `push` this could arrive as is refused", () => {
    const refused = [
      ["git", "push"],
      ["git", "push", "origin", "HEAD"],
      ["/usr/bin/git", "push"],
      ["/opt/homebrew/bin/git.exe", "push"],
      // A global option before the verb: the allowlist reads argv[1], so an
      // alias smuggled in through `-c` never reaches a verb check at all.
      ["git", "-c", "alias.x=push", "x"],
      ["git", "-C", "/somewhere", "push"],
      ["git", "--git-dir=/somewhere/.git", "push"],
      // Not spelled "git" at all.
      ["gh", "repo", "create", "--public"],
      ["sh", "-c", "git push"],
      ["bash", "-lc", "git push"],
      ["ssh", "host", "git-receive-pack"],
      ["rsync", "-a", ".", "host:/backup"],
      ["curl", "-X", "POST", "https://example.invalid"],
      ["env", "git", "push"],
      ["xargs", "git", "push"],
      // Writing a remote into the config is how a later `git push` needs no
      // argument at all.
      ["git", "config", "remote.origin.url", "https://example.invalid"],
      ["git", "config", "--add", "remote.origin.url", "https://example.invalid"],
      [],
      ["git"],
    ];
    for (const argv of refused) {
      expect(refusal(argv), `expected to refuse: ${argv.join(" ") || "(empty)"}`).toBeString();
    }
  });

  test("what Mind actually runs is allowed, including a vendor CLI", () => {
    const allowed = [
      ["git", "init", "-q", "/tmp/example"],
      ["git", "rev-parse", "--git-path", "hooks"],
      ["git", "rev-parse", "--verify", "--quiet", "HEAD"],
      ["git", "ls-files", "--cached", "-z"],
      ["git", "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
      ["git", "cat-file", "blob", ":soul/role.md"],
      ["git", "rev-list", "--count", "HEAD"],
      ["git", "config", "--get-regexp", "^remote\\..*\\.url$"],
      // I-1: the vendor CLIs have to stay runnable, and that is the hole
      // GUARD_LIMITS is about — this one cannot be closed from here.
      ["claude", "-p", "hello"],
      ["/usr/local/bin/codex", "exec", "hello"],
    ];
    for (const argv of allowed) {
      expect(refusal(argv), `expected to allow: ${argv.join(" ")}`).toBeUndefined();
    }
  });

  test("the policy is enforced by the chokepoint, not merely stated next to it", async () => {
    // `refusal` being correct is worth nothing if `spawnGuarded` forgets to
    // call it, which is a one-line regression nobody would see in review.
    expect(() => spawnGuarded(["git", "push", "origin", "HEAD"])).toThrow(SpawnRefused);
    try {
      spawnGuarded(["gh", "repo", "create"]);
      throw new Error("spawnGuarded started gh");
    } catch (error) {
      expect(error).toBeInstanceOf(SpawnRefused);
      expect((error as SpawnRefused).reason).toContain("refused list");
      expect((error as SpawnRefused).argv).toEqual(["gh", "repo", "create"]);
    }

    // And an allowed command really does run, so the guard is not passing by
    // refusing everything.
    const workspace = await mkdtemp(join(tmpdir(), "mind-chokepoint-"));
    scratch.push(workspace);
    expect((await runGuarded(["git", "init", "-q", join(workspace, "r")])).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. behaviour — what actually ran
// ---------------------------------------------------------------------------

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

describe("C. behaviour — every command, watched by a git that writes down its argv", () => {
  test("no command reaches a remote, and the bare repository stays empty", async () => {
    const home = await sandbox("mind-nopush-home-");
    const workspace = await sandbox("mind-nopush-work-");

    const trap = await installTrapGit(home);
    const path = `${trap.dir}:${await barePath(home)}`;
    // Preconditions, asserted rather than hoped for: `git` has to be the trap,
    // and no vendor CLI may be reachable (I-1).
    expect(Bun.which("git", { PATH: path })).toBe(join(trap.dir, "git"));
    expectNoVendorOn(path);

    const env = {
      ...GIT_ENV,
      HOME: home,
      PATH: path,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      CODEX_HOME: join(home, ".codex"),
      // `memory` and `erase` would otherwise ask this machine's Ollama and
      // Qdrant. Port 1 on loopback answers nothing, so both halves report and
      // carry on (D-038).
      MIND_EMBED_URL: DEAD,
      MIND_QDRANT_URL: DEAD,
    };

    const run = async (args: readonly string[]) => {
      const child = Bun.spawn(["bun", "run", BIN, ...args], {
        cwd: workspace,
        env: { ...env, PATH: `${path}:${dirname(Bun.which("bun") ?? "bun")}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      await child.exited;
      return { code: child.exitCode ?? -1, stdout, stderr };
    };

    const agent = join(workspace, "example");
    expect((await run(["new", "example", "--subject", SUBJECT])).code).toBe(0);

    // The human's part: a remote, and a first commit. Done with the real git,
    // outside the trap, because these are the things Mind refuses to do.
    const bare = await bareRemote(workspace, "origin.git");
    expect((await git(agent, ["remote", "add", "origin", `file://${bare}`])).code).toBe(0);
    expect((await git(agent, ["add", "-A"])).code).toBe(0);
    expect((await git(agent, ["commit", "-q", "-m", "first"])).code).toBe(0);

    // S5.2's three, which have to run in sequence because each one needs the
    // id the one before it printed — so they are here rather than in the list
    // below. `proposal decide` runs `git config --get user.name` through
    // `whoIsSetting` to record who answered, exactly as `autonomy set` does,
    // which is the shape of command this file exists to watch; `new` and
    // `list` resolve the personal directory, which walks for a `.git` with
    // `stat` and must never reach for the binary to answer that.
    const soulDir = join(agent, "soul");
    const filed = await run([
      "proposal", "new", soulDir, "--subject", SUBJECT,
      "--what", "tidy the logs", "--why", "the disk is full", "--impact", "old log files",
    ]);
    expect(filed.code, filed.stderr).toBe(0);
    expect(
      (await run([
        "proposal", "decide", filed.stdout.trim(), soulDir, "--subject", SUBJECT, "--refuse",
      ])).code,
    ).toBe(0);
    await run(["proposal", "list", soulDir, "--subject", SUBJECT]);

    // Where `deploy plan` is told the agent would go: a documentation address.
    const deployTarget = join(workspace, "target.json");
    await Bun.write(deployTarget, JSON.stringify({ name: "vps-1", provider: "ssh", ssh: { host: "203.0.113.10", user: "deploy" } }));

    // Every command that takes an agent directory, run for real.
    const exercised = [
      ["version"],
      ["help"],
      ["backends"],
      ["rebuild", agent, "--subject", SUBJECT],
      ["rebuild", agent, "--subject", SUBJECT, "--check"],
      // D-171: a dry run, and it only reads (the roots, a few profile files).
      ["migrate"],
      ["soul", "check", join(agent, "soul"), "--subject", SUBJECT],
      // S1.6's two: the report, and the `--as` expansion in front of it. Both
      // only read, which is exactly why they are worth watching — a command
      // that looks harmless is the one nobody checks.
      ["worn", "--backend", "claude"],
      ["worn", "--subject", SUBJECT],
      // S0.2's. It reads an agent repository through `derivedStatus` and
      // `historyFacts` — the second of which runs `git rev-list` and
      // `git config --get-regexp`, both on the verb allowlist — so it is
      // exactly the shape of command this file exists to watch. `--no-version`
      // keeps it from starting six vendor CLIs inside a test that has just
      // asserted none of them is reachable.
      ["doctor", "--no-version", "--ollama", DEAD, "--qdrant", DEAD],
      ["doctor", "--no-version", "--ollama", DEAD, "--qdrant", DEAD, "--agent", agent, "--subject", SUBJECT],
      ["--as", agent, "worn"],
      ["--as", agent, "soul", "check"],
      ["ledger", "show", "--subject", SUBJECT],
      ["guard", "install", agent],
      ["guard", "scan", "--staged", agent],
      ["guard", "status", agent],
      // S3.5's two. `purge` runs for real rather than only `--dry-run`: the
      // deleting path is the one worth watching, and the directory it deletes
      // from is this sandbox's XDG_DATA_HOME.
      ["observe", "status", "--subject", SUBJECT],
      // S3.3 (D-057): reads capture, writes nothing.
      ["observe", "patterns", "--subject", SUBJECT],
      // S3.4 (D-064): counts capture over the directories under a root.
      ["observe", "interests", "--subject", SUBJECT, "--root", agent],
      ["observe", "purge", "--subject", SUBJECT, "--dry-run"],
      ["observe", "purge", "--subject", SUBJECT],
      // S4.1's two (D-038). `index` writes .mind/index/ inside the repository —
      // which is why it is worth watching next to git — and `search` reads it.
      ["memory", "ingest", agent, "--from", join(agent, "memory"), "--name", "self", "--yes"],
      ["memory", "index", agent, "--subject", SUBJECT],
      ["memory", "search", agent, "--subject", SUBJECT, "identity"],
      ["memory", "forget", agent, "--subject", SUBJECT, "--file", "memory/README.md", "--yes"],
      // S8.3's (D-048): reads the personal store, writes nothing.
      ["egress", "needles", "--subject", SUBJECT],
      ["egress", "check", "--subject", SUBJECT, "nothing personal"],
      ["egress", "log", "--subject", SUBJECT],
      // E5's two. Both run `git config --get user.name` through `whoIsSetting`
      // to record who set a level (AC4) — a read on the verb allowlist, and
      // therefore exactly the shape of command this file exists to watch. They
      // go before `erase` on purpose: `autonomy set` leaves an `autonomy.md`
      // in the soul directory, and the erase below then has to take it.
      ["autonomy", "show", join(agent, "soul"), "--subject", SUBJECT],
      ["autonomy", "set", "write", "2", join(agent, "soul"), "--subject", SUBJECT],
      ["autonomy", "show"],
      // S5.3's (D-054). With no triggers.md each one reads the soul directory
      // and writes nothing; `schedule` only prints.
      ["triggers", "show", join(agent, "soul"), "--subject", SUBJECT],
      ["triggers", "tick", join(agent, "soul"), "--subject", SUBJECT],
      ["triggers", "schedule", join(agent, "soul"), "--subject", SUBJECT],
      // D-056's. With stdin closed it runs `backends`, then stops at its first
      // question having created nothing.
      ["setup", "--no-turn"],
      // D-060's: with no agent named it prints its usage and starts nothing.
      ["web"],
      // D-063's: reads the peer list and the inbox; sends and listens nowhere.
      ["a2a", "peers", "--subject", SUBJECT],
      ["a2a", "inbox", "--subject", SUBJECT],
      // D-066's: reads the allowlist; polls and answers nobody.
      ["chat", "users", "--subject", SUBJECT],
      // D-072's: shows the drafts there are (none); reads no artifact, asks no model.
      ["persona", "show", "--subject", SUBJECT],
      // D-073's: with no agent named it prints its usage and runs no turn.
      ["eval"],
      // D-077's: shows the records there are (none).
      ["basis", "show", "--subject", SUBJECT],
      // D-065's: a stray word is a usage error before anything is asked of GitHub.
      ["update", "wat"],
      // `stop` writes the brake into this sandbox's XDG_STATE_HOME and zeroes
      // the dial in the repository. Nothing after it runs a turn, so the brake
      // affects no later step here.
      ["stop", join(agent, "soul"), "--subject", SUBJECT],
      // E17's (D-151): `status` asks docker what runs under this sandbox's state root — or finds no docker on
      // the trap PATH and says so — and `down` of a task nobody started; neither has a reason to start git.
      ["browser", "status"],
      ["browser", "down", "t-none"],
      // D-154's: reading a subject's tasks (none here), and one that does not exist; neither starts a turn.
      ["task", "list", join(agent, "soul"), "--subject", SUBJECT],
      ["task", "show", "t-11111111", join(agent, "soul"), "--subject", SUBJECT],
      // S7.2's. The dry run and the real one both, because the deleting path
      // is the one that reads git (`rev-list --count`, on the verb allowlist)
      // and the one somebody would most want to be sure never pushed.
      // S13.1's. Its output is a list of `git bundle` and `ssh` command lines,
      // so it is exactly the command that must be seen to run none of them —
      // and it goes before `erase`, while the repository still holds its soul.
      ["deploy", "plan", agent, "--subject", SUBJECT, "--target", deployTarget],
      // S15.8's. `key` writes the agent's private key under this sandbox's XDG_DATA_HOME and walks for a
      // `.git` with `stat` to refuse a checkout; `usage report` reads the ledger and signs; `usage verify`
      // reads a file. None has a reason to start git — and they go before `erase`, which then takes the key.
      ["key", agent, "--subject", SUBJECT],
      ["usage", "report", agent, "--subject", SUBJECT],
      ["usage", "verify", join(workspace, "target.json")],
      // S15.4 step one's (D-141): a proof signed with that key, one checked, and a report bound to a listing.
      ["key", "prove", agent, "--subject", SUBJECT, "--market", "https://market.example", "--listing", "ts-reviewer", "--nonce", "A".repeat(43)],
      ["key", "verify-proof", join(workspace, "target.json"), "--key", "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", "--market", "https://market.example", "--listing", "ts-reviewer", "--nonce", "A".repeat(43)],
      ["usage", "report", agent, "--subject", SUBJECT, "--market", "https://market.example", "--listing", "ts-reviewer", "--job", "job_01"],
      ["erase", SUBJECT, "--agent", agent, "--by", "the no-push test"],
      ["erase", SUBJECT, "--agent", agent, "--by", "the no-push test", "--yes"],
      ["new", "second", "--subject", SUBJECT],
    ];
    for (const args of exercised) await run(args);

    const seen = await trap.seen();
    expect(seen.length).toBeGreaterThan(0);
    const reached = seen.filter((argv) => argv.some((token) => NETWORK_VERBS.includes(token)));
    expect(reached.map((argv) => argv.join(" "))).toEqual([]);
    expect(await refsIn(bare)).toEqual([]);
  }, 60_000);

  test("the control: a push through the trap is caught, and one without it lands a ref", async () => {
    const home = await sandbox("mind-control-home-");
    const workspace = await sandbox("mind-control-work-");
    const trap = await installTrapGit(home);

    const repo = join(workspace, "repo");
    await Bun.write(join(repo, "a.txt"), "a\n");
    expect((await git(workspace, ["init", "-q", repo])).code).toBe(0);
    expect((await git(repo, ["add", "-A"])).code).toBe(0);
    expect((await git(repo, ["commit", "-q", "-m", "first"])).code).toBe(0);

    const trapped = await bareRemote(workspace, "trapped.git");
    const direct = await bareRemote(workspace, "direct.git");

    // Through the trap: refused, recorded, and nothing arrives.
    const blocked = Bun.spawn([join(trap.dir, "git"), "push", `file://${trapped}`, "HEAD"], {
      cwd: repo,
      env: { ...GIT_ENV, PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await blocked.exited;
    expect(blocked.exitCode).toBe(97);
    expect((await trap.seen()).some((argv) => argv.includes("push"))).toBe(true);
    expect(await refsIn(trapped)).toEqual([]);

    // Without it: the same push really does land a ref. This is what makes
    // "the bare repository is empty" evidence rather than a tautology.
    expect((await git(repo, ["push", "-q", `file://${direct}`, "HEAD:refs/heads/main"])).code).toBe(0);
    expect(await refsIn(direct)).not.toEqual([]);
  }, 30_000);

  test("a new command with no trap coverage fails this file rather than slipping past", async () => {
    const source = await readFile(BIN, "utf8");
    const main = source.slice(source.indexOf("async function main("));
    const dispatched = [...main.matchAll(/case "([^"]+)":/g)].map((match) => match[1]!);

    const exercised = new Set([
      "version",
      "help",
      "backends",
      "new",
      "rebuild",
      "migrate",
      "soul",
      "worn",
      "ledger",
      "observe",
      "memory",
      "egress",
      "guard",
      "erase",
      "doctor",
      // E5's two. Both really run `git config --get user.name` in the case
      // above, so they are watched rather than exempt.
      "autonomy",
      "stop",
      "triggers",
      "setup",
      "web",
      "a2a",
      "chat",
      "persona",
      "eval",
      "basis",
      "update",
      // S13.1's: the plan only, which names `git bundle` and runs no git.
      "deploy",
      // S15.8's: the key, and the signed usage report; S15.4's proof of it (D-141).
      "key",
      "usage",
      // S5.2's. Run in sequence above rather than in the flat list, because
      // `decide` needs the id `new` printed.
      "proposal",
      // E17's (D-151): status and down run above.
      "browser",
      // D-154's: list and show run above.
      "task",
    ]);
    const exempt = new Map([
      ["--version", "an alias of version"],
      ["-v", "an alias of version"],
      ["--help", "an alias of help"],
      ["-h", "an alias of help"],
      [
        "turn",
        "spends a real turn on a real backend. Its one subprocess is the vendor CLI, which " +
          "goes through spawnGuarded — layers A and B above are what cover it, and " +
          "GUARD_LIMITS says what neither of them can.",
      ],
    ]);

    const uncovered = dispatched.filter((name) => !exercised.has(name) && !exempt.has(name));
    expect(uncovered).toEqual([]);
    // And the reverse: a name that stops being dispatched should not keep a
    // reason on file forever.
    for (const name of exempt.keys()) expect(dispatched).toContain(name);
  });
});
