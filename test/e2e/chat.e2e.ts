/**
 * Chat, end to end, on a cloud vendor CLI (default `claude`, model `haiku`): the real `mind turn`, the real
 * `mind web` page API, the real ledger and proposals. Nothing is stubbed.
 *
 * Run with:
 *
 *     MIND_E2E_CHAT=1 bun run e2e:chat
 *
 * Named `.e2e.ts`, so a plain `bun test` (CI, `bun run coverage`) never discovers it. Without the variable every
 * case is skipped. With it, each case spends a real turn on the vendor, against the operator's own quota (a few
 * short `haiku` turns).
 *
 * Optional:
 *
 * - `MIND_E2E_CHAT_BACKEND` — the backend (default `claude`). Any cloud backend the engine reports reachable.
 * - `MIND_E2E_CHAT_MODEL` — handed to the turn as `--model` (default `haiku`; set to an empty string for the vendor's own default).
 *
 * ## What is isolated, and what is not
 *
 * The agent is made by `mind new` in a fresh temporary directory with a synthetic subject. Mind's state (ledger,
 * proposals, brake) lives under that directory: `XDG_STATE_HOME` and `XDG_DATA_HOME` point into it. The one thing
 * that is not temporary is the vendor's login, which lives under the operator's `HOME`, so the turns run with it
 * (the same bargain as `actions.e2e.ts`). Nothing in `~/.secrets` is read or written by this file.
 *
 * ## Cases
 *
 * 1. **cli-turn** — one chat turn: it exits 0, the answer carries a random token the prompt asked for, and the
 *    ledger gained a line.
 * 2. **web-auth** — `mind web` on loopback: no key is 401, the key is 200 on `/api/state`, an empty message is 400.
 * 3. **web-chat** — the same chat through `POST /api/turn`: the answer carries the token.
 * 4. **web-history** — what was said earlier in the chat goes with the next message (D-095): a word given in the
 *    history comes back in the answer.
 * 5. **propose-refuse** — at level 1 a request to write a file files a proposal and writes nothing; `proposal
 *    decide --refuse` records the refusal, and the proposal list shows it refused.
 * 6. **level-0** — at level 0 nothing is sent: exit 4, no ledger line.
 *
 * A backend that gives no answer at all FAILS the run with the vendor's own reason. It is not reported as a pass,
 * and later cases that need it are failed too, so a logged-out CLI cannot look like a green run.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backend as buildBackend } from "../../src/exec/index.ts";

const ENABLED = process.env["MIND_E2E_CHAT"] === "1";
const BACKEND = process.env["MIND_E2E_CHAT_BACKEND"] || "claude";
const MODEL = process.env["MIND_E2E_CHAT_MODEL"] ?? "haiku";
const SUBJECT = "e2e-chat";
const REFUSED = 4;
const TURN_MS = 300_000;

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const BUN = Bun.which("bun") ?? process.execPath;
const RUNNER_HOME = homedir();
/** Environment that belongs to whoever runs this file, not to the turns it starts. */
const DROPPED_ENV = ["MIND_", "CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_PID", "CLAUDE_EFFORT", "AI_AGENT", "XDG_STATE_HOME", "XDG_DATA_HOME"];

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface TurnJson {
  readonly backend: string;
  readonly text: string;
  readonly confidence: string;
  readonly changed: unknown;
  readonly proposals: readonly { readonly what: string; readonly id: string | null; readonly outcome: string }[];
}

interface Box {
  readonly root: string;
  readonly agent: string;
  readonly work: string;
  readonly env: Record<string, string>;
}

const scratch: string[] = [];
let box: Box | undefined;
/** Set by the first spending case when the vendor gave no answer: why. Later cases fail with it. */
let unavailable: string | undefined;

const token = (prefix: string): string => `${prefix}-${randomBytes(5).toString("hex")}`;

function childEnv(root: string): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || DROPPED_ENV.some((prefix) => name === prefix || name.startsWith(prefix))) continue;
    kept[name] = value;
  }
  return {
    ...kept,
    HOME: RUNNER_HOME,
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    MIND_QDRANT_URL: "http://127.0.0.1:9",
    MIND_CAPTURE: "off",
    NO_COLOR: "1",
  };
}

async function run(args: readonly string[]): Promise<Ran> {
  const b = await setUp();
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: b.work, env: b.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => child.kill("SIGKILL"), TURN_MS - 10_000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

let booting: Promise<Box> | undefined;
async function setUp(): Promise<Box> {
  if (box !== undefined) return box;
  booting ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-e2e-chat-"));
    scratch.push(root);
    for (const dir of [join(root, "agents"), join(root, "state"), join(root, "data"), join(root, "work")]) await mkdir(dir, { recursive: true, mode: 0o700 });
    const env = childEnv(root);
    const made = Bun.spawn([BUN, "run", BIN, "new", "e2e-agent", "--subject", SUBJECT, "--dir", join(root, "agents")], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [, err] = await Promise.all([new Response(made.stdout).text(), new Response(made.stderr).text()]);
    await made.exited;
    if (made.exitCode !== 0) throw new Error(`mind new failed (${made.exitCode}): ${err.slice(-400)}`);
    box = { root, agent: join(root, "agents", "e2e-agent"), work: join(root, "work"), env };
    return box;
  })();
  return booting;
}

async function dial(level: 0 | 1 | 2): Promise<void> {
  const b = await setUp();
  for (const category of ["write", "run", "reach"]) {
    const set = await run(["autonomy", "set", category, String(level), b.agent, "--subject", SUBJECT]);
    if (set.code !== 0) throw new Error(`autonomy set ${category} ${level} failed: ${set.stderr.slice(-300)}`);
  }
}

const modelFlags = (): string[] => (MODEL === "" ? [] : ["--model", MODEL]);

async function turn(prompt: string): Promise<{ ran: Ran; json: TurnJson | undefined }> {
  const b = await setUp();
  const ran = await run(["turn", b.agent, "--subject", SUBJECT, "--backend", BACKEND, "--prompt", prompt, "--json", ...modelFlags()]);
  try {
    return { ran, json: JSON.parse(ran.stdout) as TurnJson };
  } catch {
    return { ran, json: undefined };
  }
}

async function ledgerCount(): Promise<number> {
  const b = await setUp();
  const shown = await run(["ledger", "show", "--subject", SUBJECT, "--json"]);
  if (shown.code !== 0) throw new Error(`ledger show failed: ${shown.stderr.slice(-200)} ${b.agent}`);
  return ((JSON.parse(shown.stdout) as { entries?: { id?: string }[] }).entries ?? []).filter((e) => typeof e.id === "string").length;
}

const answered = (json: TurnJson | undefined): boolean => json !== undefined && (json.confidence === "confirmed" || json.confidence === "partial");

/** A spending case: fails with the vendor's reason if it never answered, rather than passing vacuously. */
function guard(json: TurnJson | undefined, ran: Ran): void {
  if (answered(json)) return;
  unavailable ??= `exit ${ran.code}: ${(ran.stderr || ran.stdout).slice(-300)}`;
  throw new Error(`${BACKEND} gave no answer — ${unavailable}`);
}

function stillAvailable(): void {
  if (unavailable !== undefined) throw new Error(`${BACKEND} is unavailable (first case): ${unavailable}`);
}

async function startWeb(): Promise<{ base: string; key: string; stop: () => void }> {
  const b = await setUp();
  // Off a terminal the page's key is never printed (D-162), so the test gives it one in a key file (600).
  const key = randomBytes(24).toString("hex");
  const keyFile = join(b.root, `web-${key.slice(0, 6)}.key`);
  await writeFile(keyFile, `${key}\n`, { mode: 0o600 });
  const args = ["web", b.agent, "--subject", SUBJECT, "--port", "0", "--key-file", keyFile, "--backend", BACKEND, ...modelFlags()];
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: b.work, env: b.env, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let seen = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`mind web ended: ${seen}`);
    seen += new TextDecoder().decode(value);
    const link = /(http:\/\/127\.0\.0\.1:\d+)\//.exec(seen);
    if (link !== null) return { base: link[1]!, key, stop: () => child.kill("SIGTERM") };
  }
}

describe.skipIf(!ENABLED)(`chat e2e — ${BACKEND}${MODEL === "" ? "" : ` (${MODEL})`}`, () => {
  let web: Awaited<ReturnType<typeof startWeb>> | undefined;

  afterAll(async () => {
    web?.stop();
    for (const dir of scratch) await rm(dir, { recursive: true, force: true });
  });

  test("backend is reachable", async () => {
    expect(Bun.which(BACKEND.replace(/-local$/, ""))).not.toBeNull();
    const available = await buildBackend(BACKEND as Parameters<typeof buildBackend>[0]).available();
    expect(available.ok, available.ok ? "" : available.detail).toBe(true);
  });

  test("cli-turn", async () => {
    await dial(1);
    const word = token("cli");
    const before = await ledgerCount();
    const { ran, json } = await turn(`Reply with exactly this token and nothing else: ${word}`);
    guard(json, ran);
    expect(ran.code, ran.stderr).toBe(0);
    expect(json!.backend).toBe(BACKEND);
    expect(json!.text).toContain(word);
    expect(await ledgerCount()).toBeGreaterThan(before);
  }, TURN_MS);

  test("web-auth", async () => {
    stillAvailable();
    web = await startWeb();
    const api = (path: string, init: { key?: string; body?: unknown } = {}) =>
      fetch(`${web!.base}${path}`, {
        method: init.body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...(init.key === undefined ? {} : { "x-mind-token": init.key }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    expect((await api("/api/state")).status).toBe(401);
    expect((await api("/api/state", { key: web.key })).status).toBe(200);
    expect((await api("/api/turn", { key: web.key, body: { prompt: "   " } })).status).toBe(400);
  }, TURN_MS);

  async function chat(prompt: string, history?: readonly { role: "you" | "agent"; text: string }[]): Promise<{ status: number; body: { text?: string; error?: string } }> {
    web ??= await startWeb();
    const res = await fetch(`${web.base}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mind-token": web.key },
      body: JSON.stringify({ prompt, ...(history === undefined ? {} : { history }) }),
    });
    return { status: res.status, body: (await res.json()) as { text?: string; error?: string } };
  }

  test("web-chat", async () => {
    stillAvailable();
    const word = token("web");
    const { status, body } = await chat(`Reply with exactly this token and nothing else: ${word}`);
    expect(body.error ?? "").toBe("");
    expect(status).toBe(200);
    expect(body.text ?? "").toContain(word);
  }, TURN_MS);

  test("web-history", async () => {
    stillAvailable();
    const secret = token("hist");
    const { status, body } = await chat("What is my secret word? Reply with the word only.", [
      { role: "you", text: `My secret word is ${secret}. Remember it.` },
      { role: "agent", text: "Understood." },
    ]);
    expect(body.error ?? "").toBe("");
    expect(status).toBe(200);
    expect(body.text ?? "").toContain(secret);
  }, TURN_MS);

  test("propose-refuse", async () => {
    stillAvailable();
    await dial(1);
    const b = await setUp();
    const file = `proposed-${randomBytes(3).toString("hex")}.txt`;
    const { ran, json } = await turn(`Create a new file named ${file} in the current working directory containing: hello. Do it now, then reply with the single word done.`);
    guard(json, ran);
    const filed = json!.proposals.filter((p) => p.outcome === "filed" && p.id !== null);
    expect(filed.length).toBeGreaterThan(0);
    expect(await readdir(b.work)).not.toContain(file);
    const id = filed[0]!.id!;

    const decided = await run(["proposal", "decide", id, b.agent, "--subject", SUBJECT, "--refuse", "--note", "e2e: refused on purpose"]);
    expect(decided.code, decided.stderr).toBe(0);
    const listed = await run(["proposal", "list", b.agent, "--subject", SUBJECT, "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    const record = JSON.stringify(JSON.parse(listed.stdout));
    expect(record).toContain(id);
    expect(record.toLowerCase()).toContain("refus");
    expect(await readdir(b.work)).not.toContain(file);
  }, TURN_MS);

  test("level-0", async () => {
    await dial(0);
    const before = await ledgerCount();
    const { ran } = await turn("Reply with the single word: blocked.");
    expect(ran.code).toBe(REFUSED);
    expect(ran.stderr).toContain("nothing was sent");
    expect(await ledgerCount()).toBe(before);
  }, TURN_MS);
});
