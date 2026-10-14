/**
 * GL-01 — English is what Mind prints, and the Thai half is there only when Thai is chosen.
 *
 * The checklist's acceptance reads "a test that default output has no Thai letters": the dial's level names, the
 * browser's levels, the sensitive-actions line a person is asked a yes by, and the console's settings. Each is
 * run here with no language chosen and scanned for U+0E00 to U+0E7F; and each is run with Thai chosen and shown
 * to still carry every Thai string it carried before, so nothing was deleted to make the first half pass.
 *
 * The spawned runs use a temporary HOME and an environment built from nothing — no `LANG`, no `LC_ALL`, no
 * `MIND_LANG` — so the answer does not depend on whichever machine runs them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialBody, decideDial, writeDial } from "../../bin/dial.ts";
import { sayDial } from "../../bin/commands/autonomy.ts";
import {
  LEVEL_MEANING,
  LEVEL_MEANING_EN,
  OPERATE_MEANING,
  SENSITIVE_CATEGORIES,
  SENSITIVE_MEANING,
  classifyAction,
  levelMeaning,
  operateMeaning,
  reasonsIn,
  sensitiveMeaning,
  type ActionDescriptor,
  type Dial,
  type Level,
} from "../../src/decide/index.ts";
import { VENDORS } from "../../src/exec/index.ts";
import { HELD_SCHEMA } from "../../src/task/approvals.ts";
import { TASK_SCHEMA, type TaskRecord } from "../../src/task/store.ts";
import { subjectId } from "../../src/types.ts";
import { PAGE_HTML } from "../../src/web/page.ts";
import { inLanguage, operateSentence } from "../../src/web/view.ts";
import { BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

/** Thai letters, vowels, tone marks and digits: what an English default must not print. */
const THAI = /[฀-๿]/;
const LEVELS: readonly Level[] = [0, 1, 2, 3];

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SUBJECT = subjectId("example");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mind-english-"));
  scratch.push(home);
  return home;
}

/** What `sayDial` prints, as one string, in `language`. */
async function said(home: string, language: "en" | "th"): Promise<string> {
  const lines: string[] = [];
  const verdict = await decideDial(home, { home, env: { XDG_STATE_HOME: join(home, "state") } }, SUBJECT);
  sayDial({ line: (text = "") => lines.push(text), dim: (s) => s, bold: (s) => s }, verdict, VENDORS, language);
  return lines.join("\n");
}

/** An environment built from nothing: no language of any kind. */
function bareEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env["PATH"] ?? "",
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    MIND_NO_UPDATE_CHECK: "1",
    ...extra,
  };
}

async function run(home: string, args: readonly string[], extra: Record<string, string> = {}) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env: bareEnv(home, extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr, all: `${stdout}\n${stderr}` };
}

describe("the words that carry the Thai half", () => {
  test("every level, in English: no Thai letter anywhere", () => {
    for (const level of LEVELS) {
      expect(levelMeaning(level)).not.toMatch(THAI);
      expect(levelMeaning(level, "en")).toBe(LEVEL_MEANING_EN[level]);
      expect(operateMeaning(level)).not.toMatch(THAI);
      expect(operateMeaning(level, "en")).toBe(OPERATE_MEANING[level].en);
    }
    for (const category of SENSITIVE_CATEGORIES) expect(sensitiveMeaning(category)).not.toMatch(THAI);
  });

  test("the English is complete on its own: each level has a name and says what the turn does", () => {
    expect(LEVEL_MEANING_EN[0]).toContain("does not run");
    expect(LEVEL_MEANING_EN[1]).toContain("read-only flag");
    expect(LEVEL_MEANING_EN[2]).toContain("taken off");
    expect(LEVEL_MEANING_EN[3]).toContain("taken off");
    expect(new Set(LEVELS.map((level) => LEVEL_MEANING_EN[level].split(" — ")[0])).size).toBe(4);
  });

  test("with Thai chosen every Thai string is still there, word for word", () => {
    expect(LEVEL_MEANING[0]).toBe("เงียบ — the turn does not run at all");
    expect(LEVEL_MEANING[1]).toBe("เสนอ — the turn runs carrying the vendor's read-only flag");
    expect(LEVEL_MEANING[2]).toBe("ทำแล้วรายงาน — the turn runs with the read-only flag taken off");
    expect(LEVEL_MEANING[3]).toBe("ทำเลย — the turn runs with the read-only flag taken off");
    expect(OPERATE_MEANING[1].th).toBe("ดูแล้วเสนอ — ไม่คลิก ไม่พิมพ์");
    for (const level of LEVELS) {
      expect(levelMeaning(level, "th")).toBe(LEVEL_MEANING[level]);
      expect(operateMeaning(level, "th")).toBe(`${OPERATE_MEANING[level].en} · ${OPERATE_MEANING[level].th}`);
      expect(operateMeaning(level, "th")).toMatch(THAI);
    }
    for (const category of SENSITIVE_CATEGORIES) {
      expect(sensitiveMeaning(category, "th")).toBe(`${SENSITIVE_MEANING[category].en} · ${SENSITIVE_MEANING[category].th}`);
    }
  });

  test("the file's body: English by default, the Thai after each level when Thai is chosen", () => {
    expect(dialBody()).not.toMatch(THAI);
    expect(dialBody("en")).toBe(dialBody());
    const thai = dialBody("th");
    for (const level of LEVELS) {
      expect(thai).toContain(LEVEL_MEANING[level]);
      expect(thai).toContain(operateMeaning(level, "th"));
    }
  });

  test("writeDial writes the body in the language it is told, and English when nothing is said", async () => {
    const home = await sandbox();
    const dial: Dial = { read: 1, write: 1, run: 1, reach: 1, operate: 0, setBy: null, setAt: null };
    const path = await writeDial(home, dial, "en");
    expect(await readFile(path, "utf8")).not.toMatch(THAI);
    await writeDial(home, dial, "th");
    expect(await readFile(path, "utf8")).toContain("เงียบ");
  });
});

describe("autonomy show, as the person reading it sees it", () => {
  test("at every level of every category, English prints no Thai letter", async () => {
    for (const level of LEVELS) {
      const home = await sandbox();
      // reach stops at 2 (I-6); a 3 elsewhere is held to 2 until it is confirmed at a terminal, and is said so.
      const dial: Dial = { read: level, write: level, run: level, reach: Math.min(level, 2) as 0 | 1 | 2, operate: level, setBy: "a test", setAt: "2026-10-13T00:00:00.000Z" };
      await writeDial(home, dial, "en");
      const text = await said(home, "en");
      expect(text, `level ${level}`).not.toMatch(THAI);
      expect(text).toContain("What a turn may do, and what took it there:");
      expect(text).toContain(levelMeaning(Math.min(level, 2) as Level, "en"));
    }
  });

  test("the same dial with Thai chosen carries the Thai halves", async () => {
    const home = await sandbox();
    await writeDial(home, { read: 1, write: 1, run: 1, reach: 1, operate: 1, setBy: null, setAt: null }, "en");
    const text = await said(home, "th");
    expect(text).toContain(LEVEL_MEANING[1]);
    expect(text).toContain(operateMeaning(1, "th"));
  });

  test("the spawned commands, with no language chosen: show, show with a directory, set, the refusals", async () => {
    const home = await sandbox();
    const runs = [
      await run(home, ["autonomy", "show"]),
      await run(home, ["autonomy", "show", home, "--subject", "example"]),
      await run(home, ["autonomy", "set", "operate", "2", home, "--subject", "example"]),
      await run(home, ["autonomy", "set", "write", "2", home, "--subject", "example"]),
      await run(home, ["autonomy", "set", "write", "3", home, "--subject", "example"]),
      await run(home, ["autonomy", "set", "reach", "3", home, "--subject", "example"]),
      await run(home, ["autonomy", "resume"]),
      await run(home, ["autonomy"]),
      await run(home, ["help"]),
    ];
    for (const result of runs) expect(result.all).not.toMatch(THAI);
    expect(runs[2]!.stdout).toContain("operate is now 2");
    expect(await Bun.file(join(home, "autonomy.md")).text()).not.toMatch(THAI);
  }, 120_000);

  test("MIND_LANG=th, and a Thai locale, print the Thai half; MIND_LANG=en over a Thai locale does not", async () => {
    const home = await sandbox();
    const args = ["autonomy", "show", home, "--subject", "example"];
    expect((await run(home, args, { MIND_LANG: "th" })).stdout).toContain("no browser · ไม่ใช้เบราว์เซอร์");
    expect((await run(home, args, { LANG: "th_TH.UTF-8" })).stdout).toContain("ไม่ใช้เบราว์เซอร์");
    expect((await run(home, args, { LC_ALL: "th_TH.UTF-8" })).stdout).toContain("เสนอ — the turn runs");
    expect((await run(home, args, { LANG: "en_US.UTF-8" })).stdout).not.toMatch(THAI);
    expect((await run(home, args, { MIND_LANG: "en", LANG: "th_TH.UTF-8" })).stdout).not.toMatch(THAI);
  }, 120_000);
});

describe("the sensitive-action approval line", () => {
  /** What the container wrote: the English meaning with the Thai after it (`classifyAction`). */
  const ACTIONS: readonly ActionDescriptor[] = [
    { kind: "click", origin: "https://shop.example", role: "button", text: "Pay now" },
    { kind: "click", origin: "https://mail.example", role: "button", text: "Send" },
    { kind: "click", origin: "https://files.example", role: "button", text: "Delete repository" },
    { kind: "type", origin: "https://bank.example", role: "textbox", text: "Password", valueClass: "password" },
    { kind: "click", origin: "https://shop.example", role: "button", text: "I agree" },
    { kind: "click", origin: "https://shop.example", role: "button", text: "Agree and pay" },
    { kind: "click", origin: "https://shop.example", role: "button", text: "ชำระเงิน" },
    { kind: "teleport", origin: "https://x.example" },
    { kind: "click", origin: "", role: "button", text: "Submit" },
  ];

  test("what a held action's reasons say is English by default, however they were written", () => {
    for (const action of ACTIONS) {
      const written = classifyAction(action).reasons;
      expect(written.length, action.text ?? action.kind).toBeGreaterThan(0);
      for (const reason of reasonsIn(written)) expect(reason).not.toMatch(THAI);
      for (const reason of reasonsIn(written, "en")) expect(reason).not.toMatch(THAI);
    }
  });

  test("the English stays complete: the category, the origin and the rule that it waits survive", () => {
    const [reason] = reasonsIn(classifyAction(ACTIONS[0]!).reasons);
    expect(reason).toBe("paying or buying something on https://shop.example — it waits for a yes at every level (D-153)");
    const [first, second] = reasonsIn(classifyAction(ACTIONS[5]!).reasons);
    expect(first).toStartWith("paying or buying something on");
    expect(second).toStartWith("accepting terms or giving consent on");
  });

  test("with Thai chosen the Thai meaning follows the English, whichever form was written", () => {
    const written = classifyAction(ACTIONS[0]!).reasons;
    const expected = `paying or buying something · จ่ายเงิน on https://shop.example — it waits for a yes at every level (D-153)`;
    expect(reasonsIn(written, "th")).toEqual([expected]);
    // A record written in English alone (a later container) is given its Thai the same way.
    const english = "paying or buying something on https://shop.example — it waits for a yes at every level (D-153)";
    expect(reasonsIn([english], "th")).toEqual([expected]);
    expect(reasonsIn([expected], "en")).toEqual([english]);
    expect(reasonsIn(reasonsIn([english], "th"), "th")).toEqual([expected]);
  });

  test("a reason that names no category is left alone in both languages", () => {
    const odd = "it commits whatever the page holds on https://x.example — a form, a message or a dialog";
    expect(reasonsIn([odd], "en")).toEqual([odd]);
    expect(reasonsIn([odd], "th")).toEqual([odd]);
    expect(reasonsIn([], "th")).toEqual([]);
  });

  /** A task with one held action, the way the container leaves it, in a temporary HOME. */
  async function plantHeld(home: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const release = require("../../docker/browser/release.cjs") as { descriptorOf: (a: object) => object; digestOf: (d: object) => string };
    const tasks = join(home, "data", "mind", SUBJECT, "personal", "tasks");
    const outDir = join(home, "data", "mind", SUBJECT, "personal", "browser", "t-0000abcd");
    await mkdir(join(tasks, "t-0000abcd"), { recursive: true });
    await writeFile(join(tasks, "t-0000abcd", "task.json"), JSON.stringify({
      schema: TASK_SCHEMA, id: "t-0000abcd", subject: SUBJECT, goal: "g", dir: SOUL, cwd: home, status: "waiting", steps: [], allow: ["http://a.example:80"], operate: 2,
      budget: { turns: 5, minutes: 5, tokens: null }, used: { turns: 0, activeMs: 0, tokens: 0, tokensUnknown: 0 }, createdAt: "2026-10-05T00:00:00.000Z",
      via: "cli", backend: "claude-local", model: null, stepSeconds: 60, approvalSeconds: 600, statusAt: "2026-10-05T00:00:00.000Z", reason: null, plan: ["a"],
      result: null, runner: null, current: null, browser: { task: "t-0000abcd", port: 30_745 }, notes: [], generation: 1,
    } satisfies TaskRecord));
    const action = release.descriptorOf({ kind: "click", origin: "http://a.example:80", role: "button", text: "Pay now" });
    const verdict = classifyAction({ kind: "click", origin: "http://a.example:80", role: "button", text: "Pay now" });
    await mkdir(join(outDir, "pending"), { recursive: true });
    await writeFile(join(outDir, "pending", "a-11111111-2222-4333-8444-555555555555.json"), JSON.stringify({
      schema: HELD_SCHEMA, id: "a-11111111-2222-4333-8444-555555555555", action, digest: release.digestOf(action),
      rules: verdict.rules, categories: verdict.categories, reasons: verdict.reasons,
      filedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
  }

  test("`mind task show --json`: the reasons carry no Thai by default, and the Thai meaning when Thai is chosen", async () => {
    const home = await sandbox();
    await plantHeld(home);
    const args = ["task", "show", "t-0000abcd", SOUL, "--subject", "example", "--json"];
    const english = await run(home, args);
    expect(english.code, english.stderr).toBe(0);
    expect(english.all).not.toMatch(THAI);
    const shown = JSON.parse(english.stdout) as { approvals: { status: string; reasons: string[] }[] };
    expect(shown.approvals.map((a) => a.status)).toEqual(["pending"]);
    expect(shown.approvals[0]!.reasons[0]).toStartWith("paying or buying something on http://a.example:80");
    const thai = await run(home, args, { MIND_LANG: "th" });
    expect((JSON.parse(thai.stdout) as { approvals: { reasons: string[] }[] }).approvals[0]!.reasons[0]).toContain("paying or buying something · จ่ายเงิน on");
  }, 60_000);
});

describe("the console's settings", () => {
  test("the page itself carries no Thai", () => {
    expect(PAGE_HTML).not.toMatch(THAI);
  });

  test("the browser's sentence: English alone, or with its Thai, and every Thai string is still built", () => {
    for (const level of LEVELS) {
      const both = operateSentence(level);
      expect(both.th).toBe(OPERATE_MEANING[level].th);
      expect(JSON.stringify(inLanguage(both, "en"))).not.toMatch(THAI);
      expect(inLanguage(both, "en")).toEqual({ level, title: both.title, en: OPERATE_MEANING[level].en });
      expect(inLanguage(both, "th")).toEqual(both);
    }
  });

  /** Start `mind web` on a free port, read what its two JSON routes say, and stop it. */
  async function readPage(extra: Record<string, string>): Promise<{ state: unknown; settings: unknown; page: string }> {
    const home = await sandbox();
    const soul = join(home, "agent", "soul");
    await cp(SOUL, soul, { recursive: true });
    const keyFile = join(home, "web.key");
    const child = Bun.spawn([BUN, "run", BIN, "web", soul, "--subject", "example", "--port", "0", "--key-file", keyFile], {
      cwd: ROOT, env: bareEnv(home, extra), stdout: "pipe", stderr: "ignore", stdin: "ignore",
    });
    const out = { text: "" };
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) out.text += decoder.decode(chunk, { stream: true });
    })();
    try {
      const started = await waitFor(() => out.text.includes("Ctrl-C stops the page") || child.exitCode !== null);
      expect(started, out.text).toBe(true);
      const base = /http:\/\/127\.0\.0\.1:\d+/.exec(out.text)?.[0];
      expect(base, out.text).toBeDefined();
      const key = (await readFile(keyFile, "utf8")).trim();
      const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { "x-mind-token": key } })).text();
      return { state: JSON.parse(await get("/api/state")), settings: JSON.parse(await get("/api/settings")), page: await get("/") };
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await reading;
    }
  }

  test("`mind web`: /api/state, /api/settings and the page have no Thai letters by default", async () => {
    const seen = await readPage({});
    const all = JSON.stringify(seen.state) + JSON.stringify(seen.settings) + seen.page;
    expect(all).not.toMatch(THAI);
    const state = seen.state as { autonomy: { operate: { en: string; th?: string } } };
    expect(state.autonomy.operate.en).toBe("no browser");
    expect("th" in state.autonomy.operate).toBe(false);
    expect((seen.settings as { operate: { en: string } }).operate.en).toBe(OPERATE_MEANING[0].en);
  }, 60_000);

  test("`mind web` with MIND_LANG=th: the same two routes carry the Thai half", async () => {
    const seen = await readPage({ MIND_LANG: "th" });
    const state = seen.state as { autonomy: { operate: { en: string; th: string } } };
    expect(state.autonomy.operate.th).toBe(OPERATE_MEANING[0].th);
    expect((seen.settings as { operate: { th: string } }).operate.th).toBe(OPERATE_MEANING[0].th);
    // The page is the same file either way: the Thai is data from the server, not text in the page.
    expect(seen.page).not.toMatch(THAI);
  }, 60_000);
});
