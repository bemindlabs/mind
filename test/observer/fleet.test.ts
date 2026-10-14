/**
 * D-036 — whose data a capture lands in, now that claude 2.1.280 no longer
 * says who authored a turn.
 *
 * The failure worth testing for is the one that looks like a working system:
 * a fleet launcher that declared itself, badly, and ended up in the owner's
 * subject anyway. So most of what follows is about the marker winning, and
 * about a broken marker never falling back.
 */

import { describe, expect, test } from "bun:test";
import {
  captureTarget,
  FLEET_ENV,
  FLEET_LEAK_LIMITS,
  fleetLeaks,
  formatFleetLeaks,
} from "../../src/observer/fleet.ts";
import { NO_EVIDENCE, type CaptureRecord } from "../../src/observer/record.ts";
import { flagPersonal, subjectId } from "../../src/types.ts";

function record(project: string, key: string): CaptureRecord {
  return {
    v: 1,
    key,
    at: "2026-09-23T00:00:00.000Z",
    vendor: "claude",
    session: "s-1",
    project,
    kind: "command",
    tool: "Bash",
    target: "ls",
    outcome: "ok",
    source: "hook",
    origin: "unknown",
    evidence: NO_EVIDENCE,
  } as CaptureRecord;
}

describe("captureTarget", () => {
  test("no marker: the hook's own subject", () => {
    expect(captureTarget("om-bmt", {})).toEqual({ ok: true, subject: subjectId("om-bmt"), fleet: false });
  });

  test("a marker outranks the hook's subject", () => {
    expect(captureTarget("om-bmt", { [FLEET_ENV]: "fleet-kala" })).toEqual({
      ok: true,
      subject: subjectId("fleet-kala"),
      fleet: true,
    });
  });

  test("a marker that is not a subject id records nothing — never the hook's subject", () => {
    for (const marker of ["", "..", "a/b", "Upper Case"]) {
      const target = captureTarget("om-bmt", { [FLEET_ENV]: marker });
      expect(target.ok, marker).toBe(false);
      if (!target.ok) expect(target.reason, marker).toContain(FLEET_ENV);
    }
  });

  test("a marker still applies when the hook's own subject is broken", () => {
    expect(captureTarget(undefined, { [FLEET_ENV]: "fleet-kala" }).ok).toBe(true);
  });

  test("no marker and no usable --subject is refused, as before D-036", () => {
    for (const subject of [undefined, "", "../x"]) {
      expect(captureTarget(subject, {}).ok, String(subject)).toBe(false);
    }
  });
});

describe("fleetLeaks", () => {
  const records = flagPersonal([
    record("/fleet/kala", "a"),
    record("/fleet/kala", "b"),
    record("/home/owner/secret-project", "c"),
  ]);

  test("counts under the directories named, and only those", () => {
    const counts = fleetLeaks(records, ["/fleet/kala", "/fleet/pan"]);
    expect(counts).toEqual({ "/fleet/kala": 2, "/fleet/pan": 0 });
  });

  test("no directory the owner worked in comes out, because none was named", () => {
    const counts = fleetLeaks(records, ["/fleet/kala"]);
    expect(JSON.stringify(counts)).not.toContain("secret-project");
  });

  test("an exact directory only — a subdirectory is not counted under its parent", () => {
    expect(fleetLeaks(records, ["/fleet"])).toEqual({ "/fleet": 0 });
  });

  test("the same directory named twice is one line", () => {
    expect(Object.keys(fleetLeaks(records, ["/fleet/kala", "/fleet/kala"]))).toEqual([
      "/fleet/kala",
    ]);
  });
});

describe("formatFleetLeaks", () => {
  test("directories with records first, and marked", () => {
    const lines = formatFleetLeaks({ "/a": 0, "/b": 3 });
    expect(lines[0]).toContain("/b  ← unmarked");
    expect(lines[1]).toMatch(/0 {2}\/a$/);
  });

  test("nothing named is said out loud rather than printed as an empty table", () => {
    expect(formatFleetLeaks({})[0]).toContain("nothing was looked for");
  });

  test("the limits say what a count cannot tell apart", () => {
    expect(FLEET_LEAK_LIMITS.join(" ")).toContain("by hand");
  });
});
