/** S21.7 — the proof record: what it binds to, and every way it stops validating. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, checkProof, CONTROLS, engineIdentity, PROOF_FILE, PROOF_SCHEMA, proofDigest, proofLines, sealProof, sourceDigest, writeProof, type Control, type EngineIdentity, type ProofFields } from "../../../src/soul/tune/proof.ts";
import { VERSION } from "../../../src/version.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mind-proof-"));
  dirs.push(d);
  return d;
};

const ENGINE: EngineIdentity = { version: VERSION, gitSha: "a".repeat(40), sourceSha256: "b".repeat(64) };
const all = (v: boolean) => Object.fromEntries(CONTROLS.map((c) => [c, v])) as Record<Control, boolean>;
const evidence = Object.fromEntries(CONTROLS.map((c) => [c, `evidence of ${c}`])) as Record<Control, string>;
const fields = (over: Partial<ProofFields> = {}): ProofFields => ({ schema: PROOF_SCHEMA, engine: ENGINE, controls: all(true), twins: all(true), evidence, provedAt: "2026-10-20T00:00:00.000Z", ...over });
const put = async (dir: string, record: unknown) => writeFile(join(dir, PROOF_FILE), JSON.stringify(record));
const why = async (dir: string, engine = ENGINE) => {
  const s = await checkProof(dir, engine);
  return s.ok ? "ok" : s.reason;
};

describe("checkProof", () => {
  test("a sealed proof of this engine, every control passed and every twin caught, is valid and says when and what was seen", async () => {
    const dir = await tmp();
    await put(dir, sealProof(fields()));
    const state = await checkProof(dir, ENGINE);
    expect(state).toEqual({ ok: true, provedAt: "2026-10-20T00:00:00.000Z", evidence });
    expect(proofLines(state, ENGINE).join("\n")).toContain("VALID");
    expect(proofLines(state, ENGINE).join("\n")).toContain("tamper-evidence against accidents, not security");
  });

  test("no file, a file that is not JSON and an older schema each say what to do", async () => {
    const dir = await tmp();
    expect(await why(dir)).toContain(`there is no proof record at ${join(dir, PROOF_FILE)}`);
    await writeFile(join(dir, PROOF_FILE), "not json");
    expect(await why(dir)).toContain("there is no proof record");
    await put(dir, { schema: "mind/tuner-proof@1", engine: { version: VERSION, gitSha: null }, controls: all(true), provedAt: "2026-10-20T00:00:00Z" });
    expect(await why(dir)).toContain(`not a ${PROOF_SCHEMA} record`);
    const state = await checkProof(dir, ENGINE);
    expect(state.ok ? null : state.provedAt).toBeNull();
  });

  test("a hand-made record: fields edited after sealing, a digest copied from another record, no digest", async () => {
    const dir = await tmp();
    const sealed = sealProof(fields({ controls: { ...all(true), leak: false } }));
    await put(dir, { ...sealed, controls: all(true) });
    expect(await why(dir)).toContain("does not match its own digest");
    await put(dir, { ...sealProof(fields()), provedAt: "2030-01-01T00:00:00.000Z" });
    expect(await why(dir)).toContain("does not match its own digest");
    await put(dir, { ...fields(), digest: sealProof(fields({ provedAt: "x" })).digest });
    expect(await why(dir)).toContain("does not match its own digest");
    const { digest: _digest, ...bare } = sealProof(fields());
    await put(dir, bare);
    expect(await why(dir)).toContain(`not a ${PROOF_SCHEMA} record`);
    // The record on disk says when it claims to have been made, even when it is refused.
    await put(dir, { ...sealed, controls: all(true) });
    expect((await checkProof(dir, ENGINE) as { provedAt: string }).provedAt).toBe("2026-10-20T00:00:00.000Z");
  });

  test("another version, another commit, another tuner source", async () => {
    const dir = await tmp();
    await put(dir, sealProof(fields()));
    expect(await why(dir, { ...ENGINE, version: "0.0.1" })).toContain("for this engine");
    expect(await why(dir, { ...ENGINE, gitSha: "d".repeat(40) })).toContain("for this engine");
    expect(await why(dir, { ...ENGINE, gitSha: null })).toContain("for this engine");
    expect(await why(dir, { ...ENGINE, sourceSha256: "e".repeat(64) })).toContain("its source changed since the proof was made");
    expect(await why(dir, { ...ENGINE, sourceSha256: null })).toContain("no source checkout to digest");
  });

  test("a failed control, and a twin that was not caught, each keep it shut", async () => {
    const dir = await tmp();
    await put(dir, sealProof(fields({ controls: { ...all(true), good: false, leak: false } })));
    expect(await why(dir)).toContain("control(s) not passed: good, leak");
    await put(dir, sealProof(fields({ twins: { ...all(true), harmful: false } })));
    expect(await why(dir)).toContain("sabotaged twin(s) not caught, so the control cannot tell: harmful");
    const lines = proofLines(await checkProof(dir, ENGINE), ENGINE).join("\n");
    expect(lines).toContain("NONE VALID");
    expect(lines).toContain("the record on disk says it was made 2026-10-20");
    expect(lines).toContain("adopt is shut");
  });
});

describe("the digest and the source digest", () => {
  test("canonical is key-order independent; the digest covers every field", () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    const base = proofDigest(fields());
    expect(proofDigest(fields({ evidence: { ...evidence, noop: "other" } }))).not.toBe(base);
    expect(proofDigest(fields({ twins: { ...all(true), leak: false } }))).not.toBe(base);
    expect(proofDigest(fields({ engine: { ...ENGINE, sourceSha256: "c".repeat(64) } }))).not.toBe(base);
    expect(proofDigest({ ...fields(), extra: 1 } as ProofFields)).toBe(base);
  });

  test("sourceDigest changes with any file the verdict depends on, and with nothing else", async () => {
    const root = await tmp();
    for (const dir of ["src/soul/tune", "src/soul/tune/deep"]) await mkdir(join(root, dir), { recursive: true });
    const write = (path: string, text: string) => writeFile(join(root, path), text);
    await write("src/soul/tune/a.ts", "a");
    await write("src/soul/tune/deep/b.ts", "b");
    await write("src/soul/tune/note.md", "not source");
    await write("src/soul/eval-compare.ts", "select");
    await write("src/soul/evals.ts", "evals");
    const first = await sourceDigest(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await sourceDigest(root)).toBe(first);
    await write("src/soul/tune/note.md", "still not source");
    await write("src/soul/other.ts", "unrelated");
    expect(await sourceDigest(root)).toBe(first);
    for (const [path, text] of [["src/soul/eval-compare.ts", "always adopt"], ["src/soul/tune/deep/b.ts", "b2"], ["src/soul/evals.ts", "e2"], ["src/soul/tune/a.ts", "a2"]] as const) {
      const before = await sourceDigest(root);
      await write(path, text);
      expect(await sourceDigest(root)).not.toBe(before);
    }
    expect(await sourceDigest(join(root, "nowhere"))).toBeNull();
  });

  test("engineIdentity: this checkout has a commit and a digest; a plain directory has no commit; a build off disk has neither", async () => {
    const here = await engineIdentity(ROOT);
    expect(here.version).toBe(VERSION);
    expect(here.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(here.sourceSha256).toBe(await sourceDigest(ROOT));
    expect(await engineIdentity(undefined)).toEqual({ version: VERSION, gitSha: null, sourceSha256: null });
    expect(await engineIdentity(await tmp())).toEqual({ version: VERSION, gitSha: null, sourceSha256: null });
  });
});

describe("writeProof", () => {
  test("the directory 0700, the file 0600, the content the sealed record", async () => {
    const root = await tmp();
    const runs = join(root, "data", "evals");
    const proof = sealProof(fields());
    const path = await writeProof(runs, proof);
    expect(path).toBe(join(runs, PROOF_FILE));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(runs)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(proof);
    expect((await checkProof(runs, ENGINE)).ok).toBe(true);
  });
});
