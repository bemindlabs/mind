/**
 * `mind web` — the HTTP side (D-060). A page on this machine that a person
 * uses instead of typing commands, and that can do only what those commands
 * can do.
 *
 * Every action is the CLI run as a child (`turn`, `proposal decide`, `proposal
 * triage`, `stop`), handed in as `run` — so the page gets the same refusals,
 * notices and records as the terminal, and no second way to do anything. What
 * stays in the terminal on purpose: raising a category to 3, consenting to
 * capture, releasing the brake, erase. Each needs a phrase typed by the person
 * it concerns, and a button would be the easy path around that.
 *
 * Guarded three ways, because a server on 127.0.0.1 is reachable from any page
 * the same browser opens: a random token in the URL, sent back on every call
 * in a header a cross-site form cannot set; a Host check against DNS
 * rebinding; and loopback by default.
 */

import { fontBytes } from "./fonts.ts";
import type { MemoryEntry, MemoryGraph, WhoHit } from "./memories.ts";
import type { ModelsState } from "./models.ts";
import { readProfile, type Profile } from "../soul/profile.ts";
import { memoryPathProblem } from "../memory/write.ts";
import { IMPORT_KINDS, MAX_SOURCE_BYTES, urlProblem } from "../memory/import.ts";
import { MAX_TAGS, withTags } from "../memory/tags.ts";
import type { AgentInfo, PrivacyState, SettingsState, ViewState } from "./view.ts";
import { isLocalBackend } from "./turninfo.ts";
import { modelProblem } from "../exec/registry.ts";
import { PAGE_HTML } from "./page.ts";
import { requestToken, TOKEN_HEADER } from "./token-header.ts";
import { encodeQr, qrPath } from "./qr.ts";
import { keyPrint, newKey } from "./key.ts";
import { ASK_ANSWER_MAX_CHARS, ASK_TIMEOUT_MS, askProblem, capAnswer } from "../memory/ask.ts";
import { timingSafeEqual } from "node:crypto";
import { answerCode, type Answer } from "../task/answer.ts";

export { TOKEN_HEADER };

export interface WebDeps {
  readonly state: () => Promise<ViewState>;
  readonly settings: () => Promise<SettingsState>;
  /** The backends and model names the chat's picker offers (D-085). */
  readonly models: () => Promise<ModelsState>;
  readonly agent: () => Promise<AgentInfo>;
  readonly memories: () => Promise<readonly MemoryEntry[]>;
  readonly memoryGraph: () => Promise<MemoryGraph>;
  /** What mentions a port, service, host, env name or path (D-092). */
  readonly memoryWho: (thing: string) => Promise<readonly WhoHit[]>;
  readonly memory: (path: string) => Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }>;
  readonly privacy: () => Promise<PrivacyState>;
  /** `memory write` with this text for this path — handed over as a file that lives only for the call. */
  readonly memoryWrite: (path: string, content: string) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  /** `memory import` of an uploaded file or a web link — a plan unless `write` (D-084). */
  readonly memoryImport: (
    source: { readonly kind: "file"; readonly name: string; readonly bytes: Uint8Array } | { readonly kind: "url"; readonly url: string },
    write: boolean,
  ) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  /** One ledger line, asked and answered, or undefined. */
  readonly turnDetail: (id: string) => Promise<{ readonly asked: string | null; readonly answer: string | null; readonly backend: string; readonly model: string | null; readonly modelRequested: string | null; readonly when: string; readonly content: string } | undefined>;
  /** The soul on every axis, or why it does not load. */
  readonly profile: () => Promise<{ readonly ok: true; readonly profile: Profile } | { readonly ok: false; readonly reason: string }>;
  /** `soul edit` with this profile — a dry run unless `write`. */
  readonly editProfile: (profile: Profile, write: boolean) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
  /**
   * Run this engine with arguments; the result of the child. With `timeoutMs`, a child still running then is sent
   * SIGTERM and the result says `timedOut` — and it resolves only once that child has exited (D-152's ask is the
   * one route that asks for it).
   */
  readonly run: (
    args: readonly string[],
    options?: { readonly timeoutMs?: number },
  ) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean }>;
  /**
   * S14.3 (D-130): the phones that asked to be told something is waiting. Absent on a page that does not offer
   * it; the routes then answer 404.
   */
  readonly push?: {
    /** `key` is the {@link keyPrint} of the key the request came with: the subscription belongs to it. */
    readonly subscribe: (relay: string, handle: string, key: string) => Promise<{ readonly ok: true; readonly count: number } | { readonly ok: false; readonly reason: string }>;
    readonly unsubscribe: (handle: string) => Promise<boolean>;
    readonly count: (key: string) => Promise<number>;
    /** The subscriptions made under this key dropped, each relay asked to forget; how many there were. */
    readonly clear: (key: string) => Promise<number>;
  };
  /**
   * D-154: the newest screenshot a task's browser took, as a data URL — or why there is none. Absent on a page
   * that does not offer it; the route then answers 404.
   */
  /** D-156: the owner's answer to a held action (`answerHeld`), from this page. Absent: the route answers 404. */
  readonly taskAnswer?: (task: string, approval: string, verdict: "approve" | "deny", stop: boolean) => Promise<Answer>;
  readonly taskScreen?: (task: string) => Promise<{ readonly ok: true; readonly image: string; readonly at: string } | { readonly ok: false; readonly reason: string }>;
  /** The agent directory and subject every action is about. */
  readonly dir: string;
  readonly subject: string;
  readonly turnFlags?: readonly string[];
}

export interface WebServer {
  /** The link as it is now — a key changed from the page (S14.2) changes it. */
  readonly url: string;
  readonly token: string;
  /**
   * Stop listening. Gently (the default) lets requests already running finish first — an import or a turn a
   * restart would otherwise cut off after its file was written but before the page heard back — and resolves
   * when they have. `force` closes every connection now.
   */
  readonly stop: (force?: boolean) => Promise<void>;
  /** Requests being answered right now. */
  readonly pending: () => number;
}

const ID = /^[0-9a-f-]{8,64}$/;
const TASK_ID = /^t-[0-9a-f]{8}$/;
const APPROVAL_ID = /^a-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A child's stdout as JSON, or undefined. */
function parsed(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `task new`'s flags from a page's request (D-154), or what is wrong with it. Nothing passes unchecked. */
export function taskNewArgs(body: Record<string, unknown>): { readonly ok: true; readonly args: string[] } | { readonly ok: false; readonly error: string } {
  const goal = typeof body["goal"] === "string" ? body["goal"].trim() : "";
  if (goal === "" || goal.length > 4000) return { ok: false, error: "write the goal first (at most 4000 characters)" };
  if (goal.startsWith("-")) return { ok: false, error: "a goal cannot start with a dash" };
  const args = ["--goal", goal];
  const whole = (key: string, flag: string, max: number): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) return `${key} is a whole number from 1 to ${max}`;
    args.push(flag, String(value));
    return undefined;
  };
  for (const [key, flag, max] of [["budgetTurns", "--budget-turns", 200], ["budgetMinutes", "--budget-minutes", 1440], ["budgetTokens", "--budget-tokens", 1_000_000_000], ["approveWithin", "--approve-within", 60]] as const) {
    const problem = whole(key, flag, max);
    if (problem !== undefined) return { ok: false, error: problem };
  }
  const operate = body["operate"];
  if (operate !== undefined && operate !== 0 && operate !== 1 && operate !== 2) return { ok: false, error: "operate is 0, 1 or 2" };
  if (operate !== undefined) args.push("--operate", String(operate));
  const allow = body["allow"];
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.length > 32 || !allow.every((a) => typeof a === "string" && /^https?:\/\/[^\s,]{1,200}$/.test(a))) {
      return { ok: false, error: "allow is a list of origins like https://example.com" };
    }
    for (const origin of allow) args.push("--allow", origin as string);
  }
  if (body["backend"] !== undefined && body["backend"] !== null && body["backend"] !== "") {
    if (typeof body["backend"] !== "string" || !BACKEND_CHAIN.test(body["backend"])) return { ok: false, error: "that is not a backend" };
    args.push("--backend", body["backend"]);
  }
  if (body["model"] !== undefined && body["model"] !== null && body["model"] !== "") {
    if (!isModel(body["model"])) return { ok: false, error: "that is not a model name" };
    args.push("--model", body["model"]);
  }
  return { ok: true, args };
}
const CATEGORIES = ["read", "write", "run", "reach", "operate"];
/**
 * A backend chain as `turn --backend` takes it, and a model name — nothing a shell or a flag could be smuggled
 * in. The model's rule is the engine's own (`modelProblem`, D-142), so the page can name exactly what `turn`
 * would hand a CLI — `opus[1m]` included — and nothing it would refuse.
 */
const BACKEND_CHAIN = /^[a-z][a-z0-9-]{0,20}(,[a-z][a-z0-9-]{0,20}){0,5}$/;
const isModel = (value: unknown): value is string => typeof value === "string" && modelProblem(value) === undefined;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/** The Host values this server answers to, and nothing else (DNS rebinding). */
export function allowedHosts(hostname: string, port: number, extra: readonly string[] = []): readonly string[] {
  const names = hostname === "127.0.0.1" || hostname === "localhost" ? ["127.0.0.1", "localhost"] : [hostname];
  return [...new Set([...names, ...extra.map((n) => n.toLowerCase())])].map((n) => `${n}:${port}`);
}

/**
 * This machine's names on a tailnet, from `tailscale status --self --json`:
 * the MagicDNS name and its first label. A page bound to the tailnet address
 * answers to them too — they point at the same address, and a person types
 * the name, not the number.
 */
export function tailnetNames(statusJson: string): readonly string[] {
  try {
    const dns = (JSON.parse(statusJson) as { Self?: { DNSName?: unknown } }).Self?.DNSName;
    if (typeof dns !== "string" || dns === "") return [];
    const full = dns.replace(/\.$/, "").toLowerCase();
    const short = full.split(".")[0]!;
    return short === full ? [full] : [full, short];
  } catch {
    return [];
  }
}

/**
 * What recall attached to a turn, as `turn --json` reports it — so the app can show an answer's sources.
 * Only its shape passes, field by field: paths, headings, sizes and how each was found; never the text.
 */
export function recallOf(value: unknown): {
  readonly chars: number;
  readonly ceiling: number;
  readonly skipped: number;
  readonly attached: readonly { readonly path: string; readonly heading: string; readonly chars: number; readonly via: readonly string[] }[];
} | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const text = (v: unknown): string => (typeof v === "string" ? v.slice(0, 500) : "");
  const attached = (Array.isArray(r["attached"]) ? r["attached"] : [])
    .slice(0, 50)
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null && typeof (a as Record<string, unknown>)["path"] === "string")
    .map((a) => ({
      path: text(a["path"]),
      heading: text(a["heading"]),
      chars: count(a["chars"]),
      via: (Array.isArray(a["via"]) ? a["via"] : []).filter((v): v is string => v === "fts" || v === "vector"),
    }));
  return { chars: count(r["chars"]), ceiling: count(r["ceiling"]), skipped: count(r["skipped"]), attached };
}

/**
 * What `memory ask --json` printed, as `/api/memory-ask` answers it (D-152): `{ok, answer, sources, found, backend,
 * model}` and beside them `local`, `held`, `pieces` (the excerpts behind "show the pieces it read") and `searched`.
 * Field by field, so nothing but these shapes passes: the answer cut at {@link ASK_ANSWER_MAX_CHARS} whatever the
 * child printed, sources deduplicated by path and section. A child that printed no JSON is an error with its last
 * lines.
 */
export function askAnswer(stdout: string, code: number, notes: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: notes || `it did not answer (exit ${code})` };
  const r = parsed as Record<string, unknown>;
  const text = (v: unknown, max = 500): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const list = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).slice(0, 50).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && typeof (x as Record<string, unknown>)["path"] === "string");
  const optional = (name: string, v: unknown) => (text(v) === undefined || text(v) === "" ? {} : { [name]: text(v) });
  const seen = new Set<string>();
  const sources = list(r["sources"])
    .map((src) => ({ path: text(src["path"])!, ...optional("title", src["title"]), ...optional("section", src["section"]) }))
    .filter((src) => {
      const id = `${src.path}\0${(src as { section?: string }).section ?? ""}`;
      return seen.has(id) ? false : (seen.add(id), true);
    });
  const ok = code === 0 && r["ok"] === true;
  return {
    ok,
    answer: typeof r["answer"] === "string" ? capAnswer(r["answer"]) : "",
    sources,
    found: count(r["found"]),
    backend: text(r["backend"]) ?? null,
    model: text(r["model"]) ?? null,
    local: r["local"] === true,
    held: count(r["held"]),
    pieces: list(r["pieces"]).map((p) => ({ path: text(p["path"])!, ...optional("section", p["section"]), excerpt: text(p["excerpt"], 300) ?? "" })),
    searched: r["searched"] !== false,
    ...(ok ? {} : { error: text(r["error"], 1000) || notes || `it did not answer (exit ${code})` }),
  };
}

/** Last lines of a child's stderr, for a message a person can read. */
function said(stderr: string): string {
  return stderr
    .split("\n")
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").replace(/^mind:\s*/, "").trim())
    .filter((l) => l !== "")
    .slice(-4)
    .join("\n");
}

/**
 * D-093: a distill run takes minutes (a local model reading each piece), longer than a request should be
 * held open, so the page starts it and asks after it. Kept here, per agent, because a handler is made for
 * each request.
 */
const distilling = new Map<string, { since: string; finished?: { ok: boolean; message: string } }>();
/**
 * D-144: the approved proposals whose turn is running now, per agent. Kept here for the same reason: a handler
 * is made for each request, and two requests for one proposal are two handlers.
 */
const turning = new Set<string>();
/** D-144 §2: the spent approvals being filed again now, per agent — one refile per id at a time. */
const refiling = new Set<string>();
/**
 * D-152: the agents with an ask running now. One at a time per agent: an ask is a model call — minutes of a local
 * GPU at worst — and a page or an app that sent one per keystroke must not start a process per keystroke. The
 * mark is held until the child has exited, not until the asker stops waiting: a phone that gave up (or lost its
 * connection) leaves its ask running here, and the next ask is told so rather than started beside it.
 */
const asking = new Set<string>();
/** What an ask for an agent already answering one is told — with 409, and without a CLI started. */
export const ASK_BUSY = "Already answering a question from this agent's memory — wait for that answer, then ask again.";
/**
 * How long `/api/memory-ask` waits for its child before ending it. The CLI holds its own model step to
 * {@link ASK_TIMEOUT_MS} (sized for a model on this machine — see there); this is that plus a minute for recall,
 * which may embed the question with a model that has to load first. Past it the child gets SIGTERM, which it
 * answers by ending its backend's process group, and the page is told it took too long.
 */
export const MEMORY_ASK_TIMEOUT_MS = ASK_TIMEOUT_MS + 60_000;
/** A proposal id as Mind mints them. Filing again takes nothing looser: the id is the whole request. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What a second turn for a proposal already running is told — with 409, and without a CLI started. */
export const ALREADY_RUNNING =
  "Already running — this approved suggestion's turn has not finished yet. It runs once, so nothing more was started.";
/** A place in memory to read from: memory/ or a folder or file under it, nothing that climbs out. */
const MEMORY_PLACE = /^memory(?:\/[A-Za-z0-9._-]+)*$/;

/** The page's key, compared in constant time: a phone now holds it too, over a network (S14.2). */
export function sameToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The link a phone pairs with, for the address the page was opened at (S14.2): the
 * browser knows the address people reach it by (behind `tailscale serve` the page
 * does not), so it says; only a scheme and a host this page answers to are taken.
 */
export function pairingLink(origin: string, token: string, hosts: readonly string[]): string | undefined {
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin) return undefined;
  const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
  if (!hosts.includes(`${url.hostname}:${port}`)) return undefined;
  return `${origin}/#t=${token}`;
}

/** Changing the page's key from the page (S14.2 AC3) — given only by `startWeb`, which holds the key. */
export interface KeyControl {
  readonly rotate: () => Promise<{ readonly ok: true; readonly key: string } | { readonly ok: false; readonly reason: string }>;
}

/**
 * The page's content policy (WEB-05). The one-file page needs inline script and style, so those stay; what it never
 * needs it forbids: a `<base>` that would re-aim its relative links, and a form that posts anywhere (it has none).
 */
export const PAGE_CSP =
  "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Every answer says what it is and asks the browser not to guess otherwise (WEB-05): a JSON body is never run as a page. */
const nosniff = (res: Response): Response => {
  res.headers.set("x-content-type-options", "nosniff");
  return res;
};

export function handler(deps: WebDeps, token: string, hosts: readonly string[], keys?: KeyControl) {
  const place = [deps.dir, "--subject", deps.subject];
  const route = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!hosts.includes(req.headers.get("host") ?? "")) return new Response("wrong host", { status: 421 });

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(PAGE_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": PAGE_CSP,
          "referrer-policy": "no-referrer",
        },
      });
    }
    // D-083: the page's fonts, from inside the binary. Nothing in them is the agent's, so no token.
    const font = /^\/fonts\/([a-z0-9-]+)\.woff2$/.exec(url.pathname);
    if (req.method === "GET" && font !== null) {
      const bytes = fontBytes(font[1]!);
      if (bytes !== undefined) return new Response(bytes, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
    }
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    if (!sameToken(requestToken(req.headers), token)) return json({ error: "this page's link has expired — open the address `mind web` printed" }, 401);

    if (req.method === "POST" && url.pathname === "/api/pair/rotate") {
      if (keys === undefined) return json({ error: "this page cannot change its key" }, 404);
      const body = (await req.json().catch(() => ({}))) as { origin?: unknown };
      const oldPrint = keyPrint(token);
      const changed = await keys.rotate();
      if (!changed.ok) return json({ error: `the key was not changed: ${changed.reason}` }, 500);
      // A phone unpaired is a phone no longer told anything (D-130). The key has changed whatever happens here, so
      // a failure is said, not thrown: the tab keeps its new key, and the old key's phones are inert anyway —
      // only subscriptions made under the key a page holds are ever told.
      let unsubscribed = 0;
      let warning: string | undefined;
      try {
        unsubscribed = deps.push === undefined ? 0 : await deps.push.clear(oldPrint);
      } catch (error) {
        warning = `the key changed, but the phones paired with the old key could not be dropped here (${(error as NodeJS.ErrnoException).code ?? "error"}); they are no longer told anything`;
      }
      const link = typeof body.origin === "string" ? pairingLink(body.origin, changed.key, hosts) : undefined;
      return json({ ok: true, token: changed.key, unsubscribed, ...(warning === undefined ? {} : { warning }), ...(link === undefined ? {} : { link }) });
    }
    if (url.pathname === "/api/push" || url.pathname === "/api/push/subscribe" || url.pathname === "/api/push/unsubscribe") {
      if (deps.push === undefined) return json({ error: "this page does not send notifications" }, 404);
      if (req.method === "GET" && url.pathname === "/api/push") return json({ count: await deps.push.count(keyPrint(token)) });
      if (req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { relay?: unknown; handle?: unknown };
        if (typeof body.handle !== "string") return json({ error: "a handle is required" }, 400);
        if (url.pathname === "/api/push/unsubscribe") return json({ ok: true, removed: await deps.push.unsubscribe(body.handle) });
        if (url.pathname === "/api/push/subscribe") {
          if (typeof body.relay !== "string") return json({ error: "a relay is required" }, 400);
          const added = await deps.push.subscribe(body.relay, body.handle, keyPrint(token));
          return added.ok ? json({ ok: true, count: added.count }) : json({ error: added.reason }, 400);
        }
      }
      return json({ error: "not found" }, 404);
    }
    if (req.method === "GET" && url.pathname === "/api/pair") {
      const link = pairingLink(url.searchParams.get("origin") ?? "", token, hosts);
      if (link === undefined) return json({ error: "that is not an address this page answers to" }, 400);
      const modules = encodeQr(link, "M");
      if (modules === null) return json({ error: "the link is too long for a code — pair by pasting it" }, 400);
      return json({ link, code: qrPath(modules) });
    }
    if (req.method === "GET" && url.pathname === "/api/state") return json(await deps.state());
    if (req.method === "GET" && url.pathname === "/api/settings") return json(await deps.settings());
    if (req.method === "GET" && url.pathname === "/api/models") return json(await deps.models());
    if (req.method === "GET" && url.pathname === "/api/agent") return json(await deps.agent());
    if (req.method === "GET" && url.pathname === "/api/profile") return json(await deps.profile());
    if (req.method === "GET" && url.pathname === "/api/privacy") return json(await deps.privacy());
    if (req.method === "GET" && url.pathname === "/api/persona") {
      const out = await deps.run(["persona", "show", "--subject", deps.subject, "--json"]);
      try {
        return json(JSON.parse(out.stdout));
      } catch {
        return json({ draft: null, reason: said(out.stderr) || "no draft" });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/turn-detail") {
      const tid = url.searchParams.get("id") ?? "";
      const found = ID.test(tid) ? await deps.turnDetail(tid) : undefined;
      return found === undefined ? json({ error: "no such turn" }, 404) : json(found);
    }
    if (req.method === "GET" && url.pathname === "/api/memories") return json(await deps.memories());
    if (req.method === "GET" && url.pathname === "/api/memories/graph") return json(await deps.memoryGraph());
    if (req.method === "GET" && url.pathname === "/api/distill") {
      const out = await deps.run(["memory", "distill", "show", "--subject", deps.subject, "--json"]);
      let shown: unknown = { draft: null };
      try {
        shown = JSON.parse(out.stdout);
      } catch {
        // No draft to show.
      }
      return json({ ...(shown as object), run: distilling.get(`${deps.dir}\0${deps.subject}`) ?? null });
    }
    if (req.method === "GET" && url.pathname === "/api/memory/who") {
      const thing = (url.searchParams.get("q") ?? "").trim();
      if (thing === "" || thing.length > 200) return json({ error: "ask about a port, a service, a host, an env name or a path" }, 400);
      return json(await deps.memoryWho(thing));
    }
    if (req.method === "GET" && url.pathname === "/api/memory") {
      const read = await deps.memory(url.searchParams.get("path") ?? "");
      return read.ok ? json({ text: read.text }) : json({ error: read.reason }, 404);
    }
    // D-154 — tasks, through the same commands a person types (D-086): the list, one task, its newest screenshot.
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      const out = await deps.run(["task", "list", ...place, "--json"]);
      const listed = parsed(out.stdout);
      return listed === undefined ? json({ error: said(out.stderr) || "the tasks could not be read" }, 500) : json(listed);
    }
    const oneTask = /^\/api\/tasks\/([^/]+)(\/screen)?$/.exec(url.pathname);
    if (req.method === "GET" && oneTask !== null) {
      const id = oneTask[1]!;
      if (!TASK_ID.test(id)) return json({ error: "that is not a task id" }, 400);
      if (oneTask[2] !== undefined) {
        if (deps.taskScreen === undefined) return json({ error: "not found" }, 404);
        const screen = await deps.taskScreen(id);
        return screen.ok ? json(screen) : json({ error: screen.reason }, 404);
      }
      const out = await deps.run(["task", "show", id, ...place, "--json"]);
      const shown = parsed(out.stdout);
      return shown === undefined ? json({ error: said(out.stderr) || "no such task" }, out.code === 2 ? 404 : 500) : json(shown);
    }
    if (req.method !== "POST") return json({ error: "not allowed" }, 405);

    let body: Record<string, unknown> = {};
    try {
      body = ((await req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      // An empty body is fine for the actions that take none.
    }

    // D-154 — a new task, started in the background; the page follows it with GET /api/tasks/<id>. Every field is
    // shape-checked here and again by `task new`, which refuses what a person typing it would be refused.
    if (url.pathname === "/api/tasks") {
      const args = taskNewArgs(body);
      if (!args.ok) return json({ ok: false, error: args.error }, 400);
      const out = await deps.run(["task", "new", ...place, ...args.args, "--detach", "--json", "--via", "web"]);
      const started = parsed(out.stdout);
      if (out.code !== 0 || started === undefined) return json({ ok: false, error: said(out.stderr) || `it did not start (exit ${out.code})` }, out.code === 2 ? 400 : out.code === 4 ? 409 : 500);
      return json(started);
    }
    // D-156 — the owner's answer to one held action, in this process, behind this page's key. Not through the
    // CLI: `task approve|deny` answers only at a terminal (review of PR #24), so no script can borrow it.
    const answer = /^\/api\/tasks\/([^/]+)\/approvals\/([^/]+)\/(approve|deny)$/.exec(url.pathname);
    if (answer !== null) {
      const [, id, approval, verdict] = answer;
      if (!TASK_ID.test(id!) || !APPROVAL_ID.test(approval!)) return json({ ok: false, error: "that is not a task or an approval id" }, 400);
      if (deps.taskAnswer === undefined) return json({ error: "not found" }, 404);
      const out = await deps.taskAnswer(id!, approval!, verdict as "approve" | "deny", verdict === "deny" && body["stop"] === true);
      return json(out.ok ? { ok: true, approval: out.approval } : { ok: false, kind: out.kind, reason: out.reason }, answerCode(out).status);
    }
    const control = /^\/api\/tasks\/([^/]+)\/(stop|resume)$/.exec(url.pathname);
    if (control !== null) {
      const [, id, action] = control;
      if (!TASK_ID.test(id!)) return json({ ok: false, error: "that is not a task id" }, 400);
      const out = await deps.run(action === "stop" ? ["task", "stop", id!, ...place, "--json"] : ["task", "resume", id!, ...place, "--detach"]);
      return json({ ok: out.code === 0, message: said(out.stderr) || said(out.stdout) }, out.code === 0 ? 200 : out.code === 2 ? 404 : 409);
    }

    if (url.pathname === "/api/turn") {
      // A proposal id that is not one is refused, not dropped: dropped, the same prompt would run as an ordinary
      // turn — the approved action, with no approval behind it (D-144 review). Absent or null is no proposal.
      const named = body["proposal"];
      if (named !== undefined && named !== null && (typeof named !== "string" || !ID.test(named))) {
        return json({ ok: false, error: "that is not a proposal id — nothing was run" }, 400);
      }
      const proposal = typeof named === "string" ? named : undefined;
      // D-153: under an approval the turn runs the approved action, built from its record by id. Whatever text
      // the page or the app sent with it is not passed on — the id is the whole request.
      const prompt = proposal !== undefined ? "" : typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
      if (proposal === undefined && (prompt === "" || prompt.length > 20_000)) return json({ error: "write a message first" }, 400);
      // The page may name a backend and a model (Settings); anything that is not
      // one is ignored and the flags `mind web` was started with apply.
      const backend = typeof body["backend"] === "string" && BACKEND_CHAIN.test(body["backend"]) ? body["backend"] : undefined;
      const model = isModel(body["model"]) ? body["model"] : undefined;
      // What the page names replaces what `mind web` was started with (D-085). A model belongs to its
      // backend: a model alone keeps the started backend, but a backend alone drops the started model —
      // `claude --model qwen3.8:27b` is a turn that cannot answer.
      const started = deps.turnFlags ?? [];
      const startedWith = (flag: string) => (started.indexOf(flag) >= 0 ? started[started.indexOf(flag) + 1] : undefined);
      const useBackend = backend ?? startedWith("--backend");
      const useModel = model ?? (backend === undefined ? startedWith("--model") : undefined);
      const flags = [...(useBackend === undefined ? [] : ["--backend", useBackend]), ...(useModel === undefined ? [] : ["--model", useModel])];
      // D-095: the last exchanges of this chat, so a turn is not alone. Shape-checked here; `turn` checks again.
      const rawHistory = body["history"];
      // Not under an approval: an approved action runs with no conversation added (D-153).
      const history = proposal === undefined && Array.isArray(rawHistory)
        ? rawHistory
            .slice(-12)
            .filter((m): m is { role: "you" | "agent"; text: string } => typeof m === "object" && m !== null && (m.role === "you" || m.role === "agent") && typeof m.text === "string")
            .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }))
        : [];
      const args = ["turn", ...place, ...(proposal === undefined ? ["--prompt", prompt] : []), "--json", ...flags, ...(history.length > 0 ? ["--history-json", JSON.stringify(history)] : [])];
      if (proposal !== undefined) args.push("--proposal", proposal);
      // D-144 — one turn per approved proposal at a time. A second tap on "Do it now", or the app's "Run now"
      // while the page's is running, is answered here and starts nothing. `turn` itself would refuse it too — the
      // approval is claimed once, across processes — but only after a process was started to say so. Checked and
      // taken with no `await` between, so two requests cannot both find it free.
      const running = proposal === undefined ? undefined : `${deps.dir}\0${deps.subject}\0${proposal}`;
      if (running !== undefined) {
        if (turning.has(running)) return json({ ok: false, error: ALREADY_RUNNING }, 409);
        turning.add(running);
      }
      let out: Awaited<ReturnType<WebDeps["run"]>>;
      try {
        out = await deps.run(args);
      } finally {
        if (running !== undefined) turning.delete(running);
      }
      let answer: Record<string, unknown> | undefined;
      try {
        answer = JSON.parse(out.stdout) as Record<string, unknown>;
      } catch {
        answer = undefined;
      }
      if (answer === undefined) return json({ ok: false, error: said(out.stderr) || `it did not answer (exit ${out.code})` }, 200);
      // S12.4 — who handled the turn. `local` is derived here from the backend
      // id by the one rule (`src/web/turninfo.ts`), so the badge stays right
      // even for a child that predates the field; the held counts and the
      // change report pass through only as numbers/objects, never as HTML.
      const answeredBy = typeof answer["backend"] === "string" ? answer["backend"] : "";
      const text = typeof answer["text"] === "string" ? answer["text"] : "";
      // D-149: the turn's own notes first (`--json` carries them), then the tail of stderr, each said once.
      const fromStderr = said(out.stderr);
      const told = Array.isArray(answer["notes"]) ? answer["notes"].filter((n): n is string => typeof n === "string") : [];
      const notes = [...told.filter((n) => !fromStderr.includes(n)), fromStderr].filter((n) => n !== "").join("\n");
      return json({
        ok: out.code === 0,
        // D-144: a turn under an approval that failed with nothing to show says why, as the error — its last line
        // is what became of the approval, and a page or an app that showed "(no answer)" would lose it.
        ...(out.code !== 0 && proposal !== undefined && text === "" ? { error: notes || `it did not answer (exit ${out.code})` } : {}),
        text,
        route: answer["route"] ?? "",
        backend: answeredBy,
        local: answeredBy === "" ? false : isLocalBackend(answeredBy),
        // D-142: what the backend ran, and apart from it what it was asked for — the page labels the second as asked.
        model: typeof answer["model"] === "string" ? answer["model"] : null,
        modelRequested: typeof answer["model_requested"] === "string" ? answer["model_requested"] : null,
        held: typeof answer["held"] === "number" ? answer["held"] : 0,
        heldMessages: typeof answer["heldMessages"] === "number" ? answer["heldMessages"] : 0,
        changed: answer["changed"] ?? null,
        proposals: answer["proposals"] ?? [],
        recall: recallOf(answer["recall"]),
        notes,
      });
    }

    // D-144 §2 (the owner, 2026-09-29): "File it again" — a spent approval whose turn sent nothing, filed again
    // as a new proposal waiting for a new yes. `proposal new --refile`: the command rebuilds what, why and impact
    // from the stored record by id and refuses every other kind of proposal; nothing is taken from the body, and
    // nothing is approved or run. One at a time per id, the way turns are. The same route serves "File it again
    // for a yes" (D-153 follow-up): an approval given before approvals named their action, which no turn runs.
    const refile = /^\/api\/proposals\/([^/]+)\/refile$/.exec(url.pathname);
    if (refile !== null) {
      const id = refile[1]!;
      if (!UUID.test(id)) return json({ ok: false, message: "that is not a proposal id — nothing was filed" }, 400);
      const key = `${deps.dir}\0${deps.subject}\0${id}`;
      if (refiling.has(key)) return json({ ok: false, message: "It is being filed again already." }, 409);
      refiling.add(key);
      let out: Awaited<ReturnType<WebDeps["run"]>>;
      try {
        out = await deps.run(["proposal", "new", ...place, "--refile", id]);
      } finally {
        refiling.delete(key);
      }
      const message = said(out.stderr);
      // 2: no such proposal · 4: neither sent-nothing nor from before D-153 · 5: filed again already, or a twin is waiting.
      if (out.code === 0) return json({ ok: true, id: out.stdout.trim(), message });
      return json({ ok: false, message }, out.code === 2 ? 404 : out.code === 4 || out.code === 5 ? 409 : 500);
    }

    const decide = /^\/api\/proposals\/([0-9a-f-]+)\/(approve|refuse|triage)$/.exec(url.pathname);
    if (decide !== null && ID.test(decide[1]!)) {
      const [, id, action] = decide;
      const args =
        action === "triage"
          ? ["proposal", "triage", id!, ...place]
          : ["proposal", "decide", id!, ...place, action === "approve" ? "--approve" : "--refuse"];
      const note = typeof body["note"] === "string" ? body["note"].trim().slice(0, 500) : "";
      if (action !== "triage" && note !== "") args.push("--note", note);
      const out = await deps.run(args);
      return json({ ok: out.code === 0, message: said(out.stderr) || said(out.stdout) });
    }

    // Settings. Each is the command a person would type; the page adds nothing.
    if (url.pathname === "/api/autonomy") {
      const category = body["category"];
      const level = body["level"];
      if (typeof category !== "string" || !CATEGORIES.includes(category)) return json({ error: "no such category" }, 400);
      // 3 is typed at a terminal (D-042); the child would refuse it anyway, and
      // the page should not even look like a way to try.
      if (level !== 0 && level !== 1 && level !== 2) return json({ error: "the page sets 0, 1 or 2 — a 3 is typed in a terminal" }, 400);
      const out = await deps.run(["autonomy", "set", category, String(level), ...place]);
      return json({ ok: out.code === 0, message: said(out.stderr) || said(out.stdout) });
    }
    if (url.pathname === "/api/chat-users/remove") {
      const platform = body["platform"];
      const userId = body["userId"];
      if (typeof platform !== "string" || !/^[a-z]{1,20}$/.test(platform) || typeof userId !== "string" || !/^[1-9]\d{0,15}$/.test(userId)) return json({ error: "no such person" }, 400);
      const out = await deps.run(["chat", "remove", platform, userId, "--subject", deps.subject]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    if (url.pathname === "/api/peers/remove") {
      const name = body["name"];
      if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return json({ error: "no such peer" }, 400);
      const out = await deps.run(["a2a", "remove", name, "--subject", deps.subject]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    // D-074: the Profile wizard. `soul edit` checks the result loads — the
    // firewall included — and writes only when asked to.
    if (url.pathname === "/api/profile") {
      const read = readProfile(body["profile"]);
      if (!read.ok) return json({ ok: false, message: read.problems.join("\n") }, 400);
      const out = await deps.editProfile(read.profile, body["write"] === true);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr), problems: out.code === 0 ? "" : said(out.stderr) });
    }
    // Search by meaning is `memory search`: both indexes, each hit saying which found it.
    if (url.pathname === "/api/memory-search") {
      // Leading dashes and the spaces between them off, all of them: a query is words, never a flag. (`-- --subject x`
      // used to lose only its first dashes, and `--subject x` is an option to the command it is the last word of, WEB-06.)
      const query = typeof body["query"] === "string" ? body["query"].replace(/^[\s-]+/, "").trim() : "";
      if (query === "" || query.length > 500) return json({ error: "type what to look for" }, 400);
      const scope = body["scope"] === "memory" || body["scope"] === "knowledge" ? body["scope"] : "all";
      const out = await deps.run(["memory", "search", ...place, "--limit", "8", "--scope", scope, query]);
      // `searched: false` is exit 3 — neither index could be asked — so "nothing found" is never said of a search that did not run.
      return json({ ok: out.code === 0, searched: out.code !== 3, text: out.stdout.trim(), message: said(out.stderr) });
    }
    // D-152: a question answered from memory — a summary and its sources, never the files pasted back. `memory ask`
    // does the work (read-only on every backend, routed, screened and recorded as a turn is); this checks the body,
    // keeps one ask per agent at a time, and holds the child to a deadline.
    if (url.pathname === "/api/memory-ask") {
      const raw = body["question"];
      if (typeof raw !== "string") return json({ ok: false, error: "ask a question" }, 400);
      const question = raw.trim();
      const problem = askProblem(question);
      if (problem !== undefined) return json({ ok: false, error: problem }, 400);
      const rawScope = body["scope"];
      if (rawScope !== undefined && rawScope !== null && rawScope !== "all" && rawScope !== "memory" && rawScope !== "knowledge") {
        return json({ ok: false, error: "scope is all, memory or knowledge" }, 400);
      }
      const scope = typeof rawScope === "string" ? rawScope : "all";
      // Checked and taken with no `await` between, so two requests cannot both find it free.
      const key = `${deps.dir}\0${deps.subject}`;
      if (asking.has(key)) return json({ ok: false, error: ASK_BUSY }, 409);
      asking.add(key);
      let out: Awaited<ReturnType<WebDeps["run"]>>;
      try {
        // The flags `mind web` was started with choose who answers, as they do for a turn (D-085). The question
        // goes after `--`, word for word: one that starts with "-" is asked, never read as a flag.
        out = await deps.run(["memory", "ask", ...place, "--scope", scope, "--json", ...(deps.turnFlags ?? []), "--", question], { timeoutMs: MEMORY_ASK_TIMEOUT_MS });
      } finally {
        asking.delete(key);
      }
      if (out.timedOut === true) {
        return json({ ok: false, error: `No answer within ${Math.round(MEMORY_ASK_TIMEOUT_MS / 60_000)} minutes — the model may be busy or loading; nothing more is running.` }, 504);
      }
      return json(askAnswer(out.stdout, out.code, said(out.stderr)));
    }
    // D-081: a memory created or edited is `memory write --yes`; a delete is `memory forget`,
    // shown first unless write is true. The path is checked here and again by the command.
    if (url.pathname === "/api/memory/write") {
      const path = body["path"];
      const content = body["content"];
      if (typeof path !== "string" || memoryPathProblem(path) !== undefined || typeof content !== "string") return json({ ok: false, error: typeof path === "string" ? memoryPathProblem(path) ?? "no text" : "no path" }, 400);
      const out = await deps.memoryWrite(path, content);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    // D-084: a file (sent as base64) or a link, into memory as markdown. The command reads and gates it.
    if (url.pathname === "/api/memory/import") {
      const write = body["write"] === true;
      const link = body["url"];
      const name = body["name"];
      const data = body["data"];
      let out;
      if (typeof link === "string") {
        const problem = urlProblem(link);
        if (problem !== undefined) return json({ ok: false, error: problem }, 400);
        out = await deps.memoryImport({ kind: "url", url: link }, write);
      } else if (typeof name === "string" && typeof data === "string") {
        const ext = /\.[A-Za-z0-9]+$/.exec(name)?.[0]?.toLowerCase() ?? "";
        if (!/^[^/\\\0]{1,200}$/.test(name) || IMPORT_KINDS[ext] === undefined) return json({ ok: false, error: `cannot read ${ext || "a file with no extension"} — ${Object.keys(IMPORT_KINDS).join(" ")}` }, 400);
        if (data.length > Math.ceil((MAX_SOURCE_BYTES * 4) / 3) + 4) return json({ ok: false, error: `over ${MAX_SOURCE_BYTES / 1024 / 1024} MB` }, 400);
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        } catch {
          return json({ ok: false, error: "the file did not arrive whole" }, 400);
        }
        out = await deps.memoryImport({ kind: "file", name, bytes }, write);
      } else return json({ ok: false, error: "send a file or a link" }, 400);
      return json({ ok: out.code === 0, message: [said(out.stdout), said(out.stderr)].filter((m) => m !== "").join("\n") });
    }
    // D-090: between memory and knowledge. Shown first unless write is true; the command checks both paths again.
    if (url.pathname === "/api/memory/move") {
      const path = body["path"];
      const to = body["to"];
      if (typeof path !== "string" || memoryPathProblem(path) !== undefined || (to !== "knowledge" && to !== "memory")) return json({ ok: false, error: "not a memory file, or not knowledge/memory" }, 400);
      const out = await deps.run(["memory", "move", ...place, "--file", path, "--to", to, ...(body["write"] === true ? ["--yes"] : [])]);
      return json({ ok: out.code === 0, message: [said(out.stdout), said(out.stderr)].filter((m) => m !== "").join("\n") });
    }
    // D-091: a memory's collections, written into its front matter through `memory write` — every gate applies.
    if (url.pathname === "/api/memory/tags") {
      const path = body["path"];
      const tags = body["tags"];
      if (typeof path !== "string" || memoryPathProblem(path) !== undefined || !Array.isArray(tags) || tags.length > MAX_TAGS || !tags.every((t) => typeof t === "string" && t.length <= 60)) {
        return json({ ok: false, error: `a memory file and at most ${MAX_TAGS} tags` }, 400);
      }
      const now = await deps.memory(path);
      if (!now.ok) return json({ ok: false, error: now.reason }, 404);
      const out = await deps.memoryWrite(path, withTags(now.text, tags as string[]));
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    if (url.pathname === "/api/memory/delete") {
      const path = body["path"];
      if (typeof path !== "string" || memoryPathProblem(path) !== undefined) return json({ ok: false, error: "not a memory file" }, 400);
      const out = await deps.run(["memory", "forget", ...place, "--file", path, ...(body["write"] === true ? ["--yes"] : [])]);
      // A refusal is on stderr after the plan on stdout: show both, or the page says "would go" and hides why nothing went.
      return json({ ok: out.code === 0, message: [said(out.stdout), said(out.stderr)].filter((m) => m !== "").join("\n") });
    }
    // Gap 4 (D-079): answer a drafted claim; write the yeses (adopt shows first, writes with write: true).
    if (url.pathname === "/api/persona/decide") {
      const cid = body["claim"];
      const answer = body["answer"];
      if (typeof cid !== "string" || !/^[0-9a-f-]{8}$/.test(cid) || (answer !== "yes" && answer !== "no")) return json({ error: "no such claim" }, 400);
      const out = await deps.run(["persona", "decide", cid, "--subject", deps.subject, answer === "yes" ? "--yes" : "--no"]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    // D-093: facts drawn out of memory by the local model, each confirmed here before any is written.
    if (url.pathname === "/api/distill/start") {
      const key = `${deps.dir}\0${deps.subject}`;
      const now = distilling.get(key);
      if (now !== undefined && now.finished === undefined) return json({ ok: false, error: `already reading, since ${now.since}` }, 409);
      const from = body["from"];
      if (from !== undefined && (typeof from !== "string" || !from.split(",").every((p) => MEMORY_PLACE.test(p.trim()) && !p.includes("..")))) return json({ ok: false, error: "read from memory/ or a place under it" }, 400);
      const run = { since: new Date().toISOString() } as { since: string; finished?: { ok: boolean; message: string } };
      distilling.set(key, run);
      void deps
        .run(["memory", "distill", ...place, ...(typeof from === "string" ? ["--from", from] : [])])
        .then((out) => (run.finished = { ok: out.code === 0, message: [said(out.stdout), said(out.stderr)].filter((m) => m !== "").join("\n") }))
        .catch((e: unknown) => (run.finished = { ok: false, message: e instanceof Error ? e.message : String(e) }));
      return json({ ok: true, since: run.since });
    }
    if (url.pathname === "/api/distill/decide") {
      const fid = body["fact"];
      const answer = body["answer"];
      if (typeof fid !== "string" || !/^[0-9a-f]{8}$/.test(fid) || (answer !== "yes" && answer !== "no")) return json({ error: "no such fact" }, 400);
      const out = await deps.run(["memory", "distill", "decide", fid, "--subject", deps.subject, answer === "yes" ? "--yes" : "--no"]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    if (url.pathname === "/api/distill/adopt") {
      const out = await deps.run(["memory", "distill", "adopt", deps.dir, "--subject", deps.subject, ...(body["write"] === true ? ["--yes"] : [])]);
      return json({ ok: out.code === 0, message: [said(out.stdout), said(out.stderr)].filter((m) => m !== "").join("\n") });
    }
    if (url.pathname === "/api/persona/adopt") {
      const out = await deps.run(["persona", "adopt", deps.dir, "--subject", deps.subject, ...(body["write"] === true ? ["--yes"] : [])]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr), text: out.stdout.trim() });
    }
    // Gap 3: revoking a basis narrows what may come in, so the page may do it; recording one stays typed.
    if (url.pathname === "/api/basis/revoke") {
      const rid = body["id"];
      if (typeof rid !== "string" || !/^[0-9a-f]{8}$/.test(rid)) return json({ error: "no such record" }, 400);
      const out = await deps.run(["basis", "revoke", rid, "--subject", deps.subject]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    if (url.pathname === "/api/update-check") {
      const out = await deps.run(["update", "--check"]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }

    if (url.pathname === "/api/stop") {
      const out = await deps.run(["stop", ...place]);
      return json({ ok: out.code === 0, message: said(out.stdout) || said(out.stderr) });
    }
    return json({ error: "not found" }, 404);
  };
  return async (req: Request): Promise<Response> => nosniff(await route(req));
}

/** Start listening. Loopback unless a host is named on purpose. */
export function startWeb(
  deps: WebDeps,
  options: {
    readonly port: number;
    readonly hostname?: string;
    readonly token?: string;
    readonly names?: readonly string[];
    readonly scheme?: "http" | "https";
    /** Where a new key is kept when the page changes it (`--key-file`); without it the new key lives only here. */
    readonly saveKey?: (key: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
    /** Told when the key changes — never the key itself. */
    readonly onRotate?: () => void;
  },
): WebServer {
  const hostname = options.hostname ?? "127.0.0.1";
  let token = options.token ?? crypto.randomUUID().replace(/-/g, "");
  let hosts: readonly string[] = [];
  const keys: KeyControl = {
    rotate: async () => {
      const key = newKey();
      // Kept first: a key in use that a restart would not find again would leave the owner without a link.
      if (options.saveKey !== undefined) {
        const saved = await options.saveKey(key);
        if (!saved.ok) return saved;
      }
      token = key;
      options.onRotate?.();
      return { ok: true, key };
    },
  };
  const server = Bun.serve({
    hostname,
    port: options.port,
    fetch: (req) => handler(deps, token, hosts, keys)(req),
    // An uncaught error is a bare JSON 500: no stack, no path, nothing a page or a phone could be shown.
    error: () => json({ error: "something went wrong on this computer — the terminal running mind web may say more" }, 500),
    development: false,
  });
  const port = server.port ?? options.port;
  hosts = allowedHosts(hostname, port, options.names ?? []);
  const shown = options.names?.[0] ?? hostname;
  return {
    get url() {
      return `${options.scheme ?? "http"}://${shown}:${port}/#t=${token}`;
    },
    get token() {
      return token;
    },
    stop: async (force = false) => {
      await server.stop(force);
    },
    pending: () => server.pendingRequests,
  };
}
