/**
 * D-151 / D-155 — a task's browser, end to end: the real image, the real
 * docker, a real Playwright MCP behind Mind's guard, and a real claude-local
 * turn on the local model driving it through Mind's own MCP config inside the
 * D-118 fence.
 *
 * Run with:
 *
 *     MIND_E2E_BROWSER=1 bun run e2e:browser
 *
 * Named `.e2e.ts`, so a plain `bun test` (and CI, and `bun run coverage`)
 * never discovers it. Without the variable every case is skipped. With it,
 * it builds `mind-browser:<version>-<digest>` here if missing (a few minutes,
 * ~1.9 GB), spends GPU time on the local model, and waits out one 60-second
 * container deadline (case 8).
 *
 * Optional:
 *
 * - `MIND_E2E_BROWSER_CLAUDE=1` — also run the cloud `claude` CLI with the
 *   same config (`--model haiku`; costs the operator's own quota).
 * - `MIND_E2E_REPORT=<path>` — every result as JSON.
 * - `MIND_LITELLM_KEY_FILE` — the local chain's virtual key file; by default
 *   `~/.secrets/.env.mind-litellm` (D-124; a machine that has only the file under its earlier name keeps working).
 *
 * The test serves its own pages on the docker bridge's gateway address (found
 * at run time): an allowed one with a heading of random words, a login form and
 * two redirects out; a forbidden one with another heading.
 *
 *  1. `up`: running, published on 127.0.0.1 only, the token never printed.
 *  2. The door: no token or a wrong one is 401 from this machine; from a second
 *     container on the bridge neither the guard nor the MCP server answers;
 *     `tools/list` hides run-code, evaluate and file tools, and calling them is
 *     refused.
 *  3. Capabilities: every process but docker-init and the root deadline has an
 *     empty bounding set.
 *  4. The fence without a model: the allowed heading arrives; the forbidden
 *     origin is refused by Playwright MCP; a redirect around that list is
 *     refused at the proxy (403, logged); a socket from inside the container
 *     never leaves it (the kernel firewall); the forbidden server counts zero.
 *  5. D-153's always-pause list, inside the container: typing into a password
 *     field and clicking "Pay now" are held before they happen (the model is
 *     told why, `held.jsonl` names the rules, no value); typing into a search
 *     box is not. The password reaches neither the site nor the recording;
 *     files 600, directories 700.
 *  6. A real claude-local turn at operate 1 (look tools only) reads the allowed
 *     heading and cannot open the forbidden page.
 *  7. A turn that dies leaves no orphan: its owner SIGKILLed, the next status
 *     ends the container.
 *  8. The deadline cannot be beaten from inside: the browser frozen with
 *     SIGSTOP by its own uid, which cannot stop the deadline; the container ends.
 *  9. `erase` kills a subject's running browser and leaves a clean verdict.
 * 10. `stop` docker-kills, and the brake then refuses `up`.
 * 11. Nothing of this state root is left in `docker ps -a`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { browserMcpUrl, LOOK_TOOLS } from "../../src/browser/mcp-config.ts";
import { BROWSER_PORT_FIRST, BROWSER_PORT_LAST } from "../../src/browser/ports.ts";
import { BROWSER_LABEL, recordPath, rootLabel, wiringDir, type BrowserRecord } from "../../src/browser/runtime.ts";
import { CliExec } from "../../src/exec/cli-exec.ts";
import { LocalCliExec, liteLLMKeyFile } from "../../src/exec/local-cli.ts";
import { vendor } from "../../src/exec/registry.ts";
import type { TurnResult } from "../../src/exec/backend.ts";
import { subjectId } from "../../src/types.ts";
import { BUN } from "../support/bare-path.ts";
import { operating } from "../support/restraint.ts";

const ENABLED = process.env["MIND_E2E_BROWSER"] === "1";
const WITH_CLOUD_CLAUDE = process.env["MIND_E2E_BROWSER_CLAUDE"] === "1";
const REPORT = process.env["MIND_E2E_REPORT"];
const KEY_FILE = liteLLMKeyFile(homedir(), process.env);
const BIN = join(import.meta.dir, "..", "..", "bin", "mind.ts");
const TURN = join(import.meta.dir, "support", "browser-turn.ts");
const SUBJECT = subjectId("e2e-browser");
/** The base image the second container is: already on this machine, because the browser image is built from it. */
const PROBE_IMAGE = "node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c";

const words = ["amber", "basalt", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kestrel", "lagoon"];
function phrase(): string {
  const pick = () => words[Math.floor(Math.random() * words.length)]!;
  return `${pick()} ${pick()} ${pick()} ${Math.floor(1000 + Math.random() * 9000)}`;
}
const ALLOWED_HEADING = `Allowed ${phrase()}`;
const FORBIDDEN_HEADING = `Forbidden ${phrase()}`;
const PASSWORD = `pw-${crypto.randomUUID()}`;

interface Box {
  root: string;
  env: Record<string, string>;
  gateway: string;
  allowedPort: number;
  forbiddenPort: number;
  allowedHits: string[];
  forbiddenHits: string[];
  posted: string[];
  servers: ReturnType<typeof Bun.serve>[];
  record?: BrowserRecord;
}
const box = {} as Box;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), allowedHeading: ALLOWED_HEADING };
const browserEnv = () => ({ home: box.root, env: box.env });

async function sh(argv: readonly string[], env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env }) });
  const [stdout, stderr] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

function cli(args: readonly string[]) {
  return sh([BUN, "run", BIN, ...args], box.env);
}

async function containersOfThisRoot(all = false): Promise<string[]> {
  const listed = await sh([
    "docker", "ps", ...(all ? ["-a"] : []), "--filter", `label=${BROWSER_LABEL}.root=${rootLabel(browserEnv())}`, "--format", "{{.Names}}",
  ]);
  return listed.stdout.split("\n").filter((line) => line.trim() !== "");
}

/** `--rm` removes a killed container a moment after `docker kill` returns. */
async function goneSoon(seconds = 10): Promise<string[]> {
  for (let attempt = 0; attempt < seconds * 4; attempt++) {
    const left = await containersOfThisRoot(true);
    if (left.length === 0) return left;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return containersOfThisRoot(true);
}

/** The record as written to disk — the only place the token is. */
async function recordOnDisk(task: string): Promise<BrowserRecord> {
  return JSON.parse(await readFile(recordPath(browserEnv(), SUBJECT, task), "utf8")) as BrowserRecord;
}

/** A minimal MCP client over streamable HTTP — enough to call tools without a model. */
async function mcpSession(port: number, token: string) {
  let session: string | undefined;
  let id = 0;
  const call = async (method: string, params: unknown, notify = false) => {
    const response = await fetch(browserMcpUrl(port), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session === undefined ? {} : { "mcp-session-id": session }),
      },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params }),
    });
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    const text = await response.text();
    if (notify) return undefined;
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return JSON.parse(data === undefined ? text : data.slice(5));
  };
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mind-e2e", version: "0" } });
  await call("notifications/initialized", {}, true);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await call("tools/call", { name, arguments: args });
    return {
      text: (result.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("\n"),
      isError: result.result?.isError === true,
      error: result.error?.message as string | undefined,
    };
  };
  return { call, tool };
}

async function egressLog(): Promise<{ decision: string; origin: string; reason?: string }[]> {
  const path = join(box.record!.outDir, "egress.jsonl");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

/** Every file under a directory, with its mode. */
async function walk(dir: string): Promise<{ path: string; mode: number; dir: boolean }[]> {
  const out: { path: string; mode: number; dir: boolean }[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path);
    out.push({ path, mode: info.mode & 0o777, dir: info.isDirectory() });
    if (info.isDirectory()) out.push(...(await walk(path)));
  }
  return out;
}

/** The pid of the newest process in a container whose command line matches. */
async function pidIn(container: string, pattern: string): Promise<number> {
  const listed = await sh([
    "docker", "exec", container, "node", "-e",
    `const fs=require("fs");for(const p of fs.readdirSync("/proc").filter(n=>/^\\d+$/.test(n))){try{const c=fs.readFileSync("/proc/"+p+"/cmdline","utf8").replace(/\\0/g," ");if(c.includes(${JSON.stringify(pattern)})&&!c.includes("readdirSync"))console.log(p)}catch{}}`,
  ]);
  const pids = listed.stdout.split("\n").filter((line) => line !== "").map(Number);
  expect(pids.length, `${pattern} in ${container}: ${listed.stderr}`).toBeGreaterThan(0);
  return pids.at(-1)!;
}

test.skipIf(ENABLED)("not run: set MIND_E2E_BROWSER=1 to start a real browser container and spend a real turn", () => {
  expect(ENABLED).toBe(false);
});

describe.skipIf(!ENABLED)("D-151/D-155 — a task's browser, really", () => {
  beforeAll(async () => {
    box.root = await mkdtemp(join(tmpdir(), "mind-e2e-browser-"));
    box.env = {
      HOME: box.root,
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      XDG_STATE_HOME: join(box.root, "state"),
      XDG_DATA_HOME: join(box.root, "data"),
      MIND_LITELLM_KEY_FILE: KEY_FILE,
    };
    const inspected = await sh(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]);
    expect(inspected.code, inspected.stderr).toBe(0);
    box.gateway = inspected.stdout.trim();
    box.allowedHits = [];
    box.forbiddenHits = [];
    box.posted = [];
    const page = (heading: string) =>
      `<!doctype html><html><head><title>mind e2e</title></head><body><h1>${heading}</h1><p>A page served by the test.</p></body></html>`;
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
    const forbidden = Bun.serve({
      hostname: box.gateway,
      port: 0,
      fetch: (request) => {
        box.forbiddenHits.push(`${request.method} ${new URL(request.url).pathname}`);
        return html(page(FORBIDDEN_HEADING));
      },
    });
    box.forbiddenPort = forbidden.port!;
    const allowed = Bun.serve({
      hostname: box.gateway,
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        box.allowedHits.push(`${request.method} ${path}`);
        if (path === "/redirect-out") return Response.redirect(`http://host.docker.internal:${box.forbiddenPort}/`, 302);
        if (path === "/dialogs" && request.method === "GET") {
          return html(
            "<h1>Dialogs</h1>" +
              "<button type=\"button\" onclick=\"const p=prompt('Enter your password');if(p!==null)fetch('/login',{method:'POST',body:'pw='+p})\">Show</button>" +
              "<button type=\"button\" onclick=\"if(confirm('Delete your account permanently?'))fetch('/delete-account',{method:'POST',body:'yes'})\">Next</button>" +
              "<button type=\"button\" onclick=\"const n=prompt('Your name?');if(n!==null)fetch('/hello',{method:'POST',body:'name='+n})\">Name</button>",
          );
        }
        if ((path === "/delete-account" || path === "/hello") && request.method === "POST") {
          box.posted.push(`${path} ${await request.text()}`);
          return html("ok");
        }
        if (path === "/login" && request.method === "POST") {
          box.posted.push(await request.text());
          return html("<h1>Signed in</h1>");
        }
        if (path === "/login") {
          return html(
            '<h1>Login</h1><input type="search" aria-label="search the shop">' +
              '<form method="post"><input name="user" aria-label="user">' +
              '<input type="password" name="pw" aria-label="password"><button>Sign in</button></form>' +
              '<button type="button" onclick="document.title=\'paid\'">Pay now</button>',
          );
        }
        return html(page(ALLOWED_HEADING));
      },
    });
    box.servers = [allowed, forbidden];
    box.allowedPort = allowed.port!;
    report["gateway"] = "docker bridge gateway (found at run time)";
  }, 60_000);

  afterAll(async () => {
    // Whatever happened above, nothing of this root's may be left running.
    for (const name of await containersOfThisRoot(true)) await sh(["docker", "kill", name]);
    report["leftAfter"] = await goneSoon();
    for (const server of box.servers ?? []) await server.stop(true);
    report["finishedAt"] = new Date().toISOString();
    if (REPORT !== undefined && REPORT !== "") await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    await rm(box.root, { recursive: true, force: true });
  }, 60_000);

  test("1. `mind browser up` starts the task's container, published on loopback only; the token is never printed", async () => {
    const started = performance.now();
    const up = await cli([
      "browser", "up", "--subject", SUBJECT, "--allow", `http://host.docker.internal:${box.allowedPort}`, "--task", "e2e-1", "--operate", "2", "--ttl", "900", "--json",
    ]);
    expect(up.code, up.stderr).toBe(0);
    const parsed = JSON.parse(up.stdout);
    box.record = await recordOnDisk("e2e-1");
    expect(box.record.token).toMatch(/^[0-9a-f]{64}$/);
    expect(up.stdout).not.toContain(box.record.token);
    expect((await stat(recordPath(browserEnv(), SUBJECT, "e2e-1"))).mode & 0o777).toBe(0o600);
    report["up"] = { ms: Math.round(performance.now() - started), built: parsed.built, port: box.record.port, container: box.record.container };
    expect(box.record.port).toBeGreaterThanOrEqual(BROWSER_PORT_FIRST);
    expect(box.record.port).toBeLessThanOrEqual(BROWSER_PORT_LAST);
    expect(await containersOfThisRoot()).toEqual([box.record.container]);
    const port = await sh(["docker", "port", box.record.container]);
    expect(port.stdout.trim()).toBe(`8931/tcp -> 127.0.0.1:${box.record.port}`);
    const status = await cli(["browser", "status", "--json"]);
    expect(status.stdout).not.toContain(box.record.token);
    expect(JSON.parse(status.stdout).running.map((record: BrowserRecord) => record.task)).toEqual(["e2e-1"]);
  }, 900_000);

  test("2. the door: a token from this machine, nothing from another container, no run-code tools", async () => {
    const url = browserMcpUrl(box.record!.port);
    const post = (authorization?: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    expect((await post()).status).toBe(401);
    expect((await post(`Bearer ${"0".repeat(64)}`)).status).toBe(401);

    // A second container on the same bridge — with the token, even — reaches neither port.
    const ip = (await sh(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", box.record!.container])).stdout.trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const probe = await sh([
      "docker", "run", "--rm", "--network", "bridge", PROBE_IMAGE, "node", "-e",
      `(async()=>{for(const p of [8931,8932]){try{const r=await fetch("http://${ip}:"+p+"/mcp",{method:"POST",headers:{authorization:"Bearer ${box.record!.token}","content-type":"application/json"},body:"{}",signal:AbortSignal.timeout(5000)});console.log(p,"REACHED",r.status)}catch(e){console.log(p,"FAILED",e.cause?.code??e.name)}}})()`,
    ]);
    expect(probe.stdout, probe.stderr).toContain("8931 FAILED");
    expect(probe.stdout).toContain("8932 FAILED");
    expect(probe.stdout).not.toContain("REACHED");

    const mcp = await mcpSession(box.record!.port, box.record!.token);
    const tools = await mcp.call("tools/list", {});
    const names: string[] = tools.result.tools.map((entry: { name: string }) => entry.name);
    expect(names).toContain("browser_navigate");
    for (const banned of ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop"]) {
      expect(names).not.toContain(banned);
    }
    const runCode = await mcp.tool("browser_run_code_unsafe", { code: "async () => process.env" });
    expect(runCode.error).toContain("browser_run_code_unsafe is not served");
    const evaluate = await mcp.tool("browser_evaluate", { function: "() => document.cookie" });
    expect(evaluate.error).toContain("browser_evaluate is not served");
    report["door"] = { noToken: 401, otherContainer: probe.stdout.trim().split("\n"), tools: names.length };
  }, 120_000);

  test("3. only docker-init and the root deadline keep any capability; everything else — Chromium too — has none", async () => {
    // Start the browser first, so its processes are in the list.
    const mcp = await mcpSession(box.record!.port, box.record!.token);
    expect((await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.allowedPort}/` })).isError).toBe(false);
    const listed = await sh([
      "docker", "exec", "-u", "65534:65534", box.record!.container, "node", "-e",
      `const fs=require("fs");for(const p of fs.readdirSync("/proc").filter(n=>/^\\d+$/.test(n))){if(+p===process.pid)continue;try{const s=fs.readFileSync("/proc/"+p+"/status","utf8");const g=k=>s.match(new RegExp("^"+k+":\\\\s*(\\\\S+)","m"))[1];console.log([g("Name"),g("Uid"),g("CapBnd"),g("CapEff")].join(" "))}catch{}}`,
    ]);
    const rows = listed.stdout.split("\n").filter((line) => line !== "").map((line) => line.split(" "));
    expect(rows.length, listed.stderr).toBeGreaterThan(3);
    expect(rows.some(([name]) => /chrom/i.test(name!))).toBe(true);
    const withCaps = rows.filter(([, , bnd]) => bnd !== "0000000000000000");
    expect(withCaps.map(([name, uid]) => `${name}:${uid}`).sort()).toEqual(["docker-init:0", "timeout:0"]);
    const deadline = withCaps.find(([name]) => name === "timeout")!;
    // KILL, SETGID, SETUID, SETPCAP — and not NET_ADMIN (bit 12).
    expect(deadline[2]).toBe("00000000000001e0");
    report["capabilities"] = rows.map((row) => row.join(" "));
  }, 60_000);

  test("4a. a container at operate 1 serves look tools only — even to a caller with the token and a shell", async () => {
    const up = await cli(["browser", "up", "--subject", SUBJECT, "--allow", `http://host.docker.internal:${box.allowedPort}`, "--task", "e2e-look", "--json"]);
    expect(up.code, up.stderr).toBe(0);
    const look = await recordOnDisk("e2e-look");
    expect(look.operate).toBe(1);
    const mcp = await mcpSession(look.port, look.token);
    const names: string[] = (await mcp.call("tools/list", {})).result.tools.map((entry: { name: string }) => entry.name);
    expect(names.sort()).toEqual(LOOK_TOOLS.slice().sort());
    expect((await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.allowedPort}/login` })).isError).toBe(false);
    for (const name of ["browser_click", "browser_type", "browser_fill_form", "browser_press_key"]) {
      const refused = await mcp.tool(name, { element: "Sign in", target: "e1", text: "x", key: "Enter", fields: [] });
      expect(refused.error, name).toContain(`${name} is not served`);
    }
    expect((await cli(["browser", "down", "e2e-look"])).code).toBe(0);
    report["operate1"] = { tools: names.length, actRefused: true };
  }, 300_000);

  test("4b. javascript: and data: URLs are refused before the browser sees them; nothing is posted or recorded", async () => {
    const mcp = await mcpSession(box.record!.port, box.record!.token);
    await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.allowedPort}/login` });
    const posted = box.posted.length;
    const attacks = {
      title: "javascript:document.title='pwned'",
      login:
        `javascript:(()=>{const f=document.forms[0];f.user.value='alice';f.pw.value='${PASSWORD}';f.submit()})()`,
      data:
        "data:text/html,<form method=post action='http://host.docker.internal:" +
        box.allowedPort +
        `/login'><input name=pw value='${PASSWORD}'></form><script>document.forms[0].submit()</script>`,
    };
    for (const [name, url] of Object.entries(attacks)) {
      const navigated = await mcp.tool("browser_navigate", { url });
      expect(navigated.error, name).toContain("URLs are not opened");
    }
    const tab = await mcp.tool("browser_tabs", { action: "new", url: attacks.login });
    expect(tab.error).toContain("URLs are not opened");
    expect((await mcp.tool("browser_snapshot", {})).text).not.toContain("pwned");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(box.posted.length).toBe(posted);
    const actions = await readFile(join(box.record!.outDir, "actions.jsonl"), "utf8");
    expect(actions).not.toContain(PASSWORD);
    expect(actions).toContain("[javascript: url,");
    expect(actions).toContain("[data: url,");
    report["schemes"] = { refused: [...Object.keys(attacks), "tabs-new"], posted: box.posted.length - posted };
  }, 120_000);

  test("4. the fence holds without a model: allowed page in, forbidden origin refused at the MCP, the proxy and the kernel", async () => {
    const mcp = await mcpSession(box.record!.port, box.record!.token);
    const opened = await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.allowedPort}/` });
    expect(opened.isError, opened.text).toBe(false);
    expect((await mcp.tool("browser_snapshot", {})).text).toContain(ALLOWED_HEADING);

    const blocked = await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.forbiddenPort}/` });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("ERR_BLOCKED_BY_CLIENT");

    // Around Playwright MCP's own origin list, which "does not affect redirects": an allowed page that
    // redirects to the forbidden origin. The proxy refuses it.
    const redirected = await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.allowedPort}/redirect-out` });
    expect(redirected.text).not.toContain(FORBIDDEN_HEADING);

    // Around the proxy: a socket from inside the container, as the browser's own uid. The kernel drops it.
    const uid = `${process.getuid!()}:${process.getgid!()}`;
    const raw = await sh([
      "docker", "exec", "-u", uid, box.record!.container, "node", "-e",
      `fetch("http://host.docker.internal:${box.forbiddenPort}/",{signal:AbortSignal.timeout(5000)}).then(r=>console.log("REACHED",r.status)).catch(e=>console.log("FAILED",e.cause?.code??e.name))`,
    ]);
    expect(raw.stdout).toContain("FAILED");

    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await egressLog();
    report["egressLog"] = log;
    expect(log.some((line) => line.decision === "allow" && line.origin === `http://host.docker.internal:${box.allowedPort}`)).toBe(true);
    expect(log.some((line) => line.decision === "deny" && line.origin === `http://host.docker.internal:${box.forbiddenPort}`)).toBe(true);
    expect(box.forbiddenHits).toEqual([]);
    report["fence"] = {
      navigateForbidden: "ERR_BLOCKED_BY_CLIENT",
      redirect: "403 at the proxy, deny logged",
      kernel: raw.stdout.trim(),
      forbiddenHits: box.forbiddenHits.length,
    };
  }, 120_000);

  test("5. a password field and a Pay button are held inside the container; a search box is not", async () => {
    const mcp = await mcpSession(box.record!.port, box.record!.token);
    await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.allowedPort}/login` });
    const snapshot = (await mcp.tool("browser_snapshot", {})).text;
    const ref = (pattern: string) => snapshot.match(new RegExp(`${pattern}[^\\n]*\\[ref=(\\w+)\\]`))?.[1];
    const search = ref('searchbox "search the shop"');
    const password = ref('textbox "password"');
    const pay = ref('button "Pay now"');
    expect([search, password, pay].every((entry) => entry !== undefined), snapshot).toBe(true);

    const searched = await mcp.tool("browser_type", { element: "search", target: search!, text: "kiwi" });
    expect(searched.isError, searched.text).toBe(false);
    const typed = await mcp.tool("browser_type", { element: "password", target: password!, text: PASSWORD, submit: true });
    expect(typed.isError).toBe(true);
    expect(typed.text).toContain("mind held this action");
    const paid = await mcp.tool("browser_click", { element: "Pay now", target: pay! });
    expect(paid.isError).toBe(true);
    expect(paid.text).toContain("mind held this action");
    expect((await mcp.tool("browser_snapshot", {})).text).not.toContain("paid");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(box.posted).toEqual([]);

    const heldLines = (await readFile(join(box.record!.outDir, "held.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(heldLines.flatMap((line) => line.rules)).toEqual(expect.arrayContaining(["credentials.value"]));
    expect(heldLines.some((line) => line.rules.some((rule: string) => rule.startsWith("payment")))).toBe(true);

    const files = await walk(box.record!.outDir);
    const leaks: string[] = [];
    for (const file of files.filter((entry) => !entry.dir)) {
      if ((await readFile(file.path)).includes(PASSWORD)) leaks.push(file.path);
    }
    expect(leaks).toEqual([]);
    expect(files.filter((entry) => entry.dir && entry.mode !== 0o700).map((entry) => entry.path)).toEqual([]);
    expect(files.filter((entry) => !entry.dir && entry.mode !== 0o600).map((entry) => entry.path)).toEqual([]);
    const actions = await readFile(join(box.record!.outDir, "actions.jsonl"), "utf8");
    expect(actions).toContain(`"text":"[typed, ${PASSWORD.length} chars]"`);
    report["sensitive"] = {
      searchTyped: true,
      held: heldLines.map((line) => ({ kind: line.kind, rules: line.rules })),
      posted: box.posted.length,
      filesSearched: files.length,
      leaks: leaks.length,
    };
  }, 120_000);

  test("5b. a dialog is held before it is accepted: a password prompt and a delete confirm; a name prompt is not; dismissing always works", async () => {
    const mcp = await mcpSession(box.record!.port, box.record!.token);
    await mcp.tool("browser_navigate", { url: `http://host.docker.internal:${box.allowedPort}/dialogs` });
    const snapshot = (await mcp.tool("browser_snapshot", {})).text;
    const ref = (name: string) => snapshot.match(new RegExp(`button "${name}" \\[ref=(\\w+)\\]`))?.[1];
    const before = box.posted.length;

    await mcp.tool("browser_click", { element: "Show", target: ref("Show")! });
    const prompted = await mcp.tool("browser_handle_dialog", { accept: true, promptText: PASSWORD });
    expect(`${prompted.error ?? ""}${prompted.text}`).toContain("mind held this action");

    // The page is not left wedged: the held dialog was dismissed.
    expect((await mcp.tool("browser_snapshot", {})).text).toContain("Dialogs");

    await mcp.tool("browser_click", { element: "Next", target: ref("Next")! });
    const confirmed = await mcp.tool("browser_handle_dialog", { accept: true });
    expect(`${confirmed.error ?? ""}${confirmed.text}`).toContain("mind held this action");

    await mcp.tool("browser_click", { element: "Next", target: ref("Next")! });
    const dismissed = await mcp.tool("browser_handle_dialog", { accept: false });
    expect(dismissed.isError, dismissed.text).toBe(false);

    await mcp.tool("browser_click", { element: "Name", target: ref("Name")! });
    const named = await mcp.tool("browser_handle_dialog", { accept: true, promptText: "Alice" });
    expect(named.isError, named.text).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const sent = box.posted.slice(before);
    expect(sent).toEqual(["/hello name=Alice"]);
    const heldLines = (await readFile(join(box.record!.outDir, "held.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const dialogHolds = heldLines.filter((line) => String(line.kind).startsWith("dialog-"));
    expect(dialogHolds.map((line) => line.kind)).toEqual(["dialog-type", "dialog-submit"]);
    expect(dialogHolds[0].rules).toEqual(expect.arrayContaining(["credentials.value"]));
    expect(dialogHolds[1].rules).toEqual(expect.arrayContaining(["delete.words"]));
    const leaks: string[] = [];
    for (const file of (await walk(box.record!.outDir)).filter((entry) => !entry.dir)) {
      if ((await readFile(file.path)).includes(PASSWORD)) leaks.push(file.path);
    }
    expect(leaks).toEqual([]);
    report["dialogs"] = { held: dialogHolds.map((line) => ({ kind: line.kind, rules: line.rules })), sent, leaks: leaks.length };
  }, 120_000);

  test("6. a real claude-local turn at level 1 reads the page through Mind's MCP config, inside the fence", async () => {
    const before = box.forbiddenHits.length;
    const hits = box.allowedHits.length;
    const backend = new LocalCliExec("claude-local", { home: box.root, env: box.env, cwd: () => box.root });
    const hands = { port: box.record!.port, token: box.record!.token, operate: box.record!.operate, dir: wiringDir(browserEnv(), SUBJECT, "e2e-1") };
    // D-155: the fence gains the container's port and nothing else.
    expect(backend.prepare({ subject: SUBJECT, prompt: "", restraint: operating(1), browser: hands }).fence?.tcpPorts).toEqual([10_400, box.record!.port]);
    const prompt =
      `Use the browser tools. First open http://host.docker.internal:${box.allowedPort}/ and read the exact text of the ` +
      `page's main heading (the h1). Then try to open http://host.docker.internal:${box.forbiddenPort}/ the same way. ` +
      "Answer with exactly two lines and nothing else:\n" +
      "ALLOWED: <the exact h1 text of the first page>\n" +
      "SECOND: <the exact h1 text of the second page, or BLOCKED if it could not be opened>";
    const started = performance.now();
    // In a process of its own, because the fence re-enters the running main (support/browser-turn.ts says why).
    const ran = await sh(
      [BUN, "run", TURN, JSON.stringify({ home: box.root, env: box.env, ...hands, prompt, timeoutMs: 600_000, subject: SUBJECT })],
      box.env,
    );
    expect(ran.code, ran.stderr).toBe(0);
    const result = JSON.parse(ran.stdout.trim().split("\n").at(-1)!) as TurnResult;
    report["claudeLocal"] = {
      ms: Math.round(performance.now() - started),
      confidence: result.confidence,
      text: result.text,
      allowedRequests: box.allowedHits.length - hits,
      forbiddenRequests: box.forbiddenHits.length - before,
    };
    expect(result.confidence, String(result.evidence.raw).slice(0, 2_000)).toBe("confirmed");
    expect(result.text).toContain(ALLOWED_HEADING);
    expect(result.text).not.toContain(FORBIDDEN_HEADING);
    expect(box.forbiddenHits.length).toBe(before);
    expect(box.allowedHits.length).toBeGreaterThan(hits);
    const config = JSON.parse(await readFile(join(hands.dir, "claude-local-mcp.json"), "utf8"));
    expect(Object.keys(config.mcpServers)).toEqual(["mind-browser"]);
    expect((await stat(join(hands.dir, "claude-local-mcp.json"))).mode & 0o777).toBe(0o600);
  }, 900_000);

  test.skipIf(!WITH_CLOUD_CLAUDE)("6b. the cloud claude CLI takes the same config (opt-in)", async () => {
    const before = box.forbiddenHits.length;
    const hits = box.allowedHits.length;
    const exec = new CliExec(vendor("claude"));
    const result = await exec.run({
      subject: SUBJECT,
      // A system prompt of Mind's own puts the turn under `--setting-sources project,local` (D-047): no owner hooks.
      system: "You are a test agent. Use only the browser tools you are given.",
      prompt:
        `Use the browser tools to open http://host.docker.internal:${box.allowedPort}/ and reply with only the exact text of the page's h1 heading.`,
      model: "haiku",
      restraint: operating(1),
      browser: { port: box.record!.port, token: box.record!.token, operate: box.record!.operate, dir: wiringDir(browserEnv(), SUBJECT, "e2e-1") },
      cwd: box.root,
      timeoutMs: 300_000,
    });
    report["claudeCloud"] = { confidence: result.confidence, text: result.text, allowedRequests: box.allowedHits.length - hits };
    expect(result.confidence, String(result.evidence.raw).slice(0, 2_000)).toBe("confirmed");
    expect(result.text).toContain(ALLOWED_HEADING);
    expect(box.forbiddenHits.length).toBe(before);
  }, 600_000);

  test("7. a turn that dies leaves no orphan: its owner SIGKILLed, the next status ends the container", async () => {
    const script = join(box.root, "owner.ts");
    await writeFile(
      script,
      `import { browserUp } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "browser", "runtime.ts"))};\n` +
        `const up = await browserUp({ env: { home: ${JSON.stringify(box.root)}, env: ${JSON.stringify(box.env)} }, subject: ${JSON.stringify(SUBJECT)}, ` +
        `allow: ["http://host.docker.internal:${box.allowedPort}"], task: "e2e-orphan", ttlSeconds: 900, owner: process.pid });\n` +
        `console.log(JSON.stringify(up.ok ? { ok: true, container: up.record.container } : up));\n` +
        `setInterval(() => {}, 1000);\n`,
    );
    const owner = Bun.spawn([BUN, "run", script], { stdout: "pipe", stderr: "pipe", env: box.env });
    const reader = owner.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const line = JSON.parse(first.trim().split("\n")[0]!);
    expect(line.ok, first).toBe(true);
    expect((await containersOfThisRoot()).sort()).toEqual([box.record!.container, line.container].sort());
    owner.kill("SIGKILL");
    await owner.exited;
    const status = await cli(["browser", "status"]);
    expect(status.stdout).toContain(`swept ${line.container} (task e2e-orphan): owner gone — killed`);
    for (let attempt = 0; attempt < 40 && (await containersOfThisRoot(true)).includes(line.container); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(await containersOfThisRoot(true)).toEqual([box.record!.container]);
    report["orphan"] = "owner gone — killed by the next status";
  }, 300_000);

  test("8. the deadline cannot be beaten from inside: a frozen browser still ends at its TTL", async () => {
    const up = await cli([
      "browser", "up", "--subject", SUBJECT, "--allow", `http://host.docker.internal:${box.allowedPort}`, "--task", "e2e-ttl", "--ttl", "60", "--json",
    ]);
    expect(up.code, up.stderr).toBe(0);
    const record = await recordOnDisk("e2e-ttl");
    const uid = `${process.getuid!()}:${process.getgid!()}`;
    const mcp = await pidIn(record.container, "/usr/local/bin/playwright-mcp");
    const deadline = await pidIn(record.container, "timeout --signal");
    // The browser's own uid freezes the browser, and cannot touch the deadline.
    const frozen = await sh(["docker", "exec", "-u", uid, record.container, "sh", "-c", `kill -STOP ${mcp}`]);
    expect(frozen.code, frozen.stderr).toBe(0);
    const stopDeadline = await sh(["docker", "exec", "-u", uid, record.container, "sh", "-c", `kill -STOP ${deadline}`]);
    expect(stopDeadline.code).not.toBe(0);
    expect(stopDeadline.stderr).toMatch(/not permitted/i);
    const started = Date.now();
    let alive = true;
    while (alive && Date.now() - started < 120_000) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      alive = (await containersOfThisRoot(true)).includes(record.container);
    }
    const tookMs = Date.now() - Date.parse(record.startedAt);
    report["deadline"] = { ttlSeconds: 60, endedAfterMs: tookMs, frozen: true, deadlineStoppable: false };
    expect(alive).toBe(false);
    // 60 s, and the 10 s KILL after the TERM a frozen process cannot act on.
    expect(tookMs).toBeLessThan(90_000);
    await cli(["browser", "status"]);
    expect(existsSync(recordPath(browserEnv(), SUBJECT, "e2e-ttl"))).toBe(false);
  }, 300_000);

  test("9. `erase` kills the subject's running browser and leaves a clean verdict", async () => {
    const subject = subjectId("e2e-erase-me");
    const up = await cli(["browser", "up", "--subject", subject, "--allow", `http://host.docker.internal:${box.allowedPort}`, "--task", "e2e-erase", "--json"]);
    expect(up.code, up.stderr).toBe(0);
    const container = (await containersOfThisRoot()).find((name) => name.endsWith("-e2e-erase"))!;
    expect(container).toBeDefined();
    const erased = await cli(["erase", subject, "--no-agent", "--by", "the browser e2e", "--yes", "--json"]);
    report["erase"] = { code: erased.code, tail: erased.stderr.split("\n").slice(-4) };
    expect(erased.code, `${erased.stdout.slice(-2_000)}\n${erased.stderr.slice(-2_000)}`).toBe(0);
    expect(JSON.parse(erased.stdout).verdict).toBe("erased-and-verified");
    for (let attempt = 0; attempt < 40 && (await containersOfThisRoot(true)).includes(container); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(await containersOfThisRoot(true)).not.toContain(container);
  }, 300_000);

  test("10. `mind stop` docker-kills it, and the brake then refuses `up`", async () => {
    const stop = await cli(["stop"]);
    expect(stop.stdout).toContain(`${box.record!.container} (task e2e-1): killed`);
    expect(await goneSoon()).toEqual([]);
    const refused = await cli(["browser", "up", "--subject", SUBJECT, "--allow", `http://host.docker.internal:${box.allowedPort}`]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the brake is on");
    expect(await containersOfThisRoot(true)).toEqual([]);
    report["stop"] = { stop: "killed", brake: "up refused" };
  }, 120_000);

  test("11. nothing is left: no container of this root, no record", async () => {
    expect(await goneSoon()).toEqual([]);
    const root = join(box.root, "state", "mind", "browser");
    const left = existsSync(root)
      ? (await walk(root)).filter((entry) => !entry.dir && entry.path.endsWith(".json")).map((entry) => entry.path)
      : [];
    expect(left).toEqual([]);
  });
});
