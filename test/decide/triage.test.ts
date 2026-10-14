/** D-059 — Jev triage: opt-in, screened first, advisory, and read back exactly. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTriage,
  readTriage,
  TRIAGE_QUESTIONS,
  triageEnabled,
  triageLabel,
  triagePath,
  triageProposal,
  triageState,
  typesafeKey,
  typesafeUrl,
  TYPESAFE_URL,
  writeTriage,
} from "../../src/decide/triage.ts";
import { describeProposal } from "../../src/decide/proposals.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mind-triage-"));
  scratch.push(d);
  return d;
};

const PROPOSAL = describeProposal({
  id: "11111111-1111-4111-8111-111111111111",
  subject: subjectId("example"),
  at: new Date("2026-09-24T00:00:00Z"),
  what: "delete the old backup directory",
  why: "the disk is full",
  impact: "those backups cannot be restored",
});

const ANSWER = {
  model: "jev-1.13.0",
  answers: {
    risk: { type: "choice", choice: "destructive", confidence: 1, probabilities: { destructive: 1, external: 0, "read-only": 0, "local-change": 0 } },
    reversible: { type: "noul", noul: 0.06 },
    personal: { type: "noul", noul: 0.35 },
  },
};

const NO_NEEDLES = { needles: [] as string[] };

describe("off unless asked", () => {
  test("only MIND_TRIAGE=jev turns filing-time triage on", () => {
    expect(triageEnabled({ MIND_TRIAGE: "jev" })).toBe(true);
    for (const v of [undefined, "", "1", "true", "JEV", "yes"]) expect(triageEnabled({ MIND_TRIAGE: v })).toBe(false);
  });

  test("the key comes from the environment or the file it names, never a default", async () => {
    expect(await typesafeKey({})).toBeUndefined();
    expect(await typesafeKey({ TYPESAFE_API_KEY: " k1 " })).toBe("k1");
    const file = join(await temp(), "key");
    await writeFile(file, "k2\n");
    expect(await typesafeKey({ TYPESAFE_API_KEY_FILE: file })).toBe("k2");
    expect(await typesafeKey({ TYPESAFE_API_KEY_FILE: join(file, "missing") })).toBeUndefined();
  });

  test("the endpoint can be moved only to https, or to http on loopback", () => {
    expect(typesafeUrl({})).toBe(TYPESAFE_URL);
    expect(typesafeUrl({ MIND_TYPESAFE_URL: "http://127.0.0.1:9/x" })).toBe("http://127.0.0.1:9/x");
    expect(typesafeUrl({ MIND_TYPESAFE_URL: "https://proxy.example/v1" })).toBe("https://proxy.example/v1");
    expect(typesafeUrl({ MIND_TYPESAFE_URL: "http://evil.example/collect" })).toBe(TYPESAFE_URL);
    expect(typesafeUrl({ MIND_TYPESAFE_URL: "not a url" })).toBe(TYPESAFE_URL);
  });
});

describe("what is sent, and what is not", () => {
  test("only what/why/impact, the key as a bearer, and the three typed questions", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const lines: string[] = [];
    const out = await triageProposal(PROPOSAL, {
      key: "secret-key",
      lexicon: NO_NEEDLES,
      url: "http://127.0.0.1:9/v1/systemone",
      announce: (l) => lines.push(l),
      fetch: async (url, init) => {
        seen.push({ url, init });
        return Response.json(ANSWER);
      },
    });
    expect(out.kind).toBe("triaged");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.model).toBe("jev-latest");
    expect(JSON.parse(body.state)).toEqual({ what: PROPOSAL.what, why: PROPOSAL.why, impact: PROPOSAL.impact });
    expect(body.state).not.toContain("example");
    expect(Object.keys(body.questions)).toEqual(Object.keys(TRIAGE_QUESTIONS));
    expect((seen[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret-key");
    expect(lines[0]).toContain("leaving this machine");
    expect(triageState(PROPOSAL)).toBe(body.state);
  });

  test("a needle in the proposal keeps it in — nothing is sent", async () => {
    let called = false;
    const out = await triageProposal(PROPOSAL, {
      key: "k",
      lexicon: { needles: ["backup directory"] },
      fetch: async () => {
        called = true;
        return Response.json(ANSWER);
      },
    });
    expect(out.kind).toBe("kept-in");
    expect(called).toBe(false);
  });

  test("with no judge the caller is told once, just before the text goes; with one, or when the text is kept in, it is not (D-181)", async () => {
    const order: string[] = [];
    const sent = await triageProposal(PROPOSAL, {
      key: "k",
      lexicon: NO_NEEDLES,
      unjudged: () => order.push("unjudged"),
      announce: () => order.push("announce"),
      fetch: async () => {
        order.push("fetch");
        return Response.json(ANSWER);
      },
    });
    expect(sent.kind).toBe("triaged");
    expect(order).toEqual(["unjudged", "announce", "fetch"]);

    const judged: string[] = [];
    await triageProposal(PROPOSAL, {
      key: "k",
      lexicon: NO_NEEDLES,
      judge: async () => [],
      unjudged: () => judged.push("unjudged"),
      fetch: async () => Response.json(ANSWER),
    });
    expect(judged).toEqual([]);

    const kept: string[] = [];
    const out = await triageProposal(PROPOSAL, {
      key: "k",
      lexicon: { needles: ["backup directory"] },
      unjudged: () => kept.push("unjudged"),
      fetch: async () => Response.json(ANSWER),
    });
    expect(out.kind).toBe("kept-in");
    expect(kept).toEqual([]);
  });

  test("a refused, broken or wrongly shaped answer is a failure, never a label", async () => {
    const run = (response: () => Response | Promise<Response>) =>
      triageProposal(PROPOSAL, { key: "k", lexicon: NO_NEEDLES, fetch: async () => response() });
    expect((await run(() => new Response("no", { status: 401 }))).kind).toBe("failed");
    expect((await run(() => new Response("not json"))).kind).toBe("failed");
    expect((await run(() => Response.json({ answers: {} }))).kind).toBe("failed");
    const thrown = await triageProposal(PROPOSAL, { key: "k", lexicon: NO_NEEDLES, fetch: async () => { throw new Error("offline"); } });
    expect(thrown).toEqual({ kind: "failed", reason: "offline" });
  });
});

describe("parsing and storing", () => {
  test("a choice outside the four, or a missing yes/no, is refused", () => {
    const at = new Date("2026-09-24T01:00:00Z");
    expect(typeof parseTriage(PROPOSAL, ANSWER, at)).toBe("object");
    const bad = structuredClone(ANSWER) as { answers: Record<string, Record<string, unknown>> };
    bad.answers["risk"]!["choice"] = "approve";
    expect(parseTriage(PROPOSAL, bad, at)).toBe("no risk choice in the answer");
    const missing = structuredClone(ANSWER) as { answers: Record<string, unknown> };
    delete missing.answers["personal"];
    expect(parseTriage(PROPOSAL, missing, at)).toBe("a yes/no answer is missing");
    expect(parseTriage(PROPOSAL, null, at)).toBe("no risk choice in the answer");
  });

  test("a triage round-trips beside the proposals and labels itself", async () => {
    const dir = await temp();
    const t = parseTriage(PROPOSAL, ANSWER, new Date("2026-09-24T01:00:00Z"));
    if (typeof t === "string") throw new Error(t);
    await writeTriage(dir, t);
    expect(triagePath(dir, PROPOSAL.id)).toBe(join(dir, "triage", `${PROPOSAL.id}.json`));
    expect(await readTriage(dir, PROPOSAL.id)).toEqual(t);
    expect(await readTriage(dir, "other")).toBeUndefined();
    expect(triageLabel(t)).toBe("jev: destructive 1.00 · undo 0.06 · personal 0.35");
  });
});
