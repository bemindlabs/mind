/**
 * Assembling hands out of the pieces.
 *
 * Two factories and the re-exports, nothing else. The fallback chain used to
 * live here and no longer does: ninety lines of decision-making sat behind a
 * coverage exemption that called this file a re-export barrel, which it was
 * not. It is in `fallback.ts` now, where the gate can see it.
 */

import type { ExecBackend } from "./backend.ts";
import { CliExec } from "./cli-exec.ts";
import { OllamaExec } from "./ollama-exec.ts";
import { LOCAL_BACKENDS, isLocalCliId, localCliBackend } from "./local-cli.ts";
import { modelRefusal } from "./model.ts";
import { VENDORS, vendor } from "./registry.ts";

export * from "./backend.ts";
export * from "./registry.ts";
export {
  loosenedNote,
  probeRestraint,
  restrain,
  restraintRefusal,
  type Restraint,
} from "./restraint.ts";
export { CliExec, extractReply } from "./cli-exec.ts";
export { OllamaExec } from "./ollama-exec.ts";
export {
  LOCAL_BACKENDS,
  LITELLM_BASE_URL,
  LITELLM_KEY_FILE_ENV,
  LITELLM_PORT,
  LOCAL_MODEL,
  LocalCliExec,
  isLocalCliId,
  liteLLMKeyFile,
  localCliBackend,
  parseLiteLLMKey,
  type LocalCliContext,
  type LocalCliId,
} from "./local-cli.ts";
export { FallbackExec, fallbackTrail } from "./fallback.ts";
export { modelRefusal, routeModels, takesNoModel, type ModelRoute } from "./model.ts";
export {
  AnnouncedExec,
  announceEgress,
  dispatchAnnounced,
  EGRESS_LIMITS,
  EGRESS_NOTICE_PREFIX,
  egressLine,
  egressTarget,
  turnChain,
  type EgressNotice,
  type EgressOptions,
  type EgressTarget,
} from "./egress.ts";
export {
  asLocal,
  LOCAL_LIMITS,
  notLocal,
  notLoopbackLiteral,
  runPersonal,
  type LocalBackend,
  type PersonalTurnRequest,
} from "./local.ts";

/**
 * Build a backend by id, including the two fenced local vendor variants — with its own model, when it was given
 * one (D-142).
 *
 * The model is this backend's alone: a vendor CLI puts it behind its own model flag on every turn, ollama asks
 * the daemon for it. A model this backend cannot take — a local variant, which runs `local-coder`, or a name
 * that is not a model's shape — throws: the commands check with `routeModels` first, so reaching here with
 * one is a programmer error, and building the backend without it would run a default nobody asked for.
 */
export function backend(id: string, options: { readonly model?: string } = {}): ExecBackend {
  const model = options.model === undefined || options.model === "" ? undefined : options.model;
  if (model !== undefined) {
    const refused = modelRefusal(id, model);
    if (refused !== undefined) throw new Error(`no model can be handed to ${id} here: ${refused}`);
  }
  if (id === "ollama") {
    return new OllamaExec(model === undefined ? {} : { defaultModel: model });
  }
  if (isLocalCliId(id)) return localCliBackend(id);
  return new CliExec(vendor(id), undefined, model === undefined ? {} : { model });
}

/** Every backend Mind can build, daemon and local CLI variants included. */
export function allBackends(): ExecBackend[] {
  return [
    new OllamaExec(),
    ...VENDORS.map((spec) => new CliExec(spec)),
    ...LOCAL_BACKENDS.map((id) => localCliBackend(id)),
  ];
}
