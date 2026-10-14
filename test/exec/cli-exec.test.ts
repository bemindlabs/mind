/**
 * `CliExec` against a subprocess that is not a vendor CLI.
 *
 * This file was the first half of the debt S0.1 shipped: `cli-exec.ts` sat
 * behind a coverage exemption at 5.81% of lines while being the file every
 * commercial backend runs through, and the bug that exemption hid — an
 * unauthenticated CLI's "Not logged in" read back as the model's answer — was
 * found by running the product, not by the suite.
 *
 * The stub is an executable with a random name in a temporary directory
 * (S2.1 AC4: a test seam that does not fork a real CLI, and cannot accidentally
 * find one). It reflects its argv, its `$HOME`, its subject and its working
 * directory back as JSON, so the questions this layer is actually responsible
 * for — *what did the child see?* — are answered by the child.
 *
 * Nothing here reads or writes the operator's home (D-021): every `HOME` a
 * child gets is a temporary directory, and the stub reads no config at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliExec, extractReply, extractUsage, reportedModels, unfinished } from "../../src/exec/cli-exec.ts";
import { procStat, type ProcStat } from "../../src/decide/runs.ts";
import { modelArgs, restraintArgs, vendor, type ModelSpec, type ReadOnlySpec, type VendorSpec } from "../../src/exec/registry.ts";
import { subjectId } from "../../src/types.ts";
import { BUN } from "../support/bare-path.ts";
import { ended, ignores, procState, waitFor } from "../support/wait.ts";
import { atLevel, LOOSENED, operating, RESTRAINED } from "../support/restraint.ts";

/** Level 0 — the dial says do not run this turn at all. */
const SILENT = atLevel(0);

const SUBJECT = subjectId("example");

/** A name no real CLI has, so a passing test cannot be one that found a vendor. */
function stubName(): string {
  return `mind-stub-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * The stub CLI.
 *
 * A bun script rather than a shell script: the prompts this project sends are
 * multi-line and full of punctuation, and only an argv-level echo can show
 * that they survived as one argument.
 */
const STUB_SOURCE = `#!/usr/bin/env bun
const mode = process.env["MIND_STUB_MODE"] ?? "reflect";

// Exit 0 having printed nothing to stdout — the failure a shell \`||\` cannot
// see — while the actual reason sits on stderr, where several of these CLIs
// really do put it.
if (mode === "silent") {
  console.error("stub: the session ended before it answered");
  process.exit(0);
}

// Non-zero with prose on stdout: diagnostics wearing the shape of an answer.
if (mode === "unauthenticated") {
  console.log("Not logged in · Please run /login");
  process.exit(1);
}

// Alive until somebody kills it.
if (mode === "hang") {
  setTimeout(() => process.exit(0), 600000);
} else if (mode === "detach") {
  // A tool's command in a session of its own, the way grok runs every shell
  // command (setsid, D-149 e2e) — then alive until somebody kills it.
  const tool = Bun.spawn(
    ["setsid", "sh", "-c", (process.env["MIND_STUB_DEAF"] ? "trap '' TERM; " : "") + 'sleep "$MIND_STUB_SLEEP"; echo late > "$MIND_STUB_LATE"'],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env },
  );
  require("node:fs").writeFileSync(process.env["MIND_STUB_PIDFILE"], String(tool.pid));
  tool.unref();
  setTimeout(() => process.exit(0), 600000);
} else {
  const seen = {
    argv: process.argv.slice(2),
    subject: process.env["MIND_SUBJECT"] ?? null,
    home: process.env["HOME"] ?? null,
    marker: process.env["MIND_STUB_MARKER"] ?? null,
    cwd: process.cwd(),
  };
  const payload = { result: JSON.stringify(seen) };

  // How the vendor says the turn ended, and a reply field that is there and
  // blank — the two halves of a grok turn whose tool call was cancelled.
  const stop = process.env["MIND_STUB_STOP"];
  if (stop) payload.stopReason = stop;
  if (process.env["MIND_STUB_BLANK"]) payload.result = "";

  // Whatever a case wants in the vendor's own accounting block, verbatim.
  const usage = process.env["MIND_STUB_USAGE"];
  if (usage) payload.usage = JSON.parse(usage);
  // The per-model block claude and grok print beside it (D-142), verbatim.
  const modelUsage = process.env["MIND_STUB_MODEL_USAGE"];
  if (modelUsage) payload.modelUsage = JSON.parse(modelUsage);

  // Written before stdout, because the vendor that prints its counts here
  // prints its answer over there, and the order is not the point — both
  // streams arriving is.
  const onStderr = process.env["MIND_STUB_STDERR"];
  if (onStderr) console.error(onStderr);

  console.log(JSON.stringify(payload));

  const code = process.env["MIND_STUB_EXIT"];
  if (code) process.exit(Number(code));
}
`;

/** What the stub reports about the turn it was given. */
interface Seen {
  readonly argv: string[];
  readonly subject: string | null;
  readonly home: string | null;
  readonly marker: string | null;
  readonly cwd: string;
}

/** How the stub takes a model and names the one it ran: claude's shape (D-142). */
const STUB_MODEL: ModelSpec = {
  flag: "--model",
  listed: [],
  reported: { keysOf: "/modelUsage", canonical: "canonicalModel" },
  evidence: "synthetic",
};

/** The stub without a model flag — a vendor to which Mind may hand no model. */
function modelless(spec: VendorSpec): VendorSpec {
  const { model, ...rest } = spec;
  void model;
  return rest;
}

/**
 * A synthetic vendor.
 *
 * Synthetic on purpose: the real specs are pinned in `registry.test.ts`, and a
 * test of *this* file that used one of them would fail for two different
 * reasons at once the day a vendor changed a flag.
 */
function stubSpec(binary: string, overrides: Partial<VendorSpec> = {}): VendorSpec {
  return {
    id: "stub",
    display: "Stub CLI",
    binary,
    identity: {
      strength: "system",
      instructionFiles: ["./AGENTS.md"],
      appendPromptFlag: "--append-system-prompt",
    },
    // A synthetic vendor has to answer the read-only question too — the field
    // is required so that a seventh real vendor cannot be added without
    // answering it, and a stub that could skip it would be the one place the
    // question goes unasked.
    //
    // A mechanism with an **empty value list** rather than `kind: "none"`, and
    // the difference is not cosmetic since E5: a `none` vendor is *refused* at
    // the default dial level, so a stub declaring one would make every case in
    // this file fail for that reason instead of testing what it names. An empty
    // list still contributes nothing to the argv, which is what these cases
    // want. {@link NO_MECHANISM} below is the stub that does declare `none`, and
    // it has its own case.
    readOnly: {
      kind: "allow-tools",
      flag: "--tools",
      values: [],
      evidence: "probed",
    },
    model: STUB_MODEL,
    headlessArgv: ({ prompt, model }) => ["-p", prompt, ...modelArgs(STUB_MODEL, model)],
    replyPointers: ["/result"],
    // Unsurveyed by default, so a case that cares about counts has to say so.
    usage: null,
    traps: [],
    measuredAgainst: "0.0.0-test",
    ...overrides,
  };
}

/**
 * The vendor with no read-only mechanism — the hole, as a stub.
 *
 * kimi was the real one until S12.6 found it a profile file (D-120). Synthetic
 * here, so that the refusal can be tested without a case that changes when a
 * vendor ships a flag — which is exactly what happened.
 */
const NO_MECHANISM = {
  kind: "none",
  why: "a stub with no tools to filter; nothing here runs a real agent",
  evidence: "writes",
} as const;

/** A vendor that prints its counts as JSON on stdout, claude-shaped. */
const JSON_USAGE = {
  shape: "json",
  stream: "stdout",
  input: ["/usage/input", "/usage/cache_write", "/usage/cache_read"],
  output: "/usage/output",
  cacheRead: "/usage/cache_read",
  cacheWrite: "/usage/cache_write",
} as const;

/** A vendor that prints one total as prose on stderr, codex-shaped. */
const TEXT_USAGE = { shape: "text", stream: "stderr", totalAfterLine: "tokens used" } as const;

const scratch: string[] = [];
let stubDir = "";
let binary = "";
let originalPath = "";

beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), "mind-cli-exec-"));
  scratch.push(stubDir);
  binary = stubName();
  const path = join(stubDir, binary);
  await writeFile(path, STUB_SOURCE);
  await chmod(path, 0o755);
  // The stub's shebang resolves `bun` through the child's PATH, so the same
  // directory carries one. That also makes this directory usable on its own as
  // a whole PATH, which one case below needs.
  await symlink(BUN, join(stubDir, "bun"));

  // `available()` is a `Bun.which` against *this* process's PATH, so the stub
  // has to be reachable from here as well as from the child. Restored below.
  originalPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${stubDir}:${originalPath}`;
});

afterAll(async () => {
  process.env["PATH"] = originalPath;
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const homes: string[] = [];
afterEach(async () => {
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A throwaway home, so no case can reach the operator's own files. */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mind-cli-home-"));
  homes.push(home);
  return home;
}

/** The stub's reflection, pulled back out of the reply. */
function seen(text: string): Seen {
  return JSON.parse(text) as Seen;
}

describe("extractReply", () => {
  const spec = stubSpec("unused");

  test("the first pointer that resolves to text wins", () => {
    const twoPointers = stubSpec("unused", { replyPointers: ["/text", "/result"] });
    expect(extractReply(twoPointers, '{"text":"from text","result":"from result"}')).toBe(
      "from text",
    );
    // The second is reached only when the first is not there — a vendor that
    // renamed one field should not stop producing answers.
    expect(extractReply(twoPointers, '{"result":"from result"}')).toBe("from result");
  });

  test("a nested pointer walks the whole path", () => {
    const nested = stubSpec("unused", { replyPointers: ["/message/content"] });
    expect(extractReply(nested, '{"message":{"content":"nested answer"}}')).toBe("nested answer");
    // Through a non-object, the walk stops rather than throwing.
    expect(extractReply(nested, '{"message":"a string"}')).toBe('{"message":"a string"}');
  });

  test("output that is not JSON is the reply itself, not a crash", () => {
    // Tolerance with a purpose: a vendor that changes its output shape should
    // degrade to "we got text back", never to something that reads as the
    // model having failed.
    expect(extractReply(spec, "  plain prose, no braces  ")).toBe("plain prose, no braces");
    expect(extractReply(spec, "{not json at all")).toBe("{not json at all");
  });

  test("JSON with no matching pointer falls back to the raw text", () => {
    expect(extractReply(spec, '{"other":"field"}')).toBe('{"other":"field"}');
    // Present but not a string is a shape that moved: the raw text, as before.
    expect(extractReply(spec, '{"result":42}')).toBe('{"result":42}');
  });

  test("a reply field that is there and blank is no answer, not the whole document", () => {
    // S12.6. Measured 2026-09-26 on grok 1.0.40: a cancelled turn printed
    // `"text": ""` and exited 0, and falling back to the raw JSON here made
    // `classify` call it confirmed. A blank field is the vendor saying the
    // model said nothing — a changed shape is the case the fallback is for.
    expect(extractReply(spec, '{"result":"   "}')).toBe("");
    expect(extractReply(spec, '{"result":"","stopReason":"cancelled"}')).toBe("");
    const twoPointers = stubSpec("unused", { replyPointers: ["/text", "/result"] });
    // A blank first field does not hide a real answer under the second.
    expect(extractReply(twoPointers, '{"text":"","result":"the answer"}')).toBe("the answer");
  });

  test("a notice printed before the document does not turn it back into raw text", () => {
    // One line of noise used to make the whole output unparseable, and the
    // fallback then handed it on as the answer — a cancelled turn included.
    const grokish = stubSpec("unused", { replyPointers: ["/text", "/result"] });
    expect(extractReply(grokish, 'Update available: 1.0.41\n{"text":"","stopReason":"cancelled"}')).toBe("");
    expect(extractReply(grokish, 'notice\n{\n  "text": "pretty answer",\n  "stopReason": "end_turn"\n}')).toBe(
      "pretty answer",
    );
    // Prose with no document in it is still the reply itself.
    expect(extractReply(grokish, "first line\nsecond line")).toBe("first line\nsecond line");
  });

  test("a vendor with no pointers prints its reply verbatim", () => {
    const plain = stubSpec("unused", { replyPointers: [] });
    expect(extractReply(plain, '  {"result":"ignored"}  ')).toBe('{"result":"ignored"}');
  });

  test("empty output is empty, whatever the pointers say", () => {
    expect(extractReply(spec, "")).toBe("");
    expect(extractReply(spec, "   \n  ")).toBe("");
  });
});

describe("unfinished — the vendor's own word on how a turn ended", () => {
  const finishing = stubSpec("unused", { completion: { pointer: "/stopReason", value: "end_turn" } });

  test("a value that is there and different is the turn not finishing", () => {
    expect(unfinished(finishing, '{"text":"I will run it.","stopReason":"cancelled"}')).toBe("cancelled");
    expect(unfinished(finishing, '{"text":"done","stopReason":"end_turn"}')).toBeUndefined();
  });

  test("silence about it is not evidence of anything", () => {
    // Not JSON, no field, or a field that is not a string: none of these says
    // how the turn ended, and reading them as unfinished would turn a vendor's
    // shape change into every turn being thrown away.
    expect(unfinished(finishing, "plain prose")).toBeUndefined();
    expect(unfinished(finishing, '{"text":"done"}')).toBeUndefined();
    expect(unfinished(finishing, '{"stopReason":7}')).toBeUndefined();
    expect(unfinished(stubSpec("unused"), '{"stopReason":"cancelled"}')).toBeUndefined();
  });

  test("a notice before the document does not hide how the turn ended", () => {
    expect(unfinished(finishing, 'Update available\n{"text":"I will run it.","stopReason":"cancelled"}')).toBe(
      "cancelled",
    );
  });
});

describe("extractUsage — a wrong guess costs a number, never invents one", () => {
  const json = stubSpec("unused", { usage: JSON_USAGE });
  const text = stubSpec("unused", { usage: TEXT_USAGE });

  test("a vendor nobody has surveyed is `unreported`, not zero", () => {
    // The distinction the whole three-state design exists for: "Mind has not
    // looked" is a fact about Mind, and reads nothing like "this was free".
    const none = extractUsage(stubSpec("unused"), '{"result":"hi"}', "");
    expect(none).toEqual({ status: "unreported", input: null, output: null, total: null, cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null });
  });

  test("every named field present is `reported`, and input is their sum", () => {
    const usage = extractUsage(
      json,
      '{"usage":{"input":2,"cache_write":80951,"cache_read":0,"output":4}}',
      "",
    );
    // This stub prints no split of the write (D-143), and says so.
    expect(usage).toEqual({ status: "reported", input: 80953, output: 4, total: null, cache_read: 0, cache_write: 80951, cache_write_5m: null, cache_write_1h: null, not_printed: ["cache_write_5m", "cache_write_1h"] });
  });

  test("the cache counts are read apart, as parts of the input they are summed into (S15.9)", () => {
    // D-110 prices a cache read, a cache write and fresh input differently, so
    // the parts are kept — and `input` stays the whole, as it always was.
    const usage = extractUsage(json, '{"usage":{"input":7,"cache_write":100,"cache_read":900,"output":4}}', "");
    expect(usage.input).toBe(1007);
    expect([usage.cache_read, usage.cache_write]).toEqual([900, 100]);
    expect(usage.not_printed).toEqual(["cache_write_5m", "cache_write_1h"]);
  });

  test("a JSON vendor with no cache fields says it prints none — null, never 0 (S15.9)", () => {
    const plain = stubSpec("unused", { usage: { shape: "json", stream: "stdout", input: ["/usage/input"], output: "/usage/output" } });
    const usage = extractUsage(plain, '{"usage":{"input":12,"output":3}}', "");
    expect(usage).toEqual({
      status: "reported",
      input: 12,
      output: 3,
      total: null,
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
    });
    // A turn that died before its summary still says which of its nulls are the vendor's.
    expect(extractUsage(plain, "not json", "")).toEqual({
      status: "missing",
      input: null,
      output: null,
      total: null,
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
    });
  });

  test("a cache pointer the spec names and the vendor dropped is missing, even when the input sum is not", () => {
    // Only a registry that stopped listing the cache pointer among the inputs
    // could get here; the status must not depend on it doing so.
    const loose = stubSpec("unused", {
      usage: { shape: "json", stream: "stdout", input: ["/usage/input"], output: "/usage/output", cacheRead: "/usage/cache_read" },
    });
    const usage = extractUsage(loose, '{"usage":{"input":12,"output":3}}', "");
    expect(usage.status).toBe("missing");
    expect(usage.not_printed).toEqual(["cache_write", "cache_write_5m", "cache_write_1h"]);
  });

  test("a vendor-printed zero is a real zero, not a missing number", () => {
    // `0` from a vendor is the one case where the number and the absence look
    // alike in a nullable field, and they are not the same thing at all.
    const usage = extractUsage(
      json,
      '{"usage":{"input":0,"cache_write":0,"cache_read":0,"output":0}}',
      "",
    );
    expect(usage).toEqual({ status: "reported", input: 0, output: 0, total: null, cache_read: 0, cache_write: 0, cache_write_5m: null, cache_write_1h: null, not_printed: ["cache_write_5m", "cache_write_1h"] });
  });

  describe("D-143 — which cache a write went to", () => {
    const splitting = stubSpec("unused", {
      usage: { ...JSON_USAGE, cacheWrite5m: "/usage/cache_creation/m5", cacheWrite1h: "/usage/cache_creation/h1" },
    });
    const body = (split: unknown) => JSON.stringify({ usage: { input: 7, cache_write: 300, cache_read: 900, output: 4, cache_creation: split } });

    test("both parts, adding up to the write, are kept apart; nothing is listed as unprinted", () => {
      const usage = extractUsage(splitting, body({ m5: 100, h1: 200 }), "");
      expect(usage).toEqual({
        status: "reported",
        input: 1207,
        output: 4,
        total: null,
        cache_read: 900,
        cache_write: 300,
        cache_write_5m: 100,
        cache_write_1h: 200,
        not_printed: [],
      });
    });

    test("a split that is absent, half there, not a count or not adding up is unknown — and the rest is still reported", () => {
      for (const split of [undefined, { m5: 300 }, { m5: "100", h1: 200 }, { m5: 100, h1: 100 }, { m5: -100, h1: 400 }, "none"]) {
        const usage = extractUsage(splitting, body(split), "");
        // Not a missing count: every number the bill is made of is there. Two nulls nothing explains.
        expect(usage.status, JSON.stringify(split)).toBe("reported");
        expect([usage.cache_write, usage.cache_write_5m, usage.cache_write_1h], JSON.stringify(split)).toEqual([300, null, null]);
        expect(usage.not_printed).toEqual([]);
      }
    });

    test("claude's own spec reads the shape measured on 2.1.283", () => {
      // The usage block of the turn D-143 ran (`--model haiku`, 2026-09-28), counts as printed, and the one of
      // D-142's turn, which wrote the 1-hour cache: `cache_creation` is the split, `iterations` a per-request copy.
      const measured = (write: number, m5: number, h1: number, read: number) =>
        JSON.stringify({
          type: "result",
          result: "ok",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: write,
            cache_read_input_tokens: read,
            output_tokens: 65,
            output_tokens_details: { thinking_tokens: 58 },
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 },
            inference_geo: "not_available",
            iterations: [{ input_tokens: 10, output_tokens: 65, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 }, type: "message" }],
            speed: "standard",
          },
        });
      const read = extractUsage(vendor("claude"), measured(0, 0, 0, 11_856), "");
      expect(read).toMatchObject({ status: "reported", input: 11_866, cache_read: 11_856, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, not_printed: [] });
      const wrote = extractUsage(vendor("claude"), measured(11_856, 0, 11_856, 0), "");
      expect(wrote).toMatchObject({ status: "reported", input: 11_866, cache_write: 11_856, cache_write_5m: 0, cache_write_1h: 11_856, not_printed: [] });
      // grok prints no split and says so; its writes stay one part.
      const grok = extractUsage(vendor("grok"), JSON.stringify({ usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, total_tokens: 2 } }), "");
      expect(grok.not_printed).toEqual(["cache_write_5m", "cache_write_1h"]);
    });
  });

  test("one absent input part makes input null — never a partial sum", () => {
    // The measured failure this rule exists for: claude's `input_tokens` alone
    // reported 2 for a turn that sent about 81,000. A sum of the fields that
    // happened to be there would be off by four orders of magnitude, and would
    // look exactly like a cheap turn.
    const usage = extractUsage(json, '{"usage":{"input":2,"cache_read":0,"output":4}}', "");
    expect(usage.status).toBe("missing");
    expect(usage.input).toBeNull();
    // What was found is still kept: a partial line beats an empty one, as long
    // as the status says it is partial.
    expect(usage.output).toBe(4);
  });

  test("a shape that moved reads as missing, not as a different number", () => {
    // Every one of these is a vendor rename or retype away from the spec, and
    // every one has to land in the same place.
    for (const body of [
      '{"usage":{"input":"2","cache_write":80951,"cache_read":0,"output":4}}', // quoted
      '{"usage":{"input":-1,"cache_write":0,"cache_read":0,"output":4}}', // negative
      '{"usage":{"input":1.5,"cache_write":0,"cache_read":0,"output":4}}', // fractional
      '{"tokens":{"input":2}}', // renamed block
      '{"usage":"none"}', // no longer an object
      "not json at all", // the turn died before its summary
      "", // nothing came back
    ]) {
      expect(extractUsage(json, body, "").status).toBe("missing");
    }
  });

  test("a total the vendor did not print stays null — Mind does not add up", () => {
    // Two vendors' tokenizers do not count the same thing, so a derived total
    // would be arithmetic wearing the vendor's authority.
    expect(
      extractUsage(json, '{"usage":{"input":1,"cache_write":1,"cache_read":1,"output":4}}', "")
        .total,
    ).toBeNull();
  });

  test("a spec that names a total needs it before the line is complete", () => {
    const withTotal = stubSpec("unused", { usage: { ...JSON_USAGE, total: "/usage/total" } });
    const body = '{"usage":{"input":1,"cache_write":1,"cache_read":1,"output":4}}';
    expect(extractUsage(withTotal, body, "").status).toBe("missing");
    expect(
      extractUsage(withTotal, '{"usage":{"input":1,"cache_write":1,"cache_read":1,"output":4,"total":7}}', "")
        .total,
    ).toBe(7);
  });

  test("a prose count is read off the line after its label, commas and all", () => {
    // Measured shape: `codex exec` writes `tokens used` and puts the figure on
    // the next line, thousands separated.
    const usage = extractUsage(text, "the answer", "some progress\ntokens used\n2,243\n");
    // One total and no parts: every part is null, and said to be one the vendor never prints (S15.9).
    expect(usage).toEqual({
      status: "reported",
      input: null,
      output: null,
      total: 2243,
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      not_printed: ["input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
    });
  });

  test("the last count wins, so a run that summarised twice reports its final figure", () => {
    const usage = extractUsage(text, "", "tokens used\n100\nmore work\ntokens used\n2,243\n");
    expect(usage.total).toBe(2243);
  });

  test("a label with nothing usable after it is missing, and an empty line is not zero", () => {
    // `Number("")` is 0, which would turn a truncated run into a free one.
    for (const stderr of [
      "tokens used\n\n",
      "tokens used\n",
      "tokens used\nabout 2,243\n",
      "tokens used\n-5\n",
      "no summary here\n",
      "",
    ]) {
      expect(extractUsage(text, "", stderr).status).toBe("missing");
    }
  });

  test("each spec reads its own stream and ignores the other", () => {
    // The bug this prevents is silent in both directions: a stderr-reading
    // spec that fell back to stdout would parse the answer, and a
    // stdout-reading one that fell back to stderr would parse the progress log.
    expect(extractUsage(text, "tokens used\n999\n", "").status).toBe("missing");
    expect(
      extractUsage(json, "", '{"usage":{"input":1,"cache_write":1,"cache_read":1,"output":1}}')
        .status,
    ).toBe("missing");
  });
});

describe("CliExec is the spec, wearing the backend interface", () => {
  test("id, display, kind and strength all come from the spec it was built with", () => {
    // A `CliExec` holds no state of its own — one wrong field here would make
    // `doctor` and `backends` name one vendor while running another.
    const exec = new CliExec(stubSpec(binary, { id: "some-vendor", display: "Some Vendor" }));
    expect(exec.id).toBe("some-vendor");
    expect(exec.display).toBe("Some Vendor");
    expect(exec.kind).toBe("cli");
    expect(exec.identityStrength).toBe("system");

    const fileOnly = new CliExec(
      stubSpec(binary, { identity: { strength: "user", instructionFiles: ["./AGENTS.md"] } }),
    );
    expect(fileOnly.identityStrength).toBe("user");
  });
});

describe("CliExec.available", () => {
  test("a binary on PATH is reported with the path that was found", async () => {
    // `bun` rather than the stub, for the reason the next case records: this
    // check cannot see a directory added to PATH after the process started.
    // The path itself is the useful half — `doctor` prints it, and "which
    // claude did it actually find" is the question that ends the argument.
    const result = await new CliExec(stubSpec("bun")).available();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe(BUN);
  });

  test("a binary that is not there is a result, not an exception", async () => {
    // `doctor` calls this for every backend in a loop; one missing CLI must
    // not derail the rest, so a missing binary is an answer and not a throw.
    const missing = stubName();
    const result = await new CliExec(stubSpec(missing)).available();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(`${missing}: not on PATH`);
  });

  test("readiness is measured against the PATH this process started with", async () => {
    // Measured, not assumed, and a seam worth naming: `Bun.which(binary)` with
    // no options resolves against the environment as it was at process start,
    // so the stub directory this file prepends to `process.env.PATH` is
    // invisible to it — while `Bun.spawn` in `run()` resolves `argv[0]` from
    // the env it is *handed*, which does include it. Readiness and the turn
    // can therefore disagree about whether a binary exists.
    //
    // Nothing in Mind changes PATH mid-run today, so this costs nobody
    // anything now. It is pinned because the failure it would cause is the
    // quiet kind: `available()` says no, the backend is skipped as "not on
    // PATH", and the CLI sitting right there is never asked.
    expect(process.env["PATH"] ?? "").toContain(stubDir);
    expect(Bun.which(binary)).toBeNull();
    expect(Bun.which(binary, { PATH: process.env["PATH"] ?? "" })).toBe(join(stubDir, binary));

    const result = await new CliExec(stubSpec(binary)).available();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(`${binary}: not on PATH`);
  });
});

describe("CliExec.run", () => {
  test("a fenced turn is refused before spawning when Landlock is unavailable", async () => {
    let built = false;
    const result = await new CliExec(stubSpec(binary), {
      support: () => ({ ok: false, reason: "synthetic kernel has no Landlock" }),
      argv: () => {
        built = true;
        return ["must-not-run"];
      },
    }).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      fence: { writable: [], tcpPorts: [10400] },
      env: { HOME: await tempHome() },
    });

    expect(built).toBe(false);
    expect(result.confidence).toBe("silent");
    expect(result.identityStrength).toBe("none");
    expect(result.evidence.raw).toContain("refused by the kernel fence");
    expect(result.evidence.raw).toContain("synthetic kernel has no Landlock");
    expect(result.evidence.exitCode).toBeUndefined();
  });

  test("a supported fenced turn spawns exactly the argv the fence builder returns", async () => {
    const seenBuilds: { argv: readonly string[]; writable: readonly string[]; ports: readonly number[] }[] = [];
    const home = await tempHome();
    const result = await new CliExec(stubSpec(binary), {
      support: () => ({ ok: true, abi: 8 }),
      argv: (argv, policy) => {
        seenBuilds.push({ argv: [...argv], writable: [...policy.writable], ports: [...policy.tcpPorts] });
        // This test owns only the integration seam. The real builder and the
        // real kernel are exercised in fence.test.ts.
        return [...argv];
      },
    }).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      fence: { writable: [home], tcpPorts: [10400] },
      env: { HOME: home },
    });

    expect(result.confidence).toBe("confirmed");
    expect(seenBuilds).toEqual([
      { argv: [binary, "-p", "anything"], writable: [home], ports: [10400] },
    ]);
  });

  test("a clean exit with an answer is confirmed, and the argv is what the spec said", async () => {
    const home = await tempHome();
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "line one\nline two — with punctuation, \"quotes\" and a --flag",
      model: "stub-model",
      env: { HOME: home },
    });

    expect(result.confidence).toBe("confirmed");
    expect(result.backend).toBe("stub");
    const child = seen(result.text);

    // The prompt arrives as exactly one argv element, verbatim. Anything else
    // is the class of bug where the middle of a prompt is silently lost.
    expect(child.argv).toEqual([
      "-p",
      "line one\nline two — with punctuation, \"quotes\" and a --flag",
      "--model",
      "stub-model",
    ]);
    expect(result.evidence.exitCode).toBe(0);
    expect(result.evidence.prompt).toBe(
      "line one\nline two — with punctuation, \"quotes\" and a --flag",
    );
    expect(result.evidence.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("exit 0 with nothing printed is silence, and stderr is kept as the reason", async () => {
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome(), MIND_STUB_MODE: "silent" },
    });

    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    // For several of these CLIs the only account of why a turn produced
    // nothing is on stderr, so an empty stdout must not erase it.
    expect(result.evidence.raw).toContain("the session ended before it answered");
    expect(result.evidence.exitCode).toBe(0);
  });

  test("a CLI that is not logged in is silent — its complaint is never the answer", async () => {
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome(), MIND_STUB_MODE: "unauthenticated" },
    });

    // The regression, at this level rather than at `classify`'s. A non-zero
    // exit means the CLI never took its turn; what it printed is diagnostics.
    // Reported as an answer, it became "the model replied, but not from this
    // soul", and `soul verify` blamed the identity channel for a login problem.
    expect(result.confidence).toBe("silent");
    expect(result.evidence.exitCode).toBe(1);
    // Still kept, in full, where a human looking for the cause will find it.
    expect(result.evidence.raw).toContain("Not logged in");
    // But not offered as something a caller could print as a reply.
    expect(result.text).toBe("Not logged in · Please run /login");
    expect(result.confidence).not.toBe("confirmed");
  });

  test("a turn that blows its deadline is silent, and says how long it waited", async () => {
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      timeoutMs: 250,
      env: { HOME: await tempHome(), MIND_STUB_MODE: "hang" },
    });

    // Not the model declining to answer: us cutting the call off.
    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.evidence.raw).toContain("timed out after 250ms");
  }, 10_000);

  test.skipIf(Bun.which("setsid") === null).each([
    ["dies on SIGTERM", false],
    ["ignores SIGTERM, and gets SIGKILL before run returns (D-044)", true],
  ] as const)(
    "a turn that is ended takes what its vendor started, in a session of its own, with it, which %s (D-149 review)",
    async (_name, deaf) => {
      // No stopwatch in this test: the turn is ended by an abort fired when the shape is OBSERVED (an event), not by
      // a timer that started with the turn and could run out before a loaded machine had made the shape. The turn's
      // own timeout is far away, and the kill grace is given short, so nothing here waits on a clock but the one
      // sleep that proves a negative (the tool's late file never appears), which only a load can lengthen.
      // `endTurn` is the one function behind both the timeout and the abort; the timeout's own wiring (a silent
      // result that says how long it waited) is the test just above this one.
      const nap = 2;
      // The grok shape: the vendor's tool runs its command under setsid, so it
      // leads a group of its own, and a signal to the vendor's group misses it.
      // Before the fix it outlived the timeout, re-parented to init, and wrote
      // its file after the turn had come back as timed out.
      const home = await tempHome();
      const pidFile = join(home, "tool.pid");
      const late = join(home, "late.txt");
      const stop = new AbortController();
      const running = new CliExec(stubSpec(binary)).run({
        restraint: RESTRAINED,
        subject: SUBJECT,
        prompt: "anything",
        timeoutMs: 600_000,
        killAfterMs: 300,
        signal: stop.signal,
        env: { HOME: home, MIND_STUB_MODE: "detach", MIND_STUB_PIDFILE: pidFile, MIND_STUB_LATE: late, MIND_STUB_SLEEP: String(nap), ...(deaf ? { MIND_STUB_DEAF: "1" } : {}) },
      });

      // The stub writes the pid as soon as it has spawned `setsid sh -c …`, which is before setsid has made the
      // session and before the shell has run its `trap`. So wait for the shape itself — its own group, and SIGTERM
      // ignored when that is the case — and only then end the turn. The wait gives up only if the run itself has
      // already come back (the tool never got there), which the next assertion then reports.
      let tool: ProcStat | null = null;
      let settled = false;
      void running.finally(() => (settled = true));
      await waitFor(async () => {
        const text = await readFile(pidFile, "utf8").catch(() => "");
        const now = /^\d+$/.test(text) ? procStat(Number(text)) : null;
        if (now === null || now.pgid !== now.pid) return settled;
        if (deaf && !ignores(now.pid, 15)) return settled;
        tool = now;
        return true;
      });
      // The shape this case is about, checked rather than assumed: its own group.
      expect(tool, "the tool never led a session of its own before the turn came back").not.toBeNull();
      expect(tool!.pgid).toBe(tool!.pid);
      stop.abort();

      const result = await running;
      expect(result.confidence).toBe("silent");

      // Ended by the time run() returned — gone, reused, a zombie its new parent has not reaped yet, or with
      // SIGKILL already pending in the kernel. Asked at once and not polled: a SIGKILL left to a timer after
      // `turn` exits is a SIGKILL never sent. (It used to sleep 100 ms and ask whether the /proc entry was gone,
      // which a slow reaper fails and a late timer could pass.)
      expect(ended(tool!.pid, tool!.startTicks), JSON.stringify(procState(tool!.pid))).toBe(true);
      // And its action never happens: the sleep it was waiting on is over by now.
      await Bun.sleep(nap * 1_000);
      expect(await readFile(late, "utf8").catch(() => null)).toBeNull();
    },
    // About 1 s of the test's own timers in all, against the 60 s it was given when it spent 12.5 s on three real ones.
    60_000,
  );

  test("an aborted turn comes back rather than hanging on the timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      // Long enough that finishing at all proves the signal did the work.
      timeoutMs: 120_000,
      signal: controller.signal,
      env: { HOME: await tempHome(), MIND_STUB_MODE: "hang" },
    });

    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
  }, 10_000);

  test("a binary that vanished is a result, not a thrown error", async () => {
    // `available()` and `run()` are separate moments, and a caller looping over
    // every backend must not be derailed by one of them going missing between
    // the two.
    const result = await new CliExec(stubSpec(stubName())).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });

    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.evidence.raw).toStartWith("spawn failed:");
    expect(result.evidence.exitCode).toBeUndefined();
  });

  test("a spawn that never happened carried no identity, whatever the flags said", async () => {
    // The vendor here takes a system prompt as a flag, so the argv was built
    // to carry the identity at system strength — and then no process started.
    // Reporting "system" would describe a delivery that never occurred, which
    // is the same mistake as reading a login error as a model's answer.
    const result = await new CliExec(stubSpec(stubName())).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      system: "You are the keeper.",
      env: { HOME: await tempHome() },
    });

    expect(result.confidence).toBe("silent");
    expect(result.identityStrength).toBe("none");
  });

  test("the subject reaches the child, and a caller's env cannot rename it", async () => {
    // S0.1 AC4 / I-3. A caller may aim a turn at a different home — that is
    // what `env` is for — but it may not change whose turn it is.
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome(), MIND_SUBJECT: "someone-else" },
    });

    expect(seen(result.text).subject).toBe("example");
  });

  test("the home and the working directory a caller names are the ones the child gets", async () => {
    const home = await tempHome();
    const cwd = await tempHome();
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: home, MIND_STUB_MARKER: "carried" },
      cwd,
    });

    // Without this, a turn would read the operator's real instruction file
    // while the report talked about another one.
    const child = seen(result.text);
    expect(child.home).toBe(home);
    expect(child.marker).toBe("carried");
    // Two vendors resolve their only instruction file against the cwd, so it
    // is part of the same question as the home. Compared through `realpath`
    // because a temporary directory may sit behind a symlinked `/tmp`.
    expect(child.cwd).toBe(realpathSync(cwd));
    expect(child.cwd).not.toBe(realpathSync(process.cwd()));
  });

  test("a spec can refuse the ambient environment and receive only explicit values", async () => {
    const previous = process.env["MIND_STUB_MARKER"];
    process.env["MIND_STUB_MARKER"] = "ambient-secret";
    try {
      const result = await new CliExec(stubSpec(binary, { inheritEnv: false })).run({
        restraint: RESTRAINED,
        subject: SUBJECT,
        prompt: "anything",
        env: { HOME: await tempHome(), PATH: stubDir },
      });

      expect(result.confidence).toBe("confirmed");
      expect(seen(result.text).marker).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["MIND_STUB_MARKER"];
      else process.env["MIND_STUB_MARKER"] = previous;
    }
  });

  test("a spawned turn resolves its binary from the env it was handed, not this process's PATH", async () => {
    // Measured, not assumed, and worth pinning: `Bun.spawn` looks `argv[0]` up
    // in `options.env.PATH`. `available()` uses `Bun.which` against the
    // *process* PATH instead, so a caller that overrides PATH through `env`
    // gets a readiness check and a turn that can disagree about which binary —
    // or whether any binary — exists. No caller in Mind does that today;
    // this records the seam rather than leaving it to be discovered.
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      // The stub directory alone, with no inherited PATH behind it.
      env: { HOME: await tempHome(), PATH: stubDir },
    });

    expect(result.confidence).toBe("confirmed");
    expect(seen(result.text).argv).toEqual(["-p", "anything"]);
  });
});

describe("CliExec.run and what the turn used", () => {
  test("a JSON vendor's counts arrive on the evidence of a real turn", async () => {
    const result = await new CliExec(stubSpec(binary, { usage: JSON_USAGE })).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: {
        HOME: await tempHome(),
        MIND_STUB_USAGE: JSON.stringify({ input: 2, cache_write: 80951, cache_read: 0, output: 4 }),
      },
    });

    expect(result.confidence).toBe("confirmed");
    expect(result.evidence.usage).toEqual({
      status: "reported",
      input: 80953,
      output: 4,
      total: null,
      cache_read: 0,
      cache_write: 80951,
      cache_write_5m: null,
      cache_write_1h: null,
      not_printed: ["cache_write_5m", "cache_write_1h"],
    });
  });

  test("a count on stderr survives a turn that answered on stdout", async () => {
    // The regression this task was opened around: `evidence.raw` keeps stderr
    // only when stdout came back empty, so a vendor that answers on one stream
    // and accounts on the other loses its numbers on exactly the turns that
    // used tokens. The counts are read before `raw` narrows, and this proves it.
    const result = await new CliExec(stubSpec(binary, { usage: TEXT_USAGE })).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome(), MIND_STUB_STDERR: "tokens used\n2,243" },
    });

    expect(result.confidence).toBe("confirmed");
    expect(result.evidence.raw).not.toContain("tokens used");
    expect(result.evidence.usage).toEqual({
      status: "reported",
      input: null,
      output: null,
      total: 2243,
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      not_printed: ["input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
    });
  });

  test("a turn that exited non-zero still reports what it spent getting there", async () => {
    // Tokens are spent before the exit code is chosen. A turn that failed
    // halfway used what it used, and recording nothing would make a failing
    // backend look like a free one.
    const result = await new CliExec(stubSpec(binary, { usage: TEXT_USAGE })).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: {
        HOME: await tempHome(),
        MIND_STUB_STDERR: "tokens used\n41",
        MIND_STUB_EXIT: "1",
      },
    });

    expect(result.confidence).toBe("silent");
    expect(result.evidence.exitCode).toBe(1);
    expect(result.evidence.usage).toEqual({
      status: "reported",
      input: null,
      output: null,
      total: 41,
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
      not_printed: ["input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
    });
  });

  test("a spawn that never happened is `missing` for a surveyed vendor, `unreported` otherwise", async () => {
    // Mechanical, with no special case for "we know why the streams are
    // empty": a spec that names a channel and finds nothing in it is missing.
    const surveyed = await new CliExec(stubSpec(stubName(), { usage: TEXT_USAGE })).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(surveyed.evidence.usage?.status).toBe("missing");

    const unsurveyed = await new CliExec(stubSpec(stubName())).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(unsurveyed.evidence.usage?.status).toBe("unreported");
  });

  test("a turn killed on its deadline reports missing, not a number and not silence about it", async () => {
    const result = await new CliExec(stubSpec(binary, { usage: JSON_USAGE })).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      timeoutMs: 250,
      env: { HOME: await tempHome(), MIND_STUB_MODE: "hang" },
    });

    expect(result.confidence).toBe("silent");
    expect(result.evidence.usage?.status).toBe("missing");
  }, 10_000);

  test("every turn carries a usage, so nothing downstream has to guess", async () => {
    // `RecordingExec` falls back to `unreported` when this is absent, and an
    // exec layer that sometimes omits it would make that fallback lie about
    // vendors it had in fact surveyed.
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(result.evidence.usage).toBeDefined();
  });
});

describe("CliExec and the identity it can honestly claim", () => {
  test("a vendor with a system flag carries the soul in argv, at full strength", async () => {
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      system: "# Example Keeper\n\nsoul text",
      env: { HOME: await tempHome() },
    });

    expect(result.identityStrength).toBe("system");
    expect(seen(result.text).argv).toEqual([
      "-p",
      "anything",
      "--append-system-prompt",
      "# Example Keeper\n\nsoul text",
    ]);
  });

  test("a vendor without one reports `user`, and the soul stays out of argv", async () => {
    const fileOnly = stubSpec(binary, {
      identity: { strength: "user", instructionFiles: ["./AGENTS.md"] },
    });
    const result = await new CliExec(fileOnly).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      system: "# Example Keeper\n\nsoul text",
      env: { HOME: await tempHome() },
    });

    // The identity had to already be on disk. Saying `user` is the report
    // being honest about a weaker channel rather than flattening the two.
    expect(result.identityStrength).toBe("user");
    expect(seen(result.text).argv).toEqual(["-p", "anything"]);
    expect(result.text).not.toContain("Example Keeper");
  });

  test("no soul offered is `none`, not a quiet `user`", async () => {
    const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(result.identityStrength).toBe("none");
  });

  test("a failed spawn reports `none`, with or without a system prompt", async () => {
    // This used to report the channel the argv *would* have used, and was
    // pinned as "today's behaviour — and it is odd" while the task that found
    // it stayed in scope. It is corrected now: no process started, so nothing
    // was delivered at any strength, and saying otherwise is a report about a
    // delivery that never happened.
    const withSoul = await new CliExec(stubSpec(stubName())).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      system: "# Example Keeper",
      env: { HOME: await tempHome() },
    });
    expect(withSoul.identityStrength).toBe("none");

    const without = await new CliExec(stubSpec(stubName())).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(without.identityStrength).toBe("none");
  });
});

describe("CliExec never returns `failed`", () => {
  test("every shape this stub can produce comes back confirmed or silent", async () => {
    // The rule `backend.ts` states in prose: this layer can tell "a reply
    // arrived" from "nothing did", and cannot tell whether a reply is right.
    const outcomes = new Set<string>();
    for (const mode of ["reflect", "silent", "unauthenticated", "hang"]) {
      const result = await new CliExec(stubSpec(binary)).run({ restraint: RESTRAINED,
        subject: SUBJECT,
        prompt: "anything",
        timeoutMs: mode === "hang" ? 250 : 5_000,
        env: { HOME: await tempHome(), MIND_STUB_MODE: mode },
      });
      outcomes.add(result.confidence);
    }
    // And the binary that is not there at all.
    outcomes.add(
      (
        await new CliExec(stubSpec(stubName())).run({ restraint: RESTRAINED,
          subject: SUBJECT,
          prompt: "anything",
          env: { HOME: await tempHome() },
        })
      ).confidence,
    );

    expect([...outcomes].sort()).toEqual(["confirmed", "silent"]);
  }, 20_000);
});

/** A profile-file mechanism, kimi-shaped (D-120), synthetic. */
const PROFILE: ReadOnlySpec & { readonly kind: "agent-file" } = {
  kind: "agent-file",
  flag: "--agent-file",
  values: ["~/.local/state/mind/vendors/stub/readonly-agent.md"],
  content: "---\nname: stub-readonly\ntools:\n  - Read\n---\n${base_prompt}\n",
  evidence: "probed",
};

/** A stub held by {@link PROFILE}, whose argv carries it the way kimi's does. */
function profiled(): VendorSpec {
  return stubSpec(binary, {
    readOnly: PROFILE,
    headlessArgv: ({ prompt, restraint }) => ["-p", prompt, ...restraintArgs(PROFILE, restraint)],
  });
}

describe("a profile file is written before every restrained turn (D-120)", () => {
  const where = (home: string) => join(home, ".local", "state", "mind", "vendors", "stub", "readonly-agent.md");

  test("a restrained turn rewrites the profile in the child's home, private, and names it verbatim", async () => {
    const home = await tempHome();
    // What a level-2 turn with a shell could have left behind.
    await mkdir(join(where(home), ".."), { recursive: true });
    await writeFile(where(home), "---\nname: stub-readonly\ntools:\n  - Bash\n---\n");

    const result = await new CliExec(profiled()).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: home },
    });

    expect(result.confidence).toBe("confirmed");
    expect(await readFile(where(home), "utf8")).toBe(PROFILE.content);
    expect((await stat(where(home))).mode & 0o777).toBe(0o600);
    // The `~/` goes through untouched: the vendor expands it against the
    // same HOME the file was written under.
    expect(seen(result.text).argv).toEqual(["-p", "anything", "--agent-file", PROFILE.values[0]]);
  });

  test("a fresh home gets a private directory for it", async () => {
    const home = await tempHome();
    await new CliExec(profiled()).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "p", env: { HOME: home } });
    expect((await stat(join(where(home), ".."))).mode & 0o777).toBe(0o700);
  });

  test("a loosened turn writes no profile and names none", async () => {
    const home = await tempHome();
    const result = await new CliExec(profiled()).run({
      restraint: LOOSENED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: home },
    });
    expect(result.confidence).toBe("confirmed");
    expect(seen(result.text).argv).toEqual(["-p", "anything"]);
    expect(await Bun.file(where(home)).exists()).toBe(false);
  });

  test("a HOME that is not an absolute path means the turn does not run", async () => {
    // Given "" or a relative HOME, the vendor resolves `~/` against its working
    // directory — one a repository controls — while Mind would write
    // somewhere else. Refused before either happens.
    for (const home of ["", "relative/home"]) {
      const result = await new CliExec(profiled()).run({
        restraint: RESTRAINED,
        subject: SUBJECT,
        prompt: "anything",
        env: { HOME: home },
      });
      expect(result.confidence, home).toBe("silent");
      expect(result.evidence.exitCode).toBeUndefined();
      expect(result.evidence.raw).toContain("not an absolute path");
    }
  });

  test("a directory planted at the profile's path is refused, and leaves no temporary file", async () => {
    const home = await tempHome();
    await mkdir(where(home), { recursive: true });
    const result = await new CliExec(profiled()).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: home },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("could not be written");
    const left = await readdir(join(where(home), ".."));
    expect(left.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a profile directory someone opened up is closed again", async () => {
    const home = await tempHome();
    await mkdir(join(where(home), ".."), { recursive: true, mode: 0o777 });
    await chmod(join(where(home), ".."), 0o777);
    await new CliExec(profiled()).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "p", env: { HOME: home } });
    expect((await stat(join(where(home), ".."))).mode & 0o777).toBe(0o700);
  });

  test("a profile that cannot be written means the turn does not run", async () => {
    const home = await tempHome();
    // A file where the directory has to go: `mkdir` cannot get past it.
    await writeFile(join(home, ".local"), "not a directory");
    const result = await new CliExec(profiled()).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: home },
    });
    expect(result.confidence).toBe("silent");
    expect(result.identityStrength).toBe("none");
    expect(result.evidence.exitCode).toBeUndefined();
    expect(result.evidence.raw).toContain("could not be written");
  });
});

describe("a vendor's hardening switches reach the child, over the caller's (S12.6)", () => {
  test("the switch is set in the child, and a caller's value for it does not win", async () => {
    const spec = stubSpec(binary, {
      hardening: { args: [], env: { MIND_STUB_MARKER: "hardened" }, why: "a synthetic switch for this test" },
    });
    const result = await new CliExec(spec).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome(), MIND_STUB_MARKER: "caller" },
    });
    expect(result.confidence).toBe("confirmed");
    expect(seen(result.text).marker).toBe("hardened");
  });

  test("the subject still goes last, over a hardening list too", async () => {
    const spec = stubSpec(binary, {
      hardening: { args: [], env: { MIND_SUBJECT: "someone-else" }, why: "a synthetic switch for this test" },
    });
    const result = await new CliExec(spec).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(seen(result.text).subject).toBe(SUBJECT);
  });
});

describe("a turn the vendor says it did not finish is silent (S12.6)", () => {
  const finishing = () => stubSpec(binary, { completion: { pointer: "/stopReason", value: "end_turn" } });

  test("exit 0 with a sentence, and a stop reason that is not the finished one", async () => {
    const result = await new CliExec(finishing()).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome(), MIND_STUB_STOP: "cancelled" },
    });
    expect(result.evidence.exitCode).toBe(0);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toStartWith('ended "cancelled", not "end_turn"');
  });

  test("the finished value, and no value at all, are both still answers", async () => {
    for (const stop of ["end_turn", ""]) {
      const result = await new CliExec(finishing()).run({
        restraint: RESTRAINED,
        subject: SUBJECT,
        prompt: "anything",
        env: { HOME: await tempHome(), MIND_STUB_STOP: stop },
      });
      expect(result.confidence, stop).toBe("confirmed");
    }
  });

  test("a cap hit keeps its stderr, so it is not mistaken for an approval cancel", async () => {
    const result = await new CliExec(finishing()).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: {
        HOME: await tempHome(),
        MIND_STUB_STOP: "cancelled",
        MIND_STUB_EXIT: "1",
        MIND_STUB_STDERR: "Error: max turns reached",
      },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toStartWith('ended "cancelled", not "end_turn"\nError: max turns reached\n');
  });

  test("exit 0 with the reply field blank is silent, not the JSON handed on as an answer", async () => {
    const result = await new CliExec(stubSpec(binary)).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome(), MIND_STUB_BLANK: "1" },
    });
    expect(result.evidence.exitCode).toBe(0);
    expect(result.text).toBe("");
    expect(result.confidence).toBe("silent");
  });
});

describe("the autonomy dial, at the one place it can be silently wrong", () => {
  test("a vendor with no read-only mechanism is refused at level 1, not run hopefully", async () => {
    // The hole S5.1 closes. Before E5 this turn ran exactly as any other: there
    // was no flag to add for a `none` vendor, and nothing said so. A dial that
    // reports 1 while one path through the program behaves like 3 is the lie
    // this refusal exists to make impossible.
    const spec = stubSpec(binary, { readOnly: NO_MECHANISM });
    const result = await new CliExec(spec).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });

    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    // Nothing started, so the identity reached nowhere — the same answer a
    // failed spawn gives, rather than the channel it would have used.
    expect(result.identityStrength).toBe("none");
    expect(result.evidence.exitCode).toBeUndefined();
    // The vendor's own words, verbatim: one sentence about this hole in the
    // program, not two that can drift apart.
    expect(result.evidence.raw).toContain(NO_MECHANISM.why);
    expect(result.evidence.raw).toContain("refused by the autonomy dial");
  });

  test("…and runs at level 2, which is what raising the dial is for", async () => {
    // The control. Without it the case above would pass just as happily over a
    // `run` that had stopped running anything at all.
    const spec = stubSpec(binary, { readOnly: NO_MECHANISM });
    const result = await new CliExec(spec).run({
      restraint: LOOSENED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });

    expect(result.confidence).toBe("confirmed");
    expect(result.evidence.exitCode).toBe(0);
  });

  test("level 0 refuses every vendor, mechanism or not", async () => {
    const result = await new CliExec(stubSpec(binary)).run({
      restraint: SILENT,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("the autonomy dial is at 0");
  });
});

/** Strings no CLI may be handed as a model: a flag, a shell, a second argument, a line break, a parameter. */
const HOSTILE_MODELS = [
  "-rf",
  "--dangerously-skip-permissions",
  "-",
  "opus --tools Bash",
  "opus;rm -rf /",
  "$(id)",
  "`id`",
  "opus\n--yes",
  "opus\u0000",
  "'opus'",
  '"opus"',
  "opus=x",
  "claude=opus,ollama=x",
  "../../etc/passwd",
  "~/.ssh/id_ed25519",
  "é-model",
  "‮opus",
  "a".repeat(129),
];

describe("D-142 — a model bound to this backend reaches its CLI, and only as the model", () => {
  test("the model the backend was built with goes on argv as one element after the flag; the request's own wins", async () => {
    const home = await tempHome();
    const bound = new CliExec(stubSpec(binary), undefined, { model: "claude-opus-5" });
    expect(bound.model).toBe("claude-opus-5");
    const result = await bound.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "anything", env: { HOME: home } });
    expect(result.confidence).toBe("confirmed");
    expect(seen(result.text).argv).toEqual(["-p", "anything", "--model", "claude-opus-5"]);
    expect(result.evidence.model).toEqual({ requested: "claude-opus-5", reported: [] });

    // A caller running this one backend directly may name another; that is the one it gets.
    const direct = await bound.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "anything", model: "haiku", env: { HOME: home } });
    expect(seen(direct.text).argv).toEqual(["-p", "anything", "--model", "haiku"]);
    expect(direct.evidence.model?.requested).toBe("haiku");

    // No model, no flag — and the result says nothing was asked for.
    const plain = await new CliExec(stubSpec(binary), undefined, { model: "" }).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "anything", env: { HOME: home } });
    expect(seen(plain.text).argv).toEqual(["-p", "anything"]);
    expect(plain.evidence.model).toEqual({ requested: null, reported: [] });
  });

  test("a vendor with no model flag refuses a turn that names one — nothing is spawned, nothing runs on its default", async () => {
    const spec = modelless(stubSpec(binary));
    const result = await new CliExec(spec, undefined, { model: "opus" }).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: { HOME: await tempHome() },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("takes no model");
    // No exit code: no process was started.
    expect(result.evidence.exitCode).toBeUndefined();
    expect(result.evidence.model).toEqual({ requested: "opus", reported: [] });
    // And the same vendor with no model named runs as before.
    const control = await new CliExec(spec).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "anything", env: { HOME: await tempHome() } });
    expect(control.confidence).toBe("confirmed");
  });

  test("a hostile model string is refused before anything is spawned", async () => {
    for (const model of HOSTILE_MODELS) {
      const result = await new CliExec(stubSpec(binary), undefined, { model }).run({
        restraint: RESTRAINED,
        subject: SUBJECT,
        prompt: "anything",
        env: { HOME: await tempHome() },
      });
      expect(result.confidence, JSON.stringify(model)).toBe("silent");
      expect(result.evidence.raw, JSON.stringify(model)).toStartWith("refused: the model ");
      expect(result.evidence.exitCode, JSON.stringify(model)).toBeUndefined();
    }
  });

  test("the model the output names is recorded as reported, apart from the one asked for", async () => {
    const result = await new CliExec(stubSpec(binary), undefined, { model: "opus" }).run({
      restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "anything",
      env: {
        HOME: await tempHome(),
        MIND_STUB_MODEL_USAGE: JSON.stringify({ "claude-opus-5-5-20260901": { inputTokens: 3, canonicalModel: "claude-opus-5-5" } }),
      },
    });
    expect(result.confidence).toBe("confirmed");
    expect(result.evidence.model).toEqual({ requested: "opus", reported: ["claude-opus-5-5"] });
  });
});

describe("reportedModels — what a CLI's output says it ran (D-142)", () => {
  const spec = stubSpec("unused");
  const out = (modelUsage: unknown) => JSON.stringify({ result: "ok", modelUsage });

  test("the canonical name where the entry has one, else the key, in the order printed", () => {
    // claude 2.1.283, measured: the key is the dated API id, the canonical name is the price list's.
    expect(reportedModels(spec, out({ "claude-haiku-4-5-20251001": { canonicalModel: "claude-haiku-4-5" } }))).toEqual(["claude-haiku-4-5"]);
    // grok 1.0.40, measured: no canonical field, the key is the id the CLI sent.
    expect(reportedModels(spec, out({ "grok-4.7": { inputTokens: 1 } }))).toEqual(["grok-4.7"]);
    expect(reportedModels(spec, out({ a: { canonicalModel: "" }, b: { canonicalModel: 7 }, c: null }))).toEqual(["a", "b", "c"]);
    // Two models is two, never one.
    expect(reportedModels(spec, out({ "claude-opus-5-5": {}, "claude-haiku-4-5": {} }))).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);
  });

  test("a name that is not a model's shape keeps its slot as null, and is never copied", () => {
    expect(reportedModels(spec, out({ "-rf": {} }))).toEqual([null]);
    expect(reportedModels(spec, out({ "claude-opus-5": {}, "x\u001b[31m": {} }))).toEqual(["claude-opus-5", null]);
    expect(reportedModels(spec, out({ ok: { canonicalModel: "bad name" } }))).toEqual([null]);
  });

  test("nothing declared, nothing printed, or nothing readable: an empty list", () => {
    expect(reportedModels({ ...spec, model: { ...STUB_MODEL, reported: null } }, out({ a: {} }))).toEqual([]);
    expect(reportedModels(modelless(spec), out({ a: {} }))).toEqual([]);
    expect(reportedModels(spec, "not json")).toEqual([]);
    expect(reportedModels(spec, JSON.stringify({ result: "ok" }))).toEqual([]);
    expect(reportedModels(spec, out(["claude-opus-5"]))).toEqual([]);
    expect(reportedModels(spec, out("claude-opus-5"))).toEqual([]);
    expect(reportedModels(spec, out({}))).toEqual([]);
    // A notice line before the document is still read past, as for the reply.
    expect(reportedModels(spec, `update available\n${out({ "claude-opus-5": {} })}`)).toEqual(["claude-opus-5"]);
  });
});

const TOKEN = "ab".repeat(32);

describe("a turn handed a task's browser (D-155)", () => {
  test("claude gets the one-server config with the task's token, the strict switch, and operate 1's look tools only", async () => {
    const dir = await tempHome();
    const exec = new CliExec(stubSpec(binary, { id: "claude" }));
    const result = await exec.run({
      subject: subjectId("browser-wired"),
      prompt: "open the page",
      restraint: operating(1),
      browser: { port: 30_735, dir, token: TOKEN, operate: 2 },
    });
    expect(result.confidence).toBe("confirmed");
    const argv = seen(result.text).argv;
    const config = join(dir, "claude-mcp.json");
    expect(argv.slice(-2)).toEqual(["--mcp-config", config]);
    expect(argv).toContain("--strict-mcp-config");
    const allowed = argv[argv.indexOf("--allowedTools") + 1]!.split(",");
    expect(allowed).toContain("mcp__mind-browser__browser_navigate");
    expect(allowed).not.toContain("mcp__mind-browser__browser_click");
    expect(allowed).not.toContain("mcp__mind-browser");
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: {
        "mind-browser": { type: "http", url: "http://127.0.0.1:30735/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
    expect(argv.join(" ")).not.toContain(TOKEN);
    expect((await stat(config)).mode & 0o777).toBe(0o600);
  });

  test("a vendor with no measured way to take only Mind's server is refused, and nothing runs", async () => {
    const dir = await tempHome();
    const result = await new CliExec(stubSpec(binary, { id: "kimi" })).run({
      subject: subjectId("browser-refused"),
      prompt: "open the page",
      restraint: operating(1),
      browser: { port: 30_735, dir, token: TOKEN, operate: 2 },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("refused: no browser for kimi");
    expect(await readdir(dir)).toEqual([]);
  });

  test("a config that cannot be written refuses the turn", async () => {
    const home = await tempHome();
    const blocker = join(home, "a-file");
    await writeFile(blocker, "x");
    const result = await new CliExec(stubSpec(binary, { id: "claude" })).run({
      subject: subjectId("browser-unwritable"),
      prompt: "open the page",
      restraint: operating(1),
      browser: { port: 30_735, dir: join(blocker, "below"), token: TOKEN, operate: 2 },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("the browser's MCP config could not be written");
  });

  test("a turn whose operate level is 0 gets no browser, and nothing runs", async () => {
    const dir = await tempHome();
    const result = await new CliExec(stubSpec(binary, { id: "claude" })).run({
      subject: subjectId("browser-operate-0"),
      prompt: "open the page",
      restraint: RESTRAINED,
      browser: { port: 30_735, dir, token: TOKEN, operate: 2 },
    });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("operate is 0");
    expect(await readdir(dir)).toEqual([]);
  });
});
