/** D-095 — the conversation a turn belongs to, screened one message at a time. */

import { describe, expect, test } from "bun:test";
import { conversationBlock, forCloud, MAX_MESSAGE_CHARS, MAX_MESSAGES, parseHistory } from "../../src/exec/conversation.ts";

describe("the conversation so far", () => {
  test("read for shape: the last twelve, each trimmed; empty ones dropped; anything else refused", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "agent" : "you", text: `m${i}` }));
    const got = parseHistory(JSON.stringify(many));
    expect(got.ok && got.items.map((m) => m.text)).toEqual(many.slice(-MAX_MESSAGES).map((m) => m.text));
    const long = parseHistory(JSON.stringify([{ role: "you", text: "x".repeat(9000) }, { role: "agent", text: "  " }]));
    expect(long.ok && long.items.map((m) => m.text.length)).toEqual([MAX_MESSAGE_CHARS]);
    for (const bad of ["{", "{}", '[{"role":"system","text":"x"}]', '[{"role":"you"}]']) expect(parseHistory(bad).ok).toBe(false);
  });

  test("a cloud backend is shown the clean messages; how many were held is said", () => {
    const items = [{ role: "you" as const, text: "I am Wanida" }, { role: "agent" as const, text: "Noted." }];
    const cloud = forCloud(items, (t) => !t.includes("Wanida"));
    expect(cloud).toEqual({ kept: [{ role: "agent", text: "Noted." }], held: 1 });
    expect(conversationBlock(cloud.kept, cloud.held)).toBe("## This conversation so far\n\nEarlier in this conversation, oldest first. The person's new message is the prompt.\n\nYou: Noted.\n\n(1 earlier message(s) are not shown here: they hold personal details that stay on this machine.)");
    expect(conversationBlock(items)).toContain("The person: I am Wanida\n\nYou: Noted.");
    expect(conversationBlock([])).toBe("");
  });
});
