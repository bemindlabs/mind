/**
 * S22.4 (D-197) — a chain that may only be made of cloud backends.
 *
 * A fleet bot is a cloud model (D-197): when its tokens run out it borrows another *cloud* backend, and when every
 * one is resting the work is parked. It must never fall through to a model on this machine, because a turn that does
 * so would run a different model under the same bot's name. I-1 stays true for the engine (every capability still has
 * a local path); this is a policy a fleet turns on, not a path that was taken away.
 *
 * It is an allowlist, not a list of what to refuse: a backend added tomorrow is not cloud until someone says so here.
 * The policy only ever narrows. A caller can turn it on; nothing here turns it off, so an agent passing flags in the
 * owner's name cannot use it to widen a chain.
 *
 * Pure: no environment, no file, no process. The caller passes in what it read.
 */

/**
 * The backends that send a turn to a vendor's servers and run nothing on this machine. Ids that no registry knows
 * yet (`glm`, `qwen`, S22.3) are listed so the policy does not need editing when they land.
 */
export const CLOUD_BACKENDS: readonly string[] = ["claude", "codex", "grok", "gemini", "copilot", "kimi", "glm", "qwen"];

/** Whether `id` is on the allowlist. Exact match: `ollama`, `claude-local` and `ollama-cloud` are all not. */
export function isCloudBackend(id: string): boolean {
  return CLOUD_BACKENDS.includes(id);
}

/** `1` or `true` turns it on; anything else, including an empty string, leaves it off. */
export function cloudOnlyRequested(flag: boolean, envValue: string | undefined): boolean {
  return flag || envValue === "1" || envValue === "true";
}

/** The chain the policy leaves of a default one: its cloud members, in their own order. */
export function cloudMembers(ids: readonly string[]): readonly string[] {
  return ids.filter(isCloudBackend);
}

/**
 * Why this chain may not run under the policy, or undefined when it may.
 *
 * An empty chain is a problem too: a chain with nothing in it cannot answer, and one that is quietly refilled from a
 * default would be how a local model got back in.
 */
export function cloudOnlyProblem(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return "cloud-only leaves no backend in the chain";
  const outside = ids.filter((id) => !isCloudBackend(id));
  if (outside.length === 0) return undefined;
  return `cloud-only allows only cloud backends (${CLOUD_BACKENDS.join(", ")}); ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not one`;
}
