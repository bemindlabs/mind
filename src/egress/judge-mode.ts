/**
 * Which judge a path gets, and what is said when it gets none (D-181).
 *
 * D-061 made the local judge opt-in: unset, the layer was off and nothing said so. The red team showed what that
 * costs. A default install, with the filter alone, keeps in 8 of the 10 ways out; the two it misses (a paraphrase
 * and a translation of the owner's own words) are exactly what the judge reads. The owner ruled on 2026-10-13 that
 * the judge becomes **automatic** for the two paths that send a text to something that is not this machine's own
 * model, and that nobody is left to find out by accident that it was not running. Proposal triage sends a text to a
 * hosted service as well and was the one door left outside that rule; it is now the third automatic path.
 *
 * ## One function, five paths
 *
 * {@link resolveJudgeMode} is asked by every caller and answers with one of four modes:
 *
 * - `on` — `MIND_EGRESS_JUDGE` names a model. Wins over everything below, on every path.
 * - `off` — `MIND_EGRESS_JUDGE` is set and empty (the owner's own way of saying "no judge", the one value the
 *   variable has always had for it), or the path *requires* a judge and none is named.
 * - `auto-on` — nothing is named, the path is `a2a-send`, `cloud-turn` or `triage`, and a local model is configured
 *   and runs here: the judge runs, with that model.
 * - `auto-warn` — nothing is named, the path is one of those three, and there is no local model, or the one there is
 *   does not run here: the text goes on with the filter alone and the caller says so, in one line, every time
 *   ({@link judgeWarning}).
 *
 * `chat` and `bot` are the paths where a person or a program reads every answer and nothing approves it, so they
 * keep what D-066 and S8.3 gave them: a judge **named by the owner**, or they do not start. They are never `auto-*`.
 * At beta the other two become required too; that is not built here.
 *
 * ## What "a local model is configured" means
 *
 * The engine already has one answer: `MIND_OLLAMA_MODEL`, the model the local backend runs when a turn names none
 * (`OllamaExec`, `mind web`'s "local model"). It is asked of the environment and nothing else. There is no probe: a
 * check that reached the daemon on every start would be a network call this module has no business making, and a
 * judge that is configured but not answering already fails closed (`judgeEgress`: unsure keeps the text in). The
 * host must be a loopback literal, as it must for the judge itself; a model configured at `http://gpu-box:11434` is
 * not a local model, and sending a private text there to ask whether it is private would be the leak.
 *
 * Nor is a model whose name ends `-cloud` or `:cloud` (`relayedModel`): the local daemon relays those to a hosted
 * service (`src/exec/local.ts`, `LOCAL_LIMITS`), and from inside this process the call looks local. `MIND_OLLAMA_MODEL`
 * names what answers a turn and was never meant to guard anything, so deriving a judge from it must not hand the
 * owner's needles to a hosted model unannounced: a relayed name is `auto-warn`. Naming such a model in
 * `MIND_EGRESS_JUDGE` is the owner's own word and still wins.
 *
 * `--model` on a turn is not read: it names what answers, and the stub or small model a person picks to answer is
 * not thereby a model they trust to guard.
 *
 * ## The warning cannot be switched off
 *
 * For the same reason as the egress notice (`src/exec/egress.ts`): a variable that silences it is a variable an
 * agent running as the owner can set in the owner's name. Every caller that goes on without a judge prints it, on
 * every send, whether the judge was never configured or was set off on purpose; the filter's line stays one line.
 */

import { readMind, type Env } from "../env.ts";
import { withThai, type Language } from "../lang.ts";
import { notLoopbackLiteral } from "../loopback.ts";
import { screen, type EgressFinding, type Lexicon } from "./filter.ts";
import { judgeEgress, judgeHost, JUDGE_ENV, verdictFindings, type Fetch, type JudgeConfig } from "./judge.ts";

/**
 * The environment variable that names the model the local backend runs by default.
 *
 * The same name `OLLAMA_MODEL_ENV` holds in `src/exec/ollama-exec.ts`. It is spelled out here rather than imported
 * because the egress layer sits below the backends and takes nothing from `src/exec/`; `judge-mode.test.ts` keeps
 * the two equal.
 */
export const LOCAL_MODEL_ENV = "MIND_OLLAMA_MODEL";

/** Where a text is about to go, as far as the judge is concerned. */
export type JudgePath =
  /** `mind a2a send`: a message to another agent. There is no local fallback, so kept in means not sent. */
  | "a2a-send"
  /** A turn handed to a backend that is not this machine's own model. */
  | "cloud-turn"
  /** Proposal triage (`MIND_TRIAGE=jev`, `mind proposal triage`): the proposal's words go to TypeSafe, a hosted service. */
  | "triage"
  /** `mind chat serve`: every answer is read by a person the owner allowed. A judge must be named. */
  | "chat"
  /** A bot's reader is another program. A judge must be named. */
  | "bot";

/** The paths that do not start without a judge the owner named. */
const REQUIRED: readonly JudgePath[] = ["chat", "bot"];

export type JudgeMode = "on" | "off" | "auto-on" | "auto-warn";

/** Why the mode is what it is, in words a status line can use. */
export type JudgeReason =
  /** `MIND_EGRESS_JUDGE` names a model. */
  | "named"
  /** `MIND_EGRESS_JUDGE` is set and empty. */
  | "set-empty"
  /** The path needs the owner to name a judge and none is named. */
  | "required"
  /** `MIND_OLLAMA_MODEL` is set and its host is this machine. */
  | "local-model"
  /** `MIND_OLLAMA_MODEL` is not set. */
  | "no-local-model"
  /**
   * `MIND_OLLAMA_MODEL` is set, but it is not a model on this machine: `OLLAMA_HOST` is not a loopback literal (a
   * scheme-less `127.0.0.1:11434` is not one either: it is not a URL), or the name ends `-cloud` and the daemon
   * relays it.
   */
  | "local-model-not-local";

/** The answer. `config` is there exactly when the judge runs. */
export type JudgeResolution =
  | { readonly mode: "on" | "auto-on"; readonly reason: JudgeReason; readonly config: JudgeConfig }
  | { readonly mode: "off" | "auto-warn"; readonly reason: JudgeReason };

/** The judge this resolution runs, or `undefined` when the text goes on without one. */
export function judgeOf(resolution: JudgeResolution): JudgeConfig | undefined {
  return "config" in resolution ? resolution.config : undefined;
}

/**
 * Decide the judge for `path`, from the environment alone.
 *
 * Precedence, first match wins: an explicit model; an explicit empty value; a path that requires a named judge;
 * a configured local model; nothing. No network is touched.
 */
export function resolveJudgeMode(path: JudgePath, env: Env): JudgeResolution {
  const named = readMind(JUDGE_ENV, env);
  if (named !== undefined) {
    const model = named.trim();
    if (model !== "") return { mode: "on", reason: "named", config: { model, host: judgeHost(env) } };
    return { mode: "off", reason: "set-empty" };
  }
  if (REQUIRED.includes(path)) return { mode: "off", reason: "required" };
  const local = readMind(LOCAL_MODEL_ENV, env)?.trim();
  if (local === undefined || local === "") return { mode: "auto-warn", reason: "no-local-model" };
  const host = judgeHost(env);
  if (notLoopbackLiteral(host) !== undefined || relayedModel(local)) return { mode: "auto-warn", reason: "local-model-not-local" };
  return { mode: "auto-on", reason: "local-model", config: { model: local, host } };
}

/**
 * A model name the local daemon relays to a hosted service rather than running here (`-cloud` as in
 * `gpt-oss:120b-cloud`, `:cloud` as in `glm-4.6:cloud`), whatever the case. A name that merely contains "cloud" is not.
 */
export function relayedModel(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.endsWith("-cloud") || lower.endsWith(":cloud");
}

/** The model a status page may name for `path`, or `null` when no judge would run. */
export function judgeModelFor(path: JudgePath, env: Env): string | null {
  return judgeOf(resolveJudgeMode(path, env))?.model ?? null;
}

/** The words the warning starts with. One copy, so a test and a reader can find every occurrence. */
export const JUDGE_WARNING_PREFIX = "mind: warning: only the filter screened this";

const JUDGE_WARNING_EN =
  `${JUDGE_WARNING_PREFIX}; the local judge is off, so private data in other words or another script can still leave. ` +
  `Turn it on: ${JUDGE_ENV}=<a model on this machine>.`;

const JUDGE_WARNING_TH =
  `มีเพียงตัวกรองที่ตรวจข้อความนี้ ผู้ตัดสินในเครื่องปิดอยู่ ข้อมูลส่วนตัวที่เขียนด้วยคำอื่นหรืออักษรอื่นจึงอาจหลุดออกไปได้ ` +
  `เปิดด้วย ${JUDGE_ENV}=<โมเดลบนเครื่องนี้>`;

/**
 * The same line for a model that is configured and is not on this machine. The remedy of the line above is wrong
 * here: a judge named with `MIND_EGRESS_JUDGE` shares `OLLAMA_HOST`, so naming one while that is not a loopback URL
 * makes every send fail instead of warning. The two causes are said together because the reason does not tell them apart,
 * and each is a thing the owner can check in one look.
 */
const JUDGE_WARNING_NOT_LOCAL_EN =
  `${JUDGE_WARNING_PREFIX}; ${LOCAL_MODEL_ENV} is set but names no model on this machine, so no judge ran and private ` +
  `data in other words or another script can still leave. OLLAMA_HOST must be a full URL on a loopback address, such ` +
  `as http://127.0.0.1:11434, and a model whose name ends -cloud or :cloud is relayed to a hosted service. Fix that, then ` +
  `${LOCAL_MODEL_ENV} (or ${JUDGE_ENV}=<a model on this machine>) turns the judge on.`;

const JUDGE_WARNING_NOT_LOCAL_TH =
  `มีเพียงตัวกรองที่ตรวจข้อความนี้ ${LOCAL_MODEL_ENV} ตั้งไว้แต่ไม่ใช่โมเดลบนเครื่องนี้ จึงไม่มีผู้ตัดสินทำงาน ` +
  `ข้อมูลส่วนตัวที่เขียนด้วยคำอื่นหรืออักษรอื่นอาจหลุดออกไปได้ OLLAMA_HOST ต้องเป็น URL เต็มที่ชี้ loopback เช่น ` +
  `http://127.0.0.1:11434 และโมเดลที่ชื่อลงท้าย -cloud หรือ :cloud ถูกส่งต่อไปยังบริการภายนอก แก้แล้ว ${LOCAL_MODEL_ENV} ` +
  `(หรือ ${JUDGE_ENV}=<โมเดลบนเครื่องนี้>) จะเปิดผู้ตัดสิน`;

/**
 * The one line a path prints, every time, when it goes on without the judge: English, with the Thai after it only
 * when Thai is chosen (GL-01, `src/lang.ts`). No newline inside: it is one line of stderr.
 *
 * `reason` is what {@link resolveJudgeMode} said, so the remedy matches the cause. Without it, or for any reason but
 * `local-model-not-local`, the line is the one it always was.
 */
export function judgeWarning(language: Language, reason?: JudgeReason): string {
  return reason === "local-model-not-local"
    ? withThai(JUDGE_WARNING_NOT_LOCAL_EN, JUDGE_WARNING_NOT_LOCAL_TH, language)
    : withThai(JUDGE_WARNING_EN, JUDGE_WARNING_TH, language);
}

/** Why a configured model is not made the judge, in the words a status line uses (`judgeStatus`, `mind egress check`). */
export const NOT_LOCAL_CAUSE =
  `${LOCAL_MODEL_ENV} is set but names no model on this machine (OLLAMA_HOST must be a full URL on a loopback address ` +
  `such as http://127.0.0.1:11434, and a name ending -cloud or :cloud is relayed to a hosted service)`;

/**
 * One line saying where the second layer stands, for the commands that say nothing else about it (`mind doctor`,
 * `mind setup`). It is asked as a cloud-bound turn would be.
 *
 * A judge that runs reads a text only against the owner's needles, and with none listed it returns "clear" without a
 * call (`judgeEgress`): not a hole, nothing is named for it to match, but a reader who sees "on" would otherwise
 * think something is being read. `needles` is how many are listed, or `undefined` when the caller has no subject to
 * ask.
 */
export function judgeStatus(env: Env, needles?: number): string {
  const resolution = resolveJudgeMode("cloud-turn", env);
  const config = judgeOf(resolution);
  if (config !== undefined) {
    const how = resolution.mode === "auto-on" ? `on by itself (${LOCAL_MODEL_ENV})` : `on (${JUDGE_ENV})`;
    if (notLoopbackLiteral(config.host) !== undefined) {
      return `egress judge: ${how} — but ${config.host} is not a loopback address, so ${config.model} cannot be asked there and every text it would read is kept in`;
    }
    const reads =
      needles === 0
        ? "idle: no needles are listed, so it has nothing to read a text against; `mind egress needles` shows where to list them"
        : needles === undefined
          ? "it reads a text only against listed needles (`mind egress needles`) and does nothing while there are none"
          : `${needles} needle(s) to read against`;
    return `egress judge: ${how} — ${config.model} at ${config.host}; ${reads}`;
  }
  const without = "a turn or an A2A message goes on with the filter alone and says so each time";
  switch (resolution.reason) {
    case "set-empty":
      return `egress judge: off — ${JUDGE_ENV} is set and empty; ${without}`;
    case "local-model-not-local":
      return `egress judge: off — ${NOT_LOCAL_CAUSE}; ${without}`;
    default:
      return `egress judge: off — no local model is configured; ${without}. Set ${LOCAL_MODEL_ENV} (or ${JUDGE_ENV}=<model>) to turn it on`;
  }
}

/**
 * What stops a text from leaving: the filter, then the judge when this resolution runs one and the filter found
 * nothing. Empty means it may go. A judge that cannot answer is `judge:unsure`, which keeps the text in
 * (`judgeEgress`), so a message with no local fallback is not sent on a guess.
 */
export async function screenOutbound(
  text: string,
  lexicon: Lexicon,
  resolution: JudgeResolution,
  fetchImpl?: Fetch,
): Promise<readonly EgressFinding[]> {
  const found = screen(text, lexicon);
  const judge = judgeOf(resolution);
  if (found.length > 0 || judge === undefined) return found;
  return verdictFindings(await judgeEgress(text, lexicon.needles, judge, fetchImpl));
}

/**
 * The two options `AnnouncedExec` takes for the second layer: the judge when this resolution runs one, else the
 * line to print before each prompt that leaves without it.
 *
 * `textOf` is what the judge reads of a request (D-071: the question and what recall attached, not the soul).
 * Generic in the request so this module keeps off `src/exec/`.
 */
export interface JudgeLayer<R> {
  readonly judge?: (request: R) => Promise<readonly EgressFinding[]>;
  readonly unjudged?: string;
}

export function judgeLayer<R>(
  resolution: JudgeResolution,
  needles: readonly string[],
  textOf: (request: R) => string,
  language: Language,
  fetchImpl?: Fetch,
): JudgeLayer<R> {
  const config = judgeOf(resolution);
  if (config === undefined) return { unjudged: judgeWarning(language, resolution.reason) };
  return { judge: async (request) => verdictFindings(await judgeEgress(textOf(request), needles, config, fetchImpl)) };
}
