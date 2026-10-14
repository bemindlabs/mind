/**
 * The checkers that read source as a syntax tree rather than as text.
 *
 * Two acceptance criteria are now proven by walking an import closure and
 * looking at what is in it — S0.4 AC2 (no path in Mind pushes) and S3.5 AC2
 * (no path in the observer opens a socket) — and a third, S2.2 AC4, has been
 * doing a weaker version of the same thing since the ledger landed. They lived
 * as three private copies inside three test files, which is how the ledger's
 * copy still matches `"node:net"` as a *string* and would not see
 * `import net from "net"`.
 *
 * So the checkers are here, and the import walk is over the tree as well:
 *
 * - the regular expression the walk used, `/(?:from|import)\s+"(\.[^"]+)"/`,
 *   cannot see `await import("./leak.ts")` or a single-quoted specifier, and a
 *   closure with a hole in it makes every assertion over that closure smaller
 *   than it reads;
 * - a *file* cannot export helpers to another test file without being run as
 *   a test itself, which is why this is `test/support/` and not a `.test.ts`.
 *
 * Every function here is exercised against synthetic source that it must catch
 * and synthetic source it must not — the controls live in the test files that
 * use them, beside the assertion they make meaningful.
 */

import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/**
 * Parsed trees, by path, each kept with the exact text it was parsed from.
 *
 * `bun test` runs every file in one process, and a dozen guard tests walk the same `src/` tree — each of them
 * parsing every file again. Under `bun run coverage` on a loaded runner that alone took one of them past bun's
 * 5 s timeout. A tree is reused only for identical text, so a synthetic control at a real path, or a file that
 * changed, is parsed afresh: the cache can make a check faster, never different.
 */
const parsed = new Map<string, { readonly source: string; readonly tree: ts.SourceFile }>();

/** Parse once, with positions, so a hit can name a line. */
function parse(path: string, source: string): ts.SourceFile {
  const known = parsed.get(path);
  if (known !== undefined && known.source === source) return known.tree;
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  parsed.set(path, { source, tree });
  return tree;
}

/** Every `.ts` file under a directory, recursively. */
export async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/**
 * Relative module specifiers this file imports, however it spells them.
 *
 * From the tree, so `import`, `export … from`, `import type`, a dynamic
 * `import("./x.ts")` and a `require("./x.ts")` all count, and the same text
 * inside a comment or a string counts for nothing. A dynamic import whose
 * specifier is computed is **not** a specifier this can return — it is a hole,
 * and {@link processEscapes} reports it as one rather than letting the walk
 * quietly stop there.
 */
export function importsOf(path: string, source: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const add = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteral(node) && node.text.startsWith(".")) {
      found.push(node.text);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * **Every** module specifier this file imports — relative, bare, or `node:`.
 *
 * {@link importsOf} deliberately keeps only the relative ones, because it
 * exists to walk an import closure and a bare specifier is where the closure
 * ends. A checker asking "can this layer reach anything at all?" needs the
 * opposite: the bare specifiers are the answer, and dropping them would make
 * the check vacuously true for the imports it most cares about.
 */
export function moduleSpecifiers(path: string, source: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const add = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteral(node)) found.push(node.text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/** The name {@link importedNames} reports for `import * as ns` and for `export *`. */
export const WHOLE_MODULE = "*";

/** The name {@link importedNames} reports for a bare `import "x"`. */
export const SIDE_EFFECT_ONLY = "<side effect>";

/** One name taken out of one module, however it was spelled. */
export interface ImportedName {
  /** The specifier as written, so a caller can resolve it itself. */
  readonly specifier: string;
  /**
   * The name **as the module exports it** — the left half of `a as b`, not the
   * local alias. A renaming import is still the same name coming out of the
   * module, and a guard that read the alias could be defeated by typing `as`.
   */
  readonly name: string;
  readonly line: number;
}

/**
 * Every name this file takes out of another module, one entry per name.
 *
 * {@link importsOf} and {@link moduleSpecifiers} answer *which modules does this
 * reach?*. This answers the next question down, which is the one D-022 actually
 * asks: *which names does it take out of them?* The ledger's write side is
 * closed by S2.2 AC2 and its read side is not, so "who imports the ledger" is
 * the wrong question — `src/erase/plan.ts` imports it and must — and "who
 * imports a name that reads it" is the right one.
 *
 * Four shapes are collapsed into a name deliberately, because each of them takes
 * *everything* and so cannot be checked name by name:
 *
 * - `import * as ledger from "…"` and `export * from "…"` → {@link WHOLE_MODULE};
 * - `import "…"` for its side effects → {@link SIDE_EFFECT_ONLY};
 * - `await import("…")` → {@link WHOLE_MODULE}, because the names it destructures
 *   out are decided at run time and no syntax tree can list them.
 *
 * A re-export (`export { query } from "…"`) is reported as an ordinary name, and
 * that is the point: laundering a read through a second module is one keystroke,
 * and the re-export itself is where it is visible.
 *
 * Type-only spellings are **not** filtered out here. `import type { query }` is
 * erased and harmless, but whether a name is erased is a fact about the module
 * that exports it — see {@link exportedNames} — not about how an importer chose
 * to spell it, and a checker that trusted the spelling would be trusting the
 * file it is checking.
 */
export function importedNames(path: string, source: string): ImportedName[] {
  const file = parse(path, source);
  const found: ImportedName[] = [];

  const push = (specifier: ts.Node | undefined, name: string, at: ts.Node): void => {
    if (specifier === undefined || !ts.isStringLiteral(specifier)) return;
    found.push({ specifier: specifier.text, name, line: line(file, at) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause === undefined) {
        push(node.moduleSpecifier, SIDE_EFFECT_ONLY, node);
      } else {
        if (clause.name !== undefined) push(node.moduleSpecifier, "default", node);
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          push(node.moduleSpecifier, WHOLE_MODULE, node);
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            push(node.moduleSpecifier, (element.propertyName ?? element.name).text, element);
          }
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        push(node.moduleSpecifier, WHOLE_MODULE, node);
      } else {
        for (const element of clause.elements) {
          push(node.moduleSpecifier, (element.propertyName ?? element.name).text, element);
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      push(node.arguments[0], WHOLE_MODULE, node);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/** One name a module exports, and whether anything exists under it at run time. */
export interface ExportedName {
  readonly name: string;
  /** `type` when the declaration is erased before anything runs. */
  readonly kind: "value" | "type";
  readonly line: number;
}

/**
 * Every name this file exports, split into the erased ones and the real ones.
 *
 * The companion {@link importedNames} needs to be useful: an importer that says
 * `import { LedgerEntry }` without the `type` keyword has still imported nothing
 * at run time, because `LedgerEntry` is an interface. So the question "can this
 * name carry a byte of the ledger anywhere?" is answered here, at the
 * declaration, and not at the import.
 *
 * Anything ambiguous is called a **value**, which is the strict direction: an
 * `export { x }` with no `type` keyword is reported as a value even when `x`
 * happens to be a type alias declared above. A guard that guessed the other way
 * would have a hole in the exact shape somebody would use to widen one.
 */
export function exportedNames(path: string, source: string): ExportedName[] {
  const file = parse(path, source);
  const found: ExportedName[] = [];

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

  /** Every identifier a binding pattern introduces, destructuring included. */
  const bound = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) =>
      ts.isBindingElement(element) ? bound(element.name) : [],
    );
  };

  for (const statement of file.statements) {
    const at = line(file, statement);

    if (ts.isExportAssignment(statement)) {
      found.push({ name: "default", kind: "value", line: at });
      continue;
    }

    // `export { a, type b }` with no `from` — a local name made public.
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const erased = statement.isTypeOnly || element.isTypeOnly;
          found.push({ name: element.name.text, kind: erased ? "type" : "value", line: at });
        }
      }
      continue;
    }

    if (!isExported(statement)) continue;

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      found.push({ name: statement.name.text, kind: "type", line: at });
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name !== undefined) {
        found.push({ name: statement.name.text, kind: "value", line: at });
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bound(declaration.name)) {
          found.push({ name, kind: "value", line: line(file, declaration) });
        }
      }
    }
  }

  return found;
}

/**
 * Every use of one of `names` as an *identifier*, reported as `line: name`.
 *
 * The general form of what {@link networkEscapes} does for sockets. Matched on
 * the syntax tree, so the same words in a comment or a string are invisible —
 * which is what lets a layer say "this file names no runtime" while its header
 * comment explains at length which runtime it is not naming.
 */
export function globalsUsed(path: string, source: string, names: readonly string[]): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.includes(node.text)) {
      found.push(`${line(file, node)}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * Every call to `callee` that passes one of `literals` as an argument,
 * reported as `line: callee("…")`.
 *
 * Written for a narrow question that a text search answers badly: *who builds
 * a path with this segment in it?* `join(root, subject, "personal")` is a hit
 * and `scope === "personal"` is not, and no regular expression tells those two
 * apart without also failing on a comment that mentions either.
 */
export function literalArguments(
  path: string,
  source: string,
  callee: string,
  literals: readonly string[],
): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === callee) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === callee))
    ) {
      for (const argument of node.arguments) {
        if (ts.isStringLiteral(argument) && literals.includes(argument.text)) {
          found.push(`${line(file, node)}: ${callee}(${JSON.stringify(argument.text)})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * Every call to `callee` that passes an **array literal**, reported as
 * `line: callee([…])`.
 *
 * Asked of `parseArgs`: the flag lists that `--as` also has to parse are
 * exported constants now, and an array written inline at the call site is how a
 * second copy comes back. The literal's contents do not matter — what is being
 * refused is a list with no name, because a list with no name cannot be
 * imported and so has to be retyped somewhere else.
 */
export function arrayLiteralArguments(path: string, source: string, callee: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === callee) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === callee))
    ) {
      for (const argument of node.arguments) {
        if (ts.isArrayLiteralExpression(argument)) {
          found.push(`${line(file, node)}: ${callee}([…])`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * Every **array literal** holding `literal` as a string element, reported as
 * `line: [… "literal" …]`.
 *
 * The question is *which commands take this flag?*, and it has to be asked of
 * two shapes that a search for one would miss half of: `parseArgs(argv,
 * ["yes", "json"])` written at the call site, and `export const WORN_BOOLEANS =
 * ["json"]` declared so that `--as` can parse the same flags. A grep for
 * `"json"` finds both — and also finds `shape: "json"` in the vendor registry,
 * every doc comment that mentions the flag, and the JSON the help text prints.
 * Position in the tree is what tells a flag list from prose.
 *
 * Deliberately not tied to a callee: the constant has none, and a rule that
 * only saw the call sites would make a new command's flag list invisible to the
 * guard the moment somebody factored it out — which is the exact shape of
 * change this is meant to survive.
 */
export function arrayLiteralsContaining(
  path: string,
  source: string,
  literal: string,
): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.some((element) => ts.isStringLiteral(element) && element.text === literal)
    ) {
      found.push(`${line(file, node)}: [… ${JSON.stringify(literal)} …]`);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * Every `<object>.<member>` where `member` is one of `members`, reported as
 * `line: object.member`.
 *
 * Narrower than {@link globalsUsed} on purpose, and the difference is the whole
 * value: `process` appears in `src/` for `process.pid` — a unique suffix for a
 * temp file, which is not a fact about who is running Mind — and for
 * `process.env`, which is. A checker that could not tell those apart would have
 * to allowlist eight files, and an allowlist that long stops being read.
 *
 * Computed access (`process["env"]`) is not matched here and does not need to be:
 * {@link processEscapes} already refuses it everywhere under `src/` and `bin/`.
 */
export function memberReads(
  path: string,
  source: string,
  object: string,
  members: readonly string[],
): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === object &&
      members.includes(node.name.text)
    ) {
      found.push(`${line(file, node)}: ${object}.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * Top-level statements that are **not** a re-export, reported as `line: kind`.
 *
 * `export … from "…"` and a bare `export {}` are the two that count as one, and
 * an empty result is the claim "there is nothing in this file a test could run".
 * Eight files in `scripts/check-coverage.ts`'s exemption list are excused from
 * needing a test on exactly those words — *"Checked, not assumed: every line of
 * this file is `export *`"* — and until now the checking was done by a person
 * reading it once. An exemption whose stated reason is false is worse than none.
 */
export function nonReExports(path: string, source: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      // `export … from "…"`, or `export {}` — which exports nothing and runs
      // nothing, and is how a declared-but-empty layer says so.
      const empty =
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length === 0;
      if (statement.moduleSpecifier !== undefined || empty) continue;
    }
    found.push(`${line(file, statement)}: ${statementKind(statement)}`);
  }

  return found;
}

/**
 * Top-level statements that run when this file is merely **imported**, other
 * than declarations and one `if (import.meta.main)`, reported as `line: kind`.
 *
 * The property a script needs before it can be tested at all. `bun test` runs in
 * one process, so a script whose work is top-level does that work the moment a
 * test imports it — and `scripts/check-coverage.ts` spawned `bun test`, which is
 * why the gate over every source file had no test of its own for as long as it
 * existed.
 *
 * A top-level `await` inside a declaration counts as a hit, because that is the
 * exact shape the fault had: `const dir = await mkdtemp(…)` is a declaration by
 * syntax and a side effect by behaviour. A `const` that only calls `resolve` or
 * `join` does not — module setup has to be allowed to compute a path.
 */
export function unguardedTopLevel(path: string, source: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const awaits = (node: ts.Node): boolean => {
    if (ts.isAwaitExpression(node)) return true;
    // Not into a function body: `async function f() { await x; }` runs nothing
    // until it is called, which is the whole point of putting work in one.
    if (ts.isFunctionLike(node)) return false;
    return ts.forEachChild(node, awaits) === true;
  };

  const isMainGuard = (node: ts.IfStatement): boolean =>
    node.expression.getText(file) === "import.meta.main" && node.elseStatement === undefined;

  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      if (awaits(statement)) found.push(`${line(file, statement)}: top-level await`);
      continue;
    }
    if (
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      continue;
    }
    if (ts.isIfStatement(statement) && isMainGuard(statement)) continue;
    found.push(`${line(file, statement)}: ${statementKind(statement)}`);
  }

  return found;
}

/**
 * Every `new <name>(…)` in this file, reported as `line: new name()`.
 *
 * The question it answers is *who builds one of these directly?* — asked of
 * `FallbackExec` by `test/exec/egress.test.ts`, because the chain `turn` runs
 * has to be built by `turnChain`, whose parameter type is what forces every
 * member to announce an off-machine send before it makes one. A text search
 * would also hit the four doc comments that discuss `new FallbackExec(`, which
 * is exactly the kind of false positive that gets a gate deleted.
 */
export function constructions(path: string, source: string, name: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found.push(`${line(file, node)}: new ${name}()`);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * The string `case` labels of every `switch` whose discriminant is one of
 * `discriminants`, in source order.
 *
 * The question is *which commands does this CLI actually answer to?*, and
 * `test/guard/no-push.test.ts` has been asking it of the CLI's entry file under `bin/` with
 * `/case "([^"]+)":/g` over a slice of the file's text. That works there
 * because the slice starts at `async function main(` and `main` holds exactly
 * one `switch`. It does not survive being pointed at `bin/commands/soul.ts`,
 * which has two: `switch (sub)` — the subcommands — and `switch
 * (result.outcome)`, whose labels are `already-current`, `nothing-applicable`
 * and `wrote`. A text search reports all seven and calls three of them
 * commands.
 *
 * So the discriminant is the filter, and it is a parameter rather than a
 * constant: `command` for the entry point, `sub` for a command's own
 * dispatcher. Anything else in the file is invisible, including a `switch`
 * inside a nested function, which is the shape a later refactor is most likely
 * to add.
 *
 * Non-string labels (`case SOME_CONST:`) and `default:` are skipped — a
 * command name is a string literal here and a command that was not one could
 * not be typed at a shell.
 *
 * A file holding no matching `switch` is reported as `["absent"]`, never as
 * `[]`: the two mean opposite things to a caller checking "every advertised
 * command has a case", and a rename of the discriminant would otherwise turn
 * that check vacuously true.
 */
export function caseLabels(
  path: string,
  source: string,
  discriminants: readonly string[],
): string[] {
  const file = parse(path, source);
  const found: string[] = [];
  let seen = false;

  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node) && discriminants.includes(node.expression.getText(file))) {
      seen = true;
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
          found.push(clause.expression.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return seen ? found : ["absent"];
}

/**
 * Whether a `switch` over one of `discriminants` has a `default:` that runs a command of its own rather than
 * refusing — the shape of a verb that is both a command and a dispatcher (`key <agent-dir>` beside `key prove`,
 * D-141). A default arm that calls `usageError` anywhere in it is a refusal, which is every other dispatcher's
 * default, so they keep contributing their subcommands and not themselves.
 */
export function defaultRunsCommand(path: string, source: string, discriminants: readonly string[]): boolean {
  const file = parse(path, source);
  let runs = false;
  const callsUsageError = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) && node.expression.getText(file) === "usageError") || (ts.forEachChild(node, callsUsageError) ?? false);
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node) && discriminants.includes(node.expression.getText(file))) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isDefaultClause(clause) && !clause.statements.some(callsUsageError)) runs = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return runs;
}

/** Every file reachable from `entries` by following relative imports. */
export async function reachable(entries: readonly string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = await Bun.file(path).text();
    for (const specifier of importsOf(path, source)) {
      queue.push(resolve(dirname(path), specifier));
    }
  }
  return seen;
}

/**
 * `Bun.<member>` calls the engine is allowed to make.
 *
 * Everything here reads a file, writes a file, or looks something up on PATH.
 * `spawn`, `spawnSync` and `$` are absent, and that absence is the point: they
 * appear in `src/spawn.ts` and nowhere else. `connect`, `listen`, `serve` and
 * `udpSocket` are absent for the same reason, which is why S3.5's network
 * check needs no denylist of its own for them.
 */
export const ALLOWED_BUN_MEMBERS: readonly string[] = [
  "file",
  "write",
  "which",
  "stdin",
  "main",
  "argv",
  "hash",
  "inspect",
  "version",
  "env",
  // Parsers and a hasher. They read bytes and return values; none of them can
  // reach the filesystem, a socket or another process.
  "TOML",
  "CryptoHasher",
];

/** Modules that are another way to run a program or reach past the runtime. */
export const FORBIDDEN_MODULES: readonly string[] = [
  "node:child_process",
  "child_process",
  "bun:ffi",
  "node:worker_threads",
  "node:vm",
  "node:cluster",
  "node:repl",
];

/**
 * Modules that exist to move bytes off this machine, spelled every way.
 *
 * Both with and without the `node:` prefix, because bun resolves both and a
 * checker that only knew one would be a checker with a documented bypass. The
 * bare names are also real npm package names, which is the second way in.
 */
export const NETWORK_MODULES: readonly string[] = [
  "net",
  "node:net",
  "tls",
  "node:tls",
  "http",
  "node:http",
  "https",
  "node:https",
  "http2",
  "node:http2",
  "dns",
  "node:dns",
  "dns/promises",
  "node:dns/promises",
  "dgram",
  "node:dgram",
  "inspector",
  "node:inspector",
  "inspector/promises",
  "node:inspector/promises",
  "undici",
  "ws",
  "bun:ffi",
];

/**
 * Globals that are a socket, or a handle to one.
 *
 * Matched as *identifiers*, so the same words in a comment or a string are
 * invisible — which is the whole reason this is a syntax tree and not a grep.
 * It is deliberately strict about position: `fetch` appearing anywhere in a
 * file that is supposed to have no network is worth a human looking, even if
 * that occurrence happens to be a property name.
 */
export const NETWORK_GLOBALS: readonly string[] = [
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "EventSource",
  "navigator",
  "sendBeacon",
];

const line = (file: ts.SourceFile, node: ts.Node): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

/**
 * A statement's kind, by a name that does not depend on TypeScript's aliases.
 *
 * `ts.SyntaxKind[kind]` reverse-maps a variable statement to `"FirstStatement"`,
 * because the enum gives that number two names and the reverse map keeps
 * whichever was written last. A checker whose output is that arbitrary makes its
 * own assertions read as noise.
 */
const statementKind = (node: ts.Node): string =>
  ts.isVariableStatement(node) ? "VariableStatement" : ts.SyntaxKind[node.kind];

/**
 * Every way this file could start a process or reach a member of `Bun` that is
 * not on the allowlist, reported as `line: what`.
 *
 * Reads the syntax tree, so a mention in a comment or a string is invisible to
 * it and `Bun["spawn"]`, `const b = Bun` and `globalThis["Bun"]` are not.
 */
export function processEscapes(
  path: string,
  source: string,
  allowSpawn: boolean,
  allowServe = false,
  allowFfi = false,
): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "Bun") {
      const parent = node.parent as ts.Node | undefined;
      if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const member = parent.name.text;
        const permitted =
          ALLOWED_BUN_MEMBERS.includes(member) || (allowSpawn && member === "spawn") || (allowServe && member === "serve");
        if (!permitted) found.push(`${line(file, node)}: Bun.${member}`);
      } else if (parent !== undefined && ts.isQualifiedName(parent) && parent.left === node) {
        // `Bun.Subprocess` in a type annotation. A type is erased before
        // anything runs, so it cannot be a way to reach a member at all.
      } else {
        found.push(`${line(file, node)}: the Bun global reached without naming a member`);
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const target = node.expression.getText(file);
      if (target === "Bun" || target === "globalThis" || target === "process") {
        found.push(`${line(file, node)}: computed access on ${target}`);
      }
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      FORBIDDEN_MODULES.includes(node.moduleSpecifier.text) &&
      !(allowFfi && node.moduleSpecifier.text === "bun:ffi")
    ) {
      found.push(`${line(file, node)}: imports ${node.moduleSpecifier.text}`);
    }

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && ["eval", "require"].includes(node.expression.text)) {
        found.push(`${line(file, node)}: calls ${node.expression.text}()`);
      }
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        !ts.isStringLiteral(node.arguments[0])
      ) {
        found.push(`${line(file, node)}: import() with a computed specifier`);
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      found.push(`${line(file, node)}: new Function()`);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * Every type assertion to one of `types`, and every call to one of `calls`,
 * reported as `line: what`.
 *
 * S3.5 AC4 rests on `Personal<T>` being a box the type system will not open by
 * itself: the value inside reaches a backend only through `runPersonal`. `tsc`
 * enforces that — and `x as LocalBackend` turns it off in one keystroke, with
 * no diagnostic and nothing in review to catch the eye. So the words that
 * would turn it off are refused outside the files that are allowed to say
 * them, and the list of those files is short enough to read.
 *
 * Both assertion syntaxes count: `x as T` and the older `<T>x`. A generic is
 * matched on its head, so `as Personal<string>` is a hit for `"Personal"` —
 * the type argument is not what makes the assertion unsafe.
 */
export function assertionEscapes(
  path: string,
  source: string,
  types: readonly string[],
  calls: readonly string[],
): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  /** The head of a type reference: `Personal<string>` → `Personal`. */
  const head = (node: ts.TypeNode): string | undefined => {
    if (!ts.isTypeReferenceNode(node)) return undefined;
    return ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const name = head(node.type);
      if (name !== undefined && types.includes(name)) {
        found.push(`${line(file, node)}: asserts ${name}`);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      calls.includes(node.expression.text)
    ) {
      found.push(`${line(file, node)}: calls ${node.expression.text}()`);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * The parameters of one named function whose type is a **function type**,
 * reported as `line: name`.
 *
 * `countPersonal` (`src/types.ts`) is the second way a value leaves a
 * `Personal<T>`, and it is safe for one reason: it takes no callback. A
 * combinator that took one would be a hole with a guard on it — the function
 * decides what comes back, and the closure it is written inside can copy the
 * boxed value to an outer variable without ever saying `unwrapPersonal`. That
 * property is worth a check rather than a comment, because it is exactly the
 * kind of thing a later refactor adds "just for this one caller".
 *
 * A missing function is reported as `absent`, so a rename cannot make this
 * vacuously true.
 */
export function functionTypeParameters(
  path: string,
  source: string,
  name: string,
): string[] {
  const file = parse(path, source);
  const found: string[] = [];
  let seen = false;

  const isFunctionish = (node: ts.TypeNode | undefined): boolean => {
    if (node === undefined) return false;
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) return true;
    // `Function`, and a union or intersection with one in it.
    if (ts.isTypeReferenceNode(node)) {
      const head = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
      return head === "Function";
    }
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      return node.types.some(isFunctionish);
    }
    if (ts.isParenthesizedTypeNode(node)) return isFunctionish(node.type);
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      seen = true;
      for (const parameter of node.parameters) {
        if (isFunctionish(parameter.type)) {
          found.push(`${line(file, parameter)}: ${parameter.name.getText(file)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return seen ? found : ["absent"];
}

/**
 * Every **argument-less** call to one of `console`'s `methods`, reported as
 * `line: console.<method>()`.
 *
 * Written for one measured fact and no more: under bun 1.4.2 a `console` method
 * called with no arguments writes its lone newline to **stdout**, whichever
 * stream the method is documented to use. `console.error()` as a spacer
 * therefore puts a blank line in the output somebody is piping and nothing at
 * all in front of the message it was meant to separate.
 *
 * Read from the tree, so `console.error()` inside a comment or a string — of
 * which this repository has several, all of them explaining this rule — counts
 * for nothing. `methods` is a parameter rather than a constant here because the
 * ban belongs beside the measurement that justifies it:
 * `test/cli/streams.test.ts` measures every method and passes in only the ones
 * it just watched go to the wrong stream.
 *
 * ## What it cannot see
 *
 * Matched on the shape `console.<name>()` and nothing else, so each of these is
 * a hole, and all of them are stated rather than implied:
 *
 * - an alias — `const say = console.error; say()`;
 * - computed access — `console["error"]()`;
 * - `console.error.call(console)` and `.apply`;
 * - a method passed as a value — `lines.forEach(console.error)`;
 * - a `console` that is a local binding rather than the global;
 * - a wrapper that forwards no arguments — `const blank = () => console.error("");`
 *   is fine, but a helper written to call `console.error()` is invisible at
 *   every call site of the helper.
 *
 * The one it is aimed at — somebody typing `console.error()` where a blank line
 * is wanted — is also the only one anybody has typed here.
 */
export function bareConsoleCalls(
  path: string,
  source: string,
  methods: readonly string[],
): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console" &&
      methods.includes(node.expression.name.text)
    ) {
      found.push(`${line(file, node)}: console.${node.expression.name.text}()`);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}

/**
 * Every way this file could open a socket, reported as `line: what`.
 *
 * The companion to {@link processEscapes} and deliberately not merged with it:
 * one answers "can this start a process?", the other "can this reach a
 * network?", and S3.5 AC2 needs both answers to be no while S0.4 AC2 needs
 * only the first. A type-only import is still a hit — importing a type from
 * `node:net` is erased at run time, but it is also a sentence about what this
 * file is for, and the observer has no business writing it.
 */
export function networkEscapes(path: string, source: string): string[] {
  const file = parse(path, source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NETWORK_GLOBALS.includes(node.text)) {
      found.push(`${line(file, node)}: ${node.text}`);
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      NETWORK_MODULES.includes(node.moduleSpecifier.text)
    ) {
      found.push(`${line(file, node)}: imports ${node.moduleSpecifier.text}`);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      NETWORK_MODULES.includes(node.arguments[0].text)
    ) {
      found.push(`${line(file, node)}: import("${node.arguments[0].text}")`);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return found;
}
