// The door in front of Playwright MCP (D-151, review of PR #19).
//
// Playwright MCP has no authentication, and anything that can reach its port
// can drive the browser. So it listens on the container's loopback only
// (127.0.0.1:8932, and the firewall lets only this process's uid connect
// there), and this guard is what the published port reaches:
//
// - every request must carry `Authorization: Bearer <the task's token>`
//   (compared in constant time). mind mints the token per task and writes it
//   only into the record and the vendor's MCP config, both mode 600;
// - the container's operate level (D-153, fixed at `mind browser up`) picks
//   what is served: LOOK at 1, ACT at 2 and up. A `tools/call` naming a tool
//   outside that set is answered with a JSON-RPC error and never reaches the
//   server, and `tools/list` answers are filtered to it. So the level holds even
//   for a caller that has the token and a shell (curl), not only for claude's
//   `--allowedTools`;
// - a URL handed to `browser_navigate` or `browser_tabs` must be http: or https:
//   (or exactly about:blank). `javascript:` would run page code — the evaluate
//   ban by another door — and `data:` would load a page of the caller's making
//   that can post to an allowed origin. Refused before the server sees them; `browser_run_code_unsafe` ("RCE-equivalent", its own words) and
//   `browser_evaluate` run code in the server or the page; `browser_file_upload`
//   and `browser_drop` read files from inside the container. None of them is
//   served, at any dial level;
// - every tool call is one line of the action log on stdout (the entrypoint
//   appends it to /out/actions.jsonl), with every typed value replaced by its
//   length — the guard cannot see which field is a password, so it keeps none —
//   and every URL cut to its origin (a path or query can carry a secret too).
//
// No dependencies: Node's http and crypto only. It runs unchanged on Bun, which
// is how test/browser/guard.test.ts exercises it.

import { createServer, request as httpRequest } from "node:http";
import { timingSafeEqual } from "node:crypto";

/**
 * operate 1 — look (D-153). Must equal LOOK_TOOLS in src/browser/mcp-config.ts;
 * test/browser/mcp-config.test.ts holds the two together.
 */
export const LOOK = new Set([
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_find",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
]);

/** The most a task's browser ever serves (operate 2 and up). A tool not named here is refused — new ones too. */
export const SERVED = new Set([
  ...LOOK,
  "browser_network_request",
  "browser_tabs",
  "browser_click",
  "browser_hover",
  "browser_drag",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_handle_dialog",
  "browser_resize",
  "browser_emulate_media",
  "browser_close",
]);

/** What a container at this operate level serves. Anything that is not 2 or 3 is treated as 1. */
export function servedAt(operate) {
  return operate === 2 || operate === 3 ? SERVED : LOOK;
}

/** Argument names that carry a URL. */
const URLS = new Set(["url"]);

/** Why a URL may not be opened, or undefined. */
export function urlProblem(raw) {
  if (typeof raw !== "string") return "the url is not a string";
  if (raw.trim() === "about:blank") return undefined;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return "the url does not parse";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${url.protocol} URLs are not opened — only http:, https: and about:blank`;
  }
  return undefined;
}

/** A refused tool call's reason, or undefined: not served at this level, or a URL that may not be opened. */
export function callProblem(call, served = SERVED) {
  if (!served.has(call.name)) return `${call.name} is not served`;
  if (call.name === "browser_navigate" || call.name === "browser_tabs") {
    const url = call.arguments?.url;
    if (call.name === "browser_navigate" || url !== undefined) {
      const problem = urlProblem(url);
      if (problem !== undefined) return `${call.name} refused: ${problem}`;
    }
  }
  return undefined;
}

/** Argument names whose values are typed text. */
const TYPED = new Set(["text", "value", "values", "key", "promptText"]);
const MAX_BODY = 1024 * 1024;

/** Is this `Authorization` header the task's token? */
export function authorized(header, token) {
  if (typeof header !== "string" || typeof token !== "string" || token.length < 32) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The tool calls in one JSON-RPC body (a message or a batch). */
export function toolCalls(body) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter((message) => message?.method === "tools/call").map((message) => ({
    id: message.id,
    name: typeof message.params?.name === "string" ? message.params.name : "",
    arguments: message.params?.arguments ?? {},
  }));
}

/** Arguments with every typed value replaced by its length. */
export function redacted(value) {
  if (Array.isArray(value)) return value.map(redacted);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (URLS.has(key) && typeof inner === "string") {
      let origin;
      try {
        const url = new URL(inner);
        origin = url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}/…` : `[${url.protocol} url, ${inner.length} chars]`;
      } catch {
        origin = `[url, ${inner.length} chars]`;
      }
      out[key] = origin;
    } else if (TYPED.has(key)) {
      const length = typeof inner === "string" ? inner.length : JSON.stringify(inner ?? "").length;
      out[key] = `[typed, ${length} chars]`;
    } else {
      out[key] = redacted(inner);
    }
  }
  return out;
}

/** A `tools/list` answer (JSON or one SSE stream) with only the served tools in it. */
export function filterToolList(text, served = SERVED) {
  const filterMessage = (message) => {
    if (Array.isArray(message?.result?.tools)) {
      message.result.tools = message.result.tools.filter((tool) => served.has(tool?.name));
    }
    return message;
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(text);
    return JSON.stringify(Array.isArray(parsed) ? parsed.map(filterMessage) : filterMessage(parsed));
  }
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      try {
        return `data: ${JSON.stringify(filterMessage(JSON.parse(line.slice(5))))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function log(line) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

function refuse(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain" }).end(`mind browser guard: ${message}\n`);
}

/** Start the guard in front of `upstream` (host, port). Resolves with the listening server. */
export function startGuard({ token, upstream, port = 8931, host = "0.0.0.0", operate = 1 }) {
  const served = servedAt(operate);
  const server = createServer((req, res) => {
    if (!authorized(req.headers.authorization, token)) {
      log({ event: "refused", reason: "no or wrong token" });
      refuse(res, 401, "a task token is required");
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        refuse(res, 413, "request too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      const body = Buffer.concat(chunks);
      let parsed;
      if (body.length > 0) {
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          refuse(res, 400, "not JSON");
          return;
        }
      }
      const calls = parsed === undefined ? [] : toolCalls(parsed);
      const problems = calls.map((call) => ({ call, problem: callProblem(call, served) }));
      for (const { call, problem } of problems) {
        log({ event: problem === undefined ? "call" : "refused", tool: call.name, arguments: redacted(call.arguments), ...(problem === undefined ? {} : { reason: problem }) });
      }
      const banned = problems.find((entry) => entry.problem !== undefined);
      if (banned !== undefined) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: banned.call.id ?? null,
            error: { code: -32601, message: `mind browser guard: ${banned.problem}` },
          }),
        );
        return;
      }
      const lists = parsed !== undefined && (Array.isArray(parsed) ? parsed : [parsed]).some((m) => m?.method === "tools/list");
      const headers = { ...req.headers };
      delete headers.authorization;
      const upstreamRequest = httpRequest(
        { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers },
        (answer) => {
          if (!lists) {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
            return;
          }
          const parts = [];
          answer.on("data", (part) => parts.push(part));
          answer.on("end", () => {
            const filtered = filterToolList(Buffer.concat(parts).toString("utf8"), served);
            const out = { ...answer.headers };
            delete out["content-length"];
            delete out["transfer-encoding"];
            res.writeHead(answer.statusCode ?? 502, out).end(filtered);
          });
        },
      );
      upstreamRequest.on("error", () => {
        if (!res.headersSent) refuse(res, 502, "the browser server is not answering");
      });
      upstreamRequest.end(body);
    });
  });
  return new Promise((done) => server.listen(port, host, () => done(server)));
}

// Run as a program: `node guard.mjs` with MIND_TOKEN.
if (import.meta.main ?? process.argv[1]?.endsWith("guard.mjs")) {
  const token = process.env.MIND_TOKEN ?? "";
  if (token.length < 32) {
    console.error("mind browser guard: MIND_TOKEN is missing or short");
    process.exit(64);
  }
  const operate = Number(process.env.MIND_OPERATE ?? "1");
  await startGuard({ token, upstream: { host: "127.0.0.1", port: 8932 }, operate });
  log({ event: "start", operate: servedAt(operate) === SERVED ? "act" : "look" });
}
