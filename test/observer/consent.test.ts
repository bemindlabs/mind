/**
 * The one decision Mind will not make for its owner — and the three ways the
 * mechanism could quietly stop working.
 *
 * 1. **Somebody other than the owner says yes.** There is no `--yes`, and the
 *    acceptance needs a terminal and an exact phrase. That does not prove a
 *    person; it proves a terminal, which is stated in `CAPTURE_LIMITS` and
 *    asserted at the bottom of this file so that deleting the admission breaks
 *    a test.
 * 2. **A refusal leaves something behind.** A "no" has to leave no trace of
 *    having been asked — not a directory, not a file, not a record.
 * 3. **The words change and the consent does not.** This is the one that would
 *    rot silently: a release adds a captured field, the owner never sees the
 *    new list, and capture continues under an agreement to something else. The
 *    digest is what stops it, and the test for it changes the *words* rather
 *    than the hash, because hashing the hash proves nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_LIMITS,
  CONSENT_HEADING,
  consentAllows,
  consentDigest,
  consentGrantedAt,
  consentPath,
  consentPhrase,
  consentText,
  loadConsent,
  requestConsent,
  saveConsent,
  type ConsentIo,
  type ConsentRecord,
} from "../../src/observer/consent.ts";
import { CAPTURE_FIELDS, CAPTURE_VERSION } from "../../src/observer/record.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("example");
const NOW = new Date("2026-09-21T10:00:00.000Z");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-consent-"));
  scratch.push(dir);
  return dir;
}

/** A terminal that answers with whatever it was given. */
function terminal(answer: string, isTTY = true): ConsentIo & { readonly said: string[] } {
  const said: string[] = [];
  return {
    said,
    isTTY,
    write: (line) => said.push(line),
    readLine: async () => answer,
  };
}

describe("asking", () => {
  test("the whole list is shown before the question", async () => {
    const io = terminal(consentPhrase("capture", SUBJECT));
    const outcome = await requestConsent(io, {
      subject: SUBJECT,
      scope: "capture",
      path: "/synthetic/observer",
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    expect(io.said[0]).toBe(CONSENT_HEADING);

    const shown = io.said.join("\n");
    for (const field of CAPTURE_FIELDS) expect(shown).toContain(field);
    for (const limit of CAPTURE_LIMITS) expect(shown).toContain(limit);
    // And the two things somebody is entitled to before agreeing: where it
    // goes, and how to end it.
    expect(shown).toContain("/synthetic/observer");
    expect(shown).toContain("observe purge");
    expect(shown).toContain(consentPhrase("capture", SUBJECT));
  });

  test("not a terminal is a refusal, and says why there is no --yes", async () => {
    const io = terminal(consentPhrase("capture", SUBJECT), false);
    const outcome = await requestConsent(io, {
      subject: SUBJECT,
      scope: "capture",
      path: "/synthetic/observer",
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("--yes");
    // Nothing was even printed: there is nobody there to read it.
    expect(io.said).toEqual([]);
  });

  test("the wrong phrase is a refusal, including near misses", async () => {
    for (const answer of ["yes", "y", "capture", "capture other", "Capture example", ""]) {
      const outcome = await requestConsent(terminal(answer), {
        subject: SUBJECT,
        scope: "capture",
        path: "/synthetic/observer",
        now: NOW,
      });
      expect(outcome.ok, `${JSON.stringify(answer)} should not have been accepted`).toBe(false);
    }
  });

  test("the phrase names the subject, so a habit cannot carry to another one", () => {
    expect(consentPhrase("capture", SUBJECT)).toBe("capture example");
    expect(consentPhrase("seed", SUBJECT)).toBe("seed example");
  });

  test("a second scope is added to the first, and does not re-date it", async () => {
    const previous: ConsentRecord = {
      v: CAPTURE_VERSION,
      basis: "data-subject-self",
      grants: [
        {
          scope: "capture",
          at: "2026-09-01T00:00:00.000Z",
          digest: consentDigest(consentText("capture")),
        },
      ],
    };
    const outcome = await requestConsent(terminal(consentPhrase("seed", SUBJECT)), {
      subject: SUBJECT,
      scope: "seed",
      path: "/synthetic/observer",
      now: NOW,
      previous,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.grants.map((g) => g.scope).sort()).toEqual(["capture", "seed"]);
    // The earlier agreement keeps its own date, and both scopes keep working:
    // a single digest could not have satisfied both, because the two scopes
    // are shown different words.
    expect(consentGrantedAt(outcome.record, "capture")).toBe("2026-09-01T00:00:00.000Z");
    expect(consentGrantedAt(outcome.record, "seed")).toBe(NOW.toISOString());
    expect(consentAllows(outcome.record, "capture")).toBe(true);
    expect(consentAllows(outcome.record, "seed")).toBe(true);
  });

  test("agreeing again after the words moved does not renew the other scope", async () => {
    // The failure this guards: a release changes what is captured, the owner
    // re-reads the list and agrees to `seed` only — and `capture` silently
    // comes back with it.
    const previous: ConsentRecord = {
      v: CAPTURE_VERSION,
      basis: "data-subject-self",
      grants: [
        { scope: "capture", at: "2026-08-01T00:00:00.000Z", digest: consentDigest(["older words"]) },
      ],
    };
    const outcome = await requestConsent(terminal(consentPhrase("seed", SUBJECT)), {
      subject: SUBJECT,
      scope: "seed",
      path: "/synthetic/observer",
      now: NOW,
      previous,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(consentAllows(outcome.record, "seed")).toBe(true);
    expect(consentAllows(outcome.record, "capture")).toBe(false);
  });
});

describe("a refusal leaves nothing behind", () => {
  test("no file is written, in either refusal path", async () => {
    const dir = await sandbox();

    for (const io of [terminal("no"), terminal(consentPhrase("capture", SUBJECT), false)]) {
      const outcome = await requestConsent(io, {
        subject: SUBJECT,
        scope: "capture",
        path: dir,
        now: NOW,
      });
      expect(outcome.ok).toBe(false);
    }

    // `requestConsent` writes nothing at all — the caller is what creates the
    // tree, and only on the accepting path.
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("the consent is to a sentence, not to a program", () => {
  test("agreeing, then reading back, allows the scope that was agreed to", async () => {
    const dir = await sandbox();
    const outcome = await requestConsent(terminal(consentPhrase("capture", SUBJECT)), {
      subject: SUBJECT,
      scope: "capture",
      path: dir,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    await saveConsent(dir, outcome.record);
    const stored = await loadConsent(dir);
    expect(stored?.basis).toBe("data-subject-self");
    expect(consentAllows(stored, "capture")).toBe(true);
    // A scope nobody agreed to, on a real consent — the control for the line
    // above, which would otherwise also pass if `consentAllows` returned true
    // for everything.
    expect(consentAllows(stored, "seed")).toBe(false);
  });

  test("a consent to different words stops capture, without anybody remembering to ask", async () => {
    const dir = await sandbox();
    // What a consent recorded by a release that captured *less* looks like: the
    // record is well-formed, the scope is right, and the words are not today's.
    await saveConsent(dir, {
      v: CAPTURE_VERSION,
      basis: "data-subject-self",
      grants: [
        {
          scope: "capture",
          at: "2026-08-01T00:00:00.000Z",
          digest: consentDigest(["What enabling capture means, in full:", "we keep almost nothing"]),
        },
      ],
    });

    const stored = await loadConsent(dir);
    expect(stored).not.toBeUndefined();
    expect(consentGrantedAt(stored, "capture")).toBe("2026-08-01T00:00:00.000Z");
    expect(consentAllows(stored, "capture")).toBe(false);
  });

  test("the digest really tracks the words, and the two scopes differ", () => {
    expect(consentDigest(consentText("capture"))).not.toBe(consentDigest(consentText("seed")));
    expect(consentDigest(["a"])).not.toBe(consentDigest(["b"]));
    expect(consentDigest(consentText("capture"))).toBe(consentDigest(consentText("capture")));
  });

  test("the digest carries no path, so two machines agreeing to the same words match", () => {
    // If a home directory were inside the hashed text, every owner's consent
    // would be unique for a reason that has nothing to do with what they
    // agreed to — and a shared fixture could never assert the hash at all.
    expect(consentText("capture").join("\n")).not.toContain("/");
  });

  test("no consent at all allows nothing", () => {
    expect(consentAllows(undefined, "capture")).toBe(false);
    expect(consentAllows(undefined, "seed")).toBe(false);
  });

  test("an unreadable or foreign consent file reads as no consent", async () => {
    const dir = await sandbox();
    for (const content of [
      "{",
      "[]",
      '{"v": 99, "basis": "data-subject-self", "grants": []}',
      '{"v": 1, "basis": "somebody-else", "grants": []}',
      '{"v": 1, "basis": "data-subject-self"}',
    ]) {
      await Bun.write(consentPath(dir), content);
      expect(await loadConsent(dir), content).toBeUndefined();
    }
  });
});

describe("the size of what this proves", () => {
  test("the terminal check is admitted to be a terminal check", () => {
    const limits = CAPTURE_LIMITS.join("\n");
    expect(limits).toContain("proves there is a terminal, not that there is a person");
    expect(limits).toContain("script(1)");
    expect(limits).toContain("Mind does not claim to have authenticated anybody");
  });

  test("the owner's ruling on `target` is stated where an owner reads it", () => {
    const limits = CAPTURE_LIMITS.join("\n");
    expect(limits).toContain("never the rest of the line");
    expect(limits).toContain("separate consent");
    expect(limits).toContain("cd somewhere && git push");
  });

  test("`origin` is admitted to be an upper bound", () => {
    const limits = CAPTURE_LIMITS.join("\n");
    expect(limits).toContain("upper bound");
    expect(limits).toContain("MIND_CAPTURE=off");
    expect(limits).toContain("never folded into `owner-prompted`");
  });

  test("the two vendor facts that shape the whole story", () => {
    const limits = CAPTURE_LIMITS.join("\n");
    expect(limits).toContain("grok has no hook mechanism at all");
    expect(limits).toContain("Waiting does not widen that window");
  });
});
