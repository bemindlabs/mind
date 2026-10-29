/**
 * S21.7 (D-195) — `mind soul tune --selftest`: the tuner proves itself before it may adopt anything alone.
 *
 * Four controls run the real round (`runTune`: the real leak guard, T4 check, git plumbing, T6 rule and
 * adoption) on a throwaway agent repository made in a temp directory under the state root and removed on every
 * exit path. Only the two reaches to a model are faked: a scripted proposer, and a scripted eval engine that
 * grades by what the role body says (`RULE-<id>` passes a task, `BREAK-<id>` fails it, `FLAKY-<id>` passes it
 * on the first attempt only). No model, no network.
 *
 * | control | what must hold |
 * |---|---|
 * | (a) noop    | a proposer that returns the soul unchanged, says KEEP_BASE, or changes only wording keeps the base; nothing is adopted |
 * | (b) good    | a planted good edit is selected (held-out rises, no pass→fail) and adopt works end to end: a commit by the agent, with the run id, the SHAs and the numbers, and an owner notice |
 * | (c) harmful | a held-out regression, an overfit (train up, held-out down) and a stable pass turned flaky are each rejected with the reason |
 * | (d) leak    | with expect and reject phrases, held-out asks and person.md text planted, the real mission path in STRICT leak-guard mode hands the proposer none of them (scanned byte for byte, on what the fake proposer received) |
 *
 * **A control that cannot discriminate is a failure.** Each control also runs against a sabotaged twin and
 * must FAIL there: a selector that adopts on a tie (a), one that never adopts (b), one that always adopts (c),
 * a mission builder that leaks with the guard switched off (d). The twin swaps one part of the round
 * ({@link TuneParts}); everything else is the same code. A control that passes its twin is blind and the
 * selftest fails. The scan of (d) must also find the train asks in what the proposer received, so an empty
 * capture cannot pass.
 *
 * The proof is written by the caller ({@link proofOf}) only when every control passed and every twin failed.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../version.ts";
import { subjectId } from "../../types.ts";
import { selectByRule, type Selection } from "../eval-compare.ts";
import { evalRunRecord, repeatedReport, sha256, type EvalAttempt, type EvalRunRecord } from "../eval-runs.ts";
import { MODES, type EvalTask } from "../evals.ts";
import { missionFor, strictGuard } from "./candidate.ts";
import { adoptRun, type AdoptEnv } from "./adopt.ts";
import { blobAt, git, readCommit, TUNE_SCRATCH } from "./git.ts";
import { BODY_CLOSE, BODY_OPEN, type Dimension } from "./prompts.ts";
import { CONTROLS, PROOF_FILE, PROOF_SCHEMA, sealProof, type Control, type EngineIdentity, type Proof } from "./proof.ts";
import { readTuneRun, runTune, type TuneContext, type TuneDeps, type TuneOutcome, type TuneParts } from "./round.ts";

export interface ControlResult {
  readonly control: Control;
  readonly title: string;
  readonly pass: boolean;
  /** What was observed: on a pass the facts that were checked, on a fail every thing that was wrong. */
  readonly evidence: string;
}

export interface TwinResult {
  readonly control: Control;
  /** What was broken in the round for this twin. */
  readonly sabotage: string;
  /** The control failed on it, as it must. */
  readonly caught: boolean;
  readonly evidence: string;
}

export interface SelftestOutcome {
  readonly controls: readonly ControlResult[];
  readonly twins: readonly TwinResult[];
  /** Every control passed and every twin was caught. */
  readonly ok: boolean;
}

export interface SelftestOptions {
  /** The state root: the throwaway directory is made under `<stateRoot>/scratch/tune/`. */
  readonly stateRoot: string;
  /** The environment git runs in, read by the caller. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// The throwaway agent
// ---------------------------------------------------------------------------

const SUBJECT = subjectId("selftest");
const AGENT_EMAIL = `${SUBJECT}@agents.mind.invalid`;
const OWNER_EMAIL = "owner@selftest.invalid";

/** The engine identity the throwaway's own proof is sealed for: it gates only the throwaway's adopt. */
const THROWAWAY_ENGINE: EngineIdentity = { version: VERSION, gitSha: null, sourceSha256: sha256("mind soul tune --selftest") };

const ROLE = `+++
schema = "mind/soul-role@1"
subject = "selftest"
name = "Selftest Keeper"
role = "A throwaway agent that exists only while mind soul tune --selftest runs"
prohibitions = [
  "never touches anything outside its own throwaway directory",
]

[scope]
does = "answers the scripted questions of the tuner's controls"
does_not = "does not exist once the selftest ends"
+++

# Selftest Keeper — role knowledge

Procedures of a throwaway agent. This body is what the tuner may rewrite.

Known: RULE-t5 RULE-h3
`;

/** person.md, every line marked: none of it may reach the proposer (I-6). */
export const PERSON_NEEDLES: readonly string[] = ["PERSON-TONE-warm-b81", "PERSON-ADDRESS-comrade-b81", "PERSON-SELF-keeper-b81", "PERSON-PRINCIPLE-check-twice-b81", "PERSON-BODY-line-selftest-4c1d"];

const PERSON = `+++
schema = "mind/soul-person@1"
subject = "selftest"
tone = ["${PERSON_NEEDLES[0]}"]
addresses_user_as = "${PERSON_NEEDLES[1]}"
refers_to_self_as = ["${PERSON_NEEDLES[2]}"]
principles = ["${PERSON_NEEDLES[3]}"]
+++

# Selftest Keeper — personal traits

${PERSON_NEEDLES[4]}
`;

const TRAIN = ["t1", "t2", "t3", "t4", "t5"];
const HELD = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** Phrases that no scripted answer ever holds, and asks that name their side of the split. */
const task = (id: string, split: "train" | "heldout"): EvalTask => ({
  id,
  kind: "selftest",
  ask: `${split === "train" ? "TRAIN" : "HELDOUT"}-ASK-${id}-m2p: what is the procedure for ${id}?`,
  expect: [`zz-exp-${id}-q9x`],
  reject: [`zz-rej-${id}-q9x`],
  source: "",
  split,
});
const TASKS: readonly EvalTask[] = [...TRAIN.map((id) => task(id, "train")), ...HELD.map((id) => task(id, "heldout"))];
const SET_TEXT = "the selftest task set";
const REPEAT = 2;

interface Room {
  readonly dir: string;
  readonly agent: string;
  readonly soulDir: string;
  readonly state: string;
  readonly runs: string;
  readonly head: string;
  readonly baseRole: string;
  readonly baseBody: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

async function must(cwd: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const run = await git(cwd, args, env);
  if (run.code !== 0) throw new Error(`selftest: git ${args[0]} failed: ${run.err || `exit ${run.code}`}`);
  return run.out;
}

/** A new agent repository with one commit, made by plumbing (the guard allows no `add` or `commit`). */
async function makeRoom(root: string, label: string, options: SelftestOptions): Promise<Room> {
  const dir = join(root, label);
  const agent = join(dir, "agent");
  const soulDir = join(agent, "soul");
  const env = { ...options.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Selftest Owner", GIT_AUTHOR_EMAIL: OWNER_EMAIL, GIT_COMMITTER_NAME: "Selftest Owner", GIT_COMMITTER_EMAIL: OWNER_EMAIL };
  await mkdir(soulDir, { recursive: true });
  await mkdir(join(dir, "state"), { recursive: true });
  const files: readonly (readonly [string, string])[] = [
    ["soul/role.md", ROLE],
    ["soul/person.md", PERSON],
    ["soul/autonomy.md", "autonomy: unchanged\n"],
    [".gitignore", "/.mind/\n"],
  ];
  await must(agent, ["init", "-q"], env);
  for (const [path, text] of files) await writeFile(join(agent, path), text);
  for (const [path] of files) {
    const blob = await must(agent, ["hash-object", "-w", join(agent, path)], env);
    await must(agent, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
  }
  const tree = await must(agent, ["write-tree"], env);
  const head = await must(agent, ["commit-tree", tree, "-m", "the throwaway soul"], env);
  await must(agent, ["update-ref", "HEAD", head], env);
  return { dir, agent, soulDir, state: join(dir, "state"), runs: join(dir, "data", "evals"), head, baseRole: ROLE, baseBody: ROLE.slice(ROLE.indexOf("\n+++\n") + 5), env };
}

const withRules = (room: Room, ...tags: string[]): string => `${room.baseBody.trimEnd()}\nAdded: ${tags.join(" ")}\n`;

// ---------------------------------------------------------------------------
// The scripted eval engine and proposer
// ---------------------------------------------------------------------------

/** Does the agent wearing `body` answer `taskId` right on this attempt? BREAK beats RULE; FLAKY passes the first attempt only. */
export function scriptedPass(body: string, taskId: string, attempt: number): boolean {
  if (body.includes(`BREAK-${taskId}`)) return false;
  if (body.includes(`FLAKY-${taskId}`)) return attempt === 1;
  return body.includes(`RULE-${taskId}`);
}

async function scriptedRun(roleText: string, keep: boolean, tree: string | null): Promise<EvalRunRecord> {
  const rows: EvalAttempt[] = [];
  for (const t of TASKS) {
    for (const mode of MODES) {
      for (let attempt = 1; attempt <= REPEAT; attempt++) {
        const pass = scriptedPass(roleText, t.id, attempt);
        rows.push({ task: t.id, kind: t.kind, mode, attempt, split: t.split, pass, missing: [], rejected: [], route: "selftest", ...(keep ? { answer: `The scripted answer for ${t.id} is ${pass ? "correct" : "wrong"}.` } : {}) });
      }
    }
  }
  const soul = { gitTree: tree, dirty: false, contentSha256: sha256(roleText), files: ["role.md"] };
  return evalRunRecord({ startedAt: new Date(), subject: SUBJECT, soul, setText: SET_TEXT, backend: undefined, model: undefined, recallChars: 0, tasks: TASKS, split: "all", keptAnswers: keep, results: rows, report: repeatedReport(TASKS, rows, REPEAT) });
}

interface Seen {
  readonly dimension: Dimension;
  readonly attempt: number;
  /** What the proposer received, as bytes. */
  readonly bytes: Uint8Array;
}

type Proposer = (dimension: Dimension, attempt: number) => string;

const proposal = (body: string, notes = "scripted"): string => `${BODY_OPEN}\n${body.trim()}\n${BODY_CLOSE}\n<notes>\n${notes}\n</notes>`;
const KEEP = "KEEP_BASE\n<notes>\nscripted: nothing to change\n</notes>";

interface Played {
  readonly out: TuneOutcome;
  readonly seen: Seen[];
  /** What the reflection received (S21.6), as bytes: the second place a model reads what a round holds. */
  readonly reflected: Uint8Array[];
  readonly room: Room;
}

/** One real round on a new throwaway, with the scripted proposer and eval engine. */
async function play(root: string, label: string, options: SelftestOptions, proposer: Proposer, parts: TuneParts, room?: Room): Promise<Played> {
  const r = room ?? (await makeRoom(root, label, options));
  const seen: Seen[] = [];
  const reflected: Uint8Array[] = [];
  const deps: TuneDeps = {
    stopped: async () => false,
    propose: async (prompt, dimension, attempt) => {
      seen.push({ dimension, attempt, bytes: new TextEncoder().encode(prompt) });
      return proposer(dimension, attempt);
    },
    reflect: async (prompt) => {
      reflected.push(new TextEncoder().encode(prompt));
      return "<verdicts>\n</verdicts>\nNO_LESSON";
    },
    evalBase: async () => scriptedRun(r.baseRole, true, await must(r.agent, ["rev-parse", "HEAD:soul"], r.env)),
    evalCandidate: async (ref) => {
      const role = await blobAt(r.agent, ref, "soul/role.md");
      if (role === null) throw new Error(`selftest: no role.md at ${ref}`);
      return scriptedRun(role.text, false, await must(r.agent, ["rev-parse", `${ref}:soul`], r.env));
    },
    cost: async () => ({ turns: 0, tokens: 0, tokensUnknown: 0 }),
    recordedBase: async () => null,
    now: options.now,
    say: () => undefined,
  };
  const ctx: TuneContext = { subject: SUBJECT, soulDir: r.soulDir, tasks: TASKS, setText: SET_TEXT, repeat: REPEAT, backend: null, model: null, stateRoot: r.state, runsDir: r.runs, env: r.env };
  return { out: await runTune(ctx, deps, false, parts), seen, reflected, room: r };
}

const adoptEnv = (room: Room, options: SelftestOptions): AdoptEnv => ({ subject: SUBJECT, soulDir: room.soulDir, runsDir: room.runs, stateRoot: room.state, env: room.env, engine: THROWAWAY_ENGINE, stopped: async () => false, now: options.now });

/** The proof that opens the throwaway's own gate, so adopt runs the real check against a valid record. */
async function arm(room: Room, options: SelftestOptions): Promise<void> {
  const all = Object.fromEntries(CONTROLS.map((c) => [c, true])) as Record<Control, boolean>;
  const proof = sealProof({ schema: PROOF_SCHEMA, engine: THROWAWAY_ENGINE, controls: all, twins: all, evidence: Object.fromEntries(CONTROLS.map((c) => [c, "throwaway"])) as Record<Control, string>, provedAt: options.now().toISOString() });
  await mkdir(room.runs, { recursive: true });
  await writeFile(join(room.runs, PROOF_FILE), JSON.stringify(proof));
}

const headOf = (room: Room) => must(room.agent, ["rev-parse", "HEAD"], room.env);

/** The round's record, or a problem. */
function done(played: Played, problems: string[], what: string) {
  if (played.out.kind !== "done") {
    problems.push(`${what}: the round did not finish (${played.out.kind}${played.out.kind === "refused" ? `: ${played.out.reasons.join("; ")}` : ""})`);
    return null;
  }
  return played.out.record;
}

const deltaOf = (c: { readonly heldout: { readonly delta: number } | null }) => (c.heldout === null ? "n/a" : `${c.heldout.delta >= 0 ? "+" : ""}${c.heldout.delta}`);

// ---------------------------------------------------------------------------
// The four controls
// ---------------------------------------------------------------------------

const result = (control: Control, title: string, problems: readonly string[], facts: readonly string[]): ControlResult => ({ control, title, pass: problems.length === 0, evidence: (problems.length === 0 ? facts : problems).join("; ") });

/** (a) A proposer that changes nothing must leave the base in place, however it says so. */
async function noopControl(root: string, options: SelftestOptions, parts: TuneParts): Promise<ControlResult> {
  const problems: string[] = [];
  const facts: string[] = [];
  const variants: readonly (readonly [string, Proposer])[] = [
    ["body returned unchanged", (d) => (d === "INV" ? proposal(ROLE.slice(ROLE.indexOf("\n+++\n") + 5)) : KEEP)],
    ["KEEP_BASE answered", () => KEEP],
    ["wording changed, nothing else", (d) => (d === "INV" ? proposal(`${ROLE.slice(ROLE.indexOf("\n+++\n") + 5).trimEnd()}\nBe courteous.\n`) : KEEP)],
  ];
  for (const [index, [name, proposer]] of variants.entries()) {
    const played = await play(root, `noop-${index}`, options, proposer, parts);
    const record = done(played, problems, name);
    if (record === null) continue;
    const head = await headOf(played.room);
    const winner = record.verdict.winner;
    if (winner !== null) problems.push(`${name}: ${winner} was selected (${record.verdict.reason})`);
    for (const c of record.candidates) if (c.verdict !== "keep-base") problems.push(`${name}: the ${c.dimension} candidate was ${c.verdict}`);
    if (head !== played.room.head) problems.push(`${name}: HEAD moved`);
    await arm(played.room, options);
    const adopt = await adoptRun(adoptEnv(played.room, options), record.runId);
    if (adopt.ok) problems.push(`${name}: adopt committed ${adopt.commit.slice(0, 8)}`);
    else if (!adopt.reason.includes("has no winner")) problems.push(`${name}: adopt refused for another reason: ${adopt.reason}`);
    facts.push(`${name}: KEEP_BASE (${record.candidates.map((c) => (c.outcome === "keep-base" ? "kept" : `tie ${deltaOf(c)}`)).join(", ")}), HEAD unchanged, adopt refused`);
  }
  return result("noop", "no-op proposer keeps the base", problems, facts);
}

/** (b) A planted good edit is selected, and adopt makes the agent's commit. */
async function goodControl(root: string, options: SelftestOptions, parts: TuneParts): Promise<ControlResult> {
  const problems: string[] = [];
  const facts: string[] = [];
  const room = await makeRoom(root, "good", options);
  const played = await play(root, "", options, (d) => (d === "INV" ? proposal(withRules(room, "RULE-t1", "RULE-h1", "RULE-h2")) : KEEP), parts, room);
  const record = done(played, problems, "planted good edit");
  if (record === null) return result("good", "planted good edit is adopted", problems, facts);
  const inv = record.candidates.find((c) => c.dimension === "INV");
  if (record.verdict.winner !== "INV" || inv === undefined) {
    problems.push(`the planted edit was not selected: ${record.verdict.reason}${inv === undefined ? "" : `; candidate said: ${inv.why}`}`);
    return result("good", "planted good edit is adopted", problems, facts);
  }
  const flips = inv.changes.filter((c) => c.split === "heldout" && c.change.endsWith("→fail"));
  if (inv.heldout === null || inv.heldout.delta <= 0) problems.push("held-out did not rise");
  if (flips.length > 0) problems.push(`a held-out task lost a pass: ${flips.map((f) => f.task).join(", ")}`);
  facts.push(`INV selected: held-out ${inv.heldout?.base}% -> ${inv.heldout?.candidate}% (${deltaOf(inv)}), train ${inv.train?.base}% -> ${inv.train?.candidate}%, no pass→fail`);

  const before = await headOf(room);
  const refused = await adoptRun(adoptEnv(room, options), record.runId);
  if (refused.ok) problems.push("adopt worked without a proof record");
  else if (!refused.reason.includes("has not been proved")) problems.push(`adopt without a proof refused for another reason: ${refused.reason}`);
  if ((await headOf(room)) !== before) problems.push("HEAD moved on a refused adopt");

  await arm(room, options);
  const adopted = await adoptRun(adoptEnv(room, options), record.runId);
  if (!adopted.ok) {
    problems.push(`adopt refused: ${adopted.reason}`);
    return result("good", "planted good edit is adopted", problems, facts);
  }
  const commit = await readCommit(room.agent, adopted.commit);
  const head = await headOf(room);
  const touched = (await must(room.agent, ["diff", "--name-only", before, head], room.env)).split("\n").filter((l) => l !== "");
  const role = await blobAt(room.agent, "HEAD", "soul/role.md");
  const candidateRole = inv.commit === null ? null : await blobAt(room.agent, inv.commit, "soul/role.md");
  if (head !== adopted.commit) problems.push("HEAD is not the adoption commit");
  if (commit === null || commit.parents.length !== 1 || commit.parents[0] !== before) problems.push("the commit is not a single commit on the base");
  if (commit?.authorEmail !== AGENT_EMAIL) problems.push(`the commit is authored by ${commit?.authorEmail ?? "nobody"}, not the agent ${AGENT_EMAIL}`);
  if (commit?.authorEmail === OWNER_EMAIL) problems.push("the commit is authored by the owner (I-5)");
  const message = commit?.message ?? "";
  for (const [label, needle] of [["the run id", record.runId], ["the base sha", record.base.commit.slice(0, 12)], ["the candidate sha", (inv.commit ?? "?").slice(0, 12)], ["the held-out numbers", `${inv.heldout?.base}% -> ${inv.heldout?.candidate}%`]] as const) {
    if (!message.includes(needle)) problems.push(`the commit message lacks ${label}`);
  }
  if (touched.length !== 1 || touched[0] !== "soul/role.md") problems.push(`the commit changed ${touched.join(", ")}, not role.md alone`);
  if (role === null || candidateRole === null || role.sha !== candidateRole.sha) problems.push("role.md at HEAD is not the candidate's");
  for (const keep of ["soul/person.md", "soul/autonomy.md"]) if ((await blobAt(room.agent, "HEAD", keep))?.sha !== (await blobAt(room.agent, before, keep))?.sha) problems.push(`${keep} changed`);
  if (adopted.notice.length === 0 || !adopted.notice.join("\n").includes("not by you")) problems.push("no owner notice");
  const again = await readTuneRun(room.runs, record.runId);
  if (!again.ok || again.record.adopted?.commit !== adopted.commit) problems.push("the tune record does not name the adoption");
  facts.push(`adopt refused without a proof, then committed ${adopted.commit.slice(0, 8)} by ${commit?.authorEmail} (message names ${record.runId}, both SHAs and the held-out numbers), role.md alone changed, owner notice of ${adopted.notice.length} lines`);
  return result("good", "planted good edit is adopted", problems, facts);
}

/** (c) Harmful edits: a held-out regression, an overfit, a stable pass turned flaky. Each is rejected with its reason. */
async function harmfulControl(root: string, options: SelftestOptions, parts: TuneParts): Promise<ControlResult> {
  const problems: string[] = [];
  const facts: string[] = [];
  const variants: readonly (readonly [string, readonly string[], string])[] = [
    ["held-out regression (h3 pass→fail, though h1 and h2 now pass)", ["RULE-h1", "RULE-h2", "BREAK-h3"], "h3"],
    ["overfit (train up, held-out down)", ["RULE-t1", "RULE-t2", "RULE-t3", "RULE-t4", "BREAK-h3"], "h3"],
    ["stable pass turned flaky (h3, though h1 and h2 now pass)", ["RULE-h1", "RULE-h2", "FLAKY-h3"], "pass→flaky"],
  ];
  for (const [index, [name, tags, needle]] of variants.entries()) {
    const room = await makeRoom(root, `harmful-${index}`, options);
    const played = await play(root, "", options, (d) => (d === "INV" ? proposal(withRules(room, ...tags)) : KEEP), parts, room);
    const record = done(played, problems, name);
    if (record === null) continue;
    const inv = record.candidates.find((c) => c.dimension === "INV");
    if (inv === undefined || inv.outcome !== "edit") {
      problems.push(`${name}: the proposal never became a candidate, so nothing was judged`);
      continue;
    }
    if (record.verdict.winner !== null) problems.push(`${name}: ${record.verdict.winner} was selected (${record.verdict.reason})`);
    if (inv.verdict !== "keep-base") problems.push(`${name}: the candidate was ${inv.verdict}`);
    if (!inv.why.includes(needle)) problems.push(`${name}: rejected without the reason (wanted "${needle}", got "${inv.why}")`);
    if (name.startsWith("overfit") && !((inv.train?.delta ?? 0) > 0 && (inv.heldout?.delta ?? 0) < 0)) problems.push(`${name}: the plant did not overfit (train ${inv.train?.delta}, held-out ${inv.heldout?.delta})`);
    if ((await headOf(room)) !== room.head) problems.push(`${name}: HEAD moved`);
    await arm(room, options);
    const adopt = await adoptRun(adoptEnv(room, options), record.runId);
    if (adopt.ok) problems.push(`${name}: adopt committed ${adopt.commit.slice(0, 8)}`);
    facts.push(`${name}: rejected, "${inv.why.slice(0, 90)}" (train ${inv.train?.delta}, held-out ${deltaOf(inv)})`);
  }
  return result("harmful", "planted harmful edits are rejected with the reason", problems, facts);
}

const fold = (text: string) => text.normalize("NFC").toLowerCase().replace(/[\s*_`]+/g, " ").trim();

/** Where `needle` is in `bytes`, byte for byte, or after the guard's own folding. */
function appears(bytes: Uint8Array, needle: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(needle, "utf8")) || fold(new TextDecoder().decode(bytes)).includes(fold(needle));
}

/** (d) No expect or reject phrase, held-out ask or person.md text reaches the proposer, in strict mode on the real mission path. */
async function leakControl(root: string, options: SelftestOptions, parts: TuneParts): Promise<ControlResult> {
  const problems: string[] = [];
  const room = await makeRoom(root, "leak", options);
  // INV edits, so the round reaches its reflection (S21.6) and what that receives is scanned too; DOM keeps the base.
  const played = await play(root, "", options, (d) => (d === "INV" ? proposal(withRules(room, "RULE-t1")) : KEEP), { guard: strictGuard, ...parts }, room);
  const facts: string[] = [];
  if (played.out.kind !== "done") {
    problems.push(`the round did not finish: ${played.out.kind}${played.out.kind === "refused" ? ` (${played.out.reasons.join("; ")})` : ""}`);
    return result("leak", "nothing graded reaches the proposer", problems, facts);
  }
  const needles: (readonly [string, string])[] = [
    ...TASKS.flatMap((t) => t.expect.map((p) => ["expect phrase", p] as const)),
    ...TASKS.flatMap((t) => t.reject.map((p) => ["reject phrase", p] as const)),
    ...TASKS.filter((t) => t.split === "heldout").map((t) => ["held-out ask", t.ask] as const),
    ...PERSON_NEEDLES.map((p) => ["person.md text", p] as const),
  ];
  const personOnDisk = await readFile(join(room.soulDir, "person.md"), "utf8");
  if (PERSON_NEEDLES.some((p) => !personOnDisk.includes(p))) problems.push("the plant is missing: person.md on disk does not hold its markers");
  if (played.seen.length < 2) problems.push(`the proposer received ${played.seen.length} prompt(s), fewer than the INV and DOM missions: nothing was scanned`);
  const kinds = new Set<string>();
  for (const prompt of played.seen) {
    for (const [kind, text] of needles) {
      if (appears(prompt.bytes, text)) {
        kinds.add(kind);
        problems.push(`${kind} ${JSON.stringify(text.slice(0, 48))} reached the ${prompt.dimension} proposer (attempt ${prompt.attempt})`);
      }
    }
    // The scan must be able to see: what the proposer is meant to get has to be in what it got.
    if (!appears(prompt.bytes, "TRAIN-ASK-t1-m2p")) problems.push(`the ${prompt.dimension} prompt does not hold the train ask of t1: the capture is not the real mission`);
    if (!appears(prompt.bytes, "Selftest Keeper")) problems.push(`the ${prompt.dimension} prompt does not name the agent: the capture is not the real mission`);
  }
  if (played.reflected.length < 1) problems.push("the reflection received no prompt: its input was not scanned");
  for (const bytes of played.reflected) {
    for (const [kind, text] of needles) {
      if (appears(bytes, text)) {
        kinds.add(kind);
        problems.push(`${kind} ${JSON.stringify(text.slice(0, 48))} reached the reflection`);
      }
    }
    if (!appears(bytes, "TRAIN-ASK-t1-m2p")) problems.push("the reflection input does not hold the train ask of t1: the capture is not the real mission");
    if (!appears(bytes, "Selftest Keeper")) problems.push("the reflection input does not name the agent: the capture is not the real mission");
  }
  const total = [...played.seen.map((p) => p.bytes), ...played.reflected].reduce((n, b) => n + b.byteLength, 0);
  facts.push(`${played.seen.length} proposer prompt(s) and ${played.reflected.length} reflection prompt(s), ${total} bytes scanned for ${needles.length} planted strings (${TASKS.length} expect, ${TASKS.length} reject, ${HELD.length} held-out asks, ${PERSON_NEEDLES.length} person.md markers): none found; the train asks were present; strict leak guard on`);
  return result("leak", "nothing graded reaches the proposer", problems, facts);
}

// ---------------------------------------------------------------------------
// The sabotaged twins
// ---------------------------------------------------------------------------

const keep = (s: Selection, reason: string): Selection => ({ ...s, verdict: "keep-base", reason });

/** Adopts when the held-out pass rate ties (and nothing regressed): a no-op edit would be taken. */
const adoptOnTie: typeof selectByRule = (base, candidate) => {
  const s = selectByRule(base, candidate);
  return s.verdict === "keep-base" && s.heldout.base === s.heldout.candidate && s.regressions.length === 0 && s.heldout.tasks > 0 ? { ...s, verdict: "adopt", reason: "sabotaged: a tie is taken" } : s;
};

/** Never adopts anything: passes (a) and (c) for free, which is why (b) exists. */
const neverAdopt: typeof selectByRule = (base, candidate) => keep(selectByRule(base, candidate), "sabotaged: never adopts");

/** Adopts every candidate: what (c) must catch. */
const alwaysAdopt: typeof selectByRule = (base, candidate) => ({ ...selectByRule(base, candidate), verdict: "adopt", reason: "sabotaged: always adopts", regressions: [] });

/** A mission builder that appends an expect phrase, a held-out ask and person.md text, run with the guard off. */
const leakyParts = (): TuneParts => ({
  guard: () => undefined,
  reflection: (mission, sources) => `${mission}\n# EXTRA\n${sources.expect[0] ?? ""}\n${sources.heldOutAsks[0] ?? ""}\n${PERSON_NEEDLES.join("\n")}\n`,
  mission: (dimension, base, evidence, sources) => {
    // The very builder a round uses (its own guard off), then what must never be there.
    const real = missionFor(dimension, base, evidence, sources, () => undefined);
    return `${real}\n# EXTRA\n${sources.expect[0] ?? ""}\n${sources.heldOutAsks[0] ?? ""}\n${PERSON_NEEDLES.join("\n")}\n`;
  },
});

export interface Twin {
  readonly control: Control;
  readonly sabotage: string;
  /** What the control's failure must say: it has to fail for the sabotage, not for some other reason. */
  readonly because: string;
  readonly parts: TuneParts;
}

const TWINS: readonly Twin[] = [
  { control: "noop", sabotage: "selector adopts on a tie", because: "was selected", parts: { select: adoptOnTie } },
  { control: "good", sabotage: "selector never adopts", because: "was not selected", parts: { select: neverAdopt } },
  { control: "harmful", sabotage: "selector always adopts", because: "was selected", parts: { select: alwaysAdopt } },
  { control: "leak", sabotage: "mission builder leaks, guard off", because: "reached the", parts: leakyParts() },
];

const RUNNERS: Readonly<Record<Control, (root: string, options: SelftestOptions, parts: TuneParts) => Promise<ControlResult>>> = { noop: noopControl, good: goodControl, harmful: harmfulControl, leak: leakControl };

/** Run the four controls, then each against its twin. Throws only when the harness itself breaks (git, disk). */
export async function runControls(root: string, options: SelftestOptions, twinSet: readonly Twin[] = TWINS): Promise<SelftestOutcome> {
  const controls: ControlResult[] = [];
  for (const control of CONTROLS) controls.push(await RUNNERS[control](root, options, {}));
  const twins: TwinResult[] = [];
  for (const twin of twinSet) {
    const r = await RUNNERS[twin.control](root, options, twin.parts);
    const why = r.pass ? "the control PASSED on the sabotaged round: it cannot tell a broken tuner from a sound one" : r.evidence;
    const rightReason = !r.pass && r.evidence.includes(twin.because);
    twins.push({ control: twin.control, sabotage: twin.sabotage, caught: rightReason, evidence: !r.pass && !rightReason ? `the control failed, but not because of the sabotage (wanted "${twin.because}"): ${why}` : why });
  }
  return { controls, twins, ok: controls.every((c) => c.pass) && twins.every((t) => t.caught) };
}

/**
 * Run `fn` with a new directory under `<stateRoot>/scratch/tune/`, and remove it on every exit path: a return, a
 * throw, SIGINT, SIGTERM and SIGHUP (the handlers remove it synchronously and exit 130).
 */
export async function withScratch<T>(stateRoot: string, fn: (root: string) => Promise<T>): Promise<T> {
  const parent = join(stateRoot, TUNE_SCRATCH);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "selftest-"));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = () => {
    rmSync(root, { recursive: true, force: true });
    process.exit(130);
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    return await fn(root);
  } finally {
    for (const s of signals) process.off(s, onSignal);
    await rm(root, { recursive: true, force: true });
  }
}

/** The whole selftest: a throwaway directory, the controls and twins, the directory removed. */
export async function runSelftest(options: SelftestOptions): Promise<SelftestOutcome> {
  return withScratch(options.stateRoot, (root) => runControls(root, options));
}

/** The sealed proof of an outcome, or null unless every control passed and every twin was caught. */
export function proofOf(outcome: SelftestOutcome, engine: EngineIdentity, at: Date): Proof | null {
  if (!outcome.ok || engine.sourceSha256 === null) return null;
  const controls = Object.fromEntries(outcome.controls.map((c) => [c.control, c.pass])) as Record<Control, boolean>;
  const twins = Object.fromEntries(outcome.twins.map((t) => [t.control, t.caught])) as Record<Control, boolean>;
  const evidence = Object.fromEntries(outcome.controls.map((c) => [c.control, c.evidence])) as Record<Control, string>;
  return sealProof({ schema: PROOF_SCHEMA, engine, controls, twins, evidence, provedAt: at.toISOString() });
}

const LABEL: Readonly<Record<Control, string>> = { noop: "(a) noop", good: "(b) good", harmful: "(c) harmful", leak: "(d) leak" };

/** The result as printed: one line per control and per twin, each with its evidence. */
export function selftestLines(outcome: SelftestOutcome): string[] {
  const out = ["mind soul tune --selftest: four controls, each against a sabotaged twin (no model, no network, a throwaway agent repository)", ""];
  for (const c of outcome.controls) out.push(`${c.pass ? "PASS" : "FAIL"}  ${LABEL[c.control].padEnd(12)} ${c.title}`, `      ${c.evidence}`);
  out.push("", "sabotaged twins (each must make its control FAIL):");
  for (const t of outcome.twins) out.push(`${t.caught ? "PASS" : "FAIL"}  ${LABEL[t.control].padEnd(12)} twin: ${t.sabotage}`, `      ${t.caught ? "control failed as required: " : ""}${t.evidence.length > 360 ? `${t.evidence.slice(0, 360)}…` : t.evidence}`);
  const passed = outcome.controls.filter((c) => c.pass).length;
  const caught = outcome.twins.filter((t) => t.caught).length;
  out.push("", `${outcome.ok ? "ALL" : "NOT ALL"} as required: ${passed}/${outcome.controls.length} controls passed, ${caught}/${outcome.twins.length} twins caught.`);
  return out;
}
