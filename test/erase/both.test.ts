/**
 * S13.5 AC2, step 6 — remote first, and a failure injected into each half. No ssh, no filesystem.
 */

import { describe, expect, test } from "bun:test";
import { eraseBoth, formatBoth } from "../../src/erase/both.ts";
import type { RemoteErasure } from "../../src/erase/remote-verify.ts";

const OK: RemoteErasure["erase"] = { ok: true, trees: [] };
const ERASED: RemoteErasure = { erase: OK, verdict: { verdict: "erased-and-verified" } };
const LEFT: RemoteErasure = {
  erase: OK,
  verdict: { verdict: "remaining", left: [{ label: "x", dir: "/srv/x/y", state: "present", entries: 1, bytes: 1 }] },
};
const UNKNOWN: RemoteErasure = {
  erase: { ok: false, reason: "unreachable", detail: "down", trees: [] },
  verdict: { verdict: "not-verified", reason: "unreachable: down" },
};

describe("the order", () => {
  test("the remote half runs first, and the local half only after it is verified", async () => {
    const order: string[] = [];
    const result = await eraseBoth(
      async () => {
        order.push("remote");
        return ERASED;
      },
      async () => {
        order.push("local");
        return 0;
      },
    );
    expect(order).toEqual(["remote", "local"]);
    expect(result).toMatchObject({ exit: 0, local: { state: "ran", exit: 0 } });
  });
});

describe("a failure in the remote half", () => {
  for (const [name, remote, exit] of [["something is still there", LEFT, 1], ["the machine could not be asked", UNKNOWN, 4]] as const) {
    test(`${name}: this machine is not touched, and the exit says so`, async () => {
      let localRan = false;
      const result = await eraseBoth(
        async () => remote,
        async () => {
          localRan = true;
          return 0;
        },
      );
      expect(localRan).toBe(false);
      expect(result.local.state).toBe("skipped");
      expect(result.exit).toBe(exit);
      const text = formatBoth(result).join("\n");
      expect(text).toContain("not run");
      expect(text).toContain("still has everything");
      expect(text).not.toContain("(first): erased-and-verified");
    });
  }
});

describe("a throw in the remote half", () => {
  test("is not-verified, exit 4, this machine untouched, and the text says the remote may be partly deleted", async () => {
    let localRan = false;
    const result = await eraseBoth(
      async () => {
        throw new Error("disk full");
      },
      async () => {
        localRan = true;
        return 0;
      },
    );
    expect(localRan).toBe(false);
    expect(result.remote.verdict.verdict).toBe("not-verified");
    expect(result.exit).toBe(4);
    expect(JSON.stringify(result.remote.verdict)).toContain("partly or wholly deleted");
  });
});

describe("a failure in the local half", () => {
  test("it throws: the run says the remote is clean and this machine is not, and exits non-zero", async () => {
    const result = await eraseBoth(async () => ERASED, async () => {
      throw new Error("the ledger lock is held");
    });
    expect(result.local).toMatchObject({ state: "threw", exit: null });
    expect(result.exit).toBe(1);
    const text = formatBoth(result).join("\n");
    expect(text).toContain("local half: FAILED (the ledger lock is held)");
    expect(text).toContain("this machine is not erased");
  });

  test("it answers non-zero (something survived, or nothing was found): that code is the run's", async () => {
    for (const code of [1, 3]) {
      const result = await eraseBoth(async () => ERASED, async () => code);
      expect(result.exit).toBe(code);
      expect(formatBoth(result).join("\n")).toContain(`local half: exit ${code}`);
    }
  });
});
