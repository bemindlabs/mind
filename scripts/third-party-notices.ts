#!/usr/bin/env bun
/**
 * THIRD_PARTY_NOTICES.md: what a release binary carries that somebody else wrote, with each licence in full.
 *
 *   bun run scripts/third-party-notices.ts            print the file this would make
 *   bun run scripts/third-party-notices.ts --write    write THIRD_PARTY_NOTICES.md
 *   bun run scripts/third-party-notices.ts --check    exit 1 unless the committed file is what this makes today
 *   --root <dir>                                      another tree (the tests use a temporary one)
 *
 * ## What the binary really bundles
 *
 * `bun build bin/mind.ts --compile` makes one file out of three kinds of things:
 *
 *   1. **The Bun runtime.** A compiled binary is a copy of the Bun executable with the bundled program appended.
 *      The version is the one the release workflow installs (`bun-version:` in `.github/workflows/release.yml`).
 *   2. **The fonts of `mind web`.** `src/web/fonts.ts` holds them as base64, so they are in the binary. Their licence
 *      texts sit beside it in `src/web/fonts/`. {@link BUNDLED_FONTS} names each family once, and a test holds that
 *      list equal to what `fonts.ts` really serves, so a font cannot be added without a notice.
 *   3. **npm packages.** The production closure of `bun.lock`: what the workspaces ask for in `dependencies` and
 *      `optionalDependencies`, and what those need in turn. Today that is nothing (the engine has no runtime
 *      dependencies); `typescript` and `@types/bun` are development tools and are not in the binary.
 *
 * The output has no date and no machine name, so the same inputs make the same bytes, and a test can hold the
 * committed file equal to what this makes. The part that needs `node_modules` (a package's licence files) is
 * only read for a production package, so a tree with none needs no install to be checked.
 *
 * The functions are pure or take their reader, the run is behind `import.meta.main`, and
 * `scripts/licence-audit.ts` uses the same lock reading, so the audit and the notices look at the same packages.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** The committed file, relative to the repository root. */
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

/** The workflow whose `bun-version:` is the Bun that is copied into a released binary. */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

/** The other workflow that installs Bun; it must name the same version, or CI tests a different runtime. */
export const CI_WORKFLOW = ".github/workflows/ci.yml";

// ── the lock ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One entry of `bun.lock`'s `packages`. */
export interface LockPackage {
  /** The key in the lock: the package's name, or `parent/name` where bun nested it under another package. */
  readonly key: string;
  readonly name: string;
  readonly version: string;
  /** A member of this repository's own workspaces: not third-party. */
  readonly workspace: boolean;
  /** What it needs to run: a missing one means the lock is damaged. */
  readonly required: readonly string[];
  /** Optional and peer dependencies: left out of the closure when the lock does not list them. */
  readonly soft: readonly string[];
}

export interface ParsedLock {
  /** What the workspaces ask for in `dependencies`. */
  readonly rootRequired: readonly string[];
  /** What the workspaces ask for in `optionalDependencies`. */
  readonly rootSoft: readonly string[];
  /** What the workspaces ask for in `devDependencies`: installed, never shipped. */
  readonly rootDev: readonly string[];
  readonly packages: ReadonlyMap<string, LockPackage>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const namesOf = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : []);

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Read `bun.lock` (JSON with comments and trailing commas). Anything it does not recognise throws: a script that
 * decides what ships must not guess at a lock it cannot read.
 */
export function parseLock(text: string): ParsedLock {
  let doc: unknown;
  try {
    doc = Bun.JSONC.parse(text);
  } catch (error) {
    throw new Error(`bun.lock cannot be read: ${(error as Error).message}`);
  }
  if (!isRecord(doc) || !isRecord(doc["workspaces"]) || !isRecord(doc["packages"])) {
    throw new Error("bun.lock has no `workspaces` and `packages`: this is not a lockfile this script understands");
  }

  const rootRequired = new Set<string>();
  const rootSoft = new Set<string>();
  const rootDev = new Set<string>();
  for (const workspace of Object.values(doc["workspaces"])) {
    if (!isRecord(workspace)) continue;
    for (const name of namesOf(workspace["dependencies"])) rootRequired.add(name);
    for (const name of namesOf(workspace["optionalDependencies"])) rootSoft.add(name);
    for (const name of namesOf(workspace["devDependencies"])) rootDev.add(name);
  }

  const packages = new Map<string, LockPackage>();
  for (const [key, entry] of Object.entries(doc["packages"])) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error(`bun.lock: the entry for ${key} has no "name@version"`);
    const spec = entry[0];
    const at = spec.indexOf("@", 1);
    if (at < 1) throw new Error(`bun.lock: "${spec}" (${key}) is not name@version`);
    const meta = isRecord(entry[2]) ? entry[2] : {};
    packages.set(key, {
      key,
      name: spec.slice(0, at),
      version: spec.slice(at + 1),
      workspace: spec.slice(at + 1).startsWith("workspace:"),
      required: namesOf(meta["dependencies"]),
      soft: [...namesOf(meta["optionalDependencies"]), ...namesOf(meta["peerDependencies"])],
    });
  }
  return {
    rootRequired: [...rootRequired].sort(compareText),
    rootSoft: [...rootSoft].sort(compareText),
    rootDev: [...rootDev].sort(compareText),
    packages,
  };
}

/** A lock key as package names: `a/@s/b` is `a` then `@s/b`, because a scope and its name are one package. */
export function keySegments(key: string): string[] {
  const parts = key.split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.startsWith("@") && i + 1 < parts.length) {
      out.push(`${part}/${parts[i + 1]!}`);
      i++;
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Where `dep` resolves from the package at `parentKey`: its own nested copy, then each parent's, then the top. */
function resolveDep(parentKey: string, dep: string, packages: ReadonlyMap<string, LockPackage>): string | undefined {
  const segments = parentKey === "" ? [] : keySegments(parentKey);
  for (let n = segments.length; n >= 0; n--) {
    const candidate = [...segments.slice(0, n), dep].join("/");
    if (packages.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The packages that ship: everything reachable from a workspace's `dependencies` and `optionalDependencies`, in a
 * fixed order. A required dependency the lock does not list throws (the lock is damaged); an optional or peer one
 * that it does not list is a package this platform never installed, and is skipped.
 */
export function productionPackages(lock: ParsedLock): LockPackage[] {
  const seen = new Map<string, LockPackage>();
  const queue: Array<{ from: string; dep: string; soft: boolean }> = [
    ...lock.rootRequired.map((dep) => ({ from: "", dep, soft: false })),
    ...lock.rootSoft.map((dep) => ({ from: "", dep, soft: true })),
  ];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const key = resolveDep(next.from, next.dep, lock.packages);
    if (key === undefined) {
      if (next.soft) continue;
      throw new Error(`bun.lock is inconsistent: ${next.from === "" ? "a workspace" : next.from} needs ${next.dep}, which the lock does not list`);
    }
    if (seen.has(key)) continue;
    const pkg = lock.packages.get(key)!;
    seen.set(key, pkg);
    for (const dep of pkg.required) queue.push({ from: key, dep, soft: false });
    for (const dep of pkg.soft) queue.push({ from: key, dep, soft: true });
  }
  return [...seen.values()]
    .filter((pkg) => !pkg.workspace)
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.version, b.version) || compareText(a.key, b.key));
}

// ── what is installed ──────────────────────────────────────────────────────────────────────────────────────────

/** What a package says about itself in its `package.json`. */
export interface PackageMeta {
  /** An SPDX expression, or `null` when the package declares none. */
  readonly licence: string | null;
  readonly homepage: string | null;
  readonly repository: string | null;
}

/** Where bun puts the package of a lock key: `node_modules/a`, or `node_modules/a/node_modules/b` when nested. */
export function packageDir(root: string, key: string): string {
  const [top, ...nested] = keySegments(key);
  return join(root, "node_modules", top ?? key, ...nested.flatMap((segment) => ["node_modules", segment]));
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * The licence a `package.json` declares, as one expression. The current form is `"license": "MIT"`; the two old
 * forms, `{ "type": "MIT" }` and `"licenses": [{ "type": "MIT" }, …]` (npm reads the list as "either"), are read too.
 */
export function declaredLicence(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const current = json["license"];
  const single = textOrNull(current) ?? (isRecord(current) ? textOrNull(current["type"]) : null);
  if (single !== null) return single;
  const list = json["licenses"];
  if (Array.isArray(list)) {
    const types = list.map((item) => textOrNull(item) ?? (isRecord(item) ? textOrNull(item["type"]) : null));
    if (types.length > 0 && types.every((type): type is string => type !== null)) return types.length === 1 ? types[0]! : `(${types.join(" OR ")})`;
  }
  return null;
}

/** The fields of a parsed `package.json` that the notices use. */
export function metaFromJson(json: unknown): PackageMeta {
  const record = isRecord(json) ? json : {};
  const repository = record["repository"];
  return {
    licence: declaredLicence(json),
    homepage: textOrNull(record["homepage"]),
    repository: textOrNull(repository) ?? (isRecord(repository) ? textOrNull(repository["url"]) : null),
  };
}

/** The meta of the package installed in `dir`, or `null` when nothing is installed there. */
export async function readPackageMeta(dir: string): Promise<PackageMeta | null> {
  let text: string;
  try {
    text = await readFile(join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  try {
    return metaFromJson(JSON.parse(text));
  } catch {
    return null;
  }
}

/** LICENSE, LICENSE.md, LICENCE-MIT, COPYING, NOTICE, NOTICE.txt: what a package ships to say who wrote it. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-_.][a-z0-9._-]*)?$/i;

/** A file that is named like a licence and is code: `license-checker.js` is not somebody's licence text. */
const CODE_FILE = /\.(?:[cm]?[jt]s|json|map)$/i;

/** The text of one licence file, with CRLF made LF and no trailing space, so the same text is the same bytes. */
const tidy = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();

export interface LicenceFile {
  readonly name: string;
  readonly text: string;
}

/** The licence files in a package's directory, sorted by name. None is an empty list. */
export async function readLicenceFiles(dir: string): Promise<LicenceFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name) && !CODE_FILE.test(entry.name)).map((entry) => entry.name).sort(compareText);
  return Promise.all(names.map(async (name) => ({ name, text: tidy(await readFile(join(dir, name), "utf8")) })));
}

// ── what the binary bundles besides packages ───────────────────────────────────────────────────────────────────

/** A font family embedded in `src/web/fonts.ts`. */
export interface BundledFont {
  /** The `font-family` the page's CSS names. */
  readonly family: string;
  /** The SPDX id of its licence. */
  readonly licence: string;
  /** The line the licence file opens with: the notice the licence says to keep. A test reads it from the file. */
  readonly copyright: string;
  /** The licence text, relative to the repository root. */
  readonly licenceFile: string;
  /** The keys of `FONT_FILES` that are this family. */
  readonly files: readonly string[];
  /** Where the bytes came from and what was done to them, as `src/web/fonts.ts` says. */
  readonly source: string;
}

/**
 * Every family `src/web/fonts.ts` serves. `test/packaging/notices.test.ts` holds this equal to the families in
 * `FONT_CSS`, the keys of `FONT_FILES` and the `OFL-*.txt` files, in both directions.
 */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    family: "Inter",
    licence: "OFL-1.1",
    copyright: "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)",
    licenceFile: "src/web/fonts/OFL-Inter.txt",
    files: ["inter-400", "inter-500", "inter-600"],
    source: "Inter 4.001, the 24pt cuts at weights 400, 500 and 600, converted to woff2 and changed in nothing else.",
  },
  {
    family: "IBM Plex Sans Thai",
    licence: "OFL-1.1",
    copyright: "Copyright 2019 IBM Corp. All rights reserved.",
    licenceFile: "src/web/fonts/OFL-IBMPlexSansThai.txt",
    files: ["plex-thai-thai-400", "plex-thai-thai-600"],
    source: "The Thai subset at weights 400 and 600, as @fontsource (v5) publishes it, in woff2.",
  },
];

/** The Bun runtime that `bun build --compile` copies into every binary. */
export const RUNTIME = {
  name: "Bun",
  homepage: "https://bun.sh",
  licence: "MIT",
  /** Where Bun lists the licences of what it links, for one version. Not fetched by this script. */
  licenceListUrl: (version: string): string => `https://github.com/oven-sh/bun/blob/bun-v${version}/LICENSE.md`,
} as const;

/** The one other place the binary's source names an outside implementation it follows, and the licence of that one. */
export const QR_ACKNOWLEDGEMENT = {
  file: "src/web/qr.ts",
  name: "Project Nayuki's QR Code generator library",
  url: "https://www.nayuki.io/page/qr-code-generator-library",
  copyright: "Copyright (c) Project Nayuki. (MIT License)",
  licence: [
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ],
} as const;

/**
 * The Bun version a release is built with: every `bun-version:` in the given workflows, which must all be the same.
 * Two versions would mean CI tests one runtime and a release ships another.
 */
export function pinnedBunVersion(workflows: Readonly<Record<string, string>>): string {
  const found = new Map<string, string[]>();
  for (const [file, text] of Object.entries(workflows)) {
    for (const match of text.matchAll(/^\s*bun-version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/gm)) {
      found.set(match[1]!, [...(found.get(match[1]!) ?? []), file]);
    }
  }
  if (found.size === 0) throw new Error("no `bun-version:` in the workflows: the Bun inside a release is not pinned");
  if (found.size > 1) {
    throw new Error(`the workflows pin different Bun versions: ${[...found].map(([version, files]) => `${version} in ${files.join(", ")}`).join("; ")}`);
  }
  return [...found.keys()][0]!;
}

// ── the file ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface NoticePackage {
  readonly pkg: LockPackage;
  readonly meta: PackageMeta;
  readonly files: readonly LicenceFile[];
}

export interface NoticeInputs {
  readonly bunVersion: string;
  readonly fonts: ReadonlyArray<{ readonly font: BundledFont; readonly text: string }>;
  readonly packages: readonly NoticePackage[];
  /** Names of the installed development tools, so the file can say what it leaves out. */
  readonly devTools: readonly string[];
}

/** A fence of backticks longer than any run in `text`, so licence text cannot end its own block. */
function fenced(text: string): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return [fence + "text", text, fence];
}

/** The text of THIRD_PARTY_NOTICES.md for these inputs. Pure: no clock, no path, no machine. */
export function renderNotices(input: NoticeInputs): string {
  const lines: string[] = [
    "# Third-party notices",
    "",
    "Mind's own code is licensed under the Apache License, Version 2.0 (`LICENSE`, `NOTICE`). This file lists what a",
    "released `mind` binary carries that was written by somebody else, and the licence of each, in full.",
    "",
    "It is made by `scripts/third-party-notices.ts` from `bun.lock`, `src/web/fonts.ts`, the licence texts in",
    "`src/web/fonts/` and the Bun version in `.github/workflows/release.yml`. Do not edit it by hand:",
    "",
    "    bun run scripts/third-party-notices.ts --write",
    "",
    "A test fails when this file is not what that command makes today.",
    "",
    "## 1. The Bun runtime",
    "",
    `Every released binary is made by \`bun build bin/mind.ts --compile\`, which copies the ${RUNTIME.name} runtime`,
    `(${RUNTIME.homepage}, version ${input.bunVersion}, the one the release workflow installs) into the binary.`,
    `${RUNTIME.name} is licensed under the ${RUNTIME.licence} licence. It statically links JavaScriptCore, which Bun's licensing`,
    "page states is LGPL-2 licensed, and other libraries with their own licences. Bun lists all of them, with their",
    "licences, in its own `LICENSE.md` for the version above:",
    "",
    `    ${RUNTIME.licenceListUrl(input.bunVersion)}`,
    "",
    "That list is not copied here.",
    "",
    "## 2. Fonts in the web page (`mind web`)",
    "",
    "The page's fonts are embedded in the binary (`src/web/fonts.ts`) so that the page works offline. Each family is",
    "licensed under the SIL Open Font License, Version 1.1, whose text is given below as the licence requires.",
  ];

  for (const { font, text } of input.fonts) {
    lines.push("", `### ${font.family}`, "", `- Licence: ${font.licence} (SIL Open Font License, Version 1.1)`, `- Notice: ${font.copyright}`);
    lines.push(`- Files: ${font.files.map((file) => `\`${file}.woff2\``).join(", ")}`, `- Source: ${font.source}`, `- Licence text in the repository: \`${font.licenceFile}\``, "");
    lines.push(...fenced(tidy(text)));
  }

  lines.push(
    "",
    "## 3. Acknowledged: the QR encoder",
    "",
    `\`${QR_ACKNOWLEDGEMENT.file}\` is this project's own implementation of ISO/IEC 18004, for the pairing code of \`mind web\`.`,
    `It follows the layout of ${QR_ACKNOWLEDGEMENT.name}; no file of that library is vendored.`,
    "",
    `    ${QR_ACKNOWLEDGEMENT.url}`,
    "",
    "Its licence notice is kept here in case any part of that layout counts as derived from it:",
    "",
    ...fenced([QR_ACKNOWLEDGEMENT.copyright, "", ...QR_ACKNOWLEDGEMENT.licence.flatMap((paragraph) => [paragraph, ""])].join("\n").trim()),
    "",
    "## 4. npm packages",
    "",
  );

  if (input.packages.length === 0) {
    lines.push("None. `bun.lock` lists no runtime dependency: the binary holds Mind's own code, the fonts above and the Bun runtime.");
    if (input.devTools.length > 0) {
      const tools = input.devTools.map((name) => `\`${name}\``).join(", ");
      lines.push("", `The development tools (${tools}) are installed to build and test, and are not in the binary.`);
    }
  } else {
    lines.push(`${input.packages.length} production package(s), from the production closure of \`bun.lock\`.`);
    for (const { pkg, meta, files } of input.packages) {
      lines.push("", `### ${pkg.name}@${pkg.version}`, "", `- Licence: ${meta.licence ?? "none declared"}`);
      if (meta.homepage !== null) lines.push(`- Homepage: ${meta.homepage}`);
      if (meta.repository !== null) lines.push(`- Repository: ${meta.repository}`);
      if (files.length === 0) lines.push("- The package ships no licence file.");
      for (const file of files) lines.push("", `${file.name}:`, "", ...fenced(file.text));
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Everything the file is made from, read from the tree at `root`. Throws when a production package is not installed. */
export async function collectInputs(root: string): Promise<NoticeInputs> {
  const lock = parseLock(await readFile(join(root, "bun.lock"), "utf8"));
  const bunVersion = pinnedBunVersion({
    [RELEASE_WORKFLOW]: await readFile(join(root, RELEASE_WORKFLOW), "utf8"),
    [CI_WORKFLOW]: await readFile(join(root, CI_WORKFLOW), "utf8"),
  });
  const fonts = await Promise.all(BUNDLED_FONTS.map(async (font) => ({ font, text: await readFile(join(root, font.licenceFile), "utf8") })));
  const packages: NoticePackage[] = [];
  for (const pkg of productionPackages(lock)) {
    const dir = packageDir(root, pkg.key);
    const meta = await readPackageMeta(dir);
    if (meta === null) throw new Error(`${pkg.name}@${pkg.version} is in the production closure but is not installed at ${dir}: run bun install --frozen-lockfile`);
    packages.push({ pkg, meta, files: await readLicenceFiles(dir) });
  }
  return { bunVersion, fonts, packages, devTools: lock.rootDev };
}

/** The committed file against what the tree makes today: `null` when they are the same, else a sentence saying so. */
export function staleness(committed: string | null, made: string): string | null {
  if (committed === null) return `${NOTICES_FILE} does not exist: run \`bun run scripts/third-party-notices.ts --write\``;
  if (committed === made) return null;
  const a = committed.split("\n");
  const b = made.split("\n");
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  return `${NOTICES_FILE} is stale: it first differs from what the script makes at line ${at + 1} (${JSON.stringify((a[at] ?? "<end>").slice(0, 80))} against ${JSON.stringify((b[at] ?? "<end>").slice(0, 80))}). Run \`bun run scripts/third-party-notices.ts --write\` and commit it.`;
}

/** The committed file at `root`, or `null` when there is none. */
export async function readCommitted(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, NOTICES_FILE), "utf8");
  } catch {
    return null;
  }
}

const USAGE = "usage: bun run scripts/third-party-notices.ts [--write | --check] [--root <dir>]";

/** The command, as a function: the exit code it would give. `out` and `err` take what it prints. */
export async function main(argv: readonly string[], out: (text: string) => void = console.log, err: (text: string) => void = console.error): Promise<number> {
  let root = resolve(import.meta.dir, "..");
  let mode: "print" | "write" | "check" = "print";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--write") mode = "write";
    else if (arg === "--check") mode = "check";
    else if (arg === "--root" && argv[i + 1] !== undefined) root = resolve(argv[++i]!);
    else {
      err(`third-party-notices: unknown argument ${arg}\n${USAGE}`);
      return 2;
    }
  }
  let made: string;
  try {
    made = renderNotices(await collectInputs(root));
  } catch (error) {
    err(`third-party-notices: ${(error as Error).message}`);
    return 2;
  }
  if (mode === "print") {
    out(made.trimEnd());
    return 0;
  }
  if (mode === "write") {
    await writeFile(join(root, NOTICES_FILE), made);
    out(`third-party-notices: wrote ${NOTICES_FILE}`);
    return 0;
  }
  const problem = staleness(await readCommitted(root), made);
  if (problem !== null) {
    err(`third-party-notices: ${problem}`);
    return 1;
  }
  out(`third-party-notices: ${NOTICES_FILE} is current`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
