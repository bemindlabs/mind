/**
 * `stateRoot` — small, and worth a test for one reason.
 *
 * Two features now depend on landing in the same tree: the originals
 * `soul apply` keeps, and the turn ledger. `mind erase` (S7.2) will promise
 * that removing one directory removes both, and that promise is this function.
 * A second, subtly different copy of the XDG rule is exactly how a tree nobody
 * ever looks in again gets created.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { dataRoot, stateRoot, STATE_DIR_MODE, STATE_FILE_MODE, xdgBase } from "../src/state.ts";

describe("stateRoot", () => {
  test("uses XDG_STATE_HOME when it is set", () => {
    expect(stateRoot("/home/example", { XDG_STATE_HOME: "/var/state" })).toBe(
      join("/var/state", "mind"),
    );
  });

  test("falls back to ~/.local/state when it is unset", () => {
    expect(stateRoot("/home/example", {})).toBe(join("/home/example", ".local", "state", "mind"));
  });

  test("an empty value counts as unset, not as the current directory", () => {
    // `export XDG_STATE_HOME=` is a thing shell scripts do. Treating that as a
    // relative path would put the ledger wherever the command was run from.
    expect(stateRoot("/home/example", { XDG_STATE_HOME: "" })).toBe(
      join("/home/example", ".local", "state", "mind"),
    );
  });

  test("the modes are the private ones, not the umask's opinion", () => {
    expect(STATE_DIR_MODE).toBe(0o700);
    expect(STATE_FILE_MODE).toBe(0o600);
  });
});

describe("dataRoot", () => {
  test("uses XDG_DATA_HOME when it is set, ~/.local/share when it is not", () => {
    expect(dataRoot("/home/example", { XDG_DATA_HOME: "/var/data" })).toBe(
      join("/var/data", "mind"),
    );
    expect(dataRoot("/home/example", {})).toBe(
      join("/home/example", ".local", "share", "mind"),
    );
    expect(dataRoot("/home/example", { XDG_DATA_HOME: "" })).toBe(dataRoot("/home/example", {}));
  });

  test("it is a different tree from the state root — data is the owner's, state is Mind's", () => {
    // S0.4 AC4 puts personal data under this root. If the two ever collided,
    // `mind erase` would be deleting one while naming the other.
    const env = { XDG_STATE_HOME: "/var/state", XDG_DATA_HOME: "/var/data" };
    expect(dataRoot("/home/example", env)).not.toBe(stateRoot("/home/example", env));
    expect(dataRoot("/home/example", {})).not.toBe(stateRoot("/home/example", {}));
  });
});

describe("a relative XDG base is ignored, as the spec says (S15.8 review, L9)", () => {
  test("state and data fall back to the default rather than landing under the current directory", () => {
    for (const value of ["data", "./data", "../elsewhere", "~/data"]) {
      expect(stateRoot("/home/example", { XDG_STATE_HOME: value }), value).toBe(join("/home/example", ".local", "state", "mind"));
      expect(dataRoot("/home/example", { XDG_DATA_HOME: value }), value).toBe(join("/home/example", ".local", "share", "mind"));
    }
  });

  test("an absolute value is still used, and the rule is one function", () => {
    expect(xdgBase("/abs", "/fallback")).toBe("/abs");
    expect(xdgBase(undefined, "/fallback")).toBe("/fallback");
    expect(xdgBase("", "/fallback")).toBe("/fallback");
    expect(xdgBase("rel", "/fallback")).toBe("/fallback");
  });
});

