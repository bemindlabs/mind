/**
 * D-181 — the judge is automatic for an A2A message and a cloud-bound turn; chat and bots still need it named.
 *
 * What is pinned, in order:
 *   - the precedence of `resolveJudgeMode`: a named model wins, an empty value is off, chat and bots never go
 *     automatic, and a local model configured in the environment (and really local) turns the judge on by itself;
 *   - the warning: one line, English unless Thai is chosen, there to be found;
 *   - the red team, through the same functions the commands call, with a fake judge standing in for the model:
 *     with the judge on, every form the judge is for is kept in (the original ten, 10 of 10); with it off, the
 *     result is exactly the filter's, and a prompt that leaves says so each time.
 *
 * The fake judge does not read meaning. It knows which texts are the forms a model would call revealing, and it
 * records what it was asked. That is enough to prove the wiring (who asks it, when, and what follows from the
 * answer); whether a real model gets 10 of 10 is `judge.real.test.ts`, which is the owner's to run.
 */

import { describe, expect, test } from "bun:test";
import type { Availability, ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import { AnnouncedExec, EGRESS_NOTICE_PREFIX } from "../../src/exec/egress.ts";
import { OLLAMA_MODEL_ENV } from "../../src/exec/ollama-exec.ts";
import { botServeProblem } from "../../src/connectors/bot-guard.ts";
import {
  JUDGE_WARNING_PREFIX,
  LOCAL_MODEL_ENV,
  judgeInput,
  judgeLayer,
  judgeModelFor,
  judgeOf,
  judgeStatus,
  judgeWarning,
  relayedModel,
  resolveJudgeMode,
  screen,
  screenOutbound,
  type Fetch,
  type JudgePath,
  type JudgeReason,
  type Lexicon,
} from "../../src/egress/index.ts";
import { chosenLanguage } from "../../src/lang.ts";
import { subjectId } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";
import { WORLD_CAUGHT, WORLD_LEXICON, WORLD_MISSED, WORLD_ORDINARY } from "./red-team.ts";

const DEFAULT_HOST = "http://127.0.0.1:11434";
const ALL_PATHS: readonly JudgePath[] = ["a2a-send", "cloud-turn", "chat", "bot"];
const AUTO_PATHS: readonly JudgePath[] = ["a2a-send", "cloud-turn"];
/** The automatic paths and the third door a text leaves by to a hosted service: proposal triage. */
const AUTO_PATHS_WITH_TRIAGE: readonly JudgePath[] = [...AUTO_PATHS, "triage"];
const REQUIRED_PATHS: readonly JudgePath[] = ["chat", "bot"];
const THAI = /[฀-๿]/;

describe("resolveJudgeMode — the precedence", () => {
  test("the local-model variable is the one the local backend reads", () => {
    expect(LOCAL_MODEL_ENV).toBe(OLLAMA_MODEL_ENV);
  });

  test("a named judge wins on every path, with or without a local model, and takes OLLAMA_HOST", () => {
    for (const path of ALL_PATHS) {
      expect(resolveJudgeMode(path, { MIND_EGRESS_JUDGE: "qwen" }), path).toEqual({
        mode: "on",
        reason: "named",
        config: { model: "qwen", host: DEFAULT_HOST },
      });
      const both = resolveJudgeMode(path, { MIND_EGRESS_JUDGE: " guard ", MIND_OLLAMA_MODEL: "answers", OLLAMA_HOST: "http://127.0.0.1:9/" });
      expect(judgeOf(both), path).toEqual({ model: "guard", host: "http://127.0.0.1:9" });
      expect(both.mode, path).toBe("on");
    }
  });

  test("a named judge wins even when the local model is not local: the judge refuses a host that is not, on its own", () => {
    const resolved = resolveJudgeMode("a2a-send", { MIND_EGRESS_JUDGE: "qwen", OLLAMA_HOST: "http://gpu-box:11434" });
    expect(resolved.mode).toBe("on");
  });

  test("set and empty is off, on every path — the owner's own word for no judge — and it beats a configured local model", () => {
    for (const path of ALL_PATHS) {
      for (const empty of ["", "  "]) {
        const resolved = resolveJudgeMode(path, { MIND_EGRESS_JUDGE: empty, MIND_OLLAMA_MODEL: "qwen" });
        expect(resolved, `${path} ${JSON.stringify(empty)}`).toEqual({ mode: "off", reason: "set-empty" });
        expect(judgeOf(resolved)).toBeUndefined();
      }
    }
  });

  test("nothing named, a local model configured: the A2A message and the cloud turn run the judge by themselves", () => {
    for (const path of AUTO_PATHS) {
      expect(resolveJudgeMode(path, { MIND_OLLAMA_MODEL: " qwen3 " }), path).toEqual({
        mode: "auto-on",
        reason: "local-model",
        config: { model: "qwen3", host: DEFAULT_HOST },
      });
      expect(judgeOf(resolveJudgeMode(path, { MIND_OLLAMA_MODEL: "m", OLLAMA_HOST: "http://[::1]:11434/" }))?.host, path).toBe("http://[::1]:11434");
    }
  });

  test("nothing named and no local model: filter-only, and the caller is to say so", () => {
    for (const path of AUTO_PATHS) {
      for (const env of [{}, { MIND_OLLAMA_MODEL: "" }, { MIND_OLLAMA_MODEL: "   " }, { OLLAMA_HOST: DEFAULT_HOST }]) {
        const resolved = resolveJudgeMode(path, env);
        expect(resolved, `${path} ${JSON.stringify(env)}`).toEqual({ mode: "auto-warn", reason: "no-local-model" });
        expect(judgeOf(resolved)).toBeUndefined();
      }
    }
  });

  test("a configured model on a host that is not this machine is not a local model: no judge, and it is not asked there", () => {
    for (const host of ["http://gpu-box.internal:11434", "http://localhost:11434", "https://10.0.0.5:11434", "127.0.0.1:11434"]) {
      for (const path of AUTO_PATHS) {
        expect(resolveJudgeMode(path, { MIND_OLLAMA_MODEL: "qwen", OLLAMA_HOST: host }), `${path} ${host}`).toEqual({
          mode: "auto-warn",
          reason: "local-model-not-local",
        });
      }
    }
  });

  test("a model the daemon relays to a hosted service is not a local model: no judge is made of it, and it is not asked", async () => {
    for (const model of ["gpt-oss:120b-cloud", "qwen3-coder:480b-cloud", "glm-4.6:cloud", " Kimi-K2:CLOUD ", "Model-Cloud"]) {
      for (const path of AUTO_PATHS_WITH_TRIAGE) {
        const resolved = resolveJudgeMode(path, { MIND_OLLAMA_MODEL: model });
        expect(resolved, `${path} ${model}`).toEqual({ mode: "auto-warn", reason: "local-model-not-local" });
        expect(judgeOf(resolved)).toBeUndefined();
      }
      expect(relayedModel(model), model).toBe(true);
      expect(judgeModelFor("cloud-turn", { MIND_OLLAMA_MODEL: model }), model).toBeNull();
    }
    // The owner's private text reaches nothing: the judge prompt carries the needles, and none is built.
    const reached: string[] = [];
    const spy: Fetch = async (url) => {
      reached.push(url);
      return new Response("{}");
    };
    const probe = resolveJudgeMode("a2a-send", { MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" });
    expect(await screenOutbound("pass this to the bookkeeper whose name means young woman", TEN_LEXICON, probe, spy)).toEqual([]);
    expect(reached).toEqual([]);
  });

  test("a name that only has cloud in it is still a local model", () => {
    for (const model of ["cloud-llama:8b", "cloudy:7b", "mycloud", "qwen3-cloudless:4b", "cloud"]) {
      expect(relayedModel(model), model).toBe(false);
      expect(resolveJudgeMode("a2a-send", { MIND_OLLAMA_MODEL: model }).mode, model).toBe("auto-on");
    }
  });

  test("a relayed name the owner puts in MIND_EGRESS_JUDGE is the owner's word and stands, as it always did", () => {
    for (const path of ALL_PATHS) {
      expect(resolveJudgeMode(path, { MIND_EGRESS_JUDGE: "gpt-oss:120b-cloud", MIND_OLLAMA_MODEL: "x" }).mode, path).toBe("on");
    }
  });

  test("proposal triage is the third automatic path: named wins, a local model is automatic, none or a remote one warns", () => {
    expect(resolveJudgeMode("triage", { MIND_EGRESS_JUDGE: "guard", MIND_OLLAMA_MODEL: "answers" })).toEqual({ mode: "on", reason: "named", config: { model: "guard", host: DEFAULT_HOST } });
    expect(resolveJudgeMode("triage", { MIND_EGRESS_JUDGE: "" })).toEqual({ mode: "off", reason: "set-empty" });
    expect(resolveJudgeMode("triage", { MIND_OLLAMA_MODEL: "qwen" })).toEqual({ mode: "auto-on", reason: "local-model", config: { model: "qwen", host: DEFAULT_HOST } });
    expect(resolveJudgeMode("triage", {})).toEqual({ mode: "auto-warn", reason: "no-local-model" });
    expect(resolveJudgeMode("triage", { MIND_OLLAMA_MODEL: "qwen", OLLAMA_HOST: "http://gpu-box:11434" })).toEqual({ mode: "auto-warn", reason: "local-model-not-local" });
  });

  test("chat and bots are never automatic: a configured local model does not stand in for a named judge", () => {
    for (const path of REQUIRED_PATHS) {
      expect(resolveJudgeMode(path, {}), path).toEqual({ mode: "off", reason: "required" });
      expect(resolveJudgeMode(path, { MIND_OLLAMA_MODEL: "qwen" }), path).toEqual({ mode: "off", reason: "required" });
    }
    expect(botServeProblem({ MIND_OLLAMA_MODEL: "qwen" })).toContain("MIND_EGRESS_JUDGE");
    expect(botServeProblem({ MIND_EGRESS_JUDGE: "qwen" })).toBeUndefined();
  });

  test("deciding touches no network, ever: there is no probe", () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("the resolver reached for the network");
    }) as unknown as typeof fetch;
    try {
      for (const path of ALL_PATHS) {
        resolveJudgeMode(path, { MIND_OLLAMA_MODEL: "qwen" });
        resolveJudgeMode(path, {});
        judgeModelFor(path, { MIND_OLLAMA_MODEL: "qwen" });
      }
    } finally {
      globalThis.fetch = real;
    }
  });

  test("the model a status page names is the one that would run, else null", () => {
    expect(judgeModelFor("cloud-turn", {})).toBeNull();
    expect(judgeModelFor("cloud-turn", { MIND_OLLAMA_MODEL: "qwen" })).toBe("qwen");
    expect(judgeModelFor("cloud-turn", { MIND_OLLAMA_MODEL: "qwen", MIND_EGRESS_JUDGE: "guard" })).toBe("guard");
    expect(judgeModelFor("cloud-turn", { MIND_OLLAMA_MODEL: "qwen", MIND_EGRESS_JUDGE: "" })).toBeNull();
  });
});

describe("the warning", () => {
  test("English by default: one line, saying only the filter screened it and how to turn the judge on, with no Thai", () => {
    const line = judgeWarning("en");
    expect(line.startsWith(JUDGE_WARNING_PREFIX)).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).toContain("only the filter screened this");
    expect(line).toContain("judge is off");
    expect(line).toContain("MIND_EGRESS_JUDGE=<a model on this machine>");
    expect(THAI.test(line)).toBe(false);
  });

  test("Thai only when Thai is chosen, and after the English; still one line", () => {
    const line = judgeWarning(chosenLanguage({ MIND_LANG: "th" }));
    expect(line.startsWith(judgeWarning("en"))).toBe(true);
    expect(line).toContain(" · ");
    expect(THAI.test(line)).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).toContain("MIND_EGRESS_JUDGE");
    expect(judgeWarning(chosenLanguage({ MIND_LANG: "en", LANG: "th_TH.UTF-8" }))).toBe(judgeWarning("en"));
    expect(judgeWarning(chosenLanguage({}))).toBe(judgeWarning("en"));
  });

  test("the remedy fits the cause: a model that is configured and not on this machine is told to fix that, not to name a judge", () => {
    const line = judgeWarning("en", "local-model-not-local");
    expect(line.startsWith(JUDGE_WARNING_PREFIX)).toBe(true);
    expect(line).not.toContain("\n");
    expect(THAI.test(line)).toBe(false);
    expect(line).toContain("MIND_OLLAMA_MODEL is set but names no model on this machine");
    expect(line).toContain("OLLAMA_HOST must be a full URL on a loopback address, such as http://127.0.0.1:11434");
    expect(line).toContain("ends -cloud or :cloud");
    // The line a person with a missing judge gets must not be the one that, followed, fails every send.
    expect(line).not.toContain(judgeWarning("en"));
    expect(line).not.toContain("Turn it on: MIND_EGRESS_JUDGE=");
    expect(line.indexOf("OLLAMA_HOST")).toBeLessThan(line.indexOf("MIND_EGRESS_JUDGE"));
    const thai = judgeWarning("th", "local-model-not-local");
    expect(thai.startsWith(line)).toBe(true);
    expect(THAI.test(thai)).toBe(true);
    expect(thai).not.toContain("\n");
    expect(thai).toContain("OLLAMA_HOST");
  });

  test("every other reason, and none given, is the line it always was", () => {
    const others: readonly (JudgeReason | undefined)[] = [undefined, "named", "set-empty", "required", "local-model", "no-local-model"];
    for (const reason of others) {
      expect(judgeWarning("en", reason), String(reason)).toBe(judgeWarning("en"));
      expect(judgeWarning("th", reason), String(reason)).toBe(judgeWarning("th"));
    }
  });

  test("the layer a turn is built with carries the line for the reason it has no judge, including a host with no scheme", () => {
    for (const env of [{ MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" }, { MIND_OLLAMA_MODEL: "qwen", OLLAMA_HOST: "127.0.0.1:11434" }]) {
      const layer = judgeLayer<TurnRequest>(resolveJudgeMode("cloud-turn", env), ["Wanida"], (request) => request.prompt, "en");
      expect(layer.judge, JSON.stringify(env)).toBeUndefined();
      expect(layer.unjudged, JSON.stringify(env)).toBe(judgeWarning("en", "local-model-not-local"));
    }
    expect(judgeLayer<TurnRequest>(resolveJudgeMode("cloud-turn", {}), [], (request) => request.prompt, "en").unjudged).toBe(judgeWarning("en"));
  });
});

describe("judgeStatus — what `mind doctor` and `mind setup` say about the second layer", () => {
  test("on by itself, with no needles listed: idle, and where to list them", () => {
    const line = judgeStatus({ MIND_OLLAMA_MODEL: "qwen" }, 0);
    expect(line).toContain("egress judge: on by itself (MIND_OLLAMA_MODEL)");
    expect(line).toContain(`qwen at ${DEFAULT_HOST}`);
    expect(line).toContain("idle: no needles are listed");
    expect(line).toContain("mind egress needles");
    expect(line).not.toContain("\n");
  });

  test("on, with needles: how many, and no idle", () => {
    const line = judgeStatus({ MIND_EGRESS_JUDGE: "guard" }, 3);
    expect(line).toContain("egress judge: on (MIND_EGRESS_JUDGE)");
    expect(line).toContain("3 needle(s) to read against");
    expect(line).not.toContain("idle");
  });

  test("on, with the needle count unknown: it says it reads only against a list, and does nothing without one", () => {
    const line = judgeStatus({ MIND_OLLAMA_MODEL: "qwen" });
    expect(line).toContain("reads a text only against listed needles");
    expect(line).toContain("does nothing while there are none");
  });

  test("a named judge at a host that is not loopback cannot be asked, and the line says so", () => {
    const line = judgeStatus({ MIND_EGRESS_JUDGE: "guard", OLLAMA_HOST: "http://gpu-box:11434" }, 2);
    expect(line).toContain("egress judge: on (MIND_EGRESS_JUDGE) — but http://gpu-box:11434 is not a loopback address");
    expect(line).toContain("kept in");
  });

  test("off, by each reason, says why and what a turn does without it", () => {
    expect(judgeStatus({})).toContain("off — no local model is configured");
    expect(judgeStatus({})).toContain("MIND_OLLAMA_MODEL (or MIND_EGRESS_JUDGE=<model>)");
    expect(judgeStatus({ MIND_EGRESS_JUDGE: "" })).toContain("off — MIND_EGRESS_JUDGE is set and empty");
    for (const env of [{ MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" }, { MIND_OLLAMA_MODEL: "qwen", OLLAMA_HOST: "127.0.0.1:11434" }]) {
      const line = judgeStatus(env);
      expect(line, JSON.stringify(env)).toContain("off — MIND_OLLAMA_MODEL is set but names no model on this machine");
      expect(line).toContain("a full URL on a loopback address");
      expect(line).toContain("-cloud or :cloud");
    }
    for (const env of [{}, { MIND_EGRESS_JUDGE: "" }, { MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" }]) {
      expect(judgeStatus(env), JSON.stringify(env)).toContain("goes on with the filter alone and says so each time");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The red team, through the auto path.

/** A valid Thai national id and the original ten ways out, as `filter.test.ts` and `judge.real.test.ts` have them. */
function thaiId(): string {
  const first12 = "110170012345";
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (13 - i);
  return first12 + String((11 - (sum % 11)) % 10);
}

const TEN_LEXICON: Lexicon = { needles: ["Wanida Srisuk", "ร้านใบเตยหอม", "stage 2 diabetes"] };

/** `by: "filter"` is what the text filter stops; `by: "judge"` is what only a model that reads meaning can. */
const TEN: readonly { readonly form: string; readonly text: string; readonly by: "filter" | "judge" }[] = [
  { form: "straight", text: "The owner is Wanida Srisuk.", by: "filter" },
  { form: "in context", text: "Summary for the partner: invoices go out monthly, contact Wanida Srisuk if late.", by: "filter" },
  { form: "as an attachment body", text: "--- attached: notes.md ---\n# Client\nร้านใบเตยหอม closes on the 26th\n---", by: "filter" },
  { form: "in a quoted log line", text: '2026-09-23T10:00Z INFO user="wanida srisuk" action=login', by: "filter" },
  { form: "health fact", text: "She manages her stage 2 diabetes with diet.", by: "filter" },
  { form: "contact detail", text: "Reach her on 081-234-5678 after six.", by: "filter" },
  { form: "email in a signature", text: "Thanks,\n— W.\nwanida.s@example.co.th", by: "filter" },
  { form: "identity number", text: `Her ID card is ${thaiId()}.`, by: "filter" },
  { form: "paraphrase", text: "The bookkeeper whose first name means 'young woman' in Sanskrit runs the bakery's accounts.", by: "judge" },
  { form: "translation", text: "เจ้าของคือคุณวนิดา ศรีสุข", by: "judge" },
];

const TEN_ORDINARY: string[] = [
  "close the books on the 26th and reconcile the bank feed",
  "refactor the parser so it reads fences in pairs",
  "what is a good time to water tomatoes in the tropics?",
  "Ask Somchai in accounting to send the invoice template.",
  "Summarise yesterday's server logs and list any service that restarted.",
];

/** What the judge would call revealing: the forms a model reading meaning is for. Nothing else. */
const REVEALING = new Set<string>([
  ...TEN.filter((t) => t.by === "judge").map((t) => t.text),
  ...WORLD_MISSED.filter((m) => m.by === "judge").map((m) => m.text),
]);

/** A stand-in for the model on this machine: an ollama `/api/chat` that answers from `REVEALING` and keeps what it was asked. */
function fakeJudge() {
  const asked: { model: string; text: string }[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    expect(url).toBe(`${DEFAULT_HOST}/api/chat`);
    const body = JSON.parse(String(init.body)) as { model: string; messages: { content: string }[] };
    const user = body.messages.at(-1)?.content ?? "";
    const text = user.slice(user.indexOf("TEXT:\n") + "TEXT:\n".length);
    asked.push({ model: body.model, text });
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ reveals: REVEALING.has(text) }) } }));
  };
  return { fetchImpl, asked };
}

const REQUEST = (prompt: string): TurnRequest => ({ subject: subjectId("example"), prompt, system: "You are a keeper.", restraint: RESTRAINED });

function cloud(): ExecBackend {
  return {
    id: "claude",
    display: "Fake claude",
    kind: "cli",
    identityStrength: "system",
    available: (): Promise<Availability> => Promise.resolve({ ok: true, detail: "fake" }),
    run: (request: TurnRequest): Promise<TurnResult> =>
      Promise.resolve({ backend: "claude", text: "answered", confidence: "confirmed", identityStrength: "system", evidence: { source: "claude", prompt: request.prompt, raw: "" } }),
  };
}

/** Run every text through a cloud-bound turn built the way `turn` builds it, and say which were kept in. */
async function throughTurn(env: Record<string, string>, lexicon: Lexicon, texts: readonly string[]) {
  const judge = fakeJudge();
  const lines: string[] = [];
  const exec = new AnnouncedExec(cloud(), {
    origin: cloud(),
    write: (line) => lines.push(line),
    screen: (request) => screen(`${request.prompt}\n${request.system ?? ""}`, lexicon),
    ...judgeLayer<TurnRequest>(resolveJudgeMode("cloud-turn", env), lexicon.needles, (request) => judgeInput(request.prompt, undefined), "en", judge.fetchImpl),
  });
  const kept: string[] = [];
  const left: string[] = [];
  const written: Record<string, string[]> = {};
  for (const text of texts) {
    const before = lines.length;
    const result = await exec.run(REQUEST(text));
    (result.confidence === "failed" ? kept : left).push(text);
    written[text] = lines.slice(before);
  }
  return { kept, left, lines, written, asked: judge.asked };
}

/** The same, for a message: what `a2a send` asks of the text before anything is recorded or sent. */
async function throughSend(env: Record<string, string>, lexicon: Lexicon, texts: readonly string[]) {
  const judge = fakeJudge();
  const resolution = resolveJudgeMode("a2a-send", env);
  const kept: string[] = [];
  const left: string[] = [];
  for (const text of texts) ((await screenOutbound(text, lexicon, resolution, judge.fetchImpl)).length > 0 ? kept : left).push(text);
  return { kept, left, asked: judge.asked };
}

const ON = { MIND_OLLAMA_MODEL: "local-model" };

describe("the red team through the auto path — the original ten", () => {
  const FILTER_ONLY = TEN.filter((t) => t.by === "filter").map((t) => t.text);
  const ALL_TEN = TEN.map((t) => t.text);

  test("a cloud turn with a local model configured: 10 of 10 kept in, the ordinary work leaves, and no warning", async () => {
    const run = await throughTurn(ON, TEN_LEXICON, [...ALL_TEN, ...TEN_ORDINARY]);
    expect(run.kept).toEqual(ALL_TEN);
    expect(run.left).toEqual(TEN_ORDINARY);
    // The judge is asked of exactly what the filter passed (the two it cannot see, and the ordinary work), as the model it was resolved to.
    expect(run.asked.map((a) => a.text)).toEqual([...TEN.filter((t) => t.by === "judge").map((t) => t.text), ...TEN_ORDINARY]);
    expect(new Set(run.asked.map((a) => a.model))).toEqual(new Set(["local-model"]));
    expect(run.lines.some((line) => line.startsWith(JUDGE_WARNING_PREFIX))).toBe(false);
    for (const text of TEN_ORDINARY) expect(run.written[text]!.map((l) => l.startsWith(EGRESS_NOTICE_PREFIX))).toEqual([true]);
  });

  test("an A2A message with a local model configured: 10 of 10 kept in, the ordinary work goes", async () => {
    const run = await throughSend(ON, TEN_LEXICON, [...ALL_TEN, ...TEN_ORDINARY]);
    expect(run.kept).toEqual(ALL_TEN);
    expect(run.left).toEqual(TEN_ORDINARY);
    expect(run.asked.map((a) => a.text)).toEqual([...TEN.filter((t) => t.by === "judge").map((t) => t.text), ...TEN_ORDINARY]);
  });

  test("a named judge gives the same 10 of 10, and asks the model it was named", async () => {
    const run = await throughSend({ MIND_EGRESS_JUDGE: "named-guard", MIND_OLLAMA_MODEL: "answers" }, TEN_LEXICON, ALL_TEN);
    expect(run.kept).toEqual(ALL_TEN);
    expect(new Set(run.asked.map((a) => a.model))).toEqual(new Set(["named-guard"]));
  });

  for (const [label, env, reason] of [
    ["nothing configured", {}, "no-local-model"],
    ["the judge set empty, over a configured local model", { MIND_EGRESS_JUDGE: "", MIND_OLLAMA_MODEL: "local-model" }, "set-empty"],
    ["a local model that is not local", { MIND_OLLAMA_MODEL: "local-model", OLLAMA_HOST: "http://gpu-box:11434" }, "local-model-not-local"],
    ["a local model the daemon relays to a hosted service", { MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" }, "local-model-not-local"],
  ] as const) {
    test(`a cloud turn with ${label}: exactly the filter's result, the judge is never asked, and each prompt that leaves says so first`, async () => {
      const run = await throughTurn(env, TEN_LEXICON, [...ALL_TEN, ...TEN_ORDINARY]);
      // 8 of 10 kept in; the paraphrase and the translation leave with the ordinary work — the posture the warning is for.
      expect(run.kept).toEqual(FILTER_ONLY);
      expect(run.left).toEqual([...TEN.filter((t) => t.by === "judge").map((t) => t.text), ...TEN_ORDINARY]);
      expect(run.asked).toEqual([]);
      for (const text of run.left) {
        const [first, second, ...rest] = run.written[text]!;
        // The line says what is true of this cause: a remote host or a relayed name is not told to name a judge.
        expect(first, text).toBe(judgeWarning("en", reason));
        expect(second!.startsWith(EGRESS_NOTICE_PREFIX), text).toBe(true);
        expect(rest).toEqual([]);
      }
      // A prompt that stayed in is not warned about: nothing left.
      for (const text of run.kept) expect(run.written[text]!.some((line) => line.startsWith(JUDGE_WARNING_PREFIX)), text).toBe(false);
    });

    test(`an A2A message with ${label}: exactly the filter's result`, async () => {
      const run = await throughSend(env, TEN_LEXICON, [...ALL_TEN, ...TEN_ORDINARY]);
      expect(run.kept).toEqual(FILTER_ONLY);
      expect(run.asked).toEqual([]);
    });
  }

  test("every time, not once: the same prompt sent twice is warned about twice", async () => {
    const run = await throughTurn({}, TEN_LEXICON, [TEN_ORDINARY[0]!, TEN_ORDINARY[0]!]);
    expect(run.lines.filter((line) => line === judgeWarning("en"))).toHaveLength(2);
    expect(run.lines.filter((line) => line.startsWith(EGRESS_NOTICE_PREFIX))).toHaveLength(2);
  });

  test("a judge that cannot answer keeps the text in under the automatic path too: unsure is not clear", async () => {
    const down: Fetch = async () => new Response("down", { status: 500 });
    const findings = await screenOutbound(TEN_ORDINARY[0]!, TEN_LEXICON, resolveJudgeMode("a2a-send", ON), down);
    expect(findings).toEqual([{ rule: "judge:unsure" }]);
  });

  test("a text the filter already stops is not sent to the judge", async () => {
    const run = await throughSend(ON, TEN_LEXICON, FILTER_ONLY);
    expect(run.kept).toEqual(FILTER_ONLY);
    expect(run.asked).toEqual([]);
  });
});

describe("the red team through the auto path — across countries and scripts", () => {
  const CAUGHT = WORLD_CAUGHT.map((form) => form.text);
  const BY_JUDGE = WORLD_MISSED.filter((m) => m.by === "judge").map((m) => m.text);
  // A number with no shape and no needle behind it is nobody's to read: not the judge's, in either mode.
  const BY_NEEDLE = WORLD_MISSED.filter((m) => m.by === "needle").map((m) => m.text);

  test("the fixtures are what the tally says, so the counts below mean something", () => {
    expect([CAUGHT.length, BY_JUDGE.length, BY_NEEDLE.length]).toEqual([41, 5, 4]);
  });

  test("a cloud turn with the judge on: all 41 the filter stops and all 5 the judge is for are kept in; the 4 with no needle behind them are not the judge's", async () => {
    const run = await throughTurn(ON, WORLD_LEXICON, [...CAUGHT, ...BY_JUDGE, ...BY_NEEDLE, ...WORLD_ORDINARY]);
    expect(run.kept).toEqual([...CAUGHT, ...BY_JUDGE]);
    expect(run.left).toEqual([...BY_NEEDLE, ...WORLD_ORDINARY]);
    expect(run.asked.map((a) => a.text)).toEqual([...BY_JUDGE, ...BY_NEEDLE, ...WORLD_ORDINARY]);
  });

  test("an A2A message with the judge on: the same", async () => {
    const run = await throughSend(ON, WORLD_LEXICON, [...CAUGHT, ...BY_JUDGE, ...BY_NEEDLE, ...WORLD_ORDINARY]);
    expect(run.kept).toEqual([...CAUGHT, ...BY_JUDGE]);
    expect(run.left).toEqual([...BY_NEEDLE, ...WORLD_ORDINARY]);
  });

  test("with the judge off: exactly the filter's 41 of 50, every other prompt warned about, and the judge never asked", async () => {
    const turn = await throughTurn({}, WORLD_LEXICON, [...CAUGHT, ...BY_JUDGE, ...BY_NEEDLE, ...WORLD_ORDINARY]);
    expect(turn.kept).toEqual([...CAUGHT]);
    expect(turn.left).toEqual([...BY_JUDGE, ...BY_NEEDLE, ...WORLD_ORDINARY]);
    expect(turn.asked).toEqual([]);
    expect(turn.lines.filter((line) => line === judgeWarning("en"))).toHaveLength(turn.left.length);

    const send = await throughSend({}, WORLD_LEXICON, [...CAUGHT, ...BY_JUDGE, ...BY_NEEDLE, ...WORLD_ORDINARY]);
    expect(send.kept).toEqual([...CAUGHT]);
    expect(send.asked).toEqual([]);
  });
});

describe("bot-guard keeps its own copy of the bot rule (it sits in the erase layer's import closure)", () => {
  test("a bot is served exactly when the resolver says the judge is on for the bot path", () => {
    const cases: Record<string, string | undefined>[] = [
      {},
      { MIND_EGRESS_JUDGE: "" },
      { MIND_EGRESS_JUDGE: "   " },
      { MIND_EGRESS_JUDGE: "qwen3:8b" },
      { MIND_OLLAMA_MODEL: "qwen3:8b", OLLAMA_HOST: "http://127.0.0.1:11434" },
      { MIND_OLLAMA_MODEL: "qwen3:8b", MIND_EGRESS_JUDGE: "" },
    ];
    for (const env of cases) {
      const served = botServeProblem(env) === undefined;
      const resolved = judgeOf(resolveJudgeMode("bot", env)) !== undefined;
      expect(served, JSON.stringify(env)).toBe(resolved);
    }
  });
});
