/** S5.2 AC1 — level 1 proposes instead of acting (D-045). */

import { describe, expect, test } from "bun:test";
import { extractAsks, PROPOSAL_FENCE, PROPOSE_INSTRUCTION } from "../../src/decide/agent-proposal.ts";
import { asProposal, describeProposal, proposalLine } from "../../src/decide/proposals.ts";
import { subjectId } from "../../src/types.ts";

const block = (body: string) => "```" + PROPOSAL_FENCE + "\n" + body + "\n```";

describe("extractAsks", () => {
  test("every well-formed block is an ask; the prose around it is not", () => {
    const text = [
      "I would rotate the key.",
      block('{"what": "rotate the deploy key", "why": "it is 45 days old", "impact": "orchard-api restarts"}'),
      'Also {"what": "not a block"}',
      block('{"what": " clean /tmp ", "why": "disk", "impact": "none"}'),
    ].join("\n");
    expect(extractAsks(text)).toEqual({
      asks: [
        { what: "rotate the deploy key", why: "it is 45 days old", impact: "orchard-api restarts" },
        { what: "clean /tmp", why: "disk", impact: "none" },
      ],
      unreadable: 0,
    });
  });

  test("a block that is not JSON, misses a field, or is enormous is counted, not filed", () => {
    const text = [
      block("not json"),
      block('{"what": "x", "why": "y"}'),
      block('{"what": "x", "why": "", "impact": "z"}'),
      block(JSON.stringify({ what: "x".repeat(3000), why: "y", impact: "z" })),
      block("null"),
    ].join("\n");
    expect(extractAsks(text)).toEqual({ asks: [], unreadable: 5 });
  });

  test("no block is nothing", () => {
    expect(extractAsks("all good, nothing to do")).toEqual({ asks: [], unreadable: 0 });
  });

  test("the instruction shows the exact fence the reader looks for", () => {
    expect(PROPOSE_INSTRUCTION).toContain("```" + PROPOSAL_FENCE);
    expect(extractAsks(PROPOSE_INSTRUCTION).asks.length).toBe(1);
  });
});

describe("who filed it", () => {
  const base = { id: "p1", subject: subjectId("example"), at: new Date("2026-09-23T00:00:00Z"), what: "w", why: "y", impact: "i" };

  test("a person, by default — and a record from before the field reads as a person's", () => {
    const p = describeProposal(base);
    expect(p.filedBy).toBe("person");
    const { filedBy: _, fromTurn: __, ...old } = p;
    const back = asProposal(old);
    expect(typeof back === "string" ? back : back.filedBy).toBe("person");
  });

  test("the agent, with its turn, round-trips and is marked in the list line", () => {
    const p = describeProposal({ ...base, filedBy: "agent", fromTurn: "t-1" });
    const back = asProposal(JSON.parse(JSON.stringify(p)));
    expect(typeof back === "string" ? back : [back.filedBy, back.fromTurn]).toEqual(["agent", "t-1"]);
    expect(proposalLine(p)).toContain("(filed by the agent)");
    expect(proposalLine(describeProposal(base))).not.toContain("filed by");
  });
});
