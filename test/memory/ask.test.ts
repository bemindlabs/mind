/** D-152 — the words and arithmetic of an ask: limits, the instruction, the sources, the "not in memory" token. */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subjectId } from "../../src/types.ts";
import { attachWithin } from "../../src/memory/attach.ts";
import type { RecallHit } from "../../src/memory/recall.ts";
import { VENDORS, vendor } from "../../src/exec/registry.ts";
import { LOCAL_BACKENDS, localBaseVendor } from "../../src/exec/local-cli.ts";
import { RESTRAINED } from "../support/restraint.ts";
import {
  ASK_ANSWER_MAX_CHARS,
  ASK_COSINE_FLOOR,
  ASK_DIR,
  ASK_HEDGE_MIN_CHARS,
  ASK_RECALL_FILE,
  appendAskRecall,
  askRecallRecord,
  askTerms,
  ASK_INSTRUCTION,
  ASK_MAX_CHARS,
  NOT_IN_MEMORY,
  askClosing,
  askProblem,
  askSystem,
  capAnswer,
  languageOf,
  longestCopiedRun,
  noToolsWhenRestrained,
  nothingInMemory,
  piecesOf,
  readAnswer,
  relevantForAsk,
  sourcesOf,
} from "../../src/memory/ask.ts";

const hit = (path: string, heading: string, text: string): RecallHit => ({ id: `${path}#${heading}#${text.length}`, path, heading, text, score: 1, via: ["fts"] });
const vec = (path: string, cosine: number, text = "x"): RecallHit => ({ id: `${path}#v#${cosine}`, path, heading: "", text, score: 1, via: ["vector"], cosine });

describe("the question", () => {
  test("empty and too long are refused; at the limit is taken; Thai is counted by character", () => {
    expect(askProblem("")).toContain("empty");
    expect(askProblem("   \n")).toContain("empty");
    expect(askProblem("x".repeat(ASK_MAX_CHARS))).toBeUndefined();
    expect(askProblem("x".repeat(ASK_MAX_CHARS + 1))).toContain(`at most ${ASK_MAX_CHARS}`);
    expect(askProblem("ก".repeat(ASK_MAX_CHARS))).toBeUndefined();
  });

  test("the engine's own sentence follows the question's language", () => {
    expect(languageOf("which port?")).toBe("en");
    expect(languageOf("พอร์ตอะไร")).toBe("th");
    expect(nothingInMemory("which port?")).toBe("There is nothing in memory about this.");
    expect(nothingInMemory("dashboard ใช้พอร์ตอะไร")).toBe("ใน memory ไม่มีเรื่องนี้");
  });
});

describe("what the model is handed", () => {
  test("soul, then the instruction, then the pieces — and the instruction forbids pasting and inventing", () => {
    const att = attachWithin([hit("memory/a.md", "Ports", "dashboard on 30600")], 4500);
    const system = askSystem("SOUL", att);
    expect(system.indexOf("SOUL")).toBe(0);
    expect(system.indexOf(ASK_INSTRUCTION)).toBeGreaterThan(0);
    expect(system.indexOf("dashboard on 30600")).toBeGreaterThan(system.indexOf(ASK_INSTRUCTION));
    expect(ASK_INSTRUCTION).toContain("Never paste");
    expect(ASK_INSTRUCTION).toContain("same language the question is written in");
    expect(ASK_INSTRUCTION).toContain(NOT_IN_MEMORY);
    expect(askSystem("SOUL", attachWithin([], 4500), "why?")).toBe(`SOUL\n\n${ASK_INSTRUCTION}\n\n${askClosing("why?")}`);
    // The reminder comes last, after the pieces, and names the question's language.
    expect(system.endsWith(askClosing(""))).toBe(true);
    expect(askClosing("กี่โมง")).toContain("answer in Thai");
    expect(askClosing("when?")).toContain("answer in English");
  });
});

describe("sources come from what was handed, never from what the model wrote", () => {
  test("one per file and section, in recall's order, titled when a title is known", () => {
    const att = attachWithin([hit("memory/a.md", "Ports", "one"), hit("memory/a.md", "Ports", "two"), hit("memory/b.md", "", "three"), hit("memory/a.md", "Hosts", "four")], 4500);
    expect(sourcesOf(att, new Map([["memory/a.md", "Infra notes"]]))).toEqual([
      { path: "memory/a.md", title: "Infra notes", section: "Ports" },
      { path: "memory/b.md" },
      { path: "memory/a.md", title: "Infra notes", section: "Hosts" },
    ]);
  });

  test("a piece left over the ceiling is not a source", () => {
    const att = attachWithin([hit("memory/a.md", "", "x".repeat(40)), hit("memory/big.md", "", "y".repeat(100))], 50);
    expect(sourcesOf(att).map((s) => s.path)).toEqual(["memory/a.md"]);
  });

  test("the pieces behind the toggle are only the handed ones, cut to an excerpt", () => {
    const hits = [hit("memory/a.md", "Ports", `dashboard ${"z".repeat(400)}`), hit("memory/held.md", "", "secret")];
    const att = attachWithin([hits[0]!], 4500);
    const pieces = piecesOf(hits, att);
    expect(pieces.map((p) => p.path)).toEqual(["memory/a.md"]);
    expect(pieces[0]!.excerpt.length).toBe(241);
    expect(pieces[0]!.section).toBe("Ports");
  });
});

describe("reading the answer", () => {
  test("the token alone, with stray punctuation or a code fence, is 'not in memory'", () => {
    for (const text of [NOT_IN_MEMORY, ` ${NOT_IN_MEMORY}. `, `\`${NOT_IN_MEMORY}\``, `**${NOT_IN_MEMORY}**`, `<think>hm</think>\n${NOT_IN_MEMORY}`]) {
      expect(readAnswer(text), text).toEqual({ covered: false, answer: "" });
    }
  });

  test("an answer is kept, a reasoning block dropped, and a token inside a long answer removed", () => {
    expect(readAnswer("<think>let me see</think>The port is 30600 (memory/a.md).")).toEqual({ covered: true, answer: "The port is 30600 (memory/a.md)." });
    expect(readAnswer(`The port is 30600, from memory/a.md; the rest is not covered. ${NOT_IN_MEMORY}`).answer).toBe("The port is 30600, from memory/a.md; the rest is not covered.");
  });

  test("an answer that runs on is cut at the cap, by character, and says it was cut", () => {
    expect(capAnswer("short")).toBe("short");
    const cut = readAnswer("ก".repeat(ASK_ANSWER_MAX_CHARS + 50)).answer;
    expect([...cut].length).toBe(ASK_ANSWER_MAX_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("what 'pasted back' means, measured", () => {
  test("the longest run of words copied in order from any one piece", () => {
    const piece = "The second brain dashboard listens on port 30600 and is reachable on the tailnet only.";
    expect(longestCopiedRun("It runs on 30600, tailnet only (memory/a.md).", [piece])).toBeLessThan(4);
    expect(longestCopiedRun(`Here: ${piece}`, ["other", piece])).toBe(15);
    expect(longestCopiedRun("ใช้พอร์ต 30600", ["แดชบอร์ดใช้พอร์ต 30600 เฉพาะในเครือข่าย"])).toBeGreaterThan(0);
  });
});

describe("only pieces about the question are handed to an ask (calibrated floors)", () => {
  test("a piece the vector half alone found is kept at the cosine floor and dropped below it", () => {
    const kept = relevantForAsk([vec("memory/a.md", ASK_COSINE_FLOOR), vec("memory/b.md", ASK_COSINE_FLOOR - 0.01), vec("memory/c.md", 0.71)], "anything");
    expect(kept.map((h) => h.path)).toEqual(["memory/a.md", "memory/c.md"]);
    expect(ASK_COSINE_FLOOR).toBeGreaterThan(0.467); // the highest off-topic cosine measured
    expect(ASK_COSINE_FLOOR).toBeLessThan(0.562); // the lowest on-topic one
  });

  test("a full-text piece needs two of the question's terms: one shared word in the front matter is not enough", () => {
    const note = hit("memory/kiln.md", "", "---\nname: Kiln notes\n---\nThe kiln fires to cone 6.");
    expect(relevantForAsk([note], "What is the name of my dentist and when is my next appointment?")).toEqual([]);
    expect(relevantForAsk([note], "what cone does the kiln fire to?")).toEqual([note]);
    // A one-term question needs its one term.
    expect(relevantForAsk([note], "kiln?")).toEqual([note]);
    // Stop words alone are no terms at all: nothing is relevant by full text.
    expect(relevantForAsk([note], "what is it?")).toEqual([]);
  });

  test("either half is enough: a close vector hit with no shared words is kept", () => {
    const both: RecallHit = { ...vec("memory/backup.md", 0.69), via: ["fts", "vector"] };
    expect(relevantForAsk([both], "สำรองข้อมูลกี่โมง")).toEqual([both]);
  });
});

describe("an ask has no tools on any backend it may use", () => {
  test("of the vendors, only an empty allow list counts as no tools — claude's; grok's read tools do not", () => {
    const admitted = VENDORS.filter((spec) => noToolsWhenRestrained(spec.readOnly)).map((spec) => spec.id);
    expect(admitted).toEqual(["claude"]);
    for (const id of ["grok", "kimi", "codex", "gemini", "copilot"]) expect(noToolsWhenRestrained(vendor(id).readOnly), id).toBe(false);
    // The local CLIs follow their base vendor: claude-local in, grok-local out.
    expect(LOCAL_BACKENDS.filter((id) => noToolsWhenRestrained(vendor(localBaseVendor(id)).readOnly))).toEqual(["claude-local"]);
  });

  test("every admitted vendor's restrained argv carries the empty tool list and no tool grant", () => {
    for (const spec of VENDORS.filter((v) => noToolsWhenRestrained(v.readOnly))) {
      const argv = spec.headlessArgv({ prompt: "q", restraint: RESTRAINED, system: "s" });
      const at = argv.indexOf("--tools");
      expect(at, spec.id).toBeGreaterThanOrEqual(0);
      expect(argv[at + 1], spec.id).toBe("");
      expect(argv.filter((a) => a === "--tools")).toHaveLength(1);
      for (const grant of ["--allowedTools", "--allowed-tools", "--permission-mode", "--dangerously-skip-permissions"]) expect(argv, `${spec.id} ${grant}`).not.toContain(grant);
    }
  });
});

describe("the answer narrows the sources, never widens them", () => {
  test("paths the answer names are listed; a path it names that was not handed is not; none named lists all", () => {
    const att = attachWithin([hit("memory/a.md", "One", "1"), hit("memory/b.md", "", "2"), hit("memory/a.md", "Two", "3")], 4500);
    expect(sourcesOf(att, new Map(), "From memory/a.md and memory/zzz.md.")).toEqual([{ path: "memory/a.md", section: "One" }, { path: "memory/a.md", section: "Two" }]);
    expect(sourcesOf(att, new Map(), "Only memory/zzz.md.").map((x) => x.path)).toEqual(["memory/a.md", "memory/b.md", "memory/a.md"]);
  });

  test("a reply that opens with the token is not covered, whatever prose follows", () => {
    expect(readAnswer(`${NOT_IN_MEMORY}\n\nThe excerpts talk about kilns and tomatoes, not dentists, so I cannot say.`)).toEqual({ covered: false, answer: "" });
    expect(readAnswer(`**${NOT_IN_MEMORY}** — nothing about that here.`).covered).toBe(false);
  });
});

describe("follow-up: a part memory does not cover, and an answer that hedges first", () => {
  const handed = ["memory/knowledge/backups.md"];
  test("the instruction asks for the covered part and the gap named; the token only when nothing is covered", () => {
    expect(ASK_INSTRUCTION).toContain("cover only part of the question, answer that part and say plainly which part");
    expect(ASK_INSTRUCTION).toContain(`Only if the excerpts say nothing about any part of the question, reply with exactly ${NOT_IN_MEMORY}`);
  });

  test("the token first, then a real answer — substantial, or naming a handed file — is covered, the token dropped", () => {
    const long = `${NOT_IN_MEMORY}\n\nThe nightly backup runs at 02:40 and snapshots are kept for 45 days; the monthly USB copy goes to ORCA-7.`;
    expect(readAnswer(long, handed)).toEqual({ covered: true, answer: "The nightly backup runs at 02:40 and snapshots are kept for 45 days; the monthly USB copy goes to ORCA-7." });
    expect(readAnswer(`${NOT_IN_MEMORY} — 02:40 (memory/knowledge/backups.md).`, handed)).toEqual({ covered: true, answer: "02:40 (memory/knowledge/backups.md)." });
    // A short remark after the token, naming nothing handed, is still "not in memory".
    expect(readAnswer(`${NOT_IN_MEMORY} — nothing about dentists here.`, handed).covered).toBe(false);
    expect(ASK_HEDGE_MIN_CHARS).toBeGreaterThanOrEqual(60);
  });

  test("the token inside an answer: inline it becomes words in the asker's language; on its own line it goes", () => {
    expect(readAnswer(`- Time: 02:40\n- Retention: ${NOT_IN_MEMORY}.`, handed, "when and how long?").answer).toBe("- Time: 02:40\n- Retention: not in memory.");
    expect(readAnswer(`- เวลา: 02:40\n- ผู้ดูแล: **${NOT_IN_MEMORY}**`, handed, "กี่โมง ใครดูแล").answer).toBe("- เวลา: 02:40\n- ผู้ดูแล: ไม่มีใน memory");
    expect(readAnswer(`Backups run at 02:40 (memory/knowledge/backups.md).\n\n${NOT_IN_MEMORY}\n\nWho looks after the NAS is not in memory.`, handed).answer).toBe(
      "Backups run at 02:40 (memory/knowledge/backups.md).\n\nWho looks after the NAS is not in memory.",
    );
    expect(readAnswer(`- Retention: ${NOT_IN_MEMORY}.`, handed).answer).not.toMatch(/: \.|:\s*$/m);
  });
});

describe("follow-up: Thai terms are words, not overlapping windows", () => {
  test("ICU cuts the run into words and the question words are left out", () => {
    const terms = askTerms("สำรองข้อมูลทุกคืนตอนกี่โมง และเก็บ snapshot ไว้กี่วัน");
    expect(terms).toContain("สำรอง");
    expect(terms).toContain("ข้อมูล");
    expect(terms).toContain("snapshot");
    for (const asking of ["กี่", "และ", "ไว้", "ตอน"]) expect(terms).not.toContain(asking);
    // One Thai word is one term: the old windows made "ราคาทอง" three.
    expect(askTerms("ราคาทอง")).toEqual(["ราคา", "ทอง"]);
  });

  test("a Thai piece the full-text half found needs two real words of the question", () => {
    const note = hit("memory/infra.md", "ราคา", "แจ้งราคาทองทุกเช้าเวลา 09:00");
    expect(relevantForAsk([note], "ราคาทองแจ้งกี่โมง")).toEqual([note]);
    expect(relevantForAsk([note], "ราคาน้ำมันวันนี้เท่าไหร่")).toEqual([]);
  });
});

describe("follow-up: each ask's recall, in numbers only", () => {
  test("the record is counts, a rounded cosine and yes/no — no question, no path, no text", () => {
    const hits = [vec("memory/secret-plan.md", 0.43219, "the launch is on Friday"), hit("memory/b.md", "Heading", "words")];
    const record = askRecallRecord({ at: new Date("2026-10-05T00:00:00Z"), scope: "all", hits, vector: true, kept: 0, handed: 0 });
    expect(record).toEqual({ v: 1, at: "2026-10-05T00:00:00.000Z", scope: "all", recalled: 2, vector: true, best_cosine: 0.432, floor: ASK_COSINE_FLOOR, kept: 0, handed: 0, model_asked: false });
    const json = JSON.stringify(record);
    for (const leak of ["secret-plan", "launch", "Heading", "memory/"]) expect(json).not.toContain(leak);
    expect(askRecallRecord({ at: new Date(), scope: "memory", hits: [hit("memory/b.md", "", "x")], vector: false, kept: 1, handed: 1 })).toMatchObject({ best_cosine: null, model_asked: true });
  });

  test("appended to the subject's personal directory, 0600, one line per ask", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-ask-recall-"));
    try {
      const env = { home, env: { XDG_STATE_HOME: join(home, "state") } };
      const subject = subjectId("example");
      const record = askRecallRecord({ at: new Date(), scope: "all", hits: [], vector: false, kept: 0, handed: 0 });
      const first = await appendAskRecall(env, subject, record);
      const second = await appendAskRecall(env, subject, record);
      expect(first.ok && second.ok).toBe(true);
      const path = first.ok ? first.path : "";
      expect(path.endsWith(join(ASK_DIR, ASK_RECALL_FILE))).toBe(true);
      expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a personal directory that cannot be made is a reason, not a throw", async () => {
    const out = await appendAskRecall({ home: "/proc/nope", env: { XDG_STATE_HOME: "/proc/nope/state" } }, subjectId("example"), askRecallRecord({ at: new Date(), scope: "all", hits: [], vector: false, kept: 0, handed: 0 }));
    expect(out.ok).toBe(false);
  });
});
