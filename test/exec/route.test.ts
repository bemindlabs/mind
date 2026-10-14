import { describe, expect, test } from "bun:test";
import {
  chooseRoute,
  parseRoutePreference,
  ROUTE_PREFERENCES,
  type RouteInput,
} from "../../src/exec/route.ts";

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return { held: 0, acting: false, preference: "auto", localAvailable: false, ...overrides };
}

describe("chooseRoute", () => {
  test('preference "cloud" goes to cloud', () => {
    const route = chooseRoute(input({ preference: "cloud", held: 3, acting: true, localAvailable: true }));
    expect(route.prefer).toBe("cloud");
    expect(route.reason).toContain("cloud");
  });

  test('preference "local" with a local backend goes to local', () => {
    const route = chooseRoute(input({ preference: "local", localAvailable: true }));
    expect(route.prefer).toBe("local");
  });

  test('preference "local" without a local backend falls back to cloud', () => {
    const route = chooseRoute(input({ preference: "local", localAvailable: false }));
    expect(route.prefer).toBe("cloud");
  });

  test("auto: held pieces and an acting turn go to local when available", () => {
    const route = chooseRoute(input({ held: 2, acting: true, localAvailable: true }));
    expect(route.prefer).toBe("local");
    expect(route.reason).toContain("2 recalled pieces are held");
    expect(route.reason).toContain("acts");
    expect(chooseRoute(input({ held: 1, acting: true, localAvailable: true })).reason).toContain("1 recalled piece is held");
  });

  test("auto: held pieces and an acting turn fall back to cloud when no local backend", () => {
    const route = chooseRoute(input({ held: 2, acting: true, localAvailable: false }));
    expect(route.prefer).toBe("cloud");
    expect(route.reason).toContain("held");
  });

  test("auto: nothing held does not need this machine", () => {
    const route = chooseRoute(input({ held: 0, acting: true, localAvailable: true }));
    expect(route.prefer).toBe("cloud");
  });

  test("auto: a non-acting turn does not need this machine", () => {
    const route = chooseRoute(input({ held: 4, acting: false, localAvailable: true }));
    expect(route.prefer).toBe("cloud");
  });
});

describe("route reasons", () => {
  const cases: RouteInput[] = [
    input({ preference: "cloud" }),
    input({ preference: "local", localAvailable: true }),
    input({ preference: "local", localAvailable: false }),
    input({ held: 1, acting: true, localAvailable: true }),
    input({ held: 5, acting: true, localAvailable: false }),
    input({ held: 0, acting: true, localAvailable: true }),
    input({ held: 4, acting: false, localAvailable: true }),
  ];

  for (const [i, caseInput] of cases.entries()) {
    test(`reason ${i} is one short plain sentence`, () => {
      const route = chooseRoute(caseInput);
      expect(route.reason.endsWith(".")).toBe(true);
      expect(route.reason.length).toBeLessThanOrEqual(160);
      expect(route.reason.match(/\./g)?.length).toBe(1);
    });
  }
});

describe("parseRoutePreference", () => {
  test("undefined becomes auto", () => {
    expect(parseRoutePreference(undefined)).toBe("auto");
  });

  test("each valid value parses to itself", () => {
    expect(ROUTE_PREFERENCES).toEqual(["auto", "local", "cloud"]);
    for (const p of ROUTE_PREFERENCES) {
      expect(parseRoutePreference(p)).toBe(p);
    }
  });

  test("an unknown string becomes undefined", () => {
    expect(parseRoutePreference("hybrid")).toBeUndefined();
  });
});
