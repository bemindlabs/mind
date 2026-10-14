/**
 * The one door data flagged `personal` may leave by, and how wide it really is.
 *
 * S3.5 AC4 as written says *data flagged `personal` must never leave this
 * machine — only a local model may be chosen*. The second half is the half
 * that can be built. The first is a claim about a machine, and this file is
 * code on that machine; the honest version of the criterion, and the one the
 * engine and the docs now state, is:
 *
 * > a `Personal<T>` reaches a backend through exactly one function,
 * > {@link runPersonal}, which only accepts a backend {@link asLocal} minted.
 * > That is an ollama talking to a loopback **literal**, or one of S12.1's
 * > local CLI variants on a turn whose endpoint, fence and kernel support were
 * > checked together.
 *
 * ## Why a type alone could never have done it
 *
 * `BackendKind` defines `"http"` as *"an HTTP endpoint on this machine **or a
 * reachable host**"*, and `OllamaExec` takes its host from `OLLAMA_HOST`
 * without checking it. So "ollama is the local backend" is a sentence that can
 * be false at run time, on a machine nobody has misconfigured on purpose —
 * `OLLAMA_HOST=http://gpu-box.internal:11434` is a normal thing to export.
 *
 * Locality is therefore a run-time fact, and a type can only ever hold
 * *evidence that it was checked*. That is exactly the pattern `SubjectId`
 * already uses: one constructor, one validation, a brand that means "this went
 * through it". {@link LocalBackend} is the same shape, and {@link asLocal} is
 * the only constructor.
 *
 * ## What `asLocal` accepts, and why each refusal
 *
 * - **A concrete implementation, by `instanceof`** — never by an id a wrapper
 *   can copy. `OllamaExec` is checked directly. A `LocalCliExec` also needs
 *   the request it is about to run, because its fence is a per-turn fact.
 * - **A loopback literal host** — `127.0.0.0/8` or `[::1]`. `localhost` is
 *   refused: it is a *name*, and a name is resolved by whatever `/etc/hosts`,
 *   NSS and the resolver say at the moment of the call.
 * - **A local CLI passes three checks at that moment** — its base URL is a
 *   loopback literal, the request fence allows only that URL's TCP port, and
 *   this kernel reports the Landlock and seccomp support needed to enforce the
 *   address/transport fence. D-123 opened this door in S12.7.
 * - **Everything else refused outright** — an ordinary `CliExec` reaches a
 *   cloud; a `FallbackExec` may end anywhere; a wrapper can copy an id.
 *
 * ## What this does not prove — stated here, in {@link LOCAL_LIMITS}, and
 * printed by `observe status`
 *
 * **Loopback is not the same thing as local.** `127.0.0.1:11434` can be an ssh
 * tunnel, a socat forward or a proxy, and Mind cannot tell one from an
 * ollama. **An ollama can relay for you**: models whose names end `-cloud` are
 * served by the daemon forwarding the turn to a hosted endpoint, and from
 * inside this process that turn is indistinguishable from a local one.
 *
 * Mind does **not** try to detect that, and the reason is a measurement
 * rather than an oversight. On 2026-09-21 the owner checked this machine's
 * ollama: it holds no `*-cloud` model at all, and `/api/show` for the local
 * models returns no field naming a remote or a host. A check written against
 * that shape could not have been fired once, and a guard that has never been
 * fired is a guard nobody knows the state of — which is the failure this whole
 * story is about. So the risk is declared and left visible instead.
 */

import { notLoopbackLiteral } from "../loopback.ts";
import type { Personal } from "../types.ts";
import { flagPersonal, unwrapPersonal } from "../types.ts";
import type { ExecBackend, TurnRequest, TurnResult } from "./backend.ts";
import { fenceSupport } from "./fence.ts";
import { LocalCliExec } from "./local-cli.ts";
import { OllamaExec } from "./ollama-exec.ts";

/** Re-exported: callers that already import it from here keep working. */
export { notLoopbackLiteral };

/** Module-private, so the brand cannot be written by hand from outside. */
declare const VERIFIED_LOCAL: unique symbol;

/**
 * A backend checked through {@link asLocal}. Local CLI turns are checked again
 * by {@link runPersonal}, because their locality includes the request's fence.
 */
export type LocalBackend = ExecBackend & { readonly [VERIFIED_LOCAL]: "loopback-literal" };

/** One turn whose prompt is the owner's. The only shape {@link runPersonal} takes. */
export interface PersonalTurnRequest extends Omit<TurnRequest, "prompt"> {
  /** Boxed on purpose: `TurnRequest.prompt` is a `string` and this is not one. */
  readonly prompt: Personal<string>;
}


/** D-123: S12.7's address and transport fence opened held pieces to local CLIs. */
export const LOCAL_CLI_SEES_PERSONAL: boolean = true;

/** Why this backend is not usable for personal data, or `undefined` when it is. */
export function notLocal(backend: ExecBackend, request?: TurnRequest): string | undefined {
  if (backend instanceof OllamaExec) return notLoopbackLiteral(backend.host);
  if (backend instanceof LocalCliExec) return notLocalCli(backend, request);

  return (
    `${backend.id} is not an OllamaExec or LocalCliExec. Checked by instanceof rather than by ` +
    `id, because a wrapper can copy an id — RecordingExec forwards the one it wraps — and a ` +
    `copied id is not evidence of anything about where a turn goes.`
  );
}

/**
 * The three checks a local CLI must pass at request time: the base URL is a
 * loopback literal, this turn's fence allows only that URL's port, and the
 * kernel can enforce the complete Landlock + seccomp fence.
 */
export function notLocalCli(backend: LocalCliExec, request?: TurnRequest): string | undefined {
  {
    const address = notLoopbackLiteral(backend.baseUrl);
    if (address !== undefined) return `${backend.id} is not local: ${address}`;
    if (
      request?.fence === undefined ||
      request.fence.tcpPorts.length !== 1 ||
      request.fence.tcpPorts[0] !== backend.port
    ) {
      return (
        `${backend.id} is local only for a turn whose fence allows TCP port ${backend.port} ` +
        `and no other port.`
      );
    }
    const support = fenceSupport();
    if (!support.ok) return `${backend.id} is not local on this kernel: ${support.reason}`;
    return undefined;
  }
}

/**
 * Mint a {@link LocalBackend}, or `undefined` with the reason on the side.
 *
 * Returns the same object it was handed, re-typed. There is nothing to wrap:
 * the value of this function is that it is the only place the check happens,
 * not that it builds something new.
 */
export function asLocal(backend: ExecBackend, request?: TurnRequest): LocalBackend | undefined {
  return notLocal(backend, request) === undefined ? (backend as LocalBackend) : undefined;
}

/**
 * Run one turn with the owner's own data in it.
 *
 * The reply is boxed too. A model asked about personal data answers *from* it,
 * and treating the answer as ordinary text would be a way to launder the
 * prompt in one hop — which is the shape most leaks actually take.
 */
export async function runPersonal(
  local: LocalBackend,
  request: PersonalTurnRequest,
): Promise<Personal<TurnResult>> {
  const plain = { ...request, prompt: unwrapPersonal(request.prompt) };
  const refusal = notLocal(local, plain);
  if (refusal !== undefined) throw new Error(`personal turn refused: ${refusal}`);
  const result = await local.run(plain);
  return flagPersonal(result);
}

/**
 * What the door above does not close — printed by `observe status`, never only
 * written down here.
 *
 * Each line is something a reader could reasonably take "personal data cannot
 * leave this machine" to include, and which this code does not deliver.
 */
export const LOCAL_LIMITS: readonly string[] = [
  "loopback is not the same as local. 127.0.0.1:11434 can be an ssh tunnel, a socat forward or " +
    "a proxy, and nothing in this process can tell one of those from an ollama.",
  "an ollama can relay. A model whose name ends `-cloud` is served by the local daemon " +
    "forwarding the turn to a hosted endpoint, and that turn looks local from here. Mind does " +
    "not check for it: measured on this machine 2026-09-21, no such model was installed and " +
    "/api/show returned no field naming a remote or a host — so a check written against that " +
    "shape could never have been fired, and an unfired guard is one nobody knows the state of.",
  "the flag stops at the door. Once `unwrapPersonal` has produced a string, it is a string: no " +
    "JavaScript type system follows it into a log line, a template or a JSON.stringify.",
  "a process running as this user can read the files directly. A vendor CLI Mind spawns for an ordinary " +
    "(cloud) turn has its own tools and the same uid: mode 0600 is not a boundary against it, and a read-only " +
    "turn on a vendor that keeps its read tools can open any file you can and send it to that vendor — the I-6 " +
    "screen sees only the prompt Mind sends, never what such a tool reads. A local CLI (claude-local, " +
    "grok-local) is fenced for reads as well as writes: the kernel refuses every read outside the system " +
    "directories, what the turn may write, its working directory, the vendor program and the engine's own " +
    "executable, so your home, ~/.secrets, ~/.ssh and other subjects' data are refused to it, and so is the " +
    "environment of every process outside the fence. What it still reads is everything in its working " +
    "directory, the command line of every process, and all of /proc, /sys and /etc. Programs installed under " +
    "your home (nvm, bun, cargo, pyenv) are not readable to it either, and their PATH entries are left out so " +
    "that they do not hide the system's: a tool that exists only there is `command not found` to it. A working " +
    "directory that holds the vendor's home is not readable at all.",
  "LiteLLM is trusted beyond what `mind doctor` can see. A local CLI (claude-local, grok-local) " +
    "is admitted because its fence lets it reach only 127.0.0.1 on LiteLLM's port — but LiteLLM is a " +
    "proxy. `doctor` asks it, with the virtual key, where each `local-coder` route goes and fails when " +
    "one leaves this machine; that model's fallbacks sit in router settings the key cannot read " +
    "(checked by hand on 2026-09-27: vLLM and ollama on this machine only), and a route changed after " +
    "the last `doctor` run is not noticed until the next one. A turn does not ask.",
];
