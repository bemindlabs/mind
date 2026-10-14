/**
 * The two factories in `src/exec/index.ts`.
 *
 * This file exists because the exemption did not deserve to. `index.ts` sat in
 * the coverage gate's list as a "re-export barrel" while holding `backend()`
 * and `allBackends()` — the two functions that decide, for every command Mind
 * has, which class a backend id becomes. The file's own header already admitted
 * it ("Two factories and the re-exports"), and the gate could not see the
 * contradiction because it only asks whether a file was *loaded*.
 *
 * The cases were partly covered from `fallback.test.ts`, as a note that the
 * exemption was only honest if what remained got exercised. They live here now,
 * where the file they test is named, and go further: a factory that built the
 * right *class* while dropping the options it was handed would have passed the
 * old version of these.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { CliExec } from "../../src/exec/cli-exec.ts";
import { allBackends, backend } from "../../src/exec/index.ts";
import { LOCAL_BACKENDS, LocalCliExec } from "../../src/exec/local-cli.ts";
import { OllamaExec } from "../../src/exec/ollama-exec.ts";
import { VENDORS } from "../../src/exec/registry.ts";
import { subjectId } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

/** A daemon that records the model each request named. */
function serve() {
  const models: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      const body = (await request.json()) as { model: string };
      models.push(body.model);
      return Response.json({ message: { content: "answered" } });
    },
  });
  servers.push(server);
  return { models, host: `http://127.0.0.1:${server.port}` };
}

describe("backend()", () => {
  test("`ollama` is the local one and everything else is a vendor CLI", () => {
    expect(backend("ollama")).toBeInstanceOf(OllamaExec);
    expect(backend("ollama").kind).toBe("http");
    expect(backend("claude")).toBeInstanceOf(CliExec);
    expect(backend("claude").id).toBe("claude");
    expect(backend("claude").kind).toBe("cli");
    expect(backend("claude-local")).toBeInstanceOf(LocalCliExec);
    expect(backend("grok-local").id).toBe("grok-local");
  });

  test("an unknown id throws rather than quietly building something", () => {
    // A typo in `--backend` has to be exit 2 at the command line, not a turn
    // sent somewhere nobody asked for.
    expect(() => backend("nonesuch")).toThrow("unknown vendor");
  });

  test("a model handed to the factory is the model the daemon is asked for", async () => {
    // The gap the old barrel tests left: `backend("ollama", { model })` built
    // the right class either way, so dropping the option on the floor looked
    // exactly like honouring it.
    const daemon = serve();
    const original = process.env["OLLAMA_HOST"];
    process.env["OLLAMA_HOST"] = daemon.host;
    try {
      const result = await backend("ollama", { model: "from-the-factory" }).run({ restraint: RESTRAINED,
        subject: subjectId("example"),
        prompt: "anything",
      });
      expect(result.confidence).toBe("confirmed");
      expect(daemon.models).toEqual(["from-the-factory"]);
    } finally {
      if (original === undefined) delete process.env["OLLAMA_HOST"];
      else process.env["OLLAMA_HOST"] = original;
    }
  });

  test("no model, and the local backend says so instead of picking one", async () => {
    const daemon = serve();
    const original = process.env["OLLAMA_HOST"];
    process.env["OLLAMA_HOST"] = daemon.host;
    try {
      const result = await backend("ollama").run({ restraint: RESTRAINED,
        subject: subjectId("example"),
        prompt: "anything",
      });
      expect(result.confidence).toBe("silent");
      expect(daemon.models).toEqual([]);
    } finally {
      if (original === undefined) delete process.env["OLLAMA_HOST"];
      else process.env["OLLAMA_HOST"] = original;
    }
  });

  test("a vendor id keeps the model it was handed — the model belongs to the backend, not the turn (D-142)", () => {
    // It used to be dropped here: the model was meant to ride on the turn request, and `turn` never put it there,
    // because one request goes to every step of a chain. So `--backend claude --model opus` ran claude's default.
    const claude = backend("claude", { model: "opus" });
    expect(claude).toBeInstanceOf(CliExec);
    expect((claude as CliExec).model).toBe("opus");
    expect((backend("claude") as CliExec).model).toBeUndefined();
    expect((backend("claude", { model: "" }) as CliExec).model).toBeUndefined();
    for (const spec of VENDORS) expect((backend(spec.id, { model: "some-model" }) as CliExec).model).toBe("some-model");
  });

  test("a model a backend cannot take throws instead of building it without one (D-142)", () => {
    // The commands refuse these first (`routeModels`), so reaching here is a programmer error — and building the
    // backend on its default would run a model nobody asked for.
    for (const id of LOCAL_BACKENDS) expect(() => backend(id, { model: "opus" })).toThrow("takes no other model");
    expect(() => backend("claude", { model: "--dangerously-skip-permissions" })).toThrow("starts with '-'");
    expect(() => backend("ollama", { model: "qwen3:8b; rm -rf /" })).toThrow("a character a model name does not have");
    expect(backend("claude-local")).toBeInstanceOf(LocalCliExec);
  });
});

describe("allBackends()", () => {
  test("the local one is in the list, not beside it, and every vendor follows", () => {
    const ids = allBackends().map((b) => b.id);
    // I-1 again: a list that had to be special-cased to include the local
    // route is a list that will one day forget to.
    expect(ids[0]).toBe("ollama");
    expect(ids).toEqual(["ollama", ...VENDORS.map((spec) => spec.id), ...LOCAL_BACKENDS]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("each one is built, not described — they can all be asked if they are ready", () => {
    for (const built of allBackends()) {
      expect(typeof built.available).toBe("function");
      expect(typeof built.run).toBe("function");
      expect(["cli", "http"]).toContain(built.kind);
      expect(["system", "user", "none"]).toContain(built.identityStrength);
    }
  });
});
