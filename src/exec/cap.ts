/**
 * Q4-D2, option A (D-163, the owner's choice on 2026-10-06): **a turn on a backend that is not kernel-fenced
 * does not run with write or run at 2 or above.** Its write and run are held at 1 — propose only — until a
 * proper fence for cloud vendors exists. This file is a policy layer; the fence itself is `fence.ts`.
 *
 * Why: the owner's uid is in the `docker` group, which is root-equivalent. A loosened turn with no kernel
 * fence can reach `/var/run/docker.sock`, the systemd user bus and tailscaled. Only a turn inside the D-118
 * fence (claude-local, grok-local) cannot.
 *
 * ## The choke point
 *
 * Every entry — the CLI turn, the web `/api/turn`, a task's steps, chat, triggers, an approved proposal —
 * starts `mind turn` as a process, and `bin/commands/turn.ts` is the only place a loosened `Restraint` is
 * made and the only place a chain is built from it. It wraps each backend it builds in {@link CappedExec}, so
 * the cap is applied once, per backend, immediately before the request reaches that backend's own `run`. No
 * caller keeps a copy of the rule, and a backend added later is wrapped by the same line.
 *
 * ## What counts as fenced
 *
 * Not a list of names. {@link ExecBackend.appliesFence} is asked of the backend itself, about this very
 * request: `CliExec` answers true only when the request carries the fence it will hand the kernel;
 * `LocalCliExec` answers from its real `prepare()`. A backend that does not implement it is not fenced
 * (fail closed), so a new backend is capped by default.
 */

import type { Availability, ExecBackend, IdentityStrength, TurnRequest, TurnResult } from "./backend.ts";
import { capRestraint, UNFENCED_CAP_LEVEL } from "./restraint.ts";

/** Whether this backend, asked about this request, runs it behind the kernel fence. Absent means no. */
export function runsFenced(backend: ExecBackend, request: TurnRequest): boolean {
  return backend.appliesFence?.(request) === true;
}

/** The sentence a capped turn carries: what was held, and why — in the style of the other restraint lines. */
export function capNote(backendId: string, request: TurnRequest): string {
  const { act } = request.restraint;
  return (
    `${backendId} is not kernel-fenced, so this turn was held at write ${UNFENCED_CAP_LEVEL} and run ` +
    `${UNFENCED_CAP_LEVEL} (propose only) although the dial allows ${act}. The vendor's read-only flag stays ` +
    `ON. Why: an unfenced turn running as you can reach the docker socket, the systemd user bus and ` +
    `tailscaled, which is root on this machine (D-163). A turn on a fenced local backend (claude-local) ` +
    `keeps the dial. This is a temporary cap until a fence for cloud vendors exists.`
  );
}

/**
 * The request as this backend may run it: the same request, or — when the dial would loosen it and the
 * backend is not fenced — the same request with its restraint lowered. Never raises anything.
 */
export function capRequest(
  backend: ExecBackend,
  request: TurnRequest,
): { readonly request: TurnRequest; readonly note?: string } {
  if (!request.restraint.loosened || runsFenced(backend, request)) return { request };
  return { request: { ...request, restraint: capRestraint(request.restraint) }, note: capNote(backend.id, request) };
}

/** Wraps one backend so that every request it receives is capped as above. */
export class CappedExec implements ExecBackend {
  constructor(
    private readonly inner: ExecBackend,
    private readonly say: (line: string) => void = () => undefined,
    /**
     * What the turn's system prompt carries at level 1 and the loosened one did not (the propose instruction):
     * a turn that was held at 1 is told so, or it would believe it can act and write "done" for nothing.
     */
    private readonly heldAtOne?: string,
    /**
     * A backend with no tools at all (ollama, D-149) is capped like any other but has nothing to say about it:
     * it can answer and never act, so "held at 1" would be a line about a thing that was never possible.
     */
    private readonly toolless: boolean = false,
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get display(): string {
    return this.inner.display;
  }
  get kind(): ExecBackend["kind"] {
    return this.inner.kind;
  }
  get identityStrength(): IdentityStrength {
    return this.inner.identityStrength;
  }

  appliesFence(request: TurnRequest): boolean {
    return runsFenced(this.inner, request);
  }

  available(): Promise<Availability> {
    return this.inner.available();
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    const capped = capRequest(this.inner, request);
    if (capped.note === undefined) return this.inner.run(request);
    if (this.toolless) return this.inner.run(capped.request);
    this.say(capped.note);
    const told =
      this.heldAtOne === undefined || (capped.request.system ?? "").includes(this.heldAtOne)
        ? capped.request
        : { ...capped.request, system: [capped.request.system ?? "", this.heldAtOne].filter((part) => part !== "").join("\n\n") };
    const result = await this.inner.run(told);
    return { ...result, capped: capped.note };
  }
}

/**
 * Which of these backends would be held at write/run 1 under `restraint`, and which keep the dial — asked the
 * same way a turn asks (`capRequest`), so `mind doctor` cannot say something a turn would not do.
 * Both lists are empty when the dial is not loosened: nothing is capped at 1.
 */
export function capSurvey(
  ids: readonly string[],
  restraint: TurnRequest["restraint"],
  build: (id: string) => ExecBackend,
  subject: TurnRequest["subject"],
): { readonly capped: readonly string[]; readonly fenced: readonly string[] } {
  if (!restraint.loosened) return { capped: [], fenced: [] };
  const capped: string[] = [];
  const fenced: string[] = [];
  for (const id of ids) {
    const asked = capRequest(build(id), { subject, prompt: "", restraint });
    (asked.note === undefined ? fenced : capped).push(id);
  }
  return { capped, fenced };
}

/** The one line `mind doctor` prints about it, or `undefined` when nothing is capped (dial at 1 or below). */
export function capLine(survey: { readonly capped: readonly string[]; readonly fenced: readonly string[] }): string | undefined {
  if (survey.capped.length === 0 && survey.fenced.length === 0) return undefined;
  return (
    `capped at write/run 1 (not kernel-fenced, D-163): ${survey.capped.join(", ") || "none"} · ` +
    `keep the dial (fenced): ${survey.fenced.join(", ") || "none"}`
  );
}

/**
 * What a task's step is told when it was held at level 1 (D-163). A step reports in its own task
 * block (`TASK_BLOCK`), not as proposals, so the instruction is its own: say what could not be done, never "done".
 */
export const HELD_AT_ONE_TASK = [
  "## Acting level: 1 — read only for this step (Mind)",
  "",
  "This step cannot change anything: no file is written, no command with side effects runs, nothing outside " +
    "is contacted. Do not say or imply that you did any of those. Read and answer what you can; in the " +
    "`summary` of your block say plainly what you could NOT do and what it would take, and set " +
    '"done": false for anything that needed writing or running.',
].join("\n");
