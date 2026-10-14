/**
 * Which tool names mean "a file was edited" and which mean "a command ran" —
 * per vendor, in one place.
 *
 * `docs/cli-matrix.md` already records that copying an allowlist from one
 * vendor to another does not work: claude says `Edit` and grok says
 * `search_replace`, and a filter written against the wrong spelling silently
 * matches nothing. The same is true of a classifier, and the failure is worse
 * here because it is not silent-and-empty but silent-and-wrong: an unrecognised
 * editing tool lands in `kind: "tool"` with no target, and the owner's most
 * characteristic behaviour — which files they touch — quietly stops being
 * recorded.
 *
 * So the lists are here rather than inside an adapter, both vendors' names are
 * in them, and nothing infers a kind from the shape of a name.
 */

import type { CaptureKind } from "../record.ts";
import { commandTarget, fileTarget } from "../record.ts";

/**
 * Names that mean a file was written, across both vendors.
 *
 * `Read`, `Glob` and `Grep` are deliberately absent: reading is not the
 * behaviour `S3.2 AC1` asks for, and recording every file an agent looked at
 * would bury the handful it changed. They land in `tool` and carry no target.
 */
const FILE_TOOLS: ReadonlySet<string> = new Set([
  // claude
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  // grok
  "write_file",
  "edit_file",
  "create_file",
  "search_replace",
  "str_replace_editor",
]);

/** Names that mean something was run in a shell, across both vendors. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  // claude
  "Bash",
  "BashOutput",
  "KillBash",
  "KillShell",
  // grok
  "run_terminal_cmd",
  "terminal",
]);

/**
 * Every tool name Mind is willing to write down outside the personal store.
 *
 * The two sets above plus the read-only and search tools each vendor ships,
 * taken from the per-vendor table in `docs/cli-matrix.md` — measured off the
 * installed binaries rather than recalled, the rule that file's own header
 * states. Sorted and de-duplicated so the list reads the same however it is
 * built.
 *
 * It lives here because this is where knowledge of what the vendors call things
 * belongs; `src/observer/actions.ts` consumes it as the closed vocabulary a
 * committed summary may use. A name that is not here is counted as `other`, and
 * the case that matters most is `mcp__<server>__<tool>`: a server name is a
 * company, and often a person (SP-1 guard 1), so it can never be on this list.
 */
export const BUILTIN_TOOLS: readonly string[] = [
  ...new Set([
    ...FILE_TOOLS,
    ...COMMAND_TOOLS,
    // claude (docs/cli-matrix.md)
    "Read",
    "Grep",
    "Glob",
    "Task",
    "WebFetch",
    "WebSearch",
    // grok (docs/cli-matrix.md)
    "read_file",
    "grep",
    "list_dir",
    "web_search",
    "web_fetch",
    "todo_write",
    "task",
  ]),
].sort();

/** Parameter names that hold a path, in the order a call is likely to spell it. */
const PATH_KEYS: readonly string[] = [
  "file_path",
  "filePath",
  "notebook_path",
  "target_file",
  "path",
  "file",
  "absolute_path",
];

/** Parameter names that hold a command line. */
const COMMAND_KEYS: readonly string[] = ["command", "cmd"];

/** Which of the three action kinds a tool name is. Never `prompt`, which is not a tool. */
export function kindOf(tool: string): Exclude<CaptureKind, "prompt"> {
  if (FILE_TOOLS.has(tool)) return "file-edit";
  if (COMMAND_TOOLS.has(tool)) return "command";
  return "tool";
}

/** The first of `keys` this object holds as a non-empty string. */
function pick(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * What this call was aimed at, reduced by kind — see `record.ts` for why.
 *
 * A tool call whose arguments are not an object at all, or which names none of
 * the keys above, gets `""`. That is the honest answer: a target Mind could
 * not find is not a target it should invent from whatever string was longest.
 */
export function targetOf(
  kind: CaptureKind,
  input: unknown,
  project: string,
): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const raw = input as Record<string, unknown>;

  if (kind === "file-edit") {
    const path = pick(raw, PATH_KEYS);
    return path === undefined ? "" : fileTarget(path, project);
  }
  if (kind === "command") {
    const command = pick(raw, COMMAND_KEYS);
    return command === undefined ? "" : commandTarget(command);
  }
  // `tool` and `prompt` carry nothing. The tool's own name is already recorded,
  // and the owner's decision was that anything not a path or a command keeps no
  // arguments at all.
  return "";
}
