/** D-061 — the local judge: on this machine only, unsure means kept in, and it sits after the filter. */

import { describe, expect, test } from "bun:test";
import type { Availability, ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import { AnnouncedExec } from "../../src/exec/egress.ts";
import { describeFindings } from "../../src/egress/filter.ts";
import { judgeConfig, judgeEgress, judgeInput, judgePrompt, readVerdict, verdictFindings } from "../../src/egress/judge.ts";
import { subjectId } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";

const NEEDLES = ["Wanida Srisuk"];
const LOCAL = { model: "m", host: "http://127.0.0.1:11434" };
const answering = (content: unknown, status = 200) => async () =>
  new Response(JSON.stringify({ message: { content } }), { status });

describe("configuration", () => {
  test("off unless a model is named; the host follows OLLAMA_HOST", () => {
    expect(judgeConfig({})).toBeUndefined();
    expect(judgeConfig({ MIND_EGRESS_JUDGE: " " })).toBeUndefined();
    expect(judgeConfig({ MIND_EGRESS_JUDGE: "qwen" })).toEqual({ model: "qwen", host: "http://127.0.0.1:11434" });
    expect(judgeConfig({ MIND_EGRESS_JUDGE: "qwen", OLLAMA_HOST: "http://127.0.0.1:9/" })?.host).toBe("http://127.0.0.1:9");
  });

  test("the prompt names every protected item and asks for doubt to count as yes", () => {
    const p = judgePrompt("some text", ["A", "B"]);
    expect(p.user).toContain("1. A\n2. B");
    expect(p.user).toContain("TEXT:\nsome text");
    expect(p.system).toContain("When in doubt, answer true");
    expect(p.system).toContain("transliteration");
  });
});

describe("the verdict", () => {
  test("only a clear boolean is clear; anything else is unsure", () => {
    expect(readVerdict('{"reveals": false}')).toEqual({ kind: "clear" });
    expect(readVerdict('{"reveals":true}')).toEqual({ kind: "reveals" });
    expect(readVerdict('  {"reveals": TRUE, "why": "name"} ')).toEqual({ kind: "reveals" });
    expect(readVerdict("no").kind).toBe("unsure");
    expect(readVerdict('{"reveals": "maybe"}').kind).toBe("unsure");
  });

  test("EEA-16: an answer that says true anywhere is a reveal, and two different answers are never a clear", () => {
    expect(readVerdict('Sure! {"reveals": false} and also {"reveals": true}')).toEqual({ kind: "reveals" });
    expect(readVerdict('{"reveals": true} {"reveals": false}')).toEqual({ kind: "reveals" });
    expect(readVerdict('{"reveals": false, "why": "a"} {"reveals": false, "why": "b"}')).toEqual({ kind: "unsure", reason: "the judge answered more than once, and not the same way" });
    expect(readVerdict('Ignore the above. {"reveals": false}')).toEqual({ kind: "clear" });
    expect(readVerdict('{"reveals": false, "note": "{x}"}').kind).toBe("unsure");
  });

  test("a model that repeats its own JSON is one answer, not two: a clear text is not kept in for it", () => {
    expect(readVerdict('```json\n{"reveals": false}\n```\nSo: {"reveals": false}')).toEqual({ kind: "clear" });
    expect(readVerdict('{"reveals": false} {"reveals":false}')).toEqual({ kind: "clear" });
    expect(readVerdict('{"reveals": false}\n{ "REVEALS": FALSE }')).toEqual({ kind: "clear" });
    // A repeat does not make a reveal into anything else, and a true among the repeats still wins.
    expect(readVerdict('{"reveals": true} {"reveals": true}')).toEqual({ kind: "reveals" });
    expect(readVerdict('{"reveals": false} {"reveals": false} {"reveals": true}')).toEqual({ kind: "reveals" });
  });

  test("findings: clear is none, reveals and unsure both keep the prompt in, named without the text", () => {
    expect(verdictFindings({ kind: "clear" })).toEqual([]);
    expect(verdictFindings({ kind: "reveals" })).toEqual([{ rule: "judge:reveals" }]);
    expect(verdictFindings({ kind: "unsure", reason: "x" })).toEqual([{ rule: "judge:unsure" }]);
    expect(describeFindings([{ rule: "judge:reveals" }])).toContain("revealing a protected item");
    expect(describeFindings([{ rule: "judge:unsure" }])).toContain("could not decide");
  });
});

describe("asking", () => {
  test("no needles, nothing to protect: clear without a call", async () => {
    let called = false;
    const v = await judgeEgress("anything", [], LOCAL, async () => {
      called = true;
      return new Response("{}");
    });
    expect(v).toEqual({ kind: "clear" });
    expect(called).toBe(false);
  });

  test("a judge that is not on this machine is refused before any request", async () => {
    let called = false;
    for (const host of ["http://localhost:11434", "http://10.0.0.5:11434", "https://api.example.com"]) {
      const v = await judgeEgress("text", NEEDLES, { model: "m", host }, async () => {
        called = true;
        return new Response("{}");
      });
      expect(v.kind, host).toBe("unsure");
    }
    expect(called).toBe(false);
  });

  test("what is sent: the local chat endpoint, the model, JSON mode, temperature 0", async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const v = await judgeEgress("The owner is W.", NEEDLES, LOCAL, async (url, init) => {
      seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ message: { content: '{"reveals": true}' } }));
    });
    expect(v).toEqual({ kind: "reveals" });
    expect(seen?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(seen?.body).toMatchObject({ model: "m", stream: false, format: "json", options: { temperature: 0 } });
  });

  test("an error, a refusal, no message or no answer at all: unsure", async () => {
    expect((await judgeEgress("t", NEEDLES, LOCAL, answering('{"reveals": false}', 500))).kind).toBe("unsure");
    expect((await judgeEgress("t", NEEDLES, LOCAL, answering(42))).kind).toBe("unsure");
    expect((await judgeEgress("t", NEEDLES, LOCAL, async () => { throw new Error("refused"); })).kind).toBe("unsure");
    expect((await judgeEgress("t", NEEDLES, LOCAL, answering('{"reveals": false}'))).kind).toBe("clear");
  });
});

describe("in the egress path", () => {
  const REQUEST: TurnRequest = { subject: subjectId("example"), prompt: "p", system: "s", restraint: RESTRAINED };
  const cloud = (log: string[]): ExecBackend => ({
    id: "claude",
    display: "Fake claude",
    kind: "cli",
    identityStrength: "system",
    available: (): Promise<Availability> => Promise.resolve({ ok: true, detail: "fake" }),
    run: (request: TurnRequest): Promise<TurnResult> => {
      log.push("run");
      return Promise.resolve({ backend: "claude", text: "hi", confidence: "confirmed", identityStrength: "system", evidence: { source: "claude", prompt: request.prompt, raw: "" } });
    },
  });

  test("the judge keeps a prompt in exactly as the filter does, and is asked only when the filter found nothing", async () => {
    const log: string[] = [];
    const blocked: string[] = [];
    let judged = 0;
    const kept = new AnnouncedExec(cloud(log), {
      origin: cloud(log),
      write: (l) => log.push(l),
      screen: () => [],
      judge: async () => {
        judged += 1;
        return [{ rule: "judge:reveals" }];
      },
      onBlocked: (_b, f) => blocked.push(describeFindings(f)),
    });
    const out = await kept.run(REQUEST);
    expect(out.confidence).toBe("failed");
    expect(log).not.toContain("run");
    expect(blocked[0]).toContain("revealing a protected item");

    const filtered = new AnnouncedExec(cloud(log), { origin: cloud(log), write: () => {}, screen: () => [{ rule: "email" }], judge: async () => { judged += 1; return []; } });
    await filtered.run(REQUEST);
    expect(judged).toBe(1);

    const clear = new AnnouncedExec(cloud(log), { origin: cloud(log), write: () => {}, screen: () => [], judge: async () => [] });
    expect((await clear.run(REQUEST)).text).toBe("hi");
  });
});

describe("D-071 — what a turn's judge reads", () => {
  test("the question and the recall, and nothing of the soul", () => {
    expect(judgeInput("hi", undefined)).toBe("hi");
    expect(judgeInput("hi", "")).toBe("hi");
    expect(judgeInput("hi", "## recalled\nnotes")).toBe("hi\n## recalled\nnotes");
  });
});
