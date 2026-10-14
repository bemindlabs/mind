/**
 * The ollama daemon, as far as `OllamaExec` can tell, with a record of use.
 *
 * Lifted out of `test/cli/turn.test.ts` when a second file needed the same stub.
 * Copying the twenty lines would have been quicker and is the mistake
 * `test/support/bare-path.ts` was written to undo: two files had drifted into
 * believing two different things about the same condition, and the weaker of the
 * two was the one being asserted against. A stub is a claim about what ollama
 * looks like, and two copies of a claim eventually disagree.
 *
 * It is **not** the only stub daemon in the suite, and the other two are not
 * copies of this one. `test/cli/ledger.test.ts` answers `echo:<prompt>` and
 * reports token counts, because what it is testing is what lands in a ledger
 * line; `test/cli/soul-verify.test.ts` answers correctly, wrongly or not at all
 * on demand, because what it is testing is a verifier. Folding three different
 * behaviours into one helper with three flags would make each caller harder to
 * read than its own twelve lines.
 *
 * What this one has that a bare responder does not is the **record**: `systems`
 * and `prompts` hold every message the daemon was handed, in order. That is what
 * lets a test ask *what reached the backend* rather than only what came back —
 * the question D-022 turns on (`test/ledger/read-back.test.ts`).
 */

/** A stub daemon, its port, and what it was asked. */
export interface StubOllama {
  readonly server: ReturnType<typeof Bun.serve>;
  /** The `system` message of every `/api/chat` call, in order. */
  readonly systems: string[];
  /** The last message of every `/api/chat` call, in order. */
  readonly prompts: string[];
  /** What to hand the child as `OLLAMA_HOST`. */
  readonly url: string;
}

/**
 * Start one, on a port the kernel picks.
 *
 * The hostname is a parameter because one case needs the daemon reached by a
 * *name*: `localhost` almost always resolves to loopback, and "almost always" is
 * not what `notLoopbackLiteral` accepts, so that run must print the egress
 * notice while a `127.0.0.1` run must not.
 *
 * The caller stops it — `await ollama.server.stop(true)` in a `finally`.
 */
export function serveOllama(hostname = "127.0.0.1"): StubOllama {
  const systems: string[] = [];
  const prompts: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      if (url.pathname !== "/api/chat") return new Response("no", { status: 404 });

      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const prompt = body.messages.at(-1)?.content ?? "";
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      systems.push(system);
      prompts.push(prompt);

      const token = (prompt.match(/token (\S+)/) ?? [])[1] ?? "no-token";
      const carried = system.includes("Example Keeper") ? "with-soul" : "no-soul";
      return Response.json({ message: { content: `${token} from ollama ${carried}` } });
    },
  });
  return { server, systems, prompts, url: `http://${hostname}:${server.port}` };
}
