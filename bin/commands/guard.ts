/** `mind guard` — install the hooks, scan what is staged, report both. */

import { resolve } from "node:path";
import {
  GIT_UNDELETABLE,
  SCAN_BLIND_SPOTS,
  SCAN_RULE_COUNT,
  engineCommand,
  formatFinding,
  historyFacts,
  historySentence,
  hookStatus,
  installHooks,
  scanStaged,
  stagedDeletions,
  stagedFiles,
} from "../../src/guard/index.ts";
import { GUARD_LIMITS } from "../../src/spawn.ts";
import { bold, dim, dimErr, parseArgs, usageError } from "../shared.ts";

/** Resolve the directory a guard subcommand works on: the argument, or here. */
function guardDir(positional: readonly string[]): string {
  const dir = positional[0];
  return resolve(dir === undefined || dir === "" ? process.cwd() : dir);
}

/** Every list the guard is required to print beside a verdict, in one place. */
function printGuardNotes(write: (line: string) => void): void {
  write(bold("What the pre-commit scan cannot see:"));
  for (const note of SCAN_BLIND_SPOTS) write(dim(`  - ${note}`));
  write(bold("What this guard does not prevent:"));
  for (const note of GUARD_LIMITS) write(dim(`  - ${note}`));
}

async function cmdGuardInstall(argv: readonly string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const dir = guardDir(positional);

  const outcome = await installHooks(dir, engineCommand());
  if (!outcome.ok) {
    console.error(`mind: ${outcome.reason}`);
    return 1;
  }

  for (const path of outcome.written) console.log(`installed ${path}`);
  console.log(
    dim(
      "These live in .git/hooks, which git does not clone and does not track. They can be " +
        "rewritten at any time with this command, and deleted with rm.",
    ),
  );
  console.log();
  printGuardNotes((line) => console.log(line));
  return 0;
}

/**
 * `mind guard scan --staged` — what the pre-commit hook runs.
 *
 * Two properties are worth more than the rule list. It reads the **index**, so
 * a file edited after it was staged is judged by the bytes a commit would
 * keep; and it never prints what it matched, because a blocked commit that
 * echoed the token would have put it in scrollback, in a CI log, and in
 * whatever the output was piped to — none of which any `forget` can reach.
 *
 * Everything goes to stderr, including the summary on a passing run: stdout
 * belongs to whoever piped this, and a hook is a thing you read, not parse.
 */
async function cmdGuardScan(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["staged"]);
  if (!options.has("staged")) {
    return usageError(
      "usage: mind guard scan --staged [<dir>] — the index is the only thing worth scanning, " +
        "and naming it is how the hook's command line says so",
    );
  }
  const dir = guardDir(positional);

  let files;
  try {
    files = await stagedFiles(dir);
  } catch (error) {
    console.error(`mind: cannot read what is staged in ${dir}: ${String(error)}`);
    console.error("Nothing was scanned, so this is a block rather than a pass.");
    return 1;
  }

  const findings = scanStaged(files);

  if (findings.length > 0) {
    console.error(`mind guard: ${findings.length} finding(s) in what you staged — commit blocked.`);
    // `console.error("")` and not `console.error()`: with no arguments the
    // newline goes to **stdout** under bun 1.4.2, which would put `\n\n\n` in
    // the stream this command promises to leave empty and take the separators
    // out of the block they separate. The empty string is the whole fix, and
    // it belongs here rather than being deleted because stderr already has a
    // line on it — this is a spacer *within* one stream, and somebody keeping
    // `2> guard.log` reads the result.
    console.error("");
    for (const finding of findings) console.error(`  ${formatFinding(finding)}`);
    console.error("");
    console.error(
      "The matched text is deliberately not printed: it would be in this terminal's scrollback, " +
        "and nothing Mind has can delete that.",
    );
    console.error(
      "Fix the file and stage it again. If this is a false positive, `git commit --no-verify` " +
        "skips this hook — knowing that is the point of the list below.",
    );
    console.error("");
    printGuardNotes((line) => console.error(line));
    return 1;
  }

  if (files.length === 0) {
    // Not the word `passed`, and the exit code is 0 anyway. odd2's H7 asked for
    // a non-zero exit here and that is the wrong repair: the reachable way to
    // stage no bytes is a commit that only **deletes** files, which carries
    // nothing into git and is exactly what somebody removing a secret does.
    // Blocking it would teach people `--no-verify`, and a guard everybody
    // disables is worth less than no guard at all.
    //
    // What was dishonest was the sentence. "0 staged file(s) passed 18 rules"
    // is a pass reported over a scan that read nothing.
    const deletions = await stagedDeletions(dir).catch(() => []);
    console.error(
      dimErr(
        `mind guard: nothing staged carries bytes — no file was read, and no rule was run` +
          (deletions.length === 0
            ? ". Nothing is staged, or everything staged is a mode change git reports as neither."
            : ` (${deletions.length} staged deletion(s), which carry nothing into the commit).`),
      ),
    );
    console.error(
      dimErr(
        "This is not a pass and not a block: there was nothing to read. A commit that only " +
          "removes files is allowed through on purpose — blocking somebody from deleting a " +
          "secret would be backwards.",
      ),
    );
    for (const note of SCAN_BLIND_SPOTS) console.error(dimErr(`  - ${note}`));
    return 0;
  }

  console.error(
    dimErr(
      `mind guard: ${files.length} staged file(s) passed ${SCAN_RULE_COUNT} rules. ` +
        `That is not the same as "there is nothing personal in this commit".`,
    ),
  );
  // Printed on the runs that pass, not only the runs that block: the person
  // reading the word "passed" is the person about to believe it is safe.
  for (const note of SCAN_BLIND_SPOTS) console.error(dimErr(`  - ${note}`));
  return 0;
}

async function cmdGuardStatus(argv: readonly string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const dir = guardDir(positional);

  let hooks;
  let facts;
  try {
    hooks = await hookStatus(dir);
    facts = await historyFacts(dir);
  } catch (error) {
    console.error(`mind: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(bold(`guard status — ${dir}`));
  for (const hook of hooks) {
    console.log(`  ${hook.name.padEnd(11)} ${hook.state.padEnd(10)} ${hook.path}`);
  }
  const missing = hooks.filter((hook) => hook.state !== "installed");
  if (missing.length > 0) {
    console.log(
      dim(
        `  ${missing.length} hook(s) are not Mind's. \`foreign\` means a hook somebody else ` +
          `wrote, which Mind will not overwrite; \`absent\` means nothing is there. ` +
          `Run: mind guard install ${dir}`,
      ),
    );
  }

  console.log();
  // One sentence, from `src/guard/history.ts`, so that the unreadable case
  // cannot be spelled one way here and another on the erase certificate — and
  // so that neither can print a zero it did not count. What used to keep this
  // command honest was `hookStatus` throwing first, which is a guard that has
  // nothing to do with the thing it guards (odd2 H3).
  console.log(`${historySentence(facts)}.`);
  if (facts.readable) {
    for (const remote of facts.remotes) console.log(`  ${remote.name.padEnd(10)} ${remote.url}`);
    if (facts.remotes.length === 0) console.log(dim("Mind never adds a remote."));
  }
  console.log(
    dim(
      "Mind cannot see whether a remote is private — that is a question only the host can " +
        "answer, and Mind does not ask hosts anything. It will not print `private` next to a " +
        "URL it has not checked.",
    ),
  );

  console.log();
  console.log(bold("What git keeps, whatever you delete later:"));
  for (const note of GIT_UNDELETABLE) console.log(dim(`  - ${note}`));
  console.log();
  printGuardNotes((line) => console.log(line));

  return missing.length > 0 ? 1 : 0;
}

export async function cmdGuard(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "install":
      return cmdGuardInstall(rest);
    case "scan":
      return cmdGuardScan(rest);
    case "status":
      return cmdGuardStatus(rest);
    default:
      return usageError(
        `unknown guard subcommand ${JSON.stringify(sub ?? "")} — try "install", "scan" or "status"`,
      );
  }
}
