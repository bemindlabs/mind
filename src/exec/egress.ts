/**
 * The last moment anything can still be said: before the prompt is handed over.
 *
 * S7.2 AC4 — *"แจ้งก่อนข้อมูลจะเกิดที่จุดนั้น ไม่ใช่ตอนขอลบ"* — was true at two
 * addresses and open at a third. `mind new` announces what a commit puts
 * beyond reach, `ensureObserverDir` announces what a purge cannot reach, and
 * `turn` announced nothing at all about the one address Mind can never reach
 * afterwards: a vendor's copy of the owner's own words. {@link VENDORS_HOLD} was
 * already written down — `ledger forget` prints it, and prints it *after*, when
 * a reader can do nothing with it.
 *
 * ## The three judgements this file makes
 *
 * **When.** Per dispatch, not per turn. `FallbackExec` decides at run time who
 * is really handed the text: a chain `claude → codex → ollama` where claude is
 * off PATH gives claude nothing, and naming claude at the start of the turn
 * would be a sentence about a send that never happened. So the notice lives in
 * {@link AnnouncedExec}, one wrapper per member — the same position, for the
 * same reason, that `RecordingExec` already occupies.
 *
 * **What counts as leaving.** {@link notLocal}, asked of the **raw** backend.
 * It is the run-time answer (an `OllamaExec` whose host is a loopback literal,
 * by `instanceof`), and it has to be asked of the backend itself rather than of
 * a wrapper around it, because a wrapper copies the id and `RecordingExec`
 * already does. A loopback ollama prints nothing: a turn that never leaves the
 * machine has nothing to disclose, and a warning on a run where nothing happened
 * teaches people to skip the warning on the run where something does.
 *
 * **Who may switch it off. Nobody.** There is no flag, no env var, no config
 * key and no remembered acknowledgement in this file — an earlier draft of w3b
 * had one and it was rejected, on four grounds worth keeping written down:
 * every limits list in this repo prints on every run by design, so the first
 * exception becomes the precedent for the next; the fact being disclosed is the
 * most irreversible one Mind handles, which makes it the worst candidate for
 * silencing; noise is a real cost but the answer to it is a shorter line, not a
 * quieter one; and a silencing flag is a flag an agent running as the owner can
 * pass on the owner's behalf — the same failure `observe enable` avoids by
 * having no `--yes`. So the notice is **one line**, and it prints every time.
 *
 * ## What it proves, and what no type can
 *
 * {@link EgressNotice} is the brand `announceCapture`/`CaptureNotice` already
 * uses: minted by exactly one function, required by {@link dispatchAnnounced},
 * so a prompt cannot be handed to an off-machine backend by code that has not
 * first written the line — and `tsc` says so rather than a reviewer. It proves
 * the line was *written*. It cannot prove anybody read it, and
 * {@link EGRESS_LIMITS} says that out loud rather than leaving it implied.
 *
 * Three other things in this repo talk about egress and none of them covers
 * this one: `egressNote` (`src/soul/apply.ts`) and `verifyEgressNote`
 * (`src/soul/verify.ts`) are about the *soul file* being uploaded, and verify's
 * is printed after its own turns; `LOCAL_LIMITS` is about how little "loopback"
 * proves. This one is about the owner's prompt, before it goes.
 */

import { describeFindings, type EgressFinding } from "../egress/filter.ts";
import { VENDORS_HOLD } from "../ledger/store.ts";
import type {
  Availability,
  BackendKind,
  ExecBackend,
  IdentityStrength,
  TurnRequest,
  TurnResult,
} from "./backend.ts";
import { FallbackExec } from "./fallback.ts";
import { notLocal } from "./local.ts";
import { OllamaExec } from "./ollama-exec.ts";

/**
 * Where a prompt is about to go, when that is not this machine.
 *
 * Two shapes because the honest sentence differs. A vendor CLI is a name Mind
 * knows something about — it is in the registry, and {@link VENDORS_HOLD}
 * describes what it keeps. An ollama pointed at a host that is not a loopback
 * literal is a machine Mind knows *nothing* about, and saying the vendor
 * sentence about it would be inventing a fact.
 */
export type EgressTarget =
  | { readonly kind: "vendor"; readonly id: string; readonly display: string }
  | { readonly kind: "host"; readonly id: string; readonly host: string };

/**
 * Where this backend sends a prompt, or `undefined` when the answer is "here".
 *
 * Must be handed the backend as it really is. A `RecordingExec` around an
 * ollama reports `id === "ollama"` and is not an `OllamaExec`, so asking this
 * of the wrapper would announce a vendor egress for a turn that never left.
 */
export function egressTarget(backend: ExecBackend, request?: TurnRequest): EgressTarget | undefined {
  if (notLocal(backend, request) === undefined) return undefined;
  if (backend instanceof OllamaExec) {
    return { kind: "host", id: backend.id, host: backend.host };
  }
  return { kind: "vendor", id: backend.id, display: backend.display };
}

/**
 * The words the line starts with. One copy, so a test can find the line and a
 * reader can find every occurrence.
 */
export const EGRESS_NOTICE_PREFIX = "leaving this machine:";

/**
 * One line: who is about to receive this prompt, and that it cannot be undone.
 *
 * Deliberately short. It prints on every off-machine dispatch and can never be
 * switched off, so the whole cost of that decision is paid in this sentence —
 * and a paragraph repeated on a hot path is a paragraph nobody finishes.
 *
 * Deliberately without comfort. Nothing here says the send is safe, expected,
 * or normal; those are judgements about somebody else's risk, and the only
 * thing Mind knows is where the text is going and that it is not coming back.
 */
export function egressLine(target: EgressTarget): string {
  if (target.kind === "vendor") {
    return (
      `${EGRESS_NOTICE_PREFIX} this prompt goes to ${target.id} (${target.display}) now, ` +
      `and Mind cannot take it back.`
    );
  }
  return (
    `${EGRESS_NOTICE_PREFIX} this prompt goes to ${target.id} at ${target.host} now, ` +
    `and Mind cannot take it back — nor say what that host keeps.`
  );
}

/** Module-private, so the brand cannot be written by hand from outside. */
declare const ANNOUNCED: unique symbol;

/** Proof that the egress line was written. Mint via {@link announceEgress}. */
export type EgressNotice = { readonly [ANNOUNCED]: "egress-announced" };

/**
 * Write the line, and hand back the proof that it was written.
 *
 * @param write Where the line goes — `console.error`, a log file, a test's
 *   array. Mind does not choose the channel, only that there was one.
 */
export function announceEgress(write: (line: string) => void, target: EgressTarget): EgressNotice {
  write(egressLine(target));
  // An empty frozen object, branded on the way out: `ANNOUNCED` is a `declare
  // const` and does not exist at run time. The value carries nothing, and the
  // guarantee is that `tsc` will not let one be produced anywhere else.
  return Object.freeze({}) as EgressNotice;
}

/**
 * Hand one turn to a backend that is not on this machine.
 *
 * Takes an {@link EgressNotice}, which is the whole of AC4 at this address: a
 * prompt cannot leave by this door unless the line was written first, and that
 * is a compile error rather than a convention the next caller must remember.
 */
export function dispatchAnnounced(
  notice: EgressNotice,
  backend: ExecBackend,
  request: TurnRequest,
): Promise<TurnResult> {
  // Required at the type level and deliberately unused at run time: the value
  // carries no information beyond "announceEgress produced me", and reading a
  // field off it would invite somebody to fabricate the field instead.
  void notice;
  return backend.run(request);
}

/** What {@link AnnouncedExec} needs that it cannot work out from `inner`. */
export interface EgressOptions {
  /**
   * The backend as it really is, before any wrapper copied its id.
   *
   * Separate from `inner` on purpose: `inner` is what actually runs the turn
   * (a `RecordingExec`, in `turn`'s case), and asking a wrapper where a turn
   * goes gets the wrapper's answer, not the backend's.
   */
  readonly origin: ExecBackend;
  /** Where the line goes. Stderr in the CLI, so `--json` stdout stays parseable. */
  readonly write: (line: string) => void;
  /**
   * S8.3 (D-048) — asked of every prompt that would leave this machine, before
   * the line above is written. A non-empty answer keeps the prompt in: this
   * backend is not handed it, and the chain falls through to the next — which,
   * for personal data, is how it reaches the local model I-6 allows.
   */
  readonly screen?: (request: TurnRequest) => readonly EgressFinding[];
  /**
   * S8.3's second layer (D-061): asked only when `screen` found nothing — a
   * model on this machine judging meaning the text filter cannot see. Its
   * findings keep the prompt in exactly as the filter's do.
   */
  readonly judge?: (request: TurnRequest) => Promise<readonly EgressFinding[]>;
  /**
   * D-181 — the line written before the egress line, for every prompt that is handed over **without** `judge` having
   * read it: the filter alone screened it, and a person is told so each time. Ignored when `judge` is given. There is
   * no way to have it written once and then not again; see `src/egress/judge-mode.ts`.
   */
  readonly unjudged?: string;
  /** Told of every prompt kept in, so it can be recorded (AC4). */
  readonly onBlocked?: (backend: string, findings: readonly EgressFinding[]) => void;
}

/**
 * One backend, plus a line before every prompt it is really handed.
 *
 * Announces nothing when the turn stays on this machine, and nothing at all
 * until a prompt is actually dispatched: `available()` is a readiness probe
 * that sends no text, and a backend the chain skipped was told nothing.
 */
export class AnnouncedExec implements ExecBackend {
  constructor(
    private readonly inner: ExecBackend,
    private readonly options: EgressOptions,
  ) {}

  // Every identifying property is the wrapped backend's, so a fallback trail
  // reads `claude: unavailable (…)` and not `announced(claude): …`. Announcing
  // is not a backend an operator chose and should not appear as one.
  get id(): string {
    return this.inner.id;
  }
  get display(): string {
    return this.inner.display;
  }
  get kind(): BackendKind {
    return this.inner.kind;
  }
  get identityStrength(): IdentityStrength {
    return this.inner.identityStrength;
  }

  /** Delegated, and never announced: a readiness probe hands over no prompt. */
  available(): Promise<Availability> {
    return this.inner.available();
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    const target = egressTarget(this.options.origin, request);
    if (target === undefined) return this.inner.run(request);
    let findings = this.options.screen?.(request) ?? [];
    if (findings.length === 0 && this.options.judge !== undefined) findings = await this.options.judge(request);
    if (findings.length > 0) {
      this.options.onBlocked?.(this.inner.id, findings);
      const reason =
        `kept on this machine — the prompt carries personal data (${describeFindings(findings)}), ` +
        `and it does not leave without a person removing it (I-6, D-048)`;
      this.options.write(`mind: not sent to ${target.id}: ${reason}`);
      return {
        backend: this.inner.id,
        text: "",
        confidence: "failed",
        evidence: { source: this.inner.id, prompt: "", raw: reason },
        identityStrength: "none",
      };
    }
    if (this.options.judge === undefined && this.options.unjudged !== undefined) this.options.write(this.options.unjudged);
    return dispatchAnnounced(announceEgress(this.options.write, target), this.inner, request);
  }
}

/**
 * The chain `turn` runs, and the only sanctioned way to build one.
 *
 * It takes {@link AnnouncedExec} members and nothing else, so a chain whose
 * members could send a prompt without announcing it is a `tsc` error rather
 * than something a reviewer has to notice. `test/exec/egress.test.ts` keeps the
 * unsanctioned door shut too: `new FallbackExec(` appears in no file under
 * `src/` or `bin/` but this one.
 */
export function turnChain(members: readonly AnnouncedExec[]): FallbackExec {
  return new FallbackExec(members);
}

/**
 * What the line above does not do — printed by `mind backends`, never only
 * written down here.
 *
 * Each entry is something a reader could reasonably take "Mind tells me
 * before a prompt leaves" to include, and which this code does not deliver.
 */
export const EGRESS_LIMITS: readonly string[] = [
  VENDORS_HOLD,
  "it proves a write, not a reading. `announceEgress` witnesses that the line was handed to a " +
    "writer before the prompt was handed to the backend. Nothing in a type system can witness " +
    "that a person read it, and a turn run from a script writes it to a stderr nobody opened.",
  "it cannot be switched off, and that is the whole design: no flag, no environment variable and " +
    "no config key silences it, because an agent running as the owner could pass any of those in " +
    "the owner's name.",
  "silence is not proof of privacy. No line is printed when the backend is an ollama on a " +
    "loopback literal — see LOCAL_LIMITS in src/exec/local.ts for how little that proves: the " +
    "port can be a tunnel, and a model whose name ends `-cloud` is relayed by the daemon.",
  "`--private` withholds the prompt from Mind's own ledger, not from the backend. The vendor " +
    "still receives every character of it.",
  "it announces, it does not ask. The notice does not stop the send, waits for no answer, and is " +
    "not the per-use human approval I-6 is about.",
];
