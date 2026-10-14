/**
 * `mind browser` — one task's browser container (D-151) and the MCP config
 * every CLI is handed for it (D-155). Internal for now: no turn is given a
 * browser until the `operate` dial (D-153) decides when.
 *
 * The work is `src/browser/` (allowlist, runtime, mcp-config), on the coverage
 * floor; what is here is parsing and printing.
 */

import { readMind } from "../../src/env.ts";
import { join } from "node:path";
import { allowEnv, parseAllowlist } from "../../src/browser/allowlist.ts";
import { BROWSER_MCP_NAME, browserMcpUrl, browserWiring, writeBrowserWiring } from "../../src/browser/mcp-config.ts";
import { AUTONOMY_MAX_ENV, effectiveDial } from "../../src/decide/effective.ts";
import { isStopped } from "../../src/decide/stop.ts";
import { restrain } from "../../src/exec/restraint.ts";
import {
  browserDown,
  browserStatus,
  browserUp,
  readBrowserRecords,
  shown,
  taskProblem,
  wiringDir,
  type BrowserRecord,
  type SweepAction,
} from "../../src/browser/runtime.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { dialEnv } from "../dial.ts";
import { dim, parseArgs, usageError } from "../shared.ts";

const USAGE =
  "usage: mind browser up --subject <id> --allow <origin> [--allow <origin>…] [--operate 1|2] [--task <id>] [--ttl <seconds>] [--no-build] [--json]\n" +
  "       mind browser down <task> [--json]\n" +
  "       mind browser status [--json]\n" +
  "       mind browser mcp-config <task> --vendor <id> [--level 1|2] [--json]";

/** Every value of a repeatable option; `parseArgs` keeps only the last. */
function allValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === `--${name}`) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) values.push(value);
      index++;
    } else if (token.startsWith(`--${name}=`)) {
      values.push(token.slice(name.length + 3));
    }
  }
  return values;
}

function sayRecord(record: BrowserRecord): void {
  console.log(`  ${record.task}  ${record.container}  127.0.0.1:${record.port}  since ${record.startedAt}`);
  console.log(dim(`    allowed: ${record.allowed.join(" ")} · operate ${record.operate} (${record.operate === 1 ? "look" : "act"})`));
  console.log(dim(`    recording: ${record.outDir}`));
  console.log(
    dim(
      `    ends: ${record.owner === null ? "browser down, stop, or" : `when pid ${record.owner.pid} ends, browser down, stop, or`} ` +
        `its ${record.ttlSeconds}s deadline`,
    ),
  );
}

function saySwept(swept: readonly SweepAction[]): void {
  for (const action of swept) {
    console.log(
      `  swept ${action.container}${action.task === null ? "" : ` (task ${action.task})`}: ${action.why} — ` +
        `${action.ok ? action.detail : `NOT ended: ${action.detail}`}`,
    );
  }
}

async function cmdUp(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json", "no-build"]);
  if (positional.length > 0) return usageError(USAGE);
  let subject: SubjectId;
  try {
    subject = subjectId(options.get("subject") ?? "");
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const allow = allValues(argv, "allow");
  const parsed = parseAllowlist(allow);
  if (!parsed.ok) return usageError(parsed.errors.join("\n         "));
  const ttlRaw = options.get("ttl");
  if (ttlRaw !== undefined && !/^[0-9]+$/.test(ttlRaw)) return usageError("--ttl takes whole seconds");
  const operateRaw = options.get("operate") ?? "1";
  if (operateRaw !== "1" && operateRaw !== "2") return usageError("--operate is 1 (look) or 2 (act)");
  const task = options.get("task");
  if (task !== undefined) {
    const bad = taskProblem(task);
    if (bad !== undefined) return usageError(bad);
  }
  const up = await browserUp({
    env: dialEnv(),
    subject,
    allow,
    operate: Number(operateRaw) as 1 | 2,
    ...(task === undefined ? {} : { task }),
    ...(ttlRaw === undefined ? {} : { ttlSeconds: Number(ttlRaw) }),
    build: !options.has("no-build"),
    owner: null,
  });
  if (options.has("json")) {
    console.log(JSON.stringify(up.ok ? { ok: true, record: shown(up.record), built: up.built, mcp: browserMcpUrl(up.record.port), swept: up.swept } : up));
    return up.ok ? 0 : 1;
  }
  saySwept(up.swept);
  if (!up.ok) {
    console.error(`mind browser: not started: ${up.reason}`);
    return 1;
  }
  if (up.built) console.log(dim(`built ${up.record.image} on this machine (it is never pushed)`));
  console.log(`up: ${up.record.task}`);
  sayRecord(up.record);
  console.log(`  MCP: ${browserMcpUrl(up.record.port)} (loopback only)`);
  console.log(dim(`  egress: ${allowEnv(parsed.origins)} and nothing else — denied hosts are logged in ${join(up.record.outDir, "egress.jsonl")}`));
  return 0;
}

async function cmdDown(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  const task = positional[0];
  if (task === undefined || positional.length > 1) return usageError(USAGE);
  const bad = taskProblem(task);
  if (bad !== undefined) return usageError(bad);
  const down = await browserDown(dialEnv(), task);
  if (options.has("json")) {
    console.log(JSON.stringify({ task, ...down }));
  } else if (down.ok) {
    console.log(`down: ${task} — ${down.detail}${down.recorded ? "" : " (there was no record of it)"}`);
    console.log(dim("  the recording stays in the subject's personal directory until `mind erase` removes it"));
  } else {
    console.error(`mind browser: ${task} could not be ended: ${down.detail}`);
  }
  return down.ok ? 0 : 1;
}

async function cmdStatus(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  if (positional.length > 0) return usageError(USAGE);
  const status = await browserStatus(dialEnv());
  if (options.has("json")) {
    console.log(JSON.stringify({ ...status, running: status.running.map(shown) }));
    return status.error === undefined ? 0 : 1;
  }
  if (status.error !== undefined) console.error(`mind browser: docker is not usable here: ${status.error}`);
  saySwept(status.swept);
  for (const path of status.unreadable) console.log(`  unreadable record ${path}`);
  if (status.running.length === 0) console.log("no browser task is running");
  for (const record of status.running) sayRecord(record);
  return status.error === undefined ? 0 : 1;
}

async function cmdMcpConfig(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  const task = positional[0];
  const vendor = options.get("vendor");
  if (task === undefined || positional.length > 1 || vendor === undefined || vendor === "") return usageError(USAGE);
  const env = dialEnv();
  const { records } = await readBrowserRecords(env);
  const record = records.find((entry) => entry.task === task);
  if (record === undefined) {
    console.error(`mind browser: no browser task ${task} — \`mind browser status\` lists them`);
    return 1;
  }
  const levelRaw = options.get("level") ?? "1";
  if (levelRaw !== "1" && levelRaw !== "2") return usageError("--level is 1 (look) or 2 (act); 3 is confirmed at a terminal, not here");
  const level = Number(levelRaw) as 1 | 2;
  // Through the same arithmetic a turn's level goes through (operate = min(operate, reach), D-153): the
  // environment's ceiling and the brake apply.
  const restraint = restrain(
    effectiveDial({
      stored: { read: level, write: level, run: level, reach: level, operate: level, setBy: null, setAt: null },
      source: "file",
      envValue: readMind(AUTONOMY_MAX_ENV, process.env),
      stopped: await isStopped(env),
    }),
  );
  const wiring = browserWiring(vendor, { port: record.port, token: record.token, operate: record.operate, dir: wiringDir(env, record.subject, task) }, restraint);
  if (wiring.status === "wired") await writeBrowserWiring(wiring);
  if (options.has("json")) {
    // The files hold the token: their paths, never their content.
    console.log(JSON.stringify(wiring.status === "wired" ? { ...wiring, files: wiring.files.map((file) => file.path) } : wiring));
  } else if (wiring.status === "wired") {
    for (const file of wiring.files) console.log(`wrote ${file.path}`);
    console.log(`flags: ${[...wiring.args, "--strict-mcp-config", "--allowedTools", wiring.allowedTools.join(",")].join(" ")}`);
    console.log(dim(`  operate ${restraint.operate}: ${restraint.operate >= 2 ? "look and act — sensitive actions are still held in the container (D-153)" : "look only — no click, typing or submit"}; the file holds the task's token and is mode 600`));
    console.log(dim(`  server "${BROWSER_MCP_NAME}" → ${browserMcpUrl(record.port)}; ${wiring.evidence}`));
  } else {
    console.log(`${vendor}: no browser — ${wiring.reason}`);
  }
  return wiring.status === "wired" ? 0 : 1;
}

/** `mind browser <up|down|status|mcp-config>`. */
export async function cmdBrowser(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "up":
      return cmdUp(rest);
    case "down":
      return cmdDown(rest);
    case "status":
      return cmdStatus(rest);
    case "mcp-config":
      return cmdMcpConfig(rest);
    default:
      return usageError(USAGE);
  }
}
