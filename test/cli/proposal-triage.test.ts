/**
 * D-059 through the binary, against a stub TypeSafe: on demand and on filing
 * (only with MIND_TRIAGE=jev), shown in list and show, never deciding.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triageAndStore, triageIfEnabled } from "../../bin/triage.ts";
import { describeProposal } from "../../src/decide/proposals.ts";
import { judgeWarning, JUDGE_WARNING_PREFIX } from "../../src/egress/judge-mode.ts";
import { readTriage } from "../../src/decide/triage.ts";
import { subjectId } from "../../src/types.ts";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

const scratch: string[] = [];
const servers: { stop: (force: boolean) => void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

function stubJev() {
  const bodies: { state: string; auth: string | null }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { state: string };
      bodies.push({ state: body.state, auth: req.headers.get("authorization") });
      return Response.json({
        model: "jev-stub",
        answers: {
          risk: { type: "choice", choice: "external", confidence: 0.9, probabilities: { external: 0.9, "local-change": 0.1, "read-only": 0, destructive: 0 } },
          reversible: { type: "noul", noul: 0.2 },
          personal: { type: "noul", noul: 0.1 },
        },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1/systemone`, bodies };
}

async function setup(env: Record<string, string>) {
  const home = await mkdtemp(join(tmpdir(), "mind-ptriage-"));
  scratch.push(home);
  const soul = join(home, "soul");
  await cp(SOUL, soul, { recursive: true });
  const base = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), ...env };
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env: base, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  const file = (what: string) =>
    run(["proposal", "new", soul, "--subject", "example", "--what", what, "--why", "asked", "--impact", "one message"]);
  return { home, soul, run, file };
}

describe("proposal triage", () => {
  test("on demand: labelled in list and show, with the note; the proposal stays pending", async () => {
    const jev = stubJev();
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "test-key", MIND_TYPESAFE_URL: jev.url });
    const id = (await file("post the release notes to the team channel")).stdout.trim();
    expect(jev.bodies).toHaveLength(0); // not on filing without MIND_TRIAGE

    const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
    expect(t.code, t.stderr).toBe(0);
    expect(t.stderr).toContain("leaving this machine");
    expect(t.stderr).toContain("jev: external 0.90 · undo 0.20 · personal 0.10");
    expect(jev.bodies[0]!.auth).toBe("Bearer test-key");
    expect(JSON.parse(jev.bodies[0]!.state).what).toBe("post the release notes to the team channel");

    expect((await run(["proposal", "list", soul, "--subject", "example"])).stdout).toContain("[jev: external 0.90");
    const shown = (await run(["proposal", "show", id, soul, "--subject", "example"])).stdout;
    expect(shown).toContain("status  pending");
    expect(shown).toContain("It approves nothing.");
  }, 60_000);

  test("on filing only with MIND_TRIAGE=jev, and --pending triages what is waiting", async () => {
    const jev = stubJev();
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "k", MIND_TYPESAFE_URL: jev.url, MIND_TRIAGE: "jev" });
    await file("send a summary to the owner");
    expect(jev.bodies).toHaveLength(1);
    const again = await run(["proposal", "triage", "--pending", soul, "--subject", "example"]);
    expect(again.code, again.stderr).toBe(0);
    expect(jev.bodies).toHaveLength(2);
  }, 60_000);

  test("no key: nothing is sent, exit 1, and the proposal is untouched", async () => {
    const jev = stubJev();
    const { soul, run, file } = await setup({ MIND_TYPESAFE_URL: jev.url });
    const id = (await file("post an update")).stdout.trim();
    const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
    expect(t.code).toBe(1);
    expect(t.stderr).toContain("no key");
    expect(jev.bodies).toHaveLength(0);
  }, 60_000);
});

/** D-181: triage sends a text to a hosted service, so it is held to the rule a2a send and a cloud turn are. */
describe("proposal triage and the local judge", () => {
  const PARAPHRASE = "pass the invoice to the bookkeeper whose name means young woman";
  const warnings = (stderr: string) => stderr.split("\n").filter((line) => line.includes(JUDGE_WARNING_PREFIX));

  /** A model on loopback standing in for the local Ollama's judge, keeping what it was asked. */
  function localJudge(reveals: boolean) {
    const asked: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: { content: string }[] };
        asked.push(body.messages.at(-1)?.content ?? "");
        return Response.json({ message: { content: JSON.stringify({ reveals }) } });
      },
    });
    servers.push(server);
    return { asked, env: { MIND_OLLAMA_MODEL: "local-stub", OLLAMA_HOST: `http://127.0.0.1:${server.port}` } };
  }

  async function withNeedle(run: Awaited<ReturnType<typeof setup>>["run"]) {
    const where = await run(["egress", "needles", "--subject", "example"]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(join(needles, ".."), { recursive: true });
    await Bun.write(needles, "Wanida Srisuk\n");
  }

  test("no judge named and no local model: each triage that leaves says only the filter looked, before it goes, every time", async () => {
    const jev = stubJev();
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "k", MIND_TYPESAFE_URL: jev.url });
    const id = (await file("post the release notes")).stdout.trim();
    for (let round = 0; round < 2; round += 1) {
      const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
      expect(t.code, t.stderr).toBe(0);
      expect(warnings(t.stderr)).toEqual([judgeWarning("en")]);
      expect(t.stderr.indexOf(JUDGE_WARNING_PREFIX)).toBeLessThan(t.stderr.indexOf("leaving this machine"));
    }
    expect(jev.bodies).toHaveLength(2);
  }, 60_000);

  test("a proposal the filter keeps in is not warned about: nothing left", async () => {
    const jev = stubJev();
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "k", MIND_TYPESAFE_URL: jev.url });
    await withNeedle(run);
    const id = (await file("write to Wanida Srisuk about it")).stdout.trim();
    const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
    expect(t.stderr).toContain("kept in");
    expect(warnings(t.stderr)).toEqual([]);
    expect(jev.bodies).toHaveLength(0);
  }, 60_000);

  test("a local model is configured: the judge reads the proposal by itself, and a reveal keeps it from TypeSafe", async () => {
    const jev = stubJev();
    const judge = localJudge(true);
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "k", MIND_TYPESAFE_URL: jev.url, ...judge.env });
    await withNeedle(run);
    const id = (await file(PARAPHRASE)).stdout.trim();
    const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
    expect(judge.asked.length).toBeGreaterThan(0);
    expect(judge.asked[0]).toContain(PARAPHRASE);
    expect(t.stderr).toContain("kept in");
    expect(t.stderr).toContain("the local judge read it as revealing");
    expect(warnings(t.stderr)).toEqual([]);
    expect(jev.bodies).toHaveLength(0);
  }, 60_000);

  test("a local model that reads it as clear: it goes, with no warning", async () => {
    const jev = stubJev();
    const judge = localJudge(false);
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "k", MIND_TYPESAFE_URL: jev.url, ...judge.env });
    await withNeedle(run);
    const id = (await file(PARAPHRASE)).stdout.trim();
    const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
    expect(t.code, t.stderr).toBe(0);
    expect(judge.asked.length).toBeGreaterThan(0);
    expect(warnings(t.stderr)).toEqual([]);
    expect(jev.bodies).toHaveLength(1);
  }, 60_000);

  test("a model the daemon relays to a hosted service is not the judge: it is not asked, and the line says what to fix", async () => {
    const jev = stubJev();
    const judge = localJudge(true);
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "k", MIND_TYPESAFE_URL: jev.url, ...judge.env, MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" });
    await withNeedle(run);
    const id = (await file(PARAPHRASE)).stdout.trim();
    const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
    expect(judge.asked).toEqual([]);
    expect(warnings(t.stderr)).toEqual([judgeWarning("en", "local-model-not-local")]);
    expect(jev.bodies).toHaveLength(1);
  }, 60_000);

  test("a judge named empty is the owner's word for no judge, and the line is still said", async () => {
    const jev = stubJev();
    const judge = localJudge(true);
    const { soul, run, file } = await setup({ TYPESAFE_API_KEY: "k", MIND_TYPESAFE_URL: jev.url, ...judge.env, MIND_EGRESS_JUDGE: "" });
    await withNeedle(run);
    const id = (await file(PARAPHRASE)).stdout.trim();
    const t = await run(["proposal", "triage", id, soul, "--subject", "example"]);
    expect(judge.asked).toEqual([]);
    expect(warnings(t.stderr)).toEqual([judgeWarning("en")]);
  }, 60_000);
});

describe("the bin helper, in process", () => {
  test("stores a triage, and a missing key stores nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-ptriage-helper-"));
    scratch.push(dir);
    const proposal = describeProposal({ id: "22222222-2222-4222-8222-222222222222", subject: subjectId("example"), at: new Date(), what: "w", why: "y", impact: "i" });
    const saved = { key: process.env["TYPESAFE_API_KEY"], home: process.env["XDG_DATA_HOME"] };
    process.env["XDG_DATA_HOME"] = join(dir, "data");
    try {
      delete process.env["TYPESAFE_API_KEY"];
      expect((await triageAndStore(dir, proposal, subjectId("example"))).kind).toBe("failed");
      process.env["TYPESAFE_API_KEY"] = "k";
      const out = await triageAndStore(dir, proposal, subjectId("example"), [], async () =>
        Response.json({ model: "m", answers: { risk: { choice: "read-only", confidence: 1, probabilities: { "read-only": 1 } }, reversible: { noul: 1 }, personal: { noul: 0 } } }),
      );
      expect(out.kind).toBe("triaged");
      expect((await readTriage(dir, proposal.id))?.risk.choice).toBe("read-only");
    } finally {
      if (saved.key === undefined) delete process.env["TYPESAFE_API_KEY"];
      else process.env["TYPESAFE_API_KEY"] = saved.key;
      if (saved.home === undefined) delete process.env["XDG_DATA_HOME"];
      else process.env["XDG_DATA_HOME"] = saved.home;
    }
  });
});

describe("the bin helper's other outcomes, in process", () => {
  test("kept in by a needle, refused by the server, and off unless MIND_TRIAGE=jev", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-ptriage-more-"));
    scratch.push(dir);
    const subject = subjectId("example");
    const proposal = describeProposal({ id: "33333333-3333-4333-8333-333333333333", subject, at: new Date(), what: "tell Somchai", why: "y", impact: "i" });
    const saved = { key: process.env["TYPESAFE_API_KEY"], data: process.env["XDG_DATA_HOME"], state: process.env["XDG_STATE_HOME"], on: process.env["MIND_TRIAGE"] };
    process.env["XDG_DATA_HOME"] = join(dir, "data");
    process.env["XDG_STATE_HOME"] = join(dir, "state");
    process.env["TYPESAFE_API_KEY"] = "k";
    try {
      const kept = await triageAndStore(dir, proposal, subject, ["Somchai"], async () => Response.json({}));
      expect(kept.kind).toBe("kept-in");
      const refused = await triageAndStore(dir, { ...proposal, what: "w" }, subject, [], async () => new Response("no", { status: 429 }));
      expect(refused).toEqual({ kind: "failed", reason: "TypeSafe answered 429" });
      delete process.env["MIND_TRIAGE"];
      expect(await triageIfEnabled(dir, proposal, subject)).toBeUndefined();
      process.env["MIND_TRIAGE"] = "jev";
      process.env["MIND_TYPESAFE_URL"] = "http://127.0.0.1:9/closed";
      expect((await triageIfEnabled(dir, { ...proposal, what: "w" }, subject))?.kind).toBe("failed");
    } finally {
      delete process.env["MIND_TYPESAFE_URL"];
      for (const [k, name] of [["key", "TYPESAFE_API_KEY"], ["data", "XDG_DATA_HOME"], ["state", "XDG_STATE_HOME"], ["on", "MIND_TRIAGE"]] as const) {
        const v = saved[k];
        if (v === undefined) delete process.env[name];
        else process.env[name] = v;
      }
    }
  });
});
