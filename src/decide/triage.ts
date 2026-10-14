/**
 * Triage a proposal with TypeSafe's Jev — opt-in, and advisory only (D-059).
 *
 * Jev is a "System One" model: instead of text it answers typed questions
 * with a probability distribution and a confidence. Asked about a proposal's
 * what / why / impact, it says what kind of action it is, whether it can be
 * undone, and whether it touches somebody's private information — which is
 * the first thing an owner reads a proposal for.
 *
 * What it never does: approve, refuse, or act. The labels sit beside the
 * proposal in `proposal list` and `proposal show`; the decision stays a
 * person's (S5.2, D-045). A triage that failed or was kept in changes nothing
 * about what the proposal is.
 *
 * It is a cloud call, so the proposal's text leaves this machine. Three things
 * follow from that and are enforced here, not in the caller:
 * - Off unless asked: `mind proposal triage` on demand, or every filing
 *   when `MIND_TRIAGE=jev` is set. There is no default key and no default on.
 * - The text goes through the same egress filter a turn does (S8.3, D-048)
 *   first; a finding means nothing is sent.
 * - The key comes from `TYPESAFE_API_KEY` (or a file named by
 *   `TYPESAFE_API_KEY_FILE`) and is never written anywhere by Mind.
 */

import { readMind } from "../env.ts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { screen, type EgressFinding, type Lexicon } from "../egress/filter.ts";
import type { Proposal } from "./proposals.ts";

export const TRIAGE_ENV = "MIND_TRIAGE";
export const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";
export const TYPESAFE_KEY_FILE_ENV = "TYPESAFE_API_KEY_FILE";
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** Where to send instead — a proxy, or a stub in a test. https, or http on loopback only. */
export const TYPESAFE_URL_ENV = "MIND_TYPESAFE_URL";

/** The endpoint to use: the override when it is safe to honour, else TypeSafe's own. */
export function typesafeUrl(env: Readonly<Record<string, string | undefined>>): string {
  const raw = readMind(TYPESAFE_URL_ENV, env);
  if (raw === undefined || raw === "") return TYPESAFE_URL;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.toString();
  } catch {
    // Not a URL: fall through to the default rather than to wherever it points.
  }
  return TYPESAFE_URL;
}

/** Beside the proposals, under the personal directory, so `erase` takes it with them. */
export const TRIAGE_DIR = "triage";

export const RISKS = ["read-only", "local-change", "external", "destructive"] as const;
export type Risk = (typeof RISKS)[number];

/** The questions, in Jev's own request shape. English: Jev reads it best. */
export const TRIAGE_QUESTIONS = Object.freeze({
  risk: {
    type: "choice",
    instructions: "What kind of action does this proposal describe?",
    criteria: {
      "read-only": "Only reads, inspects or reports; changes nothing",
      "local-change": "Changes files, services or settings on this machine",
      external: "Contacts, sends to or publishes anything outside this machine",
      destructive: "Deletes, overwrites or cannot be undone",
    },
  },
  reversible: {
    type: "noul",
    instructions: "Can the effect be fully undone afterwards?",
    criteria: { true: "Fully reversible", false: "Not fully reversible" },
  },
  personal: {
    type: "noul",
    instructions: "Does carrying it out touch a person's private information (health, money, family, contacts, messages)?",
    criteria: { true: "Touches private information", false: "No private information involved" },
  },
});

export interface Triage {
  readonly proposal: string;
  readonly at: string;
  readonly model: string;
  readonly risk: { readonly choice: Risk; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> };
  /** Probability that it can be undone. */
  readonly reversible: number;
  /** Probability that it touches private information. */
  readonly personal: number;
}

export type TriageOutcome =
  | { readonly kind: "triaged"; readonly triage: Triage }
  | { readonly kind: "kept-in"; readonly findings: readonly EgressFinding[] }
  | { readonly kind: "failed"; readonly reason: string };

/** Whether filing should triage by itself. Only the exact word turns it on. */
export function triageEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return readMind(TRIAGE_ENV, env) === "jev";
}

/** The key, from the environment or the file it names; `undefined` when neither holds one. */
export async function typesafeKey(env: Readonly<Record<string, string | undefined>>): Promise<string | undefined> {
  const direct = env[TYPESAFE_KEY_ENV]?.trim();
  if (direct !== undefined && direct !== "") return direct;
  const file = env[TYPESAFE_KEY_FILE_ENV];
  if (file === undefined || file === "") return undefined;
  try {
    const text = (await readFile(file, "utf8")).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** What Jev is shown: the three fields a person reads, and nothing else about the subject. */
export function triageState(proposal: Proposal): string {
  return JSON.stringify({ what: proposal.what, why: proposal.why, impact: proposal.impact });
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Read Jev's answer, refusing anything that is not the shape asked for. */
export function parseTriage(proposal: Proposal, body: unknown, at: Date): Triage | string {
  const answers = (body as { answers?: Record<string, Record<string, unknown>> } | null)?.answers;
  const risk = answers?.["risk"];
  const choice = risk?.["choice"];
  const confidence = num(risk?.["confidence"]);
  const probabilities = risk?.["probabilities"];
  const reversible = num(answers?.["reversible"]?.["noul"]);
  const personal = num(answers?.["personal"]?.["noul"]);
  if (typeof choice !== "string" || !(RISKS as readonly string[]).includes(choice)) return "no risk choice in the answer";
  if (confidence === undefined || probabilities === null || typeof probabilities !== "object") return "no confidence for the risk choice";
  if (reversible === undefined || personal === undefined) return "a yes/no answer is missing";
  const model = (body as { model?: unknown }).model;
  return {
    proposal: proposal.id,
    at: at.toISOString(),
    model: typeof model === "string" ? model : "unknown",
    risk: { choice: choice as Risk, confidence, probabilities: probabilities as Record<string, number> },
    reversible,
    personal,
  };
}

/** Screen, send, read. Writes nothing; the caller stores what comes back. */
export async function triageProposal(
  proposal: Proposal,
  options: {
    readonly key: string;
    readonly lexicon: Lexicon;
    readonly fetch?: Fetch;
    readonly url?: string;
    readonly now?: () => Date;
    readonly announce?: (line: string) => void;
    /** S8.3's second layer (D-061): a model on this machine reads the text for meaning, when one is on (D-181). */
    readonly judge?: (text: string) => Promise<readonly EgressFinding[]>;
    /**
     * Called once, just before the text is sent, when there is no `judge`: the caller says that only the filter
     * screened it (D-181). Not called for a text that is kept in, because nothing then leaves.
     */
    readonly unjudged?: () => void;
  },
): Promise<TriageOutcome> {
  const state = triageState(proposal);
  let findings = screen(state, options.lexicon);
  if (findings.length === 0 && options.judge !== undefined) findings = await options.judge(state);
  if (findings.length > 0) return { kind: "kept-in", findings };

  const url = options.url ?? TYPESAFE_URL;
  if (options.judge === undefined) options.unjudged?.();
  options.announce?.(`leaving this machine: proposal ${proposal.id}'s what/why/impact goes to ${new URL(url).host} for triage (D-059).`);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: TRIAGE_QUESTIONS }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) return { kind: "failed", reason: `TypeSafe answered ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed", reason: "the answer was not JSON" };
  }
  const parsed = parseTriage(proposal, body, (options.now ?? (() => new Date()))());
  return typeof parsed === "string" ? { kind: "failed", reason: parsed } : { kind: "triaged", triage: parsed };
}

export function triagePath(proposalsDir: string, id: string): string {
  return join(proposalsDir, TRIAGE_DIR, `${id}.json`);
}

export async function writeTriage(proposalsDir: string, triage: Triage): Promise<void> {
  const path = triagePath(proposalsDir, triage.proposal);
  await mkdir(join(proposalsDir, TRIAGE_DIR), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(triage, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** A stored triage, or `undefined` when there is none or it does not read. */
export async function readTriage(proposalsDir: string, id: string): Promise<Triage | undefined> {
  try {
    const raw = JSON.parse(await readFile(triagePath(proposalsDir, id), "utf8")) as Triage;
    return typeof raw.risk?.choice === "string" && typeof raw.reversible === "number" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** One short label for a list line: `jev: external 0.92 · undo 0.10 · personal 0.05`. */
export function triageLabel(triage: Triage): string {
  const f = (n: number) => n.toFixed(2);
  return `jev: ${triage.risk.choice} ${f(triage.risk.confidence)} · undo ${f(triage.reversible)} · personal ${f(triage.personal)}`;
}

/** Said beside every triage the owner reads. */
export const TRIAGE_NOTE =
  "Advisory: a model's reading of the proposal's words, not of what running it would do. It approves nothing.";
