import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home() {
  const dir = await mkdtemp(join(tmpdir(), "mind-grant-cli-"));
  scratch.push(dir);
  const env = { HOME: dir, PATH: "/usr/bin:/bin", XDG_STATE_HOME: join(dir, "state"), XDG_DATA_HOME: join(dir, "data") };
  return { dir, env, grants: join(dir, "data", "mind", "example", "personal", "grants") };
}

async function run(env: Record<string, string>, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: env["HOME"]!, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  await child.exited;
  return { code: child.exitCode ?? -1, stdout: stdout.trim(), stderr };
}

const give = (env: Record<string, string>, ...extra: string[]) =>
  run(env, ["grant", "give", SOUL, "--subject", "example", "--origin", "https://shop.example.com", ...extra]);

describe("mind grant (S22.11)", () => {
  test("give, list, revoke and report: a grant exists, is shown, is taken back at once, and the record says so", async () => {
    const h = await home();
    const made = await give(h.env, "--category", "send", "--for", "24h");
    expect(made.code, made.stderr).toBe(0);
    const id = made.stdout;
    expect(id).toMatch(/^g-[0-9a-f]{8}$/);
    expect(made.stderr).toContain("never covers a credential or personal data");
    expect((await stat(join(h.grants, `${id}.json`))).mode & 0o777).toBe(0o600);

    const listed = JSON.parse((await run(h.env, ["grant", "list", SOUL, "--subject", "example", "--json"])).stdout) as { grants: { id: string; origin: string; category: string }[] };
    expect(listed.grants.map((g) => [g.id, g.category, g.origin])).toEqual([[id, "send", "https://shop.example.com:443"]]);
    expect((await run(h.env, ["grant", "list", SOUL, "--subject", "example"])).stdout).toContain(`${id}  active  send`);

    const revoked = await run(h.env, ["grant", "revoke", id, SOUL, "--subject", "example"]);
    expect(revoked.code, revoked.stderr).toBe(0);
    expect((await run(h.env, ["grant", "list", SOUL, "--subject", "example"])).stdout).toContain(`${id}  revoked`);
    expect((await run(h.env, ["grant", "revoke", id, SOUL, "--subject", "example"])).code).toBe(2);

    const report = JSON.parse((await run(h.env, ["grant", "report", SOUL, "--subject", "example", "--json"])).stdout) as { answered: number; given: number; revoked: number };
    expect(report).toMatchObject({ answered: 0, given: 1, revoked: 1 });
    const record = (await readFile(join(h.grants, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event: string });
    expect(record.map((e) => e.event)).toEqual(["give", "revoke"]);
  });

  test("a credential, a lifetime that is too long, a payment with no task, and a bad origin are refused, and nothing is written", async () => {
    const h = await home();
    const credentials = await give(h.env, "--category", "credentials", "--for", "1h");
    expect(credentials.code).toBe(2);
    expect(credentials.stderr).toContain("D-160");
    expect((await give(h.env, "--category", "delete", "--for", "7d")).code).toBe(2);
    const payment = await give(h.env, "--category", "payment", "--for", "1h");
    expect(payment.code).toBe(2);
    expect(payment.stderr).toContain("names the one task");
    expect((await run(h.env, ["grant", "give", SOUL, "--subject", "example", "--category", "send", "--origin", "nope", "--for", "1h"])).code).toBe(2);
    expect((await run(h.env, ["grant", "list", SOUL, "--subject", "example"])).stdout).toBe("no grants");
    expect(await stat(h.grants).catch(() => null)).toBeNull();
  });

  test("with no verb, or no subject, it is a usage error", async () => {
    const h = await home();
    expect((await run(h.env, ["grant"])).code).toBe(2);
    expect((await run(h.env, ["grant", "list", SOUL])).code).toBe(2);
  });
});
