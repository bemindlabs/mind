/**
 * `--as <dir>` — resolved before dispatch, and nowhere else.
 *
 * It expands into the `<dir> --subject <id>` every command already takes, so
 * no command learns a second way to be told whose identity it is working on
 * (D-003). That is why this is its own file rather than part of any command's:
 * every command it can expand for would otherwise have to import it.
 */

import { join } from "node:path";
import { SOUL_DIR } from "../src/agent/index.ts";
import { ROLE_FILE, loadSoul, parseFrontmatter, type SoulIssue } from "../src/soul/index.ts";
import { isSubjectId, subjectId } from "../src/types.ts";
import {
  SOUL_APPLY_BOOLEANS,
  SOUL_REVOKE_BOOLEANS,
  SOUL_CHECK_BOOLEANS,
  SOUL_VERIFY_BOOLEANS,
} from "./commands/soul.ts";
import { TURN_BOOLEANS } from "./commands/turn.ts";
import { WORN_BOOLEANS } from "./commands/worn.ts";
import { parseArgs, report, takesVerbatimAfterDashes, usageError } from "./shared.ts";

/**
 * What `--as` has to supply for one command, and how to read that command's
 * own arguments well enough to notice a conflict.
 *
 * `booleans` is needed for one reason: without it `--backend ollama` reads as a
 * positional and `--as` would refuse a command line that is perfectly fine. It
 * is the **same array** the command itself passes to {@link parseArgs},
 * imported rather than restated — these used to be two lists in two files kept
 * in step by hand, and the day they disagreed `--as turn --private` would have
 * parsed one way here and another way one function later.
 *
 * Each list still lives beside the command that owns it, so adding a flag to one
 * command cannot change how another is parsed; what moved is only the copy.
 * `test/cli/layout.test.ts` checks that they are the same arrays and not equal
 * ones, which a copy typed back in here would fail.
 */
interface AsCommand {
  readonly needs: "dir-and-subject" | "subject-only";
  readonly booleans: readonly string[];
}

export const AS_COMMANDS: ReadonlyMap<string, AsCommand> = new Map([
  ["soul check", { needs: "dir-and-subject", booleans: SOUL_CHECK_BOOLEANS }],
  ["soul apply", { needs: "dir-and-subject", booleans: SOUL_APPLY_BOOLEANS }],
  ["soul verify", { needs: "dir-and-subject", booleans: SOUL_VERIFY_BOOLEANS }],
  ["soul revoke", { needs: "subject-only", booleans: SOUL_REVOKE_BOOLEANS }],
  ["turn", { needs: "dir-and-subject", booleans: TURN_BOOLEANS }],
  ["worn", { needs: "subject-only", booleans: WORN_BOOLEANS }],
] as const);

/**
 * The soul directory `--as <dir>` means.
 *
 * An agent is a repository with its soul in `soul/` (S0.3), and a soul on its
 * own is a directory with `role.md` in it. Both are things someone would point
 * at, so both are accepted — and which one was found is reported, because
 * guessing silently between two directories is how a switch applies the wrong
 * identity.
 */
async function soulDirOf(given: string): Promise<string | undefined> {
  const nested = join(given, SOUL_DIR);
  if (await Bun.file(join(nested, ROLE_FILE)).exists()) return nested;
  if (await Bun.file(join(given, ROLE_FILE)).exists()) return given;
  return undefined;
}

/**
 * The subject a soul directory declares — read from the file, never the name.
 *
 * Two steps, and the second is the one that matters. `role.md` is parsed for
 * its `subject` key, and then the whole soul is loaded *as* that subject, which
 * is what makes `person.md` agree too (`src/soul/schema.ts` checks both). A
 * directory called `busaba/` holding someone else's `person.md` is refused here
 * rather than worn (I-3).
 */
async function subjectOfSoulDir(
  dir: string,
): Promise<{ readonly ok: true; readonly subject: string } | { readonly ok: false; readonly issues: readonly SoulIssue[] }> {
  const rolePath = join(dir, ROLE_FILE);
  const handle = Bun.file(rolePath);
  if (!(await handle.exists())) {
    return {
      ok: false,
      issues: [{ file: rolePath, line: 0, path: "", message: "not found — a soul directory holds role.md" }],
    };
  }

  const front = parseFrontmatter(ROLE_FILE, await handle.text());
  if (!front.ok) return front;

  const declared = front.value.doc.table["subject"];
  if (typeof declared !== "string" || !isSubjectId(declared)) {
    return {
      ok: false,
      issues: [
        {
          file: ROLE_FILE,
          line: front.value.doc.lines.get("subject") ?? front.value.openLine,
          path: "subject",
          message:
            "must be a subject id — Mind will not take the identity from the directory name, " +
            "because a directory name is a hint and an identity is a claim (I-3)",
        },
      ],
    };
  }

  const loaded = await loadSoul(dir, subjectId(declared));
  if (!loaded.ok) return loaded;
  return { ok: true, subject: loaded.soul.subject };
}

type AsExpansion =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly code: number };

/**
 * Turn `mind --as <dir> <command>` into the `<dir> --subject <id>` the
 * commands already take.
 *
 * Pure sugar, and deliberately nothing more. Mind keeps no list of agents
 * (D-049 — S1.1 AC2 was reworded rather than built): an identity is named by
 * its directory. So `--as` takes a directory, and
 * the subject comes out of the files in it. Anything else would mean inventing
 * the registry here, where it would have no test and no story behind it.
 *
 * Refuses rather than resolves a conflict: `--as` with `--subject`, or `--as`
 * with a directory argument, are two answers to one question, and picking one
 * of them quietly is how the wrong identity gets applied.
 */
export async function expandAs(argv: readonly string[]): Promise<AsExpansion> {
  let given: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    // For `memory ask` only, a bare `--` ends the options: `--as=…` after it is its question (D-152). Every
    // other command reads `--as` wherever it sits, as it always has.
    if (token === "--" && takesVerbatimAfterDashes(argv[0] ?? "", argv[1])) {
      rest.push(...argv.slice(index));
      break;
    }
    if (token === "--as") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, code: usageError("--as needs the directory of a soul, or of an agent") };
      }
      given = value;
      index++;
      continue;
    }
    if (token.startsWith("--as=")) {
      given = token.slice("--as=".length);
      continue;
    }
    rest.push(token);
  }

  if (given === undefined) return { ok: true, argv };
  if (given === "") {
    return { ok: false, code: usageError("--as needs the directory of a soul, or of an agent") };
  }

  const head = rest[0] ?? "";
  const key = head === "soul" ? `soul ${rest[1] ?? ""}` : head;
  const spec = AS_COMMANDS.get(key);
  if (spec === undefined) {
    return {
      ok: false,
      code: usageError(
        `--as does not apply to ${JSON.stringify(key.trim() || "no command")} — it fills in ` +
          `<dir> and --subject for ${[...AS_COMMANDS.keys()].map((k) => `\`${k}\``).join(", ")}. ` +
          `Other commands take --subject directly.`,
      ),
    };
  }

  const commandTokens = key.startsWith("soul ") ? rest.slice(0, 2) : rest.slice(0, 1);
  const sub = rest.slice(commandTokens.length);
  const { positional, options } = parseArgs(sub, spec.booleans);

  if (options.has("subject")) {
    return {
      ok: false,
      code: usageError(
        "--as and --subject both name an identity; pass one. `--as` reads the subject out of " +
          "the soul's own files, which is the half that cannot be wrong.",
      ),
    };
  }
  if (positional.length > 0) {
    return {
      ok: false,
      code: usageError(
        `--as ${given} already says where the soul is; drop ${JSON.stringify(positional[0]!)}`,
      ),
    };
  }

  const dir = await soulDirOf(given);
  if (dir === undefined) {
    return {
      ok: false,
      code: usageError(
        `no soul at ${given}: neither ${join(given, SOUL_DIR, ROLE_FILE)} nor ` +
          `${join(given, ROLE_FILE)} exists`,
      ),
    };
  }

  const resolved = await subjectOfSoulDir(dir);
  if (!resolved.ok) return { ok: false, code: report(resolved.issues) };

  return {
    ok: true,
    argv: [
      ...commandTokens,
      ...(spec.needs === "dir-and-subject" ? [dir] : []),
      "--subject",
      resolved.subject,
      ...sub,
    ],
  };
}
