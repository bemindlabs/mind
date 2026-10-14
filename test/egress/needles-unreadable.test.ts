/** EEA-05 — a needles file that is there and cannot be read is not "no needles". */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Availability, ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import { AnnouncedExec } from "../../src/exec/egress.ts";
import { describeFindings, screen } from "../../src/egress/filter.ts";
import { EGRESS_DIR, loadLexicon, NEEDLES_FILE } from "../../src/egress/store.ts";
import { personalDir } from "../../src/guard/personal.ts";
import { subjectId } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";

const SUBJECT = subjectId("example");
const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function env() {
  const home = await mkdtemp(join(tmpdir(), "mind-egress-unreadable-"));
  scratch.push(home);
  return { home, env: { XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state") } };
}

const REQUEST: TurnRequest = { subject: SUBJECT, prompt: "what is the capital of nowhere", system: "# Keeper", restraint: RESTRAINED };

/** A cloud backend that says whether it was ever handed the prompt. */
function cloud(log: string[]): ExecBackend {
  return {
    id: "claude",
    display: "Claude",
    kind: "cli",
    identityStrength: "system",
    available: async (): Promise<Availability> => ({ ok: true, detail: "ready" }),
    run: async (): Promise<TurnResult> => {
      log.push("run");
      return { backend: "claude", text: "hi", confidence: "confirmed", evidence: { source: "claude", prompt: "", raw: "" }, identityStrength: "system" };
    },
  } as unknown as ExecBackend;
}

describe("loadLexicon: only a file that is not there means no needles", () => {
  test("no file at all is the owner's choice: nothing flagged, nothing blocked", async () => {
    const e = await env();
    const { lexicon } = await loadLexicon(e, SUBJECT, []);
    expect(lexicon.unreadable).toBeUndefined();
    expect(screen("what is the capital of nowhere", lexicon)).toEqual([]);
  });

  test("a directory where the file should be: said, and every text stays in", async () => {
    const e = await env();
    const dir = await personalDir(e, SUBJECT);
    await mkdir(join(dir.path, EGRESS_DIR, NEEDLES_FILE), { recursive: true });
    const { lexicon, source } = await loadLexicon(e, SUBJECT, ["Wanida Srisuk"]);
    expect(source).toBeNull();
    expect(lexicon.unreadable).toContain(NEEDLES_FILE);
    expect(lexicon.unreadable).toContain("could not be read");
    // The soul's inherited names still count beside it.
    expect(lexicon.needles).toEqual(["Wanida Srisuk"]);
    expect(screen("the weather is fine", lexicon)).toEqual([{ rule: "needles-unreadable" }]);
    expect(describeFindings(screen("the weather is fine", lexicon))).toContain("could not be read");
  });

  test("a path component that is a file, not a directory, is unreadable too", async () => {
    const e = await env();
    const dir = await personalDir(e, SUBJECT);
    await mkdir(dir.path, { recursive: true });
    await Bun.write(join(dir.path, EGRESS_DIR), "not a directory");
    const { lexicon } = await loadLexicon(e, SUBJECT, []);
    expect(lexicon.unreadable).toBeDefined();
    expect(screen("anything", lexicon).map((f) => f.rule)).toContain("needles-unreadable");
  });

  test("a personal directory inside a git checkout is refused, and that is said, not skipped", async () => {
    const e = await env();
    await mkdir(join(e.home, ".git"), { recursive: true });
    const { lexicon } = await loadLexicon(e, SUBJECT, []);
    expect(lexicon.unreadable).toContain("git repository");
    expect(screen("anything", lexicon)).toEqual([{ rule: "needles-unreadable" }]);
  });

  test("a file that reads is applied as before, with nothing marked unreadable", async () => {
    const e = await env();
    const dir = await personalDir(e, SUBJECT);
    await mkdir(join(dir.path, EGRESS_DIR), { recursive: true });
    await Bun.write(join(dir.path, EGRESS_DIR, NEEDLES_FILE), "secret one\n");
    const { lexicon } = await loadLexicon(e, SUBJECT, []);
    expect("unreadable" in lexicon).toBe(false);
    expect(screen("tell secret one", lexicon)).toEqual([{ rule: "needle", needle: 1 }]);
    expect(screen("tell nobody", lexicon)).toEqual([]);
  });
});

describe("the gate a turn goes through", () => {
  test("a cloud backend is not handed the prompt, and the owner is told why, while the needles cannot be read", async () => {
    const e = await env();
    const dir = await personalDir(e, SUBJECT);
    await mkdir(join(dir.path, EGRESS_DIR, NEEDLES_FILE), { recursive: true });
    const { lexicon } = await loadLexicon(e, SUBJECT, []);
    const log: string[] = [];
    const told: string[] = [];
    const kept = new AnnouncedExec(cloud(log), {
      origin: cloud(log),
      write: (line) => told.push(line),
      screen: (request) => screen(request.prompt, lexicon),
    });
    const out = await kept.run(REQUEST);
    expect(out.confidence).toBe("failed");
    expect(log).toEqual([]);
    expect(told.join("\n")).toContain("could not be read");
  });
});
