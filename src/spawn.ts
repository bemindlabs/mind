/**
 * The one place Mind is allowed to start a subprocess.
 *
 * S0.4 AC2 asks for a property — *no path in Mind pushes* — and a property is
 * only as good as the narrowest place it can be checked. Before this file there
 * were two `Bun.spawn` call sites and no helper between them, and the test that
 * was supposed to guard the first one matched the literal text
 * `Bun.spawn(["…"`, so it could not see the second one at all: `cli-exec.ts`
 * builds its argv at run time and hands over a variable. A gate that reads like
 * a proof and is in fact a grep for one shape of one call is the failure mode
 * this whole story is about.
 *
 * So: every subprocess goes through {@link spawnGuarded}, {@link refusal} is a
 * pure function a test can interrogate directly, and a static check over `src/`
 * and `bin/` asserts that `Bun.spawn` appears in this file and nowhere else.
 * Three layers, each with a control that proves it bites — see
 * `test/guard/no-push.test.ts`.
 *
 * ## What this can and cannot promise
 *
 * It promises that **Mind's own code has no path that pushes**: `git` may only
 * be invoked with a closed list of local, read-mostly verbs, and the binaries
 * that are the usual way to reach a remote without the word `git` in the argv —
 * shells, `gh`, `ssh`, `rsync` — are refused outright.
 *
 * It does not promise that no push can happen on a machine running Mind, and
 * nothing here should be read as if it did. `cli-exec` spawns vendor CLIs, and
 * a vendor CLI is an agent with its own shell tool: it can run `git push` inside
 * its own process, and no static check on this repository can see that. That
 * limit is stated in {@link GUARD_LIMITS}, printed by the guard, and written
 * into ADR 0002 — in three places rather than one, because an acceptance
 * criterion that promises more than it proves is worse than one that promises
 * less.
 */

import { basename } from "node:path";

/**
 * The only `git` verbs Mind may run.
 *
 * A closed allowlist rather than a denylist of network verbs, because a
 * denylist is a list of the transports somebody thought of. Every verb here is
 * local and none of them opens a socket:
 *
 * - `init` — `mind new` creates the repository.
 * - `rev-parse` — where is the hooks directory, and does HEAD exist yet.
 * - `ls-files` — what is in the index before the first commit exists.
 * - `diff` — what is staged, once it does. Always with `--name-only`, which
 *   produces no diff and so never reaches a `diff.external` driver; a repository
 *   can configure one, and that is a command in somebody's own config, not a
 *   remote.
 * - `cat-file` — the staged bytes, which is what a commit will actually keep.
 * - `rev-list` — how many commits are already unreachable by deletion.
 * - `config` — reading remote URLs, and only ever reading (see {@link refusal}).
 *
 * git refuses to let an alias shadow a builtin, so this list cannot be widened
 * by anything in a repository's own config.
 */
export const GIT_VERBS: readonly string[] = [
  "init",
  "rev-parse",
  "ls-files",
  "diff",
  "cat-file",
  "rev-list",
  "config",
];

/** The only `git config` forms Mind may use: the three that read. */
export const GIT_CONFIG_READS: readonly string[] = ["--get", "--get-all", "--get-regexp"];

/**
 * Binaries Mind refuses to start at all, whatever the arguments say.
 *
 * Two kinds, and both are about the argv that would otherwise look innocent:
 *
 * - **Things that talk to a remote themselves** — `gh`, `hub`, `glab`, `ssh`,
 *   `scp`, `rsync`, `curl`, and git's own transport helpers. `gh repo create`
 *   publishes an identity without the word `push` appearing anywhere.
 * - **Things that would run a command on Mind's behalf** — a shell, `env`,
 *   `xargs`, `sudo`. `sh -c "git push"` is a spawn of `sh`, and an allowlist
 *   that only inspects `git` argvs would wave it through.
 *
 * Vendor CLIs are deliberately *not* on this list and are deliberately not
 * allowlisted either: `cli-exec` has to be able to run whichever backend the
 * registry names. What that costs is stated in {@link GUARD_LIMITS}.
 */
export const REFUSED_BINARIES: readonly string[] = [
  "gh",
  "hub",
  "glab",
  "tea",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "curl",
  "wget",
  "nc",
  "ncat",
  "socat",
  "git-upload-pack",
  "git-receive-pack",
  "git-remote-http",
  "git-remote-https",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "env",
  "xargs",
  "sudo",
  "doas",
  "nohup",
  "setsid",
];

/**
 * The one sentence Mind is allowed to say about a remote's visibility.
 *
 * Lifted out of {@link GUARD_LIMITS} when `doctor` (S0.2 AC6) needed the same
 * words. AC6 as written asks for a warning when an agent's remote is *public*,
 * and that is not knowable from here: visibility is a question only the host
 * can answer and Mind does not ask hosts anything — the same wall S0.4 AC1
 * hit when "the repo is always private" turned out to be unenforceable. What
 * both commands deliver instead is every remote, named, with this line under
 * it. One constant rather than two copies, so the claim cannot drift between
 * the command that guards and the command that reports.
 */
export const REMOTE_VISIBILITY_LIMIT =
  "Mind cannot see whether a remote is private. It never creates one, and it never asks a host " +
  "what a remote's visibility is — so it says `I cannot see` rather than `this repo is private`.";

/**
 * What this guard does **not** prevent — printed wherever it is claimed.
 *
 * Every line is something a reader could reasonably take "Mind cannot push"
 * to include, and does not. They are constants rather than prose in a document
 * so that the guard's own output and the tests can both use the same words.
 */
export const GUARD_LIMITS: readonly string[] = [
  "What is proven is narrow and exact: Mind's own code has no path that pushes. " +
    "That is not the same claim as `a push cannot happen on this machine`.",
  "A vendor CLI Mind spawns for a turn is an agent with its own shell tool. It can run " +
    "`git push` inside its own process, and no check on this repository can see that happen. " +
    "What each vendor is asked to do about it is declared per vendor in the registry and " +
    "printed by `mind backends` — including the one CLI that offers nothing to ask.",
  "`git commit --no-verify` and `git push --no-verify` skip these hooks entirely, and so does " +
    "any tool that writes objects without running hooks. The hooks are a speed bump for a human " +
    "in a hurry, not a lock.",
  "The hooks live in `.git/hooks`, which git does not clone. A fresh clone of this agent has no " +
    "guard until `mind guard install` is run there.",
  REMOTE_VISIBILITY_LIMIT,
];

/** A spawn that was refused, carrying the argv and the reason it was refused. */
export class SpawnRefused extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly reason: string,
  ) {
    super(`Mind refused to run ${argv.join(" ")}: ${reason}`);
    this.name = "SpawnRefused";
  }
}

/**
 * Why this argv may not be run, or `undefined` when it may.
 *
 * Pure, exported, and tested directly: the policy is the part worth arguing
 * about, and an argument about a policy should not have to go through a
 * subprocess to happen.
 */
export function refusal(argv: readonly string[]): string | undefined {
  const command = argv[0];
  if (command === undefined || command === "") {
    return "the command is empty — there is nothing to check";
  }

  // D-118's fence re-enters this engine (`<mind|bun run main> __fence … -- <command>`)
  // and replaces itself with <command> by `execvp`, past this function. So the
  // command that really runs is judged here, before the helper is started — a
  // wrapper must not be a way around the list below.
  const helper = argv.slice(0, 4).indexOf("__fence");
  if (helper >= 0) {
    const boundary = argv.indexOf("--", helper);
    const inner = boundary < 0 ? [] : argv.slice(boundary + 1);
    const no = refusal(inner);
    return no === undefined ? undefined : `inside the fence: ${no}`;
  }

  const name = basename(command).toLowerCase().replace(/\.exe$/, "");

  if (REFUSED_BINARIES.includes(name)) {
    return (
      `${name} is on the refused list: it can reach a remote, or run something that can, ` +
      `without the word "git" appearing in this argv (S0.4 AC2)`
    );
  }

  if (name !== "git") return undefined;

  const verb = argv[1];
  if (verb === undefined) {
    return "bare `git` with no verb — Mind names the verb it wants every time";
  }
  if (!GIT_VERBS.includes(verb)) {
    return (
      `git ${verb} is not one of the verbs Mind may run (${GIT_VERBS.join(", ")}). ` +
      `Everything that reaches a remote is outside that list, and so is every global option ` +
      `before the verb — \`-C\` and \`-c\` included, because \`-c alias.x=push\` is a push ` +
      `spelled differently. Use the cwd of the spawn instead.`
    );
  }

  if (verb === "config") {
    const form = argv[2];
    if (form === undefined || !GIT_CONFIG_READS.includes(form)) {
      return (
        `git config may only read (${GIT_CONFIG_READS.join(", ")}) — Mind does not write ` +
        `anybody's git configuration, least of all a remote into it`
      );
    }
  }

  return undefined;
}

/** What a guarded spawn accepts. Both streams are always piped; see below. */
export interface GuardedSpawnOptions {
  /** Working directory. The replacement for `git -C`, which is refused. */
  readonly cwd?: string;
  /** Environment for the child. Omitted means this process's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Give the child a process group of its own, with itself as leader (S5.4).
   *
   * Off by default and on for exactly one caller — `cli-exec`, which starts the
   * long-lived vendor CLIs. The reason is a measurement rather than tidiness:
   * without it a child inherits *Mind's* process group, and Mind's process
   * group is usually not Mind's. Under any shell without job control — cron,
   * systemd, CI, a wrapper script, a tool harness — every command shares the
   * shell's group, so the number Mind would print beside `kill -TERM -<pgid>`
   * names the invoking shell and whatever else it is running. Measured on
   * 2026-09-22: the first such group inspected held four processes and only one
   * of them was Mind.
   *
   * With it, the group holds the child and its descendants and nothing else,
   * which is what makes both the printed command and Mind's own group signal
   * exact. `setsid` is on {@link REFUSED_BINARIES} and stays there; this is the
   * runtime's own flag, not a program that would run something for us.
   */
  readonly detached?: boolean;
}

/**
 * Start a subprocess, or throw {@link SpawnRefused}.
 *
 * `stdout` and `stderr` are always pipes and `stdin` is always closed, which is
 * a policy rather than a convenience: a child that inherits the terminal can
 * print something the caller never sees and never records, and a child that
 * inherits stdin can sit waiting for a password on a pipeline nobody is
 * watching. Both call sites already wanted exactly this.
 */
export function spawnGuarded(
  argv: readonly string[],
  options: GuardedSpawnOptions = {},
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const no = refusal(argv);
  if (no !== undefined) throw new SpawnRefused(argv, no);

  return Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.detached === true ? { detached: true } : {}),
  });
}

/** Everything a short-lived command produced: bytes, not decoded text. */
export interface GuardedRun {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/**
 * Run a command to completion and collect it.
 *
 * `stdout` stays bytes because one caller is `git cat-file blob`, and a staged
 * file is whatever bytes somebody staged — decoding it as UTF-8 on the way past
 * would turn a binary blob into replacement characters before the scanner got
 * to say it was binary.
 */
export async function runGuarded(
  argv: readonly string[],
  options: GuardedSpawnOptions = {},
): Promise<GuardedRun> {
  const child = spawnGuarded(argv, options);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return { code: child.exitCode ?? -1, stdout: new Uint8Array(stdout), stderr: stderr.trim() };
}
