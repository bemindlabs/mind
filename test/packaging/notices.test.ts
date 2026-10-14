/**
 * LIC-ENGINE, LIC-NOTICE, GML-10b: NOTICE and THIRD_PARTY_NOTICES.md say what the release binary really bundles.
 *
 * The binary is `bun build --compile` of this tree: the Bun runtime, the fonts of `src/web/fonts.ts` (base64 in the
 * source, so inside the file) and the program. A notice that names a font the page no longer serves, or leaves out
 * the runtime, is wrong in the way that matters for a redistributed binary, and nothing used to notice. These tests
 * read what the artifacts bundle from the source (the CSS the page serves, the keys of the font table, the
 * build script, the workflow's Bun version, the lockfile) and fail when a notice does not name it.
 *
 * Fixture trees are temporary directories: nothing here reads the owner's real data.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FONT_CSS, FONT_FILES } from "../../src/web/fonts.ts";
import {
  BUNDLED_FONTS,
  CI_WORKFLOW,
  collectInputs,
  declaredLicence,
  keySegments,
  main,
  metaFromJson,
  NOTICES_FILE,
  packageDir,
  parseLock,
  pinnedBunVersion,
  productionPackages,
  QR_ACKNOWLEDGEMENT,
  readLicenceFiles,
  readPackageMeta,
  RELEASE_WORKFLOW,
  renderNotices,
  RUNTIME,
  staleness,
} from "../../scripts/third-party-notices.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

/** The earlier names, as the guard in test/compat spells its pattern: a regexp does not match its own source. */
const EARLIER_NAME = /oh ?my ?agi|om[-_]?agi/i;

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-notices-"));
  made.push(dir);
  return dir;
}

/** The names in `names` that `text` does not contain: the check the notice tests are made of. */
function missingFrom(text: string, names: readonly string[]): string[] {
  return names.filter((name) => !text.includes(name));
}

/** The font families the page's CSS names, in the order it names them. */
function servedFamilies(): string[] {
  return [...new Set([...FONT_CSS.matchAll(/font-family:"([^"]+)"/g)].map((match) => match[1]!))];
}

describe("LIC-ENGINE: the engine's licence set", () => {
  test.each(["LICENSE", "NOTICE", "TRADEMARKS.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md", "CODE_OF_CONDUCT.md"])("%s is at the root and is not empty", async (file) => {
    expect((await read(file)).trim().length, file).toBeGreaterThan(100);
  });

  test("the licence is Apache-2.0, in the file and in package.json", async () => {
    const licence = await read("LICENSE");
    expect(licence).toContain("Apache License");
    expect(licence).toContain("Version 2.0, January 2004");
    expect(licence).toContain("END OF TERMS AND CONDITIONS");
    expect(((await Bun.file(join(ROOT, "package.json")).json()) as { license: string }).license).toBe("Apache-2.0");
  });

  test("TRADEMARKS.md names Mind as the mark, and CONTRIBUTING says the repository is not open for code and asks for no DCO (D-167)", async () => {
    expect(await read("TRADEMARKS.md")).toContain("- **Mind** is the mark");
    const contributing = await read("CONTRIBUTING.md");
    expect(contributing).toContain("not open for code contributions");
    expect(contributing).not.toMatch(/\bDCO\b|Signed-off-by|Developer Certificate/i);
  });

  test("NOTICE opens with the product and the holder, and points at the licence and the trademarks", async () => {
    const lines = (await read("NOTICE")).split("\n");
    expect(lines[0]).toBe("Mind");
    expect(lines[1]).toBe("Copyright 2026 BeMind Technology");
    const notice = lines.join("\n");
    expect(notice).toContain("Apache License, Version 2.0 (see LICENSE)");
    expect(notice).toContain("TRADEMARKS.md");
  });
});

describe("NOTICE names what the binary bundles", () => {
  test("every font family the page serves is named, with its copyright line and its licence", async () => {
    const notice = await read("NOTICE");
    const families = servedFamilies();
    expect(families.length).toBeGreaterThanOrEqual(2);
    expect(missingFrom(notice, families)).toEqual([]);
    expect(missingFrom(notice, BUNDLED_FONTS.map((font) => font.copyright))).toEqual([]);
    expect(notice.replace(/\s+/g, " ")).toContain("SIL Open Font License, Version 1.1");
    expect(notice).toContain("src/web/fonts/");
  });

  test("the compiled binary embeds the Bun runtime, and NOTICE names it and what it links", async () => {
    const build = ((await Bun.file(join(ROOT, "package.json")).json()) as { scripts: Record<string, string> }).scripts["build"]!;
    expect(build).toContain("--compile");
    const notice = await read("NOTICE");
    expect(notice).toContain(`The ${RUNTIME.name} runtime (${RUNTIME.homepage})`);
    expect(notice).toContain("MIT licence");
    expect(notice).toContain("JavaScriptCore");
    expect(notice).toContain("LGPL");
    expect(notice).toContain("bun build --compile");
  });

  test("it points at THIRD_PARTY_NOTICES.md and its generator", async () => {
    const notice = await read("NOTICE");
    expect(notice).toContain(NOTICES_FILE);
    expect(notice).toContain("scripts/third-party-notices.ts");
  });

  test("a font the page no longer serves is not named (Electrolize was dropped in D-176)", async () => {
    for (const file of ["NOTICE", NOTICES_FILE]) expect(await read(file), file).not.toMatch(/Electrolize|Cyreal/);
    expect(servedFamilies()).not.toContain("Electrolize");
  });

  test("the notices carry no earlier name of the product", async () => {
    for (const file of ["NOTICE", NOTICES_FILE]) expect(await read(file), file).not.toMatch(EARLIER_NAME);
  });

  test("the check is not blind: a notice without a family, or without the runtime, is caught", async () => {
    const notice = await read("NOTICE");
    expect(missingFrom(notice.replaceAll("Inter", "Other"), servedFamilies())).toEqual(["Inter"]);
    expect(missingFrom(notice.replaceAll("IBM Plex Sans Thai", "x"), servedFamilies())).toEqual(["IBM Plex Sans Thai"]);
    expect(missingFrom(notice.replaceAll("Bun", "x"), [RUNTIME.name])).toEqual(["Bun"]);
    expect(missingFrom("an old notice that names Electrolize and IBM Plex Sans Thai only", servedFamilies())).toEqual(["Inter"]);
  });
});

describe("the font inventory is the fonts the page serves", () => {
  test("the families are the ones the CSS names, and nothing else", () => {
    expect([...servedFamilies()].sort()).toEqual(BUNDLED_FONTS.map((font) => font.family).sort());
  });

  test("the files are the keys of the font table, each in one family", () => {
    const claimed = BUNDLED_FONTS.flatMap((font) => font.files);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual(Object.keys(FONT_FILES).sort());
  });

  test("each family's licence text is a file beside the fonts, opens with the copyright line, and is the OFL 1.1", async () => {
    const onDisk = (await readdir(join(ROOT, "src", "web", "fonts"))).filter((name) => name.startsWith("OFL-")).map((name) => `src/web/fonts/${name}`);
    expect(BUNDLED_FONTS.map((font) => font.licenceFile).sort()).toEqual(onDisk.sort());
    for (const font of BUNDLED_FONTS) {
      const text = await read(font.licenceFile);
      expect(text.startsWith(font.copyright), font.family).toBe(true);
      expect(text, font.family).toContain("SIL Open Font License, Version 1.1");
      expect(font.licence).toBe("OFL-1.1");
    }
  });

  test("the control: a font added to the page and not to the inventory is seen", () => {
    const withExtra = FONT_CSS + '\n@font-face{font-family:"Extra Face"}';
    const families = [...new Set([...withExtra.matchAll(/font-family:"([^"]+)"/g)].map((match) => match[1]!))];
    expect(families.filter((family) => !BUNDLED_FONTS.some((font) => font.family === family))).toEqual(["Extra Face"]);
  });
});

describe("THIRD_PARTY_NOTICES.md", () => {
  test("it is what the script makes today from the lockfile, the fonts and the workflow's Bun", async () => {
    const made = renderNotices(await collectInputs(ROOT));
    expect(staleness(await read(NOTICES_FILE), made)).toBeNull();
  });

  test("it names the runtime with the version the release builds with, every family, and each licence in full", async () => {
    const text = await read(NOTICES_FILE);
    const workflows = { [RELEASE_WORKFLOW]: await read(RELEASE_WORKFLOW), [CI_WORKFLOW]: await read(CI_WORKFLOW) };
    const bun = pinnedBunVersion(workflows);
    expect(text).toContain(`${RUNTIME.name} runtime`);
    expect(text).toContain(`version ${bun}`);
    expect(text).toContain(RUNTIME.licenceListUrl(bun));
    expect(missingFrom(text, servedFamilies())).toEqual([]);
    for (const font of BUNDLED_FONTS) {
      const licence = (await read(font.licenceFile)).replace(/[ \t]+$/gm, "").trim();
      expect(text, font.family).toContain(licence);
    }
  });

  test("the runtime is the one the build script compiles and CI installs: both workflows pin the same Bun", async () => {
    const release = await read(RELEASE_WORKFLOW);
    const ci = await read(CI_WORKFLOW);
    expect(release).toMatch(/bun-version: \d+\.\d+\.\d+/);
    expect(pinnedBunVersion({ [RELEASE_WORKFLOW]: release, [CI_WORKFLOW]: ci })).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("it carries the QR acknowledgement while the encoder says it follows that library", async () => {
    expect(await read(QR_ACKNOWLEDGEMENT.file)).toContain("Nayuki");
    const text = await read(NOTICES_FILE);
    expect(text).toContain(QR_ACKNOWLEDGEMENT.name);
    expect(text).toContain(QR_ACKNOWLEDGEMENT.copyright);
  });

  test("it says there is no runtime dependency, because there is none, and that the dev tools are not in the binary", async () => {
    const lock = parseLock(await read("bun.lock"));
    expect(productionPackages(lock)).toEqual([]);
    const text = await read(NOTICES_FILE);
    expect(text).toContain("None. `bun.lock` lists no runtime dependency");
    for (const tool of lock.rootDev) expect(text, tool).toContain(`\`${tool}\``);
  });

  test("the control: a changed byte, an added line and a missing file are all stale", async () => {
    const committed = await read(NOTICES_FILE);
    const made = renderNotices(await collectInputs(ROOT));
    expect(staleness(committed.replace("Inter", "Inter2"), made)).toContain("is stale");
    expect(staleness(`${committed}extra\n`, made)).toContain("is stale");
    expect(staleness(null, made)).toContain("does not exist");
    expect(staleness(made, made)).toBeNull();
  });

  test("a bumped Bun, a new font or a new dependency changes the file", async () => {
    const inputs = await collectInputs(ROOT);
    const base = renderNotices(inputs);
    expect(renderNotices({ ...inputs, bunVersion: "9.9.9" })).not.toBe(base);
    expect(renderNotices({ ...inputs, fonts: inputs.fonts.slice(1) })).not.toBe(base);
    const pkg = { key: "left-pad", name: "left-pad", version: "1.3.0", workspace: false, required: [], soft: [] };
    const withPackage = renderNotices({ ...inputs, packages: [{ pkg, meta: { licence: "MIT", homepage: null, repository: null }, files: [{ name: "LICENSE", text: "MIT text" }] }] });
    expect(withPackage).toContain("### left-pad@1.3.0");
    expect(withPackage).not.toBe(base);
  });
});

describe("the lock and the production closure", () => {
  const lockText = (workspace: object, packages: Record<string, unknown>): string => JSON.stringify({ lockfileVersion: 2, workspaces: { "": workspace }, packages });
  const entry = (spec: string, meta: object = {}): unknown => [spec, "", meta, "sha512-x"];

  test("the closure follows dependencies and optional dependencies, nested copies and scopes, and leaves dev tools out", () => {
    const lock = parseLock(
      lockText(
        { name: "app", dependencies: { a: "^1" }, optionalDependencies: { opt: "^1" }, devDependencies: { tool: "^1" } },
        {
          a: entry("a@1.0.0", { dependencies: { b: "^2", "@s/c": "^1" } }),
          b: entry("b@2.0.0"),
          "a/b": entry("b@1.0.0"),
          "@s/c": entry("@s/c@1.5.0", { dependencies: { b: "^1" } }),
          "@s/c/b": entry("b@1.0.0"),
          opt: entry("opt@1.0.0", { peerDependencies: { absent: "*" }, optionalDependencies: { gone: "^1" } }),
          tool: entry("tool@3.0.0", { dependencies: { "tool-dep": "^1" } }),
          "tool-dep": entry("tool-dep@1.0.0"),
        },
      ),
    );
    // `b` at the top (2.0.0) is nobody's dependency here: `a` and `@s/c` each have a nested copy of their own.
    expect(productionPackages(lock).map((pkg) => `${pkg.key}=${pkg.name}@${pkg.version}`)).toEqual([
      "@s/c=@s/c@1.5.0",
      "a=a@1.0.0",
      "@s/c/b=b@1.0.0",
      "a/b=b@1.0.0",
      "opt=opt@1.0.0",
    ]);
    expect(lock.rootDev).toEqual(["tool"]);
  });

  test("a nested copy wins over the top one for the package that sits under it", () => {
    const lock = parseLock(lockText({ dependencies: { a: "^1" } }, { a: entry("a@1.0.0", { dependencies: { b: "^1" } }), b: entry("b@2.0.0"), "a/b": entry("b@1.0.0") }));
    expect(productionPackages(lock).map((pkg) => pkg.key)).toEqual(["a", "a/b"]);
  });

  test("a required dependency the lock does not list is an error, and an optional one is skipped", () => {
    expect(() => productionPackages(parseLock(lockText({ dependencies: { a: "^1" } }, { a: entry("a@1.0.0", { dependencies: { missing: "^1" } }) })))).toThrow("a needs missing");
    expect(() => productionPackages(parseLock(lockText({ dependencies: { gone: "^1" } }, {})))).toThrow("a workspace needs gone");
    expect(productionPackages(parseLock(lockText({ optionalDependencies: { gone: "^1" } }, {})))).toEqual([]);
  });

  test("a workspace member is the repository's own and is not third-party", () => {
    const lock = parseLock(lockText({ dependencies: { inner: "workspace:*" } }, { inner: ["inner@workspace:packages/inner"] }));
    expect(productionPackages(lock)).toEqual([]);
  });

  test("bun.lock's own form (comments, trailing commas) is read, and what is not a lock is refused", () => {
    const text = '// bun lockfile\n{\n  "lockfileVersion": 2,\n  "workspaces": { "": { "dependencies": { "a": "1", }, }, },\n  "packages": {\n    "a": ["a@1.0.0", "", {}, "sha512-x",],\n  },\n}\n';
    expect(productionPackages(parseLock(text)).map((pkg) => pkg.name)).toEqual(["a"]);
    expect(() => parseLock("{ not json")).toThrow("cannot be read");
    expect(() => parseLock("[]")).toThrow("not a lockfile");
    expect(() => parseLock('{"workspaces":{},"packages":{"a":["nope"]}}')).toThrow("not name@version");
    expect(() => parseLock('{"workspaces":{},"packages":{"a":[1]}}')).toThrow('no "name@version"');
  });

  test("a lock key is split into package names, a scope and its name staying one", () => {
    expect(keySegments("a")).toEqual(["a"]);
    expect(keySegments("@s/c")).toEqual(["@s/c"]);
    expect(keySegments("a/@s/c/b")).toEqual(["a", "@s/c", "b"]);
    expect(packageDir("/r", "a/@s/c/b")).toBe(join("/r", "node_modules", "a", "node_modules", "@s/c", "node_modules", "b"));
    expect(packageDir("/r", "@types/bun")).toBe(join("/r", "node_modules", "@types/bun"));
  });

  test("the declared licence is read in its three forms, and nothing else is a licence", () => {
    expect(declaredLicence({ license: "MIT" })).toBe("MIT");
    expect(declaredLicence({ license: { type: "ISC", url: "x" } })).toBe("ISC");
    expect(declaredLicence({ licenses: [{ type: "MIT" }] })).toBe("MIT");
    expect(declaredLicence({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe("(MIT OR Apache-2.0)");
    expect(declaredLicence({ licenses: ["MIT", "ISC"] })).toBe("(MIT OR ISC)");
    for (const none of [{}, { license: "" }, { license: 3 }, { licenses: [] }, { licenses: [{}] }, null, "MIT", []]) expect(declaredLicence(none)).toBeNull();
    expect(metaFromJson({ license: "MIT", homepage: " https://h ", repository: { url: "git+https://r" } })).toEqual({ licence: "MIT", homepage: "https://h", repository: "git+https://r" });
    expect(metaFromJson({ repository: "github:o/r" }).repository).toBe("github:o/r");
    expect(metaFromJson(null)).toEqual({ licence: null, homepage: null, repository: null });
  });
});

describe("what is read from node_modules", () => {
  test("licence files are found by name, tidied, sorted, and only files count", async () => {
    const dir = await temp();
    await writeFile(join(dir, "LICENSE"), "MIT  \r\nline two\r\n\r\n");
    await writeFile(join(dir, "NOTICE.txt"), "attribution");
    await writeFile(join(dir, "LICENSE-APACHE"), "apache");
    await writeFile(join(dir, "licence.md"), "british");
    await writeFile(join(dir, "README.md"), "not a licence");
    await writeFile(join(dir, "license-checker.js"), "code that is named like a licence");
    await mkdir(join(dir, "COPYING"));
    expect(await readLicenceFiles(dir)).toEqual([
      { name: "LICENSE", text: "MIT\nline two" },
      { name: "LICENSE-APACHE", text: "apache" },
      { name: "NOTICE.txt", text: "attribution" },
      { name: "licence.md", text: "british" },
    ]);
    expect(await readLicenceFiles(join(dir, "nowhere"))).toEqual([]);
  });

  test("a package that is not installed, or whose package.json is not JSON, has no meta", async () => {
    const dir = await temp();
    expect(await readPackageMeta(dir)).toBeNull();
    await writeFile(join(dir, "package.json"), "{ not json");
    expect(await readPackageMeta(dir)).toBeNull();
    await writeFile(join(dir, "package.json"), '{"license":"MIT"}');
    expect(await readPackageMeta(dir)).toEqual({ licence: "MIT", homepage: null, repository: null });
  });

  test("the Bun version is the one every workflow pins, and two versions or none are refused", () => {
    expect(pinnedBunVersion({ a: "    bun-version: 1.4.2\n", b: "      bun-version: 1.4.2" })).toBe("1.4.2");
    expect(pinnedBunVersion({ a: 'with:\n  bun-version: "1.5.0"\n' })).toBe("1.5.0");
    expect(() => pinnedBunVersion({ a: "bun-version: 1.4.2", b: "bun-version: 1.5.0" })).toThrow("different Bun versions");
    expect(() => pinnedBunVersion({ a: "bun-version: latest" })).toThrow("not pinned");
  });
});

/** A temporary tree that has what the generator reads: the lock, the workflows, the font licences, installed packages. */
async function fixtureRoot(lock: string, installed: Record<string, { json: object; files?: Record<string, string> }> = {}): Promise<string> {
  const root = await temp();
  const copy = async (path: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(ROOT, path), join(root, path));
  };
  for (const path of [RELEASE_WORKFLOW, CI_WORKFLOW, ...BUNDLED_FONTS.map((font) => font.licenceFile)]) await copy(path);
  await writeFile(join(root, "bun.lock"), lock);
  for (const [key, pkg] of Object.entries(installed)) {
    const dir = packageDir(root, key);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg.json));
    for (const [name, text] of Object.entries(pkg.files ?? {})) await writeFile(join(dir, name), text);
  }
  return root;
}

const oneDependencyLock = JSON.stringify({
  lockfileVersion: 2,
  workspaces: { "": { name: "x", dependencies: { "@o/lib": "^1" }, devDependencies: { tool: "^1" } } },
  packages: {
    "@o/lib": ["@o/lib@1.2.3", "", { dependencies: { inner: "^1" } }, "sha512-x"],
    inner: ["inner@2.0.0", "", {}, "sha512-y"],
    tool: ["tool@1.0.0", "", {}, "sha512-z"],
  },
});

describe("a tree with production dependencies", () => {
  test("their names, versions, licences and licence files are in the notices, and the dev tool is not", async () => {
    const root = await fixtureRoot(oneDependencyLock, {
      "@o/lib": { json: { license: "MIT", homepage: "https://o.example/lib" }, files: { LICENSE: "Copyright (c) O\r\nMIT text\r\n" } },
      inner: { json: { license: "Apache-2.0", repository: { url: "git+https://o.example/inner.git" } }, files: { LICENSE: "Apache text with ``` backticks", NOTICE: "inner notice" } },
      tool: { json: { license: "MIT" } },
    });
    const text = renderNotices(await collectInputs(root));
    expect(text).toContain("2 production package(s)");
    expect(text).toContain("### @o/lib@1.2.3");
    expect(text).toContain("- Licence: MIT");
    expect(text).toContain("- Homepage: https://o.example/lib");
    expect(text).toContain("Copyright (c) O\nMIT text");
    expect(text).toContain("### inner@2.0.0");
    expect(text).toContain("- Repository: git+https://o.example/inner.git");
    expect(text).toContain("inner notice");
    expect(text).toContain("````text\nApache text with ``` backticks\n````");
    expect(text).not.toContain("tool@");
    expect(text).not.toContain("None. `bun.lock` lists no runtime dependency");
    expect(text.indexOf("### @o/lib@1.2.3")).toBeLessThan(text.indexOf("### inner@2.0.0"));
  });

  test("a package with no licence file or no declared licence is said so, not skipped", async () => {
    const root = await fixtureRoot(oneDependencyLock, { "@o/lib": { json: {} }, inner: { json: { license: "MIT" } } });
    const text = renderNotices(await collectInputs(root));
    expect(text).toContain("- Licence: none declared");
    expect(text.match(/The package ships no licence file\./g)).toHaveLength(2);
  });

  test("a production package that is not installed stops the script, so the notices are never made from a half install", async () => {
    const root = await fixtureRoot(oneDependencyLock, { "@o/lib": { json: { license: "MIT" } } });
    await expect(collectInputs(root)).rejects.toThrow("inner@2.0.0 is in the production closure but is not installed");
  });

  test("the same tree makes the same bytes twice", async () => {
    const root = await fixtureRoot(oneDependencyLock, { "@o/lib": { json: { license: "MIT" } }, inner: { json: { license: "MIT" } } });
    expect(renderNotices(await collectInputs(root))).toBe(renderNotices(await collectInputs(root)));
  });
});

describe("the command", () => {
  const run = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const code = await main(argv, (text) => (out += `${text}\n`), (text) => (err += `${text}\n`));
    return { code, out, err };
  };

  test("--check passes on the committed file, fails on a missing or an edited one, and --write repairs it", async () => {
    const root = await fixtureRoot(await read("bun.lock"));
    expect((await run(["--check", "--root", root])).code).toBe(1);
    const wrote = await run(["--write", "--root", root]);
    expect(wrote.code).toBe(0);
    expect(wrote.out).toContain("wrote THIRD_PARTY_NOTICES.md");
    expect(await readFile(join(root, NOTICES_FILE), "utf8")).toBe(await read(NOTICES_FILE));
    expect((await run(["--check", "--root", root])).code).toBe(0);
    await writeFile(join(root, NOTICES_FILE), `${await read(NOTICES_FILE)}hand edit\n`);
    const stale = await run(["--check", "--root", root]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("is stale");
    expect((await run(["--write", "--root", root])).code).toBe(0);
    expect((await run(["--check", "--root", root])).code).toBe(0);
  });

  test("with no flag it prints the file, and an argument it does not know, or a lock it cannot read, is exit 2", async () => {
    const root = await fixtureRoot(await read("bun.lock"));
    const printed = await run(["--root", root]);
    expect(printed.code).toBe(0);
    expect(printed.out).toBe(`${(await read(NOTICES_FILE)).trimEnd()}\n`);
    expect((await run(["--nope"])).code).toBe(2);
    expect((await run(["--root"])).code).toBe(2);
    const broken = await fixtureRoot("{ not a lock");
    const failed = await run(["--check", "--root", broken]);
    expect(failed.code).toBe(2);
    expect(failed.err).toContain("bun.lock cannot be read");
  });

  test("run as a program on this tree: --check exits 0", async () => {
    const child = Bun.spawn(["bun", "run", "scripts/third-party-notices.ts", "--check"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    expect(`${out}${err}`).toContain("is current");
    expect(child.exitCode).toBe(0);
  }, 60_000);
});
