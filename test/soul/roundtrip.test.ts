/**
 * load → serialize → load, and the Markdown that must survive it untouched.
 *
 * This is I-2 reduced to something a machine can check. A soul is a text file
 * a human owns and git tracks; the moment Mind cannot rewrite one without
 * changing it, the human's copy and Mind's idea of it have quietly forked,
 * and git stops being the source of truth.
 *
 * The strongest assertion here is the boring one: `serialize(load(text))`
 * equals `text`, byte for byte, for a file written by hand. Everything else —
 * fixed key order, Thai left unescaped — is a reason that assertion holds.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { subjectId } from "../../src/types.ts";
import { loadSoul, parsePerson, parseRole, parseSoul } from "../../src/soul/load.ts";
import { PERSON_FILE, ROLE_FILE } from "../../src/soul/schema.ts";
import { serializePerson, serializeRole, serializeSoul, tomlString } from "../../src/soul/serialize.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const EXAMPLE = subjectId("example");

/**
 * A soul written in Thai, because the escaping question only has teeth in a
 * script that a naive serializer would turn into `\uXXXX`. Nothing here names
 * anyone: the engine and its tests carry no owner's data (D-021).
 */
const THAI_ROLE = [
  "+++",
  'schema = "mind/soul-role@1"',
  'subject = "example"',
  'name = "ผู้ดูแลตัวอย่าง"',
  'role = "ดูแลไดเรกทอรีตัวอย่างให้เรียบร้อย"',
  "prohibitions = [",
  '  "ไม่ลบข้อมูลโดยไม่ได้รับการยืนยัน",',
  '  "ไม่คอมมิตข้อมูลลับ",',
  "]",
  "",
  "[scope]",
  'does = "อ่านและตอบคำถามเกี่ยวกับไดเรกทอรีตัวอย่าง"',
  'does_not = "ไม่แตะอะไรนอกไดเรกทอรีของตัวเอง"',
  "+++",
  "",
  "# ผู้ดูแลตัวอย่าง — ความรู้ของหน้าที่",
  "",
  "ขั้นตอนและเส้นทางที่เป็นของ *งาน* ไม่ใช่ของคนที่ทำงานนั้นอยู่ตอนนี้",
  "",
].join("\n");

const THAI_PERSON = [
  "+++",
  'schema = "mind/soul-person@1"',
  'subject = "example"',
  "tone = [",
  '  "ตรงไปตรงมา",',
  '  "ไม่รีบร้อน",',
  "]",
  'addresses_user_as = "เพื่อน"',
  'refers_to_self_as = ["ผู้ดูแล"]',
  "principles = [",
  '  "ตรวจสภาพจริงก่อนลงมือ",',
  '  "บอกให้ชัดว่าอะไรถูกข้ามไป",',
  "]",
  "+++",
  "",
  "# ผู้ดูแลตัวอย่าง — นิสัยส่วนตัว",
  "",
  "ลบไฟล์นี้ทิ้งได้ โดยที่ `role.md` ยังอยู่ครบ",
  "",
].join("\n");

describe("tomlString", () => {
  test("escapes what TOML requires and nothing above ASCII", () => {
    expect(tomlString("plain")).toBe('"plain"');
    expect(tomlString('say "no"')).toBe('"say \\"no\\""');
    expect(tomlString("a\\b")).toBe('"a\\\\b"');
    expect(tomlString("line\nbreak")).toBe('"line\\nbreak"');
    expect(tomlString("\u0007")).toBe('"\\u0007"');

    // The one that matters for a soul a human has to be able to read: Thai is
    // written through as Thai. A file nobody can read is a file nobody checks.
    expect(tomlString("ตรงไปตรงมา")).toBe('"ตรงไปตรงมา"');
    expect(tomlString("ตรงไปตรงมา")).not.toContain("\\u");
  });
});

describe("round trip", () => {
  test("a hand-written fixture comes back byte-identical", async () => {
    const roleText = await Bun.file(join(FIXTURES, "soul-valid", ROLE_FILE)).text();
    const personText = await Bun.file(join(FIXTURES, "soul-valid", PERSON_FILE)).text();

    const loaded = parseSoul(roleText, personText, EXAMPLE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const written = serializeSoul(loaded.soul);
    expect(written.role).toBe(roleText);
    expect(written.person).toBe(personText);
  });

  test("Thai survives load → serialize → load unchanged", () => {
    const first = parseSoul(THAI_ROLE, THAI_PERSON, EXAMPLE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const written = serializeSoul(first.soul);
    expect(written.role).not.toContain("\\u0e");
    expect(written.person).not.toContain("\\u0e");
    expect(written.person).toContain('addresses_user_as = "เพื่อน"');

    const second = parseSoul(written.role, written.person, EXAMPLE);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.soul).toEqual(first.soul);
    expect(serializeSoul(second.soul)).toEqual(written);
  });

  test("the body is preserved byte-for-byte, fences and CRLF included", () => {
    // Two things a body is allowed to contain that a careless serializer would
    // eat: a `+++` line (only the first pair is frontmatter) and CRLF endings.
    const body = "# heading\r\n\r\n+++ not a fence +++\r\n\ttabbed\ttext\r\n";
    const text = THAI_ROLE.slice(0, THAI_ROLE.indexOf("\n+++\n") + 5) + body;

    const parsed = parseRole(ROLE_FILE, text, EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.body).toBe(body);

    const written = serializeRole(parsed.value);
    expect(written.endsWith(body)).toBe(true);
    expect(written).toBe(text);
  });

  test("key order is fixed, so a later diff shows the edit and not the rewrite", () => {
    const parsed = parsePerson(PERSON_FILE, THAI_PERSON, EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const keys = serializePerson(parsed.value)
      .split("\n")
      .map((line) => /^([a-z_]+) =/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);

    expect(keys).toEqual([
      "schema",
      "subject",
      "tone",
      "addresses_user_as",
      "refers_to_self_as",
      "principles",
    ]);
  });

  test("[extra] is written sorted, after [scope], and survives the trip", async () => {
    const loaded = await loadSoul(join(FIXTURES, "soul-valid"), EXAMPLE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const role = {
      ...loaded.soul.role,
      extra: { zebra: "last", alpha: "first", upstream: loaded.soul.role.extra["upstream"]! },
    };

    const written = serializeRole(role);
    expect(written.indexOf("[extra]")).toBeGreaterThan(written.indexOf("[scope]"));
    expect(written.indexOf('alpha = "first"')).toBeLessThan(written.indexOf('zebra = "last"'));

    const reparsed = parseRole(ROLE_FILE, written, EXAMPLE);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value).toEqual(role);
  });

  test("an empty body round trips as an empty body", () => {
    const parsed = parseRole(ROLE_FILE, `${THAI_ROLE.split("\n+++\n")[0]}\n+++\n`, EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.body).toBe("");
    expect(serializeRole(parsed.value).endsWith("+++\n")).toBe(true);
  });
});
