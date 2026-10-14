/**
 * The brake — layer one of three, and the only one that needs no code of ours.
 *
 * S5.4 AC2 asks that the kill switch work *even when the main agent is stuck*,
 * which rules out anything that has to be delivered by the process being
 * stopped. So "stopped" is the **existence of a file**, and nothing more:
 *
 * ```
 * touch "$XDG_STATE_HOME/mind/STOP"      # or ~/.local/state/mind/STOP
 * ```
 *
 * The contents are never read, never parsed, and never will be. A format is a
 * thing that can be malformed, and a brake that can be malformed is a brake with
 * a failure mode. `stat` succeeds or it does not.
 *
 * ## The three layers, and which of them depend on Mind
 *
 * | layer | how | depends on |
 * |---|---|---|
 * | 1 · do not start the next one | `touch <stateRoot>/STOP` | the filesystem |
 * | 2 · end the ones running | `mind stop` | a *new* Mind process |
 * | 3 · what layer 2 could not reach | `kill -TERM -<pgid>`, with the number printed for you | the shell and the kernel |
 *
 * Layers 1 and 3 need nothing from the program that is misbehaving. Layer 2 is
 * a convenience built on top of them, not the lifeline — which is what makes it
 * acceptable for it to be the one layer that runs our code.
 *
 * ## Why this file is not in git
 *
 * The dial lives in the agent's repository, where `git diff` can show a level
 * change and a clone carries the owner's intent with it. This file must not,
 * and the reason is stronger than a dirty working tree: committed, it would
 * travel with every clone, and a machine that was never told to stop would find
 * itself stopped with nobody there able to say why. A brake is a fact about
 * *this machine now*. The state root is where facts about this machine live.
 *
 * ## Setting it is easy; clearing it is not
 *
 * `touch` sets it. Clearing it is `mind autonomy resume`, which asks for a
 * phrase typed at a terminal and has no `--yes` — the same shape, and the same
 * reason, as `observe enable`: a program running as the owner can pass a flag
 * on the owner's behalf, and this is one of the few decisions that must cost a
 * human a keystroke. `rm` still works, of course, and saying so is the point:
 * Mind does not pretend to own a file it cannot defend.
 */

import { stat, unlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateRoot } from "../state.ts";

/** The file's name under the state root. One word, shouted, so `ls` shows it. */
export const STOP_FILE = "STOP";

/** Everything the brake is allowed to know about this machine. */
export interface StopEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Where the brake is, for this machine. Printed wherever it is mentioned. */
export function stopPath(env: StopEnv): string {
  return join(stateRoot(env.home, env.env), STOP_FILE);
}

/**
 * Is the brake on?
 *
 * Any answer other than "the file is not there" counts as **on**. A permission
 * error, a directory in its place, a filesystem that will not answer — every one
 * of those is a state in which Mind cannot show that it was told to run, and
 * the safe reading of "I cannot tell" is the same as the safe reading of an
 * unparseable dial: do nothing.
 */
export async function isStopped(env: StopEnv): Promise<boolean> {
  try {
    await stat(stopPath(env));
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Put the brake on.
 *
 * Idempotent, and deliberately writes a line of text even though nothing reads
 * it: somebody will find this file with `ls` and open it, and a file that
 * explains itself costs one write.
 *
 * @returns the path, so the caller can print the one thing that matters.
 */
export async function arm(env: StopEnv, at: Date, by: string): Promise<string> {
  const path = stopPath(env);
  await mkdir(stateRoot(env.home, env.env), { recursive: true, mode: STATE_DIR_MODE });
  await writeFile(
    path,
    `Mind is stopped.\n\n` +
      `Set at ${at.toISOString()} by ${by}.\n\n` +
      `Nothing reads these words. The file existing is the whole of the mechanism, so\n` +
      `\`touch\` sets it and \`rm\` clears it, and neither needs Mind to be working.\n` +
      `\`mind autonomy resume\` is the polite way to clear it and asks for a typed phrase.\n`,
    { mode: STATE_FILE_MODE },
  );
  return path;
}

/** Take the brake off. Returns false when it was not on. */
export async function disarm(env: StopEnv): Promise<boolean> {
  try {
    await unlink(stopPath(env));
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/** The phrase `autonomy resume` will accept, and nothing else. */
export function resumePhrase(): string {
  return "resume mind";
}

/**
 * What stopping does **not** do — printed by the command itself, every run.
 *
 * The last line is the one worth the most, and it is here rather than in a
 * document because a document is not in front of the person typing the command.
 * It records a measurement: on 2026-09-22, a grandchild process started as a
 * shell background job had `SigIgn` covering SIGINT — POSIX requires a
 * background job to ignore it — and survived a process-group SIGINT for the
 * three seconds it was watched, while the same process under a group SIGTERM
 * died. **Ctrl-C is not the kill switch.** The obvious answer to "what is the
 * simplest thing a person can do that certainly works" was wrong, and a person
 * who believes it will believe a turn has stopped when it has not.
 */
export const STOP_CANNOT: readonly string[] = [
  "put back a file that has already been written, recall a token that has already been sent, or " +
    "remove something a vendor has already uploaded. It stops the next act, not the last one.",
  "reach a process a vendor CLI started for itself that does not die on SIGTERM. The process " +
    "group number is printed above for exactly that case; `kill -TERM -<pgid>` is yours to run " +
    "and Mind will not run it for you.",
  "reach a turn started against a different state root. This command sees one, and prints which.",
  "reach a turn started by a build of Mind from before run records existed. There is nothing " +
    "on disk naming it, so there is nothing here that could find it.",
  "be replaced by Ctrl-C. Measured 2026-09-22: a child process started as a shell background job " +
    "ignores SIGINT by default (POSIX), and survived a process-group SIGINT while the same " +
    "process died on a group SIGTERM. A person who reaches for Ctrl-C and sees the prompt come " +
    "back has been told the turn ended, and may not have been told the truth.",
];
