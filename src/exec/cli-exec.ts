/**
 * Running a turn on a vendor CLI — a subprocess that can lie about finishing.
 *
 * Everything defensive in this file exists because of one measured behaviour:
 * these CLIs fail by exiting 0 with nothing to show for it. A tool call nobody
 * approves, a plan mode nobody can approve, a prompt truncated in the middle —
 * each produces a clean exit and an empty or half answer. So a zero exit code
 * is treated as a claim to be checked, never as a result — and where a vendor
 * says how its turn ended, that is checked too (`VendorSpec.completion`).
 */

import type {
  Availability,
  ExecBackend,
  IdentityStrength,
  TurnRequest,
  TurnResult,
} from "./backend.ts";
import { classify } from "./backend.ts";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { expandPath, modelProblem, type ReadOnlySpec, type UsageSpec, type VendorSpec } from "./registry.ts";
import { restraintRefusal } from "./restraint.ts";
import { fencedArgv, fenceSupport, type FencePolicy, type FenceSupport } from "./fence.ts";
import { procStat, signalSurvivors, signalTree, type ProcStat } from "../decide/runs.ts";
import { spawnGuarded } from "../spawn.ts";
import { browserWiring, withBrowserArgs, writeBrowserWiring } from "../browser/mcp-config.ts";
import { tokenCount, UNREPORTED_USAGE, USAGE_FIELDS, type TurnModel, type Usage, type UsageField } from "../types.ts";

/** Wall-clock ceiling for one turn when the caller names none. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Pull a value out of parsed JSON by a slash-delimited pointer. */
function resolvePointer(document: unknown, pointer: string): unknown {
  let current: unknown = document;
  for (const token of pointer.replace(/^\//, "").split("/")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/**
 * The JSON document a CLI printed, if it printed one.
 *
 * The whole output first; failing that, everything from the first line that
 * opens a document, then the last non-empty line — the shapes a vendor takes
 * when it prints a notice ("an update is available") before the document it
 * was asked for, pretty-printed or on one line. Without these, one line of
 * noise would make a turn the vendor calls cancelled read as an answer.
 */
function parseDocument(stdout: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const text = stdout.trim();
  const lines = text.split("\n");
  const opens = lines.findIndex((line) => /^\s*[[{]/.test(line));
  const fromOpening = opens <= 0 ? "" : lines.slice(opens).join("\n").trim();
  const lastLine = lines.map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? "";
  for (const candidate of [text, fromOpening, lastLine]) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Not this one; try the next.
    }
  }
  return { ok: false };
}

/**
 * Find the model's answer in whatever the CLI printed.
 *
 * Tolerant by design: a vendor that changes its JSON shape should degrade to
 * "we got text back", not to a crash that looks like the model failed.
 *
 * Tolerant of a *changed shape*, not of an *empty answer* (S12.6). A reply
 * field that is there and blank is the vendor saying the model said nothing,
 * and it comes back as nothing. Measured 2026-09-26 on grok 1.0.40: a turn
 * whose tool call was cancelled printed `"text": ""` and exited 0, and the old
 * fallback handed the whole JSON document on as the answer — which `classify`
 * then called confirmed.
 */
export function extractReply(spec: VendorSpec, stdout: string): string {
  const text = stdout.trim();
  if (text.length === 0 || spec.replyPointers.length === 0) return text;

  const parsed = parseDocument(text);
  if (!parsed.ok) return text;
  const document = parsed.value;

  let blank = false;
  for (const pointer of spec.replyPointers) {
    const value = resolvePointer(document, pointer);
    if (typeof value !== "string") continue;
    if (value.trim().length > 0) return value.trim();
    blank = true;
  }
  return blank ? "" : text;
}

/**
 * The value a turn ended on, when it is not the one a finished turn sets —
 * otherwise `undefined` (S12.6).
 *
 * Only a value that is there and different counts. Output that is not JSON, or
 * JSON without the field, says nothing about how the turn ended, and treating
 * that as unfinished would turn a vendor's shape change into every turn being
 * thrown away.
 */
export function unfinished(spec: VendorSpec, stdout: string): string | undefined {
  const completion = spec.completion;
  if (completion === undefined) return undefined;
  const parsed = parseDocument(stdout);
  if (!parsed.ok) return undefined;
  const value = resolvePointer(parsed.value, completion.pointer);
  return typeof value === "string" && value !== completion.value ? value : undefined;
}

/**
 * The models a CLI's output says the turn ran on (D-142) — every one it names, in the order printed.
 *
 * Read only where the registry says the vendor names them ({@link ModelSpec.reported}), and only out of a JSON
 * document: the keys of one object, one per model the turn called, each replaced by the vendor's canonical name
 * for it when the entry carries one. A name that is not a model name's shape is kept as a `null` slot rather
 * than dropped, so a turn that called two models is never read as one — and a vendor's odd string is never
 * copied into a ledger line. Anything else — no report declared, output that is not JSON, no such object — is
 * an empty list: the output named nothing.
 */
export function reportedModels(spec: VendorSpec, stdout: string): (string | null)[] {
  const report = spec.model?.reported;
  if (report === undefined || report === null) return [];
  const parsed = parseDocument(stdout);
  if (!parsed.ok) return [];
  const usage = resolvePointer(parsed.value, report.keysOf);
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return [];
  return Object.entries(usage as Record<string, unknown>).map(([key, entry]) => {
    const canonical =
      report.canonical === undefined || typeof entry !== "object" || entry === null
        ? undefined
        : (entry as Record<string, unknown>)[report.canonical];
    const name = typeof canonical === "string" && canonical !== "" ? canonical : key;
    return modelProblem(name) === undefined ? name : null;
  });
}

/**
 * Write the profile a restrained turn is held by (D-120), and say where.
 *
 * Before every restrained turn, not once: a turn at level 2 has a shell, and
 * the file sits in a home that shell can write. What that defeats is a file a
 * looser turn *left behind* — a symlink or a looser profile at the path is
 * replaced, not followed. It is not a boundary against a turn running at the
 * same moment as the same user, which can change the file or a directory above
 * it between this write and the vendor's read; that is the kernel fence's job
 * (D-118), not this function's.
 *
 * Created exclusively beside itself and renamed into place, so the vendor never
 * reads half a file and a name planted in advance is refused rather than
 * written through; 0600 in a directory made 0700, because it is a permission
 * and nobody else's business. A failed rename takes its temporary file with it.
 *
 * `home` is the HOME the child will get, since that is what the vendor expands
 * the `~/` in the argv against — and it must be absolute: expanded against
 * anything else, the file and the vendor's read would land in two places.
 */
export async function writeAgentFile(
  mechanism: ReadOnlySpec & { readonly kind: "agent-file" },
  home: string,
): Promise<string> {
  if (!isAbsolute(home)) throw new Error(`the child's HOME is not an absolute path (${JSON.stringify(home)})`);
  const path = expandPath(mechanism.values[0], { home });
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, mechanism.content, { mode: 0o600, flag: "wx" });
  try {
    await rename(temp, path);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
  return path;
}

/**
 * A spec that named a channel, with nothing found in it: every count null, and
 * `missing` says why. The counts the spec does not name at all are still named
 * in `not_printed`, so even a turn that died before its summary says which of
 * its nulls would have been null anyway.
 */
function missingUsage(notPrinted: readonly UsageField[]): Usage {
  return {
    status: "missing",
    input: null,
    output: null,
    total: null,
    cache_read: null,
    cache_write: null,
    cache_write_5m: null,
    cache_write_1h: null,
    not_printed: notPrinted,
  };
}

/** Sum, or null the moment one part is absent — never a partial sum. */
function sumAll(parts: readonly (number | null)[]): number | null {
  let total = 0;
  for (const part of parts) {
    if (part === null) return null;
    total += part;
  }
  return total;
}

/** The counts a JSON spec names no pointer for — null on every turn, and said so. */
function jsonNotPrinted(spec: UsageSpec & { shape: "json" }): UsageField[] {
  return [
    ...(spec.cacheRead === undefined ? (["cache_read"] as const) : []),
    ...(spec.cacheWrite === undefined ? (["cache_write"] as const) : []),
    ...(spec.cacheWrite5m === undefined ? (["cache_write_5m"] as const) : []),
    ...(spec.cacheWrite1h === undefined ? (["cache_write_1h"] as const) : []),
  ];
}

/**
 * The 5-minute and 1-hour parts of a cache write (D-143), or two nulls: both printed, and adding up to the
 * write they split, or neither is kept. A split that does not add up is a vendor whose fields moved meaning,
 * and one of them kept would be a wrong number rather than a missing one.
 */
function writeSplit(cacheWrite: number | null, fiveMinute: number | null, oneHour: number | null): readonly [number | null, number | null] {
  if (cacheWrite === null || fiveMinute === null || oneHour === null || fiveMinute + oneHour !== cacheWrite) return [null, null];
  return [fiveMinute, oneHour];
}

/** Counts out of a vendor that prints them as JSON. */
function jsonUsage(spec: UsageSpec & { shape: "json" }, stream: string): Usage {
  const notPrinted = jsonNotPrinted(spec);
  let document: unknown;
  try {
    document = JSON.parse(stream.trim());
  } catch {
    // The spec says there are numbers here and there is not even an object.
    // That is the turn that died before its summary, and it is `missing`.
    return missingUsage(notPrinted);
  }

  const read = (pointer: string | undefined) => (pointer === undefined ? null : tokenCount(resolvePointer(document, pointer)));
  const input = sumAll(spec.input.map((pointer) => tokenCount(resolvePointer(document, pointer))));
  const output = tokenCount(resolvePointer(document, spec.output));
  const total = spec.total === undefined ? null : read(spec.total);
  const cacheRead = read(spec.cacheRead);
  const cacheWrite = read(spec.cacheWrite);
  const [write5m, write1h] = writeSplit(cacheWrite, read(spec.cacheWrite5m), read(spec.cacheWrite1h));

  // Whatever was found is kept even when the set is incomplete — a half-read
  // line is still worth more to a human than an empty one — but the status
  // says it is incomplete, so nothing downstream can read it as the whole bill.
  // The cache pointers are among the input pointers, so a missing cache count
  // has already made `input` null; they are checked again only so the rule
  // does not depend on the registry keeping that true.
  //
  // The split of a cache write (D-143) does not enter the status: every count
  // the bill is made of is there without it. Unknown, it is two nulls that
  // `not_printed` does not explain — and a turn that wrote to the cache with
  // its split unknown is not charged, which is where the gap is paid for.
  const complete =
    input !== null &&
    output !== null &&
    (spec.total === undefined || total !== null) &&
    (spec.cacheRead === undefined || cacheRead !== null) &&
    (spec.cacheWrite === undefined || cacheWrite !== null);
  return {
    status: complete ? "reported" : "missing",
    input,
    output,
    total,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    cache_write_5m: write5m,
    cache_write_1h: write1h,
    not_printed: notPrinted,
  };
}

/** What a vendor that prints one total never prints: every part of it (S15.9, D-143). */
const TEXT_NOT_PRINTED: readonly UsageField[] = USAGE_FIELDS;

/** A count printed as prose: a label line, then the figure on the next line. */
function textUsage(spec: UsageSpec & { shape: "text" }, stream: string): Usage {
  const lines = stream.split("\n");
  // The last occurrence, not the first: a run that printed several summaries
  // ended on the one that counts.
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.includes(spec.totalAfterLine)) {
      at = i;
      break;
    }
  }
  if (at === -1 || at + 1 >= lines.length) return missingUsage(TEXT_NOT_PRINTED);

  const figure = lines[at + 1]!.trim();
  // Tested before it is converted, because `Number("")` is 0 and an empty line
  // after the label would otherwise be recorded as a turn that used nothing.
  if (!/^\d[\d,]*$/.test(figure)) return missingUsage(TEXT_NOT_PRINTED);
  const total = tokenCount(Number(figure.replace(/,/g, "")));
  if (total === null) return missingUsage(TEXT_NOT_PRINTED);

  // One number, and the vendor's own: input and output stay null rather than
  // being split out of a total Mind has no key to split — and so does every
  // cache count, which is why a turn like this is never priced (S15.9).
  return {
    status: "reported",
    input: null,
    output: null,
    total,
    cache_read: null,
    cache_write: null,
    cache_write_5m: null,
    cache_write_1h: null,
    not_printed: TEXT_NOT_PRINTED,
  };
}

/**
 * Read a turn's token counts out of whatever the CLI printed.
 *
 * Both streams, because the two surveyed vendors use one each, and independent
 * of the exit code, because a turn that failed halfway still spent what it
 * spent. The one property worth stating: **a wrong guess about a vendor's
 * shape produces `missing`, never a wrong number.** Every read goes through
 * {@link tokenCount}, and an incomplete set is labelled as one.
 */
export function extractUsage(spec: VendorSpec, stdout: string, stderr: string): Usage {
  const usage = spec.usage;
  if (usage === null) return UNREPORTED_USAGE;
  const stream = usage.stream === "stdout" ? stdout : stderr;
  return usage.shape === "json" ? jsonUsage(usage, stream) : textUsage(usage, stream);
}

/** How long a timed-out or cancelled turn's processes get after SIGTERM before SIGKILL — D-044's grace. */
const KILL_AFTER_MS = 4_000;

/**
 * End a turn that has run out of time or been cancelled — and reach everything
 * it started, which `child.kill()` does not.
 *
 * Measured 2026-09-22: `Subprocess.kill()` signals the direct child only. A
 * vendor CLI that has started something of its own survives it with its parent
 * reassigned to init, which is a timeout that reports a stopped turn and leaves
 * a running one. Since {@link CliExec.run} spawns detached, the child is its own
 * group leader and the whole group can be addressed — but a group is not the
 * tree: grok runs every shell command under `setsid` (D-149 e2e), so a tool's
 * command leads a group of its own and outlived the timeout, re-parented to
 * init, with no run record left to find it. So the tree is signalled the way
 * `mind stop` signals it ({@link signalTree}: every group in it, each checked
 * before it is addressed, and what no group reached one by one), and whatever is
 * still the same process {@link KILL_AFTER_MS} later gets SIGKILL (D-044).
 */
async function endTurn(child: Bun.Subprocess<"ignore", "pipe", "pipe">, killAfterMs: number = KILL_AFTER_MS): Promise<void> {
  const tree = signalTree(child.pid, "SIGTERM");
  if (tree.signalled.length === 0) {
    // Not in `/proc` (gone already, or no `/proc`): the narrow form is never worse than nothing.
    child.kill();
    return;
  }
  // Waited out here, and awaited by `run` before it returns: a timer left to fire later does not fire at all
  // once `turn` exits, and a child that ignores SIGTERM then outlives the timeout (measured in the re-verify
  // of PR #12). The wait ends early when everything the tree held is gone.
  const sameProcess = (stat: ProcStat) => procStat(stat.pid)?.startTicks === stat.startTicks;
  for (let waited = 0; waited < killAfterMs && tree.watched.some(sameProcess); waited += 25) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  if (tree.watched.some(sameProcess)) signalSurvivors(tree, "SIGKILL");
}

/** A vendor CLI reached as a subprocess. */
export class CliExec implements ExecBackend {
  readonly kind = "cli" as const;
  /**
   * The model this backend hands its CLI (D-142), or undefined for the vendor's own default.
   *
   * Bound here, per backend, rather than carried on the turn request: a request is shared by every step of a
   * fallback chain, and a model on it would reach every vendor in the chain — `claude --model qwen3:8b` is a
   * turn that fails for the wrong reason, and a model id priced on the wrong backend is a wrong bill.
   * `FallbackExec` refuses a request that carries one. A request's own model still wins for a caller that
   * runs this one backend directly, as it does for `OllamaExec`.
   */
  readonly model: string | undefined;

  constructor(
    private readonly spec: VendorSpec,
    private readonly fence: {
      readonly support: () => FenceSupport;
      readonly argv: (argv: readonly string[], policy: FencePolicy) => string[];
    } = { support: fenceSupport, argv: fencedArgv },
    options: { readonly model?: string } = {},
  ) {
    this.model = options.model === "" ? undefined : options.model;
  }

  get id(): string {
    return this.spec.id;
  }

  get display(): string {
    return this.spec.display;
  }

  get identityStrength(): IdentityStrength {
    return this.spec.identity.strength;
  }

  /**
   * True exactly when `run` will start this request through the kernel fence: `request.fence` is what makes
   * `run` ask the kernel and wrap the argv (and refuse the turn when it cannot). A request with none runs on
   * the vendor's own flags — the cloud case — and is not fenced.
   */
  appliesFence(request: TurnRequest): boolean {
    return request.fence !== undefined;
  }

  /**
   * Is the binary on PATH?
   *
   * Deliberately does not run the CLI: a readiness check that spends quota
   * cannot be called in a loop, and `mind backends` calls it for every
   * vendor on every run. `doctor` (S0.2) asks the same question through an
   * injected `which` seam rather than through this method — it has to be able
   * to describe a machine that does not exist — but the lookup is the same one,
   * and the vendor facts it reports still come from the registry.
   */
  async available(): Promise<Availability> {
    // `Bun.which` is a PATH lookup, not a subprocess — no shell, and nothing
    // to go wrong on a machine whose shell builtins differ.
    const path = Bun.which(this.spec.binary);
    if (path === null) {
      return { ok: false, detail: `${this.spec.binary}: not on PATH` };
    }
    return { ok: true, detail: path };
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    const startedAt = performance.now();
    // D-142: the model this turn names, and what the CLI's output will be read for. Named before anything can
    // refuse, so even a turn that never ran says what it was asked to run.
    const model = request.model === undefined || request.model === "" ? this.model : request.model;
    const asked: TurnModel = { requested: model ?? null, reported: [] };

    // The dial, before the argv rather than inside it. A vendor with no
    // read-only mechanism at an acting level of 1 is refused here and nothing
    // is spawned — which is the one case where the dial used to be silently
    // wrong, because there was no flag to add and nobody said so. See
    // `restraintRefusal`.
    const nothingRan = (raw: string): TurnResult => ({
      backend: this.spec.id,
      text: "",
      confidence: "silent",
      // Nothing started, so the identity reached nowhere — the same answer a
      // failed spawn gives, and for the same reason.
      identityStrength: "none",
      evidence: {
        source: this.spec.id,
        prompt: request.prompt,
        raw,
        durationMs: Math.round(performance.now() - startedAt),
        usage: extractUsage(this.spec, "", ""),
        model: asked,
      },
    });

    // D-142. A model this CLI cannot be handed, or one that is not a model's name, stops the turn here: run on
    // the vendor's default instead, it would answer, and the answer would read as the model that was asked for.
    if (model !== undefined) {
      if (this.spec.model === undefined) {
        return nothingRan(
          `refused: ${this.spec.id} takes no model Mind may pass (asked for ${JSON.stringify(model)}), ` +
            "and a turn run on its default instead would read as the model that was asked for.",
        );
      }
      const bad = modelProblem(model);
      if (bad !== undefined) return nothingRan(`refused: the model ${JSON.stringify(model)} ${bad}.`);
    }

    const refused = restraintRefusal(this.spec, request.restraint);
    if (refused !== undefined) return nothingRan(`refused by the autonomy dial: ${refused}`);

    // D-118. Ask before writing a profile or starting anything. A local turn
    // with tools must never fall back to the vendor's allow/deny flags merely
    // because this kernel is missing the boundary that was promised.
    if (request.fence !== undefined) {
      const available = this.fence.support();
      if (!available.ok) return nothingRan(`refused by the kernel fence: ${available.reason}`);
    }

    // D-120. A restrained turn on a vendor held by a profile file gets that
    // file freshly written, or does not run: the vendor would otherwise read
    // whatever a looser turn left at that path.
    // The child's environment, decided once: this process's, the caller's
    // overrides, then the vendor's hardening switches (S12.6), which no caller
    // may undo — and the subject last, which nobody may rename.
    const childEnv: Record<string, string | undefined> = {
      ...(this.spec.inheritEnv === false ? {} : process.env),
      ...request.env,
      ...this.spec.hardening?.env,
      MIND_SUBJECT: request.subject,
    };

    const mechanism = this.spec.readOnly;
    if (!request.restraint.loosened && mechanism.kind === "agent-file") {
      // Unset, the vendor falls back to the account's home as this process
      // does; set to anything that is not absolute (an empty string among
      // them), the vendor would resolve `~/` against its working directory —
      // one a repository controls — and `writeAgentFile` refuses.
      const home = childEnv["HOME"] ?? homedir();
      try {
        await writeAgentFile(mechanism, home);
      } catch (cause) {
        return nothingRan(
          `refused: the read-only profile for ${this.spec.id} could not be written (${String(cause)}), ` +
            "and a restrained turn does not run on a profile Mind did not just write.",
        );
      }
    }

    let argv = [this.spec.binary, ...this.spec.headlessArgv(model === undefined ? request : { ...request, model })];

    // Only two vendors accept a system prompt as a flag. For the rest the
    // identity has to already be on disk, and the result says so rather than
    // implying the turn carried it.
    const appendFlag = this.spec.identity.appendPromptFlag;
    const carriedAsFlag = request.system !== undefined && appendFlag !== undefined;
    if (carriedAsFlag) argv.push(appendFlag, request.system!);

    // D-155. The task's browser, as the one MCP server this turn is handed — or
    // no turn: a vendor that cannot be told *only this server* is refused, and
    // one asked to use a browser does not run without it.
    if (request.browser !== undefined) {
      const wiring = browserWiring(this.spec.id, request.browser, request.restraint);
      if (wiring.status !== "wired") return nothingRan(`refused: no browser for ${this.spec.id}: ${wiring.reason}`);
      try {
        await writeBrowserWiring(wiring);
      } catch (cause) {
        return nothingRan(`refused: the browser's MCP config could not be written (${String(cause)})`);
      }
      argv = withBrowserArgs(argv, wiring);
    }

    let spawnArgv = argv;
    if (request.fence !== undefined) {
      try {
        spawnArgv = this.fence.argv(argv, request.fence);
      } catch (cause) {
        return nothingRan(`refused by the kernel fence: ${String(cause)}`);
      }
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    let timedOut = false;

    try {
      // Through the guard rather than `Bun.spawn` directly (S0.4 AC2). The
      // argv here is built at run time, which is exactly why the old gate —
      // a regular expression looking for `Bun.spawn(["…"` — could not see this
      // call at all. `spawnGuarded` inspects the argv that is really passed,
      // and always pipes both streams, which is what this call site wanted.
      const child = spawnGuarded(spawnArgv, {
        // A CLI resolves its instruction file from the working directory, so a
        // caller that names one means it.
        cwd: request.cwd ?? process.cwd(),
        // A CLI reading its own config is fine; what must not happen is this
        // process's identity leaking into a turn that belongs to a subject.
        // The subject goes last on purpose: a caller's overrides may aim the
        // turn at a different home, but they may not rename whose turn it is.
        env: childEnv,
        // S5.4. Its own process group, so that both `mind stop` and the
        // command a human is handed reach this CLI *and its children* and
        // nothing else. Measured: without it the group belongs to whatever
        // shell started Mind. See `GuardedSpawnOptions.detached`.
        detached: true,
      });

      // Kept so `run` returns only after the ending is over, SIGKILL included (D-044).
      let ending: Promise<void> | undefined;
      const kill = setTimeout(() => {
        timedOut = true;
        ending ??= endTurn(child, request.killAfterMs);
      }, timeoutMs);

      const onAbort = () => {
        ending ??= endTurn(child, request.killAfterMs);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        await child.exited;
        exitCode = child.exitCode ?? undefined;
      } finally {
        clearTimeout(kill);
        request.signal?.removeEventListener("abort", onAbort);
        if (ending !== undefined) await ending;
      }
    } catch (cause) {
      // Spawn itself failed — the binary vanished between `available()` and
      // here, the OS refused, or the guard refused (`SpawnRefused`, which
      // carries its reason into `raw` below). That is a failure to run, not a
      // bad answer.
      //
      // The strength is "none" whatever the argv was going to carry: no
      // process started, so the identity reached nowhere. Reporting the
      // channel it *would* have used describes a delivery that never
      // happened — the same shape of lie as reading a login error as the
      // model's answer.
      return {
        backend: this.spec.id,
        text: "",
        confidence: "silent",
        identityStrength: "none",
        evidence: {
          source: this.spec.id,
          prompt: request.prompt,
          raw: `spawn failed: ${String(cause)}`,
          durationMs: Math.round(performance.now() - startedAt),
          // No streams to read, so a vendor with a channel reports `missing`
          // and a vendor without one reports `unreported` — the same two
          // answers the mechanism gives everywhere else, with no special case
          // for "we know why it is empty".
          usage: extractUsage(this.spec, "", ""),
          model: asked,
        },
      };
    }

    const durationMs = Math.round(performance.now() - startedAt);
    const text = extractReply(this.spec, stdout);

    // Read here, from both streams, before `raw` below narrows to one of them.
    // `raw` keeps stderr only when stdout came back empty, which is precisely
    // the case codex is not: it answers on stdout and prints its token count
    // on stderr, so anything reading the counts out of `raw` would find them
    // on failed turns and never on successful ones.
    const usage = extractUsage(this.spec, stdout, stderr);

    // A killed process reports no useful exit code, and its empty output is
    // not the model declining to answer — it is us cutting the call off. A turn
    // the vendor says it did not finish is not an answer either, whatever
    // sentence it got out first.
    const stoppedAt = unfinished(this.spec, stdout);
    const confidence = timedOut || stoppedAt !== undefined ? "silent" : classify(text, exitCode);

    return {
      backend: this.spec.id,
      text,
      confidence,
      identityStrength: carriedAsFlag
        ? this.spec.identity.strength
        : request.system !== undefined
          ? "user"
          : "none",
      evidence: {
        source: this.spec.id,
        prompt: request.prompt,
        // Keep stderr when stdout is empty: for several of these CLIs the
        // reason a turn produced nothing is only ever on stderr.
        raw: timedOut
          ? `timed out after ${timeoutMs}ms\n${stderr}`.trim()
          : stoppedAt !== undefined
            ? [
                `ended ${JSON.stringify(stoppedAt)}, not ${JSON.stringify(this.spec.completion?.value)}`,
                // A cap hit and an approval cancel both say `cancelled`; only
                // stderr tells them apart, and only on a non-zero exit.
                ...(exitCode !== undefined && exitCode !== 0 && stderr.trim() !== "" ? [stderr.trim()] : []),
                stdout.trim(),
              ].join("\n")
            : stdout.trim().length > 0
            ? stdout
            : stderr,
        durationMs,
        usage,
        // Read whatever the exit code: a turn that failed halfway may still say which model it called.
        model: { requested: asked.requested, reported: reportedModels(this.spec, stdout) },
        ...(exitCode === undefined ? {} : { exitCode }),
      },
    };
  }
}
