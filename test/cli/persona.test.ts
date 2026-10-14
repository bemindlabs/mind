/**
 * S6.1 through the binary (D-072): extract against a stub local model, the
 * made-up claim cut, the draft kept in personal/, review refused without a
 * terminal, and adopt writing only what was answered yes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A local model that proposes one real claim and one invented one. */
function stubModel() {
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: { role: string; content: string }[] };
      asked.push(body.model);
      return Response.json({
        message: {
          content: JSON.stringify([
            { field: "prohibition", text: "Never restart the database in business hours", quote: "never restart the database between 9 and 17" },
            { field: "knowledge", text: "Backups run at 02:00", quote: "backups run nightly at 03:30 from the NAS" },
          ]),
        },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, asked };
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "mind-persona-"));
  scratch.push(home);
  const agent = join(home, "agent");
  await cp(SOUL, join(agent, "soul"), { recursive: true });
  const docs = join(home, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, "ops.md"), "# Ops\n\nWe never restart the database between 9 and 17.\n");
  const model = stubModel();
  // S7.3: a basis for "persona" is on record for the subject.
  await mkdir(join(home, "state", "mind", "basis", "example"), { recursive: true });
  await writeFile(join(home, "state", "mind", "basis", "example", "records.json"), JSON.stringify([{ id: "b1", subject: "example", basis: "owner", approvedBy: "test", at: "2026-09-25T00:00:00Z", uses: ["persona"], expires: null, note: "", revokedAt: null }]));
  const env = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), OLLAMA_HOST: model.url, MIND_NO_UPDATE_CHECK: "1" };
  const run = async (args: readonly string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  const draftsDir = join(home, "data", "mind", "example", "personal", "persona");
  return { home, agent, docs, model, run, draftsDir };
}

describe("mind persona", () => {
  test("extract → show → adopt: the invented claim is cut, and only a yes reaches the soul", async () => {
    const t = await setup();
    const ex = await t.run(["persona", "extract", t.agent, "--subject", "example", "--from", t.docs, "--model", "stub"]);
    expect(ex.code, ex.stderr).toBe(0);
    expect(ex.stdout).toContain("1 claim(s) drafted");
    expect(ex.stdout).toContain("1 cut as made up");
    expect(t.model.asked).toEqual(["stub"]);

    const files = await readdir(t.draftsDir);
    expect(files).toHaveLength(1);
    const path = join(t.draftsDir, files[0]!);
    const show = await t.run(["persona", "show", "--subject", "example"]);
    expect(show.stdout).toContain("docs/ops.md:3");
    expect(show.stdout).not.toContain("03:30");

    // Review is a person at a terminal; a pipe is refused.
    expect((await t.run(["persona", "review", t.agent, "--subject", "example"])).code).toBe(1);
    // Nothing answered yet: nothing to write.
    expect((await t.run(["persona", "adopt", t.agent, "--subject", "example", "--yes"])).stdout).toContain("Nothing answered yes");

    // The web page's way to answer: persona show --json, then persona decide.
    const shown = JSON.parse((await t.run(["persona", "show", "--subject", "example", "--json"])).stdout) as { draft: { claims: { id: string; decision: string | null }[] } };
    const claimId = shown.draft.claims[0]!.id;
    expect((await t.run(["persona", "decide", claimId, "--subject", "example", "--yes"])).code).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8")).claims[0].decision).toBe("yes");
    expect((await t.run(["persona", "decide", "nope1234", "--subject", "example", "--no"])).code).toBe(1);
    expect((await t.run(["persona", "decide", claimId, "--subject", "example", "--yes", "--no"])).code).toBe(2);
    expect((await t.run(["persona", "decide", claimId, "--subject", "example"])).code).toBe(2);
    const dry = await t.run(["persona", "adopt", t.agent, "--subject", "example"]);
    expect(dry.stdout).toContain("would write 1 claim(s)");
    expect(await readFile(join(t.agent, "soul", "role.md"), "utf8")).not.toContain("business hours");
    const wet = await t.run(["persona", "adopt", t.agent, "--subject", "example", "--yes"]);
    expect(wet.code, wet.stderr).toBe(0);
    expect(await readFile(join(t.agent, "soul", "role.md"), "utf8")).toContain("Never restart the database in business hours");
    expect((await t.run(["soul", "check", t.agent, "--subject", "example"])).code).toBe(0);
  }, 60_000);

  test("the model must be on this machine, and must be named", async () => {
    const t = await setup();
    const far = await t.run(["persona", "extract", t.agent, "--subject", "example", "--from", t.docs, "--model", "stub"], { OLLAMA_HOST: "http://model.example:11434" });
    expect(far.code).toBe(1);
    expect(far.stderr).toContain("must be on this machine");
    expect(t.model.asked).toEqual([]);
    expect((await t.run(["persona", "extract", t.agent, "--subject", "example", "--from", t.docs])).code).toBe(2);
    expect((await t.run(["persona", "extract", t.agent, "--subject", "example", "--from", join(t.home, "nothing"), "--model", "stub"])).code).toBe(1);
    expect((await t.run(["persona", "show", "--subject", "example"])).stdout).toContain("no draft yet");
    for (const args of [["persona"], ["persona", "wat"], ["persona", "show"], ["persona", "extract", t.agent, "--subject", "example"], ["persona", "adopt", "--subject", "example"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
  }, 60_000);

  test("S7.3: without a basis for persona, no artifact is read and no model is asked", async () => {
    const t = await setup();
    await writeFile(join(t.home, "state", "mind", "basis", "example", "records.json"), JSON.stringify([{ id: "b1", subject: "example", basis: "owner", approvedBy: "test", at: "2026-09-25T00:00:00Z", uses: ["memory"], expires: null, note: "", revokedAt: null }]));
    const out = await t.run(["persona", "extract", t.agent, "--subject", "example", "--from", t.docs, "--model", "stub"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("allows memory — not persona");
    expect(t.model.asked).toEqual([]);
  }, 60_000);
});

