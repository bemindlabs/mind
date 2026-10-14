/**
 * `OllamaExec` against a daemon that is not ollama.
 *
 * I-1 says every capability must have a local route that really works, and
 * this file is that route. It shipped with the same coverage exemption
 * `cli-exec.ts` had — 8.18% of lines — which is an odd place to leave the one
 * backend the acceptance test for I-1 depends on: the vendor path at least got
 * exercised end to end by `test/cli/*`, while the local one was only ever
 * reached through a subprocess.
 *
 * A `Bun.serve` on `127.0.0.1:0` stands in for the daemon. The random port
 * matters as much as the loopback address: nothing here can reach a real
 * ollama on :11434, so no case can pass because a model happened to be pulled
 * on this machine (D-021).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { extractOllamaUsage, OllamaExec } from "../../src/exec/ollama-exec.ts";
import { subjectId } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";

const SUBJECT = subjectId("example");

/** A port nothing listens on, so "the daemon is down" is a real condition. */
const NOWHERE = "http://127.0.0.1:1";

interface ChatCall {
  readonly model: string;
  readonly stream: unknown;
  readonly messages: { role: string; content: string }[];
}

interface Handlers {
  /** What `/api/tags` answers. Default: one model. */
  readonly tags?: () => Response;
  /** What `/api/chat` answers. Default: an echo of the last message. */
  readonly chat?: (call: ChatCall) => Response | Promise<Response>;
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

/** The daemon, as far as `OllamaExec` can tell, with a record of what it was sent. */
function serve(handlers: Handlers = {}) {
  const calls: ChatCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") {
        return handlers.tags?.() ?? Response.json({ models: [{ name: "stub" }] });
      }
      if (url.pathname !== "/api/chat") return new Response("no such route", { status: 404 });

      const body = (await request.json()) as ChatCall;
      calls.push(body);
      if (handlers.chat !== undefined) return await handlers.chat(body);
      const prompt = body.messages.at(-1)?.content ?? "";
      return Response.json({ message: { content: `echo: ${prompt}` } });
    },
  });
  servers.push(server);
  return { calls, host: `http://127.0.0.1:${server.port}` };
}

const ASK = {
  subject: SUBJECT,
  prompt: "what is the capital of nowhere",
  // The local backend has no read-only flag to carry, but the dial still
  // decides whether the turn runs at all, so every request carries one (S5.1).
  restraint: RESTRAINED,
} as const;

describe("OllamaExec.available", () => {
  test("a daemon with models pulled is ready, and says how many", async () => {
    const daemon = serve({ tags: () => Response.json({ models: [{ name: "a" }, { name: "b" }] }) });
    const result = await new OllamaExec({ host: daemon.host }).available();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe(`${daemon.host}: 2 model(s)`);
  });

  test("reachable with nothing pulled is not ready, and the detail says why", async () => {
    // A daemon that answers but holds no model cannot run a turn, and "not
    // ready" with no reason is the kind of report that costs an hour.
    const daemon = serve({ tags: () => Response.json({ models: [] }) });
    const result = await new OllamaExec({ host: daemon.host }).available();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(`${daemon.host}: reachable but no models pulled`);

    const noField = serve({ tags: () => Response.json({}) });
    expect((await new OllamaExec({ host: noField.host }).available()).ok).toBe(false);
  });

  test("an error status is reported, not treated as ready", async () => {
    const daemon = serve({ tags: () => new Response("upstream sulked", { status: 500 }) });
    const result = await new OllamaExec({ host: daemon.host }).available();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(`${daemon.host}: HTTP 500`);
  });

  test("nothing listening is a result, not a thrown error", async () => {
    // `doctor` calls this for every backend in a loop; one dead daemon must
    // not derail the others.
    const result = await new OllamaExec({ host: NOWHERE }).available();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("unreachable");
  });
});

describe("OllamaExec.run — what the daemon is actually sent", () => {
  test("a reply comes back confirmed, with the raw body kept as evidence", async () => {
    const daemon = serve();
    const result = await new OllamaExec({ host: daemon.host, defaultModel: "stub" }).run(ASK);

    expect(result.confidence).toBe("confirmed");
    expect(result.backend).toBe("ollama");
    expect(result.text).toBe("echo: what is the capital of nowhere");
    expect(result.evidence.source).toBe("ollama");
    expect(result.evidence.prompt).toBe(ASK.prompt);
    expect(result.evidence.raw).toContain("echo: what is the capital of nowhere");
    expect(result.evidence.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("the prompt is sent verbatim, streaming off, and the system message only when there is one", async () => {
    const daemon = serve();
    const exec = new OllamaExec({ host: daemon.host, defaultModel: "stub" });

    await exec.run({ ...ASK, prompt: "line one\nline two — \"quoted\"" });
    expect(daemon.calls[0]!.stream).toBe(false);
    expect(daemon.calls[0]!.messages).toEqual([
      { role: "user", content: "line one\nline two — \"quoted\"" },
    ]);

    await exec.run({ ...ASK, system: "# Example Keeper\n\nsoul text" });
    // System first, because that is the slot a chat model reads it from, and
    // exactly one of them — a soul delivered twice is a soul delivered wrong.
    expect(daemon.calls[1]!.messages).toEqual([
      { role: "system", content: "# Example Keeper\n\nsoul text" },
      { role: "user", content: ASK.prompt },
    ]);
  });

  test("the model on the request beats the configured default", async () => {
    const daemon = serve();
    const exec = new OllamaExec({ host: daemon.host, defaultModel: "the-default" });

    await exec.run(ASK);
    expect(daemon.calls[0]!.model).toBe("the-default");

    await exec.run({ ...ASK, model: "asked-for" });
    expect(daemon.calls[1]!.model).toBe("asked-for");
  });

  test("the identity is a first-class field, so it lands at full strength", async () => {
    const daemon = serve();
    const exec = new OllamaExec({ host: daemon.host, defaultModel: "stub" });

    expect(exec.identityStrength).toBe("system");
    expect((await exec.run({ ...ASK, system: "# Example Keeper" })).identityStrength).toBe("system");
    // …and `none` when no soul was offered, rather than a claim nobody made.
    expect((await exec.run(ASK)).identityStrength).toBe("none");
  });

  test("the host comes from OLLAMA_HOST when nothing else says, with a trailing slash trimmed", async () => {
    const daemon = serve();
    const original = process.env["OLLAMA_HOST"];
    process.env["OLLAMA_HOST"] = `${daemon.host}/`;
    try {
      const result = await new OllamaExec({ defaultModel: "stub" }).run(ASK);
      // A doubled slash would make the URL `…//api/chat`, which some proxies
      // route somewhere else entirely.
      expect(result.confidence).toBe("confirmed");
      expect(daemon.calls.length).toBe(1);
    } finally {
      if (original === undefined) delete process.env["OLLAMA_HOST"];
      else process.env["OLLAMA_HOST"] = original;
    }
  });
});

describe("what a local turn used", () => {
  test("the daemon's own counts are read, and no total is invented", () => {
    // Measured 2026-09-21 against 0.32.13: both counts sit at the top level of
    // the chat response, beside the durations. There is no total field and no
    // field in a currency anywhere in the body, which is the evidence that
    // writing `0` for a local turn would be Mind adding something the daemon
    // never said.
    const usage = extractOllamaUsage(
      JSON.stringify({
        message: { content: "hi" },
        prompt_eval_count: 15,
        eval_count: 24,
        total_duration: 1_000_000,
      }),
    );
    expect(usage).toEqual({ status: "reported", input: 15, output: 24, total: null, cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null, not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"] });
  });

  test("no cache count is read, and both say the daemon prints none — null, never 0 (S15.9)", () => {
    // The measured body has no cache field at all. A 0 here would be a claim
    // that nothing came from a cache; null in `not_printed` is the claim that
    // the daemon does not say, which is the one that is true.
    for (const raw of [JSON.stringify({ prompt_eval_count: 15, eval_count: 24 }), "not json"]) {
      const usage = extractOllamaUsage(raw);
      expect([usage.cache_read, usage.cache_write]).toEqual([null, null]);
      expect(usage.not_printed).toEqual(["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"]);
    }
  });

  test("a count of zero from the daemon is zero, not an absent number", () => {
    const usage = extractOllamaUsage(JSON.stringify({ prompt_eval_count: 0, eval_count: 0 }));
    expect(usage).toEqual({ status: "reported", input: 0, output: 0, total: null, cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null, not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"] });
  });

  test("one count without the other is missing, and keeps the half it found", () => {
    // The shape ollama is rumoured to take when a prompt is fully cached. If
    // it happens, the honest report is an incomplete one, not a turn that
    // looks like it read nothing.
    const usage = extractOllamaUsage(JSON.stringify({ eval_count: 24 }));
    expect(usage.status).toBe("missing");
    expect(usage.input).toBeNull();
    expect(usage.output).toBe(24);
  });

  test("anything that is not a body with whole counts in it is missing", () => {
    for (const raw of [
      "",
      "not json",
      "[1,2]",
      "null",
      JSON.stringify({ error: "model requires more system memory" }),
      JSON.stringify({ prompt_eval_count: "15", eval_count: 24 }),
      JSON.stringify({ prompt_eval_count: -1, eval_count: 24 }),
      JSON.stringify({ prompt_eval_count: 1.5, eval_count: 24 }),
    ]) {
      expect(extractOllamaUsage(raw).status).toBe("missing");
    }
  });

  test("a real turn through the backend carries them on its evidence (I-1)", async () => {
    // The local route accounts for itself as completely as a commercial CLI
    // does, so choosing it costs nothing in what can be audited afterwards.
    const daemon = serve({
      chat: () =>
        Response.json({ message: { content: "hello" }, prompt_eval_count: 15, eval_count: 24 }),
    });
    const result = await new OllamaExec({ host: daemon.host, defaultModel: "stub" }).run(ASK);

    expect(result.confidence).toBe("confirmed");
    expect(result.evidence.usage).toEqual({
      status: "reported",
      input: 15,
      output: 24,
      total: null,
      cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null, not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
    });
  });

  test("a daemon that answered without counts is missing, never zero", async () => {
    const daemon = serve();
    const result = await new OllamaExec({ host: daemon.host, defaultModel: "stub" }).run(ASK);
    expect(result.confidence).toBe("confirmed");
    expect(result.evidence.usage).toEqual({
      status: "missing",
      input: null,
      output: null,
      total: null,
      cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null, not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
    });
  });

  test("every route out of `run` carries a usage, including the ones that never left", async () => {
    const noModel = await new OllamaExec({ host: serve().host }).run(ASK);
    expect(noModel.evidence.usage?.status).toBe("missing");

    const refused = await new OllamaExec({ host: NOWHERE, defaultModel: "stub" }).run(ASK);
    expect(refused.evidence.usage?.status).toBe("missing");
  });
});

describe("OllamaExec.run — the four ways nothing useful comes back", () => {
  test("no model named is silence: no request ever left", async () => {
    const daemon = serve();
    const result = await new OllamaExec({ host: daemon.host }).run(ASK);

    // Not `failed`. Nothing ran, so nothing can be said to have failed — and
    // the reason is still on the record, where a human will read it.
    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.evidence.raw).toBe("no model given and no default configured — pass --model, or set MIND_OLLAMA_MODEL");
    expect(daemon.calls.length).toBe(0);
  });

  test("MIND_OLLAMA_MODEL is the default a chain's local fallback uses; an explicit model wins", async () => {
    const daemon = serve();
    const before = process.env["MIND_OLLAMA_MODEL"];
    process.env["MIND_OLLAMA_MODEL"] = "from-env";
    try {
      await new OllamaExec({ host: daemon.host }).run(ASK);
      await new OllamaExec({ host: daemon.host, defaultModel: "explicit" }).run(ASK);
      process.env["MIND_OLLAMA_MODEL"] = "  ";
      const blank = await new OllamaExec({ host: daemon.host }).run(ASK);
      expect(blank.confidence).toBe("silent");
    } finally {
      if (before === undefined) delete process.env["MIND_OLLAMA_MODEL"];
      else process.env["MIND_OLLAMA_MODEL"] = before;
    }
    expect(daemon.calls.map((c) => (c as { model?: string }).model)).toEqual(["from-env", "explicit"]);
  });

  test("an error status is silence, and its body is evidence rather than an answer", async () => {
    const daemon = serve({
      chat: () => new Response("model 'stub' not found, try pulling it first", { status: 404 }),
    });
    const result = await new OllamaExec({ host: daemon.host, defaultModel: "stub" }).run(ASK);

    // The HTTP twin of a non-zero exit: the daemon did not take the turn.
    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.evidence.raw).toBe("HTTP 404: model 'stub' not found, try pulling it first");
  });

  test("an unparseable body is silence — an HTML error page is not what the model said", async () => {
    const daemon = serve({
      chat: () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    const result = await new OllamaExec({ host: daemon.host, defaultModel: "stub" }).run(ASK);

    // The one of these four a reviewer is most likely to argue with: bytes did
    // come back. But the alternative is to let a proxy's error page become the
    // answer text, which is precisely the bug this whole task was opened for.
    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.evidence.raw).toContain("unparseable response:");
    expect(result.evidence.raw).toContain("502 Bad Gateway");
  });

  test("an error in the body is silence — `Not logged in`, in HTTP", async () => {
    const daemon = serve({ chat: () => Response.json({ error: "model requires more system memory" }) });
    const result = await new OllamaExec({ host: daemon.host, defaultModel: "stub" }).run(ASK);

    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.evidence.raw).toBe("model requires more system memory");
  });

  test("a 200 with an empty message is silence too", async () => {
    const daemon = serve({ chat: () => Response.json({ message: { content: "   " } }) });
    const result = await new OllamaExec({ host: daemon.host, defaultModel: "stub" }).run(ASK);
    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");

    const noMessage = serve({ chat: () => Response.json({ done: true }) });
    expect(
      (await new OllamaExec({ host: noMessage.host, defaultModel: "stub" }).run(ASK)).confidence,
    ).toBe("silent");
  });

  test("a refused connection, a timeout and an abort are all silence", async () => {
    const refused = await new OllamaExec({ host: NOWHERE, defaultModel: "stub" }).run(ASK);
    expect(refused.confidence).toBe("silent");
    expect(refused.text).toBe("");
    expect(refused.evidence.raw.length).toBeGreaterThan(0);

    // A server that takes the request and never answers until the test lets it go: no sleep to outlast, and the
    // abort below is fired when the request has ARRIVED, not 100 ms after on the hope that it has.
    // Two requests reach it (the one that times out, then the one that is aborted): the abort waits for the second.
    let requests = 0;
    let arrived: () => void = () => undefined;
    const requestArrived = new Promise<void>((resolve) => (arrived = resolve));
    let letGo: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (letGo = resolve));
    const slow = serve({
      chat: async () => {
        requests += 1;
        if (requests === 2) arrived();
        await released;
        return Response.json({ message: { content: "too late" } });
      },
    });
    const exec = new OllamaExec({ host: slow.host, defaultModel: "stub" });

    const timedOut = await exec.run({ ...ASK, timeoutMs: 200 });
    expect(timedOut.confidence).toBe("silent");
    expect(timedOut.text).toBe("");

    const controller = new AbortController();
    const abortedRun = exec.run({ ...ASK, timeoutMs: 120_000, signal: controller.signal });
    await requestArrived;
    controller.abort();
    const aborted = await abortedRun;
    letGo();
    expect(aborted.confidence).toBe("silent");
    expect(aborted.text).toBe("");
  }, 20_000);

  test("every route through this backend is `confirmed` or `silent`, never `failed`", async () => {
    // The sweep the plan for this task promised, and the reason the confidence
    // is no longer a parameter of `result()`: with four call sites each
    // choosing their own, four of them chose `failed` — a judgement about
    // *content* that this layer has no way to make. Now there is one decision,
    // derived from whether there is any text, and no argument to get wrong.
    const cases: Array<() => Promise<{ confidence: string }>> = [
      () => new OllamaExec({ host: serve().host }).run(ASK),
      () => new OllamaExec({ host: serve().host, defaultModel: "stub" }).run(ASK),
      () =>
        new OllamaExec({
          host: serve({ chat: () => new Response("nope", { status: 500 }) }).host,
          defaultModel: "stub",
        }).run(ASK),
      () =>
        new OllamaExec({
          host: serve({ chat: () => new Response("<html>", { status: 200 }) }).host,
          defaultModel: "stub",
        }).run(ASK),
      () =>
        new OllamaExec({
          host: serve({ chat: () => Response.json({ error: "no" }) }).host,
          defaultModel: "stub",
        }).run(ASK),
      () =>
        new OllamaExec({
          host: serve({ chat: () => Response.json({ message: { content: "" } }) }).host,
          defaultModel: "stub",
        }).run(ASK),
      () => new OllamaExec({ host: NOWHERE, defaultModel: "stub" }).run(ASK),
    ];

    const outcomes = new Set<string>();
    for (const run of cases) outcomes.add((await run()).confidence);
    expect([...outcomes].sort()).toEqual(["confirmed", "silent"]);
  }, 20_000);
});
