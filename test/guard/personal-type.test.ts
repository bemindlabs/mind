/**
 * S3.5 AC4 — the one door, and an honest measurement of how wide it is.
 *
 * ## The criterion is narrowed on purpose
 *
 * As written, AC4 says *data flagged `personal` must never leave this machine —
 * only a local model may be chosen*. The first half is a claim about a machine,
 * and everything here is code running on it; nothing in this repository can
 * make it true, so nothing here will tick a box saying it did. What is built,
 * and what these tests check, is the half that can be:
 *
 * > a `Personal<T>` reaches a backend through exactly one function,
 * > `runPersonal`, which accepts only a backend `asLocal` minted. That is an
 * > `OllamaExec` whose host is a loopback **literal**, or a local CLI whose
 * > loopback endpoint, exact port-only turn fence and kernel support all pass.
 *
 * ## Why a type alone could not have done it
 *
 * `BackendKind` defines `"http"` as "an endpoint on this machine **or a
 * reachable host**", and `OllamaExec` reads its host from `OLLAMA_HOST` without
 * checking it. "ollama means local" is therefore a sentence that is false on a
 * machine nobody misconfigured on purpose. Locality is a run-time fact, so the
 * type can only ever hold *evidence that it was checked* — the shape
 * `SubjectId` already uses. Three tests below are that argument, executed:
 * `OLLAMA_HOST` pointing at another host is refused, `localhost` is refused
 * because it is a name, and a wrapper that copies the id `"ollama"` is refused
 * because an id is a string anything can copy. The local CLI cases then show
 * that a trusted implementation name alone is insufficient: locality also
 * depends on the request and the kernel at the moment of the turn.
 *
 * ## What is not proven — asserted here so that deleting it breaks a test
 *
 * `LOCAL_LIMITS` holds four sentences, and each is something a reader could
 * reasonably take "personal data cannot leave this machine" to include and
 * which this code does not deliver: loopback is not local (a tunnel or a proxy
 * passes), an ollama can relay (`*-cloud` models are forwarded by the daemon),
 * the flag stops at the door (an unwrapped string is a string), and a process
 * with the same uid can read the files directly.
 */

import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import { CliExec } from "../../src/exec/cli-exec.ts";
import { FallbackExec } from "../../src/exec/fallback.ts";
import { fenceSupport } from "../../src/exec/fence.ts";
import { LocalCliExec } from "../../src/exec/local-cli.ts";
import {
  asLocal,
  LOCAL_CLI_SEES_PERSONAL,
  LOCAL_LIMITS,
  notLocal,
  notLocalCli,
  notLoopbackLiteral,
  runPersonal,
  type LocalBackend,
} from "../../src/exec/local.ts";
import { OllamaExec } from "../../src/exec/ollama-exec.ts";
import { vendor } from "../../src/exec/registry.ts";
import {
  countPersonal,
  flagPersonal,
  isPersonal,
  subjectId,
  unwrapPersonal,
} from "../../src/types.ts";
import { assertionEscapes, functionTypeParameters, sourceFiles } from "../support/ast.ts";
import { RESTRAINED } from "../support/restraint.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SUBJECT = subjectId("example");
const FENCE_SUPPORT = fenceSupport();

/** A port nothing listens on, so a turn fails fast and locally. */
const DEAD_LOOPBACK = "http://127.0.0.1:1";

// ---------------------------------------------------------------------------
// The box
// ---------------------------------------------------------------------------

describe("Personal<T> — a box, not a brand", () => {
  test("it carries the value and gives it back only when asked by name", () => {
    const boxed = flagPersonal("what the owner typed");

    expect(isPersonal(boxed)).toBe(true);
    expect(unwrapPersonal(boxed)).toBe("what the owner typed");
    // Not a string, and not pretending to be one: `String(boxed)` is what a
    // template literal would produce, and it is not the secret.
    expect(typeof boxed).toBe("object");
    expect(String(boxed)).not.toContain("what the owner typed");
    expect(JSON.stringify(boxed)).toBe("{}");
  });

  test("it boxes anything, because flagging more is never the unsafe direction", () => {
    const record = flagPersonal({ at: "2026-09-21", what: "typed" });
    expect(unwrapPersonal(record).what).toBe("typed");
    expect(isPersonal("an ordinary string")).toBe(false);
    expect(isPersonal(null)).toBe(false);
    expect(isPersonal({ prompt: "looks personal" })).toBe(false);
  });

  test("a brand would have compiled, and that is why this is not one", () => {
    const boxed = flagPersonal("secret");
    const backend = new OllamaExec({ host: DEAD_LOOPBACK, defaultModel: "none" });

    // The whole mechanism, as a compile error. A `string & {__personal: true}`
    // is still a `string`, so this line would have type-checked and the flag
    // would have been decoration on the one call it exists to stop.
    // @ts-expect-error — Personal<string> is not assignable to string
    void (() => backend.run({ subject: SUBJECT, prompt: boxed }));

    // And the door will not take an unchecked backend either.
    // @ts-expect-error — ExecBackend is not a LocalBackend
    void (() => runPersonal(backend, { subject: SUBJECT, prompt: boxed }));
  });
});

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

describe("notLoopbackLiteral — an address, never a name", () => {
  test("the whole 127.0.0.0/8 block and [::1] pass", () => {
    for (const host of [
      "http://127.0.0.1:11434",
      "http://127.0.0.1",
      // Daemons are bound to 127.0.0.2 by people who had a reason.
      "http://127.0.0.2:11434",
      "http://127.255.255.254:11434",
      "http://[::1]:11434",
    ]) {
      expect(notLoopbackLiteral(host), host).toBeUndefined();
    }
  });

  test("`localhost` is refused, and the reason says why a name cannot be evidence", () => {
    const why = notLoopbackLiteral("http://localhost:11434");
    expect(why).toBeString();
    expect(why).toContain("resolver");
  });

  test("a reachable host is refused — which is the OLLAMA_HOST case", () => {
    for (const host of [
      "http://gpu-box.internal:11434",
      "http://192.168.1.5:11434",
      "http://10.0.0.7:11434",
      "https://ollama.example.com",
      // Nearly loopback, and not: 128 is a different network entirely.
      "http://128.0.0.1:11434",
      // Not an address at all.
      "http://127.0.0.999:11434",
      "not a url",
      "",
    ]) {
      expect(notLoopbackLiteral(host), host).toBeString();
    }
  });
});

describe("asLocal — the only constructor", () => {
  test("an ollama on a loopback literal is minted, and is the same object", () => {
    const backend = new OllamaExec({ host: DEAD_LOOPBACK, defaultModel: "none" });
    const local = asLocal(backend);

    expect(local).toBeDefined();
    expect(local).toBe(backend as unknown as LocalBackend);
    expect(notLocal(backend)).toBeUndefined();
  });

  test("an ollama pointed somewhere else is refused", () => {
    const remote = new OllamaExec({ host: "http://gpu-box.internal:11434", defaultModel: "none" });
    expect(asLocal(remote)).toBeUndefined();
    expect(notLocal(remote)).toContain("loopback literal");

    const named = new OllamaExec({ host: "http://localhost:11434", defaultModel: "none" });
    expect(asLocal(named)).toBeUndefined();
  });

  test("a vendor CLI is refused, whatever else is true about it", () => {
    const cli = new CliExec(vendor("claude"));
    expect(asLocal(cli)).toBeUndefined();
    expect(notLocal(cli)).toContain("instanceof");
  });

  test("a local CLI needs this turn's exact port-only fence", () => {
    const backend = new LocalCliExec("claude-local", {
      home: "/fixture/home",
      env: { XDG_STATE_HOME: "/fixture/state" },
      cwd: () => "/fixture/agent",
    });
    const prepared = backend.prepare({ subject: SUBJECT, prompt: "anything", restraint: RESTRAINED });

    // D-123 keeps locality tied to this request's exact fence.
    expect(notLocalCli(backend)).toContain("fence allows TCP port 10400");
    expect(notLocalCli(backend, { ...prepared, fence: { ...prepared.fence!, tcpPorts: [10400, 443] } }))
      .toContain("no other port");
    if (FENCE_SUPPORT.ok) expect(notLocalCli(backend, prepared)).toBeUndefined();
    else expect(notLocalCli(backend, prepared)).toContain("kernel");
  });

  test("a local CLI passes the personal-data door when all three checks pass (D-123)", () => {
    const backend = new LocalCliExec("claude-local", {
      home: "/fixture/home",
      env: { XDG_STATE_HOME: "/fixture/state" },
      cwd: () => "/fixture/agent",
    });
    const prepared = backend.prepare({ subject: SUBJECT, prompt: "anything", restraint: RESTRAINED });
    if (FENCE_SUPPORT.ok) {
      expect(notLocal(backend, prepared)).toBeUndefined();
      expect(asLocal(backend, prepared)).toBeDefined();
      expect(LOCAL_CLI_SEES_PERSONAL).toBe(true);
    } else {
      expect(asLocal(backend, prepared)).toBeUndefined();
    }
  });

  test("a local CLI name cannot make a remote base URL local", () => {
    const backend = new LocalCliExec("grok-local", {
      home: "/fixture/home",
      env: { XDG_STATE_HOME: "/fixture/state" },
      cwd: () => "/fixture/agent",
      baseUrl: "https://models.example.com:10400",
    });
    const prepared = backend.prepare({ subject: SUBJECT, prompt: "anything", restraint: RESTRAINED });
    expect(asLocal(backend, prepared)).toBeUndefined();
    expect(notLocalCli(backend, prepared)).toContain("loopback literal");
  });

  test("a chain is refused, because a chain may end anywhere", () => {
    const local = new OllamaExec({ host: DEAD_LOOPBACK, defaultModel: "none" });
    const chain = new FallbackExec([local, new CliExec(vendor("claude"))]);

    expect(asLocal(chain)).toBeUndefined();
  });

  test("the control: a copied id does not get through — checked by instanceof", () => {
    // `RecordingExec` really does forward the wrapped backend's id, which is
    // correct for a fallback trail and would be a forged passport here. This
    // stands in for it without dragging the ledger into this file: any object
    // claiming `id === "ollama"` is refused.
    const impostor = {
      id: "ollama",
      display: "Ollama (local)",
      kind: "http" as const,
      identityStrength: "system" as const,
      available: async () => ({ ok: true, detail: "" }),
      run: async () => {
        throw new Error("the impostor was asked to run a turn");
      },
    };

    expect(asLocal(impostor)).toBeUndefined();
    expect(notLocal(impostor)).toContain("copy an id");
  });
});

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

describe("runPersonal — the one way through", () => {
  test("it unwraps for the backend and boxes what comes back", async () => {
    // Nothing is listening on port 1, so the turn fails locally and fast.
    // Which outcome it is does not matter here; what matters is the shape of
    // what comes back, and that it never throws.
    const local = asLocal(new OllamaExec({ host: DEAD_LOOPBACK, defaultModel: "none" }));
    expect(local).toBeDefined();
    if (local === undefined) return;

    const answer = await runPersonal(local, { restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: flagPersonal("what the owner typed"),
      timeoutMs: 2_000,
    });

    // Boxed on the way out too. A model asked about personal data answers
    // *from* it, and treating the reply as ordinary text would launder the
    // prompt in one hop — which is the shape most leaks take.
    expect(isPersonal(answer)).toBe(true);
    const result = unwrapPersonal(answer);
    expect(result.backend).toBe("ollama");
    expect(result.confidence).toBe("silent");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// The gate that keeps the door the only one
// ---------------------------------------------------------------------------

describe("no cast writes its way past the door", () => {
  /**
   * The two files allowed to say the words that would turn `tsc` off here.
   *
   * `local.ts` is the door: it mints the brand in `asLocal` and unwraps in
   * `runPersonal`, which is the whole of what AC4 permits. This file is the
   * gate itself and asserts the brand once, to prove `asLocal` hands back the
   * object it was given. Everything else in `src/`, `bin/` and `test/` is
   * refused — `src/types.ts` included, which is not an oversight: it *declares*
   * `Personal` and `unwrapPersonal` and never asserts or calls either, so
   * putting it on this list would be an allowance covering nothing, and the
   * second half of this test refuses those too.
   */
  const ALLOWED: readonly string[] = [
    join("src", "exec", "local.ts"),
    join("src", "observer", "patterns.ts"),
    join("test", "guard", "personal-type.test.ts"),
  ];

  test("the list is three files, and the third is S3.3's miner alone (D-057)", () => {
    // Asserted as a whole rather than by length. S3.2 needed to compute over a
    // `Personal<T>` and got `countPersonal` instead of a line here. S3.3 could
    // not: a routine needs the project, the order and the hour, which no closed
    // vocabulary holds. So the owner opened exactly one more door (D-057) —
    // one file, which prints to a writer it is handed and stores nothing — and
    // the test below keeps anything but `observe` from importing it.
    expect(ALLOWED).toEqual([
      join("src", "exec", "local.ts"),
      join("src", "observer", "patterns.ts"),
      join("test", "guard", "personal-type.test.ts"),
    ]);
  });

  test("only `mind observe` imports the miner, so what it opens goes to a terminal and nowhere else", async () => {
    const importers: string[] = [];
    for (const dir of ["src", "bin"]) {
      for (const path of await sourceFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, path);
        if (/from\s+["'][^"']*observer\/patterns(\.ts)?["']/.test(await Bun.file(path).text())) importers.push(rel);
      }
    }
    expect(importers).toEqual([join("bin", "commands", "observe.ts")]);
    // And the index does not re-export it, which would make every importer of
    // `src/observer` an importer of the miner without naming it.
    expect(await Bun.file(join(ROOT, "src", "observer", "index.ts")).text()).not.toContain("patterns");
  }, 30_000);

  const TYPES = ["LocalBackend", "Personal"];
  const CALLS = ["unwrapPersonal"];

  test("`as LocalBackend`, `as Personal` and unwrapPersonal() appear in two files", async () => {
    const files = [
      ...(await sourceFiles(join(ROOT, "src"))),
      ...(await sourceFiles(join(ROOT, "test"))),
      // The whole of `bin/`, not the entry point alone: the CLI is several
      // files, and a gate naming one of them would be green over the rest.
      ...(await sourceFiles(join(ROOT, "bin"))),
    ];
    // Guards the gate's own scope: a file list that went empty would make the
    // assertion below vacuous.
    expect(files.length).toBeGreaterThan(40);
    // `src/` and `test/` alone clear 40, so the count cannot see `bin/` go.
    expect(files).toContain(join(ROOT, "bin", "mind.ts"));

    const escapes: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (ALLOWED.includes(rel)) continue;
      for (const hit of assertionEscapes(path, await Bun.file(path).text(), TYPES, CALLS)) {
        escapes.push(`${rel}:${hit}`);
      }
    }

    expect(escapes).toEqual([]);

    // The reverse: an allowance that stopped being used should not sit on the
    // list forever claiming to cover something.
    for (const rel of ALLOWED) {
      const source = await Bun.file(join(ROOT, rel)).text();
      expect(
        assertionEscapes(join(ROOT, rel), source, TYPES, CALLS).length,
        `${rel} is allowed but says none of the words`,
      ).toBeGreaterThan(0);
    }
  }, 30_000);

  test("the checker catches both syntaxes, and ignores the same words elsewhere", () => {
    const caught = (source: string) => assertionEscapes("synthetic.ts", source, TYPES, CALLS);

    expect(caught(`const b = x as LocalBackend;`)).not.toEqual([]);
    expect(caught(`const p = x as Personal<string>;`)).not.toEqual([]);
    expect(caught(`const b = <LocalBackend>x;`)).not.toEqual([]);
    expect(caught(`send(unwrapPersonal(boxed));`)).not.toEqual([]);

    // Declaring the type is not asserting it, and the words in prose are prose.
    expect(caught(`let b: LocalBackend;`)).toEqual([]);
    expect(caught(`function f(p: Personal<string>) {}`)).toEqual([]);
    expect(caught(`// unwrapPersonal() is refused outside three files.`)).toEqual([]);
    expect(caught(`const note = "x as LocalBackend would be a bypass";`)).toEqual([]);
    expect(caught(`const n = x as number;`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The second door (S3.2), and why it needs no guard of its own
// ---------------------------------------------------------------------------

/**
 * `countPersonal` is the other way out of the box, and the shape *is* the
 * safety.
 *
 * The owner refused the obvious combinator — `mapPersonal(value, fn)` — on the
 * grounds that a door taking a function is a hole with a guard on it: an AST
 * rule can see the call site and not the body, and the closure it is written
 * inside can copy the boxed value to an outer variable without ever saying
 * `unwrapPersonal`. So the rule here is not about who may call `countPersonal`;
 * it is that there is nothing to pass it that could carry a value out.
 */
describe("countPersonal — a door with no callback in it", () => {
  test("no parameter of it is a function type, so no closure receives the value", async () => {
    const path = join(ROOT, "src", "types.ts");
    const hits = functionTypeParameters(path, await Bun.file(path).text(), "countPersonal");

    // `absent` would mean the function was renamed and this check had stopped
    // checking anything, so it fails the same way a callback would.
    expect(hits).toEqual([]);
  });

  test("the control: the same walk finds a callback where one really is", () => {
    const caught = (source: string) => functionTypeParameters("synthetic.ts", source, "door");

    expect(caught(`function door(v: Personal<T>, fn: (inner: T) => U) {}`)).not.toEqual([]);
    expect(caught(`function door(v: Personal<T>, fn: Function) {}`)).not.toEqual([]);
    expect(caught(`function door(v: Personal<T>, fn?: ((x: T) => U) | undefined) {}`)).not.toEqual([]);
    expect(caught(`function door(v: Personal<T>, fn: new () => T) {}`)).not.toEqual([]);

    // Data, not code — which is what the tallies are.
    expect(caught(`function door(v: Personal<T>, spec: readonly Tally[]) {}`)).toEqual([]);
    expect(caught(`function door(v: Personal<T>, words: readonly string[]) {}`)).toEqual([]);

    // And a function that is not there at all is not silently a pass.
    expect(functionTypeParameters("synthetic.ts", `function other() {}`, "door")).toEqual(["absent"]);
  });

  test("it lets integers out and nothing else, over keys it was handed", () => {
    // The whole proof obligation, executed: the value inside is a path and a
    // server name, and what comes back is two integers under two words the
    // caller wrote in this file.
    const boxed = flagPersonal([
      { kind: "file-edit", tool: "mcp__acme__write", target: "clients/acme-corp/a.ts" },
      { kind: "command", tool: "Bash", target: "git commit" },
    ]);

    const counts = countPersonal(
      boxed,
      [{ key: { parts: [{ literal: "kind" }, { field: "kind" }] } }],
      ["kind|file-edit", "kind|command"],
    );

    expect(counts).toEqual({ "kind|file-edit": 1, "kind|command": 1 });
    expect(JSON.stringify(counts)).not.toContain("acme");
    // Still boxed afterwards: counting is not unwrapping.
    expect(isPersonal(boxed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What none of the above proves
// ---------------------------------------------------------------------------

describe("the size of what AC4 proves", () => {
  test("every limit is stated in the engine's own output, not only in a comment", () => {
    const limits = LOCAL_LIMITS.join("\n");

    expect(limits).toContain("loopback is not the same as local");
    expect(limits).toContain("ssh tunnel");
    expect(limits).toContain("-cloud");
    expect(limits).toContain("the flag stops at the door");
    expect(limits).toContain("same uid");
    // D-124: the local CLIs are admitted on a fence that reaches only LiteLLM; where LiteLLM
    // sends `local-coder` is checked by `doctor` as far as the virtual key can see, not per turn.
    expect(limits).toContain("LiteLLM is trusted beyond what `mind doctor` can see");
    expect(limits).toContain("A turn does not ask.");
    expect(LOCAL_LIMITS.length).toBe(5);
  });

  test("the flag really does stop at the door, which is why that line is there", () => {
    const boxed = flagPersonal("what the owner typed");
    const unwrapped = unwrapPersonal(boxed);

    // Demonstrated rather than asserted in prose: once it is a string it is a
    // string, and no type system follows it into a template or a log line.
    const leaked = `prompt: ${unwrapped}`;
    expect(leaked).toContain("what the owner typed");
    expect(isPersonal(unwrapped)).toBe(false);
  });
});
