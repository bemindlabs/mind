/**
 * S18.2 — the backend probe, and the floor: Mind never puts vLLM to sleep and never wakes it (AC3).
 */

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_VLLM_URL, MAX_PROBE_BODY_BYTES, VLLM_URL_ENV, backendReadiness, needsLocalModel, probeLocalModel, probeTargets } from "../../src/task/backend-ready.ts";
import { LITELLM_BASE_URL } from "../../src/exec/local-cli.ts";
import { aTask } from "./fixture.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** A fake fetch: answers by path, keeps every request it saw. */
function fakeFetch(answers: Record<string, { status: number; body?: unknown } | "refused">) {
  const seen: { url: string; method: string; init: Record<string, unknown> }[] = [];
  const fetcher = async (url: string, init: { readonly method: "GET"; readonly signal: AbortSignal; readonly redirect: "error" }) => {
    seen.push({ url, method: init.method, init: init as unknown as Record<string, unknown> });
    const path = new URL(url).pathname;
    const answer = answers[path];
    if (answer === undefined) return new Response("not found", { status: 404 });
    if (answer === "refused") throw new Error("Unable to connect. Is the computer able to access the url?");
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  };
  return { fetcher, seen };
}

const targets = { litellm: "http://127.0.0.1:9", vllm: "http://127.0.0.1:8" };

describe("the backend probe (S18.2)", () => {
  test("only a chain of local CLIs alone waits on the local model", () => {
    expect(needsLocalModel(aTask({ backend: "claude-local" }))).toBe(true);
    expect(needsLocalModel(aTask({ backend: "claude-local,grok-local" }))).toBe(true);
    expect(needsLocalModel(aTask({ backend: "claude-local,claude" }))).toBe(false);
    expect(needsLocalModel(aTask({ backend: "ollama" }))).toBe(false);
    expect(needsLocalModel(aTask({ backend: null }))).toBe(false);
    expect(needsLocalModel(aTask({ backend: " , " }))).toBe(false);
  });

  test("where it asks: LiteLLM's base and MIND_VLLM_URL (default :10410; none skips vLLM)", () => {
    expect(probeTargets({})).toEqual({ litellm: LITELLM_BASE_URL, vllm: DEFAULT_VLLM_URL });
    expect(probeTargets({ [VLLM_URL_ENV]: "http://127.0.0.1:5555/" }).vllm).toBe("http://127.0.0.1:5555");
    expect(probeTargets({ [VLLM_URL_ENV]: "none" }).vllm).toBeNull();
    expect(probeTargets({ [VLLM_URL_ENV]: "off" }).vllm).toBeNull();
  });

  test("ready: LiteLLM alive and vLLM awake — asked with two GETs, no body, no key", async () => {
    const fake = fakeFetch({ "/health/liveliness": { status: 200, body: "I'm alive!" }, "/is_sleeping": { status: 200, body: { is_sleeping: false } } });
    expect(await probeLocalModel(targets, fake.fetcher)).toEqual({ ready: true });
    expect(fake.seen.map((s) => [s.method, s.url])).toEqual([
      ["GET", "http://127.0.0.1:9/health/liveliness"],
      ["GET", "http://127.0.0.1:8/is_sleeping"],
    ]);
    for (const request of fake.seen) {
      expect(request.init["redirect"]).toBe("error");
      expect(request.init["body"]).toBeUndefined();
      expect(request.init["headers"]).toBeUndefined();
    }
  });

  test("not ready: vLLM asleep, vLLM down, LiteLLM down or failing — each says which", async () => {
    const asleep = await probeLocalModel(targets, fakeFetch({ "/health/liveliness": { status: 200 }, "/is_sleeping": { status: 200, body: { is_sleeping: true } } }).fetcher);
    expect(asleep).toEqual({ ready: false, reason: "vLLM (http://127.0.0.1:8) is asleep — another job has the GPU; it is woken by whoever put it to sleep" });
    const down = await probeLocalModel(targets, fakeFetch({ "/health/liveliness": { status: 200 }, "/is_sleeping": "refused" }).fetcher);
    expect(down.ready).toBe(false);
    if (!down.ready) expect(down.reason).toStartWith("vLLM (http://127.0.0.1:8) did not answer");
    const proxyDown = fakeFetch({ "/health/liveliness": "refused" });
    const proxy = await probeLocalModel(targets, proxyDown.fetcher);
    expect(proxy.ready).toBe(false);
    if (!proxy.ready) expect(proxy.reason).toStartWith("LiteLLM (http://127.0.0.1:9) did not answer");
    // vLLM is not asked when LiteLLM is not there.
    expect(proxyDown.seen).toHaveLength(1);
    expect(await probeLocalModel(targets, fakeFetch({ "/health/liveliness": { status: 503 } }).fetcher)).toEqual({ ready: false, reason: "LiteLLM (http://127.0.0.1:9) answered 503" });
  });

  test("fail closed: an /is_sleeping that is not a boolean, a status other than 200 or 404, or a body past the cap is not ready", async () => {
    const live = { status: 200 } as const;
    for (const body of [{ is_sleeping: "false" }, { is_sleeping: 0 }, { is_sleeping: null }, {}, [], "text"]) {
      const out = await probeLocalModel(targets, fakeFetch({ "/health/liveliness": live, "/is_sleeping": { status: 200, body } }).fetcher);
      expect(out.ready, JSON.stringify(body)).toBe(false);
      if (!out.ready) expect(out.reason).toContain("not true or false");
    }
    const huge = await probeLocalModel(targets, fakeFetch({ "/health/liveliness": live, "/is_sleeping": { status: 200, body: { is_sleeping: false, pad: "x".repeat(MAX_PROBE_BODY_BYTES + 10) } } }).fetcher);
    expect(huge.ready).toBe(false);
    for (const status of [500, 503, 302, 401]) {
      const out = await probeLocalModel(targets, fakeFetch({ "/health/liveliness": live, "/is_sleeping": { status } }).fetcher);
      expect(out).toEqual({ ready: false, reason: `vLLM (http://127.0.0.1:8) answered /is_sleeping ${status}` });
    }
    // An answer with no body at all.
    const noBody = await probeLocalModel(targets, fakeFetch({ "/health/liveliness": live, "/is_sleeping": { status: 200 } }).fetcher);
    expect(noBody.ready).toBe(false);
  });

  test("a vLLM without the sleep route (not in dev mode) is asked /health; LiteLLM alone when vLLM is none", async () => {
    expect(await probeLocalModel(targets, fakeFetch({ "/health/liveliness": { status: 200 }, "/health": { status: 200 } }).fetcher)).toEqual({ ready: true });
    expect(await probeLocalModel(targets, fakeFetch({ "/health/liveliness": { status: 200 }, "/health": { status: 500 } }).fetcher)).toEqual({ ready: false, reason: "vLLM (http://127.0.0.1:8) answered 500" });
    const healthDown = await probeLocalModel(targets, fakeFetch({ "/health/liveliness": { status: 200 }, "/health": "refused" }).fetcher);
    expect(healthDown.ready).toBe(false);
    const onlyProxy = fakeFetch({ "/health/liveliness": { status: 200 } });
    expect(await probeLocalModel({ litellm: targets.litellm, vllm: null }, onlyProxy.fetcher)).toEqual({ ready: true });
    expect(onlyProxy.seen).toHaveLength(1);
  });

  test("the runner's probe asks nothing for a task that does not need the local model", async () => {
    const fake = fakeFetch({ "/health/liveliness": "refused" });
    const ready = backendReadiness({ [VLLM_URL_ENV]: targets.vllm }, fake.fetcher);
    expect(await ready(aTask({ backend: "claude" }))).toEqual({ ready: true });
    expect(fake.seen).toHaveLength(0);
    expect((await ready(aTask({ backend: "claude-local" }))).ready).toBe(false);
    expect(fake.seen).toHaveLength(1);
  });
});

/** Every source file Mind ships or runs: what the floor below reads. */
async function sources(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(path);
      } else if (/\.(ts|js|cjs|mjs|sh|py)$/.test(entry.name)) out.push(path);
    }
  };
  for (const top of ["src", "bin", "scripts", "docker"]) await walk(join(ROOT, top));
  return out;
}

/** A route spelled in code: `/sleep` or `/wake_up` — not `/is_sleeping` — or the bare words only vLLM's API has. */
const ROUTE = /\/(sleep|wake_up)\b|\bwake_up\b|\bsleep\?level/;
/** A request that is not a read, spelled as an option or as curl would. */
const WRITES = /method\s*[:=]\s*["'`](POST|PUT|PATCH|DELETE)["'`]|["'`]-X["'`]\s*,\s*["'`](POST|PUT|PATCH|DELETE)["'`]|-X\s+(POST|PUT|PATCH|DELETE)\b|\bvllm\w*\s*\.(post|put|patch|delete)\s*\(/i;
const TALKS_TO_VLLM = /10410|vllm/i;

/**
 * What the floor objects to in one source file's text. Comments are removed first — a line that starts with `*`,
 * `//`, `/*` or `#`, and a trailing `// …` only when the `//` follows whitespace, since `http://host/sleep` has a
 * `//` that begins nothing. String concatenation is joined (`"/sle" + "ep"`) before the route is looked for.
 */
export function sleepWakeFindings(source: string): string[] {
  const code = source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("#")) return "";
      return line.replace(/(^|\s)\/\/.*$/, "$1");
    })
    .join("\n")
    .replace(/["'`]\s*\+\s*["'`]/g, "");
  const found: string[] = [];
  const route = ROUTE.exec(code);
  if (route !== null) found.push(`names ${JSON.stringify(route[0])}`);
  // Anything that talks to vLLM at all may only read.
  if (TALKS_TO_VLLM.test(code)) {
    const write = WRITES.exec(code);
    if (write !== null) found.push(`writes (${JSON.stringify(write[0])}) in a file that talks to vLLM`);
  }
  return found;
}

describe("the floor: Mind never puts vLLM to sleep, never wakes it (S18.2 AC3)", () => {
  test("no source file outside comments names either route or writes to vLLM", async () => {
    const files = await sources();
    expect(files.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const file of files) for (const finding of sleepWakeFindings(await readFile(file, "utf8"))) found.push(`${file.slice(ROOT.length + 1)}: ${finding}`);
    expect(found).toEqual([]);
  });

  test("mutations: the floor sees each way of spelling it (reviewed 2026-10-06: a `//` in `http://` hid the rest of the line)", () => {
    const mutants: Record<string, string> = {
      "fetch with a url": 'await fetch("http://127.0.0.1:10410/sleep?level=1", { method: "POST" });',
      "a template url": "await fetch(`${vllm}/sleep?level=1`)",
      "wake_up in another file": 'const r = await post(base + "/wake_up");',
      "wake_up on an http line": 'fetch("http://x:1/wake_up", {});',
      "bare wake_up": 'const path = "wake_up";',
      "concatenated": 'fetch(base + "/sle" + "ep");',
      "concatenated, single quotes": "fetch(base + '/wake' + '_up');",
      "post with only the port": 'await fetch(`http://127.0.0.1:10410/anything`, { method: "POST" });',
      "post with a lower-case option": "await fetch(vllmUrl, { method: 'post' })",
      "post to vllm by name": 'const vllm = "x"; await fetch(vllm, { method : "PUT" });',
      "curl style": 'run(["curl", "-X", "POST", "http://127.0.0.1:10410/x"]);',
      "a client call": "await vllmClient.post(path);",
      "a real comment after code does not hide it": 'fetch(base + "/sleep") // sleep it',
    };
    for (const [name, text] of Object.entries(mutants)) expect(sleepWakeFindings(text).length, name).toBeGreaterThan(0);
  });

  test("and what is allowed passes: GETs, `/is_sleeping`, the words in comments, a POST to something else", () => {
    const fine = [
      'fetch(`${vllm}/is_sleeping`, { method: "GET" });',
      'get("http://127.0.0.1:10410/is_sleeping");',
      "// /sleep and /wake_up belong to media-gen",
      " * POST /sleep?level=1 is media-gen's",
      'await fetch("http://127.0.0.1:11435/api/chat", { method: "POST" });',
      'const link = "http://example.com"; // a `//` comment after whitespace is a comment',
    ];
    for (const text of fine) expect(sleepWakeFindings(text), text).toEqual([]);
  });

  test("the probe module itself only ever GETs", async () => {
    const text = await readFile(join(ROOT, "src", "task", "backend-ready.ts"), "utf8");
    expect(text).not.toMatch(/method:\s*"(POST|PUT|DELETE|PATCH)"/);
    expect(text).toMatch(/method:\s*"GET"/);
  });
});
