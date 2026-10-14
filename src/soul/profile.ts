/**
 * An agent's profile on every axis, as one plain object a form can hold (D-074).
 *
 * The soul is two TOML-fronted files; a page cannot edit TOML safely, and
 * should not have to. This is the soul's editable fields laid flat — identity,
 * scope, prohibitions, voice, principles, whose knowledge it carries, and the
 * two notes bodies — with the one translation back that `soul edit` uses.
 * Nothing here writes: the command validates the result with `parseSoul`
 * (the firewall included, D-046) before any byte reaches disk.
 */

import type { Soul } from "./schema.ts";

export interface Profile {
  readonly name: string;
  readonly role: string;
  readonly does: string;
  readonly doesNot: string;
  readonly prohibitions: readonly string[];
  readonly tone: readonly string[];
  readonly addressesUserAs: string;
  readonly refersToSelfAs: readonly string[];
  readonly principles: readonly string[];
  readonly inheritsFrom: readonly string[];
  readonly roleNotes: string;
  readonly personNotes: string;
}

export const PROFILE_FIELDS: readonly (keyof Profile)[] = [
  "name", "role", "does", "doesNot", "prohibitions", "tone", "addressesUserAs", "refersToSelfAs", "principles", "inheritsFrom", "roleNotes", "personNotes",
];

const LISTS = new Set<keyof Profile>(["prohibitions", "tone", "refersToSelfAs", "principles", "inheritsFrom"]);
const MAX_LINE = 400;
const MAX_NOTES = 20_000;
const MAX_ITEMS = 40;

export function profileOf(soul: Soul): Profile {
  return {
    name: soul.role.name,
    role: soul.role.role,
    does: soul.role.scope.does,
    doesNot: soul.role.scope.does_not,
    prohibitions: soul.role.prohibitions,
    tone: soul.person.tone,
    addressesUserAs: soul.person.addresses_user_as,
    refersToSelfAs: soul.person.refers_to_self_as,
    principles: soul.person.principles,
    inheritsFrom: soul.person.inherits_from,
    roleNotes: soul.role.body,
    personNotes: soul.person.body,
  };
}

/**
 * A profile as the form sent it, or every reason it is not one. Lists lose
 * blank lines and surrounding space; nothing else is changed on its behalf.
 */
export function readProfile(body: unknown): { readonly ok: true; readonly profile: Profile } | { readonly ok: false; readonly problems: readonly string[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  for (const key of PROFILE_FIELDS) {
    const v = b[key];
    if (LISTS.has(key)) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        problems.push(`${key} is a list of lines`);
        continue;
      }
      const items = (v as string[]).map((x) => x.trim()).filter((x) => x !== "");
      if (items.length > MAX_ITEMS) problems.push(`${key} has more than ${MAX_ITEMS} lines`);
      if (items.some((x) => x.length > MAX_LINE)) problems.push(`a line in ${key} is longer than ${MAX_LINE} characters`);
      out[key] = items;
    } else {
      if (typeof v !== "string") {
        problems.push(`${key} is text`);
        continue;
      }
      const notes = key === "roleNotes" || key === "personNotes";
      const text = notes ? v : v.trim();
      if (text.length > (notes ? MAX_NOTES : MAX_LINE)) problems.push(`${key} is longer than ${notes ? MAX_NOTES : MAX_LINE} characters`);
      out[key] = text;
    }
  }
  for (const key of Object.keys(b)) if (!PROFILE_FIELDS.includes(key as keyof Profile)) problems.push(`${key} is not part of a profile`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, profile: out as unknown as Profile };
}

/** The soul with this profile in it. Schema, subject and anything else the files hold stay as they were. */
export function applyProfile(soul: Soul, p: Profile): Soul {
  const notes = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);
  return {
    ...soul,
    role: {
      ...soul.role,
      name: p.name,
      role: p.role,
      prohibitions: p.prohibitions,
      scope: { does: p.does, does_not: p.doesNot },
      body: notes(p.roleNotes),
    },
    person: {
      ...soul.person,
      tone: p.tone,
      addresses_user_as: p.addressesUserAs,
      refers_to_self_as: p.refersToSelfAs,
      principles: p.principles,
      inherits_from: p.inheritsFrom,
      body: notes(p.personNotes),
    },
  };
}

/** Which fields differ, in the order a person reads them. */
export function changedFields(before: Profile, after: Profile): readonly (keyof Profile)[] {
  return PROFILE_FIELDS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}
