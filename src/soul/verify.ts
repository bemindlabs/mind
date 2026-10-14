/**
 * Asking the model, instead of believing the file.
 *
 * `soul apply` can report a perfect write and still have changed nothing about
 * how a backend behaves: the file may be read late, weighed lightly, or
 * overridden by something else in the same context. So this module measures the
 * other end. It asks each backend three questions whose answers exist only
 * inside the soul that was applied, and reports what actually came back.
 *
 * Four commitments shape everything below.
 *
 * - **No floating identity questions.** "Who are you?" is unanswerable as
 *   evidence on a machine where something else also injects a persona — a
 *   session-start hook, a vendor default, another tool's file. Every probe
 *   therefore asks for a *distinctive fact of this soul* ("what do your
 *   standing instructions call the user?"), which a second identity in the same
 *   context cannot supply by accident. A pass means this soul's words came
 *   back, not that the model sounded like somebody.
 * - **Four levels, never a boolean** (AC3). {@link Confidence} already draws the
 *   line this story needs: a CLI that could not run is `silent`, not a failed
 *   identity, and collapsing the two would hide the only difference that
 *   changes what you do next.
 * - **The raw answer is the evidence** (AC2). Levels are Mind's opinion;
 *   the transcript is the fact. Every probe keeps its prompt, its reply, its
 *   duration and its exit code so a reviewer can disagree with the level.
 * - **Backends are not equal, and the report says so** (AC4). A file lands as
 *   user-level text; the system field of a local request lands as a real system
 *   prompt. {@link channelFor} names which one each row actually used, rather
 *   than flattening them into one "supported".
 *
 * Nothing here writes. `verify` is a read of the filesystem and a series of
 * turns; the only state it leaves is what the vendors log for themselves.
 */

import type { ExecBackend, IdentityStrength, TurnRequest } from "../exec/backend.ts";
import { probeRestraint } from "../exec/restraint.ts";
import { vendor } from "../exec/registry.ts";
import type { Confidence, Evidence, NonEmpty, SubjectId } from "../types.ts";
import { locate } from "./block.ts";
import { renderSoul } from "./render.ts";
import type { Soul } from "./schema.ts";
import type { Target } from "./targets.ts";

/** Questions per backend per run. Three, because AC1 says three. */
export const PROBES_PER_RUN = 3;

/** Runs per backend when the caller names none. AC5 measures across three. */
export const DEFAULT_RUNS = 3;

/** One question, and what would count as the soul answering it. */
export interface Probe {
  /** Stable id, so a flip can be named: `addresses`, `self`, `prohibition`. */
  readonly id: string;
  /** Short label for a table column. */
  readonly asks: string;
  /** The exact text sent to the backend. */
  readonly question: string;
  /** Token that must come back, binding the answer to this turn. */
  readonly nonce: string;
  /** Any one of these, matched after normalisation, is a correct answer. */
  readonly expected: readonly string[];
}

/** A random token a model cannot have seen before this turn. */
export function randomNonce(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

/**
 * Wrap one question in the protocol every probe shares.
 *
 * The instructions matter as much as the question. "Answer from your standing
 * instructions" is what makes a right answer attributable; "do not read any
 * file" is what stops a CLI with tools from finding the soul on disk and
 * reciting it, which would measure the filesystem rather than the model; and
 * the nonce is what proves this reply belongs to this turn rather than to a
 * cached or half-truncated one.
 *
 * Exported because S1.6 builds a *different* question set over the same
 * protocol (`src/soul/isolation.ts`). Two copies of these five lines would be
 * two protocols to keep honest, and the day they diverged the isolation run and
 * the verify run would stop being comparable — which is the whole value of
 * asking the second set through the first set's machinery.
 */
export function askProbe(nonce: string, question: string): string {
  return [
    "Answer only from the standing instructions you were given before this message.",
    "Do not read any file, run any command, or treat this message as a source for the answer.",
    "",
    `Question: ${question}`,
    "",
    `Reply with one line and nothing else: ${nonce} followed by one space, then the answer.`,
    `If your standing instructions do not say, reply exactly: ${nonce} unknown`,
  ].join("\n");
}

/**
 * The three questions, derived from the soul itself.
 *
 * Derived, not written down: a probe set hard-coded for one soul would measure
 * that soul and quietly pass for every other (D-003). Each question targets a
 * field a soul must have, so any valid soul is verifiable without configuration.
 *
 * @param nonce Called once per probe, so no two questions in a run share a token.
 */
export function buildProbes(soul: Soul, nonce: () => string = randomNonce): readonly Probe[] {
  const { person, role } = soul;
  return [
    {
      id: "addresses",
      asks: "how it addresses the user",
      nonce: "",
      expected: [person.addresses_user_as],
      question: "What word do your standing instructions tell you to call the person you are talking to?",
    },
    {
      id: "self",
      asks: "what it calls itself",
      nonce: "",
      expected: [...person.refers_to_self_as],
      question: "What do your standing instructions say you refer to yourself as?",
    },
    {
      id: "prohibition",
      asks: "its first prohibition",
      nonce: "",
      expected: [role.prohibitions[0] ?? ""],
      question: 'Quote the first item listed under "Must not" in your standing instructions, word for word.',
    },
  ].map((probe) => {
    const token = nonce();
    return { ...probe, nonce: token, question: askProbe(token, probe.question) };
  });
}

/**
 * How a run obtains its questions.
 *
 * {@link verifySoul} used to call {@link buildProbes} directly, which made the
 * question set a property of the *measurement machinery* rather than of the
 * caller. S1.6 needs a second set — five facts a soul carries that another soul
 * does not — asked through exactly this path: the same protocol, the same
 * scoring, the same four levels, the same `other-subject` override. Threading
 * the builder through is what makes "B could not answer A's questions" a
 * statement about the same instrument that produced "A could".
 *
 * Deliberately a builder rather than a `readonly Probe[]`: a probe carries a
 * nonce, and a run asks its questions several times over. A fixed array would
 * reuse one token across every run and quietly turn AC5's stability check into
 * a test of whether the backend caches.
 */
export type ProbeBuilder = (soul: Soul, nonce: () => string) => readonly Probe[];

/**
 * Fold away everything two humans would call the same answer.
 *
 * Deliberately blunt: case, punctuation and runs of whitespace go, nothing
 * else. Anything cleverer would start deciding that a wrong answer was close
 * enough, and the whole point of this command is that it does not do that.
 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** What came back for one probe, judged. `silent` means nothing arrived. */
export function scoreAnswer(probe: Probe, turn: { readonly text: string; readonly confidence: Confidence }): Confidence {
  if (turn.confidence === "silent" || turn.text.trim().length === 0) return "silent";

  const answer = normalize(turn.text);
  const matched = probe.expected.some((value) => {
    const wanted = normalize(value);
    return wanted.length > 0 && answer.includes(wanted);
  });
  if (!matched) return "failed";

  // The soul's words came back, but nothing ties them to this turn — a cached
  // reply, a truncated prompt, and a real answer all look like this. Believe
  // it, and say that it is believed rather than observed.
  return answer.includes(normalize(probe.nonce)) ? "confirmed" : "partial";
}

/**
 * One backend's level, from every probe of every run.
 *
 * Strict on purpose. One wrong answer in nine is not "it works"; it is exactly
 * the partial delivery this project exists to make visible.
 */
export function levelFor(verdicts: readonly Confidence[]): Confidence {
  if (verdicts.length === 0) return "silent";
  if (verdicts.every((v) => v === "silent")) return "silent";
  if (verdicts.every((v) => v === "confirmed")) return "confirmed";
  if (verdicts.some((v) => v === "confirmed" || v === "partial")) return "partial";
  return "failed";
}

/** What the file on disk says, before any model is asked. */
export type FileState =
  /** This backend has no instruction file at any scope. */
  | "system-field"
  /** The file the vendor reads is not there. */
  | "missing"
  /** The file is there and holds no Mind block. */
  | "absent"
  /** A block for this subject, holding exactly this soul. */
  | "present"
  /** A block for this subject, holding an older render of it. */
  | "stale"
  /** A block whose body was edited by hand since Mind wrote it. */
  | "edited"
  /** A block that belongs to a different subject (I-3). */
  | "other-subject"
  /** Unreadable, or holding markers Mind refuses to interpret. */
  | "unreadable";

/** The deterministic half of the answer: what is on disk, checked without a model. */
export interface FileCheck {
  readonly state: FileState;
  /** One line a human can act on. */
  readonly detail: string;
  readonly path?: string;
  /** Whose block is in the file, when there is one. */
  readonly subject?: SubjectId;
}

/**
 * Read the target file and say what Mind finds in it.
 *
 * Runs *before* the probes on purpose. Whether a block is on disk is a fact,
 * and a fact settled by evidence should never be inferred from a model's mood.
 *
 * @param rendered The current {@link renderSoul} output, which is deterministic,
 *   so "the block holds this soul" is a byte comparison rather than a guess.
 */
export async function checkFile(target: Target, rendered: string): Promise<FileCheck> {
  if (target.kind === "system-field") {
    return { state: "system-field", detail: "not a file — sent with every request" };
  }

  const path = target.path;
  const handle = Bun.file(path);
  if (!(await handle.exists())) {
    return { state: "missing", path, detail: "the file this vendor reads does not exist" };
  }

  let text: string;
  try {
    text = await handle.text();
  } catch (cause) {
    return { state: "unreadable", path, detail: `could not be read as text: ${String(cause)}` };
  }

  const found = locate(text);
  if (found.kind === "refused") return { state: "unreadable", path, detail: found.reason };
  if (found.kind === "absent") return { state: "absent", path, detail: "no Mind block in this file" };

  const block = found.block;
  if (!block.intact) {
    return {
      state: "edited",
      path,
      subject: block.subject,
      detail: "the text between Mind's markers was edited by hand — what the model reads is not what Mind wrote",
    };
  }
  // Whose block it is, is decided by the caller: `checkFile` compares bytes
  // and nothing else, so `withOtherSubject` can re-label without re-reading.
  const body = block.body.replaceAll("\r\n", "\n");
  const same = body === rendered;
  return {
    state: same ? "present" : "stale",
    path,
    subject: block.subject,
    detail: same ? "holds exactly this soul" : "holds an older render of a soul — re-run `soul apply`",
  };
}

/** How the identity reached the model in this run, and how strongly. */
export interface Channel {
  readonly kind: "instruction-file" | "system-field";
  /**
   * What it arrives as. A file is user-level text even for a vendor that also
   * offers a system-prompt flag — verify does not use the flag, because the
   * flag is what S1.4 measures separately.
   */
  readonly strength: IdentityStrength;
  readonly note: string;
}

/** Name the channel this verification actually used for one target. */
export function channelFor(target: Target): Channel {
  if (target.kind === "system-field") {
    return {
      kind: "system-field",
      strength: "system",
      note: "carried in the system field of every request — a real system prompt",
    };
  }

  let flag: string | undefined;
  try {
    flag = vendor(target.backend).identity.appendPromptFlag;
  } catch {
    flag = undefined;
  }
  return {
    kind: "instruction-file",
    strength: "user",
    note:
      `read from ${target.path} as user-level instructions, which a model may weigh less than a system prompt` +
      (flag === undefined
        ? " — this vendor offers no system-prompt flag at all"
        : ` — this vendor also offers ${flag}, which verify deliberately does not use (S1.4 measures that separately)`),
  };
}

/** One probe, on one run, with everything needed to check the verdict by hand. */
export interface ProbeRun {
  readonly probe: string;
  readonly asks: string;
  /** 1-based run number. */
  readonly run: number;
  readonly verdict: Confidence;
  /** What would have counted as correct. */
  readonly expected: readonly string[];
  /** The reply as extracted from the vendor's output. */
  readonly answer: string;
  readonly evidence: Evidence;
}

/** How steady one question's answer was across the runs (AC5). */
export interface ProbeStability {
  readonly probe: string;
  readonly verdicts: readonly Confidence[];
  readonly flipped: boolean;
}

/**
 * Everything measured about one backend.
 *
 * `stable` is the field worth reading the comment for: see {@link Stability}.
 */
export interface BackendReport {
  readonly backend: string;
  readonly display: string;
  /** The four-level result. Never collapsed to pass/fail (AC3). */
  readonly level: Confidence;
  /** One sentence naming what the level means here. */
  readonly reason: string;
  readonly channel: Channel;
  readonly file: FileCheck;
  /** Whether the backend was reachable at all, and what it said if not. */
  readonly reachable: boolean;
  readonly runs: readonly ProbeRun[];
  readonly stability: readonly ProbeStability[];
  /** Questions whose verdict was not the same on every run. */
  readonly flipped: number;
  /** AC5: at most one of three questions may move. {@link Stability}. */
  readonly stable: Stability;
  /** Things that would make a reader wrong to trust this row on its own. */
  readonly caveats: readonly string[];
}

/**
 * How steady something was — or `null`, which is not a third kind of steady.
 *
 * `true` means it was measured and held. `false` means it was measured and
 * moved. **`null` means it was not measured**, and it is here because the third
 * state was previously reported as the first: a backend that could not run at
 * all got `stable: true` written into the silent arm directly, so a machine with
 * no vendor CLI on PATH produced `level: "silent"`, `runs: []`, `flipped: 0` and
 * `stable: true` — perfect stability over zero probe runs, handed to whoever
 * parses `--json` with a `flipped: 0` beside it looking like a measurement
 * (odd2, H4).
 *
 * `false` would be the other wrong answer, and by a wider margin: it is the
 * claim that this backend was asked and wavered, which is ADR 0001 §2's
 * `silent` collapsed into `failed` — the one move this project exists to
 * refuse. A row that never ran did not hold still and did not move.
 *
 * At report level the same three states are folded in that order: any `false`
 * makes the report `false`; failing that, any `null` makes it `null`; only a
 * report where every row was measured and held is `true`. A `null` there does
 * not swallow what the other rows measured — {@link VerifyReport.unmeasured}
 * names exactly which backends it came from, so "we do not know" is always
 * accompanied by "and here is why".
 */
export type Stability = boolean | null;

/** The whole measurement. */
export interface VerifyReport {
  readonly subject: SubjectId;
  readonly runs: number;
  /**
   * One row per backend asked, and there is always at least one.
   *
   * {@link NonEmpty} because every judgment made of this report is an `every`
   * or an `all` over it, and each of those is true of nothing: `soul verify`'s
   * exit rule was `backends.every((b) => b.level === "confirmed") &&
   * result.stable`, which is `true && true` for a report of no backends — exit
   * 0, having measured nothing (odd2, H5). The list is closed here rather than
   * guarded at each reader, because there were three readers and one of them
   * had no guard.
   */
  readonly backends: NonEmpty<BackendReport>;
  /** Caveats about the machine rather than about one backend. */
  readonly caveats: readonly string[];
  /** Whether every backend held still across the runs (AC5). {@link Stability}. */
  readonly stable: Stability;
  /**
   * The backends whose stability was not measured, by id.
   *
   * Empty whenever {@link stable} is a boolean. Non-empty is what makes a
   * report-level `null` readable: one silent row is enough to make the whole
   * report "not known", and a reader is entitled to know that the other rows
   * were measured and which single row is the reason.
   */
  readonly unmeasured: readonly string[];
}

/**
 * Does this report clear the bar `soul verify` exits 0 on?
 *
 * In `src/` rather than in the command, because that is where it can be tested.
 * It lived as two lines inside `cmdSoulVerify`, and odd2's probe for it could
 * only assert against a *transcribed copy* of those two lines — a test that
 * goes green when the real rule is repaired and green when it is not, because
 * it never touches it. Same rule, one definition, callable.
 *
 * Both halves are strict about the same thing. `confirmed` on every backend is
 * a statement about what was measured; `stable === true` rather than
 * `!== false` is a statement that it *was* measured — a report carrying `null`
 * does not pass, because "we did not find out" is not a verification.
 */
export function verifyPasses(report: VerifyReport): boolean {
  return report.backends.every((row) => row.level === "confirmed") && report.stable === true;
}

/** Everything `verify` is allowed to know about this machine. */
export interface VerifyOptions {
  /** Where the identity was applied, resolved by the caller — as `apply` does. */
  readonly targets: readonly Target[];
  /** How many times to ask the whole question set. Default {@link DEFAULT_RUNS}. */
  readonly runs?: number;
  /** Injected so a test can make a run reproducible. */
  readonly nonce?: () => string;
  /**
   * Wall-clock ceiling per turn.
   *
   * There is deliberately no `model` here: which model a backend uses is the
   * backend's own configuration (`backend("ollama", { model })`), and a single
   * model id threaded through every backend would send a local model name to a
   * vendor CLI that has never heard of it.
   */
  readonly timeoutMs?: number;
  /**
   * Environment overrides for probe subprocesses.
   *
   * This is how a probe is aimed at the same home the file check read. Without
   * it a spawned CLI would read the operator's real instruction file while the
   * report talked about a different one.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory for probe subprocesses. */
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Machine-level caveats the caller already knows, e.g. session-start hooks. */
  readonly caveats?: readonly string[];
  /**
   * The question set. Defaults to {@link buildProbes} — S1.3's three.
   *
   * S1.6 passes its own; see {@link ProbeBuilder} for why this is the seam.
   */
  readonly probes?: ProbeBuilder;
}

function targetFor(targets: readonly Target[], backendId: string): Target | undefined {
  return targets.find((t) => t.backend === backendId);
}

/**
 * Sentences that tell a reader what this row does *not* prove.
 *
 * The three disagreements between disk and behaviour each mean something
 * different, and each is worth more than the level on its own.
 */
function caveatsFor(level: Confidence, file: FileCheck, channel: Channel): string[] {
  const caveats: string[] = [];

  if ((level === "confirmed" || level === "partial") && (file.state === "absent" || file.state === "missing")) {
    caveats.push(
      "the answers carry this soul but Mind wrote no block here — the identity is reaching this backend " +
        "through some other channel, and Mind cannot take that channel back (I-4)",
    );
  }
  if (level === "failed" && file.state === "present") {
    caveats.push(
      "the soul is on disk exactly as rendered, and the model still answered otherwise — the file channel " +
        "is either too weak here or is being overridden by something else in the context",
    );
  }
  if (file.state === "other-subject") {
    caveats.push(
      `the block on disk belongs to subject ${file.subject ?? "?"} — this machine is wearing a different ` +
        "identity, so nothing here can be read as the requested one arriving (I-3)",
    );
  }
  if (file.state === "stale") {
    caveats.push("the block on disk is an older render of this soul — `soul apply` has not been re-run since it changed");
  }
  if (channel.kind === "instruction-file") {
    caveats.push(
      "this row measures the file channel only: the identity arrives as user-level text, not as a system prompt (AC4)",
    );
  }
  return caveats;
}

function reasonFor(level: Confidence, file: FileCheck, reachable: boolean, detail: string): string {
  if (!reachable) return `did not run: ${detail}`;
  switch (level) {
    case "confirmed":
      return "every question was answered with this soul's own words, with the run token attached";
    case "partial":
      return "some questions carried this soul and some did not — the identity arrived incompletely";
    case "failed":
      return file.state === "present"
        ? "the soul is on disk, and the model answered from something else"
        : "the model answered, and none of it was this soul";
    case "silent":
      return "nothing came back at all — this is a failure to run, not a wrong answer";
  }
}

/**
 * Measure one soul against every backend given.
 *
 * Each backend is measured on its own. There is deliberately no fallback here:
 * a chain that answers on its third try would report a level for a backend that
 * never answered, which is the exact lie this command exists to prevent.
 */
export async function verifySoul(
  soul: Soul,
  backends: NonEmpty<ExecBackend>,
  options: VerifyOptions,
): Promise<VerifyReport> {
  const rendered = renderSoul(soul);
  const runs = Math.max(1, options.runs ?? DEFAULT_RUNS);
  const nonce = options.nonce ?? randomNonce;
  const build = options.probes ?? buildProbes;
  const caveats = [...(options.caveats ?? [])];

  // A question whose answer is already in the question cannot attribute
  // anything. Say so rather than scoring it as if it could.
  for (const probe of build(soul, () => "0")) {
    for (const value of probe.expected) {
      const wanted = normalize(value);
      if (wanted.length > 0 && wanted.length < 3) {
        caveats.push(
          `the expected answer for "${probe.asks}" is only ${wanted.length} character(s) long — ` +
            "it could match by accident; read the raw answers for this one",
        );
      }
    }
  }

  // Head and tail rather than a loop into an array, so the non-empty promise
  // survives into the report: every reader of `backends` below judges it with
  // an `every`, and `every` is true of nothing. Sequential on purpose — these
  // are real turns on real CLIs, and running them at once would change what is
  // being measured.
  const measure = (exec: ExecBackend): Promise<BackendReport> =>
    measureBackend(exec, soul, rendered, runs, nonce, build, options);
  const first = await measure(backends[0]);
  const rest: BackendReport[] = [];
  for (const exec of backends.slice(1)) rest.push(await measure(exec));
  const reports: NonEmpty<BackendReport> = [first, ...rest];

  // Three states folded in one order, and the order is the point: a measured
  // flip outranks an unmeasured row, and an unmeasured row outranks the rest
  // holding still. See {@link Stability}.
  const unmeasured = reports.filter((row) => row.stable === null).map((row) => row.backend);
  const stable: Stability = reports.some((row) => row.stable === false)
    ? false
    : unmeasured.length > 0
      ? null
      : true;

  return { subject: soul.subject, runs, backends: reports, caveats, stable, unmeasured };
}

/**
 * One backend, measured on its own.
 *
 * Lifted out of {@link verifySoul}'s loop so that the loop could become a head
 * and a tail — see the comment at its call site. Nothing about what is measured
 * changed with the move.
 */
async function measureBackend(
  exec: ExecBackend,
  soul: Soul,
  rendered: string,
  runs: number,
  nonce: () => string,
  build: ProbeBuilder,
  options: VerifyOptions,
): Promise<BackendReport> {
    const target = targetFor(options.targets, exec.id);
    const file = target === undefined
      ? ({ state: "missing", detail: "no target resolved for this backend" } as FileCheck)
      : await checkFile(target, rendered);
    const channel: Channel = target === undefined
      ? { kind: "instruction-file", strength: "none", note: "no target resolved for this backend" }
      : channelFor(target);

    // Whose block is in the file is a question about the requested subject, so
    // it is settled once, here, and every level below reads the same answer.
    const checked = withOtherSubject(file, soul.subject);

    const availability = await exec.available();
    if (!availability.ok) {
      return {
        backend: exec.id,
        display: exec.display,
        level: "silent",
        reason: reasonFor("silent", checked, false, availability.detail),
        channel,
        file: checked,
        reachable: false,
        runs: [],
        stability: [],
        flipped: 0,
        // Not `true`. Nothing was asked, so nothing held still — see
        // {@link Stability} for why the other wrong answer is `false`.
        stable: null,
        caveats: caveatsFor("silent", checked, channel),
      };
    }

    const probeRuns: ProbeRun[] = [];
    const byProbe = new Map<string, Confidence[]>();

    for (let run = 1; run <= runs; run++) {
      for (const probe of build(soul, nonce)) {
        const request = turnRequest(soul.subject, probe, channel, rendered, options);
        const turn = await exec.run(request);
        const verdict = scoreAnswer(probe, turn);
        probeRuns.push({
          probe: probe.id,
          asks: probe.asks,
          run,
          verdict,
          expected: probe.expected,
          answer: turn.text,
          evidence: turn.evidence,
        });
        byProbe.set(probe.id, [...(byProbe.get(probe.id) ?? []), verdict]);
      }
    }

    const stability: ProbeStability[] = [...byProbe.entries()].map(([probe, verdicts]) => ({
      probe,
      verdicts,
      flipped: verdicts.some((v) => v !== verdicts[0]),
    }));
    const flipped = stability.filter((s) => s.flipped).length;

    // I-3, checked rather than argued: a file wearing someone else's block
    // cannot be evidence that this subject arrived, however well the model
    // happened to answer.
    const measured = levelFor(probeRuns.map((r) => r.verdict));
    const level: Confidence =
      checked.state === "other-subject" && measured !== "silent" ? "failed" : measured;

    return {
      backend: exec.id,
      display: exec.display,
      level,
      reason:
        checked.state === "other-subject" && measured !== level
          ? `answers matched, but the block on disk belongs to subject ${checked.subject ?? "?"} — reported as failed (I-3)`
          : reasonFor(level, checked, true, availability.detail),
      channel,
      file: checked,
      reachable: true,
      runs: probeRuns,
      stability,
      flipped,
      // AC5: three questions, at most one of them allowed to move. A boolean
      // here and not `null`: this backend ran, so this was measured.
      stable: flipped <= 1,
      caveats: caveatsFor(level, checked, channel),
    };
}

/**
 * Re-label a file check once the requested subject is known.
 *
 * {@link checkFile} does not take the subject, so that the byte comparison
 * stays about the rendered text alone. Whose block it is, is decided here.
 */
function withOtherSubject(file: FileCheck, subject: SubjectId): FileCheck {
  if (file.subject === undefined || file.subject === subject) return file;
  return {
    ...file,
    state: "other-subject",
    detail: `holds the block of subject ${file.subject}, not ${subject}`,
  };
}

/**
 * Build the turn for one probe.
 *
 * The rule that makes the measurement mean anything: a backend whose channel is
 * a file gets **no** system text, so a correct answer can only have come from
 * the file on disk. A backend whose channel is the request itself gets exactly
 * what `apply` would have written, rendered by the same function.
 */
function turnRequest(
  subject: SubjectId,
  probe: Probe,
  channel: Channel,
  rendered: string,
  options: VerifyOptions,
): TurnRequest {
  return {
    subject,
    prompt: probe.question,
    // Pinned, never read from the dial: a measuring instrument whose
    // permissions follow a setting produces readings that follow a setting.
    // See `probeRestraint` for the longer argument.
    restraint: probeRestraint(),
    ...(channel.kind === "system-field" ? { system: rendered } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/**
 * Whether this home injects extra context into a CLI's sessions.
 *
 * A `SessionStart` hook can put a whole second identity in front of the model
 * before Mind's prompt arrives, and neither `apply` nor a file check can see
 * it. That does not invalidate a measurement — the probes ask for facts only
 * this soul carries — but it does mean a reader should know that attribution
 * had competition. Read-only, and it never interprets what the hook does.
 *
 * @returns One caveat per settings file that configures such a hook.
 */
export async function contextInjectionNote(home: string): Promise<readonly string[]> {
  const notes: string[] = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const path = `${home}/.claude/${name}`;
    const handle = Bun.file(path);
    if (!(await handle.exists())) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.text());
    } catch {
      continue;
    }
    const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
    const sessionStart = hooks === undefined || hooks === null ? undefined : hooks["SessionStart"];
    if (!Array.isArray(sessionStart) || sessionStart.length === 0) continue;

    notes.push(
      `${path} configures ${sessionStart.length} SessionStart hook(s): every claude session in this home ` +
        "starts with context Mind did not write. Answers may blend two identities, so only answers carrying " +
        "this soul's own words are counted — read the raw answers before trusting any row here.",
    );
  }
  return notes;
}

/**
 * How many probe answers were right, out of how many were asked.
 *
 * Kept next to the report rather than in the printer because a caller reading
 * `--json` wants the same number the table shows.
 */
export function tally(report: BackendReport): { readonly passed: number; readonly total: number } {
  return {
    passed: report.runs.filter((r) => r.verdict === "confirmed").length,
    total: report.runs.length,
  };
}

/**
 * Repeat `apply`'s egress note for the rows that are cloud CLIs (I-6).
 *
 * Named apart from {@link import("./apply.ts").egressNote} because the two say
 * different things: applying uploads the file once per later turn, verifying
 * spends the turns itself.
 */
export function verifyEgressNote(report: VerifyReport): string | undefined {
  const cloud = report.backends
    .filter((b) => b.channel.kind === "instruction-file" && b.reachable)
    .map((b) => b.backend);
  if (cloud.length === 0) return undefined;
  return (
    `Each probe above was a real turn on ${[...new Set(cloud)].join(" and ")}, and those CLIs upload their ` +
    `instruction file with every turn. Verifying costs the same egress as using them.`
  );
}

/** The four levels, spelled out wherever a reader meets them first (AC3). */
export const LEVEL_LEGEND: Readonly<Record<Confidence, string>> = {
  confirmed: "every question answered from this soul",
  partial: "some questions answered from this soul, some not",
  failed: "answered, but not from this soul",
  silent: "the backend never ran, or returned nothing — not a wrong answer",
};
