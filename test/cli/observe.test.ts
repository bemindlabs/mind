/**
 * `mind observe` through the real binary — and the two rules that, if broken,
 * would damage the owner's own session rather than Mind's.
 *
 * Both were measured off the installed claude (2.1.278) before this was
 * written, and both are asserted here rather than left as a comment, because a
 * comment is not what fails when somebody adds a `console.log`:
 *
 * 1. **`capture` prints nothing on stdout.** A `UserPromptSubmit` hook that
 *    exits 0 has its stdout *shown to the model* — injected into the context of
 *    the turn that is starting. A confirmation line there would feed the
 *    owner's observer data back into a cloud CLI on every prompt, which is I-6
 *    broken by one statement.
 * 2. **`capture` exits 0, always.** Exit 2 on `UserPromptSubmit` blocks the
 *    prompt and erases it; exit 2 on `PostToolUse` pushes stderr at the model.
 *    A recorder is not entitled to do either, so every failure path exits 0 and
 *    says what happened on stderr.
 *
 * Everything runs in a temporary `HOME` with a temporary `XDG_DATA_HOME`. No
 * real home directory is read or written by anything in this file, and no
 * vendor CLI is on the PATH the child gets.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { appendRecord, ensureCaptureDir } from "../../src/observer/capture-store.ts";
import {
  consentDigest,
  consentText,
  saveConsent,
  type ConsentScope,
} from "../../src/observer/consent.ts";
import { ensureSessionsDir } from "../../src/observer/origin.ts";
import { CAPTURE_VERSION, NO_EVIDENCE } from "../../src/observer/record.ts";
import { announceCapture, ensureObserverDir } from "../../src/observer/store.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { sourceFiles } from "../support/ast.ts";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = subjectId("example");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  readonly home: string;
  readonly data: string;
  readonly path: string;
}

async function harness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "mind-observe-cli-"));
  scratch.push(home);
  const path = await barePath(home);
  expectNoVendorOn(path);
  return { home, data: join(home, "data"), path };
}

async function run(
  h: Harness,
  args: readonly string[],
  options: { readonly stdin?: string; readonly env?: Record<string, string> } = {},
) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: ROOT,
    env: {
      HOME: h.home,
      PATH: h.path,
      XDG_DATA_HOME: h.data,
      XDG_STATE_HOME: join(h.home, "state"),
      ...options.env,
    },
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** The observer directory, with consent already in it — the state `enable` leaves. */
async function enabled(h: Harness, ...scopes: readonly ConsentScope[]): Promise<string> {
  return enabledAs(h, SUBJECT, ...scopes);
}

async function enabledAs(
  h: Harness,
  subject: SubjectId,
  ...scopes: readonly ConsentScope[]
): Promise<string> {
  const created = await ensureObserverDir(
    { home: h.home, env: { XDG_DATA_HOME: h.data } },
    subject,
    announceCapture(() => undefined),
  );
  if (!created.ok) throw new Error(created.reason);
  await ensureCaptureDir(created.path);
  await ensureSessionsDir(created.path);
  // One grant per scope, each with the digest of its own text: the two scopes
  // are shown different words, so one hash could only ever satisfy one of them.
  await saveConsent(created.path, {
    v: CAPTURE_VERSION,
    basis: "data-subject-self",
    grants: scopes.map((scope) => ({
      scope,
      at: "2026-09-21T00:00:00.000Z",
      digest: consentDigest(consentText(scope)),
    })),
  });
  return created.path;
}

function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "s-1",
    transcript_path: "/synthetic/transcript.jsonl",
    cwd: "/synthetic/project",
    permission_mode: "default",
    hook_event_name: event,
    ...extra,
  });
}

/** Every file under a tree, so "nothing was written" can be checked rather than assumed. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  };
  await walk(dir);
  return found;
}

// ---------------------------------------------------------------------------
// The two rules
// ---------------------------------------------------------------------------

describe("capture — stdout is silent, because stdout reaches the model", () => {
  test("a payload that really is recorded still prints nothing", async () => {
    const h = await harness();
    const dir = await enabled(h, "capture");

    const result = await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: payload("PostToolUse", {
        tool_name: "Edit",
        tool_use_id: "t-1",
        tool_input: { file_path: "/synthetic/project/a.ts" },
      }),
    });

    // The control: without this, an empty stdout would also be what a command
    // that did nothing at all produces.
    const written = await tree(join(dir, "capture"));
    expect(written.length).toBe(1);
    expect(await Bun.file(written[0] ?? "").text()).toContain("claude:tool:t-1");

    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  });

  test("a prompt event — the one whose stdout is injected — prints nothing either", async () => {
    const h = await harness();
    const dir = await enabled(h, "capture");

    const result = await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: payload("UserPromptSubmit", { prompt: "CANARY-typed", source: "user" }),
    });

    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);

    const written = await tree(dir);
    expect(written.length).toBeGreaterThan(1);
    for (const path of written) {
      expect(await Bun.file(path).text(), path).not.toContain("CANARY");
    }
  });
});

describe("capture — exit 0, on every path", () => {
  const cases: readonly { readonly what: string; readonly args: readonly string[]; readonly stdin: string }[] = [
    { what: "no consent recorded", args: ["--subject", "example"], stdin: payload("PostToolUse") },
    { what: "no --subject at all", args: [], stdin: payload("PostToolUse") },
    { what: "an invalid subject id", args: ["--subject", "Not A Subject"], stdin: payload("PostToolUse") },
    { what: "a format Mind does not read", args: ["--subject", "example", "--from", "codex-hook"], stdin: "{}" },
    { what: "a payload that is not JSON", args: ["--subject", "example"], stdin: "not json at all" },
    { what: "an empty payload", args: ["--subject", "example"], stdin: "" },
    { what: "a payload that is JSON but not an event", args: ["--subject", "example"], stdin: "[1,2,3]" },
  ];

  for (const { what, args, stdin } of cases) {
    test(`${what} — exit 0, stdout empty`, async () => {
      const h = await harness();
      const result = await run(h, ["observe", "capture", ...args], { stdin });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
    });
  }

  test("without consent, nothing is created anywhere — not even a directory", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: payload("PostToolUse", { tool_name: "Edit", tool_use_id: "t-1", tool_input: {} }),
    });

    expect(result.code).toBe(0);
    // The data root is the only tree Mind writes into, and it is checked
    // rather than HOME as a whole: the child's runtime puts its own install
    // cache under a temporary HOME, and that is bun's doing, not Mind's.
    expect(await tree(h.data)).toEqual([]);
  });

  test("MIND_CAPTURE=off keeps an unattended process out of the data entirely", async () => {
    const h = await harness();
    const dir = await enabled(h, "capture");

    const result = await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: payload("PostToolUse", {
        tool_name: "Edit",
        tool_use_id: "t-off",
        tool_input: { file_path: "/synthetic/project/a.ts" },
      }),
      env: { MIND_CAPTURE: "off" },
    });

    expect(result.code).toBe(0);
    expect(await tree(join(dir, "capture"))).toEqual([]);
  });
});

describe("capture — MIND_FLEET moves a fleet launcher out of the owner's subject (D-036)", () => {
  const FLEET = subjectId("fleet-example");
  const edit = (id: string) =>
    payload("PostToolUse", {
      tool_name: "Edit",
      tool_use_id: id,
      tool_input: { file_path: "/synthetic/project/a.ts" },
    });

  test("a marked process lands under the fleet subject, and the owner's stays empty", async () => {
    const h = await harness();
    const owner = await enabled(h, "capture");
    const fleet = await enabledAs(h, FLEET, "capture");

    const result = await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: edit("t-fleet"),
      env: { MIND_FLEET: FLEET },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(await tree(join(owner, "capture"))).toEqual([]);
    const written = await tree(join(fleet, "capture"));
    expect(written.length).toBe(1);
    expect(await Bun.file(written[0] ?? "").text()).toContain("claude:tool:t-fleet");
  });

  test("a fleet subject nobody enabled records nothing — the default for every launcher", async () => {
    const h = await harness();
    const owner = await enabled(h, "capture");

    const result = await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: edit("t-unenabled"),
      env: { MIND_FLEET: FLEET },
    });

    expect(result.code).toBe(0);
    expect(await tree(join(owner, "capture"))).toEqual([]);
  });

  test("a marker that is not a subject id does not fall back to the owner", async () => {
    for (const marker of ["", "../owner", "Not Valid"]) {
      const h = await harness();
      const owner = await enabled(h, "capture");

      const result = await run(h, ["observe", "capture", "--subject", SUBJECT], {
        stdin: edit("t-bad"),
        env: { MIND_FLEET: marker },
      });

      expect(result.code, marker).toBe(0);
      expect(result.stdout, marker).toBe("");
      expect(result.stderr, marker).toContain("MIND_FLEET");
      expect(await tree(join(owner, "capture")), marker).toEqual([]);
    }
  });

  test("the control: with no marker the same payload lands under the hook's subject", async () => {
    const h = await harness();
    const owner = await enabled(h, "capture");

    await run(h, ["observe", "capture", "--subject", SUBJECT], { stdin: edit("t-owner") });

    expect((await tree(join(owner, "capture"))).length).toBe(1);
  });
});

describe("observe leaks — counts under directories the caller names (D-036)", () => {
  test("an unmarked record from a fleet directory is counted, and exits 1", async () => {
    const h = await harness();
    await enabled(h, "capture");
    await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: payload("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "t-leak",
        tool_input: { command: "ls" },
      }),
    });

    const result = await run(h, [
      "observe",
      "leaks",
      "--subject",
      SUBJECT,
      "--fleet-dir",
      "/synthetic/project",
      "--fleet-dir",
      "/synthetic/elsewhere",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/1 {2}\/synthetic\/project {2}← unmarked/);
    expect(result.stdout).toMatch(/0 {2}\/synthetic\/elsewhere\n/);
  });

  test("no record from a named directory exits 0", async () => {
    const h = await harness();
    await enabled(h, "capture");

    const result = await run(h, [
      "observe",
      "leaks",
      "--subject",
      SUBJECT,
      "--fleet-dir",
      "/synthetic/elsewhere",
    ]);

    expect(result.code).toBe(0);
  });

  test("without a directory there is nothing to look for, and that is a usage error", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "leaks", "--subject", SUBJECT]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--fleet-dir");
  });
});

describe("capture cannot bring its own directory into existence", () => {
  test("the code path names neither constructor of the capture tree", async () => {
    // Every file of the CLI, not the entry point alone. This used to parse
    // the entry file because that was the whole CLI; the day the commands
    // moved into `bin/commands/` a single-file parse would have found no
    // `cmdObserveCapture` at all — and `namesIn` returning nothing is a gate
    // that passes every assertion below by saying nothing.
    const parsed = await Promise.all(
      (await sourceFiles(join(ROOT, "bin"))).map(async (path) =>
        ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS),
      ),
    );
    expect(parsed.length).toBeGreaterThan(0);

    /** Identifiers inside the named top-level function declarations. */
    const namesIn = (wanted: readonly string[]): string[] => {
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isFunctionDeclaration(node) &&
          node.name !== undefined &&
          wanted.includes(node.name.text) &&
          node.body !== undefined
        ) {
          const collect = (inner: ts.Node): void => {
            if (ts.isIdentifier(inner)) found.push(inner.text);
            ts.forEachChild(inner, collect);
          };
          collect(node.body);
        }
        ts.forEachChild(node, visit);
      };
      for (const file of parsed) ts.forEachChild(file, visit);
      return found;
    };

    const inCapture = namesIn(["cmdObserveCapture", "captureOnce"]);

    // Guards the check's own scope: an empty list would make it vacuous.
    expect(inCapture).toContain("appendRecord");
    expect(inCapture).toContain("consentAllows");

    // A hook that could create the tree would resume capture after a purge
    // without anybody agreeing to it a second time (I-4), and it would do so
    // without a CaptureNotice ever having been written (S7.2 AC4).
    for (const forbidden of ["ensureObserverDir", "ensureCaptureDir", "ensureSessionsDir", "announceCapture", "mkdir"]) {
      expect(inCapture, `capture must not reach ${forbidden}`).not.toContain(forbidden);
    }

    // And the control for the control: the enabling command does name them.
    const inEnable = namesIn(["cmdObserveEnable"]);
    expect(inEnable).toContain("ensureObserverDir");
    expect(inEnable).toContain("announceCapture");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The other subcommands
// ---------------------------------------------------------------------------

describe("enable — there is no --yes, and no terminal means no", () => {
  test("it refuses without a terminal, and says why the flag does not exist", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "enable", "--subject", SUBJECT], { stdin: "" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--yes");
    // What it did print first is the thing S7.2 AC4 is about: the undeletable
    // list, before anything exists at that address.
    expect(result.stdout).toContain("Before anything is captured");
    // And nothing was created by asking.
    expect(await tree(h.data)).toEqual([]);
  });

  test("--yes really is not a flag: passing it changes nothing", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "enable", "--subject", SUBJECT, "--yes"], { stdin: "" });
    expect(result.code).toBe(1);
    expect(await tree(h.data)).toEqual([]);
  });

  test("a bad --scope is a usage error before anything is printed", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "enable", "--subject", SUBJECT, "--scope", "everything"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--scope");
  });
});

describe("disable — stops recording, deletes nothing", () => {
  test("the consent goes and the records stay", async () => {
    const h = await harness();
    const dir = await enabled(h, "capture");
    await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: payload("PostToolUse", {
        tool_name: "Read",
        tool_use_id: "t-1",
        tool_input: { file_path: "/synthetic/project/a.ts" },
      }),
    });
    expect((await tree(join(dir, "capture"))).length).toBe(1);

    const off = await run(h, ["observe", "disable", "--subject", SUBJECT]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("capture is off");
    expect(await Bun.file(join(dir, "consent.json")).exists()).toBe(false);
    expect((await tree(join(dir, "capture"))).length).toBe(1);

    // And the next event writes nothing, without a second switch.
    await run(h, ["observe", "capture", "--subject", SUBJECT], {
      stdin: payload("PostToolUse", { tool_name: "Read", tool_use_id: "t-2", tool_input: {} }),
    });
    const files = await tree(join(dir, "capture"));
    expect(files.length).toBe(1);
    expect(await Bun.file(files[0] ?? "").text()).not.toContain("t-2");
  });
});

describe("hook --print — a snippet, and nothing written", () => {
  test("stdout is the snippet, the caveats are on stderr, and no file changes", async () => {
    const h = await harness();
    const before = await tree(h.data);

    const result = await run(h, ["observe", "hook", "--print", "--subject", SUBJECT]);
    expect(result.code).toBe(0);

    const parsed = JSON.parse(result.stdout) as { hooks: Record<string, unknown> };
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      "PostToolUse",
      "PostToolUseFailure",
      "UserPromptSubmit",
    ]);
    // Shell-quoted, because this string is pasted into a settings file and run
    // by a shell — a path with a space in it would otherwise become two words.
    expect(result.stdout).toContain(`'observe' 'capture' '--subject' '${SUBJECT}'`);
    expect(result.stderr).toContain("2.1.278");
    expect(result.stderr).toContain("PostToolUseFailure");

    expect(await tree(h.data)).toEqual(before);
  });

  test("without --print it refuses, because printing is all it does", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "hook", "--subject", SUBJECT]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--print");
  });
});

describe("seed — the closed vendor union, and the consent it needs", () => {
  test("a vendor SP-1 measured below the bar is a usage error naming the cost", async () => {
    const h = await harness();
    const result = await run(h, [
      "observe",
      "seed",
      "--subject",
      SUBJECT,
      "--vendor",
      "codex",
      "--root",
      h.home,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("claude, grok");
    expect(result.stderr).toContain("5.4%");
  });

  test("--root has no default, so Mind never goes looking through a home directory", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "seed", "--subject", SUBJECT, "--vendor", "claude"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--root has no default");
  });

  test("a consent to capture is not a consent to import history", async () => {
    const h = await harness();
    await enabled(h, "capture");
    const result = await run(h, [
      "observe",
      "seed",
      "--subject",
      SUBJECT,
      "--vendor",
      "claude",
      "--root",
      h.home,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--scope seed");
  });

  test("a second seed is refused, and says the word for what it would be", async () => {
    const h = await harness();
    const dir = await enabled(h, "seed");
    const root = join(h.home, "transcripts");
    await Bun.write(
      join(root, "a.jsonl"),
      [
        JSON.stringify({
          uuid: "u-0",
          sessionId: "s-1",
          timestamp: "2026-09-20T08:00:00.000Z",
          cwd: "/synthetic/project",
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "invented" }] },
        }),
        JSON.stringify({
          uuid: "u-1",
          sessionId: "s-1",
          timestamp: "2026-09-20T09:00:00.000Z",
          cwd: "/synthetic/project",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t-1", name: "Write", input: { file_path: "/synthetic/project/a.ts" } }],
          },
        }),
      ].join("\n") + "\n",
    );

    const first = await run(h, [
      "observe", "seed", "--subject", SUBJECT, "--vendor", "claude", "--root", root,
    ]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("2 record(s) written");
    expect(await Bun.file(join(dir, "seeds.json")).exists()).toBe(true);

    const second = await run(h, [
      "observe", "seed", "--subject", SUBJECT, "--vendor", "claude", "--root", root,
    ]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already seeded");
    expect(second.stderr).toContain("backfill");

    const again = await run(h, [
      "observe", "seed", "--subject", SUBJECT, "--vendor", "claude", "--root", root, "--again",
    ]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("This is a repeat seed.");
    // Idempotent by key: the repeat added nothing, which is the point.
    expect(again.stdout).toContain("0 record(s) written");
  });
});

describe("status — says whether it is recording, not only how many bytes", () => {
  test("off before, on after, and the path either way", async () => {
    const h = await harness();

    const before = await run(h, ["observe", "status", "--subject", SUBJECT]);
    expect(before.code).toBe(0);
    expect(before.stdout).toContain("capture: off");
    expect(before.stdout).toContain(join("mind", SUBJECT, "personal", "observer"));
    expect(before.stdout).toContain("The size of what capture is:");
    // Asking where it would go does not bring it into existence.
    expect(await tree(h.data)).toEqual([]);

    await enabled(h, "capture");
    const after = await run(h, ["observe", "status", "--subject", SUBJECT]);
    expect(after.stdout).toContain("capture: on since 2026-09-21");
    expect(after.stdout).toContain("scope: capture");
  });

  test("a consent to words this release does not use reads as off, and says why", async () => {
    const h = await harness();
    const dir = await enabled(h, "capture");
    await saveConsent(dir, {
      v: CAPTURE_VERSION,
      basis: "data-subject-self",
      grants: [
        { scope: "capture", at: "2026-08-01T00:00:00.000Z", digest: consentDigest(["we keep almost nothing"]) },
      ],
    });

    const result = await run(h, ["observe", "status", "--subject", SUBJECT]);
    expect(result.stdout).toContain("capture: off");
    expect(result.stdout).toContain("agreed to different words");
  });
});

describe("the subcommand list", () => {
  test("an unknown one names all seven rather than the two it used to", async () => {
    const h = await harness();
    const result = await run(h, ["observe", "wat"]);
    expect(result.code).toBe(2);
    for (const name of ["status", "enable", "disable", "hook", "capture", "seed", "purge"]) {
      expect(result.stderr).toContain(`"${name}"`);
    }
  });

  test("every observe subcommand is in the usage text", async () => {
    const h = await harness();
    const help = await run(h, ["help"]);
    for (const name of ["observe enable", "observe disable", "observe hook", "observe capture", "observe seed"]) {
      expect(help.stdout, name).toContain(name);
    }
  });

  test("D-021 — no path from this machine is written into the engine", async () => {
    // The snippet embeds the engine's own location, which is this checkout, and
    // that is correct. What must never appear is a subject's home or data root.
    const source = await Bun.file(BIN).text();
    expect(source).not.toContain("/home/");
    expect(relative(ROOT, BIN).startsWith("..")).toBe(false);
  });
});

describe("observe patterns — S3.3 through the binary (D-057)", () => {
  test("a command on four mornings is a routine with a time and a trigger snippet; a subagent's is not", async () => {
    const h = await harness();
    const dir = await enabled(h, "capture");
    let i = 0;
    for (const day of ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]) {
      for (const origin of ["unknown", "subagent"] as const) {
        const at = new Date(`${day}T02:10:00Z`);
        await appendRecord(dir, {
          v: CAPTURE_VERSION, key: `k${(i += 1)}`, at: at.toISOString(), vendor: "claude", session: `s-${day}`,
          project: "/synthetic/project", kind: "command", tool: "Bash",
          target: origin === "unknown" ? "bun test" : "docker compose",
          outcome: "ok", source: "hook", origin, evidence: NO_EVIDENCE,
        }, at);
      }
    }

    const before = await tree(dir);
    const result = await run(h, ["observe", "patterns", "--subject", SUBJECT], { env: { TZ: "UTC" } });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("bun test  in /synthetic/project — 4 of 4 active day(s)");
    expect(result.stdout).not.toContain("docker compose");
    expect(result.stdout).toContain("copy what you want into triggers.md yourself");
    expect(result.stdout).toContain("nothing is saved");
    // Nothing is written by asking (AC4): the directory is what it was before.
    expect(await tree(dir)).toEqual(before);
  });

  test("an empty subject says none yet, and a bad --limit is a usage error", async () => {
    const h = await harness();
    await enabled(h, "capture");
    const empty = await run(h, ["observe", "patterns", "--subject", SUBJECT]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("none yet");
    expect((await run(h, ["observe", "patterns", "--subject", SUBJECT, "--limit", "0"])).code).toBe(2);
  });
});
