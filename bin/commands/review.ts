/**
 * `mind review` — a change reviewed by a backend that did not write it (S22.7, D-197). See `src/review/review.ts`.
 *
 * Exit codes: 0 approved · 7 changes asked for · 1 the review did not happen or could not be read · 2 usage ·
 * 3 no reviewer different from the author is usable · 4 refused (the brake, a dial that lets a reviewer act, or run
 * from inside a turn).
 */

import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileHealth, healthPath } from "../../src/exec/health.ts";
import { backend as backendFor } from "../../src/exec/index.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import {
  DEFAULT_REVIEWERS,
  MAX_DIFF_BYTES,
  countsOf,
  pickReviewer,
  readVerdict,
  reviewPrompt,
  type ReviewRecord,
} from "../../src/review/review.ts";
import { spawnGuarded } from "../../src/spawn.ts";
import { STATE_FILE_MODE } from "../../src/state.ts";
import { agentAncestor } from "../../src/task/index.ts";
import { readTurnJson } from "../../src/task/spawn-turn.ts";
import { readTask, taskDirIn, tasksDir } from "../../src/task/store.ts";
import { guardedGit } from "../../src/task/worktree.ts";
import { isKnownBackend } from "../../src/soul/index.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { decideDial, dialEnv } from "../dial.ts";
import { parseArgs, usageError } from "../shared.ts";

const USAGE =
  "usage: mind review <dir> --subject <id> (--author a[,b] | --task <id>) [--repo <path>] [--base <ref>] [--reviewers a,b,c] [--context <text>] [--json]";

const csv = (value: string | undefined): string[] => (value ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");

export async function cmdReview(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  const dir = positional[0];
  const rawSubject = options.get("subject");
  if (dir === undefined || positional.length > 1 || rawSubject === undefined || rawSubject === "") return usageError(USAGE);
  let subject: SubjectId;
  try {
    subject = subjectId(rawSubject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const explicit = csv(options.get("author"));
  const candidates = options.has("reviewers") ? csv(options.get("reviewers")) : [...DEFAULT_REVIEWERS];
  for (const id of [...explicit, ...candidates]) if (!isKnownBackend(id)) return usageError(`unknown backend ${JSON.stringify(id)}`);
  const base = options.get("base") ?? "main";

  // The authors: whoever answered a step of the task, and whoever the caller names.
  const authors = new Set(explicit);
  let taskDir: string | undefined;
  let repo = options.get("repo") === undefined ? undefined : resolve(options.get("repo")!);
  const taskId = options.get("task");
  const tasks = await tasksDir(dialEnv(), subject);
  if (!tasks.ok) {
    console.error(`mind review: ${tasks.reason}`);
    return 1;
  }
  if (taskId !== undefined) {
    const read = await readTask(tasks.path, subject, taskId);
    if (!read.ok) return usageError(read.reason);
    for (const step of read.record.steps) {
      if (step.backend !== null && (step.outcome === "ok" || step.outcome === "unreadable")) authors.add(step.backend);
    }
    taskDir = taskDirIn(tasks.path, taskId);
    repo ??= read.record.worktree?.path ?? read.record.cwd;
  }
  repo ??= process.cwd();
  if (authors.size === 0) {
    // Asked first, before a diff is read or a backend probed: with no author there is no "different from the author".
    console.error("mind review: nothing was sent — no author is named, so a reviewer different from it cannot be chosen (--author, or --task with finished steps)");
    return 3;
  }

  const above = await agentAncestor(dialEnv(), tasks.path, subject);
  if (above !== undefined) {
    console.error(`mind review: nothing was sent — this command runs under ${above}. A review is asked for by a person, not from inside a turn.`);
    return 4;
  }
  const verdict = await decideDial(resolve(dir), dialEnv(), subject);
  if (verdict.effective.stopped) {
    console.error("mind review: nothing was sent — the brake is on (`mind stop`).");
    return 4;
  }
  if (verdict.effective.act >= 2) {
    console.error(`mind review: nothing was sent — this agent's dial lets a turn act (level ${verdict.effective.act}), and a reviewer must only read. Use an agent whose write, run and reach are below 2.`);
    return 4;
  }

  const diff = await guardedGit(["git", "diff", base], repo);
  if (diff.code !== 0) {
    console.error(`mind review: nothing was sent — \`git diff ${base}\` failed in ${repo}: ${diff.stderr.split("\n")[0] ?? "no message"}`);
    return 1;
  }
  if (diff.stdout.trim() === "") {
    console.error(`mind review: nothing to review — no change against ${base} in ${repo} (new, untracked files are not in a diff: \`git add -N\` them).`);
    return 0;
  }
  if (Buffer.byteLength(diff.stdout) > MAX_DIFF_BYTES) {
    console.error(`mind review: nothing was sent — the diff is over ${MAX_DIFF_BYTES} bytes; split the change.`);
    return 1;
  }

  const health = fileHealth(healthPath(dialEnv().home, dialEnv().env));
  const reach = new Map<string, boolean>();
  await Promise.all(
    candidates.map(async (id) => {
      try {
        reach.set(id, (await backendFor(id).available()).ok);
      } catch {
        reach.set(id, false);
      }
    }),
  );
  const picked = pickReviewer([...authors], candidates, (id) => {
    const rest = health.coolingUntil(id, Date.now());
    if (rest !== undefined) return { ok: false, why: `resting until ${new Date(rest.until).toISOString()}` };
    return reach.get(id) === true ? { ok: true } : { ok: false, why: "not reachable here" };
  });
  if (!picked.ok) {
    console.error(`mind review: nothing was sent — ${picked.reason}`);
    return 3;
  }
  console.error(`mind review: ${picked.reviewer} reviews a change by ${[...authors].join(", ")}${picked.skipped.length > 0 ? ` (passed over: ${picked.skipped.join("; ")})` : ""}. The diff goes to that vendor like any prompt; the notice below is the turn's own.`);

  // An ordinary turn, so the egress notice, the I-6 screen, the ledger and `mind stop` all apply. The prompt goes in a
  // file of its own (argv is readable by every local user) and is removed when the turn ends.
  const scratch = await mkdtemp(join(tmpdir(), "mind-review-"));
  let text = "";
  let turn: string | null = null;
  let why = "";
  try {
    const file = join(scratch, "prompt.txt");
    await writeFile(file, reviewPrompt(diff.stdout, options.get("context")), { mode: STATE_FILE_MODE });
    const child = spawnGuarded([...engineCommand().argv, "turn", resolve(dir), "--subject", subject, "--prompt-file", file, "--json", "--backend", picked.reviewer], { cwd: repo, env: process.env });
    // The turn's own stderr, line by line as it comes: the egress notice is the one line that must not wait.
    const relayed = (async () => {
      const decoder = new TextDecoder();
      let held = "";
      for await (const chunk of child.stderr) {
        held += decoder.decode(chunk, { stream: true });
        const cut = held.lastIndexOf("\n");
        if (cut >= 0) {
          console.error(held.slice(0, cut));
          held = held.slice(cut + 1);
        }
      }
      if (held !== "") console.error(held);
    })();
    const out = await new Response(child.stdout).text();
    await relayed;
    await child.exited;
    const read = readTurnJson(out);
    text = read.text;
    turn = read.turnId;
    why = read.why ?? "";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (text === "") {
    console.error(`mind review: ${picked.reviewer} did not answer${why === "" ? "" : ` — ${why}`}. Nothing was decided.`);
    return 1;
  }
  const read = readVerdict(text);
  if (!read.ok) {
    console.error(`mind review: the answer could not be read — ${read.reason}. Nothing was decided. What it said:\n${text.slice(0, 1500)}`);
    return 1;
  }

  const record: ReviewRecord = { at: new Date().toISOString(), reviewer: picked.reviewer, authors: [...authors], verdict: read.verdict, counts: countsOf(read.findings), turn };
  if (taskDir !== undefined) await appendFile(join(taskDir, "reviews.jsonl"), `${JSON.stringify(record)}\n`, { mode: STATE_FILE_MODE });
  if (options.has("json")) {
    console.log(JSON.stringify({ ok: true, ...record, findings: read.findings }));
  } else {
    console.log(`${read.verdict === "approve" ? "approved" : "changes asked for"} by ${picked.reviewer} — ${record.counts.blocker} blocker(s), ${record.counts.major} major, ${record.counts.minor} minor`);
    for (const f of read.findings) console.log(`  ${f.severity}  ${f.file}${f.line === null ? "" : `:${f.line}`}  ${f.text}`);
    console.error("A reviewer's verdict is an opinion from a model, not a gate: whoever merges decides.");
  }
  return read.verdict === "approve" ? 0 : 7;
}
