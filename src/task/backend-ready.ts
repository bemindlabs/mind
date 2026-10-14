/**
 * S18.2 (D-164) — is the backend a task's next step needs ready?
 *
 * media-gen puts vLLM to sleep (`POST /sleep?level=1`) for the length of a video job and wakes it after
 * (`vllm_parked`, `~/ai-stack/media-gen/app.py`). A claude-local step that runs meanwhile gets no answer; two in a
 * row and the task used to fail. So before every step the runner asks this, and while the answer is no it waits
 * (`waiting-backend`) instead of spending a step (`runner.ts`).
 *
 * ## What is asked, and of whom
 *
 * Only tasks whose named chain is local CLIs alone (`claude-local`, `grok-local`): they have nowhere else to go.
 * A chain with a cloud member falls through to it as the person who named it asked, and the usual chain is routed
 * per turn — neither waits here (AO-11's "no automatic fallback" is the unattended tasks' rule, E18 P1).
 *
 * 1. LiteLLM, `GET <base>/health/liveliness` (no key: it says the proxy is up, not what is behind it).
 * 2. vLLM, `GET <vllm>/is_sleeping` — `{"is_sleeping": bool}`, served when vLLM runs with `VLLM_SERVER_DEV_MODE=1`
 *    (as `~/ai-stack/vllm/run.sh` starts vLLM 0.30). `/health` is no help: it answers 200 while asleep. A vLLM
 *    that has no such route (404) is asked `/health` instead; one that does not answer at all is down.
 *    `MIND_VLLM_URL` names it (default `http://127.0.0.1:10410`); `none` skips this step on a machine whose
 *    LiteLLM sends `local-coder` somewhere else.
 *
 * ## What is never asked
 *
 * Mind never puts vLLM to sleep and never wakes it: those belong to media-gen, which knows when its GPU job ends.
 * Both requests here are GETs, carry no key and no body; `test/task/backend-ready.test.ts` holds a floor over every
 * source file for any sleep or wake route.
 */

import { readMind } from "../env.ts";
import { LITELLM_BASE_URL, isLocalCliId } from "../exec/local-cli.ts";
import type { TaskRecord } from "./store.ts";

export const VLLM_URL_ENV = "MIND_VLLM_URL";
export const DEFAULT_VLLM_URL = "http://127.0.0.1:10410";
/** How long a task waits for its backend before it is parked, unless the task says otherwise. */
export const DEFAULT_BACKEND_WAIT_MINUTES = 30;
export const MAX_BACKEND_WAIT_MINUTES = 24 * 60;
const PROBE_TIMEOUT_MS = 3000;
/** The most of an answer that is read: both probes' answers are a few bytes. */
export const MAX_PROBE_BODY_BYTES = 64 * 1024;

export type BackendState = { readonly ready: true } | { readonly ready: false; readonly reason: string };

type Fetch = (url: string, init: { readonly method: "GET"; readonly signal: AbortSignal; readonly redirect: "error" }) => Promise<Response>;

/** Does this task's chain have nowhere to go but the local model? */
export function needsLocalModel(record: Pick<TaskRecord, "backend">): boolean {
  if (record.backend === null) return false;
  const chain = record.backend.split(",").map((b) => b.trim()).filter((b) => b !== "");
  return chain.length > 0 && chain.every(isLocalCliId);
}

/** Where to ask: LiteLLM's base, and vLLM's (`null` when `MIND_VLLM_URL=none`). */
export function probeTargets(env: Readonly<Record<string, string | undefined>>): { readonly litellm: string; readonly vllm: string | null } {
  const raw = (readMind(VLLM_URL_ENV, env) ?? "").trim();
  const vllm = raw === "none" || raw === "off" ? null : (raw === "" ? DEFAULT_VLLM_URL : raw).replace(/\/+$/, "");
  return { litellm: LITELLM_BASE_URL, vllm };
}

async function get(fetcher: Fetch, url: string): Promise<{ readonly status: number; readonly body: unknown } | { readonly error: string }> {
  try {
    // `redirect: "error"`: an address that answers with a redirect is not the one that was configured.
    const response = await fetcher(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "error" });
    const text = await boundedText(response);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message.slice(0, 120) : "no answer" };
  }
}

/** At most {@link MAX_PROBE_BODY_BYTES} of the body, as text: what is beyond is not read (and then does not parse). */
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size > MAX_PROBE_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return "";
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Ask LiteLLM, then vLLM. Never anything but a GET. */
export async function probeLocalModel(targets: { readonly litellm: string; readonly vllm: string | null }, fetcher: Fetch = fetch as unknown as Fetch): Promise<BackendState> {
  const proxy = await get(fetcher, `${targets.litellm}/health/liveliness`);
  if ("error" in proxy) return { ready: false, reason: `LiteLLM (${targets.litellm}) did not answer: ${proxy.error}` };
  if (proxy.status < 200 || proxy.status >= 300) return { ready: false, reason: `LiteLLM (${targets.litellm}) answered ${proxy.status}` };
  if (targets.vllm === null) return { ready: true };
  const sleeping = await get(fetcher, `${targets.vllm}/is_sleeping`);
  if ("error" in sleeping) return { ready: false, reason: `vLLM (${targets.vllm}) did not answer: ${sleeping.error}` };
  if (sleeping.status === 200) {
    const flag = (sleeping.body as { is_sleeping?: unknown } | undefined)?.is_sleeping;
    // Fail closed: an answer that is not exactly true or false is not "awake".
    if (typeof flag !== "boolean") return { ready: false, reason: `vLLM (${targets.vllm}) answered /is_sleeping with something that is not true or false` };
    return flag ? { ready: false, reason: `vLLM (${targets.vllm}) is asleep — another job has the GPU; it is woken by whoever put it to sleep` } : { ready: true };
  }
  // No sleep route at all (404: not in dev mode): whether it is up is all that can be asked. Any other status is
  // not ready.
  if (sleeping.status !== 404) return { ready: false, reason: `vLLM (${targets.vllm}) answered /is_sleeping ${sleeping.status}` };
  const health = await get(fetcher, `${targets.vllm}/health`);
  if ("error" in health) return { ready: false, reason: `vLLM (${targets.vllm}) did not answer: ${health.error}` };
  return health.status === 200 ? { ready: true } : { ready: false, reason: `vLLM (${targets.vllm}) answered ${health.status}` };
}

/** The runner's `backendReady`: the probe for a task that needs the local model, ready for any other. */
export function backendReadiness(env: Readonly<Record<string, string | undefined>>, fetcher?: Fetch): (record: TaskRecord) => Promise<BackendState> {
  const targets = probeTargets(env);
  return async (record) => (needsLocalModel(record) ? probeLocalModel(targets, fetcher) : { ready: true });
}
