/**
 * S8.3's second layer: a local model reads what the text filter cannot (D-061).
 *
 * The filter matches text; it cannot see a needle paraphrased ("the bookkeeper
 * whose name means 'young woman'") or written in another script ("คุณวนิดา"
 * for "Wanida"). Those two were the forms the red team got through (8/10). So,
 * after the filter passes a prompt that is about to leave this machine, and
 * only when the owner has needles, a model **on this machine** is asked one
 * question: does this text reveal or point to any of these protected items?
 *
 * Three rules make it a gate rather than a hope:
 * - **Local only.** The judge is reached at a loopback literal and nowhere
 *   else — asking a cloud model whether text is private would send it out to
 *   find out. A host that is not loopback is refused before any request.
 * - **Fails closed.** No answer, a timeout, or an answer that does not parse
 *   is "unsure", and unsure keeps the prompt in. A prompt that could not be
 *   judged does not leave.
 * - **Named by `MIND_EGRESS_JUDGE=<ollama model>`**, because it costs a local
 *   call on every cloud turn. Until D-181 the layer was off unless it was
 *   named; now `judge-mode.ts` decides, per path, whether an unnamed judge is
 *   switched on by itself (a local model is configured) or the path goes on
 *   with the filter alone and says so every time. Naming a model, or setting
 *   the variable empty, still wins over all of that.
 */

import { readMind } from "../env.ts";
import { notLoopbackLiteral } from "../loopback.ts";
import type { EgressFinding } from "./filter.ts";

export const JUDGE_ENV = "MIND_EGRESS_JUDGE";
export const JUDGE_HOST_ENV = "OLLAMA_HOST";
export const DEFAULT_JUDGE_HOST = "http://127.0.0.1:11434";
export const JUDGE_TIMEOUT_MS = 20_000;

export type Verdict =
  | { readonly kind: "clear" }
  | { readonly kind: "reveals" }
  | { readonly kind: "unsure"; readonly reason: string };

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface JudgeConfig {
  readonly model: string;
  readonly host: string;
}

/** Where the judge's model is asked: `OLLAMA_HOST`, else the loopback default. */
export function judgeHost(env: Readonly<Record<string, string | undefined>>): string {
  return (env[JUDGE_HOST_ENV] ?? DEFAULT_JUDGE_HOST).replace(/\/+$/, "");
}

/**
 * The judge the environment **names**, or `undefined` when it names none. This is the explicit setting only: whether an
 * unnamed judge runs anyway is `resolveJudgeMode` (`judge-mode.ts`, D-181), so a path that screens a text asks that,
 * not this. Every path asks the resolver now, proposal triage included; this stays as the explicit setting on its own.
 */
export function judgeConfig(env: Readonly<Record<string, string | undefined>>): JudgeConfig | undefined {
  const model = readMind(JUDGE_ENV, env)?.trim();
  if (model === undefined || model === "") return undefined;
  return { model, host: judgeHost(env) };
}

/** What the model is told. The needles are named to it — it is on this machine. */
export function judgePrompt(text: string, needles: readonly string[]): { system: string; user: string } {
  return {
    system:
      "You guard an owner's privacy. You are given a list of PROTECTED items and a TEXT that is about to be sent " +
      "to an outside service. Decide whether the TEXT reveals, names, identifies, describes or points to any " +
      "protected item — in any language, script, spelling, nickname, translation, transliteration, abbreviation " +
      "or paraphrase. When in doubt, answer true. Reply with JSON only: {\"reveals\": true} or {\"reveals\": false}.",
    user: `PROTECTED:\n${needles.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nTEXT:\n${text}`,
  };
}

/**
 * Read the model's answer. Anything but one clear boolean is unsure; and an answer that says `true` anywhere is
 * `reveals` whatever else it says (EEA-16) — text the judge was shown can address it, and `{"reveals": false} and also
 * {"reveals": true}` is not a clear. The same object said twice, to the letter and to the spacing, is one answer: a
 * model that repeats its JSON (once in a fence, once in prose) has not contradicted itself, and keeping its text in
 * for that would block a clear one. Objects that differ and have no `true` among them stay unsure.
 */
export function readVerdict(content: string): Verdict {
  const answers = [...content.matchAll(/\{[^{}]*"reveals"\s*:\s*(true|false)[^{}]*\}/gi)].map((m) => ({ said: m[1]!.toLowerCase(), object: m[0].replace(/\s+/g, "").toLowerCase() }));
  if (answers.length === 0) return { kind: "unsure", reason: "the judge's answer did not say true or false" };
  if (answers.some((a) => a.said === "true")) return { kind: "reveals" };
  return new Set(answers.map((a) => a.object)).size === 1 ? { kind: "clear" } : { kind: "unsure", reason: "the judge answered more than once, and not the same way" };
}

/** Ask the local judge. Never throws; every failure is unsure. */
export async function judgeEgress(
  text: string,
  needles: readonly string[],
  config: JudgeConfig,
  fetchImpl: Fetch = fetch,
): Promise<Verdict> {
  if (needles.length === 0) return { kind: "clear" };
  const refused = notLoopbackLiteral(config.host);
  if (refused !== undefined) return { kind: "unsure", reason: `the judge must run on this machine: ${refused}` };
  const { system, user } = judgePrompt(text, needles);
  try {
    const response = await fetchImpl(`${config.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: "unsure", reason: `the judge answered ${response.status}` };
    const body = (await response.json()) as { message?: { content?: unknown } };
    const content = body.message?.content;
    return typeof content === "string" ? readVerdict(content) : { kind: "unsure", reason: "the judge sent no message" };
  } catch (error) {
    return { kind: "unsure", reason: `the judge did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * What a turn's judge reads (D-071): the question and what recall attached —
 * not the soul. The soul is the agent's own identity, the same every turn and
 * written by the owner on purpose; read alongside the needles, it made the
 * judge keep nearly every turn in. The filter still screens all of it, soul
 * included, so a needle written into a soul is still caught.
 */
export function judgeInput(prompt: string, recall: string | undefined): string {
  return recall === undefined || recall === "" ? prompt : `${prompt}\n${recall}`;
}

/** A verdict as findings the egress path already knows how to keep in and record. */
export function verdictFindings(verdict: Verdict): readonly EgressFinding[] {
  if (verdict.kind === "clear") return [];
  return [{ rule: verdict.kind === "reveals" ? "judge:reveals" : "judge:unsure" }];
}
