/** S9.2 — the chat allowlist and its record (D-066). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowUserPhrase, chatDirFor, chatStatePath, isAllowed, readChatState, userProblem, writeChatState } from "../../src/connectors/users.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("chat users", () => {
  test("ids and platforms that can be added", () => {
    expect(userProblem("telegram", "12345")).toBeUndefined();
    expect(userProblem("telegram", "-100")).toContain("positive number");
    expect(userProblem("telegram", "0")).toContain("positive number");
    expect(userProblem("line", "1")).toContain("platforms are telegram");
    expect(allowUserPhrase("telegram", "12345")).toBe("answer telegram 12345");
  });

  test("written 600 under the state root, read back; a missing or broken file is nobody", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-chat-users-"));
    scratch.push(home);
    const dir = chatDirFor({ home, env: { XDG_STATE_HOME: join(home, "state") } }, subjectId("example"));
    expect(dir).toContain(join("state", "mind", "chat", "example"));
    expect((await readChatState(dir)).users).toEqual([]);
    const user = { platform: "telegram", userId: "5", label: "me", addedBy: "owner", addedAt: "t" };
    await writeChatState(dir, { users: [user], contacted: ["telegram:5"], offsets: { telegram: 9 } });
    expect(((await stat(chatStatePath(dir))).mode & 0o777).toString(8)).toBe("600");
    const back = await readChatState(dir);
    expect(isAllowed(back, "telegram", "5")).toBe(true);
    expect(isAllowed(back, "telegram", "6")).toBe(false);
    expect(back.offsets["telegram"]).toBe(9);
    await writeFile(chatStatePath(dir), "{not json");
    expect(await readChatState(dir)).toEqual({ users: [], contacted: [], offsets: {} });
    await writeFile(chatStatePath(dir), JSON.stringify({ users: [{ nope: 1 }], contacted: [3], offsets: null }));
    expect(await readChatState(dir)).toEqual({ users: [], contacted: [], offsets: {} });
  });
});
