/** D-060 — the page's words, and the server's guards and routes, with no real CLI behind it. */

import { afterEach, describe, expect, test } from "bun:test";
import { PAGE_HTML } from "../../src/web/page.ts";
import { ALREADY_RUNNING, ASK_BUSY, MEMORY_ASK_TIMEOUT_MS, askAnswer, allowedHosts, handler, pairingLink, recallOf, sameToken, startWeb, tailnetNames, TOKEN_HEADER, type KeyControl, type WebDeps } from "../../src/web/server.ts";
import { keyPrint } from "../../src/web/key.ts";
import { ago, approvalLists, excerpt, levelSentence, operateSentence, remoteForPage, triageChips, type AgentInfo, type SettingsState, type ViewState } from "../../src/web/view.ts";
import type { Triage } from "../../src/decide/triage.ts";
import { claimRefile, decideProposal, describeProposal, findProposal, readProposals, writeProposal, type Proposal } from "../../src/decide/proposals.ts";
import { subjectId } from "../../src/types.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_ANSWER_MAX_CHARS } from "../../src/memory/ask.ts";
import { waitFor } from "../support/wait.ts";

const STATE: ViewState = {
  agent: { name: "Keeper", role: "keeps things", subject: "example", dir: "/a" },
  autonomy: { title: "Asks you first", detail: "d", tone: "ask", levels: { read: 1, write: 1, run: 1, reach: 1, operate: 0 }, operate: operateSentence(0) },
  stopped: false,
  waiting: [],
  approved: [],
  refileable: [],
  needsReapproval: [],
  triggers: [],
  tasks: [],
  taskApprovals: [],
  recent: [],
  canTriage: false, version: { current: "0.6.1", latest: "0.7.0" },
  engine: { chain: ["claude", "codex", "ollama"], localModel: "qwen3.8:27b", judge: "qwen3.8:27b", last: { backend: "claude", model: null, modelRequested: null, when: "just now" } },
};

const SETTINGS: SettingsState = {
  levels: { read: 1, write: 3, run: 0, reach: 1, operate: 1 },
  operate: operateSentence(1),
  stopped: false,
  backends: [{ id: "ollama", available: true }, { id: "claude", available: false }],
  defaultTurn: { backend: "ollama", model: null },
  chatUsers: [{ platform: "telegram", userId: "42", label: "me", told: true, added: "just now" }],
  peers: [{ name: "fern", endpoint: "http://127.0.0.1:1/", added: "yesterday" }],
  guards: { judge: "qwen", triage: false, needles: 2 },
  version: { current: "0.4.0", latest: "0.4.0", checked: "just now" },
};

const AGENT: AgentInfo = {
  ok: true, problems: [], name: "Keeper", role: "keeps things", subject: "example", dir: "/a",
  repo: { remote: null, web: null, head: "abc1234", lastCommit: "first", lastCommitAt: "just now" },
  prohibitions: ["never lies"], scope: { does: "d", doesNot: "n" },
  person: { tone: ["warm"], addressesUserAs: "you", refersToSelfAs: ["I"], principles: ["p"], inheritsFrom: [] },
  roleNotes: "r", personNotes: "q", stats: { memories: 1, turns: 0, lastTurn: null, byBackend: [] },
};

const PROFILE = { name: "Keeper", role: "keeps", does: "d", doesNot: "n", prohibitions: ["never lies"], tone: ["warm"], addressesUserAs: "you", refersToSelfAs: ["I"], principles: [], inheritsFrom: [], roleNotes: "", personNotes: "" };

function fakeDeps() {
  const runs: (readonly string[])[] = [];
  const deps: WebDeps = {
    dir: "/a",
    subject: "example",
    turnFlags: ["--backend", "ollama"],
    state: async () => STATE,
    settings: async () => SETTINGS,
    agent: async () => AGENT,
    memories: async () => [{ path: "memory/a.md", title: "A", description: "d", type: "project", bytes: 10, modified: "t", kind: "memory", tags: ["infra"] }],
    memoryImport: async (source, write) => {
      runs.push(["memory", "import", source.kind === "url" ? source.url : `${source.name}:${new TextDecoder().decode(source.bytes)}`, write ? "--yes" : "(dry)"]);
      return { code: 0, stdout: "new memory/imported/x.md", stderr: "" };
    },
    models: async () => ({ backends: [{ id: "claude", available: true }, { id: "ollama", available: true }, { id: "kimi", available: false }], chain: ["claude", "codex", "ollama"], defaultTurn: { backend: null, model: null }, models: { claude: ["opus", "sonnet", "haiku"], ollama: ["qwen3.8:27b"], kimi: [] } }),
    memoryGraph: async () => ({ nodes: [{ path: "memory/a.md", title: "A", type: "project", bytes: 10, kind: "memory", tags: ["infra"] }, { path: "memory/knowledge/b.md", title: "B", type: "", bytes: 5, kind: "knowledge", tags: [] }], edges: [[0, 1, 2]], dangling: 1, entities: [{ type: "port", value: "10410", count: 2 }], mentions: [[0, 0], [0, 1]] }),
    memoryWho: async (thing) => (thing === "10410" ? [{ type: "port" as const, value: "10410", mentions: [{ path: "memory/a.md", title: "A", line: 3, excerpt: "vLLM on :10410" }] }] : []),
    memory: async (path) => (path === "memory/a.md" ? { ok: true, text: "hello" } : { ok: false, reason: "not a memory file" }),
    memoryWrite: async (path, content) => {
      runs.push(["memory", "write", path, content]);
      return { code: 0, stdout: "written", stderr: "" };
    },
    privacy: async () => ({ capture: { on: true, lines: ["capture: on since x"] }, keptIn: [{ when: "now", at: "t", backend: "claude", why: "personal needle #1" }], keptInTotal: 1, needles: 9, judge: "qwen", basis: [{ id: "d858fe8c", basis: "owner", uses: ["memory"], approvedBy: "me", at: "2026-09-25", expires: null, state: "active", note: "" }] }),
    turnDetail: async (tid) => (tid === "11111111-2222-3333-4444-555555555555" ? { asked: "q", answer: "a", backend: "claude", model: null, modelRequested: null, when: "just now", content: "full" } : undefined),
    profile: async () => ({ ok: true, profile: PROFILE }),
    editProfile: async (profile, write) => {
      runs.push(["soul", "edit", write ? "--yes" : "(dry)", profile.name]);
      return { code: 0, stdout: write ? "Written: name." : "would change: name", stderr: "" };
    },
    run: async (args) => {
      runs.push(args);
      if (args[0] === "turn") return { code: 0, stdout: JSON.stringify({ text: "hi", route: "answered by ollama", proposals: [] }), stderr: "" };
      return { code: 0, stdout: "", stderr: "mind: done\n" };
    },
  };
  return { deps, runs };
}

const HOSTS = allowedHosts("127.0.0.1", 30701);
const req = (path: string, init: RequestInit & { token?: string | null; host?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? "127.0.0.1:30701");
  if (init.token !== null) headers.set(TOKEN_HEADER, init.token ?? "tok");
  return new Request(`http://127.0.0.1:30701${path}`, { ...init, headers });
};

describe("words", () => {
  test("each level, and the brake above all of them", () => {
    expect(levelSentence(1, false).title).toBe("Asks you first");
    expect(levelSentence(0, false).tone).toBe("stop");
    expect(levelSentence(2, false).title).toBe("Acts, then tells you");
    expect(levelSentence(3, false).title).toBe("Acts on its own");
    const stopped = levelSentence(3, true);
    expect(stopped.title).toBe("Stopped");
    expect(stopped.detail).toContain("mind autonomy resume");
  });

  test("triage chips in plain words, with doubt said", () => {
    const t = (choice: Triage["risk"]["choice"], confidence: number, reversible: number, personal: number): Triage => ({
      proposal: "p", at: "", model: "m", risk: { choice, confidence, probabilities: {} }, reversible, personal,
    });
    expect(triageChips(t("destructive", 1, 0.1, 0.7)).map((c) => c.text)).toEqual(["Deletes or can't be undone", "Hard to undo", "Touches private info"]);
    expect(triageChips(t("read-only", 0.5, 0.9, 0.1)).map((c) => c.text)).toEqual(["Only looks (unsure)", "Can be undone"]);
    expect(triageChips(t("external", 0.9, 0.9, 0.1))[0]!.tone).toBe("care");
  });

  test("times as a person says them, and one-line excerpts", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(ago("2026-09-24T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-09-24T11:30:00Z", now)).toBe("30 min ago");
    expect(ago("2026-09-24T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-09-23T10:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-09-20T12:00:00Z", now)).toBe("4 days ago");
    expect(ago("2026-08-01T12:00:00Z", now)).toBe("2026-08-01");
    expect(ago("2026-09-24T12:10:00Z", now)).toBe("in 10 min");
    expect(ago("2026-09-25T12:00:00Z", now)).toBe("in 24 h");
    expect(ago("2026-09-30T12:00:00Z", now)).toBe("in 6 days");
    expect(ago("nonsense", now)).toBe("nonsense");
    expect(excerpt(null)).toBe("(not kept)");
    expect(excerpt("line one\nline two")).toBe("line one");
    expect(excerpt("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("the page puts server values in with textContent, never as HTML, and loads nothing remote", () => {
    expect(PAGE_HTML).not.toContain("innerHTML");
    expect(PAGE_HTML).not.toMatch(/(src|href)=["']https?:/);
    expect(PAGE_HTML).toContain("Only in the terminal");
  });

  test("the judge's line in Settings says what is true since D-181: a note each time without it, MIND_OLLAMA_MODEL as a way on, and nothing to read until words are listed", () => {
    expect(PAGE_HTML).toContain("still goes, with a note each time that only the filter looked");
    expect(PAGE_HTML).toContain("Set MIND_OLLAMA_MODEL (or MIND_EGRESS_JUDGE) to a model on this computer to turn it on; chat apps need MIND_EGRESS_JUDGE.");
    expect(PAGE_HTML).toContain("It has nothing to read against until personal words are listed.");
    expect(PAGE_HTML).not.toContain("Off. Set MIND_EGRESS_JUDGE to a local model to turn it on — chat apps need it.");
  });
});

describe("the token header", () => {
  test("x-mind-token carries the key; a wrong or missing one is refused", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const bare = (headers: Record<string, string>) =>
      new Request("http://127.0.0.1:30701/api/state", { headers: { host: "127.0.0.1:30701", ...headers } });
    expect((await h(bare({ "x-mind-token": "tok" }))).status).toBe(200);
    expect((await h(bare({ "x-mind-token": "wrong" }))).status).toBe(401);
    expect((await h(bare({}))).status).toBe(401);
  });

  test("the page sends the header the engine emits, and no other", () => {
    expect(PAGE_HTML).toContain(`"${TOKEN_HEADER}": token`);
  });
});

describe("guards", () => {
  test("a wrong Host is refused (DNS rebinding), and the API needs the token", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect((await h(req("/api/state", { host: "evil.example:30701" }))).status).toBe(421);
    expect((await h(req("/api/state", { token: null }))).status).toBe(401);
    expect((await h(req("/api/state", { token: "wrong" }))).status).toBe(401);
    expect((await h(req("/api/state"))).status).toBe(200);
    expect(allowedHosts("100.1.2.3", 9)).toEqual(["100.1.2.3:9"]);
    expect(allowedHosts("100.1.2.3", 9, ["Box.tail1.ts.net", "box", "100.1.2.3"])).toEqual(["100.1.2.3:9", "box.tail1.ts.net:9", "box:9"]);
    const named = handler(deps, "tok", allowedHosts("100.1.2.3", 30701, ["box.tail1.ts.net"]));
    expect((await named(req("/api/state", { host: "box.tail1.ts.net:30701" }))).status).toBe(200);
    expect((await named(req("/api/state", { host: "other.tail1.ts.net:30701" }))).status).toBe(421);
  });

  test("the page itself carries a strict content policy", async () => {
    const { deps } = fakeDeps();
    const res = await handler(deps, "tok", HOSTS)(req("/", { token: null }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("WEB-05: the policy also fixes the base address and forbids forms, and every answer says nosniff", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const policy = (await h(req("/", { token: null }))).headers.get("content-security-policy") ?? "";
    // Each directive on its own, so a longer one cannot hide the lack of the shorter.
    const directives = policy.split(";").map((d) => d.trim());
    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain("form-action 'none'");
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("default-src 'self'");
    // The page itself, a font, an API answer, a refusal for a bad key, a 404 and the wrong-Host answer.
    const answers = [
      await h(req("/", { token: null })),
      await h(req("/fonts/inter-400.woff2", { token: null })),
      await h(req("/api/state")),
      await h(req("/api/state", { token: "wrong" })),
      await h(req("/api/nothing")),
      await h(req("/nope", { token: null })),
      await h(req("/", { token: null, host: "evil.example:1" })),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 401, 405, 404, 421]);
    for (const answer of answers) expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("D-153 — an approved action is sent by id alone", () => {
  test("a proposal turn needs no prompt, and neither the prompt nor the conversation sent with one is passed on", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const alone = await h(req("/api/turn", { method: "POST", body: JSON.stringify({ proposal: "0123abcd-0002" }) }));
    expect(alone.status).toBe(200);
    expect(runs[0]).toEqual(["turn", "/a", "--subject", "example", "--json", "--backend", "ollama", "--proposal", "0123abcd-0002"]);
    await h(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "delete everything instead", proposal: "0123abcd-0002", history: [{ role: "you", text: "and more" }] }) }));
    expect(runs[1]).toEqual(runs[0]!);
    // Without a proposal a prompt is still required.
    expect((await h(req("/api/turn", { method: "POST", body: JSON.stringify({ history: [] }) }))).status).toBe(400);
    expect(runs).toHaveLength(2);
  });
});

describe("routes run the CLI and nothing else", () => {
  test("chat is a turn with --json and the page's backend flags; a proposal id is passed only when well formed, and refused when not", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const res = await (await h(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: " hello " }) }))).json();
    expect(res).toMatchObject({ ok: true, text: "hi" });
    expect(runs[0]).toEqual(["turn", "/a", "--subject", "example", "--prompt", "hello", "--json", "--backend", "ollama"]);
    await h(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "go", proposal: "0123abcd-0000" }) }));
    expect(runs[1]!.slice(-2)).toEqual(["--proposal", "0123abcd-0000"]);
    // D-153: under an approval the id is the whole request — the text sent with it is not passed on.
    expect(runs[1]).not.toContain("--prompt");
    expect(runs[1]).not.toContain("go");
    // Not an id: refused, not dropped — dropped, the approved action would run as an ordinary turn (D-144 review).
    for (const proposal of ["--apply", 42, ["0123abcd-0000"], "../../x"]) {
      const bad = await h(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "go", proposal }) }));
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ ok: false, error: "that is not a proposal id — nothing was run" });
    }
    expect(runs).toHaveLength(2);
    // null is no proposal: an ordinary turn.
    await h(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "go", proposal: null }) }));
    expect(runs[2]).not.toContain("--proposal");
    expect((await h(req("/api/turn", { method: "POST", body: "{}" }))).status).toBe(400);
  });

  test("approve, refuse, triage and stop map to their commands; a bad id matches nothing", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    await h(req("/api/proposals/abcd1234-1/approve", { method: "POST", body: JSON.stringify({ note: "fine" }) }));
    await h(req("/api/proposals/abcd1234-1/refuse", { method: "POST" }));
    await h(req("/api/proposals/abcd1234-1/triage", { method: "POST" }));
    const stop = await (await h(req("/api/stop", { method: "POST" }))).json();
    expect(runs).toEqual([
      ["proposal", "decide", "abcd1234-1", "/a", "--subject", "example", "--approve", "--note", "fine"],
      ["proposal", "decide", "abcd1234-1", "/a", "--subject", "example", "--refuse"],
      ["proposal", "triage", "abcd1234-1", "/a", "--subject", "example"],
      ["stop", "/a", "--subject", "example"],
    ]);
    expect(stop).toEqual({ ok: true, message: "done" });
    expect((await h(req("/api/proposals/..%2Fx/approve", { method: "POST" }))).status).toBe(404);
    expect((await h(req("/api/state", { method: "DELETE" }))).status).toBe(405);
    expect((await h(req("/nope"))).status).toBe(404);
  });

  test("a refusal answers with the line that says it was refused, not with the list of earlier refusals (B6)", async () => {
    const deps: WebDeps = {
      ...fakeDeps().deps,
      run: async () => ({
        code: 0,
        stdout: "abcd1234-1 refused by the owner at 2026-10-14T10:00:00.000Z\n",
        stderr: "\n1 thing(s) this subject has been refused, newest first:\n  abcd1234-1  tidy\n  Printed in full on every run.\n",
      }),
    };
    const refused = await (await handler(deps, "tok", HOSTS)(req("/api/proposals/abcd1234-1/refuse", { method: "POST" }))).json();
    expect(refused).toEqual({ ok: true, message: "abcd1234-1 refused by the owner at 2026-10-14T10:00:00.000Z" });
    // Approving keeps the guidance the command prints on stderr ("Good for one turn …").
    const approving: WebDeps = { ...deps, run: async () => ({ code: 0, stdout: "x approved by the owner at t\n", stderr: "  Good for one turn, and for this action only.\n" }) };
    const approved = await (await handler(approving, "tok", HOSTS)(req("/api/proposals/abcd1234-1/approve", { method: "POST" }))).json();
    expect(approved).toEqual({ ok: true, message: "Good for one turn, and for this action only." });
  });

  test("a turn that printed no JSON comes back as a sentence, not a crash", async () => {
    const deps: WebDeps = {
      ...fakeDeps().deps,
      run: async () => ({ code: 4, stdout: "", stderr: "mind: nothing was sent — the autonomy dial is at 0 for this turn.\n" }),
    };
    const res = await (await handler(deps, "tok", HOSTS)(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }))).json();
    expect(res).toEqual({ ok: false, error: "nothing was sent — the autonomy dial is at 0 for this turn." });
  });
});

describe("an approved proposal runs once — one turn per proposal at the door (D-144)", () => {
  /** Deps whose `turn` for `held` waits until released, and a record of every CLI started. */
  function heldTurn(held: string) {
    const base = fakeDeps();
    const started: (readonly string[])[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const deps: WebDeps = {
      ...base.deps,
      run: async (args) => {
        started.push(args);
        if (args[0] === "turn" && args.includes(held)) {
          entered();
          await gate;
        }
        return base.deps.run(args);
      },
    };
    return { deps, started, release, inside };
  }
  const turnFor = (proposal?: string) =>
    req("/api/turn", { method: "POST", body: JSON.stringify(proposal === undefined ? { prompt: "hello" } : { prompt: "delete the old logs", proposal }) });

  test("two calls at once for one proposal: one runs, the other is 409 and starts no CLI", async () => {
    const { deps, started, release, inside } = heldTurn("0123abcd-0001");
    const h = handler(deps, "tok", HOSTS);

    const first = h(turnFor("0123abcd-0001"));
    await inside; // the first one's CLI is running now
    const second = await h(turnFor("0123abcd-0001"));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ ok: false, error: ALREADY_RUNNING });
    expect(ALREADY_RUNNING).toStartWith("Already running");
    expect(started).toHaveLength(1);

    // Only that proposal is held: another one, and ordinary chat, go ahead meanwhile.
    expect((await h(turnFor("0123abcd-0002"))).status).toBe(200);
    expect((await h(turnFor())).status).toBe(200);
    expect(started.map((args) => args.includes("0123abcd-0001"))).toEqual([true, false, false]);

    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, text: "hi" });

    // Back, and so free again at this door. Whether it may run again is the
    // engine's to say — and it says no: the approval was claimed once.
    expect((await h(turnFor("0123abcd-0001"))).status).toBe(200);
    expect(started.filter((args) => args.includes("0123abcd-0001"))).toHaveLength(2);
  });

  test("a turn that throws frees its proposal, so the door does not stay shut", async () => {
    const base = fakeDeps();
    let calls = 0;
    const deps: WebDeps = {
      ...base.deps,
      run: async (args) => {
        calls += 1;
        if (calls === 1) throw new Error("the child could not start");
        return base.deps.run(args);
      },
    };
    const h = handler(deps, "tok", HOSTS);
    await expect(h(turnFor("0123abcd-0003"))).rejects.toThrow("the child could not start");
    expect((await h(turnFor("0123abcd-0003"))).status).toBe(200);
  });

  test("a turn under an approval that failed with no answer says why as its error — the page and the app show it (D-144 review)", async () => {
    const spentLine = "mind: proposal 0123abcd-0001 stays spent — turn t took its approval and nothing was sent (D-144). To run it again, file it again.";
    const deps: WebDeps = {
      ...fakeDeps().deps,
      run: async () => ({
        code: 1,
        stdout: JSON.stringify({ text: "", route: "no backend answered · 0.0s", backend: "ollama", proposals: [] }),
        stderr: `no backend answered · 0.0s\n${spentLine}\n`,
      }),
    };
    const h = handler(deps, "tok", HOSTS);
    const withProposal = (await (await h(turnFor("0123abcd-0001"))).json()) as { ok: boolean; text: string; error: string };
    expect(withProposal.ok).toBe(false);
    expect(withProposal.text).toBe("");
    // Its last line is what became of the approval.
    expect(String(withProposal.error).split("\n").at(-1)).toBe(spentLine.replace(/^mind:\s*/, ""));
    // An ordinary turn keeps its shape: the reason is in notes, which the page now shows when a turn fails.
    const plain = (await (await h(turnFor())).json()) as { ok: boolean; error?: string; notes: string };
    expect(plain.ok).toBe(false);
    expect(plain.error).toBeUndefined();
    expect(plain.notes).toContain("no backend answered");
  });

  test("a turn's own --json notes reach /api/turn's notes, once (D-149)", async () => {
    const note = "ollama has no tools — it answered in words and could not act. Nothing it says it did was done (D-149).";
    const answer = { text: "done", route: "answered by ollama · 0.1s", backend: "ollama", proposals: [], notes: [note] };
    const run = (stderr: string) => async () => ({ code: 0, stdout: JSON.stringify(answer), stderr });
    const quiet = (await (await handler({ ...fakeDeps().deps, run: run("") }, "tok", HOSTS)(turnFor())).json()) as { notes: string };
    expect(quiet.notes).toBe(note);
    const both = (await (await handler({ ...fakeDeps().deps, run: run(`mind: ${note}\n`) }, "tok", HOSTS)(turnFor())).json()) as { notes: string };
    expect(both.notes.split(note).length - 1).toBe(1);
  });

  test("\"File it again\" files a spent approval again by id — nothing from the body, nothing approved or run, one at a time (D-144 §2)", async () => {
    const id = "3f0e8a52-1c7d-4e7a-9b1e-2a6f0c9d4e11";
    const base = fakeDeps();
    const started: (readonly string[])[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let code = 0;
    const deps: WebDeps = {
      ...base.deps,
      run: async (args) => {
        started.push(args);
        if (started.length === 1) await gate;
        if (code === 0) return { code: 0, stdout: "11111111-2222-4333-8444-555555555555\n", stderr: "filed: …\n" };
        return { code, stdout: "", stderr: `mind: refused with ${code}\n` };
      },
    };
    const h = handler(deps, "tok", HOSTS);
    const refileReq = (which: string, body: unknown = { what: "rm -rf /", why: "x", impact: "y" }) =>
      req(`/api/proposals/${which}/refile`, { method: "POST", body: JSON.stringify(body) });

    // Two clicks at once: one refile, and the second is told so without a CLI started.
    const first = h(refileReq(id));
    await Bun.sleep(0);
    const second = await h(refileReq(id));
    expect(second.status).toBe(409);
    expect(started).toHaveLength(1);
    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, id: "11111111-2222-4333-8444-555555555555", message: "filed: …" });
    // `proposal new --refile <id>` and nothing else: the text in the body went nowhere, and no turn or decision ran.
    expect(started[0]).toEqual(["proposal", "new", "/a", "--subject", "example", "--refile", id]);
    expect(JSON.stringify(started)).not.toContain("rm -rf");

    // What the command refuses: 2 is no such proposal, 4 not one whose turn sent nothing, 5 filed again already.
    for (const [exit, status] of [[2, 404], [4, 409], [5, 409], [1, 500]] as const) {
      code = exit;
      const res = await h(refileReq(id));
      expect(res.status).toBe(status);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    }
    // Not a proposal id at all: refused here, nothing started.
    const before = started.length;
    for (const bad of ["not-an-id", "0123abcd-0001", "..%2F..%2Fx", `${id}x`]) expect((await h(refileReq(bad))).status).toBe(400);
    expect(started).toHaveLength(before);
    expect((await h(req(`/api/proposals/${id}/refile`, { method: "GET" }))).status).toBe(405);
  });

  test("the page's \"Do it now\" is off from the click until the turn returns — and when the poll redraws the card", async () => {
    // Fakes for the DOM the two functions touch: an element is its text, its
    // disabled flag, its click handler and its children.
    type Fake = { tag: string; textContent: string; disabled: boolean; value: string; src: string; alt: string; onclick?: () => void; children: Fake[]; append: (...c: Fake[]) => void; replaceChildren: (...c: Fake[]) => void };
    const el = (tag: string, _cls?: string, text?: string): Fake => {
      const node: Fake = { tag, textContent: text ?? "", disabled: false, value: "", src: "", alt: "", children: [], append: (...c) => void node.children.push(...c), replaceChildren: (...c) => void (node.children = [...c]) };
      return node;
    };
    const nodes = new Map<string, Fake>();
    const $ = (id: string) => nodes.get(id) ?? nodes.set(id, el("div")).get(id)!;
    const document = { querySelector: () => ({ src: "logo" }), createTextNode: (t: string) => el("#text", "", t), body: { classList: { add: () => undefined, remove: () => undefined } } };
    const toasts: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    let answer!: (value: Record<string, unknown>) => void;
    const paths: string[] = [];
    const api = (path: string, body: Record<string, unknown>) => {
      paths.push(path);
      bodies.push(body);
      return new Promise<Record<string, unknown>>((resolve) => (answer = resolve));
    };

    const pick = (pattern: RegExp) => {
      const source = pattern.exec(PAGE_HTML)?.[0];
      expect(source).toBeDefined();
      return source!;
    };
    const bubbles: [string, string][] = [];
    const page = new Function(
      "$", "el", "document", "toast", "api", "bubble",
      `const runningProposals = new Set(); const chatLog = []; const closeMenu = () => {}; const runCommand = async () => {};
       const refilingProposals = new Set(); const choice = () => ({}); const turnLine = () => ""; const refresh = async () => {};
       ${pick(/async function send\(text, proposal\) \{[\s\S]*?\n  \}\n/)}
       ${pick(/function renderApproved\(items, again, legacy\) \{[\s\S]*?\n  \}\n/)}
       ${pick(/async function refile\(p, button\) \{[\s\S]*?\n  \}\n/)}
       return { send, renderApproved, runningProposals };`,
    )($, el, document, (t: string) => toasts.push(t), api, (cls: string, text: string) => void bubbles.push([cls, text])) as {
      send: (text: string, proposal?: string) => Promise<void>;
      renderApproved: (
        items: readonly { id: string; what: string; decided: string }[],
        again?: readonly { id: string; what: string; spent: string }[],
        legacy?: readonly { id: string; what: string; approved: string; approvedAt: string; reason: "no-action" | "changed" }[],
      ) => void;
      runningProposals: Set<string>;
    };
    const card = [{ id: "0123abcd-0001", what: "delete the old logs", decided: "just now" }];
    const button = () => $("approved").children[1]!.children[2]!.children[0]!;

    page.renderApproved(card);
    expect(button().textContent).toBe("Do it now");
    expect(button().disabled).toBe(false);

    button().onclick!();
    // Off the moment it is clicked, before anything has come back.
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Running…");
    // D-153: the id alone — the turn builds the prompt from the record.
    expect(bodies).toEqual([{ proposal: "0123abcd-0001" }]);

    // The page polls every few seconds and draws the card again: still off.
    page.renderApproved(card);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Running…");
    // And `/do` — or anything else that calls send — is held the same way.
    await page.send("delete the old logs", "0123abcd-0001");
    expect(toasts).toEqual(["Already running — it runs once."]);
    expect(bodies).toHaveLength(1);

    answer({ ok: true, text: "done" });
    await Bun.sleep(0);
    expect(page.runningProposals.size).toBe(0);
    page.renderApproved(card);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Do it now");
    expect(bubbles.at(-1)).toEqual(["it", "done"]);

    // A turn that failed says why (D-144 review): as the error when there was no answer…
    bubbles.length = 0;
    const failed = page.send("delete the old logs", "0123abcd-0001");
    answer({ ok: false, text: "", error: "proposal 0123abcd-0001 stays spent — …" });
    await failed;
    expect(bubbles).toEqual([["me", "delete the old logs"], ["it", "proposal 0123abcd-0001 stays spent — …"]]);
    // …and beside the answer when there was one, instead of dropping it.
    bubbles.length = 0;
    const ran = page.send("delete the old logs", "0123abcd-0001");
    answer({ ok: false, text: "deleted", notes: "proposal 0123abcd-0001 was spent by this turn and it ran — ollama answered, and the ledger did not record it." });
    await ran;
    expect(bubbles).toEqual([
      ["me", "delete the old logs"],
      ["it", "deleted"],
      ["sys", "proposal 0123abcd-0001 was spent by this turn and it ran — ollama answered, and the ledger did not record it."],
    ]);

    // D-144 §2 — "File it again", offered only for what the state lists as sent-nothing, never beside "Do it now".
    page.renderApproved([], []);
    expect($("approved").children).toEqual([]);
    const spentId = "3f0e8a52-1c7d-4e7a-9b1e-2a6f0c9d4e11";
    const spentCard = [{ id: spentId, what: "delete the old logs", spent: "just now" }];
    page.renderApproved([], spentCard);
    const again = () => $("approved").children[1]!.children[2]!.children[0]!;
    expect(again().textContent).toBe("File it again");
    expect(again().disabled).toBe(false);
    expect(JSON.stringify($("approved").children)).not.toContain("Do it now");

    paths.length = 0;
    bodies.length = 0;
    again().onclick!();
    expect(again().disabled).toBe(true);
    expect(again().textContent).toBe("Filing…");
    // The id is the whole request: no text goes with it.
    expect(paths).toEqual([`/api/proposals/${spentId}/refile`]);
    expect(bodies).toEqual([{}]);
    // Redrawn while it is filing: still off; and a second click sends nothing.
    page.renderApproved([], spentCard);
    expect(again().disabled).toBe(true);
    again().onclick!();
    expect(paths).toHaveLength(1);
    answer({ ok: true, id: "new-id" });
    await Bun.sleep(0);
    expect(toasts.at(-1)).toBe("Filed again — it waits for your yes.");

    // D-153 follow-up — an approval from before approvals named their action: never "Do it now", one button that
    // files it again by id for a new yes, through the same route; nothing goes with it, nothing is approved or run.
    const oldId = "6b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
    const oldCard = [{ id: oldId, what: "read the real state of the server", approved: "yesterday", approvedAt: "2026-10-04T18:11:37.997Z", reason: "no-action" as const }];
    page.renderApproved([], [], oldCard);
    const card0 = $("approved").children[0]!;
    expect(card0.children[1]!.textContent).toBe("Approved before approvals named their action — approve it again · allowed yesterday");
    const reask = () => $("approved").children[0]!.children[2]!.children[0]!;
    expect(reask().textContent).toBe("File it again for a yes");
    expect(reask().disabled).toBe(false);
    const drawn = JSON.stringify($("approved").children);
    expect(drawn).not.toContain("Do it now");
    expect(drawn).not.toContain("Running");
    paths.length = 0;
    bodies.length = 0;
    reask().onclick!();
    expect(reask().disabled).toBe(true);
    expect(reask().textContent).toBe("Filing…");
    expect(paths).toEqual([`/api/proposals/${oldId}/refile`]);
    expect(bodies).toEqual([{}]);
    page.renderApproved([], [], oldCard);
    expect(reask().disabled).toBe(true);
    reask().onclick!();
    expect(paths).toHaveLength(1);
    answer({ ok: true, id: "newer-id" });
    await Bun.sleep(0);
    expect(toasts.at(-1)).toBe("Filed again — it waits for your yes.");
    // The next poll no longer lists it: the card is gone.
    page.renderApproved([], [], []);
    expect($("approved").children).toEqual([]);

    // Review of PR #29: a record changed after its yes. The refile copies the edited text, so the card frames it as
    // a new request, not as confirming what was approved.
    page.renderApproved([], [], [{ ...oldCard[0]!, reason: "changed" as const }]);
    expect($("approved").children[0]!.children[1]!.textContent).toBe("This text changed after your yes. Read it as a new request. · allowed yesterday");
    expect(JSON.stringify($("approved").children)).not.toContain("approve it again");
    expect($("approved").children[0]!.children[2]!.children[0]!.textContent).toBe("File it again for a yes");
    expect(JSON.stringify($("approved").children)).not.toContain("Do it now");
  });

  test("/api/state lists an approval that names no action apart — never runnable — and drops it once it is asked again (D-153 follow-up)", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-web-legacy-"));
    try {
      const dir = join(home, "proposals");
      await mkdir(dir, { recursive: true });
      const at = new Date("2026-10-05T12:00:00.000Z");
      const base = (id: string, what: string) => ({
        ...describeProposal({ id, subject: subjectId("example"), at: new Date("2026-10-04T18:10:51.504Z"), what, why: "w", impact: "i" }),
      });
      const decided = (p: Proposal) => {
        const d = decideProposal(p, { outcome: "approved", at: "2026-10-04T18:11:37.997Z", by: "the owner", note: null });
        if (typeof d === "string") throw new Error(d);
        return d;
      };
      const bound = decided(base("bound", "approved after D-153"));
      const withDigest = decided(base("old", "approved before D-153"));
      const { actionDigest: _, ...decision } = withDigest.decision!;
      const old = { ...withDigest, decision };
      // Review of PR #29: a digest that is empty, or names an action the record no longer holds, cannot run either.
      const blank = decided(base("blank", "a digest that is empty"));
      const moved = decided(base("moved", "a digest for something else"));
      for (const p of [bound, old, { ...blank, decision: { ...blank.decision!, actionDigest: "" } }, { ...moved, decision: { ...moved.decision!, actionDigest: "sha256:0000" } }]) {
        await writeProposal(dir, p);
      }

      const lists = approvalLists(await readProposals(dir), at);
      // "Do it now" is offered only for what `turn --proposal` would run.
      expect(lists.approved.map((p) => p.id)).toEqual(["bound"]);
      expect(lists.refileable).toEqual([]);
      const when = { approved: ago("2026-10-04T18:11:37.997Z", at), approvedAt: "2026-10-04T18:11:37.997Z" };
      expect([...lists.needsReapproval].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
        { id: "blank", what: "a digest that is empty", ...when, reason: "changed" },
        { id: "moved", what: "a digest for something else", ...when, reason: "changed" },
        { id: "old", what: "approved before D-153", ...when, reason: "no-action" },
      ]);

      // Filed again (the claim is what says so): in no list at all.
      expect((await claimRefile(findProposal(await readProposals(dir), "old")!, "new-one", at)).ok).toBe(true);
      const after = approvalLists(await readProposals(dir), at);
      expect(after.needsReapproval.map((p) => p.id).sort()).toEqual(["blank", "moved"]);
      expect(after.approved.map((p) => p.id)).toEqual(["bound"]);
      expect(after.refileable).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("listening", () => {
  const started: { stop: (force?: boolean) => Promise<void> }[] = [];
  afterEach(async () => {
    for (const s of started.splice(0)) await s.stop(true);
  });

  test("loopback by default, a fresh token each time, the token only in the fragment", async () => {
    const a = startWeb(fakeDeps().deps, { port: 0 });
    const b = startWeb(fakeDeps().deps, { port: 0 });
    started.push(a, b);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{32}$/);
    expect(a.token).not.toBe(b.token);
    const port = new URL(a.url).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { [TOKEN_HEADER]: a.token } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ViewState).agent.name).toBe("Keeper");
  });
});

describe("stopping (D-088)", () => {
  test("a stop lets a request already running finish and answer, and refuses new ones", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const { deps } = fakeDeps();
    const server = startWeb({ ...deps, memoryImport: async () => (await slow, { code: 0, stdout: "imported", stderr: "" }) }, { port: 0 });
    const port = new URL(server.url).port;
    const inFlight = fetch(`http://127.0.0.1:${port}/api/memory/import`, { method: "POST", headers: { [TOKEN_HEADER]: server.token, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.org/", write: true }) });
    // Wait for the request to be in flight rather than for 50 ms: on a loaded runner it may not have arrived yet.
    expect(await waitFor(() => server.pending() === 1)).toBe(true);
    let stopped = false;
    const stopping = server.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/api/state`, { headers: { [TOKEN_HEADER]: server.token } })).rejects.toThrow();
    release();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toBe("imported");
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("tailnet names", () => {
  test("the MagicDNS name and its first label; anything else is none", () => {
    expect(tailnetNames(JSON.stringify({ Self: { DNSName: "Box.tail1.ts.net." } }))).toEqual(["box.tail1.ts.net", "box"]);
    expect(tailnetNames(JSON.stringify({ Self: { DNSName: "box" } }))).toEqual(["box"]);
    expect(tailnetNames(JSON.stringify({ Self: {} }))).toEqual([]);
    expect(tailnetNames("not json")).toEqual([]);
  });

  test("startWeb shows the first name in the link", () => {
    const { deps } = fakeDeps();
    const server = startWeb(deps, { port: 0, names: ["box.tail1.ts.net"] });
    try {
      expect(server.url).toMatch(/^http:\/\/box\.tail1\.ts\.net:\d+\/#t=/);
      const tls = startWeb(deps, { port: 0, names: ["box.tail1.ts.net"], scheme: "https" });
      expect(tls.url).toMatch(/^https:\/\/box\.tail1\.ts\.net:\d+\/#t=/);
      void tls.stop(true);
    } finally {
      void server.stop(true);
    }
  });
});

describe("Settings (the page sets only what a command could, and nothing that needs a phrase)", () => {
  const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  test("GET /api/settings, behind the token", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect(await (await h(req("/api/settings"))).json()).toEqual(SETTINGS);
    expect((await h(req("/api/settings", { token: null }))).status).toBe(401);
  });

  test("a level of 0–2 is `autonomy set`; 3, or a category that is not one, runs nothing", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const ok = (await (await h(post("/api/autonomy", { category: "write", level: 2 }))).json()) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(runs).toEqual([["autonomy", "set", "write", "2", "/a", "--subject", "example"]]);
    for (const bad of [{ category: "write", level: 3 }, { category: "write", level: "2" }, { category: "all", level: 1 }, { category: "write" }]) {
      expect((await h(post("/api/autonomy", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(runs).toHaveLength(1);
  });

  test("D-153: operate is a category the page sets 0–2, and 3 is typed in a terminal", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const ok = (await (await h(post("/api/autonomy", { category: "operate", level: 1 }))).json()) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(runs).toEqual([["autonomy", "set", "operate", "1", "/a", "--subject", "example"]]);
    expect((await h(post("/api/autonomy", { category: "operate", level: 3 }))).status).toBe(400);
    expect(runs).toHaveLength(1);
  });

  test("D-153: /api/state and /api/settings carry the browser's level in force, in English and Thai; the page shows it", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const state = (await (await h(req("/api/state"))).json()) as ViewState;
    expect(state.autonomy.levels["operate"]).toBe(0);
    expect(state.autonomy.operate).toEqual({ level: 0, title: "No browser", en: "no browser", th: "ไม่ใช้เบราว์เซอร์" });
    const settings = (await (await h(req("/api/settings"))).json()) as SettingsState;
    expect(settings.operate.level).toBe(1);
    expect(settings.operate.th).toBe("ดูแล้วเสนอ — ไม่คลิก ไม่พิมพ์");
    expect(operateSentence(3).en).toContain("typed phrase");
    expect(operateSentence(2).title).toBe("Allowed sites only");
    for (const text of ['["operate", "Browser", "use a web browser for you"]', 'id="operateLine"', "/autonomy <read|write|run|reach|operate>"]) {
      expect(PAGE_HTML).toContain(text);
    }
    // GL-01: the page carries no Thai of its own — the Thai half comes from the server, when Thai is chosen.
    expect(PAGE_HTML).not.toMatch(/[\u0E00-\u0E7F]/);
  });

  test("removing a chat user or a peer is the remove command; adding has no route", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    await h(post("/api/chat-users/remove", { platform: "telegram", userId: "42" }));
    await h(post("/api/peers/remove", { name: "fern" }));
    expect(runs).toEqual([
      ["chat", "remove", "telegram", "42", "--subject", "example"],
      ["a2a", "remove", "fern", "--subject", "example"],
    ]);
    expect((await h(post("/api/chat-users/remove", { platform: "telegram", userId: "--subject" }))).status).toBe(400);
    expect((await h(post("/api/peers/remove", { name: "../x" }))).status).toBe(400);
    expect((await h(post("/api/chat-users/allow", { platform: "telegram", userId: "7" }))).status).toBe(404);
    expect((await h(post("/api/peers/allow", { name: "x" }))).status).toBe(404);
    expect(runs).toHaveLength(2);
  });

  test("update-check asks; the page's backend and model replace the start flags only when they are names", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    await h(post("/api/update-check", {}));
    expect(runs[0]).toEqual(["update", "--check"]);
    await h(post("/api/turn", { prompt: "hi", backend: "claude,ollama", model: "qwen3.8:27b" }));
    expect(runs[1]!.slice(-4)).toEqual(["--backend", "claude,ollama", "--model", "qwen3.8:27b"]);
    await h(post("/api/turn", { prompt: "hi", backend: "ollama --yes", model: "-x" }));
    expect(runs[2]!.slice(-2)).toEqual(["--backend", "ollama"]);
  });

  test("the page has a Settings tab, and no button that sets a 3", () => {
    expect(PAGE_HTML).toContain('id="tabSettings"');
    expect(PAGE_HTML).toContain('const LEVELS = ["Never", "Ask me first", "Do it, then tell me"];');
    expect(PAGE_HTML).not.toContain("/api/chat-users/allow");
  });
});

describe("Agent and Memories (read-only)", () => {
  test("GET /api/agent, /api/memories and /api/memory; a path that is not a memory is 404", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect(((await (await h(req("/api/agent"))).json()) as AgentInfo).name).toBe("Keeper");
    expect(((await (await h(req("/api/memories"))).json()) as unknown[]).length).toBe(1);
    expect(await (await h(req("/api/memory?path=memory%2Fa.md"))).json()).toEqual({ text: "hello" });
    expect((await h(req("/api/memory?path=..%2Fsoul%2Fperson.md"))).status).toBe(404);
    expect((await h(req("/api/memory", { token: null }))).status).toBe(401);
  });

  test("search by meaning is `memory search`, and a query cannot become a flag", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const post = (body: unknown) => req("/api/memory-search", { method: "POST", body: JSON.stringify(body) });
    await h(post({ query: "where is vllm" }));
    await h(post({ query: "--subject other" }));
    expect(runs).toEqual([
      ["memory", "search", "/a", "--subject", "example", "--limit", "8", "--scope", "all", "where is vllm"],
      ["memory", "search", "/a", "--subject", "example", "--limit", "8", "--scope", "all", "subject other"],
    ]);
    expect((await h(post({ query: "  " }))).status).toBe(400);
  });

  test("WEB-06: however many dashes a query starts with, none is left to be read as an option of the command", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const post = (query: string) => h(req("/api/memory-search", { method: "POST", body: JSON.stringify({ query }) }));
    for (const query of ["-- --subject other", "--  --scope memory", "- -- --limit 1 where", "\t--\n--subject=x", "-- -- -- --subject other"]) await post(query);
    // Nothing but dashes and spaces is no query at all.
    for (const query of ["--", "- - -", "---   ", "-\n-"]) expect((await post(query)).status, query).toBe(400);
    expect(runs).toHaveLength(5);
    for (const argv of runs) {
      expect(argv.slice(0, 9)).toEqual(["memory", "search", "/a", "--subject", "example", "--limit", "8", "--scope", "all"]);
      expect(argv.slice(9)).toHaveLength(1);
      expect(argv[9]!.startsWith("-")).toBe(false);
    }
    expect(runs.map((a) => a[9])).toEqual(["subject other", "scope memory", "limit 1 where", "subject=x", "subject other"]);
  });

  test("a search that could not run says so (exit 3 → searched: false); a search that ran is searched even with no hit", async () => {
    const answers = [3, 1, 0];
    const { deps } = fakeDeps();
    const h = handler({ ...deps, run: async () => ({ code: answers.shift()!, stdout: "x", stderr: "no fts.sqlite\n" }) }, "tok", HOSTS);
    const post = () => req("/api/memory-search", { method: "POST", body: JSON.stringify({ query: "vllm" }) });
    expect(await (await h(post())).json()).toMatchObject({ ok: false, searched: false });
    expect(await (await h(post())).json()).toMatchObject({ ok: false, searched: true });
    expect(await (await h(post())).json()).toMatchObject({ ok: true, searched: true });
    // The page's own searches ask now (D-152); a search that could not run still says so, never "nothing found".
    expect(PAGE_HTML).toContain('if (r.searched === false) return "Nothing was searched: "');
  });

  test("a remote is shown without credentials, and linked when it is a forge", () => {
    expect(remoteForPage("git@github.com:o/r.git")).toEqual({ remote: "git@github.com:o/r.git", web: "https://github.com/o/r" });
    expect(remoteForPage("https://u:secret@github.com/o/r.git")).toEqual({ remote: "https://github.com/o/r.git", web: "https://github.com/o/r" });
    expect(remoteForPage("/srv/git/r.git")).toEqual({ remote: "/srv/git/r.git", web: null });
  });

  test("the page has the four tabs and carries the mascot, which is the file in docs/", async () => {
    for (const id of ["tabHome", "tabAgent", "tabMemories", "tabSettings"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    const { MASCOT_SVG, MASCOT_DATA_URI } = await import("../../src/web/mascot.ts");
    expect(MASCOT_SVG).toBe(await Bun.file(new URL("../../docs/assets/mascot.svg", import.meta.url)).text());
    expect(PAGE_HTML).toContain(MASCOT_DATA_URI);
  });
});

describe("Profile wizard (D-074)", () => {
  const post = (body: unknown) => req("/api/profile", { method: "POST", body: JSON.stringify(body) });
  test("GET the profile; POST is `soul edit`, a dry run unless write is true; a malformed profile runs nothing", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect(((await (await h(req("/api/profile"))).json()) as { profile: { name: string } }).profile.name).toBe("Keeper");
    expect(((await (await h(post({ profile: { ...PROFILE, name: "Two" } }))).json()) as { message: string }).message).toBe("would change: name");
    await h(post({ profile: { ...PROFILE, name: "Two" }, write: true }));
    expect(runs).toEqual([["soul", "edit", "(dry)", "Two"], ["soul", "edit", "--yes", "Two"]]);
    expect((await h(post({ profile: { ...PROFILE, disclosesAi: false } }))).status).toBe(400);
    expect((await h(post({ profile: "x" }))).status).toBe(400);
    expect(runs).toHaveLength(2);
    expect(PAGE_HTML).toContain('id="tabProfile"');
  });
});

describe("the console (D-078): a rail on a desk, a bottom bar on a phone, and who answers always shown", () => {
  test("layout, contrast and the engine box", () => {
    expect(PAGE_HTML).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(PAGE_HTML).toContain('<aside class="rail">');
    expect(PAGE_HTML).toContain("@media (max-width:760px)");
    // The bottom bar is fixed to the screen: nothing above it may create a containing block for it.
    const phone = PAGE_HTML.slice(PAGE_HTML.indexOf("@media (max-width:760px)"));
    // D-089: the tab bar sits on the version footer, which takes the very bottom.
    expect(phone).toMatch(/nav\.tabs\{position:fixed;left:0;right:0;bottom:var\(--foot\)/);
    expect(phone.slice(0, phone.indexOf("nav.tabs{position:fixed"))).not.toContain("backdrop-filter");
    expect(PAGE_HTML).toContain('"Show all " + list.length');
    expect(PAGE_HTML).toContain("--primary-foreground: ");
    for (const id of ["engChain", "engLocal", "engJudge", "engLast", "engineLine", "statusDot"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    expect(STATE.engine.chain).toEqual(["claude", "codex", "ollama"]);
    // Full width: no cap on main, and the home page laid out by areas — status across, chat beside what waits.
    expect(PAGE_HTML).not.toMatch(/main\{[^}]*max-width/);
    // D-080: the chat holds the left column top to bottom and stays put; everything else scrolls beside it.
    expect(PAGE_HTML).toContain('grid-template-areas:"chat status" "chat wait" "chat recent" "chat sched" "chat term"');
    expect(PAGE_HTML).toMatch(/\.chatpanel\{[^}]*position:sticky;top:16px;height:calc\(100vh - 32px - var\(--foot\)\)/);
    // On a phone the message box sits above the tab bar.
    expect(PAGE_HTML).toMatch(/\.composer\{position:fixed;left:0;right:0;bottom:calc\(62px/);
    expect(PAGE_HTML).toContain('grid-template-areas:"chat" "status" "wait" "recent" "sched" "term"');
  });
});

describe("gaps closed (D-079)", () => {
  test("1: what waits can be filtered and decided in bulk, and a poll does not wipe a note being typed", () => {
    for (const id of ["waitFilter", "waitWho", "waitSelectAll", "bulkBar", "bulkYes", "bulkNo"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    expect(PAGE_HTML).toContain("if (!force && sig === waitSig) return;");
    expect(PAGE_HTML).toContain('confirm("Decline " + ids.length');
  });
});

describe("gaps closed (D-079), 2", () => {
  test("a turn from the ledger by id; anything that is not an id is 404; the chat is kept in this browser", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect(await (await h(req("/api/turn-detail?id=11111111-2222-3333-4444-555555555555"))).json()).toMatchObject({ asked: "q", answer: "a" });
    expect((await h(req("/api/turn-detail?id=ffffffff-ffff-ffff-ffff-ffffffffffff"))).status).toBe(404);
    expect((await h(req("/api/turn-detail?id=../x"))).status).toBe(404);
    expect((await h(req("/api/turn-detail?id=11111111-2222-3333-4444-555555555555", { token: null }))).status).toBe(401);
    expect(PAGE_HTML).toContain('const CHAT_KEY = "mind-chat";');
    expect(PAGE_HTML).toContain('id="chatClear"');
  });
});

describe("gaps closed (D-079), 3", () => {
  test("Privacy: GET the picture; revoking a basis is `basis revoke`; recording one has no route", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect(((await (await h(req("/api/privacy"))).json()) as { needles: number }).needles).toBe(9);
    const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });
    await h(post("/api/basis/revoke", { id: "d858fe8c" }));
    expect(runs).toEqual([["basis", "revoke", "d858fe8c", "--subject", "example"]]);
    expect((await h(post("/api/basis/revoke", { id: "--subject" }))).status).toBe(400);
    expect((await h(post("/api/basis/record", { basis: "owner" }))).status).toBe(404);
    expect(PAGE_HTML).toContain('id="tabPrivacy"');
  });
});

describe("gaps closed (D-079), 4", () => {
  test("persona review on the page: show is persona show --json, an answer is persona decide, writing is persona adopt", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    await h(req("/api/persona"));
    const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });
    await h(post("/api/persona/decide", { claim: "abcd1234", answer: "yes" }));
    await h(post("/api/persona/adopt", {}));
    await h(post("/api/persona/adopt", { write: true }));
    expect(runs).toEqual([
      ["persona", "show", "--subject", "example", "--json"],
      ["persona", "decide", "abcd1234", "--subject", "example", "--yes"],
      ["persona", "adopt", "/a", "--subject", "example"],
      ["persona", "adopt", "/a", "--subject", "example", "--yes"],
    ]);
    for (const bad of [{ claim: "--yes", answer: "yes" }, { claim: "abcd1234", answer: "maybe" }]) expect((await h(post("/api/persona/decide", bad))).status).toBe(400);
    expect(PAGE_HTML).toContain('id="draftList"');
  });
});

describe("2K audit", () => {
  test("type grows with the screen, cards flow as a masonry wall, bubbles keep a readable width", () => {
    expect(PAGE_HTML).toContain("@media (min-width:1920px){html{font-size:16px}");
    expect(PAGE_HTML).toContain("@media (min-width:2400px){html{font-size:17.5px}");
    expect(PAGE_HTML).toContain(".set{columns:30rem;column-gap:18px}");
    expect(PAGE_HTML).toContain("break-inside:avoid");
    expect(PAGE_HTML).toContain("max-width:min(88%,62rem)");
  });
});

describe("Memories CRUD (D-081)", () => {
  test("save is memory write; delete is memory forget, shown first; a path outside memory/ runs nothing", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });
    expect(((await (await h(post("/api/memory/write", { path: "memory/notes/a.md", content: "# a" }))).json()) as { ok: boolean }).ok).toBe(true);
    await h(post("/api/memory/delete", { path: "memory/notes/a.md" }));
    await h(post("/api/memory/delete", { path: "memory/notes/a.md", write: true }));
    expect(runs).toEqual([
      ["memory", "write", "memory/notes/a.md", "# a"],
      ["memory", "forget", "/a", "--subject", "example", "--file", "memory/notes/a.md"],
      ["memory", "forget", "/a", "--subject", "example", "--file", "memory/notes/a.md", "--yes"],
    ]);
    for (const bad of [{ path: "soul/role.md", content: "x" }, { path: "memory/../x.md", content: "x" }, { path: "memory/a.md" }]) expect((await h(post("/api/memory/write", bad))).status).toBe(400);
    expect((await h(post("/api/memory/delete", { path: "../x" }))).status).toBe(400);
    expect(runs).toHaveLength(3);
    for (const id of ["memNew", "memEdit", "memDelete", "memEditor", "memEdSave"]) expect(PAGE_HTML).toContain(`id="${id}"`);
  });

  test("the map: GET /api/memories/graph, and the page draws it (D-082)", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const g = (await (await h(req("/api/memories/graph"))).json()) as { edges: unknown[]; dangling: number };
    expect(g).toMatchObject({ edges: [[0, 1, 2]], dangling: 1 });
    expect((await h(req("/api/memories/graph", { token: null }))).status).toBe(401);
    for (const id of ["mapCanvas", "mapSpin", "mapReset", "mapToggle", "mapLegend", "mapStats"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    expect(PAGE_HTML).toContain("prefers-reduced-motion: reduce");
  });

  test("a big memory is filtered, not drawn whole: find, how many, around one memory, unlinked, kinds, clear", () => {
    for (const id of ["mapFind", "mapLimit", "mapAround", "mapLoose", "mapClear", "mapEmpty"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    // The default is the most linked part, with All one choice away.
    expect(PAGE_HTML).toContain('<option value="150">150 most linked</option>');
    expect(PAGE_HTML).toContain('<option value="0">All</option>');
    // The legend's kinds are buttons that turn a kind off, and the choice is kept.
    expect(PAGE_HTML).toContain('el("button", "legchip")');
    expect(PAGE_HTML).toContain('store.set("mind-map-off"');
    // The stats say how much of memory is on screen.
    expect(PAGE_HTML).toContain('"showing " + seenNotes + " of "');
    // Lines are stroked in batches, and the glow is stamped, not blurred per dot per frame.
    expect(PAGE_HTML).toContain("const batches = new Map()");
    expect(PAGE_HTML).toContain("glowOf(color)");
  });

  test("fonts come from inside the binary, need no token, and nothing else under /fonts/ does (D-083)", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const res = await h(req("/fonts/inter-400.woff2", { token: null }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe("wOF2");
    for (const bad of ["/fonts/nope.woff2", "/fonts/../x.woff2", "/fonts/constructor.woff2"]) expect((await h(req(bad, { token: null }))).status).toBe(404);
    expect(PAGE_HTML).toContain('font-family:"Inter"');
    expect(PAGE_HTML).toContain('"Inter", "IBM Plex Sans Thai"');
    // The old display face and Plex's Latin subsets are not served any more: Inter draws every Latin glyph.
    for (const gone of ["/fonts/electrolize-latin-400.woff2", "/fonts/plex-thai-latin-400.woff2"]) expect((await h(req(gone, { token: null }))).status).toBe(404);
    // Thai is drawn at Latin's size beside it, and a Latin line height of 1.55 gives way to 1.65 for Thai text.
    expect(PAGE_HTML).toContain("size-adjust:102.6%");
    expect(PAGE_HTML).not.toContain("${");
  });

  test("import: a file as base64 or a link, checked then written; anything else runs nothing (D-084)", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const post = (body: unknown) => req("/api/memory/import", { method: "POST", body: JSON.stringify(body) });
    const ok = (await (await h(post({ name: "notes.md", data: btoa("# hi") }))).json()) as { ok: boolean; message: string };
    expect(ok).toEqual({ ok: true, message: "new memory/imported/x.md" });
    await h(post({ url: "https://example.org/a", write: true }));
    expect(runs).toEqual([
      ["memory", "import", "notes.md:# hi", "(dry)"],
      ["memory", "import", "https://example.org/a", "--yes"],
    ]);
    for (const bad of [{ url: "file:///etc/passwd" }, { name: "x.exe", data: "AA==" }, { name: "a/b.md", data: "AA==" }, { name: "x.md", data: "%%%" }, { name: "x.md", data: "A".repeat(30_000_000) }, {}]) {
      expect((await h(post(bad))).status).toBe(400);
    }
    expect(runs).toHaveLength(2);
    for (const id of ["memImp", "memImport", "memFiles", "memUrl", "memImpGo", "memQueue"]) expect(PAGE_HTML).toContain(`id="${id}"`);
  });

  test("WEB-01: a link to this machine, a private network or a metadata service is refused at the route, and nothing is run", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const post = (body: unknown) => req("/api/memory/import", { method: "POST", body: JSON.stringify(body) });
    for (const link of ["http://127.0.0.1:10400/", "http://localhost:11434/api/tags", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://100.64.0.1:8080/", "http://2130706433/", "http://printer.local/"]) {
      for (const write of [false, true]) {
        const res = await h(post({ url: link, write }));
        expect(res.status, link).toBe(400);
        expect(((await res.json()) as { error: string }).error, link).toContain("only public web pages are fetched");
      }
    }
    expect(runs).toEqual([]);
    // A public one still goes through to the command, which looks the name up and checks every address again.
    expect((await h(post({ url: "https://example.org/a" }))).status).toBe(200);
    expect(runs).toHaveLength(1);
  });

  test("an answer's line names the model the backend ran, and a requested one only as asked (S15.9, PR #3 R1, D-142)", () => {
    // `turn --json` sends model null for a vendor CLI whose output named no model. The line used to fall back to
    // the picker, so "claude · opus" still read as answered by claude on opus. Since D-142 the model does reach
    // claude, and what it asked for travels apart (`model_requested`) and is labelled as asked, never as the model.
    const source = /function turnLine\(r, pick\) \{[\s\S]*?\n  \}\n/.exec(PAGE_HTML)?.[0];
    const label = /const modelLabel = [^\n]*\n/.exec(PAGE_HTML)?.[0];
    expect(source).toBeDefined();
    expect(label).toBeDefined();
    const turnLine = new Function(
      "engine",
      `const isLocalId = (id) => id === "ollama" || id.endsWith("-local"); ${label} ${source}; return turnLine;`,
    )({ localModel: "qwen3:8b" }) as (r: Record<string, unknown>, pick: { model?: string }) => string;
    const claude = { route: "answered by claude · 1.2s", backend: "claude", held: 0, heldMessages: 0 };
    expect(turnLine({ ...claude, model: null }, { model: "opus" })).toBe("answered by claude · cloud · 1.2s");
    expect(turnLine({ ...claude, model: "claude-opus-5" }, { model: "opus" })).toBe("answered by claude · cloud · claude-opus-5 · 1.2s");
    // Asked for an alias, and the output named what it resolved to: both, and which is which.
    expect(turnLine({ ...claude, model: "claude-opus-5-5", modelRequested: "opus" }, { model: "opus" })).toBe(
      "answered by claude · cloud · claude-opus-5-5 (asked for opus) · 1.2s",
    );
    // Asked, and the output named nothing: the request is shown as a request, not as the model it ran.
    expect(turnLine({ ...claude, model: null, modelRequested: "opus" }, { model: "opus" })).toBe("answered by claude · cloud · asked for opus · 1.2s");
    // The same name asked and reported is said once.
    expect(turnLine({ ...claude, model: "claude-opus-5", modelRequested: "claude-opus-5" }, {})).toBe("answered by claude · cloud · claude-opus-5 · 1.2s");
    // A local backend still falls back to what the page knows it runs, then to the pick.
    const ollama = { route: "answered by ollama · 0.4s", backend: "ollama", held: 0, heldMessages: 0 };
    expect(turnLine({ ...ollama, model: null }, {})).toBe("answered by ollama · on this machine · qwen3:8b · 0.4s");
    expect(turnLine({ ...ollama, model: "stub" }, {})).toBe("answered by ollama · on this machine · stub · 0.4s");
  });

  test("the page's script parses — one bad quote in the template stops every button", () => {
    const scripts = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
  });

  test("a bulk selection holds only the cards on screen — never one a filter or \"Show fewer\" hid", () => {
    expect(PAGE_HTML).toContain("for (const id of [...picked]) if (!waitOnScreen.includes(id)) picked.delete(id);");
    expect(PAGE_HTML).toContain("for (const id of waitOnScreen) picked.add(id);");
    expect(PAGE_HTML).not.toContain("for (const p of waitShown()) picked.add(p.id)");
  });

  test("the chat switches backend and model: /api/models, and each one named replaces only its own flag (D-085)", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler({ ...deps, turnFlags: ["--backend", "ollama", "--model", "qwen3.8:27b"] }, "tok", HOSTS);
    const m = (await (await h(req("/api/models"))).json()) as { models: Record<string, string[]>; chain: string[] };
    expect(m.models["claude"]).toEqual(["opus", "sonnet", "haiku"]);
    expect(m.chain).toEqual(["claude", "codex", "ollama"]);
    expect((await h(req("/api/models", { token: null }))).status).toBe(401);
    const turn = (body: unknown) => h(req("/api/turn", { method: "POST", body: JSON.stringify(body) }));
    await turn({ prompt: "a" });
    await turn({ prompt: "b", backend: "claude", model: "opus" });
    await turn({ prompt: "c", model: "typhoon-4b" });
    await turn({ prompt: "d", backend: "claude" });
    await turn({ prompt: "e", backend: "claude; rm -rf /", model: "--yes" });
    // D-142: the page names what the engine would hand a CLI — its own rule, so `opus[1m]` is a name, and
    // anything `turn` would refuse is not sent at all.
    await turn({ prompt: "f", backend: "claude", model: "opus[1m]" });
    await turn({ prompt: "g", backend: "claude", model: "opus --tools Bash" });
    const flags = runs.filter((r) => r[0] === "turn").map((r) => r.slice(r.indexOf("--json") + 1).join(" "));
    expect(flags).toEqual([
      "--backend ollama --model qwen3.8:27b",
      "--backend claude --model opus",
      "--backend ollama --model typhoon-4b",
      "--backend claude",
      "--backend ollama --model qwen3.8:27b",
      "--backend claude --model opus[1m]",
      "--backend claude",
    ]);
    for (const id of ["chatPick", "pickRow", "chatBackend", "chatModel", "chatModelList"]) expect(PAGE_HTML).toContain(`id="${id}"`);
  });

  test("the chat's / commands (D-086): all listed, and every endpoint the page calls is one the server answers", async () => {
    for (const name of ["help", "clear", "retry", "copy", "export", "backend", "model", "status", "waiting", "approve", "decline", "do", "search", "remember", "import", "memories", "autonomy", "stop", "update", "go"]) {
      expect(PAGE_HTML).toContain(`{ name: "${name}", args: `);
    }
    expect(PAGE_HTML).toContain('id="cmdMenu"');
    const server = await Bun.file(new URL("../../src/web/server.ts", import.meta.url)).text();
    const called = [...new Set([...PAGE_HTML.matchAll(/api\("(\/api\/[a-z/-]+)/g)].map((m) => m[1]!))];
    expect(called.length).toBeGreaterThan(15);
    // A plain route is a string; one with an id in it is a pattern with its slashes escaped.
    for (const path of called) expect(server.includes(`"${path}"`) || server.includes(path.split("/").join("\\/")), path).toBe(true);
  });

  test("the tab's icon is Mind, from inside the page (CSP allows data: images)", () => {
    expect(PAGE_HTML).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml');
  });

  test("a footer across the bottom says which Mind this is, and when a newer one is out (D-089)", async () => {
    const { deps } = fakeDeps();
    const state = (await (await handler(deps, "tok", HOSTS)(req("/api/state"))).json()) as ViewState;
    expect(state.version).toEqual({ current: "0.6.1", latest: "0.7.0" });
    for (const id of ["foot", "footVer", "footNewer", "footWho"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    expect(PAGE_HTML).toContain(".foot{position:fixed;left:0;right:0;bottom:0");
  });

  test("memory and knowledge (D-090): move is memory move, shown first; search carries the scope; the page has the switch", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const post = (path: string, body: unknown) => h(req(path, { method: "POST", body: JSON.stringify(body) }));
    await post("/api/memory/move", { path: "memory/notes/a.md", to: "knowledge" });
    await post("/api/memory/move", { path: "memory/knowledge/a.md", to: "memory", write: true });
    await post("/api/memory-search", { query: "kiln", scope: "knowledge" });
    await post("/api/memory-search", { query: "kiln", scope: "--rm" });
    expect(runs).toEqual([
      ["memory", "move", "/a", "--subject", "example", "--file", "memory/notes/a.md", "--to", "knowledge"],
      ["memory", "move", "/a", "--subject", "example", "--file", "memory/knowledge/a.md", "--to", "memory", "--yes"],
      ["memory", "search", "/a", "--subject", "example", "--limit", "8", "--scope", "knowledge", "kiln"],
      ["memory", "search", "/a", "--subject", "example", "--limit", "8", "--scope", "all", "kiln"],
    ]);
    for (const bad of [{ path: "../x.md", to: "knowledge" }, { path: "memory/a.md", to: "elsewhere" }, { path: "memory/a.md" }]) expect((await post("/api/memory/move", bad)).status).toBe(400);
    expect(runs).toHaveLength(4);
    for (const id of ["memKind", "memMove"]) expect(PAGE_HTML).toContain(`id="${id}"`);
  });

  test("collections (D-091): tags are written into the front matter through memory write; bad asks write nothing", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler({ ...deps, memory: async (path) => (path === "memory/a.md" ? { ok: true as const, text: "---\nname: A\ndescription: d\n---\nbody\n" } : { ok: false as const, reason: "no such memory" }) }, "tok", HOSTS);
    const post = (body: unknown) => h(req("/api/memory/tags", { method: "POST", body: JSON.stringify(body) }));
    expect(((await (await post({ path: "memory/a.md", tags: ["Infra", "ports"] })).json()) as { ok: boolean }).ok).toBe(true);
    expect(runs).toEqual([["memory", "write", "memory/a.md", "---\nname: A\ndescription: d\ntags: [infra, ports]\n---\nbody\n"]]);
    expect((await post({ path: "memory/none.md", tags: [] })).status).toBe(404);
    for (const bad of [{ path: "../a.md", tags: [] }, { path: "memory/a.md", tags: "infra" }, { path: "memory/a.md", tags: Array(13).fill("t") }, { path: "memory/a.md", tags: [3] }]) expect((await post(bad)).status).toBe(400);
    expect(runs).toHaveLength(1);
    for (const id of ["memTags", "memTagBox", "memTagEdit"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    expect(PAGE_HTML).toContain('{ name: "tags", args: ');
  });

  test("who mentions a thing (D-092): GET /api/memory/who; an empty ask is refused; the page has Things and /who", async () => {
    const { deps } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const who = (await (await h(req("/api/memory/who?q=10410"))).json()) as { value: string }[];
    expect(who[0]!.value).toBe("10410");
    expect((await h(req("/api/memory/who?q="))).status).toBe(400);
    expect((await h(req("/api/memory/who?q=10410", { token: null }))).status).toBe(401);
    expect(PAGE_HTML).toContain('id="mapEntities"');
    expect(PAGE_HTML).toContain('{ name: "who", args: ');
  });

  test("facts (D-093): a run starts in the background and is asked after; decide and adopt are the CLI's", async () => {
    let release: (v: { code: number; stdout: string; stderr: string }) => void = () => {};
    const { deps, runs } = fakeDeps();
    const h = handler({ ...deps, dir: "/facts-agent", run: async (args) => {
      runs.push(args);
      if (args[1] === "distill" && args[2] !== "show" && args[2] !== "decide" && args[2] !== "adopt") return new Promise((r) => (release = r));
      if (args[2] === "show") return { code: 0, stdout: JSON.stringify({ draft: { facts: [] } }), stderr: "" };
      return { code: 0, stdout: "done", stderr: "" };
    } }, "tok", HOSTS);
    const post = (path: string, body: unknown) => h(req(path, { method: "POST", body: JSON.stringify(body) }));
    expect((await post("/api/distill/start", { from: "../etc" })).status).toBe(400);
    expect(((await (await post("/api/distill/start", { from: "memory/knowledge" })).json()) as { ok: boolean }).ok).toBe(true);
    expect((await post("/api/distill/start", {})).status).toBe(409);
    const during = (await (await h(req("/api/distill"))).json()) as { run: { since: string; finished?: unknown } };
    expect(during.run.finished).toBeUndefined();
    release({ code: 0, stdout: "1 fact(s) drafted", stderr: "" });
    await new Promise((r) => setTimeout(r, 10));
    const after = (await (await h(req("/api/distill"))).json()) as { draft: unknown; run: { finished: { ok: boolean } } };
    expect(after.run.finished.ok).toBe(true);
    expect(after.draft).toEqual({ facts: [] });
    await post("/api/distill/decide", { fact: "abcd1234", answer: "yes" });
    expect((await post("/api/distill/decide", { fact: "nope", answer: "yes" })).status).toBe(400);
    await post("/api/distill/adopt", { write: true });
    expect(runs.filter((r) => r[1] === "distill")).toEqual([
      ["memory", "distill", "/facts-agent", "--subject", "example", "--from", "memory/knowledge"],
      ["memory", "distill", "show", "--subject", "example", "--json"],
      ["memory", "distill", "show", "--subject", "example", "--json"],
      ["memory", "distill", "decide", "abcd1234", "--subject", "example", "--yes"],
      ["memory", "distill", "adopt", "/facts-agent", "--subject", "example", "--yes"],
    ]);
    for (const id of ["factStart", "factAdopt", "factList"]) expect(PAGE_HTML).toContain(`id="${id}"`);
  });

  test("phone audit (D-094): long words wrap, and the phone rules come after the phone layout they correct", () => {
    expect(PAGE_HTML).toContain("#capLines li,ul.plain li,.notes,.md{overflow-wrap:anywhere}");
    const audit = PAGE_HTML.indexOf("/* Phone audit (D-094");
    expect(audit).toBeGreaterThan(PAGE_HTML.indexOf("nav.tabs{position:fixed;left:0;right:0;bottom:var(--foot)"));
    const rules = PAGE_HTML.slice(audit, PAGE_HTML.indexOf("</style>"));
    for (const r of ["nav.tabs button{font-size:.76rem}", ".linkish{min-height:36px", ".pickchip{min-height:36px}", ".steps button{min-height:36px", ".composer #sending{font-size:.76rem}"]) expect(rules).toContain(r);
    expect(PAGE_HTML).toContain('$("memTagBox").hidden = editing || !memShown;');
  });

  test("the conversation goes with a message (D-095): the last twelve well-formed ones, as --history-json", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    const history = [{ role: "you", text: "a" }, { role: "agent", text: "b" }, { role: "system", text: "no" }, "junk", ...Array.from({ length: 14 }, (_, i) => ({ role: "you", text: `m${i}` }))];
    await h(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "next", history }) }));
    await h(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "alone" }) }));
    const turns = runs.filter((r) => r[0] === "turn");
    const sent = JSON.parse(turns[0]![turns[0]!.indexOf("--history-json") + 1]!) as { text: string }[];
    expect(sent.map((m) => m.text)).toEqual(Array.from({ length: 12 }, (_, i) => `m${i + 2}`));
    expect(turns[1]).not.toContain("--history-json");
    expect(PAGE_HTML).toContain("if (talk.length && !proposal) body.history = talk;");
  });

  test("a refused delete shows the plan and the reason, not the plan alone", async () => {
    const { deps } = fakeDeps();
    const h = handler({ ...deps, run: async () => ({ code: 1, stdout: "1 file(s) would go\n", stderr: "mind: cannot reach the vectors. Nothing was removed\n" }) }, "tok", HOSTS);
    const out = (await (await h(req("/api/memory/delete", { method: "POST", body: JSON.stringify({ path: "memory/a.md", write: true }) }))).json()) as { ok: boolean; message: string };
    expect(out.ok).toBe(false);
    expect(out.message).toBe("1 file(s) would go\ncannot reach the vectors. Nothing was removed");
  });
});

describe("who handled each turn (S12.4)", () => {
  test("/api/turn carries backend, local/cloud, model, the held counts and the change report", async () => {
    const turnOut = {
      text: "done",
      route: "answered by claude · identity arrived as system · 1.2s",
      backend: "claude",
      local: false,
      model: "claude-sonnet-5",
      model_requested: "sonnet",
      held: 2,
      heldMessages: 1,
      changed: { added: ["made-by-the-turn.txt"], changed: [], removed: ["old-note.txt"] },
      proposals: [],
    };
    const deps: WebDeps = { ...fakeDeps().deps, run: async () => ({ code: 0, stdout: JSON.stringify(turnOut), stderr: "" }) };
    const res = await (await handler(deps, "tok", HOSTS)(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }))).json();
    expect(res).toMatchObject({
      ok: true,
      backend: "claude",
      local: false,
      // D-142: what claude said it ran, and apart from it what it was asked for.
      model: "claude-sonnet-5",
      modelRequested: "sonnet",
      held: 2,
      heldMessages: 1,
      changed: { added: ["made-by-the-turn.txt"], changed: [], removed: ["old-note.txt"] },
    });
  });

  test("local is derived from the backend id — a child that predates the fields still gets the right badge", async () => {
    for (const [backend, local] of [["ollama", true], ["claude-local", true], ["grok-local", true], ["claude", false], ["codex", false]] as const) {
      const deps: WebDeps = { ...fakeDeps().deps, run: async () => ({ code: 0, stdout: JSON.stringify({ text: "hi", route: `answered by ${backend}`, backend }), stderr: "" }) };
      const res = (await (await handler(deps, "tok", HOSTS)(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }))).json()) as {
        backend: string;
        local: boolean;
        model: string | null;
        held: number;
        heldMessages: number;
        changed: unknown;
      };
      expect(res.local, backend).toBe(local);
      expect(res.backend).toBe(backend);
      expect(res.held).toBe(0);
      expect(res.heldMessages).toBe(0);
      expect(res.model).toBeNull();
      expect(res.changed).toBeNull();
    }
    // A child from before the field existed names no backend at all: nothing is invented.
    const legacy: WebDeps = { ...fakeDeps().deps, run: async () => ({ code: 0, stdout: JSON.stringify({ text: "hi", route: "answered by ollama" }), stderr: "" }) };
    const old = await (await handler(legacy, "tok", HOSTS)(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }))).json();
    expect(old).toMatchObject({ ok: true, text: "hi", backend: "", local: false, model: null, modelRequested: null, held: 0, heldMessages: 0, changed: null });
  });

  test("the badge rides on the one local rule, and the change report stays collapsed until asked", () => {
    expect(PAGE_HTML).toContain('const isLocalId = (id) => id === "ollama" || id.endsWith("-local");');
    expect(PAGE_HTML).toContain("function turnLine(r, pick)");
    expect(PAGE_HTML).toContain('const d = el("details", "changed")');
    expect(PAGE_HTML).toContain("const CHANGE_LIMITS");
    expect(PAGE_HTML).toContain(".changed{margin-top:6px");
    expect(PAGE_HTML).toContain("what it changed: ");
    // Kept for the Engine box: the chain badge and the Last row both use the rule.
    expect(PAGE_HTML).toContain('isLocalId(engine.last.backend) ? "on this machine" : "cloud"');
  });
});

describe("pairing a phone (S14.2)", () => {
  test("the key is compared whole, in constant time", () => {
    expect(sameToken("tok", "tok")).toBe(true);
    expect(sameToken(null, "tok")).toBe(false);
    expect(sameToken("", "tok")).toBe(false);
    expect(sameToken("to", "tok")).toBe(false);
    expect(sameToken("tok ", "tok")).toBe(false);
    expect(sameToken("tOk", "tok")).toBe(false);
  });

  test("the link is built only for an address this page answers to", () => {
    const hosts = allowedHosts("127.0.0.1", 30701, ["box.tail1.ts.net"]);
    expect(pairingLink("https://box.tail1.ts.net:30701", "k", hosts)).toBe("https://box.tail1.ts.net:30701/#t=k");
    expect(pairingLink("http://127.0.0.1:30701", "k", hosts)).toBe("http://127.0.0.1:30701/#t=k");
    expect(pairingLink("https://evil.example:30701", "k", hosts)).toBeUndefined();
    expect(pairingLink("https://box.tail1.ts.net", "k", hosts)).toBeUndefined(); // 443 is not where it listens
    expect(pairingLink("https://box.tail1.ts.net:30701/path", "k", hosts)).toBeUndefined();
    expect(pairingLink("https://u:p@box.tail1.ts.net:30701", "k", hosts)).toBeUndefined();
    expect(pairingLink("ftp://box.tail1.ts.net:30701", "k", hosts)).toBeUndefined();
    expect(pairingLink("not a url", "k", hosts)).toBeUndefined();
    expect(pairingLink("", "k", hosts)).toBeUndefined();
    expect(pairingLink("https://box.tail1.ts.net:443", "k", allowedHosts("box.tail1.ts.net", 443))).toBeUndefined(); // not the origin form
    expect(pairingLink("https://box.tail1.ts.net", "k", allowedHosts("box.tail1.ts.net", 443))).toBe("https://box.tail1.ts.net/#t=k");
  });

  test("/api/pair answers with the link and its code — behind the key, and runs nothing", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect((await h(req("/api/pair?origin=" + encodeURIComponent("http://127.0.0.1:30701"), { token: null }))).status).toBe(401);
    const res = await h(req("/api/pair?origin=" + encodeURIComponent("http://127.0.0.1:30701")));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: string; code: { size: number; d: string } };
    expect(body.link).toBe("http://127.0.0.1:30701/#t=tok");
    expect(body.code.size).toBeGreaterThan(21);
    expect(body.code.d).toMatch(/^[Mhvz0-9 -]+$/);
    expect((await h(req("/api/pair?origin=" + encodeURIComponent("https://evil.example:30701")))).status).toBe(400);
    expect((await h(req("/api/pair"))).status).toBe(400);
    expect(runs).toEqual([]);
  });

  test("a link too long for a code says to paste it", async () => {
    const { deps } = fakeDeps();
    const long = "k".repeat(300);
    const res = await handler(deps, long, HOSTS)(req("/api/pair?origin=" + encodeURIComponent("http://127.0.0.1:30701"), { token: long }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("pair by pasting it");
  });

  test("/api/pair/rotate: behind the old key; only where the page can change its key; a failure changes nothing", async () => {
    const { deps, runs } = fakeDeps();
    const post = (body: unknown, token?: string | null) => req("/api/pair/rotate", { method: "POST", body: JSON.stringify(body), ...(token === undefined ? {} : { token }) });
    expect((await handler(deps, "tok", HOSTS)(post({}))).status).toBe(404);
    const ok: KeyControl = { rotate: async () => ({ ok: true, key: "b".repeat(64) }) };
    expect((await handler(deps, "tok", HOSTS, ok)(post({}, null))).status).toBe(401);
    const res = await handler(deps, "tok", HOSTS, ok)(post({ origin: "http://127.0.0.1:30701" }));
    expect(await res.json()).toEqual({ ok: true, token: "b".repeat(64), unsubscribed: 0, link: "http://127.0.0.1:30701/#t=" + "b".repeat(64) });
    const noOrigin = await handler(deps, "tok", HOSTS, ok)(post({ origin: "https://evil.example:30701" }));
    expect(await noOrigin.json()).toEqual({ ok: true, token: "b".repeat(64), unsubscribed: 0 });
    const broken: KeyControl = { rotate: async () => ({ ok: false, reason: "disk full" }) };
    const failed = await handler(deps, "tok", HOSTS, broken)(post({}));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toBe("the key was not changed: disk full");
    expect(runs).toEqual([]);
  });

  test("a running page changes its key: the old one stops, the new one is kept first, the link follows", async () => {
    const saved: string[] = [];
    let told = 0;
    const server = startWeb(fakeDeps().deps, { port: 0, saveKey: async (key) => { saved.push(key); return { ok: true }; }, onRotate: () => { told++; } });
    try {
      const port = new URL(server.url).port;
      const old = server.token;
      const rotate = await fetch(`http://127.0.0.1:${port}/api/pair/rotate`, { method: "POST", headers: { [TOKEN_HEADER]: old, "content-type": "application/json" }, body: "{}" });
      const { token } = (await rotate.json()) as { token: string };
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(saved).toEqual([token]);
      expect(told).toBe(1);
      expect(server.token).toBe(token);
      expect(server.url).toEndWith(`/#t=${token}`);
      expect((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { [TOKEN_HEADER]: old } })).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { [TOKEN_HEADER]: token } })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("when the new key cannot be kept, the old one stays in use", async () => {
    const server = startWeb(fakeDeps().deps, { port: 0, saveKey: async () => ({ ok: false, reason: "read-only" }) });
    try {
      const port = new URL(server.url).port;
      const old = server.token;
      const res = await fetch(`http://127.0.0.1:${port}/api/pair/rotate`, { method: "POST", headers: { [TOKEN_HEADER]: old, "content-type": "application/json" }, body: "not json" });
      expect(res.status).toBe(500);
      expect(server.token).toBe(old);
      expect((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { [TOKEN_HEADER]: old } })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("the page offers the code in Settings and warns what it is", () => {
    expect(PAGE_HTML).toContain('id="rotateKey"');
    expect(PAGE_HTML).toContain('api("/api/pair/rotate", { origin: location.origin })');
    expect(PAGE_HTML).toContain('id="h-pair"');
    expect(PAGE_HTML).toContain("/api/pair?origin=");
    expect(PAGE_HTML).toContain('document.createElementNS(NS, "path")');
    expect(PAGE_HTML).toContain("Anyone who scans it can use this page as you");
    expect(PAGE_HTML).toContain("every paired phone, every other open tab and every saved link stop working");
  });
});

describe("push (S14.3, D-130)", () => {
  const HANDLE = "h".repeat(43);
  function withPush() {
    const calls: string[] = [];
    let subs = 0;
    const push: NonNullable<WebDeps["push"]> = {
      subscribe: async (relay, handle, key) => {
        calls.push(`subscribe ${relay} ${handle} ${key}`);
        if (relay.startsWith("http://evil")) return { ok: false, reason: "the relay must be https" };
        subs++;
        return { ok: true, count: subs };
      },
      unsubscribe: async (handle) => { calls.push(`unsubscribe ${handle}`); return handle === HANDLE; },
      count: async (key) => { calls.push(`count ${key}`); return subs; },
      clear: async (key) => { const n = subs; subs = 0; calls.push(`clear ${key}`); return n; },
    };
    return { push, calls };
  }
  const post = (path: string, body: unknown, token?: string | null) => req(path, { method: "POST", body: JSON.stringify(body), ...(token === undefined ? {} : { token }) });

  test("a page without push says so, and every route is behind the key", async () => {
    const { deps } = fakeDeps();
    expect((await handler(deps, "tok", HOSTS)(req("/api/push"))).status).toBe(404);
    const { push } = withPush();
    const h = handler({ ...deps, push }, "tok", HOSTS);
    expect((await h(req("/api/push", { token: null }))).status).toBe(401);
    expect((await h(post("/api/push/subscribe", { relay: "https://relay.example", handle: HANDLE }, null))).status).toBe(401);
  });

  test("subscribe, count, unsubscribe — the page passes relay and handle through and runs nothing", async () => {
    const { deps, runs } = fakeDeps();
    const { push, calls } = withPush();
    const h = handler({ ...deps, push }, "tok", HOSTS);
    expect(await (await h(post("/api/push/subscribe", { relay: "https://relay.example", handle: HANDLE }))).json()).toEqual({ ok: true, count: 1 });
    expect(await (await h(req("/api/push"))).json()).toEqual({ count: 1 });
    const refused = await h(post("/api/push/subscribe", { relay: "http://evil.example", handle: HANDLE }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("the relay must be https");
    expect((await h(post("/api/push/subscribe", { handle: HANDLE }))).status).toBe(400);
    expect((await h(post("/api/push/subscribe", { relay: "https://relay.example" }))).status).toBe(400);
    expect(await (await h(post("/api/push/unsubscribe", { handle: HANDLE }))).json()).toEqual({ ok: true, removed: true });
    expect(await (await h(post("/api/push/unsubscribe", { handle: "x".repeat(43) }))).json()).toEqual({ ok: true, removed: false });
    expect((await h(req("/api/push/subscribe"))).status).toBe(404);
    const P = keyPrint("tok");
    expect(calls).toEqual([`subscribe https://relay.example ${HANDLE} ${P}`, `count ${P}`, `subscribe http://evil.example ${HANDLE} ${P}`, `unsubscribe ${HANDLE}`, `unsubscribe ${"x".repeat(43)}`]);
    expect(runs).toEqual([]);
  });

  test("changing the key drops every subscription (a phone unpaired is a phone not told)", async () => {
    const { deps } = fakeDeps();
    const { push, calls } = withPush();
    await push.subscribe("https://relay.example", HANDLE, keyPrint("tok"));
    await push.subscribe("https://relay.example", "k".repeat(43), keyPrint("tok"));
    const keys: KeyControl = { rotate: async () => ({ ok: true, key: "c".repeat(64) }) };
    const res = await handler({ ...deps, push }, "tok", HOSTS, keys)(post("/api/pair/rotate", {}));
    expect(((await res.json()) as { unsubscribed: number }).unsubscribed).toBe(2);
    // The old key's phones — not the new key's, of which there are none yet.
    expect(calls.at(-1)).toBe(`clear ${keyPrint("tok")}`);
  });

  test("if the old key's phones cannot be dropped, the key has still changed and the tab is told so", async () => {
    const { deps } = fakeDeps();
    const { push } = withPush();
    const broken = { ...push, clear: async () => { throw Object.assign(new Error("EACCES: permission denied, open '/home/someone/.local/state/mind/push/x'"), { code: "EACCES" }); } };
    const keys: KeyControl = { rotate: async () => ({ ok: true, key: "d".repeat(64) }) };
    const res = await handler({ ...deps, push: broken }, "tok", HOSTS, keys)(post("/api/pair/rotate", {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; unsubscribed: number; warning: string };
    expect(body.token).toBe("d".repeat(64));
    expect(body.unsubscribed).toBe(0);
    expect(body.warning).toContain("(EACCES)");
    expect(body.warning).not.toContain("/home/");
  });

  test("an error nobody caught is a bare JSON 500 — no stack, no path", async () => {
    const { deps } = fakeDeps();
    const server = startWeb({ ...deps, state: async () => { throw new Error("boom at /home/someone/secret-path"); } }, { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${new URL(server.url).port}/api/state`, { headers: { [TOKEN_HEADER]: server.token } });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      const text = await res.text();
      expect(text).not.toContain("/home/");
      expect(text).not.toContain("boom");
    } finally {
      await server.stop(true);
    }
  });

  test("the page shows how many phones are told, and says what the relay learns", () => {
    expect(PAGE_HTML).toContain('api("/api/push")');
    expect(PAGE_HTML).toContain("which learns when, never what");
    expect(PAGE_HTML).toContain("toast(r.warning ? r.warning :");
  });
});

describe("what recall attached reaches the app (sources under an answer)", () => {
  test("/api/turn passes the attachment's shape through: paths, headings, sizes, how found — never text", async () => {
    const turnOut = {
      text: "the answer",
      route: "answered by ollama",
      proposals: [],
      recall: { chars: 1200, ceiling: 6000, skipped: 1, block: "SECRET MEMORY TEXT", attached: [{ path: "memory/notes/ports.md", heading: "Ports", chars: 800, via: ["fts", "vector"], text: "SECRET" }] },
    };
    const deps: WebDeps = { ...fakeDeps().deps, run: async () => ({ code: 0, stdout: JSON.stringify(turnOut), stderr: "" }) };
    const res = (await (await handler(deps, "tok", HOSTS)(req("/api/turn", { method: "POST", body: JSON.stringify({ prompt: "which port" }) }))).json()) as { recall: unknown };
    expect(res.recall).toEqual({ chars: 1200, ceiling: 6000, skipped: 1, attached: [{ path: "memory/notes/ports.md", heading: "Ports", chars: 800, via: ["fts", "vector"] }] });
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  test("no recall, or one of the wrong shape, is null or cleaned — never passed on as it came", () => {
    expect(recallOf(undefined)).toBeNull();
    expect(recallOf(null)).toBeNull();
    expect(recallOf("x")).toBeNull();
    expect(recallOf({ chars: -3, ceiling: "9", skipped: 1.7, attached: [{ path: 5 }, { path: "p".repeat(900), heading: 1, chars: "2", via: ["fts", "evil", 3] }, "junk"] })).toEqual({
      chars: 0,
      ceiling: 0,
      skipped: 1,
      attached: [{ path: "p".repeat(500), heading: "", chars: 0, via: ["fts"] }],
    });
    expect(recallOf({ attached: Array.from({ length: 80 }, (_, i) => ({ path: `memory/${i}.md` })) })!.attached).toHaveLength(50);
  });
});


describe("ask your memory (D-152): POST /api/memory-ask", () => {
  const ANSWER = {
    ok: true, answer: "The dashboard listens on 30600 (memory/infra.md).", found: 2, backend: "ollama", model: "qwen3.8:27b", local: true, held: 0, searched: true,
    sources: [{ path: "memory/infra.md", title: "Infra", section: "Ports" }, { path: "memory/b.md" }],
    pieces: [{ path: "memory/infra.md", section: "Ports", excerpt: "The second-brain dashboard listens on port 30600" }],
  };
  const post = (body: unknown, init: { token?: string | null; host?: string; signal?: AbortSignal } = {}) => req("/api/memory-ask", { method: "POST", body: JSON.stringify(body), ...init });

  test("it is `memory ask --json` with the started flags and the question after --, under a deadline; the answer passes field by field", async () => {
    const { deps } = fakeDeps();
    const seen: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    const h = handler({ ...deps, run: async (args, options) => (seen.push({ args, timeoutMs: options?.timeoutMs }), { code: 0, stdout: JSON.stringify({ ...ANSWER, read: 2, extra: "<b>not passed</b>" }), stderr: "mind: recall: 2 piece(s)\n" }) }, "tok", HOSTS);
    const res = await h(post({ question: "which port does the dashboard use?", scope: "memory" }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ args: ["memory", "ask", "/a", "--subject", "example", "--scope", "memory", "--json", "--backend", "ollama", "--", "which port does the dashboard use?"], timeoutMs: MEMORY_ASK_TIMEOUT_MS }]);
    expect(await res.json()).toEqual(ANSWER);
  });

  test("a question that starts with dashes is asked as written, after --, never read as a flag", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    for (const question of ["--subject other", "-v?", "--json"]) {
      await h(post({ question }));
      const args = runs.at(-1)!;
      expect(args.slice(-2)).toEqual(["--", question]);
      expect(args.indexOf("--")).toBe(args.length - 2);
    }
  });

  test("the body is checked before anything runs: no question, an empty one, one over 2000 characters, a bad scope", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    for (const bad of [{}, { question: 3 }, { question: "   " }, { question: "x".repeat(2001) }, { question: "ok?", scope: "--rm" }, { question: "ok?", scope: "everything" }]) {
      expect((await h(post(bad))).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect(runs).toEqual([]);
  });

  test("the same key and Host as every other route", async () => {
    const { deps, runs } = fakeDeps();
    const h = handler(deps, "tok", HOSTS);
    expect((await h(post({ question: "q" }, { token: null }))).status).toBe(401);
    expect((await h(post({ question: "q" }, { token: "wrong" }))).status).toBe(401);
    expect((await h(post({ question: "q" }, { host: "evil.example:30701" }))).status).toBe(421);
    expect(runs).toEqual([]);
  });

  test("one ask per agent at a time — held until the child exits, even when the asker gave up — then the next runs", async () => {
    const { deps } = fakeDeps();
    let release!: () => void;
    let started = 0;
    const h = handler({ ...deps, run: async () => { started += 1; await new Promise<void>((r) => (release = r)); return { code: 0, stdout: JSON.stringify(ANSWER), stderr: "" }; } }, "tok", HOSTS);
    // The phone asks, then gives up waiting: its request is aborted while the child still runs.
    const gaveUp = new AbortController();
    const first = h(post({ question: "one" }, { signal: gaveUp.signal }));
    // Gives up once the child is really running — not after 5 ms, by which a slow runner may not have started it.
    expect(await waitFor(() => started === 1)).toBe(true);
    gaveUp.abort();
    const second = await h(post({ question: "two" }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe(ASK_BUSY);
    expect(started).toBe(1);
    release();
    await first;
    const third = h(post({ question: "three" }));
    // `release` is the third child's only once it has started; released earlier, it ends nothing and this hangs.
    expect(await waitFor(() => started === 2)).toBe(true);
    release();
    expect((await third).status).toBe(200);
    expect(started).toBe(2);
  });

  test("a child past the deadline is 504; nothing searched passes as searched: false; no JSON is an error with its last lines", async () => {
    const { deps } = fakeDeps();
    const outs = [
      { code: -1, stdout: "", stderr: "", timedOut: true },
      { code: 3, stdout: JSON.stringify({ ok: false, searched: false, error: "nothing searched — no index", answer: "", sources: [], found: 0, backend: null, model: null }), stderr: "" },
      { code: 1, stdout: "", stderr: "mind: no backend answered\n" },
    ];
    const h = handler({ ...deps, run: async () => outs.shift()! }, "tok", HOSTS);
    expect((await h(post({ question: "q" }))).status).toBe(504);
    expect(await (await h(post({ question: "q" }))).json()).toMatchObject({ ok: false, searched: false, error: "nothing searched — no index", found: 0 });
    expect(await (await h(post({ question: "q" }))).json()).toEqual({ ok: false, error: "no backend answered" });
    expect(MEMORY_ASK_TIMEOUT_MS).toBeGreaterThan(180_000);
  });

  test("askAnswer: only the contract's shapes pass; sources deduplicated by path and section; the answer capped; ok needs exit 0 and ok", () => {
    const out = askAnswer(JSON.stringify({
      ok: true, answer: "a", found: "2", backend: 7,
      sources: [{ path: "memory/a.md", title: 5, section: "" }, { title: "no path" }, { path: "memory/a.md" }, { path: "memory/a.md", section: "S" }, { path: "memory/a.md", section: "S", title: "again" }],
      pieces: [{ path: "memory/a.md", excerpt: "e" }],
    }), 0, "");
    expect(out).toEqual({ ok: true, answer: "a", sources: [{ path: "memory/a.md" }, { path: "memory/a.md", section: "S" }], found: 0, backend: null, model: null, local: false, held: 0, pieces: [{ path: "memory/a.md", excerpt: "e" }], searched: true });
    const long = askAnswer(JSON.stringify({ ok: true, answer: "y".repeat(ASK_ANSWER_MAX_CHARS * 3) }), 0, "");
    expect([...(long["answer"] as string)].length).toBe(ASK_ANSWER_MAX_CHARS);
    expect((long["answer"] as string).endsWith("…")).toBe(true);
    expect(askAnswer(JSON.stringify({ ok: true, answer: "a" }), 1, "the ledger did not record it")).toMatchObject({ ok: false, error: "the ledger did not record it" });
  });

  test("the page asks, says it is searching, links each source to Read, and keeps the pieces behind a closed toggle", () => {
    expect(PAGE_HTML).toContain('api("/api/memory-ask", { question: q, scope: memKind || "all" })');
    expect(PAGE_HTML).toContain("Searching your memory…");
    expect(PAGE_HTML).toContain("b.onclick = () => openMemory(s.path)");
    expect(PAGE_HTML).toContain('el("details", "changed"); d.append(el("summary", "", "Show the pieces it read');
    expect(PAGE_HTML).not.toMatch(/d\.open = true|<details open/);
    // /search in the chat asks too (D-086: a command is what the page does), and says its sources as text.
    expect(PAGE_HTML).toContain('api("/api/memory-ask", { question: words, scope })');
    expect(PAGE_HTML).toContain('"\\n\\nSources: " + from');
    // The raw route stays for whoever must show raw pieces (the app's management views); the page no longer pastes them.
    expect(PAGE_HTML).not.toContain('api("/api/memory-search"');
  });
});

describe("tasks (D-154): one API for the page and the app, every route a command a person could type", () => {
  const TASK = { id: "t-0000abcd", goal: "g", status: "running" };
  function taskDeps(code = 0) {
    const { deps, runs } = fakeDeps();
    const run: WebDeps["run"] = async (args) => {
      runs.push(args);
      if (args[1] === "list") return { code, stdout: code === 0 ? JSON.stringify({ tasks: [TASK], unreadable: [] }) : "", stderr: "mind task: nope" };
      if (args[1] === "show") return { code, stdout: code === 0 ? JSON.stringify(TASK) : "", stderr: "mind task: no task t-0000abcd" };
      if (args[1] === "new") return { code, stdout: code === 0 ? JSON.stringify({ ok: true, id: "t-0000abcd", detached: true, pid: 9 }) : "", stderr: "mind task: nothing was started — the brake is on" };
      return { code, stdout: "", stderr: code === 0 ? "" : "mind task: no task" };
    };
    return { deps: { ...deps, run, taskScreen: async (id: string) => (id === "t-0000abcd" ? { ok: true as const, image: "data:image/png;base64,AA==", at: "t" } : { ok: false as const, reason: "no screenshot" }) }, runs };
  }

  test("list, show and the screenshot are read with GET; a bad id never reaches a command", async () => {
    const { deps, runs } = taskDeps();
    const h = handler(deps, "tok", HOSTS);
    expect(await (await h(req("/api/tasks"))).json()).toEqual({ tasks: [TASK], unreadable: [] });
    expect(await (await h(req("/api/tasks/t-0000abcd"))).json()).toEqual(TASK);
    expect(await (await h(req("/api/tasks/t-0000abcd/screen"))).json()).toEqual({ ok: true, image: "data:image/png;base64,AA==", at: "t" });
    expect((await h(req("/api/tasks/t-11111111/screen"))).status).toBe(404);
    expect((await h(req("/api/tasks/..%2Fx"))).status).toBe(400);
    expect((await h(req("/api/tasks/t-0000abcd/stop"))).status).toBe(405);
    expect(runs).toEqual([
      ["task", "list", "/a", "--subject", "example", "--json"],
      ["task", "show", "t-0000abcd", "/a", "--subject", "example", "--json"],
    ]);
    const { deps: failing } = taskDeps(2);
    const hf = handler(failing, "tok", HOSTS);
    expect((await hf(req("/api/tasks/t-0000abcd"))).status).toBe(404);
    expect((await hf(req("/api/tasks"))).status).toBe(500);
    const { deps: bare } = fakeDeps();
    expect((await handler(bare, "tok", HOSTS)(req("/api/tasks/t-0000abcd/screen"))).status).toBe(404);
  });

  test("a new task is `task new … --detach`, with every field checked; stop and resume are the commands", async () => {
    const { deps, runs } = taskDeps();
    const h = handler(deps, "tok", HOSTS);
    const post = (path: string, body: unknown) => h(req(path, { method: "POST", body: JSON.stringify(body) }));
    const ok = await post("/api/tasks", { goal: " fill the form ", operate: 2, allow: ["http://host.docker.internal:30999"], backend: "claude-local", budgetTurns: 6, budgetMinutes: 10, model: "haiku" });
    expect(await ok.json()).toEqual({ ok: true, id: "t-0000abcd", detached: true, pid: 9 });
    expect(runs[0]).toEqual([
      "task", "new", "/a", "--subject", "example", "--goal", "fill the form", "--budget-turns", "6", "--budget-minutes", "10",
      "--operate", "2", "--allow", "http://host.docker.internal:30999", "--backend", "claude-local", "--model", "haiku", "--detach", "--json", "--via", "web",
    ]);
    for (const bad of [{}, { goal: "" }, { goal: "-x" }, { goal: "g", operate: 3 }, { goal: "g", budgetTurns: 0 }, { goal: "g", budgetTurns: 1.5 }, { goal: "g", allow: "http://a" }, { goal: "g", allow: ["javascript:x"] }, { goal: "g", backend: "a b" }, { goal: "g", model: "--rm" }]) {
      expect((await post("/api/tasks", bad)).status).toBe(400);
    }
    expect(runs).toHaveLength(1);
    await post("/api/tasks/t-0000abcd/stop", {});
    await post("/api/tasks/t-0000abcd/resume", {});
    expect(runs.slice(1)).toEqual([
      ["task", "stop", "t-0000abcd", "/a", "--subject", "example", "--json"],
      ["task", "resume", "t-0000abcd", "/a", "--subject", "example", "--detach"],
    ]);
    expect((await post("/api/tasks/nope/stop", {})).status).toBe(400);
    const { deps: braked } = taskDeps(4);
    const hb = handler(braked, "tok", HOSTS);
    const refused = await hb(req("/api/tasks", { method: "POST", body: JSON.stringify({ goal: "g" }) }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("the brake is on");
    expect((await hb(req("/api/tasks/t-0000abcd/stop", { method: "POST", body: "{}" }))).status).toBe(409);
  });

  test("D-156: an answer is answered in this process behind the page's key — never by running the CLI", async () => {
    const { deps, runs } = taskDeps();
    const answers: unknown[][] = [];
    const h = handler({
      ...deps,
      taskAnswer: async (task, approval, verdict, stop) => {
        answers.push([task, approval, verdict, stop]);
        if (approval.startsWith("a-2")) return { ok: false as const, kind: "agent" as const, reason: "a turn that can run commands is running for this agent" };
        return verdict === "deny" ? { ok: false as const, kind: "not-allowed" as const, reason: "not allowed yet (D-160)" } : { ok: false as const, kind: "missing" as const, reason: "no such approval" };
      },
    }, "tok", HOSTS);
    const post = (path: string, body: unknown) => h(req(path, { method: "POST", body: JSON.stringify(body) }));
    const id = "a-11111111-2222-4333-8444-555555555555";
    expect((await post(`/api/tasks/t-0000abcd/approvals/${id}/approve`, { stop: true })).status).toBe(404);
    const denied = await post(`/api/tasks/t-0000abcd/approvals/${id}/deny`, { stop: true });
    expect(denied.status).toBe(409);
    expect(((await denied.json()) as { reason: string }).reason).toContain("D-160");
    expect((await post("/api/tasks/t-0000abcd/approvals/../approve", {})).status).toBe(404);
    expect((await post("/api/tasks/t-0000abcd/approvals/a-1/approve", {})).status).toBe(400);
    expect((await h(req(`/api/tasks/t-0000abcd/approvals/${id}/approve`, { method: "POST", body: "{}", token: "wrong" }))).status).toBe(401);
    // Review of PR #24, finding 2: while a loosened turn of the agent runs, the page's answer is refused (403).
    expect((await post("/api/tasks/t-0000abcd/approvals/a-21111111-2222-4333-8444-555555555555/approve", {})).status).toBe(403);
    expect(answers.slice(0, 2)).toEqual([["t-0000abcd", id, "approve", false], ["t-0000abcd", id, "deny", true]]);
    expect(runs).toEqual([]);
    const { deps: bare } = fakeDeps();
    expect((await handler(bare, "tok", HOSTS)(req(`/api/tasks/t-0000abcd/approvals/${id}/approve`, { method: "POST", body: "{}" }))).status).toBe(404);
    expect(PAGE_HTML).toContain('id="taskAskBox"');
    // D-160: no yes button that works for a credential.
    expect(PAGE_HTML).toContain('"Not allowed yet (D-160)"');
    expect(PAGE_HTML).toContain("if (a.approvable === false) yes.disabled = true;");
    // D-158: an interrupted task carries its Resume button in the list.
    expect(PAGE_HTML).toContain("Nothing resumes it on its own.");
    expect(PAGE_HTML).toContain('api("/api/tasks/" + taskId + "/approvals/" + a.id + "/" + verdict, body)');
  });

  test("the page has a Tasks tab that uses exactly these routes", () => {
    for (const id of ["tabTasks", "taskGoal", "taskOperate", "taskAllow", "taskStart", "taskList", "taskDetail"]) expect(PAGE_HTML).toContain(`id="${id}"`);
    expect(PAGE_HTML).toContain('api("/api/tasks", body)');
    expect(PAGE_HTML).toContain('api("/api/tasks/" + t.id + "/screen")');
  });
});
