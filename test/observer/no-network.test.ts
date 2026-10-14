/**
 * S3.5 AC2, layers A and B — and the exact size of what they prove.
 *
 * **What is proven: no code in Mind's observer path opens a socket.** Not
 * "it did not this time". The import closure that starts at `src/observer/`
 * contains no module that names a network global, imports a network module, or
 * can start a process — and a subprocess is a network stack with extra steps,
 * so "cannot spawn" is part of "cannot reach a network" rather than a separate
 * story.
 *
 * **What is not proven, and must never be claimed:** that observer data cannot
 * leave this machine. The files are mode 0700 under a 0700 directory, which
 * keeps out *other accounts*. It does not keep out a process running as the
 * owner — and `cli-exec` spawns exactly such a process for every ordinary
 * turn, an agent with its own shell and its own network tools. That limit is
 * written into `OBSERVER_LIMITS`, printed by `observe status`, and asserted
 * below so that deleting it breaks a test.
 *
 * ## Three layers, and this file holds two
 *
 * - **A. static, over the import closure** (here) — the AST, not a grep. A
 *   checker that matched `"node:net"` as text could not see
 *   `import net from "net"`, and the walk that found the files could not see
 *   `await import("./leak.ts")` until it read the tree as well.
 * - **B. traps inside the process** (here) — `fetch`, `WebSocket` and the
 *   `Bun` socket constructors are replaced, then the whole observer cycle runs
 *   through them. Its control calls `fetch` while the traps are up and
 *   requires that the call was recorded.
 * - **C. `strace` over the real CLI** (`no-socket.test.ts`) — the layer that
 *   matches the criterion's own words, and the only one that can see a socket
 *   opened and closed by something neither A nor B is looking at.
 *
 * Layers B and C run against the store S3.5 built. The capture that will fill
 * it is w4's, and the tripwire at the bottom of this file is how w4 finds out:
 * an export added to `src/observer/index.ts` that layer B does not exercise
 * turns this file red rather than quietly shrinking what B covers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import * as observer from "../../src/observer/index.ts";
import {
  ACTIONS_DIR,
  ACTIONS_LIMITS,
  ACTION_KINDS,
  ACTION_TALLIES,
  actionsSummary,
  actionsVocabulary,
  announceCapture,
  appendRecord,
  auditClears,
  AUDIT_EXCERPT,
  AUDIT_FIELDS,
  AUDIT_FILES,
  AUDIT_FLOOR,
  AUDIT_LIMITS,
  AUDIT_PER_FILE,
  BACKFILL_NOTE,
  BUILTIN_TOOLS,
  captureTarget,
  countActions,
  FLEET_ENV,
  FLEET_LEAK_LIMITS,
  fleetLeaks,
  formatActions,
  formatFleetLeaks,
  formatAudit,
  isAction,
  judgeSample,
  monthsOfFiles,
  OWNER_ROW_EMPTY,
  sampleActions,
  SUMMARY_FILE,
  SUMMARY_OTHER,
  SUMMARY_PATH,
  SUMMARY_PROGRAMS,
  SUMMARY_SCHEMA,
  CAPTURE_FIELDS,
  CAPTURE_LIMITS,
  CAPTURE_NOTICE_HEADING,
  CAPTURE_SUBDIR,
  CAPTURE_VENDORS,
  CAPTURE_VERSION,
  capturedKeys,
  captureDir,
  census,
  claudeHook,
  claudeHookSnippet,
  claudeTranscript,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_MEASURED,
  commandTarget,
  commitPurge,
  consentAllows,
  consentDigest,
  consentGrantedAt,
  consentPath,
  consentPhrase,
  consentText,
  CONSENT_FILE,
  CONSENT_HEADING,
  deriveOrigin,
  emptyClaudeIndex,
  emptyGrokIndex,
  ensureCaptureDir,
  ensureObserverDir,
  ensureSessionsDir,
  fileTarget,
  formatRecord,
  formatReport,
  fromValue,
  grokSession,
  hookEvent,
  hookSession,
  indexClaudeLine,
  indexGrokLine,
  isCaptureVendor,
  kindOf,
  loadConsent,
  loadSeeds,
  loadSessionState,
  monthFileName,
  nextSessionState,
  NO_EVIDENCE,
  NO_SESSION,
  observerDir,
  OBSERVER_LIMITS,
  OBSERVER_UNDELETABLE,
  parseRecord,
  planPurge,
  planPurgeDir,
  readCaptured,
  readInto,
  READABLE_FLOOR,
  RECORD_MAX_BYTES,
  requestConsent,
  saveConsent,
  saveSeeds,
  saveSessionState,
  seedVendor,
  SEEDS_FILE,
  SESSIONS_DIR,
  sessionStatePath,
  streamLines,
  targetOf,
  TARGET_MAX,
  textLines,
  transcriptFiles,
  SEED_VENDORS,
  isSeedVendor,
  TERMINAL_SOURCE,
  TURN_KEY_PREFIX,
  turnEvidence,
  turnKey,
  turnOrigin,
  turnOutcome,
  turnRecord,
  type ConsentIo,
  type ObserverEnv,
} from "../../src/observer/index.ts";
import { subjectId } from "../../src/types.ts";
import { importsOf, networkEscapes, processEscapes, reachable, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const OBSERVER = join(ROOT, "src", "observer");
const SPAWN_CHOKEPOINT = join("src", "spawn.ts");
const EXEC_DIR = join("src", "exec") + sep;
const SUBJECT = subjectId("example");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-observer-"));
  scratch.push(dir);
  return dir;
}

/** The closure, computed once per test that wants it, as repo-relative paths. */
async function observerClosure(): Promise<{ paths: Set<string>; rel: string[] }> {
  const paths = await reachable(await sourceFiles(OBSERVER));
  return { paths, rel: [...paths].map((path) => relative(ROOT, path)).sort() };
}

// ---------------------------------------------------------------------------
// A. static — what the observer's import graph is allowed to contain
// ---------------------------------------------------------------------------

describe("A. static — the observer's import closure", () => {
  test("it reaches neither the spawn chokepoint nor anything under src/exec/", async () => {
    const { rel } = await observerClosure();

    // Guards the gate's own scope. A closure that silently went empty — a
    // renamed directory, a walk that stopped at the first file — would make
    // every assertion below vacuously true.
    expect(rel.length).toBeGreaterThan(4);

    expect(rel).not.toContain(SPAWN_CHOKEPOINT);
    expect(rel.filter((path) => path.startsWith(EXEC_DIR))).toEqual([]);
  });

  test("the control: the walk really is transitive, and names what it went through", async () => {
    const { rel } = await observerClosure();

    // None of these is imported by `src/observer/index.ts` directly. They are
    // two and three hops out, so finding them is evidence the walk did not
    // stop at the barrel — which is the way this check would fail open.
    expect(rel).toContain(join("src", "observer", "store.ts"));
    expect(rel).toContain(join("src", "guard", "personal.ts"));
    expect(rel).toContain(join("src", "agent", "repo.ts"));
    expect(rel).toContain(join("src", "state.ts"));
    expect(rel).toContain(join("src", "types.ts"));

    // And the reason `repo.ts` exists at all: the same question used to be
    // answered in `src/agent/new.ts`, which runs `git init`. If the walk ever
    // reaches that file again, the closure has swallowed the chokepoint.
    expect(rel).not.toContain(join("src", "agent", "new.ts"));
  });

  test("nothing in the closure opens a socket", async () => {
    const { paths } = await observerClosure();

    const hits: string[] = [];
    for (const path of paths) {
      const source = await Bun.file(path).text();
      for (const hit of networkEscapes(path, source)) hits.push(`${relative(ROOT, path)}:${hit}`);
    }
    expect(hits).toEqual([]);
  });

  test("nothing in the closure can start a process either", async () => {
    const { paths } = await observerClosure();

    const hits: string[] = [];
    for (const path of paths) {
      const source = await Bun.file(path).text();
      for (const hit of processEscapes(path, source, false)) {
        hits.push(`${relative(ROOT, path)}:${hit}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("the control: the same scanner finds a socket where one really lives", async () => {
    // `src/exec/` is where the network is: `ollama-exec.ts` calls `fetch`, and
    // `cli-exec.ts` spawns. A scanner that reported nothing there would be
    // reporting nothing anywhere, and the four assertions above would mean it.
    const exec = await reachable([join(ROOT, "src", "exec", "index.ts")]);

    const sockets: string[] = [];
    const spawns: string[] = [];
    for (const path of exec) {
      const source = await Bun.file(path).text();
      const rel = relative(ROOT, path);
      if (networkEscapes(path, source).length > 0) sockets.push(rel);
      if (processEscapes(path, source, false).length > 0) spawns.push(rel);
    }

    expect(sockets).toContain(join("src", "exec", "ollama-exec.ts"));
    expect(spawns).toContain(SPAWN_CHOKEPOINT);
  }, 30_000);

  test("the checker catches every spelling of a socket, and ignores comments", () => {
    const caught = (source: string) => networkEscapes("synthetic.ts", source);

    // Both prefixes, because bun resolves both and a checker that knew only
    // one would be a checker with a documented bypass.
    expect(caught(`import net from "node:net";`)).not.toEqual([]);
    expect(caught(`import net from "net";`)).not.toEqual([]);
    expect(caught(`import { lookup } from "node:dns/promises";`)).not.toEqual([]);
    expect(caught(`import { createSocket } from "dgram";`)).not.toEqual([]);
    // Erased at run time, and still a hit: it is a sentence about what this
    // file is for, and the observer has no business writing it.
    expect(caught(`import type { Socket } from "node:tls";`)).not.toEqual([]);
    expect(caught(`await import("node:http2");`)).not.toEqual([]);
    expect(caught(`export { connect } from "node:net";`)).not.toEqual([]);
    expect(caught(`await fetch(url);`)).not.toEqual([]);
    expect(caught(`const ws = new WebSocket(url);`)).not.toEqual([]);
    expect(caught(`new EventSource(url);`)).not.toEqual([]);
    expect(caught(`navigator.sendBeacon(url, body);`)).not.toEqual([]);

    // And the false positives that would make somebody delete the gate.
    expect(caught(`// fetch() is refused in this directory — see AC2.`)).toEqual([]);
    expect(caught(`const note = "import net from 'node:net' would be a leak";`)).toEqual([]);
    expect(caught(`import { join } from "node:path";`)).toEqual([]);
    expect(caught(`await Bun.file(path).text();`)).toEqual([]);
  });

  test("the control: the walk reads the tree, so a dynamic import is not a hole", () => {
    // The regular expression this replaced — /(?:from|import)\s+"(\.[^"]+)"/ —
    // matched neither of the first two, so a module could have imported a
    // spawning one and stayed invisible to the closure.
    expect(importsOf("synthetic.ts", `await import("./leak.ts");`)).toEqual(["./leak.ts"]);
    expect(importsOf("synthetic.ts", `const x = require("./leak.ts");`)).toEqual(["./leak.ts"]);
    expect(importsOf("synthetic.ts", `export * from "./leak.ts";`)).toEqual(["./leak.ts"]);
    expect(importsOf("synthetic.ts", `import type { T } from "./leak.ts";`)).toEqual(["./leak.ts"]);

    // The same words where they are not an import.
    expect(importsOf("synthetic.ts", `// import "./leak.ts";`)).toEqual([]);
    expect(importsOf("synthetic.ts", `const s = 'import "./leak.ts"';`)).toEqual([]);

    // A specifier that cannot be read is a hole in the walk, so it is reported
    // as an escape rather than skipped in silence.
    expect(processEscapes("synthetic.ts", `await import(name);`, false)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. traps — the whole cycle, run with the sockets replaced
// ---------------------------------------------------------------------------

/** A socket constructor replaced for the duration of one test. */
interface Traps {
  /** Every trapped call, in order, as `what(argument)`. */
  readonly calls: string[];
  /** Names that were successfully replaced — asserted, never assumed. */
  readonly installed: string[];
  restore(): void;
}

/**
 * Replace every way this process could reach a network, and write down the
 * attempts.
 *
 * Installation is checked rather than hoped for: a runtime that refused an
 * assignment would leave a trap that records nothing, and a trap that records
 * nothing is indistinguishable from code that never called it. `installed` is
 * asserted against a known list by the control below.
 */
function installTraps(): Traps {
  const calls: string[] = [];
  const installed: string[] = [];
  const undo: Array<() => void> = [];

  const replace = (holder: Record<string, unknown>, name: string, label: string): void => {
    const original = holder[name];
    const trap = (...args: unknown[]): never => {
      calls.push(`${label}(${args.map((arg) => String(arg)).join(", ")})`);
      throw new Error(`${label} is trapped: S3.5 AC2 says the observer path never opens a socket`);
    };
    try {
      // Plain assignment rather than `Object.defineProperty`, because the two
      // are not interchangeable here. Measured on bun 1.4.2: `Bun.connect` is
      // `writable: true, configurable: false`, so redefining it throws
      // "Attempting to change configurable attribute of unconfigurable
      // property" while `Bun.connect = trap` lands. Writing it the other way
      // silently left the Bun constructors untrapped.
      holder[name] = trap;
      if (holder[name] !== trap) return;
      installed.push(label);
      undo.push(() => {
        holder[name] = original;
      });
    } catch {
      // Left out of `installed`, so the assertion below is what notices.
    }
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
    replace(globals, name, name);
  }
  const bun = Bun as unknown as Record<string, unknown>;
  for (const name of ["connect", "listen", "udpSocket", "serve"]) {
    replace(bun, name, `Bun.${name}`);
  }

  return {
    calls,
    installed,
    restore: () => {
      for (const step of undo.splice(0)) step();
    },
  };
}

/**
 * Every runtime export of `src/observer/index.ts`, exercised once.
 *
 * The tripwire below compares this list against the module's actual exports,
 * so w4 adding a capture function without adding it here fails this file
 * instead of silently narrowing what layer B covers.
 */
const EXERCISED: readonly string[] = [
  "FLEET_ENV",
  "FLEET_LEAK_LIMITS",
  "captureTarget",
  "fleetLeaks",
  "formatFleetLeaks",
  "SEED_VENDORS",
  "TERMINAL_SOURCE",
  "TURN_KEY_PREFIX",
  "isSeedVendor",
  "turnEvidence",
  "turnKey",
  "turnOrigin",
  "turnOutcome",
  "turnRecord",
  "ACTIONS_DIR",
  "ACTIONS_LIMITS",
  "ACTION_KINDS",
  "ACTION_TALLIES",
  "AUDIT_EXCERPT",
  "AUDIT_FIELDS",
  "AUDIT_FILES",
  "AUDIT_FLOOR",
  "AUDIT_LIMITS",
  "AUDIT_PER_FILE",
  "BACKFILL_NOTE",
  "BUILTIN_TOOLS",
  "OWNER_ROW_EMPTY",
  "SUMMARY_FILE",
  "SUMMARY_OTHER",
  "SUMMARY_PATH",
  "SUMMARY_PROGRAMS",
  "SUMMARY_SCHEMA",
  "actionsSummary",
  "actionsVocabulary",
  "auditClears",
  "countActions",
  "formatActions",
  "formatAudit",
  "isAction",
  "judgeSample",
  "monthsOfFiles",
  "sampleActions",
  "CAPTURE_FIELDS",
  "CAPTURE_LIMITS",
  "CAPTURE_NOTICE_HEADING",
  "CAPTURE_SUBDIR",
  "CAPTURE_VENDORS",
  "CAPTURE_VERSION",
  "CLAUDE_HOOK_EVENTS",
  "CLAUDE_HOOK_MEASURED",
  "CONSENT_FILE",
  "CONSENT_HEADING",
  "NO_EVIDENCE",
  "NO_SESSION",
  "OBSERVER_DIR",
  "OBSERVER_LIMITS",
  "OBSERVER_UNDELETABLE",
  "READABLE_FLOOR",
  "RECORD_MAX_BYTES",
  "SEEDS_FILE",
  "SESSIONS_DIR",
  "TARGET_MAX",
  "announceCapture",
  "appendRecord",
  "captureDir",
  "capturedKeys",
  "census",
  "claudeHook",
  "claudeHookSnippet",
  "claudeTranscript",
  "commandTarget",
  "commitPurge",
  "consentAllows",
  "consentDigest",
  "consentGrantedAt",
  "consentPath",
  "consentPhrase",
  "consentText",
  "deriveOrigin",
  "emptyClaudeIndex",
  "emptyGrokIndex",
  "ensureCaptureDir",
  "ensureObserverDir",
  "ensureSessionsDir",
  "fileTarget",
  "formatRecord",
  "formatReport",
  "fromValue",
  "grokSession",
  "hookEvent",
  "hookSession",
  "indexClaudeLine",
  "indexGrokLine",
  "isCaptureVendor",
  "kindOf",
  "loadConsent",
  "loadSeeds",
  "loadSessionState",
  "monthFileName",
  "nextSessionState",
  "observerDir",
  "parseRecord",
  "planPurge",
  "planPurgeDir",
  "readCaptured",
  "readInto",
  "requestConsent",
  "saveConsent",
  "saveSeeds",
  "saveSessionState",
  "seedVendor",
  "sessionStatePath",
  "streamLines",
  "targetOf",
  "textLines",
  "transcriptFiles",
];

/** A hook payload shaped like the one claude 2.1.278 sends. Invented values. */
function hookPayload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "s-1",
    transcript_path: "/synthetic/transcript.jsonl",
    cwd: "/synthetic/project",
    permission_mode: "default",
    hook_event_name: event,
    ...extra,
  });
}

/**
 * Consent, capture, seed, read, purge — the whole of w4, run with the sockets
 * replaced.
 *
 * Every runtime export of the barrel is called somewhere in here. The tripwire
 * at the bottom of this file compares the list above against the module's own
 * exports, so a capture function added without a call here turns this file red
 * rather than quietly narrowing what layer B covers.
 */
async function observerCycle(env: ObserverEnv): Promise<void> {
  // Minted with the traps up on purpose: announcing what a purge cannot reach
  // is now on the path to creating the directory, so it is inside what layer B
  // covers rather than beside it.
  const announced: string[] = [];
  const notice = announceCapture((line) => announced.push(line));
  expect(announced[0]).toBe(CAPTURE_NOTICE_HEADING);

  // ---- consent, through an injected terminal ------------------------------
  const said: string[] = [];
  const io: ConsentIo = {
    isTTY: true,
    write: (line) => said.push(line),
    readLine: async () => consentPhrase("capture", SUBJECT),
  };
  const granted = await requestConsent(io, {
    subject: SUBJECT,
    scope: "capture",
    path: "/synthetic/observer",
    now: new Date("2026-09-21T00:00:00.000Z"),
  });
  expect(granted.ok).toBe(true);
  if (!granted.ok) return;
  expect(said[0]).toBe(CONSENT_HEADING);
  expect(consentText("capture").length).toBeGreaterThan(CAPTURE_FIELDS.length);
  expect(granted.record.grants[0]?.digest).toBe(consentDigest(consentText("capture")));
  expect(CAPTURE_LIMITS.length).toBeGreaterThan(0);

  const created = await ensureObserverDir(env, SUBJECT, notice);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.path.endsWith(join("personal", observer.OBSERVER_DIR))).toBe(true);

  await ensureCaptureDir(created.path);
  await ensureSessionsDir(created.path);
  await saveConsent(created.path, granted.record);
  expect(consentPath(created.path).endsWith(CONSENT_FILE)).toBe(true);
  expect(captureDir(created.path).endsWith(CAPTURE_SUBDIR)).toBe(true);

  const stored = await loadConsent(created.path);
  expect(consentAllows(stored, "capture")).toBe(true);
  expect(consentAllows(stored, "seed")).toBe(false);
  expect(consentGrantedAt(stored, "capture")).toBe("2026-09-21T00:00:00.000Z");

  // ---- capture, through the one pipe --------------------------------------
  const prompt = hookPayload("UserPromptSubmit", { prompt: "not kept", source: "user" });
  expect(hookEvent(JSON.parse(prompt))).toBe("UserPromptSubmit");
  const session = hookSession(JSON.parse(prompt));
  expect(session).toBe("s-1");
  const statePath = sessionStatePath(created.path, session ?? "");
  expect(statePath.includes(SESSIONS_DIR)).toBe(true);

  const at = new Date("2026-09-21T10:00:00.000Z");
  const before = await loadSessionState(statePath);
  expect(before).toEqual(NO_SESSION);

  for (const payload of [
    prompt,
    hookPayload("PostToolUse", {
      tool_name: "Edit",
      tool_use_id: "t-1",
      tool_input: { file_path: "/synthetic/project/src/a.ts" },
      tool_response: { ignored: true },
    }),
    hookPayload("PostToolUseFailure", {
      tool_name: "Bash",
      tool_use_id: "t-2",
      tool_input: { command: "git push origin main" },
      error: "refused",
    }),
  ]) {
    const report = await readInto(
      textLines(payload),
      claudeHook({ at: at.toISOString(), session: await loadSessionState(statePath) }),
      async (record) => {
        expect(record.v).toBe(CAPTURE_VERSION);
        const written = await appendRecord(created.path, record, at);
        expect(written.ok).toBe(true);
      },
    );
    expect(report.pct).toBe(100);
    const next = nextSessionState(JSON.parse(payload), await loadSessionState(statePath), at.toISOString());
    if (next !== undefined) await saveSessionState(statePath, next);
  }

  expect(monthFileName(at)).toBe("2026-09.jsonl");
  expect((await capturedKeys(created.path)).size).toBe(3);

  // ---- the turn door (D-032), through the same store ----------------------
  // A fourth record, from Mind's own turn rather than a hook: same append,
  // same key set, and — the point of running it here — no socket opened on the
  // way, because the adapter is pure and the store is a file.
  const turn = turnRecord({
    turnId: "turn-1",
    at: at.toISOString(),
    project: "/synthetic/project",
    backend: "ollama",
    confidence: "confirmed",
    terminal: true,
    proposal: false,
  });
  expect(turn.key).toBe(turnKey("turn-1"));
  expect(turn.key).toBe(`${TURN_KEY_PREFIX}turn-1`);
  expect(turn.origin).toBe(turnOrigin({ terminal: true, proposal: false }));
  expect(turn.outcome).toBe(turnOutcome("confirmed"));
  expect(turn.evidence).toEqual(turnEvidence({ terminal: true }));
  expect(turn.evidence.promptSource).toBe(TERMINAL_SOURCE);
  expect((await appendRecord(created.path, turn, at)).ok).toBe(true);
  expect((await capturedKeys(created.path)).size).toBe(4);
  // Mind itself is a vendor a record may name and not one a seed may read from.
  expect(isSeedVendor("mind")).toBe(false);
  expect(SEED_VENDORS).not.toContain("mind");

  // ---- the pure parts, called where the traps can see them ---------------
  expect(kindOf("Edit")).toBe("file-edit");
  expect(targetOf("command", { command: "git commit -m x" }, "/synthetic")).toBe("git commit");
  expect(commandTarget("docker restart thing")).toBe("docker restart");
  expect(fileTarget("/synthetic/project/a.ts", "/synthetic/project")).toBe("a.ts");
  expect(TARGET_MAX).toBeGreaterThan(0);
  expect(RECORD_MAX_BYTES).toBeGreaterThan(0);
  expect(READABLE_FLOOR).toBe(85);
  expect(deriveOrigin({ ...NO_EVIDENCE, promptSource: "sdk" })).toBe("unattended");
  expect(isCaptureVendor(CAPTURE_VENDORS[0] ?? "")).toBe(true);
  expect(claudeHookSnippet("mind observe capture")).toContain(CLAUDE_HOOK_EVENTS[0] ?? "");
  expect(CLAUDE_HOOK_MEASURED).toContain("claude");

  const back = await readCaptured(created.path);
  // Three from the hook payloads above, one from the turn door (D-032).
  expect(back.report.records).toBe(4);

  const line = formatRecord(sample());
  expect(parseRecord(line).ok).toBe(true);
  expect(fromValue(JSON.parse(line)).ok).toBe(true);
  expect(formatReport(syntheticReport(back.report.records))).toContain("kept");

  // ---- the seed, over a synthetic vendor directory ------------------------
  const root = join(created.path, "..", "synthetic-transcripts");
  await Bun.write(
    join(root, "sess-a.jsonl"),
    [
      JSON.stringify({
        uuid: "u-1",
        sessionId: "seed-1",
        timestamp: "2026-09-20T09:00:00.000Z",
        cwd: "/synthetic/project",
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "invented" }] },
      }),
      JSON.stringify({
        uuid: "u-2",
        sessionId: "seed-1",
        timestamp: "2026-09-20T09:00:01.000Z",
        cwd: "/synthetic/project",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "s-t-1", name: "Write", input: { file_path: "/synthetic/project/b.ts" } }],
        },
      }),
    ].join("\n") + "\n",
  );
  expect((await transcriptFiles(root)).length).toBe(1);

  const claudeIndex = emptyClaudeIndex();
  for await (const text of streamLines(join(root, "sess-a.jsonl"))) {
    if (text.trim() !== "") indexClaudeLine(JSON.parse(text), claudeIndex);
  }
  expect(claudeIndex.humanTurns.get("seed-1")).toBe(1);
  const adapter = claudeTranscript(claudeIndex, at.toISOString());
  expect("records" in adapter({ sessionId: "seed-1", uuid: "u-3" })).toBe(true);

  const grokIndex = emptyGrokIndex();
  indexGrokLine({ role: "user", content: "invented" }, grokIndex, "g-1");
  expect(grokIndex.humanTurns.get("g-1")).toBe(1);
  expect("records" in grokSession(grokIndex, at.toISOString(), "g-1")({ type: "x" })).toBe(true);

  const seeded = await seedVendor({
    observerPath: created.path,
    vendor: "claude",
    root,
    now: at,
    seen: await capturedKeys(created.path),
    repeat: false,
  });
  expect(seeded.written).toBe(2);
  expect(BACKFILL_NOTE).toContain("backfill");

  await saveSeeds(created.path, {
    claude: { at: at.toISOString(), root, records: seeded.written },
  });
  expect((await loadSeeds(created.path)).claude?.records).toBe(2);
  expect(SEEDS_FILE.endsWith(".json")).toBe(true);

  // ---- S3.2: count inside the box, and the audit instrument ---------------
  // Both with the traps up, because these are the two things w5 added that
  // touch the owner's data: one reads the capture store, the other reads vendor
  // transcripts. Neither may reach a socket, and neither does.
  const readBack = await readCaptured(created.path);
  const months = monthsOfFiles(readBack.report.files);
  expect(months).toEqual(["2026-09"]);
  expect(actionsVocabulary(months).length).toBeGreaterThan(ACTION_TALLIES.length);

  const summary = actionsSummary({
    counts: countActions(readBack.records, months),
    months,
    records: readBack.report.records,
    at,
    generator: "mind@test",
  });
  expect(summary.schema).toBe(SUMMARY_SCHEMA);
  expect(summary.counts["2026-09"]?.records).toBe(readBack.report.records);
  expect(formatActions(summary).length).toBeGreaterThan(0);
  expect(OWNER_ROW_EMPTY).toContain("capture");
  expect(ACTIONS_LIMITS.length).toBeGreaterThan(0);
  expect(ACTION_KINDS.length).toBe(3);

  // ---- D-036: the fleet marker, and the leak count ------------------------
  expect(captureTarget("example", { [FLEET_ENV]: "fleet-x" })).toMatchObject({ fleet: true });
  const leaks = fleetLeaks(readBack.records, ["/nowhere"]);
  expect(leaks["/nowhere"]).toBe(0);
  expect(formatFleetLeaks(leaks).length).toBe(1);
  expect(FLEET_LEAK_LIMITS.length).toBeGreaterThan(0);
  expect(isAction(sample())).toBe(true);
  expect(SUMMARY_PROGRAMS).toContain("git");
  expect(BUILTIN_TOOLS).toContain("Edit");
  expect(SUMMARY_OTHER).toBe("other");
  expect(SUMMARY_PATH).toBe(`${ACTIONS_DIR}/${SUMMARY_FILE}`);

  const audited = await sampleActions({
    root,
    vendor: "claude",
    now: at,
    files: AUDIT_FILES,
    perFile: AUDIT_PER_FILE,
    random: () => 0,
  });
  expect(audited.pairs.length).toBeGreaterThan(0);
  expect(audited.pairs[0]?.excerpt.length).toBeLessThanOrEqual(AUDIT_EXCERPT);

  const answers: string[] = [...AUDIT_FIELDS].map(() => "y");
  const verdicts = await judgeSample(
    { isTTY: true, write: () => undefined, readLine: async () => answers.shift() ?? "" },
    { ...audited, pairs: audited.pairs.slice(0, 1) },
  );
  expect(formatAudit(verdicts).length).toBe(AUDIT_FIELDS.length);
  expect(auditClears(verdicts)).toBe(true);
  expect(AUDIT_FLOOR).toBe(80);
  expect(AUDIT_LIMITS.length).toBeGreaterThan(0);

  // ---- count, plan, purge -------------------------------------------------
  const counted = await census(created.path);
  expect(counted.files).toBeGreaterThan(2);

  const resolved = await observerDir(env, SUBJECT);
  expect(resolved.ok).toBe(true);

  // Both entry points, because `erase` (S7.2) uses the second one over trees
  // this file's closure check is the reason to trust.
  const byDir = await planPurgeDir(SUBJECT, created.path);
  expect("ok" in byDir).toBe(false);

  const plan = await planPurge(env, SUBJECT);
  expect("ok" in plan).toBe(false);
  if ("ok" in plan) return;

  const result = await commitPurge(plan);
  expect(result.remaining.files).toBe(0);

  expect(OBSERVER_UNDELETABLE.length).toBeGreaterThan(0);
  expect(OBSERVER_LIMITS.length).toBeGreaterThan(0);
}

/** One invented record, for the format/parse round trip above. */
function sample(): observer.CaptureRecord {
  return {
    v: CAPTURE_VERSION,
    key: "claude:tool:sample",
    at: "2026-09-21T10:00:00.000Z",
    vendor: "claude",
    session: "s-1",
    project: "/synthetic/project",
    kind: "tool",
    tool: "Read",
    target: "",
    outcome: "ok",
    source: "hook",
    origin: "unknown",
    evidence: NO_EVIDENCE,
  };
}

/** A report shaped like one `readInto` returns, for {@link formatReport}. */
function syntheticReport(records: number): observer.ReadReport {
  return { lines: records, parsed: records, accepted: records, duplicates: 0, skipped: {}, pct: 100 };
}

describe("B. traps — the observer cycle with every socket replaced", () => {
  test("a full write → count → purge round trip touches no trapped call", async () => {
    const home = await sandbox();
    const env: ObserverEnv = { home, env: { XDG_DATA_HOME: join(home, "data") } };

    const traps = installTraps();
    try {
      await observerCycle(env);
    } finally {
      traps.restore();
    }

    expect(traps.calls).toEqual([]);
  });

  test("the control: the traps are really installed, and they really bite", async () => {
    const traps = installTraps();
    let threw = false;
    try {
      // If this reached the network it would try to connect to a closed port
      // on loopback, which is the safest thing to attempt. It never gets
      // there: the trap throws before any syscall.
      await fetch("http://127.0.0.1:1/observer-trap-control");
    } catch {
      threw = true;
    } finally {
      traps.restore();
    }

    expect(threw).toBe(true);
    expect(traps.calls.length).toBe(1);
    expect(traps.calls[0]).toContain("observer-trap-control");

    // Named individually, so a runtime that stopped allowing one of these to
    // be replaced is a failure here rather than a quiet gap in the run above.
    expect(traps.installed).toContain("fetch");
    expect(traps.installed).toContain("WebSocket");
    expect(traps.installed).toContain("Bun.connect");
    expect(traps.installed).toContain("Bun.listen");
    expect(traps.installed).toContain("Bun.udpSocket");

    // And the world is put back: a leaked trap would poison every later test.
    expect(String(globalThis.fetch)).not.toContain("is trapped");
  });

  test("the tripwire for w4 — every export of the barrel is exercised above", () => {
    const exported = Object.keys(observer).sort();

    expect(exported).toEqual([...EXERCISED].sort());
    // Read the other way round too, so a function deleted from the module does
    // not leave a name here claiming coverage of something that is gone.
    for (const name of EXERCISED) expect(exported).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// The limits, asserted so that deleting one breaks a test
// ---------------------------------------------------------------------------

describe("what AC2 does not promise", () => {
  test("the vendor-CLI hole is stated in the engine's own output, not only here", () => {
    const limits = OBSERVER_LIMITS.join("\n");
    expect(limits).toContain("vendor CLI");
    expect(limits).toContain("not the claim that observer data cannot leave this machine");

    const undeletable = OBSERVER_UNDELETABLE.join("\n");
    expect(undeletable).toContain("same uid");
  });
});
