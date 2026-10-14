/**
 * Measuring the measurement, without spending a single real turn.
 *
 * Every backend here is a fake, and that is the point of the `ExecBackend`
 * seam: the interesting questions — does a wrong answer fail, does a missing
 * CLI read as `silent` rather than `failed`, does an identity on disk that
 * belongs to somebody else ever come back as a pass — are all questions about
 * Mind's judgement, not about any vendor's model.
 *
 * The one thing a fake cannot check is whether a real CLI reads the home we
 * point it at. That lives in `test/cli/soul-verify.test.ts` (stub binaries on a
 * temporary PATH) and in `verify.real.test.ts` (opt-in, this machine).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Availability,
  ExecBackend,
  IdentityStrength,
  TurnRequest,
  TurnResult,
} from "../../src/exec/backend.ts";
import { MARKER_NAMESPACE, splice } from "../../src/soul/block.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { renderSoul } from "../../src/soul/render.ts";
import type { Soul } from "../../src/soul/schema.ts";
import { resolveTargets, type Target } from "../../src/soul/targets.ts";
import {
  buildProbes,
  checkFile,
  contextInjectionNote,
  levelFor,
  normalize,
  PROBES_PER_RUN,
  randomNonce,
  scoreAnswer,
  tally,
  verifyEgressNote,
  verifySoul,
  type Probe,
} from "../../src/soul/verify.ts";
import { subjectId } from "../../src/types.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(prefix = "mind-verify-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function fixture(name: string, subject: string): Promise<Soul> {
  const loaded = await loadSoul(join(FIXTURES, name), subjectId(subject));
  if (!loaded.ok) throw new Error(`fixture ${name} does not load: ${JSON.stringify(loaded.issues)}`);
  return loaded.soul;
}

const soulA = await fixture("soul-valid", "example");
const soulB = await fixture("soul-valid-b", "other-example");

/** Answer a probe the way a session wearing `soul` would. */
function answerFor(prompt: string, soul: Soul, options: { readonly nonce?: boolean } = {}): string {
  const token = options.nonce === false ? "" : `${prompt.match(/nothing else: (\S+) followed/)?.[1] ?? ""} `;
  if (prompt.includes("call the person")) return `${token}${soul.person.addresses_user_as}`;
  if (prompt.includes("refer to yourself")) return `${token}${soul.person.refers_to_self_as[0]}`;
  return `${token}${soul.role.prohibitions[0]}`;
}

type Reply = (prompt: string, call: number) => string;

/** A backend that answers however the test says, and records what it was asked. */
class FakeExec implements ExecBackend {
  readonly kind = "cli" as const;
  readonly calls: TurnRequest[] = [];

  constructor(
    readonly id: string,
    private readonly reply: Reply,
    private readonly options: {
      readonly available?: boolean;
      readonly detail?: string;
      readonly identityStrength?: IdentityStrength;
    } = {},
  ) {}

  get display(): string {
    return `fake ${this.id}`;
  }

  get identityStrength(): IdentityStrength {
    return this.options.identityStrength ?? "user";
  }

  available(): Promise<Availability> {
    return Promise.resolve(
      this.options.available === false
        ? { ok: false, detail: this.options.detail ?? "not on PATH" }
        : { ok: true, detail: "fake" },
    );
  }

  run(request: TurnRequest): Promise<TurnResult> {
    this.calls.push(request);
    const text = this.reply(request.prompt, this.calls.length);
    return Promise.resolve({
      backend: this.id,
      text,
      confidence: text.trim() === "" ? "silent" : "confirmed",
      identityStrength: request.system === undefined ? "none" : "system",
      evidence: { source: this.id, prompt: request.prompt, raw: text, durationMs: 1, exitCode: 0 },
    });
  }
}

async function targetsFor(home: string, ids: readonly string[]): Promise<readonly Target[]> {
  return resolveTargets(ids, { home, cwd: home, env: {}, which: () => Promise.resolve(true) });
}

/** A home whose `~/.claude/CLAUDE.md` holds `soul`'s block, as `apply` would leave it. */
async function homeWearing(soul: Soul, human = "# human notes\n"): Promise<string> {
  const home = await temp();
  await mkdir(join(home, ".claude"), { recursive: true });
  const spliced = splice(human, { subject: soul.subject, body: renderSoul(soul) });
  if (spliced.kind !== "spliced") throw new Error(spliced.reason);
  await writeFile(join(home, ".claude", "CLAUDE.md"), spliced.next);
  return home;
}

describe("buildProbes", () => {
  test("asks three questions, all of them derived from the soul itself", () => {
    const probes = buildProbes(soulA, () => "tok");
    expect(probes.length).toBe(PROBES_PER_RUN);
    expect(probes.map((p) => p.id)).toEqual(["addresses", "self", "prohibition"]);
    expect(probes[0]!.expected).toEqual(["friend"]);
    expect(probes[1]!.expected).toEqual(["the keeper"]);
    expect(probes[2]!.expected).toEqual([soulA.role.prohibitions[0]!]);
  });

  test("a different soul gives different expected answers, with no configuration", () => {
    const probes = buildProbes(soulB, () => "tok");
    expect(probes[0]!.expected).toEqual(["colleague"]);
    expect(probes[1]!.expected).toEqual(["the understudy"]);
  });

  test("no question contains its own answer — otherwise a pass would prove nothing", () => {
    for (const probe of buildProbes(soulA)) {
      for (const expected of probe.expected) {
        expect(normalize(probe.question)).not.toContain(normalize(expected));
      }
    }
  });

  test("the prompt never carries the soul, and forbids reading it off disk", () => {
    const probe = buildProbes(soulA)[0]!;
    expect(probe.question).not.toContain("Example Keeper");
    expect(probe.question).toContain("standing instructions");
    expect(probe.question).toContain("Do not read any file");
  });

  test("every probe carries its own token, and tokens differ between runs", () => {
    const first = buildProbes(soulA);
    const second = buildProbes(soulA);
    const tokens = new Set([...first, ...second].map((p) => p.nonce));
    expect(tokens.size).toBe(6);
    for (const probe of first) expect(probe.question).toContain(probe.nonce);
    expect(randomNonce()).not.toBe(randomNonce());
  });
});

describe("scoreAnswer", () => {
  const probe: Probe = {
    id: "addresses",
    asks: "how it addresses the user",
    question: "ignored here",
    nonce: "abc123",
    expected: ["friend"],
  };
  const said = (text: string) => scoreAnswer(probe, { text, confidence: "confirmed" as const });

  test("the soul's word plus the run token is the only thing that confirms", () => {
    expect(said("abc123 friend")).toBe("confirmed");
  });

  test("case, punctuation and chatter around the answer do not change it", () => {
    expect(said('  ABC123: "Friend."  ')).toBe("confirmed");
    expect(said("abc123 I am told to call you friend.")).toBe("confirmed");
  });

  test("the right answer without the token is believed, but only partly", () => {
    expect(said("friend")).toBe("partial");
  });

  test("another identity's answer is a failure, token or no token", () => {
    expect(said("abc123 colleague")).toBe("failed");
    expect(said("colleague")).toBe("failed");
  });

  test("nothing back is silence, which is never reported as a wrong answer", () => {
    expect(said("")).toBe("silent");
    expect(said("   ")).toBe("silent");
    expect(scoreAnswer(probe, { text: "abc123 friend", confidence: "silent" })).toBe("silent");
  });
});

describe("levelFor", () => {
  test("keeps four levels rather than collapsing to pass/fail (AC3)", () => {
    expect(levelFor(["confirmed", "confirmed", "confirmed"])).toBe("confirmed");
    expect(levelFor(["confirmed", "failed", "confirmed"])).toBe("partial");
    expect(levelFor(["partial", "failed"])).toBe("partial");
    expect(levelFor(["failed", "failed"])).toBe("failed");
    expect(levelFor(["failed", "silent"])).toBe("failed");
    expect(levelFor(["silent", "silent"])).toBe("silent");
    expect(levelFor([])).toBe("silent");
  });
});

describe("checkFile", () => {
  test("a backend with no instruction file is a different kind of target, not a gap", async () => {
    const [target] = await targetsFor(await temp(), ["ollama"]);
    const check = await checkFile(target!, renderSoul(soulA));
    expect(check.state).toBe("system-field");
    expect(check.path).toBeUndefined();
  });

  test("names the three ways a file can fail to hold this soul", async () => {
    const empty = await temp();
    await mkdir(join(empty, ".claude"), { recursive: true });
    const rendered = renderSoul(soulA);

    const [missing] = await targetsFor(empty, ["claude"]);
    expect((await checkFile(missing!, rendered)).state).toBe("missing");

    await writeFile(join(empty, ".claude", "CLAUDE.md"), "# just a human file\n");
    expect((await checkFile(missing!, rendered)).state).toBe("absent");

    const other = await homeWearing(soulB);
    const [otherTarget] = await targetsFor(other, ["claude"]);
    const found = await checkFile(otherTarget!, rendered);
    // `checkFile` compares bytes only; whose block it is gets decided against
    // the requested subject in `verifySoul`.
    expect(found.state).toBe("stale");
    expect(found.subject).toBe(soulB.subject);
  });

  test("a block holding exactly this soul reads as present", async () => {
    const home = await homeWearing(soulA);
    const [target] = await targetsFor(home, ["claude"]);
    const check = await checkFile(target!, renderSoul(soulA));
    expect(check.state).toBe("present");
    expect(check.subject).toBe(soulA.subject);
    expect(check.path).toBe(join(home, ".claude", "CLAUDE.md"));
  });

  test("text edited by hand between the markers is reported, not overlooked", async () => {
    const home = await homeWearing(soulA);
    const path = join(home, ".claude", "CLAUDE.md");
    const text = await Bun.file(path).text();
    await writeFile(path, text.replace("friend", "stranger"));

    const [target] = await targetsFor(home, ["claude"]);
    expect((await checkFile(target!, renderSoul(soulA))).state).toBe("edited");
  });

  test("markers Mind cannot parse are refused rather than guessed at", async () => {
    const home = await temp();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), `${MARKER_NAMESPACE}begin nonsense -->\n`);

    const [target] = await targetsFor(home, ["claude"]);
    expect((await checkFile(target!, renderSoul(soulA))).state).toBe("unreadable");
  });
});

describe("verifySoul", () => {
  test("a backend answering from the soul confirms, with every answer kept (AC2)", async () => {
    const home = await homeWearing(soulA);
    const exec = new FakeExec("claude", (prompt) => answerFor(prompt, soulA));

    const report = await verifySoul(soulA, [exec], {
      targets: await targetsFor(home, ["claude"]),
      runs: 3,
    });

    const [row] = report.backends;
    expect(row!.level).toBe("confirmed");
    expect(row!.file.state).toBe("present");
    expect(row!.runs.length).toBe(9);
    expect(tally(row!)).toEqual({ passed: 9, total: 9 });
    for (const item of row!.runs) {
      expect(item.evidence.prompt).toContain("Question:");
      expect(item.answer.length).toBeGreaterThan(0);
    }
    expect(report.stable).toBe(true);
  });

  test("AC5 — three runs is the default, so instability has something to show", async () => {
    const home = await homeWearing(soulA);
    const exec = new FakeExec("claude", (prompt) => answerFor(prompt, soulA));

    const report = await verifySoul(soulA, [exec], { targets: await targetsFor(home, ["claude"]) });
    expect(report.runs).toBe(3);
    expect(report.backends[0]!.runs.length).toBe(3 * PROBES_PER_RUN);
    expect(new Set(exec.calls.map((c) => c.prompt)).size).toBe(3 * PROBES_PER_RUN);
  });

  test("AC4 — the row says which channel carried the identity, and how strongly", async () => {
    const home = await homeWearing(soulA);
    const file = new FakeExec("claude", (prompt) => answerFor(prompt, soulA));
    const field = new FakeExec("ollama", (prompt) => answerFor(prompt, soulA));

    const report = await verifySoul(soulA, [file, field], {
      targets: await targetsFor(home, ["claude", "ollama"]),
      runs: 1,
    });

    const [claude, ollama] = report.backends;
    expect(claude!.channel.kind).toBe("instruction-file");
    expect(claude!.channel.strength).toBe("user");
    expect(claude!.channel.note).toContain("--append-system-prompt");
    expect(claude!.caveats.join(" ")).toContain("user-level text");

    expect(ollama!.channel.kind).toBe("system-field");
    expect(ollama!.channel.strength).toBe("system");
  });

  test("a file backend is asked with no system text, so a pass can only come from disk", async () => {
    const home = await homeWearing(soulA);
    const file = new FakeExec("claude", (prompt) => answerFor(prompt, soulA));
    const field = new FakeExec("ollama", (prompt) => answerFor(prompt, soulA));

    await verifySoul(soulA, [file, field], {
      targets: await targetsFor(home, ["claude", "ollama"]),
      runs: 1,
      env: { HOME: home },
      cwd: home,
    });

    for (const call of file.calls) expect(call.system).toBeUndefined();
    for (const call of field.calls) expect(call.system).toBe(renderSoul(soulA));
    // The probe has to be aimed at the home the file check read (AC6 depends
    // on the two being the same place).
    expect(file.calls[0]!.env).toEqual({ HOME: home });
    expect(file.calls[0]!.cwd).toBe(home);
    expect(file.calls[0]!.subject).toBe(soulA.subject);
  });

  test("an answer from somewhere else fails, and says the soul is on disk anyway", async () => {
    const home = await homeWearing(soulA);
    const exec = new FakeExec("claude", (prompt) => answerFor(prompt, soulB));

    const report = await verifySoul(soulA, [exec], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });

    const [row] = report.backends;
    expect(row!.level).toBe("failed");
    expect(row!.file.state).toBe("present");
    expect(row!.caveats.join(" ")).toContain("still answered otherwise");
    expect(row!.runs.map((r) => r.verdict)).toEqual(["failed", "failed", "failed"]);
  });

  test("a CLI that is not installed is silent — a failure to run, not a wrong answer", async () => {
    const home = await homeWearing(soulA);
    const exec = new FakeExec("claude", () => "", { available: false, detail: "claude: not on PATH" });

    const report = await verifySoul(soulA, [exec], {
      targets: await targetsFor(home, ["claude"]),
      runs: 3,
    });

    const [row] = report.backends;
    expect(row!.level).toBe("silent");
    expect(row!.reachable).toBe(false);
    expect(row!.runs).toEqual([]);
    expect(row!.reason).toContain("not on PATH");
    expect(exec.calls.length).toBe(0);
  });

  test("a CLI that runs and prints nothing is silent too", async () => {
    const home = await homeWearing(soulA);
    const exec = new FakeExec("claude", () => "");

    const report = await verifySoul(soulA, [exec], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });
    expect(report.backends[0]!.level).toBe("silent");
    expect(report.backends[0]!.reachable).toBe(true);
  });

  test("AC6 — wearing B and asking for A cannot come back as a pass (I-3)", async () => {
    const home = await homeWearing(soulB);
    const answersB = new FakeExec("claude", (prompt) => answerFor(prompt, soulB));

    const report = await verifySoul(soulA, [answersB], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });

    const [row] = report.backends;
    expect(row!.level).toBe("failed");
    expect(row!.file.state).toBe("other-subject");
    expect(row!.file.detail).toContain("other-example");
    expect(row!.caveats.join(" ")).toContain("I-3");
  });

  test("AC6 — even a model that says the right words is failed while B's block is on disk", async () => {
    const home = await homeWearing(soulB);
    const answersA = new FakeExec("claude", (prompt) => answerFor(prompt, soulA));

    const report = await verifySoul(soulA, [answersA], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });

    const [row] = report.backends;
    expect(row!.runs.every((r) => r.verdict === "confirmed")).toBe(true);
    expect(row!.level).toBe("failed");
    expect(row!.reason).toContain("belongs to subject other-example");
  });

  test("a pass with no block on disk is reported as reaching through another channel", async () => {
    const home = await temp();
    await mkdir(join(home, ".claude"), { recursive: true });
    const exec = new FakeExec("claude", (prompt) => answerFor(prompt, soulA));

    const report = await verifySoul(soulA, [exec], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });

    const [row] = report.backends;
    expect(row!.level).toBe("confirmed");
    expect(row!.file.state).toBe("missing");
    expect(row!.caveats.join(" ")).toContain("some other channel");
  });

  test("AC5 — one question moving across runs is tolerated, two is not", async () => {
    const home = await homeWearing(soulA);

    const oneFlip = new FakeExec("claude", (prompt, call) =>
      prompt.includes("call the person") && call > PROBES_PER_RUN ? "nope" : answerFor(prompt, soulA),
    );
    const first = await verifySoul(soulA, [oneFlip], {
      targets: await targetsFor(home, ["claude"]),
      runs: 2,
    });
    expect(first.backends[0]!.flipped).toBe(1);
    expect(first.backends[0]!.stable).toBe(true);
    expect(first.stable).toBe(true);
    expect(first.backends[0]!.level).toBe("partial");

    const twoFlips = new FakeExec("claude", (prompt, call) =>
      (prompt.includes("call the person") || prompt.includes("refer to yourself")) && call > PROBES_PER_RUN
        ? "nope"
        : answerFor(prompt, soulA),
    );
    const second = await verifySoul(soulA, [twoFlips], {
      targets: await targetsFor(home, ["claude"]),
      runs: 2,
    });
    expect(second.backends[0]!.flipped).toBe(2);
    expect(second.backends[0]!.stable).toBe(false);
    expect(second.stable).toBe(false);
  });

  test("an answer with the soul's words but no run token is partial, never confirmed", async () => {
    const home = await homeWearing(soulA);
    const exec = new FakeExec("claude", (prompt) => answerFor(prompt, soulA, { nonce: false }));

    const report = await verifySoul(soulA, [exec], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });
    expect(report.backends[0]!.level).toBe("partial");
    expect(report.backends[0]!.runs.every((r) => r.verdict === "partial")).toBe(true);
  });

  test("verifying costs turns on cloud CLIs, and the report says so (I-6)", async () => {
    const home = await homeWearing(soulA);
    const exec = new FakeExec("claude", (prompt) => answerFor(prompt, soulA));
    const report = await verifySoul(soulA, [exec], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });
    expect(verifyEgressNote(report)).toContain("claude");
  });

  test("writes nothing — the home it measured is byte-identical afterwards", async () => {
    const home = await homeWearing(soulA);
    const path = join(home, ".claude", "CLAUDE.md");
    const before = await Bun.file(path).text();

    await verifySoul(soulA, [new FakeExec("claude", (p) => answerFor(p, soulA))], {
      targets: await targetsFor(home, ["claude"]),
      runs: 1,
    });

    expect(await Bun.file(path).text()).toBe(before);
  });
});

describe("contextInjectionNote", () => {
  test("a session-start hook is reported as competition for attribution", async () => {
    const home = await temp();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );

    const notes = await contextInjectionNote(home);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("SessionStart");
    expect(notes[0]).toContain("blend two identities");
  });

  test("a home with no hooks, no settings, or unreadable settings says nothing", async () => {
    const home = await temp();
    expect(await contextInjectionNote(home)).toEqual([]);

    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{ not json");
    expect(await contextInjectionNote(home)).toEqual([]);

    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    expect(await contextInjectionNote(home)).toEqual([]);
  });

  test("it only reads — a hook is never run, and nothing is written", async () => {
    const home = await temp();
    await mkdir(join(home, ".claude"), { recursive: true });
    const marker = join(home, "hook-ran");
    await writeFile(
      join(home, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] },
      }),
    );

    expect((await contextInjectionNote(home)).length).toBe(1);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
