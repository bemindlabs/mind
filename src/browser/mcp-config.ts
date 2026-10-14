/**
 * D-155 — the one MCP server every CLI is handed: the task's Playwright MCP,
 * reached on a loopback port, through a configuration Mind writes itself.
 *
 * The owner's own MCP servers stay off (D-047's intent), so a vendor is wired
 * only where Mind can say *only this server*. What each vendor offers was
 * measured on this machine on 2026-10-05 — `--help` first, then the vendor's
 * own listing command where it has one (no model was called for those):
 *
 * | vendor | version | how a server is given | can the owner's be kept out? | here |
 * |---|---|---|---|---|
 * | claude, claude-local | 2.1.289 | `--mcp-config <configs...>` (JSON files or strings) | yes: `--strict-mcp-config` — *"Only use MCP servers from --mcp-config, ignoring all other MCP configurations"*, already on every turn (D-047) | wired |
 * | grok-local | 1.0.46 | no flag; `[mcp_servers.<name>] url = …` in `$GROK_HOME/config.toml`, a home Mind owns for this backend | yes (the home is Mind's; D-119 already switches off what grok borrows from Claude/Cursor) | **refused**: see below |
 * | grok | 1.0.46 | the same file, in the owner's `~/.grok` (it holds the login) | no — the only home with a login is the owner's | refused |
 * | kimi | 2.1.1 | no flag; `mcp.json` in `$KIMI_CODE_HOME` (the login's home), merged with a project `.mcp.json` and `<cwd>/.kimi-code/mcp.json` | no strict switch: project files in the working directory are always merged | refused |
 * | codex | 0.155.1 | `-c mcp_servers.<name>.url="…"` per run | no: `-c` *adds* to the owner's `[mcp_servers]` (measured: an owner's server stayed `enabled` beside ours, also with `-c mcp_servers={…}`); and codex cannot act on this machine at all (bwrap, D-121) | refused |
 * | gemini, copilot, ollama | — | not measured / no tools | — | refused |
 *
 * grok-local, measured with a real turn on `local-coder` (2026-10-05): grok
 * puts MCP tools behind its meta-tools `search_tool` and `use_tool` — the model
 * saw "25 tools" on the server and no tool names. D-119 removes those two at
 * every level, because a level-1 turn used `use_tool` to reach a shell, so
 * with D-119 in force grok has no way to call the browser (it fell back to
 * other tools and never touched the container). Giving them back is a product
 * decision about D-119, not a wiring detail, so grok-local stays refused here.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import type { FencePolicy } from "../exec/fence.ts";
import type { Restraint } from "../exec/restraint.ts";
import { BROWSER_PORT_FIRST, BROWSER_PORT_LAST } from "./ports.ts";

/** The server's name in every vendor's configuration. Claude names its tools `mcp__<this>__<tool>`. */
export const BROWSER_MCP_NAME = "mind-browser";

/** Where the task's Playwright MCP answers (streamable HTTP), on the host. */
export function browserMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * What a turn is handed to drive one task's browser. Not reachable from
 * `mind turn` yet: the `operate` dial (D-153) decides when a turn gets it.
 */
export interface BrowserHands {
  /** The task container's loopback port ({@link BROWSER_PORT_FIRST}–{@link BROWSER_PORT_LAST}). */
  readonly port: number;
  /** The task's bearer token (the record's); it goes only into the 600 config file. */
  readonly token: string;
  /** The container's operate level (the record's): the most its guard serves. */
  readonly operate: 1 | 2;
  /** A directory Mind owns where the vendor's config file is written. */
  readonly dir: string;
  /**
   * claude's per-call limit for this server (its config's `timeout`, ms), when a call may legitimately wait:
   * a sensitive action paused on the owner's answer (D-156) is a tool call that has not returned yet.
   */
  readonly toolTimeoutMs?: number;
}

/**
 * `operate` 1 — look and propose (D-153): open pages within the allowlist and
 * read them. No click, no typing, no submit, no dialog.
 */
export const LOOK_TOOLS: readonly string[] = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
];

/**
 * `operate` 2 and up — act: the look tools and the ones that change a page.
 * Approving a tool is not approving every use of it: D-153's always-pause
 * list (`src/decide/sensitive.ts`) is checked inside the container before each
 * click, keystroke, select or upload, and holds paying, sending, deleting,
 * credentials and accepting terms at every level (`docker/browser/record.cjs`).
 */
export const ACT_TOOLS: readonly string[] = [
  ...LOOK_TOOLS,
  "browser_click",
  "browser_hover",
  "browser_drag",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_handle_dialog",
  "browser_tabs",
  "browser_resize",
  "browser_close",
];

/**
 * Never pre-approved at any level, and not served at all by the container's
 * guard (`docker/browser/guard.mjs`): code in the server or the page, and files
 * read from inside the container.
 */
export const NEVER_TOOLS: readonly string[] = [
  "browser_run_code_unsafe",
  "browser_evaluate",
  "browser_file_upload",
  "browser_drop",
];

/**
 * The tools a turn at this restraint is handed without being asked: by its `operate` level (D-153), never
 * more than the container's guard serves (`container`, the record's level).
 */
export function toolsFor(restraint: Restraint, container: 1 | 2 = 2): readonly string[] {
  const level = Math.min(restraint.operate, container);
  return restraint.act <= 0 || level <= 0 ? [] : level === 1 ? LOOK_TOOLS : ACT_TOOLS;
}

/** A vendor's wiring: the files to write and the argv to add, or why it has none. */
export type BrowserWiring =
  | {
      readonly status: "wired";
      readonly vendor: string;
      readonly files: readonly { readonly path: string; readonly content: string }[];
      /** Appended to the vendor's argv; see {@link withBrowserArgs} for how `--allowedTools` is merged. */
      readonly args: readonly string[];
      readonly allowedTools: readonly string[];
      readonly evidence: string;
    }
  | { readonly status: "refused"; readonly vendor: string; readonly reason: string };

const CLAUDE_EVIDENCE =
  "claude 2.1.289 --help: `--mcp-config <configs...>` loads MCP servers from JSON files or strings; " +
  "`--strict-mcp-config` (on every Mind turn, D-047) ignores every other MCP configuration";

/** The vendors that cannot be wired, and the measured reason. */
export const BROWSER_REFUSALS: Readonly<Record<string, string>> = {
  "grok-local":
    "grok 1.0.46 offers MCP tools only through its meta-tools search_tool and use_tool, which D-119 removes " +
    "at every level (a level-1 turn used use_tool to reach a shell). Measured 2026-10-05: with D-119 in force " +
    "the model could not call the browser. Re-allowing them is a decision about D-119, not wiring.",
  grok:
    "grok 1.0.46 reads MCP servers only from $GROK_HOME/config.toml, and a cloud turn runs in the owner's " +
    "~/.grok (its login): Mind has no file of its own to put the server in without writing the owner's config.",
  kimi:
    "kimi 2.1.1 has no per-run MCP flag: servers come from $KIMI_CODE_HOME/mcp.json (the login's home) and are " +
    "merged with the working directory's .mcp.json and .kimi-code/mcp.json, with no switch to keep the " +
    "owner's or a repository's servers out (D-047).",
  codex:
    "codex 0.155.1 takes `-c mcp_servers.<name>.url=…` per run, but it adds to the owner's [mcp_servers] rather " +
    "than replacing them (measured with `codex mcp list`: an owner's server stayed enabled beside Mind's), " +
    "and codex cannot act on this machine (bwrap, D-121).",
};

/**
 * The wiring for one vendor id at one restraint, pure: nothing is written.
 *
 * The tools are approved one by one (`mcp__mind-browser__browser_navigate`),
 * never the whole server: a tool the turn's level does not name is one claude
 * `-p` refuses to call. The config carries the task's token in the server's
 * `headers`, so it is written mode 600 ({@link writeBrowserWiring}).
 */
export function browserWiring(vendor: string, hands: BrowserHands, restraint: Restraint): BrowserWiring {
  const portProblem = browserPortProblem(hands.port);
  if (portProblem !== undefined) return { status: "refused", vendor, reason: portProblem };
  if (!/^[0-9a-f]{64}$/.test(hands.token)) return { status: "refused", vendor, reason: "the task's token is not one Mind minted" };
  if (restraint.act <= 0) return { status: "refused", vendor, reason: "the autonomy dial is at 0 for this turn" };
  if (restraint.operate <= 0) {
    return {
      status: "refused",
      vendor,
      reason: "operate is 0 for this turn (min(operate, reach), D-153): no browser — `mind autonomy set operate 1` lets it look",
    };
  }
  if (vendor === "claude" || vendor === "claude-local") {
    const path = join(hands.dir, `${vendor}-mcp.json`);
    const content = `${JSON.stringify(
      {
        mcpServers: {
          [BROWSER_MCP_NAME]: {
            type: "http",
            url: browserMcpUrl(hands.port),
            headers: { Authorization: `Bearer ${hands.token}` },
            // claude 2.1.289: "Per-server tool-call timeout in milliseconds. Overrides the MCP_TOOL_TIMEOUT
            // environment variable for this server" (its config schema, read from the binary 2026-10-05).
            ...(hands.toolTimeoutMs === undefined ? {} : { timeout: hands.toolTimeoutMs }),
          },
        },
      },
      null,
      2,
    )}\n`;
    const allowedTools = toolsFor(restraint, hands.operate).map((tool) => `mcp__${BROWSER_MCP_NAME}__${tool}`);
    return {
      status: "wired",
      vendor,
      files: [{ path, content }],
      args: ["--mcp-config", path],
      allowedTools,
      evidence: CLAUDE_EVIDENCE,
    };
  }
  return {
    status: "refused",
    vendor,
    reason:
      BROWSER_REFUSALS[vendor] ??
      `${vendor} has no measured way to be handed only Mind's MCP server, so it gets no browser`,
  };
}

/** Write a wired vendor's files, private to the owner. Returns the paths written. */
export async function writeBrowserWiring(wiring: BrowserWiring): Promise<readonly string[]> {
  if (wiring.status !== "wired") return [];
  const written: string[] = [];
  for (const file of wiring.files) {
    const directory = join(file.path, "..");
    await mkdir(directory, { recursive: true, mode: STATE_DIR_MODE });
    await chmod(directory, STATE_DIR_MODE);
    await writeFile(file.path, file.content, { mode: STATE_FILE_MODE });
    await chmod(file.path, STATE_FILE_MODE);
    written.push(file.path);
  }
  return written;
}

/**
 * The vendor's argv with the browser's flags added.
 *
 * `--allowedTools` is variadic in claude and the grant (D-047) may already
 * carry one (`Bash` on claude-local at level 2). Rather than trust how a second
 * occurrence combines with the first, the browser's tools are appended to the
 * existing value; with none, a new `--allowedTools` is added. `--mcp-config`
 * goes last of all and takes one path, so nothing after it can be read as a
 * second config.
 */
export function withBrowserArgs(argv: readonly string[], wiring: BrowserWiring): string[] {
  if (wiring.status !== "wired") return [...argv];
  const out = [...argv];
  if (wiring.allowedTools.length > 0) {
    const at = out.indexOf("--allowedTools");
    if (at >= 0 && at + 1 < out.length) {
      const existing = out[at + 1]!.split(",").filter((tool) => tool !== "");
      out[at + 1] = [...existing, ...wiring.allowedTools.filter((tool) => !existing.includes(tool))].join(",");
    } else {
      out.push("--allowedTools", wiring.allowedTools.join(","));
    }
  }
  if (!out.includes("--strict-mcp-config")) out.push("--strict-mcp-config");
  out.push(...wiring.args);
  return out;
}

/** Why a port cannot be a browser task's, or `undefined`. */
export function browserPortProblem(port: number): string | undefined {
  if (!Number.isInteger(port) || port < BROWSER_PORT_FIRST || port > BROWSER_PORT_LAST) {
    return `port ${port} is not a browser task's (${BROWSER_PORT_FIRST}–${BROWSER_PORT_LAST})`;
  }
  return undefined;
}

/**
 * D-155 — the local chain's fence, with exactly one more loopback port: the
 * task container's. Nothing else about the policy changes. Throws on a port
 * outside the browser band, so a mistake cannot open LiteLLM's neighbour.
 */
export function browserFence(policy: FencePolicy, port: number): FencePolicy {
  const problem = browserPortProblem(port);
  if (problem !== undefined) throw new Error(`refused to widen the fence: ${problem}`);
  return {
    writable: [...policy.writable],
    tcpPorts: policy.tcpPorts.includes(port) ? [...policy.tcpPorts] : [...policy.tcpPorts, port],
  };
}
