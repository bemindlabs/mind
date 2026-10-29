/**
 * S22.12 AC2 (D-198) — the coding task's last mile: the repository's own gate decides "done", and what comes out is a
 * request for a human to merge, never a merge.
 *
 * A task made with `--worktree` and `--gate "<command>"` is not done when the bot says so. The runner runs the gate in
 * the task's worktree; red, and the goal is not reached: the bot is told what the gate printed and works again, up to
 * {@link MAX_GATE_RED} times; green, and the task is done with a {@link Handoff} on its record — the branch, the base,
 * what changed, and the one command a person types to merge. Mind writes that record and stops. It has no `merge`
 * verb (`src/spawn.ts` GIT_VERBS) and a bot that merges on its own is breaking I-5, not being helped.
 *
 * Why a record on the task and not a proposal: a proposal's approval is spent as a turn whose prompt is the proposal's
 * words, so approving "merge this" would hand a bot the order to merge. The record is read by a person, in
 * `mind task show` and on the fleet page, and acted on by hand.
 *
 * Pure: the argv parse, the note told to the bot, the handoff. Running the gate and reading git are the caller's.
 */

/** A bot may be told the gate is red this many times in a row before the task fails. */
export const MAX_GATE_RED = 3;
/** The most of the gate's output the bot is told, from the end. */
export const GATE_TAIL_CHARS = 1500;

/** What a person reads and types to finish a coding task. */
export interface Handoff {
  readonly repo: string;
  readonly branch: string;
  readonly base: string;
  /** The gate that was green, as typed. */
  readonly gate: string;
  readonly at: string;
  /** `git diff --stat` of the worktree against the base, as git printed it. */
  readonly diffStat: string;
  /** Files git does not track yet: the diff above cannot show them. */
  readonly untracked: readonly string[];
  /** The command a person runs, from the repository, to take the work. Mind has not run it. */
  readonly mergeCommand: string;
}

/** Characters a shell would act on. The gate is an argv, so none of them can mean what they look like. */
const SHELL = /["'`$;&|<>(){}*?\\\n]/;

/** `--gate "bun test"` as an argv. Refused, not interpreted, when it looks like a shell line. */
export function parseGate(text: string): { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly reason: string } {
  const words = text.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return { ok: false, reason: "--gate is the command that decides done, such as \"bun test\"" };
  if (SHELL.test(text)) {
    return { ok: false, reason: "--gate is run as a command and its arguments, not through a shell: no quotes, pipes, redirects, globs or `;`. Put the steps in a script in the repository and name that." };
  }
  return { ok: true, argv: words };
}

/** What the bot is told when the gate is red: the gate, its end of the output, and that the goal is not reached. */
export function redNote(gate: string, output: string, attempt: number): string {
  const tail = output.trim().slice(-GATE_TAIL_CHARS);
  return `The gate \`${gate}\` is red (attempt ${attempt} of ${MAX_GATE_RED}), so the goal is not reached yet.${tail === "" ? "" : ` It printed, at the end: ${tail}`} Fix the cause, not the check.`;
}

/** The handoff of a green task. `mergeCommand` is text for a person; nothing here runs it. */
export function handoffOf(input: Omit<Handoff, "mergeCommand">): Handoff {
  return { ...input, mergeCommand: `git -C ${input.repo} merge --ff-only ${input.branch}` };
}

/** Lines for `mind task show`. Says plainly that nothing was merged. */
export function handoffLines(handoff: Handoff): readonly string[] {
  return [
    `  ready to merge: ${handoff.branch} into ${handoff.base} — gate \`${handoff.gate}\` was green at ${handoff.at}`,
    ...(handoff.diffStat === "" ? ["  (git shows no change against the base)"] : handoff.diffStat.split("\n").map((line) => `    ${line}`)),
    ...(handoff.untracked.length === 0 ? [] : [`  not in that diff, git does not track them yet: ${handoff.untracked.join(", ")}`]),
    `  nothing was merged. To take it: ${handoff.mergeCommand}`,
  ];
}
