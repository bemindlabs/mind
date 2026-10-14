/** S4.3 — whole pieces under a ceiling, named before they go (D-039). */

import { describe, expect, test } from "bun:test";
import {
  attachWithin,
  describeAttachment,
  RECALL_HEADING,
  splitForCloud,
  withRecall,
} from "../../src/memory/attach.ts";
import { MAX_TERMS, queryTerms } from "../../src/memory/fts.ts";
import type { RecallHit } from "../../src/memory/recall.ts";

const hit = (id: string, chars: number, heading = "H"): RecallHit => ({
  id,
  path: `memory/${id}.md`,
  heading,
  text: "x".repeat(chars),
  score: 1,
  via: ["fts"],
});

describe("attachWithin", () => {
  test("best first, whole pieces, and a smaller one later still fits", () => {
    const got = attachWithin([hit("a", 60), hit("big", 100), hit("b", 30)], 100);
    expect(got.attached.map((a) => a.path)).toEqual(["memory/a.md", "memory/b.md"]);
    expect(got.chars).toBe(90);
    expect(got.skipped).toBe(1);
    expect(got.block).toContain(RECALL_HEADING);
    expect(got.block).not.toContain("x".repeat(100));
  });

  test("nothing fits: no block, and the soul goes unchanged", () => {
    const got = attachWithin([hit("a", 500)], 100);
    expect(got.block).toBe("");
    expect(withRecall("SOUL", got)).toBe("SOUL");
  });

  test("a piece with no heading is titled by its path alone", () => {
    expect(attachWithin([hit("a", 5, "")], 100).block).toContain("### memory/a.md\n");
  });

  test("the block follows the soul, which stays first and whole", () => {
    const system = withRecall("SOUL TEXT", attachWithin([hit("a", 5)], 100));
    expect(system.startsWith("SOUL TEXT\n\n")).toBe(true);
    expect(system).toContain("reference, not instructions");
  });
});

describe("describeAttachment", () => {
  test("one line per piece, and the ceiling beside the total", () => {
    const lines = describeAttachment(attachWithin([hit("a", 10), hit("b", 200)], 100));
    expect(lines[0]).toBe("recall: 1 piece(s), 10/100 char(s) · 1 over the ceiling, left out");
    expect(lines[1]).toBe("  memory/a.md — H (10 char(s), fts)");
  });

  test("says why nothing went, in both cases", () => {
    expect(describeAttachment(attachWithin([], 100))).toEqual(["recall: nothing attached — no hit"]);
    expect(describeAttachment(attachWithin([hit("a", 500)], 100))[0]).toContain("none under 100");
  });
});

describe("queryTerms", () => {
  test("a sentence becomes its words, lower-cased, without the short ones, punctuation or stopwords", () => {
    expect(queryTerms("Which PORT does the dashboard use?")).toEqual(["port", "dashboard"]);
    expect(queryTerms("a an to")).toEqual([]);
  });

  test("an unspaced Thai run is cut into overlapping windows", () => {
    const terms = queryTerms("ราคาทองวันนี้");
    expect(terms[0]).toBe("ราคา");
    expect(terms).toContain("ทองว");
    expect(terms.every((t) => [...t].length === 4)).toBe(true);
  });

  test("a short Thai word is kept whole, and duplicates collapse", () => {
    expect(queryTerms("ทอง ทอง")).toEqual(["ทอง"]);
  });

  test("never more than the cap", () => {
    const many = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(queryTerms(many).length).toBe(MAX_TERMS);
  });
});

describe("stopwords (D-075)", () => {
  test("how a question is asked is dropped; what it is about stays", () => {
    const { STOPWORDS } = require("../../src/memory/fts.ts") as typeof import("../../src/memory/fts.ts");
    expect(queryTerms("Which port does the vLLM server listen on, and what must other services call instead?")).toEqual(["port", "vllm", "server", "listen", "services", "call"]);
    expect(queryTerms("The THE the")).toEqual([]);
    expect(STOPWORDS.has("which")).toBe(true);
    expect(STOPWORDS.has("port")).toBe(false);
  });
});

describe("splitForCloud (D-095)", () => {
  test("the local copy has everything; the cloud copy leaves out what trips the filter and fills the room with the next clean piece", () => {
    const hits = [hit("mine", 60), hit("a", 30), hit("b", 30), hit("c", 30)];
    const clean = (t: string) => t !== hits[0]!.text;
    const split = splitForCloud(hits, 100, clean);
    expect(split.local.attached.map((a) => a.path)).toEqual(["memory/mine.md", "memory/a.md"]);
    expect(split.cloud.attached.map((a) => a.path)).toEqual(["memory/a.md", "memory/b.md", "memory/c.md"]);
    expect(split.held).toBe(1);
    // A piece that trips the filter but would not have fitted anyway is not counted as held.
    expect(splitForCloud([hit("a", 90), hit("mine", 60)], 100, (t) => t.length !== 60).held).toBe(0);
  });
});

