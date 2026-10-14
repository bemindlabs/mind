/** `mind egress` — what may not leave this machine, and the record of what did not (S8.3, D-048). */

import { join } from "node:path";
import {
  describeFindings,
  EGRESS_DIR,
  FILTER_LIMITS,
  FILTER_SHAPES,
  judgeOf,
  loadLexicon,
  NEEDLES_FILE,
  NOT_LOCAL_CAUSE,
  readBlocked,
  resolveJudgeMode,
  screenOutbound,
} from "../../src/egress/index.ts";
import { personalDir } from "../../src/guard/personal.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { dialEnv } from "../dial.ts";
import { bold, dim, parseArgs, usageError } from "../shared.ts";

const USAGE =
  "usage: mind egress needles --subject <id>\n" +
  "       mind egress check --subject <id> <text...>\n" +
  "       mind egress log --subject <id>";

function subjectOf(raw: string | undefined): { ok: true; id: SubjectId } | { ok: false; code: number } {
  if (raw === undefined || raw === "") return { ok: false, code: usageError(USAGE) };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

/** Where the needles file is, and how many it holds. Never what they are. */
async function cmdNeedles(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options.get("subject"));
  if (!s.ok || positional.length > 0) return s.ok ? usageError(USAGE) : s.code;
  const dir = await personalDir(dialEnv(), s.id);
  const path = join(dir.path, EGRESS_DIR, NEEDLES_FILE);
  const { lexicon, source } = await loadLexicon(dialEnv(), s.id, []);
  console.log(path);
  console.log(
    dim(
      source === null
        ? "no needles file yet. Write one phrase per line — a name, an address, anything that must not leave — and `#` for a comment. It is personal, outside git, and `erase` removes it."
        : `${lexicon.needles.length} needle(s). Mind never prints them.`,
    ),
  );
  return 0;
}

/** Screen a text the way a turn would. Exit 1 when it would be kept in. */
async function cmdCheck(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options.get("subject"));
  if (!s.ok) return s.code;
  if (positional.length === 0) return usageError(USAGE);
  const { lexicon } = await loadLexicon(dialEnv(), s.id, []);
  const text = positional.join(" ");
  // D-181: as a turn would be screened — the judge named, or automatic when a local model is configured.
  const resolution = resolveJudgeMode("cloud-turn", process.env);
  const judge = judgeOf(resolution);
  const findings = await screenOutbound(text, lexicon, resolution);
  console.log(findings.length === 0 ? "may leave — no finding" : `kept in — ${describeFindings(findings)}`);
  console.log(
    dim(
      judge === undefined
        ? resolution.reason === "local-model-not-local"
          ? `second layer: off — ${NOT_LOCAL_CAUSE}; a turn or an A2A message goes on with the filter alone and says so each time (D-181)`
          : "second layer: off — a turn or an A2A message goes on with the filter alone and says so each time; set MIND_EGRESS_JUDGE=<local ollama model> (or MIND_OLLAMA_MODEL) to have a model on this machine read meaning too (D-061, D-181)"
        : `second layer: on${resolution.mode === "auto-on" ? " by itself (MIND_OLLAMA_MODEL)" : ""} — ${judge.model} at ${judge.host}${lexicon.needles.length === 0 ? " (idle: no needles to protect)" : ""}`,
    ),
  );
  console.log();
  console.log(bold("What this recognises without being told — it supplements your needles and never replaces them:"));
  for (const shape of FILTER_SHAPES) console.log(dim(`  - ${shape.rule}: ${shape.says}`));
  console.log(dim("  - secret:*: a credential, by the repo guard's own rules"));
  console.log();
  console.log(bold("What this cannot see:"));
  for (const note of FILTER_LIMITS) console.log(dim(`  - ${note}`));
  return findings.length === 0 ? 0 : 1;
}

/** AC4 — what was kept in, when, going where, by which rule. */
async function cmdLog(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options.get("subject"));
  if (!s.ok || positional.length > 0) return s.ok ? usageError(USAGE) : s.code;
  const entries = await readBlocked(dialEnv(), s.id);
  if (entries.length === 0) {
    console.log("nothing has been kept in");
    return 0;
  }
  for (const entry of entries) console.log(`${entry.at}  ${entry.backend.padEnd(8)}  ${describeFindings(entry.findings)}`);
  return 0;
}

export async function cmdEgress(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "needles":
      return cmdNeedles(rest);
    case "check":
      return cmdCheck(rest);
    case "log":
      return cmdLog(rest);
    default:
      return usageError(`unknown egress subcommand ${JSON.stringify(sub ?? "")} — try "needles", "check" or "log"`);
  }
}
