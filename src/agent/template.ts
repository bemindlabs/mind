/**
 * What a new agent repository is made of, before anybody has edited it.
 *
 * An agent is a git repository (D-013), and this file is the whole of what
 * that means on disk. Four properties are decided here rather than argued
 * later:
 *
 * - **Everything git holds is text a human can open** (AC3). No binary, no
 *   database, nothing that needs Mind installed to read. The soul is written
 *   through {@link serializeSoul}, the same function `soul import` uses, so a
 *   template can never drift out of the schema the loader enforces.
 * - **`.gitignore` has exactly one line in it** (AC2). One line is a thing a
 *   person can check at a glance and cannot get subtly wrong; a list of
 *   patterns is a place for a mistake to hide. That is only possible because
 *   every rebuildable thing lives under one directory (D-014).
 * - **Nothing personal has a home here** (I-4, I-6). There is no directory in
 *   this template for data flagged personal, because a directory is an
 *   invitation. That data lives outside the repository entirely, and the
 *   READMEs below say so to whoever opens them first.
 * - **Nothing in the text is specific to the machine it was made on** (AC5,
 *   D-021). No paths, no account names, no hostnames — the only value that
 *   varies is the name and subject the person typed.
 *
 * Empty directories are not a thing git stores, so `memory/` and `consent/`
 * each carry a README. They are not filler: they are the first thing somebody
 * reads when they wonder what belongs in there, and the answer to that matters
 * more in `consent/` than almost anywhere else in the repository.
 */

import {
  PERSON_SCHEMA,
  ROLE_SCHEMA,
  soulOf,
  PERSON_FILE,
  ROLE_FILE,
  type Soul,
  type SoulPerson,
  type SoulRole,
} from "../soul/schema.ts";
import { serializeSoul } from "../soul/serialize.ts";
import type { SubjectId } from "../types.ts";

/** The one directory git does not keep. */
export const DERIVED_DIR = ".mind";
/** Identity, in git. */
export const SOUL_DIR = "soul";
/** Distilled memory, in git. */
export const MEMORY_DIR = "memory";
/** Legal basis for holding a subject's data, in git. */
export const CONSENT_DIR = "consent";

/** The ignore file's name, and its entire contents. */
export const GITIGNORE_FILE = ".gitignore";

/**
 * Every byte of the agent's `.gitignore` (AC2).
 *
 * `/.mind/` and not `.mind/`: the leading slash anchors it to the repository
 * root, so a directory that happens to be called `.mind` further down — in a
 * memory note about the engine itself, say — is not silently excluded from git.
 */
export const GITIGNORE_CONTENT = "/.mind/\n";

/** One file of the template: where it goes, and what is in it. */
export interface TemplateFile {
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  readonly content: string;
}

const ROLE_BODY = (name: string) => `
# ${name} — role knowledge

Everything here belongs to the *job*, not to whoever is holding it. Delete
\`person.md\` and every line below still applies.

The fields above are placeholders. Replace them before this agent is used for
anything: a soul that still says "not described yet" is a soul nobody has
thought about, and \`mind soul verify\` has nothing to measure on it.
`;

const PERSON_BODY = (name: string) => `
# ${name} — personal traits

Voice and manner — how this agent speaks, not what it knows. This file can be
deleted on its own, and the role knowledge in \`${ROLE_FILE}\` survives intact.
`;

/** Exported so recall can tell the untouched template from something written (D-039). */
export const MEMORY_README = `# memory

Distilled memory, in git, as Markdown that opens in any editor. What is in
here is the source of truth. Anything an index holds about it can be thrown
away and rebuilt — that is what \`${DERIVED_DIR}/\` is for.

**Nothing flagged personal goes in this directory.** That data lives outside
the repository altogether, under \`$XDG_DATA_HOME/mind/<subject>/personal/\` —
a path Mind resolves in code and refuses to place inside any git checkout —
for three reasons that are all about being able to take it back:

- \`git clean -fdx\` deletes ignored files, so "ignored" is not "kept safe";
- one wrong line in \`.gitignore\` and it is committed, and git remembers what
  it is asked to forget;
- copying this directory somewhere else would carry it along unnoticed, which
  is the failure that cannot be undone.

The repository guard (S0.4) refuses to commit anything staged under a
\`personal/\` directory, and scans what you stage for credentials. It cannot see
personal information written as prose — a name, an address, a diagnosis — and
says so on every run, including the ones that pass.

Nothing has been ingested yet, and nothing should be until the local-only guard
is done.
`;

/** Is `text` the README `mind new` writes, untouched? (D-039) Any edit makes it the person's own file, read like a note. */
export function isUntouchedMemoryReadme(text: string): boolean {
  return text === MEMORY_README;
}

const CONSENT_README = `# consent

The legal basis for holding a subject's data — one record per subject, for any
subject who is not the person running Mind.

Empty is the correct state while the only subject is that person: there is
nobody to ask. The directory exists from the first commit anyway, because the
moment a second subject appears, a consent record that was never designed for
is a consent record that arrives too late to be true.
`;

/**
 * The soul a new agent starts with: valid, placeholder, and honest about it.
 *
 * The prohibitions are not placeholders. Three of them restate invariants this
 * project does not let a soul opt out of — saying it is an AI (I-5), not
 * letting personal data leave without a per-message human decision (I-6), and
 * not carrying secrets into git (D-013). Someone editing this file can still
 * delete them; what they cannot do is fail to see them.
 */
export function templateSoul(subject: SubjectId, name: string): Soul {
  const role: SoulRole = {
    schema: ROLE_SCHEMA,
    subject,
    name,
    role: "not described yet — say in one line what this agent is for",
    prohibitions: [
      "never claims to be a person, and says plainly that it is an AI whenever asked",
      "never lets anything flagged personal leave this machine without a human approving that message",
      "never puts a credential, a token, or anything told in confidence into git",
    ],
    scope: {
      does: "not described yet — say what this agent takes on",
      does_not: "not described yet — say out loud what this agent declines",
    },
    extra: {},
    body: ROLE_BODY(name),
  };

  const person: SoulPerson = {
    schema: PERSON_SCHEMA,
    subject,
    tone: ["plain", "specific"],
    addresses_user_as: "you",
    refers_to_self_as: [name],
    principles: [
      "check the real state before acting on what was remembered",
      "say plainly what was skipped",
      "keep what git holds readable without Mind installed",
    ],
    inherits_from: [],
    body: PERSON_BODY(name),
  };

  return soulOf(subject, role, person);
}

/**
 * Every file a new agent repository starts with, in a fixed order.
 *
 * Fixed order so that two runs of `mind new` print the same list and write
 * the same tree — the same reason `render` carries no timestamp.
 */
export function templateFiles(subject: SubjectId, name: string): readonly TemplateFile[] {
  const soul = serializeSoul(templateSoul(subject, name));
  return [
    { path: GITIGNORE_FILE, content: GITIGNORE_CONTENT },
    { path: `${SOUL_DIR}/${ROLE_FILE}`, content: soul.role },
    { path: `${SOUL_DIR}/${PERSON_FILE}`, content: soul.person },
    { path: `${MEMORY_DIR}/README.md`, content: MEMORY_README },
    { path: `${CONSENT_DIR}/README.md`, content: CONSENT_README },
  ];
}
