/**
 * SEC-REVIEW (dependency audit and CI part), GML-10b (licence-audit CI step), REL-CI (mind-dev part).
 *
 * `scripts/licence-audit.ts` fails when a production package or an embedded font has a licence outside the allowlist,
 * and `.github/workflows/ci.yml` runs it, and `bun audit` at a stated threshold, as a job of its own. The tests give
 * the audit fake trees (a lock and what each package declares), so every verdict is one the audit really reaches, and
 * run it once on this tree, whose production closure is empty and whose fonts are the two OFL families.
 *
 * What these tests cannot do: `bun audit` asks the registry, so no test runs it. Its exit-code behaviour at each
 * level was checked by hand (see the comment in ci.yml); the workflow's use of it is pinned here as text.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOWED_LICENCES,
  auditLicences,
  evaluateLicence,
  LICENCE_OVERRIDES,
  main,
  type Reader,
  readerFor,
  renderReport,
} from "../../scripts/licence-audit.ts";
import { BUNDLED_FONTS, packageDir, type PackageMeta } from "../../scripts/third-party-notices.ts";

const ROOT = join(import.meta.dir, "..", "..");

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("the allowlist", () => {
  test("it holds the permissive licences the release plan names, and the fonts' one", () => {
    for (const id of ["Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "BlueOak-1.0.0", "OFL-1.1"]) expect(ALLOWED_LICENCES, id).toContain(id);
  });

  test("it holds nothing that asks for source to be shared, a network clause, a field-of-use limit or no licence at all", () => {
    for (const id of ALLOWED_LICENCES) expect(id, id).not.toMatch(/GPL|SSPL|BUSL|BSL-|CC-BY-NC|CC-BY-SA|EUPL|MPL|CDDL|EPL|OSL|Commons-Clause|UNLICENSED|Proprietary/i);
    expect(new Set(ALLOWED_LICENCES.map((id) => id.toLowerCase())).size).toBe(ALLOWED_LICENCES.length);
  });

  test("no package is waved through by name today, and any that is says why", () => {
    for (const [subject, override] of Object.entries(LICENCE_OVERRIDES)) {
      expect(subject, subject).toMatch(/^(@[^/]+\/)?[^@/]+@\d+\.\d+\.\d+/);
      expect(override.why.length, subject).toBeGreaterThan(30);
    }
    expect(Object.keys(LICENCE_OVERRIDES)).toEqual([]);
  });
});

describe("evaluateLicence: an SPDX expression against the list", () => {
  test.each([
    "MIT",
    "mit",
    "Apache-2.0",
    "BSD-3-Clause",
    "0BSD",
    "BlueOak-1.0.0",
    "OFL-1.1",
    "Apache-2.0+",
    "(MIT OR Apache-2.0)",
    "MIT OR GPL-3.0-only",
    "GPL-3.0-only OR MIT",
    "(GPL-3.0-only AND AGPL-3.0-only) OR ISC",
    "MIT AND BSD-3-Clause",
    "(MIT AND (ISC OR GPL-2.0-only))",
    "Apache-2.0 WITH LLVM-exception",
    "mit or apache-2.0",
  ])("allowed: %s", (expression) => {
    expect(evaluateLicence(expression)).toEqual({ ok: true, reason: "" });
  });

  test.each(["GPL-3.0-only", "GPL-2.0-or-later", "LGPL-2.1-only", "AGPL-3.0-only", "SSPL-1.0", "BUSL-1.1", "CC-BY-NC-4.0", "UNLICENSED", "Proprietary", "BSD", "MPL-2.0"])(
    "outside the list: %s",
    (expression) => {
      const verdict = evaluateLicence(expression);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("is not on the allowlist");
    },
  );

  test("AND needs both sides, OR needs one, and WITH is judged by the licence before it", () => {
    expect(evaluateLicence("MIT AND GPL-3.0-only").ok).toBe(false);
    expect(evaluateLicence("GPL-3.0-only AND AGPL-3.0-only")).toEqual({ ok: false, reason: "GPL-3.0-only, AGPL-3.0-only are not on the allowlist" });
    expect(evaluateLicence("GPL-3.0-only OR AGPL-3.0-only").ok).toBe(false);
    expect(evaluateLicence("GPL-2.0-only WITH Classpath-exception-2.0").ok).toBe(false);
    expect(evaluateLicence("MIT AND ISC OR GPL-3.0-only").ok).toBe(true);
    expect(evaluateLicence("GPL-3.0-only OR MIT AND AGPL-3.0-only").ok).toBe(false);
  });

  test("what is not an SPDX expression, or is nothing, fails: a check that passes on what it cannot read is not a check", () => {
    for (const bad of ["", "   ", null, "SEE LICENSE IN LICENSE.txt", "MIT*", "MIT OR", "(MIT", "MIT)", "AND MIT", "MIT WITH", "MIT, ISC", "MIT OR OR ISC", "()", "Apache 2.0"]) {
      const verdict = evaluateLicence(bad);
      expect(verdict.ok, String(bad)).toBe(false);
      expect(verdict.reason.length, String(bad)).toBeGreaterThan(10);
    }
    expect(evaluateLicence(null).reason).toBe("it declares no licence");
    expect(evaluateLicence("MIT*").reason).toContain("is not an SPDX licence expression");
  });

  test("the list is a parameter: the same expression passes on one list and fails on another", () => {
    expect(evaluateLicence("MIT", ["MIT"]).ok).toBe(true);
    expect(evaluateLicence("MIT", ["ISC"]).ok).toBe(false);
    expect(evaluateLicence("OFL-1.1", ["MIT"]).reason).toBe("OFL-1.1 is not on the allowlist");
  });
});

/** A reader over an in-memory tree: `installed` maps a lock key to what its `package.json` declares. */
function fakeReader(lock: object, installed: Record<string, Partial<PackageMeta>>, repoFiles: readonly string[] = BUNDLED_FONTS.map((font) => font.licenceFile)): Reader {
  return {
    lockText: async () => JSON.stringify(lock),
    meta: async (pkg) => {
      const meta = installed[pkg.key];
      return meta === undefined ? null : { licence: null, homepage: null, repository: null, ...meta };
    },
    exists: (path) => repoFiles.includes(path),
  };
}

const lockOf = (deps: Record<string, string>, packages: Record<string, { version: string; deps?: Record<string, string> }>, dev: Record<string, string> = {}): object => ({
  lockfileVersion: 2,
  workspaces: { "": { name: "x", dependencies: deps, devDependencies: dev } },
  packages: Object.fromEntries(Object.entries(packages).map(([key, p]) => [key, [`${key.split("/").slice(-1)[0]}@${p.version}`, "", { dependencies: p.deps ?? {} }, "sha512-x"]])),
});

const failures = (report: Awaited<ReturnType<typeof auditLicences>>): string[] => report.findings.filter((finding) => !finding.ok).map((finding) => finding.subject);

describe("auditLicences: production packages and embedded fonts", () => {
  test("a tree of permissive production packages passes, and the fonts are counted", async () => {
    const report = await auditLicences(fakeReader(lockOf({ a: "1" }, { a: { version: "1.0.0", deps: { b: "1" } }, b: { version: "2.0.0" } }), { a: { licence: "MIT" }, b: { licence: "(MIT OR Apache-2.0)" } }));
    expect(failures(report)).toEqual([]);
    expect(report.packages).toBe(2);
    expect(report.fonts).toBe(BUNDLED_FONTS.length);
    expect(report.findings.map((finding) => finding.subject)).toEqual(["a@1.0.0", "b@2.0.0", "font Inter", "font IBM Plex Sans Thai"]);
  });

  test("a production package under a licence outside the list fails, by name and version", async () => {
    const report = await auditLicences(fakeReader(lockOf({ a: "1" }, { a: { version: "1.0.0" } }), { a: { licence: "GPL-3.0-only" } }));
    expect(failures(report)).toEqual(["a@1.0.0"]);
    expect(report.findings[0]!.reason).toBe("GPL-3.0-only is not on the allowlist");
  });

  test("a dependency of a dependency counts: the closure is the whole of what ships", async () => {
    const report = await auditLicences(fakeReader(lockOf({ a: "1" }, { a: { version: "1.0.0", deps: { deep: "1" } }, deep: { version: "0.1.0" } }), { a: { licence: "MIT" }, deep: { licence: "AGPL-3.0-only" } }));
    expect(failures(report)).toEqual(["deep@0.1.0"]);
  });

  test("a development tool under any licence is not judged: it is installed and never shipped", async () => {
    const report = await auditLicences(fakeReader(lockOf({}, { tool: { version: "1.0.0" } }, { tool: "1" }), { tool: { licence: "GPL-3.0-only" } }));
    expect(failures(report)).toEqual([]);
    expect(report.packages).toBe(0);
  });

  test("a package with no licence field, an unreadable one, or one that is not installed fails", async () => {
    const lock = lockOf({ none: "1", odd: "1", gone: "1" }, { none: { version: "1.0.0" }, odd: { version: "1.0.0" }, gone: { version: "1.0.0" } });
    const report = await auditLicences(fakeReader(lock, { none: {}, odd: { licence: "SEE LICENSE IN LICENSE" } }));
    expect(failures(report)).toEqual(["gone@1.0.0", "none@1.0.0", "odd@1.0.0"]);
    const byName = Object.fromEntries(report.findings.map((finding) => [finding.subject, finding.reason]));
    expect(byName["none@1.0.0"]).toBe("it declares no licence");
    expect(byName["odd@1.0.0"]).toContain("is not an SPDX licence expression");
    expect(byName["gone@1.0.0"]).toContain("not installed");
  });

  test("a nested copy is read where bun put it", async () => {
    const lock = lockOf({ a: "1" }, { a: { version: "1.0.0", deps: { b: "1" } }, b: { version: "2.0.0" }, "a/b": { version: "1.0.0" } });
    const report = await auditLicences(fakeReader(lock, { a: { licence: "MIT" }, "a/b": { licence: "WTFPL" } }));
    expect(failures(report)).toEqual(["b@1.0.0"]);
  });

  test("an override names one package at one version, still has to pass the list, and does not cover the next version", async () => {
    const lock = lockOf({ a: "1" }, { a: { version: "1.0.0" } });
    const overrides = { "a@1.0.0": { licence: "MIT", why: "package.json has no licence field; LICENSE read by hand on 2026-10-13: MIT" } };
    expect(failures(await auditLicences(fakeReader(lock, { a: {} }), ALLOWED_LICENCES, overrides))).toEqual([]);
    expect(failures(await auditLicences(fakeReader(lockOf({ a: "1" }, { a: { version: "1.0.1" } }), { a: {} }), ALLOWED_LICENCES, overrides))).toEqual(["a@1.0.1"]);
    expect(failures(await auditLicences(fakeReader(lock, { a: {} }), ALLOWED_LICENCES, { "a@1.0.0": { licence: "GPL-3.0-only", why: "x".repeat(40) } }))).toEqual(["a@1.0.0"]);
  });

  test("an embedded font fails when its licence is off the list, and when its licence text is not in the repository", async () => {
    const lock = lockOf({}, {});
    expect(failures(await auditLicences(fakeReader(lock, {}), ["MIT"]))).toEqual(["font Inter", "font IBM Plex Sans Thai"]);
    const missing = await auditLicences(fakeReader(lock, {}, ["src/web/fonts/OFL-Inter.txt"]));
    expect(failures(missing)).toEqual(["font IBM Plex Sans Thai"]);
    expect(missing.findings.find((finding) => !finding.ok)!.reason).toContain("src/web/fonts/OFL-IBMPlexSansThai.txt is not in the repository");
  });

  test("a lock that cannot be read is an error, not a pass", async () => {
    const reader: Reader = { lockText: async () => "{ nope", meta: async () => null, exists: () => true };
    await expect(auditLicences(reader)).rejects.toThrow("bun.lock cannot be read");
  });
});

describe("the report", () => {
  test("a pass says so, and lists every finding with its licence", async () => {
    const lines = renderReport(await auditLicences(fakeReader(lockOf({ a: "1" }, { a: { version: "1.0.0" } }), { a: { licence: "ISC" } })));
    expect(lines[0]).toBe(`licence-audit: 1 production package(s), 2 bundled font(s); allowed: ${ALLOWED_LICENCES.join(", ")}`);
    expect(lines).toContain("  ok   a@1.0.0 - ISC");
    expect(lines).toContain("  ok   font Inter - OFL-1.1");
    expect(lines.at(-1)).toBe("licence-audit: pass");
  });

  test("a failure names the package and what is wrong, and counts", async () => {
    const lines = renderReport(await auditLicences(fakeReader(lockOf({ a: "1", b: "1" }, { a: { version: "1.0.0" }, b: { version: "1.0.0" } }), { a: { licence: "GPL-3.0-only" } })));
    expect(lines).toContain("  FAIL a@1.0.0 - GPL-3.0-only: GPL-3.0-only is not on the allowlist");
    expect(lines).toContain("  FAIL b@1.0.0 - no licence: it is in the production closure but is not installed, so its licence cannot be read: run bun install --frozen-lockfile");
    expect(lines.at(-1)).toBe("licence-audit: FAIL, 2 of 4 outside the allowlist or unreadable");
  });
});

describe("this tree", () => {
  test("the audit passes on it: every production package and both embedded fonts are on the list", async () => {
    const report = await auditLicences(readerFor(ROOT));
    expect(failures(report)).toEqual([]);
    expect(report.findings.length).toBe(report.packages + BUNDLED_FONTS.length);
    expect(report.fonts).toBe(2);
  });

  test("the control: make a package of this tree a production dependency and narrow the list, and the audit fails by its name", async () => {
    const reader = readerFor(ROOT);
    const withTypescript: Reader = {
      ...reader,
      lockText: async () => (await reader.lockText()).replace('"devDependencies"', '"dependencies": { "typescript": "*" },\n      "devDependencies"'),
    };
    // typescript is Apache-2.0 in node_modules, so on the real list it passes; on a list of MIT alone it must not.
    expect(failures(await auditLicences(withTypescript))).toEqual([]);
    const narrowed = await auditLicences(withTypescript, ["MIT", "OFL-1.1"]);
    expect(failures(narrowed).map((subject) => subject.split("@")[0])).toEqual(["typescript"]);
    expect(narrowed.packages).toBe(1);
  });
});

/** A temporary tree on disk with a lock and installed packages, for the command. */
async function onDisk(lock: object, installed: Record<string, object>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mind-licences-"));
  made.push(root);
  await writeFile(join(root, "bun.lock"), JSON.stringify(lock));
  for (const [key, json] of Object.entries(installed)) {
    await mkdir(packageDir(root, key), { recursive: true });
    await writeFile(join(packageDir(root, key), "package.json"), JSON.stringify(json));
  }
  for (const font of BUNDLED_FONTS) {
    await mkdir(join(root, font.licenceFile, ".."), { recursive: true });
    await writeFile(join(root, font.licenceFile), "text");
  }
  return root;
}

describe("the command", () => {
  const run = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const code = await main(argv, (text) => (out += `${text}\n`), (text) => (err += `${text}\n`));
    return { code, out, err };
  };

  test("exit 0 and the report on stdout when everything is allowed", async () => {
    const root = await onDisk(lockOf({ a: "1" }, { a: { version: "1.0.0" } }), { a: { name: "a", license: "MIT" } });
    const result = await run(["--root", root]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("licence-audit: pass");
    expect(result.err).toBe("");
  });

  test("exit 1 and the report on stderr, naming the package, when one is outside the list", async () => {
    const root = await onDisk(lockOf({ a: "1" }, { a: { version: "1.0.0" } }), { a: { name: "a", license: "GPL-3.0-only" } });
    const result = await run(["--root", root]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("FAIL a@1.0.0 - GPL-3.0-only");
    expect(result.out).toBe("");
  });

  test("exit 2 for an argument it does not know, a tree with no lock, or a lock it cannot read", async () => {
    expect((await run(["--nope"])).code).toBe(2);
    expect((await run(["--root"])).code).toBe(2);
    const empty = await mkdtemp(join(tmpdir(), "mind-licences-"));
    made.push(empty);
    expect((await run(["--root", empty])).code).toBe(2);
    await writeFile(join(empty, "bun.lock"), "{ nope");
    const broken = await run(["--root", empty]);
    expect(broken.code).toBe(2);
    expect(broken.err).toContain("bun.lock cannot be read");
  });

  test("run as a program on this tree it exits 0 and says pass", async () => {
    const child = Bun.spawn(["bun", "run", "scripts/licence-audit.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    expect(`${out}${err}`).toContain("licence-audit: pass");
    expect(child.exitCode).toBe(0);
  }, 60_000);
});

describe(".github/workflows/ci.yml: the dependency job", () => {
  type Step = { uses?: string; run?: string; "continue-on-error"?: unknown; if?: unknown };
  type Job = { needs?: unknown; steps: Step[]; permissions?: Record<string, string> };
  const load = async (): Promise<{ text: string; wf: { permissions: Record<string, string>; jobs: Record<string, Job> } }> => {
    const text = await readFile(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    return { text, wf: Bun.YAML.parse(text) as { permissions: Record<string, string>; jobs: Record<string, Job> } };
  };

  test("it audits the installed packages at HIGH and runs the licence audit, after a frozen install", async () => {
    const { wf } = await load();
    const runs = wf.jobs["dependencies"]!.steps.map((step) => step.run).filter((run): run is string => run !== undefined);
    expect(runs).toEqual(["bun install --frozen-lockfile", "bun audit --audit-level=high", "bun run scripts/licence-audit.ts", "bun run scripts/third-party-notices.ts --check"]);
  });

  test("the threshold is written down where the step is, with what it was checked against", async () => {
    const { text } = await load();
    expect(text).toContain("The audit threshold is HIGH");
    expect(text).toContain("`bun audit --audit-level=high` exits 1 when an advisory of severity high or critical");
    expect(text).toContain("--ignore=<GHSA id>");
  });

  test("nothing in the workflow is allowed to fail quietly, and the audit is not made optional", async () => {
    const { text, wf } = await load();
    expect(text).not.toMatch(/continue-on-error:\s*true/);
    for (const job of Object.values(wf.jobs)) for (const step of job.steps) expect(step.run ?? "", step.run).not.toMatch(/\|\|\s*(true|:)\s*$/m);
    const audit = wf.jobs["dependencies"]!.steps.find((step) => step.run?.startsWith("bun audit"))!;
    expect(audit["continue-on-error"]).toBeUndefined();
    expect(audit.if).toBeUndefined();
  });

  test("the gates job still runs the four gates, the new job only reads the repository, and its actions are pinned by SHA like the rest", async () => {
    const { wf, text } = await load();
    expect(wf.jobs["gates"]!.steps.map((step) => step.run).filter(Boolean)).toEqual(["bun install --frozen-lockfile", "bun run typecheck", "bun test", "bun run coverage"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(wf.jobs["dependencies"]!.permissions).toBeUndefined();
    const pins = wf.jobs["dependencies"]!.steps.filter((step) => step.uses !== undefined).map((step) => step.uses!);
    expect(pins.length).toBe(2);
    for (const pin of pins) expect(pin).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    expect(text).not.toMatch(/uses:\s*\S+@v\d/);
  });

  test("it installs the Bun that the release builds with", async () => {
    const { text } = await load();
    const release = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const versions = (yml: string): string[] => [...yml.matchAll(/bun-version:\s*(\S+)/g)].map((match) => match[1]!);
    expect(new Set([...versions(text), ...versions(release)]).size).toBe(1);
    expect(versions(text).length).toBe(2);
  });

  test("every script the workflow runs is in the repository", async () => {
    const { wf } = await load();
    for (const job of Object.values(wf.jobs)) {
      for (const step of job.steps) {
        const script = /^bun run (scripts\/\S+)/.exec(step.run ?? "")?.[1];
        if (script !== undefined) expect(await Bun.file(join(ROOT, script)).exists(), script).toBe(true);
      }
    }
  });
});
