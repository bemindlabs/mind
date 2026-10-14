/**
 * The hand that keeps working when the first one is gone.
 *
 * A fallback belongs in the engine rather than in a shell wrapper for one
 * reason: the decision it has to make is *what counts as a failure worth
 * retrying*, and that judgement is the same judgement `verify` makes. A CLI
 * that exits 0 with nothing to show is the case a shell `||` cannot see, and
 * it is exactly the case a fallback must catch.
 *
 * This is also the file S2.1 AC6 rests on — take `claude` and `codex` off
 * PATH and the turn still has to finish on a local model alone (I-1). It
 * lives on its own rather than inside the barrel so the coverage gate can see
 * it: ninety lines of decision-making hidden behind an exemption that said
 * "re-export barrel" was untrue, and untested.
 */

import type { Availability, ExecBackend, IdentityStrength, TurnRequest, TurnResult } from "./backend.ts";

/**
 * Try backends in order until one actually answers.
 *
 * "Actually answers" is the whole point. A `silent` result — exit 0 and an
 * empty reply, a timeout, a spawn that never happened — is treated as a miss
 * and the next backend is tried, because the work did not get done and
 * nothing said so. A `failed` result is also a miss: the backend ran and
 * could not do it.
 *
 * What is *not* a miss is a real answer Mind happens to dislike. This class
 * never judges content; it only distinguishes "something came back" from
 * "nothing did".
 */
export class FallbackExec implements ExecBackend {
  readonly kind = "cli" as const;

  /**
   * @param chain Backends in preference order. Must not be empty.
   * @param id Reported id; defaults to naming the chain, so evidence says
   *   which route was configured, not just which one answered.
   */
  constructor(
    private readonly chain: readonly ExecBackend[],
    readonly id: string = chain.map((b) => b.id).join("→"),
  ) {
    if (chain.length === 0) throw new Error("FallbackExec needs at least one backend");
  }

  get display(): string {
    return this.chain.map((b) => b.display).join(" → ");
  }

  /** The strongest identity channel any member of the chain offers. */
  get identityStrength(): IdentityStrength {
    const order: IdentityStrength[] = ["none", "user", "system"];
    return this.chain.reduce<IdentityStrength>(
      (best, b) => (order.indexOf(b.identityStrength) > order.indexOf(best) ? b.identityStrength : best),
      "none",
    );
  }

  /** Available when any member is. Reports each member's state either way. */
  async available(): Promise<Availability> {
    const checks = await Promise.all(
      this.chain.map(async (b) => ({ id: b.id, result: await b.available() })),
    );
    const usable = checks.filter((c) => c.result.ok);
    const detail = checks.map((c) => `${c.id}: ${c.result.detail}`).join(" · ");
    return { ok: usable.length > 0, detail };
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    // D-142. One request goes to every step, so a model on it would reach every backend in the chain — a
    // local model's name handed to a vendor CLI, and a line priced as a model the step never ran. A step's
    // model is bound to that step when it is built; a chain refuses to carry one, before anything is sent.
    if (request.model !== undefined) {
      return {
        backend: this.id,
        text: "",
        confidence: "silent",
        identityStrength: "none",
        evidence: {
          source: this.id,
          prompt: request.prompt,
          raw:
            `[fallback] refused: the request names the model ${JSON.stringify(request.model)}, which would reach ` +
            `all ${this.chain.length} backend(s) — build each one with its own model instead`,
        },
      };
    }
    const attempts: string[] = [];
    let last: TurnResult | undefined;

    for (const candidate of this.chain) {
      const ready = await candidate.available();
      if (!ready.ok) {
        attempts.push(`${candidate.id}: unavailable (${ready.detail})`);
        continue;
      }

      const result = await candidate.run(request);
      if (result.confidence === "confirmed" || result.confidence === "partial") {
        return {
          ...result,
          // Keep the misses in the evidence. A chain that silently succeeds on
          // its third try looks identical to one that succeeded on its first,
          // and the difference is the thing worth knowing.
          evidence: {
            ...result.evidence,
            raw:
              attempts.length === 0
                ? result.evidence.raw
                : `[fallback] ${attempts.join(" · ")}\n---\n${result.evidence.raw}`,
          },
        };
      }

      attempts.push(`${candidate.id}: ${result.confidence}`);
      last = result;
    }

    // Everything missed. Report the last real attempt so the caller sees a
    // concrete failure, with the full trail attached.
    const trail = `[fallback] all ${this.chain.length} backend(s) missed · ${attempts.join(" · ")}`;
    if (last === undefined) {
      return {
        backend: this.id,
        text: "",
        confidence: "silent",
        identityStrength: "none",
        evidence: { source: this.id, prompt: request.prompt, raw: trail },
      };
    }
    return {
      ...last,
      backend: this.id,
      evidence: { ...last.evidence, raw: `${trail}\n---\n${last.evidence.raw}` },
    };
  }
}

/**
 * Pull the miss trail back out of a result's evidence.
 *
 * {@link FallbackExec} records the backends that missed inside `evidence.raw`
 * rather than in a field of its own, because `TurnResult` is the shape every
 * backend returns and a fallback-only field would be absent everywhere else.
 * A caller that wants to *show* the route — which is the whole point of
 * printing one — needs it back, and reading it here beats every call site
 * inventing its own parse.
 *
 * @returns The trail, or undefined when nothing missed.
 */
export function fallbackTrail(raw: string): string | undefined {
  const match = raw.match(/^\[fallback\] ([^\n]*)(?:\n---\n[\s\S]*)?$/);
  return match?.[1];
}
