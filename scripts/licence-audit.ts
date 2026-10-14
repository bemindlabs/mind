#!/usr/bin/env bun
/**
 * The licence audit: CI fails when something that ships has a licence outside the allowlist.
 *
 *   bun run scripts/licence-audit.ts              audit this tree
 *   bun run scripts/licence-audit.ts --root <dir>  audit another tree (the tests use temporary ones)
 *
 * ## What is audited
 *
 *   - **Every production package** in `bun.lock`: what the workspaces ask for in `dependencies` and
 *     `optionalDependencies`, and what those need in turn (the closure `scripts/third-party-notices.ts` also uses,
 *     so the audit and the notices cannot look at different packages). Development tools are installed but never
 *     shipped and are not judged here. `bun audit` looks at those for vulnerabilities, a different question.
 *   - **Every bundled font** (`BUNDLED_FONTS`): its licence must be on the list and its licence text must be in the
 *     repository, because a font whose text was deleted is a font shipped without the licence it asks for.
 *
 * The Bun runtime inside a compiled binary is not a dependency anyone chose per package, and is not judged here.
 * It is named in `NOTICE` and `THIRD_PARTY_NOTICES.md` instead.
 *
 * ## What counts as allowed
 *
 * The licence a package declares is an SPDX expression (`MIT`, `(MIT OR Apache-2.0)`, `MIT AND Zlib`,
 * `Apache-2.0 WITH LLVM-exception`). `OR` passes when either side is on the list, `AND` when both are, and `WITH`
 * is judged by the licence before it (an exception only adds permissions). The list is permissive licences only:
 * nothing that asks for source to be shared, for a network clause or for a field of use. Anything that is not an
 * SPDX expression, a package with no licence field, and a package that is not installed all FAIL: a check that
 * passes on what it could not read is not a check. One package whose metadata is wrong can be named in
 * {@link LICENCE_OVERRIDES} with the version it was read at and the reason; the list itself is not loosened for it.
 *
 * Exit 0 when everything is allowed, 1 when something is not, 2 when the tree cannot be read.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BUNDLED_FONTS,
  type LockPackage,
  type PackageMeta,
  packageDir,
  parseLock,
  productionPackages,
  readPackageMeta,
} from "./third-party-notices.ts";

/**
 * The SPDX ids that may be shipped. Compared without regard to case, as SPDX says ids are.
 * A new entry is a decision: say in the commit who agreed to it.
 */
export const ALLOWED_LICENCES: readonly string[] = [
  "Apache-2.0",
  "MIT",
  "MIT-0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "OFL-1.1",
  "CC0-1.0",
  "Unlicense",
  "Zlib",
];

/**
 * A package whose `package.json` declares nothing usable, or the wrong thing, and whose real licence was read by
 * a person. Keyed by `name@version`, so a new version is looked at again. Empty today.
 */
export const LICENCE_OVERRIDES: Readonly<Record<string, { readonly licence: string; readonly why: string }>> = {};

// ── SPDX expressions ───────────────────────────────────────────────────────────────────────────────────────────

type Node =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "and" | "or"; readonly left: Node; readonly right: Node };

/** The expression as a tree, or the reason it is not one. */
function parse(expression: string): { readonly node: Node } | { readonly error: string } {
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+:-]+/g) ?? [];
  if (tokens.join("").length !== expression.replace(/\s+/g, "").length) return { error: "it has characters an SPDX expression does not" };
  let at = 0;
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const isOperator = (token: string | undefined, word: string): boolean => token !== undefined && token.toUpperCase() === word;

  const atom = (): Node => {
    const token = tokens[at++];
    if (token === undefined) return fail("it ends where a licence is expected");
    if (token === "(") {
      const inner = or();
      if (tokens[at++] !== ")") fail("a parenthesis is not closed");
      return inner;
    }
    if (token === ")" || isOperator(token, "AND") || isOperator(token, "OR") || isOperator(token, "WITH")) return fail(`"${token}" is where a licence is expected`);
    if (isOperator(tokens[at], "WITH")) {
      at++;
      const exception = tokens[at++];
      if (exception === undefined || exception === "(" || exception === ")") fail("WITH has no exception after it");
    }
    return { kind: "id", id: token.replace(/\+$/, "") };
  };
  const and = (): Node => {
    let node = atom();
    while (isOperator(tokens[at], "AND")) {
      at++;
      node = { kind: "and", left: node, right: atom() };
    }
    return node;
  };
  const or = (): Node => {
    let node = and();
    while (isOperator(tokens[at], "OR")) {
      at++;
      node = { kind: "or", left: node, right: and() };
    }
    return node;
  };

  try {
    const node = or();
    if (at !== tokens.length) fail(`"${tokens[at]}" follows a complete expression`);
    return { node };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** What the audit says about one licence expression. */
export interface Verdict {
  readonly ok: boolean;
  /** Why not, as a sentence, or `""` when it is allowed. */
  readonly reason: string;
}

/** Is this licence expression on the list? An empty or unreadable one is not. */
export function evaluateLicence(expression: string | null, allowed: readonly string[] = ALLOWED_LICENCES): Verdict {
  if (expression === null || expression.trim() === "") return { ok: false, reason: "it declares no licence" };
  const parsed = parse(expression.trim());
  if ("error" in parsed) return { ok: false, reason: `"${expression}" is not an SPDX licence expression (${parsed.error})` };
  const list = new Set(allowed.map((id) => id.toLowerCase()));
  const outside: string[] = [];
  const passes = (node: Node): boolean => {
    if (node.kind === "id") {
      const ok = list.has(node.id.toLowerCase());
      if (!ok) outside.push(node.id);
      return ok;
    }
    const left = passes(node.left);
    const right = passes(node.right);
    return node.kind === "or" ? left || right : left && right;
  };
  if (passes(parsed.node)) return { ok: true, reason: "" };
  return { ok: false, reason: `${[...new Set(outside)].join(", ")} ${outside.length === 1 ? "is" : "are"} not on the allowlist` };
}

// ── the audit ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Finding {
  /** `name@version` of a package, or `font <family>`. */
  readonly subject: string;
  /** What was judged: the declared licence, or `null`. */
  readonly licence: string | null;
  readonly ok: boolean;
  readonly reason: string;
}

export interface Report {
  readonly findings: readonly Finding[];
  /** The production packages that were looked at. */
  readonly packages: number;
  readonly fonts: number;
}

/** What the audit reads from the world, so a test can give it a fake one. */
export interface Reader {
  readonly meta: (pkg: LockPackage) => Promise<PackageMeta | null>;
  readonly exists: (repoPath: string) => boolean;
  readonly lockText: () => Promise<string>;
}

/** The reader for the tree at `root`. */
export function readerFor(root: string): Reader {
  return {
    meta: (pkg) => readPackageMeta(packageDir(root, pkg.key)),
    exists: (repoPath) => existsSync(join(root, repoPath)),
    lockText: () => readFile(join(root, "bun.lock"), "utf8"),
  };
}

/** Judge every production package and every bundled font. Throws only when the lock cannot be read. */
export async function auditLicences(
  reader: Reader,
  allowed: readonly string[] = ALLOWED_LICENCES,
  overrides: Readonly<Record<string, { readonly licence: string; readonly why: string }>> = LICENCE_OVERRIDES,
): Promise<Report> {
  const packages = productionPackages(parseLock(await reader.lockText()));
  const findings: Finding[] = [];

  for (const pkg of packages) {
    const subject = `${pkg.name}@${pkg.version}`;
    const override = overrides[subject];
    if (override !== undefined) {
      findings.push({ subject, licence: override.licence, ...evaluateLicence(override.licence, allowed) });
      continue;
    }
    const meta = await reader.meta(pkg);
    if (meta === null) {
      findings.push({ subject, licence: null, ok: false, reason: "it is in the production closure but is not installed, so its licence cannot be read: run bun install --frozen-lockfile" });
      continue;
    }
    findings.push({ subject, licence: meta.licence, ...evaluateLicence(meta.licence, allowed) });
  }

  for (const font of BUNDLED_FONTS) {
    const verdict = evaluateLicence(font.licence, allowed);
    if (verdict.ok && !reader.exists(font.licenceFile)) {
      findings.push({ subject: `font ${font.family}`, licence: font.licence, ok: false, reason: `its licence text ${font.licenceFile} is not in the repository` });
    } else {
      findings.push({ subject: `font ${font.family}`, licence: font.licence, ...verdict });
    }
  }

  return { findings, packages: packages.length, fonts: BUNDLED_FONTS.length };
}

/** The report as lines a person reads in a CI log. */
export function renderReport(report: Report, allowed: readonly string[] = ALLOWED_LICENCES): string[] {
  const failed = report.findings.filter((finding) => !finding.ok);
  const lines = [
    `licence-audit: ${report.packages} production package(s), ${report.fonts} bundled font(s); allowed: ${allowed.join(", ")}`,
    ...report.findings.map((finding) => `  ${finding.ok ? "ok  " : "FAIL"} ${finding.subject} - ${finding.licence ?? "no licence"}${finding.ok ? "" : `: ${finding.reason}`}`),
    failed.length === 0 ? "licence-audit: pass" : `licence-audit: FAIL, ${failed.length} of ${report.findings.length} outside the allowlist or unreadable`,
  ];
  return lines;
}

const USAGE = "usage: bun run scripts/licence-audit.ts [--root <dir>]";

/** The command, as a function: the exit code it would give. */
export async function main(argv: readonly string[], out: (text: string) => void = console.log, err: (text: string) => void = console.error): Promise<number> {
  let root = resolve(import.meta.dir, "..");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--root" && argv[i + 1] !== undefined) root = resolve(argv[++i]!);
    else {
      err(`licence-audit: unknown argument ${arg}\n${USAGE}`);
      return 2;
    }
  }
  let report: Report;
  try {
    report = await auditLicences(readerFor(root));
  } catch (error) {
    err(`licence-audit: ${(error as Error).message}`);
    return 2;
  }
  for (const line of renderReport(report)) (report.findings.every((finding) => finding.ok) ? out : err)(line);
  return report.findings.every((finding) => finding.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
