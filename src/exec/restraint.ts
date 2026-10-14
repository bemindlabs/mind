/**
 * Proof that the dial was consulted before a turn was composed — checked by
 * `tsc`, not by a reviewer.
 *
 * ## Why a brand and not a number
 *
 * {@link import("../decide/autonomy.ts")} explains the thing everybody gets
 * backwards: today, every vendor's read-only flag goes onto every turn
 * unconditionally, so the dial is what **removes** it. That makes "did anything
 * ask the dial?" the question worth being unable to skip. A plain
 * `level: number` on `TurnRequest` would have been skippable in the ordinary
 * way — somebody passes `3` from a config, or `2` from a test, or leaves the
 * field out and a default fills it in, and the loosening happens with nothing in
 * review to catch the eye.
 *
 * So a {@link Restraint} can only be made by {@link restrain}, which takes an
 * {@link EffectiveDial} — and an `EffectiveDial` can only be made by
 * {@link effectiveDial}, which is where the minimum, the environment ceiling and
 * the stop flag are applied. The chain is: file → ceilings → minimum → brand →
 * argv. There is no shortcut into the middle of it that type-checks.
 *
 * Same shape, and for the same reason, as `CaptureNotice`
 * (`src/observer/store.ts`) and `EgressNotice` (`src/exec/egress.ts`): one
 * constructor, plus an AST gate (`test/decide/restraint.test.ts`) that refuses
 * `as Restraint` anywhere but here, because a cast would switch the whole
 * mechanism off in one keystroke.
 *
 * ## The vendor with no mechanism is refused, not run hopefully
 *
 * A vendor may declare `readOnly.kind: "none"` with `evidence: "writes"` —
 * measured, a headless turn told to write a file wrote it. kimi did until
 * S12.6 found it a profile file (D-120); none does today. Before this file, a
 * turn on such a vendor at any level ran exactly the same way: there was no flag
 * to add and nothing said so out loud. That is the dial lying by omission — the
 * owner sets a level, and one path through the program ignores it silently.
 *
 * {@link restraintRefusal} closes it: at an acting level of 1, a vendor with no
 * mechanism is **refused**, and the refusal quotes `readOnly.why` word for word
 * rather than paraphrasing it, so there is one sentence about that hole in this
 * program and not two that can drift apart.
 *
 * At level 0 every vendor is refused, which is what level 0 means.
 */

import { defaultEffective, type EffectiveDial } from "../decide/effective.ts";
import type { Level } from "../decide/autonomy.ts";
import type { ReadOnlySpec, VendorSpec } from "./registry.ts";

/**
 * The brand. `declare const`, so it does not exist at run time and the value
 * carries nothing an impostor could fabricate a field for.
 */
declare const RESTRAINED: unique symbol;

/**
 * Proof that {@link import("../decide/effective.ts").effectiveDial} decided this
 * turn's level. Mint via {@link restrain} and nowhere else.
 */
export interface Restraint {
  readonly [RESTRAINED]: "autonomy-dial-consulted";
  /** `min(write, run, reach)` after every ceiling. See `actLevel`. */
  readonly act: Level;
  /**
   * True when the read-only flag comes **off** for this turn.
   *
   * Named for what it does rather than for the level that causes it, because
   * the sentence a person needs is "the restraint was removed", not "the number
   * was 2".
   */
  readonly loosened: boolean;
  /**
   * Level 3 in force for the local side: write and run are both 3 (each
   * confirmed at a terminal, D-042) and the turn acts at 2 because reach may
   * never pass 2 (I-6). `act` cannot say this — `min(write, run, reach)` is at
   * most 2 by construction — so it is its own field rather than a number the
   * minimum would have to be broken to produce (D-047).
   */
  readonly unfenced: boolean;
  /**
   * The browser's level for this turn (D-153): `min(operate, reach)`, 3 only when operate is a confirmed 3.
   * 0 = no browser, 1 = look and propose, 2 = act on the task's allowed sites, 3 = act on any site. A turn
   * handed a browser gets its tools from this number (`src/browser/mcp-config.ts`), never from `act`.
   */
  readonly operate: Level;
}

/**
 * Mint a restraint from a decided dial.
 *
 * The only constructor. It takes the whole {@link EffectiveDial} rather than
 * its `act` field so that the argument cannot be produced by arithmetic at the
 * call site: to get one of these you must have gone through the file, the
 * ceiling, the brake and the minimum, in that order.
 */
export function restrain(effective: EffectiveDial): Restraint {
  // Frozen and branded on the way out, exactly as `announceCapture` does it.
  return Object.freeze({
    act: effective.act,
    loosened: effective.act >= 2,
    unfenced: effective.act >= 2 && effective.dial.write === 3 && effective.dial.run === 3,
    operate: effective.operate,
  }) as Restraint;
}

/**
 * What a turn on a backend that is not kernel-fenced is held to, until a fence for cloud vendors exists
 * (D-163, Q4-D2 option A, owner's choice 2026-10-06). Write and run are held at 1: propose only.
 */
export const UNFENCED_CAP_LEVEL: Level = 1;

/**
 * Hold a restraint at {@link UNFENCED_CAP_LEVEL} for write and run — **a reduction and nothing else**.
 *
 * A restraint that is not loosened is returned as it came (same object): at act 1 or 0 the vendor's read-only
 * flag is already on and there is nothing to lower, so this can never raise a level. A loosened one comes back
 * with `act` 1, `loosened` false, `unfenced` false — which is exactly what write=1, run=1 produces — so every
 * consumer (the read-only flag, the tool grant, the local fence's writable set) reads the lowered turn the way
 * it reads any level-1 turn. `operate` is the browser's and is not touched. The only other way to make a
 * Restraint is {@link restrain}; this is the second place `as Restraint` may stand, and it lowers.
 */
export function capRestraint(restraint: Restraint): Restraint {
  if (!restraint.loosened) return restraint;
  return Object.freeze({
    act: Math.min(restraint.act, UNFENCED_CAP_LEVEL) as Level,
    loosened: false,
    unfenced: false,
    operate: restraint.operate,
  }) as Restraint;
}

/**
 * The restraint a **measurement** runs under, which the dial may not raise.
 *
 * `soul verify` spends real turns asking a backend questions only one soul can
 * answer. Its whole value is that the answers came from an identity rather than
 * from a file the turn read or wrote on the way past, and an instrument whose
 * permissions follow a setting is an instrument whose readings follow a setting
 * too. So this is pinned at the dial's default level — read-only everywhere a
 * vendor offers it, and a refusal at any vendor that offers nothing — no
 * matter what `autonomy.md` says.
 *
 * It is deliberately the only function besides {@link restrain} that produces
 * one of these, and it is deliberately *stricter* than the dial rather than
 * looser: a second constructor that could loosen would be the bypass this whole
 * file exists to prevent. This one cannot express a loosened restraint at all.
 */
export function probeRestraint(): Restraint {
  return restrain(defaultEffective());
}

/**
 * Why this vendor may not be run at this level, or `undefined` when it may.
 *
 * Pure and exported, so the policy can be argued with directly instead of
 * through a subprocess — the same reason `refusal()` in `src/spawn.ts` is.
 */
export function restraintRefusal(spec: VendorSpec, restraint: Restraint): string | undefined {
  if (restraint.act === 0) {
    return (
      "the autonomy dial is at 0 for this turn, which means do not run it. Nothing was sent. " +
      "Raise a level with `mind autonomy set`, or clear the stop flag with " +
      "`mind autonomy resume` if that is what put it here."
    );
  }

  const mechanism: ReadOnlySpec = spec.readOnly;
  if (restraint.act === 1 && mechanism.kind === "none") {
    return (
      `${spec.id} has no read-only mechanism, and the dial is at 1, which asks for one. ` +
      `Refused rather than run: a turn that quietly ignores the level it was given is the ` +
      `failure this dial exists to make impossible. What was measured: ${mechanism.why} ` +
      `To run it anyway, raise write, run and reach to 2 together — which says out loud that ` +
      `this turn may write.`
    );
  }

  return undefined;
}

/**
 * The line a turn prints when the flag came off, naming what took it off.
 *
 * Computed from the dial rather than written twice: a reader is entitled to know
 * which categories were high enough, because the minimum means it took all
 * three.
 */
export function loosenedNote(effective: EffectiveDial): string | undefined {
  if (effective.act < 2) return undefined;
  return (
    `the vendor's read-only flag was NOT sent: write=${effective.dial.write}, ` +
    `run=${effective.dial.run}, reach=${effective.dial.reach}, so the turn runs at ` +
    `${effective.act}. This turn may write files and run commands.`
  );
}
