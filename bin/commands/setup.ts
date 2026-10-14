/**
 * `mind setup` — the first run, step by step (D-056).
 *
 * Each step is an existing command run as a child, so what setup does is what
 * those commands do — the same refusals, the same notices, the same records.
 * The questions and what the answers become live in `src/setup/wizard.ts`.
 */

import { writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { readMind } from "../../src/env.ts";
import { OLLAMA_MODEL_ENV } from "../../src/exec/ollama-exec.ts";
import { judgeStatus, loadLexicon } from "../../src/egress/index.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import { serializeSoul } from "../../src/soul/serialize.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { PERSON_FILE, ROLE_FILE } from "../../src/soul/schema.ts";
import { chooseModel, nextSteps, QUESTIONS, resolveAnswer, withAnswers, type SetupAnswers, type SetupEnv } from "../../src/setup/wizard.ts";
import { runGuarded } from "../../src/spawn.ts";
import { subjectId } from "../../src/types.ts";
import { dialEnv } from "../dial.ts";
import { bold, dim, lineReaderOrEnd, parseArgs, usageError } from "../shared.ts";

const USAGE = "usage: mind setup [--no-turn]";

/** The home and login name the defaults are made from. */
function setupEnv(): SetupEnv {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (some containers): the subject question then has no default.
  }
  return { home: homedir(), user: process.env["USER"] ?? user };
}

/** Run this engine with some arguments, printing what it printed. */
async function self(args: readonly string[]): Promise<number> {
  const run = await runGuarded([...engineCommand().argv, ...args]);
  const out = new TextDecoder().decode(run.stdout).trimEnd();
  if (out !== "") console.log(out);
  if (run.stderr !== "") console.error(run.stderr);
  return run.code;
}

/** Which backend a first turn should use, and the local models there are. */
async function detectBackends(): Promise<{ ollama: readonly string[] | null; vendors: readonly string[] }> {
  const host = (process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  let ollama: readonly string[] | null = null;
  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const body = (await response.json()) as { models?: { name?: unknown }[] };
      ollama = (body.models ?? []).flatMap((m) => (typeof m.name === "string" ? [m.name] : []));
    }
  } catch {
    // Not reachable. Said below.
  }
  const vendors = ["claude", "codex", "grok", "gemini", "copilot", "kimi"].filter((cli) => Bun.which(cli) !== null);
  return { ollama, vendors };
}

export async function cmdSetup(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["no-turn"]);
  if (positional.length > 0) return usageError(USAGE);
  // One reader for the run, its lock released after every line: a terminal sends one line per Enter, a pipe sends
  // them all at once, and the process must still end by itself when the last answer is read (B2).
  const read = lineReaderOrEnd(() => Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const env = setupEnv();

  // The prompt ends its own line: writing without a newline would mean reading
  // the process.stdout getter, which this engine does not (test/cli/streams.test.ts).
  const ask = async (prompt: string, fallback: string): Promise<string | undefined> => {
    console.log(`${prompt}${fallback === "" ? "" : dim(` [${fallback}]`)} ›`);
    return read();
  };

  console.log(bold("mind setup — one agent, step by step"));
  console.log(
    dim(
      "Each step runs a mind command you could type yourself. Press Enter to take the answer in [brackets].\n" +
        "Nothing here raises what the agent may do on its own, turns on capture, or writes into your AI CLIs' files.\n",
    ),
  );

  console.log(bold("1 · this machine"));
  await self(["backends"]);
  console.log();

  console.log(bold("2 · the agent"));
  const so: Partial<Record<keyof SetupAnswers, string>> = {};
  for (const question of QUESTIONS) {
    for (;;) {
      if (question.hint !== undefined) console.log(dim(`  ${question.hint}`));
      const fallback = question.fallback(so, env);
      const typed = await ask(`  ${question.ask}`, fallback);
      if (typed === undefined && fallback === "") {
        console.error(`mind: setup ran out of input at "${question.ask}". Nothing more was done.`);
        return 1;
      }
      const answer = resolveAnswer(question, typed ?? "", so, env);
      const problem = question.check?.(answer);
      if (problem === undefined) {
        so[question.key] = answer;
        break;
      }
      console.log(`  ${problem}`);
      if (typed === undefined) return 1;
    }
  }
  const answers = so as SetupAnswers;
  const subject = subjectId(answers.subject);
  const dir = resolve(join(answers.parent, answers.name));
  console.log();

  console.log(bold("3 · create it"));
  const made = await self(["new", answers.name, "--subject", subject, "--dir", answers.parent]);
  if (made !== 0) {
    console.error(`mind: \`new\` did not finish (exit ${made}); setup stops here. Nothing else was written.`);
    return made;
  }

  const loaded = await loadSoul(dir, subject);
  if (!loaded.ok) {
    console.error(`mind: the soul \`new\` wrote does not load: ${loaded.issues.map((i) => i.message).join("; ")}`);
    return 1;
  }
  const files = serializeSoul(withAnswers(loaded.soul, answers));
  await writeFile(join(dir, "soul", ROLE_FILE), files.role);
  await writeFile(join(dir, "soul", PERSON_FILE), files.person);
  const checked = await self(["soul", "check", dir, "--subject", subject]);
  if (checked !== 0) return checked;
  console.log();

  console.log(bold("4 · what it may do by itself"));
  console.log(
    "  Level 1 — it proposes, and nothing it proposes happens until you approve it. That is where it starts,\n" +
      "  and setup leaves it there. `mind autonomy set` raises a category when you decide to.",
  );
  console.log();

  if (!options.has("no-turn")) {
    console.log(bold("5 · a first turn"));
    const found = await detectBackends();
    const local = found.ollama !== null && found.ollama.length > 0;
    console.log(
      dim(
        `  local models: ${found.ollama === null ? "Ollama did not answer" : local ? found.ollama.join(", ") : "none pulled"}` +
          ` · AI CLIs on PATH: ${found.vendors.length > 0 ? found.vendors.join(", ") : "none"}`,
      ),
    );
    const backendFallback = local ? "ollama" : (found.vendors[0] ?? "skip");
    const backend = ((await ask("  Which backend for a first turn? (or skip)", backendFallback)) ?? "").trim() || backendFallback;
    if (backend !== "skip") {
      const args = ["turn", dir, "--subject", subject, "--backend", backend];
      if (backend === "ollama") {
        const chosen = chooseModel(found.ollama ?? [], readMind(OLLAMA_MODEL_ENV, process.env));
        const modelFallback = chosen.model;
        console.log(dim(`  default model: ${chosen.model === "" ? "none" : chosen.model} — ${chosen.why}`));
        const model = ((await ask("  Which model?", modelFallback)) ?? "").trim() || modelFallback;
        if (model !== "") args.push("--model", model);
      }
      args.push("--prompt", "In two sentences: who are you, what are you for, and are you a human?");
      const turned = await self(args);
      if (turned !== 0) console.log(dim(`  the turn did not finish (exit ${turned}); the agent is set up regardless.`));
    }
    console.log();
  }

  console.log(bold("Done."));
  console.log(`  ${dir} is a git repository; the soul you just described is not committed yet:`);
  console.log(`    cd ${dir} && git add soul && git commit -m "soul: first description"`);
  console.log();
  // D-181: nothing is listed to protect yet, so the second layer, on or not, has nothing to read a text against.
  const listed = (await loadLexicon(dialEnv(), subject, loaded.soul.person.inherits_from).catch(() => undefined))?.lexicon.needles.length;
  console.log(dim(`  ${judgeStatus(process.env, listed)}`));
  console.log();
  console.log("  Next, when you want them:");
  for (const line of nextSteps(dir, subject)) console.log(`    ${line}`);
  return 0;
}
