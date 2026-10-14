/**
 * Which identity this machine is wearing — read off the bytes, never remembered.
 *
 * D-011 made Mind a runtime that *wears* identities rather than one that has
 * one, and the first thing that follows from it is a question somebody has to
 * be able to ask out loud: **which one is on right now?** S0.2 AC5 asks
 * `doctor` for it and S1.6 AC1 asks the switch for it; this is the one function
 * both of them call, so that there is one answer rather than two that drift.
 *
 * Three decisions, each of which is the difference between a report and a
 * guess:
 *
 * - **Derived, never stored.** There is deliberately no "currently worn" file,
 *   no pointer under the state root, nothing to go stale. The worn identity is
 *   whatever the marker in each vendor's instruction file says it is, read
 *   fresh. A stored pointer would be right until something else wrote the file,
 *   and it would keep being confident afterwards — which is exactly the silent
 *   failure this project exists to catch.
 * - **Mixed is a verdict, not an average.** A's block in one file and B's in
 *   another is neither "wearing A" nor "wearing B": it is a half-finished
 *   switch, and it is the shape a memory leak across identities (I-3) takes on
 *   disk. So it gets its own verdict, and {@link residue} names the files that
 *   still carry the identity that was supposed to be gone (AC3).
 * - **Backends with no file are reported as such, not as "nothing worn".**
 *   `ollama` has no instruction file at any scope; its identity arrives in the
 *   system field of each request and is gone when the request is. This function
 *   cannot see that channel and says so rather than counting it as empty.
 *
 * Read-only: `Bun.file().text()` and nothing else. Asking what is worn must
 * never be the thing that creates or changes it.
 */

import type { SubjectId } from "../types.ts";
import { locate } from "./block.ts";
import type { Target } from "./targets.ts";

/** What one place turned out to hold. */
export type WornState =
  /** A well-formed block whose body still hashes to what its marker claims. */
  | "worn"
  /** A block for this subject whose body was edited by hand since Mind wrote it. */
  | "edited"
  /** The file is there and holds no Mind block. */
  | "absent"
  /** The file the vendor reads does not exist. */
  | "missing"
  /** Unreadable, or holding markers Mind refuses to interpret. */
  | "unreadable"
  /** Not a file at all: the identity travels in each request instead. */
  | "system-field";

/** One backend's instruction file, and whose identity is in it. */
export interface WornPlace {
  readonly backend: string;
  readonly display: string;
  readonly state: WornState;
  /** One line a human can act on. */
  readonly detail: string;
  readonly path?: string;
  /** Whose block is in the file, when there is one — including when `edited`. */
  readonly subject?: SubjectId;
}

/** The whole machine's answer, in one word. */
export type WornVerdict =
  /** No Mind block anywhere Mind can look. */
  | "none"
  /** Every block found names the same subject. */
  | "one"
  /** Two or more subjects have blocks — a switch that did not finish (AC3). */
  | "mixed";

/** What this machine is wearing, and everything that qualifies the answer. */
export interface WornReport {
  readonly verdict: WornVerdict;
  /** Set only for `one`: there is no single answer to report otherwise. */
  readonly subject?: SubjectId;
  /** Every subject with a block somewhere, sorted, so `mixed` can be read. */
  readonly subjects: readonly SubjectId[];
  readonly places: readonly WornPlace[];
  /** Things that would make a reader wrong to trust the verdict on its own. */
  readonly caveats: readonly string[];
}

/**
 * Read one target file, keeping "not there" apart from "could not be read".
 *
 * The two mean different things to whoever is reading the report — one is a
 * backend Mind has never written to, the other is a file Mind cannot see
 * into — so they are two results rather than one `undefined` the caller has to
 * ask the filesystem about a second time.
 */
type FileRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string };

async function readText(path: string): Promise<FileRead> {
  const handle = Bun.file(path);
  if (!(await handle.exists())) return { kind: "missing" };
  try {
    return { kind: "text", text: await handle.text() };
  } catch (cause) {
    return { kind: "unreadable", reason: `could not be read as text: ${String(cause)}` };
  }
}

async function placeFor(target: Target): Promise<WornPlace> {
  if (target.kind === "system-field") {
    return {
      backend: target.backend,
      display: target.display,
      state: "system-field",
      detail:
        "no instruction file at any scope — whatever identity this backend is given arrives in " +
        "the system field of a request and is gone with it, so nothing on disk can be read as " +
        "what it is wearing",
    };
  }

  const path = target.path;
  const read = await readText(path);
  if (read.kind !== "text") {
    return {
      backend: target.backend,
      display: target.display,
      path,
      state: read.kind,
      detail:
        read.kind === "missing" ? "the file this vendor reads does not exist" : read.reason,
    };
  }

  const found = locate(read.text);
  if (found.kind === "refused") {
    return {
      backend: target.backend,
      display: target.display,
      path,
      state: "unreadable",
      detail: found.reason,
    };
  }
  if (found.kind === "absent") {
    return {
      backend: target.backend,
      display: target.display,
      path,
      state: "absent",
      detail: "no Mind block in this file",
    };
  }

  const block = found.block;
  return {
    backend: target.backend,
    display: target.display,
    path,
    subject: block.subject,
    state: block.intact ? "worn" : "edited",
    detail: block.intact
      ? `holds the block of subject ${block.subject}`
      : `holds the block of subject ${block.subject}, edited by hand since Mind wrote it — ` +
        "what the model reads is not what Mind put there",
  };
}

/**
 * The limits of this answer, printed with it rather than left to be discovered.
 *
 * Every line here is something a reader would otherwise assume the verdict
 * covers. The last one is the one that matters most for I-4: Mind can take
 * back what it wrote, and it has no way at all to reach what a backend was told
 * in a session that already happened.
 */
export const WORN_LIMITS: readonly string[] = [
  "this reads the instruction files of the backends it was given, and nothing else — the file " +
    "Mind writes for each, and the other files the registry records that backend reading. A " +
    "backend nobody named, a file the registry does not list, or an identity injected by a " +
    "session-start hook is outside what it can see.",
  "a backend whose only channel is the system field of a request wears nothing between turns; " +
    "there is no file to read and this report does not invent one.",
  "`edited` means a human changed the text inside Mind's markers. The subject named there is " +
    "who Mind wrote, not necessarily what the model now reads.",
  "nothing here is about what a backend was already told. A turn that has happened cannot be " +
    "unsaid by changing a file afterwards (I-4).",
];

/**
 * Read every target and say which identity, if any, this machine is wearing.
 *
 * @param targets Resolved by the caller — as `apply` and `verify` resolve them —
 *   so that the files read here are the same files those commands write and
 *   measure, against the same home.
 */
export async function wornReport(targets: readonly Target[]): Promise<WornReport> {
  const places: WornPlace[] = [];
  for (const target of targets) {
    places.push(await placeFor(target));
    // A file the vendor also reads, which Mind does not write (kimi's home AGENTS.md): only what is in
    // one is news — a block, or a file that cannot be read. Missing or empty is the ordinary state.
    if (target.kind !== "file") continue;
    for (const extra of target.alsoReads) {
      const place = await placeFor({ ...target, backend: extra.by, path: extra.path, alsoReads: [] });
      if (place.subject !== undefined || place.state === "unreadable") {
        places.push({ ...place, detail: `also read by ${extra.by}, not written by Mind: ${place.detail}` });
      }
    }
  }

  // `edited` counts. A block a human rewrote still names a subject, and leaving
  // it out of the tally would report a clean switch over a file that still has
  // the previous identity's name on it.
  const subjects = [
    ...new Set(places.flatMap((place) => (place.subject === undefined ? [] : [place.subject]))),
  ].sort();

  const verdict: WornVerdict =
    subjects.length === 0 ? "none" : subjects.length === 1 ? "one" : "mixed";

  const caveats = [...WORN_LIMITS];
  if (verdict === "mixed") {
    caveats.unshift(
      `${subjects.length} identities have blocks on this machine (${subjects.join(", ")}). ` +
        "That is a switch that did not finish, not a machine wearing two things: re-run " +
        "`mind soul apply` for the one you mean, and check the files named above (I-3).",
    );
  }
  for (const place of places) {
    if (place.state === "edited") {
      caveats.unshift(`${place.path}: ${place.detail}`);
    }
    if (place.state === "unreadable") {
      caveats.unshift(
        `${place.path}: Mind cannot read this file, so it cannot say whether an identity is ` +
          `in it — ${place.detail}`,
      );
    }
  }

  return {
    verdict,
    ...(verdict === "one" ? { subject: subjects[0]! } : {}),
    subjects,
    places,
    caveats,
  };
}

/**
 * Places that still carry `subject`'s block — S1.6 AC3, stated as a list.
 *
 * "No residue" is not a feeling about a diff; it is this function returning
 * nothing after a switch. `edited` places are included on purpose: a block
 * somebody rewrote by hand is residue that `apply` will refuse to replace,
 * which makes it the most persistent kind there is.
 */
export function residue(report: WornReport, subject: SubjectId): readonly WornPlace[] {
  return report.places.filter((place) => place.subject === subject);
}

/**
 * True when `subject` is the only identity on this machine, intact everywhere.
 *
 * Strict about `edited` and `unreadable`: both mean Mind does not know what
 * the model will read, and "probably wearing the right thing" is not an answer
 * this command is allowed to give.
 */
export function wearsOnly(report: WornReport, subject: SubjectId): boolean {
  if (report.verdict !== "one" || report.subject !== subject) return false;
  return !report.places.some((place) => place.state === "edited" || place.state === "unreadable");
}

/** One line per place, plus the verdict — the shape `doctor` will print (S0.2). */
export function formatWorn(report: WornReport): readonly string[] {
  const lines: string[] = [];
  const headline =
    report.verdict === "none"
      ? "wearing nothing — no Mind block in any file that was read"
      : report.verdict === "one"
        ? `wearing ${report.subject}`
        : `wearing ${report.subjects.length} identities at once: ${report.subjects.join(", ")}`;
  lines.push(headline);

  for (const place of report.places) {
    const where = place.path ?? "no file at any scope";
    lines.push(`  ${place.backend.padEnd(8)} ${place.state.padEnd(13)} ${where}`);
    lines.push(`           ${place.detail}`);
  }
  return lines;
}
