/**
 * Two souls that exist only in a temporary directory, and share nothing.
 *
 * D-021 says the engine carries no path, name or account of the owner and that
 * every fixture is synthetic. S1.6 needs more than synthetic, though: it needs
 * two identities whose facts are **provably disjoint**, because the whole
 * measurement is "B cannot say what A knows" and two souls that happened to
 * share a phrase would make a pass mean nothing.
 *
 * So the facts here are deliberately arbitrary sentences about fictional
 * procedures, and `sharedFacts` (`src/soul/isolation.ts`) is asserted to be
 * empty in both directions before any of them is used as evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One synthetic identity: what to write, and what it uniquely knows. */
export interface SyntheticSoul {
  readonly subject: string;
  readonly name: string;
  /** `[extra]` — the table `renderSoul` writes into the applied block. */
  readonly facts: Readonly<Record<string, string>>;
}

/** Identity A. Five facts, none of which B carries. */
export const SOUL_A: SyntheticSoul = {
  subject: "alpha-keeper",
  name: "Alpha Keeper",
  facts: {
    "archive-window": "the alpha archive is sealed after eleven working days",
    "counting-day": "alpha counts its shelves on the second Tuesday of a quarter",
    "handover-word": "an alpha handover is signed off with the word marmalade",
    "spare-key": "the alpha spare key lives behind the third ledger on the west shelf",
    "tea-order": "alpha takes its tea with two spoons of condensed milk and no sugar",
  },
};

/** Identity B. Five different facts, about different things. */
export const SOUL_B: SyntheticSoul = {
  subject: "beta-keeper",
  name: "Beta Keeper",
  facts: {
    "archive-window": "the beta archive is sealed after four working days",
    "counting-day": "beta counts its shelves on the last Friday before a holiday",
    "handover-word": "a beta handover is signed off with the word periwinkle",
    "spare-key": "the beta spare key lives inside the blue tin on the north windowsill",
    "tea-order": "beta takes its tea black with a slice of lemon and one clove",
  },
};

function roleText(soul: SyntheticSoul): string {
  const extra = Object.entries(soul.facts)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join("\n");

  return `+++
schema = "mind/soul-role@1"
subject = ${JSON.stringify(soul.subject)}
name = ${JSON.stringify(soul.name)}
role = "Keeps the ${soul.name} fixture tidy"
prohibitions = [
  "never deletes a shelf without an explicit confirmation",
  "never writes down a key that is not its own",
]

[scope]
does = "tends the ${soul.name} shelves and answers questions about them"
does_not = "does not touch another keeper's shelves"

[extra]
${extra}
+++

# ${soul.name} — role knowledge

Procedures that belong to the job rather than to whoever holds it. Synthetic:
this fixture describes no real agent and no real procedure.
`;
}

function personText(soul: SyntheticSoul): string {
  return `+++
schema = "mind/soul-person@1"
subject = ${JSON.stringify(soul.subject)}
tone = ["plain", "unhurried"]
addresses_user_as = ${JSON.stringify(soul.name === "Alpha Keeper" ? "shelf-holder" : "tin-holder")}
refers_to_self_as = [${JSON.stringify(soul.name)}]
principles = [
  "says what was skipped",
  "counts before it reports a count",
]
+++

# ${soul.name} — personal traits

Voice and habits. Delete this file and the role above still applies.
`;
}

/**
 * Write one synthetic soul into `parent/<subject>/` and return the directory.
 *
 * Two files, because a soul is two files — the same shape `soul apply` and
 * `--as` read, so a test built on this is testing the real loader.
 */
export async function writeSoul(
  parent: string,
  soul: SyntheticSoul,
  dirName: string = soul.subject,
): Promise<string> {
  const dir = join(parent, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "role.md"), roleText(soul));
  await writeFile(join(dir, "person.md"), personText(soul));
  return dir;
}

/** Every fact value this soul carries, for asserting none of them is left behind. */
export function factValues(soul: SyntheticSoul): readonly string[] {
  return Object.values(soul.facts);
}
