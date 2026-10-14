/** D-155 — the one MCP server each vendor is handed, and the one port the fence gains. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACT_TOOLS,
  BROWSER_MCP_NAME,
  BROWSER_REFUSALS,
  LOOK_TOOLS,
  NEVER_TOOLS,
  toolsFor,
  browserFence,
  browserMcpUrl,
  browserPortProblem,
  browserWiring,
  withBrowserArgs,
  writeBrowserWiring,
} from "../../src/browser/mcp-config.ts";
import { BROWSER_PORT_FIRST, BROWSER_PORT_LAST } from "../../src/browser/ports.ts";
import { VENDORS } from "../../src/exec/registry.ts";
import { LOCAL_BACKENDS } from "../../src/exec/local-cli.ts";
import { atLevel, operating, RESTRAINED } from "../support/restraint.ts";

const LOOK = operating(1);
const ACT = operating(2);
import { resolve } from "node:path";

/** The container's guard, loaded at run time (plain JS that runs in the image, no types). */
const GUARD_PATH = resolve(import.meta.dir, "..", "..", "docker", "browser", "guard.mjs");
const { SERVED, LOOK: GUARD_LOOK } = (await import(GUARD_PATH)) as { SERVED: Set<string>; LOOK: Set<string> };

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const TOKEN = "cd".repeat(32);
const HANDS = { port: 30_733, dir: "/state/browser/s/wiring/t-1", token: TOKEN, operate: 2 as const };

describe("browserWiring", () => {
  test("claude and claude-local: one JSON file naming only Mind's server, with the token, loaded with --mcp-config", () => {
    for (const vendor of ["claude", "claude-local"]) {
      const wiring = browserWiring(vendor, HANDS, LOOK);
      expect(wiring.status).toBe("wired");
      if (wiring.status !== "wired") continue;
      const path = join(HANDS.dir, `${vendor}-mcp.json`);
      expect(wiring.files).toHaveLength(1);
      expect(wiring.files[0]!.path).toBe(path);
      expect(JSON.parse(wiring.files[0]!.content)).toEqual({
        mcpServers: {
          [BROWSER_MCP_NAME]: { type: "http", url: "http://127.0.0.1:30733/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
        },
      });
      expect(wiring.args).toEqual(["--mcp-config", path]);
      expect(wiring.allowedTools).toEqual(LOOK_TOOLS.map((tool) => `mcp__mind-browser__${tool}`));
      expect(wiring.evidence).toContain("--strict-mcp-config");
    }
  });

  test("operate 1 looks, 2 and up act; run-code, evaluate and file tools are never approved; 0 is refused", () => {
    expect(toolsFor(LOOK)).toEqual(LOOK_TOOLS);
    expect(toolsFor(ACT)).toEqual(ACT_TOOLS);
    expect(toolsFor(operating(3))).toEqual(ACT_TOOLS);
    expect(toolsFor(operating(0))).toEqual([]);
    // The tools follow operate, not the acting level: a turn at 2 everywhere but operate gets none.
    expect(toolsFor(atLevel(2))).toEqual([]);
    // And operate is min(operate, reach): RESTRAINED keeps operate at 0.
    expect(toolsFor(RESTRAINED)).toEqual([]);
    for (const tool of ["browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_handle_dialog"]) {
      expect(LOOK_TOOLS).not.toContain(tool);
      expect(ACT_TOOLS).toContain(tool);
    }
    for (const tool of NEVER_TOOLS) {
      expect(ACT_TOOLS).not.toContain(tool);
      // ...and the container's guard does not serve them either.
      expect(SERVED.has(tool)).toBe(false);
    }
    // Everything a level approves is something the guard serves at that level — the same two lists.
    for (const tool of ACT_TOOLS) expect(SERVED.has(tool)).toBe(true);
    expect([...GUARD_LOOK].sort()).toEqual([...LOOK_TOOLS].sort());
    // A turn never gets more than the container's guard serves.
    expect(toolsFor(ACT, 1)).toEqual(LOOK_TOOLS);
    const capped = browserWiring("claude", { ...HANDS, operate: 1 }, ACT);
    expect(capped.status === "wired" && capped.allowedTools).not.toContain("mcp__mind-browser__browser_click");
    const zero = browserWiring("claude", HANDS, atLevel(0));
    expect(zero.status === "refused" && zero.reason).toContain("dial is at 0");
    const noOperate = browserWiring("claude", HANDS, atLevel(2));
    expect(noOperate.status === "refused" && noOperate.reason).toContain("operate is 0");
    const acting = browserWiring("claude", HANDS, ACT);
    expect(acting.status === "wired" && acting.allowedTools).toContain("mcp__mind-browser__browser_click");
  });

  test("a token Mind did not mint is refused", () => {
    expect(browserWiring("claude", { ...HANDS, token: "short" }, LOOK).status).toBe("refused");
  });

  test("every other vendor and both unknown ones are refused with a reason; none is wired by accident", () => {
    const ids = [...VENDORS.map((spec) => spec.id), ...LOCAL_BACKENDS, "ollama", "made-up"];
    const wired = ids.filter((id) => browserWiring(id, HANDS, LOOK).status === "wired");
    expect(wired.sort()).toEqual(["claude", "claude-local"]);
    for (const id of ["grok", "grok-local", "kimi", "codex"]) {
      const wiring = browserWiring(id, HANDS, LOOK);
      expect(wiring.status === "refused" && wiring.reason).toBe(BROWSER_REFUSALS[id]!);
    }
    const unknown = browserWiring("made-up", HANDS, LOOK);
    expect(unknown.status === "refused" && unknown.reason).toContain("no measured way");
  });

  test("a port outside the browser band is never wired", () => {
    expect(browserWiring("claude", { ...HANDS, port: 10_400 }, LOOK).status).toBe("refused");
    expect(browserPortProblem(BROWSER_PORT_FIRST)).toBeUndefined();
    expect(browserPortProblem(BROWSER_PORT_LAST)).toBeUndefined();
    expect(browserPortProblem(BROWSER_PORT_LAST + 1)).toContain("not a browser task's");
    expect(browserPortProblem(30_730.5)).toContain("not a browser task's");
    expect(browserMcpUrl(30_740)).toBe("http://127.0.0.1:30740/mcp");
  });
});

describe("writeBrowserWiring", () => {
  test("writes the file private to the owner, and nothing for a refusal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-wiring-"));
    dirs.push(dir);
    const wiring = browserWiring("claude-local", { port: 30_730, dir: join(dir, "t-1"), token: TOKEN, operate: 2 as const }, LOOK);
    const written = await writeBrowserWiring(wiring);
    expect(written).toEqual([join(dir, "t-1", "claude-local-mcp.json")]);
    expect((await stat(written[0]!)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "t-1"))).mode & 0o777).toBe(0o700);
    expect(await readFile(written[0]!, "utf8")).toContain("127.0.0.1:30730");
    expect(await writeBrowserWiring(browserWiring("kimi", HANDS, LOOK))).toEqual([]);
  });
});

describe("withBrowserArgs", () => {
  const wiring = browserWiring("claude-local", HANDS, LOOK);
  const looks = LOOK_TOOLS.map((tool) => `mcp__mind-browser__${tool}`).join(",");
  const config = join(HANDS.dir, "claude-local-mcp.json");

  test("joins the tools onto an existing --allowedTools rather than adding a second", () => {
    const argv = ["claude", "-p", "x", "--allowedTools", "Bash", "--strict-mcp-config"];
    expect(withBrowserArgs(argv, wiring)).toEqual([
      "claude", "-p", "x", "--allowedTools", `Bash,${looks}`, "--strict-mcp-config", "--mcp-config", config,
    ]);
    // Already there: not twice.
    const twice = ["claude", "--allowedTools", looks, "--strict-mcp-config"];
    expect(withBrowserArgs(twice, wiring)[2]).toBe(looks);
  });

  test("adds --allowedTools and the strict switch when the argv has neither; --mcp-config goes last", () => {
    expect(withBrowserArgs(["claude", "-p", "x", "--tools", ""], wiring)).toEqual([
      "claude", "-p", "x", "--tools", "", "--allowedTools", looks, "--strict-mcp-config", "--mcp-config", config,
    ]);
  });

  test("a refusal leaves the argv as it was", () => {
    const argv = ["kimi", "-p", "x"];
    expect(withBrowserArgs(argv, browserWiring("kimi", HANDS, LOOK))).toEqual(argv);
  });
});

describe("browserFence", () => {
  test("adds exactly one port, keeps the writable paths, and is idempotent", () => {
    const policy = { writable: ["/home/vendor", "/home/vendor/scratch"], tcpPorts: [10_400] };
    const fenced = browserFence(policy, 30_741);
    expect(fenced).toEqual({ writable: ["/home/vendor", "/home/vendor/scratch"], tcpPorts: [10_400, 30_741] });
    expect(browserFence(fenced, 30_741).tcpPorts).toEqual([10_400, 30_741]);
    expect(policy.tcpPorts).toEqual([10_400]);
  });

  test("refuses to open anything outside the browser band", () => {
    expect(() => browserFence({ writable: [], tcpPorts: [10_400] }, 10_401)).toThrow("refused to widen the fence");
    expect(() => browserFence({ writable: [], tcpPorts: [10_400] }, 22)).toThrow();
  });
});
