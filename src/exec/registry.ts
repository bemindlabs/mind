/**
 * What each vendor CLI actually does — measured, not assumed.
 *
 * Every field was read off the CLI's own `--help` on a machine with all of
 * them installed; `docs/cli-matrix.md` records the survey and the versions.
 * Re-run it when a vendor updates, because these differences move between
 * releases and the failures they cause are silent.
 *
 * Nothing here names a person, a machine, or an account (D-021): paths are
 * written with `~` and expanded at call time, so this file is the same on
 * every install.
 *
 * Two measured facts shape everything above this file:
 *
 *   1. Only two of these CLIs accept a system prompt as a flag. The rest take
 *      an identity *only* as a file on disk. The file is therefore the
 *      universal channel and the flag is an optimisation for two vendors.
 *   2. The file channel is weaker. A flag lands the soul as a system prompt;
 *      a file lands it as user-level instructions, which a model may weigh
 *      less. Mind reports that difference rather than flattening it.
 *   3. **Not one of these CLIs is read-only by default.** Each turn Mind
 *      starts is an agent with a shell and a file-writing tool, and the only
 *      thing between that agent and the working directory is a flag in
 *      {@link VendorSpec.readOnly}. A vendor that offers no such flag has to
 *      say so in the registry rather than being left to look like the others.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { NonEmpty } from "../types.ts";
import type { IdentityStrength } from "./backend.ts";
// Type-only, and it has to stay that way: `restraint.ts` imports the two types
// below from here, so a value import in either direction would be a cycle.
import type { Restraint } from "./restraint.ts";

/** How an identity reaches one vendor, and how strongly. */
export interface IdentityChannel {
  readonly strength: IdentityStrength;
  /**
   * Files this CLI reads for user-level instructions, most authoritative
   * first. Written with a leading `~` for the user's home, or `./` for a
   * path resolved against the working directory.
   *
   * A `./` entry means the vendor has *no* home-scoped channel: the identity
   * can only be delivered per project. That is a vendor limitation Mind
   * reports; it cannot fix it.
   */
  readonly instructionFiles: readonly string[];
  /** Flag that appends to the system prompt without replacing it. */
  readonly appendPromptFlag?: string;
  /**
   * Flag that replaces the entire system prompt.
   *
   * Recorded for completeness; Mind does not use it. Replacing a vendor's
   * own system prompt removes its tool instructions, and the result is a CLI
   * that runs, exits 0, and quietly cannot use its own tools.
   */
  readonly replacePromptFlag?: string;
}

/**
 * Where one vendor prints what a turn used, and in what shape.
 *
 * Two shapes because the two vendors that were measured do genuinely different
 * things: claude puts its counts in the same JSON object as the reply, while
 * `codex exec` writes a line of prose to stderr. A single shape would have
 * meant inventing a parser general enough for both, which is the kind of
 * cleverness that turns a vendor's format change into a wrong number instead of
 * a missing one.
 *
 * Nothing here is derived. A spec names the fields the vendor prints; when one
 * of them is not there the result is {@link UsageStatus} `missing`.
 */
export type UsageSpec =
  | {
      readonly shape: "json";
      readonly stream: "stdout" | "stderr";
      /**
       * Pointers summed into `input`. Never partially: a vendor that splits
       * prompt tokens across fields has no single field that means "input",
       * and reporting one of them as if it did is how a 81,000-token turn gets
       * recorded as 2. At least one pointer, or the spec says nothing.
       */
      readonly input: readonly string[];
      readonly output: string;
      /** A total the vendor computes itself. Absent where it does not. */
      readonly total?: string;
      /**
       * The part of `input` the vendor served from its prompt cache, and the
       * part it wrote into it (S15.9) — each one of the `input` pointers,
       * because it is a part of the prompt and not something beside it (the
       * registry test holds that). Absent where the vendor prints no such
       * count: the count is then `null` and listed in `not_printed`, never 0.
       */
      readonly cacheRead?: string;
      readonly cacheWrite?: string;
      /**
       * The parts of the cache write that went to the 5-minute and to the 1-hour cache (D-143) — both or
       * neither, and only beside {@link cacheWrite}, which they split (the registry test holds that). Absent
       * where the vendor prints no split: both counts are then `null` and listed in `not_printed`, and the
       * write is priced as one part.
       */
      readonly cacheWrite5m?: string;
      readonly cacheWrite1h?: string;
    }
  | {
      readonly shape: "text";
      readonly stream: "stdout" | "stderr";
      /** Label line; the count is on the line after it, thousands separators and all. */
      readonly totalAfterLine: string;
    };

/**
 * How far a mechanism has actually been checked.
 *
 * Three states rather than a boolean, for the same reason {@link UsageSpec}
 * has three: "nobody looked" and "it held when somebody looked" are different
 * claims, and collapsing them is how a table gets a tick it has not earned.
 *
 * - `probed` — a real turn in a scratch directory was told to write a file and
 *   the directory stayed empty. `test/exec/readonly.real.test.ts` is that turn;
 *   kimi's profile (D-120) was probed the same way in a recorded scratch run on
 *   a local model (`notes/2026-09-26_s12.6/`), and has not yet been re-run
 *   through that test on the owner's own vendor settings.
 * - `documented` — the vendor's own `--help` says the flag is read-only, and
 *   no turn has confirmed it on this machine. Believed, not measured.
 * - `writes` — a real turn was told to write a file and **the file appeared**.
 *   Only `none` carries this, and it is the honest end of the scale.
 */
export type ReadOnlyEvidence = "probed" | "documented" | "writes";

/**
 * What stops one vendor's turn from writing — or the statement that nothing does.
 *
 * Required on every vendor (see {@link VendorSpec.readOnly}) so that a seventh
 * CLI cannot be added without answering the question. `none` is a legal answer
 * and the point of the type: a vendor with no mechanism has to say so in a
 * field that `readonlyLimits()` prints, instead of quietly resembling the
 * vendors that do.
 *
 * The argv is built *from* this value by {@link readOnlyArgs} rather than
 * beside it. Two lists drift; one cannot.
 */
export type ReadOnlySpec =
  | {
      /**
       * `allow-tools` is the shape to prefer where a vendor offers both.
       * A deny list fails open — the day a vendor renames a tool, the old name
       * matches nothing and the tool comes back — and that is not a thought
       * experiment: grok's shell tool was denied as `run_terminal_cmd`, the
       * vendor renamed it `run_terminal_command`, and a probe wrote a file
       * through a flag that still looked like a fence. An allow list fails
       * closed: a drifted name costs the turn a tool it can no longer use.
       */
      readonly kind: "allow-tools" | "deny-tools" | "sandbox" | "approval-mode";
      readonly flag: string;
      /** One argv value per occurrence of the flag, in order. */
      readonly values: readonly string[];
      /**
       * A flag this vendor *requires* that loosens permissions, with the reason
       * it is safe here. Declared rather than merely present, so that the one
       * `--allow-all-tools` in this registry is a line somebody had to write
       * and a test can see, not a token hiding in an argv.
       */
      readonly despite?: { readonly flag: string; readonly why: string };
      readonly evidence: "probed" | "documented";
    }
  | {
      /**
       * A vendor agent profile that Mind writes and names by path (D-120).
       *
       * The allow list lives in {@link content}'s front matter, so it is
       * declared here rather than hidden in a file nobody reviews. `CliExec`
       * writes `content` to `values[0]` — expanded against the HOME the child
       * will get — before **every** restrained turn, never only the first: a
       * turn at level 2 has a shell and could have changed the file.
       */
      readonly kind: "agent-file";
      readonly flag: string;
      /**
       * One value, the path, `~/`-relative and passed verbatim: the vendor
       * expands `~/` against the child's own HOME, so the argv is the same on
       * every install (D-021). Never relative — that would resolve against a
       * working directory the repository controls.
       */
      readonly values: readonly [string];
      readonly content: string;
      readonly despite?: undefined;
      readonly evidence: "probed";
    }
  | {
      readonly kind: "none";
      /** What was looked for, what was found, and what it costs. Printed. */
      readonly why: string;
      readonly evidence: "writes";
    };

/**
 * How one vendor CLI takes a model, and where it says which model it ran (D-142).
 *
 * The flag is read off the CLI's own `--help` on this machine, never inferred
 * from another vendor's spelling (`docs/cli-matrix.md`). A vendor without this
 * field takes no model: `CliExec` refuses a turn that names one rather than run
 * it on the vendor's default and say nothing.
 */
export interface ModelSpec {
  /** The flag. The model always follows it as its own argv element — never `--flag=value`, never through a shell. */
  readonly flag: string;
  /**
   * Names the vendor itself documents for that flag — its `--help`, or a real
   * turn that resolved them. What the web picker offers for this backend, with
   * the price table's names for it (`src/web/models.ts`). Not a whitelist: any
   * name of the right shape still goes to the CLI, which decides.
   */
  readonly listed: readonly string[];
  /** Where the CLI's output names the model it ran, or null when nobody has measured that it does. */
  readonly reported: ModelReport | null;
  /** What was read, from which version, and when. */
  readonly evidence: string;
}

/**
 * The model a turn ran on, as the CLI's JSON output names it: the keys of one
 * object — one per model the turn called — and optionally a field inside each
 * entry with the vendor's canonical name for it.
 */
export interface ModelReport {
  /** JSON pointer to the object whose keys are the model ids the CLI called. */
  readonly keysOf: string;
  /** A string field of each entry naming the vendor's canonical model; used in place of the key when present. */
  readonly canonical?: string;
}

/** Longest model name Mind hands a CLI or records from one. Longer than any vendor's real id, shorter than a paragraph. */
export const MODEL_MAX = 128;

/**
 * A model name as Mind will put it on an argv or read it back out of a CLI's
 * output: starts with a letter or digit (so never with `-`, which a CLI would
 * read as a flag), then letters, digits and `._:@+/[]-` — `org/name`, `name:tag`
 * and claude's `opus[1m]` all fit; a space, a quote, a `$`, `=`, `,`, a control
 * character or a newline do not. Nothing here is a path check: the name is one
 * argv element, and no shell ever reads it.
 */
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@+/[\]-]*$/;

/** Why this string may not be handed to a backend as a model, or undefined when it may. */
export function modelProblem(model: string): string | undefined {
  if (model === "") return "is empty";
  if (model.length > MODEL_MAX) return `is longer than ${MODEL_MAX} characters`;
  if (model.startsWith("-")) return "starts with '-', which a CLI would read as a flag";
  if (!MODEL_SHAPE.test(model)) {
    return "has a character a model name does not have (letters, digits and ._:@+/[]- only, starting with a letter or digit)";
  }
  return undefined;
}

/** The flag and the model, as two argv elements — or nothing when no model is named. Every `headlessArgv` splices this. */
export function modelArgs(spec: ModelSpec, model: string | undefined): string[] {
  return model === undefined || model === "" ? [] : [spec.flag, model];
}

/** One vendor CLI: how to reach it, and what it gets wrong. */
export interface VendorSpec {
  readonly id: string;
  readonly display: string;
  /** Binary name, looked up on PATH. Never an absolute path. */
  readonly binary: string;
  /**
   * Whether a child inherits this process's environment before the request and
   * hardening overrides are applied. Ordinary cloud CLIs need the owner's
   * login variables, so omission means true. Local CLI variants set false:
   * their model credential and small runtime environment are assembled by
   * Mind, and a cloud key inherited by accident would defeat that isolation.
   */
  readonly inheritEnv?: boolean;
  readonly identity: IdentityChannel;
  /**
   * What keeps a turn on this vendor from writing.
   *
   * Required, with no default. A seventh CLI added without this field is a
   * `tsc` error, which is the only way this question gets asked reliably: the
   * alternative is an optional field nobody fills in and a table that reads as
   * if every vendor were covered.
   */
  readonly readOnly: ReadOnlySpec;
  /**
   * What levels 2 and 3 explicitly grant (D-047). Absent where Mind has not
   * measured a grant: that vendor then runs at 2 and 3 with its own defaults,
   * which for some of them means it still cannot write — said in `backends`.
   */
  readonly grant?: GrantSpec;
  /**
   * Flags that narrow what a turn can reach, sent at **every** level (S12.6).
   *
   * The same idea as claude's `--strict-mcp-config`, for vendors whose version
   * of it is plain data. Declared rather than spliced in by hand so that the
   * registry test can see every permission-shaped flag an argv carries, and so
   * that nothing here can loosen: `why` says what each flag closes, and a test
   * refuses a loosening flag in this list.
   */
  readonly hardening?: {
    readonly args: readonly string[];
    /**
     * Switches set in the child's environment, over whatever the caller's own
     * environment says — for what a vendor lets an environment variable turn
     * off and no flag reaches.
     */
    readonly env?: Readonly<Record<string, string>>;
    readonly why: string;
  };
  /**
   * The field a finished turn sets, and the value it sets it to (S12.6).
   *
   * A vendor that can end a turn early — a cancelled approval, a cap — and
   * still exit 0 writes something else there. A turn whose value differs is
   * `silent`, whatever text came with it: measured on grok 1.0.40, a
   * cancelled turn can carry the sentence the model said before the call,
   * which reads exactly like an answer.
   */
  readonly completion?: { readonly pointer: string; readonly value: string };
  /**
   * How this CLI takes a model, and whether it says which one it ran (D-142).
   * Absent: it takes none Mind may pass, and a turn naming one is refused.
   * `headlessArgv` builds the flag *from* this value ({@link modelArgs}), so the
   * declaration and the argv are one fact.
   */
  readonly model?: ModelSpec;
  /**
   * Argv after the binary for a single-turn, text-only answer.
   *
   * **Read-only only if the dial says so**, and the {@link Restraint} is how it
   * says: every implementation below splices {@link restraintArgs} in, which is
   * `readOnlyArgs` at an acting level of 1 and *nothing at all* at 2 or above.
   * The parameter is required rather than optional, so a turn cannot be
   * composed by code that has not been through
   * `src/decide/effective.ts` — see `src/exec/restraint.ts` for why that is the
   * property worth having `tsc` enforce here rather than a reviewer.
   */
  headlessArgv(request: {
    readonly prompt: string;
    readonly model?: string;
    readonly restraint: Restraint;
    /** Present when Mind carries the identity itself (D-047 isolates on it). */
    readonly system?: string;
  }): string[];
  /**
   * JSON pointers tried in order against stdout. Empty means stdout is the
   * reply verbatim.
   */
  readonly replyPointers: readonly string[];
  /**
   * Where this vendor prints what a turn used, or `null` when nobody has
   * looked.
   *
   * `null` is a statement about Mind's survey, not about the vendor: it
   * produces `unreported`, which reads as "nobody reported" and never as "this
   * turn was free". Measuring a vendor means spending a real turn on it, so the
   * list of surveyed vendors grows slowly and on purpose.
   */
  readonly usage: UsageSpec | null;
  /** Vendor behaviours that cost someone a debugging session. */
  readonly traps: readonly string[];
  /** Version this entry was measured against. */
  readonly measuredAgainst: string;
}

/**
 * Where a path is resolved from.
 *
 * All three are injectable so that a test can resolve a registry path without
 * touching the real `$HOME` — which, for this registry in particular, is the
 * home of someone whose `CLAUDE.md` is in daily use.
 */
export interface PathContext {
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** `${VAR:-fallback}`, and only at the very start of a spec. */
const ENV_PREFIX = /^\$\{([A-Z_][A-Z0-9_]*):-([^}]*)\}/;

/**
 * Expand a registry path against the user's home, environment, or cwd.
 *
 * Supports exactly three forms, because a registry is not a shell: a leading
 * `~`, a leading `${VAR:-fallback}`, and a relative path. `CODEX_HOME` is the
 * reason the second one exists — that variable relocates the only global
 * channel codex has, so a registry that ignored it would confidently report a
 * path the CLI does not read.
 */
export function expandPath(spec: string, context: PathContext = {}): string {
  const home = context.home ?? homedir();
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();

  const match = spec.match(ENV_PREFIX);
  if (match !== null) {
    const value = env[match[1]!];
    const head = value !== undefined && value !== "" ? value : match[2]!;
    return expandPath(head + spec.slice(match[0].length), context);
  }

  if (spec.startsWith("~/")) return resolve(home, spec.slice(2));
  if (spec === "~") return home;
  if (isAbsolute(spec)) return spec;
  return resolve(cwd, spec);
}

/**
 * True when a vendor offers no home-scoped identity channel.
 *
 * Keyed on `./` rather than "does not start with `~`", because a spec may
 * begin with an environment variable that still resolves under the home.
 */
export function isProjectScopedOnly(spec: VendorSpec): boolean {
  return spec.identity.instructionFiles.every((f) => f.startsWith("./"));
}

/**
 * The flags one mechanism contributes to an argv.
 *
 * Every `headlessArgv` below splices this in rather than spelling its own
 * flags, so the declaration and the command are the same fact. A vendor whose
 * mechanism is `none` contributes nothing — and the emptiness is visible here,
 * in one line, instead of being an absence a reader has to notice.
 */
export function readOnlyArgs(spec: ReadOnlySpec): string[] {
  if (spec.kind === "none") return [];
  const required = spec.despite === undefined ? [] : [spec.despite.flag];
  return [...required, ...spec.values.flatMap((value) => [spec.flag, value])];
}

/**
 * The same flags, or **none of them**, according to the dial.
 *
 * This one line is the whole of what S5.1 changes about how a turn is run, and
 * it is worth being blunt about the direction: until E5 every `headlessArgv`
 * below called `readOnlyArgs` unconditionally, so every turn Mind had ever
 * started was already restrained. The dial's only new power is to return `[]`
 * here. `DEFAULT_DIAL` — every category at 1 — reproduces the old behaviour
 * exactly, which is why a tree with no `autonomy.md` in it behaves today as it
 * did yesterday.
 *
 * It lives in this file rather than beside {@link Restraint} so that
 * `restraint.ts` can import from here with `import type` alone. A value import
 * in both directions would be a module cycle, and the one thing worse than a
 * cycle is a cycle around the code that decides whether a turn may write.
 */
export function restraintArgs(spec: ReadOnlySpec, restraint: Restraint): string[] {
  return restraint.loosened ? [] : readOnlyArgs(spec);
}

/**
 * What a vendor is explicitly *given* at levels 2 and 3 (D-047).
 *
 * Taking the read-only flag off was never the same as granting anything:
 * probed 2026-09-23, a claude `-p` turn with no grant and no user settings
 * wrote nothing and ran nothing, and codex's default sandbox is read-only. So
 * levels 2 and 3 used to "work" only where the owner's own vendor settings
 * happened to allow it. These are the flags that make the level true on its
 * own. `act3` — used when {@link Restraint.unfenced} — differs from `act2`
 * where the vendor has a difference to offer.
 */
export interface GrantSpec {
  readonly act2: readonly string[];
  readonly act3: readonly string[];
  /** What was measured, and against which version. */
  readonly evidence: string;
}

/** The grant for this turn's level, or nothing below 2. */
export function grantArgs(grant: GrantSpec | undefined, restraint: Restraint): string[] {
  if (grant === undefined || !restraint.loosened) return [];
  return [...(restraint.unfenced ? grant.act3 : grant.act2)];
}

// `--tools ""` is the empty allow list: every built-in tool removed. A probe
// must answer from its context, never by reading a file that happens to
// contain the answer — and it cannot write one either (measured 2026-09-21).
const CLAUDE_READONLY: ReadOnlySpec = {
  kind: "allow-tools",
  flag: "--tools",
  values: [""],
  evidence: "probed",
};

/** D-047 — without a grant a headless claude writes and runs nothing. */
export const CLAUDE_GRANT: GrantSpec = {
  act2: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash,WebFetch,WebSearch"],
  act3: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash,WebFetch,WebSearch"],
  evidence:
    "probed 2026-09-23 against 2.1.280: no grant = nothing written or run; Edit+Write with " +
    "acceptEdits = writes, cannot run; Bash allowed = writes and runs (a shell also writes)",
};

/**
 * D-047 — the flags that keep a claude turn to one identity and no MCP.
 *
 * `--setting-sources project,local` only when Mind carries the identity
 * itself (the `system` field): it drops the owner's user settings — and with
 * them the owner's SessionStart hooks, which were measured putting another
 * persona into every mind turn — at the price of the user-level CLAUDE.md,
 * which is exactly the file a turn wearing a different soul must not read.
 * `--strict-mcp-config` always: MCP servers (claude.ai connectors among them)
 * are a way out of the machine the dial never governed.
 */
export function claudeIsolation(system: string | undefined): string[] {
  return [...(system === undefined ? [] : ["--setting-sources", "project,local"]), "--strict-mcp-config"];
}

/**
 * D-142 — `--model <model>`: "Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a
 * model's full name (e.g. 'claude-fable-5')" (`--help`, 2.1.283).
 *
 * The output names the model it ran. Measured 2026-09-28 against 2.1.283, one turn (`-p "Reply with the single
 * word: ok" --output-format json --tools "" --model haiku`, no user settings, no MCP): `modelUsage` held one
 * entry, keyed `claude-haiku-4-5-20251001` — the dated API id the alias resolved to — with `canonicalModel:
 * "claude-haiku-4-5"` inside it, the name the vendor's price list uses. The canonical name is recorded; the key
 * is the fallback. A turn that calls more than one model has more than one key, and is never read as one.
 */
const CLAUDE_MODEL: ModelSpec = {
  flag: "--model",
  // The three aliases `--help` names, and `haiku`, which the measured turn resolved.
  listed: ["fable", "opus", "sonnet", "haiku"],
  reported: { keysOf: "/modelUsage", canonical: "canonicalModel" },
  evidence:
    "flag: `--help` of 2.1.283 (2026-09-28); report: one turn with `--model haiku` on 2.1.283, " +
    "modelUsage keyed `claude-haiku-4-5-20251001` with canonicalModel `claude-haiku-4-5`",
};

const CLAUDE: VendorSpec = {
  id: "claude",
  display: "Claude Code",
  binary: "claude",
  identity: {
    strength: "system",
    instructionFiles: ["~/.claude/CLAUDE.md"],
    appendPromptFlag: "--append-system-prompt",
    replacePromptFlag: "--system-prompt",
  },
  readOnly: CLAUDE_READONLY,
  grant: CLAUDE_GRANT,
  model: CLAUDE_MODEL,
  headlessArgv: ({ prompt, model, restraint, system }) => [
    "-p",
    prompt,
    "--output-format",
    "json",
    ...restraintArgs(CLAUDE_READONLY, restraint),
    ...grantArgs(CLAUDE_GRANT, restraint),
    ...claudeIsolation(system),
    ...modelArgs(CLAUDE_MODEL, model),
  ],
  replyPointers: ["/result"],
  // Measured 2026-09-21 against 2.1.278, one turn, `--output-format json`.
  //
  // The three input pointers are one number, not three candidates. That turn
  // sent roughly 81,000 tokens and reported `input_tokens: 2`, with the other
  // 80,951 under `cache_creation_input_tokens` — reading the first field alone
  // would have under-reported by four orders of magnitude, quietly.
  //
  // The same response carried `total_cost_usd: 0.80962` for a two-character
  // answer. It is deliberately not read: see {@link Usage}.
  //
  // S15.9 reads the two cache fields apart as well, because D-110 prices them
  // apart: in that measured turn the 80,951 cache-write tokens were the price.
  //
  // D-143 reads which cache the write went to, because Anthropic prices a
  // 5-minute write at 1.25× input and a 1-hour write at 2×. Measured on 2.1.283:
  // `usage.cache_creation` is `{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
  // beside `cache_creation_input_tokens`, on the turn of D-142 (2026-09-28,
  // `--model haiku`: 1h 11,856, 5m 0, the total 11,856) and on the one D-143 ran
  // to measure it (the same command later that day: 0 and 0 with a total of 0 —
  // it read 11,856 from the cache instead). `modelUsage` carries no split.
  usage: {
    shape: "json",
    stream: "stdout",
    input: [
      "/usage/input_tokens",
      "/usage/cache_creation_input_tokens",
      "/usage/cache_read_input_tokens",
    ],
    output: "/usage/output_tokens",
    cacheRead: "/usage/cache_read_input_tokens",
    cacheWrite: "/usage/cache_creation_input_tokens",
    cacheWrite5m: "/usage/cache_creation/ephemeral_5m_input_tokens",
    cacheWrite1h: "/usage/cache_creation/ephemeral_1h_input_tokens",
  },
  traps: [
    "`usage.input_tokens` is only the part of the prompt that missed the " +
      "cache. A turn measured at ~81,000 tokens reported 2 there, with the " +
      "rest under cache_creation_input_tokens. Summing all three input " +
      "fields is the only reading that means anything.",
  ],
  measuredAgainst: "2.1.278",
};

// The only mechanism here that is the vendor's own process boundary rather
// than a list of tool names: the CLI refuses the write itself, in prose
// ("the workspace is read-only", measured 2026-09-21 on 0.155.1), so nothing
// depends on Mind having spelled a tool id correctly.
const CODEX_READONLY: ReadOnlySpec = {
  kind: "sandbox",
  flag: "--sandbox",
  values: ["read-only"],
  evidence: "probed",
};

/** D-047 — codex's default sandbox is read-only; level 2 is sandboxed, level 3 is not. */
export const CODEX_GRANT: GrantSpec = {
  act2: ["--sandbox", "workspace-write"],
  act3: ["--sandbox", "danger-full-access"],
  evidence:
    "probed 2026-09-23 against 0.155.1 on kernel 7.0: default = read-only; workspace-write " +
    "refused both the write and the shell command on this machine; danger-full-access did both",
};

/**
 * S12.6 (D-121) — on every codex turn, at every level.
 *
 * Measured 2026-09-26 against 0.155.1, on a local model in a home with no
 * ChatGPT sign-in, no `[features]` (so every feature at its default, on) and
 * no `[shell_environment_policy]`. The owner's config has no policy table
 * either, and sets `shell_snapshot = true` explicitly; these flags override it
 * on a copy of that config (`features list`, no model call).
 *
 * - With default features `codex exec` connected to github.com:443 (the
 *   plugins repository) and chatgpt.com:443 before the model was asked
 *   anything (2/2). `--disable plugins` alone brought non-loopback connects to
 *   0 in that home (3/3).
 * - `shell_snapshot` re-exports the whole parent environment into every command
 *   the model runs, past `shell_environment_policy`: with it on, a `*KEY*`
 *   canary reached the model's shell even with the policy fixed (2/2), and at
 *   read-only too (1/1, under legacy Landlock, because bwrap cannot start here).
 * - Turning the snapshot off is not enough on its own: codex's default policy
 *   has `ignore_default_excludes = true`, and the canary reached the shell with
 *   the snapshot off too (2/2). With both it was hidden (4/4).
 * - `apps` (ChatGPT connectors) and `remote_plugin` are off as well. Not
 *   measured — they matter only under a ChatGPT sign-in, which the probe home
 *   did not have — and off for the reason claude gets `--strict-mcp-config`:
 *   tools from an account, not from Mind.
 *
 * `--disable` rather than `-c features.<name>=false` because `-c` accepts a
 * misspelt feature silently and `--disable` refuses to start. What is still
 * open is written in the trap below: only names holding KEY, SECRET or TOKEN
 * are filtered.
 */
const CODEX_HARDENING = {
  args: [
    "--disable",
    "plugins",
    "--disable",
    "shell_snapshot",
    "--disable",
    "apps",
    "--disable",
    "remote_plugin",
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
  ],
  why:
    "plugins: no fetch of the plugins repository from github.com or call to chatgpt.com before " +
    "the turn (probed 2026-09-26 against 0.155.1 without a ChatGPT sign-in; on a cloud config the " +
    "turn itself still reaches the model's endpoint); shell_snapshot and " +
    "ignore_default_excludes=false together: environment variables named *KEY*, *SECRET* or " +
    "*TOKEN* stay out of the commands the model runs (probed, same date); apps and remote_plugin: " +
    "no account-side connectors or plugins in a turn Mind starts (not measured — they act only " +
    "under a ChatGPT sign-in)",
} as const;

/**
 * D-142 — `-m, --model <MODEL>`: "Model the agent should use" (`codex exec --help`, 0.155.1, 2026-09-28). The
 * help lists no names. `codex exec` answers in plain text with its count on stderr, so its output names no model
 * and a turn records only the one asked for.
 */
const CODEX_MODEL: ModelSpec = {
  flag: "--model",
  listed: [],
  reported: null,
  evidence: "flag: `codex exec --help` of 0.155.1 (2026-09-28); the text output names no model",
};

const CODEX: VendorSpec = {
  id: "codex",
  display: "Codex CLI",
  binary: "codex",
  identity: {
    strength: "user",
    // `CODEX_HOME` moves this whole directory, and the CLI stops reading the
    // default the moment it is set. Written as the variable so `soul apply`
    // and `backends` name the path this machine actually uses.
    instructionFiles: ["${CODEX_HOME:-~/.codex}/AGENTS.md"],
  },
  // `codex exec` writes progress to stderr and only the final message to
  // stdout, so stdout is the reply with no parsing needed.
  readOnly: CODEX_READONLY,
  grant: CODEX_GRANT,
  hardening: CODEX_HARDENING,
  model: CODEX_MODEL,
  headlessArgv: ({ prompt, model, restraint }) => [
    "exec",
    "--skip-git-repo-check",
    ...restraintArgs(CODEX_READONLY, restraint),
    ...grantArgs(CODEX_GRANT, restraint),
    // After `--sandbox`, the order that was measured.
    ...CODEX_HARDENING.args,
    ...modelArgs(CODEX_MODEL, model),
    prompt,
  ],
  replyPointers: [],
  // Measured 2026-09-21 against 0.153.4, one `codex exec`: stderr carries a
  // line reading `tokens used` with the figure on the line after it, thousands
  // separated by commas (`2,243`). One total, never split into input and
  // output — `codex exec --json` does split them, and switching to it would
  // mean rebuilding the reply path this registry already pins as plain stdout.
  usage: { shape: "text", stream: "stderr", totalAfterLine: "tokens used" },
  traps: [
    "The token count goes to stderr while the answer goes to stdout, so any " +
      "wrapper that keeps stderr only when stdout came back empty throws the " +
      "count away on exactly the turns that used tokens.",
    "No system-prompt flag exists. $CODEX_HOME/AGENTS.md is the only global " +
      "channel, and CODEX_HOME relocates it wholesale.",
    "Tool names follow feature flags, not the vendor: on 0.155.1 with " +
      "features.unified_exec = true (the default) every shell call is named " +
      "`exec_command`, not `unified_exec` or `shell`. An allowlist written against " +
      "another spelling silently matches nothing (measured 2026-09-26).",
    "`shell_snapshot` re-exports the whole parent environment into every command " +
      "the model runs, past shell_environment_policy, and the default policy lets " +
      "*KEY*/*SECRET*/*TOKEN* through anyway — either one alone leaks. Even with " +
      "both closed, only names matching those three words are filtered: a canary " +
      "without them reached the shell 4/4, so a PASSWORD, DATABASE_URL or *_PAT " +
      "would too (inferred from that canary; measured 2026-09-26, 0.155.1).",
    "`-c features.<name>=false` accepts a misspelt or unknown feature silently; " +
      "`--disable <name>` refuses to start. The first form looks like a fix and " +
      "can be nothing.",
    "At --sandbox workspace-write and danger-full-access `codex exec` appends " +
      "[projects.\"<cwd>\"] trust_level = \"trusted\" to $CODEX_HOME/config.toml, " +
      "so a level-2 or level-3 turn writes into the owner's own codex config. " +
      "--ephemeral does not stop it (measured 2026-09-26, 0.155.1).",
    "Where the kernel restricts unprivileged user namespaces (Ubuntu's " +
      "apparmor_restrict_unprivileged_userns=1), bubblewrap cannot start and every " +
      "command under read-only or workspace-write dies with `bwrap: loopback: " +
      "Failed RTM_NEWADDR`. Level 1 then holds by accident, and level 2 can do " +
      "nothing (measured 2026-09-23 and 2026-09-26, 0.155.1).",
  ],
  measuredAgainst: "0.155.1",
};

/**
 * An allow list, and the reason this registry now prefers that shape.
 *
 * Until 2026-09-21 this vendor was held with `--disallowed-tools
 * run_terminal_cmd,search_replace,web_search,web_fetch,task`. Two of those five
 * names no longer existed: 1.0.40 calls the shell tool `run_terminal_command`
 * and the subagent tool `spawn_subagent`, and nothing warned about either —
 * an unknown name in a tool list is accepted with exit 0. A probe asked the
 * CLI to write a file and it wrote one, through a flag that read like a fence
 * in the registry, in the tests, and in `mind backends`.
 *
 * The same probe under this allow list wrote nothing, and the model's own
 * reasoning said why: *I don't have a write tool.* The three names here are the
 * read-only ones from the vendor's own tool table; if one of them drifts too,
 * the turn loses a tool it cannot use rather than regaining one it must not.
 */
const GROK_READONLY: ReadOnlySpec = {
  kind: "allow-tools",
  flag: "--tools",
  values: ["read_file,grep,list_dir"],
  evidence: "probed",
};

/**
 * D-119 — what levels 2 and 3 grant. The only grant measured that never ends a
 * headless turn silently.
 *
 * In headless a tool call that needs approval is not refused, it is
 * *cancelled*, and the cancel ends the whole turn with exit 0. So a narrower
 * grant does not make a turn safer, it makes it stop: `--allow Bash --allow
 * Edit --allow Write` still left `rm` and any command the vendor's parser
 * cannot split (anything with `$?`) to a prompt nobody answers, and ended 3 of
 * 11 multi-step runs that way. This is the same power claude gets at level 2
 * (`Bash` allowed whole). Neither is bounded by a list of names: for a turn on
 * this machine that is the kernel fence of D-118 — which S12.2 has yet to
 * build — and for a cloud turn, only the dial.
 */
export const GROK_GRANT: GrantSpec = {
  act2: ["--always-approve"],
  act3: ["--always-approve"],
  evidence:
    "probed 2026-09-26 against 1.0.40 on a local model: no grant = the first shell call is " +
    "cancelled, exit 0, empty text (0/2); acceptEdits alone does not approve the shell (0/2), and " +
    "with --allow Bash added it still cancelled the edit (0/2); acceptEdits + --allow Bash --allow " +
    "Edit --allow Write ends the turn silently on rm (0/2), on a command using $? (0/2) and in 3 " +
    "of 11 multi-step runs; on $?, --allow 'Bash(*)' (0/1) and dontAsk (0/2) failed the same way; " +
    "--always-approve ran all of them (fix-and-test 14/14 plus 1/1 under its alias " +
    "bypassPermissions, edit 4/4, $? 7/7, rm 3/3). act3 = act2: no measured difference worth having",
};

/**
 * S12.6 (D-119) — removed at every level, the way claude always gets
 * `--strict-mcp-config`.
 *
 * `--tools` never removes the MCP meta-tools `search_tool` and `use_tool`, and
 * at levels 2 and 3 it is not what is sent at all. Measured 2026-09-26 on
 * 1.0.40: a level-1 turn called `use_tool` with `tool_name: "bash"` to write the
 * probe file, and wrote nothing only because nobody approved it — which ended
 * the turn with exit 0 and no text (1/3). With this list the level-1 toolset is
 * exactly `read_file`, `grep`, `list_dir` (4/4 wrote nothing and answered).
 *
 * It is a deny list, so it fails open on a rename, and it is hygiene rather
 * than the fence: at level 1 the fence stays {@link GROK_READONLY}, which fails
 * closed. The image and video generators are on it because `--always-approve`
 * would otherwise approve them at level 2 wherever the account enables them.
 *
 * The environment half is the part that matches `--strict-mcp-config`. This
 * CLI reads Claude Code's and Cursor's settings on purpose, and on the owner's
 * home that put five Claude hooks — a SessionStart hook injecting another
 * persona among them — and seven MCP servers from `~/.claude.json` into every
 * grok turn, level 1 included. With these switches the compat surfaces read
 * `enabled: false (env)`; `grok inspect` still *lists* what it discovered, so
 * it is not the evidence. The evidence is a run (2026-09-27, 1.0.40, the
 * owner's home, a model id that does not exist so nothing reaches xAI, debug
 * log): without the switches the SessionStart hook ran (1) and seven MCP
 * servers were spawned and handshaken (7); with them, 0 and 0. The `rules`
 * surface stays on: it is how this vendor reads `~/.claude/CLAUDE.md`, the
 * instruction file {@link IdentityChannel} names.
 *
 * Claude *plugins* (`~/.claude/plugins`) are discovered either way; in that run
 * no plugin hook was dispatched at session start with or without the switches.
 * Hooks a plugin registers for tool use were not reached (no tool ran), and the
 * only off switch for plugins is `[plugins] disabled` in a config Mind does
 * not own.
 *
 * The last three switch off what xAI's remote config turns on after login for
 * the owner's account — `telemetry=true (remote) trace_upload=true (remote)` in
 * the same run. With them the CLI resolves all three from the environment and
 * does not re-resolve after login. grok-local already writes them off in its
 * own config; a cloud turn uses the owner's.
 */
const GROK_HARDENING = {
  args: [
    "--disallowed-tools",
    "search_tool,use_tool,ask_user_question,enter_plan_mode,exit_plan_mode,image_edit," +
      "image_gen,image_to_video,reference_to_video,send_feedback,workflow,monitor," +
      "scheduler_create,scheduler_delete,scheduler_list",
  ],
  env: {
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CLAUDE_AGENTS_ENABLED: "0",
    GROK_CLAUDE_SKILLS_ENABLED: "0",
    GROK_CURSOR_HOOKS_ENABLED: "0",
    GROK_CURSOR_MCPS_ENABLED: "0",
    GROK_CURSOR_AGENTS_ENABLED: "0",
    GROK_CURSOR_SKILLS_ENABLED: "0",
    GROK_MANAGED_MCPS_ENABLED: "0",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_TELEMETRY_TRACE_UPLOAD: "0",
    GROK_FEEDBACK_ENABLED: "0",
  },
  why:
    "the MCP meta-tools a level-1 turn tried to reach a shell through, the interactive and " +
    "vendor-hosted extras a headless turn has no use for (probed 2026-09-26 against 1.0.40), " +
    "the hooks, MCP servers, agents and skills this CLI borrows from Claude Code and Cursor " +
    "settings (0 run and 0 spawned with the switches, 1 and 7 without — 2026-09-27), and the " +
    "telemetry, trace upload and feedback xAI's remote config turns on after login",
} as const;

/**
 * D-142 — `-m, --model <MODEL>`: "Model ID to use" (`--help`, 1.0.40, 2026-09-28). The help lists no names
 * (`grok models` does, against the account, and is not run here).
 *
 * The output names the model it called. Measured 2026-09-28 against 1.0.40 through Mind's own `grok-local` —
 * a local model behind LiteLLM, so nothing reached xAI — one turn, `-p "Reply with the single word: ok"`:
 * `modelUsage` held one entry keyed `local-coder`, the id the CLI sent, with no canonical name inside it. So the
 * key is the id the CLI asked the API for; an alias xAI resolves on its own side would not show here. Not yet
 * seen against xAI itself.
 */
const GROK_MODEL: ModelSpec = {
  flag: "--model",
  listed: [],
  reported: { keysOf: "/modelUsage" },
  evidence:
    "flag: `--help` of 1.0.40 (2026-09-28); report: one grok-local turn on 1.0.40 (2026-09-28), " +
    "modelUsage keyed by the model id the CLI sent (`local-coder`), no canonical field",
};

const GROK: VendorSpec = {
  id: "grok",
  display: "Grok CLI",
  binary: "grok",
  model: GROK_MODEL,
  identity: {
    strength: "system",
    // This vendor reads Anthropic's file on purpose — it documents the
    // behaviour as Claude Code compatibility. So an identity written for
    // `claude` already reaches `grok`, and that is precisely why it should
    // not be relied on: it is a courtesy, switchable with one env var
    // (GROK_CLAUDE_AGENTS_ENABLED=0), not a contract.
    instructionFiles: ["~/.claude/CLAUDE.md"],
    appendPromptFlag: "--rules",
    replacePromptFlag: "--system-prompt-override",
  },
  readOnly: GROK_READONLY,
  grant: GROK_GRANT,
  hardening: GROK_HARDENING,
  // Measured 2026-09-26 on 1.0.40, 76 runs: every finished turn said `end_turn`
  // (52); the other 24 said `cancelled` — 19 approval cancels at exit 0, 5 cap
  // hits at exit 1.
  completion: { pointer: "/stopReason", value: "end_turn" },
  headlessArgv: ({ prompt, model, restraint }) => [
    "-p",
    prompt,
    "--output-format",
    "json",
    // A backstop, not a fix. Measured 2026-09-26 on 1.0.40: with no cap a
    // fix-and-test task ended `end_turn` (3/3) — the half-answer this cap was
    // once blamed for was an approval cancel. `--max-turns N` counts model
    // calls and a hit exits 1 with `Error: max turns reached`; that task took
    // 4 to 6 calls (n=25), and caps of 2 to 4 never finished it (0/5 — cap 2
    // twice, 3 once, 4 twice). 20 is about three times the worst case seen.
    "--max-turns",
    "20",
    ...restraintArgs(GROK_READONLY, restraint),
    ...grantArgs(GROK_GRANT, restraint),
    ...GROK_HARDENING.args,
    ...modelArgs(GROK_MODEL, model),
  ],
  // `/text` is where `--output-format json` puts the reply on 1.0.40; `/result`
  // never appeared in 76 turns and is kept as a harmless second try.
  replyPointers: ["/text", "/result"],
  // Measured 2026-09-26 against 1.0.40, 76 runs of `--output-format json` on a
  // local model: present on every one, cancelled and exit-1 runs included, and
  // the vendor's total equalled the fields below on all 76 — with both cache
  // fields 0, because the local model has no prompt cache. That `input_tokens`
  // is the uncached part only, and so all three must be summed, is the vendor's
  // own documentation; it has not been seen with a non-zero cache.
  usage: {
    shape: "json",
    stream: "stdout",
    input: [
      "/usage/input_tokens",
      "/usage/cache_read_input_tokens",
      "/usage/cache_creation_input_tokens",
    ],
    output: "/usage/output_tokens",
    total: "/usage/total_tokens",
    // Read apart since S15.9 (D-110). Both were 0 on every measured run, and
    // `total_tokens` equalled input + output there — so `reasoning_tokens`,
    // printed beside them, is inside `output_tokens` or outside the bill; it
    // is not read.
    cacheRead: "/usage/cache_read_input_tokens",
    cacheWrite: "/usage/cache_creation_input_tokens",
  },
  traps: [
    "In headless a tool call that needs approval is cancelled, not refused: the whole turn " +
      "ends at once with exit 0, stopReason `cancelled`, and `text` empty or holding only the " +
      "sentence before the call. `--allow Bash` does not cover `rm` or any command the parser " +
      "cannot split, such as one using `$?`; on `$?`, `--allow 'Bash(*)'` and " +
      "`--permission-mode dontAsk` failed the same way. Only `--always-approve` ran them " +
      "(measured 2026-09-26, 1.0.40).",
    "`--permission-mode acceptEdits` approves nothing in headless: the shell was cancelled " +
      "under it, and so was `search_replace` with `--allow Bash` added (measured 2026-09-26, 1.0.40).",
    "A `--deny` rule can be recovered from and a prompt cannot: under `--always-approve` a " +
      "denied call reaches the model as `Denied by permission policy` and the turn still ends " +
      "`end_turn` (measured 2026-09-26, 1.0.40).",
    "`--max-turns N` counts model calls, and the tools of call N still run. A hit exits 1 with " +
      "`Error: max turns reached` on stderr and usually no reply (4 of 5; the fifth, half a " +
      "sentence), so the work can be done with nothing said about it (measured 2026-09-26, 1.0.40).",
    "`--tools` never removes the MCP meta-tools `search_tool` and `use_tool`, and at levels 2 " +
      "and 3 the interactive extras stay too. A level-1 turn called `use_tool` with `tool_name: " +
      "\"bash\"` to write a file, stopped only because nobody approved it (measured 2026-09-26, 1.0.40).",
    "A headless turn can stall after the model's stream has ended and wait for the caller's " +
      "timeout: once in three level-1 turns through Mind on a local model (2026-09-26, 1.0.40). " +
      "It comes back `silent` on the deadline; a long `timeoutMs` makes it a long wait.",
    "`--permission-mode plan` in headless plans the work, then waits for an " +
      "approval nobody will give, and exits 0 having changed nothing.",
    "`--always-approve` overrides `[ui] yolo = false` in the vendor's own " +
      "config.toml: the flag wins over the owner's setting (measured 2026-09-26, 1.0.40).",
    "Tool ids are not the display names, and they move between releases: the " +
      "shell tool documented as `run_terminal_cmd` at 1.0.24 is " +
      "`run_terminal_command` at 1.0.40, and `task` is now `spawn_subagent`. " +
      "A deny list written against the old spelling matched nothing and let a " +
      "turn write a file. This is why the registry holds an allow list here.",
    "An unrecognised name in `--tools` is accepted silently — the run exits 0 " +
      "and answers. So a typo in an allow list costs the turn its tools " +
      "quietly, and a typo in a deny list costs the turn its limits quietly. " +
      "Only the first of those two failures is safe, which decides the shape.",
    "Large prompts are truncated in the middle without warning — the head and " +
      "tail arrive, the centre does not. Ask two questions at once, one about " +
      "the end and one about the whole, to detect it.",
    "`--sandbox` exists but names a profile defined in a config file this " +
      "registry does not write, and it refuses to start when it cannot build " +
      "its bubblewrap plan. It is a machine-level mechanism, not an argv one, " +
      "and Mind does not reach for it.",
  ],
  measuredAgainst: "1.0.40",
};

// The one entry in this registry believed on the vendor's word. `--help` at
// 0.38.2 documents `plan` as read-only, and the probe that would have confirmed
// it could not run: this CLI refused to authenticate at all on 2026-09-21
// (`IneligibleTierError`, a tier being retired), so no turn was spent and none
// was faked. `readonlyLimits()` names it every run until one is.
const GEMINI_READONLY: ReadOnlySpec = {
  kind: "approval-mode",
  flag: "--approval-mode",
  values: ["plan"],
  evidence: "documented",
};

/** D-142 — `-m, --model`: "Model [string]" (`--help`, 0.38.2, 2026-09-28). No names listed; text output names none. */
const GEMINI_MODEL: ModelSpec = {
  flag: "-m",
  listed: [],
  reported: null,
  evidence: "flag: `--help` of 0.38.2 (2026-09-28); run with text output, which names no model",
};

const GEMINI: VendorSpec = {
  id: "gemini",
  display: "Gemini CLI",
  binary: "gemini",
  identity: {
    strength: "user",
    instructionFiles: ["~/.gemini/GEMINI.md"],
  },
  readOnly: GEMINI_READONLY,
  model: GEMINI_MODEL,
  headlessArgv: ({ prompt, model, restraint }) => [
    "-p",
    prompt,
    "-o",
    "text",
    ...restraintArgs(GEMINI_READONLY, restraint),
    ...modelArgs(GEMINI_MODEL, model),
  ],
  replyPointers: [],
  // Not surveyed. This vendor very likely reports something, but nobody has
  // spent a turn to find out, and a pointer guessed from another vendor's
  // spelling would produce `missing` at best.
  usage: null,
  traps: [
    "GEMINI.md is also where this CLI writes its own auto-saved memories, so " +
      "an identity placed there shares a file with vendor-generated text that " +
      "changes underneath it.",
    "`--allowed-tools` is deprecated in favour of a policy engine.",
  ],
  measuredAgainst: "0.38.2",
};

// The only entry that has to loosen something to work at all, so the loosening
// is a declared field rather than a token in an argv: `--allow-all-tools` is
// required for non-interactive mode, and denials outrank it. Measured
// 2026-09-21 — the probe was told to write a file and answered that it had no
// permission to.
const COPILOT_READONLY: ReadOnlySpec = {
  kind: "deny-tools",
  flag: "--deny-tool",
  values: ["shell", "write"],
  despite: {
    flag: "--allow-all-tools",
    why:
      "non-interactive mode refuses to run without it; `--deny-tool` takes " +
      "precedence over it, and a probe confirmed the denial still bites",
  },
  evidence: "probed",
};

/**
 * D-142 — `--model <model>`: "Set the AI model to use", with a fixed list of choices (`--help`, 0.0.367,
 * 2026-09-28). The list is copied here as the vendor printed it; a name outside it is still handed over, and the
 * CLI refuses it itself. `-s` output names no model.
 */
const COPILOT_MODEL: ModelSpec = {
  flag: "--model",
  listed: [
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "claude-opus-4.5",
    "claude-sonnet-4",
    "gpt-5",
    "gpt-5.1",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex",
    "gpt-5-mini",
    "gpt-4.1",
    "gemini-3-pro-preview",
  ],
  reported: null,
  evidence: "flag and choices: `--help` of 0.0.367 (2026-09-28); `-s` output names no model",
};

const COPILOT: VendorSpec = {
  id: "copilot",
  display: "GitHub Copilot CLI",
  binary: "copilot",
  identity: {
    strength: "user",
    // Resolved from the working directory. There is no home-scoped file, so
    // an identity reaches this vendor per project or not at all.
    instructionFiles: ["./AGENTS.md"],
  },
  readOnly: COPILOT_READONLY,
  model: COPILOT_MODEL,
  headlessArgv: ({ prompt, model, restraint }) => [
    "-p",
    prompt,
    "-s",
    ...restraintArgs(COPILOT_READONLY, restraint),
    ...modelArgs(COPILOT_MODEL, model),
  ],
  replyPointers: [],
  // Not surveyed — see the note on gemini.
  usage: null,
  traps: [
    "No home-scoped instruction file exists; identity is per-project by " +
      "construction.",
    "`--no-custom-instructions` disables the only channel there is.",
    "Permissions name kinds, not tools — shell(git:*), write, MyMCP(tool) — " +
      "so an allowlist copied from another vendor does not parse.",
  ],
  measuredAgainst: "0.0.367",
};

/**
 * D-120 — a profile file Mind writes, naming the only three tools a
 * read-only turn gets.
 *
 * Until 2026-09-26 this entry said there was nothing to pass: `--plan` is
 * refused together with `-p`, and a plain `-p` turn wrote a file. Both are still
 * true. What the old survey missed is that `--help` on the same 2.0.2 also
 * offers `--agent <name>` and `--agent-file <path>`, and both work with `-p`.
 *
 * The built-in `plan` profile is **not** used, though SP-5 proposed it: probed
 * 2026-09-26, its FetchURL fetched a page and quoted it (reach at level 1), and a
 * repository can replace it — a `.kimi-code/agents/plan.md` with `override:
 * true` gave the "plan" turn Bash, Edit and Write, and it wrote the file. An
 * explicit `--agent-file` outranks a repository profile of the same name.
 *
 * With this file every session's tool list was exactly Glob, Grep, Read; told to
 * write a file it wrote nothing (7/7, a hijacked repository among them); told to
 * fetch a URL it made no request (4/4); a read question still came back right
 * (2/2); `./AGENTS.md` still reached the model. A missing or broken file makes
 * the CLI exit 1 before any model call, so a failed write cannot fall through
 * to an unfenced turn.
 *
 * It is the vendor's allow list, not a sandbox: by the vendor's source (not
 * measured), `Read` takes absolute paths outside the working directory. For a
 * local turn that is D-118's fence to close. Rewriting the file before every
 * turn defeats a file a looser turn left behind; it is not a boundary against a
 * turn running *at the same time* under the same user — that is D-118's too.
 *
 * Plain strings on purpose: `${base_prompt}` is the vendor's placeholder for its
 * own system prompt, which carries `AGENTS.md` (as `${agents_md}`), and a
 * template literal would try to interpolate it.
 */
const KIMI_READONLY: ReadOnlySpec = {
  kind: "agent-file",
  flag: "--agent-file",
  values: ["~/.local/state/mind/vendors/kimi/readonly-agent.md"],
  content: [
    "---",
    "name: mind-readonly",
    "description: Mind acting level 1. Read, Glob and Grep only; no shell, no file writes, no network.",
    "tools:",
    "  - Read",
    "  - Glob",
    "  - Grep",
    "---",
    "${base_prompt}",
    "",
    "# Read-only turn",
    "",
    "You are running as a read-only agent: you can read and search files with Read, Glob and Grep, " +
      "and you have no shell, no file-editing tools and no network access. Where the instructions " +
      "above tell you to make changes, run commands or verify with tools, that does not apply to " +
      "you: do not attempt to run commands, modify files or fetch URLs. If you are asked to change " +
      "something, do not claim it is done. Say plainly that this turn is read-only, then describe " +
      "exactly what you would change (file, location, new content) so that it can be applied later.",
    "",
  ].join("\n"),
  evidence: "probed",
};

/**
 * D-142 — `-m, --model <model>`: "LLM model alias to use for this invocation. Defaults to default_model in
 * config.toml" (`--help`, 2.0.2, 2026-09-28). The names are aliases defined in the owner's own config, so none are
 * listed here; text output names none.
 */
const KIMI_MODEL: ModelSpec = {
  flag: "-m",
  listed: [],
  reported: null,
  evidence: "flag: `--help` of 2.0.2 (2026-09-28); aliases come from the owner's config.toml; text output names no model",
};

const KIMI: VendorSpec = {
  id: "kimi",
  display: "Kimi Code CLI",
  binary: "kimi",
  model: KIMI_MODEL,
  identity: {
    strength: "user",
    // `./AGENTS.md` is where `soul apply` writes (SP-2 measured 9/9 from it). kimi 2.0.2 also reads a home
    // file first, `${KIMI_CODE_HOME:-~/.kimi-code}/AGENTS.md` — measured in S12.6 (K4h: a line written there
    // reached the system prompt and was obeyed, under `plan` and under Mind's read-only profile). It is
    // listed so `worn` and `erase` look in it; Mind never writes it. The source also reads
    // `~/.agents/AGENTS.md`, which has not been measured and is not listed.
    instructionFiles: ["./AGENTS.md", "${KIMI_CODE_HOME:-~/.kimi-code}/AGENTS.md"],
  },
  readOnly: KIMI_READONLY,
  // No grant: print mode sets the vendor's own permission to `auto` (observed
  // 2026-09-26; forced, per the vendor's source), so at levels 2 and 3 a turn
  // edits and runs with no flag. A narrower level-2 profile through
  // `--agent-file` is possible; it has not been measured or decided.
  headlessArgv: ({ prompt, model, restraint }) => [
    "-p",
    prompt,
    "--output-format",
    "text",
    ...restraintArgs(KIMI_READONLY, restraint),
    ...modelArgs(KIMI_MODEL, model),
  ],
  replyPointers: [],
  // Not surveyed — see the note on gemini.
  usage: null,
  traps: [
    "Headless support is newer than some tooling assumes: `-p` with " +
      "`--output-format text|stream-json` and `--auto` all exist in 2.x, so a " +
      "wrapper that reports this CLI as interactive-only is out of date.",
    "`--plan` and `-p` cannot be combined: the run exits 1 with `Cannot " +
      "combine --prompt with --plan` before a turn starts. `--agent <name>` and " +
      "`--agent-file <path>` can, and they are the working route.",
    "A plain `-p` turn is the 25-tool default agent with permission forced to " +
      "auto — shell, write, FetchURL, sub-agents, cron (probed 2026-09-26, 2.0.2). " +
      "Level 1 therefore rests entirely on the agent file.",
    "The built-in `plan` profile is not read-only: its FetchURL reaches the web, " +
      "and a repository file `.kimi-code/agents/plan.md` with `override: true` " +
      "replaces it with one that writes (probed 2026-09-26, 2.0.2).",
    "An agent file's body replaces the vendor's whole system prompt. Keep " +
      "`${base_prompt}` in it (or `${agents_md}` at least), or the turn loses the " +
      "vendor's own prompt and every AGENTS.md with it — they reach the model only " +
      "through the template.",
  ],
  measuredAgainst: "2.0.2",
};

/**
 * Every vendor CLI Mind knows about, wired or not.
 *
 * {@link NonEmpty} for the same reason {@link import("../agent/derive.ts").DERIVATIONS}
 * is: `isProjectScopedOnly` is an `every` over this list's instruction files and
 * is vacuously true of nothing. Emptying it turns 152 tests red
 * (`notes/odd2-driver.ts`, `D-P3`) and used to leave `tsc` clean, so the
 * loudest signal a reader got was in a suite nobody runs before a type error.
 */
export const VENDORS: NonEmpty<VendorSpec> = [CLAUDE, CODEX, GROK, GEMINI, COPILOT, KIMI];

const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

/** Look up a vendor by id. Throws only on a programmer error. */
export function vendor(id: string): VendorSpec {
  const found = BY_ID.get(id);
  if (!found) {
    throw new Error(`unknown vendor ${JSON.stringify(id)} (known: ${[...BY_ID.keys()].join(", ")})`);
  }
  return found;
}

/**
 * One column's worth of answer to "can a turn on this vendor write?".
 *
 * Three answers, not two, for the reason the whole registry keeps three
 * states: a flag nobody has watched work is a different thing from one that
 * has been watched, and a table that prints both as `no` is a table that has
 * quietly promised something. Whatever this returns, `readonlyLimits()` is
 * printed under it.
 */
export function readOnlySummary(spec: VendorSpec): string {
  const mechanism = spec.readOnly;
  if (mechanism.kind === "none") return "yes — no limit";
  return mechanism.evidence === "probed" ? "no (measured)" : "no (on trust)";
}

/**
 * What the read-only flags do **not** cover — derived, never listed twice.
 *
 * Every sentence below is computed from {@link VENDORS} rather than written
 * beside it. That is the whole design: a second list of "vendors with a hole"
 * would be right on the day it was written and wrong on the day a vendor was
 * fixed or added, and nobody would find out, because prose does not fail a
 * test. Declare `none` in the registry and this text names the vendor by
 * itself; close the hole and the sentence disappears with it.
 *
 * Printed by `mind backends`, the same way `GUARD_LIMITS` is printed
 * wherever the guard speaks: the reader of a green table is exactly the person
 * about to believe it covers more than it does.
 */
export function readonlyLimits(vendors: readonly VendorSpec[] = VENDORS): readonly string[] {
  const named = (list: readonly VendorSpec[]) => list.map((spec) => spec.id).join(", ");
  const open = vendors.filter((spec) => spec.readOnly.kind === "none");
  const believed = vendors.filter(
    (spec) => spec.readOnly.kind !== "none" && spec.readOnly.evidence === "documented",
  );
  const denyLists = vendors.filter((spec) => spec.readOnly.kind === "deny-tools");
  const loosened = vendors.filter(
    (spec) => spec.readOnly.kind !== "none" && spec.readOnly.despite !== undefined,
  );
  const profiles = vendors.filter((spec) => spec.readOnly.kind === "agent-file");

  const lines: string[] = [
    "What is covered is narrow and exact: the turns Mind itself starts carry a flag that " +
      "asks the vendor to stay read-only. A CLI the owner runs by hand, or one another tool " +
      "spawns, is reached by nothing in this repository.",
    "The mechanism is the vendor's, not Mind's. Mind passes a flag and the vendor decides " +
      "what to do with it — so a release that renames a tool or stops honouring a flag fails " +
      "silently, and only a real turn against the real CLI notices.",
  ];

  // EEA-01, EXEC-04: "read-only" says what a turn may change, not what it may open. Derived like the rest, so a
  // vendor that is started with no tools at all leaves this sentence and one that gains a tool joins it.
  const withoutTools = vendors.filter(
    (spec) => spec.readOnly.kind === "allow-tools" && spec.readOnly.values.every((value) => value === ""),
  );
  const canRead = vendors.filter((spec) => !withoutTools.includes(spec));
  if (canRead.length > 0) {
    lines.push(
      `A read-only turn is not a turn that cannot read. ${named(canRead)} keep file-reading tools or a shell ` +
        "that runs read commands, and run as you: they can open any file you can open (~/.secrets, ~/.ssh, " +
        "other subjects' data) and send what they read to that vendor. The I-6 screen sees only the prompt " +
        "and system text Mind sends, never what a vendor's own tool reads afterwards." +
        (withoutTools.length > 0
          ? ` ${named(withoutTools)} is started with no tools at all and is the only kind here that reads nothing by itself.`
          : ""),
    );
  }

  for (const spec of open) {
    const mechanism = spec.readOnly;
    if (mechanism.kind !== "none") continue;
    lines.push(`${spec.id}: no read-only mechanism exists to pass. ${mechanism.why}`);
  }
  if (believed.length > 0) {
    lines.push(
      `Believed rather than measured: ${named(believed)} — the flag is read-only according to ` +
        "the vendor's own `--help`, and no turn here has watched it hold. " +
        "`MIND_REAL_READONLY=1 bun test test/exec/readonly.real.test.ts` is what changes that.",
    );
  }
  if (denyLists.length > 0) {
    lines.push(
      `A deny list only denies the names the vendor still uses (${named(denyLists)}). That is ` +
        "how this check was wrong before it was written: a shell tool denied under a name the " +
        "vendor had renamed, and a turn that wrote a file through it.",
    );
  }
  if (loosened.length > 0) {
    lines.push(
      `${named(loosened)} needs a permissive flag to run headless at all, kept only because the ` +
        "denials outrank it. If that precedence ever changes, nothing in the argv will look " +
        "different.",
    );
  }
  if (profiles.length > 0) {
    lines.push(
      `${named(profiles)} is held by a profile file Mind writes before every read-only turn, ` +
        "naming the only tools the turn gets. It is the vendor's allow list, not a sandbox: a " +
        "tool it keeps, such as reading files, is not confined to the working directory.",
    );
  }
  lines.push(
    "MCP servers and session-start hooks configured in the owner's own vendor settings are " +
      "outside every flag here: they add tools and context to a turn before Mind's argv is " +
      "read. No tool list can close that, and this line is not a plan to.",
  );
  return lines;
}

/**
 * The backends phase A wires end to end.
 *
 * `ollama` is not a vendor CLI and is deliberately in this list: it is the
 * one that has to keep working when the other two are taken off PATH (I-1).
 * A list of commercial CLIs alone would make that test unpassable by design.
 */
export const PHASE_A_BACKENDS = ["claude", "codex", "ollama"] as const;
