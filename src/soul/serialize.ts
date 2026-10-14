/**
 * Writing a soul back out, in a form the next reader can edit by hand.
 *
 * The contract this file owes the rest of the system is narrow and testable:
 * `load(serialize(soul))` equals `soul`, and the Markdown body comes out
 * byte-identical to what went in. That is I-2 in miniature — if Mind cannot
 * rewrite a file it read without changing it, then Mind, not git, has
 * quietly become the source of truth.
 *
 * Two consequences show up in the code. Key order is fixed rather than
 * whatever `Object.keys` returns, so a diff after an edit shows the edit.
 * And non-ASCII text is written through untouched: Thai is not escaped to
 * `ท`, because a soul file that a human cannot read is a soul file a
 * human cannot check.
 */

import type { Soul, SoulPerson, SoulRole } from "./schema.ts";
import { DELIMITER } from "./frontmatter.ts";

/**
 * A TOML basic string.
 *
 * Only what TOML actually requires is escaped — backslash, quote, and the
 * control characters that cannot appear literally. Everything else, including
 * every script above ASCII, is emitted as-is.
 */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\b":
        out += "\\b";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\r":
        out += "\\r";
        break;
      default: {
        const code = char.codePointAt(0)!;
        out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : char;
      }
    }
  }
  return `${out}"`;
}

/** An array of strings: inline when it holds one, one-per-line when it holds more. */
function tomlArray(values: readonly string[]): string {
  if (values.length <= 1) return `[${values.map(tomlString).join("")}]`;
  return `[\n${values.map((v) => `  ${tomlString(v)},`).join("\n")}\n]`;
}

/** `key = value` with the value already rendered. */
function pair(key: string, rendered: string): string {
  return `${key} = ${rendered}`;
}

/** Wrap a rendered TOML table and a body into one soul file. */
function file(toml: readonly string[], body: string): string {
  return `${DELIMITER}\n${toml.join("\n")}\n${DELIMITER}\n${body}`;
}

/**
 * Render `role.md`.
 *
 * The tag is the one the soul carries.
 */
export function serializeRole(role: SoulRole): string {
  const toml = [
    pair("schema", tomlString(role.schema)),
    pair("subject", tomlString(role.subject)),
    pair("name", tomlString(role.name)),
    pair("role", tomlString(role.role)),
    pair("prohibitions", tomlArray(role.prohibitions)),
    "",
    "[scope]",
    pair("does", tomlString(role.scope.does)),
    pair("does_not", tomlString(role.scope.does_not)),
  ];

  const extraKeys = Object.keys(role.extra).sort();
  if (extraKeys.length > 0) {
    toml.push("", "[extra]");
    for (const key of extraKeys) toml.push(pair(key, tomlString(role.extra[key]!)));
  }

  return file(toml, role.body);
}

/** Render `person.md`. */
export function serializePerson(person: SoulPerson): string {
  return file(
    [
      pair("schema", tomlString(person.schema)),
      pair("subject", tomlString(person.subject)),
      pair("tone", tomlArray(person.tone)),
      pair("addresses_user_as", tomlString(person.addresses_user_as)),
      pair("refers_to_self_as", tomlArray(person.refers_to_self_as)),
      pair("principles", tomlArray(person.principles)),
      // Written only when there is someone to name: a soul that inherits from
      // nobody should not grow an empty key it never had (D-046).
      ...(person.inherits_from.length > 0 ? [pair("inherits_from", tomlArray(person.inherits_from))] : []),
    ],
    person.body,
  );
}

/** Both halves of a soul, keyed by the filename each belongs in. */
export function serializeSoul(soul: Soul): { readonly role: string; readonly person: string } {
  return { role: serializeRole(soul.role), person: serializePerson(soul.person) };
}
