/**
 * S7.2 AC4 for the owner's own words — "แจ้งก่อน", enforced by a type and by a
 * gate, and measured at the moment the prompt is really handed over.
 *
 * The backlog's own note on AC4 said the criterion was two thirds done: `new`
 * announces what a commit puts beyond reach, `ensureObserverDir` announces what
 * a purge cannot reach, and *"`turn` ยังไม่แจ้งก่อน prompt ออกไปหา cloud"*. This
 * file is the third third, and it asks four questions:
 *
 * 1. does the line get written **before** the backend is handed the prompt, and
 *    only for a backend that was really handed one?
 * 2. is it silent when nothing leaves the machine — because a warning on a run
 *    where nothing happened is how people learn to skip the real one?
 * 3. can anything switch it off? (There must be no flag, no env var, and no
 *    memory of a previous run anywhere in the module.)
 * 4. can a prompt reach an off-machine backend without it? (`tsc` must say no,
 *    and a cast must not be able to say yes.)
 *
 * What none of this proves is that a human read the line. No type can witness a
 * reading; `EGRESS_LIMITS` says so, and the last block here asserts that it
 * still says so.
 */

import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import type { Availability, ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import {
  announceEgress,
  AnnouncedExec,
  dispatchAnnounced,
  EGRESS_LIMITS,
  EGRESS_NOTICE_PREFIX,
  egressLine,
  egressTarget,
  turnChain,
} from "../../src/exec/egress.ts";
import { CliExec } from "../../src/exec/cli-exec.ts";
import { fenceSupport } from "../../src/exec/fence.ts";
import { LocalCliExec } from "../../src/exec/local-cli.ts";
import { asLocal } from "../../src/exec/local.ts";
import { OllamaExec } from "../../src/exec/ollama-exec.ts";
import { vendor } from "../../src/exec/registry.ts";
import { UNDELETABLE, VENDORS_HOLD } from "../../src/ledger/store.ts";
import { subjectId } from "../../src/types.ts";
import { assertionEscapes, constructions, globalsUsed, moduleSpecifiers, sourceFiles } from "../support/ast.ts";
import { RESTRAINED } from "../support/restraint.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
/** The one file allowed to mint the brand and to build the chain. */
const EGRESS = join("src", "exec", "egress.ts");

const REQUEST: TurnRequest = {
  subject: subjectId("example"),
  prompt: "what is the capital of nowhere",
  system: "# Example Keeper\n\nsoul text",
  restraint: RESTRAINED,
};

interface FakeOptions {
  readonly id: string;
  /** false means `available()` says no, so `run` must never be called. */
  readonly ready?: boolean;
  readonly confidence?: TurnResult["confidence"];
}

/**
 * A backend that answers on demand and writes its own name into the same array
 * the notice goes to.
 *
 * One array for both, because the only interesting question about the order is
 * whether the line was written before the prompt was handed over, and two
 * arrays cannot answer it.
 */
function fake(options: FakeOptions, log: string[]): ExecBackend {
  const confidence = options.confidence ?? "confirmed";
  return {
    id: options.id,
    display: `Fake ${options.id}`,
    kind: "cli",
    identityStrength: "system",
    available(): Promise<Availability> {
      log.push(`available:${options.id}`);
      return Promise.resolve({
        ok: options.ready ?? true,
        detail: `${options.id}: fake`,
      });
    },
    run(request: TurnRequest): Promise<TurnResult> {
      log.push(`run:${options.id}`);
      return Promise.resolve({
        backend: options.id,
        text: confidence === "silent" ? "" : `${options.id} answered`,
        confidence,
        identityStrength: "system",
        evidence: { source: options.id, prompt: request.prompt, raw: `raw from ${options.id}` },
      });
    },
  };
}

/** An ollama pointed wherever the case needs it, with no daemon behind it. */
const ollamaAt = (host: string) => new OllamaExec({ host });

// ---------------------------------------------------------------------------
// The line itself
// ---------------------------------------------------------------------------

describe("the line", () => {
  test("it is one line, it names the backend, and it says the send is final", () => {
    const line = egressLine({ kind: "vendor", id: "claude", display: "Claude Code" });

    expect(line).toContain(EGRESS_NOTICE_PREFIX);
    expect(line).toContain("claude");
    expect(line).toContain("cannot take it back");
    // One line, and short enough that a person on a hot path reads all of it.
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(160);
  });

  test("a host Mind knows nothing about is not described as if it were a vendor", () => {
    const host = egressLine({ kind: "host", id: "ollama", host: "http://gpu-box.example:11434" });

    expect(host).toContain("http://gpu-box.example:11434");
    expect(host).toContain("cannot take it back");
    // The vendor sentence is about vendor transcripts on this machine. Saying
    // it about somebody's GPU box would be inventing a fact about a stranger.
    expect(host).toContain("nor say what that host keeps");
    expect(host).not.toContain("transcript");
  });

  test("nothing in it reassures, because Mind has nothing to reassure anyone about", () => {
    // The failure this guards against is the same one `GIT_UNDELETABLE` guards
    // against from the other side: a comforting verb sneaking into the one line
    // people read at the moment they could still stop.
    const lines = [
      egressLine({ kind: "vendor", id: "claude", display: "Claude Code" }),
      egressLine({ kind: "host", id: "ollama", host: "http://gpu-box.example:11434" }),
    ];
    for (const line of lines) {
      for (const word of ["safe", "secure", "encrypted", "private", "don't worry", "as usual"]) {
        expect(line.toLowerCase(), word).not.toContain(word);
      }
    }
  });

  test("Mind does not choose the channel, only that there was one", () => {
    const written: string[] = [];
    const notice = announceEgress((line) => written.push(line), {
      kind: "vendor",
      id: "codex",
      display: "Codex CLI",
    });

    expect(written).toEqual([egressLine({ kind: "vendor", id: "codex", display: "Codex CLI" })]);
    expect(notice).toBeObject();
    expect(Object.isFrozen(notice)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What counts as leaving
// ---------------------------------------------------------------------------

describe("what counts as leaving this machine", () => {
  test("an ollama on a loopback literal has nothing to announce", () => {
    for (const host of ["http://127.0.0.1:11434", "http://127.0.0.2:11434", "http://[::1]:11434"]) {
      expect(egressTarget(ollamaAt(host)), host).toBeUndefined();
    }
  });

  test("the control — a name, or another machine, is a send and is announced", () => {
    // `localhost` is the case that makes this worth testing: it almost always
    // resolves to loopback, and "almost always" is not what `notLoopbackLiteral`
    // accepts, so the notice prints. A resolver is not evidence.
    for (const host of ["http://localhost:11434", "http://gpu-box.example:11434"]) {
      const target = egressTarget(ollamaAt(host));
      expect(target?.kind, host).toBe("host");
      expect(target === undefined ? "" : egressLine(target)).toContain(host);
    }
  });

  test("a vendor CLI is a vendor, by class and not by id", () => {
    const claude = new CliExec(vendor("claude"));
    const target = egressTarget(claude);

    expect(target?.kind).toBe("vendor");
    expect(target === undefined ? "" : egressLine(target)).toContain("claude");
  });

  test("asked of a wrapper, the answer would be wrong — so it is asked of the backend", () => {
    const log: string[] = [];
    const local = ollamaAt("http://127.0.0.1:11434");
    // A wrapper that forwards the id it wraps. `RecordingExec` is exactly this,
    // and `turn` puts one between the announcer and the backend.
    const wrapper = fake({ id: local.id }, log);

    expect(egressTarget(wrapper)?.kind).toBe("vendor");
    expect(egressTarget(local)).toBeUndefined();

    const announced = new AnnouncedExec(wrapper, { origin: local, write: (l) => log.push(l) });
    return announced.run(REQUEST).then(() => {
      // The wrapper ran; nothing was announced, because nothing left.
      expect(log).toEqual(["run:ollama"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Per dispatch, at run time
// ---------------------------------------------------------------------------

describe("announced per dispatch, not per turn", () => {
  test("the line is written before the backend is handed the prompt", async () => {
    const log: string[] = [];
    const cloud = fake({ id: "claude" }, log);
    const announced = new AnnouncedExec(cloud, { origin: cloud, write: (line) => log.push(line) });

    const result = await announced.run(REQUEST);

    expect(log.length).toBe(2);
    expect(log[0]).toContain(EGRESS_NOTICE_PREFIX);
    expect(log[1]).toBe("run:claude");
    expect(result.confidence).toBe("confirmed");
  });

  test("a readiness probe announces nothing, because it hands over no prompt", async () => {
    const log: string[] = [];
    const cloud = fake({ id: "claude" }, log);
    await new AnnouncedExec(cloud, { origin: cloud, write: (line) => log.push(line) }).available();

    expect(log).toEqual(["available:claude"]);
  });

  test("a backend the chain skipped was told nothing, and is not named", async () => {
    const log: string[] = [];
    const missing = fake({ id: "claude", ready: false }, log);
    const local = ollamaAt("http://127.0.0.1:11434");
    const localRunner = fake({ id: "ollama" }, log);

    const chain = turnChain([
      new AnnouncedExec(missing, { origin: missing, write: (line) => log.push(line) }),
      new AnnouncedExec(localRunner, { origin: local, write: (line) => log.push(line) }),
    ]);
    await chain.run(REQUEST);

    expect(log.filter((entry) => entry.includes(EGRESS_NOTICE_PREFIX))).toEqual([]);
    expect(log).toContain("run:ollama");
  });

  test("a backend that was handed the prompt is named, even when it answered nothing", async () => {
    const log: string[] = [];
    const cloud = fake({ id: "claude", confidence: "silent" }, log);
    const local = ollamaAt("http://127.0.0.1:11434");
    const localRunner = fake({ id: "ollama" }, log);

    const chain = turnChain([
      new AnnouncedExec(cloud, { origin: cloud, write: (line) => log.push(line) }),
      new AnnouncedExec(localRunner, { origin: local, write: (line) => log.push(line) }),
    ]);
    const result = await chain.run(REQUEST);

    const notices = log.filter((entry) => entry.includes(EGRESS_NOTICE_PREFIX));
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("claude");
    // The turn was answered locally — and claude still received the prompt.
    expect(result.backend).toBe("ollama");
  });

  test("the wrapper is not a backend an operator chose, so it reports the one it wraps", () => {
    const log: string[] = [];
    const cloud = fake({ id: "claude" }, log);
    const announced = new AnnouncedExec(cloud, { origin: cloud, write: () => undefined });

    expect(announced.id).toBe("claude");
    expect(announced.display).toBe("Fake claude");
    expect(announced.kind).toBe("cli");
    expect(announced.identityStrength).toBe("system");
    expect(turnChain([announced]).id).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// Nothing switches it off
// ---------------------------------------------------------------------------

describe("nobody can silence it", () => {
  test("the second send is announced exactly like the first", async () => {
    const log: string[] = [];
    const cloud = fake({ id: "claude" }, log);
    const announced = new AnnouncedExec(cloud, { origin: cloud, write: (line) => log.push(line) });

    await announced.run(REQUEST);
    await announced.run(REQUEST);

    const notices = log.filter((entry) => entry.includes(EGRESS_NOTICE_PREFIX));
    expect(notices.length).toBe(2);
    expect(notices[0]).toBe(notices[1]!);
  });

  test("there is nothing in the module to set, and nowhere for it to remember a run", async () => {
    const source = await Bun.file(resolve(ROOT, EGRESS)).text();

    // No environment: an exported variable in a shared dotfile or a container
    // image would silence people who never saw the line once.
    expect(globalsUsed(resolve(ROOT, EGRESS), source, ["process", "Bun"])).toEqual([]);
    // No filesystem: an acknowledgement written to disk is a silence that
    // survives reboots, and an agent running as the owner could write it.
    for (const specifier of moduleSpecifiers(resolve(ROOT, EGRESS), source)) {
      expect(specifier.startsWith("node:"), specifier).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The door, and the ways round it
// ---------------------------------------------------------------------------

describe("a prompt cannot leave by this door unannounced", () => {
  test("dispatching without a notice does not compile", async () => {
    const log: string[] = [];
    const cloud = fake({ id: "claude" }, log);

    // @ts-expect-error — an EgressNotice is required, and only announceEgress mints one
    void (() => dispatchAnnounced(cloud, REQUEST));
    // @ts-expect-error — and an ordinary object is not one either
    void (() => dispatchAnnounced({ announced: true }, cloud, REQUEST));

    const notice = announceEgress((line) => log.push(line), {
      kind: "vendor",
      id: "claude",
      display: "Fake claude",
    });
    const result = await dispatchAnnounced(notice, cloud, REQUEST);
    expect(result.confidence).toBe("confirmed");
    expect(log[0]).toContain(EGRESS_NOTICE_PREFIX);
  });

  test("a chain of bare backends does not compile either", () => {
    const cloud = fake({ id: "claude" }, []);
    // @ts-expect-error — turnChain takes AnnouncedExec and nothing else
    void (() => turnChain([cloud]));

    expect(turnChain([new AnnouncedExec(cloud, { origin: cloud, write: () => undefined })])).toBeDefined();
  });

  test("`as EgressNotice` appears in exactly one file", async () => {
    const ALLOWED = [EGRESS];
    const TYPES = ["EgressNotice"];
    const files = [
      ...(await sourceFiles(resolve(ROOT, "src"))),
      ...(await sourceFiles(resolve(ROOT, "test"))),
      // The whole of `bin/`, not the entry point alone: the CLI is several
      // files, and a gate naming one of them would be green over the rest.
      ...(await sourceFiles(resolve(ROOT, "bin"))),
    ];
    // Guards the gate's own scope: an empty file list would make this vacuous.
    expect(files.length).toBeGreaterThan(40);
    // `src/` and `test/` alone clear 40, so the count cannot see `bin/` go.
    expect(files).toContain(resolve(ROOT, "bin", "mind.ts"));

    const escapes: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (ALLOWED.includes(rel)) continue;
      for (const hit of assertionEscapes(path, await Bun.file(path).text(), TYPES, [])) {
        escapes.push(`${rel}:${hit}`);
      }
    }
    expect(escapes).toEqual([]);

    // The reverse: the allowance must still be covering something.
    for (const rel of ALLOWED) {
      const source = await Bun.file(resolve(ROOT, rel)).text();
      expect(assertionEscapes(rel, source, TYPES, []).length, rel).toBeGreaterThan(0);
    }
  }, 30_000);

  test("the chain `turn` runs is built in one place, so the type gate cannot be walked round", async () => {
    const ALLOWED = [EGRESS];
    const files = [...(await sourceFiles(resolve(ROOT, "src"))), ...(await sourceFiles(resolve(ROOT, "bin")))];
    expect(files.length).toBeGreaterThan(20);
    // `src/` alone clears 20, so the count cannot see `bin/` go.
    expect(files).toContain(resolve(ROOT, "bin", "mind.ts"));

    const built: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (ALLOWED.includes(rel)) continue;
      for (const hit of constructions(path, await Bun.file(path).text(), "FallbackExec")) {
        built.push(`${rel}:${hit}`);
      }
    }
    expect(built).toEqual([]);

    for (const rel of ALLOWED) {
      const source = await Bun.file(resolve(ROOT, rel)).text();
      expect(constructions(rel, source, "FallbackExec").length, rel).toBeGreaterThan(0);
    }
  }, 30_000);

  test("the checker reads syntax, not words — the controls", () => {
    const caught = (source: string) => constructions("synthetic.ts", source, "FallbackExec");

    expect(caught(`const c = new FallbackExec([a, b]);`)).not.toEqual([]);
    expect(caught(`// new FallbackExec( in a comment would be a bypass`)).toEqual([]);
    expect(caught(`const s = "new FallbackExec(";`)).toEqual([]);
    expect(caught(`FallbackExec.name;`)).toEqual([]);
    expect(caught(`const c = new OtherExec([a]);`)).toEqual([]);
  });

  test("the announcer is not a local backend, whatever it wraps (I-6)", () => {
    const local = ollamaAt("http://127.0.0.1:11434");
    const announced = new AnnouncedExec(local, { origin: local, write: () => undefined });

    // Same refusal `RecordingExec` gets: a wrapper copies an id, and `asLocal`
    // mints only for an `OllamaExec` itself. Announcing an egress is not a way
    // to become the door `Personal<T>` leaves by.
    expect(asLocal(announced)).toBeUndefined();
    expect(asLocal(local)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// One fact, one string — and the size of what it proves
// ---------------------------------------------------------------------------

describe("what the notice does not do", () => {
  test("the vendor sentence is one string, not two copies that can drift", () => {
    // `ledger forget` prints it after the send; the egress limits print it
    // beside the notice that goes before one. Identity, not similarity: a
    // second copy is a second promise, and only one of them gets updated.
    expect(EGRESS_LIMITS[0]).toBe(VENDORS_HOLD);
    expect(UNDELETABLE[2]).toBe(VENDORS_HOLD);
  });

  test("the limits are in the engine's own output, not only in this comment", () => {
    const limits = EGRESS_LIMITS.join("\n");
    expect(limits).toContain("proves a write, not a reading");
    expect(limits).toContain("no flag, no environment variable and no config key");
    expect(limits).toContain("LOCAL_LIMITS");
    expect(limits).toContain("--private");
    expect(limits).toContain("it announces, it does not ask");
  });

  test("no line in the limits promises something Mind does not do", () => {
    for (const note of EGRESS_LIMITS) {
      expect(note.toLowerCase()).not.toContain("will be deleted");
      expect(note.toLowerCase()).not.toContain("mind removes");
    }
  });
});

describe("D-123's fenced local CLI stays inside the egress door", () => {
  test.skipIf(!fenceSupport().ok)("a prepared local request has no egress target or notice", () => {
    const backend = new LocalCliExec("claude-local", {
      home: "/fixture/home",
      env: { XDG_STATE_HOME: "/fixture/state" },
      cwd: () => "/fixture/agent",
    });
    expect(egressTarget(backend, backend.prepare(REQUEST))).toBeUndefined();
  });
});
