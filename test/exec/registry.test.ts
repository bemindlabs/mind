/**
 * The registry — the file whose whole value is that its contents are true.
 *
 * `registry.ts` is data, and the usual answer to "how do you test data?" is
 * that you do not. That answer is wrong here for two reasons the file's own
 * header states: these values were read off each CLI's `--help` and they move
 * between vendor releases, and the failures a wrong value causes are *silent* —
 * a missing grant makes grok cancel its first tool call and exit 0 with the
 * sentence it said before it, a missing `--tools ""` lets a probe answer by
 * reading a file instead of from its context. Neither shows up as an error
 * anywhere.
 *
 * So what is pinned here is not "the data is correct" — only a person with the
 * CLI installed can say that — but the invariants that hold across every
 * vendor, plus the handful of individual flags whose absence is known to cost
 * someone a debugging session. A vendor bump that drops one of them now has to
 * delete a line that says why it is there.
 *
 * `expandPath` and `isProjectScopedOnly` are already covered by
 * `test/soul/targets.test.ts` and are deliberately not repeated.
 *
 * ## The failure this file taught, which is not about this file
 *
 * An exact pin over a value that encodes a policy freezes the policy, holes
 * included. `expect(argv(vendor("kimi"))).toEqual(["-p", PROMPT,
 * "--output-format", "text"])` was here for months. It was true, it was
 * precise, it ran on every commit — and what it pinned was that kimi's turns
 * have no tool filter at all. An exact-argv assertion says *these flags and no
 * others*, so the day somebody added a limit, the suite would have gone red
 * and called the fix a regression. It looked like coverage and it was a lock
 * on a hole.
 *
 * The general form: **a test that pins a constant cannot tell "this is
 * deliberate" from "this is all we managed"**, and the second reading is
 * invisible precisely because the test is green. So where a value carries a
 * decision, pin the *declaration* of the decision and let the argv follow it —
 * here, `VendorSpec.readOnly` is the declaration, `readOnlyArgs` builds the
 * argv from it, and the assertions below check both directions against it.
 * Where an exact pin is still the right tool — claude's `--tools ""`, grok's
 * tool list — the line above it says what it would cost to change, so that
 * changing it is an argument rather than an accident.
 */

import { describe, expect, test } from "bun:test";
import {
  PHASE_A_BACKENDS,
  readonlyLimits,
  CLAUDE_GRANT,
  CODEX_GRANT,
  GROK_GRANT,
  claudeIsolation,
  grantArgs,
  modelProblem,
  readOnlyArgs,
  readOnlySummary,
  VENDORS,
  vendor,
  type ReadOnlySpec,
  type VendorSpec,
} from "../../src/exec/registry.ts";
import type { Restraint } from "../../src/exec/restraint.ts";
import { atLevel, LOOSENED, RESTRAINED } from "../support/restraint.ts";

/** Argv for a vendor, for a prompt nothing would produce by accident. */
const PROMPT = "line one\nline two — with \"quotes\", a --flag and a 'tick'";

/**
 * @param restraint Which dial level to build the argv under. Defaults to the
 *   restrained one, because that is what every case here was written against:
 *   `readOnlyArgs` used to be spliced in unconditionally, and level 1 is the
 *   level at which it still is.
 */
function argv(spec: VendorSpec, model?: string, restraint: Restraint = RESTRAINED): string[] {
  return spec.headlessArgv(
    model === undefined ? { prompt: PROMPT, restraint } : { prompt: PROMPT, model, restraint },
  );
}

describe("vendor lookup", () => {
  test("an unknown id throws, and names what is known", async () => {
    // Throwing is right here — a typo in a backend id is a programmer error,
    // not a backend that happens to be missing — but an error that only says
    // "unknown" leaves the caller guessing at the spelling.
    expect(() => vendor("nonesuch")).toThrow('unknown vendor "nonesuch"');
    for (const spec of VENDORS) expect(() => vendor("nonesuch")).toThrow(spec.id);
    await Promise.resolve();
  });

  test("every id resolves to itself, and no id is claimed twice", () => {
    const ids = VENDORS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(vendor(id).id).toBe(id);
  });
});

describe("D-021 — the registry names nobody", () => {
  test("no binary is a path, and no instruction file is an absolute one", () => {
    for (const spec of VENDORS) {
      // A binary with a slash in it would be this machine's install, shipped
      // to everyone else's.
      expect(spec.binary).not.toContain("/");
      expect(spec.binary.length).toBeGreaterThan(0);

      for (const file of spec.identity.instructionFiles) {
        // Exactly three permitted shapes: `~/` for the home, `./` for the
        // working directory, `${VAR:-…}` for a vendor that relocates its own.
        expect(file).toMatch(/^(~\/|\.\/|\$\{[A-Z_][A-Z0-9_]*:-)/);
        expect(file).not.toStartWith("/");
      }
    }
  });

  test("nothing in the whole registry looks like somebody's home", async () => {
    // Cheaper and broader than the per-field checks above: the file itself is
    // read, so a path added in a comment or a trap is caught too.
    const source = await Bun.file(
      new URL("../../src/exec/registry.ts", import.meta.url).pathname,
    ).text();
    expect(source).not.toMatch(/\/home\/[a-z]/i);
    expect(source).not.toMatch(/\/Users\/[a-z]/i);
  });
});

describe("what every vendor's argv must do", () => {
  test("the prompt appears once, whole, as a single argument", () => {
    for (const spec of VENDORS) {
      const args = argv(spec);
      const occurrences = args.filter((arg) => arg === PROMPT);
      // Once: a prompt sent twice is a prompt a model may answer twice.
      // Whole: a prompt split across arguments is the truncation bug that
      // grok's own trap list already records, arriving by another road.
      expect(occurrences.length).toBe(1);
      expect(args.some((arg) => arg !== PROMPT && arg.includes(PROMPT.slice(0, 20)))).toBe(false);
    }
  });

  test("a model flag appears when a model is named, and never when one is not", () => {
    for (const spec of VENDORS) {
      const withModel = argv(spec, "some-model");
      const without = argv(spec);
      expect(withModel).toContain("some-model");
      expect(without).not.toContain("some-model");
      // The flag and its value, adjacent and in that order — and the flag is the one the spec declares (D-142).
      const at = withModel.indexOf("some-model");
      expect(withModel[at - 1]).toMatch(/^(-m|--model)$/);
      expect(withModel[at - 1]).toBe(spec.model?.flag);
      // Naming a model adds exactly the flag and the value, nothing else.
      expect(withModel.length).toBe(without.length + 2);
    }
  });

  test("no vendor's argv carries a system prompt — that is the caller's job", () => {
    // `CliExec` appends `appendPromptFlag` itself, and only when a soul was
    // offered. A spec that baked one in would send it on every turn.
    for (const spec of VENDORS) {
      const flags = [spec.identity.appendPromptFlag, spec.identity.replacePromptFlag];
      for (const flag of flags) {
        if (flag !== undefined) expect(argv(spec, "m")).not.toContain(flag);
      }
    }
  });

  test("`replacePromptFlag` is recorded and never used", async () => {
    // Replacing a vendor's own system prompt removes its tool instructions,
    // and the result is a CLI that runs, exits 0, and quietly cannot use its
    // own tools. Recorded so nobody rediscovers it; unused so nobody ships it.
    const withReplace = VENDORS.filter((spec) => spec.identity.replacePromptFlag !== undefined);
    expect(withReplace.length).toBeGreaterThan(0);

    for (const dir of ["cli-exec.ts", "index.ts", "fallback.ts"]) {
      const source = await Bun.file(
        new URL(`../../src/exec/${dir}`, import.meta.url).pathname,
      ).text();
      expect(source).not.toContain("replacePromptFlag");
    }
  });

  test("an append flag exists exactly where the strength claims one does", () => {
    for (const spec of VENDORS) {
      if (spec.identity.appendPromptFlag !== undefined) {
        // A flag delivers a real system prompt. Claiming `user` while holding
        // one would under-report; claiming `system` without one would be the
        // dangerous direction — a soul reported as delivered at full strength
        // when it only ever reached a file.
        expect(spec.identity.strength).toBe("system");
      } else {
        expect(spec.identity.strength).toBe("user");
      }
    }
  });

  test("every spec says what it was measured against", () => {
    for (const spec of VENDORS) {
      expect(spec.measuredAgainst).toMatch(/^\d+\.\d+\.\d+$/);
      expect(spec.display.length).toBeGreaterThan(0);
    }
  });
});

describe("the individual flags that cost someone a debugging session", () => {
  test("claude asks for JSON and for no tools at all", () => {
    const args = argv(vendor("claude"));
    // `--strict-mcp-config` on every turn: no MCP server, so no way out the
    // dial does not govern (D-047). No `--setting-sources` here — this turn
    // carries no system field, so Mind is not the one holding the identity.
    expect(args).toEqual(["-p", PROMPT, "--output-format", "json", "--tools", "", "--strict-mcp-config"]);
    // `--tools ""` removes every built-in tool. Without it a probe can answer
    // "what are your standing instructions?" by *reading the file* rather than
    // from its context — and `soul verify` would report an identity that
    // reached the model when it had not.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(vendor("claude").replyPointers).toEqual(["/result"]);
  });

  test("codex runs read-only and skips the git check", () => {
    const args = argv(vendor("codex"));
    expect(args.slice(0, 4)).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only"]);
    // Trailing positional, not `-p`: this one takes the prompt last.
    expect(args.at(-1)).toBe(PROMPT);
    // `codex exec` writes progress to stderr and the final message to stdout,
    // so stdout is the reply and there is nothing to point at.
    expect(vendor("codex").replyPointers).toEqual([]);
  });

  test("grok's turn cap is a backstop with room, not the old cap of 2", () => {
    // Measured 2026-09-26 on 1.0.40 (S12.6): a fix-and-test task took 4 to 6
    // model calls over 25 runs, and a cap hit exits 1 with no reply. A cap of
    // 2 could never finish it (0/5). The half-answer the cap was once blamed
    // for was an approval cancel — the grant below is what fixed that.
    const args = argv(vendor("grok"));
    const at = args.indexOf("--max-turns");
    expect(at).toBeGreaterThan(-1);
    expect(Number(args[at + 1])).toBeGreaterThanOrEqual(6);
    // Two shapes are tried because this vendor prints its reply under either.
    expect(vendor("grok").replyPointers).toEqual(["/text", "/result"]);
  });

  test("grok is granted at 2 and 3 with the one flag that never cancels a turn silently", () => {
    // D-119. `--allow Bash --allow Edit --allow Write` still left `rm` and any
    // `$?` command to a prompt nobody answers, and a headless prompt is a
    // cancel that ends the turn with exit 0 (3 of 11 multi-step runs).
    expect(vendor("grok").grant).toBe(GROK_GRANT);
    expect(grantArgs(GROK_GRANT, RESTRAINED)).toEqual([]);
    expect(grantArgs(GROK_GRANT, LOOSENED)).toEqual(["--always-approve"]);
    expect(grantArgs(GROK_GRANT, atLevel(3))).toEqual(["--always-approve"]);
    expect(argv(vendor("grok"))).not.toContain("--always-approve");
  });

  test("grok says how a turn ended, and a turn that did not finish is not an answer", () => {
    expect(vendor("grok").completion).toEqual({ pointer: "/stopReason", value: "end_turn" });
  });

  test("copilot denies the two tools that would let a read-only turn write", () => {
    const args = argv(vendor("copilot"));
    // `--allow-all-tools` is required for non-interactive mode; denials take
    // precedence over it, so these two are what actually keep the run safe.
    expect(args).toContain("--allow-all-tools");
    const denied = args.filter((_, index) => args[index - 1] === "--deny-tool");
    expect(denied.sort()).toEqual(["shell", "write"]);
  });

  test("kimi's read-only turn is held by a profile file, and the argv follows the declaration", () => {
    // This assertion was once `toEqual(["-p", PROMPT, "--output-format",
    // "text"])`, and it passed for months. It was also the strongest thing in
    // this repository keeping a security hole in place: an exact-argv pin says
    // *these flags and no others*, so the test that looked like coverage would
    // have failed the day somebody added a limit. A pinned constant cannot tell
    // "this is deliberate" from "this is all we managed".
    //
    // S12.6 is that day (D-120), and the rewrite shows the lesson held: what is
    // pinned is the *declaration* — the kind, the path, the tools the file
    // names — and the argv is checked against it, not against a literal list.
    const spec = vendor("kimi");
    const mechanism = spec.readOnly;
    expect(mechanism.kind).toBe("agent-file");
    if (mechanism.kind !== "agent-file") return;
    expect(argv(spec)).toEqual(["-p", PROMPT, "--output-format", "text", ...readOnlyArgs(mechanism)]);
    expect(readOnlyArgs(mechanism)).toEqual([mechanism.flag, mechanism.values[0]]);
    expect(argv(spec, undefined, LOOSENED)).toEqual(["-p", PROMPT, "--output-format", "text"]);
  });

  test("kimi's profile names exactly three read-only tools, and lives where no repository can shadow it", () => {
    const mechanism = vendor("kimi").readOnly;
    if (mechanism.kind !== "agent-file") throw new Error("kimi is no longer held by a profile file");
    const [, front = "", body = ""] = mechanism.content.split(/^---$/m);
    // The allow list is the front matter's `tools:`; nothing else in the file
    // may name a tool the turn gets.
    const tools = [...front.matchAll(/^\s+-\s+(\S+)$/gm)].map((m) => m[1]);
    expect(tools).toEqual(["Read", "Glob", "Grep"]);
    for (const tool of tools) expect(tool).not.toMatch(/bash|shell|write|edit|fetch|web|agent|cron/i);
    // Without it the vendor's own prompt — and every AGENTS.md, the identity
    // channel — is gone from the turn.
    expect(body).toContain("${base_prompt}");
    // `~/`-relative, so the argv is the same on every install and the vendor
    // expands it against the child's HOME; never relative to a repository, and
    // never under a directory the vendor searches for profiles, where a
    // repository profile of the same name would outrank it.
    expect(mechanism.values[0]).toStartWith("~/");
    expect(mechanism.values[0]).not.toMatch(/\.kimi-code\/agents|\.agents\/agents/);
    expect(mechanism.values[0]).toEndWith(".md");
  });

  test("every trap recorded is a sentence, not a shrug", () => {
    // Traps are read by humans in `mind backends`; an empty string or a
    // three-word note is worse than nothing there.
    for (const spec of VENDORS) {
      for (const trap of spec.traps) expect(trap.length).toBeGreaterThan(40);
    }
  });
});

/**
 * Every flag across these six CLIs that decides what a turn may do.
 *
 * Collected from the six `--help` outputs, including the spellings only one
 * vendor uses and the compat aliases two of them accept. The list exists for
 * one assertion — *no vendor's argv carries a permission flag it has not
 * declared* — and that assertion is the control that bites: the forward check
 * (the declared mechanism is in the argv) is true by construction now that
 * `headlessArgv` splices `readOnlyArgs` in, so on its own it would prove only
 * that the splice happened.
 */
/**
 * A vendor with nothing to pass, and an argv of its own. Synthetic since S12.6
 * left no real vendor declaring `none` (D-120): the `none` arm still has to be
 * held to what it says, for the next vendor that declares it.
 */
const HOLE: VendorSpec = {
  ...vendor("kimi"),
  id: "example",
  readOnly: {
    kind: "none",
    why:
      "a synthetic vendor with no tool filter and no sandbox: a headless turn told to write a file " +
      "would write it, and nothing in this repository could narrow it",
    evidence: "writes",
  },
  // kimi carries no grant and no hardening, so neither needs taking away.
  headlessArgv: ({ prompt, model }) => ["-p", prompt, ...(model ? ["-m", model] : [])],
};

/** The argv with the vendor's hardening slice taken out once, where it sits. */
function withoutHardening(spec: VendorSpec, args: readonly string[]): string[] {
  const slice = spec.hardening?.args ?? [];
  if (slice.length === 0) return [...args];
  for (let at = 0; at + slice.length <= args.length; at += 1) {
    if (slice.every((token, i) => args[at + i] === token)) return [...args.slice(0, at), ...args.slice(at + slice.length)];
  }
  return [...args];
}

const GOVERNING_FLAGS: readonly string[] = [
  "--tools",
  "--agent",
  "--agent-file",
  "-c",
  "--config",
  "--disable",
  "--enable",
  "--allow",
  "--deny",
  "--allowedTools",
  "--disallowedTools",
  "--allowed-tools",
  "--disallowed-tools",
  "--allow-tool",
  "--deny-tool",
  "--allow-all-tools",
  "--always-approve",
  "--permission-mode",
  "--approval-mode",
  "--ask-for-approval",
  "--sandbox",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--yolo",
  "-y",
  "--auto",
  "--plan",
  "--no-plan",
];

describe("what stops a turn from writing, per vendor", () => {
  test("every vendor declares a mechanism, and the declaration is in the argv", () => {
    for (const spec of VENDORS) {
      const args = argv(spec);
      const expected = readOnlyArgs(spec.readOnly);
      if (expected.length === 0) {
        expect(spec.readOnly.kind).toBe("none");
        continue;
      }
      // Contiguous and in order, not merely present: `--deny-tool shell` and
      // `--deny-tool write` separated by something else is a different command
      // from the one that was measured.
      const joined = args.join("\u0000");
      expect(joined).toContain(expected.join("\u0000"));
    }
  });

  test("at level 2 the read-only flags are gone — the dial's only new power", () => {
    // The direction of S5.1, asserted rather than described. Before E5 every
    // `headlessArgv` spliced `readOnlyArgs` in unconditionally, so level 1 is
    // not a new restraint — it is the old behaviour, and the *loosened*
    // restraint is the thing that did not exist. If this test ever goes green
    // by the argvs being equal at both levels, the dial has stopped doing the
    // one thing it does.
    let vendorsThatDiffer = 0;
    for (const spec of VENDORS) {
      const restrained = argv(spec, undefined, RESTRAINED);
      const loosened = argv(spec, undefined, LOOSENED);
      const dropped = readOnlyArgs(spec.readOnly);

      // What was dropped is gone, and what the vendor is *granted* at 2
      // (D-047) is added — nothing else moves. A grant may reuse the same flag
      // with another value (codex: `--sandbox workspace-write`), so a dropped
      // token only has to be absent where the grant did not bring it back.
      const granted = grantArgs(spec.grant, LOOSENED);
      for (const flag of dropped) if (!granted.includes(flag)) expect(loosened).not.toContain(flag);
      expect(loosened.filter((part) => !granted.includes(part))).toEqual(
        restrained.filter((part) => !dropped.includes(part)),
      );
      for (const flag of granted) expect(loosened).toContain(flag);
      if (dropped.length > 0) vendorsThatDiffer += 1;
    }
    // Guards the assertion's own scope: a registry where every vendor declared
    // `none` would satisfy every line above and prove nothing.
    expect(vendorsThatDiffer).toBe(VENDORS.filter((s) => s.readOnly.kind !== "none").length);
    expect(vendorsThatDiffer).toBeGreaterThan(3);
  });

  test("no argv carries a permission flag the vendor has not declared", () => {
    // The direction that catches the real failure. A flag added to a
    // `headlessArgv` by hand — a `--permission-mode`, a `--yolo` someone put
    // there to get a run working — changes what the turn may do while the
    // registry, `mind backends` and `readonlyLimits()` all keep describing
    // the old command.
    for (const spec of VENDORS) {
      const mechanism = spec.readOnly;
      const declared = new Set(
        mechanism.kind === "none"
          ? []
          : [mechanism.flag, ...(mechanism.despite === undefined ? [] : [mechanism.despite.flag])],
      );
      // The hardening slice is declared whole, so it is taken out whole: a flag
      // it happens to share — codex's `-c` — must not excuse a second `-c`
      // anywhere else in the argv, which could carry any config key at all.
      const undeclared = withoutHardening(spec, argv(spec, "m")).filter(
        (token) => GOVERNING_FLAGS.includes(token) && !declared.has(token),
      );
      expect({ id: spec.id, undeclared }).toEqual({ id: spec.id, undeclared: [] });
    }
  });

  test("a vendor with no mechanism carries no permission flag at all", () => {
    // The `none` arm's own control. Without this, "we have no mechanism" and
    // "we pass a flag and call it nothing" are the same green test. On the
    // synthetic vendor as well as the real ones, because since S12.6 the real
    // loop has nobody to check.
    for (const spec of [...VENDORS, HOLE]) {
      if (spec.readOnly.kind !== "none") continue;
      expect(argv(spec, "m").filter((t) => GOVERNING_FLAGS.includes(t))).toEqual([]);
      expect(spec.readOnly.evidence).toBe("writes");
      // Long enough to say what was looked for and what it costs: this string
      // is printed to a human as the reason a vendor is unguarded.
      expect(spec.readOnly.why.length).toBeGreaterThan(120);
      expect(readOnlySummary(spec)).toBe("yes — no limit");
    }
  });

  test("grok's allow list is pinned by its contents, not by the flag being present", () => {
    // The previous version of this file asserted `args).toContain(
    // "--disallowed-tools")` and nothing about what followed it. What followed
    // it was `run_terminal_cmd` and `task` — names this vendor had renamed to
    // `run_terminal_command` and `spawn_subagent`. The flag was there, the
    // test was green, and a probe on 2026-09-21 asked the CLI to write a file
    // and it wrote one. A tool list is the contents; the flag is packaging.
    const mechanism = vendor("grok").readOnly;
    expect(mechanism.kind).toBe("allow-tools");
    if (mechanism.kind === "none") return;
    expect(mechanism.flag).toBe("--tools");
    expect(mechanism.values).toEqual(["read_file,grep,list_dir"]);
    for (const tool of mechanism.values.join(",").split(",")) {
      // Read-only by name is not a proof, but a tool called `write_file`
      // arriving in this list should stop somebody.
      expect(tool).not.toMatch(/write|edit|replace|terminal|exec|shell|patch|subagent/);
    }
  });

  test("claude's mechanism is the empty allow list, and codex's is the vendor's own sandbox", () => {
    const claude = vendor("claude").readOnly;
    expect(claude.kind).toBe("allow-tools");
    if (claude.kind !== "none") expect(claude.values).toEqual([""]);

    const codex = vendor("codex").readOnly;
    expect(codex.kind).toBe("sandbox");
    if (codex.kind !== "none") expect(codex.values).toEqual(["read-only"]);
  });

  test("the one-column answer keeps the three states apart", () => {
    // `no (measured)` and `no (on trust)` are not decoration. Printing both as
    // `no` would let one reading of a vendor's `--help` look identical to a
    // turn that was actually watched, which is the whole distinction this
    // story exists to make.
    const all = [...VENDORS, HOLE];
    const summaries = new Map(all.map((spec) => [spec.id, readOnlySummary(spec)]));
    for (const spec of all) {
      const summary = summaries.get(spec.id)!;
      if (spec.readOnly.kind === "none") expect(summary).toStartWith("yes");
      else if (spec.readOnly.evidence === "probed") expect(summary).toBe("no (measured)");
      else expect(summary).toBe("no (on trust)");
    }
    // Every vendor that is unguarded says so in the word a hurried reader
    // takes in first, not in a parenthesis at the end.
    expect([...summaries.values()].filter((s) => s.startsWith("yes")).length).toBe(
      all.filter((spec) => spec.readOnly.kind === "none").length,
    );
    expect(summaries.get("example")).toBe("yes — no limit");
  });

  test("a loosening flag exists only where it is declared with a reason", () => {
    for (const spec of VENDORS) {
      const mechanism = spec.readOnly;
      const despite = mechanism.kind === "none" ? undefined : mechanism.despite;
      if (despite === undefined) continue;
      expect(argv(spec)).toContain(despite.flag);
      expect(despite.why.length).toBeGreaterThan(40);
    }
  });
});

describe("readonlyLimits()", () => {
  /** A vendor whose only interesting property is its mechanism. */
  function fake(id: string, readOnly: ReadOnlySpec): VendorSpec {
    return {
      ...vendor("kimi"),
      id,
      readOnly,
    };
  }

  const HOLE: ReadOnlySpec = {
    kind: "none",
    why: "a synthetic vendor with nothing to pass, used to check that this text is derived",
    evidence: "writes",
  };

  test("the real registry's holes are named, with the reason, in the printed text", () => {
    const printed = readonlyLimits().join("\n");
    for (const spec of VENDORS) {
      if (spec.readOnly.kind !== "none") continue;
      expect(printed).toContain(spec.id);
      expect(printed).toContain(spec.readOnly.why);
    }
    // Nothing here promises more than the flags do.
    expect(printed).not.toMatch(/cannot write|impossible|guaranteed/i);
  });

  test("close the hole and the sentence goes with it", () => {
    // The point of deriving this text rather than writing it. A second list —
    // prose in a document, a constant beside the registry — is right on the
    // day it is written and silently wrong afterwards, and the failure is
    // invisible because prose does not fail a test.
    const open = readonlyLimits([fake("example", HOLE)]).join("\n");
    expect(open).toContain(HOLE.why);

    const closed = readonlyLimits([
      fake("example", { kind: "sandbox", flag: "--sandbox", values: ["read-only"], evidence: "probed" }),
    ]).join("\n");
    expect(closed).not.toContain(HOLE.why);
    expect(closed).not.toContain("no read-only mechanism exists");
  });

  test("a vendor believed on its own documentation is named as believed", () => {
    const believed = readonlyLimits([
      fake("example", {
        kind: "approval-mode",
        flag: "--approval-mode",
        values: ["plan"],
        evidence: "documented",
      }),
    ]).join("\n");
    expect(believed).toContain("Believed rather than measured");
    expect(believed).toContain("readonly.real.test.ts");

    const probed = readonlyLimits([
      fake("example", { kind: "sandbox", flag: "--sandbox", values: ["ro"], evidence: "probed" }),
    ]).join("\n");
    expect(probed).not.toContain("Believed rather than measured");
  });

  test("two limits hold on every registry: the scope, and the channels no flag reaches", () => {
    const always = readonlyLimits([
      fake("example", { kind: "sandbox", flag: "--sandbox", values: ["ro"], evidence: "probed" }),
    ]).join("\n");
    // A CLI the owner starts is not covered, and the settings a CLI reads
    // before Mind's argv arrives are not covered. Both survive a registry
    // with no holes at all, because neither is about a vendor.
    expect(always).toContain("turns Mind itself starts");
    expect(always).toContain("MCP servers and session-start hooks");
  });
});

describe("where each vendor says it prints what a turn used", () => {
  test("every pointer is a pointer, and every JSON spec names at least one input field", () => {
    for (const spec of VENDORS) {
      const usage = spec.usage;
      if (usage === null || usage.shape !== "json") continue;
      // A pointer without a leading slash resolves against nothing and would
      // make every turn on this vendor read as `missing` — quietly, forever.
      for (const pointer of [...usage.input, usage.output, ...(usage.total ? [usage.total] : [])]) {
        expect(pointer).toStartWith("/");
        expect(pointer.length).toBeGreaterThan(1);
      }
      // An empty input list would sum to 0 and report it as a real count.
      expect(usage.input.length).toBeGreaterThan(0);
      expect(new Set(usage.input).size).toBe(usage.input.length);
    }
  });

  test("a text spec names a label with something in it", () => {
    for (const spec of VENDORS) {
      if (spec.usage === null || spec.usage.shape !== "text") continue;
      expect(spec.usage.totalAfterLine.trim().length).toBeGreaterThan(0);
    }
  });

  test("claude sums all three input fields, because one of them alone is a lie", () => {
    // Measured 2026-09-21 against 2.1.278: a turn of roughly 81,000 tokens
    // reported `input_tokens: 2`, with 80,951 under cache creation. A spec
    // that pointed at the first field alone would under-report by four orders
    // of magnitude and look like an unusually cheap turn.
    const usage = vendor("claude").usage;
    expect(usage?.shape).toBe("json");
    if (usage?.shape !== "json") return;
    expect([...usage.input].sort()).toEqual([
      "/usage/cache_creation_input_tokens",
      "/usage/cache_read_input_tokens",
      "/usage/input_tokens",
    ]);
    expect(usage.output).toBe("/usage/output_tokens");
    expect(usage.stream).toBe("stdout");
  });

  test("a cache count is a part of the input, and the split of a write is both parts of it or neither (S15.9, D-143)", () => {
    for (const spec of VENDORS) {
      const usage = spec.usage;
      if (usage === null || usage.shape !== "json") continue;
      for (const pointer of [usage.cacheRead, usage.cacheWrite]) if (pointer !== undefined) expect(usage.input, spec.id).toContain(pointer);
      // Both or neither, and only beside the write they split — a half split cannot say what the other half was.
      expect(usage.cacheWrite5m === undefined, spec.id).toBe(usage.cacheWrite1h === undefined);
      if (usage.cacheWrite5m !== undefined) {
        expect(usage.cacheWrite, spec.id).toBeDefined();
        expect(usage.cacheWrite5m).not.toBe(usage.cacheWrite1h);
        for (const pointer of [usage.cacheWrite5m, usage.cacheWrite1h!]) expect(pointer).toStartWith("/");
      }
    }
    // Measured on 2.1.283 (D-142's turn and D-143's): claude says which cache it wrote. grok prints no split.
    const claude = vendor("claude").usage;
    expect(claude?.shape === "json" && [claude.cacheWrite5m, claude.cacheWrite1h]).toEqual([
      "/usage/cache_creation/ephemeral_5m_input_tokens",
      "/usage/cache_creation/ephemeral_1h_input_tokens",
    ]);
    const grok = vendor("grok").usage;
    expect(grok?.shape === "json" && [grok.cacheWrite5m, grok.cacheWrite1h]).toEqual([undefined, undefined]);
  });

  test("nothing in the registry reads a vendor's price", async () => {
    // The same response that carries claude's token counts carries
    // `total_cost_usd`, and it quoted $0.81 for a two-character answer —
    // almost all of it the list price of a cache write a subscription holder
    // is not billed for. It is not read, and it is not kept under another
    // name: a half-measure would become somebody's `cost` column later.
    const source = await Bun.file(
      new URL("../../src/exec/registry.ts", import.meta.url).pathname,
    ).text();
    expect(source).not.toContain("/total_cost_usd");
    expect(source).not.toContain("vendor_quoted_usd");
    for (const spec of VENDORS) expect(JSON.stringify(spec.usage)).not.toMatch(/usd|price|cost/i);
  });

  test("codex reads stderr, because that is where it prints and not where it answers", () => {
    const usage = vendor("codex").usage;
    expect(usage?.shape).toBe("text");
    expect(usage?.stream).toBe("stderr");
  });

  test("an unsurveyed vendor says `null` rather than claiming to report nothing", () => {
    // `null` here becomes `unreported` downstream — a statement about Mind's
    // survey. Guessing a pointer from another vendor's spelling would produce
    // `missing` on every turn instead, which reads as a vendor that broke.
    for (const id of ["gemini", "copilot", "kimi"]) {
      expect(vendor(id).usage).toBeNull();
    }
  });

  test("grok sums all three input fields too, and names its own total", () => {
    // Surveyed 2026-09-26 against 1.0.40 (S12.6), 76 turns: present on every
    // one, cancelled and exit-1 turns included, and the vendor's own total
    // equalled the three input fields plus output on all 76.
    const usage = vendor("grok").usage;
    expect(usage?.shape).toBe("json");
    if (usage?.shape !== "json") return;
    expect([...usage.input].sort()).toEqual([
      "/usage/cache_creation_input_tokens",
      "/usage/cache_read_input_tokens",
      "/usage/input_tokens",
    ]);
    expect(usage.output).toBe("/usage/output_tokens");
    expect(usage.total).toBe("/usage/total_tokens");
  });
});

describe("PHASE_A_BACKENDS", () => {
  test("the local backend is in the list, not beside it", () => {
    // I-1 in one assertion: a default chain of commercial CLIs alone would
    // make "take them off PATH and the work still finishes" unpassable by
    // construction.
    expect(PHASE_A_BACKENDS).toContain("ollama");
    expect(PHASE_A_BACKENDS.at(-1)).toBe("ollama");
  });

  test("every other member is a vendor that resolves", () => {
    for (const id of PHASE_A_BACKENDS) {
      if (id === "ollama") continue;
      expect(vendor(id).id).toBe(id);
    }
    expect(new Set(PHASE_A_BACKENDS).size).toBe(PHASE_A_BACKENDS.length);
  });
});

/** Flags that widen what a turn may do. None of them may hide in a hardening list. */
const LOOSENING: readonly string[] = [
  "--always-approve",
  "--yolo",
  "-y",
  "--auto",
  "--allow",
  "--allow-all-tools",
  "--allowedTools",
  "--allowed-tools",
  "--allow-tool",
  "--enable",
  "--sandbox",
  "--permission-mode",
  "--approval-mode",
  "--ask-for-approval",
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--agent",
  "--agent-file",
];

describe("S12.6 — hardening sent at every level", () => {
  test("every hardening list is in the argv at 1, 2 and 3, contiguous and in order", () => {
    let hardened = 0;
    for (const spec of VENDORS) {
      if (spec.hardening === undefined) continue;
      hardened += 1;
      for (const level of [RESTRAINED, LOOSENED, atLevel(3)]) {
        const joined = spec.headlessArgv({ prompt: "p", restraint: level }).join("\u0000");
        expect(joined, spec.id).toContain(spec.hardening.args.join("\u0000"));
      }
      expect(spec.hardening.why.length).toBeGreaterThan(40);
    }
    expect(hardened).toBeGreaterThanOrEqual(2);
  });

  test("a hardening list only narrows: no flag in it widens what a turn may do", () => {
    for (const spec of VENDORS) {
      const args = spec.hardening?.args ?? [];
      expect({ id: spec.id, loosening: args.filter((t) => LOOSENING.includes(t)) }).toEqual({
        id: spec.id,
        loosening: [],
      });
    }
  });

  test("codex's hardening is exactly these switches, and nothing rides beside them", () => {
    // `-c` can carry any config key, sandbox_mode and approval_policy among
    // them, so the list is pinned whole: another `-c` has to be argued for.
    // `--disable` over `-c features.x=false` because `-c` accepts a misspelt
    // feature silently and `--disable` refuses to start (probed 2026-09-26).
    expect(vendor("codex").hardening?.args).toEqual([
      "--disable",
      "plugins",
      "--disable",
      "shell_snapshot",
      "--disable",
      "apps",
      "--disable",
      "remote_plugin",
      "-c",
      "shell_environment_policy.ignore_default_excludes=false",
    ]);
    // And the argv carries no `-c`, `--config`, `--enable` or `--disable` of
    // its own outside that slice, at any level.
    for (const level of [RESTRAINED, LOOSENED, atLevel(3)]) {
      const rest = withoutHardening(vendor("codex"), vendor("codex").headlessArgv({ prompt: "p", restraint: level }));
      expect(rest.filter((t) => ["-c", "--config", "--enable", "--disable"].includes(t))).toEqual([]);
    }
  });

  test("hardening switches in the environment only switch things off", () => {
    for (const spec of VENDORS) {
      for (const [name, value] of Object.entries(spec.hardening?.env ?? {})) {
        expect({ id: spec.id, name, value }).toEqual({ id: spec.id, name, value: "0" });
      }
    }
  });

  test("grok's environment switches take Claude's and Cursor's hooks and MCP servers out of its turns", () => {
    // `grok inspect` on the owner's home, 2026-09-26: five Claude hooks and
    // seven MCP servers from `~/.claude.json` loaded into every turn, level 1
    // included, until these were set. `RULES` stays on on purpose — it is the
    // instruction-file channel the identity entry names.
    const env = vendor("grok").hardening?.env ?? {};
    for (const vendorName of ["CLAUDE", "CURSOR"]) {
      for (const surface of ["HOOKS", "MCPS", "AGENTS", "SKILLS"]) {
        expect(env[`GROK_${vendorName}_${surface}_ENABLED`]).toBe("0");
      }
    }
    expect(env["GROK_MANAGED_MCPS_ENABLED"]).toBe("0");
    // xAI's remote config turned telemetry and trace upload on after login (2026-09-27); these win over it.
    expect(env["GROK_TELEMETRY_ENABLED"]).toBe("0");
    expect(env["GROK_TELEMETRY_TRACE_UPLOAD"]).toBe("0");
    expect(env["GROK_FEEDBACK_ENABLED"]).toBe("0");
    expect(env["GROK_CLAUDE_RULES_ENABLED"]).toBeUndefined();
    expect(vendor("grok").identity.instructionFiles).toEqual(["~/.claude/CLAUDE.md"]);
  });

  test("grok's hardening removes the two meta-tools a level-1 turn used to reach a shell", () => {
    const args = vendor("grok").hardening?.args ?? [];
    expect(args[0]).toBe("--disallowed-tools");
    const removed = (args[1] ?? "").split(",");
    expect(removed).toContain("search_tool");
    expect(removed).toContain("use_tool");
    // Hygiene, not the fence: the level-1 fence stays the allow list, which
    // fails closed when a name drifts.
    expect(vendor("grok").readOnly.kind).toBe("allow-tools");
  });
});

describe("D-047 — grants and isolation", () => {
  test("levels 2 and 3 grant explicitly; below 2 nothing is granted", () => {
    expect(grantArgs(CLAUDE_GRANT, RESTRAINED)).toEqual([]);
    expect(grantArgs(CLAUDE_GRANT, LOOSENED)).toContain("acceptEdits");
    expect(grantArgs(CODEX_GRANT, LOOSENED)).toEqual(["--sandbox", "workspace-write"]);
    expect(grantArgs(CODEX_GRANT, atLevel(3))).toEqual(["--sandbox", "danger-full-access"]);
    expect(grantArgs(undefined, atLevel(3))).toEqual([]);
    expect(vendor("claude").grant).toBe(CLAUDE_GRANT);
    expect(vendor("codex").grant).toBe(CODEX_GRANT);
    expect(vendor("grok").grant).toBe(GROK_GRANT);
  });

  test("a claude turn that carries its own identity loads no user settings; every claude turn loads no MCP", () => {
    expect(claudeIsolation(undefined)).toEqual(["--strict-mcp-config"]);
    expect(claudeIsolation("# soul")).toEqual(["--setting-sources", "project,local", "--strict-mcp-config"]);
    const withSoul = vendor("claude").headlessArgv({ prompt: "p", restraint: RESTRAINED, system: "# soul" });
    expect(withSoul).toContain("project,local");
    expect(withSoul).toContain("--strict-mcp-config");
  });

  test("every governing flag a loosened argv carries is declared by its mechanism or its grant", () => {
    for (const spec of VENDORS) {
      const declared = new Set([
        ...(spec.readOnly.kind === "none" ? [] : [spec.readOnly.flag]),
        ...(spec.readOnly.kind !== "none" && spec.readOnly.despite !== undefined ? [spec.readOnly.despite.flag] : []),
        ...grantArgs(spec.grant, atLevel(3)).filter((t) => t.startsWith("--")),
      ]);
      for (const level of [LOOSENED, atLevel(3)]) {
        const undeclared = withoutHardening(spec, spec.headlessArgv({ prompt: "p", restraint: level }))
          .filter((token) => GOVERNING_FLAGS.includes(token) && !declared.has(token));
        expect({ id: spec.id, undeclared }).toEqual({ id: spec.id, undeclared: [] });
      }
    }
  });
});

describe("D-142 — how each vendor takes a model, as its own --help says", () => {
  /**
   * Read 2026-09-28 off each CLI's `--help` on a machine with all six installed: claude 2.1.283 `--model
   * <model>`; codex 0.155.1 (`exec --help`) `-m, --model <MODEL>`; grok 1.0.40 `-m, --model <MODEL>`; gemini
   * 0.38.2 `-m, --model`; copilot 0.0.367 `--model <model>` with a fixed list; kimi 2.0.2 `-m, --model <model>`.
   * Where the CLI has both spellings, the registry keeps the one it already sent.
   */
  const FLAGS: Readonly<Record<string, string>> = {
    claude: "--model",
    codex: "--model",
    grok: "--model",
    gemini: "-m",
    copilot: "--model",
    kimi: "-m",
  };

  test("every vendor declares its model flag, with the version it was read from", () => {
    expect(VENDORS.map((spec) => spec.id).sort()).toEqual(Object.keys(FLAGS).sort());
    for (const spec of VENDORS) {
      expect(spec.model, spec.id).toBeDefined();
      expect(spec.model!.flag, spec.id).toBe(FLAGS[spec.id]!);
      expect(spec.model!.evidence, spec.id).toContain("--help");
      expect(spec.model!.evidence, spec.id).toMatch(/\d+\.\d+\.\d+/);
      // What the picker offers must be something a turn would accept.
      for (const name of spec.model!.listed) expect(modelProblem(name), `${spec.id}: ${name}`).toBeUndefined();
    }
  });

  test("the names a vendor lists are its own: claude's aliases, copilot's fixed choices, and none guessed for the rest", () => {
    expect(vendor("claude").model!.listed).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(vendor("copilot").model!.listed).toContain("gpt-5.1-codex");
    for (const id of ["codex", "grok", "gemini", "kimi"]) expect(vendor(id).model!.listed, id).toEqual([]);
  });

  test("only the two vendors measured naming their model read one, and only out of their JSON output", () => {
    const reading = VENDORS.filter((spec) => spec.model?.reported != null);
    expect(reading.map((spec) => spec.id)).toEqual(["claude", "grok"]);
    for (const spec of reading) {
      // The report is read from the document the reply is read from, so a text-output vendor cannot have one.
      expect(spec.replyPointers.length, spec.id).toBeGreaterThan(0);
      expect(spec.usage?.shape, spec.id).toBe("json");
      expect(spec.model!.reported!.keysOf).toBe("/modelUsage");
    }
    expect(vendor("claude").model!.reported!.canonical).toBe("canonicalModel");
    expect(vendor("grok").model!.reported!.canonical).toBeUndefined();
  });
});
