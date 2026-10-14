/**
 * The one decision Mind will not make on the owner's behalf.
 *
 * ## Why this is not a flag
 *
 * D-024 and D-025 were technical calls, and the owner delegated those. Whether
 * a program may keep a record of what its owner does, minute by minute, is not
 * a technical call, and it cannot be delegated — not to Mind and not to an
 * agent acting for the owner. So capture ships **off**, and turning it on costs
 * two deliberate acts: this command, and then connecting the hook by hand
 * (`observe hook --print` only prints).
 *
 * Three properties follow, and each of them exists because of a specific way
 * this could otherwise go wrong.
 *
 * - **There is no `--yes`.** Every other writing command in Mind has one, and
 *   this one deliberately does not: an agent running as the owner can type
 *   `--yes` for them, and an agent is exactly who would. The acceptance is a
 *   phrase typed at a terminal instead.
 * - **The consent is to a sentence, not to a program.** {@link consentDigest}
 *   hashes the words that were shown. A release that changes what is captured
 *   changes the words, changes the hash, and capture stops until the owner has
 *   read the new list. Nothing needs to remember to ask.
 * - **The consent lives inside the observer directory.** So `observe purge` and
 *   `mind erase` remove it along with the records, without either of them
 *   being taught about this file. Deleting the data *is* withdrawing consent,
 *   and capture stops by itself (I-4).
 *
 * ## What the terminal check proves, and what it does not
 *
 * It proves there is a terminal. It does not prove there is a person: `script(1)`
 * gives any process a pty, and an agent with a shell can use it. That is the
 * same class of limit `OBSERVER_LIMITS` already admits about the capture notice
 * — a type can witness a call, not a reading — and it is written into
 * {@link CAPTURE_LIMITS} rather than left for a reader to work out.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_FILE_MODE } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { CAPTURE_FIELDS, CAPTURE_VERSION } from "./record.ts";

/** The file, inside the observer directory so that purge and erase reach it. */
export const CONSENT_FILE = "consent.json";

/**
 * What a consent covers.
 *
 * Two, and they are asked for separately on purpose. Capturing what happens
 * from now on and importing seven weeks of what already happened are different
 * things to agree to: one is a decision about the future, the other hands over
 * a body of history that exists whether or not this program was ever installed.
 */
export type ConsentScope = "capture" | "seed";

/**
 * One scope agreed to, on one day, to one set of words.
 *
 * Per scope rather than per file, because the two scopes are shown *different*
 * text and a single digest could only ever match one of them. A record holding
 * `["capture", "seed"]` beside one hash would have had a seed permission that
 * silently never worked — or, worse, a capture permission that the seed's hash
 * happened to satisfy.
 */
export interface ConsentGrant {
  readonly scope: ConsentScope;
  /** When this scope was agreed to, ISO-8601. */
  readonly at: string;
  /** sha256 of the words that were shown for it. See {@link consentDigest}. */
  readonly digest: string;
}

/** Everything written down when somebody says yes. */
export interface ConsentRecord {
  readonly v: number;
  /**
   * On what footing. One value today, and it is the honest one: the person
   * whose behaviour is recorded is the person who agreed. S7.3 will have more
   * to say about bases; this field is the hook it will hang them on.
   */
  readonly basis: "data-subject-self";
  /** One per scope agreed to, oldest first. */
  readonly grants: readonly ConsentGrant[];
}

/** The heading the consent text is printed under. One copy, asserted by test. */
export const CONSENT_HEADING = "What enabling capture means, in full:";

/**
 * The words an owner is shown, and the words that are hashed.
 *
 * Built from {@link CAPTURE_FIELDS} and {@link CAPTURE_LIMITS} rather than
 * written out again here, so there is no second copy to keep honest — and so a
 * field added to capture cannot be added without changing what was agreed to.
 *
 * Deliberately free of any path: the digest has to mean the same thing on two
 * machines, and a home directory in it would make every owner's consent unique
 * for a reason that has nothing to do with what they agreed to. The path is
 * printed beside this text, not inside it.
 */
export function consentText(scope: ConsentScope): readonly string[] {
  return [
    CONSENT_HEADING,
    `scope: ${scope}`,
    ...CAPTURE_FIELDS.map((line) => `  - ${line}`),
    "The size of what this is:",
    ...CAPTURE_LIMITS.map((line) => `  - ${line}`),
  ];
}

/** sha256, hex, of the exact lines that were shown — newline-joined. */
export function consentDigest(lines: readonly string[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(lines.join("\n"));
  return hasher.digest("hex");
}

/** The phrase that has to be typed. Names the subject, so a habit cannot carry. */
export function consentPhrase(scope: ConsentScope, subject: SubjectId): string {
  return `${scope} ${subject}`;
}

/** Where a subject's consent lives, given their observer directory. */
export function consentPath(observerPath: string): string {
  return join(observerPath, CONSENT_FILE);
}

/**
 * The terminal, as a value, so the acceptance path can be tested.
 *
 * `bin/commands/observe.ts` builds one of these from `process.stdin` and
 * `process.stdout`;
 * a test builds one from arrays. The decision about *whether* there is a
 * terminal is still made out here — `isTTY` is a fact about the process, and
 * this type only carries it.
 */
export interface ConsentIo {
  /** True when both ends really are a terminal. Never inferred in this file. */
  readonly isTTY: boolean;
  readonly write: (line: string) => void;
  /** One line from the owner, without its newline. */
  readonly readLine: () => Promise<string>;
}

/** Why a consent was not given, or the record that says it was. */
export type ConsentOutcome =
  | { readonly ok: true; readonly record: ConsentRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Show the whole thing, and take an answer.
 *
 * Prints the text, the path the data will live at, and the two commands that
 * end it — then waits for the exact phrase. Anything else is a refusal, and a
 * refusal writes nothing at all: not a record of having been asked, not a
 * directory. Somebody who said no has left no trace of having been asked.
 *
 * @param previous The consent already on disk, when there is one. A second
 *   scope is added to it rather than replacing it, so agreeing to a seed does
 *   not quietly re-date the original agreement to capture.
 */
export async function requestConsent(
  io: ConsentIo,
  options: {
    readonly subject: SubjectId;
    readonly scope: ConsentScope;
    readonly path: string;
    readonly now: Date;
    readonly previous?: ConsentRecord | undefined;
  },
): Promise<ConsentOutcome> {
  if (!io.isTTY) {
    return {
      ok: false,
      reason:
        "this asks for consent to record what you do, so it has to be answered at a terminal. " +
        "There is deliberately no --yes: a program running as you could type one, and this is " +
        "the one decision Mind will not take from an argument.",
    };
  }

  const lines = consentText(options.scope);
  for (const line of lines) io.write(line);
  io.write("");
  io.write(`It will be written to: ${options.path}`);
  io.write(`Stop it at any time by removing the hook you added, or by deleting the data:`);
  io.write(`  mind observe disable --subject ${options.subject}`);
  io.write(`  mind observe purge   --subject ${options.subject}`);
  io.write(
    "Deleting the data removes this consent with it, and capture stops on its own — there is no " +
      "second switch to remember.",
  );
  io.write("");

  const phrase = consentPhrase(options.scope, options.subject);
  io.write(`To agree, type exactly:  ${phrase}`);

  const answer = (await io.readLine()).trim();
  if (answer !== phrase) {
    return {
      ok: false,
      reason: `that was not ${JSON.stringify(phrase)}, so nothing was enabled and nothing was written`,
    };
  }

  // Other scopes keep their own grants untouched — agreeing to a seed today
  // neither re-dates an earlier agreement to capture nor renews one whose
  // words have since moved. This scope's grant is replaced, dated now.
  const others = (options.previous?.grants ?? []).filter((grant) => grant.scope !== options.scope);

  return {
    ok: true,
    record: {
      v: CAPTURE_VERSION,
      basis: "data-subject-self",
      grants: [
        ...others,
        { scope: options.scope, at: options.now.toISOString(), digest: consentDigest(lines) },
      ],
    },
  };
}

/** Read the consent back, or undefined when there is none or it cannot be read. */
export async function loadConsent(observerPath: string): Promise<ConsentRecord | undefined> {
  let text: string;
  try {
    text = await readFile(consentPath(observerPath), "utf8");
  } catch {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const raw = value as Record<string, unknown>;
  const grants = raw["grants"];
  if (raw["v"] !== CAPTURE_VERSION) return undefined;
  if (raw["basis"] !== "data-subject-self" || !Array.isArray(grants)) return undefined;

  const known: ConsentGrant[] = [];
  for (const entry of grants) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const fields = entry as Record<string, unknown>;
    const scope = fields["scope"];
    if (scope !== "capture" && scope !== "seed") continue;
    if (typeof fields["at"] !== "string" || typeof fields["digest"] !== "string") continue;
    known.push({ scope, at: fields["at"], digest: fields["digest"] });
  }
  return { v: CAPTURE_VERSION, basis: "data-subject-self", grants: known };
}

/** Write it. The caller has already created the directory through `ensureObserverDir`. */
export async function saveConsent(observerPath: string, record: ConsentRecord): Promise<void> {
  await writeFile(consentPath(observerPath), `${JSON.stringify(record, null, 2)}\n`, {
    mode: STATE_FILE_MODE,
  });
}

/**
 * May capture write, right now, for this scope?
 *
 * Three ways to be false, and all three are silent at the call site: no consent
 * at all, no consent for this scope, and a consent to *different words*. The
 * third is the one that does the work over time — a release that changes what
 * is captured stops capturing until the owner has seen the new list.
 */
export function consentAllows(
  record: ConsentRecord | undefined,
  scope: ConsentScope,
): boolean {
  const grant = record?.grants.find((entry) => entry.scope === scope);
  if (grant === undefined) return false;
  return grant.digest === consentDigest(consentText(scope));
}

/** When a scope was agreed to, or undefined when it was not. For `observe status`. */
export function consentGrantedAt(
  record: ConsentRecord | undefined,
  scope: ConsentScope,
): string | undefined {
  return record?.grants.find((entry) => entry.scope === scope)?.at;
}

/**
 * The size of what capture proves — printed beside the fields, and hashed with
 * them.
 *
 * Written here rather than only in a document for the reason `GUARD_LIMITS` and
 * `OBSERVER_LIMITS` are: a criterion that promises more than it checks gets
 * ticked, and then the tick is what people read. These are inside the consent
 * text on purpose, so agreeing to capture is agreeing to something whose limits
 * were on the same screen.
 */
export const CAPTURE_LIMITS: readonly string[] = [
  "`origin: owner-prompted` is an upper bound, not a proof that a person typed. It comes from the " +
    "vendor's own `source` field on the prompt that started the turn — measured on claude 2.1.278, " +
    "`user` means the interactive composer and `sdk` means `claude -p` or the Agent SDK, which is " +
    "what a fleet launcher uses. A launcher that drove the interactive composer would be recorded " +
    "as you. Set MIND_CAPTURE=off in an unattended process to keep it out of this data entirely.",
  "a payload that carries no `source` at all is recorded as `origin: unknown` and is never folded " +
    "into `owner-prompted`. The vendor's own schema says the field may be absent, and guessing in " +
    "the owner's favour is how an agent ends up learning the fleet's habits as yours.",
  "typing the phrase at a terminal proves there is a terminal, not that there is a person. " +
    "`script(1)` gives any process a pty. Mind does not claim to have authenticated anybody, and " +
    "no program on this machine can.",
  "a command's target is its program name and first subcommand only — `git commit`, never the rest " +
    "of the line. Resolution was traded for leak surface: a command line is where tokens, URLs and " +
    "people's names most often sit, and the pre-commit scan's own blind-spot list says it cannot " +
    "see personal data written as prose. Anyone who needs full argv has to design a separate " +
    "consent for it.",
  "that reduction is literal, not clever: `cd somewhere && git push` is recorded as `cd`. A shell " +
    "parser that got precedence wrong would keep the half of the line this rule exists to drop, so " +
    "the first word is what is kept and the understatement is stated here instead.",
  "nothing captures until you connect a hook yourself. `mind observe hook --print` prints a " +
    "snippet and writes nothing; Mind never edits another program's configuration. grok has no " +
    "hook mechanism at all, so grok can only ever be seeded.",
  "a seed reaches as far back as the vendor kept files, and no further — measured 2026-09-21: " +
    "about seven weeks for claude and eleven days for grok. Waiting does not widen that window.",
];
