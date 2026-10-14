/**
 * `doctor` against machines that do not exist.
 *
 * Every probe in `src/doctor.ts` arrives through {@link DoctorEnv}, which is
 * what makes this file possible: the machines described below have no ollama,
 * three GPUs, a vendor CLI that hangs on `--version`, a vector store with
 * somebody else's collection in it — and none of them is this one. Nothing
 * here reads the real `$HOME`, spawns a process, or opens a socket, and the
 * souls are synthetic (D-021).
 *
 * What is asserted is mostly the shape of a *judgement* rather than a string:
 * that drift is reported as drift rather than printed as two numbers, that a
 * missing commercial CLI is not an exit 1 and a missing model is, and that the
 * count of CLIs follows the registry instead of a literal. A test that pinned
 * `7` could not tell a deliberate seventh CLI from an accidental one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asMib,
  blockers,
  checkLocalAction,
  DOCTOR_LIMITS,
  doctorExit,
  parseNvidiaSmi,
  parseOllamaTags,
  parseQdrantCollections,
  parseModelInfo,
  parseVersion,
  printable,
  renderDoctor,
  routePlace,
  runDoctor,
  type DoctorEnv,
  type DoctorReport,
  type Finding,
  type JsonProbe,
  type ProbeRun,
} from "../src/doctor.ts";
import { readOnlySummary, VENDORS } from "../src/exec/index.ts";
import { COLLECTION_PREFIX } from "../src/memory/collection.ts";
import { splice } from "../src/soul/block.ts";
import { loadSoul } from "../src/soul/load.ts";
import { renderSoul } from "../src/soul/render.ts";
import { REMOTE_VISIBILITY_LIMIT } from "../src/spawn.ts";
import { subjectId } from "../src/types.ts";
import { SOUL_A, SOUL_B, writeSoul } from "./support/synthetic-soul.ts";

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * An engine tree with something in it — the default every fixture below gets.
 *
 * It used to be an empty directory, and that is worse than the bug this file
 * was changed for: every `doctor` test in this suite ran against an engine
 * scan that read nothing and reported `ok clean, 0 file(s)`, so the whole
 * suite walked the broken path and called the machine healthy. A fixture that
 * cannot tell a working check from an absent one is not a fixture.
 */
async function engineSandbox(prefix = "mind-doctor-engine-"): Promise<string> {
  const root = await sandbox(prefix);
  for (const where of ["src", "bin"]) {
    await mkdir(join(root, where), { recursive: true });
    await writeFile(join(root, where, "thing.ts"), "export default 1;\n");
  }
  return root;
}

// ---------------------------------------------------------------------------
// A machine, described
// ---------------------------------------------------------------------------

interface Machine {
  /** Binaries on PATH, mapped to where they are. Anything else is absent. */
  readonly binaries?: Readonly<Record<string, string>>;
  /** What each binary prints for `--version`, or the probe it produces. */
  readonly versions?: Readonly<Record<string, Partial<ProbeRun> | undefined>>;
  readonly tags?: JsonProbe;
  readonly collections?: JsonProbe;
  readonly nvidiaSmi?: Partial<ProbeRun>;
}

/** A machine's hardware and the flags `doctor` was run with, in one object. */
type Described = Machine & Partial<DoctorEnv>;

const NOTHING: ProbeRun = { code: 127, stdout: "", stderr: "not found", timedOut: false };

function probe(partial: Partial<ProbeRun> | undefined): ProbeRun {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...partial };
}

/** Every vendor answering `--version` with exactly the registry's reading. */
function everyVendorCurrent(): Record<string, Partial<ProbeRun>> {
  const versions: Record<string, Partial<ProbeRun>> = {};
  for (const spec of VENDORS) versions[spec.binary] = { stdout: `${spec.measuredAgainst}\n` };
  return versions;
}

function onPath(...names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, `/fake/bin/${name}`]));
}

async function machine(described: Described = {}): Promise<DoctorEnv> {
  const { binaries = {}, versions, tags, collections, nvidiaSmi, ...overrides } = described;
  const home = overrides.home ?? (await sandbox("mind-doctor-home-"));
  // `in` rather than `??`, so that a test can ask for "no checkout at all" —
  // which is what the compiled binary has — and not be handed a sandbox.
  const engineRoot = "engineRoot" in overrides ? overrides.engineRoot : await engineSandbox();

  return {
    home,
    cwd: await sandbox("mind-doctor-cwd-"),
    env: {},
    engineRoot,
    which: (binary) => binaries[binary] ?? null,
    run: async (argv) => {
      const name = argv[0]!;
      if (binaries[name] === undefined) return NOTHING;
      if (name === "nvidia-smi") return probe(nvidiaSmi);
      return probe(versions?.[name]);
    },
    getJson: async (url) =>
      url.includes("/api/tags")
        ? (tags ?? { ok: false, reason: "connection refused" })
        : (collections ?? { ok: false, reason: "connection refused" }),
    ollamaHost: "http://127.0.0.1:11434",
    qdrantHost: "http://127.0.0.1:10300",
    models: [],
    backends: ["ollama", "claude"],
    probeVersions: true,
    ...overrides,
  };
}

/** Tags in the shape ollama's own `/api/tags` uses. */
function tagsFor(models: readonly (readonly [string, number | null])[]): JsonProbe {
  return {
    ok: true,
    body: {
      models: models.map(([name, size]) => (size === null ? { name } : { name, size })),
    },
  };
}

function collectionsFor(names: readonly string[]): JsonProbe {
  return { ok: true, body: { result: { collections: names.map((name) => ({ name })) } } };
}

function findingById(report: DoctorReport, id: string): Finding | undefined {
  return report.sections.flatMap((section) => section.findings).find((f) => f.id === id);
}

/** Every model a healthy fixture machine holds. One is enough for the rule. */
const HEALTHY_TAGS = tagsFor([["some-model:4b", 2_500_000_000]]);

/** A machine where the local route works, so only the thing under test can fail. */
async function healthy(extra: Described = {}): Promise<DoctorEnv> {
  return machine({
    binaries: onPath("ollama", ...VENDORS.map((spec) => spec.binary)),
    versions: { ...everyVendorCurrent(), ollama: { stdout: "ollama version is 0.32.13\n" } },
    tags: HEALTHY_TAGS,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe("parseVersion — six vendors print six shapes", () => {
  test("it reads the version out of each one measured on 2026-09-21", () => {
    expect(parseVersion("2.1.278 (Claude Code)\n")).toBe("2.1.278");
    expect(parseVersion("grok 1.0.40 (eb1a2256660d) [stable]\n")).toBe("1.0.40");
    expect(parseVersion("codex-cli 0.155.1\n")).toBe("0.155.1");
    expect(parseVersion("0.38.2\n")).toBe("0.38.2");
    expect(parseVersion("0.0.367\nCommit: 9b421b4\n")).toBe("0.0.367");
    expect(parseVersion("2.0.2\n")).toBe("2.0.2");
    expect(parseVersion("ollama version is 0.32.13\nWarning: client is 0.13.5\n")).toBe("0.32.13");
  });

  test("a shape with no version in it is undefined, never a guess", () => {
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion("command not found")).toBeUndefined();
    // Two numbers is not a version: reporting `1.0` as one would make every
    // comparison against a three-part registry reading come out as drift.
    expect(parseVersion("1.0\n")).toBeUndefined();
  });

  test("a pre-release suffix survives, because the registry may record one", () => {
    expect(parseVersion("v1.2.3-beta.4 (build)")).toBe("1.2.3-beta.4");
  });
});

describe("parseNvidiaSmi", () => {
  test("it reads the rows this machine's driver prints", () => {
    expect(parseNvidiaSmi("NVIDIA RTX A6000, 21443, 46068\n")).toEqual([
      { name: "NVIDIA RTX A6000", freeMib: 21443, totalMib: 46068 },
    ]);
  });

  test("several GPUs are several rows", () => {
    const gpus = parseNvidiaSmi("A, 1, 2\nB, 3, 4\n");
    expect(gpus.map((gpu) => gpu.name)).toEqual(["A", "B"]);
  });

  test("a row that is not three fields and two numbers is dropped, not guessed at", () => {
    // A driver that adds a column must cost this check one GPU, never produce
    // a free-memory figure read out of the wrong field.
    expect(parseNvidiaSmi("A, 1, 2, 3\n")).toEqual([]);
    expect(parseNvidiaSmi("A, [N/A], 2\n")).toEqual([]);
    expect(parseNvidiaSmi(", 1, 2\n")).toEqual([]);
    expect(parseNvidiaSmi("no GPUs found\n")).toEqual([]);
  });
});

describe("parseOllamaTags", () => {
  test("names and sizes come through", () => {
    expect(parseOllamaTags({ models: [{ name: "a", size: 10 }] })).toEqual([
      { name: "a", bytes: 10 },
    ]);
  });

  test("a model with no size is a model with no size, not a model with zero", () => {
    expect(parseOllamaTags({ models: [{ name: "a" }] })).toEqual([{ name: "a", bytes: null }]);
    expect(parseOllamaTags({ models: [{ name: "a", size: -1 }] })).toEqual([
      { name: "a", bytes: null },
    ]);
  });

  test("an empty list and an unreadable body are different answers", () => {
    // The distinction the whole check turns on: nothing pulled is exit 1,
    // and a proxy's error page is "Mind cannot say what this is".
    expect(parseOllamaTags({ models: [] })).toEqual([]);
    expect(parseOllamaTags({ error: "nope" })).toBeUndefined();
    expect(parseOllamaTags("<html>")).toBeUndefined();
    expect(parseOllamaTags(null)).toBeUndefined();
  });
});

describe("parseQdrantCollections", () => {
  test("it reads the shape this store answers with", () => {
    expect(parseQdrantCollections({ result: { collections: [{ name: "docs" }] } })).toEqual(["docs"]);
  });

  test("anything else is undefined rather than an empty store", () => {
    expect(parseQdrantCollections({ result: {} })).toBeUndefined();
    expect(parseQdrantCollections({})).toBeUndefined();
    expect(parseQdrantCollections([])).toBeUndefined();
    expect(parseQdrantCollections(null)).toBeUndefined();
  });

  test("an entry with no usable name is skipped", () => {
    expect(parseQdrantCollections({ result: { collections: [{ name: "" }, 7, { name: "a" }] } })).toEqual([
      "a",
    ]);
  });
});

describe("asMib", () => {
  test("it rounds up, because a model that needs part of a MiB needs the MiB", () => {
    expect(asMib(1024 * 1024)).toBe(1);
    expect(asMib(1024 * 1024 + 1)).toBe(2);
    expect(asMib(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC1 — the CLIs
// ---------------------------------------------------------------------------

describe("AC1 — what is installed, and whether the registry still describes it", () => {
  test("the expected count follows the registry, and is not a literal", async () => {
    const report = await runDoctor(await healthy());
    const clis = report.sections[0]!;

    expect(clis.title).toContain(`of ${VENDORS.length + 1} reachable`);
    // Every vendor plus the local daemon's own binary, one finding each.
    expect(clis.findings).toHaveLength(VENDORS.length + 1);
  });

  test("a vendor whose installed release is not the measured one is reported as drift", async () => {
    const env = await healthy();
    const spec = VENDORS[1]!;
    const drifted = await machine({
      binaries: onPath("ollama", ...VENDORS.map((v) => v.binary)),
      versions: {
        ...everyVendorCurrent(),
        [spec.binary]: { stdout: "9.9.9\n" },
        ollama: { stdout: "0.32.13\n" },
      },
      tags: HEALTHY_TAGS,
    });

    expect(findingById(await runDoctor(env), `cli.${spec.id}.drift`)).toBeUndefined();

    const finding = findingById(await runDoctor(drifted), `cli.${spec.id}.drift`);
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("9.9.9");
    expect(finding?.detail).toContain(spec.measuredAgainst);
    // Drift is a warning, never a blocker: a vendor moving does not stop this
    // machine working (I-1).
    expect(doctorExit(await runDoctor(drifted))).toBe(0);
  });

  test("every vendor gone is still exit 0 — I-1, and the demo's honest table", async () => {
    const env = await machine({
      binaries: onPath("ollama"),
      versions: { ollama: { stdout: "0.32.13\n" } },
      tags: HEALTHY_TAGS,
    });
    const report = await runDoctor(env);

    // One of seven: the daemon's own binary and nothing else.
    expect(report.sections[0]!.title).toContain(`1 of ${VENDORS.length + 1} reachable`);
    for (const spec of VENDORS) {
      expect(findingById(report, `cli.${spec.id}.absent`)?.severity).toBe("warn");
    }
    expect(doctorExit(report)).toBe(0);
  });

  test("a CLI that hangs on --version is a warning naming the timeout, not a crash", async () => {
    const spec = VENDORS[0]!;
    const env = await machine({
      binaries: onPath("ollama", spec.binary),
      versions: { [spec.binary]: { timedOut: true, code: -1 }, ollama: { stdout: "0.32.13\n" } },
      tags: HEALTHY_TAGS,
    });

    const finding = findingById(await runDoctor(env), `cli.${spec.id}.version`);
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("did not answer");
  });

  test("a CLI that prints nothing readable is `could not read a version`, not drift", async () => {
    const spec = VENDORS[0]!;
    const env = await machine({
      binaries: onPath("ollama", spec.binary),
      versions: { [spec.binary]: { code: 1, stderr: "unknown flag" }, ollama: {} },
      tags: HEALTHY_TAGS,
    });

    const report = await runDoctor(env);
    expect(findingById(report, `cli.${spec.id}.drift`)).toBeUndefined();
    expect(findingById(report, `cli.${spec.id}.version`)?.severity).toBe("warn");
  });

  test("the ollama binary being absent is a warning about the binary, not the daemon", async () => {
    const env = await machine({ binaries: {}, tags: HEALTHY_TAGS });
    const report = await runDoctor(env);

    expect(findingById(report, "cli.ollama.absent")?.severity).toBe("warn");
    // And the daemon, which is the thing that matters, is still fine.
    expect(findingById(report, "ollama.daemon")?.severity).toBe("ok");
    expect(doctorExit(report)).toBe(0);
  });

  test("--no-version starts nothing, and no row is left looking checked", async () => {
    let started = 0;
    const env = await healthy({
      probeVersions: false,
      run: async () => {
        started += 1;
        return { code: 0, stdout: "9.9.9\n", stderr: "", timedOut: false };
      },
    });
    const report = await runDoctor(env);

    // The whole point of the flag: nothing else on this machine is started.
    expect(started).toBe(0);
    for (const spec of VENDORS) {
      const finding = findingById(report, `cli.${spec.id}.unchecked`);
      expect(finding?.severity).toBe("warn");
      expect(finding?.detail).toContain(spec.measuredAgainst);
      expect(findingById(report, `cli.${spec.id}.drift`)).toBeUndefined();
    }
    // Still reachable — not asking is not the same as not being there.
    expect(report.sections[0]!.title).toContain(`${VENDORS.length + 1} of ${VENDORS.length + 1}`);
  });

  test("the cost of asking is declared where somebody would otherwise assume it is free", async () => {
    const asking = await runDoctor(await healthy());
    const quiet = await runDoctor(await healthy({ probeVersions: false }));

    expect(asking.sections[0]!.notes.join(" ")).toContain("is not free");
    expect(quiet.sections[0]!.notes.join(" ")).not.toContain("is not free");
    expect(DOCTOR_LIMITS.join(" ")).toContain("Mind writes nothing here");
    expect(DOCTOR_LIMITS.join(" ")).toContain("--no-version");
  });

  test("each installed vendor's row carries the registry's own read-only answer", async () => {
    const report = await runDoctor(await healthy());
    // Not a second list: `readOnlySummary` is the function `mind backends`
    // prints, and every vendor's row says what it says — including the day a
    // vendor declares `none` again and its row reads "yes — no limit".
    for (const spec of VENDORS) {
      expect(findingById(report, `cli.${spec.id}`)?.detail, spec.id).toContain(`writes? ${readOnlySummary(spec)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — the local route, and the only source of exit 1
// ---------------------------------------------------------------------------

describe("AC2 — ollama is the route that has to work", () => {
  test("an unreachable daemon is the reason this command exits 1", async () => {
    const env = await machine({ binaries: onPath("ollama"), tags: { ok: false, reason: "ECONNREFUSED" } });
    const report = await runDoctor(env);

    expect(findingById(report, "ollama.unreachable")?.severity).toBe("missing");
    expect(doctorExit(report)).toBe(1);
    expect(blockers(report)).toHaveLength(1);
  });

  test("a daemon with nothing pulled is exit 1 too — it can answer nothing", async () => {
    const env = await machine({ binaries: onPath("ollama"), tags: tagsFor([]) });
    const report = await runDoctor(env);

    expect(findingById(report, "ollama.empty")?.severity).toBe("missing");
    expect(doctorExit(report)).toBe(1);
  });

  test("something answering that port in another shape is `cannot say it is an ollama`", async () => {
    const env = await machine({ binaries: onPath("ollama"), tags: { ok: true, body: "<html>" } });
    const report = await runDoctor(env);

    expect(findingById(report, "ollama.unreadable")?.severity).toBe("missing");
    expect(findingById(report, "ollama.empty")).toBeUndefined();
  });

  test("a named model that is not pulled is missing, and one that is is ok", async () => {
    const env = await healthy({ models: ["some-model:4b", "absent-model:70b"] });
    const report = await runDoctor(env);

    expect(findingById(report, "ollama.model.some-model:4b")?.severity).toBe("ok");
    expect(findingById(report, "ollama.model.absent-model:70b")?.severity).toBe("missing");
    expect(doctorExit(report)).toBe(1);
  });

  test("no model is hard-coded: with no --model the only rule is `at least one`", async () => {
    const env = await healthy();
    const report = await runDoctor(env);
    const ollama = report.sections[1]!;

    expect(doctorExit(report)).toBe(0);
    expect(ollama.notes.join(" ")).toContain("a fact about one machine");
    // Nothing in the engine may name a model id (D-021).
    const source = await Bun.file(join(import.meta.dir, "..", "src", "doctor.ts")).text();
    expect(source).not.toContain("qwen");
    expect(source).not.toContain("typhoon");
  });

  test("an OLLAMA_HOST that is not loopback is warned about, in the same words as S3.5", async () => {
    const env = await healthy({ ollamaHost: "http://gpu-box.internal:11434" });
    const finding = findingById(await runDoctor(env), "ollama.host");

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("leaves this machine");
  });
});

// ---------------------------------------------------------------------------
// AC3 — VRAM
// ---------------------------------------------------------------------------

describe("AC3 — free VRAM in MiB, and whether a named model fits", () => {
  test("free and total are reported per GPU", async () => {
    const withGpu = await machine({
      binaries: onPath("ollama", "nvidia-smi", ...VENDORS.map((v) => v.binary)),
      versions: everyVendorCurrent(),
      tags: HEALTHY_TAGS,
      nvidiaSmi: { stdout: "NVIDIA RTX A6000, 21443, 46068\n" },
    });

    const finding = findingById(await runDoctor(withGpu), "gpu.NVIDIA RTX A6000");
    expect(finding?.severity).toBe("ok");
    expect(finding?.detail).toContain("21443 MiB free of 46068 MiB");
  });

  test("no nvidia-smi is `cannot measure`, not zero, and not a failure", async () => {
    const report = await runDoctor(await healthy());
    const finding = findingById(report, "gpu.unmeasurable");

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("supported machine");
    expect(doctorExit(report)).toBe(0);
  });

  test("nvidia-smi answering with nothing readable leaves VRAM unmeasured", async () => {
    const env = await machine({
      binaries: onPath("ollama", "nvidia-smi"),
      tags: HEALTHY_TAGS,
      nvidiaSmi: { code: 9, stdout: "No devices were found\n" },
    });

    expect(findingById(await runDoctor(env), "gpu.unreadable")?.severity).toBe("warn");
  });

  test("a named model larger than what is free is the other source of exit 1", async () => {
    const env = await machine({
      binaries: onPath("ollama", "nvidia-smi"),
      tags: tagsFor([["big:70b", 40 * 1024 * 1024 * 1024]]),
      nvidiaSmi: { stdout: "GPU0, 2000, 46068\n" },
      models: ["big:70b"],
    });
    const report = await runDoctor(env);

    const short = findingById(report, "gpu.short");
    expect(short?.severity).toBe("missing");
    expect(short?.detail).toContain("40960 MiB");
    expect(doctorExit(report)).toBe(1);
  });

  test("the freest GPU is the one that decides, not the first one listed", async () => {
    const env = await machine({
      binaries: onPath("ollama", "nvidia-smi"),
      tags: tagsFor([["small:4b", 100 * 1024 * 1024]]),
      nvidiaSmi: { stdout: "GPU0, 10, 46068\nGPU1, 90000, 46068\n" },
      models: ["small:4b"],
    });

    expect(findingById(await runDoctor(env), "gpu.fits")?.severity).toBe("ok");
  });

  test("a named model with no reported size leaves the free figure standing alone", async () => {
    const env = await machine({
      binaries: onPath("ollama", "nvidia-smi"),
      tags: tagsFor([["sizeless:4b", null]]),
      nvidiaSmi: { stdout: "GPU0, 10, 46068\n" },
      models: ["sizeless:4b"],
    });
    const report = await runDoctor(env);

    expect(findingById(report, "gpu.short")).toBeUndefined();
    expect(findingById(report, "gpu.fits")).toBeUndefined();
    expect(report.sections[2]!.notes.join(" ")).toContain("stands on its own");
  });

  test("the estimate is declared, with what it does not count", () => {
    expect(DOCTOR_LIMITS.join(" ")).toContain("KV cache");
    expect(DOCTOR_LIMITS.join(" ")).toContain("context window");
  });
});

// ---------------------------------------------------------------------------
// AC4 — the vector store, and the collection that is not Mind's
// ---------------------------------------------------------------------------

describe("AC4 — the store, and what D-007 says about a shared collection", () => {
  test("`docs` is reported as not Mind's, with the reason", async () => {
    const env = await healthy({ collections: collectionsFor(["docs"]) });
    const finding = findingById(await runDoctor(env), "qdrant.foreign.docs");

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("D-007");
    expect(finding?.detail).toContain("no delete");
  });

  test("a collection Mind named is reported as ours, with the subject", async () => {
    const env = await healthy({ collections: collectionsFor([`${COLLECTION_PREFIX}example`]) });
    const report = await runDoctor(env);

    expect(findingById(report, `qdrant.ours.${COLLECTION_PREFIX}example`)?.detail).toContain(
      "subject example",
    );
    expect(findingById(report, "qdrant.none-of-ours")).toBeUndefined();
  });

  test("no collection of Mind's is expected today, and says so", async () => {
    const env = await healthy({ collections: collectionsFor(["docs"]) });
    const finding = findingById(await runDoctor(env), "qdrant.none-of-ours");

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("S4.1");
    expect(finding?.detail).toContain("not a fault");
  });

  test("an unreachable store is a capability that is absent, never exit 1", async () => {
    const env = await healthy({ collections: { ok: false, reason: "ECONNREFUSED" } });
    const report = await runDoctor(env);

    expect(findingById(report, "qdrant.unreachable")?.severity).toBe("warn");
    expect(doctorExit(report)).toBe(0);
  });

  test("a body that is not a collection list is unreadable, not empty", async () => {
    const env = await healthy({ collections: { ok: true, body: { status: "ok" } } });
    expect(findingById(await runDoctor(env), "qdrant.unreadable")?.severity).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// AC5 — which identity is worn
// ---------------------------------------------------------------------------

describe("AC5 — the worn identity, answered by the function `worn` answers with", () => {
  /**
   * A home whose `CLAUDE.md` really holds one soul's block.
   *
   * Written with `splice` and `renderSoul` — the same two functions `soul
   * apply` writes with — so that what `doctor` reads back is a block an actual
   * apply would have produced, markers, hash and all.
   */
  async function homeWearing(soul: typeof SOUL_A): Promise<string> {
    const home = await sandbox("mind-doctor-worn-");
    await mkdir(join(home, ".claude"), { recursive: true });

    const written = await writeSoul(await sandbox("mind-doctor-souls-"), soul);
    const loaded = await loadSoul(written, subjectId(soul.subject));
    if (!loaded.ok) throw new Error("fixture soul did not load");

    const result = splice("# a human wrote this\n", {
      subject: loaded.soul.subject,
      body: renderSoul(loaded.soul),
    });
    if (result.kind !== "spliced") throw new Error(result.reason);

    await writeFile(join(home, ".claude", "CLAUDE.md"), result.next);
    return home;
  }

  test("a home with no block reads as wearing nothing, and is still exit 0", async () => {
    const home = await sandbox("mind-doctor-bare-");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "# nothing of Mind's\n");

    const report = await runDoctor(await healthy({ home, backends: ["claude"] }));
    const finding = findingById(report, "worn.verdict");

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("wearing nothing");
    // Which identity is on is not a readiness question (AC7).
    expect(doctorExit(report)).toBe(0);
  });

  test("one block is reported as wearing that subject", async () => {
    const home = await homeWearing(SOUL_A);
    const report = await runDoctor(await healthy({ home, backends: ["claude"] }));

    expect(findingById(report, "worn.verdict")?.severity).toBe("ok");
    expect(findingById(report, "worn.verdict")?.detail).toContain(`wearing ${SOUL_A.subject}`);
    expect(findingById(report, "worn.claude")?.severity).toBe("ok");
  });

  test("--subject asks about one identity, and is told no about the other", async () => {
    const home = await homeWearing(SOUL_A);

    const mine = await runDoctor(
      await healthy({ home, backends: ["claude"], subject: subjectId(SOUL_A.subject) }),
    );
    expect(findingById(mine, "worn.asked")?.severity).toBe("ok");

    const theirs = await runDoctor(
      await healthy({ home, backends: ["claude"], subject: subjectId(SOUL_B.subject) }),
    );
    expect(findingById(theirs, "worn.asked")?.severity).toBe("warn");
    // Still not a readiness failure: `mind worn` is what exits 1 on it.
    expect(doctorExit(theirs)).toBe(0);
  });

  test("a backend with no file at any scope is a row, not a silence", async () => {
    const report = await runDoctor(await healthy({ backends: ["ollama"] }));
    const finding = findingById(report, "worn.ollama");

    expect(finding?.severity).toBe("ok");
    expect(finding?.detail).toContain("system-field");
  });

  test("the caveats `worn` prints travel with the answer", async () => {
    const report = await runDoctor(await healthy({ backends: ["claude"] }));
    expect(report.sections[4]!.notes.join(" ")).toContain("I-4");
  });
});

// ---------------------------------------------------------------------------
// D-014 and AC6 — the agent repository
// ---------------------------------------------------------------------------

describe("D-014 — is this identity's .mind/ stale", () => {
  test("a repository with no .mind is `missing`, and not an exit 1", async () => {
    const agent = await sandbox("mind-doctor-agent-");
    const report = await runDoctor(
      await healthy({ agent, subject: subjectId("example") }),
    );

    const finding = findingById(report, "agent.derived");
    expect(finding?.label).toBe("missing");
    expect(finding?.severity).toBe("warn");
    expect(doctorExit(report)).toBe(0);
  });

  test("with no --agent there is no agent section at all", async () => {
    const report = await runDoctor(await healthy());
    expect(report.sections.some((section) => section.title.startsWith("agent"))).toBe(false);
  });

  test("a directory that is not a repository says so, instead of counting zero commits", async () => {
    const agent = await sandbox("mind-doctor-notrepo-");
    const report = await runDoctor(await healthy({ agent, subject: subjectId("example") }));

    // `historyFacts` shells out to git, and a non-repository answers with a
    // non-zero exit rather than an exception — so the count comes back 0 and
    // the remote list empty, which is exactly what a healthy fresh repository
    // looks like. Reporting that as `ok` would be a green line produced by a
    // probe that never answered, which is the engine bug in another place.
    const finding = findingById(report, "agent.notrepo");
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("not a git repository");
    expect(findingById(report, "agent.commits")).toBeUndefined();
    expect(findingById(report, "agent.remotes")).toBeUndefined();
    // Still not a readiness failure: I-1 is about the local route (AC7).
    expect(doctorExit(report)).toBe(0);
  });

  test("a real repository is counted, and a repository before its first commit is not `0`", async () => {
    const agent = await sandbox("mind-doctor-realrepo-");
    const init = Bun.spawn(["git", "init", "-q", agent], { stdout: "pipe", stderr: "pipe" });
    await init.exited;
    expect(init.exitCode).toBe(0);

    const report = await runDoctor(await healthy({ agent, subject: subjectId("example") }));
    const finding = findingById(report, "agent.commits");

    expect(finding?.severity).toBe("ok");
    expect(finding?.detail).toContain("no commit yet");
    expect(findingById(report, "agent.notrepo")).toBeUndefined();
    expect(findingById(report, "agent.remotes")?.severity).toBe("ok");
  });

  test("AC6: a repository with a remote is warned about — by name, with why, and nothing asked of the host", async () => {
    const agent = await sandbox("mind-doctor-remote-");
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", "-C", agent, ...args], { stdout: "pipe", stderr: "pipe" });
      await child.exited;
      expect(child.exitCode, args.join(" ")).toBe(0);
    };
    await git("init", "-q");
    // An address that resolves nowhere: if doctor asked the host anything,
    // this would hang or fail rather than produce the warning below.
    await git("remote", "add", "origin", "https://git.invalid/owner/agent.git");
    await git("remote", "add", "backup", "/nonexistent/mirror.git");

    const report = await runDoctor(await healthy({ agent, subject: subjectId("example") }));

    for (const name of ["origin", "backup"]) {
      const finding = findingById(report, `agent.remote.${name}`);
      expect(finding?.severity, name).toBe("warn");
      expect(finding?.detail, name).toContain("no deletion here can reach the copy on the host");
    }
    expect(findingById(report, "agent.remote.origin")?.detail).toContain("git.invalid");
    expect(findingById(report, "agent.remotes")).toBeUndefined();
    // Visibility is not claimed either way — the limit is printed instead.
    const section = report.sections.find((s) => s.title.startsWith("agent"))!;
    expect(section.notes).toContain(REMOTE_VISIBILITY_LIMIT);
    // A remote is a warning about the future, not a machine that cannot work.
    expect(doctorExit(report)).toBe(0);
  });

  test("the remote sentence is the guard's own constant, not a second copy", async () => {
    const agent = await sandbox("mind-doctor-agent-");
    const report = await runDoctor(await healthy({ agent, subject: subjectId("example") }));
    const section = report.sections.find((s) => s.title.startsWith("agent"))!;

    expect(section.notes).toContain(REMOTE_VISIBILITY_LIMIT);
    expect(DOCTOR_LIMITS).toContain(REMOTE_VISIBILITY_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// D-021 — a path under this machine's home, hard-coded in the engine
// ---------------------------------------------------------------------------

describe("D-021 — the engine may not name this machine", () => {
  test("a hard-coded home path under src/ is found, and the needle is never printed", async () => {
    const home = await sandbox("mind-doctor-d021-home-");
    const engineRoot = await engineSandbox("mind-doctor-d021-engine-");
    await writeFile(
      join(engineRoot, "src", "bad.ts"),
      `const where = "${home}/.config/thing";\nexport default where;\n`,
    );

    const report = await runDoctor(await healthy({ home, engineRoot }));
    const hits = report.sections
      .flatMap((section) => section.findings)
      .filter((finding) => finding.id.startsWith("engine.hardcoded."));

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toContain("bad.ts:1");
    expect(hits[0]!.detail).toContain("D-021");
    // The finding names the file and the line and never the path itself: a
    // report echoed into a CI log cannot be taken back.
    expect(hits[0]!.detail).not.toContain(home);
  });

  test("a clean engine says how many files it read, and the number is not zero", async () => {
    const engineRoot = await engineSandbox("mind-doctor-d021-clean-");

    const report = await runDoctor(await healthy({ engineRoot }));
    const finding = findingById(report, "engine.clean");
    expect(finding?.severity).toBe("ok");
    // One file in `src/` and one in `bin/`: the count is what was really read.
    expect(finding?.detail).toContain("2 file(s)");
    expect(findingById(report, "engine.unchecked")).toBeUndefined();
  });

  test("a home too short to search for is said so, not reported as hundreds of hits", async () => {
    const report = await runDoctor(await healthy({ home: "/" }));
    expect(findingById(report, "engine.unscannable")?.severity).toBe("warn");
  });

  test("no checkout to scan is `not checked`, never a clean report of nothing", async () => {
    // What the compiled binary has: `import.meta.dir` inside the executable,
    // so there is no directory for anything to walk. It reported
    // `ok clean, 0 file(s)` until 2026-09-21, which is a pass earned by
    // looking at nothing — the one failure this whole command exists to catch.
    const report = await runDoctor(await healthy({ engineRoot: undefined }));
    const finding = findingById(report, "engine.unchecked");

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("Nothing was scanned");
    expect(findingById(report, "engine.clean")).toBeUndefined();
    // A check that cannot run is not a machine that cannot work (AC7).
    expect(doctorExit(report)).toBe(0);
  });

  test("a root that is not the engine's source is `not checked`, and names what is absent", async () => {
    const engineRoot = await sandbox("mind-doctor-d021-elsewhere-");
    await mkdir(join(engineRoot, "src"), { recursive: true });
    await writeFile(join(engineRoot, "src", "thing.ts"), "export default 1;\n");

    // The same rule catches a root pointing at the wrong place in a checkout,
    // which is why it is written as evidence on disk rather than as a test on
    // what a virtual path happens to be called in this release of bun.
    const report = await runDoctor(await healthy({ engineRoot }));
    const finding = findingById(report, "engine.unchecked");

    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("bin/");
    expect(finding?.detail).not.toContain("src/ and");
    expect(findingById(report, "engine.clean")).toBeUndefined();
  });

  test("both trees present and empty is `not checked` too — nothing read is nothing known", async () => {
    const engineRoot = await sandbox("mind-doctor-d021-empty-");
    for (const where of ["src", "bin"]) await mkdir(join(engineRoot, where), { recursive: true });

    const report = await runDoctor(await healthy({ engineRoot }));
    expect(findingById(report, "engine.unchecked")?.severity).toBe("warn");
    expect(findingById(report, "engine.clean")).toBeUndefined();
  });

  test("the limit says the binary cannot answer this, so a reader is not left to assume", () => {
    expect(DOCTOR_LIMITS.join(" ")).toContain("compiled binary has none");
    expect(DOCTOR_LIMITS.join(" ")).toContain("a pass earned by looking at nothing");
  });

  test("this engine's own src/, bin/ and scripts/ are clean", async () => {
    // The check pointed at the repository it ships in, which is the only way
    // to know the rule is being kept rather than merely checkable.
    const engineRoot = join(import.meta.dir, "..");
    const report = await runDoctor(
      await healthy({ engineRoot, home: join("/", "home", "somebody") }),
    );
    expect(findingById(report, "engine.clean")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC7 and the report itself
// ---------------------------------------------------------------------------

describe("AC7 — the exit code, and what it is allowed to mean", () => {
  test("a working local route is 0 even with nothing else on the machine", async () => {
    const env = await machine({ binaries: onPath("ollama"), tags: HEALTHY_TAGS });
    expect(doctorExit(await runDoctor(env))).toBe(0);
  });

  test("the four things that make it 1 are all the local route", async () => {
    const cases: readonly (readonly [string, DoctorEnv])[] = [
      ["daemon down", await machine({ tags: { ok: false, reason: "x" } })],
      ["nothing pulled", await machine({ tags: tagsFor([]) })],
      ["named model absent", await healthy({ models: ["nope:1b"] })],
      [
        "named model will not fit",
        await machine({
          binaries: onPath("ollama", "nvidia-smi"),
          tags: tagsFor([["big:70b", 40 * 1024 * 1024 * 1024]]),
          nvidiaSmi: { stdout: "GPU0, 10, 46068\n" },
          models: ["big:70b"],
        }),
      ],
    ];

    for (const [why, env] of cases) {
      const report = await runDoctor(env);
      expect(`${why}: ${doctorExit(report)}`).toBe(`${why}: 1`);
      expect(blockers(report).length).toBeGreaterThan(0);
    }
  });

  test("nothing but the local route can produce a blocker", async () => {
    // Every other section, as bad as it gets, on a machine whose ollama works.
    const env = await machine({
      binaries: onPath("ollama"),
      tags: HEALTHY_TAGS,
      collections: { ok: false, reason: "down" },
      backends: ["claude", "codex", "ollama"],
    });
    const report = await runDoctor(env);

    expect(blockers(report)).toEqual([]);
    expect(doctorExit(report)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The rule the engine bug turned into a general one
// ---------------------------------------------------------------------------

describe("no `ok` in this report opens with a zero", () => {
  /**
   * Every `ok` whose detail begins with `0 `, across a spread of machines.
   *
   * `ok clean, 0 file(s)` was true, green, and produced by a scan that read
   * nothing — and no reader can tell that line from one that counted a real
   * zero. So the shape is banned outright rather than fixed where it was
   * found: a check with nothing to report says what it did not do, and a
   * measured zero (a GPU with nothing free, a repository before its first
   * commit) is phrased so the zero is not the first thing on the line.
   *
   * The rule is the *format*, not the number. It cannot prove a check looked
   * at something; what it can do is make "looked at nothing" impossible to
   * write in the same shape as "looked, and found none".
   */
  function zeroLed(report: DoctorReport): string[] {
    return report.sections
      .flatMap((section) => section.findings)
      .filter((finding) => finding.severity === "ok" && finding.detail.startsWith("0 "))
      .map((finding) => `${finding.id}: ${finding.detail}`);
  }

  test("the rule can see one, so an empty list below means something", () => {
    const invented: DoctorReport = {
      sections: [
        {
          title: "engine",
          findings: [{ id: "engine.clean", severity: "ok", label: "clean", detail: "0 file(s) under nowhere" }],
          notes: [],
        },
      ],
      limits: [],
    };
    // The exact line this bug printed for as long as the binary existed.
    expect(zeroLed(invented)).toHaveLength(1);
  });

  test("not one check on any of these machines claims ok with `0 ` in front of it", async () => {
    const agent = await sandbox("mind-doctor-zero-agent-");
    const init = Bun.spawn(["git", "init", "-q", agent], { stdout: "pipe", stderr: "pipe" });
    await init.exited;

    const machines: readonly DoctorEnv[] = [
      await healthy(),
      // A GPU with nothing free at all: a measured zero, and still not a line
      // that opens with one.
      await machine({
        binaries: onPath("ollama", "nvidia-smi"),
        tags: HEALTHY_TAGS,
        nvidiaSmi: { stdout: "GPU0, 0, 46068\n" },
      }),
      // A store that is answering and holds nothing.
      await healthy({ collections: collectionsFor([]) }),
      // A repository that exists and has never been committed to.
      await healthy({ agent, subject: subjectId("example") }),
      // A directory that is not a repository at all.
      await healthy({
        agent: await sandbox("mind-doctor-zero-notrepo-"),
        subject: subjectId("example"),
      }),
      // No engine source to scan, which is what the binary has.
      await healthy({ engineRoot: undefined }),
      // Nothing on this machine but the daemon, and it is down.
      await machine({ tags: { ok: false, reason: "ECONNREFUSED" } }),
    ];

    for (const env of machines) {
      expect(zeroLed(await runDoctor(env))).toEqual([]);
    }
  });
});

describe("the rendered report", () => {
  test("every section, every finding and every limit reaches the page", async () => {
    const report = await runDoctor(await healthy());
    const text = renderDoctor(report).join("\n");

    for (const section of report.sections) expect(text).toContain(section.title);
    for (const limit of report.limits) expect(text).toContain(limit);
    expect(text).toContain("ready — everything the local route needs is here");
  });

  test("a machine that is not ready says which things are missing, at the end", async () => {
    const env = await machine({ tags: { ok: false, reason: "ECONNREFUSED" } });
    const text = renderDoctor(await runDoctor(env)).join("\n");

    expect(text).toContain("not ready — 1 thing(s) the local route needs are missing");
    expect(text).toContain("ECONNREFUSED");
  });

  test("the report carries its own limits, so --json gets them too", async () => {
    const report = await runDoctor(await healthy());
    expect(report.limits).toEqual(DOCTOR_LIMITS);
    expect(JSON.parse(JSON.stringify(report)).sections.length).toBe(report.sections.length);
  });
});

describe("D-124 — where LiteLLM sends local-coder", () => {
  const KEY = "virtual-key-for-test";
  const info = (...routes: [string, string, string?][]): JsonProbe => ({
    ok: true,
    body: { data: routes.map(([group, model, apiBase]) => ({ model_name: group, litellm_params: apiBase === undefined ? { model } : { model, api_base: apiBase } })) },
  });
  async function withRoutes(probe: JsonProbe, own: readonly string[] = ["172.17.0.1"]) {
    const asked: { url: string; headers: Readonly<Record<string, string>> | undefined }[] = [];
    const env: DoctorEnv = {
      ...(await machine()),
      liteLLM: { url: "http://127.0.0.1:10400", key: KEY },
      ownAddresses: own,
      getJson: async (url, _timeout, headers) => {
        asked.push({ url, headers });
        return url.endsWith("/model/info") ? probe : { ok: false, reason: "connection refused" };
      },
    };
    return { env, asked };
  }

  test("not set up: no section at all", async () => {
    expect(await checkLocalAction(await machine())).toBeUndefined();
    const report = await runDoctor(await machine());
    expect(report.sections.some((section) => section.title.startsWith("local action"))).toBe(false);
  });

  test("a route to this machine is ok; the key goes to LiteLLM alone, in a header", async () => {
    const { env, asked } = await withRoutes(info(["local-coder", "hosted_vllm/qwen", "http://172.17.0.1:10410/v1"]));
    const section = (await checkLocalAction(env))!;
    expect(section.findings.map((f) => [f.severity, f.detail])).toEqual([["ok", "172.17.0.1 — stays on this machine"]]);
    const toLiteLLM = asked.filter((a) => a.headers !== undefined);
    expect(toLiteLLM).toEqual([{ url: "http://127.0.0.1:10400/model/info", headers: { authorization: `Bearer ${KEY}` } }]);
    const report = await runDoctor(env);
    expect(blockers(report).filter((f) => f.id.startsWith("local-action"))).toEqual([]);
    expect(renderDoctor(report).join("\n")).not.toContain(KEY);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  test("a route that leaves this machine fails the report", async () => {
    const { env } = await withRoutes(info(["local-coder", "openai/gpt", "https://api.example.com/v1"]));
    const report = await runDoctor(env);
    const leak = blockers(report).find((f) => f.id.startsWith("local-action:route"));
    expect(leak?.detail).toBe("api.example.com — LEAVES this machine — held pieces of memory would go with a local-action turn");
    expect(doctorExit(report)).toBe(1);
  });

  test("where each kind of address is placed", () => {
    const own = ["172.17.0.1", "fe80::1"];
    const at = (apiBase: string | undefined, provider = "hosted_vllm") => routePlace({ group: "local-coder", provider, apiBase }, own).place;
    expect(at("http://127.0.0.1:10410")).toBe("here");
    expect(at("http://127.9.9.9:1")).toBe("here");
    expect(at("http://localhost:11434")).toBe("here");
    expect(at("http://host.docker.internal:10410")).toBe("here");
    expect(at("http://[::1]:10410")).toBe("here");
    expect(at("http://172.17.0.1:10410/v1")).toBe("here");
    expect(at("http://192.168.1.5:8000")).toBe("network");
    expect(at("http://10.0.0.2:8000")).toBe("network");
    expect(at("http://100.100.1.1:8000")).toBe("network"); // a tailnet address that is not ours
    expect(at("http://[fd00::5]:8000")).toBe("network");
    expect(at("http://vllm:8000")).toBe("unknown");
    expect(at("http://gpu.internal:8000")).toBe("unknown");
    expect(at("not a url")).toBe("outside"); // unreadable is never a pass
    // Parsers disagree on these (httpx takes \\ as user-info; WHATWG as /): read as leaving (review 2026-09-27).
    expect(at("http://127.0.0.1\\@api.example.com/v1")).toBe("outside");
    expect(at("http://127.0.0.1@api.example.com/v1")).toBe("outside");
    expect(at("http://u:p@127.0.0.1:10410/v1")).toBe("outside");
    expect(at("https://api.example.com:\uff14\uff14\uff13/v1")).toBe("outside"); // full-width port digits
    expect(at("http://evil.example.com^/v1")).toBe("outside");
    expect(at("http://127.0.0.1:10410/v1\\x")).toBe("outside");
    expect(at("https://api.example.com/v1")).toBe("outside");
    expect(at("http://8.8.8.8/")).toBe("outside");
    expect(at("http://[2001:db8::1]/")).toBe("outside");
    // LiteLLM takes ollama's address from its own OLLAMA_API_BASE, which /model/info does not show.
    expect(at(undefined, "ollama")).toBe("unknown");
    expect(routePlace({ group: "local-coder", provider: "openai", apiBase: undefined }, own)).toEqual({ place: "outside", host: "openai's own servers (no api_base)" });
    expect(routePlace({ group: "local-coder", provider: "", apiBase: undefined }, own).host).toBe("an unnamed provider's own servers (no api_base)");
  });

  test("what cannot be judged is a warning, never a pass", async () => {
    const warnOf = async (probe: JsonProbe) => (await checkLocalAction((await withRoutes(probe)).env))!.findings.map((f) => [f.severity, f.id]);
    expect(await warnOf({ ok: false, reason: "connection refused" })).toEqual([["warn", "local-action:litellm"]]);
    expect(await warnOf({ ok: true, body: { nothing: true } })).toEqual([["warn", "local-action:litellm"]]);
    expect(await warnOf(info(["local-chat", "hosted_vllm/x", "http://127.0.0.1:1"]))).toEqual([["warn", "local-action:none"]]);
    expect(await warnOf(info(["local-coder", "hosted_vllm/x", "http://192.168.1.5:1"]))).toEqual([["warn", "local-action:route:0"]]);
    const problem: DoctorEnv = { ...(await machine()), liteLLM: { url: "http://127.0.0.1:10400", problem: "holds only LITELLM_MASTER_KEY" } };
    expect((await checkLocalAction(problem))!.findings).toEqual([{ id: "local-action:key", severity: "warn", label: "key", detail: "holds only LITELLM_MASTER_KEY" }]);
  });

  test("nothing from LiteLLM's answer reaches the terminal as a control sequence", async () => {
    const { env } = await withRoutes(info(["local-coder", "openai\u001b[8m/gpt", "https://api.example.com/v1"], ["gpt\u001b[2J", "openai/gpt"]));
    const report = await runDoctor(env);
    const text = renderDoctor(report).join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("openai?[8m");
    expect(printable("a\u0007b\u009bc")).toBe("a?b?c");
    expect(printable("x".repeat(500)).length).toBe(200);
  });

  test("a key that can use more than local-coder is pointed out", async () => {
    const { env } = await withRoutes(info(["local-coder", "hosted_vllm/q", "http://127.0.0.1:1"], ["gpt", "openai/gpt"], ["gpt", "openai/gpt"]));
    const section = (await checkLocalAction(env))!;
    expect(section.notes).toContain("the key can also use gpt — a key for local action should see local-coder alone");
  });

  test("parseModelInfo reads LiteLLM's shape and skips what is not a route", () => {
    expect(parseModelInfo(null)).toBeUndefined();
    expect(parseModelInfo({ data: "x" })).toBeUndefined();
    expect(parseModelInfo({ data: [{ litellm_params: {} }, { model_name: "a" }, { model_name: "b", litellm_params: { model: "ollama/x", api_base: "" } }] })).toEqual([
      { group: "a", provider: "", apiBase: undefined },
      { group: "b", provider: "ollama", apiBase: undefined },
    ]);
  });

  test("the limit says what is not checked", () => {
    expect(DOCTOR_LIMITS.join("\n")).toContain("Its fallbacks live in LiteLLM's router settings");
  });
});

