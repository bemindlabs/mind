/**
 * D-156 — the approval channel: a sensitive browser action a task's container is holding, asked of the owner,
 * answered once.
 *
 * ## The way through
 *
 * 1. The container (`docker/browser/record.cjs`, `release.cjs`) holds an action D-153's list flags and writes it
 *    to `<recording>/pending/<id>.json`: the step's kind, element role and text, origin, the rules that held it,
 *    its digest, when it was filed and when the wait ends. No typed value is in it, ever.
 * 2. The task's runner sees it while the step runs ({@link watchApprovals}), files it in the task's own store
 *    (`approvals/<id>.json`, copied — the recording is the browser's, the store is the task's) and the task is
 *    `waiting`. Every channel shows it: `task show`, `/api/state`, `/api/tasks/<id>`, the page and the app.
 * 3. The owner answers ({@link decideApproval}): `task approve|deny`, or `POST /api/tasks/<id>/approvals/<id>/…`.
 *    The answer is **claimed** first — `approvals/decided/<id>.json`, linked into place (D-144's exclusive step):
 *    of two answers sent at once exactly one is the answer, and an approval is never decided twice. Only then is
 *    the release written into the recording, signed with the task's release key.
 * 4. The container takes the release only for that id, with the digest it computed itself and a valid mac, and
 *    once (`release.cjs`); the action goes ahead or is refused, and the model is told which. The task is
 *    `running` again; a no is said to the next step too.
 *
 * ## Expiry
 *
 * No answer by `expiresAt` is a no: the container stops waiting a few seconds after it (grace for a yes sent
 * just in time), and here an answer after `expiresAt` is refused. The runner claims the expiry, so a late
 * answer finds the approval decided.
 *
 * ## The digest
 *
 * Recomputed here from the action the pending file describes — the same canonical bytes as `release.cjs`
 * (`test/task/approvals.test.ts` holds the two equal) — and a pending file whose digest does not match is not
 * offered. The container compares against the digest it computed when it held the action, not the file's.
 */

import { createHash, sign, type KeyObject } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linkClaim } from "../decide/proposals.ts";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";

/** The id a held action's pending file carries (`docker/browser/release.cjs` writes it). */
export const HELD_SCHEMA = "mind/held-action@1";
/** The id of the copy the task's runner files under `approvals/`. */
export const APPROVAL_SCHEMA = "mind/task-approval@1";
/** The id of the claim in `approvals/decided/`. The reader looks at the verdict, not at the id. */
export const DECISION_SCHEMA = "mind/task-approval-decision@1";
/** The first line of what a release signs (`<this>\n<id>\n<digest>\n<verdict>`), the same text as `release.cjs`'s `releaseMessage`. */
export const RELEASE_PREFIX = "mind-release";
export const APPROVALS_DIR = "approvals";
export const DECIDED_DIR = "decided";
/** Yeses claimed while a loosened turn ran: released as no (review of PR #24, round 3). */
export const TAINTED_DIR = "tainted";
const ID = /^a-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The same list as `release.cjs`'s FIELDS (held equal by test/task/approvals.test.ts). */
export const FIELDS = ["kind", "origin", "path", "role", "text", "inputType", "valueClass", "key", "submits", "formRole", "submitsForm", "formHasPassword", "formAction", "formMethod", "href", "context", "frameOrigin", "framePath"] as const;

export function isApprovalId(id: string): boolean {
  return ID.test(id);
}

/** What a held action is, as the container described it. Never a typed value. */
export type HeldDescriptor = Partial<Record<(typeof FIELDS)[number], string | boolean>>;

/** The same canonical bytes `docker/browser/release.cjs` hashes: keys sorted, no whitespace. */
export function canonicalAction(descriptor: HeldDescriptor): string {
  return JSON.stringify(Object.fromEntries(Object.keys(descriptor).sort().map((key) => [key, descriptor[key as keyof HeldDescriptor]])));
}

export function heldDigest(descriptor: HeldDescriptor): string {
  return `sha256:${createHash("sha256").update(canonicalAction(descriptor)).digest("hex")}`;
}

/**
 * A release's signature: Ed25519 over the id, the digest and the verdict, with the task runner's private key
 * (review of PR #24, round 3) — the same bytes `docker/browser/release.cjs`'s `releaseMessage` verifies.
 */
export function releaseSignature(key: KeyObject, id: string, digest: string, verdict: "approve" | "deny"): string {
  return sign(null, Buffer.from(`${RELEASE_PREFIX}\n${id}\n${digest}\n${verdict}`), key).toString("base64");
}

export interface HeldAction {
  /**
   * D-160: false for a credential — never approvable until a store fills values without the model seeing
   * them. Decided here from the categories and rules too, whatever the file says.
   */
  readonly approvable: boolean;
  /** D-159: the id of the released action the container says this one came right after (same page). */
  readonly followsId?: string;
  readonly id: string;
  readonly action: HeldDescriptor;
  readonly digest: string;
  readonly rules: readonly string[];
  readonly categories: readonly string[];
  readonly reasons: readonly string[];
  readonly filedAt: string;
  readonly expiresAt: string;
}

/**
 * `refused`: a credential (D-160) on a strong signal — {@link isCredential} — refused by the container at once;
 * nobody can approve it.
 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "refused";

/** D-160 — is this a credential, which no answer may release? From the categories and the rule ids both. */
export function isCredential(held: { readonly rules: readonly string[]; readonly action: HeldDescriptor }): boolean {
  if (held.rules.includes("credentials.login-submit") || held.rules.includes("credentials.filled-password")) return true;
  if (["password", "otp", "secret"].includes(String(held.action.valueClass ?? ""))) return true;
  return ["type", "fill", "dialog-type"].includes(String(held.action.kind ?? "")) && new RegExp(STRONG_WORDS, "iu").test(String(held.action.text ?? ""));
}

/** The same words as `release.cjs`'s STRONG_WORDS (held equal by test/task/approvals.test.ts). */
export const STRONG_WORDS = "(password|passphrase|passcode|passwort|kennwort|mot de passe|contraseña|wachtwoord|hasło|senha|パスワード|密码|密碼|비밀번호|รหัสผ่าน)";

/** What the page and the app say instead of a yes button for a credential. */
export const NOT_ALLOWED_YET = "not allowed yet (D-160): a password or credential is never entered for you until a store fills it without the model seeing it";

export interface ActionApproval extends HeldAction {
  readonly task: string;
  /** The step that was running when it was held, or `null` when it was read before the runner filed it. */
  readonly step: number | null;
  readonly status: ApprovalStatus;
  readonly decidedAt: string | null;
  readonly by: string | null;
  /** The owner asked for the task to stop with the no. */
  readonly stop: boolean;
  /**
   * D-159 (the owner, after the review): a page's confirm is asked as its own question, shown beside the action
   * that opened it — the last action of this task answered yes before this one was held.
   */
  readonly follows: { readonly id: string; readonly action: HeldDescriptor } | null;
  /** Review finding 4: a value goes with this action — chosen by the agent, and never shown. */
  readonly carriesValue: boolean;
}

function asHeld(value: unknown): HeldAction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const id = raw["id"];
  const action = raw["action"];
  if (typeof id !== "string" || !isApprovalId(id) || typeof action !== "object" || action === null) return undefined;
  const descriptor: HeldDescriptor = {};
  for (const field of FIELDS) {
    const v = (action as Record<string, unknown>)[field];
    if (typeof v === "string" || typeof v === "boolean") descriptor[field] = v;
  }
  // Bound to what it says it is: a file whose action does not hash to its digest is not offered.
  if (raw["digest"] !== heldDigest(descriptor) || Object.keys(action).length !== Object.keys(descriptor).length) return undefined;
  const strings = (key: string) => (Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((s): s is string => typeof s === "string") : []);
  const filedAt = raw["filedAt"];
  const expiresAt = raw["expiresAt"];
  if (typeof filedAt !== "string" || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  const rules = strings("rules");
  const categories = strings("categories");
  const credential = isCredential({ rules, action: descriptor });
  // `follows` as the container writes it; `followsId` as the task's store keeps its copy.
  const named = typeof raw["follows"] === "string" ? raw["follows"] : raw["followsId"];
  const followsId = typeof named === "string" && isApprovalId(named) ? named : undefined;
  return { approvable: raw["approvable"] !== false && !credential, ...(followsId === undefined ? {} : { followsId }), id, action: descriptor, digest: raw["digest"] as string, rules, categories, reasons: strings("reasons"), filedAt, expiresAt };
}

async function readJsonDir(dir: string): Promise<{ name: string; value: unknown }[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: { name: string; value: unknown }[] = [];
  for (const name of names) {
    try {
      out.push({ name, value: JSON.parse(await readFile(join(dir, name), "utf8")) });
    } catch {
      // Being written, or not ours: not an action anyone can be asked about.
    }
  }
  return out;
}

/** What the container is holding, read from the task's recording. */
export async function readHeld(outDir: string): Promise<readonly HeldAction[]> {
  return (await readJsonDir(join(outDir, "pending")))
    .map(({ name, value }) => {
      const held = asHeld(value);
      return held !== undefined && name === `${held.id}.json` ? held : undefined;
    })
    .filter((held): held is HeldAction => held !== undefined);
}

interface Decided {
  readonly verdict: "approve" | "deny" | "expired";
  readonly at: string;
  readonly by: string;
  readonly stop: boolean;
}

async function readDecided(taskDir: string): Promise<Map<string, Decided>> {
  const out = new Map<string, Decided>();
  for (const { name, value } of await readJsonDir(join(taskDir, APPROVALS_DIR, DECIDED_DIR))) {
    const raw = value as Record<string, unknown>;
    const verdict = raw["verdict"];
    if (verdict !== "approve" && verdict !== "deny" && verdict !== "expired") continue;
    out.set(name.slice(0, -5), { verdict, at: String(raw["at"] ?? ""), by: String(raw["by"] ?? ""), stop: raw["stop"] === "1" });
  }
  for (const { name, value } of await readJsonDir(join(taskDir, APPROVALS_DIR, TAINTED_DIR))) {
    const id = name.slice(0, -5);
    if (out.has(id)) out.set(id, { verdict: "deny", at: String((value as Record<string, unknown>)["at"] ?? ""), by: `nobody: it was claimed while a turn that can run commands was running (${String((value as Record<string, unknown>)["turn"] ?? "")}), so it counts as no — ask again`, stop: false });
  }
  return out;
}

/** Copy what the container holds into the task's store, once each, naming the step. Returns the ones new now. */
export async function fileHeld(taskDir: string, outDir: string, task: string, step: number): Promise<readonly HeldAction[]> {
  const dir = join(taskDir, APPROVALS_DIR);
  const filed = new Set((await readJsonDir(dir)).map(({ name }) => name.slice(0, -5)));
  const fresh: HeldAction[] = [];
  for (const held of await readHeld(outDir)) {
    if (filed.has(held.id)) continue;
    // Not recursive: a task erased under its runner stays erased (I-4) — its directory is never made again.
    await mkdir(dir, { mode: STATE_DIR_MODE }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") throw cause;
    });
    try {
      await writeFile(join(dir, `${held.id}.json`), `${JSON.stringify({ schema: APPROVAL_SCHEMA, task, step, ...held }, null, 2)}\n`, { mode: STATE_FILE_MODE, flag: "wx" });
      fresh.push(held);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  }
  return fresh;
}

/** Every approval of a task: what was filed, and what the container holds that is not filed yet. Oldest first. */
export async function readApprovals(taskDir: string, outDir: string | null, task: string, now: Date): Promise<readonly ActionApproval[]> {
  const byId = new Map<string, { held: HeldAction; step: number | null }>();
  for (const { name, value } of await readJsonDir(join(taskDir, APPROVALS_DIR))) {
    const held = asHeld(value);
    if (held === undefined || name !== `${held.id}.json`) continue;
    const step = (value as Record<string, unknown>)["step"];
    byId.set(held.id, { held, step: typeof step === "number" ? step : null });
  }
  if (outDir !== null) for (const held of await readHeld(outDir)) if (!byId.has(held.id)) byId.set(held.id, { held, step: null });
  const decided = await readDecided(taskDir);
  return [...byId.values()]
    .map(({ held, step }) => {
      const answer = decided.get(held.id);
      const status: ApprovalStatus =
        answer !== undefined
          ? answer.verdict === "approve" ? "approved" : answer.verdict === "deny" ? "denied" : "expired"
          : !held.approvable ? "refused" : now.getTime() > Date.parse(held.expiresAt) ? "expired" : "pending";
      return { ...held, task, step, status, decidedAt: answer?.at ?? null, by: answer?.by ?? null, stop: answer?.stop ?? false, follows: null, carriesValue: carriesValue(held.action) };
    })
    .sort((a, b) => a.filedAt.localeCompare(b.filedAt))
    .map((approval, _index, all) => {
      // D-159: paired with the action the container recorded it followed — never guessed from the clock.
      const before = approval.followsId === undefined ? undefined : all.find((a) => a.id === approval.followsId);
      return before === undefined ? approval : { ...approval, follows: { id: before.id, action: before.action } };
    });
}

export type Decision =
  | { readonly ok: true; readonly approval: ActionApproval }
  | { readonly ok: false; readonly reason: string; readonly kind: "missing" | "decided" | "expired" | "no-browser" | "not-allowed" };

/**
 * Answer one approval, once: the answer is **claimed** (`decided/<id>.json`, linked into place — of two answers
 * at once exactly one is the answer). Nothing more here: the release the container takes is written and
 * signed by the task's runner, the only process that holds the release key (review of PR #24, finding 2c).
 * `outDir` is the task's recording, to read what the container holds that the runner has not filed yet.
 */
export async function decideApproval(options: {
  readonly taskDir: string;
  readonly task: string;
  readonly id: string;
  readonly verdict: "approve" | "deny";
  readonly by: string;
  readonly now: Date;
  readonly stop?: boolean;
  readonly outDir: string | null;
  /** The step running now, or `null` when none is: an approval of any other step has outlived its step. */
  readonly openStep: number | null;
}): Promise<Decision> {
  if (!isApprovalId(options.id)) return { ok: false, kind: "missing", reason: `${JSON.stringify(options.id)} is not an approval id` };
  const all = await readApprovals(options.taskDir, options.outDir, options.task, options.now);
  const approval = all.find((entry) => entry.id === options.id);
  if (approval === undefined) return { ok: false, kind: "missing", reason: `task ${options.task} has no approval ${options.id}` };
  if (!approval.approvable) return { ok: false, kind: "not-allowed", reason: `approval ${options.id} is ${NOT_ALLOWED_YET}; it was refused at once and nothing can release it` };
  if (approval.status !== "pending") {
    return { ok: false, kind: approval.status === "expired" ? "expired" : "decided", reason: `approval ${options.id} is ${approval.status} already${approval.status === "expired" ? " — no answer came in time, which counts as no" : ""}` };
  }
  // Review of PR #24, finding 5: an approval is good only while the step that asked is the one running.
  if (approval.step !== null && approval.step !== options.openStep) {
    return { ok: false, kind: "expired", reason: `approval ${options.id} belongs to step ${approval.step}, which has ended — it counts as no` };
  }
  const claim = join(options.taskDir, APPROVALS_DIR, DECIDED_DIR, `${options.id}.json`);
  const made = await linkClaim(claim, {
    schema: DECISION_SCHEMA,
    id: options.id,
    verdict: options.verdict,
    digest: approval.digest,
    at: options.now.toISOString(),
    by: options.by,
    stop: options.stop === true ? "1" : "0",
  });
  if (made === "taken") return { ok: false, kind: "decided", reason: `approval ${options.id} was answered already, a moment before this answer` };
  return { ok: true, approval: { ...approval, status: options.verdict === "approve" ? "approved" : "denied", decidedAt: options.now.toISOString(), by: options.by, stop: options.stop === true } };
}

/**
 * The runner's half of an answer: for every approval with a claimed answer (or a recorded expiry) and no
 * release yet, write the release the container takes — signed with `key`, which only the runner holds.
 *
 * A claim is a file any process of the owner's uid could write (review of PR #24, round 2), so a yes is
 * checked again here, at the last moment, before it is signed:
 * - while any turn of the owner that can run commands is running (`loosened`, every agent), a yes is **held**:
 *   not signed, asked again at the next look — such a turn could have written the claim;
 * - a yes for a step that is not the one running (`openStep`), or after the step has ended, is released as no.
 * A no and an expiry are released as no at once. Returns the ids released now.
 */
export async function writeReleases(options: {
  readonly taskDir: string;
  readonly outDir: string;
  readonly task: string;
  readonly key: KeyObject;
  readonly now: Date;
  readonly openStep: number | null;
  /**
   * Was a turn of the owner's that can run commands running when a claim was made (its file's ctime, which
   * no process can set)? `taintedAt`, src/task/answer.ts.
   */
  readonly tainted: (claimedAtMs: number) => Promise<string | undefined>;
}): Promise<readonly string[]> {
  const decided = await readDecided(options.taskDir);
  const releaseDir = join(options.outDir, "release");
  const written: string[] = [];
  const approvals = await readApprovals(options.taskDir, options.outDir, options.task, options.now);
  for (const held of approvals) {
    const answer = decided.get(held.id);
    if (answer === undefined) continue;
    const path = join(releaseDir, `${held.id}.json`);
    if ((await Bun.file(path).exists()) || (await Bun.file(join(releaseDir, `${held.id}.used`)).exists())) continue;
    let verdict: "approve" | "deny" = answer.verdict === "approve" && held.approvable ? "approve" : "deny";
    if (verdict === "approve" && (held.step === null || held.step !== options.openStep)) verdict = "deny";
    if (verdict === "approve") {
      // Review of PR #24, round 3: a yes claimed while any loosened turn ran is tainted — released as a no,
      // recorded so every channel says why, and never signed later.
      const claimedAt = (await stat(join(options.taskDir, APPROVALS_DIR, DECIDED_DIR, `${held.id}.json`))).ctimeMs;
      const turn = await options.tainted(claimedAt);
      if (turn !== undefined) {
        verdict = "deny";
        const taintDir = join(options.taskDir, APPROVALS_DIR, TAINTED_DIR);
        await mkdir(taintDir, { recursive: true, mode: STATE_DIR_MODE });
        await writeFile(join(taintDir, `${held.id}.json`), `${JSON.stringify({ id: held.id, at: options.now.toISOString(), turn })}\n`, { mode: STATE_FILE_MODE });
      }
    }
    await mkdir(releaseDir, { recursive: true, mode: STATE_DIR_MODE });
    const temp = join(releaseDir, `.${held.id}.${process.pid}.tmp`);
    await writeFile(temp, `${JSON.stringify({ id: held.id, digest: held.digest, verdict, sig: releaseSignature(options.key, held.id, held.digest, verdict) })}\n`, { mode: STATE_FILE_MODE });
    await rename(temp, path);
    written.push(held.id);
  }
  return written;
}

/** Does a value go with this action (typing, a key, a prompt's answer)? The value is never in the record. */
export function carriesValue(action: HeldDescriptor): boolean {
  return ["type", "fill", "dialog-type", "upload", "select"].includes(String(action.kind ?? "")) || (action.kind === "press" && action.valueClass !== undefined);
}

/** The note every channel puts on an action that carries a value (review finding 4). */
export const VALUE_NOT_SHOWN = "the value is not shown, and was chosen by the agent";

/** One approval in a sentence: what the action was, aimed where. */
export function describeHeld(held: Pick<HeldAction, "action">): string {
  const a = held.action;
  const what = String(a.kind ?? "an action").replace(/^dialog-submit$/, "accept a dialog").replace(/^dialog-type$/, "answer a dialog");
  const target = [
    a.formAction === undefined ? "" : ` → ${String(a.formMethod ?? "get").toUpperCase()} ${String(a.formAction)}`,
    a.href === undefined ? "" : ` → ${String(a.href)}`,
    a.context === undefined ? "" : ` (in: "${String(a.context).slice(0, 80)}")`,
  ].join("");
  const frame = a.frameOrigin === undefined ? "" : ` (in a frame from ${String(a.frameOrigin)}${a.framePath === undefined ? "" : String(a.framePath)})`;
  return `${what}${a.text === undefined || a.text === "" ? "" : ` "${String(a.text).slice(0, 80)}"`}${target}${a.origin === undefined ? "" : ` on ${String(a.origin)}${a.path === undefined ? "" : String(a.path)}`}${frame}`;
}

/**
 * The runner's view while a step runs (D-156): file what the container newly holds, claim what expired, and
 * say whether the task is waiting, how long this step has waited, and what to tell the next step. `told` is
 * the runner's own memory of what it has said already, so each no is said once.
 */
export async function watchApprovals(options: {
  readonly taskDir: string;
  readonly outDir: string;
  readonly task: string;
  readonly step: number;
  readonly now: Date;
  readonly told: Set<string>;
  /** The release key: the runner's, in its memory only. */
  readonly key: KeyObject;
  /** The step has ended: what it left pending is expired, and released as a no. */
  readonly ended?: boolean;
  /** `taintedAt`: a yes claimed while a turn of the owner that could run commands ran is released as no. */
  readonly tainted: (claimedAtMs: number) => Promise<string | undefined>;
}): Promise<{ readonly waiting: boolean; readonly waitedMs: number; readonly notes: readonly string[]; readonly stop: boolean }> {
  await fileHeld(options.taskDir, options.outDir, options.task, options.step);
  let approvals = await readApprovals(options.taskDir, options.outDir, options.task, options.now);
  const outlived = (a: ActionApproval) => a.status === "pending" && options.ended === true && (a.step === options.step || a.step === null);
  for (const approval of approvals.filter((a) => (a.status === "expired" && a.decidedAt === null) || outlived(a))) {
    await linkClaim(join(options.taskDir, APPROVALS_DIR, DECIDED_DIR, `${approval.id}.json`), {
      schema: DECISION_SCHEMA,
      id: approval.id,
      verdict: "expired",
      digest: approval.digest,
      at: outlived(approval) ? options.now.toISOString() : approval.expiresAt,
      by: outlived(approval) ? "its step ended first" : "nobody answered in time",
      stop: "0",
    });
  }
  await writeReleases({
    taskDir: options.taskDir,
    outDir: options.outDir,
    task: options.task,
    key: options.key,
    now: options.now,
    openStep: options.ended === true ? null : options.step,
    tainted: options.tainted,
  });
  approvals = await readApprovals(options.taskDir, options.outDir, options.task, options.now);
  const mine = approvals.filter((a) => a.step === options.step);
  const waitedMs = mine.reduce((sum, a) => {
    const end = a.decidedAt !== null ? Date.parse(a.decidedAt) : Math.min(options.now.getTime(), Date.parse(a.expiresAt));
    return sum + Math.max(0, Math.min(end, Date.parse(a.expiresAt)) - Date.parse(a.filedAt));
  }, 0);
  const notes: string[] = [];
  for (const a of mine) {
    if (options.told.has(a.id) || (a.status !== "denied" && a.status !== "expired" && a.status !== "refused")) continue;
    options.told.add(a.id);
    notes.push(
      a.status === "refused"
        ? `Not done, and not askable: ${describeHeld(a)} — a password or credential is never entered for you yet (D-160). Do not try it another way; finish and say what is left.`
        : a.status === "denied"
        ? `The owner said no to: ${describeHeld(a)}. Do not try it again or another way; carry on without it, or finish and say what is left.`
        : `Nobody answered in time about: ${describeHeld(a)}, which counts as no. Do not try it another way.`,
    );
  }
  return { waiting: mine.some((a) => a.status === "pending"), waitedMs, notes, stop: mine.some((a) => a.status === "denied" && a.stop) };
}
