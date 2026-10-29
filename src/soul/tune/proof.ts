/**
 * S21.7 (D-195) — the tuner's proof record, and the check `adopt` makes of it.
 *
 * `personal/evals/tuner-proof.json` (`mind/tuner-proof@2`) says: on this engine, the four controls of
 * `selftest.ts` passed and each of their sabotaged twins failed. It binds to
 *
 * - the engine's version and git commit (D-193's binding),
 * - `sourceSha256`, a digest of the files the tuner's verdict depends on ({@link PROOF_SOURCES}: everything
 *   under `src/soul/tune/`, the T6 rule in `eval-compare.ts`, and `evals.ts` for the split and the held-out
 *   minimum), so editing the tuner voids the proof even when the commit is the same (an uncommitted edit),
 * - `digest`, a sha256 over every other field, so a record edited by hand (a control flipped to true, a
 *   date changed) no longer validates.
 *
 * **What this is not.** It is tamper-evidence against accidents and against a careless edit. It is not
 * security: the owner, or an agent running as the owner, can read this file, run `sealProof`, and write a
 * record that validates, because nothing here is secret. The gate asks that a proof was *made by running
 * the controls on this code*; it cannot ask that nobody forged one.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { VERSION } from "../../version.ts";
import { privateDir } from "../eval-runs.ts";
import { replaceFile } from "../../task/store.ts";
import { git } from "./git.ts";

export const PROOF_SCHEMA = "mind/tuner-proof@2";
export const PROOF_FILE = "tuner-proof.json";
/** S21.7's four controls: (a) a no-op proposer keeps the base, (b) a planted good edit is adopted, (c) a planted harmful edit is rejected, (d) no expect, reject, held-out or person.md text reaches the proposer. */
export const CONTROLS = ["noop", "good", "harmful", "leak"] as const;
export type Control = (typeof CONTROLS)[number];

/** The files the proof's source digest covers: a directory (every `.ts` under it) or a file, relative to the engine checkout. */
export const PROOF_SOURCES: readonly string[] = ["src/soul/tune", "src/soul/eval-compare.ts", "src/soul/evals.ts"];

export interface EngineIdentity {
  readonly version: string;
  /** The engine's git commit when it runs from a checkout; null for a build that has none. */
  readonly gitSha: string | null;
  /** {@link sourceDigest} of the checkout; null for a build that is not on disk (nothing to hash, so no proof can be made or honoured). */
  readonly sourceSha256: string | null;
}

export interface ProofFields {
  readonly schema: typeof PROOF_SCHEMA;
  readonly engine: EngineIdentity;
  /** Each real control passed. */
  readonly controls: Readonly<Record<Control, boolean>>;
  /** Each sabotaged twin failed its control, as it must. */
  readonly twins: Readonly<Record<Control, boolean>>;
  /** One line per control: what was observed. */
  readonly evidence: Readonly<Record<Control, string>>;
  readonly provedAt: string;
}

export interface Proof extends ProofFields {
  /** sha256 over {@link canonical} of every other field. */
  readonly digest: string;
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** JSON with object keys in sorted order, so the same fields always give the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The fields of a record, in the shape the digest covers; anything else in the file is ignored by it and rejected by the check. */
function fieldsOf(p: ProofFields): ProofFields {
  return { schema: p.schema, engine: { version: p.engine.version, gitSha: p.engine.gitSha, sourceSha256: p.engine.sourceSha256 }, controls: p.controls, twins: p.twins, evidence: p.evidence, provedAt: p.provedAt };
}

export const proofDigest = (fields: ProofFields): string => sha256(canonical(fieldsOf(fields)));

/** The record to write: the fields and their digest. */
export function sealProof(fields: ProofFields): Proof {
  return { ...fieldsOf(fields), digest: proofDigest(fields) };
}

async function sourceFiles(root: string, rel: string): Promise<string[]> {
  const full = join(root, rel);
  if (rel.endsWith(".ts")) return [rel];
  const out: string[] = [];
  for (const entry of await readdir(full, { withFileTypes: true })) {
    const name = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await sourceFiles(root, name)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(name);
  }
  return out;
}

/** sha256 over `path NUL bytes NUL` for each of {@link PROOF_SOURCES}' files in path order; null when the checkout cannot be read. */
export async function sourceDigest(engineRoot: string): Promise<string | null> {
  try {
    const files = (await Promise.all(PROOF_SOURCES.map((s) => sourceFiles(engineRoot, s)))).flat().sort();
    const hasher = new Bun.CryptoHasher("sha256");
    for (const file of files) {
      hasher.update(`${file}\0`);
      hasher.update(await Bun.file(join(engineRoot, file)).bytes());
      hasher.update("\0");
    }
    return files.length === 0 ? null : hasher.digest("hex");
  } catch {
    return null;
  }
}

/** This engine: its version, the commit of the checkout it runs from, and the digest of the tuner's sources; nulls for a build that is not on disk (`ENGINE_CHECKOUT` is undefined). */
export async function engineIdentity(engineRoot: string | undefined): Promise<EngineIdentity> {
  if (engineRoot === undefined) return { version: VERSION, gitSha: null, sourceSha256: null };
  const head = await git(engineRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return { version: VERSION, gitSha: head.code === 0 && /^[0-9a-f]{40}$/.test(head.out) ? head.out : null, sourceSha256: await sourceDigest(engineRoot) };
}

const closed = "the tuner has not been proved (S21.7)";
const short = (e: EngineIdentity) => `${e.version}${e.gitSha === null ? "" : ` @${e.gitSha.slice(0, 8)}`}`;

export type ProofState =
  | { readonly ok: true; readonly provedAt: string; readonly evidence: Readonly<Record<Control, string>> }
  | { readonly ok: false; readonly reason: string; /** When the record on disk says it was made, if it could be read. */ readonly provedAt: string | null };

/** Is there a proof for exactly this engine and this tuner source, unaltered, with every control and twin as required? Otherwise, why not. */
export async function checkProof(runsDir: string, engine: EngineIdentity): Promise<ProofState> {
  const path = join(runsDir, PROOF_FILE);
  let parsed: Partial<Proof>;
  try {
    parsed = JSON.parse(await Bun.file(path).text()) as Partial<Proof>;
  } catch {
    return { ok: false, reason: `${closed}: there is no proof record at ${path}`, provedAt: null };
  }
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (parsed.schema !== PROOF_SCHEMA || !object(parsed.engine) || !object(parsed.controls) || !object(parsed.twins) || !object(parsed.evidence) || typeof parsed.provedAt !== "string" || typeof parsed.digest !== "string") {
    return { ok: false, reason: `${closed}: ${PROOF_FILE} is not a ${PROOF_SCHEMA} record (an older or a hand-made file; run mind soul tune --selftest)`, provedAt: null };
  }
  const at = parsed.provedAt;
  const fields = parsed as Proof;
  if (proofDigest(fields) !== fields.digest) return { ok: false, reason: `${closed}: ${PROOF_FILE} does not match its own digest, so it was edited after it was made; run mind soul tune --selftest`, provedAt: at };
  if (fields.engine.version !== engine.version || fields.engine.gitSha !== engine.gitSha) {
    return { ok: false, reason: `${closed} for this engine: the proof is of ${short(fields.engine)}, this is ${short(engine)}`, provedAt: at };
  }
  if (engine.sourceSha256 === null) return { ok: false, reason: `${closed}: this build has no source checkout to digest, so no proof can bind to it`, provedAt: at };
  if (fields.engine.sourceSha256 !== engine.sourceSha256) return { ok: false, reason: `${closed} for this tuner: its source changed since the proof was made (${PROOF_SOURCES.join(", ")}); run mind soul tune --selftest`, provedAt: at };
  const failed = CONTROLS.filter((c) => fields.controls[c] !== true);
  if (failed.length > 0) return { ok: false, reason: `${closed}: control(s) not passed: ${failed.join(", ")}`, provedAt: at };
  const blind = CONTROLS.filter((c) => fields.twins[c] !== true);
  if (blind.length > 0) return { ok: false, reason: `${closed}: sabotaged twin(s) not caught, so the control cannot tell: ${blind.join(", ")}`, provedAt: at };
  return { ok: true, provedAt: at, evidence: fields.evidence };
}

/** Write the proof: the directory 0700, the file 0600, whole or not at all; its path. */
export async function writeProof(runsDir: string, proof: Proof): Promise<string> {
  await privateDir(join(runsDir, ".."));
  await privateDir(runsDir);
  const path = join(runsDir, PROOF_FILE);
  await replaceFile(path, `${JSON.stringify(proof, null, 2)}\n`);
  return path;
}

/** The proof as `mind soul tune proof` prints it. */
export function proofLines(state: ProofState, engine: EngineIdentity): string[] {
  if (!state.ok) return [`tuner proof: NONE VALID for mind ${short(engine)}`, `  why: ${state.reason}`, ...(state.provedAt === null ? [] : [`  the record on disk says it was made ${state.provedAt}`]), "  adopt is shut until it is: mind soul tune --selftest --subject <id>"];
  return [`tuner proof: VALID for mind ${short(engine)}, source ${engine.sourceSha256?.slice(0, 12)}`, `  made ${state.provedAt}; adopt is open`, ...CONTROLS.map((c) => `  ${c.padEnd(8)} ${state.evidence[c]}`), "  (tamper-evidence against accidents, not security: whoever runs as the owner can write a record that validates)"];
}
